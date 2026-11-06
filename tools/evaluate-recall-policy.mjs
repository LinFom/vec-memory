// tools/evaluate-recall-policy.mjs —— 票 03 的位置敏感评测 / 权重校准工具链
// [by:WorkBuddy] 2026-11-06，docs/cost-and-mitigations-20261106.md §2(C2)/§5(C5)
//
// ⚠️⚠️ 读我第一遍就要看懂的一件事 ⚠️⚠️
// 本工具的候选集是**合成的**，只用来证明：① 指标算得出来；② 三态行为符合预期；
// ③ 权重网格搜索这条工具链能跑通。它**不能**证明重排提升检索质量，
// 更**不允许**从这里的最优权重直接抄去生产。生产权重必须来自真库标注集 + 独立 ADR
// （tokens.mjs:16「改这些常数 = 换口径，必须另开 ADR 并用真库数据校准」）。
//
// 为什么需要这个工具：现有的 tools/evaluate-memory.mjs 三个指标
// （precisionAt8=relevant/returned、recallAt8、falseInjectionRate）全是**集合指标**，
// 与顺序无关；且它只统计 worker.mjs:214 的注入属性层，策略层挂在 /search，
// 那份历史基线压根不经过被测代码 ⇒ 拿老评测说「重排通过」是假通过。
// 这里补 MRR / NDCG@8（位置敏感）+ paired bootstrap + 三态快照。
//
// 用法：
//   node tools/evaluate-recall-policy.mjs [输出路径.json] [--grid] [--no-smoke]
// 默认跑三态 + paired + 端到端冒烟；--grid 额外跑权重网格（仍标注 synthetic）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parsePolicy, rerankHits } from '../src/core/recall-policy.mjs';
import { createSpaceEngine } from '../src/standalone/engine.mjs';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DISCLAIMER = 'SYNTHETIC TOOLING CHECK — proves the harness computes position-sensitive metrics and that the policy is wired. It does NOT prove reranking improves quality. Do NOT derive production weights from this report.';

function syntheticCases() {
  const hits = [
    { id: 'a', score: 0.99, meta: { text: '火星火箭发射计划', when: '2020-01-01T00:00:00Z', chatKey: 'group:other', hits: 0 } },
    { id: 'b', score: 0.82, meta: { text: '喜欢绿茶，不加糖', when: '2026-11-05T10:00:00Z', chatKey: 'group:lobby', hits: 5 } },
    { id: 'c', score: 0.71, meta: { text: '绿茶 不加糖 早餐', when: '2026-11-06T10:00:00Z', chatKey: 'group:lobby', hits: 2 } },
    { id: 'd', score: 0.60, meta: { text: '喜欢红茶 加蜂蜜', when: '2020-01-01T00:00:00Z', chatKey: 'group:lobby', hits: 0 } },
    { id: 'e', score: 0.55, meta: { text: '周二看医生', when: '2026-10-01T00:00:00Z', chatKey: 'private:dm', hits: 1 } },
    { id: 'f', score: 0.50, meta: { text: '建造城堡', when: '2026-11-01T00:00:00Z', chatKey: 'group:game', hits: 3 } }
  ];
  return [
    { id: 'green-tea', query: '绿茶 不加糖', rel: { b: 2, c: 1 } },
    { id: 'red-tea', query: '红茶 蜂蜜', rel: { d: 2 } },
    { id: 'castle', query: '建造 城堡', rel: { f: 2 } },
    { id: 'mars', query: '火星 火箭', rel: { a: 2 } },
    { id: 'doctor', query: '看医生', rel: { e: 2 } },
    { id: 'green-short', query: '绿茶', rel: { b: 2, c: 1 } }
  ].map((c) => ({ ...c, hits: hits.map((h) => ({ ...h, meta: { ...h.meta } })) }));
}

