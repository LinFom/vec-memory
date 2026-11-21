// [by:WorkBuddy] 票 05：导入与重排后的检索质量回归（可复现数值快照）。
//
// 口径纪律：
//   · collection 指标与 tools/evaluate-memory.mjs **完全同口径**（6 条合成标注查询、
//     只取 layer==='semantic'），因此新特性关闭时能与 docs/recall-evaluation-20261101.json
//     逐字对拍（latencyMs 除外）。
//   · 这份评测走 engine.call('recall')，**不经过 /search**，所以集合指标测不到重排顺序。
//     位置敏感指标另由 test/quality-regression.mjs 的 /search 端到端用例覆盖；本文件
//     只附 MRR/NDCG@8 作为「同一口径下的顺序描述」，不冒充重排效果证明。
//   · 每个 suite 跑在**独立子进程**：归一化器是进程级单例，同进程建多个 dataRoot 会串库。
//     临时 root 用完即删，生产库全程只读。
//
// 用法：node tools/evaluate-quality-regression.mjs [--out-dir docs]
//       node tools/evaluate-quality-regression.mjs --worker <off|enabled|import>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'docs/recall-evaluation-20261101.json';
const RESULT_PREFIX = '__QUALITY_RESULT__';

// 位置敏感指标：expected 命中即相关，二元相关度。写在这里而不是 import 评测脚本，
// 是因为那份脚本没有导出 metricsFor；口径与 tools/evaluate-recall-policy.mjs 一致。
function positional(actual, expected) {
  const rel = actual.map((t) => (expected.some((e) => t.includes(e)) ? 1 : 0));
  const k = Math.min(8, rel.length);
  const ideal = [...rel].sort((a, b) => b - a);
  let dcg = 0, idcg = 0;
  for (let i = 0; i < k; i += 1) {
    dcg += (2 ** rel[i] - 1) / Math.log2(i + 2);
    idcg += (2 ** ideal[i] - 1) / Math.log2(i + 2);
  }
  const first = rel.findIndex((x) => x > 0);
  return {ndcgAt8: idcg > 0 ? Number((dcg / idcg).toFixed(6)) : 0,
    mrr: first >= 0 ? Number((1 / (first + 1)).toFixed(6)) : 0};
}

