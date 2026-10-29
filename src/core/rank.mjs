// 六维打分（M1 · 影子）—— 纯函数，零依赖，可单独跑。
//
// ── 这个文件为什么长这样 ──────────────────────────────────────────────────
// 「六维记忆」那套实现（`memory_plugin/src/memory6d-kernel.js`，`6d-kernel-1.1`）
// 已经把**算法**抽成了一个零依赖纯函数内核。本文件做两件事，且只做这两件：
//
//   ① 把内核里那批**纯函数**照抄过来（`clamp` / `halfLifeDays` / `effectiveWeight`
//      / `scoreOf` / `importanceFromText`），并在 `test/rank.mjs` 里**对拍** ——
//      抄就得抄到数值等价，不能"参考着写"。
//   ② 给**小时块**（而不是它的 fact/event 表）派生六维。
//      六维的原料在它那边来自 `facts.jsonl` 的字段（`sources[]` / `hits` /
//      `participants` / `emotion`）。我们 M1 的对象是**核心已有的小时块**，
//      那些字段一个都没有 —— 所以必须从块自己身上派生，而不能假装有。
//
// ⇒ **凡派不出来的，一律 `src: 'missing'`，值给 `null`。**
//   `missing ≠ 0` 是这套系统的头号纪律（`规格/rubrics.md` §0.2）：
//   填 0 会让覆盖率的图看起来 100%，实际全是假的。本项目已经在这上面栽过两次
//   （`165 条事实 importance 全 3`、`weightStep` 默认 0.15）。
//
// ── 六维在这套系统里到底回答什么（照抄口径，不许自行发挥）──────────────────
//   S 意义强度   这条记忆对"这段关系"有多重要                     0~1
//   D 细节完整度 细节**可复现、可验证**的程度（≠ 长度）             0~1
//   E 情绪残留   valence -1~1 / intensity 0~1（**状态**，非事实）   0~1
//   R 可检索度   这条记忆在多少个会话里被承认过（通路数）           0~1
//   I 中心度     被多少线索指着（跨会话 × 重逢 × 参与人数）          0~1
//   C 巩固程度   被反复重逢过多少次                                0~1
//
// 每个维度对外都带 `src: 'field' | 'derived' | 'missing'`，消费口**必须**看它：
//   指不出 `src` 的分数，就是"看起来有值的常数"。

export const RANK_VERSION = 'rank-1';

export const DAY_MS = 86400000;

/** 六维的顺序是**固定的**：面板、分布表、测试都按它排。 */
export const DIM_ORDER = ['S', 'D', 'E', 'R', 'I', 'C'];

export const DIM_LABEL = {
  S: '意义强度',
  D: '细节完整度',
  E: '情绪残留',
  R: '可检索度',
  I: '中心度',
  C: '巩固程度'
};

/** 各维的原料来自哪 —— 面板要显示给人看，免得又出现"这一维在裸奔"。 */
export const DIM_SOURCE = {
  S: '块的关键词+摘要，走 importanceFromText 词表规则（内核同款）',
  D: '块的抽样覆盖率（snippets / msgCount）+ 有声原话条数，分三档',
  E: '**无原料** —— 情绪词表未随源包分发，且块级融合文本上判情绪会污染（见 ADR-0008）',
  R: '块里命中的实体在多少个会话里出现过（跨块倒排 / 5，内核同款归一化）',
  I: '跨会话来源 × 重逢次数 × 参与人数（内核 centralityOf 同款权重）',
  C: '重逢次数（hits / 10）+ 核心是否巩固过（consolidatedAt 有值）'
};

// ══════════════════════════════════════════════════════════════════════════
// ① 照抄 shipped kernel 的纯函数
//    来源：E:/Tools/QQ-Agent-整合版-100000001/memory_plugin/src/memory6d-kernel.js
//    对拍：test/rank.mjs 直接 import 那个文件，逐函数比数值。
// ══════════════════════════════════════════════════════════════════════════

