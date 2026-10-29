// 关系边取数（G1 星图第一批）—— 共现边 + 互动边。
//
// ── 这个文件只做一件被拍板过的事（ADR-0004 / ADR-0005 / ADR-0009）──────────
// 从**存档**（`data/messages*`）里算出两个人之间的两路信号，分开存、不合并：
//
//   cooccurrence  谁和谁常在一起（**结构**）        → 驱动星图"距离"
//   interaction   谁主动和谁交互（**行为**，有方向） → 驱动星图"粗细 / 方向"
//
// 两路**不合并进一个标量**：合并会丢掉「熟悉的陌生人」（高共现、零互动）——
// 那本身是有价值的信号（ADR-0005 决定 1）。
//
// ── 三条硬约束（都来自 ADR，别在实现里绕开）─────────────────────────────
// ① **只读**：存档与块都是只读；本模块不写任何文件、不建表（ADR-0004）。
// ② **信号源是存档，不是块**：块是加权抽样，答的是"显著性"，不是关系强度（ADR-0004）。
// ③ **节点 ID 复用归一化器的占位符**（HMAC 派生）：星图数据要出境，
//    直接用 QQ 号 = 从另一条路把通讯录漏出去（ADR-0002、02-图谱层构思 改 3）。
//
// ── 两个"口径"必须写在代码里，不能留给读者猜（本项目已吃过"328/497"的亏）──
// · 共现的定义：**会话内时间窗**。把会话按窗口大小 W 连续切桶，
//   每个桶内出现过的不同说话人**两两记 +1**。"常在一起" = 经常在同一个时间桶里都开口。
//   ⚠️ W 不是拍脑袋定的常数 —— 它由 `test/edges.mjs` 的**窗口扫描**看分布选（刻度纪律）。
// · 跨会话合并：**按会话规模加权的平均**。
//   per-session 速率 r_s = raw_s / msgs_s；权重 w_s ∝ msgs_s；
//   加权平均 ⇒ `normalized = Σ(raw_s) / Σ(msgs_s)`（对**该边出现过的会话**求和）。
//   注意分母是"共现过的会话"，不是全部会话 —— 否则会塌成全局 `raw/total`，加权就白做了。
//
// ── 明确留空的东西 ──────────────────────────────────────────────────────
// `intimacy_score` 的权重**留空**（ADR-0005 硬约束）：G1 期间它只算不用、
// 不参与注入与排序，先跑 3~7 天看 `cooccurrence.normalized × interaction.normalized`
// 的四象限散点分布，再定权重。本模块因此**不导出任何合成的单一分数**。
import crypto from 'node:crypto';

import { listArchiveFiles, readArchive } from './vocab.mjs';
import { NORMALIZER_VERSION } from './normalize.mjs';

/** 边算法版本：进**边层戳**，任何口径变化都必须 +1。 */
export const EDGE_ALGO_VERSION = 1;

/**
 * 语用层（`pattern` / `speaker_profile`）**判定逻辑**的版本号 —— 保留位。
 *
 * ⚠️ 以前"判定逻辑版本"（触发阈值、句长下限、相似度口径）**不在任何戳里**：
 * `gstamp` 只覆盖数据层，漏了语义层 ⇒ "触发阈值 3→4"这类**逻辑变更不会让任何
 * read-model 失效** —— 静默过期。
 * ⇒ 语用层落地时用它算**语用层自己的戳**：
 *   `layerStamp('pragmatic', PRAGMATIC_VERSION, baseParams({ … }))`；
 *   **不塞进边层的 `gstamp`** —— 边层不替语义层背书（ADR-0013）。
 *
 * 版本沿革（"阈值即逻辑"：判定口径一变就 +1）：
 *   1 —— 初值（语用层保留位）。
 *   2 —— `ADR-0018`：句长下限口径（**CJK 字 → 有效字符**）、相似度**剥标点**、
 *        `horizon` 改**最密窗口**。三处都是**判定逻辑**，不 bump 就会静默过期。
 *   3 —— `ADR-0018` 决定 6：**占位符并入脚手架**（`stripScaffold` 按 `PLACEHOLDER_PATTERN`
 *        结构剥所有 `〔…〕`）—— 相似度与口头禅的**输入文本**变了，判定逻辑变更。
 *   4 —— `ADR-0021`：**纯字母 ASCII 的实体串必须整词匹配**（`_isBoundaryOk` 第 ② 条）。
 *        实测 502 块里，不整词匹配会替掉 30 处**别的词**（`qwen`←`qwe`、`sessions`←`sion`）。
 *        归一化器的**输出文本**变了 ⇒ 出境文本、`sourceHash` 全变，判定逻辑变更。
 *        同轮另加的「自我别称」是**词表输入**（不是判定逻辑），但它同样改变输出文本，
 *        所以并到同一个版本里 —— 版本号管的是"产出会不会变"，不是"改动叫什么名字"。
 *   5 —— `ADR-0005`（2026-10-09，`ROADMAP #6`）：**合并转发正文里的说话人标签遮蔽**
 *        （`- 某名: 内容` 与 `某名: [媒体]/@某人` ⇒ 名字换 `〔SPEAKER〕`）。
 *        实测 502 块里 1 块：昵称只出现在转发块里 ⇒ 不挨硬 ID、不是常见姓 ⇒ 各层都登记不到
 *        ⇒ 原样出境。遮蔽改变归一化器的**输出文本**（既影响出境/`sourceHash`，
 *        也影响相似度与句长——名字段从"内容"变成占位符，随后被 `stripScaffold` 剥掉）。
 *        后果：既有语用层事实的 `logic_version` 落后于 5 ⇒ 下一次真判按新口径**重新派生**
 *        （slots 是 append-only 真值，不删不改；这是设计好的重算路径，不是数据损坏）。
 */
