// lib/judge.mjs —— M4 第二段：LLM 模式判定的**纯函数面**（`ADR-0019`）
//
// ── 这一层的职责边界 ─────────────────────────────────────────────────────
//   prompt 组装 + 出境双向断言 + 响应解析 + 降级 + 频率闸门。
//   **不含网络调用**（`callLlm` 由调用方注入）、**不含落库**（writes 由调用方执行）——
//   所以可以整文件离线测，`test/judge.mjs` 不需要宿主参数。
//
// ── 四条硬约束（每条对应 ADR-0019 的一个决定）─────────────────────────────
//   1. **出境 = 白名单字段 + 占位符身份 + 显式目的地声明 + 无内容日志**（决定 1）：
//      · speaker/target/scope 必须过 `RAW_ID`（与 factstore 同一正则，单一来源）；
//      · exemplar 里不得有裸号码（QQ 号 5-11 位独立数字串）——比形态闸门窄而独立的第二道；
//      · `endpointKind` 必填（`local`/`external`），缺省**拒绝启动**（fail-closed，
//        与 `NO_SCOPE_SOURCE` 同款：必填维度不许落到"看起来正常"的值上）；
//      · 日志只记 `{ts, batchId, clusterIds, fieldsSent, endpointKind, outcome, elapsedMs}`，
//        **不落内容本身** —— 日志是二次泄漏面。
//   2. **簇级原子**（决定 2）：单簇的 `{pattern_type 判定, facts 事实内容}` 要么都落要么都不落；
//      批内其他簇不受牵连。
//   3. **失败分两类**（决定 3）：
//      · **枚举外值**（pattern_type / fact kind 不在封闭枚举里）⇒ 直接 `ambiguous`，**不重试**；
//      · **格式错**（JSON 不合法 / 缺字段）⇒ 重试 1 次；仍失败 ⇒ **整批跳过 +
//        `LLM_PARSE_FAILED`**，**不落 ambiguous** —— "没判成" ≠ "判了但不确定"，
//        落 ambiguous 会让 L1 分布仪表失真（把基础设施事件伪装成判定事件）。
//      · 两种失败都记 `reason`，fail-visible。
//   4. **退避 ≠ 队列**（决定 2）：RateLimiter 失败翻倍批间间隔，`tryAcquire` 拒绝就是跳过，
//      不存在积压和重试风暴 —— 候选簇是纯函数产物，下一轮重算触发条件自然重判。

import { RAW_ID } from './factstore.mjs';
import { FACT_KIND_GROUPS } from './facts.mjs';
import { shouldTrigger } from './extract.mjs';

// ── 常量 ─────────────────────────────────────────────────────────────────

/**
 * L1 `pattern_type` 的**封闭枚举**（`ADR-0010` 决定 1 的三态；`ADR-0019` 决定 3）。
 * 身份键分量纪律的同型要求：封闭集合、**无默认值** —— 模型给的值不在里面就降级，不猜。
 */
export const PATTERN_TYPES = Object.freeze(['joke', 'sincere', 'ambiguous']);

/** 语义段事实的封闭枚举（`facts.mjs` 同源 —— 不在这里抄第二份）。 */
export const SEMANTIC_KINDS = FACT_KIND_GROUPS.semantic;

/** 格式错重试上限（`ADR-0019` 决定 3：格式错重试 **1** 次；枚举外 **0** 次）。 */
export const JUDGE_FORMAT_RETRY_MAX = 1;

/** 频率闸门缺省值（决定 2：**配置化，不硬编码** —— 这里只是缺省，宿主设置可覆盖）。 */
export const DEFAULT_PER_MINUTE = 10;
export const DEFAULT_BASE_DELAY_MS = 2_000;
export const DEFAULT_MAX_DELAY_MS = 300_000;

/**
 * 出境文本里的**裸号码**检测（QQ 号 = 5-11 位独立数字串）。
 *
 * 与 `RAW_ID`（fullmatch，管字段值）分工：这条是 **search**，管**自由文本**（exemplar）。
 * 边界用 Unicode 字母/数字，因此：
 *   `〔P7722〕`（4 位）不命中 · `P123456`（前是字母）不命中 · `group:C12345`（前是字母）不命中；
 *   `100000001 你在吗` / `group:100000001`（冒号后裸数字）命中 —— 正是要拦的。
 * 13 位以上长数字（订单号式）因后边界 fail 不命中，不误伤。
 */
export const BARE_ID_RE = /(?<![\p{L}\p{N}])(?:qq:)?\d{5,11}(?![\p{L}\p{N}])/u;

export function containsBareId(text) {
  return BARE_ID_RE.test(String(text ?? ''));
}

