import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { createBackup, createBackupTo } from '../src/standalone/backup.mjs';
import { exportMemoryMessages, previewMemoryData, restoreMemoryMessages } from '../interop/preview-memory-data.mjs';
import { restorePortableRecords } from '../interop/merge-portable-memory.mjs';

test('portable records restore role history, tasks and corrections with original retry receipts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'vec-continuity-portable-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const source = path.join(root,'source'), restored = path.join(root,'restored'), bundle = path.join(root,'bundle');
  const scope = {kind:'private',id:'chat'}, roleId = 'moon', at = Date.now()-10000;
  const base = {actorId:'person',conversationId:'private:chat',role:'user',scope,timestamp:at};
  const task = {operationId:'task-create',scope,text:'把书还给我',messageId:'evidence'};
  const note = {operationId:'note-create',scope,roleId,kind:'concern',text:'担心约定失约',messageId:'evidence'};
  const day = {operationId:'day-create',scope,roleId,kind:'day',dayKind:'planned',at,text:'一起还书'};
  const temporal = {operationId:'z-assert',scope,actorId:'person',attribute:'residence',messageId:'evidence',value:'杭州'};
  let engine = createSpaceEngine({root:source,maintenance:true});
  try {
    await engine.call('ingest',{messages:[{...base,messageId:'evidence',text:'我现在住杭州，把书还给我'},
      {...base,timestamp:at+1,messageId:'correction',text:'刚刚的杭州说错了'},
      {...base,timestamp:at+2,messageId:'occurred',text:'我们已经一起还书了'}]});
    await engine.call('tasksWrite',task);
    await engine.call('tasksWrite',{operationId:'task-done',scope,id:'task-create',expectedRevision:1,status:'completed'});
    await engine.call('roleNotesWrite',note);
    await engine.call('roleNotesWrite',day);
    await engine.call('roleNotesWrite',{operationId:'day-occurred',scope,roleId,id:'day-create',expectedRevision:1,
      dayKind:'occurred',at:at+2,messageId:'occurred'});
    await engine.call('temporalWrite',temporal);
    await engine.call('temporalWrite',{...temporal,operationId:'a-correct',messageId:'correction',action:'retract',targetId:'z-assert'});
  } finally {await engine.close();}
  await exportMemoryMessages(source,bundle,'portable.roles',{includeObservations:true,includeRoleNotes:true});
  const ordinary=path.join(root,'ordinary');
  await exportMemoryMessages(source,ordinary,'portable.roles',{includeObservations:true});
  assert.equal((await previewMemoryData(ordinary)).counts['vec-memory.role-note'],undefined);
  const report = await previewMemoryData(bundle);
  assert.equal(report.counts['vec-memory.role-note'].unsupported,0);
  assert.equal(report.references.missing+report.references.unavailable,0);
  await restorePortableRecords(bundle,restored);
  engine = createSpaceEngine({root:restored,maintenance:true});
  try {
    assert.equal((await engine.call('tasksQuery',{scope,status:'all'})).items[0].status,'completed');
    assert.equal((await engine.call('roleNotesQuery',{scope,roleId,kind:'concern'})).items[0].text,note.text);
    assert.equal((await engine.call('roleNotesQuery',{scope,roleId,kind:'day'})).items[0].dayKind,'occurred');
    assert.equal((await engine.call('temporalQuery',{scope,actorId:'person',attribute:'residence'})).items.length,0);
    assert.equal((await engine.call('roleNotesQuery',{scope:{kind:'private',id:'elsewhere'},roleId,kind:'concern'})).items.length,0);
    assert.equal((await engine.call('roleNotesQuery',{scope,roleId:'other',kind:'concern'})).items.length,0);
    assert.equal((await engine.call('roleNotesWrite',note)).replayed,true);
    assert.equal((await engine.call('tasksWrite',task)).replayed,true);
    assert.equal((await engine.call('temporalWrite',temporal)).replayed,true);
    await engine.call('audit',{});
  } finally {await engine.close();}
  const again = path.join(root,'again');
  await exportMemoryMessages(restored,again,'portable.roles',{includeObservations:true,includeRoleNotes:true});
  const rows = async dir => (await fs.readFile(path.join(dir,'records/messages.ndjson'),'utf8')).trim().split('\n').map(JSON.parse)
    .sort((a,b) => a.key.id.localeCompare(b.key.id) || a.revision-b.revision);
  assert.deepEqual(await rows(again),await rows(bundle));
});

