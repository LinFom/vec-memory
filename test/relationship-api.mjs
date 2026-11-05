import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initialize,createService} from '../src/standalone/service.mjs';
import {unionGraphs} from '../src/core/graph-union.mjs';
import {graphSimilarity} from '../src/core/graph-similarity.mjs';

test('optional content similarity is sparse and separate from real social relationships',()=>{
 const nodes=[{id:'a',accounts:['a']},{id:'b',accounts:['b']},{id:'c',accounts:['c']}];
 assert.equal(graphSimilarity(nodes,[]).length,0);
 const edges=graphSimilarity(nodes,[{actorId:'a',text:'喜欢图形编程计算机视觉'},{actorId:'b',text:'喜欢图形编程计算机视觉'},{actorId:'c',text:'热爱烘焙蛋糕甜点'}]);
 assert.equal(edges.length,1);assert.equal(edges[0].type,'similarity');assert.equal(edges[0].method,'keyword-jaccard');assert.equal(edges[0].weight,1);
});

test('union deduplicates verified platform identities only and retains provenance',()=>{
 const n=(id,label,proof)=>({id,label,type:'person',activity:1,accounts:[id],verifiedIdentities:proof?[JSON.stringify(proof)]:[]});
 const result=unionGraphs([{source:'a',result:{nodes:[n('1','柚子',['qq','1']),n('2','柚子')],edges:[]}},{source:'b',result:{nodes:[n('1','蜂蜜柚子茶',['qq','1']),n('2','柚子'),n('game','柚子',['game','1'])],edges:[]}}]);
 assert.equal(result.nodes.length,4);assert.equal(result.nodes.find(n=>n.origins.length===2).activity,2);
 assert.equal(result.nodes.filter(n=>n.label==='柚子').length,4);
});
test('graph API enforces scope, grants, revocation and administrative relation maintenance',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-graph-api-')),token=initialize(root);let calls=[];
 const service=createService({root,engineFactory:()=>({call:async(op,p)=>{calls.push({op,p});return {ok:true,nodes:[{id:'actor:a',type:'person',label:'a'}],edges:[],stats:{}};},close:async()=>{}})});
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=(tok,route,body={},method='POST')=>service.handle({token:tok,path:'/api/v1/'+route,body,method});
 const a=(await call(token,'admin/projects',{projectId:'a'})).body.token;await call(token,'admin/projects',{projectId:'b'});
 await call(token,'admin/spaces',{spaceId:'a',owner:'a'});await call(token,'admin/spaces',{spaceId:'b',owner:'b'});
 assert.equal((await call(a,'spaces/a/graph',{sharedSpaceIds:['b'],scope:{kind:'group',id:'g'}})).status,403);
 await call(token,'admin/spaces/b/readers',{projectIds:['a']},'PUT');
 const response=await call(a,'spaces/a/graph',{sharedSpaceIds:['b'],scope:{kind:'group',id:'g'}});assert.equal(response.status,200);assert.equal(response.body.nodes.length,2);assert.equal(calls.at(-1).p.admin,false);
 assert.equal((await call(a,'spaces/a/relationships',{action:'confirm'})).status,403);
 assert.equal((await call(a,'spaces/a/relation-backfill',{action:'start'})).status,403);
 await call(token,'admin/spaces/b/readers',{projectIds:[]},'PUT');assert.equal((await call(a,'spaces/a/graph',{sharedSpaceIds:['b']})).status,403);
});
test('historical backfill advances durable batches and pauses/resumes without automatic new scans',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-graph-jobs-')),token=initialize(root);let batches=0,release;
 const factory=()=>({call:async(op,p)=>{if(op!=='relationBackfill')return {ok:true};if(p.preview)return {ok:true,total:100,batches:2,modelConfigured:true};batches++;if(batches===1)await new Promise(r=>release=r);return {ok:true,offset:p.offset+50,total:100,done:p.offset+50>=100};},close:async()=>{}});
 let service=createService({root,engineFactory:factory});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=(route,body={},method='POST')=>service.handle({token,path:'/api/v1/'+route,body,method});
 await call('admin/projects',{projectId:'a'});await call('admin/spaces',{spaceId:'a',owner:'a'});
 const options={scope:{kind:'group',id:'g'},from:0,to:Date.now()};
 await call('spaces/a/relation-backfill',{action:'preview',...options});assert.equal(batches,0);
 const start=await call('spaces/a/relation-backfill',{action:'start',...options}),jobId=start.body.job.id;
 while(!release)await new Promise(r=>setTimeout(r,5));await call('spaces/a/relation-backfill',{action:'pause',jobId});release();
 let job;for(let i=0;i<100;i++){job=(await call('spaces/a/jobs/'+jobId,{},'GET')).body.job;if(job.status==='paused')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(job.status,'paused');assert.equal(job.options.offset,50);assert.equal(batches,1);
 await service.close();service=createService({root,engineFactory:factory});await new Promise(r=>setTimeout(r,20));assert.equal(batches,1);
 await call('spaces/a/relation-backfill',{action:'resume',jobId});
 for(let i=0;i<100;i++){job=(await call('spaces/a/jobs/'+jobId,{},'GET')).body.job;if(job.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(job.status,'completed');assert.equal(job.options.offset,100);assert.equal(batches,2);
});