/**
 * **纯系统事件标记**清单（单一来源，对齐 `MEDIA_MARKER_LABELS` 的纪律）。
 *
 * "纯系统事件" = **不含"某人说了什么"** 的宿主/平台生成消息 —— 不在 M4 判定对象
 * （人类表达）的语义域内，进候选只会白烧 LLM 调用。判定对象界定属**数据源筛选**，
 * 不进 `stripScaffold`（不 bump `PRAGMATIC_VERSION`）。
 *
 * ⚠️ **按证据定清单，不按猜测定**（2026-10-08 实测 `_scratch/probe-system-markers*.mjs`，
 * 存档 9,266 条 / 155 种方括号标记）：唯一存在的纯系统事件标记就是 `[拍一拍]`（36 条）。
 * 撤回 / 红包 / 转账 / 退群 在存档里**只作为人类正文里的词出现**（"还…你…把…这…"），
 * 按词排除必然误剥 —— 不收。新增类型**只改这一处**，且须先在真实存档里见到该标记形态。
 * （类型清单扩展到一定规模后再立 ADR；混合消息——如"被撤回的原消息算不算候选"——
 * 属语义判断，单独立 ADR，不走这张表。）
 */
export const SYSTEM_MESSAGE_MARKERS = Object.freeze(['拍一拍']);

/** 该原始消息是否为纯系统事件（**精确**匹配 `[标记]` 形态，不用宽网 —— 宁漏不误剥）。 */
export function isSystemMessage(rawText) {
  const s = String(rawText ?? '');
  return SYSTEM_MESSAGE_MARKERS.some((m) => s.includes(`[${m}]`));
}