export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 半衰期（天）：importance 越高活得越久。
 * importance 1 → 1.0×base，3 → 2.5×base，5 → 4.0×base（base 默认 30 天）。
 *
 * ⚠️ 这个 `(i-1)*0.75` 是**六维自用**的。别把它套到关系边上 ——
 * 关系边没有 `i`，套上去会让「聊过一千次的老朋友」被「点过两次头的人」碾过
 * （实测差 8 个数量级，见 `plugin/02-图谱层构思.md` 改 2）。
 */
export function halfLifeDays(importance, base) {
  const i = clamp(Number(importance) || 3, 1, 5);
  return base * (1 + (i - 1) * 0.75);
}

/**
 * 遗忘曲线：把"权重 + 重要度 + 最后触碰时间"实时折算成当前有效权重。
 * 不用定时扣分 —— 衰减可解释、可重算，也不会因为进程没开而漏算。
 */
export function effectiveWeight(entry, now = Date.now(), baseDays = 30) {
  if (!entry) return 0;
  if (entry.pinned === true) return 1;
  const w0 = clamp(entry.weight === undefined ? 1 : entry.weight, 0, 1);
  const touched = Number(entry.lastTouchedAt) || Number(entry.updatedAt) || Number(entry.createdAt) || now;
  const ageDays = Math.max(0, (now - touched) / DAY_MS);
  return clamp(w0 * Math.pow(0.5, ageDays / halfLifeDays(entry.importance, baseDays)), 0, 1);
}

/** 综合排序分：有效权重为主，重要度次之。 */
export function scoreOf(entry, now, baseDays) {
  const w = effectiveWeight(entry, now, baseDays);
  const imp = clamp(Number(entry?.importance) || 3, 1, 5) / 5;
  return w * 0.65 + imp * 0.35;
}

/**
 * S 维的自动判定（零 token 词表规则）。只判 5 / 4 / 2 三档，
 * **判不出来一律回落 3** —— 保守，不制造虚假精度。
 *
 * ⚠️ 它自己就是这个文件最大的分布风险：关键词表命中率低的话，
 * 全库会一起回落到 3（= 内核那边 `165/165` 的病复现）。
 * 所以 M1 的第一件事就是**量它**，而不是信它。
 */
export function importanceFromText(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const has = (arr) => arr.some((w) => lower.includes(w));
  if (has(['雷点', '雷区', '禁忌', '绝对不能', '绝对不', '绝不', '不许', '不准', '禁止', '底线',
    '不能提', '别提', '别再提', '安全词', '过敏', '碰不得', '死穴'])) return 5;
  if (has(['约定', '答应', '承诺', '说好了', '保证', '最讨厌', '最喜欢', '不吃', '不爱吃', '不能吃',
    '习惯', '总是', '每次都', '生日', '设定是', '自称', '职业', '工作', '上学', '住在', '老家'])) return 4;
  if (has(['今天', '刚才', '这会儿', '临时', '这阵子', '待会', '今晚', '昨天', '这次', '现在正'])) return 2;
  return 3;
}

// ══════════════════════════════════════════════════════════════════════════
// ② 块的可用原料（先把"有什么"摊开，再谈打分）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 一个块身上真正有的东西（实测字段，见 data/memory-v2/chunks/*.json）：
 *
 *   id kind chatKey dayKey hourKey timeOfDay when
 *   title summary keywords[] snippets[] msgCount consolidatedAt
 *
 *   snippets[i] = { ts, mid, localId, who, self, text, w }
 *
 * ⇒ 六维需要的 `sources[] / hits / participants / emotion / weight` **一个都没有**。
 *   能派生的只有：抽样的音频痕迹（snippets）、块的显著性（w）、
 *   关键词里的实体、以及跨块的实体倒排。这就是下面所有的原料来源。
 */
