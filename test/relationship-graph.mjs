import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RelationshipGraph} from '../src/core/relationship-graph.mjs';
import {DurableLog} from '../src/core/durable-log.mjs';
const entities=[{id:'a',kind:'person',displayName:'蜂蜜柚子茶'},{id:'b',kind:'person',displayName:'柚子'},{id:'c',kind:'person',displayName:'游戏账号'}];
const scope={kind:'group',id:'g'};
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-relations-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,graph:new RelationshipGraph(root),log:new DurableLog(path.join(root,'messages.jsonl'),()=>{})};}
function append(log,id,actor,extra={}){const m={messageId:id,actorId:actor,role:'user',timestamp:Date.now(),scope,conversationId:'g',text:'A说B是我的同学',...extra};log.append(id,m,{message:m},{ok:true});return m;}
test('directed interactions deduplicate @ plus reply and resolve out-of-order targets once',t=>{
 const {root,graph,log}=setup(t);append(log,'reply','a',{mentions:['b'],replyTo:'late'});
 let view=graph.project(log.rows,entities,{}, {admin:true,from:0});assert.equal(view.stats.unresolvedReplies,1);
 append(log,'late','b');view=graph.project(log.rows,entities,{}, {admin:true,from:0});
 assert.equal(view.stats.unresolvedReplies,0);const edges=view.edges.filter(e=>e.type==='interaction');assert.equal(edges.length,1);assert.equal(edges[0].count,1);assert.equal(edges[0].source,'actor:a');assert.equal(edges[0].target,'actor:b');
 assert.equal(new RelationshipGraph(root).project(log.rows,entities,{}, {admin:true,from:0}).edges.find(e=>e.type==='interaction').count,1);
 assert.equal(view.nodes.filter(n=>n.type==='person').length,3);
});
test('scope visibility, fixed account binding and independent names',t=>{
 const {graph,log}=setup(t);append(log,'1','a');append(log,'2','b',{scope:{kind:'group',id:'other'},mentions:['c']});
 const v=graph.project(log.rows,entities,{}, {scope,from:0});assert.equal(v.nodes.some(n=>n.id==='actor:b'),false);
 const linked=graph.project(log.rows,entities,{links:{x:{a:'a',b:'c',active:true}}},{admin:true,from:0});assert.equal(linked.nodes.filter(n=>n.type==='person').length,2);assert.notEqual(linked.nodes.find(n=>n.accounts?.includes('a')).id,linked.nodes.find(n=>n.accounts?.includes('b')).id);
});
test('relationship evidence is attributed; corrections are durable and old extraction cannot revive them',t=>{
 const {root,graph,log}=setup(t),m=append(log,'1','a');
 const candidate={sourceActorId:'a',targetActorId:'b',kind:'relationship',predicate:'同学',statement:'A表示B是同学',reporterId:'a',evidenceIds:['1'],quote:'我的同学'};
 assert.deepEqual(graph.extract([candidate],{rows:[m],entities,windowId:'w'}),{accepted:1,rejected:0});
 const r=graph.records()[0];assert.equal(r.status,'candidate');assert.equal(r.evidence[0].reporterId,'a');
 const preview=graph.revise({operationId:'p',id:r.id,action:'preview'},{messages:[m],entities});
 const request={operationId:'delete',id:r.id,action:'retract',expectedRev:r.rev,previewToken:preview.previewToken};
 graph.revise(request,{messages:[m],entities});assert.equal(graph.revise(request,{messages:[m],entities}).replayed,true);
 graph.extract([candidate],{rows:[m],entities,windowId:'w'});
 assert.equal(new RelationshipGraph(root).records()[0].status,'retracted');
 assert.equal(graph.project(log.rows,entities,{}, {admin:true}).edges.filter(e=>e.type==='relationship').length,0);
 assert.throws(()=>graph.revise({...request,operationId:'stale'},{messages:[m],entities}),{code:'STALE_REVISION'});
 assert.equal(graph.extract([{...candidate,reporterId:'b'}],{rows:[m],entities,windowId:'w'}).rejected,1);
});
test('90-day filter does not expire confirmed relationships; reserved message IDs are harmless',t=>{
 const {graph,log}=setup(t),m=append(log,'__proto__','a',{timestamp:Date.now()-100*86400000,mentions:['b']});
 graph.revise({operationId:'manual',sourceActorId:'a',targetActorId:'b',kind:'attitude',predicate:'信任',statement:'手工声明',evidenceIds:[m.messageId]},{messages:[m],entities});
 const v=graph.project(log.rows,entities,{}, {admin:true});assert.equal(v.edges.some(e=>e.type==='interaction'),false);assert.equal(v.edges.some(e=>e.type==='attitude'),true);
});
test('repeated statements add evidence to one candidate and canonical account aliases do not duplicate nodes',t=>{
 const {graph,log}=setup(t),a=append(log,'1','raw-a'),b=append(log,'2','raw-a');
 const candidate={sourceActorId:'a',targetActorId:'b',kind:'relationship',predicate:'同学',statement:'同学',reporterId:'raw-a',quote:'我的同学'};
 graph.extract([{...candidate,evidenceIds:['1']},{...candidate,evidenceIds:['2']}],{rows:[a,b],entities,windowId:'w'});
 assert.equal(graph.records().length,1);assert.deepEqual(graph.records()[0].evidenceIds,['1','2']);
 const v=graph.project(log.rows,entities,{}, {admin:true,resolveAccount:id=>id==='raw-a'?'a':id});assert.equal(v.nodes.filter(n=>n.type==='person').length,3);assert.equal(v.nodes.some(n=>n.id==='actor:raw-a'),false);
 graph.revise({operationId:'denial',sourceActorId:'a',targetActorId:'b',kind:'relationship',predicate:'同学',statement:'明确否认',negated:true,evidenceIds:[]},{messages:[a,b],entities});
 const conflicts=graph.project(log.rows,entities,{}, {admin:true}).edges.filter(e=>e.type==='relationship');assert.equal(conflicts.length,2);assert.equal(conflicts.every(e=>e.record.conflicts.length===1),true);
});
