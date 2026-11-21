import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime, disposeMemoryVec, mergeEntities, unmergeEntity, factStoreOf, runIndex } from '../src/core/backend.mjs';
import { readHitLog } from '../src/core/consolidate.mjs';
import { relatedLabels } from '../src/core/lineage.mjs';
import { encodingIdentity, openActiveVectors } from '../src/core/vector-generation.mjs';
import { embedTexts } from '../src/core/embed.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-hardening-'));
const config = { embedBaseURL: '', embedModel: '', autoIndexEnabled: false, consolidateEnabled: false };
const router = createRouter({ dataRoot: root, settings: { getSkillConfig: (_, defaults) => ({ ...defaults, ...config }) } });
const rt = await getRuntime();
for (let i = 0; !rt.lastIdentityCheck && i < 200; i++) await new Promise(r => setTimeout(r, 10));
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch; disposeMemoryVec();
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('vmm-hardening-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const call = (route, body) => router.handle({ path: route, method: body ? 'POST' : 'GET', body });
const A = '10000111', B = '10000222', CHAT = 'group:10000999';
rt.normalizer.setVocabulary([{ id: `qq:${A}`, kind: 'person', surface: ['Alpha'] },
  { id: `qq:${B}`, kind: 'person', surface: ['Beta'] }, { id: CHAT, kind: 'group', surface: ['Test'] }]);
const inject = extra => call('/inject', { chatKey: CHAT, people: [{ id: A }], rehearsal: 'deferred', ...extra });

test('identity closure handles multi-hop and isolates cycles', () => {
  assert.deepEqual([...relatedLabels({ x: { to: 'y' }, y: { to: 'z' } }, ['z'])].sort(), ['x', 'y', 'z']);
  assert.deepEqual([...relatedLabels({ x: { to: 'y' }, y: { to: 'x' } }, ['x'])], ['x']);
});

test('merge and undo preserve facts, scope isolation and visible profile conflicts', async () => {
  for (const [userId, text] of [[A, 'engineer'], [B, 'artist']]) {
    assert.equal((await call('/remember', { chatKey: CHAT, userId, kind: 'trait', attr: '职业', text })).status, 200);
  }
  await call('/remember', { chatKey: `private:${B}`, userId: B, kind: 'trait', attr: '所在地', text: 'secret place' });
  const before = fs.readFileSync(factStoreOf(rt).slotsFile, 'utf8');
  assert.equal((await mergeEntities(rt, `qq:${B}`, `qq:${A}`)).ok, true);
  const person = await call(`/person?who=${A}`);
  assert.equal(person.body.totalSlots, 3, JSON.stringify(person.body));
  const r = await inject({ profileCrossScope: false });
  assert.match(r.body.block, /engineer/); assert.match(r.body.block, /artist/); assert.match(r.body.block, /分歧/);
  assert.doesNotMatch(r.body.block, /secret place/);
  assert.equal(fs.readFileSync(factStoreOf(rt).slotsFile, 'utf8'), before);
  assert.equal((await unmergeEntity(rt, `qq:${B}`)).ok, true);
  assert.equal((await call(`/person?who=${A}`)).body.totalSlots, 1);
  assert.equal((await call(`/person?who=${B}`)).body.totalSlots, 2);
});

test('only adopted receipt counts rehearsal; dry, lost and duplicate acknowledgements do not', async () => {
  const dir = path.join(rt.dir, 'consolidate'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ id: 'e1', chatKey: CHAT, title: 'camping', summary: 'camping plan', toTs: Date.now(), createdAt: new Date().toISOString() }) + '\n');
  assert.equal((await inject({ dry: true })).body.receipt, null);
  const generated = await inject({});
  assert.ok(generated.body.receipt, JSON.stringify(generated.body));
  assert.equal(readHitLog({ libDir: rt.dir }).counts.size, 0);
  assert.equal((await call('/inject/ack', { receipt: generated.body.receipt, chatKey: 'group:wrong' })).status, 400);
  const ack = await call('/inject/ack', { receipt: generated.body.receipt, chatKey: CHAT });
  assert.equal(ack.body.accepted, true);
  assert.equal((await call('/inject/ack', { receipt: generated.body.receipt, chatKey: CHAT })).body.accepted, false);
  const second = await inject({});
  await call('/inject/ack', { receipt: second.body.receipt, chatKey: CHAT });
  assert.equal(readHitLog({ libDir: rt.dir }).counts.get('e1').n, 1);
});

test('whole injection embedding budget cancels a slow endpoint and preserves local sections', async () => {
  await call('/remember', { chatKey: CHAT, userId: A, kind: 'preference', text: 'camping trips' });
  Object.assign(config, { embedBaseURL: 'http://synthetic.invalid', embedModel: 'A' });
  let requests = 0, aborted = 0;
  globalThis.fetch = async (_, init) => { requests++; return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true });
  }); };
  // Keep the test alive while AbortSignal.timeout (an unref timer) runs.
  const keepAlive = setInterval(() => {}, 50);
  const start = Date.now();
  let r; try { r = await inject({ topic: 'camping' }); } finally { clearInterval(keepAlive); }
  assert.equal(r.status, 200); assert.ok(Date.now() - start < 2400);
  assert.equal(requests, 1); assert.equal(aborted, 1);
  assert.equal(r.body.simMetric, 'token-overlap');
  assert.ok(r.body.profileLines.length); assert.equal(r.body.events.applied, true);
});