export const PRAGMATIC_VERSION = 7;
// 版本沿革：
//   4 → 5  合并转发说话人标签遮蔽（`ADR-0005`，2026-10-09）
//   5 → 6  合并转发标记本体剥离（2026-10-09 拍板，`ROADMAP #9` 关闭）：
//          `[合并转发 共N条]` / `[合并转发聊天记录]` 是客户端 UI 文字，属脚手架，
//          全留会让转发块相似度互相虚高。归一化输出文本变 ⇒ 全库 `sourceHash` 变
//          ⇒ 整库重嵌入（与 `keywordsSource=filtered` 切换同批做，一趟重算办两件事）。
//   6 → 7  **候选条目的「对谁」（`target`）启用**（2026-10-12，用户拍板，`ROADMAP #97`）：
//          过去 `backend.mjs` 的候选构造把 `target` **恒置空**（"说话人级簇"，
//          M4 后续段预留）；现从原始文本的 `@` / `引用` 解出，正则与边层**共用**
//          `extractAtTargets`（单一来源）。**判定输入变了** —— 簇的粒度由
//          `(speaker,scope)` 变为 `(speaker,target,scope)`（同一句话 @ 两个人会成两簇）
//          ⇒ 不 bump 就会让既有 read-model **静默过期**（`factstore` 靠 `logic_version`
//          判过期，正是本版本号存在的理由）。

/**
 * 共现时间窗的**暂拟**默认值（1 小时）。
 * ⚠️ 这不是拍板的常数 —— 用 `test/edges.mjs` 的窗口扫描看分布后选定。
 * 之所以暂取 1 小时：核心小时块的粒度就是"小时"，存档侧的原始共现用同量级窗口
 * 才有可比性（块答显著性，这里答关系强度）。
 */
export const DEFAULT_COOC_WINDOW_MS = 60 * 60 * 1000;

/** 互动边只在**群**会话建（ADR-0005 决定 2：私聊 `@` 恒为 0，轮次交替会造假阳性）。 */
function isGroupScope(chatKey) {
  return /^group:/.test(String(chatKey || ''));
}

/** 一条消息的发送者 → 实体 id（`self` 保留，其余 `qq:<数字>`）。 */
function senderEntity(m) {
  const sid = m?.senderId ? String(m.senderId) : '';
  if (!sid) return '';
  return sid === 'self' ? 'self' : `qq:${sid}`;
}

/**
 * 实体 id → 占位符。先走 `resolveKnown`（认别名，`[CQ:at,qq=<机器人自己的号>]` 必须落成 `SELF`），
 * 再走 `labelOf`（未知实体给临时占位符）。两条路都**不产生明文 QQ**。
 *
 * ⚠️ **边层（星图节点）与事实层（槽的 `target`）共用这一份** —— 同一个实体在两条路上
 * 必须落成**同一个占位符**，否则"和谁有边"与"对谁说过话"会对不上号（本项目纪律：
 * 跨层的映射只留一个入口，见 `ADR-0023` 的教训）。
 */
export function entityLabel(normalizer, entityId) {
  if (!entityId) return '';
  const known = normalizer.resolveKnown ? normalizer.resolveKnown(entityId) : null;
  if (known && known.label) return known.label;
  return normalizer.labelOf(entityId);
}

