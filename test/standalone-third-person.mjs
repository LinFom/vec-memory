import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
import {mentionedPeople} from '../src/core/person-targets.mjs';
import {initialize,createService} from '../src/standalone/service.mjs';
import {keywordImpressions} from '../src/core/keyword-impressions.mjs';

test('keyword leads prioritize the requested field over name-only matches',()=>{
 const leads=keywordImpressions({query:'小乙的职业',profiles:[{who:'小乙',rec:{content:{items:[{k:'家乡',v:'杭州'},{k:'爱好',v:'玫瑰'},{k:'职业',v:'园艺师'}]}}}]});
 assert.equal(leads.length,2);assert.equal(leads[0].line,'职业=园艺师');
});

test('automatic impressions are two keyword fields in total; deliberate queries retain the full profile',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-keyword-leads-')),engine=createSpaceEngine({root});
  t.after(async()=>{await engine.close();fs.rmSync(root,{recursive:true,force:true});});
  const scope={kind:'group',id:'lobby'};
  for(const [id,name]of [['b','小乙'],['c','小丙']]){
    await engine.call('entity',{entityId:id,displayName:name});
    for(const [attr,text]of [['职业','园艺师'],['爱好','种植玫瑰'],['家乡','杭州']])
      await engine.call('remember',{operationId:id+attr,actorId:id,scope,source:'manual',kind:'trait',attr,text});
  }
  const auto=await engine.call('recall',{scope,query:'小乙和小丙的职业',purpose:'automatic'});
  const leads=auto.items.filter(i=>['semantic','profile'].includes(i.layer));
  assert.equal(leads.length,2);assert(leads.every(i=>i.matchMethod==='keyword'));
  assert(leads.every(i=>!i.text.includes(' / ')),'automatic recall must split profile cards into fields');
  const none=await engine.call('recall',{scope,actorIds:['b','c'],query:'火箭发射',purpose:'automatic'});
  assert.equal(none.items.filter(i=>['semantic','profile'].includes(i.layer)).length,0);
  const full=await engine.call('recall',{scope,query:'小乙的档案',purpose:'query'});
  assert(full.items.some(i=>i.layer==='profile'&&i.text.includes('园艺师')&&i.text.includes('杭州')));
});

test('private third-person queries require configured profile sharing and never expose foreign evidence',async t=>{
  for(const shared of [false,true]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-cross-profile-'));
    if(shared)fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({profileCrossScope:true}));
    const engine=createSpaceEngine({root});t.after(async()=>{await engine.close();fs.rmSync(root,{recursive:true,force:true});});
    const group={kind:'group',id:'lobby'},privateScope={kind:'private',id:'a'};
    await engine.call('entity',{entityId:'b',displayName:'小乙'});
    await engine.call('ingest',{messages:[{messageId:'group-source',conversationId:'lobby',actorId:'a',role:'user',timestamp:Date.now(),text:'小乙是园艺师',scope:group}]});
    await engine.call('remember',{operationId:'b-job',actorId:'b',scope:group,source:'evidence',evidenceIds:['group-source'],kind:'trait',attr:'职业',text:'园艺师'});
    const result=await engine.call('recall',{scope:privateScope,query:'小乙是什么职业',purpose:'query'});
    const profile=result.items.find(i=>i.layer==='profile');assert.equal(!!profile,shared);
    assert(!result.items.some(i=>['working','semantic','long-term','episodic'].includes(i.layer)));
    if(profile)assert.deepEqual(profile.sourceRefs,[]);
  }
});

