// src/core/recall-policy.mjs —— 检索读侧策略层（纯函数 / 默认关闭 / 不写真值）
// [by:WorkBuddy] 2026-11-06，票 03 + docs/cost-and-mitigations-20261106.md §2/§3/§7
//
// 这个文件**只读 hits、只改 hits 顺序**。它不写 meta、不改 sourceHash、
// 不进 encodingIdentity、不碰 factstore/vecstore/vector-generation（有 CI 源码级断言）。
//
// 为什么默认用 RRF 而不是加权和：五个信号量纲不同（余弦 ~[-1,1]，tokens.mjs 的
// 话题重合度 [0,2] 且封顶），直接照抄第三方那组 0.45/0.20/… 做加权和而不先归一化，
// 量纲大的那一路会单独主导，权重形同虚设。RRF 只用名次、不用分数、无超参，
// 天然免疫量纲与分数饱和（Fusion Weight Tuning / Weighted Sum Fusion，见设计文档 §8）。
// 加权和是显式可选策略，且强制先做 min-max 归一化。
//
// 口径守卫：本文件的字面重合度是**独立实现**，不复用 tokens.mjs 的 topicOverlap 常数
// （tokens.mjs:16 明写「改这些常数 = 换口径，必须另开 ADR 并用真库数据校准」）。
// 本文件不改它、不 import 它、也不宣称与它数值等价。
//
// router.mjs:1633 的纪律仍然成立：「三种分数不可比」⇒ 只在同类 hits 内部重排，
// 绝不把事件侧车 / 档案 / 文档候选混进同一个数组。

import { channelKey } from './exposure.mjs';

export const POLICY_MODES = Object.freeze(['off', 'shadow', 'enabled']);
export const SIGNAL_NAMES = Object.freeze(['base', 'entity', 'recency', 'frequency', 'context']);
export const POLICY_SETTINGS_KEYS = Object.freeze([
  'recallPolicyMode', 'recallPolicyWeights', 'recallExposureWindow', 'recallExposureDecay'
]);

const DEFAULTS = Object.freeze({
  mode: 'off',
  strategy: 'rrf',
  weights: null,
  exposureWindow: 3,
  exposureDecay: 0.6
});

const RRF_K = 60; // 标准经验常数；名次融合对它的具体取值不敏感
const RECENCY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 放大召回：只在策略非 off 时多捞候选，重排后一律截回请求 k。
 * store 的硬上限是 200（vecstore.mjs:676/744），这里不越过它。
 * off 时返回原 k ⇒ 与历史基线逐字可比。
 */
export function recallTopN(k, cfg) {
  const base = Math.max(1, Number(k) || 8);
  if (!cfg?.ok || cfg.mode === 'off') return base;
  return Math.max(1, Math.min(200, Math.max(base * 4, 20)));
}

/** 放大召回后截回请求 k。单独导出，好让截断本身能被实跑验证（而不是只做源码断言）。 */
export function trimToK(hits, k) {
  if (!Array.isArray(hits)) return hits;
  const cap = Math.max(1, Math.min(200, Number(k) || 8));
  return hits.length > cap ? hits.slice(0, cap) : hits;
}

function intIn(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function bad(detail) {
  return { ...DEFAULTS, ok: false, reason: 'POLICY_CONFIG_INVALID', detail };
}

/**
 * 解析并严格校验策略配置。任何非法值都**显式**退回 off + 稳定原因码，
 * 绝不「差不多就用」（对齐本项目「静默失败必须定位根因」的纪律）。
 */
export function parsePolicy(settings = {}) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const mode = src.recallPolicyMode === undefined ? DEFAULTS.mode : src.recallPolicyMode;
  if (!POLICY_MODES.includes(mode)) {
    return bad('recallPolicyMode must be one of off|shadow|enabled');
  }

  let strategy = 'rrf';
  let weights = null;
  const raw = src.recallPolicyWeights;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    let parsed;
    try { parsed = JSON.parse(String(raw)); }
    catch { return bad('recallPolicyWeights is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return bad('recallPolicyWeights must be a JSON object');
    }
    const entries = Object.entries(parsed);
    if (!entries.length) return bad('recallPolicyWeights must not be empty');
    if (entries.some(([k]) => !SIGNAL_NAMES.includes(k))) {
      return bad('recallPolicyWeights has unknown signal name');
    }
    const nums = {};
    for (const [k, v] of entries) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return bad(`weight ${k} must be a finite non-negative number`);
      nums[k] = n;
    }
    const sum = Object.values(nums).reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return bad('recallPolicyWeights must contain at least one positive weight');
    weights = Object.fromEntries(SIGNAL_NAMES.map((n) => [n, 0]));
    for (const [k, v] of Object.entries(nums)) weights[k] = v / sum; // 归一化到和为 1
    strategy = 'weighted';
  }

  const exposureWindow = src.recallExposureWindow === undefined
    ? DEFAULTS.exposureWindow : intIn(src.recallExposureWindow, 1, 16, NaN);
  if (!Number.isFinite(exposureWindow)) return bad('recallExposureWindow must be an integer 1..16');

  const decayNum = src.recallExposureDecay === undefined
    ? DEFAULTS.exposureDecay : Number(src.recallExposureDecay);
  if (!Number.isFinite(decayNum) || decayNum < 0.01 || decayNum > 1) {
    return bad('recallExposureDecay must be a number in [0.01, 1]');
  }

  return {
    ok: true,
    mode,
    strategy,
    weights,
    exposureWindow,
    exposureDecay: decayNum,
    reason: null,
    detail: null
  };
}

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 独立的字面重合度，与 tokens.mjs 的 topicOverlap 口径无关（见文件头「口径守卫」）。 */
function literalOverlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return n / Math.max(1, Math.min(A.size, B.size));
}

