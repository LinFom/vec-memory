// src/core/event-index.mjs —— 短期层的**关键词索引**（倒排 + IDF 打分）
//
// ── 这个文件解决什么（`ADR-0048` ④）────────────────────────────────────────
// 事件进短期层之后，注入不能只靠"最近 N 条"：群里刚聊过的话题未必是最近一小时的事，
// 而"刚才发生过什么"只按时间取会让老事件永远轮不到（三天前那件"决定周末去露营"
// 在周末当天最该被想起来）。
// 所以要一层**关键词检索**：拿当前话题句去短期层里找有关联的事件。
//
// ── 为什么不用 `topicOverlap`（`tokens.mjs` 那个）──────────────────────────
// 它是为 **≤6 个候选的 re-rank** 调的：封顶 2、单字固定 0.2、命中两个词就顶满。
// 用它给**整个短期层**（可能几千条）打分，结果是**大量事件并列在 2.0**
// （2026-10-22 实测：五个真实查询 top5 全是 2.00 ⇒ 实际排序由时间决定，检索等于没做）。
//
// 这里换成 **IDF 加权的查询覆盖率**：
//   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))       ← 越罕见的词越值钱
//   score  = Σ_{t∈查询∩事件} idf(t) / Σ_{t∈查询} idf(t)  ← 落在 0~1，可解释、可当门槛
// 好处正是要它解决的那个问题：**单字天然 df 高 ⇒ idf 接近 0 ⇒ 自己就淡出了**，
// 不必像 `topicOverlap` 那样硬编码"单字只给 0.2"（那条规则同时压死了所有单字，
// 包括"猫""鱼"这种有区分度的）。
//
// ⚠️ 分母是**查询侧全部 token 的 idf 之和** ⇒ 查询句越长越难拿高分。所以门槛
//    不能按"相似度 0.8"那种直觉设（默认 `DEFAULT_EVENT_MIN_SCORE = 0.18`，
//    含义大致是"查询里值钱的那几个词里，至少有一个真的落在事件里"）。
//    真实校准见 `_scratch/calibrate-event-idf.mjs`，调参前先跑它。
import fs from 'node:fs';

import { readEventRows, consolidatePaths, RETIRE_DIM_WEIGHT } from './consolidate.mjs';
import { tokenize } from './tokens.mjs';

/**
 * 关键词路的默认门槛（0~1 的覆盖率）。低于它 ⇒ 这条事件不算"相关"。
 *
 * 0.15 取自真实语料的分位（2026-10-23，`_scratch/calibrate-event-idf.mjs`，
 * 用宿主真实聊天当 topic、真实事件账本当库；账本按一事一行拆过之后 98 条）：
 *   自身分数 p90=0.447 / p75=0.403 / p50=0.150 / p25=0.111 / p10=0.000，
 *   **双峰**：真相关的一坨在 0.33~0.55，纯巧合的一坨在 0.11~0.19。
 *   门槛压在 p50（0.15）而不是谷底：多给一条事件只要 40 来字，
 *   而漏掉一条的代价是"记了却想不起来"（用户的核心抱怨）。**便宜的一侧要放宽。**
 *
 * ⚠️ 门槛只有配合 `requireWord`（至少一个两字以上的 token 命中）才成立 ——
 *    单看分数，一句"我吃了碗面"也能靠单字巧合拿到 0.16。
 */
export const DEFAULT_EVENT_MIN_SCORE = 0.15;

/**
 * 是否要求"至少命中一个**两字以上**的 token"。
 *
 * 单字命中在这类语料里基本是噪声：中文单字几乎每句都有，「不/人/大/个」能凑出一堆
 * 假命中（实测：`我是不太懂这个` 靠单字「个」就能对上一条讲群友吵架的事件）。
 * 这条不是把单字权重压低（IDF 已经在做那件事），而是**直接要求有一个真词落地**。
 */
export const DEFAULT_EVENT_REQUIRE_WORD = true;

/**
 * 分数差小于这个值就当作**并列**，交给第二键（命中最罕见词）决定先后。
 *
 * 为什么需要它（2026-10-23 生产实测）：查询「妮安最近在群里说了什么」的 top3 是
 * 0.447 / 0.446 / 0.434 —— 三条**实质并列**，但第一条 matched 是
 * `在群/群/群里/里/说`（全是通用词），第二条才含专名「妮安」。差 0.001 也算数的话，
 * 「谁排第一」就由一堆通用词决定，而这正是用户抱怨的"记了却想不起来"的观感来源。
 *
 * ⚠️ 别把它理解成"高频词要过滤掉"：真实 topic（10 条消息拼成）上 top1 就是目标事件
 * （9/10 捞回自己，见 `_scratch/diagnose-event-df.mjs`），通用词在那里无害 ——
 * 信息量足的查询自带区分度。这一键只在**短查询区分度不足**时救场。
 */
