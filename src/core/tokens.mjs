// src/core/tokens.mjs —— 关键词层：分词 + **跳字 bigram** 重合度（纯函数，零依赖）
//
// ── 这个文件为什么存在（`ADR-0033`）──────────────────────────────────────────
// 只用向量相似度有一个**结构性盲区**：语义相似度对**精确 token** 不敏感 ——
// 人名变体、缩写、黑话、专有名词（"KID1411"、"推歌"、"cqt"）在向量空间里彼此很近，
// 于是"找这个人的这条"与"找这个话题的这条"混在一起。这不是调 topK 能救的。
//
// 宿主侧早有一层**字面重合**排序（`src/memory.js` 的 `topicOverlap` + `rankImpressions`），
// 实测捞回过真事：用户点名"给我推首歌"，印象里那条"音乐推荐口味固定三类"靠
// **字面重合**被提到前二（`memory.js:326-335` 有完整实测记录）。本文件把那层**照搬**过来，
// 让 vec-memory 在**嵌入端点缺席时也有排序依据**，而不是静默退化成"按可信度排"。
//
// ── 抄就得抄到数值等价 ─────────────────────────────────────────────────────
// 与 `rank.mjs` 对六维内核的做法一致（"抄就得抄到数值等价，不能参考着写"）：
// `topicOverlap` 的计分规则**逐条**来自宿主实现，包括那些看起来"不优雅"的部分
// （单字只给 0.2、总分封顶 2、早退）。改这些常数 = 换口径，必须另开 ADR 并用真库数据校准。
//
// ── ⚠️ 这个函数是**有方向**的 ──────────────────────────────────────────────
// `topicOverlap(content, topicSets)` 遍历的是 **`content` 的 token**，拿它们去查
// `topicSets` 的集合与字符位置。两个方向都有正当用途，但**结果不一样**：
//
//   · 注入（宿主的用法）：`content` = **候选属性行**，`topicSets` = **当前话题句**
//     ⇒ "这条属性跟这句话沾不沾边"。
//   · 检索（本仓 `/search mode:'exact'`）：`content` = **查询串**，`topicSets` = **文档**
//     ⇒ "这条查询的词在这篇文档里找得到几个"。
//
// 实测过的反向代价（别随手互换）：查询 `推歌` 对文档「推首歌」——
//   · 查询当 content ⇒ 查询 token 里的两字词 `推歌` 走 `skipBigramHit(文档, '推歌')`，
//     文档字符位置 推@0 / 歌@2、间距 2 ≤ 3 ⇒ **命中，1.0**。
//   · 文档当 content ⇒ 文档 token 是 `推首`/`首歌`，拿它们查查询的位置表 ⇒ **只有 0.2**。
// 即：**长的一侧当 topicSets**。这与"这条查询能不能在这篇文档里落地"的直觉一致。

/**
 * 停用词 —— 与宿主 `conversation-memory/lib/tokenize.js` **同一份**。
 *
 * ⚠️ 两份分词器必须同口径：宿主的海马倒排与这里的倒排搜的是**同一批聊天**，
 * 口径不一致就会出现"宿主的印象系统搜得到、这里的 /search 搜不到"——
 * 那是**最难查的一类 bug**（两边都"看起来正常"）。
 */
const STOP = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '在',
  '和', '与', '也', '就', '都', '很', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
  'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'in', 'on', 'at'
]);

/** 单条 token 的长度上限（超过基本是粘在一起的畸形串，留着只会污染倒排）。 */
const MAX_TOKEN_LEN = 40;

/** `tokensForLine` 的截断长度 —— 与宿主同值（`memory.js` 的 `.slice(0, 160)`）。 */
export const LINE_MAX_CHARS = 160;

/** 单次话题最多取几句（宿主同值 6）。 */
export const MAX_TOPIC_LINES = 6;

/**
 * **文档**侧的长度上限（安全网，不是口径）。
 *
 * ⚠️ 为什么不复用 `LINE_MAX_CHARS`（160）：那是**话题句**的口径 —— 一句话就那么多字，
 *    超出的部分是噪声。**文档不是**：本仓的块文本按 `settings.maxChars` 构建，
 *    实测一条 `usedChars: 355`。把 160 套到文档上 ⇒ **正文的大半根本不进索引**，
 *    表现是"关键词明明在块里、就是搜不到"，而它**静默**（不报错、参数也合法）。
 *    实施时先踩了这一脚（`ADR-0033` §7）。
 *
 *    这个值只是防病态输入的兜底，远高于任何合理的 `maxChars`。
 */