function viewHit(h, i) {
  const meta = h && typeof h === 'object' && h.meta && typeof h.meta === 'object' ? h.meta : {};
  return {
    index: i,
    id: String((h && h.id) ?? meta.id ?? `idx-${i}`),
    score: Number(h && h.score) || 0,
    text: String(meta.text ?? (h && h.text) ?? meta.title ?? ''),
    when: meta.when ?? (h && h.when) ?? null,
    chatKey: meta.chatKey ?? (h && h.chatKey) ?? null,
    hits: Number(meta.hits ?? (h && h.hits) ?? 0) || 0
  };
}

function recencyOf(when, now) {
  if (when === null || when === undefined || when === '') return 0.5; // 缺信息给中性，不伪造
  const raw = /^\d+$/.test(String(when)) ? Number(when) : Date.parse(String(when));
  if (!Number.isFinite(raw)) return 0.5;
  const age = Math.max(0, now - raw);
  return Math.exp(-age / RECENCY_HALFLIFE_MS);
}

/**
 * 重排同类召回候选。纯函数（除可选的 exposure 查表外无副作用）。
 *
 * @param {object} p
 * @param {Array} p.hits         store.search / searchText 的原始命中（含 meta）
 * @param {string} p.query       已归一化的查询串
 * @param {string|null} p.chatKey
 * @param {string} p.spaceKey    曝光状态的作用域隔离键
 * @param {object} p.cfg         parsePolicy() 的产物
 * @param {object|null} p.exposure createExposureState() 的实例
 * @param {number} p.now
 * @param {number} p.k
 * @returns {{hits:Array, diagnostics:object|null, degraded:object|null, applied:boolean, recordIds:string[]}}
 */