const RE_AT = /\[CQ:at,qq=(\d+)\]/g;
const RE_QUOTE_QQ = /\[\s*引用\s+[^\[\]：:\n]{1,40}?\(QQ:(\d+)\)\s*[：:]/g;
const RE_QUOTE_LOCAL = /\[\s*引用\s+#(\d+)\s+/g;

/**
 * 从**原始文本**解出「被指向者」的实体 id（`@` 与 `引用`）。
 *
 * ⚠️ **正则只有这一份**：边层（`extractScopeEdges`）与 M4 候选条目（事实层的 `target`）
 * 共用它 —— 否则"谁 @ 了谁"在两条路上会答出不同的数（同 `ADR-0013` 的 `rank_version`
 * 教训：两处各写一套 ⇒ 必漂移）。纯函数：不读文件、不写状态、不碰归一化器
 * （实体 id → 占位符由调用方 `entityLabel` 做）。
 *
 * @param {string} rawText 存档里的**原始**消息文本（含 `[CQ:at,qq=…]` / `[引用 …]`）
 * @param {{resolveLocalId?:(n:string)=>string|null}} [opts]
 *        `[引用 #n]` 的反查：返回**实体 id**（`self` / `qq:<数字>`）；查不到返回 null
 * @returns {{ids:string[], atHits:number, quoteHits:number, quoteUnresolved:number}}
 *        `ids` 去重、保序（`@` 在前、`引用` 在后）
 */
export function extractAtTargets(rawText, opts = {}) {
  const text = String(rawText || '');
  const resolveLocalId = typeof opts.resolveLocalId === 'function' ? opts.resolveLocalId : null;
  const ids = [];
  const seen = new Set();
  let atHits = 0;
  let quoteHits = 0;
  let quoteUnresolved = 0;
  const push = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
  if (!text || (text.indexOf('@') < 0 && text.indexOf('引用') < 0)) {
    return { ids, atHits, quoteHits, quoteUnresolved };
  }
  let mm;
  RE_AT.lastIndex = 0;
  while ((mm = RE_AT.exec(text)) !== null) { push(`qq:${mm[1]}`); atHits++; }
  RE_QUOTE_QQ.lastIndex = 0;
  while ((mm = RE_QUOTE_QQ.exec(text)) !== null) { push(`qq:${mm[1]}`); quoteHits++; }
  RE_QUOTE_LOCAL.lastIndex = 0;
  while ((mm = RE_QUOTE_LOCAL.exec(text)) !== null) {
    const id = resolveLocalId ? resolveLocalId(String(mm[1])) : null;
    if (!id) { quoteUnresolved++; continue; }
    push(id);
    quoteHits++;
  }
  return { ids, atHits, quoteHits, quoteUnresolved };
}

/** 无序对键：保证 `(a,b)` 与 `(b,a)` 落到同一条边。 */
function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

/**
 * **按会话**（scope）提取边。这是最小可信单元：径向单人视图按 scope 看，
 * 跨会话合并单独做（`mergeScopeEdges`）。
 *
 * @param {object} opts
 * @param {string} opts.dataDir              宿主的 data 目录（含 messages / messages-cold）
 * @param {import('./normalize.mjs').Normalizer} opts.normalizer  已 setVocabulary 的归一化器
 * @param {number} [opts.coocWindowMs]       共现时间窗（默认 1h，见 DEFAULT_COOC_WINDOW_MS）
 * @param {boolean} [opts.mineInteraction=true] 是否抽互动边（关掉只剩共现，用于对拍）
 * @returns {{scopes:Array<object>, horizon:object, stats:object}}
 */
export function extractScopeEdges(opts = {}) {
  const { dataDir, normalizer } = opts;
  if (!dataDir) throw new Error('extractScopeEdges 需要 dataDir（写清对着哪个数据源查，是本项目纪律）');
  if (!normalizer) throw new Error('extractScopeEdges 需要 normalizer（节点 ID 必须由占位符派生）');
  // ⚠️ `scope` 是一条**独立的身份通道**：节点 `a`/`b` 早就走占位符，`scope` 却一直沿用明文 `chatKey`。
  //    而私聊的 `chatKey` 就是**对方的明文 QQ**（实测 `private:100000001`）。
  //    本轮把 `scope` 提进产事实级键（ADR-0015）后，它更是**键的一部分** ⇒ 必须落占位符。
  //    ⇒ 缺 `scopeLabel` 就**抛**，而不是退回明文（退回 = 静默重开泄密通道）。
  if (typeof normalizer.scopeLabel !== 'function') {
    throw new Error('extractScopeEdges 需要 normalizer.scopeLabel（scope 必须由占位符派生，否则星图数据会带明文 QQ/群号）');
  }
  const W = Number(opts.coocWindowMs) > 0 ? Number(opts.coocWindowMs) : DEFAULT_COOC_WINDOW_MS;
  const mineInteraction = opts.mineInteraction !== false;

  let minTs = 0;
  let maxTs = 0;
  let messages = 0;
  let atHits = 0;
  let quoteHits = 0;
  let quoteUnresolved = 0;
  let skippedPrivateInteraction = 0;
  let archiveFiles = 0;

  // ⚠️ **一个 chatKey 会横跨多个文件**（热片 + 每个冷片 5000 条）。
  //    会话的粒度是 `chatKey`，不是文件 —— 按文件切会把一个群拆成几十个"会话"，
  //    还会把跨文件的时间桶从中间切断（共现被系统性低估）。
  //    ⇒ 必须先用 chatKey 聚合，再算桶。
  //    ⚠️ **`byChat` 的键仍是明文 chatKey（内部用、不出境）**；
  //       投出去的 `scope` 字段一律是**占位符 token**（`normalizer.scopeLabel`）。
  /** @type {Map<string, {scope:string, kind:string, messages:number, speakers:Set<string>, bins:Map<number,Set<string>>, cooc:Map<string,number>, inter:Map<string,number>}>} */
  const byChat = new Map();
  const accFor = (chatKey) => {
    let a = byChat.get(chatKey);
    if (!a) {
      a = {
        // 明文 chatKey 只作 Map 键；对外**只有**占位符 token（`group:C1234` / `private:C5678`）。
        scope: normalizer.scopeLabel(chatKey),
        kind: isGroupScope(chatKey) ? 'group' : 'private',
        messages: 0,
        speakers: new Set(),
        bins: new Map(),
        cooc: new Map(),
        inter: new Map()
      };
      byChat.set(chatKey, a);
    }
    return a;
  };

  for (const { file } of listArchiveFiles(dataDir)) {
    const r = readArchive(file);
    if (r.error) continue;
    archiveFiles++;
    const chatKey = r.chatKey || String(file).replace(/\.json$/, '').split(/[\\/]/).pop();
    const acc = accFor(chatKey);

    // 本片内 `id → senderId`：`[引用 #n]` 的 n 要反查被引用者（n = 宿主的会话级递增 id）。
    // 同片可解析率实测 99.73%，不做跨片合并（ADR-0010 决定 7 的"已知边界"）。
    const localIndex = new Map();
    for (const m of r.messages) {
      if (m && m.id !== undefined && m.id !== null && m.senderId) localIndex.set(String(m.id), String(m.senderId));
    }

    for (const m of r.messages) {
      if (!m || typeof m !== 'object') continue;
      const ts = Number(m.ts) || 0;
      if (ts > 0) {
        if (!minTs || ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      const senderId = senderEntity(m);
      if (!senderId) continue;
      // ⚠️ 收集时**就地**落成占位符：map 里存的、`a`/`b` 里的，必须全程是占位符，
      //    绝不能是实体 id（`qq:123`）—— 那等于把 QQ 号写进星图数据（ADR-0002 改 3）。
      const me = entityLabel(normalizer, senderId);
      if (!me) continue;
      messages++;
      acc.messages++;
      acc.speakers.add(me);   // 该会话说过的不同人数（星图的"球半径 ∝ ∛成员数"要用）

      // ── 共现：按时间桶收集说话人（桶键是全局 ts 桶，跨文件自然接续）────────
      if (ts > 0) {
        const bin = Math.floor(ts / W);
        let set = acc.bins.get(bin);
        if (!set) { set = new Set(); acc.bins.set(bin, set); }
        set.add(me);
      }

      // ── 互动：只群会话（ADR-0005 决定 2：私聊 `@` 恒为 0，轮次交替会造假阳性）
      if (!mineInteraction) continue;
      if (acc.kind !== 'group') { skippedPrivateInteraction++; continue; }
      const text = String(m.text || '');
      if (!text || (text.indexOf('@') < 0 && text.indexOf('引用') < 0)) continue;

      /** @type {string[]} 被指向者的**实体 id**（先收实体，再统一转占位符） */
      const ex = extractAtTargets(text, {
        resolveLocalId: (n) => {
          const sid = localIndex.get(String(n));
          return sid ? (sid === 'self' ? 'self' : `qq:${sid}`) : null;
        }
      });
      atHits += ex.atHits;
      quoteHits += ex.quoteHits;
      quoteUnresolved += ex.quoteUnresolved;

      for (const targetId of ex.ids) {
        const t = entityLabel(normalizer, targetId);
        if (!t || t === me) continue;
        bump(acc.inter, pairKey(me, t));
      }
    }
  }

  // 全部文件读完后，再把每个会话的时间桶两两展开成共现对
  // （必须等同一 chatKey 的全部文件都进来 —— 跨文件的时间桶要接得上）。
  const scopes = [];
  for (const acc of byChat.values()) {
    for (const set of acc.bins.values()) {
      if (set.size < 2) continue;
      const arr = [...set];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) bump(acc.cooc, pairKey(arr[i], arr[j]));
      }
    }
    scopes.push({
      scope: acc.scope,
      kind: acc.kind,
      messages: acc.messages,
      members: acc.speakers.size,
      speakers: acc.speakers,   // 内部字段（Set，占位符）：backend 的哑巴星剔除要用；出境层显式挑字段 ⇒ 不会带出去
      bins: acc.bins.size,
      cooc: acc.cooc,
      inter: acc.inter,
      interactionMined: mineInteraction && acc.kind === 'group'
    });
  }

  const days = minTs && maxTs ? Math.max(0, (maxTs - minTs) / 86400000) : 0;
  const horizon = {
    start: minTs ? new Date(minTs).toISOString() : null,
    end: maxTs ? new Date(maxTs).toISOString() : null,
    days: Number(days.toFixed(2)),
    messages
  };

  return {
    scopes,
    horizon,
    stats: {
      dataDir,
      // 词表**内容**指纹（本轮新增）：`vocab_version` 是**代码常量**（`NORMALIZER_VERSION=2`），
      // 加人 / 改名 / 删人物卡**都不会**让它变 ⇒ 只靠版本号，词表漂移是**静默**的（追问 3）。
      // 内容 hash 进边层戳 ⇒ 词表内容一变，边层 read-model 立刻过期。
      vocabHash: normalizer.vocabHash ? normalizer.vocabHash() : null,
      scopes: scopes.length,
      archiveFiles,
      messages,
      coocWindowMs: W,
      minTs,
      maxTs,
      atHits,
      quoteHits,
      quoteUnresolved,
      skippedPrivateInteraction,
      horizon
    }
  };
}

/**
 * 把**按会话**的边合并成全局边（星图 + 四象限散点用）。
 *
 * 合并口径（与文件头一致，**写死**）：
 *   normalized = Σ(raw_s) / Σ(msgs_s)   —— 对**该边出现过的会话**求和
 *   session_count = 该边出现过的会话数
 *
 * `scope` 取**权重最大**的那个会话；`scopes` 列出全部会话键。
 * （`'cross'` 这个值**不在这里用** —— 它留给 M4 的跨渠道身份合并，ADR-0009 决定 6。）
 *
 * @param {Array<object>} scopeEdges `extractScopeEdges().scopes`
 * @param {object} [opts]
 * @param {string} [opts.gstamp]     全局戳（不给则不挂 derived_from）
 * @param {object} [opts.params]     全局戳的**原始参数**（`gstampParams()` 的产物）—— 与 `gstamp` 一起存，供溯源
 * @param {number} [opts.rev=1]      每边修订号（累积计数，只增）
 * @param {string} [opts.at]         生成时刻（ISO）
 * @returns {Array<object>} 边（`{a,b,scope,scopes,by_scope,cooccurrence,interaction,intimacy_score,horizon,derived_from}`）
 */
export function mergeScopeEdges(scopeEdges, opts = {}) {
  const gstamp = opts.gstamp || '';
  const params = opts.params || null;
  const at = opts.at || new Date().toISOString();
  const rev = Number.isFinite(opts.rev) ? Number(opts.rev) : 1;

  /** @type {Map<string, {a:string,b:string, coocRaw:number, coocMsgs:number, interRaw:number, interMsgs:number, scopeW:Map<string,number>, byScope:Map<string,{coocRaw:number,coocMsgs:number,interRaw:number,interMsgs:number}>}>} */
  const acc = new Map();

  const touch = (key, a, b) => {
    let e = acc.get(key);
    if (!e) {
      e = { a, b, coocRaw: 0, coocMsgs: 0, interRaw: 0, interMsgs: 0, scopeW: new Map(), byScope: new Map() };
      acc.set(key, e);
    }
    return e;
  };
  const weight = (e, scope, msgs) => {
    // 一条边在一个会话里出现 ⇒ 该会话的规模进入分母，且记一次 scope 权重
    e.scopeW.set(scope, (e.scopeW.get(scope) || 0) + msgs);
  };
  // **per-scope 分账**（2026-10-11，`ADR-0012` §4）：这条边在每个会话里各自算出了多少。
  // 值本来就在 `extractScopeEdges` 里算过，只是过去加总后被丢掉 ⇒ 单群视图拿不到真值。
  // 这里只**透出**，不参与任何已定口径的计算（合并值仍走 coocRaw/coocMsgs）。
  const scopeAcc = (e, scope) => {
    let v = e.byScope.get(scope);
    if (!v) { v = { coocRaw: 0, coocMsgs: 0, interRaw: 0, interMsgs: 0 }; e.byScope.set(scope, v); }
    return v;
  };

  for (const s of scopeEdges) {
    const msgs = Math.max(1, Number(s.messages) || 0);
    for (const [k, raw] of s.cooc) {
      const [a, b] = k.split('\u0000');
      const e = touch(k, a, b);
      e.coocRaw += raw;
      e.coocMsgs += msgs;
      weight(e, s.scope, msgs);
      const v = scopeAcc(e, s.scope);
      v.coocRaw += raw;
      v.coocMsgs += msgs;
    }
    for (const [k, raw] of s.inter) {
      const [a, b] = k.split('\u0000');
      const e = touch(k, a, b);
      e.interRaw += raw;
      e.interMsgs += msgs;
      weight(e, s.scope, msgs);
      const v = scopeAcc(e, s.scope);
      v.interRaw += raw;
      v.interMsgs += msgs;
    }
  }

  const out = [];
  for (const e of acc.values()) {
    // 主会话 = scope 权重最大者（并列时取字典序，保证确定性）
    let primary = '';
    let best = -1;
    for (const [scope] of [...e.scopeW.entries()].sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1))) {
      if (e.scopeW.get(scope) > best) { best = e.scopeW.get(scope); primary = scope; }
    }
    const scopes = [...e.scopeW.keys()].sort();
    out.push({
      a: e.a,
      b: e.b,
      scope: primary,
      scopes,
      // 每条边在每个会话里**各自**的速率（per-session 归一化 = raw_s / msgs_s）。
      // 「一群一星系」靠它把环半径摊到单群口径上（`ADR-0012` §2/§4）。
      by_scope: byScopeOf(e.byScope),
      cooccurrence: {
        raw: e.coocRaw,
        normalized: e.coocMsgs ? e.coocRaw / e.coocMsgs : 0,
        session_count: e.coocMsgs ? scopesCountFor(e, scopeEdges, 'cooc') : 0
      },
      interaction: {
        raw: e.interRaw,
        normalized: e.interMsgs ? e.interRaw / e.interMsgs : 0,
        session_count: e.interMsgs ? scopesCountFor(e, scopeEdges, 'inter') : 0
      },
      intimacy_score: null,          // 权重留空（ADR-0005 硬约束）
      horizon: opts.horizon || null,
      derived_from: gstamp ? { gstamp, params, rev, at } : null
    });
  }
  return out;
}