// ── 数据源筛选：机器产物（2026-10-17，`ADR-0038`）────────────────────────
//
// ## 为什么需要第二个筛选器（`isSystemMessage` 没坏，是它管不到这一类）
//
// `isSystemMessage` 管的是"**平台事件**"——QQ 自己产的通知（`[拍一拍]`），它不含
// "某人说了什么"，所以按精确标记匹配、宁漏不误剥。而 2026-10-17 拆群槽时发现的是
// **另一类**：宿主插件与机器人自己产出的**完整句子**，它们长得像人话、能过句长下限、
// 能成簇触发，于是被 judge 当成"人类表达"学了下去。实测 A 号 29 条活跃群槽里：
//
//   · `P1669`「B站视频是吧，正在解析下载，稍等～」= **机器人自己的回复**（qq:100000001
//     「千早爱音」），而且同一条内容被同时记成 `pattern` + `event` + `promise`（一模板三身份）；
//   · `P5425`/`P8453`/`P2876`「【防撤回】一条已撤回的消息（缓存未命中，由 get_msg 回查）：…」
//     —— 宿主防撤回插件把回查结果**复制到多个成员名下**（实测 179 条 / **27 个发送者** /
//     仅 2 个群），归属本身就是错的；
//   · `P3546`「给 X 点了 N 个赞。」· `P4358`「⏳ #153 还在忙，第 5 分钟了，手头正在做：read」；
//   · `P383`「[表情:饥饿]」· `X2271`「[音乐:NIGHT DANCER]」—— 带参数/编号的媒体标记
//     **不在** `SCAFFOLD_RE` 的精确白名单里（它只认 `[表情]`），剥不掉 ⇒ 「表情24」= 4 个
//     有效字符，**恰好**通过 4 字符句长下限（实测 1,855 条 / 363 种变体）。
//
// 一句话：**这不是文本处理口径的问题，是"哪些消息算候选"的界定问题**。所以它与
// `SYSTEM_MESSAGE_MARKERS` 同层（归一化**之前**、`stripScaffold` **之外**），
// **不 bump `PRAGMATIC_VERSION`** —— 进了 `stripScaffold` 就等于承认"这些是人类的句子、
// 只是需要清洗"，而事实是它们压根不是人类说的。
//
// ## 口径纪律（每条模板都是**整条锚定**，不是 `includes`）
//
// 实测反例（`_scratch/probe-machine-msgs.mjs`）：`[引用 #116429 依山傍水：B站视频是吧，
// 正在解析下载，稍等～]你怎么抢爱音的台词` —— 这是**人类在吐槽机器人**，含真实表达，
// 整条必须留。所以模板一律 `^…$` / `^…` 锚定开头，宁可漏掉"引用块里装脚手架"的 14 条
// （它们的内容主体仍是人类的话，交给 `stripScaffold` 的引用块剥离即可）。
//
// 新增模板的规矩：**先在真实存档里数出来**（多少条 / 多少发送者 / 多少群），
// 数不出来就别加 —— 与 `SYSTEM_MESSAGE_MARKERS` 同一条纪律。
export const SCAFFOLD_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'ANTI_RECALL',
    // 宿主防撤回插件：回查结果被复制到多个成员名下 ⇒ 归属不可信，内容也不可信。
    re: /^【防撤回】/u,
    evidence: '179 条 / 27 个发送者 / 2 个群（2026-10-17 实测）',
  }),
  Object.freeze({
    id: 'LIKE_BATCH',
    // 「给 <昵称> 点了 N 个赞。」—— 机器人点赞功能的回执，不是人说的话。
    re: /^给 .{1,40} 点了 \d+ 个赞。$/u,
    evidence: '9 条 / 1 个发送者（qq:352513951「星浔」）',
  }),
  Object.freeze({
    id: 'BUSY_TICK',
    // 「⏳ #153 还在忙，第 5 分钟了，手头正在做：read」—— 宿主 agent 的忙碌心跳。
    re: /^⏳(?: #\d+)? 还在忙，第 \d+ 分钟了，手头正在做：/u,
    evidence: '6 条 / 1 个发送者（qq:3922609566「小喵」），每分钟一条地重复',
  }),
  Object.freeze({
    id: 'MEDIA_FETCH_ACK',
    // 「B站视频是吧，正在解析下载，稍等～」—— 机器人自己的下载回执。
    re: /^(?:B站|抖音)视频是吧，正在解析下载，稍等～$/u,
    evidence: '62 条 / 3 个发送者（含 qq:3961475664「千早爱音」）',
  }),
  Object.freeze({
    id: 'MEDIA_LINK_ACK',
    // 「收到B站链接，我去下载一下，稍等哦～」—— 同上，另一种措辞。
    re: /^收到(?:B站|抖音)链接，我去下载一下，稍等哦～$/u,
    evidence: '62 条 / 3 个发送者',
  }),
  Object.freeze({
    id: 'DOWNLOAD_PROGRESS',
    // 下载进度心跳（同一台 bot 的第三种措辞）—— 实测在触发簇里出现过 3 种：
    // 「还在努力下载中…（30 秒了）」「视频有点大，还在下…（已等待 30 秒）」「还在下载中…（已经等了 30 秒了）」。
    // 共同形态：「…（<含"秒"的等待描述>）」。只锚定这三个起手，不写宽网。
    re: /^(?:还在努力下载中|还在下载中|视频有点大，还在下)…（[^）]*秒[^）]*）$/u,
    evidence: '8 条 / 1 个发送者（qq:3961475664），3 种措辞',
  }),
  Object.freeze({
    id: 'TAROT_DRAW',
    // 塔罗插件输出：「今日已抽取　恋人（逆位）——失衡、选错、分离、价值观冲突」。
    // 牌名短（≤10 字）+ `（正位|逆位）` + `——` + 一句牌义 —— 整条锁死，人类引用带 `[引用` 前缀不会命中。
    re: /^(?:今日已抽取[\s　]*)?[^（）\n]{1,10}（(?:正位|逆位)）——[^。\n]{0,40}$/u,
    evidence: '77 条 / 4 个发送者（塔罗抽签功能的回执）',
  }),
  Object.freeze({
    id: 'LIKE_QUOTA',
    // 点赞配额提示，与 `LIKE_BATCH` 同一功能的另一种回执。
    re: /^今日的赞已点满啦$/u,
    evidence: '11 条 / 1 个发送者（qq:352513951）',
  })
]);

/**
 * **媒体标记变体**（整条只有标记、带参数或编号）。
 *
 * 与 `extract.mjs` 的 `SCAFFOLD_RE` 分工：那边是**文本处理**（剥掉标记、看剩下什么），
 * 只认精确形态 `[图片]` / `[表情]`；这里管**数据源**——`[表情344]` / `[表情:托腮]` /
 * `[表情包:嘿嘿]` / `[音乐:NIGHT DANCER]` 剥不掉，剩 4-9 个有效字符就能过句长下限。
 *
 * ⚠️ 标签清单刻意**收窄到媒体类**（不收 `引用`/`链接`/`重要`）：`[引用 …]` 是别人的原话，
 * 人类自己也会打 `[重要]`，宽网会误剥 —— 与 `SCAFFOLD_RE` 注释里"宁可少剥，不可误剥"同源。
 * ⚠️ 只匹配**整条**（`^…$`）：`[表情24]今天好累` 这种"表情+真话"必须留。
 */
export const MEDIA_VARIANT_LABELS = Object.freeze([
  '表情包', '表情', '图片', '语音', '视频', '文件', '动画', '音乐',
  '卡片消息', '合并转发', '红包', '接龙', '位置',
  'image', 'face', 'sticker', 'emoji', 'animation', 'voice', 'video', 'file', 'music'
]);

