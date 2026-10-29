import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
const scope={kind:'group',id:'team-dev'};
const sample=(id='m1',patch={})=>({messageId:id,conversationId:'conversation-A',actorId:'user:alice@example',role:'user',timestamp:Date.now()-600000,text:'周末去露营，记得带绿茶',scope,...patch});
async function temporary(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-space-engine-'));try{await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('standalone engine: durable raw messages, conflicts, arbitrary IDs, evidence, restart and scope isolation',async()=>temporary(async root=>{
 let e=createSpaceEngine({root});const m=sample();try{
 assert.equal((await e.call('ingest',{messages:[m]})).accepted,1);
 let r=await e.call('ingest',{messages:[m,{...m,text:'different'},sample('bad',{timestamp:'bad'})]});assert.deepEqual(r.results.map(x=>x.status),['duplicate','conflict','invalid']);
 await e.call('entity',{entityId:m.actorId,displayName:'Alice'});
 await assert.rejects(e.call('remember',{actorId:m.actorId,text:'喜欢绿茶',scope,source:'assistant'}),e=>e.code==='EVIDENCE_REQUIRED');
 const request={operationId:'remember-tea',actorId:m.actorId,text:'喜欢绿茶',kind:'preference',scope,source:'evidence',evidenceIds:['m1']};
 assert.equal((await e.call('remember',request)).saved,true);
 assert.equal((await e.call('remember',request)).replayed,true);
 await assert.rejects(e.call('remember',{...request,text:'讨厌绿茶'}),e=>e.status===409);
 r=await e.call('recall',{query:'绿茶',scope,conversationId:m.conversationId});assert(r.items.some(i=>i.layer==='semantic'&&i.sourceRefs.some(ref=>ref.id==='m1')));assert(r.items.some(i=>i.layer==='working'));assert.equal(r.actualMode,'keyword');
 assert.equal((await e.call('recall',{query:'绿茶',scope:{kind:'private',id:'other'}})).items.length,0);
 const adopt={receiptId:r.receiptId,itemIds:[r.items[0].id]};assert.equal((await e.call('adoption',adopt)).accepted,true);assert.equal((await e.call('adoption',adopt)).replayed,true);
 await assert.rejects(e.call('job',{type:'consolidate'}),e=>e.code==='LLM_UNCONFIGURED');await assert.rejects(e.call('job',{type:'index'}),e=>e.code==='EMBED_UNCONFIGURED');
 await e.close();e=createSpaceEngine({root});assert.equal((await e.call('ingest',{messages:[m]})).duplicates,1);assert.equal((await e.call('remember',request)).replayed,true);assert((await e.call('recall',{query:'绿茶',scope})).items.some(i=>i.layer==='semantic'));
 }finally{await e.close();}
}));
test('standalone engine: existing consolidation, indexing, promotion and adoption algorithms run with generic inputs',async()=>temporary(async root=>{
 let calls=0;const model=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);res.setHeader('content-type','application/json');
 if(req.url.endsWith('/embeddings'))res.end(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}));
 else {calls++;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({events:[{title:'周末露营',detail:'约好带绿茶去露营',who:['user:alice@example']}],people:[{actorId:'user:alice@example',kind:'preference',aspect:'饮品',text:'喜欢绿茶'}]})}}]}));}});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${model.address().port}`;
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({llmBaseURL:url,llmModel:'mock',embedBaseURL:url,embedModel:'mock-embed',embedDimensions:3,promoteHits:1,consolidateSettleMin:0}));
 let e=createSpaceEngine({root});try{
 await e.call('ingest',{messages:[sample('m2')]});let result=await e.call('job',{type:'consolidate'});assert.equal(result.processed,1);assert.equal(calls,1);
 let recall=await e.call('recall',{query:'露营',scope});assert(recall.items.some(i=>i.layer==='episodic'));assert(recall.items.some(i=>i.layer==='semantic'));assert(recall.items.filter(i=>i.layer==='semantic').every(i=>i.sourceRefs.length));
 const first=recall.items.find(i=>i.layer==='episodic'),other=recall.items.find(i=>i.layer==='working');await e.call('adoption',{receiptId:recall.receiptId,itemIds:[other.id]});let adopted=await e.call('adoption',{receiptId:recall.receiptId,itemIds:[first.id]});assert.equal(adopted.rehearsal.bumped.length,1);
 await e.call('job',{type:'consolidate'});assert.equal(calls,1);result=await e.call('job',{type:'index'});assert.equal(result.ok,true);
 recall=await e.call('recall',{query:'露营',scope});assert.equal(recall.actualMode,'vector');assert(recall.items.some(i=>i.layer==='long-term'));
 await e.close();e=createSpaceEngine({root});await e.call('job',{type:'consolidate'});assert.equal(calls,1);assert((await e.call('recall',{query:'露营',scope})).items.some(i=>i.layer==='long-term'));
 }finally{await e.close();await new Promise(resolve=>model.close(resolve));}
}));