export function chunkParts(chunk, derived = {}) {
  const snippets = Array.isArray(chunk?.snippets) ? chunk.snippets : [];
  const ws = snippets.map((s) => Number(s?.w)).filter((n) => Number.isFinite(n) && n > 0);
  const msgCount = Math.max(0, Number(chunk?.msgCount) || 0);
  const samples = snippets.length;
  const who = new Set();
  for (const s of snippets) {
    const k = String(s?.who ?? '').trim();
    if (k) who.add(k);
  }
  return {
    samples,
    msgCount,
    // ⚠️ 这不是"抽样率"，是**块内保真度**。实测（469 个真块）：
    //   coverage 最小 0.301、最大 1.000，30 种取值，其中 90.4% 恰为 **1.000**。
    //   ⇒ 小块的 snippets 就是全部消息，大块被核心封顶到 ~80 条。
    //   **实跑把 D 的判据推翻了**：因为最小值 0.301 也 ≥ 我定的 0.30 阈值，
    //   469 个块全部落进 0.8 那一档 → D 恒 0.8（`dead`，见 ADR-0008）。
    //   是**阈值太松**，不是没原料（仪表把这两种病分开报了）。
    //   （ADR-0004 里那个 11.4% 说的是**存档 → 块**的覆盖率，不是块内。两个数不是一回事。）
    coverage: msgCount > 0 ? samples / msgCount : null,
    wMean: ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null,
    wMax: ws.length ? Math.max(...ws) : null,
    wSum: ws.length ? ws.reduce((a, b) => a + b, 0) : 0,
    participants: who.size,
    // 派生自全量扫描（rankscan 填）：本块命中的实体 + 它们辐射到几个会话 + 重逢次数
    entityKeys: Array.isArray(derived.entityKeys) ? derived.entityKeys : [],
    entitySessions: Number(derived.entitySessions) || 0,
    entityRecur: Number(derived.entityRecur) || 0
  };
}

