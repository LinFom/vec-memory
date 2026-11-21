import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf, disposeMemoryVec, mergeEntities } from '../src/core/backend.mjs';
import { memoryCoreOf } from '../src/core/memory-core.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mv-core-api-'));
const config={autoIndexEnabled:false,consolidateEnabled:false,crossChatEnabled:false,embedBaseURL:'',embedModel:''};
const router=createRouter({dataRoot:root,settings:{getSkillConfig:(_,defaults)=>({...defaults,...config})}});
const rt=await getRuntime();
for(let i=0;!rt.lastIdentityCheck&&i<200;i++) await new Promise(r=>setTimeout(r,10));
const A='10001111',B='10002222',CHAT='group:10009999',OTHER='group:10008888';
rt.normalizer.setVocabulary([{id:'qq:'+A,kind:'person',surface:['Alpha']},{id:'qq:'+B,kind:'person',surface:['Beta']},{id:CHAT,kind:'group',surface:['Test']}]);
const call=(route,body,headers)=>router.handle({path:route,method:body===undefined?'GET':'POST',body,headers});
const person=async()=> (await call('/memory/person?who='+A)).body;
const inject=extra=>call('/inject',{chatKey:CHAT,people:[{id:A}],dry:true,...extra});
test.after(()=>{disposeMemoryVec();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('mv-core-api-'));fs.rmSync(root,{recursive:true,force:true});});

test('management edit affects person, recall and injection while conflicts preserve draft',async()=>{
  assert.equal((await call('/remember',{chatKey:CHAT,userId:A,kind:'trait',attr:'职业',text:'engineer'})).status,200);
  const before=fs.readFileSync(factStoreOf(rt).slotsFile,'utf8');
  const item=(await person()).items[0];
  const q={operationId:'edit1',target:{key:item.key,itemKey:item.itemKey},expectedEtag:item.etag,op:'replace',value:'artist'};
  assert.equal((await call('/memory/revisions',q)).status,200);
  assert.equal((await call('/memory/revisions',q)).body.replayed,true);
  const conflict=await call('/memory/revisions',{...q,operationId:'edit2'});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'STALE_REVISION');assert.ok(conflict.body.currentEtag);
  assert.match((await inject()).body.block,/artist/);
  assert.match(JSON.stringify((await call('/person?who='+A)).body),/artist/);
  assert.match(JSON.stringify((await call('/recall?who='+A+'&chatKey='+CHAT)).body.longTerm),/artist/);
  assert.equal(fs.readFileSync(factStoreOf(rt).slotsFile,'utf8'),before);
  const edited=(await person()).items[0];
  assert.equal((await call('/memory/revisions',{operationId:'hide1',target:q.target,expectedEtag:edited.etag,op:'hide'})).status,200);
  assert.doesNotMatch((await inject()).body.block,/artist|engineer/);
  assert.equal((await call('/recall?who='+A+'&chatKey='+CHAT)).body.longTerm.total,0);
  const hidden=(await person()).items[0];assert.equal(hidden.hidden,true);
  const restored=await call('/memory/revisions',{operationId:'restore1',target:q.target,expectedEtag:hidden.etag,op:'restore'});assert.equal(restored.status,200);
  assert.match((await inject()).body.block,/engineer/);
});

test('policy comparison, legacy requests and explicit recall opt-in agree',async()=>{
  await call('/remember',{chatKey:OTHER,userId:A,kind:'trait',attr:'年龄',text:'25'});
  await call('/remember',{chatKey:'private:'+A,userId:A,kind:'trait',attr:'所在地',text:'secret-place'});
  const result=(await inject({profilePolicy:'group-peers'})).body;
  assert.equal(result.policySummary.allowedSlots,2);assert.equal(result.policySummary.blockedSlots,1);
  assert.match(result.block,/25/);assert.doesNotMatch(result.block,/secret-place/);assert.equal(result.profileDetails[0].sourceSlots.length,2);
  assert.match((await inject({profileCrossScope:true})).body.block,/secret-place/);
  assert.equal((await inject({profilePolicy:'group-peers',profileCrossScope:true})).status,400);
  const impact=await call('/memory/policy-impact?who='+A+'&chatKey='+CHAT);
  assert.equal(impact.status,200);assert.deepEqual(impact.body.policies.map(p=>p.allowedSlots),[1,2,3]);
  assert.equal((await call('/recall?who='+A+'&chatKey='+CHAT)).body.longTerm.total,1);
  assert.equal((await call('/recall?who='+A+'&chatKey='+CHAT+'&visibility=policy&profilePolicy=all')).body.longTerm.total,3);
  assert.equal((await call('/recall?visibility=policy')).status,400);
});