/**
 * per-scope 分账 → 可出境的公开形态。
 * 键按字典序排序（渲染确定性）；归一化 = raw_s / msgs_s（与 `extractScopeEdges` 同口径）。
 */
function byScopeOf(map) {
  /** @type {Record<string, {cooccurrence:{raw:number,normalized:number}, interaction:{raw:number,normalized:number}}>} */
  const out = {};
  for (const scope of [...map.keys()].sort()) {
    const v = map.get(scope);
    out[scope] = {
      cooccurrence: { raw: v.coocRaw, normalized: v.coocMsgs ? v.coocRaw / v.coocMsgs : 0 },
      interaction: { raw: v.interRaw, normalized: v.interMsgs ? v.interRaw / v.interMsgs : 0 }
    };
  }
  return out;
}

/** 该边在两个通道里各自跨了几个会话（分母口径不同：共现会话数 ≠ 互动会话数）。 */
function scopesCountFor(edge, scopeEdges, channel) {
  let n = 0;
  const key = pairKey(edge.a, edge.b);
  for (const s of scopeEdges) {
    const m = channel === 'cooc' ? s.cooc : s.inter;
    if (m && m.has(key)) n++;
  }
  return n;
}

/**
 * **基础参数**：所有派生层共享的输入 —— 数据源（词表）与观察窗。
 *
 * ⚠️ 只把**层无关**的东西放这里：它们变了，**每一层**都过期。
 * 层的**算法版本不进基础参数**（那是各层自己的事，见 `layerStamp`）。
 *
 * `vocab_hash` 是**词表内容**指纹，与 `vocab_version`（代码版本号）互补：
 * 加人 / 改名时版本号不变、内容变了 —— 靠 `vocab_hash` 才能检出（ADR-0013 / 追问 3）。
 */