/** 整条 = 一个或多个 `[标签][:参数][编号]`。`\d*` 吃 `[表情344]` 的编号。 */
export const MEDIA_VARIANT_RE = new RegExp(
  String.raw`^(?:\[\s*(?:${MEDIA_VARIANT_LABELS.join('|')})\s*(?:[:：][^\[\]]*)?\d*\s*\]\s*)+$`,
  'u'
);

/**
 * 这条存档消息是否**不该进候选**（机器产物 / 非人类表达），返回原因码；空串 = 保留。
 *
 * 返回分级原因而不是布尔：`corpus.sourceRejects` 要能说清"是被哪一类挡掉的"——
 * 挡得对不对，靠这张分布表回头看（静默丢数据是本仓明令禁止的形态）。
 *
 * ⚠️ **`self` 不在这里判**：`senderId === 'self'`（宿主账号自己发出的，机器人回复与
 * 主人手打共用此身份）是 `ADR-0019` 观察项 #5 的**既有决定 —— 不排除、只标注**
 * （簇带 `selfN`、槽带 `self_n`）。本过滤器只认"文本形态能证明是机器产出的"，
 * 不碰那条口径；机器人自己的**模板化回复**由 `SCAFFOLD_TEMPLATES` 拦下。
 *
 * @param {{text?:string, senderId?:string, self?:boolean}} message 存档原始消息
 * @returns {''|'SYSTEM_MARKER'|string} 原因码（`SCAFFOLD_TEMPLATES[].id` / `MEDIA_VARIANT`）
 */
export function classifySourceRejection(message) {
  const raw = String(message?.text ?? '');
  if (isSystemMessage(raw)) return 'SYSTEM_MARKER';
  const t = raw.trim();
  if (!t) return 'EMPTY';
  for (const tpl of SCAFFOLD_TEMPLATES) {
    if (tpl.re.test(t)) return tpl.id;
  }
  if (MEDIA_VARIANT_RE.test(t)) return 'MEDIA_VARIANT';
  return '';
}

/**
 * **疑似符号残片**检测（观测仪表，**不干预判定** —— 对面 `0034` 回复建议）。
 *
 * 口径：剥空白后，**非字母字符**（`\p{L}` 之外，含数字/标点/符号）占比 > 80% ⇒ true。
 * 检的就是 `33/3/453-22-` 这类归一化后仍存的结构残渣（ADR-0018 口径数字算有效字符，
 * 所以能过句长下限）。已知代价：`666666` 这类纯数字表达也会命中 —— 但逐字重复属
 * 口头禅簇、根本到不了 judge；非逐字的纯数字变体（`233`/`23333`）会被误计，
 * **只影响观测计数、不影响判定**，真开 LLM 后回看分布时再校准口径。
 *
 * @returns {boolean}
 */
export function looksLikeSymbolFragment(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return false;
  let letters = 0;
  for (const ch of s) if (/[\p{L}]/u.test(ch)) letters++;
  return letters / [...s].length < 0.2;
}

/** 语义化判定错误（backend 捕获后映射成 HTTP 状态与 reason）。 */
export class JudgeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// ── ① 出境断言（决定 1：进 prompt 前，逐字段）────────────────────────────

/**
 * 对单个簇做出境断言，并返回**白名单字段**的出境记录。
 *
 * 断言（命中 ⇒ 抛，**整批拒收**——上游归一化坏了是系统性信号，不是单个簇的事）：
 *   - `speaker` / `target` / `scope`：过 `RAW_ID` fullmatch（`SELF`/`P7722`/`group:C1234` 过；
 *     `qq:123`/裸数字/`group:100000001` 抛）。target 可空（说话人级簇）。
 *   - `exemplar`：非空、无裸号码。
 *   （"明文昵称"由上游归一化 + 形态闸门负责 —— 分层防御，这一层只做**结构性**检测。）
 *
 * 白名单（封闭枚举，`ADR-0019` 决定 1）：`idx`（内部索引，映射回簇用）、
 * `speaker` / `target` / `scope` / `size` / `verbatim` / `exemplar`、
 * `spanMs`（`times` 的**派生跨度** —— 原始时间戳不出境，对判定无用且是侧信道）。
 * `rawExemplar` / 引用块原文 / 簇内其他成员文本 **永不**出境。
 */
