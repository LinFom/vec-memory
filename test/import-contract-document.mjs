// [by:WorkBuddy] 票 02 端到端：起一个真实 standalone HTTP 服务，跑完
// 「JSONL → 契约 → 确定性计划 → 提交 → recall 命中 / 未核验台账 / 幂等 / 失败重入」。
// 不 mock 服务：票面要求「导入后 recall 能命中」，只有真链路能证明。
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initialize} from '../src/standalone/service.mjs';
import {createStandaloneServer} from '../src/standalone/server.mjs';
import {convertAndValidate, jsonlToContract} from '../interop/importers/jsonl-to-contract.mjs';
import {buildImportPlan, submitImportPlan, ImportSubmitError} from '../tools/import-contract-document.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'interop/examples/legacy-jsonl');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let ctx;
before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-importer-e2e-'));
  const adminToken = initialize(root);
  const {server, close} = createStandaloneServer({root});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const raw = async (method, route, body, token = adminToken) => {
    const res = await fetch(baseURL + route, {
      method,
      headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  };
  await raw('POST', '/api/v1/admin/projects', {projectId: 'importer-project'});
  for (const sid of ['imp-main', 'imp-idem', 'imp-fail']) {
    await raw('POST', '/api/v1/admin/spaces', {spaceId: sid, owner: 'importer-project'});
  }
  ctx = {root, adminToken, baseURL, raw, server, close};
});
after(async () => {
  if (!ctx) return;
  ctx.server.closeAllConnections?.();
  await ctx.close();
  fs.rmSync(ctx.root, {recursive: true, force: true});
});

const build = (spaceId) => {
  const {document, result, mapping, excludedRuntimeFields} = convertAndValidate({dir: EXAMPLES, spaceId});
  assert.equal(result.ok, true, `契约校验应通过：${JSON.stringify(result.errors)}`);
  const plan = buildImportPlan(document);
  assert.equal(plan.ok, true, `计划应生成：${JSON.stringify(plan.errors)}`);
  return {document, result, mapping, excludedRuntimeFields, plan: plan.plan};
};

test('四类来源都有字段映射，且映射目标落在服务允许的分类内', () => {
  const {mapping, result} = build('imp-main');
  assert.equal(mapping.length, 4);
  assert.deepEqual(mapping.map((m) => m.targetKind),
    ['preference', 'speaker_profile', 'event', 'topic']);
  assert.equal(mapping.some((m) => m.fallback), false, '样例里不该有未知 kind 的降级');
  assert.equal(result.summary.unverified, 4);
  assert.equal(result.summary.traced, 4, '每条都要能追到 file:line');
  const allowed = new Set(['preference', 'speaker_profile', 'trait', 'event', 'topic', 'promise', 'joke', 'grudge']);
  for (const m of mapping) assert.ok(allowed.has(m.targetKind), `${m.targetKind} 不在服务可写集合`);
});

test('计划是确定性的、纯离线：两次生成逐字相同，且不含时间戳/随机 ID', () => {
  const a = build('imp-main'), b = build('imp-main');
  assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan));
  assert.match(a.plan.documentHash, /^[a-f0-9]{64}$/);
  for (const step of a.plan.steps) {
    assert.ok(step.route.startsWith(`/api/v1/spaces/imp-main/`));
    if (step.operationId) assert.match(step.operationId, /^import:[a-f0-9]{40}/);
  }
  assert.equal(a.plan.steps.length, 11);
  assert.equal(a.plan.counts.entities, 1);
  assert.equal(a.plan.counts.messages, 2);
  assert.equal(a.plan.counts.memories, 4);
  assert.equal(a.plan.counts.ledger, 4);
  assert.equal(a.plan.unverified, true);
});

