import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { createBackupTo, inspectBackupFile } from '../src/standalone/backup.mjs';
import { createService, initialize } from '../src/standalone/service.mjs';

test('an administrator can rebuild a space index through the v1 job API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-api-'));
  const token = initialize(root);
  const service = createService({ root });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (route, method, body) => service.handle({ token, path: '/api/v1/' + route, method, body });
  assert.equal((await call('admin/projects', 'POST', { projectId: 'p' })).status, 200);
  assert.equal((await call('admin/spaces', 'POST', { spaceId: 's', owner: 'p' })).status, 200);
  const submitted = await call('spaces/s/jobs', 'POST', { type: 'history-lexical' });
  assert.equal(submitted.status, 200);
  const deadline = Date.now() + 5000;
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 25));
    job = (await call('spaces/s/jobs/' + submitted.body.jobId, 'GET')).body.job;
  } while (['queued', 'running'].includes(job.status) && Date.now() < deadline);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  const status = await call('spaces/s/status', 'GET');
  assert.equal(status.body.historyIndex.generation, job.result.generation);
  assert.equal(status.body.historyIndex.lastJob.id, submitted.body.jobId);
  assert.equal(status.body.historyIndex.lastJob.status, 'completed');
});

test('historical recall stays scoped and can recover a persisted generation', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-history-'));
  const root = path.join(temp, 'spaces', 's');
  let engine = createSpaceEngine({ root, maintenance: true });
  t.after(async () => {
    await engine.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const scope = { kind: 'private', id: 'a' };
  const sample = (messageId, text, offset, patch = {}) => ({
    messageId, text, timestamp: 1700000000000 + offset, actorId: 'alice',
    role: 'user', scope, conversationId: 'first', ...patch,
  });
  const query = { query: '薄荷巧克力', scope, conversationId: 'first', purpose: 'automatic', historyLexical: true };
  const historical = result => result.items.filter(item => item.matchMethod === 'history-lexical');
  const messages = [
    sample('old', '我记得你喜欢薄荷巧克力。', 0, { role: 'assistant' }),
    sample('other-scope', '薄荷巧克力', 1, { scope: { ...scope, id: 'b' } }),
    sample('other-thread', '薄荷巧克力', 2, { conversationId: 'second' }),
    sample('bad', '\ud800', 3),
    ...Array.from({ length: 6 }, (_, i) => sample('recent-' + i, '今天下雨', i + 4)),
  ];
  const ingested = await engine.call('ingest', { messages });
  assert.equal(ingested.accepted, 9);
  assert.equal(ingested.results[3].code, 'INVALID_MESSAGE');
  assert.deepEqual(historical(await engine.call('recall', { ...query, historyLexical: false })), []);
  assert.deepEqual(historical(await engine.call('recall', { ...query, historyLexical: undefined })), []);
  assert.equal(historical(await engine.call('recall', { ...query, purpose: 'query', historyLexical: undefined })).length, 1);
  const [old] = historical(await engine.call('recall', query));
  assert.equal(old.sourceRefs[0].id, 'old');
  assert.match(old.text, /^\[assistant\]/);
  assert.deepEqual(historical(await engine.call('recall', query)).map(item => item.id), ['message:old']);
  assert.deepEqual(historical(await engine.call('recall', { ...query, query: '完全无关' })), []);

  const first = await engine.call('job', { type: 'history-lexical' });
  const extra = sample('increment', '薄荷巧克力', -1);
  assert.equal((await engine.call('ingest', { messages: [extra, extra] })).duplicates, 1);
  assert.equal(historical(await engine.call('recall', query)).length, 2);
  const { historyIndex } = await engine.call('status');
  assert.equal(historyIndex.watermark, first.watermark);
  assert.equal(historyIndex.sourceRows, first.watermark + 1);
  const second = await engine.call('job', { type: 'history-lexical' });
  assert.equal(second.watermark, 10);
  assert.notEqual(first.generation, second.generation);
  await engine.close();
  fs.writeFileSync(path.join(root, 'derived-history', second.generation + '.json'), 'broken');
  engine = createSpaceEngine({ root, maintenance: true });
  assert.equal((await engine.call('status')).historyIndex.generation, first.generation);
  assert.equal(historical(await engine.call('recall', query)).length, 2);
  await engine.close();

  const archive = path.join(temp, 'full.vmb');
  await createBackupTo(temp, archive, { spaceId: 's', mode: 'full' });
  const { files } = await inspectBackupFile(archive);
  assert(files.some(file => file.name === 'input/messages.jsonl'));
  assert(files.every(file => !file.name.startsWith('derived-history/')));
});