export function baseParams({ vocabVersion = NORMALIZER_VERSION, vocabHash = null, horizon } = {}) {
  return {
    vocab_version: vocabVersion,
    vocab_hash: vocabHash,
    horizon: { start: horizon?.start || null, end: horizon?.end || null }
  };
}

/**
 * **分层戳**（本轮新增）：`hash(基础参数 + 层名 + 该层版本)`。
 *
 * 为什么**分层**而不是一个全局 `gstamp`：
 * 边层**不消费**排序层（`rank`）与语用层（`pattern`）的输出 ⇒ 那两层变了，
 * 边**不该**重建。旧 `gstamp` 把 `rank_version` 塞进去是**错位**（ADR-0013）：
 *   - 语义上：边层替别的层背了书（"一个字段装了两件事"）；
 *   - 实际上：`extractEdges` 从没传过它，戳里一直落在 `na` —— **声称了却没落地**。
 * ⇒ 每层只装自己的版本；跨层"要不要全量重建"用 `modelStamp()` 汇总。
 *
 * @param {string} layer    层名（`'edge'` / `'rank'` / `'pragmatic'` …）
 * @param {string|number} version 该层的算法版本（不含层名）
 * @param {object} base     `baseParams()` 的产物
 */
export function layerStamp(layer, version, base) {
  const b = base || {};
  const h = [
    b.vocab_version ?? 'na',
    b.vocab_hash ?? 'na',
    b.horizon?.start || '',
    b.horizon?.end || '',
    String(layer ?? ''),
    version ?? 'na'
  ].join('|');
  return 'g' + crypto.createHash('sha1').update(h, 'utf8').digest('hex').slice(0, 12);
}