test('caller cancellation terminates embedding retry backoff', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('offline'); };
  const start = Date.now();
  await assert.rejects(embedTexts(['x'], { baseURL: 'http://synthetic.invalid', model: 'A', retries: 3, signal: AbortSignal.timeout(30) }));
  assert.equal(requests, 1); assert.ok(Date.now() - start < 300);
});

test('delivery replay after a newer edit and reopen never restores the old fact', async () => {
  const body = { chatKey: CHAT, userId: A, kind: 'trait', attr: '职业', text: 'first job', deliveryId: 'delivery-first' };
  assert.equal((await call('/remember', body)).status, 200);
  // A new delivery of the same content is a durable noop receipt as well.
  const noop = { ...body, deliveryId: 'delivery-noop' };
  assert.equal((await call('/remember', noop)).body.action, 'noop');
  await call('/remember', { ...body, deliveryId: 'delivery-second', text: 'new job' });
  rt.factStore = null;
  const before = fs.readFileSync(factStoreOf(rt).slotsFile, 'utf8');
  for (const request of [body, noop]) {
    const replay = await call('/remember', request);
    assert.equal(replay.body.replayed, true);
  }
  assert.equal(fs.readFileSync(factStoreOf(rt).slotsFile, 'utf8'), before);
  assert.equal((await call('/remember', { ...body, text: 'collision' })).status, 409);
  const profile = await inject({ profileCrossScope: false });
  assert.match(profile.body.block, /new job/); assert.doesNotMatch(profile.body.block, /first job/);
});

test('model switch rejects vector scores, degrades auto, and refuses to carry event vectors across models', async () => {
  Object.assign(config, { embedBaseURL: 'http://synthetic.invalid', embedModel: 'A' });
  rt.store.put({ id: 'old-event', vector: [1, 0], model: 'A', encoding: encodingIdentity(config), meta: { kind: 'event', text: 'camping old event', sourceHash: 'old', chatKey: CHAT } });
  rt.store.put({ id: 'old-chunk', vector: [0, 1], model: 'A', encoding: encodingIdentity(config), meta: { kind: 'hour', text: 'camping old chunk', sourceHash: 'old2', chatKey: CHAT } });
  // 新代**从语料重建**（2026-10-29 起不再复制旧向量，理由见 vector-generation.mjs 头注释），
  // 所以这里必须有真语料。1 条块即可：够触发重建、也够让安全阀（低于旧库一半就中止）放过。
  const chunksDir = path.join(root, 'memory-v2', 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });
  const chunkId = 'day_group_10000999_2026-01-01';
  fs.writeFileSync(path.join(chunksDir, `${chunkId}.json`), JSON.stringify({
    id: chunkId, chatKey: CHAT, title: '群聊', summary: '今天 camp 了一次 camping，Alpha 也在。'
  }), 'utf8');
  const oldDir = rt.store.dir;
  config.embedModel = 'B';
  let requests = 0, fail = true;
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body); requests++;
    if (fail && requests === 1) return { ok: false, status: 400, text: async () => 'synthetic interruption' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [1, 0] })) }) };
  };
  assert.notEqual((await call('/search', { q: 'camping', mode: 'vector' })).status, 200);
  const auto = await call('/search', { q: 'camping', mode: 'auto' });
  assert.equal(auto.body.mode, 'exact'); assert.ok(auto.body.degraded); assert.equal(requests, 0);
  await assert.rejects(runIndex());
  assert.equal(rt.store.dir, oldDir); assert.equal(openActiveVectors(rt.dir).count, 2);
  fail = false;
  // 🔴 换模型重建时，旧事件向量**不该原样搬过去**：它是 A 的向量，在 B 的编码空间里没有意义。
  //   2026-10-29 主审驳回的上一版正是这里 —— 当时靠"用 settings.embedModel 重贴标签 + 写当前
  //   encoding"把它搬了过去，于是审计只能证明"目标标签 == 目标 index"，属于自证。
  //   现在的契约：来源身份明确不一致（A≠B）⇒ 拒绝搬运、**不切代**、抛错说明原因。
  //   旧代继续服务，事件一条没丢 —— "不能搬"和"不能丢"同时成立。
  await assert.rejects(runIndex(), /来源身份|不兼容|不一致|未切换代/);
  assert.equal(rt.store.dir, oldDir, '搬运被拒时不得切代');
  assert.equal(requests, 2, '失败那一次之后只补没写入的条目，不重跑已完成的');
  const stillOld = openActiveVectors(rt.dir);
  assert.equal(stillOld.count, 2, '旧代原样：事件 + 块都在');
  assert.equal(stillOld.get('old-event').meta.kind, 'event');
  assert.equal(stillOld.get('old-event').meta.model, 'A', '旧事件不得被贴上 B 的标签');
  assert.equal(stillOld.get('old-event').meta.carriedFrom, undefined, '未搬运 ⇒ 不该有搬运标记');
});


test('missing active generation is reported instead of opening an empty library', () => {
  const dir = path.join(root, 'broken-pointer'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'vector-active.json'), JSON.stringify({ generation: 'a'.repeat(32) }));
  assert.throws(() => openActiveVectors(dir), /incomplete/);
});