export function rerankHits({
  hits = [], query = '', chatKey = null, spaceKey = 'default', channel = 'search',
  cfg, exposure = null, now = Date.now(), k = 8
} = {}) {
  const conf = cfg || parsePolicy({});
  if (!conf.ok) {
    return {
      hits,
      diagnostics: null,
      degraded: { code: conf.reason, reason: conf.detail },
      applied: false,
      recordIds: []
    };
  }
  if (conf.mode === 'off' || !Array.isArray(hits) || hits.length < 2) {
    return { hits, diagnostics: null, degraded: null, applied: false, recordIds: [] };
  }

  const views = hits.map(viewHit);
  const n = views.length;

  // ① base 先做 min-max 归一化：加权和的前提，否则量纲大的一路单独主导
  const bases = views.map((v) => v.score);
  const lo = Math.min(...bases);
  const hi = Math.max(...bases);
  const span = hi - lo;
  const normBase = bases.map((b) => (span > 0 ? (b - lo) / span : 0.5));

  const signals = {
    base: normBase,
    entity: views.map((v) => literalOverlap(query, v.text)),
    recency: views.map((v) => recencyOf(v.when, now)),
    // 注意：采用次数只是**排序信号**，不是真实性评分（CONTEXT.md:16）
    frequency: views.map((v) => Math.min(1, Math.log1p(Math.max(0, v.hits)) / Math.log(11))),
    context: views.map((v) => (v.chatKey && chatKey
      ? (String(v.chatKey) === String(chatKey) ? 1 : 0.4)
      : 0.5))
  };

  // ② 每个信号独立取名次（RRF 只看序数，天然免疫量纲与分数饱和）
  const ranks = {};
  for (const name of SIGNAL_NAMES) {
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => signals[name][b] - signals[name][a] || a - b);
    const r = new Array(n);
    order.forEach((idx, pos) => { r[idx] = pos + 1; });
    ranks[name] = r;
  }
  const w = conf.strategy === 'weighted'
    ? conf.weights
    : Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 1 / SIGNAL_NAMES.length]));

  const exKey = channelKey(spaceKey, channel, chatKey);
  const scored = views.map((v, i) => {
    const components = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, Number(signals[name][i].toFixed(6))]));
    const fused = conf.strategy === 'weighted'
      ? SIGNAL_NAMES.reduce((acc, name) => acc + w[name] * signals[name][i], 0)
      : SIGNAL_NAMES.reduce((acc, name) => acc + w[name] / (RRF_K + ranks[name][i]), 0);
    const ex = exposure
      ? exposure.lookup(exKey, v.id, now, conf.exposureWindow, conf.exposureDecay)
      : { count: 0, factor: 1 };
    return {
      i, id: v.id, components,
      fused: Number(fused.toFixed(8)),
      exposureCount: ex.count,
      exposureFactor: Number(ex.factor.toFixed(6)),
      final: fused * ex.factor
    };
  });

  const ordered = [...scored].sort((a, b) => b.final - a.final || a.i - b.i); // 平局用原始下标稳定
  const proposedOrder = ordered.map((x) => x.id);
  const originalOrder = views.map((v) => v.id);
  const applied = conf.mode === 'enabled';
  const outHits = applied ? ordered.map((x) => hits[x.i]) : hits;

  const diagnostics = {
    mode: conf.mode,
    strategy: conf.strategy,
    scoreSource: 'hits-only',
    signals: SIGNAL_NAMES,
    weights: conf.strategy === 'weighted' ? w : null,
    rrfK: conf.strategy === 'rrf' ? RRF_K : null,
    exposure: { window: conf.exposureWindow, decay: conf.exposureDecay,
      channel, scope: `${channel}-level; channels are key-isolated` },
    applied,
    originalOrder,
    proposedOrder,
    items: [...scored].sort((a, b) => a.i - b.i).map((x) => ({
      id: x.id,
      originalRank: x.i + 1,
      proposedRank: ordered.findIndex((o) => o.i === x.i) + 1,
      components: x.components,
      fused: x.fused,
      exposureCount: x.exposureCount,
      exposureFactor: x.exposureFactor,
      final: Number(x.final.toFixed(8))
    })),
    degraded: null,
    note: conf.mode === 'shadow'
      ? 'shadow: components computed, hits order deliberately unchanged'
      : 'rank fusion over hits only; events/profile/docs are never mixed into this array'
  };

  return {
    hits: outHits,
    diagnostics,
    degraded: null,
    applied,
    recordIds: applied ? ordered.slice(0, Math.max(1, k)).map((x) => x.id) : []
  };
}

/**
 * 注入级曝光因子工厂（票 03 收尾）。
 *
 * 返回一个 `(lineId) => factor` 纯函数，交给 `inject.mjs:selectInjectLines` 当可选参数。
 * 这样 `inject.mjs` 不 import 策略层、不依赖曝光实现，层次不倒挂；不传该参数时
 * `selectInjectLines` 的排序与返回对象逐字不变。
 *
 * 关键隔离：用 `channel='inject'` 造 key，与 `/search` 的 `'search'` 通道物理分开。
 * 两边 id 空间不同（文档 id vs `who|line`），混用只会「永远查不到」这种静默失败。
 *
 * 三态纪律：off 返回 null（完全不接）；shadow 返回恒 1 但照常统计 `wouldDemote`；
 * enabled 返回真实软降权因子。函数对象自带 `.report()` / `.key` 供响应诊断。
 */
export function makeInjectionExposureFactor({
  exposure, spaceKey = 'default', chatKey = '', cfg, now = Date.now()
} = {}) {
  const conf = cfg || parsePolicy({});
  if (!exposure || !conf.ok || conf.mode === 'off') return null;
  const key = channelKey(spaceKey, 'inject', chatKey);
  const state = { checked: 0, demoted: 0, wouldDemote: 0, mode: conf.mode, channel: 'inject' };
  const factorOf = (lineId) => {
    const ex = exposure.lookup(key, lineId, now, conf.exposureWindow, conf.exposureDecay);
    state.checked += 1;
    if (ex.count > 0) {
      state.demoted += 1;
      if (conf.mode === 'shadow') state.wouldDemote += 1;
    }
    return conf.mode === 'shadow' ? 1 : ex.factor;
  };
  factorOf.report = () => ({ ...state });
  factorOf.key = key;
  factorOf.mode = conf.mode;
  return factorOf;
}
