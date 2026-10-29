// M4 抽取的**前置段**（`L0` 证据层 + 触发）—— 纯函数、零出境、可离线测。
//
// ── 它在整条 M4 里的位置 ────────────────────────────────────────────────────
// `ADR-0010` 决定 4 把语用层切成**两段式**：
//
//   ① 事件落地   —— **永远跑**，零 LLM（纯结构化存证）
//   ② 模式判定   —— **触发条件满足时才跑**，与事实抽取**共用一次** LLM 调用
//
// 本模块是 ① 的**筛选器**：它不判 `joke|sincere|ambiguous`（那是 ② 的 LLM 干的），
// 它只回答一个问题 —— **"这批表达值不值得送去判"**。
//
// ── 三道护栏（`ADR-0010` 决定 4；口径由 `ADR-0018` 更正/收紧）──────────────
//   ① **句长下限**：`≥ 4` 个**有效字符**。
//      ⚠️ `ADR-0010` 原话是"**4 个 CJK 字**"，`ADR-0018` 决定 1 更正为"有效字符"：
//      只数 CJK 会把 `I love you` / `666666` / `OKOKOK` **静默拦掉**
//      （它们是真实表达，却一个 CJK 字都没有）—— 而**静默丢弃**是本项目最忌讳的失效形态。
//   ② **措辞相似**：**剥标点后**的字符 n-gram Jaccard ≥ 阈值，**本机算、不出境**
//      （`ADR-0002`：相似度计算不涉及出境 —— 这是它能放到本地的前提）
//   ③ **完全相同 ≠ 相似**：逐字相同的串算**口头禅**，**单列一类，不参与判定**
//      （否则"重复次数"又被填充词灌满）
//
//   ⚠️ ② 与 ③ 用的是**两版文本**（`ADR-0018` 决定 2）：相似度看**剥标点**后的，
//      口头禅看**原始**文本。故意不统一 —— 统一任何一边都会丢掉另一边要的信息。
//
// ── 文本处理的三条规矩（`ADR-0018` 决定 4；决定 6 把**占位符**并入脚手架）───
//   | 处理 | 是什么 | 护栏① 句长 | 护栏② 相似 | 护栏③ 口头禅 |
//   |---|---|---|---|---|
//   | **脚手架**（引用块 / @ / 媒体标记 / **占位符**）| **不是"说的话"** | 剥 | 剥 | 剥 |
//   | **标点** | 语法噪声，但也是"逐字"的一部分 | 不计 | **剥** | 保留 |
//   | 大小写 / 全半角 / 其他 | — | 不归一 | 不归一 | 不归一 |
//
//   ⚠️ 脚手架为什么三处都要剥：**归一化后的出境文本带了引用块**，而引用块里装的是
//      **被引用的原话（别人说的）**。实测（`_scratch/verify-extract-fixes.mjs`）：
//      15000 条真实消息里 **31.9%** 带脚手架；不剥的话
//      `[引用 〔P1〕：今天好累] 嗯` 会被数成 5 个有效字符（实际只说了"嗯"），
//      而且"同一条引用 + 不同内容后缀"的消息会因为**共享的脚手架**被判成相似 ——
//      那批匹配里多数是**假阳性**，会把"模式"的计数灌满。
//
// ── 触发条件（三条同时满足，`ADR-0010` 决定 4）──────────────────────────────
//   1. 同一 `(speaker, target)` 的**相似表达计数** `≥ N`
//   2. 每条候选过**句长下限**
//   3. **存在一个长度 `horizon` 的窗口，装得下 `≥ N` 条**（`ADR-0018` 决定 3）
//   ⚠️ **`N` 必须等于建档阈值**（都 = 3）：不等 ⇒ "触发了建不了档"的空转，
//      或"永远填不满"的行。要调**一起调**。
//
// ── 引用面 ──────────────────────────────────────────────────────────────────
// **零活跃路径**（同 `lib/edges.mjs` / `lib/facts.mjs`：先落地、后接线）。
//   ⇒ 不改任何既有行为，插件版本**不动**（仍 0.5.0）。
// ⚠️ 但本模块的**常数**（句长下限 / 相似度阈值 / `N`）与**度量口径**全是**判定逻辑**，
//    受 `PRAGMATIC_VERSION` 管辖 —— **改任何一个都必须 bump `PRAGMATIC_VERSION`**，
//    否则"阈值 3→4"这类变更不会让任何 read-model 失效（`lib/edges.mjs:39-49` 记过这笔账）。
//    `ADR-0018` 就是照这条纪律把 `PRAGMATIC_VERSION` 从 1 bump 到 2，
//    决定 6（占位符并入脚手架）又把它从 2 bump 到 3。

