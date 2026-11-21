import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsolidate, readEventRows, retireStaleEvents, loadConsolidateState, promoteEvents } from '../src/core/consolidate.mjs';
import { VecStore } from '../src/core/vecstore.mjs';
import { openFactStore } from '../src/core/factstore.mjs';

const NOW = 1800000000000, MIN = 60000, DAY = 86400000;
function fixture(t, times = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-commit-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'vmm-commit-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const libDir = path.join(root, 'lib'), sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(libDir, 'consolidate'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'memory/evidence.jsonl'), times.map(at => JSON.stringify({ id: `e-${at}`, at, chatKey: 'group:1', speakerId: '111111', text: 'weekend camping' })).join('\n') + '\n');
  return { libDir, sourceRoot, normalizer: { normalize: text => ({ text }), scopeLabel: () => 'group:C1' }, settings: { layerMaintenance: false }, callLlm: async () => JSON.stringify({ events: [{ title: 'camping', detail: '', who: [] }], people: [] }) };
}
const eventFile = d => path.join(d.libDir, 'consolidate/events.jsonl');
const event = (id, extra = {}) => ({ id, chatKey: 'group:1', summary: 'camping', title: 'camping', toTs: NOW - 100 * DAY, createdAt: new Date(NOW - 100 * DAY).toISOString(), ...extra });

test('event maintenance preserves every historical id beyond the display window', t => {
  const d = fixture(t);
  const rows = Array.from({ length: 4010 }, (_, i) => event(`old-${i}`, { chatKey: `group:${i % 3}` }));
  fs.writeFileSync(eventFile(d), rows.map(JSON.stringify).join('\n') + '\n');
  retireStaleEvents({ libDir: d.libDir, now: NOW });
  assert.deepEqual(readEventRows({ libDir: d.libDir, limitLines: 0 }).rows.map(r => r.id), rows.map(r => r.id));
});

test('maintenance refuses corrupt history rather than overwriting the valid subset', t => {
  const d = fixture(t), raw = JSON.stringify(event('old')) + '\n{broken\n';
  fs.writeFileSync(eventFile(d), raw);
  assert.throws(() => retireStaleEvents({ libDir: d.libDir, now: NOW }));
  assert.equal(fs.readFileSync(eventFile(d), 'utf8'), raw);
});

test('dry-run failures never advance or persist retry state', async t => {
  const d = fixture(t, [NOW - 20 * MIN]);
  for (let i = 0; i < 3; i++) await runConsolidate({ ...d, callLlm: async () => { throw Error('503'); } }, { now: NOW, dryRun: true });
  assert.deepEqual(loadConsolidateState({ libDir: d.libDir }).chats, {});
});

test('later successful windows cannot skip an earlier retryable failure', async t => {
  const d = fixture(t, [NOW - 200 * MIN, NOW - 20 * MIN]);
  let calls = 0;
  await runConsolidate({ ...d, callLlm: async (...args) => { if (calls++ === 0) throw Error('503'); return d.callLlm(...args); } }, { now: NOW });
  assert.ok((await runConsolidate(d, { now: NOW })).windows > 0);
});

