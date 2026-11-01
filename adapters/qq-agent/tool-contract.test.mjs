import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

test('legacy search tool deliberately queries a named person with current scope and stable target',async()=>{
 const tools=[],calls=[],previous=globalThis.fetch;let mod;
 try{
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,lines:[],profileLines:[{who:'乙',line:'职业=园艺师 / 家乡=杭州'}],block:'乙：职业=园艺师 / 家乡=杭州'}));};
  mod=await import('./index.js?legacy-person-query='+Date.now());
  mod.setup({config:()=>({protocolV1:false,serviceBaseURL:'http://localhost:8091'}),registerTool:t=>tools.push(t)});
  const result=await tools.find(t=>t.id==='search').execute({chatKey:'private:11111'},{q:'乙的职业',userId:'22222'});
  assert.equal(result.isError,false);assert.match(result.content,/园艺师.*杭州/);
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/api\/vec\/inject$/);
  assert.equal(calls[0].body.purpose,'query');assert.equal(calls[0].body.chatKey,'private:11111');
  assert.deepEqual(calls[0].body.people,[{id:'22222',name:'22222'}]);
 }finally{mod?.deactivate();globalThis.fetch=previous;}
});
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
  const scene=await tools.find(t=>t.id==='remember_scene').execute({chatKey:'group:42'},{text:'本群把先搁置问题叫冰箱战术',kind:'meme'});assert.equal(scene.isError,false,scene.content);
  const ownScene=await tools.find(t=>t.id==='query_scene').execute({chatKey:'group:42'},{sceneId:'group:42'});assert.match(ownScene.content,/冰箱战术/);
  const otherChannel=await tools.find(t=>t.id==='query_scene').execute({chatKey:'private:12345'},{sceneId:'group:42'});assert.doesNotMatch(otherChannel.content,/冰箱战术/);
  const ctx={chatKey:'group:42',messages:[{role:'user',content:'冰箱战术是什么意思？'}]};await mod.hooks['before-llm-messages'](ctx);assert.match(ctx.messages[0].content,/来源观察.*冰箱战术/);assert.match(ctx.messages[0].content,/先搁置问题/);
 }finally{mod?.deactivate();if(runtime)await runtime.close();if(oldDir===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true})}
});

