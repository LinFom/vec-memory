import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
import {VecStore} from '../src/core/vecstore.mjs';
import {openActiveVectors} from '../src/core/vector-generation.mjs';

test('explicit event reembedding retains the old generation until all source records can be rebuilt',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vec-reembed-events-'));
  let calls=0,failSecond=true;
  const endpoint=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);calls++;
    if(failSecond&&calls===3){res.writeHead(402,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'quota exhausted'}}));return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0.5,0.25,1]}))}));
  });
  await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
  const dir=path.join(root,'legacy/data/memory-vec');
  const legacy=new VecStore(dir,{model:'old-model'});
  legacy.put({id:'event-one',model:'old-model',vector:[1,0,0,0],meta:{kind:'event',title:'old',text:'old',sourceHash:'old'}});
  legacy.put({id:'event-two',model:'old-model',vector:[0,1,0,0],meta:{kind:'event',title:'old two',text:'old two',sourceHash:'old-two'}});
  await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({embedBaseURL:`http://127.0.0.1:${endpoint.address().port}`,embedModel:'new-model',embedDimensions:4}));
  const engine=createSpaceEngine({root,maintenance:true});
  t.after(async()=>{await engine.close();await new Promise(r=>endpoint.close(r));await fs.rm(root,{recursive:true,force:true});});
  await engine.call('ingest',{messages:[{messageId:'source',scope:{kind:'private',id:'one'},conversationId:'one',actorId:'user',role:'user',timestamp:Date.now()-10000,text:'A quiet library visit and reading a book.'}]});
  await assert.rejects(engine.call('job',{type:'index'}),/来源身份|source/i);
  assert.equal(calls,1);
  await assert.rejects(engine.call('job',{type:'index',reembedEvents:true}),/original event records/);
  assert.equal(calls,1,'Missing event records are checked before any event embedding request');
  const eventDir=path.join(dir,'consolidate');await fs.mkdir(eventDir,{recursive:true});
  await fs.writeFile(path.join(eventDir,'events.jsonl'),['event-one','event-two'].map(id=>JSON.stringify({id,chatKey:'private:one',fromTs:Date.now()-2000,toTs:Date.now()-1000,title:'Library visit',summary:'Read a book in the library.'})).join('\n')+'\n');
  await assert.rejects(engine.call('job',{type:'index',reembedEvents:true}),/quota|余额|额度/i);
  await assert.rejects(fs.access(path.join(dir,'vector-active.json')));
  assert.equal(calls,3);failSecond=false;
  const result=await engine.call('job',{type:'index',reembedEvents:true});
  assert.equal(result.reembeddedEvents,1);assert.equal(calls,4);
  const active=openActiveVectors(dir),row=active.get('event-one');
  assert.equal(row.meta.model,'new-model');assert.equal(row.meta.kind,'event');
  assert.equal(legacy.get('event-one').meta.model,'old-model','Source metadata was not relabeled');
  await engine.call('job',{type:'index',reembedEvents:true});
  assert.equal(calls,4,'A completed rebuild is not billed again');
});