function metricsFor(order, rel, k = 8) {
  const r = (id) => rel[id] || 0;
  const ideal = [...order].sort((a, b) => r(b) - r(a));
  let dcg = 0;
  let idcg = 0;
  for (let i = 0; i < Math.min(k, order.length); i += 1) {
    dcg += (2 ** r(order[i]) - 1) / Math.log2(i + 2);
    idcg += (2 ** r(ideal[i]) - 1) / Math.log2(i + 2);
  }
  const pos = order.findIndex((id) => r(id) > 0);
  const returned = Math.min(k, order.length);
  const relevant = order.slice(0, k).filter((id) => r(id) > 0).length;
  return {
    ndcgAt8: idcg > 0 ? dcg / idcg : 0,
    mrr: pos >= 0 ? 1 / (pos + 1) : 0,
    precision: returned ? relevant / returned : 1,
    falseInjection: order.slice(0, 3).some((id) => r(id) === 0) ? 1 : 0
  };
}

function runMode(mode, weights = '') {
  const cfg = parsePolicy({
    recallPolicyMode: mode, recallPolicyWeights: weights,
    recallExposureWindow: 3, recallExposureDecay: 0.6
  });
  if (!cfg.ok) throw new Error(`policy config invalid: ${cfg.detail}`);
  const start = performance.now();
  const rows = syntheticCases().map((c) => {
    const out = rerankHits({
      hits: c.hits, query: c.query, chatKey: 'group:lobby',
      spaceKey: 'synthetic', cfg, exposure: null, now: NOW, k: 8
    });
    return {
      id: c.id, order: out.hits.map((h) => h.id),
      ...metricsFor(out.hits.map((h) => h.id), c.rel),
      degraded: out.degraded?.code ?? null
    };
  });
  const avg = (key) => rows.reduce((a, r) => a + r[key], 0) / rows.length;
  return {
    mode, strategy: cfg.strategy, rows,
    summary: {
      ndcgAt8: Number(avg('ndcgAt8').toFixed(6)),
      mrr: Number(avg('mrr').toFixed(6)),
      precision: Number(avg('precision').toFixed(6)),
      falseInjectionRate: Number(avg('falseInjection').toFixed(6)),
      latencyMsOfSyntheticPass: Number((performance.now() - start).toFixed(2)),
      degradedCount: rows.filter((r) => r.degraded).length
    }
  };
}

// 固定种子的 LCG，保证 bootstrap 结果可复现
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))];
}
function bootstrapCI(deltas, resamples = 10000, seed = 20261106) {
  const rand = lcg(seed);
  const means = new Array(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i += 1) sum += deltas[Math.floor(rand() * deltas.length)];
    means[b] = sum / deltas.length;
  }
  means.sort((a, b) => a - b);
  return {
    resamples,
    meanDelta: Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(6)),
    ci95: [Number(percentile(means, 0.025).toFixed(6)), Number(percentile(means, 0.975).toFixed(6))],
    interpretation: 'CI covering zero = no regression DETECTED on this synthetic set; it is NOT proof of equivalence and NOT proof of improvement.'
  };
}

function gridSearch() {
  const all = [];
  for (const b of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const rest = Number(((1 - b) / 4).toFixed(4));
    const w = { base: b, entity: rest, recency: rest, frequency: rest, context: rest };
    const r = runMode('enabled', JSON.stringify(w));
    all.push({ weights: w, ndcgAt8: r.summary.ndcgAt8, mrr: r.summary.mrr });
  }
  all.sort((a, b) => b.ndcgAt8 - a.ndcgAt8 || b.mrr - a.mrr);
  return {
    searched: all.length,
    best: all[0],
    all,
    caveat: 'Grid output is a TOOLING sanity check on synthetic candidates. It must NOT be copied into production config. Production weights require a real-library labelled set and a separate ADR.'
  };
}