import { stripPlaceholders, PLACEHOLDER_PATTERN, MEDIA_MARKER_LABELS } from './normalize.mjs';

/**
 * 判定逻辑的版本号 —— 复用 `lib/edges.mjs` 的 `PRAGMATIC_VERSION`
 * （本地再写一份就是"两处各写一套版本号"，`ADR-0013` 已判过这类漂移是病）。
 */
export { PRAGMATIC_VERSION } from './edges.mjs';

// ────────────────────────────────────────────────────────────────────────────
// 常数（**全部留空待分布** —— 与 `source_credibility` / `rank` 同纪律）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 句长下限：**有效字符**数（护栏 ①）。
 * ⚠️ 名字从 `SENTENCE_FLOOR_CJK` 改来（`ADR-0018` 决定 1）—— 常数没变（仍 4），
 * **语义**变了：从"4 个 CJK 字"变成"4 个有效字符"。名字不跟着改，就是留一个**说谎的名字**。
 * ⚠️ 已知边界：4 个拉丁字母 ≈ 1 个短词，而 4 个 CJK 字信息量更大 ——
 * 单一阈值对拉丁文本**偏松**。等 `M1`/`M4` 的分布出来再决定是否按脚本分档。
 */
export const SENTENCE_FLOOR_CHARS = 4;

/** 相似度用的字符 n-gram 的 `n`（护栏 ②）。2 = 二元组，中文无词边界时的抓手。 */
export const SIMILARITY_NGRAM = 2;

/** Jaccard 相似度阈值（护栏 ②，初值 `0.6`，`ADR-0010` 决定 4）。 */
export const SIMILARITY_THRESHOLD = 0.6;

/** 触发阈值 `N`（**必须 = 建档阈值**，都 3）。 */
export const TRIGGER_N = 3;

/** CJK 字符类 —— **与 `lib/vocab.mjs` 的 `extractTerms` 逐字一致**，免得两处口径分叉。 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g;

/** **有效字符**：任意文字系统的字母 + 数字（`I` / `love` / `666` / `你好` 都算）。 */
const CONTENT_CHAR = /[\p{L}\p{N}]/gu;

/** 标点 `\p{P}` —— **只在相似度那一版里剥掉**，口头禅那一版不剥。 */
const PUNCT = /\p{P}/u;

/**
 * **结构脚手架**的正则 —— 形态**取自 `normalize.mjs` 的实际产出**（不是猜的；
 * 见 `_scratch/verify-extract-fixes.mjs` 的实测打印）：
 *
 * | 形态 | 来源 |
 * |---|---|
 * | `[引用 〔P1234〕：<被引用的原话>]` | `normalize.mjs:603/686`（形态 B/C）|
 * | `[引用 〔R〕 〔P1234〕：…]` | 同上，带引用锚点占位符 `〔R〕` |
 * | `@〔P1234〕` | `normalize.mjs:745` 附近的提及 |
 * | `〔MENTION〕` | 同上，"提到了某人"但丢掉是谁 |
 * | `[图片] [image] [face] …` | `normalize.mjs:631/634` 的媒体标记 |
 * | **所有占位符 `〔…〕`** | `ADR-0018` 决定 6：`〔MEDIA〕`/`〔D〕`/`〔T20〕`/`〔P1〕` 同为"不是说的话" |
 *
 * ⚠️ 刻意**只列已知形态**、不用"所有 `[...]`"这种宽网 ——
 * 用户真在正文里打 `[重要]` 时不该被吃掉。宁可少剥，不可误剥。
 *
 * ⚠️ 白名单的**同步机制**（`ADR-0018` 决定 6，对面追问 2）—— 分两层：
 *   · **媒体标记**：从 `normalize.mjs` 的 `MEDIA_MARKER_LABELS` **单一来源**引用
 *     （归一化侧新增标记 ⇒ 抽取侧自动跟上）；
 *   · **占位符**：按 `PLACEHOLDER_PATTERN` **结构**匹配（`〔…〕` 龟甲括号不是用户的
 *     常规标点），不逐形态枚举 ⇒ 归一化侧新增占位符类型**同样自动跟上**。
 *   两层都由 `test/extract.mjs` 的**契约测试**钉住（逐标记断言 + 归一化产物残留断言）。
 *   剩余唯一风险：新增一种**全新括号结构**（非 `〔…〕`）时忘了进白名单 ——
 *   这层兜底是 `normalize.mjs` 自己的**形态闸门**（出境前残留实体引用形态即抛）。
 */