test('new install baseline is persisted and unknown management person is empty',async()=>{
  const result=(await inject()).body;
  assert.equal(result.policySummary.id,'group-peers');assert.equal(result.policySummary.origin,'new-install-default');
  assert.equal(JSON.parse(fs.readFileSync(path.join(rt.dir,'policy-baseline.json'),'utf8')).profilePolicy,'group-peers');
  assert.deepEqual((await call('/memory/person?who=Nobody')).body.items,[]);
});

test('instance mismatch and malformed mutation fail before writing',async()=>{
  const before=memoryCoreOf(rt,factStoreOf(rt)).manual.log.rows.length;
  const r=await call('/memory/revisions',{}, {'x-memory-instance-id':'wrong'});
  assert.equal(r.status,409);assert.equal(r.body.code,'INSTANCE_MISMATCH');assert.ok(r.body.instanceId);
  assert.equal((await call('/memory/revisions','{invalid')).status,400);
  assert.equal(memoryCoreOf(rt,factStoreOf(rt)).manual.log.rows.length,before);
});

test('subject observation stays separate from person paths and only recalls in its source scope',async()=>{
  const scope=rt.normalizer.scopeLabel(CHAT);
  const group=await call('/subjects',{operationId:'group',kind:'group',label:'Test group',scopeBinding:scope});assert.equal(group.status,200);
  const subject=group.body.subject,core=memoryCoreOf(rt,factStoreOf(rt));
  core.subjects.addObservation({operationId:'group-observation',subjectId:subject.id,expectedSubjectRev:subject.rev,sourceScope:scope,aspect:'style',statement:'prefers concise replies',claimType:'opinion',observedAt:1,
    provenance:[{type:'message',id:'synthetic-message',chatKey:CHAT}]},{verifyReference:()=>true});
  const local=await call('/recall?subjectId='+subject.id+'&chatKey='+CHAT);assert.equal(local.body.subjects.items.length,1);
  assert.equal((await call('/recall?subjectId='+subject.id+'&chatKey='+OTHER)).body.subjects.items.length,0);
  assert.equal((await call('/person?who='+subject.id)).body.code,'NOT_A_PERSON');
  assert.equal((await call('/recall?subjectId='+subject.id+'&who='+A+'&chatKey='+CHAT)).status,400);
  const injection=(await inject()).body;assert.equal(injection.subjectDetails.length,1);assert.match(injection.block,/主体观察/);
  assert.equal((await call('/subjects/'+subject.id+'/observations',{operationId:'unsafe'})).status,501);
});

test('API subject merge is reversible and diagnostics only advertises implemented capabilities',async()=>{
  const a=(await call('/subjects',{operationId:'work-a',kind:'work',label:'Book A'})).body.subject;
  const b=(await call('/subjects',{operationId:'work-b',kind:'work',label:'Book B'})).body.subject;
  const merged=await call('/subjects/'+a.id+'/merge',{operationId:'merge',intoId:b.id,expectedFromRev:1,expectedIntoRev:1});assert.equal(merged.status,200);
  assert.equal((await call('/subjects/'+a.id+'/unmerge',{operationId:'undo',expectedRev:merged.body.subject.rev})).status,200);
  const diag=(await call('/memory/diagnostics')).body;
  assert.ok(diag.capabilities.includes('memory.revisions'));assert.equal(diag.capabilities.includes('subjects.observations.write'),false);assert.equal(diag.pending.outbox,null);
});