export function buildOutboundRecord(cluster, idx) {
  const forField = (label, v, { allowEmpty = false } = {}) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (!s) {
      if (allowEmpty) return s;
      throw new JudgeError('PLAIN_IDENTITY', `出境断言：${label} 不能为空`, { field: label });
    }
    if (RAW_ID.test(s)) {
      throw new JudgeError(
        'RAW_ID_OUTBOUND',
        `出境断言：${label} 必须是占位符，收到明文 id 形态 —— 拒绝出境（ADR-0019 决定 1）`,
        { field: label }
      );
    }
    return s;
  };

  const exemplar = String(cluster?.exemplar ?? '').trim();
  if (!exemplar) throw new JudgeError('EMPTY_EXEMPLAR', '出境断言：exemplar 为空');
  if (containsBareId(exemplar)) {
    throw new JudgeError(
      'RAW_ID_OUTBOUND',
      '出境断言：exemplar 含裸号码形态 —— 拒绝出境（归一化漏项或词表外 id，先修上游）',
      { field: 'exemplar' }
    );
  }

  return {
    idx,
    speaker: forField('speaker', cluster.speaker),
    target: forField('target', cluster.target, { allowEmpty: true }),
    scope: forField('scope', cluster.scope),
    size: Number(cluster.size) || 0,
    verbatim: Boolean(cluster.verbatim),
    spanMs: Number(cluster.spanMs) || 0,
    exemplar
  };
}

/** 白名单字段名清单（出境日志的 `fieldsSent` —— 只记**字段名**，不记值）。 */
export const OUTBOUND_FIELDS = Object.freeze([
  'idx', 'speaker', 'target', 'scope', 'size', 'verbatim', 'spanMs', 'exemplar'
]);

// ── ② prompt 组装（决定 3：标准进 system，user 只放 JSON）────────────────

/**
 * system 段：判定标准 + 输出格式 + 封闭枚举 + anonymity 声明。
 * **不含任何簇数据** —— 标准是"规则"不是"数据"，写 user 层会被 exemplar 内容污染。
 *
 * ⚠️ 这段文案是**判定逻辑** ⇒ 受 `PRAGMATIC_VERSION` 管辖（`ADR-0019` 决定 3）：
 * 改判定语义必须 bump，否则旧 read-model 不会失效。
 */
export function buildJudgeSystemPrompt() {
  return [
    'You are a conversation-pattern judge. You receive JSON records of repeated message clusters.',
    'Each record is anonymized: participants are placeholder tokens (like P7722), not real identities.',
    'Treat placeholders as anonymity tokens. NEVER guess or invent real identities, phone numbers, or IDs.',
    '',
    'For each cluster (matched by "idx"), decide pattern_type:',
    '- "joke": the repetition is a running gag / meme / playful bit. Repeating it is the point.',
    '- "sincere": the repetition is a genuine, meant expression (a phrase this person really means and reuses).',
    '- "ambiguous": you cannot tell, or it is neither. When in doubt, choose "ambiguous".',
    '',
    'Also extract semantic facts that the exemplar itself states, as "facts":',
    `each fact is {"kind": <one of ${SEMANTIC_KINDS.join('|')}>, "text": <the fact, concise}>.`,
    'Use [] if the exemplar states no clear fact. Do not invent facts.',
    '',
    'Output STRICTLY a JSON array, one object per input record, same order:',
    '{"idx": <int>, "pattern_type": <joke|sincere|ambiguous>, "facts": [...], "confidence_note": <short string>}',
    'No markdown, no commentary, JSON only.'
  ].join('\n');
}

/**
 * 组整批 prompt：逐簇出境断言（**一个坏簇 ⇒ 整批拒收并抛**）+ system/user 两段。
 * @returns {{system: string, user: string, records: object[], fieldsSent: string[]}}
 */
export function buildBatchPrompt(clusters) {
  const records = clusters.map((c, i) => buildOutboundRecord(c, i));
  return {
    system: buildJudgeSystemPrompt(),
    // user 段 = **只放 JSON，不放自然语言包装**（减 prompt 注入面，`ADR-0019` 决定 3）
    user: JSON.stringify(records, null, 0),
    records,
    fieldsSent: OUTBOUND_FIELDS
  };
}

// ── ③ 响应解析（决定 3：失败分两类，降级保守）────────────────────────────

const PATTERN_SET = new Set(PATTERN_TYPES);
const SEMANTIC_SET = new Set(SEMANTIC_KINDS);

function entryHasBareId(entry) {
  const note = entry?.confidence_note;
  if (typeof note === 'string' && containsBareId(note)) return true;
  for (const f of (Array.isArray(entry?.facts) ? entry.facts : [])) {
    if (typeof f?.text === 'string' && containsBareId(f.text)) return true;
  }
  return false;
}