test('failed event append never commits the window cursor', async t => {
  const d = fixture(t, [NOW - 20 * MIN]);
  fs.mkdirSync(eventFile(d));
  const result = await runConsolidate(d, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(loadConsolidateState({ libDir: d.libDir }).chats['group:1']?.lastTs || 0, 0);
});

test('failed replacement keeps the previously confirmed vector after reopen', t => {
  const d = fixture(t), dir = path.join(d.libDir, 'vectors'), store = new VecStore(dir);
  store.put({ id: 'x', vector: [1, 0], model: 'm', meta: { sourceHash: 'old' } });
  const append = fs.appendFileSync;
  try {
    fs.appendFileSync = function(file, ...args) { if (file === store.binFile) throw Error('disk failure'); return append.call(this, file, ...args); };
    assert.throws(() => store.put({ id: 'x', vector: [0, 1], model: 'm', meta: { sourceHash: 'new' } }));
  } finally { fs.appendFileSync = append; }
  const reopened = new VecStore(dir);
  assert.equal(reopened.get('x')?.meta.sourceHash, 'old');
  assert.equal(reopened.count, 1);
});


test('partially written window retries its frozen output, not a new model result', async t => {
  const d = fixture(t, [NOW - 20 * MIN]);
  let modelCalls = 0;
  d.callLlm = async () => { modelCalls++; return JSON.stringify({ events: [{ title: 'first' }, { title: 'second' }], people: [] }); };
  const append = fs.appendFileSync;
  let writes = 0;
  try {
    fs.appendFileSync = function(file, ...args) { if (file === eventFile(d) && ++writes === 2) throw Error('disk failure'); return append.call(this, file, ...args); };
    assert.equal((await runConsolidate(d, { now: NOW })).ok, false);
  } finally { fs.appendFileSync = append; }
  d.callLlm = async () => { modelCalls++; throw Error('must not rerun model'); };
  assert.equal((await runConsolidate(d, { now: NOW })).ok, true);
  assert.equal(modelCalls, 1);
  assert.deepEqual(readEventRows({ libDir: d.libDir }).rows.map(r => r.title), ['first', 'second']);
  assert.equal(loadConsolidateState({ libDir: d.libDir }).chats['group:1'].lastTs, NOW - 20 * MIN);
});

for (const failAt of ['meta', 'index']) test(`replacement rollback survives ${failAt} failure`, t => {
  const d = fixture(t), store = new VecStore(d.libDir);
  store.put({ id: 'x', vector: [1, 0], model: 'm', meta: { sourceHash: 'old' } });
  const original = failAt === 'meta' ? fs.appendFileSync : fs.renameSync;
  const method = failAt === 'meta' ? 'appendFileSync' : 'renameSync';
  let failed = false;
  try {
    fs[method] = function(...args) {
      if (!failed && (failAt === 'meta' ? args[0] === store.metaFile : args[1] === store.indexFile)) { failed = true; throw Error('one-shot failure'); }
      return original.apply(this, args);
    };
    assert.throws(() => store.put({ id: 'x', vector: [0, 1], model: 'm', meta: { sourceHash: 'new' } }));
  } finally { fs[method] = original; }
  const reopened = new VecStore(d.libDir);
  assert.equal(reopened.readOnlyReason, '');
  assert.equal(reopened.get('x').meta.sourceHash, 'old');
});

test('restart rolls back an interrupted vector append before exposing it', t => {
  const d = fixture(t), store = new VecStore(d.libDir);
  store.put({ id: 'x', vector: [1, 0], model: 'm', meta: { sourceHash: 'old' } });
  fs.writeFileSync(store.putJournal, JSON.stringify({ version: 1, binBytes: fs.statSync(store.binFile).size,
    metaBytes: fs.statSync(store.metaFile).size, index: store.index }));
  store._put({ id: 'x', vector: [0, 1], model: 'm', meta: { sourceHash: 'uncommitted' } });
  const reopened = new VecStore(d.libDir);
  assert.equal(reopened.get('x').meta.sourceHash, 'old');
  assert.equal(reopened.count, 1);
});

test('promotion merges into the latest ledger after an awaited embedding', async t => {
  const d = fixture(t);
  fs.writeFileSync(eventFile(d), JSON.stringify(event('hot', { hits: 9 })) + '\n');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => {
    fs.appendFileSync(eventFile(d), JSON.stringify(event('arrived-during-embed')) + '\n');
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }) };
  };
  const normalizer = { normalize: text => ({ text, stats: { hits: 0 } }), assertNoEntityForm() {}, findLeak: () => null, findEntityForm: () => null };
  const result = await promoteEvents({ libDir: d.libDir, store: { get: () => null, put() {} }, normalizer,
    settings: { embedBaseURL: 'http://synthetic.invalid', embedModel: 'test' }, now: NOW });
  assert.equal(result.promoted, 1);
  assert.deepEqual(readEventRows({ libDir: d.libDir }).rows.map(r => r.id), ['hot', 'arrived-during-embed']);
});

test('fact failure keeps a window pending while another chat can commit', async t => {
  const d = fixture(t, [NOW - 20 * MIN]);
  fs.appendFileSync(path.join(d.sourceRoot, 'memory/evidence.jsonl'), JSON.stringify({ id: 'other', at: NOW - 10 * MIN, chatKey: 'group:2', speakerId: '111111', text: 'other chat' }) + '\n');
  d.normalizer.resolveKnown = () => ({ label: '〔P1〕', kind: 'person' });
  d.factStore = openFactStore(path.join(d.libDir, 'facts'));
  const put = d.factStore.put.bind(d.factStore);
  let first = true;
  d.factStore.put = rec => { if (first) { first = false; throw Error('disk failure'); } return put(rec); };
  d.callLlm = async () => JSON.stringify({ events: [{ title: 'camping' }], people: [{ qq: '111111', kind: 'preference', text: 'camping' }] });
  const result = await runConsolidate(d, { now: NOW });
  assert.equal(result.failedWindows, 1); assert.equal(result.processed, 1);
  const chats = loadConsolidateState({ libDir: d.libDir }).chats;
  assert.equal(chats['group:1']?.lastTs || 0, 0); assert.equal(chats['group:2'].lastTs, NOW - 10 * MIN);
  d.factStore = openFactStore(path.join(d.libDir, 'facts'));
  d.callLlm = async () => { throw Error('retry must use frozen output'); };
  assert.equal((await runConsolidate(d, { now: NOW })).ok, true);
  assert.equal(readEventRows({ libDir: d.libDir }).rows.length, 2);
});
