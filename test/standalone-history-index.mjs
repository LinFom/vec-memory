import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, createService } from '../src/standalone/service.mjs';
import { buildIndex, historyFacts, searchHistory } from '../src/standalone/history-index.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));

function rows(n, textOf = i => `第 ${i} 条消息，提到索引和记忆`) {
  return Array.from({length: n}, (_, i) => JSON.stringify({
    version: 1, seq: i + 1,
    data: {message: {messageId: `m${i + 1}`, conversationId: 'c1', actorId: 'a1', role: i % 2 ? 'assistant' : 'user', timestamp: 1000 + i, text: textOf(i)}}
  })).join('\n') + '\n';
}

function fixture(extra = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vec-history-${extra}`));
  fs.mkdirSync(path.join(root, 'input'), {recursive: true});
  return root;
}

async function waitJob(fetchJob, timeout = 20000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeout) {
    last = await fetchJob();
    if (last && ['completed', 'failed'].includes(last.status)) return last;
    await delay(120);
  }
  throw new Error('job did not settle: ' + JSON.stringify(last));
}

test('索引模块：建索引、报覆盖、按原话检索、原料增长后水位不动', async t => {
  const spaceDir = fixture('module');
  t.after(() => fs.rmSync(spaceDir, {recursive: true, force: true}));
  const src = path.join(spaceDir, 'input', 'messages.jsonl');
  fs.writeFileSync(src, rows(5, i => i === 3 ? '索引还在跑，别催' : `第 ${i} 条普通消息`));

  assert.equal((await historyFacts(spaceDir)).generation, null, '没建过就是没有代');
  assert.deepEqual(await searchHistory({spaceDir, terms: ['索引']}).catch(e => e.code), 'HISTORY_INDEX_MISSING');

  const progress = [];
  const meta = await buildIndex({spaceDir, onProgress: p => progress.push(p)});
  assert.equal(meta.sourceRows, 5);
  assert.equal(meta.indexedRows, 5);
  assert.match(meta.generation, /^[0-9a-f]{32}$/);
  assert.match(meta.sourceHead, /^sha256:[0-9a-f]{64}$/);
  assert.ok(progress.length >= 1, '至少要回一次进度');
  assert.deepEqual(progress.at(-1), {indexedRows: 5, sourceRows: 5});
  assert.ok(fs.existsSync(path.join(spaceDir, 'history-index', 'generations', meta.generation, 'rows.bin')));

  const facts = await historyFacts(spaceDir);
  assert.equal(facts.generation, meta.generation);
  assert.equal(facts.watermark, 5);
  assert.equal(facts.sourceRows, 5);

  const hits = await searchHistory({spaceDir, terms: ['索引']});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, '索引还在跑，别催');
  assert.equal(hits[0].matchMethod, 'history-lexical');
  assert.deepEqual(await searchHistory({spaceDir, terms: ['完全不存在zzz']}), []);

  // 原料追加：sourceRows 要长上去，watermark 必须留在原地 ——
  // 这两条数不相等就是「索引落后于原料」，界面要如实显示。
  fs.appendFileSync(src, rows(1, () => '追加的一条').replace(/^m1/, 'm9'));
  const grown = await historyFacts(spaceDir);
  assert.equal(grown.sourceRows, 6);
  assert.equal(grown.watermark, 5);
  assert.equal(grown.generation, meta.generation, '原料变了但没重建，代还是旧代');

  const rebuilt = await buildIndex({spaceDir});
  assert.equal(rebuilt.sourceRows, 6);
  assert.equal(rebuilt.indexedRows, 6);
  assert.equal((await historyFacts(spaceDir)).watermark, 6);
  assert.notEqual(rebuilt.generation, meta.generation, '原料变了必须换新代');
});

test('索引模块：缺原料时明确报错，空空间报 0 行', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-empty-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'input'), {recursive: true}); // 故意不放 messages.jsonl

  const facts = await historyFacts(root);
  assert.equal(facts.sourceRows, 0);
  assert.equal(facts.watermark, 0);
  assert.equal(facts.generation, null);
  await assert.rejects(() => buildIndex({spaceDir: root}), e => e.code === 'HISTORY_SOURCE_MISSING');
});

test('status：暴露 historyIndex，且重建权限按角色区分', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-status-'));
  const admin = initialize(root);
  const service = createService({
    root,
    engineFactory: () => ({call: async (op) => op === 'status'
      ? {ok: true, messages: 7, historyIndex: {generation: 'g1', watermark: 7, sourceRows: 9, format: 'jsonl', encoding: 'utf-8', sourceHead: 'sha256:x'}}
      : {ok: true}, close: async () => {}})
  });
  t.after(async () => { await service.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const call = (token, route, method = 'GET', body = {}) => service.handle({token, path: '/api/v1/' + route, method, body});

  await call(admin, 'admin/projects', 'POST', {projectId: 'owner'});
  const reader = (await call(admin, 'admin/projects', 'POST', {projectId: 'reader'})).body.token;
  await call(admin, 'admin/spaces', 'POST', {spaceId: 'demo', owner: 'owner'});
  await call(admin, 'admin/spaces/demo/readers', 'PUT', {projectIds: ['reader']});

  const asAdmin = await call(admin, 'spaces/demo/status');
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.body.canRebuildHistoryIndex, true);
  assert.deepEqual(
    {gen: asAdmin.body.historyIndex.generation, wm: asAdmin.body.historyIndex.watermark, src: asAdmin.body.historyIndex.sourceRows},
    {gen: 'g1', wm: 7, src: 9}
  );
  assert.equal(asAdmin.body.historyIndex.building, null);
  assert.equal(asAdmin.body.historyIndex.lastJob, null);

  const asReader = await call(reader, 'spaces/demo/status');
  assert.equal(asReader.status, 200, '只读读者仍可查看索引状态');
  assert.equal(asReader.body.canRebuildHistoryIndex, false, '只读读者不能重建');
});

test('重建任务：进度写进 building，完成后换新代并收掉进度', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-job-'));
  const admin = initialize(root);
  let statusCalls = 0;
  const service = createService({
    root,
    engineFactory: () => ({
      call: async (op, payload, options) => {
        if (op === 'status') return {ok: true, messages: 3, historyIndex: {
          generation: statusCalls++ === 0 ? null : 'gen-new', watermark: statusCalls === 1 ? 0 : 3, sourceRows: 3,
          format: 'jsonl', encoding: 'utf-8', sourceHead: 'sha256:y'}};
        if (op === 'job') {
          assert.equal(payload.type, 'history-lexical');
          options.onProgress?.({indexedRows: 1, sourceRows: 3});
          await delay(60);
          options.onProgress?.({indexedRows: 3, sourceRows: 3});
          return {ok: true, generation: 'gen-new', indexedRows: 3, sourceRows: 3};
        }
        return {ok: true};
      },
      close: async () => {}
    })
  });
  t.after(async () => { await service.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const call = (token, route, method = 'GET', body = {}) => service.handle({token, path: '/api/v1/' + route, method, body});

  await call(admin, 'admin/projects', 'POST', {projectId: 'p'});
  await call(admin, 'admin/spaces', 'POST', {spaceId: 'demo', owner: 'p'});

  const submitted = await call(admin, 'spaces/demo/jobs', 'POST', {type: 'history-lexical', operationId: 'op-1'});
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.job.type, 'history-lexical');
  const jobId = submitted.body.jobId;

  // 任务跑起来的过程中，status 必须能读到 building —— 进度条靠的就是它。
  let sawBuilding = null;
  for (let i = 0; i < 40 && !sawBuilding; i++) {
    const s = await call(admin, 'spaces/demo/status');
    if (s.body.historyIndex.building) sawBuilding = s.body.historyIndex.building;
    await delay(10);
  }
  assert.ok(sawBuilding, '重建过程中 status 应出现 building');
  assert.equal(sawBuilding.sourceRows, 3);
  assert.equal(sawBuilding.jobId, jobId);

  const done = await waitJob(async () => (await call(admin, `spaces/demo/jobs/${jobId}`)).body?.job);
  assert.equal(done.status, 'completed');
  const after = await call(admin, 'spaces/demo/status');
  assert.equal(after.body.historyIndex.generation, 'gen-new');
  assert.equal(after.body.historyIndex.watermark, 3);
  assert.equal(after.body.historyIndex.building, null, '完成后进度必须收掉');
  assert.equal(after.body.historyIndex.lastJob.status, 'completed');
  assert.equal(after.body.historyIndex.lastJob.id, jobId);
});

test('同一个 operationId 重复提交不会产生两个重建任务', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-idem-'));
  const admin = initialize(root);
  let ran = 0;
  const service = createService({
    root,
    engineFactory: () => ({
      call: async (op, payload, options) => {
        if (op === 'status') return {ok: true, messages: 0, historyIndex: {generation: null, watermark: 0, sourceRows: 0}};
        if (op === 'job') { ran++; options.onProgress?.({indexedRows: 0, sourceRows: 0}); return {ok: true}; }
        return {ok: true};
      },
      close: async () => {}
    })
  });
  t.after(async () => { await service.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const call = (token, route, method = 'GET', body = {}) => service.handle({token, path: '/api/v1/' + route, method, body});

  await call(admin, 'admin/projects', 'POST', {projectId: 'p'});
  await call(admin, 'admin/spaces', 'POST', {spaceId: 'demo', owner: 'p'});

  const first = await call(admin, 'spaces/demo/jobs', 'POST', {type: 'history-lexical', operationId: 'same-op'});
  const second = await call(admin, 'spaces/demo/jobs', 'POST', {type: 'history-lexical', operationId: 'same-op'});
  assert.equal(first.body.jobId, second.body.jobId, '同一操作 ID 必须复用同一任务');
  await waitJob(async () => (await call(admin, `spaces/demo/jobs/${first.body.jobId}`)).body?.job);
  assert.equal(ran, 1, '只能真跑一次');
});

test('未知任务类型仍然被拒', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-bad-'));
  const admin = initialize(root);
  const service = createService({root, engineFactory: () => ({call: async () => ({ok: true}), close: async () => {}})});
  t.after(async () => { await service.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const call = (route, method = 'GET', body = {}) => service.handle({token: admin, path: '/api/v1/' + route, method, body});
  await call('admin/projects', 'POST', {projectId: 'p'});
  await call('admin/spaces', 'POST', {spaceId: 'demo', owner: 'p'});
  const bad = await call('spaces/demo/jobs', 'POST', {type: 'something-else'});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_JOB');
});