/**
 * 解析 LLM 批量响应。
 *
 * @returns {{ok:false, retryable:true, reason:'FORMAT_JSON'|'FORMAT_FIELDS', detail?:string}}
 *        | {{ok:true, results:Array<{idx, patternType, facts, degraded:string|null, reason:string}>}}
 *
 * - JSON 不合法 / 非数组 ⇒ `FORMAT_JSON`（retryable）。
 * - 条目缺字段 / idx 越界 / facts 非数组 / fact.text 非法 ⇒ `FORMAT_FIELDS`（retryable）。
 * - `pattern_type` 枚举外 ⇒ 该簇降级 `ambiguous` + `OUT_OF_ENUM`，**不重试**。
 * - 响应字段命中裸号码 ⇒ 该簇降级 + `RAW_ID_ECHO`（反向泄漏，防模型不可信脱敏）。
 * - `facts[].kind` 枚举外 ⇒ **簇级原子**：整簇降级 + `FACT_KIND_OUT_OF_ENUM`，facts 丢弃。
 */
export function parseBatchResponse(raw, { count } = {}) {
  let arr;
  try {
    arr = JSON.parse(String(raw ?? ''));
  } catch (err) {
    return { ok: false, retryable: true, reason: 'FORMAT_JSON', detail: String(err?.message ?? err).slice(0, 200) };
  }
  if (!Array.isArray(arr)) {
    return { ok: false, retryable: true, reason: 'FORMAT_JSON', detail: 'not an array' };
  }

  const byIdx = new Map();
  for (const entry of arr) {
    const idx = entry?.idx;
    if (!Number.isInteger(idx) || idx < 0 || (count != null && idx >= count)) {
      return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `bad idx: ${JSON.stringify(idx)?.slice(0, 40)}` };
    }
    if (typeof entry.pattern_type !== 'string' || !entry.pattern_type) {
      return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `idx ${idx}: missing pattern_type` };
    }
    if (!Array.isArray(entry.facts)) {
      return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `idx ${idx}: facts must be an array` };
    }
    for (const f of entry.facts) {
      if (!f || typeof f.text !== 'string' || !f.text.trim()) {
        return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `idx ${idx}: fact.text required` };
      }
    }
    if (byIdx.has(idx)) {
      return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `idx ${idx}: duplicated` };
    }
    byIdx.set(idx, entry);
  }
  if (count != null) {
    for (let i = 0; i < count; i++) {
      if (!byIdx.has(i)) {
        return { ok: false, retryable: true, reason: 'FORMAT_FIELDS', detail: `idx ${i}: missing from response` };
      }
    }
  }

  const results = [];
  for (const [idx, entry] of byIdx) {
    // 值域问题（不重试）从重到轻逐项判，先到先得：
    let patternType = entry.pattern_type;
    let degraded = null;
    if (!PATTERN_SET.has(patternType)) {
      patternType = 'ambiguous';
      degraded = 'OUT_OF_ENUM';
    } else if (entryHasBareId(entry)) {
      patternType = 'ambiguous';
      degraded = 'RAW_ID_ECHO';
    } else if (entry.facts.some((f) => !SEMANTIC_SET.has(f.kind))) {
      // 簇级原子：一个非法 fact kind ⇒ 判定与事实同生共死，整簇降级
      patternType = 'ambiguous';
      degraded = 'FACT_KIND_OUT_OF_ENUM';
    }
    const facts = degraded
      ? []
      : entry.facts.map((f) => ({ kind: String(f.kind), text: String(f.text).trim() }));
    results.push({
      idx,
      patternType,
      facts,
      degraded,
      reason: degraded || 'OK',
      confidence_note: typeof entry.confidence_note === 'string' ? entry.confidence_note.slice(0, 200) : ''
    });
  }
  results.sort((a, b) => a.idx - b.idx);
  return { ok: true, results };
}

// ── ④ 落库计划（簇级原子；写入由调用方执行 —— 本模块不碰 FactStore）────────

/**
 * 把一个簇的判定结果展开成**将要执行**的写槽清单。
 * `degraded` ⇒ 只有 pattern 槽（content 标 ambiguous + degraded reason），无 facts —— 同生共死。
 *
 * `reason` 单列在 `content.reason`：`LLM_PARSE_FAILED` 这类"没判成"走**批次跳过**根本不进槽，
 * 进槽的 reason 只有 `OK` / 降级码 —— 与 `ambiguous` 分布**始终可区分**（对面对 0033 的补充）。
 */
