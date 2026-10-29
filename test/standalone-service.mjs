import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, createService } from '../src/standalone/service.mjs';
import { createStandaloneServer } from '../src/standalone/server.mjs';

test('credentials, project isolation, explicit sharing, revocation and adoption', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-spaces-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const admin=initialize(root);const adopted=[];
  const service=createService({root,engineFactory:({root:r})=>({call:async(op,p)=>op==='recall'?{items:[{id:'entry',text:path.basename(r),layer:'event',sourceRefs:['m1']}],block:'remember',receiptId:'local',actualMode:'keyword'}:op==='adoption'?(adopted.push([r,p]),{ok:true}):{ok:true},close:async()=>{}})});
  t.after(()=>service.close());
  const call=(token,route,method='GET',body={})=>service.handle({token,path:'/api/v1/'+route,method,body});
  assert.equal((await call('', 'version')).status,401);
  const a=(await call(admin,'admin/projects','POST',{projectId:'a'})).body.token;
  const b=(await call(admin,'admin/projects','POST',{projectId:'b'})).body.token;
  for(const sid of ['a','b'])assert.equal((await call(admin,'admin/spaces','POST',{spaceId:sid,owner:sid})).status,200);
  assert.equal((await call(a,'admin/spaces')).status,403);
  assert.equal((await call(a,'spaces/b/recall','POST',{})).status,403);
  await call(admin,'admin/spaces/b/readers','PUT',{projectIds:['a']});
  assert.equal((await call(a,'spaces/b/messages','POST',{messages:[]})).status,403);
  const result=await call(a,'spaces/a/recall','POST',{sharedSpaceIds:['b']});
  assert.deepEqual(result.body.items.map(i=>i.spaceId),['a','b']);
  assert.equal((await call(b,'spaces/a/adoptions','POST',{receiptId:result.body.receiptId})).status,403);
  await call(admin,'admin/spaces/b/readers','PUT',{projectIds:[]});
  assert.equal((await call(a,'spaces/a/adoptions','POST',{receiptId:result.body.receiptId})).status,403);
  assert.equal(adopted.length,0);
  const own=await call(a,'spaces/a/recall','POST',{});
  assert.equal((await call(a,'spaces/a/adoptions','POST',{receiptId:own.body.receiptId,itemIds:['a:entry']})).body.adopted,1);
  assert.equal((await call(a,'spaces/a/adoptions','POST',{receiptId:own.body.receiptId,itemIds:['a:entry']})).body.adopted,0);
  assert.equal(adopted.length,1);
  await call(admin,'admin/spaces/a/settings','PUT',{patch:{embedApiKey:'private-key',embedModel:'model'}});
  assert.equal(JSON.stringify((await call(admin,'admin/spaces/a/settings')).body).includes('private-key'),false);
  assert.equal((await call(admin,'admin/spaces/a/settings','PUT',{patch:{sourceRoot:'elsewhere'}})).status,400);
});

test('HTTP uses same credential checks and rejects malformed bodies',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-http-'));const token=initialize(root);
  const runtime=createStandaloneServer({root});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await runtime.close();fs.rmSync(root,{recursive:true,force:true})});
  const base='http://127.0.0.1:'+runtime.server.address().port;
  assert.equal((await fetch(base+'/api/v1/version')).status,401);
  assert.equal((await fetch(base+'/api/v1/version',{headers:{Authorization:'Bearer '+token}})).status,200);
  assert.equal((await fetch(base+'/api/v1/admin/projects',{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/vec/status',{headers:{Authorization:'Bearer '+token}})).status,404);
  assert.equal((await fetch(base+'/standalone.html')).status,200);
});

test('failed engine operations never become successful recall or adoption',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-errors-'));const admin=initialize(root);let mode='failRecall';
  const service=createService({root,engineFactory:()=>({call:async op=>op==='recall'?(mode==='failRecall'?{ok:false,code:'STORAGE_UNAVAILABLE',error:'archive unavailable'}:{ok:true,items:[{id:'e',text:'entry'}],receiptId:'r'}):{ok:false,code:'INVALID_RECEIPT',error:'receipt unavailable'},close:async()=>{}})});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true})});
  const call=(route,method='POST',body={})=>service.handle({token:admin,path:'/api/v1/'+route,method,body});
  await call('admin/projects','POST',{projectId:'p'});await call('admin/spaces','POST',{spaceId:'s',owner:'p'});
  const failed=await call('spaces/s/recall');assert.equal(failed.body.ok,false);assert.equal(failed.body.code,'STORAGE_UNAVAILABLE');assert.equal(failed.body.receiptId,undefined);
  mode='recall';const recalled=await call('spaces/s/recall');
  const result=await call('spaces/s/adoptions','POST',{receiptId:recalled.body.receiptId});assert.equal(result.body.ok,false);assert.equal(result.body.code,'INVALID_RECEIPT');
  const persisted=JSON.parse(fs.readFileSync(path.join(root,'spaces','s','state.json'),'utf8'));assert.deepEqual(persisted.receipts[recalled.body.receiptId].adopted,[]);
});

test('real HTTP empty-library workflow survives restart and isolates projects',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-endtoend-')),admin=initialize(root);
  let runtime=createStandaloneServer({root});
  async function listen(){await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));}
  await listen();t.after(async()=>{await runtime.close();fs.rmSync(root,{recursive:true,force:true})});
  async function api(token,route,method='POST',body={}){const r=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/api/v1/'+route,{method,headers:{Authorization:'Bearer '+token,...(method!=='GET'?{'content-type':'application/json'}:{})},...(method!=='GET'?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};}
  const {token}=await api(admin,'admin/projects','POST',{projectId:'app'});await api(admin,'admin/spaces','POST',{spaceId:'personal',owner:'app'});
  const scope={kind:'private',id:'person-alice'},message={messageId:'first',conversationId:'chat',actorId:'alice',role:'user',timestamp:new Date().toISOString(),text:'喜欢喝绿茶',scope};
  assert.equal((await api(token,'spaces/personal/messages','POST',{messages:[message]})).accepted,1);
  assert.equal((await api(token,'spaces/personal/entities/alice','PUT',{displayName:'Alice'})).ok,true);
  assert.equal((await api(token,'spaces/personal/memories','POST',{operationId:'tea',actorId:'alice',text:'喜欢喝绿茶',kind:'preference',scope,evidenceIds:['first'],source:'evidence'})).saved,true);
  let recall=await api(token,'spaces/personal/recall','POST',{query:'绿茶',scope,conversationId:'chat'});assert(recall.items.some(i=>i.layer==='semantic'));assert.equal((await api(token,'spaces/personal/adoptions','POST',{receiptId:recall.receiptId,itemIds:recall.items.map(i=>i.id)})).ok,true);
  assert.equal((await api(token,'spaces/personal/recall','POST',{scope:{kind:'group',id:'public'}})).items.length,0);
  await runtime.close();runtime=createStandaloneServer({root});await listen();
  assert.equal((await api(token,'spaces/personal/messages','POST',{messages:[message]})).duplicates,1);
  recall=await api(token,'spaces/personal/recall','POST',{query:'绿茶',scope});assert(recall.items.some(i=>i.layer==='semantic'));
  const task=await api(token,'spaces/personal/jobs','POST',{type:'consolidate'});
  let job;for(let i=0;i<30;i++){job=(await api(token,'spaces/personal/jobs/'+task.jobId,'GET')).job;if(job.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(job.status,'failed');assert.equal(job.error.code,'LLM_UNCONFIGURED');
});