export const DOC_MAX_CHARS = 8000;

/** 规范化：NFKC（全角→半角）+ 小写 + 空白折叠。 */
export function normText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 汉字在串里的位置表（字符 → 下标数组）—— 跳字 bigram 的原料。
 * 抽出来是因为**话题侧与文档侧都要用**：各写一份，两边的"位置"定义迟早会分叉。
 */
function charPos(raw) {
  const pos = new Map();
  const chars = [...raw];           // ⚠️ 用展开而不是下标：`raw` 可能有代理对
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (!/[\u4e00-\u9fff]/.test(c)) continue;
    let arr = pos.get(c);
    if (!arr) { arr = []; pos.set(c, arr); }
    arr.push(i);
  }
  return pos;
}

/**
 * 切出检索 token（去重）。
 * - ASCII/数字连续段 → 整词（`cqt`、`kid1411`、`b12`）
 * - 汉字串 → 每字 + 相邻 bigram（单字停用词丢掉）
 *
 * 不追求语言学正确 —— 只求"给对关键词能搜到"。中文按字 bigram 是**刻意**的选择：
 * 不引分词词典就没有"新词/黑话/人名"的次生问题，而这个库的语料恰恰全是黑话。
 */
export function tokenize(text) {
  const s = normText(text);
  if (!s) return [];
  const out = new Set();
  const push = (t) => {
    if (!t || t.length < 1) return;
    if (STOP.has(t)) return;
    if (t.length > MAX_TOKEN_LEN) return;
    out.add(t);
  };

  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) push(m[0]);

  for (const run of s.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      push(run[i]);
      if (i + 1 < run.length) push(run.slice(i, i + 2));
    }
  }

  return [...out];
}

/**
 * 单句 → 检索用的小结构 `{ set, pos }`。
 *
 * `set` 是 token 集合；`pos` 是**汉字在句中的位置表**（字符 → 下标数组），
 * 供"跳字 bigram"用（见 `skipBigramHit`）。
 *
 * ⚠️ **去掉长度 > 8 的 token**（宿主同口径）：那是短句里不该出现的长串，
 *    留着只会让"整句话"级别的 token 恰好命中一次就顶到满分。
 */
export function tokensForLine(line) {
  const raw = normText(String(line ?? '')).slice(0, LINE_MAX_CHARS);
  if (!raw) return null;

  const set = new Set();
  for (const t of tokenize(raw)) {
    if (!t || t.length > 8) continue;
    set.add(t);
  }

  return { set, pos: charPos(raw) };
}

/**
 * **文档**侧的分词产物 —— 与 `tokensForLine` 是**两个口径**，别互换。
 *
 * 三处刻意的不同（每一处都是踩过才知道的，见 `DOC_MAX_CHARS` 的注释）：
 *   ① **长度上限是 `DOC_MAX_CHARS`**，不是话题句的 160 字；
 *   ② **不做 `> 8 字` 过滤** —— 那条规矩是为"一句话里出现长串"设的；
 *      文档里长串是正常内容，剔了反而让倒排与打分用上两套不同的词集；
 *   ③ 于是 `set` 与倒排里的词条**逐字相等** ⇒ "候选里有它"与"打分时认得它"永远同时成立。
 *
 * ⚠️ ③ 是这条函数存在的**唯一理由**：只要两处用不同的过滤，就会出现
 *    "倒排说命中、打分说 0 分 ⇒ 结果被过滤掉"这种**自相矛盾的静默漏检**。
 */
export function docIndex(text, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : DOC_MAX_CHARS;
  const raw = normText(String(text ?? '')).slice(0, maxChars);
  if (!raw) return null;
  return { set: new Set(tokenize(raw)), pos: charPos(raw) };
}

/**
 * 触发文本 → 若干「单句」结构（数组或单串都收）。
 *
 * 为什么按句拆：刷屏群里一次可能带好几条消息，拼成一坨算重合的话
 * 「给我推首歌」会被旁边聊猫聊模型的句子稀释掉。逐句算、取最大值，语义才对得上。
 */
export function topicTokenSets(topic) {
  const lines = Array.isArray(topic) ? topic : [topic];
  const out = [];
  for (const line of lines) {
    if (out.length >= MAX_TOPIC_LINES) break;
    const info = tokensForLine(line);
    if (info && info.set.size) out.push(info);
  }
  return out;
}