export function planClusterWrites(cluster, result) {
  const evidenceIds = Array.isArray(cluster.memberIds) ? cluster.memberIds : [];
  const patternPut = {
    speaker: cluster.speaker,
    target: cluster.target,
    fact_kind: 'pattern',
    scope: cluster.scope,
    content: {
      pattern_type: result.patternType,
      reason: result.reason,
      confidence_note: result.confidence_note,
      exemplar: cluster.exemplar,
      cluster_size: Number(cluster.size) || 0,
      // `self_n`：簇内 self=true 成员数（对面 0035 回复建议）—— **不排除、只标注**。
      // self（机器人回复 + 主人手打共用身份）与人类消息共享 speaker 占位符，
      // 带计数让分析层可区分 pattern 贡献来源；若 self 污染严重，在分析层过滤即可，
      // 不必回改管线。刻意**不进出境白名单**：判定不需要知道它，动了 OUTBOUND_FIELDS 契约零收益。
      self_n: Number(cluster.selfN) || 0,
      span_ms: Number(cluster.spanMs) || 0,
      verbatim: Boolean(cluster.verbatim),
      degraded: result.degraded
    },
    evidenceIds
  };
  if (result.degraded) return { patternPut, factPuts: [] };
  const factPuts = result.facts.map((f) => ({
    speaker: cluster.speaker,
    target: cluster.target,
    fact_kind: f.kind,
    scope: cluster.scope,
    content: { text: f.text, exemplar: cluster.exemplar, from_pattern: result.patternType, self_n: Number(cluster.selfN) || 0 },
    evidenceIds
  }));
  return { patternPut, factPuts };
}

// ── ⑤ 频率闸门（决定 2：上限 + 指数退避；**不是重试队列**）────────────────

/**
 * 全局每分钟上限 + 指数退避。失败 ⇒ 批间间隔翻倍；成功 ⇒ 归零。
 * `tryAcquire` 拒绝 = 本轮跳过（调用方记 reason 后走人），**没有队列**。
 */
export class RateLimiter {
  constructor({ perMinute = DEFAULT_PER_MINUTE, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
    this.perMinute = Math.max(1, Number(perMinute) || DEFAULT_PER_MINUTE);
    this.baseDelayMs = Math.max(0, Number(baseDelayMs) || DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || DEFAULT_MAX_DELAY_MS);
    this.window = [];        // 60s 窗口内的调用时间戳
    this.blockedUntil = 0;
    this.failures = 0;
  }

  /** 尝试占用一个名额。拒绝时返回 `{ok:false, retryAfterMs}` —— 调用方**跳过**，不排队。 */
  tryAcquire(now = Date.now()) {
    if (now < this.blockedUntil) {
      return { ok: false, retryAfterMs: this.blockedUntil - now, why: 'BACKOFF' };
    }
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.perMinute) {
      return { ok: false, retryAfterMs: 60_000 - (now - this.window[0]), why: 'PER_MINUTE' };
    }
    this.window.push(now);
    return { ok: true };
  }

  /** 连续失败 ⇒ 间隔翻倍（封顶 maxDelayMs）。**退避拉长的是批间间隔，不是重试。** */
  onFailure(now = Date.now()) {
    this.failures += 1;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.failures - 1));
    this.blockedUntil = Math.max(this.blockedUntil, now + delay);
    return delay;
  }

  onSuccess() {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}

// ── ⑥ 批处理编排（决定 2/3/4 的落点；LLM 由调用方注入）────────────────────

/**
 * 跑一轮判定批处理。
 *
 * @param {object} opts
 * @param {Array}  opts.clusters       `clusterCandidates` 产出的簇（触发过滤在这里做）
 * @param {Function} opts.callLlm      `async ({system, user, temperature}) => string`
 * @param {string} opts.endpointKind   **必填** `'local' | 'external'`（决定 1，fail-closed）
 * @param {boolean} [opts.dryRun]      决定 4：全链路 + 固定桩，**不调 LLM、不落库**（writes 只返回不执行）
 * @param {RateLimiter} [opts.rateLimiter]
 * @param {number} [opts.N]            触发阈值（传给 `shouldTrigger`）
 * @param {number} [opts.horizonMs]    触发窗口（传给 `shouldTrigger`）
 * @param {number} [opts.retryMax]     格式错重试上限（缺省 1）
 * @param {number} [opts.now]
 *
 * @returns {{ok:true, dryRun:boolean, results, writes:{patternPut,factPuts}[], outbound:{system,user,fieldsSent}, log}}
 *        | {{ok:false, skipped:true, reason:'RATE_LIMITED'|'LLM_UNAVAILABLE'|'LLM_PARSE_FAILED'|'EMPTY_BATCH', ...}}
 * @throws {JudgeError} `NO_ENDPOINT_KIND` / `RAW_ID_OUTBOUND` / `PLAIN_IDENTITY` / `EMPTY_EXEMPLAR`
 *
 * `dryRun` 的桩返回"全 ambiguous"：管线全真（断言/解析/计划），判定全假（桩）——
 * 且 **writes 只返回不执行**：真值不被假数据污染（`ADR-0019` 决定 4）。
 */