test('scoped evidence and portable preview use persisted messages before consolidation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vec-portable-test-'));
  const space = path.join(root, 'spaces', 'demo');
  await fs.mkdir(space, { recursive: true });
  const engine = createSpaceEngine({ root: space, maintenance: true });
  try {
    const scope = { kind: 'private', id: 'user-scope' };
    const message = { messageId: 'original', actorId: 'participant', conversationId: 'thread', scope,
      role: 'user', text: '发票编号 ZK502，金额 920 元', timestamp: 1794870000000 };
    await engine.call('ingest', { messages: [
      message,
      { ...message, messageId: 'different-thread', conversationId: 'other' },
      { ...message, messageId: 'machine-text', role: 'tool' },
    ] });
    const result = await engine.call('recall', { purpose: 'query', query: 'ZK502', scope, conversationId: 'thread' });
    const evidence = result.items.filter(item => item.layer === 'evidence');
    assert.deepEqual(evidence.map(item => item.sourceRefs[0].id), ['original']);
    assert.match(evidence[0].text, /ZK502.*920/);
    const automatic = await engine.call('recall', { purpose: 'automatic', query: 'ZK502', scope });
    assert(!automatic.items.some(item => item.layer === 'evidence'));
  } finally {
    await engine.close();
  }
  try {
    const bundle = path.join(root, 'bundle');
    const before = await fs.readFile(path.join(space, 'input/messages.jsonl'));
    await exportMemoryMessages(space, bundle, 'test.original');
    const live = await previewMemoryData(space);
    const portable = await previewMemoryData(bundle);
    assert.deepEqual(portable.counts, live.counts);
    assert.equal(portable.counts['vec-memory.message'].records, 3);
    const segment = path.join(bundle, 'records/messages.ndjson');
    const rows = (await fs.readFile(segment, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(rows[0].key, { namespace: 'test.original', id: 'original' });
    assert.deepEqual(await fs.readFile(path.join(space, 'input/messages.jsonl')), before);
    const restored = path.join(root, 'restored');
    assert.equal((await restoreMemoryMessages(bundle, restored)).restored, 3);
    const restoredEngine = createSpaceEngine({ root: restored, maintenance: true });
    try {
      const response = await restoredEngine.call('recall', { purpose: 'query', query: 'ZK502',
        scope: { kind: 'private', id: 'user-scope' }, conversationId: 'thread' });
      assert(response.items.some(item => item.layer === 'evidence' && item.sourceRefs[0].id === 'original'));
    } finally {
      await restoredEngine.close();
    }
    await assert.rejects(restoreMemoryMessages(bundle, restored), /already exists/);
    await fs.appendFile(segment, '\n');
    const brokenTarget = path.join(root, 'broken');
    await assert.rejects(restoreMemoryMessages(bundle, brokenTarget), /count mismatch|Integrity check/);
    await assert.rejects(fs.access(brokenTarget), { code: 'ENOENT' });
    await assert.rejects(previewMemoryData(bundle), /count mismatch|Integrity check/);
    const events = path.join(space, 'legacy/data/memory-vec/consolidate');
    await fs.mkdir(events, { recursive: true });
    await fs.writeFile(path.join(events, 'events.jsonl'), JSON.stringify({ evidenceIds: ['original', 'absent'] }) + '\n');
    const oldPath = path.join(root, 'full-v1.vmb'), newPath = path.join(root, 'evidence-v2.vmb');
    await fs.writeFile(oldPath, createBackup(root, { spaceId: 'demo' }));
    await createBackupTo(root, newPath, { spaceId: 'demo', mode: 'evidence' });
    const old = await previewMemoryData(oldPath);
    const archive = await previewMemoryData(newPath);
    assert.equal(old.format, 'vec-memory/vmb@1');
    assert.equal(archive.format, 'vec-memory/vmb@2');
    assert.equal(old.spaces[0].counts['vec-memory.message'].records, 3);
    assert.deepEqual(old.spaces[0].references, {
      checked: 2, missing: 1, unavailable: 0,
      examples: [{ kind: 'vec-memory.event', locator: 'legacy/data/memory-vec/consolidate/events.jsonl', line: 1, id: 'absent' }],
    });
    assert.deepEqual(archive.spaces[0].references, { checked: 0, missing: 0, unavailable: 2, examples: [] });
    assert.equal(old.spaces[0].datasets.find(row => row.kind === 'vec-memory.message').status, 'present');
    assert.equal(archive.spaces[0].datasets.find(row => row.kind === 'vec-memory.message').status, 'missing');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('query recalls an indexed identifier outside the recent window and scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vec-recall-index-'));
  const engine = createSpaceEngine({ root, maintenance: true });
  t.after(async () => {
    await engine.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const scope = { kind: 'group', id: 'team' };
  const common = { conversationId: 'chat', actorId: 'member', role: 'user', timestamp: 1794870000000, scope };
  await engine.call('ingest', { messages: [
    { ...common, messageId: 'wrong', scope: { ...scope, id: 'another-team' }, text: '设备 XY509 归他组' },
    { ...common, messageId: 'source', text: '设备 XY509 在二楼机房' },
    { ...common, messageId: 'mandarin', text: '桂花茶放在木柜底层' },
    ...Array.from({ length: 302 }, (_, i) => ({ ...common, messageId: `new-${i}`, text: '例行签到', timestamp: common.timestamp + i + 1 })),
  ] });
  await engine.call('job', { type: 'history-lexical' });
  const response = await engine.call('recall', { purpose: 'query', scope, conversationId: 'chat', query: 'XY509' });
  assert.deepEqual(response.items.filter(item => item.layer === 'evidence').map(item => item.sourceRefs[0].id), ['source']);
  const mandarin = await engine.call('recall', { purpose: 'query', scope, conversationId: 'chat', query: '桂花茶放哪了' });
  assert.deepEqual(mandarin.items.filter(item => item.layer === 'evidence').map(item => item.sourceRefs[0].id), ['mandarin']);
});

test('portable preview reports unknown records and exact-version reference gaps with their locations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vec-bundle-refs-'));
  t.after(async () => {
    if (path.basename(root).startsWith('vec-bundle-refs-')) await fs.rm(root, { recursive: true, force: true });
  });
  const key = { namespace: 'source.one', id: 'message' };
  const base = { protocol: 'vec-memory/record@1', kind: 'vec-memory.future', schemaVersion: 9,
    revision: 1, operation: 'put', recordedAt: null, payload: {} };
  const raw = [
    { ...base, key },
    { ...base, key: { namespace: key.namespace, id: 'derived' },
      references: [{ key, revision: 1, relation: 'vec-memory.evidence' },
        { key, revision: 2, relation: 'vec-memory.evidence' }] },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await fs.mkdir(path.join(root, 'records'));
  const file = 'records/part.ndjson';
  await fs.writeFile(path.join(root, file), raw);
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    protocol: 'vec-memory/bundle@1', profile: 'full', sourceSpace: 'demo',
    datasets: [{ kind: base.kind, status: 'complete' }], assets: [], requiredCapabilities: [],
    segments: [{ file, records: 2, bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') }],
  }));
  const report = await previewMemoryData(root);
  assert.deepEqual(report.counts[base.kind], { records: 2, unsupported: 2 });
  assert.deepEqual(report.references, { checked: 2, missing: 1, unavailable: 0,
    examples: [{ kind: base.kind, locator: file, line: 2, id: key.id }] });
});
