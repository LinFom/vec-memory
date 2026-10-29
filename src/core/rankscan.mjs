// 六维扫描 + 逐维分布（M1 的**仪表**）。
//
// ── 这个文件为什么先于算法落地 ────────────────────────────────────────────
// `plugin/00-构思.md` §7 把「只读观测」提到 M0 而不是 M3，理由只有一句：
// **selftest 全绿 和 165 条事实同分 可以同时成立** —— 人造数据天生没有分布问题。
// 所以打分函数写完，第一件事不是"接进排序"，是**把分布摊开看**。
//
// 本文件做三件事：
//   ① 从全量块算跨块原料（实体倒排 → 通路数 / 重逢数）
//   ② 逐维出 n / 档数 / 极差 / top档 / 覆盖率，并判 dead
//   ③ 把这一次的分布快照落进影子账本（跑 3~7 天看它变不变）
//
// 判据（照 `规格/rubrics.md` §0.3，不自行放宽）：
//   **档数 ≥ 3 且 极差 > 0.01** 才允许该维进 `scoreOf`。
//   两头都是刻意卡的：档数少 = 分不出高低；极差小 = 名次由浮点噪声决定。
import fs from 'node:fs';
import path from 'node:path';

import {
  RANK_VERSION, DIM_ORDER, DIM_LABEL, DIM_SOURCE,
  dims, scoreOfChunk, chunkParts, significance, clamp
} from './rank.mjs';
import { distribution, judge, summarize } from './stats.mjs';

/** 占位符形态。不写死前缀 —— 前缀是词表的事，扫描器只认"被括号包起来的那一段"。 */
const PLACEHOLDER_RE = /〔([^〔〕]{1,24})〕/g;

/**
 * 抠出"实体键"。有归一化器就用占位符（与索引侧同一套口径）；
 * 没有就用关键词兜底（离线测试用，不参与任何出境）。
 *
 * 为什么要有兜底：本文件必须能在**不加载归一化器**的情况下跑起来，
 * 否则测试就得先造密钥、造映射表 —— 那会让"仪表"比被测对象还难启动。
 * 兜底口径只在本机算，且两处口径**不混用**（同一次扫描只走一条路）。
 */
export function entityKeysOf(chunk, normalizer = null) {
  if (normalizer && typeof normalizer.normalize === 'function') {
    const text = [
      Array.isArray(chunk?.keywords) ? chunk.keywords.join(' ') : '',
      String(chunk?.summary || chunk?.title || '')
    ].filter(Boolean).join('\n');
    let out;
    try {
      out = normalizer.normalize(text, { context: `rank:${chunk?.id || ''}`, register: false }).text;
    } catch {
      return [];
    }
    const keys = new Set();
    for (const m of out.matchAll(PLACEHOLDER_RE)) keys.add(m[1]);
    return [...keys];
  }
  // 兜底：纯数字（≥5 位）当 QQ；出现在 snippets.who 里的 2~6 字 CJK 当人名。
  const keys = new Set();
  const who = new Set();
  for (const s of Array.isArray(chunk?.snippets) ? chunk.snippets : []) {
    const k = String(s?.who ?? '').trim();
    if (k) who.add(k);
  }
  for (const raw of Array.isArray(chunk?.keywords) ? chunk.keywords : []) {
    const k = String(raw ?? '').trim();
    if (!k) continue;
    if (/^\d{5,15}$/.test(k)) { keys.add(`qq:${k}`); continue; }
    if (/^[\u4e00-\u9fa5]{2,6}$/.test(k) && who.has(k)) keys.add(`name:${k}`);
  }
  return [...keys];
}

/**
 * 跑一遍全量：算跨块原料 + 逐块六维。
 *
 * @param {object[]} chunks  核心小时块（原始字段即可）
 * @param {{normalizer?:object, now?:number, baseDays?:number}} [opts]
 * @returns {{rows:object[], inv:{entities:number, pairs:number}, at:number}}
 */