/**
 * **跨层汇总戳**：各层戳再 hash。
 * 用途：需要"任何一层变了就整体失效"的消费口（例如总览面板），
 * 同时各层仍能用 `layerStamp` 独立判过期，层间不互相污染。
 */
export function modelStamp(stamps = {}) {
  const h = Object.keys(stamps).sort().map((k) => `${k}:${stamps[k] ?? 'na'}`).join('|');
  return 'm' + crypto.createHash('sha1').update(h, 'utf8').digest('hex').slice(0, 12);
}

/**
 * **边层**的原始参数（存进 `derived_from.params`，供溯源）。
 *
 * ⚠️ 为什么参数要单独存一份，而不是只存戳：
 * 戳是**单向 hash**，词表升级后**无法从旧 hash 反推**当时的
 * `vocab_version` / `horizon` ⇒ **溯源会断**（"这条边当时是怎么算出来的"查不到）。
 * ⇒ `derived_from` 必须**同时存两样**：
 *   - `gstamp`：**短标签**，O(1) 判"变了没有"（过期检测用）；
 *   - `params`：**原始参数**，可复现、可人读（溯源用）。
 * 两者**互为校验**：`verifyGstamp(gstamp, params)` 能发现"参数与戳对不上"的漂移。
 */
export function gstampParams({ vocabVersion = NORMALIZER_VERSION, vocabHash = null, horizon, edgeAlgoVersion = EDGE_ALGO_VERSION, coocWindowMs = DEFAULT_COOC_WINDOW_MS } = {}) {
  return {
    ...baseParams({ vocabVersion, vocabHash, horizon }),
    edge_algo_version: edgeAlgoVersion,
    cooc_window_ms: coocWindowMs
  };
}

