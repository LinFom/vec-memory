import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SceneMemory} from '../src/core/scene-memory.mjs';
import {RelationshipGraph} from '../src/core/relationship-graph.mjs';
import {DurableLog,digest} from '../src/core/durable-log.mjs';
import {canonicalChatKey} from '../src/core/input-source.mjs';
import {Normalizer} from '../src/core/normalize.mjs';
import {planEventCarry,encodingIdentity} from '../src/core/vector-generation.mjs';
import {createBackup,inspectBackup,restoreBackup} from '../src/standalone/backup.mjs';
import {initialize,createService} from '../src/standalone/service.mjs';

function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vec-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const scope={kind:'group',id:'a'}, outside={kind:'private',id:'dm'};
test('ambiguous nicknames never assert one person; stable accounts remain distinct',()=>{
 const n=new Normalizer({secret:Buffer.alloc(32,3)});
 n.setVocabulary([{id:'qq:10001',kind:'person',surface:['蜂蜜柚子茶','柚子']},{id:'qq:10002',kind:'person',surface:['柚子']}]);
 assert.notEqual(n.resolveKnown('qq:10001').label,n.resolveKnown('qq:10002').label);
 assert(![n.resolveKnown('qq:10001').label,n.resolveKnown('qq:10002').label].some(label=>n.normalize('柚子').text.includes(label)));
 assert.equal(n.normalize('蜂蜜柚子茶').text,'〔'+n.resolveKnown('qq:10001').label+'〕');
});
test('unknown original vector identity stays unknown across second and third carry',()=>{
 const identity={model:'m',dim:3,encoding:encodingIdentity({embedModel:'m',embedBaseURL:'https://example.test',embedDimensions:3})};
 const first=planEventCarry({sourceMetas:[{id:'e',kind:'event',model:'m',dim:3}],targetIdentity:identity,allowUnknown:true});
 assert.equal(first.accepted[0].verdict.verdict,'unknown');
 const second=planEventCarry({sourceMetas:[{...first.accepted[0].meta,carriedFrom:'A',carryIdentity:first.accepted[0].sourceIdentity}],sourceEncoding:identity.encoding,targetIdentity:identity});
 assert.equal(second.blocked[0].verdict,'unknown');
 const missing=planEventCarry({sourceMetas:[{id:'e',kind:'event',carriedFrom:'B',model:'m',dim:3}],sourceEncoding:identity.encoding,targetIdentity:identity});assert.equal(missing.blocked[0].verdict,'unknown');
});
test('scene candidates, duplicate tombstones, proven dependency corrections and explicit sharing',t=>{
 const dir=temporary(t), w=new SceneMemory(dir);w.scene({operationId:'s',sceneId:'a',name:'A',bindings:[scope]});
 const save=(id,text,more={})=>w.entry({operationId:id,sceneId:'a',scope,text,...more},{admin:true});
 const root=save('r','不正确的规矩',{confirm:true,shareable:true}).entry;
 const child=save('c','由规矩形成的印象',{derivedFrom:[root.id]}).entry;
 save('private','内部信息',{confirm:true});
 assert.equal(w.query({scope:outside}).length,1);
 assert.equal(w.entry({operationId:'candidate',sceneId:'a',scope:outside,text:'外部补充'},{evidence:[{id:'m'}]}).entry.status,'candidate');
 assert.equal(save('again','不正确的规矩').duplicate,true);
 const preview=w.preview(root.id);assert.deepEqual(new Set(preview.proven),new Set([root.id,child.id]));
 w.retract({operationId:'delete',entryId:root.id,previewToken:preview.previewToken,reason:'纠正'});
 assert.equal(save('resurrection','不正确的规矩').blocked,true);assert.equal(w.query({scope:outside}).length,0);
 const reopen=new SceneMemory(dir);assert.equal(reopen.state().entries[child.id].status,'retracted');
 const restored=reopen.entry({operationId:'restore-explicit',entryId:root.id,expectedRev:reopen.state().entries[root.id].rev,previewToken:reopen.preview(root.id).previewToken,sceneId:'a',scope,text:'修正后的规矩',confirm:true,shareable:true},{admin:true}).entry;
 assert.equal(restored.status,'confirmed');assert.equal(reopen.state().entries[child.id].status,'retracted');
 assert.equal(new SceneMemory(dir).query({scope:outside})[0].text,'修正后的规矩');
 const candidate=Object.values(reopen.state().entries).find(e=>e.text==='外部补充');
 assert.throws(()=>reopen.entry({operationId:'publish',entryId:candidate.id,expectedRev:1,sceneId:'a',scope:outside,text:'外部补充',shareable:true},{evidence:[{id:'m'}]}),/administrator/i);
});
// ── bounded SERVICE channel-name contract ───────────────────────────────────
// Names are display metadata only: they never merge identities, move a scene's
// bindings or touch message journals. All fixtures are model-free.
const nameDir=t=>path.join(t,'input');
// A real SceneMemory journal is the only trustworthy way to seed historical
// rows: the log verifies its hash chain, so fake rows must not be fabricated.
const seedWorkspace=(dir,scenes)=>{
 const w=new SceneMemory(dir);
 for(const s of scenes)w.scene({operationId:'seed:'+s.sceneId,sceneId:s.sceneId,name:s.name,bindings:s.bindings||[{kind:'group',id:s.sceneId.slice(6)}]});
};
test('scene names are bounded: human names are never auto-renamed, legacy ID names may be',t=>{
 const dir=temporary(t),w=new SceneMemory(dir);
 assert.throws(()=>w.scene({operationId:'bad',sceneId:'group:a',name:'A'}),/bindings/i);
 const manual=w.scene({operationId:'s',sceneId:'group:a',name:'人工群名',bindings:[scope]}).scene;
 assert.equal(manual.nameSource,'manual');
 const kept=w.ensureScene({operationId:'p1',sceneId:'group:a',name:'适配器群名',scope});
 assert.equal(kept.name,'人工群名');assert.equal(kept.manualPreserved,true);assert.equal(kept.updated,false);assert.equal(kept.nameSource,'manual');
 assert.equal(w.state().scenes['group:a'].name,'人工群名');
 const created=w.ensureScene({operationId:'p2',sceneId:'private:dm',scope:outside});
 assert.equal(created.name,'private:dm');assert.equal(created.nameSource,'generated');assert.equal(created.updated,true);
 // A same-operation re-submission replays the stored answer; a nameless call on
 // an existing scene is a pure no-op that adds no journal row.
 const replay=w.ensureScene({operationId:'p2',sceneId:'private:dm',scope:outside});
 assert.equal(replay.name,'private:dm');assert.equal(replay.replayed,true,'the stored answer is replayed, not re-journaled');
 assert.equal(fs.readFileSync(path.join(dir,'workspace.jsonl'),'utf8').trim().split('\n').length,2,'management create + ensured create');
 const claim=w.ensureScene({operationId:'p3',sceneId:'private:dm',name:'私聊对象',scope:outside});
 assert.equal(claim.name,'私聊对象');assert.equal(claim.nameSource,'adapter');assert.equal(claim.staleName,undefined);
 assert.equal(w.state().scenes['private:dm'].bindings.map(canonicalChatKey).join(),'private:dm','bindings untouched');
 const follow=w.ensureScene({operationId:'p4',sceneId:'private:dm',name:'改名了',scope:outside,previousName:'私聊对象'});
 assert.equal(follow.name,'改名了');assert.equal(follow.updated,true);
 const stale=w.ensureScene({operationId:'p5',sceneId:'private:dm',name:'抢名',scope:outside,previousName:'私聊对象'});
 assert.equal(stale.name,'改名了','stale cursor returns the ACTUAL stored name');assert.equal(stale.staleName,true);assert.equal(stale.updated,false);
 const again=w.ensureScene({operationId:'p6',sceneId:'private:dm',name:'改名了',scope:outside});
 assert.equal(again.name,'改名了');assert.equal(again.updated,false);assert.equal(again.manualPreserved,false);
 const rows=()=>fs.readFileSync(path.join(dir,'workspace.jsonl'),'utf8').trim().split('\n').length,rev=()=>new SceneMemory(dir).state().scenes['private:dm'].rev;
 const before=rows(),revBefore=rev();
 assert.equal(w.scene({operationId:'p7',sceneId:'private:dm',name:'人工输入',bindings:[outside],expectedRev:revBefore}).scene.name,'人工输入');
 assert.equal(rows(),before+1,'one journal row per real change');
 assert.equal(w.ensureScene({operationId:'p8',sceneId:'private:dm',name:'人工输入',scope:outside}).name,'人工输入');
 // A manually preserved submission is answered from state: no row, no revision.
 assert.equal(rows(),before+1,'a human-protected submission adds no journal row');
 assert.equal(rev(),revBefore+1,'and no extra revision');
});
test('historical workspace rows without nameSource stay protected unless they are ID placeholders',t=>{
 const dir=temporary(t),input=nameDir(dir);fs.mkdirSync(input,{recursive:true});
 const row=state=>({version:1,seq:1,previous:'',operationId:'legacy-row',fingerprint:digest('legacy-row'),data:{state},result:{ok:true}});
 const write=scenes=>{const body=row({version:1,scenes,entries:{},links:{}});fs.writeFileSync(path.join(input,'workspace.jsonl'),JSON.stringify({...body,hash:digest(body)})+'\n');};
 // Names written before this contract carry no nameSource at all.
 write({'group:keep':{sceneId:'group:keep',name:'人起的老群名',type:'channel',rev:1,bindings:[{kind:'group',id:'keep'}]},
        'group:old':{sceneId:'group:old',name:'group:old',type:'channel',rev:1,bindings:[{kind:'group',id:'old'}]}});
 const w=new SceneMemory(input);
 assert.equal(w.state().scenes['group:keep'].nameSource,undefined);
 const protectedName=w.ensureScene({operationId:'h1',sceneId:'group:keep',name:'新群名',scope:{kind:'group',id:'keep'}});
 assert.equal(protectedName.name,'人起的老群名','a historical human name is never auto-overwritten');
 assert.equal(protectedName.manualPreserved,true);assert.equal(protectedName.updated,false);
 const upgraded=w.ensureScene({operationId:'h2',sceneId:'group:old',name:'老群的新名字',scope:{kind:'group',id:'old'}});
 assert.equal(upgraded.name,'老群的新名字','an ID placeholder may be claimed by the adapter');
 assert.equal(upgraded.nameSource,'adapter');assert.equal(upgraded.updated,true);
 assert.equal(new SceneMemory(input).state().scenes['group:old'].bindings.map(canonicalChatKey).join(),'group:old');
 // Explicit management naming wins and records human authority.
 const renamed=w.scene({operationId:'h3',sceneId:'group:old',name:'人手再改',bindings:[{kind:'group',id:'old'}],expectedRev:w.state().scenes['group:old'].rev}).scene;
 assert.equal(renamed.nameSource,'manual');
 assert.equal(new SceneMemory(input).state().scenes['group:old'].nameSource,'manual','durable across reopen');
 assert.equal(w.ensureScene({operationId:'h4',sceneId:'group:old',name:'适配器再试',scope:{kind:'group',id:'old'}}).manualPreserved,true);
});
test('relationship projection labels channels by display name, never by scope ID',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-relations-labels-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const graph=new RelationshipGraph(root),log=new DurableLog(path.join(root,'messages.jsonl'),()=>{});
 const named={kind:'group',id:'123'},unnamed={kind:'group',id:'999'},dm={kind:'private',id:'7'};
 const append=(id,actor,sc)=>{const m={messageId:id,actorId:actor,role:'user',timestamp:Date.now(),scope:sc??named,conversationId:'c',text:'hi'};log.append(id,m,{message:m},{ok:true});};
 append('1','a',named);append('2','b',unnamed);append('3','a',dm);
 const entities=[{id:'qq:1',kind:'person',displayName:'柚子'}];
 const workspace={scenes:{'group:123':{sceneId:'group:123',name:'星海实验室',nameSource:'manual',bindings:[named]}},links:{}};
 const view=graph.project(log.rows,entities,workspace,{admin:true,from:0});
 const channel=id=>view.nodes.find(n=>n.id==='channel:'+id);
 assert.equal(channel('group:123').label,'星海实验室');
 assert.equal(channel('group:999').label,'未命名群聊','an unnamed channel is not titled group:999');
 assert.equal(channel('group:999').scopeId,'group:999','the raw scope stays for traceability');
 assert.equal(channel('private:7').label,'未命名私聊');
 // An ID-shaped scene name is a placeholder, not a label.
 const legacy={scenes:{'group:999':{sceneId:'group:999',name:'group:999',bindings:[unnamed]}},links:{}};
 assert.equal(graph.project(log.rows,entities,legacy,{admin:true,from:0}).nodes.find(n=>n.id==='channel:group:999').label,'未命名群聊');
 // Exact registered group entity is a fallback; label never merges people.
 const withEntities=graph.project(log.rows,[...entities,{id:'group:999',kind:'group',displayName:'游戏公会'}],workspace,{admin:true,from:0,groupEntityName:key=>key==='group:999'?'游戏公会':null});
 assert.equal(withEntities.nodes.find(n=>n.id==='channel:group:999').label,'游戏公会');
 assert.equal(channel('group:123').label,'星海实验室','a group entity name never overrides a human scene name');
});
test('SERVICE name sync ACKs the stored name, honours project write access and never renames a person',async t=>{
 const root=temporary(t),admin=initialize(root),service=createService({root});t.after(()=>service.close());
 const call=async(route,body={},token=admin)=>{const r=await service.handle({path:'/api/v1/'+route,method:'POST',token,body});return {...r.body,http:r.status};};
 const project=(await call('admin/projects',{projectId:'p'})).token,stranger=(await call('admin/projects',{projectId:'x'})).token;
 assert.ok(project);assert.ok(stranger);
 await call('admin/spaces',{spaceId:'s',owner:'p'});
 const w=(action,p={},tk=admin)=>call('spaces/s/workspace',{action,...p},tk);
 const room={kind:'group',id:'chan-1'};
 // Legacy ensureScene keeps its behaviour and now acknowledges name sync support.
 const legacy=await w('ensureScene',{scope:room});assert.equal(legacy.http,200);
 assert.equal(legacy.ok,true);assert.equal(legacy.nameSyncSupported,true);assert.equal(legacy.sceneId,'group:chan-1');
 assert.equal(legacy.name,'group:chan-1');assert.equal(legacy.nameSource,'generated');
 for(const placeholder of ['group:chan-1','chan-1']){
   const entity=await service.handle({path:'/api/v1/spaces/s/entities/group%3Achan-1',method:'PUT',token:project,body:{kind:'group',displayName:placeholder}});
   assert.equal(entity.status,200);
   const graph=await call('spaces/s/graph',{from:0});
   assert.equal(graph.nodes.find(n=>n.scopeId==='group:chan-1').label,'未命名群聊');
 }

 // An empty scope/name is rejected with the ordinary length validation.
 assert.equal((await w('ensureScene',{scope:room,name:'   '})).code,'INVALID_ARGUMENT');
 // A project credential with write access may supply and follow the platform name.
 const first=await w('ensureScene',{scope:room,name:'星海实验室',nameSource:'adapter'},project);
 assert.equal(first.http,200,JSON.stringify(first));assert.equal(first.name,'星海实验室');assert.equal(first.updated,true);assert.equal(first.manualPreserved,false);
 // The same name again is a no-op: no revision, and it acknowledges the stored name.
 const repeat=await w('ensureScene',{scope:room,name:'星海实验室',nameSource:'adapter',previousName:'星海实验室'},project);
 assert.equal(repeat.updated,false);assert.equal(repeat.name,'星海实验室');assert.equal(repeat.manualPreserved,false);
 const renamed=await w('ensureScene',{scope:room,name:'星海实验室（二群）',nameSource:'adapter',previousName:'星海实验室'},project);
 assert.equal(renamed.name,'星海实验室（二群）');assert.equal(renamed.updated,true);
 const noCursor=await w('ensureScene',{scope:room,name:'没有改名游标',nameSource:'adapter'},project);
 assert.equal(noCursor.staleName,true);assert.equal(noCursor.name,'星海实验室（二群）');
 // A stale cursor returns the ACTUAL stored name and never overwrites it.
 const stale=await w('ensureScene',{scope:room,name:'别人的名字',nameSource:'adapter',previousName:'星海实验室'},project);
 assert.equal(stale.name,'星海实验室（二群）');assert.equal(stale.staleName,true);assert.equal(stale.updated,false);
 // Management naming is human authority: later adapter syncs are ACKed but preserved.
 const scene=await w('scene',{operationId:'m1',sceneId:'group:chan-1',name:'人工定的群名',bindings:[room],expectedRev:3});
 assert.equal(scene.http,200,JSON.stringify(scene));assert.equal(scene.scene.nameSource,'manual');
 const kept=await w('ensureScene',{scope:room,name:'适配器再来',nameSource:'adapter'},project);
 assert.equal(kept.name,'人工定的群名');assert.equal(kept.manualPreserved,true);assert.equal(kept.updated,false);assert.equal(kept.nameSource,'manual');
 const admin2=await w('ensureScene',{scope:room,name:'适配器再来',nameSource:'adapter'});assert.equal(admin2.manualPreserved,true);
 const oldSubmission=await w('ensureScene',{scope:room,name:'星海实验室',nameSource:'adapter'},project);
 assert.equal(oldSubmission.name,'人工定的群名');assert.equal(oldSubmission.manualPreserved,true);
 const cyclic={kind:'group',id:'rename-cycle'};
 let previousName;
 for(const name of ['频道甲','频道乙','频道甲','频道乙']){
   const ack=await w('ensureScene',{scope:cyclic,name,nameSource:'adapter',...(previousName?{previousName}:{})},project);
   assert.equal(ack.name,name);assert.equal(ack.updated,true);
   assert.equal((await w('scenes',{scope:cyclic},project)).scenes[0].name,name);
   previousName=name;
 }
 // Without any write grant the name cannot be submitted at all.
 const denied=await w('ensureScene',{scope:room,name:'陌生人改名',nameSource:'adapter'},stranger);
 assert.equal(denied.http,403);
 assert.equal((await w('scenes',{scope:room},project)).scenes[0].name,'人工定的群名');
 // Project read-only credential still lists the scene; no cross-scope silent merge.
 assert.equal((await w('scenes',{scope:{kind:'group',id:'other'}},project)).scenes.length,0);
});
test('name sync survives restart and never merges people who share a display name',t=>{
 const dir=temporary(t),room={kind:'channel',id:'c9'};
 const first=new SceneMemory(dir);
 first.ensureScene({operationId:'n1',sceneId:'channel:c9',scope:room});
 assert.equal(first.ensureScene({operationId:'n2',sceneId:'channel:c9',scope:room,name:'频道甲'}).nameSource,'adapter');
 assert.equal(first.ensureScene({operationId:'n3',sceneId:'channel:c9',scope:room,name:'频道乙',previousName:'频道甲'}).updated,true);
 // Reopening replays the same stored name and the same protection answers.
 const reopened=new SceneMemory(dir);
 const keptName=reopened.ensureScene({operationId:'n4',sceneId:'channel:c9',scope:room,name:'频道丙',previousName:'频道甲'});
 assert.equal(keptName.name,'频道乙','a stale cursor acknowledges the stored name after restart');
 assert.equal(keptName.staleName,true);assert.equal(keptName.updated,false);
 assert.equal(new SceneMemory(dir).state().scenes['channel:c9'].name,'频道乙');
 // Two people registered under one display name stay two entities and two stars.
 const graph=new RelationshipGraph(path.join(dir,'graph')),log=new DurableLog(path.join(dir,'graph','messages.jsonl'),()=>{});
 for(const [id,actor] of [['m1','qq:11'],['m2','qq:22']]){const m={messageId:id,actorId:actor,role:'user',timestamp:Date.now(),scope:{kind:'group',id:'same'},conversationId:'x',text:'同名'};log.append(id,m,{message:m},{ok:true});}
 const sameName=[{id:'qq:11',kind:'person',displayName:'同名'},{id:'qq:22',kind:'person',displayName:'同名'}];
 const view=graph.project(log.rows,sameName,{scenes:{},links:{}},{admin:true,from:0});
 assert.equal(view.nodes.filter(n=>n.type==='person').length,2,'a shared display name never merges accounts');
 assert.equal(view.nodes.filter(n=>n.label==='同名').length,2);
});
test('confirmed account links are reversible and transitive without changing original IDs',t=>{
 const w=new SceneMemory(temporary(t));assert.throws(()=>w.link({operationId:'bad',a:'qq:1',b:'game:1'}),/confirm/i);
 const l=w.link({operationId:'link',a:'qq:1',b:'game:1',confirmed:true}).link;
 assert.deepEqual(w.accounts('game:1').sort(),['game:1','qq:1']);
 w.link({operationId:'unlink',a:l.a,b:l.b,active:false,expectedRev:l.rev,confirmed:true});assert.deepEqual(w.accounts('game:1'),['game:1']);
});
test('encrypted full and portable space backups reject wrong password and damage; never overwrite',t=>{
 const dir=temporary(t),root=path.join(dir,'root');initialize(root);
 fs.mkdirSync(path.join(root,'spaces','s'),{recursive:true});fs.writeFileSync(path.join(root,'spaces','s','state.json'),JSON.stringify({jobs:{pending:{status:'queued'},active:{status:'running'}},receipts:{old:{}}}));fs.writeFileSync(path.join(root,'spaces','s','settings.json'),JSON.stringify({llmApiKey:'secret',consolidateEnabled:true}));
 assert.throws(()=>createBackup(root),/password/i);
 const bytes=createBackup(root,{password:'password-123'});assert(!bytes.includes(Buffer.from('secret')));assert.throws(()=>inspectBackup(bytes,'wrong-password'),/password/i);
 const manifest=inspectBackup(bytes,'password-123');assert.equal(manifest.kind,'service');
 const restored=restoreBackup(bytes,path.join(dir,'restored'),{password:'password-123',expectedChecksum:manifest.checksum});assert.equal(restored.automaticTasksSuspended,true);
 const resumed=JSON.parse(fs.readFileSync(path.join(dir,'restored','spaces','s','state.json')));assert.equal(resumed.jobs.pending.status,'failed');assert.equal(resumed.jobs.active.error.code,'RESTORED_REVIEW_REQUIRED');assert.deepEqual(resumed.receipts,{});
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'restored','spaces','s','settings.json'))).consolidateEnabled,false);
 assert.throws(()=>restoreBackup(bytes,path.join(dir,'restored'),{password:'password-123'}),/new destination/i);
 const portable=inspectBackup(createBackup(root,{spaceId:'s'}));assert(!JSON.stringify(portable).includes('secret'));assert.equal(JSON.parse(Buffer.from(portable.files.find(f=>f.name==='settings.json').data,'base64')).llmApiKey,undefined);
 const archiveFile=path.join(dir,'cli.vmb');fs.writeFileSync(archiveFile,bytes);
 const cli=fileURLToPath(new URL('../tools/standalone-backup.mjs',import.meta.url)),env={...process.env,VEC_MEMORY_BACKUP_PASSWORD:'password-123'};
 const runCli=(...args)=>spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:20000});
 const bad=runCli('restore',archiveFile,path.join(dir,'cli-bad'),'wrong-checksum');assert.notEqual(bad.status,0);assert(!fs.existsSync(path.join(dir,'cli-bad')));
 const good=runCli('restore',archiveFile,path.join(dir,'cli-good'),manifest.checksum);assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).validated,true);
 const changed=JSON.parse(bytes);changed.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>inspectBackup(Buffer.from(JSON.stringify(changed)),'password-123'),/damaged/i);
});
test('real service scene/person APIs, backup/import and permission boundaries',async t=>{
 const root=temporary(t),admin=initialize(root),service=createService({root});t.after(()=>service.close());
 const call=async(route,body={},token=admin,method='POST')=>{const r=await service.handle({path:'/api/v1/'+route,method,token,body});return {...r.body,status:r.status};};
 const token=(await call('admin/projects',{projectId:'p'})).token;await call('admin/spaces',{spaceId:'s',owner:'p'});
 const w=(action,p={},tk=admin)=>call('spaces/s/workspace',{action,...p},tk);
 assert.equal((await w('state',{},token)).status,403);
 assert.equal((await w('scene',{operationId:'s',sceneId:'a',name:'A',bindings:[scope]})).status,200);
 const e=await w('entry',{operationId:'e',sceneId:'a',scope,text:'公开定位',shareable:true,confirm:true});assert.equal(e.status,200);
 const external=await w('query',{scope:outside},token);assert.equal(external.entries[0].text,'公开定位');assert.deepEqual(external.entries[0].evidence,[]);
 await call('spaces/s/entities/qq%3A1',{displayName:'A'},token,'PUT');await call('spaces/s/memories',{operationId:'m',actorId:'qq:1',source:'manual',kind:'trait',attr:'饮品',text:'绿茶',scope},token);
 let person=await call('spaces/s/people',{actorId:'qq:1',scope},token);assert.equal(person.profiles.length,1);
 const item=person.profiles[0];assert.equal((await call('spaces/s/people',{actorId:'qq:1',scope,action:'revision',operationId:'hide',op:'hide',target:{key:item.key,itemKey:item.itemKey},expectedEtag:item.etag,reason:'错误'})).status,200);
 const recalled=await call('spaces/s/recall',{query:'绿茶',scope},token);assert(!recalled.items.some(i=>i.layer==='profile'&&i.text.includes('绿茶')));
 const backup=await call('admin/backups',{spaceId:'s'});assert.equal(backup.status,200);
 const preview=await call('admin/backups/'+backup.backupId+'/preview');assert.equal(preview.kind,'space');
 const imported=await call('admin/backups/'+backup.backupId+'/restore',{expectedChecksum:preview.checksum,spaceId:'copy',owner:'p'});assert.equal(imported.status,200);
 assert.equal((await call('spaces/copy/status',{},token,'GET')).messages,0);
 assert.equal((await call('spaces/copy/people',{actorId:'qq:1',scope},token)).profiles[0].hidden,true);
 assert.equal((await call('admin/backups',{spaceId:'s'},token)).status,403);
 await call('spaces/s/entities/game%3Aplayer',{displayName:'Game Alice'},token,'PUT');
 await call('spaces/s/memories',{operationId:'game-habit',actorId:'game:player',source:'manual',kind:'trait',attr:'兴趣',text:'建造城堡',scope:{kind:'group',id:'game-room'}},token);
 const link=(await w('link',{operationId:'link',a:'qq:1',b:'game:player',confirmed:true})).link;assert(link);
 const combined=await call('spaces/s/people',{actorId:'qq:1',scope,allScopes:true});assert.equal(combined.profiles.length,2);assert(combined.profiles.some(i=>i.accountId==='game:player'&&i.value.includes('城堡')));
 assert.equal((await call('spaces/s/people',{actorId:'qq:1',scope,allScopes:true},token)).status,403);
 assert(!(await call('spaces/s/recall',{scope,actorIds:['qq:1']},token)).items.some(i=>i.text.includes('城堡')));
 await w('link',{operationId:'unlink',a:link.a,b:link.b,confirmed:true,active:false,expectedRev:link.rev});
 assert.equal((await call('spaces/s/people',{actorId:'qq:1',scope,allScopes:true})).profiles.length,1);
});