export async function runJudgeBatch({
  clusters = [], callLlm, endpointKind, dryRun = false,
  rateLimiter = null, N, horizonMs, retryMax = JUDGE_FORMAT_RETRY_MAX, now = Date.now()
} = {}) {
  // 目的地声明 fail-closed：dryRun 也要求 —— 第一次出境前必须先声明"将去往何处"。
  const kind = String(endpointKind ?? '');
  if (kind !== 'local' && kind !== 'external') {
    throw new JudgeError(
      'NO_ENDPOINT_KIND',
      `llmEndpointKind 必填（'local' | 'external'），收到：${JSON.stringify(endpointKind)} —— ` +
      '缺省拒绝启动 M4 第二段（ADR-0019 决定 1，fail-closed）'
    );
  }

  const t0 = now;
  const batchId = `j${now.toString(36)}`;
  const triggered = clusters.filter((c) => shouldTrigger(c, { N, horizonMs }).trigger);
  if (!triggered.length) {
    return {
      ok: false, skipped: true, reason: 'EMPTY_BATCH', dryRun: Boolean(dryRun),
      log: { ts: now, batchId, endpointKind: kind, dryRun: Boolean(dryRun), outcome: 'EMPTY_BATCH', clusterIds: [], fieldsSent: [], elapsedMs: Date.now() - t0 }
    };
  }

  // 出境断言（一个坏簇 ⇒ 整批拒收并抛 —— 上游归一化坏了是系统性信号）
  const prompt = buildBatchPrompt(triggered);

  const finishLog = (outcome, extra = {}) => ({
    ts: now, batchId, endpointKind: kind, dryRun: Boolean(dryRun), outcome,
    // 日志只记簇的**内部下标**（不记 exemplar / 身份值）—— 无内容日志（决定 1③）
    clusterIds: prompt.records.map((r) => r.idx),
    fieldsSent: prompt.fieldsSent.slice(),
    elapsedMs: Date.now() - t0,
    ...extra
  });

  let parsed;
  if (dryRun) {
    const stub = JSON.stringify(prompt.records.map((r) => ({
      idx: r.idx, pattern_type: 'ambiguous', facts: [], confidence_note: 'dryRun stub'
    })));
    parsed = parseBatchResponse(stub, { count: prompt.records.length });
  } else {
    if (!rateLimiter) rateLimiter = new RateLimiter();
    const slot = rateLimiter.tryAcquire(now);
    if (!slot.ok) {
      return { ok: false, skipped: true, reason: 'RATE_LIMITED', retryAfterMs: slot.retryAfterMs, why: slot.why, log: finishLog('RATE_LIMITED') };
    }

    let lastParse = null;
    for (let attempt = 0; attempt <= Math.max(0, retryMax); attempt++) {
      let raw;
      try {
        raw = await callLlm({ system: prompt.system, user: prompt.user, temperature: 0 });
      } catch (err) {
        // 不可达 / 超时 ⇒ 本轮跳过，不排队、不重试（决定 2；格式错的 retry 只属于"模型回了但格式坏"）
        rateLimiter.onFailure(now);
        return { ok: false, skipped: true, reason: 'LLM_UNAVAILABLE', error: String(err?.message ?? err).slice(0, 300), log: finishLog('LLM_UNAVAILABLE') };
      }
      lastParse = parseBatchResponse(raw, { count: prompt.records.length });
      if (lastParse.ok) break;
      if (!lastParse.retryable) break;   // 枚举外等值域问题不走 retry（parse 已降级，不会到这）
      if (attempt >= retryMax) break;    // 格式错重试额度用完
    }
    if (!lastParse.ok) {
      rateLimiter.onFailure(now);
      // "没判成" ≠ "判了但不确定"：整批跳过 + 独立 reason，**不落 ambiguous**（决定 3）
      return { ok: false, skipped: true, reason: 'LLM_PARSE_FAILED', parse: { reason: lastParse.reason, detail: lastParse.detail }, log: finishLog('LLM_PARSE_FAILED') };
    }
    rateLimiter.onSuccess();
    parsed = lastParse;
  }

  const byIdx = new Map(parsed.results.map((r) => [r.idx, r]));
  const writes = triggered.map((cluster, i) => planClusterWrites(cluster, byIdx.get(i)));
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    results: parsed.results,
    writes,
    // dryRun 的核心产物：宿主在真开 LLM 前，能看清**会送什么出去**
    outbound: { system: prompt.system, user: prompt.user, fieldsSent: prompt.fieldsSent },
    log: finishLog(dryRun ? 'DRY_RUN' : 'OK')
  };
}