/** 由边层**参数**算戳 —— `gstampParams` 是它唯一的输入源，两者不会各写一套而漂移。 */
function edgeStampOf(p) {
  const base = { vocab_version: p.vocab_version, vocab_hash: p.vocab_hash, horizon: p.horizon };
  return layerStamp('edge', `${p.edge_algo_version}+cooc:${p.cooc_window_ms}`, base);
}

/**
 * 边层戳 `gstamp`（ADR-0010 决定 6，经 ADR-0013 修正为**分层戳**）。
 * `hash(vocab_version, vocab_hash, horizon, edge_algo_version, cooc_window_ms)` —— 任一变则边层重建。
 */
export function computeGstamp(opts = {}) {
  return edgeStampOf(gstampParams(opts));
}

/** 用存的**原始参数**复算戳，与存的 `gstamp` 对拍（自洽校验：参数 ⇄ 戳不许脱节）。 */
export function verifyGstamp(gstamp, params) {
  return !!gstamp && !!params && edgeStampOf(params) === gstamp;
}

/** 一人一票的便捷入口：抽 → 并 → 挂 `horizon` / `derived_from`。 */
export function extractEdges(opts = {}) {
  const { scopes, horizon, stats } = extractScopeEdges(opts);
  const params = gstampParams({
    vocabVersion: opts.vocabVersion,
    vocabHash: opts.vocabHash ?? stats.vocabHash,
    horizon,
    coocWindowMs: stats.coocWindowMs
  });
  const gstamp = edgeStampOf(params);
  const edges = mergeScopeEdges(scopes, { gstamp, params, horizon, at: opts.at });
  return { edges, scopes, horizon, stats: { ...stats, gstamp, params, edgeCount: edges.length } };
}