test('person correction previews and retracts dependent scenes, protects manual value after re-extraction and restart',async t=>{
 const root=temporary(t),admin=initialize(root);let service=createService({root});t.after(()=>service.close());
 const call=async(route,body={})=>{const r=await service.handle({path:'/api/v1/'+route,method:'POST',token:admin,body});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 await call('admin/projects',{projectId:'p'});await call('admin/spaces',{spaceId:'s',owner:'p'});
 let response=await service.handle({path:'/api/v1/spaces/s/entities/qq%3A1',method:'PUT',token:admin,body:{displayName:'A'}});assert.equal(response.status,200);
 const remember={actorId:'qq:1',source:'manual',kind:'trait',attr:'饮品',text:'绿茶',scope};
 await call('spaces/s/memories',{...remember,operationId:'tea'});
 const item=(await call('spaces/s/people',{actorId:'qq:1',scope})).profiles[0];
 await call('spaces/s/workspace',{action:'scene',operationId:'s',sceneId:'a',name:'A',bindings:[scope]});
 const child=(await call('spaces/s/workspace',{action:'entry',operationId:'derived',sceneId:'a',scope,text:'这个群都爱绿茶',confirm:true,derivedFrom:[item.id]})).entry;
 const p={actorId:'qq:1',scope,target:{key:item.key,itemKey:item.itemKey}},preview=await call('spaces/s/people',{...p,action:'preview'});assert.deepEqual(preview.proven,[child.id]);
 const correction={...p,action:'revision',operationId:'correct-tea',expectedEtag:item.etag,previewToken:preview.previewToken,op:'replace',value:'红茶',reason:'原印象错误'};
 await call('spaces/s/people',correction);await call('spaces/s/memories',{...remember,operationId:'old-evidence-again'});
 assert.equal((await call('spaces/s/people',{actorId:'qq:1',scope})).profiles[0].value,'红茶');
 assert.equal((await call('spaces/s/workspace',{action:'state'})).entries[child.id].status,'retracted');
 await service.close();service=createService({root});assert.equal((await call('spaces/s/people',{actorId:'qq:1',scope})).profiles[0].value,'红茶');
 assert.equal((await call('spaces/s/people',correction)).replayed,true);
});