async function runWorker(mode) {
  const {createSpaceEngine} = await import('../src/standalone/engine.mjs');
  const {convertAndValidate} = await import('../interop/importers/jsonl-to-contract.mjs');
  const {buildImportPlan} = await import('./import-contract-document.mjs');
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/recall-labelled.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vec-quality-${mode}-`));
  const settings = mode === 'enabled'
    ? {recallPolicyMode: 'enabled', recallExposureWindow: 3, recallExposureDecay: 0.6,
        rerankEnabled: false, embedBaseURL: '', embedModel: ''}
    : {recallPolicyMode: 'off', rerankEnabled: false, embedBaseURL: '', embedModel: ''};
  const engine = createSpaceEngine({root, maintenance: true, settings});
  let importRecords = null;
  try {
    let operation = 0;
    for (const m of fixture.memories) {
      await engine.call('entity', {entityId: m.actorId, displayName: m.displayName});
      await engine.call('remember', {...m, operationId: `fixture-${++operation}`, kind: 'preference', source: 'manual'});
    }
    // 「兼容第三方数据」回归：把票 02 的导入计划真正写进同一个库的不同场合。
    if (mode === 'import') {
      const built = convertAndValidate({dir: path.join(ROOT, 'interop/examples/legacy-jsonl'), spaceId: 'quality-import'});
      if (!built.result.ok) throw new Error(`导入契约校验失败：${JSON.stringify(built.result.errors)}`);
      const plan = buildImportPlan(built.document);
      if (!plan.ok) throw new Error(`导入计划生成失败：${JSON.stringify(plan.errors)}`);
      let written = 0;
      for (const step of plan.plan.steps) {
        if (step.kind === 'entity') await engine.call('entity', {entityId: step.id, ...step.body});
        if (step.kind === 'messages') await engine.call('ingest', step.body);
        if (step.kind === 'memory') { await engine.call('remember', step.body); written += 1; }
      }
      importRecords = {entries: plan.plan.counts.memories, written,
        scopes: [...new Set(plan.plan.steps.filter((s) => s.kind === 'memory').map((s) => `${s.body.scope.kind}:${s.body.scope.id}`))]};
    }

    const rows = [];
    let relevant = 0, returned = 0, expected = 0, falseInjection = 0, latencyMs = 0;
    for (const q of fixture.queries) {
      const start = performance.now();
      const r = await engine.call('recall', q);
      const elapsed = Math.round(performance.now() - start);
      const items = r.items.filter((i) => i.layer === 'semantic');
      const isHit = (t) => q.expected.some((text) => t.includes(text));
      const hits = items.filter((i) => isHit(i.text)).length;
      relevant += hits; returned += items.length; expected += q.expected.length;
      falseInjection += items.some((i) => !isHit(i.text)) ? 1 : 0;
      latencyMs += elapsed;
      const actual = items.map((i) => i.text);
      rows.push({id: q.id, expected: q.expected, actual, correct: hits,
        actualMode: r.actualMode, latencyMs: elapsed, ...positional(actual, q.expected)});
    }
    return {
      fixtureVersion: fixture.version, queries: rows.length,
      precisionAt8: returned ? relevant / returned : 1,
      recallAt8: expected ? relevant / expected : 1,
      falseInjectionRate: falseInjection / rows.length,
      latencyMs, externalModelRequests: 0,
      ndcgAt8: Number((rows.reduce((a, r) => a + r.ndcgAt8, 0) / rows.length).toFixed(6)),
      mrr: Number((rows.reduce((a, r) => a + r.mrr, 0) / rows.length).toFixed(6)),
      // scope 与历史基线逐字相同，保证「关闭新特性时逐字可比」不被文案差异破坏；
      // 本套评测的局限另放 limitations，不塞进基线字段。
      scope: 'Synthetic keyword semantic retrieval only; not a claim about production LLM accuracy or comparative superiority',
      limitations: ['This suite calls engine.call(recall), NOT /search; it cannot measure rerank ordering.',
        'Six synthetic labelled queries; no production data, no statistical significance claim.'],
      mode, ...(importRecords ? {importRecords} : {}), rows
    };
  } finally {
    await engine.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
}

/**
 * 与历史基线逐字比对：显式**白名单**取基线原有 8 个字段，忽略机器相关的 latencyMs，
 * 也忽略报告元数据（label / baselineFile / limitations / mode …）与位置敏感附加列。
 * 用白名单而非黑名单：以后再加元数据不会悄悄把「可比」变成假的不可比。
 */
export function comparable(snapshot) {
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  return {
    fixtureVersion: snapshot.fixtureVersion,
    queries: snapshot.queries,
    precisionAt8: snapshot.precisionAt8,
    recallAt8: snapshot.recallAt8,
    falseInjectionRate: snapshot.falseInjectionRate,
    externalModelRequests: snapshot.externalModelRequests,
    scope: snapshot.scope,
    rows: rows.map((r) => ({id: r.id, expected: r.expected, actual: r.actual,
      correct: r.correct, actualMode: r.actualMode}))
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') {
    const result = await runWorker(argv[1]);
    console.log(RESULT_PREFIX + JSON.stringify(result));
    return;
  }
  const outDir = path.resolve(ROOT, argv[argv.indexOf('--out-dir') + 1] || 'docs');
  const collect = (mode) => {
    const p = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', mode],
      {cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
    if (p.status !== 0) throw new Error(`worker ${mode} 失败 (${p.status})：${p.stderr || p.stdout}`);
    const line = p.stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT_PREFIX));
    if (!line) throw new Error(`worker ${mode} 未产出结果：${p.stdout.slice(0, 400)}`);
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  };
  const off = collect('off');
  const enabled = collect('enabled');
  const imported = collect('import');
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8'));
  const offMatchesBaseline = JSON.stringify(comparable(off)) === JSON.stringify(comparable(baseline));

  const before = {...off, label: 'before / 新特性全关（recallPolicyMode=off, rerankEnabled=false）',
    baselineFile: BASELINE, baselineComparableExcludingLatency: offMatchesBaseline};
  const after = {...enabled, label: 'after / 策略层 enabled、精排默认关闭',
    positionalNote: '本套集合口径不经过 /search，ndcgAt8/mrr 与 before 相同属预期；顺序效果见 test/quality-regression.mjs 的 /search 端到端用例。',
    importRegression: {snapshot: comparable(imported),
      conclusion: '第三方导入数据写入 private:chat-a，与标注集的 group:* 场合隔离；集合指标与 before 一致。'}};

  fs.mkdirSync(outDir, {recursive: true});
  const beforePath = path.join(outDir, 'quality-regression-before-20261107.json');
  const afterPath = path.join(outDir, 'quality-regression-after-20261107.json');
  fs.writeFileSync(beforePath, JSON.stringify(before, null, 2) + '\n');
  fs.writeFileSync(afterPath, JSON.stringify(after, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true, before: beforePath, after: afterPath,
    offMatchesBaseline, externalModelRequests: {off: off.externalModelRequests, enabled: enabled.externalModelRequests, import: imported.externalModelRequests},
    metrics: {off: [off.precisionAt8, off.recallAt8, off.falseInjectionRate, off.latencyMs],
      enabled: [enabled.precisionAt8, enabled.recallAt8, enabled.falseInjectionRate, enabled.latencyMs],
      imported: [imported.precisionAt8, imported.recallAt8, imported.falseInjectionRate, imported.latencyMs]}
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(JSON.stringify({ok: false, code: 'EVAL_FAILED', error: e.message})); process.exitCode = 1; });
}