const SCORE_TIE_EPS = 0.02;

/** 标题里的命中权重（标题是这事的骨架，正文常带闲聊噪声）。 */
const TITLE_BOOST = 2;

/**
 * 分母里"库里根本没有的词"的折扣系数。
 *
 * 为什么要打折而不是全额计入：`topic` 是**最近几条真实聊天**拼的，里面一半是
 * "哈哈/刚刚/你们/这个"这类口头语 —— 它们当然不会出现在事件摘要里，
 * 但这**不说明**"这一问短期层答不了"。全额计入会让正常查询的分数被无谓压低
 * （2026-10-23 真实语料实测：全额计入时"自身被捞回"的分数中位数只有 0.21，
 * 门槛落在 0.18 就等于**一半情况给空**）。
 *
 * 0.35 是实测出来的：见 `_scratch/calibrate-event-idf.mjs` 的 λ 扫描。
 */
const MISS_PENALTY = 0.35;

/**
 * 索引缓存：`libDir → { stamp, index }`。
 *
 * 为什么必须缓存：`/inject` 是**每轮对话都调**的端点，而短期层可能几千条事件。
 * 每次重建 = 每轮几十万次 tokenize —— 比向量检索还贵，且完全没必要
 * （events.jsonl 只在整理跑完时变）。
 * `stamp` 用 `mtimeMs + size`：append 一定改这两个数，搬迁/重写也逃不掉。
 */
const CACHE = new Map();

/**
 * 建索引（纯函数，不碰缓存）。
 *
 * @param {Array<object>} rows 事件行（`readEventRows().rows` 的形态）
 * @returns {{N:number, df:Map<string,number>, post:Map<string,Array<{id:string,tf:number,title:boolean}>>, docs:Array<object>, dropped:number}}
 */
export function buildEventIndex(rows) {
  const df = new Map();
  const post = new Map();
  const docs = [];
  let dropped = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String(r?.id || '').trim();
    if (!id) { dropped++; continue; }
    if (r.retiredAt) { dropped++; continue; }        // 硬回收：出索引（ADR-0048 ⑪ 的第二刀）
    if (r.supersededBy) { dropped++; continue; }     // 旧窗口行已被拆成一事一行（ADR-0048 迁移）
    const title = String(r.title || '');
    const body = String(r.summary || r.detail || '');
    if (!title && !body) { dropped++; continue; }

    // `ADR-0048 ⑪`：**变暗的行仍然进索引**，只是 tf 整体乘 `RETIRE_DIM_WEIGHT`。
    // 这是软回收的全部意义 —— 它被想起的难度变大了，但**还能被找到**。
    // （旧行为在这里直接 `dropped++`，等于把"可检索性"和"数据"一起删了。）
    // ⚠️ 用的是持久化的 `dimmedAt`，不是实时的保持率：索引缓存按 `events.jsonl` 的
    //    mtime+size 失效，而"复活"要等下一次整理清 `dimmedAt` 才落盘 ⇒
    //    刚被排练的变暗行会**多暗一个整理周期**。偏向保守（名次低，不丢），可接受。
    const dim = r.dimmedAt ? Math.max(0.01, Math.min(1, Number(RETIRE_DIM_WEIGHT) || 0.3)) : 1;

    // tf 分两档：标题命中算 2 次、正文命中算 1 次（同一 token 不重复累加同一档）
    const tf = new Map();
    const titleToks = new Set(tokenize(title));
    for (const t of titleToks) tf.set(t, (tf.get(t) || 0) + TITLE_BOOST * dim);
    for (const t of new Set(tokenize(body))) tf.set(t, (tf.get(t) || 0) + 1 * dim);

    const chatKey = String(r.chatKey || '');
    for (const [t, n] of tf) {
      df.set(t, (df.get(t) || 0) + 1);
      let arr = post.get(t);
      if (!arr) { arr = []; post.set(t, arr); }
      arr.push({ id, tf: n, chatKey });
    }
    docs.push({ id, chatKey, toTs: Number(r.toTs) || 0 });
  }

  return { N: docs.length, df, post, docs, dropped };
}

