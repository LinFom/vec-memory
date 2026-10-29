import { isCanonicalSource, canonicalFingerprint, canonicalVocabulary } from './input-source.mjs';
import { loadPolicyBaseline } from './visibility.mjs';
import { encodingIdentity, openActiveVectors, planEventCarry, prepareVectorGeneration, rebuildJobPath } from './vector-generation.mjs';
// memory-vec — 向量记忆库插件本体（服务端）。
//
// ── 它是什么 ─────────────────────────────────────────────────────────────
// 给宿主补上三样它现在没有的能力，**一样都不碰它已有的东西**：
//   ① 语义召回   —— 核心的 conversation-memory 只有 TF 倒排，跨不过"问句↔答案"的距离；
//   ② 向量底座   —— 宿主完全没有 embedding 能力（全仓只有 model-prices 里一条价格记录）；
//   ③ 可见的库   —— 让"库里到底有什么、检索得到吗"变成能看的界面。
//
// ── 它怎么工作（分两条轨，互不相干）────────────────────────────────────
//   写入轨：[手动/定时触发] → 读核心小时块 → 构建截断文本 → 调嵌入端点 → 落 vectors.bin
//   读取轨：[面板请求] → /api/memory-vec/* → 暴力余弦 → 返回命中与分数
//   M0 只做读取轨 + 一个手动触发的索引按钮。**不做自动注入**（injectEnabled 默认 false）。
//
// ── 三条纪律 ─────────────────────────────────────────────────────────────
//   1. 默认值一律是"不改变行为"的那个值：autoIndexEnabled=false、injectEnabled=false、
//      shadowMode=true。装上插件、什么都不点，宿主的行为与没装它完全一样。
//   2. 拿不准就明说。维度不符 / 模型不符 / 端点不齐 / 库损坏 —— 全部抛错并原样报给界面，
//      绝不 catch 掉之后返回一个空数组（那会让人以为"库里没东西"）。
//   3. 数据只写 <DATA_DIR>/memory-vec/。插件目录一个字都不写 —— plugins/ 被全量监听，
//      写一次就触发一次重扫（sticker-admin 的头注释里有完整事故记录）。
import fs from 'node:fs';
import path from 'node:path';

import { VecStore, VecStoreError } from './vecstore.mjs';
import { embedDocuments, embedQueries, checkEndpoint, EmbedError, partitionBySafety, DEFAULT_QUERY_INSTRUCTION, joinUrl, clampBatchSize, DEFAULT_BATCH_SIZE } from './embed.mjs';
import { buildSourceText, buildEmbedText, sourceHash, chunkMeta } from './chunkread.mjs';
// 语料入口：老块 + 派生块（从宿主 messages 存档补的小时块）。
// **所有语料遍历都必须走 corpus** —— 留着 `listChunks` 直调的口子，
// 迟早有一处漏掉派生块，而那种漏是静默的（索引少一批、状态少一批，无报错）。
import { listCorpus, readCorpusItem } from './corpus.mjs';
import { getSharedNormalizer, NormalizerError } from './normalize.mjs';
import { buildVocabulary, scanSuspects, archiveFingerprint } from './vocab.mjs';
import { appendLineage, readLineage, repointLineage, lineagePairs } from './lineage.mjs';
import { distribution, judge, summarize } from './stats.mjs';
import { DIM_ORDER, RANK_VERSION } from './rank.mjs';
import { scanCorpus, rankDistribution, appendShadowSnapshot, readShadowSnapshots } from './rankscan.mjs';
import { extractEdges, EDGE_ALGO_VERSION, DEFAULT_COOC_WINDOW_MS, buildGraphView, buildGraphNodes, filterGraphByScope, extractAtTargets, entityLabel } from './edges.mjs';
import { refreshGroupNames } from './groupnames.mjs';
import { FactStoreError, openFactStore } from './factstore.mjs';
import { runConsolidate, consolidateStatus } from './consolidate.mjs';
import { DEFAULT_KEYWORDS_SOURCE } from './keywords.mjs';
import { iterateArchive } from './vocab.mjs';
import { clusterCandidates, shouldTrigger } from './extract.mjs';
import { runJudgeBatch, RateLimiter, JudgeError, DEFAULT_PER_MINUTE, classifySourceRejection, looksLikeSymbolFragment } from './judge.mjs';
import { hostConfig, hostSettings, hostFallbackRoot } from './host.mjs';

// 宿主根：由适配层 bindHost() 注入（原来是 path.resolve(HERE,'..','..') 推算）。
const PLUGIN_ID = 'memory-vec';

// ── 运行期单例 ───────────────────────────────────────────────────────────
// stop 缝需要同步拿到句柄，所以挂到 globalThis 上（见 patches/src__app.js__stop.js）。
let runtime = null;
let indexJob = null;

// ── 宿主环境（注入点）────────────────────────────────────────────────────
// 原实现是动态 import 宿主的 ../../src/config.js 与 ../../src/skills/config.js ——
// 那要求本文件物理上住在 <宿主>/plugins/<id>/ 里。拆仓后本文件不再知道自己在哪，
// 改由适配层在启动时 bindHost() 注入**同一对模块**，因此在宿主场景下行为完全等价。
// 注入缺席 ⇒ 返回 null ⇒ 各调用点走原有兜底分支，与"动态 import 失败"一致。
async function coreConfig() {
  return hostConfig();
}

async function coreSettings() {
  return hostSettings();
}

/** 读取本插件的配置（与 manifest.settings 合并后的形状）。 */
async function pluginSettings() {
  const mod = await coreSettings();
  if (mod?.getSkillConfig) {
    try {
      const explicit = mod.getSkillConfig(PLUGIN_ID, {});
      return { ...mod.getSkillConfig(PLUGIN_ID, DEFAULT_SETTINGS), _profileCrossScopeExplicit: Object.hasOwn(explicit || {}, 'profileCrossScope') };
    } catch { /* 落到下面的默认值 */ }
  }
  return { ...DEFAULT_SETTINGS, _profileCrossScopeExplicit: false };
}

/**
 * 把运行期那份设置副本刷新成盘上的最新值。
 *
 * 为什么需要：`getRuntime()` 只在**首次装配**时读一次配置，之后运行期一直用那份副本。
 * 于是"面板改了设置 → 点按钮"这条路径若不刷新，用的还是启动时的旧值 ——
 * 端点、别称都改了却"没生效"，而且**不报错**。
 */
export async function refreshSettings(rt) {
  const mod = await coreSettings();
  if (mod?.getSkillConfig) {
    try { rt.settings = { ...mod.getSkillConfig(PLUGIN_ID, DEFAULT_SETTINGS), _profileCrossScopeExplicit: Object.hasOwn(mod.getSkillConfig(PLUGIN_ID, {}) || {}, 'profileCrossScope') }; } catch { /* 用旧配置 */ }
  }
  return rt.settings;
}

// 与 plugin.json 的 settings 保持一致（核心读不到时用它兜底，保证形状稳定）。
// ⚠️ **数值项的真来源在别处**：`embedBatchSize` 取 `embed.mjs` 的 `DEFAULT_BATCH_SIZE`
// （代码是唯一来源，`plugin.json` / 面板只是**声明副本**）；`injectThreshold` 取
// `inject.mjs` 的 `DEFAULT_MIN_SCORE`。这里**不写字面量** —— 本次嵌入批量事故
// （面板提示 10 / 代码默认 16）就是"同一个数字抄了两份、其中一份是错的"。
//
// 导出给只读工具用（`tools/audit-active-generation.mjs`）：审计必须按**生产同一套默认值**
// 复算 `sourceHash`，否则"哈希陈旧"这个结论会来自审计自己的默认值而不是生产配置。
export const DEFAULT_SETTINGS = {
  autoIndexEnabled: false,
  autoIndexIntervalMin: 0,
  shadowMode: true,
  injectEnabled: true,
  embedBaseURL: '',
  embedApiKey: '',
  embedModel: '',
  embedRevision: '',
  embedBatchSize: DEFAULT_BATCH_SIZE,
  embedTimeoutMs: 30000,
  embedDimensions: '',
  maxChars: 1200,
  withKeywords: true,
  withSummary: true,
  // 关键词来源（`ROADMAP #5`，2026-10-09 拍板切 `filtered`）：core = 核心分词（碎片会出境）
  // · filtered = 按词表剔碎片（实测 60 块 35 碎片→0，覆盖不变）· redacted = 从脱敏文本重抽。
  // 改它改变出境文本 ⇒ 全库 sourceHash 变化 ⇒ 触发重嵌入（本次与转发标记剥离同批）。
  keywordsSource: DEFAULT_KEYWORDS_SOURCE,
  // redacted 口径：snippets+summary（宽，实测空表 0/502）· summary（窄，空表 94/502）
  keywordsCaliber: 'snippets+summary',
  topK: 8,
  // 查询侧的指令前缀（非对称编码）。留空用 Qwen3 的官方默认。
  queryInstruction: '',
  // ── M2 注入（ADR-0009，2026-10-10 拍板：人格属性句 · 每人 2 条 · 全群开）──
  // 阈值沿革：0.85（拍板值）→ **0.5**（2026-10-13 按真库实测校准）。**唯一来源是
  // core/inject.mjs 的 `DEFAULT_MIN_SCORE`**，这里跟随；它是可配置项，面板能改。
  // injectEnabled 在上面（true = 全群开；复用 M0 时代的遗留键——它当时从未实现，
  // 面板勾选框文案就是"把召回结果注入提示词"，与 M2 所做的事一致）。
  // 服务端只是响应端：宿主钩子每轮问一次 /inject；关了服务端也尊重该值。
  // 向量相似度阈值：≥它的属性行是"现在就用得上"（hot）。mode=boost 只加排序权重；
  // mode=hard 才是硬门槛（嵌入服务缺席时 hard 降级为 boost，见 inject.mjs）。
  injectThreshold: 0.5,
  injectMode: 'boost',
  // 条数对齐宿主"群友印象"机制（src/memory.js maxEach=2）；总上限兜 prompt 预算。
  injectPerPerson: 2,
  injectTotal: 8,
  // 档案（`trait`）要不要服从场合隔离：`true` = 跨场合（2026-10-18 用户拍板，默认），
  // `false` = 只在本场合注入（旧行为，ADR-0031 §3.8）。
  // 起因：私聊说「我 21 岁」→ 群里问就答不出（`blocked=4`），而人对自己的年龄没有场合预期。
  // 代价：`trait` 里的「住址/真名/性取向」也会跟着进任何会话 —— 面板同一开关可随时关回。
  profileCrossScope: true,
  // ── 跨会话近况（`ADR-0043`，2026-10-19 用户拍板）─────────────────────────────
  // 宿主短期历史按 chatKey 物理隔离 ⇒ 群里刚说的话，私聊里完全不知道。
  // 这一组键的语义**对齐宿主那批死键**（`api.architecture.crossChat*`，`defaults.js:206` 起）——
  // 名字照抄是为了"看到就知道是同一条需求"，不是因为宿主那批还能用（它们没有消费方）。
  //
  // 三个开关**必须分开**，合成一个就会有"想要 A 必然得到 B"的副作用：
  //   · `crossChatEnabled`       总闸（关掉整段，谁都不注入）
  //   · `crossChatInPrivate`     私聊要不要收别处动静（默认 true，用户明确要的）
  //   · `crossChatIncludePrivate`私聊内容能不能当**来源**（默认 false —— 群里永远听不见私聊）
  crossChatEnabled: true,
  crossChatInPrivate: true,
  crossChatInGroup: true,
  crossChatIncludePrivate: false,
  // ── 事件整理（M5，2026-10-22 用户拍板「用整理取代旧的印象管道」）──────────────
  // 与宿主的 `memory.consolidateEnabled` **不是一回事**：那个开关控制的是宿主 M6
  // （产出 observations/episodes 到宿主 data），本组控制的是**本库自己的**整理管道
  // （读宿主 evidence 账本 → 产事件 + 人印象）。旧开关已于 10-22 关停。
  //
  // `consolidateEnabled` 缺省 **false**：整理要调模型（花钱），必须显式开 ——
  // 与 `llmEndpointKind` 的 fail-closed 同理，"自动花你的钱"不能是默认行为。
  consolidateEnabled: false,
  consolidateIntervalMin: 0,          // 0 = 用 `consolidateIntervalMinDefault`（30 分钟）
  consolidateIntervalMinDefault: 30,
  consolidateWindowMsgs: 120,         // 一个窗口最多几条消息
  consolidateWindowSpanMin: 120,      // 一个窗口最长时间跨度（分钟）
  consolidateSettleMin: 3,            // 窗口末端必须早于 now-3min（正在聊的留给下一轮）
  consolidateMaxWindowsPerRun: 3,     // 单轮最多处理几个窗口（成本闸门）
  // `/inject` 注入最近几条事件。`ADR-0048` 起**一行 = 一件事**（旧口径一行 = 一个窗口、
  // 最多含 5 件）⇒ 3 条只剩原来的 1/3~1/5 信息量，默认提到 6。
  consolidateInjectCount: 6,
  consolidateInjectMaxChars: 200,     // 每条事件在提示词里的字符上限
  // 单次整理调用的输出上限。推理类模型的思考过程也吃这个预算，
  // 给小了会静默拿到 `content:""`（正文还没开始就被截断）。
  consolidateMaxTokens: 2000,
  consolidateTimeoutMs: 180000,
  // ── 短期层 / 长期层（ADR-0047 / ADR-0048）──────────────────────────────
  // 事件**不再**一落盘就进向量（那等于零门槛升长期）。攒够 `promoteHits` 次排练才建向量。
  // `eventAutoEmbed` 只是回退开关，默认关。
  eventAutoEmbed: false,
  promoteHits: 9,                     // 排练多少次升长期
  // ── 回收：遗忘曲线（`ADR-0048` ⑩）─────────────────────────────────────
  // `retireDays` 不再是"固定的 30 天"，而是**锚点**：0 次排练的事件的回收天数。
  // 每多一次排练，半衰期 ×(1 + gain×hits) ⇒ 被想起过的事活得更久。
  retireDays: 30,                     // 多少天没排练就回收（只打标记）；**锚点 = 0 次排练**
  retireHalfLifeGain: 0.4,            // 每多一次排练，半衰期增长的倍率（**未校准**，见 ADR）
  retireMinRecall: 0.1,               // 保持率低于多少算"忘了"（**变暗**阈值，不再直接出索引）
  // ── 软回收（`ADR-0048 ⑪`）───────────────────────────────────────────────
  // 跌破 `retireMinRecall` ⇒ 变暗（仍在索引里，tf × `retireDimWeight`）；
  // 跌破 `retireMinRecall × retireHardRatio` ⇒ 才打 `retiredAt` 出索引。
  retireHardRatio: 0.3,               // 硬回收阈值 = retireMinRecall × 这个值
  retireDimWeight: 0.3,               // 变暗行在关键词索引里的权重倍率
  layerMaintenance: true,             // 整理跑完顺带做升长期+回收
  consolidateEventRelatedCount: 3,    // 「相关事件」段条数
  consolidateEventMinScore: 0.15,     // 「相关事件」段的覆盖率门槛（口径见 event-index.mjs）
  crossChatMinutes: 10,     // 时间窗（分钟）
  crossChatMaxChats: 2,     // 最多几个来源会话
  crossChatMaxChars: 120,   // 每个来源会话的文本上限（字符）
  // 兜底层扫描参数：分布集中度阈值与最小出现次数
  suspectMinCount: 8,
  suspectMaxSpread: 0.35,
  // 自我别称：用户显式声明的"这也是我"（逗号分隔）。
  // 缺省为空 ⇒ 不额外声明任何别称、不做任何猜测（见 parseSelfAliases）。
  selfAliases: '',
  // ── 群名来源（星图上的星系标签，2026-10-12）──────────────────────────────
  // 群名只有宿主知道（OneBot `get_group_list`），存档里没有。留空 = **自动**：
  // 从 `<源根>/config.json` 的 `server.port` 推出宿主 HTTP 面（实测 3210）。
  // 宿主换端口/换机器，或想把这一路完全关掉（填一个连不上的地址即降级为占位符）时才填。
  groupNamesBaseURL: '',
  // ── M4 第二段（LLM 模式判定，`ADR-0019`）──
  // `llmEndpointKind` **缺省为空 ⇒ 拒绝启动 M4 第二段**（fail-closed）：
  // "出境到哪"永远显式声明，不会因默认配置悄悄送到外部。
  llmEndpointKind: '',     // '' | 'local' | 'external'
  llmBaseURL: '',          // OpenAI 兼容 /chat/completions 端点
  llmApiKey: '',
  llmModel: '',
  judgeDryRun: false,      // `ADR-0019` 决定 4：默认关闭；true = 全链路 + 固定桩，不真调 LLM、不落库
  judgePerMinute: DEFAULT_PER_MINUTE   // 频率上限（决定 2：配置化，不硬编码）
};

