// 分布观测 —— 这个文件是"仪表先于算法"这条纪律的落地。
//
// ── 为什么必须有它 ───────────────────────────────────────────────────────
// 前几轮验证过的结论：`selftest 104/104 全过` 和 `165 条记忆全填同一个值、
// 极差 0.0004` 可以**同时成立** —— 因为自检喂的是人造数据，而人造数据里
// 你总是记得传不同的值。人造数据天生没有分布问题。
//
// 所以能抓住这类病的只有两件事：**反射式契约检查**（接线通不通）和**分布观测**
// （一批数据的形状）。打分函数写完必须立刻看分布，否则你无法判断后面任何改动
// 是变好还是变坏。
//
// ── topTiers 比 tiers 重要 ───────────────────────────────────────────────
// 全局 4 档看着健康，但注入提示词的永远只有 top-K。如果 top-5 里只有 1 档，
// 那"注入前 5 条"仍然等于**随便挑 5 条**。只看全局档数会得出"健康"的错误结论。
//
// ── 判据（来自影子跑方法论）─────────────────────────────────────────────
//   档数 ≥ 3 且 极差 > 0.01   才允许该判定源进入正式排序。
// 两头都是刻意卡的：档数太少 = 分不出高低；极差太小 = 名次靠浮点噪声决定。

/** 把分数按精度去重成"档"。默认保留 4 位小数（排序分通常落在 0~2）。 */
function tierKey(v, precision) {
  const p = Math.pow(10, precision);
  return Math.round(Number(v) * p) / p;
}

/**
 * 计算一批分数的分布形状。
 * @param {number[]} scores
 * @param {{precision?:number, topK?:number}} [opts]
 */
export function distribution(scores, opts = {}) {
  const precision = Number.isInteger(opts.precision) ? opts.precision : 4;
  const topK = Math.max(1, Number(opts.topK) || 5);
  const nums = (Array.isArray(scores) ? scores : []).map(Number).filter((n) => Number.isFinite(n));
  const n = nums.length;
  if (!n) {
    return {
      n: 0, tiers: 0, range: 0, min: null, max: null,
      topTiers: 0, maxTie: 0, topMaxTie: 0, mean: null, p50: null,
      sorted: [], buckets: []
    };
  }
  const sorted = [...nums].sort((a, b) => b - a);
  const max = sorted[0];
  const min = sorted[sorted.length - 1];

  const counts = new Map();
  for (const v of nums) {
    const k = tierKey(v, precision);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = sorted.slice(0, Math.min(topK, n));
  const topCounts = new Map();
  for (const v of top) {
    const k = tierKey(v, precision);
    topCounts.set(k, (topCounts.get(k) || 0) + 1);
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const mid = Math.floor(n / 2);
  const p50 = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // 分档直方图（给面板画条用）：按名次切 8 段
  const segs = Math.min(8, n);
  const buckets = [];
  for (let i = 0; i < segs; i++) {
    const from = Math.floor((i * n) / segs);
    const to = Math.floor(((i + 1) * n) / segs);
    const seg = sorted.slice(from, to);
    buckets.push({
      from: from + 1,
      to,
      count: seg.length,
      max: seg[0] ?? null,
      min: seg[seg.length - 1] ?? null
    });
  }

  return {
    n,
    tiers: counts.size,
    range: max - min,
    min,
    max,
    topTiers: topCounts.size,
    maxTie: Math.max(...counts.values()),
    topMaxTie: Math.max(...topCounts.values()),
    mean: sum / n,
    p50,
    sorted,
    buckets
  };
}

/**
 * 上线判据。返回 ok + 逐条结论，便于面板直接摊开讲。
 * @param {ReturnType<typeof distribution>} dist
 * @param {{minTiers?:number, minRange?:number, topK?:number}} [opts]
 */
export function judge(dist, opts = {}) {
  const minTiers = Number(opts.minTiers) || 3;
  const minRange = Number.isFinite(opts.minRange) ? opts.minRange : 0.01;
  const checks = [
    {
      id: 'tiers',
      label: `档数 ≥ ${minTiers}`,
      pass: dist.tiers >= minTiers,
      actual: dist.tiers,
      hint: '分不出高低时，"塞进提示词的前 5 条"就是碰巧那 5 条'
    },
    {
      id: 'range',
      label: `极差 > ${minRange}`,
      pass: dist.range > minRange,
      actual: Number(dist.range.toFixed(6)),
      hint: '极差太小说明名次由浮点噪声决定，任何一次改动都可能把顺序洗一遍'
    },
    {
      id: 'topTiers',
      label: `top-${Math.max(1, Number(opts.topK) || 5)} 档数 ≥ 2`,
      pass: dist.topTiers >= 2,
      actual: dist.topTiers,
      hint: '注入的只有 top-K；全局健康但 top-K 只有一档 = 等于随机挑'
    }
  ];
  return { ok: checks.every((c) => c.pass), checks };
}

/** 一条可以直接打进日志/面板的短句。 */
export function summarize(dist) {
  if (!dist?.n) return '样本为空 —— 没有样本就谈不上分布';
  return `n=${dist.n} 档数=${dist.tiers} 极差=${dist.range.toFixed(4)} topTiers=${dist.topTiers} 最多并列=${dist.maxTie}`;
}