/** 单 token 的 idf（`N=0` ⇒ 0；`df=0` ⇒ 0，表示"这个词不在索引里"，**不**等于不罕见）。 */
export function idfOf(index, token) {
  const raw = idfRaw(index, token);
  if (!raw) return 0;
  return capByChars(index, token, raw);
}

/** idf 的裸公式（不带上字约束）—— 约束自身要用它，否则会无限递归。 */
function idfRaw(index, token) {
  const N = Number(index?.N) || 0;
  if (!N) return 0;
  const dfv = Number(index.df.get(token)) || 0;
  if (!dfv) return 0;
  return Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
}

/**
 * **一个词的信息量不该超过它最好的那个字**（2026-10-23 实测后加）。
 *
 * 起因：查询「妮安最近在群里说了什么」的 top1 命中，matched 全是 `在群/群/群里/里/说`。
 * 查真实 df（`data-2`，N=98）：`在群` df=2 ⇒ **idf=3.679**，比专名 `妮安`(df=5, idf=2.890)
 * **还高**。原因是 `在` 是停用词（`tokenize` 直接丢掉、df=0），于是「在群」在倒排里
 * 成了一个**几乎独占**的词 —— 可它在语义上只是「群」的变体。
 *
 * ⇒ IDF 本身分不出"罕见且有意义"与"罕见但没意义"（小语料上尤其明显：通用 bigram 的
 * df 也可以很低）。加这一条约束后：`在群` ≤ max(idf(在)=0, idf(群)=1.114) ⇒ 1.114；
 * `妮安` ≤ max(idf(妮)=2.890, idf(安)=2.344) ⇒ 保持 2.890。**专名不受损**（它的字同样罕见）。
 *
 * ⚠️ 只对**纯汉字且 ≥2 字**生效：ASCII 整词（`cqt`）不该被按字母拆开比。
 */
function capByChars(index, token, raw) {
  if (!/^[\u4e00-\u9fff]{2,}$/.test(String(token || ''))) return raw;
  let best = 0;
  for (const c of token) {
    const w = idfRaw(index, c);
    if (w > best) best = w;
  }
  return best > 0 ? Math.min(raw, best) : raw;
}

/**
 * 「一个词在语料里**一次都没出现**」该记多少信息量 —— 取 idf 的**上界**（`df → 0`）。
 *
 * 为什么需要它：分母如果只累加"语料里存在"的词，就会出现
 * `查询 = 「我是不太懂这个」` ⇒ 只有单字「个」在库里 ⇒ 分母只剩它自己 ⇒ **score = 1.0**
 * ⇒ 一条毫不相干的事件被当成满分命中。这类查询的特征是**信息量大多落在库外的词上**，
 * 分母必须如实反映"这一问有多少字是库里根本没有的"。
 */
export function idfCeilingOf(index) {
  const N = Number(index?.N) || 0;
  if (!N) return 0;
  return Math.log(1 + (N + 0.5) / 0.5);
}

/**
 * 拿一个查询句去短期层找相关事件。
 *
 * @param {object} index            `buildEventIndex` 的产物
 * @param {string|string[]} query   当前话题（可以是多句，逐句取最大 —— 与注入侧同口径）
 * @param {object} [o]
 * @param {string} [o.chatKey]  只在这个会话里找（**必填**语义：短期层按会话物理隔离，
 *                              不给就等于把私聊的事念到群里 —— 见 `CONTEXT.md`「记忆的两层」）
 * @param {number} [o.limit=5]
 * @param {number} [o.minScore]
 * @param {Set<string>|string[]} [o.exclude] 已由"最近事件"段覆盖的 id（不重复给）
 * @returns {Array<{id, score, matched, coverage}>} 按 score 降序、同分按 matched 多者优先
 */
