import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openFactStore } from '../src/core/factstore.mjs';
import { ManualRevisions } from '../src/core/manual-revisions.mjs';
import { SubjectStore, openSubjectStore } from '../src/core/subjects.mjs';
import { evaluateVisibility, resolveProfilePolicy, loadPolicyBaseline } from '../src/core/visibility.mjs';
import { profileSummary } from '../src/core/memory-core.mjs';
import { evidenceView } from '../src/core/provenance.mjs';
import { runConsolidate, loadConsolidateState } from '../src/core/consolidate.mjs';

function temp(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mv-core-v1-'));
  t.after(()=>{ assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('mv-core-v1-'));fs.rmSync(root,{recursive:true,force:true}); });
  return root;
}
const err=code=>e=>e.code===code;
function facts(root) {
  const f=openFactStore(path.join(root,'facts'));
  const r=f.put({speaker:'P1',target:'',fact_kind:'trait',scope:'group:C1',content:{items:[{k:'职业',v:'engineer'},{k:'爱好',v:'painting'}]},evidenceIds:['e1']});
  return {f,key:r.key};
}
const request=(item,op,operationId,value)=>({operationId,target:{key:item.key,itemKey:item.itemKey},expectedEtag:item.etag,op,...(value===undefined?{}:{value})});

test('human additions survive restart and machine replacement without reviving hidden legacy text',t=>{
  const root=temp(t),f=openFactStore(path.join(root,'facts'));
  f.put({speaker:'P1',target:'',fact_kind:'event',scope:'group:C1',content:{text:'legacy event'},evidenceIds:['e1']});
  const m=new ManualRevisions(root,f),old=m.items()[0];
  m.commit(request(old,'hide','hide-legacy'));
  const q={operationId:'human-add',speaker:'P1',scope:'group:C1',kind:'event',itemKey:'support',value:'human donation notice'};
  m.create(q);assert.equal(m.create(q).replayed,true);
  assert.doesNotMatch(JSON.stringify(m.project()),/legacy event/);
  const reopened=new ManualRevisions(root,openFactStore(path.join(root,'facts')));
  assert.equal(reopened.items().find(i=>i.itemKey==='support').origin,'human');
  assert.match(JSON.stringify(reopened.project()),/human donation notice/);
  f.put({speaker:'P1',target:'',fact_kind:'event',scope:'group:C1',content:{text:'new machine event'},evidenceIds:['e2','e3']});
  assert.match(JSON.stringify(m.project()),/human donation notice/);
  assert.doesNotMatch(JSON.stringify(m.project()),/new machine event/);
  const item=m.items().find(i=>i.itemKey==='support');
  m.commit(request(item,'replace','edit-human','edited support'));
  const edited=m.items().find(i=>i.itemKey==='support');
  m.commit(request(edited,'restore','restore-human'));
  assert.equal(m.items().find(i=>i.itemKey==='support').value,q.value);
  const badIo=Object.create(fs);badIo.fsyncSync=()=>{throw Error('disk failure');};
  const broken=new ManualRevisions(root,f,{io:badIo});
  assert.throws(()=>broken.create({...q,operationId:'failed',itemKey:'other'}),err('STORAGE_UNAVAILABLE'));
  assert.equal(new ManualRevisions(root,f).items().some(i=>i.itemKey==='other'),false);
});