test('automatic shared-space recall caps the delivered block and adoption receipt globally',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-shared-leads-')),admin=initialize(root);
  const service=createService({root,engineFactory:()=>({call:async op=>op==='recall'?{items:[1,2].map(n=>({id:'p'+n,text:'field-'+n,layer:'profile',score:n,matchMethod:'keyword'})),block:'unfiltered',receiptId:'local',actualMode:'keyword'}:{ok:true},close:async()=>{}})});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(route,body,method='POST')=>service.handle({token:admin,path:'/api/v1/'+route,method,body});
  await call('admin/projects',{projectId:'a'});
  for(const sid of ['a','b'])await call('admin/spaces',{spaceId:sid,owner:'a'});
  const r=await call('spaces/a/recall',{purpose:'automatic',sharedSpaceIds:['b']});
  assert.equal(r.status,200);assert.equal(r.body.items.length,2);
  assert.equal(r.body.block.split('\n').filter(l=>l.includes('【profile】')).length,2);
  const receipts=JSON.parse(fs.readFileSync(path.join(root,'spaces/a/state.json'),'utf8')).receipts;
  assert.equal(receipts[r.body.receiptId].items.length,2);
});

test('A asking about B recalls B profile even when B never spoke in that scope', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-third-person-'));
  const engine=createSpaceEngine({root});
  t.after(async()=>{await engine.close();fs.rmSync(root,{recursive:true,force:true});});
  const scope={kind:'group',id:'lobby'};
  await engine.call('entity',{entityId:'qq:a',displayName:'小甲'});
  await engine.call('entity',{entityId:'qq:b',displayName:'小乙',aliases:['乙同学']});
  await engine.call('remember',{operationId:'b-profile',actorId:'qq:b',scope,source:'manual',kind:'trait',attr:'职业',text:'园艺师'});
  await engine.call('ingest',{messages:[{messageId:'a-1',conversationId:'lobby',actorId:'qq:a',role:'user',timestamp:Date.now(),text:'乙同学是做什么工作的？',scope}]});
  const result=await engine.call('recall',{scope,conversationId:'lobby',query:'乙同学是做什么工作的？'});
  assert(result.items.some(i=>i.layer==='profile'&&i.text.includes('园艺师')), 'B was mentioned by unique alias but their profile was not recalled');
});

test('person references keep longer names, shared names and ASCII word boundaries separate',()=>{
  const entities=[{id:'long',displayName:'蜂蜜柚子茶'},{id:'short',displayName:'柚子'},
    {id:'one',displayName:'小白'},{id:'two',displayName:'小白'},{id:'ann',displayName:'Ann'}];
  assert.deepEqual(mentionedPeople('蜂蜜柚子茶的职业',entities).ids,['long']);
  assert.deepEqual(mentionedPeople('柚子的职业',entities).ids,['short']);
  assert.deepEqual(mentionedPeople('小白是谁？',entities),{ids:[],ambiguous:['小白']});
  assert.deepEqual(mentionedPeople('annual meeting',entities).ids,[]);
});

test('automatic consolidation may create B profile from A report with B absent',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-third-consolidate-'));let prompt='';
  const model=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);prompt=body.messages.map(m=>m.content).join('\n');
    const allowed=prompt.includes('"qq:b"');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({events:[],people:allowed?[{actorId:'qq:b',kind:'trait',attr:'职业',text:'园艺师'}]:[]})}}]}));});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({llmBaseURL:'http://127.0.0.1:'+model.address().port,llmModel:'mock',consolidateSettleMin:0}));
  const engine=createSpaceEngine({root});t.after(async()=>{await engine.close();await new Promise(r=>model.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const scope={kind:'group',id:'lobby'};
  await engine.call('entity',{entityId:'qq:b',displayName:'小乙'});
  await engine.call('ingest',{messages:[{messageId:'report',conversationId:'lobby',actorId:'qq:a',role:'user',timestamp:Date.now()-600000,text:'小乙的职业是园艺师。',scope}]});
  await engine.call('job',{type:'consolidate'});
  assert(prompt.includes('"qq:b"'),'Extraction prompt excludes the person being discussed');
  const result=await engine.call('recall',{scope,query:'小乙是什么职业'});
  assert(result.items.some(i=>i.layer==='profile'&&i.text.includes('园艺师')));
  const profile=result.items.find(i=>i.layer==='profile');assert.match(profile.text,/他人转述/);
  assert(profile.sourceRefs.some(r=>r.reporterId==='qq:a'&&r.aboutActorId==='qq:b'));
});