test('人格/情绪/向量等运行态字段不会被写进契约', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-importer-runtime-'));
  try {
    fs.copyFileSync(path.join(EXAMPLES, 'messages.jsonl'), path.join(tmp, 'messages.jsonl'));
    fs.writeFileSync(path.join(tmp, 'facts.jsonl'), JSON.stringify({
      id: 'f-x', text: '喜欢不加糖的茶', actorId: 'user-a', kind: 'preference',
      scope: {kind: 'private', id: 'chat-a'}, evidenceIds: ['m-001'],
      persona: '柔和', emotion: '开心', embedding: [0.1, 0.2], confidence: 0.99
    }) + '\n');
    const {document, excludedRuntimeFields} = convertAndValidate({dir: tmp, spaceId: 'imp-main'});
    for (const bad of ['persona', 'emotion', 'embedding', 'confidence']) {
      assert.equal(JSON.stringify(document).includes(`"${bad}"`), false, `${bad} 不得进契约`);
    }
    assert.ok(excludedRuntimeFields.length >= 4, '审计清单要列出被排除的字段');
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test('端到端：提交后 recall 命中，台账全是未核验候选，且台账不复制原文', async () => {
  const {plan, document} = build('imp-main');
  const result = await submitImportPlan(plan, {baseURL: ctx.baseURL, token: ctx.adminToken});
  assert.equal(result.ok, true);
  assert.equal(result.completed.length, plan.steps.length);
  assert.equal(result.unverified, true);
  assert.ok(Object.keys(result.sceneIds).length >= 1, 'ensureScene 必须返回规范化后的 sceneId');

  const scope = {kind: 'private', id: 'chat-a'};
  const recalled = await ctx.raw('POST', '/api/v1/spaces/imp-main/recall',
    {scope, query: '不加糖的茶', actorIds: ['user-a']});
  const texts = (recalled.items || []).map((i) => String(i.text || '')).join('\n');
  assert.match(texts, /不加糖的茶/, `recall 应命中导入的事实，实际 items=${JSON.stringify(recalled.items).slice(0, 400)}`);

  const state = await ctx.raw('POST', '/api/v1/spaces/imp-main/workspace', {action: 'state', scope});
  const entries = Object.values(state.entries || {});
  assert.equal(entries.length, 4, '每条导入条目都应有一条未核验台账');
  for (const e of entries) {
    assert.equal(e.legacy, true, '台账必须带 legacy:true');
    assert.equal(e.status, 'candidate', 'confirm:false ⇒ 只能是候选，不能被当成已确认');
    assert.equal(e.legacyRecord?.unverified, true);
    assert.equal(typeof e.legacyRecord?.origin?.source?.locator, 'string');
    assert.equal(e.text.includes('不加糖的茶'), false, '台账不得复制原话正文');
    assert.match(e.text, /^\[historical-import\]/);
  }
  // 契约里每条 origin.verified 都被 const:false 锁死。
  for (const e of document.entries) assert.equal(e.origin.verified, false);
});

test('导入幂等：重跑同一计划不产生重复条目，memory 走 replayed', async () => {
  const {plan} = build('imp-idem');
  const first = await submitImportPlan(plan, {baseURL: ctx.baseURL, token: ctx.adminToken});
  const scope = {kind: 'private', id: 'chat-a'};
  const before = await ctx.raw('POST', '/api/v1/spaces/imp-idem/workspace', {action: 'state', scope});
  const second = await submitImportPlan(plan, {baseURL: ctx.baseURL, token: ctx.adminToken});
  const after = await ctx.raw('POST', '/api/v1/spaces/imp-idem/workspace', {action: 'state', scope});
  assert.equal(first.completed.length, second.completed.length);
  assert.equal(Object.keys(after.entries || {}).length, Object.keys(before.entries || {}).length,
    '台账条数不得翻倍');
  const replayed = second.completed.filter((c) => c.kind === 'memory' && c.replayed).length;
  assert.equal(replayed, plan.counts.memories, '每条记忆都应由稳定 operationId 命中幂等回放');
});

test('失败可重入：中途断网留下可读错误，重跑同一计划即恢复', async () => {
  const {plan} = build('imp-fail');
  let seen = 0;
  const flaky = async (...args) => {
    seen += 1;
    if (seen === 5) throw new Error('simulated connection reset');
    return fetch(...args);
  };
  await assert.rejects(
    () => submitImportPlan(plan, {baseURL: ctx.baseURL, token: ctx.adminToken, fetchImpl: flaky}),
    (e) => e instanceof ImportSubmitError && e.code === 'IMPORT_NETWORK'
      && e.completed.length === 4, '失败时须带已完成步骤，便于判断从哪续上');
  const retry = await submitImportPlan(plan, {baseURL: ctx.baseURL, token: ctx.adminToken});
  assert.equal(retry.ok, true);
  assert.equal(retry.completed.length, plan.steps.length);
  const state = await ctx.raw('POST', '/api/v1/spaces/imp-fail/workspace',
    {action: 'state', scope: {kind: 'private', id: 'chat-a'}});
  assert.equal(Object.keys(state.entries || {}).length, 4, '重跑后不能留下半导入状态');
});

test('认不出说话人：隔离、不挂人物档案；想挂人物档案直接被契约拒绝', () => {
  const doc = jsonlToContract({dir: EXAMPLES, spaceId: 'imp-main'});
  const {__mapping, __excludedRuntimeFields, ...base} = doc;
  const noActor = structuredClone(base);
  delete noActor.entries[0].actorId;
  const plan = buildImportPlan(noActor);
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.counts.quarantine, 1);
  assert.equal(plan.plan.counts.memories, 3, '隔离条目不得写事实记忆');
  assert.equal(plan.plan.quarantine[0].unattributed, true);
  assert.equal(plan.plan.quarantine[0].usableAsEvidence, false);
  assert.equal(plan.plan.quarantine[0].writtenToMemory, false);

  const wantsPerson = structuredClone(noActor);
  wantsPerson.entries[0].subject = {id: 'ghost', displayName: '幽灵', kind: 'person'};
  const rejected = buildImportPlan(wantsPerson);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((e) => e.code === 'UNATTRIBUTED_PERSON'),
    `应拒绝把未署名的话挂到人物档案：${JSON.stringify(rejected.errors)}`);
});

test('硬边界：转换器零 src/ 依赖、不写生产库指针、四个真值层零改动', () => {
  for (const f of ['tools/import-contract-document.mjs', 'interop/importers/jsonl-to-contract.mjs']) {
    const src = read(f);
    assert.doesNotMatch(src, /from\s+['"][^'"]*src\//, `${f} 不得 import 服务内部模块`);
    assert.doesNotMatch(src, /vector-active\.json/, `${f} 不得写生产库指针`);
  }
  assert.doesNotMatch(read('interop/importers/jsonl-to-contract.mjs'), /globalThis\.fetch|node:http/,
    '源侧转换器必须完全离线');
  const diff = spawnSync('git', ['diff', '--name-only', 'c06e8fe', '--',
    'src/core/factstore.mjs', 'src/core/vecstore.mjs', 'src/core/vector-generation.mjs', 'src/core/embed.mjs'],
    {cwd: ROOT, encoding: 'utf8'});
  assert.equal(diff.status, 0);
  assert.equal(diff.stdout.trim(), '', '四个真值层文件必须零改动');
});