test('visibility matrix and migration origins are explicit',()=>{
  for(const p of ['same-scope','group-peers','all']) {
    assert.equal(evaluateVisibility({sourceScope:'group:C1',targetScope:'group:C1',policy:p}).rank,0);
    assert.equal(evaluateVisibility({sourceScope:'group:C1',targetScope:'group:C2',policy:p}).allowed,p!=='same-scope');
    for(const pair of [['private:C1','group:C2'],['group:C1','private:C2'],['private:C1','private:C2']]) assert.equal(evaluateVisibility({sourceScope:pair[0],targetScope:pair[1],policy:p}).allowed,p==='all');
    assert.equal(evaluateVisibility({sourceScope:'?',targetScope:'?',policy:p}).allowed,false);
    assert.equal(evaluateVisibility({sourceScope:'',targetScope:'',policy:p,isSelf:true}).allowed,true);
    assert.equal(evaluateVisibility({sourceScope:'group:C1',targetScope:'group:C2',section:'subject',policy:p}).allowed,false);
  }
  assert.equal(resolveProfilePolicy({existing:false}).id,'group-peers');
  assert.equal(resolveProfilePolicy({}).origin,'legacy-default');
  assert.equal(resolveProfilePolicy({settings:{profileCrossScope:false}}).id,'same-scope');
  assert.throws(()=>resolveProfilePolicy({request:{profilePolicy:'group-peers',profileCrossScope:true}}),err('POLICY_CONFLICT'));
});

test('profile explanations retain all sources and separate blocked slots from merged lines',t=>{
  const root=temp(t),{f}=facts(root);
  f.put({speaker:'P1',target:'',fact_kind:'trait',scope:'group:C2',content:{items:[{k:'年龄',v:'25'}]},evidenceIds:['e2']});
  f.put({speaker:'P1',target:'',fact_kind:'trait',scope:'private:C3',content:{items:[{k:'所在地',v:'secret'}]},evidenceIds:['e3']});
  const p=profileSummary({winners:f.slots.values(),people:[{id:'1'}],normalizer:{resolveKnown:()=>({label:'P1'})},nowScope:'group:C1',policy:{id:'group-peers',origin:'request'}});
  assert.equal(p.summary.eligibleSlots,3);assert.equal(p.summary.allowedSlots,2);assert.equal(p.summary.blockedSlots,1);
  assert.equal(p.details.length,1);assert.equal(p.details[0].sourceSlots.length,2);assert.equal(p.details[0].mixedScopes,true);
  assert.equal(p.lines[0].scopeRank,1);assert.doesNotMatch(p.details[0].text,/secret/);
});

test('revision CAS, idempotency and restart preserve manual value without touching truth',t=>{
  const root=temp(t),{f,key}=facts(root);const before=fs.readFileSync(f.slotsFile,'utf8');
  const m=new ManualRevisions(root,f),item=m.items().find(i=>i.itemKey==='职业');
  const q=request(item,'replace','op1','artist'),done=m.commit(q);
  assert.equal(done.item.value,'artist');assert.equal(m.commit(q).replayed,true);
  assert.throws(()=>m.commit({...q,operationId:'op2'}),err('STALE_REVISION'));
  assert.throws(()=>m.commit({...q,value:'different'}),err('OPERATION_CONFLICT'));
  assert.equal(fs.readFileSync(f.slotsFile,'utf8'),before);
  const reopened=new ManualRevisions(root,openFactStore(path.join(root,'facts')));
  assert.equal(reopened.items().find(i=>i.itemKey==='职业').value,'artist');
  assert.equal(reopened.commit(q).replayed,true);assert.equal(reopened.project()[0].content.items.length,2);
});

test('hide survives machine replay; source change and restore are visible',t=>{
  const root=temp(t),{f,key}=facts(root),m=new ManualRevisions(root,f);
  const item=m.items().find(i=>i.itemKey==='职业');m.commit(request(item,'hide','h1'));
  f.put({speaker:'P1',target:'',fact_kind:'trait',scope:'group:C1',content:{items:[{k:'职业',v:'writer'},{k:'爱好',v:'painting'}]},evidenceIds:['e2']});
  assert.equal(m.project()[0].content.items.some(i=>i.k==='职业'),false);
  const hidden=m.items().find(i=>i.itemKey==='职业');assert.equal(hidden.hidden,true);assert.equal(hidden.sourceState,'source_changed');
  const restored=m.commit(request(hidden,'restore','r1'));assert.equal(restored.item.value,'writer');assert.equal(restored.item.hidden,false);
});

