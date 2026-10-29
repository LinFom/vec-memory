// 关键词的**脱敏后**来源 —— 修 `ROADMAP #5`（关键词碎片出境）。
//
// ── 问题（实测，2026-10-09 `data/memory-v2/chunks/*.json`）────────────────────
// 块的 `keywords` 是**核心 tokenize 的原始分词**，跑在**未脱敏**文本上：
//   · `Single Samara` → `single` + `samara`   —— 机器人自己的名字被拆成两块
//   · `[CQ:at,qq=…]`  → `cq` + `qq`           —— 结构碎片（纯噪声）
//   · `KID1411`       → `kid1411`             —— 人名的小写残片（实测块里就有）
// 归一化器只认**完整串**（这是对的：`单块即我` 会让普通英文词变占位符），
// 于是这些碎片原样出境 —— 既漏身份，又是纯噪声。
//
// ── 两种修法（本模块两个纯函数，`keywordsSource` 设置决定用哪个）──────────
//   · `filterCoreKeywords`  —— 保留核心分词的质量，只**按词表剔除**碎片（最省、不引入新分词器）
//   · `extractKeywords`     —— 从**已脱敏**文本重新分词（`ROADMAP #5` 用户定的"从脱敏文本重抽"）
//
// ⚠️ 默认值已于 2026-10-09 拍板切为 `filtered`（`DEFAULT_SETTINGS`）：碎片明文出境是
//     隐私 + 检索双重缺陷，且过滤是**结构判据**（不是要维护的名单）—— 新群友/新词自动跟上。
//     切换的代价（整库重嵌入）已由人拍板承担。

/** 占位符（`〔P1〕`/`〔MEDIA〕`/`〔SPEAKER〕`…）—— 它们不是内容，分词前先遮掉。 */
const PLACEHOLDER_RE = /〔[^〕]*〕/g;

/**
 * 结构碎片黑名单：CQ 码与协议字段被核心 tokenize 切出来的词。
 * 它们**永远是噪声**（`cq` / `qq` 出现在每个块的 keywords 里），且与身份无关，
 * 所以两种来源都过滤 —— 不依赖词表。
 */
/**
 * 关键词来源的**默认值**（单一来源）：`backend.mjs` 的 `DEFAULT_SETTINGS` 与
 * `chunkread.mjs` 的 opts 回落都引用这里 —— 改默认只许改这一处。
 * 2026-10-09 拍板切 `filtered`（`ADR-0006` + 用户确认），理由见文件头注释。
 */
export const DEFAULT_KEYWORDS_SOURCE = 'filtered';

export const STRUCTURAL_TOKENS = new Set([  'cq', 'qq', 'at', 'reply', 'image', 'face', 'mface', 'bface', 'anime',
  'forward', 'json', 'xml', 'hl', 'pic', 'file', 'record', 'video', 'shake',
  'poke', 'gift', 'share', 'location', 'music', 'tts', 'markdown', 'node',
  'group', 'private'
]);

/**
 * `keyword` 是不是某个已知实体串（surface）的**碎片**？
 *
 * 判据（顺序即优先级）：
 *   ① 完全相同 ⇒ 是（完整串出境，最严重）
 *   ② 是 surface 按非字母数字切出来的**块** ⇒ 是（`Single Samara` → `single` / `samara`）
 *   ③ **锚定**命中：只算 `surface` 的**开头或结尾**（`kid1411`⊂`KID1411` 等长、
 *      `伊芙`⊂`伊芙琳` 前缀、`单糖`⊂`Persici的单糖` 后缀）
 *
 * ⚠️ ③ **必须锚定**，这是实测改的（2026-10-09 首次审计）：中间命中会把普通词全卷进来 ——
 *    群里真实存在的长名片「放片不看把自己关门外cos无能的丈夫」会让 `自己`/`直接`/`给我`/`一下`
 *    全部被判成"碎片"，`filtered` 模式于是把常用词删光 —— 那才是**真正的内容损坏**
 *    （碎片判据的误伤方向比漏判更贵：漏判一个碎片只是少丢一个词）。
 *    锚定后仍覆盖全部真实现象（见上三例），代价只是"名字被写在中间"这类想象情形。
 *
 * ⚠️ 长度下限也是**故意的**：纯 ASCII ≥3、含汉字 ≥2。否则单字母实体（实测有 surface 是 `D`）
 *    会把所有含该字母的词判成碎片。
 */