/**
 * 插件设置 → embed 层的**端点形状**（唯一映射点）。
 *
 * ⚠️ 这两套形状的键名**不一样**：设置里叫 `embedBaseURL / embedApiKey / embedModel`，
 *    embed 层要的是 `baseURL / apiKey / model`。曾经有三处把 `rt.settings` **直接**
 *    传进 `checkEndpoint()`，于是 `ep.baseURL` 恒为 `undefined` ⇒ 无论端点怎么配都报
 *    「端点地址（baseURL）为空；嵌入模型名为空；API Key 为空」（2026-10-08 宿主首次
 *    真跑时撞到，此前所有运行都是旁路脚本、没走过这条缝）。
 *
 *    单测只用**端点形状**测过 `checkEndpoint`，所以这条缝一直没被红出来 ——
 *    现在两套形状之间**只留这一个搬运点**，不许再出现第二处手工搬运。
 */
export function endpointOf(settings) {
  return {
    baseURL: settings?.embedBaseURL,
    apiKey: settings?.embedApiKey,
    model: settings?.embedModel,
    timeoutMs: settings?.embedTimeoutMs,
    dimensions: settings?.embedDimensions,
    batchSize: settings?.embedBatchSize
  };
}

export async function dataDir() {
  const cfg = await coreConfig();
  if (cfg?.DATA_DIR) return path.join(cfg.DATA_DIR, 'memory-vec');
  // 兜底：插件目录的兄弟位置（绝不写，只保证不崩）
  return path.join(hostFallbackRoot(), 'data', 'memory-vec');
}

/**
 * 宿主的 data 根目录 —— 存档（messages*）与人物卡（memory/people）都在这儿。
 * 0.9.3 起外接模式：这是**源根**（索引/身份/存档，只读），由服务侧 `SOURCE_DIR`
 * 指回宿主 data；**库**（本服务自持的 `memory-vec/`）仍走 `dataDir()`＝DATA_DIR。
 * 没配 SOURCE_DIR 时两者同根 —— 兼容旧部署（服务直接跑在宿主 data 上）。
 */
export async function dataRoot() {
  const cfg = await coreConfig();
  if (cfg?.SOURCE_DIR) return cfg.SOURCE_DIR;
  if (cfg?.DATA_DIR) return cfg.DATA_DIR;
  return path.join(hostFallbackRoot(), 'data');
}

export async function chunksDir() {
  const cfg = await coreConfig();
  const root = cfg?.SOURCE_DIR || cfg?.DATA_DIR;
  if (root) return path.join(root, 'memory-v2', 'chunks');
  return path.join(hostFallbackRoot(), 'data', 'memory-v2', 'chunks');
}

// ── 身份边界（归一化器 + 词表 + 观察窗）──────────────────────────────────
// 纪律（ADR-0003）：**全场只有一个归一化器实例**，索引侧与查询侧共用它。
// 各 new 一个会加载出两份注册表 —— 两侧不一致时不会报错，只会慢慢变得不对。
export const identityScan = { busy: false };

/**
 * 「当前在场词表」装载了没有？
 *
 * ⚠️ **不许拿 `entities.size > 0` 当判据。** `entities.json` 里**永远至少有一个
 * `self`**（种子实体，`surface: ['我']`），所以每次重启后 `entities.size === 1`
 * —— 旧判据恒真，全量词表（本机实测 **944 个实体**）**一次都没装过**。
 *
 * 真机代价（2026-10-08 首次部署后索引失败）：
 *   冷启动时 `林寒枫霜` 认不出来，裸说话人名 `林寒枫霜: …` 原样留在出境文本里；
 *   直到某个块出现 `@林寒枫霜[CQ:at,qq=100000001]`，对齐层凭硬 ID 认出它并登记，
 *   于是**先前已经构建好的**那些块，在出境自检里被报成泄漏：
 *   `document 侧第 0 条文本里仍有实体串「林寒枫霜」（层：align）`。
 *   **`层：align` 就是"没走词表"的签名** —— 词表命中会写 `registry`。
 *
 * 判据必须回答的问题是"这次装载做过没有"，答案只能来自**运行期事实**，
 * 不能来自"文件里有没有东西"（文件里永远有种子）。
 *
 * 代价是**每次进程启动重扫一遍存档**（本机实测 **777ms / 944 实体**）。
 * 这是刻意换的：词表永不落后于存档，也不用去猜磁盘上那份快照是哪天的。
 */
/**
 * 「这次要不要重装词表，为什么」—— **判据的唯一实现**。
 *
 * 返回值：`'forced' | 'first' | 'aliases' | 'archive' | null`（null = 不用装）。
 *
 * 为什么让判据**同时**给出理由：面板要显示"刚才凭什么刷新的"，
 * 而如果为了显示理由在别处再写一遍比较逻辑，判据就有两份实现 ——
 * 两份实现的分叉**不报错**（本项目已经吃过一次：`load()` 带 `keepLabels`、
 * `ensureIdentity()` 不带，于是"新增一人 ⇒ 一批人挪号"，静默）。
 * ⇒ 一处判定，`vocabularyNeeded()` 就是它 `!== null`。
 *
 * 三个输入（每个都对应一次真实事故）：
 *   · `selfAliases` 变了 —— 别称是词表的**输入**之一，不比它 = 改了设置不生效且不报错
 *   · **存档变了** —— 不比它 = 新说话的人全部落成临时标签（2026-10-11 实测：986 vs 1151）
 *   · `identityLoaded` —— 运行期事实，不是"文件里有没有东西"（文件里永远有种子 self）
 */
export function identityReloadReason(rt, { force = false, archiveSig = '' } = {}) {
  if (force) return 'forced';
  if (!rt?.identityLoaded) return 'first';
  const recorded = rt.vocabularySelfAliases;              // null ⇒ 没记录（老形状/半初始化）
  const now = aliasSignature(rt.settings?.selfAliases);   // ''   ⇒ 没声明
  if (recorded === null || recorded === undefined) {
    // 没有记录 ⇒ 无从比较。只有在"现在声明了别称"时才必须重装；
    // 没声明则与"装载时用的空签名"等效，保持"装载过就不重扫"的既有契约。
    if (now !== '') return 'aliases';
  } else if (recorded !== now) {
    // 逐字比较。**注意空签名也要比**：把别称从 `samara` 删成空
    // 同样是一次"输入变了"，不比就会一直留着那条已经不想要的别称。
    return 'aliases';
  }
  const recSig = rt.vocabularyArchiveSig;
  // 没记录（老形状 / 半初始化）⇒ 补上一次。
  if (!recSig) return 'archive';
  // ⚠️ **调用方没给指纹 ⇒ 重扫**。这条是刻意的"失败方向"：
  //    忘了传指纹只会白扫几秒（看得见），而反过来（默认"没变"）就是静默落后 ——
  //    正是本次要修的那个故障（12:47 的词表配着 19:05 的存档，无人察觉）。
  if (!archiveSig) return 'archive';
  return recSig !== archiveSig ? 'archive' : null;
}

export function vocabularyNeeded(rt, opts = {}) {
  return identityReloadReason(rt, opts) !== null;
}

/**
 * 「自我别称」：用户**显式声明**的自己的名字。
 *
 * 为什么需要它：词表里的"我是谁"有三个来源（`config.json` 的 `botName`、
 * `per-chat-persona` 的人设名、从存档挖"主人怎么叫我"），三者都挖不出**残缺形态**
 * —— 多词名字被拆开的单块（`Single Samara` 里的 `samara`）没有任何独立来源。
 * 实测：`samara` / `Samara` / `SAMARA` 三个形态全部原样出境（`Single Samara` 能认）。
 *
 * 为什么不写一条"多词名字的每一块都算我"的规则：`Single` 是常用英文词，
 * 那条规则会让所有 `single` 变成 `〔SELF〕`。**缺省不猜，让用户声明**（纪律 6）。
 *
 * 分隔符：逗号 / 顿号 / 分号 / 换行。空串 ⇒ 空数组（不额外声明任何别称）。
 */