test('real HTTP injects a named non-speaking member profile from service entities',{skip:!process.env.VEC_MEMORY_ROOT},async()=>{
 const {pathToFileURL}=await import('node:url');
 const {initialize}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/service.mjs')));
 const {createStandaloneServer}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/server.mjs')));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-third-person-inject-')),oldDir=process.env.QQ_AGENT_DATA_DIR;process.env.QQ_AGENT_DATA_DIR=path.join(dir,'host');let runtime,mod;
 try{
  const admin=initialize(path.join(dir,'library'));runtime=createStandaloneServer({root:path.join(dir,'library')});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+runtime.server.address().port;
  const api=async(route,body)=>{const r=await fetch(base+'/api/v1/'+route,{method:'POST',headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d};
  const put=async(entityId,body)=>{const r=await fetch(base+'/api/v1/spaces/qq/entities/'+entityId,{method:'PUT',headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d};
  const project=await api('admin/projects',{projectId:'qq'});await api('admin/spaces',{spaceId:'qq',owner:'qq'});
  await put('11111',{displayName:'甲同学'});await put('22222',{displayName:'乙同学'});
  const scope={kind:'group',id:'42'};
  await api('spaces/qq/memories',{operationId:'seed-b-trait',actorId:'22222',scope,source:'manual',kind:'trait',attr:'职业',text:'园艺师'});
  const row={id:1,ts:Date.now(),senderId:'11111',senderName:'甲同学',text:'乙同学是什么职业',self:false},tools=[];
  mod=await import('./index.js?third-person-inject='+Date.now());mod.setup({config:()=>({protocolV1:true,serviceBaseURL:base,serviceToken:project.token,spaceId:'qq',rememberCheckpointEnabled:false}),registerTool:t=>tools.push(t)});
  mod.activate({dataDir:path.join(dir,'host'),store:{listChats:()=>['group:42'],recent:()=>[row]}});
  await mod.hooks['before-context']({chatKey:'group:42',triggerEntries:[{id:1,sender:{id:'11111',name:'甲同学'},text:row.text}]});
  const ctx={chatKey:'group:42',messages:[{role:'user',content:'甲同学(11111)：乙同学是什么职业'}]};await mod.hooks['before-llm-messages'](ctx);
  assert.match(ctx.messages[0].content,/乙同学[^\n]*职业=园艺师/,'B 没发言但被 A 点名时，before-context+before-llm-messages 必须注入 B 的 trait 档案');
  const searched=await tools.find(t=>t.id==='search').execute({chatKey:'group:42'},{q:'乙同学的职业',userId:'22222'});assert.equal(searched.isError,false);assert.match(searched.content,/园艺师/);
 }finally{mod?.deactivate();if(runtime)await runtime.close();if(oldDir===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true})}
});

test('real remember tool stores a CQ-mentioned third person trait and keeps it off A',{skip:!process.env.VEC_MEMORY_ROOT},async()=>{
 const {pathToFileURL}=await import('node:url');
 const {initialize}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/service.mjs')));
 const {createStandaloneServer}=await import(pathToFileURL(path.join(process.env.VEC_MEMORY_ROOT,'src/standalone/server.mjs')));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-third-person-remember-')),oldDir=process.env.QQ_AGENT_DATA_DIR;process.env.QQ_AGENT_DATA_DIR=path.join(dir,'host');let runtime,mod;
 try{
  const admin=initialize(path.join(dir,'library'));runtime=createStandaloneServer({root:path.join(dir,'library')});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+runtime.server.address().port;
  const api=async(route,body)=>{const r=await fetch(base+'/api/v1/'+route,{method:'POST',headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d};
  const put=async(entityId,body)=>{const r=await fetch(base+'/api/v1/spaces/qq/entities/'+entityId,{method:'PUT',headers:{Authorization:'Bearer '+admin,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d};
  const project=await api('admin/projects',{projectId:'qq'});await api('admin/spaces',{spaceId:'qq',owner:'qq'});
  await put('11111',{displayName:'甲同学'});
  const scope={kind:'group',id:'42'},row={id:1,ts:Date.now(),senderId:'11111',senderName:'甲同学',text:'[CQ:at,qq=22222] 乙同学的职业是园艺师',self:false},tools=[];
  mod=await import('./index.js?third-person-remember='+Date.now());mod.setup({config:()=>({protocolV1:true,serviceBaseURL:base,serviceToken:project.token,spaceId:'qq',rememberCheckpointEnabled:false}),registerTool:t=>tools.push(t)});
  mod.activate({dataDir:path.join(dir,'host'),store:{listChats:()=>['group:42'],recent:()=>[row]}});
  await mod.hooks['before-context']({chatKey:'group:42',triggerEntries:[{id:1,sender:{id:'11111',name:'甲同学'},text:row.text}]});
  const remember=tools.find(t=>t.id==='remember');assert(remember);
  const result=await remember.execute({chatKey:'group:42'},{userId:'22222',kind:'trait',attr:'职业',text:'园艺师',evidence:['group:42:1']});
  assert.equal(result.isError,false,result.content);
  const b=await api('spaces/qq/people',{actorId:'22222',scope}),bp=(b.profiles||[]).find(p=>p.itemKey==='职业'&&p.value==='园艺师'),problems=[];
  if(!bp)problems.push('B 的档案里没有职业=园艺师：'+JSON.stringify(b));
  else {
   if(String(bp.accountId||'').replace(/^qq:/,'')!=='22222')problems.push('B 的真实身份不是结构化 CQ 提及的 22222，而是 '+(bp.accountId||''));
   if(!/group:42:1/.test(JSON.stringify(bp)))problems.push('B 的档案没有保留 A 这条已接收消息 group:42:1 作为来源');
  }
  const a=await api('spaces/qq/people',{actorId:'11111',scope});
  if((a.profiles||[]).some(p=>p.itemKey==='职业'&&p.value==='园艺师'))problems.push('A 的档案错误地得到了 B 的职业');
  const rememberTool=tools.find(t=>t.id==='remember'),userDoc=String(rememberTool?.parameters?.properties?.userId?.description||''),docs=`${rememberTool?.description||''} ${userDoc}`;
  if(!/(?:被描述|所描述|描述的人|关于谁)/.test(userDoc))problems.push('userId 描述没有说明它是被描述的人');
  if(!/(?:不是|而非|而不是)[^。；;]{0,30}(?:说话人|发言者|发言人)/.test(docs))problems.push('工具描述没有明确 userId 不是固定的当前说话人');
  assert.deepEqual(problems,[],problems.join('；'));
 }finally{mod?.deactivate();if(runtime)await runtime.close();if(oldDir===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true})}
});