test('identity change invalidates etag; hidden journal corruption fails closed',t=>{
  const root=temp(t),{f}=facts(root);let identity='before';const m=new ManualRevisions(root,f,{identityVersion:()=>identity});
  const item=m.items()[0];identity='after';assert.throws(()=>m.commit(request(item,'hide','stale')),err('STALE_REVISION'));
  m.commit(request(m.items()[0],'hide','h'));
  fs.appendFileSync(m.log.file,'{broken\n');
  const reopened=new ManualRevisions(root,f);assert.throws(()=>reopened.project(),err('STORAGE_UNAVAILABLE'));
});

test('failed durable append rolls back and retry applies once',t=>{
  const root=temp(t),{f}=facts(root);let fail=true;
  const io={...fs,writeSync(...args){if(fail) throw Error('disk full');return fs.writeSync(...args);}};
  const m=new ManualRevisions(root,f,{io}),q=request(m.items()[0],'hide','retry');
  assert.throws(()=>m.commit(q),err('STORAGE_UNAVAILABLE'));assert.equal(m.log.rows.length,0);
  fail=false;assert.equal(m.commit(q).ok,true);assert.equal(m.commit(q).replayed,true);
});

test('persisted provenance is outside content fingerprint and never fabricates exact legacy sources',t=>{
  const root=temp(t),{f,key}=facts(root);
  const rec=f.get(key);assert.equal(evidenceView(rec,'职业').state,'unavailable');
  const withRefs={...rec,itemProvenance:{'职业':[{type:'window',id:'w1',chatKey:'group:1',fromTs:1,toTs:2}]}};
  assert.equal(evidenceView(withRefs,'职业').state,'unavailable');
  const view=evidenceView(withRefs,'职业',()=>true);assert.equal(view.level,'item');assert.equal(view.references[0].type,'window');
});

function create(s,operationId,kind='work',label='A',scopeBinding=null){return s.create({operationId,kind,label,scopeBinding}).subject;}
function observe(s,subject,operationId,scope='group:C1',statement='good') {
  return s.addObservation({operationId,subjectId:subject.id,expectedSubjectRev:subject.rev,aspect:'quality',statement,claimType:'opinion',sourceScope:scope,observedAt:10,
    provenance:[{type:'message',id:operationId,chatKey:'group:1'}]},{verifyReference:()=>true});
}

test('typed subjects, verified observations, same-scope recall and ambiguity',t=>{
  const root=temp(t),s=new SubjectStore(root),a=create(s,'a');
  assert.throws(()=>s.addObservation({operationId:'bad',subjectId:a.id,expectedSubjectRev:1,sourceScope:'group:C1',provenance:[]}),err('INVALID_PROVENANCE'));
  observe(s,a,'o1');assert.equal(s.select({scope:'group:C1',text:'A'}).length,1);assert.equal(s.select({scope:'group:C2',text:'A'}).length,0);
  create(s,'b','work','A');assert.equal(s.select({scope:'group:C1',text:'A'}).length,0);
  assert.equal(s.select({scope:'group:C1',subjectId:a.id}).length,1);
  const g=create(s,'g','group','group','group:C1');assert.throws(()=>create(s,'g2','group','other','group:C1'),err('SUBJECT_EXISTS'));
  assert.throws(()=>observe(s,g,'wrongscope','group:C2'),err('SCOPE_MISMATCH'));
});

test('merge and undo retain observation ids; cross kind and chains are guarded',t=>{
  const root=temp(t),s=new SubjectStore(root);let a=create(s,'a'),b=create(s,'b','work','B'),c=create(s,'c','project','C');
  a=observe(s,a,'a-o').subject;b=observe(s,b,'b-o','group:C1','bad').subject;
  const ids=[...s.snapshot().observations.keys()];
  assert.throws(()=>s.merge({operationId:'wrong',fromId:a.id,intoId:c.id,expectedFromRev:a.rev,expectedIntoRev:c.rev}),err('SCOPE_MISMATCH'));
  const q={operationId:'merge',fromId:a.id,intoId:b.id,expectedFromRev:a.rev,expectedIntoRev:b.rev};
  const merged=s.merge(q);assert.equal(s.get(b.id).observations.length,2);assert.equal(s.merge(q).replayed,true);
  s.unmerge({operationId:'undo',subjectId:a.id,expectedRev:merged.subject.rev});assert.equal(s.get(a.id).observations.length,1);assert.equal(s.get(b.id).observations.length,1);
  assert.deepEqual([...new SubjectStore(root).snapshot().observations.keys()],ids);
});

