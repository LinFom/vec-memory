import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('actual registered tools explain everyday uses and adapt verified current evidence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-tool-contract-')),old=globalThis.fetch,oldDir=process.env.QQ_AGENT_DATA_DIR;process.env.QQ_AGENT_DATA_DIR=dir;
 const tools=[],calls=[],cfg={protocolV1:true,serviceBaseURL:'http://127.0.0.1:8091',spaceId:'demo',serviceToken:'test',rememberCheckpointEnabled:false};
 const row={id:9,senderId:'123456',ts:Date.now(),text:'冰箱战术指先搁置问题',self:false};let mod;
 try{
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body||'{}');calls.push({url,body});return {ok:true,json:async()=>url.endsWith('/messages')?{ok:true,results:body.messages.map(m=>({messageId:m.messageId,status:'accepted'}))}:{ok:true,items:[],discovery:{state:'candidate'}}};};
 mod=await import('./index.js?tool-contract='+Date.now());mod.setup({config:()=>cfg,registerTool:t=>tools.push(t)});
 const thing=tools.find(t=>t.id==='remember_thing'),remember=tools.find(t=>t.id==='remember');assert(thing);assert.deepEqual(thing.parameters.required,['name']);assert(!thing.parameters.properties.scope);assert(!thing.parameters.properties.operationId);
 assert.doesNotMatch(remember.description,/稳定印象|不记：一次性/);assert.match(remember.parameters.properties.evidence.description,/没有可核对来源会明确失败/);
 mod.activate({dataDir:dir,store:{listChats:()=>['group:42'],recent:()=>[row]}});
 await mod.hooks['before-context']({chatKey:'group:42',triggerEntries:[{id:9,sender:{id:'123456'},text:row.text}]});
 const guided={chatKey:'group:42',messages:[{role:'user',content:'刚解释的新梗'}]};await mod.hooks['before-llm-messages'](guided);assert.match(guided.messages[0].content,/mv-guide/);
 cfg.rememberGuideEnabled=false;const disabled={chatKey:'group:42',messages:[{role:'user',content:'关闭提示'}]};await mod.hooks['before-llm-messages'](disabled);assert.doesNotMatch(disabled.messages[0].content,/mv-guide/);
 const result=await thing.execute({chatKey:'group:42'},{name:'冰箱战术',statement:'先搁置问题'});assert.equal(result.isError,false);
 const request=calls.find(c=>c.url.endsWith('/discoveries'));assert.deepEqual(request.body.evidenceIds,['group:42:9']);assert.equal(request.body.scope.id,'42');assert(request.body.operationId);assert.equal(request.body.interpretation,'definition');
 const pending=await thing.execute({chatKey:'group:42'},{name:'冰箱战术'});assert.equal(pending.isError,false);assert.equal(calls.filter(c=>c.url.endsWith('/discoveries')).at(-1).body.interpretation,'mention');
 const missing=await thing.execute({chatKey:'group:other'},{name:'新词',statement:'尚无解释'});assert.equal(missing.isError,true);assert.match(missing.content,/没有可核对|还没有可核对/);
 const trusted=await thing.execute({chatKey:'group:another',evidenceId:'999',store:{recent:()=>[row]}},{name:'幽灵'});assert.equal(trusted.isError,true);
 const exact=await remember.execute({chatKey:'group:42'},{userId:'123456',text:'喝茶不加糖',evidence:['group:42:9']});assert.equal(exact.isError,false);assert.deepEqual(calls.find(c=>c.url.endsWith('/memories')).body.evidenceIds,['group:42:9']);
 }finally{mod?.deactivate();globalThis.fetch=old;if(oldDir===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true})}
});

test('legacy protocol does not expose an unavailable thing writer',async()=>{
 const tools=[],mod=await import('./index.js?legacy-contract='+Date.now());
 mod.setup({config:()=>({protocolV1:false}),registerTool:t=>tools.push(t)});
 assert(!tools.some(t=>t.id==='remember_thing'));assert.doesNotMatch(tools.find(t=>t.id==='remember').description,/remember_thing/);
});

test('actual thing tool writes and recalls through standalone HTTP',{skip:!process.env.VEC_MEMORY_ROOT},async()=>{
 const {pathToFileURL}=await import('node:url');
 const {initialize}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/service.mjs')));
 const {createStandaloneServer}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/server.mjs')));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-thing-live-')),oldDir=process.env.QQ_AGENT_DATA_DIR;process.env.QQ_AGENT_DATA_DIR=path.join(dir,'host');let runtime,mod;
 try{
  const admin=initialize(path.join(dir,'library'));runtime=createStandaloneServer({root:path.join(dir,'library')});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+runtime.server.address().port;
  const api=async(route,body)=>{const r=await fetch(base+'/api/v1/'+route,{method:'POST',headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d};
  const project=await api('admin/projects',{projectId:'qq'});await api('admin/spaces',{spaceId:'qq',owner:'qq'});
  const tools=[],row={id:1,ts:Date.now(),senderId:'12345',text:'冰箱战术就是先搁置问题',self:false};
  mod=await import('./index.js?thing-live='+Date.now());mod.setup({config:()=>({protocolV1:true,serviceBaseURL:base,serviceToken:project.token,spaceId:'qq',rememberCheckpointEnabled:false}),registerTool:t=>tools.push(t)});
  mod.activate({dataDir:path.join(dir,'host'),store:{listChats:()=>['group:42'],recent:()=>[row]}});
  await mod.hooks['before-context']({chatKey:'group:42',triggerEntries:[{id:1,sender:{id:'12345'}}]});
  const result=await tools.find(t=>t.id==='remember_thing').execute({chatKey:'group:42'},{name:'冰箱战术',statement:'先搁置问题'});assert.equal(result.isError,false,result.content);
  const ctx={chatKey:'group:42',messages:[{role:'user',content:'冰箱战术是什么意思？'}]};await mod.hooks['before-llm-messages'](ctx);assert.match(ctx.messages[0].content,/来源观察.*冰箱战术/);assert.match(ctx.messages[0].content,/先搁置问题/);
 }finally{mod?.deactivate();if(runtime)await runtime.close();if(oldDir===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true})}
});