export function scanCorpus(chunks, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const baseDays = Number(opts.baseDays) || 30;
  const normalizer = opts.normalizer || null;
  const list = Array.isArray(chunks) ? chunks : [];

  // ── 第一趟：实体倒排 ─────────────────────────────────────────────────
  const keysOf = [];
  /** @type {Map<string, Set<string>>} 实体 → 出现在哪些会话 */
  const entChats = new Map();
  /** @type {Map<string, number>} 实体 → 出现在几个块里（重逢的原料） */
  const entChunks = new Map();
  for (const c of list) {
    const keys = entityKeysOf(c, normalizer);
    keysOf.push(keys);
    for (const k of keys) {
      let s = entChats.get(k);
      if (!s) entChats.set(k, (s = new Set()));
      s.add(String(c?.chatKey || c?.id || '?'));
      entChunks.set(k, (entChunks.get(k) || 0) + 1);
    }
  }

  // ── 第二趟：逐块派生 + 六维 ──────────────────────────────────────────
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const keys = keysOf[i];
    let entitySessions = 0;
    let entityRecur = 0;
    if (keys.length) {
      const sessions = new Set();
      for (const k of keys) {
        const s = entChats.get(k);
        if (s) for (const v of s) sessions.add(v);
        // 重逢 = 同一实体在**别的**块里再出现。自身这一块不计。
        entityRecur += Math.max(0, (entChunks.get(k) || 1) - 1);
      }
      entitySessions = sessions.size;
    }
    const derived = { entityKeys: keys, entitySessions, entityRecur };
    const d = dims(c, derived);
    rows.push({
      id: String(c?.id || ''),
      chatKey: String(c?.chatKey || ''),
      when: Number(c?.when) || 0,
      d,
      sig: significance(c, d.parts),
      score: scoreOfChunk(c, d, now, baseDays, false),
      scoreW: scoreOfChunk(c, d, now, baseDays, true)
    });
  }
  return { rows, inv: { entities: entChats.size, pairs: list.length }, at: now };
}

/** 从一批行里取某一维的原始值（null 单独计数，**不当 0**）。 */
function collect(rows, pick) {
  const values = [];
  let missing = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || v === undefined || !Number.isFinite(Number(v))) { missing++; continue; }
    values.push(Number(v));
  }
  return { values, missing };
}

/**
 * 每一维的**主原料**。诊断用：一个维度"死"了，要先分清是
 *   ① 原料本身就是常数（这一层根本没有可判的东西），还是
 *   ② 原料有分布、只是判据的阈值把它压平了（判据要重扫）。
 * 这两种病改法完全不同，混在一起会去改错的代码。
 */
const RAW_OF = {
  S: { key: 'importanceFromText 档', pick: (p) => p.sRaw },
  D: { key: '块内保真度 samples/msgCount', pick: (p) => p.coverage },
  E: null,
  R: { key: '实体辐射会话数', pick: (p) => p.entitySessions },
  I: { key: '实体重逢次数', pick: (p) => p.entityRecur },
  C: { key: '实体重逢次数', pick: (p) => p.entityRecur }
};