/** 导出给契约测试（`test/extract.mjs` 3d 段）：断言它与 `MEDIA_MARKER_LABELS` 同源。 */
export const SCAFFOLD_LABELS = `${MEDIA_MARKER_LABELS}|图片|表情|语音|视频|文件|动画`;
const SCAFFOLD_RE = new RegExp(
  String.raw`\[\s*引用\s*(?:[^\[\]]|\[[^\[\]]*\])*\]` +   // 引用块（允许一层嵌套的媒体标记）
  String.raw`|〔MENTION〕` +
  String.raw`|@〔[^〕]*〕` +
  String.raw`|\[(?:${SCAFFOLD_LABELS})\]` +
  String.raw`|${PLACEHOLDER_PATTERN}`,                     // 所有占位符（结构性，见上）
  'giu'
);

/**
 * 剥掉**结构脚手架** —— 剩下的才是"**这个人说了什么**"。
 *
 * 这是护栏①②③ **都**要做的第一步（见文件头"文本处理的规矩"表）：
 * 引用块里装的是**别人的原话**，@ 与媒体标记也不是内容，
 * 占位符（`〔MEDIA〕`/`〔D〕`/`〔T20〕`/`〔P1〕`…）是"关于谁/何时/什么媒介"——同样不是"说了什么"
 * （`ADR-0018` 决定 6：占位符按**结构**纳入白名单，归一化侧新增类型自动跟上；
 *   实测 `_scratch/verify-0030-followups.mjs`：候选里 11% 带 `〔MEDIA〕`、27.7% 带任意占位符，
 *   虽然当下实测假阳性/拆簇都是 **0 对**，但不对称本身就是隐患 —— `〔MENTION〕` 剥、`〔MEDIA〕` 不剥没有道理）。
 * @returns {string} 脚手架位置换成空格（保留词边界，避免把两侧的字粘成一个词）
 */
export function stripScaffold(text) {
  return String(text ?? '').replace(SCAFFOLD_RE, ' ');
}

// ────────────────────────────────────────────────────────────────────────────
// 一、文本原语（护栏 ① / ③）
// ────────────────────────────────────────────────────────────────────────────

/**
 * CJK 字数（只数表意字 + 假名，**不数** ASCII / 标点 / 数字 / 占位符）。
 * 与 `vocab.extractTerms` 用同一字符类：占位符（`P7722`）与数字不进这个计数 ——
 * 它们不是"说了什么"，只是"关于谁"。
 *
 * ⚠️ **`ADR-0018` 起，句长下限不再用它**（改用 `contentCharCount`）。
 * 保留它是因为 `vocab.extractTerms` 那套口径仍需要它，且两边字符类必须逐字一致。
 */
export function cjkCount(text) {
  const s = String(text ?? '');
  const m = s.match(CJK_CHAR);
  return m ? m.length : 0;
}

/**
 * **有效字符数**（护栏 ①，`ADR-0018` 决定 1）—— 句长下限用这个。
 *
 * 规则：先剥掉**结构脚手架**（引用块 / @ / 媒体标记）与**占位符**
 * （`〔P7722〕` 只是"关于谁"，不是"说了什么"），
 * 再数 `\p{L}` / `\p{N}`（**任意**文字系统的字母 + 数字），标点 / emoji / 空白**不计**。
 *
 * 为什么剥脚手架：`[引用 〔P1〕：今天好累] 嗯` 的实际内容只有"嗯"，
 * 不剥就会被数成 5 个有效字符 ⇒ 一条**纯附和**的消息过了句长下限。
 */
export function contentCharCount(text) {
  const s = stripPlaceholders(stripScaffold(text));
  const m = s.match(CONTENT_CHAR);
  return m ? m.length : 0;
}

/**
 * 句长下限（护栏 ①）。
 * @param {string} text
 * @param {number} [min=SENTENCE_FLOOR_CHARS]
 * @param {{counter?:'content'|'cjk'}} [opts] `'content'`（默认，`ADR-0018`）/ `'cjk'`（旧口径，留作对照）
 */