export function isSurfaceFragment(keyword, surface) {
  const k = String(keyword ?? '').trim().toLowerCase();
  const s = String(surface ?? '').trim().toLowerCase();
  if (!k || !s) return false;
  if (k === s) return true;
  const ascii = /^[\x20-\x7e]+$/.test(k);
  if (k.length < (ascii ? 3 : 2)) return false;
  const blocks = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (blocks.includes(k)) return true;
  return s.startsWith(k) || s.endsWith(k);
}

/** 审计用：从关键词表里挑出所有"是某个 surface 碎片"的条目（返回 `{keyword, surface}`）。 */
export function keywordFragments(keywords, surfaces) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  const out = [];
  for (const raw of keywords || []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    const hit = list.find((s) => isSurfaceFragment(t, s));
    if (hit) out.push({ keyword: t, surface: String(hit) });
  }
  return out;
}

/**
 * 过滤核心分词：剔掉结构碎片与"已知实体串的碎片"，其余**原样保留顺序**。
 * 纯函数：不碰词表对象，只读 `opts.surfaces`。
 *
 * @param {string[]} keywords 核心 `tokenize()` 的产物（`chunk.keywords`）
 * @param {{surfaces?: string[], limit?: number}} [opts]
 * @returns {string[]}
 */
export function filterCoreKeywords(keywords, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 24);
  const surfaces = opts.surfaces || [];
  const out = [];
  for (const raw of keywords || []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    if (STRUCTURAL_TOKENS.has(t.toLowerCase())) continue;
    // 纯数字（QQ 号残留 / 消息数）：对语义零贡献，且是身份的半截 —— 永远不当关键词。
    // （core 口径下它们走归一化被数字层拦；filtered 的关键词行拼在归一化**之后**，得自己拦。）
    if (/^[0-9]+$/.test(t)) continue;
    if (surfaces.some((s) => isSurfaceFragment(t, s))) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从**已脱敏**文本重新抽关键词（纯函数，不需要词表 —— 名字早已是占位符）。
 *
 * 分词口径（刻意简单、可解释，不引第三方分词器）：
 *   · 拉丁/数字词：`[A-Za-z][A-Za-z0-9_]{1,}`，小写化；数字开头的串（QQ 号残留）不收
 *   · 汉字 n-gram：连续汉字段切 **2 元 + 3 元**（2 元覆盖常用词，3 元留住短语）
 *   · 占位符与结构碎片先剔掉
 * 排序：出现次数 ↓ → 词长 ↓ → 首次出现位置 ↑（**确定性**：同样输入永远同样输出）
 *
 * ⚠️ 它是"够用"而不是"最好"：没有词表分词，2 元里必然有跨词边界的噪声
 *    （`明一`/`下一`）。选它的理由是**可解释 + 零依赖 + 不引入新的出境面**；
 *    质量由 `tools/keyword-audit.mjs` 在真数据上量出来，再决定是否启用。
 *
 * @param {string} text 已归一化的文本（snippets / summary 的合格者）
 * @param {{limit?:number}} [opts]
 * @returns {string[]}
 */
export function extractKeywords(text, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 24);
  const src = String(text ?? '').replace(PLACEHOLDER_RE, ' ');
  /** @type {Map<string, {count:number, first:number}>} */
  const counts = new Map();
  let order = 0;
  const bump = (token) => {
    const cur = counts.get(token);
    if (cur) { cur.count += 1; return; }
    counts.set(token, { count: 1, first: order++ });
  };

  for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) {
    const t = m[0].toLowerCase();
    if (STRUCTURAL_TOKENS.has(t)) continue;
    bump(t);
  }
  for (const m of src.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = m[0];
    for (const n of [2, 3]) {
      for (let k = 0; k + n <= run.length; k++) bump(run.slice(k, k + n));
    }
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1].count - a[1].count) || (b[0].length - a[0].length) || (a[1].first - b[1].first))
    .slice(0, limit)
    .map(([term]) => term);
}