export function searchEvents(index, query, {
  chatKey = '', limit = 5, minScore = DEFAULT_EVENT_MIN_SCORE,
  exclude = null, requireWord = DEFAULT_EVENT_REQUIRE_WORD
} = {}) {
  const N = Number(index?.N) || 0;
  if (!N) return [];
  const queries = (Array.isArray(query) ? query : [query]).map((q) => String(q || '').trim()).filter(Boolean);
  if (!queries.length) return [];

  const ck = String(chatKey || '').trim();
  const skip = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  const idfMax = idfCeilingOf(index);
  const best = new Map();          // id → {score, matched:Set}

  for (const q of queries) {
    const qToks = [...new Set(tokenize(q))];
    if (!qToks.length) continue;
    // 分母 = 这一问的**全部信息量**：库里有这个词就用它的 idf，库里没有就按上界 × 折扣记
    // （折扣的理由见 `MISS_PENALTY`）。⇒ 分数读作"这一问有多少信息量被这条事件接住了"。
    const total = qToks.reduce((s, t) => s + (idfOf(index, t) || idfMax * MISS_PENALTY), 0);
    if (total <= 0) continue;
    const acc = new Map();         // id → {w, matched:[], maxIdf}
    for (const t of qToks) {
      const w = idfOf(index, t);
      if (w <= 0) continue;
      for (const p of index.post.get(t) || []) {
        if (ck && p.chatKey !== ck) continue;      // 会话隔离：绝不跨会话给
        let a = acc.get(p.id);
        if (!a) { a = { w: 0, matched: [], maxIdf: 0 }; acc.set(p.id, a); }
        a.w += w * Math.min(2, p.tf);      // tf 饱和在 2：短摘要里 tf>2 基本是复读
        a.matched.push(t);
        if (w > a.maxIdf) a.maxIdf = w;    // 平局键：它命中的**最罕见**的词有多罕见
      }
    }
    for (const [id, a] of acc) {
      // ⚠️ **不封顶 1**：标题加权会让"标题+正文都命中"的分数超过 1，这是有意的 ——
      //    封顶会把"标题命中"和"正文命中"抹成同分（实测：两条都 =1.0，随后由 id 决定先后，
      //    等于标题加权根本没生效）。门槛只管下界。
      const raw = a.w / total;
      const score = Math.round(raw * 1000) / 1000;
      const cur = { score, raw, maxIdf: a.maxIdf, matched: a.matched };
      const prev = best.get(id);
      if (!prev || raw > prev.raw) best.set(id, cur);
    }
  }

  const out = [];
  for (const [id, v] of best) {
    if (skip.has(id)) continue;
    if (v.score < minScore) continue;
    // 真词落地：**必须**有一个两字以上的 token 命中。
    // ⚠️ 曾经放宽成"多个不同单字也算"，实测当场被打穿：无关话题「今天天气不错 我吃了碗面」
    //    靠 `气` + `不` 两个单字就凑出 0.15 命中一条讲群友吵架的事件（2026-10-23）。
    //    「不」并不在停用词表里（`tokens.mjs` 的 STOP 与宿主同源，不许私改）⇒
    //    单字的 idf 再低，凑两三个也能过门槛。只有 bigram 是真信号。
    if (requireWord && !v.matched.some((t) => t.length >= 2)) continue;
    out.push({
      id, score: v.score, matched: v.matched, coverage: v.matched.length,
      maxIdf: Math.round(v.maxIdf * 1000) / 1000   // 一起回报：排障时看得出"它靠什么赢的"
    });
  }
  // 排序：分数 → **平局时看它命中的最罕见的词** → 命中词数 → id。
  // 第二键的理由见 `SCORE_TIE_EPS`：分数并列时，命中专名的一条才是"因为这件事被想起"。
  out.sort((a, b) => {
    if (Math.abs(a.score - b.score) >= SCORE_TIE_EPS) return b.score - a.score;
    const pa = (best.get(a.id)?.maxIdf) ?? 0;
    const pb = (best.get(b.id)?.maxIdf) ?? 0;
    return pb - pa || b.coverage - a.coverage || (a.id < b.id ? -1 : 1);
  });
  return out.slice(0, Math.max(1, Number(limit) || 5));
}

/**
 * 取（并缓存）某个库的索引。
 *
 * @param {object} o
 * @param {string} o.libDir
 * @param {boolean} [o.force] 强制重建（测试/排障用）
 * @returns {{N:number, df:Map, post:Map, docs:Array, dropped:number, stale:boolean}}
 */
export function getEventIndex({ libDir, force = false } = {}) {
  const dir = String(libDir || '').trim();
  if (!dir) return { ...buildEventIndex([]), stale: false };
  const file = consolidatePaths(dir).events;
  let stamp = 'missing';
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch { /* 文件还没建 ⇒ 空索引 */ }

  const hit = CACHE.get(dir);
  if (!force && hit && hit.stamp === stamp) return hit.index;

  const { rows } = readEventRows({ libDir: dir });
  const index = { ...buildEventIndex(rows), stamp, stale: false };
  CACHE.set(dir, { stamp, index });
  return index;
}

/** 让缓存失效（整理跑完 / 排练写盘后调用；不调也只是晚一轮生效，不会读错）。 */
export function invalidateEventIndex(libDir) {
  const dir = String(libDir || '').trim();
  if (dir) CACHE.delete(dir);
  else CACHE.clear();
}