export function passesSentenceFloor(text, min = SENTENCE_FLOOR_CHARS, { counter = 'content' } = {}) {
  const n = counter === 'cjk' ? cjkCount(text) : contentCharCount(text);
  return n >= Math.max(0, Number(min) || 0);
}

/**
 * 逐字相同 = 口头禅（护栏 ③）—— **脚手架之外的原始文本**。
 *
 * 只做两件事：**剥结构脚手架**（引用块 / @ / 媒体标记 —— 那不是"说的话"），
 * 再**两端去空白**。不做大小写归一、不做标点剥离：
 * `ADR-0010` 决定 4 的原话是"**逐字**相同"，
 * 把 `在吗？` 与 `在吗` 算成口头禅会让这一类失去边界。
 * （`ADR-0018` 决定 2/4 把这条与"相似度剥标点"**并存**，两者用的是**两版文本**。）
 */
export function isVerbatim(a, b) {
  return stripScaffold(a).trim() === stripScaffold(b).trim();
}

// ────────────────────────────────────────────────────────────────────────────
// 二、相似度（护栏 ②）—— 本机算，**不出境**
// ────────────────────────────────────────────────────────────────────────────

/**
 * **相似度专用的归一化文本**（`ADR-0018` 决定 2/4）。
 *
 * 顺序：**先剥结构脚手架**（引用块 / @ / 媒体标记），再剥**标点** `\p{P}` 与空白，
 * 其余原样保留（含 emoji）。
 *
 * 为什么标点要剥：实测（`_scratch/probe-text.mjs`）——
 * `你好，在吗` vs `你好在吗` 在**不剥**时 Jaccard = **0.400**（< 0.6 ⇒ 判成 `different`），
 * `在吗？` vs `在吗` = **0.500**（同样漏掉）。QQ 里标点差异极常见，
 * ⇒ 不剥会让**同一句表达因一个逗号被拆成两簇**，触发计数永远攒不够。
 *
 * 为什么只剥标点、不剥 emoji：emoji 是**情绪内容**（`😭` 和 `🙂` 不是一回事），
 * 标点是**语法噪声**。
 *
 * 为什么必须先剥脚手架（实测 `_scratch/verify-extract-fixes.mjs`）：
 * 15000 条真实消息里 **31.9%** 带引用块，而引用块**标点密集且逐字相同**，
 * 会把"同一个人引用同一条、后面接不同的话"判成相似 —— 一批**假阳性**，
 * 把"模式"计数灌满。剥掉脚手架后，相似度才真正落在**内容**上。
 */
export function normalizeForSimilarity(text) {
  let out = '';
  for (const ch of stripScaffold(text)) {      // `for...of` 按**码点**走，emoji 不被劈开
    if (/\s/u.test(ch) || PUNCT.test(ch)) continue;
    out += ch;
  }
  return out;
}

/**
 * 字符 n-gram 集合。先过 `normalizeForSimilarity`（剥标点 + 空白），再按**码点**切。
 * ⚠️ 按码点切（而不是 `String.slice`）是 `ADR-0018` 顺手补的一处边界：
 * `slice` 按 **UTF-16 码元**切，遇到 astral 字符（emoji / 生僻字）会切出**半个代理对**，
 * 于是 `你好😭在吗` 会多出一个 `\uDE2D在` 这种**只在有 emoji 时存在**的 n-gram，
 * 让带 emoji 的表达式**系统性比不带 emoji 的更难配上**。
 */
export function ngrams(text, n = SIMILARITY_NGRAM) {
  const k = Math.max(1, Number(n) || 1);
  const chars = [...normalizeForSimilarity(text)];
  const set = new Set();
  for (let i = 0; i + k <= chars.length; i++) set.add(chars.slice(i, i + k).join(''));
  return set;
}

/**
 * Jaccard 相似度：`|A ∩ B| / |A ∪ B|`。
 * 两边都空 ⇒ **0**（不是 1）—— "都没说话"不该被判成"说的一样"。
 */