export function parseSelfAliases(raw) {
  return String(raw ?? '')
    .split(/[\n\r,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 别称列表的稳定签名（**顺序无关**：改顺序不该触发重建）。 */
export function aliasSignature(raw) {
  return parseSelfAliases(raw).slice().sort().join('\u0000');
}

/**
 * 别称 → 词表 surface（ASCII 项额外展开大小写变体）。
 *
 * 为什么要有变体：同一串 ASCII 的**大小写不携带身份** —— 实测语料里
 * `samara` / `Samara` / `SAMARA` 三种都出现过；只声明一项却只认一项，
 * 用户会以为"声明了没用"，而漏的是同一件事。
 *
 * 为什么**只**对显式别称做，不对全词表做：对全词表折叠大小写会把
 * 人名 `May` 变成"替换掉任何英文文本里的 `may`"。声明是用户自己的话，范围可控。
 */
export function selfAliasSurfaces(raw) {
  const out = [];
  for (const a of parseSelfAliases(raw)) {
    if (!out.includes(a)) out.push(a);
    if (!/^[\x20-\x7e]+$/.test(a)) continue;       // 只展开纯 ASCII
    const variants = [
      a.toLowerCase(),
      a.toUpperCase(),
      a.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    ];
    for (const v of variants) if (v && v !== a && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 确保词表已装载。首次调用会全量扫一遍存档（119,008 条，约 1~3 秒），
 * 之后从本机映射表直接加载。
 */
export async function ensureIdentity(rt, { force = false, dryRun = false } = {}) {
  const root = await dataRoot();
  const fp = isCanonicalSource(root) ? canonicalFingerprint(root) : archiveFingerprint(root);
  // ── 先结账"凭什么（不）装"，再决定装不装 ────────────────────────────────
  // `staleBefore` 必须在**装载之前**算：装载会把词表修好，之后再算
  // 永远是"不陈旧" —— 那就是判据把自己要回答的问题抹掉了（本轮根因的同族）。
  const reason = identityReloadReason(rt, { force, archiveSig: fp.sig });
  if (!reason) {
    rt.lastIdentityCheck = { at: Date.now(), reloaded: false, reason: null, staleBefore: false, relabels: 0 };
    return rt.identityStats;
  }
  const staleBefore = reason === 'archive' || reason === 'aliases';

  const selfAliases = parseSelfAliases(rt.settings?.selfAliases);
  const v = isCanonicalSource(root) ? canonicalVocabulary(root, [...rt.normalizer.entities.values()]) : buildVocabulary({ dataDir: root, botNames: selfAliasSurfaces(rt.settings?.selfAliases) });

  // ── 装载前先记下"每个实体 id 现在挂着哪个标签" ───────────────────────────
  // 这一份差量就是**标签沿革表**的全部来源：装载后按同一个 id 再读一次，
  // 变了的就是"换了标签的人"，而备注（按标签存键）正好需要这条映射才不静默失联。
  const before = labelSnapshot(rt.normalizer);

  rt.normalizer.setVocabulary(v.entities, {
    // ⚠️ `load()` 一直带着 `keepLabels`，而这里原来**没带** —— 两处口径不一致，
    //    后果是"新增一个人可能让后面一批人整体挪号"。挪号不报错，
    //    只让备注与库里已存的向量静默漂移（同族事故：`ss` 元数据里的占位符对不上人名）。
    keepLabels: entityLabels(rt.normalizer)
  });
  // `dryRun`（只读对账专用，见 `tools/audit-active-generation.mjs`）：装载词表本身是纯内存
  // 动作，但 `save()` 会重写 entities / registry / pending 三份本机敏感文件、
  // `appendLineage` 会往沿革表追加行。审计不能因为"看了一眼"就改变被审计对象的状态。
  if (!dryRun) rt.normalizer.save();
  rt.horizon = v.horizon;
  // 只有**真的装载过**才置位。装到一半抛错 ⇒ 保持 false ⇒ 下次重试，
  // 不会像旧判据那样"看起来装好了，其实是空表"。
  rt.identityLoaded = true;
  // 记下**本次用的别称签名**：设置一改它就不等 ⇒ vocabularyNeeded 重新装载。
  rt.vocabularySelfAliases = aliasSignature(rt.settings?.selfAliases);
  // 记下**本次看到的存档指纹**：存档一长它就不等（上面第三条判据）。
  rt.vocabularyArchiveSig = fp.sig;

  // ── 写沿革（只增）────────────────────────────────────────────────────────
  const after = labelSnapshot(rt.normalizer);
  const pairs = lineagePairs(before, after);
  // 与 `save()` 同理：dryRun 下不追加沿革行（只读审计不改盘上事实）
  const lineage = dryRun
    ? { ok: true, added: 0, skipped: 'dry-run' }
    : (pairs.length ? appendLineage(root, pairs, 'rebuild') : { ok: true, added: 0 });
  rt.lastLineage = { at: Date.now(), pairs: pairs.length, added: lineage.added || 0, ok: lineage.ok !== false };
  rt.lastIdentityCheck = {
    at: Date.now(),
    reloaded: true,
    reason,
    staleBefore,
    relabels: pairs.length
  };

  // `identity` 里装的是"机器人自己是谁、怎么判出来的" —— 2.1 那处漏替的可见化。
  // 面板上要能看到 selfId 与它的判断来源，否则下次同类漏项还是查不出来。
  rt.identityStats = {
    ...v.stats,
    identity: v.identity,
    loadedAt: Date.now(),
    selfAliasesDeclared: selfAliases,
    // 让面板能显示"这次刷新救回了 N 条换了号的备注"（`/identity` 会带出去）
    archiveSig: fp.sig,
    archiveFiles: fp.files,
    archiveBytes: fp.bytes,
    relabels: pairs.length,
    archiveSig: fp.sig,
    archiveFiles: fp.files,
    archiveBytes: fp.bytes,
    lineage: { total: lineage.total ?? null, added: lineage.added || 0, ok: lineage.ok !== false }
  };
  return rt.identityStats;
}

/** 把"实体 id → 标签"取成一张表（**只认实体，不认别名**）。 */
function entityLabels(normalizer) {
  const m = new Map();
  for (const id of normalizer.entities.keys()) {
    const l = normalizer.labelById.get(id);
    if (l) m.set(id, l);
  }
  return m;
}

/**
 * 装载前/后的**全量**快照：实体标签 + 临时标签（`ephemeral`）。
 *
 * 临时标签必须一起收：那 164 个新人当时根本不在词表里，他们只有 `ephemeral` 里的一条
 * `(other\0qq:NNN → X277)`。不收它，最该被救的那批人就正好漏掉 ——
 * 而"只收看起来像样的那一半"正是本项目反复吃过的亏。
 */
function labelSnapshot(normalizer) {
  const m = entityLabels(normalizer);
  for (const [key, v] of normalizer.ephemeral || []) {
    const i = key.indexOf('\u0000');
    const thing = i >= 0 ? key.slice(i + 1) : key;
    if (!m.has(thing) && v?.label && v.label !== 'SELF') m.set(thing, v.label);
  }
  return m;
}


// ── 身份合并（ADR-0019）──────────────────────────────────────────────────
// 载体是**现成的**：每个实体的 `aliases`（"这个实体在别处还会被叫成什么 ID"），
// `setVocabulary()` 会把 `aliases → 同一个标签` 写进 `aliasById`，
// 而 `resolveKnown()` 先查别名 ⇒ 边、星、备注（经沿革）全都自动归位。
// **不需要新建任何表。**
//
// 权限纪律（用户拍板）：**只信显式点名**。同名 9 组 / 29 颗星里，很可能混着
// "不同人撞同一个昵称"（中文短昵称在 QQ 群里撞车很正常），系统自己也只能猜一个。
// 所以自动那条路只**产建议**（`/identity/suggest`），绝不自动焊。

/**
 * 把 `fromId` 并进 `intoId`。
 *
 * 做四件事：① `from` 的 id 与别名进 `into.aliases`（从此同一个标签）
 * ② `from` 的 surface（昵称）搬给 `into`（文本匹配也跟着合并）
 * ③ 从词表里**删掉** `from` 实体（它的标签不再指人 ⇒ 写进沿革）
 * ④ 把 `from` 的快照记进沿革条目的 `removed` ⇒ **取消合并是可逆的**
 *
 * @param {object} rt
 * @param {string} fromId 被并方实体 id（`qq:123`）
 * @param {string} intoId 规范方实体 id
 */
export async function mergeEntities(rt, fromId, intoId) {
  await ensureIdentity(rt);
  const n = rt.normalizer;
  const from = n.entities.get(String(fromId));
  const into = n.entities.get(String(intoId));
  if (!from || !into) {
    return { ok: false, error: '实体不存在：from / into 都必须是当前词表里的 id（先用 /identity/suggest 或 /identity 查）' };
  }
  if (from.id === into.id) return { ok: false, error: '不能并到自己' };

  const fromLabel = n.labelById.get(from.id) || '';
  const intoLabel = n.labelById.get(into.id) || '';
  if (!fromLabel || !intoLabel) return { ok: false, error: '两边都得有标签才谈得上合并' };

  const kept = entityLabels(n);
  const removed = {
    id: from.id,
    kind: from.kind,
    surface: [...from.surface],
    aliases: [...from.aliases],
    label: fromLabel
  };

  for (const s of from.surface) into.surface.add(s);
  for (const a of from.aliases) into.aliases.add(a);
  into.aliases.add(from.id);
  n.entities.delete(from.id);

  n.setVocabulary([...n.entities.values()], { keepLabels: kept });
  n.save();

  const root = await dataDir();
  const lin = appendLineage(root, [{ from: fromLabel, to: intoLabel, removed }], 'merge');

  // 合并改变了归一化输出（原本是 `fromLabel` 的文本现在是 `intoLabel`）
  // ⇒ 受影响块的 `sourceHash` 会变 ⇒ 交给既有的重索引路径，不在这里自作聪明。
  rt.identityStats = null;   // 强制下次重算概览
  return {
    ok: true,
    action: 'merge',
    from: { id: removed.id, label: fromLabel, surfaces: removed.surface },
    into: { id: into.id, label: intoLabel },
    lineage: { ok: lin.ok !== false, added: lin.added || 0, total: lin.total ?? null },
    note: '合并只改身份，不重算历史：边层是只读派生（每次现算），下一次扫图自动生效；' +
      '备注经标签沿革表折叠，不需要改写。需要重嵌入的块由 sourceHash 变化自然带出。'
  };
}

/**
 * 取消一次合并（把沿革条目 `removed` 里那份快照放回词表）。
 * 沿革条目的落点会**改指**回恢复出来的新标签 —— 这是全项目**唯一**允许改指的地方。
 */
export async function unmergeEntity(rt, fromId) {
  await ensureIdentity(rt);
  const n = rt.normalizer;
  const root = await dataDir();
  const { entries } = readLineage(root);
  const key = String(fromId);
  const hit = Object.entries(entries).find(([, v]) => v?.removed && String(v.removed.id) === key);
  if (!hit) return { ok: false, error: `沿革表里找不到 ${key} 的合并记录（只录过合并的才谈得上取消）` };
  const [fromLabel, rec] = hit;

  // ⚠️ `rec.to` 是**标签**（`P1826`），不是实体 id。这里曾经直接拿它去查 `entities`
  //    ⇒ 永远查不到 ⇒ 报"落点已不在词表里"。沿革的键值两端都是标签，
  //    要用它必须经 `byLabel` 反查回实体。**"看着像 id 的串"是最容易混的一类。**
  const intoId = n.byLabel?.get(String(rec.to)) || '';
  const target = intoId ? n.entities.get(intoId) : null;
  if (!target) {
    return { ok: false, error: `合并的落点标签 ${rec.to} 现在解析不到实体（可能又被并到别处），请先在 /identity 里核对` };
  }
  const kept = entityLabels(n);
  target.aliases.delete(key);
  for (const s of rec.removed.surface || []) target.surface.delete(s);

  const restored = {
    id: rec.removed.id,
    kind: rec.removed.kind || 'person',
    surface: new Set(rec.removed.surface || []),
    aliases: new Set(rec.removed.aliases || [])
  };
  n.entities.set(restored.id, restored);
  n.setVocabulary([...n.entities.values()], { keepLabels: kept });
  n.save();

  const newLabel = n.labelById.get(restored.id) || '';
  // 沿革条目**必须改指**：合并时记的是"这个标签从此是那个人的"，现在不成立了。
  // `newLabel === fromLabel` 时改指成**自己** —— 那不是空操作，而是**作废**：
  // `readLineage()` 会丢掉所有自指条目（`k === to`），于是这条沿革从有效表里消失。
  // 实测这一步是必须的：编号由 HMAC 确定性派生 ⇒ 恢复出来的人**常常拿回原来的号**
  // （测试里就是 `P7334 → P7334`），不改指的话他的备注会继续显示在规范方身上。
  const rep = newLabel ? repointLineage(root, fromLabel, newLabel, 'unmerge') : { ok: false, error: '恢复出来的实体没有标签，沿革未动' };
  rt.identityStats = null;
  return {
    ok: true,
    action: 'unmerge',
    from: { id: restored.id, label: fromLabel },
    restoredLabel: newLabel,
    repointed: rep.ok !== false,
    lineageVoided: rep.ok !== false && newLabel === fromLabel,
    note: '沿革条目已改指/作废 ⇒ 那个人原本的备注会回到他身上，规范方不再显示它。'
  };
}

/**
 * 合并**建议表** —— 只看"同一个昵称挂在多个实体 id 上"。
 * 只产建议，不做任何写入；判定与执行之间隔着用户的点名（纪律）。
 */
export async function suggestMerges(rt) {
  await ensureIdentity(rt);
  const n = rt.normalizer;
  /** @type {Map<string, Array<{id:string,label:string}>>} */
  const bySurface = new Map();
  for (const e of n.entities.values()) {
    for (const s of e.surface) {
      if (!s) continue;
      if (!bySurface.has(s)) bySurface.set(s, []);
      const bucket = bySurface.get(s);
      if (!bucket.some((x) => x.id === e.id)) bucket.push({ id: e.id, label: n.labelById.get(e.id) || '' });
    }
  }
  const groups = [];
  for (const [surface, cands] of bySurface) {
    if (cands.length < 2) continue;
    groups.push({ surface, candidates: cands, reason: 'surface' });
  }
  groups.sort((a, b) => b.candidates.length - a.candidates.length || a.surface.localeCompare(b.surface));

  // 已经点过名的（= 已进别名的，或已被并走）不再出现在建议里。
  // 但**要记账**：合并之后那个昵称会"无声消失"，而用户需要看到"它去哪了"。
  // 判据取自沿革表（`why='merge'` 的条目里存着被并方的 surface），
  // 而不是从"剩下的候选人不足两个"倒推 —— 那会把"本来就只有一个人用这个名字"
  // 也误报成"你合并过"。
  const root2 = await dataDir();
  const { entries } = readLineage(root2);
  const mergedSurfaces = new Set();
  for (const v of Object.values(entries)) {
    if (v?.why !== 'merge' || !v.removed) continue;
    for (const s of v.removed.surface || []) mergedSurfaces.add(String(s));
  }
  const kept = [];
  const dropped = [];
  for (const g of groups) {
    const unresolved = g.candidates.filter((c) => !n.aliasById?.has(c.id));
    if (unresolved.length >= 2) kept.push({ ...g, candidates: unresolved });
    else dropped.push(g.surface);
  }
  for (const s of mergedSurfaces) if (!dropped.includes(s)) dropped.push(s);
  return {
    ok: true,
    count: kept.length,
    groups: kept,
    alreadyMerged: dropped.sort(),
    note: '同名**不等于**同一个人（中文短昵称在群里容易撞车）⇒ 这里只产建议。' +
      '点过名之后 `POST /identity {action:"merge", from, into}` 才写入词表。'
  };
}

// ── 运行期装配 ───────────────────────────────────────────────────────────
export async function getRuntime() {
  // 每次取运行期都刷新一遍设置副本：面板改完设置立刻点按钮就该生效，
  // 而不是"改动生效要等重启宿主"。入口只有这一处，别再散落到各个路由里。
  if (runtime) { await refreshSettings(runtime); return runtime; }
  const dir = await dataDir();
  const settings = await pluginSettings();
  const policyBaseline = loadPolicyBaseline(dir);
  const store = openActiveVectors(dir);
  // 归一化器是本机件，落在 <DATA_DIR>/memory-vec/normalizer/：
  //   secret.key      本机密钥（派生占位符，不可反推）
  //   entities.json   占位符 ↔ 实体映射表（最敏感资产，等同通讯录）
  //   registry.json   实体注册表（第二敏感）
  //   pending.json    待审池
  const normalizer = getSharedNormalizer({ dir: path.join(dir, 'normalizer') });
  runtime = {
    policyBaseline,
    dir,
    store,
    settings,
    normalizer,
    horizon: null,
    identityLoaded: false, // 「词表装载过没有」的**唯一**判据（见 vocabularyNeeded）
    vocabularySelfAliases: null, // 上次装载用的别称签名（设置改了它就换，见 vocabularyNeeded）
    vocabularyArchiveSig: null,  // 上次装载时的**存档指纹**（存档长了就换，见 vocabularyNeeded）
    identityStats: null,
    lastIndex: null,
    lastError: null,
    rankDist: null,        // 六维分布（M1 影子）的缓存，60 秒 TTL
    rankShadowAt: 0,       // 上次写影子账本的时刻（限流用）
    graphCache: null,      // 星图取数（G1）的缓存，120 秒 TTL
    factStore: null,       // M4 事实槽（lazy，见 factStoreOf）
    judgeLimiter: null,    // M4 第二段的频率闸门（lazy）
    lastJudge: null,       // 最近一轮判定批的日志（无内容，见 runJudgeScan）
    lastConsolidate: null, // 最近一轮**事件整理**的结果（M5，见 runConsolidateNow）
    timer: null,
    consolidateTimer: null,
    startedAt: Date.now()
  };
  globalThis.__memoryVec = runtime;
  armTimer(runtime, settings);
  armConsolidateTimer(runtime, settings);
  // 词表可以晚点装（首次全量扫存档要几秒），但索引前必须装好 —— runIndex 里会兜底
  ensureIdentity(runtime).catch((err) => {
    runtime.lastError = { at: Date.now(), where: 'identity', message: String(err?.message ?? err) };
  });
  // 群名（星系标签的真名）**预热一次**：它是本机的一次只读 HTTP 请求，几毫秒。
  // 不预热也行（`/identity/names` 首次会自己等一次），但那会让**第一次打开星图**的人
  // 多等一个来回；预热把它挪到进程启动的空白期。失败只记在模块状态里，不影响任何功能
  // （星图退回占位符显示，`/identity/names` 会把 `error` 带出去）。
  if (!isCanonicalSource(await dataRoot())) warmGroupNames(runtime);
  return runtime;
}

/** 预热群名：拿 sourceRoot 自己解析，不依赖调用方。失败静默记状态，不抛。 */
function warmGroupNames(rt) {
  dataRoot()
    .then((root) => refreshGroupNames({
      libDir: rt.dir, sourceRoot: root, settings: rt.settings,
      scopeLabel: rt.normalizer?.scopeLabel?.bind(rt.normalizer)
    }))
    .then((r) => { rt.__groupNamesWarm = r; })
    .catch((err) => { rt.__groupNamesWarm = { ok: false, error: String(err?.message ?? err) }; });
}

function armTimer(rt, settings) {
  if (rt.timer) {
    clearInterval(rt.timer);
    rt.timer = null;
  }
  const minutes = Number(settings.autoIndexIntervalMin) || 0;
  if (!settings.autoIndexEnabled || minutes <= 0) return;
  rt.timer = setInterval(() => {
    // 定时索引失败不能把进程打挂：记下来，界面上能看到
    runIndex({ reason: 'timer' }).catch((err) => {
      rt.lastError = { at: Date.now(), where: 'timer', message: String(err?.message ?? err) };
      console.warn('[memory-vec] 定时索引失败：', rt.lastError.message);
    });
  }, Math.max(60_000, minutes * 60_000));
}

/**
 * 事件整理的定时器（M5）。
 *
 * ⚠️ **默认不装**：`consolidateEnabled !== true` 就 return —— 整理要调模型花钱，
 * "自动花你的钱"不能是默认行为（与 `llmEndpointKind` 的 fail-closed 同一理由）。
 * ⚠️ 间隔下限 60s：`consolidateIntervalMin` 填 0 会落到 `consolidateIntervalMinDefault`，
 * 而不是"关掉"（关掉走 `consolidateEnabled`）。两个键一个管开关、一个管频率。
 */
function armConsolidateTimer(rt, settings) {
  if (rt.consolidateTimer) {
    clearInterval(rt.consolidateTimer);
    rt.consolidateTimer = null;
  }
  if (settings?.consolidateEnabled !== true) return;
  const minutes = Number(settings.consolidateIntervalMin) > 0
    ? Number(settings.consolidateIntervalMin)
    : Number(settings.consolidateIntervalMinDefault) || 30;
  rt.consolidateTimer = setInterval(() => {
    runConsolidateNow({ reason: 'timer' }).catch((err) => {
      rt.lastError = { at: Date.now(), where: 'consolidate-timer', message: String(err?.message ?? err) };
      console.warn('[memory-vec] 定时事件整理失败：', rt.lastError.message);
    });
  }, Math.max(60_000, minutes * 60_000));
}

/**
 * 跑一轮事件整理（M5）：宿主 evidence 账本 → 事件 + 人印象。
 *
 * 与 `runIndex` 的区别：索引只搬运**已有的**摘要；整理是**新造**记忆（调 LLM）。
 * 两者互不依赖：整理挂了不影响索引，索引挂了不影响整理（事件落盘先于向量化）。
 *
 * @param {{dryRun?:boolean, limit?:number, chatKey?:string, force?:boolean, reason?:string}} [opts]
 */
export async function runConsolidateNow(opts = {}) {
  const rt = await getRuntime();
  const settings = rt.settings;
  const enabled = settings.consolidateEnabled === true;
  // `force` 只给"手动点一下"用（面板/排障）。定时器永远不带 force ⇒ 关掉就是真关掉。
  if (!enabled && opts.force !== true) {
    return { ok: false, disabled: true, error: '事件整理未启用（consolidateEnabled 需显式 true）' };
  }
  const baseURL = String(settings.llmBaseURL || '').trim();
  const model = String(settings.llmModel || '').trim();
  // ⚠️ 端点缺失**不再在入口 `throw`**：没有可整理窗口时，层维护（升长期 / 回收）
  //    与模型无关，不该被"没配模型"挡住 —— "没人说话就不变淡"正是上一版的错。
  //    真正需要模型的时刻由 `runConsolidate` 判（有窗口且非重试 ⇒ 明确报"没有 LLM 入口"）。
  //    这里**不**塞一个"一调就抛"的闭包：那会把一个配置错误变成每个窗口一次
  //    "LLM 调用失败"，三次之后被认输跳过 —— 窗口被**静默吃掉**，比直接拒绝坏得多。
  const llmConfigured = Boolean(baseURL && model);
  if (rt.consolidateJob) return { ok: false, busy: true, ...rt.consolidateJob };
  rt.consolidateJob = { startedAt: Date.now(), reason: opts.reason || 'manual' };
  try {
    await ensureIdentity(rt);
    const sourceRoot = await dataRoot();
    const result = await runConsolidate({
      sourceRoot,
      libDir: rt.dir,
      settings,
      normalizer: rt.normalizer,
      factStore: factStoreOf(rt),
      store: rt.store,
      callLlm: llmConfigured ? ({ system, user }) => callLlmOpenAI({
        baseURL,
        apiKey: settings.llmApiKey,
        model,
        system,
        user,
        temperature: 0.2,          // 整理要稳定复现，不要发散
        maxTokens: Number(settings.consolidateMaxTokens) || 2000,
        timeoutMs: Math.max(10_000, Number(settings.consolidateTimeoutMs) || 180_000)
      }) : null,
      log: (level, msg) => console.warn('[memory-vec]', msg)
    }, { ...opts, reason: opts.reason || 'manual' });
    result.llmConfigured = llmConfigured;
    rt.lastConsolidate = result;
    // 端点检查的落点在这里，而不是函数入口：只有在"真的有窗口要整理、而模型没配"时
    // 才算失败（HTTP 层据此仍给 400）。没有窗口的那一轮已经跑完层维护，不该报错。
    // `runConsolidate` 会先把维护结果写进 `result`，所以即便抛出，维护的账也留得住。
    if (!llmConfigured && result.llmMissing === true) {
      throw new Error('LLM 端点地址 / 模型名为空 —— 事件整理必须调模型，不能跳过（层维护已在本轮完成）');
    }
    return result;
  } catch (err) {
    rt.lastError = { at: Date.now(), where: 'consolidate', message: String(err?.message ?? err) };
    throw err;
  } finally {
    rt.consolidateJob = null;
  }
}

/** 整理管道的只读状态（面板/排障用）：不调模型、不推进游标。 */
export async function consolidatePipelineStatus() {
  const rt = await getRuntime();
  const sourceRoot = await dataRoot();
  const st = await consolidateStatus({ sourceRoot, libDir: rt.dir, settings: rt.settings });
  return {
    ...st,
    enabled: rt.settings.consolidateEnabled === true,
    running: Boolean(rt.consolidateJob),
    lastConsolidate: rt.lastConsolidate,
    llmConfigured: Boolean(String(rt.settings.llmBaseURL || '').trim() && String(rt.settings.llmModel || '').trim())
  };
}

/** 资源释放：stop 缝与插件 deactivate 都会调。必须幂等。 */
export function disposeMemoryVec() {
  const rt = globalThis.__memoryVec;
  if (!rt) return { disposed: false };
  try {
    if (rt.timer) clearInterval(rt.timer);
    rt.timer = null;
  } catch { /* ignore */ }
  try {
    if (rt.consolidateTimer) clearInterval(rt.consolidateTimer);
    rt.consolidateTimer = null;
  } catch { /* ignore */ }
  // 向量库每次写已经落盘，这里只是明确一下"不再接受新写入"
  rt.disposed = true;
  globalThis.__memoryVec = null;
  runtime = null;
  return { disposed: true };
}

// ── 索引流程 ─────────────────────────────────────────────────────────────
/**
 * 跑一轮索引：读核心小时块 → 向量化 → 落库。
 * 已存在且源哈希未变的块会被**跳过**（幂等），所以重复点按钮不会重复烧 token。
 *
 * @param {{reason?:string, limit?:number, chatKey?:string, force?:boolean, maxEmbed?:number, dryRun?:boolean, noPublish?:boolean}} [opts]
 *   `maxEmbed`：本轮最多嵌多少条（不做完就先收尾、**不切代**，留给下一次续跑）。
 *   与"额度用尽"共用同一套进度落盘：两者都只会丢**还没写入**的那一批。
 *   `dryRun`：只扫不嵌（报要发多少条、多少条出不去、多少字），不写库、不切代。
 *   `noPublish`：构建完成但先不切代（作业写成 `ready`），用于切换前的可比对。
 */
export async function runIndex(opts = {}) {
  if (indexJob) return { ok: false, busy: true, ...indexJob.progress };
  const rt = await getRuntime();
  const settings = rt.settings;
  const health = checkEndpoint(endpointOf(settings));
  if (!health.ok) {
    // 明确拒绝，不静默跳过 —— "点了没反应"是最难查的一类反馈
    throw new EmbedError(
      'BAD_ENDPOINT',
      `嵌入端点还没配齐，无法索引：${health.problems.join('；')}。请到「设置 → 向量记忆库」填好端点、模型与 Key。`,
      { problems: health.problems }
    );
  }

  let generation = null;
  indexJob = { startedAt: Date.now(), progress: { phase: 'scan' } };
  try {
    // 出境前的第一步：词表必须在位。没有词表就归一化不出东西，
    // 而"没词表也照发"正是 ADR-0002 要防的那件事。
    await ensureIdentity(rt);
    const encoding = encodingIdentity(settings);
    // 新代机制：编码兼容 ⇒ 直接返回旧库（`publish` 是空操作）；不兼容 ⇒ 建/复用可续跑的新代。
    // ⚠️ 这里的返回值**不再包含"把旧向量复制过去"**：旧版本用 `meta.text`（被截到 400 字）
    //    重嵌一遍，既丢内容又和语料索引的 `sourceHash` 对不上（详见 vector-generation.mjs 头注释）。
    generation = await prepareVectorGeneration({ dir: rt.dir, oldStore: rt.store, settings });
    const targetStore = generation.store;
    const rebuilding = targetStore !== rt.store;

    // 语料 = 老块 + 派生块。`listCorpus` 的签名要 data 根（不是 chunks 目录），
    // 因为派生源在 `<data>/messages/` 与 `<data>/messages-cold/`。
    // `maxChars` 传进去是让它按同一份出境预算决定派生块的 summary 长度 ——
    // 两边各用一套预算的话，派生块会在归一化后突然被截掉尾部。
    let chunks = listCorpus(await dataRoot(), { maxChars: settings.maxChars });
    if (opts.chatKey) chunks = chunks.filter((c) => c.chatKey === opts.chatKey);
    const limit = Math.max(0, Number(opts.limit) || 0);
    if (limit) chunks = chunks.slice(0, limit);

    indexJob.progress = { phase: 'scan', total: chunks.length };
    const todo = [];
    let skipped = 0;
    // `broken` 是**合计**（对外字段不变，前端在用）；真正影响决策的是它的两个分项：
    //   unreadable = 块文件读不出来 / 解析失败 —— 真损坏，重建时**不允许**切换
    //   rejected   = 出境闸门拒绝（归一化失败、还有实体串）—— 数据没坏，只是不能发出去
    // 为什么非要拆开：旧代码把两者都算 `broken`，而重建路径"有任何 broken 就不 publish"，
    // 于是一条被词表挡住的块就能让整个新代永远切不过去（小号实测 39 条）。
    let broken = 0;
    let unreadable = 0;
    let rejected = 0;
    const brokenList = [];
    let redacted = 0;          // 这一批里至少动过一处的块数
    const byLayer = {};        // 各层命中次数合计
    let replacedTotal = 0;     // 总替换点（= 各层之和）
    let replacedIdentity = 0;  // 其中换成了身份占位符的（人 / 群 / 自己）

    // ── 第 ① 遍：登记（只落真值，出境文本当场丢掉）────────────────────────
    // 为什么非要有这一遍 —— 出境自检是**按批**跑的，而"哪些名字算实体"是**语料级**的
    // 事实。一遍式（边构建边登记）会让**后登记的词追溯性地否决先前已构建好的文本**：
    // 实测（502 个真块）：词表正常装载时，一遍式仍有 3 批被拒，词条是
    // ` 哈气了 喵`、`$ÿĀ  AAA群友的主人` 这类只能靠对齐层凭硬 ID 才认出来的昵称。
    // 两条纪律：
    //   · **登记先定型，构建再发生** ⇒ 出境文本是注册表的纯函数，可复算、可对拍
    //   · 登记遍吞掉归一化异常：它是本机动作、不出境；真的出不去由第 ② 遍照常记 broken
    for (const parsed of chunks) {
      const { chunk, error } = readCorpusItem(parsed);
      if (error || !chunk) continue;
      try {
        buildEmbedText(chunk, {
          normalizer: rt.normalizer,
          maxChars: settings.maxChars,
          withKeywords: settings.withKeywords !== false,
          keywordsSource: settings.keywordsSource,
          withSummary: settings.withSummary !== false,
          register: true            // 这一遍只为登记，文本丢弃
        });
      } catch { /* 第 ② 遍会重新遇到它并如实记成 broken */ }
    }

    // ── 第 ② 遍：用**已定型**的注册表构建出境文本（register:false）────────
    // `register:false` 不是省事：它把"构建"钉成**不改变真值**的纯函数 ——
    // 同一份注册表下重复构建必得同一段文本、同一个 sourceHash。
    for (const parsed of chunks) {
      const { chunk, error } = readCorpusItem(parsed);
      if (error || !chunk) {
        broken++; unreadable++;
        if (brokenList.length < 20) brokenList.push({ id: parsed.id, code: 'UNREADABLE', error: error || '空文件' });
        continue;
      }
      let info;
      try {
        info = buildEmbedText(chunk, {
          normalizer: rt.normalizer,
          maxChars: settings.maxChars,
          withKeywords: settings.withKeywords !== false,
          keywordsSource: settings.keywordsSource,
          withSummary: settings.withSummary !== false,
          register: false            // 构建不得再改注册表（第 ① 遍已完成登记）
        });
      } catch (err) {
        // 归一化失败 = 拒绝出境。这里**不能降级成"发原文"** —— 那就是把闸门拆了。
        // 但只有**这一条**不能发，不是整轮不能跑（P1）。记原因继续。
        broken++; rejected++;
        const reason = `归一化拒绝：${err?.code || ''} ${err?.message || err}`;
        if (brokenList.length < 20) brokenList.push({ id: parsed.id, code: err?.code || 'NORMALIZE_REJECT', error: reason });
        generation?.reject?.({ id: parsed.id, code: err?.code || 'NORMALIZE_REJECT', message: reason });
        continue;
      }
      if (!info.text) {
        broken++; rejected++;
        const reason = '构建出的向量化文本为空';
        if (brokenList.length < 20) brokenList.push({ id: parsed.id, code: 'EMPTY_TEXT', error: reason });
        generation?.reject?.({ id: parsed.id, code: 'EMPTY_TEXT', message: reason });
        continue;
      }
      if (info.redaction?.total) {
        redacted++;
        replacedTotal += info.redaction.total;
        replacedIdentity += info.redaction.identity || 0;
        for (const [k, n] of Object.entries(info.redaction.byLayer || {})) byLayer[k] = (byLayer[k] || 0) + n;
      }
      // 源哈希入参是**归一化后**的文本：词表变化会让哈希变化，
      // 于是"库里的向量"与"当前归一化器"始终一致（不会出现新旧词表混用的静默错配）
      const hash = sourceHash(chunk, info.text);
      const existed = targetStore.get(parsed.id);
      if (!opts.force && existed && existed.meta?.sourceHash === hash) {
        skipped++;
        continue;
      }
      todo.push({ parsed, chunk, info, hash });
    }

    // ── 只算不嵌（dry-run）──────────────────────────────────────────────
    // 用途：全量重建前先回答"要发多少条、多少条出不去、大概多少字"。
    // **必须**复用同一套扫描/构建/闸门逻辑，否则报出来的数和真跑出来的对不上，
    // 那这个预览就只是在骗人。走的是"扫到 todo 就返回"，一个字节都不出境。
    if (opts.dryRun) {
      const chars = todo.reduce((n, t) => n + String(t.info.text || '').length, 0);
      const preview = {
        ok: true, dryRun: true, at: Date.now(),
        scanned: chunks.length,
        todo: todo.length,            // 真要嵌的条数
        skipped,                      // 重建时 = 续跑已在盘上的条数
        broken, unreadable, rejected,
        brokenList,
        pendingChars: chars,
        estBatches: todo.length ? Math.ceil(todo.length / clampBatchSize(settings.embedBatchSize)) : 0,
        batchSize: clampBatchSize(settings.embedBatchSize),
        rebuilding,
        generation: rebuilding ? generation.generation : null,
        resumed: Boolean(generation?.resumed),
        aliveBefore: rt.store.count,
        // 事件向量会原样搬过去（不进语料，所以不算在 todo 里）
        eventCarry: rebuilding ? rt.store.metas.filter((m) => m && m.kind === 'event').length : 0,
        // 安全阀预览：false 表示"真跑会中止"（源根大概不可达）
        corpusFloor: Math.floor(rt.store.count * 0.5),
        floorOk: !rebuilding || (todo.length + skipped + rejected) >= Math.floor(rt.store.count * 0.5)
      };
      // 预览不改任何持久状态：把刚才建的空代目录/作业文件撤掉（只撤"本次新建的空壳"）。
      if (rebuilding && generation?.job) generation.abandonPreview?.();
      return preview;
    }

    // ── 安全阀：语料骤减时**拒绝**用新代覆盖记忆 ─────────────────────────
    // 真实场景：源根盘没挂上、`sourceRoot` 被改错、宿主清了 `memory-v2/chunks`。
    // 这时 listCorpus 会"正常返回 0 条"（不报错），新代建出来只有事件向量 ——
    // publish 之后**记忆就空了**，而且旧代还在、没人会立刻发现。
    // 判据：新代能认出的条数（要嵌 + 已在盘 + 被闸门拒）低于旧库活条数的一半 ⇒ 中止。
    // 为什么用一半而不是"必须相等"：闸门拒绝、源块被删都是正常波动，
    // 一半的骤降只可能是"看不见语料"，不是"内容变少了"。
    if (rebuilding) {
      const recognizable = todo.length + skipped + rejected;
      const corpusFloor = Math.floor(rt.store.count * 0.5);
      if (corpusFloor >= 1 && recognizable < corpusFloor) {
        generation.pause('failed', `语料只认出 ${recognizable} 条，低于旧库 ${rt.store.count} 条的一半（${corpusFloor}），拒绝切代`);
        throw new Error(
          `重建中止：本次只认出 ${recognizable} 条可用语料，旧库有 ${rt.store.count} 条。` +
          `这通常意味着源根不可达或路径配错了（sourceRoot）—— **不会**用几乎空的新代覆盖记忆。` +
          `检查源根后重跑即可，已写入的新代条目会被复用。`
        );
      }
    }

    indexJob.progress = { phase: 'embed', total: todo.length, done: 0, skipped, broken };
    let embedded = 0;
    // 续跑跳过量：重建时新代里已有同 `sourceHash` 的条目一律不重嵌（钱已经花过了）。
    const skippedResume = rebuilding ? skipped : 0;
    // 本轮的嵌入上限（可选）。到点正常收尾但**不切代**，留给下一次接着跑 —— 这是"分批跑"，
    // 和"额度用尽被动暂停"是两件事：一个是我们自己停，一个是端点让我们停。
    const maxEmbed = Math.max(0, Math.trunc(Number(opts.maxEmbed) || 0));
    let paused = '';
    // `job.embedded` 是**累计**口径（跨续跑），所以要加上进入本轮时已有的值 ——
    // 否则续跑一轮之后，"这次一共花了多少条"会被本轮的数字覆盖掉。
    const embeddedBefore = rebuilding ? (Number(generation.job?.embedded) || 0) : 0;
    // `done` 同理是累计：本轮结束时应等于「上轮已处理 + 本轮处理」，否则续跑一轮后它会退回。
    const doneBefore = rebuilding ? (Number(generation.job?.done) || 0) : 0;
    if (rebuilding && generation.job) {
      generation.progress({ total: Math.max(Number(generation.job?.total) || 0, todo.length + skipped), phase: 'embed', skippedResume });
    }
    // 单批条数走共享收敛（`0` / 缺省 / 非数值 = 未设 ⇒ `DEFAULT_BATCH_SIZE`）。
    // ⚠️ 别在这里再写一份 `Math.min(64, Number(x) || 16)`：默认值分叉两次，这次的事故
    //    就是"面板提示写 10、代码默认写 16"——两处数字各写一份，必有一个是错的。
    let batchSize = clampBatchSize(settings.embedBatchSize);
    // ⚠️ 推进量必须是**这一片实际发了多少条**（`slice.length`），**不能**写 `i += batchSize`：
    //    下面那行"学到端点上限 ⇒ 把 batchSize 改小"发生在**这一片已经成功嵌完 16 条之后**，
    //    于是 `i += batchSize` 就是 `i + 10` —— 游标**退回**到 10，10..15 被**再嵌一遍**
    //    （`embedded` 变 22，而库条数、覆盖率**都还是对的** ⇒ 静默重复计费）。
    //    突变验证过：把 `i = end` 改成 `i += batchSize`，`test/index-batch.mjs` 立刻红
    //    （`embedded=22`、请求序列多一发 6），而 `alive` / `coverage` 断言仍绿。
    for (let i = 0; i < todo.length;) {
      const slice = todo.slice(i, i + batchSize);
      const end = i + slice.length;
      // 闸门从"整批判定"拆成"逐条判定"（P1）：一批里有一条命中词表，就**只少那一条**。
      // ⚠️ 这不是放宽闸门 —— 每一条照样跑 findLeak + findEntityForm，被拒的一条都不发；
      //    变的是代价：以前"这一批不发，而块按 id 倒序 ⇒ 撞墙点之后的老块永久饿死"。
      const part = partitionBySafety(slice.map((t) => t.info.text), rt.normalizer, 'document');
      for (const r of part.rejected) {
        const t = slice[r.index];
        broken++; rejected++;
        if (brokenList.length < 20) brokenList.push({ id: t.parsed.id, code: r.code, error: r.message });
        generation?.reject?.({ id: t.parsed.id, code: r.code, message: r.message });
      }
      if (!part.clean.length) {
        // 整片都被拒 ⇒ 没有要发的，但进度必须照样前进，否则下一轮又从这一片开始
        indexJob.progress = { ...indexJob.progress, done: end };
        generation?.progress?.({ done: doneBefore + end, embedded: embeddedBefore + embedded, skippedResume, rejected, unreadable });
        i = end;
        continue;
      }
      let res;
      try {
        // 文档侧入口：不加指令前缀；`prechecked` 是因为上面**已经逐条**过过闸门了
        res = await embedDocuments(part.clean.map((c) => c.text), {
          ...endpointOf(settings),
          batchSize,        // 上面已收敛过，这里覆盖映射里的原值
          normalizer: rt.normalizer,
          log: (m) => console.warn('[memory-vec]', m)
        }, { prechecked: true });
      } catch (err) {
        // 额度/余额不足：**停在这里**，把进度留在盘上。这是"可续跑的中断"，不是"这轮失败"。
        // 用户的原话：跑一半没余额了要打标记，以免充值后把已经跑过的又跑一遍。
        if (err?.code === 'EMBED_QUOTA_EXHAUSTED') {
          paused = 'paused-quota';
          generation?.pause?.('paused-quota', `${err.message}（已停在第 ${embedded} 条，完成 ${end}/${todo.length}）`);
          throw new EmbedError(
            'EMBED_REBUILD_PAUSED',
            `嵌入额度不足，已停在 ${embedded}/${todo.length} 条。进度已落盘（rebuild-job.json），` +
            `充值后重新发起会从断点继续，**不会**重嵌已完成的条目。端点原话：${err.message}`,
            { embedded, done: end, total: todo.length, generation: generation?.generation || null, cause: err.message }
          );
        }
        throw err;
      }
      const { vectors, dim, batchLimit } = res;
      // 端点嫌这批太大时，`embedTexts` 已经自己换小批把**这一片**取回来了；
      // 这里只是把它探到的上限**记下来给后面的片用** —— 否则每一片都要先撞一次 400 才知道。
      // 只往下调，不往上调：上限是端点的负面约束，不是"它建议你调大"。
      if (batchLimit >= 1 && batchLimit < batchSize) {
        batchSize = batchLimit;
        indexJob.learnedBatchSize = batchSize;
      }
      // ⚠️ 下标走 `part.clean[k].index` 回到 `slice`，不能直接用 k ——
      //    中间被闸门剔掉的条目会让 `vectors[k]` 与 `slice[k]` **错位**，
      //    结果是"向量写进了别人的 id"，而且条数完全对得上、没有任何报错。
      for (let k = 0; k < part.clean.length; k++) {
        const t = slice[part.clean[k].index];
        targetStore.put({
          encoding,
          id: t.parsed.id,
          vector: vectors[k],
          model: settings.embedModel,
          meta: {
            ...chunkMeta(t.parsed, t.chunk, t.info),
            sourceHash: t.hash,
            embedDim: dim
          }
        });
        embedded++;
      }
      indexJob.progress = { ...indexJob.progress, done: end };
      // 每批落一次作业文件：中断（余额、断电、Ctrl+C）最多丢这一批，
      // 而这一批**没有写入** ⇒ 下次会重嵌它，不会漏。
      generation?.progress?.({ done: doneBefore + end, embedded: embeddedBefore + embedded, skippedResume, rejected, unreadable });
      i = end;
      // 这一批里凡是"同 id 换新向量"的，旧槽的墓碑必须落盘。
      // ⚠️ 后果要说准（2026-10-29 主审复核纠正）：`_load()` 有隐式去重（同 id 后者
      // 覆盖前者），所以**不会**出现"两条向量一起进 Top-K"。真正的代价是槽位白占：
      // 主号旧库 5553 槽只服务 1425 条、小号 5923 槽服务 1399 条，bin 与启动读取
      // 都按槽数付费，回收只能靠 `compact()`。flush 是"把盘上状态写对"，压缩是
      // "把空间要回来" —— 两件事。
      // 按批落而不是按条落：`_rewriteMeta` 是整表重写（行号=slot），按条做是 O(n²)。
      // 失败不打断本轮：向量本身已提交（见 `VecStore.flushTombstones`），只有墓碑
      // 维护欠着；pending 会保留到下一批重试，作业文件里同时记一笔便于事后排查。
      try {
        targetStore.flushTombstones?.();
        // 上一批欠着的墓碑这一批补上了 ⇒ 把作业文件里的告警擦掉，免得留个假警报
        if (generation?.job?.tombstonePending) generation.progress({ tombstonePending: 0, tombstoneError: null });
      } catch (err) {
        const backlog = targetStore.pendingTombstones?.size ?? 0;
        console.warn(`[memory-vec] 墓碑落盘失败（向量已提交，只有墓碑维护欠着；保留 ${backlog} 条待重试）:`, err?.message || err);
        try {
          generation?.progress?.({ tombstonePending: backlog, tombstoneError: String(err?.message || err).slice(0, 240) });
        } catch { /* 作业文件写不进去也不该再抛一层 */ }
      }
      if (maxEmbed && embedded >= maxEmbed && i < todo.length) { paused = 'paused-limit'; break; }
    }

    // ── 事件向量：先核来源身份，再决定搬不搬（0 次调用）────────────────────
    // `listCorpus` 只枚举"块"，而事件向量是升长期（promote）按窗口写进来的 ——
    // 盘点里那批 `kind=event` 的"孤立"条目就是它们，**不是**脏数据。
    // 不搬的后果很具体：新代一上线，事件语义召回就没了（IDF 路还在，但向量路空）。
    //
    // 🔴 原来的写法有两处**自证**（2026-10-29 主审 `batch-followup-acceptance.md` 驳回）：
    //    ① 解构旧行的 `model/dim` 再写 `model: settings.embedModel` ⇒ 标签是重贴的；
    //    ② 顺手写 `encoding`（当前串）⇒ 旧向量被当前编码身份背书。
    //    由此得出的"兼容"只证明"目标标签 == 目标 index"，等于用结论证明结论。
    //
    // 现在的判据：来源身份**只取旧行自己写下的** `model`/`dim` 与**旧代 index 的 encoding**。
    //   · 旧扁平布局的 `index.json` 不记 `encoding` ⇒ endpoint / revision / normalizer /
    //     documentFraming 四项**无来源记录**，判定只能是 `unknown`，不能写成 compatible。
    //   · `unknown` 默认**不搬**（fail-closed），要搬必须显式 `allowUnknownCarry`；
    //     `incompatible` 一律不搬并阻止发布。
    //   · 搬的时候标签写来源声称值、不传 `encoding` —— 不替来源背书，也不冒充重嵌已完成。
    let carried = 0;
    /** @type {null | {blocked:number, byVerdict:object, sample:object[], reason:string}} */
    let carryBlocked = null;
    let carryByVerdict = { compatible: 0, unknown: 0, incompatible: 0 };
    if (rebuilding && !paused) {
      const plan = planEventCarry({
        sourceMetas: rt.store.metas,
        sourceEncoding: rt.store.index?.encoding ?? null,
        targetIdentity: { model: settings.embedModel, dim: targetStore.index?.dim ?? null, encoding },
        hasTarget: (id) => Boolean(targetStore.get(id)),
        allowUnknown: opts.allowUnknownCarry === true
      });
      carryByVerdict = plan.byVerdict;

      for (const { meta, sourceIdentity, verdict } of plan.accepted) {
        const old = rt.store.get(meta.id);
        if (!old?.vector) continue;
        const { slot, state, dim, norm, model, indexedAt, ...content } = meta;
        targetStore.put({
          id: meta.id,
          vector: Array.from(old.vector),
          // 写来源声称的 model（记录来源），不是 settings.embedModel（宣称本代重嵌过）
          model: model ?? null,
          // ⚠️ 刻意不传 `encoding`：新代 index.encoding 由块嵌入时写入，这里传当前串
          //    等于替来源背书（`_put` 里 `if (rec.encoding) this.index.encoding = rec.encoding`）
          meta: {
            ...content,
            embedDim: dim ?? null,
            carriedFrom: 'legacy-generation',
            carryVerdict: verdict.verdict,
            carryIdentity: { model: sourceIdentity.model, dim: sourceIdentity.dim, encoding: sourceIdentity.encoding },
            carryUnknowns: verdict.unknowns
          }
        });
        carried++;
      }

      if (plan.blocked.length) {
        // ⚠️ 文案必须按**实际判定**分叉，不能按开关分叉。按开关写会出现的具体错报：
        //    换模型（incompatible）也印成"无法证实（unknown）"，于是人以为补个编码记录就能放行，
        //    实际补了也没用 —— 那是"明确不同"，不是"不知道"。
        const hasIncompatible = plan.byVerdict.incompatible > 0;
        carryBlocked = {
          blocked: plan.blocked.length,
          byVerdict: { ...plan.byVerdict },
          sample: plan.sample,
          reason: hasIncompatible
            ? '存在来源身份明确不一致的事件向量（incompatible），拒绝搬运'
            : '事件向量来源身份无法证实（unknown），按 fail-closed 拒绝搬运'
        };
      }
      generation?.progress?.({
        carried,
        carryVerdict: plan.status,
        carryByVerdict: { ...plan.byVerdict },
        ...(carryBlocked ? { carryBlocked } : {}),
        ...(plan.accepted.length ? { carrySample: plan.accepted.slice(0, 5).map((a) => ({ id: a.meta.id, verdict: a.verdict.verdict })) } : {})
      });
    }

    // ── 切换边界 ──────────────────────────────────────────────────────────
    // 三种情况**不切**，旧代继续服务（回退只需不切，不需要"用旧整库覆盖"）：
    //   · 有块读不出来（数据真坏了，重建不能掩盖它）
    //   · 额度/上限中断（还没跑完）
    if (!rebuilding) {
      rt.store = targetStore;              // 同一个对象，保持原有行为
    } else if (unreadable > 0) {
      generation.pause('failed', `有 ${unreadable} 个块读不出来，未切换`);
      throw new Error(`重建遇到 ${unreadable} 个不可读语料，旧代仍保留；修复后重试`);
    } else if (carryBlocked) {
      // 事件搬运被拒 ⇒ **不切代**。为什么不"少搬几条也能上线"：事件向量是语义召回的一条腿，
      // 悄悄少搬 = 新代上线后某些时段永远检索不到，而且没有任何报错。
      // 旧代继续服务，事件事实全在旧库里，一条没丢。
      generation.pause('carry-blocked', `${carryBlocked.blocked} 条事件未搬运：${carryBlocked.reason}`);
      throw new Error(
        `事件向量来源身份未通过核验（${carryBlocked.blocked} 条，${carryBlocked.reason}），未切换代；`
        + '旧代仍在服务，事件未丢失。可用 allowUnknownCarry 显式接受 unknown 来源，'
        + '或对这批事件定向重嵌（需先报条目数与依据）。'
      );
    } else if (paused) {
      generation.pause(paused, paused === 'paused-quota'
        ? `额度不足，停在第 ${embedded} 条`
        : `达到本轮上限 ${maxEmbed} 条，停在第 ${embedded} 条`);
    } else if (opts.noPublish) {
      // 构建完成但**先不切**：留给"新旧代同查询比对"这一步（分数不能跨模型比，
      // 但同一个模型的返回集合可以）。状态写 `ready`，下次进来会复用同一个代。
      generation.pause('ready', `构建完成（${targetStore.count} 条），未切代`);
    } else {
      generation.publish();
      rt.store = targetStore;
    }
    const result = {
      ok: true,
      at: Date.now(),
      reason: opts.reason || 'manual',
      scanned: chunks.length,
      embedded,
      skipped,
      broken,
      // 分项（`broken` 仍是两者之和，旧字段不变）：
      //   unreadable 真损坏（读不出来）—— 重建时**阻止**切代
      //   rejected   出境闸门拒绝 —— 数据没坏，只是不能发出去，只记清单
      unreadable,
      rejected,
      brokenList,
      // ── 新代相关（非重建时 rebuilding=false、其余为 null，前端可整块忽略）──
      rebuilding,
      generation: rebuilding ? generation.generation : null,
      resumed: Boolean(generation?.resumed),
      skippedResume,                                  // 续跑时"盘上已有、本次没调"的条数
      carried,                                        // 事件向量原样搬运的条数（0 次调用）
      // 事件搬运的身份结论：compatible / unknown-accepted / blocked
      // ⚠️ `carried` 只说明"搬了几条"，不说明"搬得对不对"。判"搬得对不对"看这里。
      carryVerdict: rebuilding ? (carryBlocked ? 'blocked' : (carryByVerdict.unknown ? 'unknown-accepted' : 'compatible')) : null,
      carryByVerdict: rebuilding ? { ...carryByVerdict } : null,
      carryBlocked: carryBlocked || null,
      paused: paused || null,                         // paused-limit：本轮到上限，未切代
      written: rebuilding ? targetStore.count : null,  // 新代当前已写入条数
      jobFile: rebuilding ? rebuildJobPath(rt.dir) : null,
      redacted,
      // 口径写死在这里，免得再出"数字对不上"（2.2）：
      //   replacedTotal    总替换点（含剥离的语篇标记）
      //   replacedIdentity 其中换成身份占位符的（人/群/自己）
      replacedTotal,
      replacedIdentity,
      byLayer,
      dim: rt.store.dim,
      model: rt.store.status().model,
      alive: rt.store.count,
      ms: Date.now() - indexJob.startedAt
    };
    rt.lastIndex = result;
    rt.lastError = null;
    return result;
  } catch (err) {
    const rt2 = runtime;
    if (rt2) rt2.lastError = { at: Date.now(), where: 'index', message: String(err?.message ?? err) };
    throw err;
  } finally {
    generation?.close();
    indexJob = null;
  }
}

export function indexingProgress() {
  return indexJob ? { running: true, ...indexJob.progress } : { running: false };
}

// ── 六维打分（M1 · 影子）───────────────────────────────────────────────────
/**
 * 跑一遍六维分布。M1 的全部产出就是这个 —— **只算不注入**。
 *
 * 为什么要缓存：面板一刷新就跑一次 469 个块的归一化+扫描虽然只要几十毫秒，
 * 但它是同步 CPU 活，跑在 HTTP 线程上。60 秒内的重复请求直接复用上一次结果。
 */
const RANK_TTL_MS = 60 * 1000;
const SHADOW_MIN_INTERVAL_MS = 60 * 1000;

export async function runRankScan(rt, { force = false, snapshot = true } = {}) {
  const now = Date.now();
  if (!force && rt.rankDist && rt.rankDist.__at && now - rt.rankDist.__at < RANK_TTL_MS) {
    return rt.rankDist;
  }
  // 词表必须在位：R/I/C 的原料是"占位符级实体"，没词表就只能走兜底口径，
  // 覆盖率会从 ~99% 掉到 ~28%（实测），那种分布不能拿去定权重。
  await ensureIdentity(rt);

  const chunks = [];
  let broken = 0;
  for (const p of listCorpus(await dataRoot(), { maxChars: rt.settings.maxChars })) {
    const { chunk, error } = readCorpusItem(p);
    if (error || !chunk) { broken++; continue; }
    chunks.push(chunk);
  }
  const scan = scanCorpus(chunks, { normalizer: rt.normalizer, now, baseDays: 30 });
  const dist = rankDistribution(scan, { topK: Math.max(1, Number(rt.settings.topK) || 5) });
  dist.chunks = chunks.length;
  dist.broken = broken;
  dist.__at = now;
  dist.shadow = { dir: null, written: false, at: rt.rankShadowAt || null };
  rt.rankDist = dist;

  if (snapshot && now - (rt.rankShadowAt || 0) >= SHADOW_MIN_INTERVAL_MS) {
    try {
      const dir = path.join(rt.dir, 'shadow');
      const file = appendShadowSnapshot(dist, dir);
      rt.rankShadowAt = now;
      dist.shadow = { dir, written: Boolean(file), at: now, file };
    } catch (err) {
      // 影子账本写不进去**不该让整个分布读不出来** —— 但也不能装作写了。
      dist.shadow = { dir: path.join(rt.dir, 'shadow'), written: false, at: rt.rankShadowAt || null,
        error: String(err?.message ?? err) };
    }
  }
  return dist;
}

/** 面板要读的影子历史（"这几天分布有没有变"）。 */
export function rankShadowHistory(rt) {
  return readShadowSnapshots(path.join(rt.dir, 'shadow'), 60);
}

/**
 * 逐维自检 —— 与 `/selfcheck` 里的"分布有分辨力"不是同一件事：
 * 那条看的是**向量库的相似度**（检索相不相信自己），这条看的是**六维打分**。
 * 两者都可能"看着健康但没用"，所以分开报。
 */
export function rankChecks(dist) {
  const checks = [];
  if (!dist || !dist.n) {
    checks.push({ id: 'rank-sample', label: '六维有样本', pass: null, detail: '还没跑过分布（点「跑一遍分布」）' });
    return checks;
  }
  for (const k of DIM_ORDER) {
    const v = dist.dims[k];
    let pass;
    let detail;
    if (v.src === 'missing' && v.n === 0) {
      pass = null;   // **不是通过**，也不是失败：这一层根本没有判定源，已明确记为「不做」
      detail = `无判定源（已记为「不做」，不是 0）—— ${v.source}`;
    } else if (v.dead) {
      pass = false;
      detail = `是常数 ⇒ 装了等于没装。${v.deadReason || ''}（${v.summary}）`;
    } else {
      pass = v.ok;
      detail = `${v.summary}` +
        (v.atMaxShare >= 0.4 ? ` · ⚠️ ${(v.atMaxShare * 100).toFixed(1)}% 打满 ${v.max}` : '') +
        (v.deadReason ? ` · ${v.deadReason}` : '');
    }
    checks.push({ id: `rank-${k}`, label: `六维 ${k} ${v.label}`, pass, detail });
  }
  // 影子账本：攒了几天、有没有逐日变化（"跑 3~7 天看分布"这句承诺得能被验）
  checks.push({
    id: 'rank-shadow',
    label: '影子账本在攒（分布快照）',
    pass: null,
    detail: '只记分布形状，不记逐条分数 —— 六维是确定性规则，逐条存只是复制数据'
  });
  return checks;
}

/** 分布观测：对库里全部记录的 norm 做分布（M1 接上打分后换成排序分）。 */
export function storeDistribution(rt) {
  const scores = [];
  for (const m of rt.store.metas) {
    if (m && typeof m.norm === 'number') scores.push(m.norm);
  }
  return distribution(scores, { topK: 5 });
}

// ── 星图取数（G1 · 只读派生）──────────────────────────────────────────────
// 输入是**存档**（不是块 —— 块是加权抽样，答的是显著性不是关系强度，ADR-0004）。
// 输出全部是**占位符**（节点 `a`/`b`、scope `group:C…`），一个明文 QQ 都不带（ADR-0002）。
// `intimacy_score` 的权重**留空**（ADR-0005）—— 所以这里只给两路原始通道，不合成单一分。
const GRAPH_TTL_MS = 120 * 1000;

/**
 * 跑一遍星图取数（按会话抽边 → 剪枝 → 汇总节点）。只算不注入，只读不落盘。
 *
 * @param {object} rt            运行期
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略 TTL 缓存
 * @param {number}  [opts.k=6]   每人保留 top-K 邻居（O(N²) 全连接没人看得懂，02-图谱层构思 改 4）
 * @param {string}  [opts.scope] 只看某个会话（占位符 token）；不给则全量合并
 * @param {string}  [opts.dataDir] 显式数据源（默认宿主的 data 根）——
 *        与本项目纪律一致：**取数必须写明对着哪个数据源查**（`extractScopeEdges` 同理）。
 */
export async function runGraphScan(rt, { force = false, k = 6, scope = '', dataDir: dataDirOverride = '' } = {}) {
  await ensureIdentity(rt);
  const now = Date.now();
  const cached = rt.graphCache;
  if (!force && cached && cached.k === Number(k) && now - cached.__at < GRAPH_TTL_MS) {
    return scope ? filterGraphByScope(cached, scope) : cached;
  }

  const root = dataDirOverride || (await dataRoot());
  const { edges, scopes, horizon, stats } = extractEdges({
    dataDir: root,
    normalizer: rt.normalizer,
    coocWindowMs: DEFAULT_COOC_WINDOW_MS
  });

  // 剪枝 + 汇总节点（纯函数在 `lib/edges.mjs`，便于离线测）。**只在展示层剪**，原始边仍在。
  const view = buildGraphView(edges, { k });

  // ── 哑巴星剔除（用户 #1："完全没说过话、和任何人都没有交集的，就不要记录到星图上"）──
  // 口径：**从没作为发送者出现**（存档里一条都没发过，只被 @/引用过）且**与中心零共现**
  //（= 不在任何 spokes 里）。实测 6 颗 —— 都是"被人 @ 了一次"产生的孤儿星与它的单弦。
  // 被动提及的弦仍在边层（原始边不动）；这里只是**星图不再为它画一颗光秃秃的星**。
  // 计数照报（`removedSilent`）—— 剔除不许是静默的。
  const speakers = new Set();
  for (const s of scopes) {
    for (const p of s.speakers || []) speakers.add(p);
  }
  const selfId0 = (rt.normalizer.resolveKnown && rt.normalizer.resolveKnown('self')?.label)
    || (rt.normalizer.labelOf && rt.normalizer.labelOf('self')) || '';
  const spokeIds = new Set();
  if (selfId0) {
    for (const e of edges) {
      if (e.a === selfId0) spokeIds.add(e.b);
      else if (e.b === selfId0) spokeIds.add(e.a);
    }
  }
  const isSilent = (id) => id !== selfId0 && !speakers.has(id) && !spokeIds.has(id);
  if (view.edges.some((e) => isSilent(e.a) || isSilent(e.b))) {
    const removed = view.edges.filter((e) => isSilent(e.a) || isSilent(e.b)).length;
    view.edges = view.edges.filter((e) => !isSilent(e.a) && !isSilent(e.b));
    view.nodes = buildGraphNodes(view.edges);
    view.edgeCount = view.edges.length;
    view.removedSilent = removed;
  } else {
    view.removedSilent = 0;
  }

  // ── 中心（= 机器人自己）的邻居表：**不剪枝**（`ADR-0012` §2/§3）──────────
  // 为什么单独给一份：剪枝是按"互动"取每人 top-K 的，而**只共现、零互动**的人
  // （"熟悉的陌生人"）会排在最后被剪掉 —— 可"她跟谁熟"这件事恰恰不能靠互动来筛，
  // 否则星图上会凭空少掉一批只会陪她说话的人。所以中心这一圈走**全量**。
  // 它同时是 §2 那条「方向 = Σ w_k · dir_k」里 `w_k`（per-scope 共现）的唯一来源。
  const selfId = (rt.normalizer.resolveKnown && rt.normalizer.resolveKnown('self')?.label)
    || (rt.normalizer.labelOf && rt.normalizer.labelOf('self')) || '';
  const spokes = [];
  if (selfId) {
    for (const e of edges) {
      if (e.a !== selfId && e.b !== selfId) continue;
      spokes.push({
        id: e.a === selfId ? e.b : e.a,
        cooccurrence: e.cooccurrence,
        interaction: e.interaction,
        by_scope: e.by_scope,
        scopes: e.scopes
      });
    }
  }

  const result = {
    ok: true,
    edgeAlgoVersion: EDGE_ALGO_VERSION,
    coocWindowMs: stats.coocWindowMs,
    k: view.k,
    edges: view.edges,
    nodes: view.nodes,
    center: { id: selfId, spokes },
    edgeCount: view.edgeCount,
    edgeCountRaw: view.edgeCountRaw,
    removedSilent: view.removedSilent || 0,
    scopes: scopes.map((s) => ({ scope: s.scope, kind: s.kind, messages: s.messages, members: s.members, bins: s.bins })),
    horizon,
    stats: {
      messages: stats.messages,
      archiveFiles: stats.archiveFiles,
      atHits: stats.atHits,
      quoteHits: stats.quoteHits,
      vocabHash: stats.vocabHash,
      gstamp: stats.gstamp
    },
    // 权重留空的事实要写在数据里，别只写在注释里（ADR-0005）
    intimacy_score: null,
    note: 'intimacy_score 权重留空：先跑 3~7 天看 cooccurrence.normalized × interaction.normalized 四象限散点再定。',
    __at: now
  };
  rt.graphCache = result;
  return scope ? filterGraphByScope(result, scope) : result;
}

/** 从核心配置里取一个可预填的端点（宿主 provider 的第一个）。 */
export async function presetEndpoint() {
  const cfg = await coreConfig();
  const providers = cfg?.getConfig?.()?.providers;
  if (!providers || typeof providers !== 'object') return null;
  for (const p of Object.values(providers)) {
    if (p && typeof p === 'object' && p.baseURL) {
      return {
        baseURL: String(p.baseURL),
        apiKey: String(p.apiKey || ''),
        apiKeyPresent: Boolean(String(p.apiKey || '').trim()),
        targetModel: Object.values(p.modelNames || {})[0] || (Array.isArray(p.models) ? p.models[0] : '') || '',
        displayName: String(p.displayName || p.id || '')
      };
    }
  }
  return null;
}

// ── M4 第二段：LLM 模式判定（`ADR-0019`）────────────────────────────────
// 触发式批处理：读存档 → 归一化 → 成簇 → `shouldTrigger` 过才调 LLM。
// **不进请求路径、不建队列**：抽不到（超时/解析失败/限流）⇒ 本轮跳过 + reason，
// 候选簇是纯函数产物，下一轮重算触发条件自然重判（`ADR-0018` 切窗无关纪律）。

/** 触发窗口缺省值：7 天（`ADR-0018` 决定 3 的 `horizon`；具体值**待分布校准** —— 仪表先于算法）。 */
const JUDGE_TRIGGER_HORIZON_MS = 7 * 86_400_000;

/** M4 事实槽的落点（lazy：`<DATA_DIR>/memory-vec/facts/`）。 */
export function factStoreOf(rt) {
  // ⚠️ 必须走 `openFactStore`（= 建实例 **+ 载入台账**），不能只 `new FactStore()`：
  //    构造只建空 map，`open()` 才是载入。只 `new` ⇒ `this.slots` 恒空 ⇒
  //    ① `rev` 跨进程归零；② `compareAndUpdate` 的 noop 跨进程失效（重跑同语料全量重写）；
  //    ③ `open()` 里的损坏检测（半截 JSON ⇒ 只读）根本没机会跑。
  //    原因与教训见 `lib/factstore.mjs` 的 `openFactStore` 注释 + `ADR-0023`。
  if (!rt.factStore) rt.factStore = openFactStore(path.join(rt.dir, 'facts'));
  return rt.factStore;
}

function judgeLimiterOf(rt) {
  if (!rt.judgeLimiter) rt.judgeLimiter = new RateLimiter({ perMinute: rt.settings.judgePerMinute });
  return rt.judgeLimiter;
}

/**
 * OpenAI 兼容 `/chat/completions`（温度 0）。格式错的重试在 `runJudgeBatch` 里管，
 * 这里只管"一次调用"：网络错 / HTTP 非 2xx / 响应缺字段都抛错 ⇒ 上层记 `LLM_UNAVAILABLE`。
 */
export async function callLlmOpenAI({ baseURL, apiKey, model, system, user, temperature = 0, maxTokens = 0, timeoutMs = 60_000 }) {
  const url = joinUrl(baseURL, '/chat/completions');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, Number(timeoutMs) || 60_000));
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature,
        // ⚠️ `max_tokens` 必须能显式给：推理类模型（deepseek-flash 等）的思考过程也占预算，
        //    用端点默认值很容易在正文开头就被截断（`finish_reason:"length"` + `content:""`），
        //    而那种失败在调用方看来只是"模型回了个空字符串"。
        ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: ctrl.signal
    });
    if (!resp.ok) throw new JudgeError(`LLM_HTTP_${resp.status}`, `LLM 端点 HTTP ${resp.status}`);
    const j = await resp.json();
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new JudgeError('LLM_BAD_RESPONSE', 'LLM 响应缺少 choices[0].message.content');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一轮 M4 判定：读存档尾部 → 归一化 → 成簇 → 触发过滤 → LLM 判定 → 落槽。
 *
 * @param {object} rt   runtime
 * @param {{limit?:number, dryRun?:boolean, N?:number, horizonMs?:number, dataRoot?:string}} [opts]
 *   - `limit`：取存档**最近**多少条（缺省 15000，与 `0030` 实测口径同量级）
 *   - `dryRun`：不给则用设置 `judgeDryRun`；`ADR-0019` 决定 4 —— 桩结果**不落库**
 *   - `dataRoot`：显式数据源（与 `runGraphScan` 的 `dataDir` 同纪律：取数写明对着哪个数据源查）
 * @returns 批处理结果 + `outbound`（dryRun 的核心产物：看清会送什么出去）
 */
export async function runJudgeScan(rt, { limit = 15_000, dryRun, N = 3, horizonMs = JUDGE_TRIGGER_HORIZON_MS, dataRoot: dataRootOverride = '' } = {}) {
  await ensureIdentity(rt);
  const settings = rt.settings;
  const endpointKind = String(settings.llmEndpointKind || '');
  const dry = dryRun != null ? Boolean(dryRun) : Boolean(settings.judgeDryRun);

  // 目的地声明 fail-closed（决定 1）—— dryRun 也要求：第一次出境前必须先声明去哪。
  if (endpointKind !== 'local' && endpointKind !== 'external') {
    throw new JudgeError(
      'NO_ENDPOINT_KIND',
      'llmEndpointKind 未声明（须为 local | external）—— 拒绝启动 M4 第二段（ADR-0019 决定 1，fail-closed）。到「设置」页选择端点类型。'
    );
  }
  // 真调用的配置检查（dryRun 不需要 LLM 配置）
  if (!dry && (!String(settings.llmBaseURL || '').trim() || !String(settings.llmModel || '').trim())) {
    throw new JudgeError('NO_LLM_CONFIG', 'LLM 端点地址 / 模型名为空 —— 设置页补齐后再跑（fail-visible，不静默跳过）');
  }

  // 读存档**尾部** limit 条（iterateArchive 最旧 → 最新；窗口滑动取尾）
  const root = dataRootOverride || await dataRoot();
  const tail = [];
  let total = 0;
  for (const it of iterateArchive(root)) {
    total++;
    tail.push(it);
    if (tail.length > limit) tail.shift();
  }

  // 归一化 → 候选条目。`speaker` / `target` **一律**经 `entityLabel` 落成占位符
  // （与边层**同一份映射**：`resolveKnown` 认别名 ⇒ 存档里 `senderId:'self'` 与
  //  `[CQ:at,qq=<机器人自己的号>]` 都落成 `SELF`，而不是一个陌生占位符）。
  //
  // `target` = 「对谁」（2026-10-12 起启用，`PRAGMATIC_VERSION` 6→7）：从**原始文本**的
  // `@` / `引用` 解出，正则与边层**共用** `extractAtTargets`（单一来源）。一条消息指向
  // 多个人 ⇒ **每人一条候选** —— 槽键的分量就是单个 target，压成一条会把"对谁"抹掉
  // （正是上一版把 target 恒置空的老毛病）。解不出对象时退回 `target:''`（说话人级）。
  const items = [];
  let normalized = 0;
  let targetBearing = 0;   // 观测仪表：带 target 的候选条数（只计数、不干预判定）
  /** 数据源筛选的分级计数（原因码 → 条数）。空对象 = 一条没挡，正常。 */
  const sourceRejects = Object.create(null);

  /** 存档里的 speaker 形态 → 实体 id（`'self'` 与边层 `senderEntity` 同口径）。 */
  const entityIdOf = (sid) => (String(sid) === 'self' ? 'self' : `qq:${String(sid)}`);

  // `[引用 #n]` 的反查表：`<chatKey>\u0000<id>` → senderId。
  // ⚠️ 反查只在**判定窗口（tail）内** —— 引用到窗口之外的消息解析不到（已知边界，
  //    与边层"同片解析、不跨片合并"同级，理由同 `ADR-0010` 决定 7）。
  //    id 是**会话语义**的递增号 ⇒ 跨会话会撞号，键必须带 chatKey。
  const quoteIndex = new Map();
  for (const { chatKey, message } of tail) {
    const mid = message?.id;
    if (mid !== undefined && mid !== null && message?.senderId) {
      quoteIndex.set(`${chatKey}\u0000${String(mid)}`, String(message.senderId));
    }
  }

  for (const { chatKey, message } of tail) {
    const raw = String(message?.text ?? '');
    if (!raw.trim()) continue;
    // 数据源筛选：**机器产物不是"人说的表达"**，在归一化之前就跳过。
    //   · `SYSTEM_MARKER`：平台事件（`[拍一拍]`…），`judge.mjs` 的 `SYSTEM_MESSAGE_MARKERS`；
    //   · `SCAFFOLD_TEMPLATES[].id`：宿主插件 / 机器人自己的**整句**（防撤回回执、点赞回执、
    //     忙碌心跳、下载回执）—— 它们长得像人话、能过句长下限，2026-10-17 前被当人类表达学了；
    //   · `MEDIA_VARIANT`：`[表情344]` / `[表情:托腮]` / `[音乐:…]` 这类剥不掉的媒体变体。
    // **不是文本处理口径**：不进 `stripScaffold`、不 bump `PRAGMATIC_VERSION` ——
    // 进那里等于承认"这是人类的句子、只是需要清洗"，而这些压根不是人类说的（`ADR-0038`）。
    // 分级计数（`sourceRejects`）回来路上要带上：挡得对不对靠这张分布表回看，不许静默丢。
    const rejected = classifySourceRejection(message);
    if (rejected) {
      sourceRejects[rejected] = (sourceRejects[rejected] || 0) + 1;
      continue;
    }
    let text;
    try {
      text = String(rt.normalizer.normalize(raw)?.text ?? '');
      normalized++;
    } catch {
      continue;   // 归一化拒收的单条（形态闸门抛）不进候选 —— 闸门的输出才可出境
    }
    if (!text.trim()) continue;

    const speaker = entityLabel(rt.normalizer, entityIdOf(message.senderId)) || '';

    // 「对谁」：**转成占位符之后**再去重 —— `[引用 #n]` 与 `[CQ:at,qq=…]` 常指向同一个人，
    // 但两条路给出的**实体 id 不同**（一个来自 id 反查、一个来自 at 里的号）⇒
    // 只在实体 id 层去重会留下两条"同一个人"的候选。
    const ex = extractAtTargets(raw, {
      resolveLocalId: (n) => {
        const sid = quoteIndex.get(`${chatKey}\u0000${n}`);
        return sid ? entityIdOf(sid) : null;
      }
    });
    /** @type {string[]} */
    const targets = [];
    for (const ent of ex.ids) {
      const t = entityLabel(rt.normalizer, ent);
      // 自己 @ 自己 ⇒ 丢弃（与边层 `t === me` 同判据）；同人合并成一条。
      if (t && t !== speaker && !targets.includes(t)) targets.push(t);
    }

    const base = {
      id: `${chatKey}:${message.mid ?? message.id ?? ''}`,
      speaker,
      scope: rt.normalizer.scopeLabel(chatKey),
      text,
      at: Number(message.ts) || undefined,
      // self=true = 宿主账号自己发出（机器人回复与主人手打共用此身份，见 ADR-0019 观察项 #5）。
      // **不排除、只标注**：簇聚合为 `selfN`，落槽带 `self_n`，分析层可区分贡献来源。
      self: message.self === true
    };
    if (!targets.length) {
      items.push({ ...base, target: '' });
      continue;
    }
    targetBearing++;
    for (const t of targets) {
      // `id` 加 `@<target>` 后缀：同一句 @ 两个人是**两个问题**（两条槽），
      // 证据 id 必须可区分，否则 `evidenceSetHash` 会把两批证据算成同一批。
      items.push({ ...base, id: `${base.id}@${t}`, target: t });
    }
  }

  const { clusters, stats: clusterStats } = clusterCandidates(items);

  // 观测仪表：**带 target 的簇数**（`ROADMAP #97`）。与 `targetBearingItems` 配对看 ——
  // 条目里带对象 ≠ 那些条目能成簇触发（"反复重复的短语"与"@ 某人"交集本来就小）。
  // 只计数，不干预判定。
  let targetBearingClusters = 0;
  for (const c of clusters) if (String(c.target || '')) targetBearingClusters++;

  // 观测仪表（对面 0034 回复建议）：触发簇 exemplar 里"疑似符号残片"的计数。
  // **只计数、不干预判定** —— 真开 LLM 后回看 ambiguous 分布时，
  // 能分清有多少是 `33/3/453-22-` 这类残渣贡献的。纯数字，无内容，dryRun / 真跑都带。
  let fragClusters = 0;
  for (const c of clusters) {
    if (shouldTrigger(c, { N, horizonMs }).trigger && looksLikeSymbolFragment(c.exemplar)) fragClusters++;
  }

  const batch = await runJudgeBatch({
    clusters,
    endpointKind,
    dryRun: dry,
    rateLimiter: judgeLimiterOf(rt),
    N,
    horizonMs,
    callLlm: dry
      ? null
      : (p) => callLlmOpenAI({
        baseURL: settings.llmBaseURL, apiKey: settings.llmApiKey, model: settings.llmModel, ...p
      })
  });

  // 落槽（dryRun **不落** —— 真值不被桩数据污染；端到端落库验证走临时 dataDir）
  let applied = null;
  if (batch.ok && !batch.dryRun) {
    const store = factStoreOf(rt);
    if (store.readOnlyReason) {
      throw new FactStoreError('READ_ONLY', `事实槽只读，拒绝判定落库：${store.readOnlyReason}`);
    }
    applied = { pattern: 0, facts: 0, noop: 0 };
    for (const w of batch.writes) {
      for (const put of [w.patternPut, ...w.factPuts]) {
        const r = store.put(put);   // put 内再做一次占位符 / 封闭枚举断言（双层防御）
        if (r.action === 'update') {
          if (put.fact_kind === 'pattern') applied.pattern++;
          else applied.facts++;
        } else {
          applied.noop++;
        }
      }
    }
  }

  // 日志（无内容 —— 只记字段名与簇下标，`ADR-0019` 决定 1③）
  rt.lastJudge = batch.log;
  if (!batch.ok && batch.skipped) {
    console.warn(`[memory-vec] M4 判定跳过：${batch.reason}`, batch.error || batch.parse?.detail || '');
  }

  return {
    ...batch,
    applied,
    obs: { fragmentExemplarClusters: fragClusters, targetBearingItems: targetBearing, targetBearingClusters },
    corpus: {
      archivedTotal: total,
      windowSize: tail.length,
      normalized,
      // 数据源筛选（`ADR-0038`）：被挡掉的消息按原因码分类计数。
      // `droppedTotal` 单独给合计 —— 与 `windowSize` 对照能一眼看出"这一窗有多少是机器产物"。
      sourceRejects,
      sourceRejectedTotal: Object.values(sourceRejects).reduce((a, b) => a + b, 0),
      clusterStats
    }
  };
}