/** 块的显著性 —— 归一到 0~1。取 wMax 而不是均值：一个块有几条"值得记住的"就是它的显著性。 */
export function significance(entry, parts = chunkParts(entry)) {
  if (parts.wMax === null) return null;
  return clamp(parts.wMax / 3, 0, 1);
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 六维
// ══════════════════════════════════════════════════════════════════════════

/** D 维的三档锚点（照 rubrics 的 0.2 / 0.5 / 0.8，判据换成块上量的出来的东西）。 */
export function detailTier(parts) {
  if (parts.samples === 0) return 0.2;              // 没有一条原话 → 只能算转述
  const cov = parts.coverage;
  if ((cov !== null && cov >= 0.30) || parts.samples >= 40) return 0.8;  // 原话足够复现
  if ((cov !== null && cov >= 0.10) || parts.samples >= 12) return 0.5;  // 有出处但缺细节
  return 0.2;
}

/**
 * 逐维打分。
 *
 * @param {object} entry   核心小时块（原始字段即可）
 * @param {object} [derived] 由 rankscan 从全量算出来的跨块原料
 * @returns {{S:number|null, D:number|null, E:number|null, R:number|null, I:number|null, C:number|null,
 *            src:Record<string,'field'|'derived'|'missing'>,
 *            parts:object, note:Record<string,string>}}
 */
export function dims(entry, derived = {}) {
  const parts = chunkParts(entry, derived);

  // ── S 意义强度 ────────────────────────────────────────────────────────
  // 原料是"块的关键词 + 摘要"，走内核同款词表规则。两级信息：
  //   S_raw ∈ {2,3,4,5}（判据本身）    S = S_raw / 5（与 scoreOf 里的 imp/5 同口径）
  const sText = [
    Array.isArray(entry?.keywords) ? entry.keywords.join(' ') : '',
    String(entry?.summary || entry?.title || '')
  ].filter(Boolean).join('\n');
  const sRaw = importanceFromText(sText);
  const S = sRaw / 5;

  // ── D 细节完整度 ──────────────────────────────────────────────────────
  const D = detailTier(parts);

  // ── E 情绪残留 ────────────────────────────────────────────────────────
  // **没有原料，就写没有。** 源包只分发了 kernel 与 store，
  // rubrics §3 提到的 `内核/emotion.mjs`（词表 v3）不在包里（全盘 find 无此文件）。
  // 而且就算有，E 的四条红线里第 2 条写着"情绪必须独立落点，绝不写进事实条目"——
  // 块级融合文本上判情绪，正是它明令禁止的那种做法。
  const E = null;

  // ── R 可检索度 ────────────────────────────────────────────────────────
  // 内核口径：通路数 = 这条记忆在多少个会话里被承认过（去重 chatKey 数 ÷ 5，5 条满分）。
  // 块上没有 `sources[]`，用**实体倒排**近似：本块命中的实体，一共辐射到几个会话。
  // 一个实体都没有 ⇒ 不是"不可检索"，是**没有原料** ⇒ null。
  const R = parts.entityKeys.length ? Math.min(1, parts.entitySessions / 5) : null;

  // ── I 中心度 ──────────────────────────────────────────────────────────
  // 内核 centralityOf 同公式、同权重（来源交叉 0.25 / 重逢 0.40 / 参与 0.35）。
  // 只是三个输入换成块上量的出来的：实体辐射会话数 / 实体重逢次数 / 有几个人说话。
  const nSrc = parts.entitySessions;
  const hits = parts.entityRecur;
  const partN = parts.participants;
  const I = Math.min(1,
    Math.min(1, nSrc / 3) * 0.25 +
    Math.min(1, hits / 10) * 0.4 +
    Math.min(1, partN / 4) * 0.35);

  // ── C 巩固程度 ────────────────────────────────────────────────────────
  // 内核口径是 `hits` + `lastConsolidateAt` 有值。块上有 `consolidatedAt`（核心真的写过）
  // 和重逢次数（实体在别的块里再出现）。两项各半。
  const consolidated = Number(entry?.consolidatedAt) > 0 ? 1 : 0;
  const C = 0.5 * Math.min(1, hits / 10) + 0.5 * consolidated;

  return {
    S, D, E, R, I, C,
    src: {
      S: 'derived',
      D: 'derived',
      E: 'missing',
      R: parts.entityKeys.length ? 'derived' : 'missing',
      I: 'derived',
      C: 'derived'
    },
    parts: { ...parts, sRaw, sTextChars: sText.length },
    note: {
      S: `importanceFromText → ${sRaw}（2/3/4/5 四档，判不出来回落 3）`,
      D: `抽样覆盖率 ${parts.coverage === null ? 'n/a' : (parts.coverage * 100).toFixed(1) + '%'} · 原话 ${parts.samples} 条 · msgCount ${parts.msgCount}`,
      E: '本机无情绪词表（源包未分发）；且块级融合文本判情绪违反 E 维红线 2 —— 显式记为「不做」，不是 0',
      R: parts.entityKeys.length ? `${parts.entityKeys.length} 个实体辐射 ${parts.entitySessions} 个会话` : '块里没命中任何实体 ⇒ 无原料',
      I: `来源 ${nSrc} 会话 / 重逢 ${hits} 次 / 参与 ${partN} 人`,
      C: `重逢 ${hits} · consolidatedAt ${consolidated ? '有' : '无'}`
    }
  };
}

/**
 * 块的排序分 —— **内核 scoreOf 原样**，只是把原料接上。
 *
 * `w0`（`entry.weight`）在块上本来是空的。内核默认 1，那会让全库的 0.65 那半项
 * 只随**衰减**变化。所以这里显式提供两个口径，让分布说话，而不是先替谁拍板：
 *   - `weighted: false` → 内核默认（w0 = 1）
 *   - `weighted: true`  → 用块的显著性当 w0（wMax 归一）
 *
 * @param {number} [baseDays=30] 半衰期基数
 * @param {boolean} [weighted=false]
 */
export function scoreOfChunk(entry, d, now = Date.now(), baseDays = 30, weighted = false) {
  // d 可以传 dims() 的整个返回值，也可以直接传它的 parts；都不传就现算一份。
  const parts = d?.parts ?? (d?.wMax !== undefined ? d : chunkParts(entry));
  const lastTouchedAt = Number(entry?.consolidatedAt) || Number(entry?.when) || now;
  let w0 = 1;
  if (weighted) {
    const wMax = parts?.wMax;
    w0 = wMax === null || wMax === undefined ? 1 : clamp(wMax / 3, 0, 1);
  }
  return scoreOf(
    { weight: w0, importance: parts?.sRaw ?? 3, lastTouchedAt },
    now,
    baseDays
  );
}

/** 六维里**允许进 scoreOf** 的那几个（其余保持只算不用）。上游按判据填。 */
export const SCORABLE_DIMS = ['S', 'C'];