/** 一条分布结论：形状 + 判据 + dead + 覆盖率 + **饱和诊断**。 */
function judgeOne(values, missing, rows, opts, raw = null) {
  const n = values.length;
  const total = rows.length || 1;
  const dist = distribution(values, { topK: opts.topK });
  const jd = judge(dist, { minTiers: opts.minTiers, minRange: opts.minRange, topK: opts.topK });
  // dead = 这一维实际上是个常数（装了等于没装）。与"判据不达标"是两件事：
  // 档数 2、极差 0.4 的维度不是 dead，只是还没达到"可进排序"的门槛。
  const dead = n > 0 && (dist.tiers <= 1 || dist.range <= 0);
  // atMaxShare：有多少比例打到本维最高分。**饱和**是最隐蔽的一种"没分辨力" ——
  // 档数看着不止 1 个（有长尾），判据也可能通过，但头部全平：
  // 而注入用的永远只有 top-K。实测 R 维 88.1% 打满、C 维 98.3% 打满，都是这么来的。
  const atMax = dist.max === null ? 0 : values.filter((v) => Math.abs(v - dist.max) < 1e-9).length;
  const atMaxShare = n ? Number((atMax / n).toFixed(4)) : 0;

  // 原料诊断
  let baseline = null;
  let deadReason = null;
  if (raw) {
    const rawVals = rows.map((r) => raw.pick(r.d.parts)).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
    const cnt = new Map();
    for (const v of rawVals) { const k = Number(v).toFixed(4); cnt.set(k, (cnt.get(k) || 0) + 1); }
    const sortedRaw = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    baseline = {
      key: raw.key,
      n: rawVals.length,
      distinct: cnt.size,
      mode: sortedRaw[0]?.[0] ?? null,
      modeShare: rawVals.length ? Number((sortedRaw[0][1] / rawVals.length).toFixed(4)) : 0
    };
    if (dead) {
      deadReason = baseline.distinct <= 1
        ? `原料本身是常数（${baseline.key} 恒为 ${baseline.mode}）⇒ **这一层没有可判的原料**，不是阈值问题`
        : `原料有 ${baseline.distinct} 种取值，却全被映射到同一档 ⇒ **判据的阈值需要重扫**（不是没原料）`;
    }
  }
  if (!dead && atMaxShare >= 0.4) {
    deadReason = `⚠️ ${(atMaxShare * 100).toFixed(1)}% 打到本维最高分 ${dist.max}（饱和）—— ` +
      `归一化的"满分点"可能定得太低；头部全平时，注入的 top-K 等于随手挑`;
  }

  return {
    n,
    missing,
    coverage: Number((n / total).toFixed(4)),
    tiers: dist.tiers,
    range: Number(dist.range.toFixed(6)),
    min: dist.min === null ? null : Number(dist.min.toFixed(6)),
    max: dist.max === null ? null : Number(dist.max.toFixed(6)),
    mean: dist.mean === null ? null : Number(dist.mean.toFixed(6)),
    p50: dist.p50 === null ? null : Number(dist.p50.toFixed(6)),
    topTiers: dist.topTiers,
    maxTie: dist.maxTie,
    topMaxTie: dist.topMaxTie,
    atMaxShare,
    dead,
    deadReason,
    baseline,
    ok: n === 0 ? null : jd.ok,        // null = 没有样本，**不算通过**
    checks: jd.checks,
    summary: summarize(dist)
  };
}

/**
 * 逐维分布 —— M1 的核心产出。
 *
 * @param {ReturnType<typeof scanCorpus>} scan
 * @param {{topK?:number, minTiers?:number, minRange?:number}} [opts]
 */
export function rankDistribution(scan, opts = {}) {
  const o = { topK: 5, minTiers: 3, minRange: 0.01, ...opts };
  const rows = scan.rows || [];
  const dimsOut = {};
  for (const dim of DIM_ORDER) {
    const { values, missing } = collect(rows, (r) => r.d[dim]);
    dimsOut[dim] = {
      label: DIM_LABEL[dim],
      source: DIM_SOURCE[dim],
      src: missing === rows.length ? 'missing' : 'derived',
      ...judgeOne(values, missing, rows, o, RAW_OF[dim])
    };
  }
  // 两个 scoreOf 口径 + 块的显著性 —— 它们不是"六维"，但同样需要先看分布。
  const pick = (fn) => { const c = collect(rows, fn); return judgeOne(c.values, c.missing, rows, o); };
  const extras = {
    significance: { label: '块的显著性 wMax/3', ...pick((r) => r.sig) },
    scoreOf: { label: '排序分 scoreOf（内核口径 w0=1）', ...pick((r) => r.score) },
    scoreOfWeighted: { label: '排序分 scoreOf（w0=显著性）', ...pick((r) => r.scoreW) }
  };
  return {
    version: RANK_VERSION,
    at: scan.at,
    n: rows.length,
    inv: scan.inv,
    dims: dimsOut,
    extras,
    // 一句话结论：哪些维能进 scoreOf、哪些是死的、哪些根本没有原料。
    verdict: verdictOf(dimsOut, extras)
  };
}