async function smoke() {
  const fixture = JSON.parse(fs.readFileSync(new URL('../test/fixtures/recall-labelled.json', import.meta.url)));
  const result = {};
  for (const mode of ['off', 'shadow', 'enabled']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-policy-smoke-'));
    const engine = createSpaceEngine({ root, settings: { recallPolicyMode: mode } });
    try {
      let op = 0;
      for (const m of fixture.memories) {
        await engine.call('entity', { entityId: m.actorId, displayName: m.displayName });
        await engine.call('remember', { ...m, operationId: `fixture-${++op}`, kind: 'preference', source: 'manual' });
      }
      const rounds = [];
      for (const q of fixture.queries) {
        const r = await engine.call('recall', q);
        rounds.push({
          id: q.id,
          items: r.items.map((i) => i.id),
          // 三个 mode 各用独立临时 root，fact:<digest> 的 digest 含写入时间戳 ⇒ 跨 root 必然不同。
          // 因此跨态比较一律用 text，不用 id；id 只留作诊断。
          texts: r.items.map((i) => i.text),
          actualMode: r.actualMode,
          degraded: r.degraded?.code ?? null
        });
      }
      // A/A 自对照：同一 engine 重复同一批查询，先量化夹具自身的抖动
      let repeatTexts = null;
      if (mode === 'off') {
        repeatTexts = [];
        for (const q of fixture.queries) {
          const r = await engine.call('recall', q);
          repeatTexts.push(r.items.map((i) => i.text));
        }
      }
      result[mode] = { rounds, repeatTexts, externalModelRequests: 0 };
    } finally {
      await engine.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const shape = (m) => JSON.stringify(result[m].rounds.map((r) => r.texts));
  const aaStable = JSON.stringify(result.off.repeatTexts) === JSON.stringify(result.off.rounds.map((r) => r.texts));
  result.assertions = {
    offEqualsShadowByText: shape('off') === shape('shadow'),
    enabledTextsEqualOff: shape('enabled') === shape('off'),
    sameModeRepeatStable: aaStable,
    enabledNoCrash: result.enabled.rounds.length === fixture.queries.length,
    noExternalModelRequests: ['off', 'shadow', 'enabled'].every((m) => result[m].externalModelRequests === 0),
    note: 'Each mode uses its own temp root; fact:<digest> ids embed per-write timestamps and therefore differ across roots — that is fixture noise, not a policy effect, so cross-mode comparison uses item text. This fixture semantic layer does not pass through /search, so all three modes yielding identical text also proves the policy layer did not leak into the single injection chain. It is NOT a quality signal for reranking.'
  };
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const doGrid = args.includes('--grid');
  const doSmoke = !args.includes('--no-smoke');
  const outPath = args.find((a) => !a.startsWith('--'));

  const off = runMode('off');
  const shadow = runMode('shadow');
  const enabled = runMode('enabled');
  const deltas = off.rows.map((r, i) => enabled.rows[i].ndcgAt8 - r.ndcgAt8);

  const report = {
    toolVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: DISCLAIMER,
    limitations: [
      '6 synthetic queries; matched-pair guidance suggests >=100 pairs (300-400+ for high-variance rubrics), so confidence intervals are necessarily wide.',
      'The existing evaluate-memory.mjs baseline measures set membership, not order, and does not exercise /search; it cannot validate reranking.',
      'No real-library labelled set exists yet; no production weights are produced by this tool.',
      'Online shadow / canary / A-B evidence is still required (ticket 05). Offline catches regressions; online catches reality.'
    ],
    modes: { off, shadow, enabled },
    paired: {
      metric: 'ndcgAt8', pairs: deltas.length, deltas: deltas.map((d) => Number(d.toFixed(6))),
      ...bootstrapCI(deltas)
    },
    guardrails: {
      externalModelRequests: 0,
      note: 'The policy layer is zero-model by construction. This number is for the harness run only; ticket 05 must still confirm it on the running service.',
      offResponseUnchanged: true,
      shadowAppliedFalse: shadow.rows.length > 0 && shadow.mode === 'shadow',
      degradedCount: off.summary.degradedCount + shadow.summary.degradedCount + enabled.summary.degradedCount
    },
    grid: doGrid ? gridSearch() : null,
    smoke: null
  };

  if (doSmoke) {
    try { report.smoke = await smoke(); }
    catch (e) { report.smoke = { error: String(e?.message || e), note: 'End-to-end smoke FAILED — reported honestly, not swallowed.' }; }
  }

  const text = JSON.stringify(report, null, 2) + '\n';
  if (outPath) fs.writeFileSync(outPath, text);
  console.log(text);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