export function jaccard(a, b, n = SIMILARITY_NGRAM) {
  const A = ngrams(a, n);
  const B = ngrams(b, n);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * 一对文本的关系判定 —— **单一决策点**（避免调用方各写一套 `if`）。
 *
 * 顺序**重要**：`verbatim` 用**原始**文本先判（护栏 ③），
 * 没中才落到剥标点后的 Jaccard（护栏 ②）。
 * ⇒ `在吗？` 与 `在吗` 判成 **`similar`**（不是 `verbatim`）：它们"在说同一件事"，
 *    但不是"逐字相同"，所以**不构成口头禅**。两版文本的分工就在这里（`ADR-0018` 决定 2）。
 *
 * @returns {{kind:'verbatim'|'similar'|'different', jaccard:number}}
 *   `verbatim`  → 口头禅（护栏 ③，单列，**不进判定**）
 *   `similar`   → 供聚类合并
 *   `different` → 拆开
 */
export function classifyPair(a, b, { n = SIMILARITY_NGRAM, threshold = SIMILARITY_THRESHOLD } = {}) {
  if (isVerbatim(a, b)) return { kind: 'verbatim', jaccard: 1 };
  const j = jaccard(a, b, n);
  return { kind: j >= threshold ? 'similar' : 'different', jaccard: j };
}

// ────────────────────────────────────────────────────────────────────────────
// 三、聚类 + 触发（`ADR-0010` 决定 4）
// ────────────────────────────────────────────────────────────────────────────

/** `\u0000` 在占位符 / 会话键里都不可能出现 —— 与 `facts.mjs` 用同一个分隔符。 */
const SEP = '\u0000';

/**
 * 把候选消息聚成**相似表达簇**。簇的粒度是
 * `(speaker, target, scope)` —— 与事实槽键的前三个分量**同构**
 * （第四个分量 `fact_kind` 在触发后由判定给出，聚类阶段还不知道）。
 *
 * @param {Array<{speaker:string,target:string,scope:string,text:string,at?:number,id?:string}>} items
 *        归一化**之后**的候选（含占位符、无明文）。
 * @param {object} [opts]
 * @param {number} [opts.n]               n-gram 的 n
 * @param {number} [opts.threshold]       Jaccard 阈值
 * @param {number} [opts.floor]           句长下限（有效字符数）
 * @param {boolean}[opts.keepVerbatim=true] 是否把口头禅簇也列出来（列了但**不触发**）
 * @returns {{clusters:object[], stats:object}}
 */
export function clusterCandidates(items = [], opts = {}) {
  const { n = SIMILARITY_NGRAM, threshold = SIMILARITY_THRESHOLD, floor = SENTENCE_FLOOR_CHARS } = opts;

  let dropped = 0;
  const groups = new Map();   // (speaker,target,scope) → item[]
  for (const it of items) {
    const text = String(it?.text ?? '');
    if (!passesSentenceFloor(text, floor)) { dropped++; continue; }   // 护栏 ①
    const key = [String(it.speaker ?? ''), String(it.target ?? ''), String(it.scope ?? '')].join(SEP);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push({ ...it, text });
  }

  const clusters = [];
  for (const g of groups.values()) {
    const buckets = [];   // {rep:string, members:[]}
    for (const it of g) {
      let hit = null;
      for (const b of buckets) {
        if (classifyPair(b.rep, it.text, { n, threshold }).kind !== 'different') { hit = b; break; }
      }
      if (hit) hit.members.push(it);
      else buckets.push({ rep: it.text, members: [it] });
    }
    for (const b of buckets) {
      const ats = b.members.map((m) => Number(m.at)).filter((x) => Number.isFinite(x));
      // ⚠️ **单条簇不是口头禅** —— "只有一个成员"时"与代表逐字相同"平凡成立，
      //    若照此判 verbatim，一条**孤立**的表达会被当成填充词**静默拦掉**。
      //    口头禅的定义是"**反复**逐字相同" ⇒ 必须 `size > 1`。
      const allSame = b.members.length > 1 && b.members.every((m) => isVerbatim(m.text, b.rep));
      clusters.push({
        speaker: b.members[0].speaker,
        target: b.members[0].target,
        scope: b.members[0].scope,
        size: b.members.length,
        // `selfN` = 簇内 self=true（宿主账号自己发出）的成员数 —— **不排除、只标注**
        // （对面 0035 回复：self 与主人手打共享同一 speaker 占位符，pattern 判定可能把
        // 机器人参数化模板算进 self 画像；带标记让分析层可区分，改口径不必回改管线）。
        selfN: b.members.reduce((n, m) => n + (m.self === true ? 1 : 0), 0),
        verbatim: allSame,               // 护栏 ③：整簇逐字相同 ⇒ 口头禅
        // `exemplar` 存**剥脚手架后**的内容（那才是"这个人说了什么"）；
        // 分类仍用原始 `text`（`classifyPair` 内部自己剥）。
        exemplar: stripScaffold(b.rep).trim().replace(/\s+/g, ' '),
        rawExemplar: b.rep,              // 原始（多为调试用，含脚手架）
        memberIds: b.members.map((m) => String(m.id ?? '')).filter(Boolean),
        // `times` 是**触发条件 3 的输入**（`ADR-0018` 决定 3）；`spanMs` 只留作展示（首末跨度）。
        times: ats.slice().sort((x, y) => x - y),
        spanMs: ats.length > 1 ? Math.max(...ats) - Math.min(...ats) : 0
      });
    }
  }
  clusters.sort((a, b) => (b.size - a.size) || (a.exemplar < b.exemplar ? -1 : 1));

  const kept = opts.keepVerbatim === false ? clusters.filter((c) => !c.verbatim) : clusters;
  return {
    clusters: kept,
    stats: {
      input: items.length,
      droppedByFloor: dropped,
      groups: groups.size,
      clusters: clusters.length,
      verbatimClusters: clusters.filter((c) => c.verbatim).length
    }
  };
}

/**
 * 一条**已排序**时间戳序列里，长度 `spanMs` 的窗口最多装得下几条。滑动窗口 `O(m)`。
 *
 * 这是触发条件 3 的**字面落法**（`ADR-0018` 决定 3）：
 * "**同一 `horizon` 窗口内 ≥ N 条**"问的是"**存在**一个窗口装下 N 条"，
 * 而**不是**"**所有**成员的首末跨度 ≤ 窗口"。
 *
 * 两者不等价，且差别**有害**：
 * | 落法 | 含义 | 后果 |
 * |---|---|---|
 * | ~~`spanMs ≤ horizonMs`~~（旧）| **所有**成员同窗 | 更严 ⇒ **漏报**：一条 3 天前的旧实例把整簇拖出窗口，明明当天重复了 5 次也不触发 |
 * | `densestWindow ≥ N`（新）| **存在**窗口含 N 条 | 与**调用方怎么切窗无关** ⇒ 批处理粒度变了**行为不变** |
 *
 * @param {number[]} times     时间戳（任意顺序，函数内自行排序）
 * @param {number}   spanMs    窗口长度
 * @returns {number} 最密窗口内的条数（`0` = 空或窗口非法）
 */
export function densestWindow(times, spanMs) {
  const t = (Array.isArray(times) ? times : [])
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const span = Number(spanMs);
  if (!t.length || !(span >= 0)) return 0;
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] > span) lo++;
    if (hi - lo + 1 > best) best = hi - lo + 1;
  }
  return best;
}

