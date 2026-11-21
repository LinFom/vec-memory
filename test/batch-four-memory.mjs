import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { createBackup, createBackupTo } from '../src/standalone/backup.mjs';
import { initialize, recoverSpaceImport, saveJson } from '../src/standalone/service.mjs';
import { exportMemoryMessages } from '../interop/preview-memory-data.mjs';
import { commitPortableMerge, previewPortableMerge } from '../interop/merge-portable-memory.mjs';
import { restoreLegacyMemory } from '../interop/restore-legacy-memory.mjs';

async function workspace(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'vec-batch-four-'));
  t.after(async () => {
    if (path.dirname(root) === parent && path.basename(root).startsWith('vec-batch-four-')) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  return root;
}

async function withEngine(root, fn, evaluation = false) {
  const engine = createSpaceEngine({ root, evaluation, maintenance: true });
  try { return await fn(engine); }
  finally { await engine.close(); }
}

const scope = { kind: 'private', id: 'thread' };
const now = Date.parse('2027-01-04T10:00:00+08:00');
const message = (id, text) => ({messageId:id,conversationId:'thread',actorId:'owner',
  role:'user',scope,timestamp:now-1000,text});
const recall = (engine, evaluationNow) => engine.call('recall', {
  scope, purpose:'automatic', natural:true, evaluationNow,
});

test('recorded reminder is visible only after capture and each delivered revision survives restart', async t => {
  const root = await workspace(t);
  const first = message('one','提醒我：2027-01-04T10:10:00+08:00，取快递');
  const second = message('two','提醒我：2027-01-04T10:20:00+08:00，带书');
  await withEngine(root, async engine => {
    const added = await engine.call('ingest',{messages:[first,second,{...second,messageId:'future',timestamp:now+1000}],evaluationNow:now});
    assert.equal(added.reminderCapture.written,2);
    assert.equal(added.rejected,1);
    assert.deepEqual((await recall(engine,now-1)).items,[]);
    const a = await recall(engine,now);
    assert.match(a.items[0].text,/取快递/);
    const concurrent = await recall(engine,now);
    assert.match(concurrent.items[0].text,/带书/);
    await engine.call('adoption',{receiptId:a.receiptId,itemIds:[a.items[0].id]});
  }, true);
  await withEngine(root, async engine => {
    const b = await recall(engine,now);
    assert.match(b.items[0].text,/带书/);
    await engine.call('adoption',{receiptId:b.receiptId,itemIds:[b.items[0].id]});
    assert.equal((await recall(engine,now)).items.length,0);
    const c = await engine.call('recall',{scope,observations:{operation:'count',asOf:now-1},evaluationNow:now});
    assert.equal(c.aggregate,0);
    const again = await engine.call('ingest',{messages:[first],evaluationNow:now});
    assert.equal(again.reminderCapture.replayed,1);
  }, true);
});

test('normal runtime ignores evaluation clock override', async t => {
  const root = await workspace(t);
  await withEngine(root, async engine => {
    const valid = {...message('one','普通消息'),timestamp:Date.now()-300};
    const r = await engine.call('ingest',{messages:[valid],evaluationNow:0});
    assert.equal(r.accepted,1);
    const output = await engine.call('recall',{scope,observations:{operation:'count'},evaluationNow:0});
    assert(output.asOf > 0);
  });
});

test('old full archives retain messages and can replay isolated restore, evidence archive stays preview-only', async t => {
  const root = await workspace(t), service = path.join(root,'srv');
  const space = path.join(service,'spaces','old');
  initialize(service);
  await withEngine(space,engine=>engine.call('ingest',{messages:[message('stored','藏书编号 R320')]}));
  const v1 = path.join(root,'old.vmb'), v2 = path.join(root,'old-v2.vmb'), partial = path.join(root,'partial.vmb');
  await fs.writeFile(v1,createBackup(service,{spaceId:'old'}));
  await createBackupTo(service,v2,{spaceId:'old',mode:'full'});
  await createBackupTo(service,partial,{spaceId:'old',mode:'evidence'});
  for (const [n, archive] of [v1,v2].entries()) {
    const destination = path.join(root,'restore-'+n);
    assert.equal((await restoreLegacyMemory(archive,destination)).replayed,false);
    assert.equal((await restoreLegacyMemory(archive,destination)).replayed,true);
    await withEngine(destination,async engine=>{
      const r=await engine.call('recall',{scope,purpose:'query',query:'R320'});
      assert(r.items.some(item=>item.sourceRefs.some(ref=>ref.id==='stored')));
    });
  }
  await assert.rejects(restoreLegacyMemory(partial,path.join(root,'no')),/full backup/);
});

test('merge refuses stale preview and retains ownership across recovery of a directory switch', async t => {
  const root = await workspace(t), service = path.join(root,'srv');
  const accesses = path.join(service,'access.json');
  initialize(service);
  const access = JSON.parse(await fs.readFile(accesses,'utf8'));
  access.projects.owner={tokenHash:'owner'};
  access.projects.reader={tokenHash:'reader'};
  access.spaces.main={owner:'owner',readers:['reader']};
  saveJson(accesses,access);
  const space = path.join(service,'spaces','main'), source = path.join(root,'source'), bundle = path.join(root,'bundle');
  await withEngine(space,engine=>engine.call('ingest',{messages:[message('original','原有记录')]}));
  await withEngine(source,engine=>engine.call('ingest',{messages:[message('new','合并记录')]}));
  await exportMemoryMessages(source,bundle,'demo.source');
  const old = await previewPortableMerge(service,'main',bundle);
  await withEngine(space,engine=>engine.call('ingest',{messages:[message('later','预览后的写入')]}));
  await assert.rejects(commitPortableMerge(service,'main',bundle,old.token),/changed/);
  const fresh = await previewPortableMerge(service,'main',bundle);
  assert.equal((await commitPortableMerge(service,'main',bundle,fresh.token)).applied,1);
  assert.equal((await commitPortableMerge(service,'main',bundle,fresh.token)).replayed,true);
  const staging=space+'.merge-recovery', rollback=space+'.rollback-recovery';
  await fs.cp(space,staging,{recursive:true});
  saveJson(path.join(service,'import-intent.json'),{destination:space,staging,rollback,sid:'main',preserveAccess:true});
  await fs.rename(space,rollback);
  recoverSpaceImport(service);
  assert.deepEqual(JSON.parse(await fs.readFile(accesses,'utf8')).spaces.main,access.spaces.main);
  await withEngine(space,async engine=>assert.equal((await engine.call('status',{})).messages,3));
});

test('portable merge retains an observation tombstone', async t => {
  const root=await workspace(t), srv=path.join(root,'srv'), space=path.join(srv,'spaces','main'), src=path.join(root,'src');
  const bundle=path.join(root,'bundle'), next=path.join(root,'next'), namespace='demo.portable';
  const accessFile=path.join(srv,'access.json');
  initialize(srv);
  const grants=JSON.parse(await fs.readFile(accessFile,'utf8'));
  grants.projects.one={tokenHash:'test'};
  grants.spaces.main={owner:'one',readers:[]};
  saveJson(accessFile,grants);
  const real=Date.now();
  const evidence={...message('source','还书'),timestamp:real-1000};
  const key={namespace,id:'commitment'};
  const record={protocol:'vec-memory/record@1',kind:'vec-memory.observation',schemaVersion:1,operation:'put',
    key,revision:1,references:[{key:{namespace,id:'source'},revision:1,relation:'vec-memory.evidence'}],
    payload:{subject:'owner',predicate:'return',status:'planned'}};
  await withEngine(src,async engine=>{
    await engine.call('ingest',{messages:[evidence]});
    const written=await engine.call('observe',{scope,operationId:'add',record});
    await engine.call('portableObservation',{operationId:'delete',record:{...record,revision:2,operation:'delete',
      references:undefined,payload:{},recordedAt:written.recordedAt}});
  });
  await exportMemoryMessages(src,bundle,namespace,{includeObservations:true});
  await withEngine(space,engine=>engine.call('ingest',{messages:[evidence]}));
  const plan=await previewPortableMerge(srv,'main',bundle);
  assert.equal(plan.canCommit,true);
  await commitPortableMerge(srv,'main',bundle,plan.token);
  await withEngine(space,async engine=>{
    const result=await engine.call('recall',{scope,observations:{predicate:'return',operation:'count'}});
    assert.equal(result.aggregate,0);
    await assert.rejects(engine.call('observe',{scope,operationId:'revive',record:{...record,revision:3}}),
      {code:'OBSERVATION_DELETED'});
  });
  await exportMemoryMessages(space,next,namespace,{includeObservations:true});
  const exported=(await fs.readFile(path.join(next,'records/messages.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert(exported.some(row=>row.operation==='delete'&&row.key.id===key.id&&row.revision===2));
});

test('unknown portable revisions are retained across export without entering observation recall', async t => {
  const root=await workspace(t), srv=path.join(root,'srv'), space=path.join(srv,'spaces','main'), src=path.join(root,'src');
  const bundle=path.join(root,'bundle'), next=path.join(root,'next'), namespace='demo.portable';
  const file='records/messages.ndjson', grantsFile=path.join(srv,'access.json');
  initialize(srv);
  const grants=JSON.parse(await fs.readFile(grantsFile,'utf8'));
  grants.projects.one={tokenHash:'test'};
  grants.spaces.main={owner:'one',readers:[]};
  saveJson(grantsFile,grants);
  await withEngine(src,engine=>engine.call('ingest',{messages:[message('source','观察原话')]}));
  await withEngine(space,engine=>engine.call('ingest',{messages:[message('existing','已有原话')]}));
  const manifest=await exportMemoryMessages(src,bundle,namespace);
  const opaque={protocol:'vec-memory/record@1',kind:'vec-memory.observation',schemaVersion:10,operation:'put',
    key:{namespace,id:'future'},revision:1,recordedAt:null,payload:{unknown:{v:[1,2,3]}},extensions:{'demo.test':{typed:true}}};
  await fs.appendFile(path.join(bundle,file),JSON.stringify(opaque)+'\n');
  const bytes=await fs.readFile(path.join(bundle,file));
  manifest.segments[0]={file,bytes:bytes.length,records:2,sha256:createHash('sha256').update(bytes).digest('hex')};
  const dataset=manifest.datasets.find(row=>row.kind===opaque.kind);
  dataset.status='partial';
  dataset.reason='Opaque test revision';
  await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest));
  const plan=await previewPortableMerge(srv,'main',bundle);
  assert.equal(plan.counts.retain,1);
  await commitPortableMerge(srv,'main',bundle,plan.token);
  await withEngine(space,async engine=>{
    const output=await engine.call('recall',{scope,observations:{operation:'count'}});
    assert.equal(output.aggregate,0);
  });
  await exportMemoryMessages(space,next,namespace,{includeObservations:true});
  const exported=(await fs.readFile(path.join(next,file),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(exported.find(row=>row.key.id==='future'),opaque);
});