/**
 * 两字词能不能在话题句里「跳着」对上（印象的 `推歌` ↔ 话题的 `推首歌`）。窗口 ≤3 字。
 *
 * ⚠️ `a === b` 直接 false（`首首` 这类叠字在刷屏群里满地都是，它不算"两个不同的字对上了"）。
 */
export function skipBigramHit(info, tok) {
  if (tok.length !== 2) return false;
  const [a, b] = tok;
  if (a === b) return false;
  const pa = info.pos.get(a);
  const pb = info.pos.get(b);
  if (!pa || !pb) return false;
  for (const i of pa) {
    for (const j of pb) {
      if (j > i && j - i <= 3) return true;
    }
  }
  return false;
}

/**
 * `content` 跟话题重合多少（逐句取最大，**封顶 2**）。
 *
 * 计分（宿主实测调出来的，别随手改成"每个字都算 0.3"）：
 *   · 两个字的 token 命中（含跳字）= **+1**
 *   · 只对上**单个汉字** = 最多 **+0.2**（不管对上几个字）
 *
 * 为什么单字必须压到 0.2：刷屏群里"不/人/大/件/推/定"到处都是。按字累加时
 * 「群里的机器人管理员…」能靠 部/人/不 攒到 0.9，压过真正沾边的「推歌口味」——
 * 实测那一轮根本没人提音乐。压到 0.2 之后：只有单字巧合的候选**同分** ⇒ 排序不变
 * （等于没插手），只有**真词命中**（≥1.0）才换人。**这是"宁可不插手，也不乱插手"。**
 *
 * @param {string} content        被匹配的一侧（注入=候选属性行；检索=查询串）
 * @param {any} topicSets         另一侧 —— `[{set,pos}]` 或 文本/文本数组（内部会转）
 * @returns {number} 0 ~ 2，两位小数
 */
export function topicOverlap(content, topicSets) {
  // 允许传「文本」「文本数组」「结构数组」三种：调用方容易记混，这里统一收口
  const sets = Array.isArray(topicSets) && topicSets[0] && topicSets[0].set instanceof Set
    ? topicSets
    : topicTokenSets(topicSets);
  if (!sets.length) return 0;
  const text = String(content || '');
  if (!text) return 0;
  const toks = tokenize(text);
  if (!toks.length) return 0;

  let best = 0;
  for (const info of sets) {
    let bigrams = 0;
    const chars = new Set();
    for (const t of toks) {
      if (info.set.has(t)) {
        if (t.length >= 2) bigrams += 1;
        else chars.add(t);
        continue;
      }
      if (skipBigramHit(info, t)) bigrams += 1;
    }
    const sum = Math.min(2, bigrams + Math.min(0.2, chars.size * 0.2));
    if (sum > best) best = sum;
    if (best >= 2) break;
  }
  return Math.round(best * 100) / 100;
}

/**
 * 「查询的**实词**有几个真的落在文档里」—— 给检索**并列时**用的第二排序键。
 *
 * 为什么需要它：`topicOverlap` **封顶 2**（它是为 ≤6 个候选做的 re-rank，不是相关性分），
 * 一篇 300 字的块很容易靠两三个词就顶到 2.0，于是**大量文档并列**。并列时不能靠
 * "谁先扫到"，需要一个**可解释**的次序 —— 覆盖的词数就是最直白的那个。
 *
 * ⚠️ 只算**长度 ≥ 2 的 token**。单字覆盖是噪声（见 `topicOverlap` 的注释），
 *    拿它排序等于把"不/人/大/件"捧成信号。
 *
 * ⚠️ 这个数**不是**相关性分数，别当门槛用（门槛由调用方明确给出）。它只回答
 *    "命中了几个词"，不回答"够不够相关"。
 *
 * @param {string|string[]} queryTokens 查询的 token（或可被 `tokenize` 的文本）
 * @param {Set<string>} docTokens       文档的 token 集合
 */
export function tokenCoverage(queryTokens, docTokens) {
  const toks = Array.isArray(queryTokens) ? queryTokens : tokenize(queryTokens);
  if (!toks.length || !(docTokens instanceof Set) || !docTokens.size) {
    return { matched: [], count: 0, ratio: 0 };
  }
  const matched = [];
  for (const t of toks) {
    if (t.length < 2) continue;
    if (docTokens.has(t)) matched.push(t);
  }
  const total = toks.filter((t) => t.length >= 2).length;
  return { matched, count: matched.length, ratio: total ? Math.round((matched.length / total) * 100) / 100 : 0 };
}