/**
 * 剪枝：每人只留 top-K 邻居（按给定通道排序）。N 人全连接是 O(N²)，
 * 500 人群 = 12.5 万条边，力导向跑不动也没人看得懂（02-图谱层构思 改 4）。
 *
 * @param {Array<object>} edges
 * @param {number} [k=6]
 * @param {'cooccurrence'|'interaction'} [channel='interaction']
 */
export function pruneEdges(edges, k = 6, channel = 'interaction') {
  const K = Math.max(1, Number(k) || 6);
  const best = new Map();   // 节点 → 它的邻居边（按通道分数）
  const score = (e) => Number(e?.[channel]?.normalized) || 0;
  for (const e of edges) {
    for (const node of [e.a, e.b]) {
      let list = best.get(node);
      if (!list) { list = []; best.set(node, list); }
      list.push(e);
    }
  }
  const keep = new Set();
  for (const list of best.values()) {
    list.sort((x, y) => score(y) - score(x));
    for (const e of list.slice(0, K)) keep.add(e);
  }
  return edges.filter((e) => keep.has(e));
}

// ────────────────────────────────────────────────────────────────────────────
// 星图视图（G1 展示层）—— 纯函数，便于离线断言；backend 只调用不重写。
// ────────────────────────────────────────────────────────────────────────────

/** 把一条内部边转成**可出境的公开形态**（字段显式列出，避免 `...e` 把内部字段带出去）。 */
export function publicEdge(e) {
  return {
    a: e.a,
    b: e.b,
    scope: e.scope,
    scopes: e.scopes,
    by_scope: e.by_scope,
    cooccurrence: e.cooccurrence,
    interaction: e.interaction,
    intimacy_score: e.intimacy_score,     // 恒 null（权重留空，ADR-0005）
    horizon: e.horizon,
    derived_from: e.derived_from
  };
}

/** 节点 = 出现过的占位符 + 度数 / 两通道强度合计。半径 / 线宽都从这里来。 */
export function buildGraphNodes(edges) {
  const map = new Map();
  const touch = (id) => {
    let n = map.get(id);
    if (!n) { n = { id, degree: 0, cooc: 0, inter: 0 }; map.set(id, n); }
    return n;
  };
  for (const e of edges) {
    const a = touch(e.a);
    const b = touch(e.b);
    const cooc = Number(e.cooccurrence?.normalized) || 0;
    const inter = Number(e.interaction?.normalized) || 0;
    a.degree++; b.degree++;
    a.cooc += cooc; b.cooc += cooc;
    a.inter += inter; b.inter += inter;
  }
  // 稳定序：度数降序，并列按 id 字典序（保证渲染确定性）
  return [...map.values()].sort((x, y) => (y.degree - x.degree) || (x.id < y.id ? -1 : 1));
}

/**
 * 组一张**星图视图**：剪枝（每人 top-K 邻居）→ 汇总节点。
 * ⚠️ 剪枝**只在展示层**做；原始边仍在（`edgeCountRaw`），可复算。
 * （N 人全连接是 O(N²)，500 人群 = 12.5 万条边，力导向跑不动也没人看得懂，02-图谱层构思 改 4。）
 */
export function buildGraphView(edges, { k = 6 } = {}) {
  const pruned = pruneEdges(edges, k, 'interaction');
  return {
    k: Math.max(1, Number(k) || 6),
    edges: pruned.map(publicEdge),
    nodes: buildGraphNodes(pruned),
    edgeCount: pruned.length,
    edgeCountRaw: edges.length
  };
}

/** 只看单会话：把视图过滤到该 scope（边可能跨多会话 ⇒ 用 `scopes` 判定）。 */
export function filterGraphByScope(view, scope) {
  const edges = view.edges.filter((e) => e.scope === scope || (Array.isArray(e.scopes) && e.scopes.includes(scope)));
  const out = { ...view, scope, edges, nodes: buildGraphNodes(edges), edgeCount: edges.length };
  // 中心邻居表跟着筛：它虽然不剪枝，但**必须守住"这个视图只谈这个会话"**，
  // 否则切到单群之后，辐条仍来自全部会话（一个"看起来对、其实是合并值"的老毛病）。
  if (view.center && Array.isArray(view.center.spokes)) {
    out.center = {
      ...view.center,
      spokes: view.center.spokes.filter((s) => Array.isArray(s.scopes) && s.scopes.includes(scope))
    };
  }
  return out;
}