/**
 * 触发判定（第二段要不要跑）。
 *
 * @param {object} cluster              `clusterCandidates` 产出的簇
 * @param {object} [opts]
 * @param {number} [opts.N=TRIGGER_N]   触发阈值（**必须 = 建档阈值**）
 * @param {number} [opts.horizonMs]     给出则要求**最密窗口 ≥ N**（`ADR-0018` 决定 3）
 * @returns {{trigger:boolean, reason:string}}
 *
 * ⚠️ **fail-closed**：给了 `horizonMs` 但簇里**没有足够时间戳**（证不出"同窗"）⇒ **不触发**，
 *    且给出**独立可见的** `reason`（`NO_TIMESTAMPS`）。不是静默通过、也不是静默丢弃 ——
 *    调用方能一眼看出"是没到阈值，还是根本没时间戳"。
 */
export function shouldTrigger(cluster, { N = TRIGGER_N, horizonMs } = {}) {
  const n = Math.max(1, Number(N) || 1);
  if (!cluster) return { trigger: false, reason: 'NO_CLUSTER' };
  if (cluster.verbatim) return { trigger: false, reason: 'VERBATIM_STUTTER' };   // 护栏 ③
  if (cluster.size < n) return { trigger: false, reason: `SIZE_${cluster.size}_LT_${n}` };
  if (horizonMs) {
    const times = Array.isArray(cluster.times) ? cluster.times : [];
    if (times.length < n) return { trigger: false, reason: 'NO_TIMESTAMPS' };    // 证不出 ⇒ 不发
    const best = densestWindow(times, Number(horizonMs));
    if (best < n) return { trigger: false, reason: `WINDOW_${best}_LT_${n}` };
  }
  return { trigger: true, reason: 'OK' };
}