test('observation storage failure keeps frozen window pending and retry never reruns model',async t=>{
  const root=temp(t),libDir=path.join(root,'lib'),sourceRoot=path.join(root,'source'),now=1800000000000,at=now-20*60000;
  fs.mkdirSync(path.join(sourceRoot,'memory'),{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,'memory/evidence.jsonl'),JSON.stringify({id:'e1',at,chatKey:'group:1',speakerId:'111111',text:'group prefers quiet'})+'\n');
  const store=openSubjectStore(libDir);store.ensureGroup('group:C1');
  const original=store.log.append.bind(store.log);let calls=0;
  store.log.append=()=>{throw Error('subject disk failure');};
  const deps={libDir,sourceRoot,normalizer:{normalize:text=>({text}),scopeLabel:()=> 'group:C1'},settings:{layerMaintenance:false,subjectMemoryEnabled:true},
    callLlm:async()=>{calls++;return JSON.stringify({events:[],people:[],observations:[{subjectRef:'current-group',aspect:'style',statement:'quiet',claimType:'pattern',evidenceIds:['e1']}]});}};
  assert.equal((await runConsolidate(deps,{now})).ok,false);assert.equal(loadConsolidateState({libDir}).chats?.['group:1']?.lastTs,undefined);
  store.log.append=original;
  assert.equal((await runConsolidate(deps,{now})).ok,true);assert.equal(calls,1);assert.equal(store.select({scope:'group:C1'}).length,1);
  assert.equal((await runConsolidate(deps,{now})).ok,true);assert.equal(store.select({scope:'group:C1'}).length,1);
});

test('dry subject extraction never creates group storage or advances cursor',async t=>{
  const root=temp(t),sourceRoot=path.join(root,'source'),libDir=path.join(root,'lib'),now=1800000000000;
  fs.mkdirSync(path.join(sourceRoot,'memory'),{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,'memory/evidence.jsonl'),JSON.stringify({id:'e1',at:now-20*60000,chatKey:'group:1',speakerId:'111111',text:'quiet'})+'\n');
  const result=await runConsolidate({sourceRoot,libDir,normalizer:{scopeLabel:()=> 'group:C1'},settings:{subjectMemoryEnabled:true},callLlm:async()=>JSON.stringify({events:[],people:[],observations:[{subjectRef:'current-group',aspect:'style',statement:'quiet',claimType:'pattern',evidenceIds:['e1']}]})},{now,dryRun:true});
  assert.equal(result.ok,true);assert.equal(fs.existsSync(libDir),false);
});


test('partial journal append is removed before retry and replay remains stable',t=>{
  const root=temp(t),{f}=facts(root);let calls=0,fail=true;
  const io={...fs,writeSync(fd,bytes,offset,length,position){
    if(fail && ++calls===1) return fs.writeSync(fd,bytes,offset,Math.min(17,length),position);
    if(fail) throw Error('interrupted write');
    return fs.writeSync(fd,bytes,offset,length,position);
  }};
  const m=new ManualRevisions(root,f,{io}),q=request(m.items()[0],'replace','partial','new value');
  assert.throws(()=>m.commit(q),err('STORAGE_UNAVAILABLE'));assert.equal(fs.statSync(m.log.file).size,0);
  fail=false; m.commit(q); assert.equal(new ManualRevisions(root,f).commit(q).replayed,true);
});