function verdictOf(dimsOut, extras) {
  const canEnter = [];
  const dead = [];
  const saturated = [];
  const noSource = [];
  for (const [k, v] of Object.entries(dimsOut)) {
    if (v.src === 'missing' && v.n === 0) { noSource.push(`${k}（${v.label}）`); continue; }
    if (v.dead) { dead.push(`${k}（${v.label}）`); continue; }
    if (v.atMaxShare >= 0.4) { saturated.push(`${k}（${v.label}，${(v.atMaxShare * 100).toFixed(1)}% 打满）`); }
    if (v.ok) canEnter.push(`${k}（${v.label}）`);
  }
  const parts = [];
  if (noSource.length) parts.push(`**没有判定源的**：${noSource.join('、')} —— 明确记为「不做」，不是 0`);
  if (dead.length) parts.push(`**是常数的（dead）**：${dead.join('、')} —— 装了等于没装，别接进排序`);
  if (saturated.length) parts.push(`**头部饱和的**：${saturated.join('、')} —— 有长尾但头部全平，top-K 等于随手挑`);
  parts.push(canEnter.length
    ? `**够格进 scoreOf 的**：${canEnter.join('、')}`
    : '**目前没有任何一维够格进 scoreOf** —— 这正是"先影子跑"要拦下的事');
  for (const [k, v] of Object.entries(extras)) {
    parts.push(`${v.label}：档数 ${v.tiers}，极差 ${v.range}，top档 ${v.topTiers}` +
      `${v.ok ? '（过）' : '（不达标）'}${v.deadReason ? ' —— ' + v.deadReason : ''}`);
  }
  return parts;
}

// ── 影子账本 ─────────────────────────────────────────────────────────────
/**
 * 把这一次的分布快照追进影子账本。
 *
 * **只记分布形状、不记逐条分数。** 理由：六维是**确定性规则**，
 * 同一份块任何时候算出来都一样，逐条存下来只是复制数据；真正会随时间变的
 * 是"分布长什么样"（块在长、词表在长、群在解散）。攒的是这个。
 *
 * 一行一次运行，`data/memory-vec/shadow/rank-<YYYY-MM-DD>.jsonl`。
 */
export function appendShadowSnapshot(dist, shadowDir) {
  if (!shadowDir) return null;
  const day = new Date(dist.at || Date.now()).toISOString().slice(0, 10);
  const file = path.join(shadowDir, `rank-${day}.jsonl`);
  const line = JSON.stringify({
    at: dist.at,
    version: dist.version,
    n: dist.n,
    inv: dist.inv,
    dims: Object.fromEntries(Object.entries(dist.dims).map(([k, v]) => [k, {
      n: v.n, missing: v.missing, tiers: v.tiers, range: v.range, mean: v.mean,
      atMaxShare: v.atMaxShare, dead: v.dead, ok: v.ok, src: v.src
    }])),
    extras: Object.fromEntries(Object.entries(dist.extras).map(([k, v]) => [k, {
      n: v.n, tiers: v.tiers, range: v.range, atMaxShare: v.atMaxShare, dead: v.dead, ok: v.ok
    }]))
  });
  fs.mkdirSync(shadowDir, { recursive: true });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return file;
}

/** 读回影子账本（面板上要画"这几天分布有没有变"）。 */
export function readShadowSnapshots(shadowDir, limit = 60) {
  if (!shadowDir || !fs.existsSync(shadowDir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(shadowDir).filter((f) => /^rank-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch { return []; }
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(shadowDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 半截行：追加写崩了会留一条，跳过 */ }
    }
  }
  return out.slice(-limit);
}