test('human creation persists in person, recall and injection with manual provenance and isolated scope',async()=>{
  const instanceId=(await person()).instanceId;
  const body={operationId:'human-support',expectedInstanceId:instanceId,who:B,chatKey:CHAT,kind:'trait',itemKey:'支持经历',value:'supported the cat agent',reason:'operator entered from notification'};
  const result=await call('/memory/entries',body);
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((await call('/memory/entries',body)).body.replayed,true);
  assert.equal((await call('/memory/entries',{...body,value:'different'})).status,409);
  assert.equal((await call('/memory/entries',{...body,operationId:'another-support'})).body.code,'ITEM_EXISTS');
  const data=(await call('/memory/person?who='+B)).body;
  assert.equal(data.person.names[0],'Beta');
  const item=data.items.find(i=>i.itemKey==='支持经历'); assert.equal(item.origin,'human');assert.equal(item.humanCreated,true);
  assert.equal(data.scopes.find(s=>s.scope===item.scope).chatKey,CHAT);
  const ev=await call('/facts/evidence?key='+encodeURIComponent(item.key)+'&itemKey='+encodeURIComponent(item.itemKey));
  assert.equal(ev.body.state,'manual');assert.equal(ev.body.level,'item');
  const versions=await call('/facts/versions?key='+encodeURIComponent(item.key));
  assert.equal(versions.body.manualHistory[0].type,'addition');
  assert.match(JSON.stringify((await call('/recall?who='+B+'&chatKey='+CHAT)).body),/supported the cat agent/);
  const read=extra=>call('/inject',{chatKey:CHAT,people:[{id:B}],dry:true,...extra});
  assert.match((await read()).body.block,/supported the cat agent/);
  assert.doesNotMatch((await read({chatKey:OTHER,profilePolicy:'same-scope'})).body.block,/supported the cat agent/);
  await call('/memory/revisions',{operationId:'hide-human',target:{key:item.key,itemKey:item.itemKey},expectedEtag:item.etag,op:'hide'});
  assert.doesNotMatch((await read()).body.block,/supported the cat agent/);
  const hidden=(await call('/memory/person?who='+B)).body.items.find(i=>i.itemKey===item.itemKey);
  await call('/memory/revisions',{operationId:'restore-human',target:{key:item.key,itemKey:item.itemKey},expectedEtag:hidden.etag,op:'restore'});
  assert.match((await read()).body.block,/supported the cat agent/);
  for(const patch of [{who:'Nobody'},{who:CHAT},{chatKey:'group:C123'},{expectedInstanceId:'wrong'},{itemKey:'整体'},{kind:'pattern'}]) {
    const rejected=await call('/memory/entries',{...body,...patch,operationId:'invalid-'+JSON.stringify(patch)});
    assert.ok(rejected.status>=400,JSON.stringify(patch));
  }
});

test('manual event items coexist and persisted text is normalized before projection',async()=>{
  const instanceId=(await person()).instanceId;
  for(const day of ['day1','day2']) {
    const result=await call('/memory/entries',{operationId:'manual-event-'+day,expectedInstanceId:instanceId,who:B,
      chatKey:CHAT,kind:'event',itemKey:day,value:'Alpha supported the cat '+day});
    assert.equal(result.status,200,JSON.stringify(result.body));
  }
  const data=(await call('/memory/person?who='+B)).body;
  const events=data.items.filter(i=>i.kind==='event');
  assert.equal(events.length,2);assert.ok(events.every(i=>i.humanCreated));
  assert.doesNotMatch(JSON.stringify(events),/Alpha/);
  assert.match(JSON.stringify((await call('/recall?who='+B+'&chatKey='+CHAT)).body),/day1/);
  assert.match(JSON.stringify((await call('/recall?who='+B+'&chatKey='+CHAT)).body),/day2/);
});