test('old unmarked libraries keep all, new baseline survives reopen and corruption fails',t=>{
  const root=temp(t),old=path.join(root,'old'),fresh=path.join(root,'new');fs.mkdirSync(old);
  fs.writeFileSync(path.join(old,'old-asset'),'legacy');
  assert.equal(loadPolicyBaseline(old).existing,true);assert.equal(fs.existsSync(path.join(old,'policy-baseline.json')),false);
  assert.equal(loadPolicyBaseline(fresh).existing,false);assert.equal(loadPolicyBaseline(fresh).existing,false);
  fs.writeFileSync(path.join(fresh,'policy-baseline.json'),'{bad');assert.throws(()=>loadPolicyBaseline(fresh),err('STORAGE_UNAVAILABLE'));
});

test('new evidence does not erase unchanged item sources or attribute changed values to old sources',t=>{
  const root=temp(t),{f}=facts(root),ref={type:'window',id:'w1',chatKey:'group:1'};
  const put=(content,extra={})=>f.put({speaker:'P1',target:'',fact_kind:'trait',scope:'group:C1',content:{items:content},evidenceIds:['new'],...extra});
  const r=put([{k:'职业',v:'artist'},{k:'爱好',v:'painting'}],{itemProvenance:{'职业':[ref]}});
  put([{k:'职业',v:'artist'},{k:'爱好',v:'reading'}]);assert.equal(f.get(r.key).itemProvenance['职业'][0].id,'w1');
  put([{k:'职业',v:'writer'},{k:'爱好',v:'reading'}]);assert.equal(f.get(r.key).itemProvenance?.['职业'],undefined);
});

test('subject names require a real mention and case variants remain ambiguous',t=>{
  const root=temp(t),s=new SubjectStore(root),a=create(s,'a','work','Tool');observe(s,a,'o');
  assert.equal(s.select({scope:'group:C1',text:'Toolbox'}).length,0);
  assert.equal(s.select({scope:'group:C1',text:'Use tool today'}).length,1);
  create(s,'b','work','tool');assert.equal(s.select({scope:'group:C1',text:'Use Tool today'}).length,0);
  assert.throws(()=>create(s,'bad','group','raw group','group:123456'),err('INVALID_ARGUMENT'));
});


test('structured patterns remain visible to management but cannot be rewritten as plain text',t=>{
  const root=temp(t),{f}=facts(root);
  f.put({speaker:'P2',target:'',fact_kind:'pattern',scope:'group:C1',content:{pattern_type:'joke',exemplar:'a joke'},evidenceIds:['p']});
  const m=new ManualRevisions(root,f),item=m.items().find(i=>i.kind==='pattern');
  assert.ok(item.value);assert.equal(item.editable,false);
  assert.throws(()=>m.commit(request(item,'replace','pattern','other')),err('INVALID_ARGUMENT'));
});


test('window observation reporters must resolve from actual participants, not model labels',t=>{
  const root=temp(t),s=new SubjectStore(root),win={chatKey:'group:1',fromTs:1,toTs:2,rows:[{id:'e1',speakerId:'111111'}]};
  const candidate={subjectRef:'current-group',aspect:'style',statement:'quiet',claimType:'opinion',evidenceIds:['e1']};
  const input={win,windowId:'w1',scope:'group:C1',resolveReporter:id=>id==='111111'?'P1':null};
  assert.throws(()=>s.prepareWindow({...input,candidates:[{...candidate,reporterLabel:'P999'}]}),err('INVALID_OBSERVATION'));
  assert.throws(()=>s.prepareWindow({...input,candidates:[{...candidate,reporterId:'222222'}]}),err('INVALID_OBSERVATION'));
  const requests=s.prepareWindow({...input,candidates:[{...candidate,reporterId:'111111'}]});
  assert.equal(requests[0].reporterLabel,'P1');s.applyPrepared(requests,win,'group:C1');
  assert.equal(s.select({scope:'group:C1'})[0].reporterLabel,'P1');
});
