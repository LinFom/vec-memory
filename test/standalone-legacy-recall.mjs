import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRouter} from '../src/index.mjs';
import {getRuntime,disposeMemoryVec} from '../src/core/backend.mjs';

test('legacy inject finds absent B by name and caps automatic keyword fields without exposing records',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-legacy-third-'));
  const router=createRouter({dataRoot:root,settings:{getSkillConfig:(_,defaults)=>({...defaults,embedBaseURL:'',embedModel:'',consolidateEnabled:false,autoIndexEnabled:false})}});
  const rt=await getRuntime();
  t.after(()=>{disposeMemoryVec();fs.rmSync(root,{recursive:true,force:true});});
  for(let n=0;!rt.lastIdentityCheck&&n<200;n++)await new Promise(r=>setTimeout(r,10));
  rt.normalizer.setVocabulary([{id:'qq:11111',kind:'person',surface:['甲同学']},{id:'qq:22222',kind:'person',surface:['乙同学']},{id:'group:42',kind:'group',surface:['测试群']}]);
  const post=(route,body)=>router.handle({path:route,method:'POST',body});
  for(const [attr,text]of [['职业','园艺师'],['家乡','杭州'],['喜好','玫瑰']]){
    const saved=await post('/remember',{chatKey:'group:42',userId:'22222',kind:'trait',attr,text});assert.equal(saved.status,200);
  }
  const request={chatKey:'group:42',people:[{id:'11111'}],topic:'乙同学的职业',purpose:'automatic',rehearsal:'deferred'};
  const auto=await post('/inject',request);assert.equal(auto.body.ok,true);
  assert.match(auto.body.block,/乙同学[^\n]*职业=园艺师/);
  assert.equal(auto.body.profileLines.length+auto.body.lines.length,2);
  assert(auto.body.profileLines.every(l=>!l.rec&&!l.sourceSlots));
  assert.equal(auto.body.simMetric,'token-overlap');
  const unrelated=await post('/inject',{...request,people:[{id:'22222'}],topic:'火箭发射'});
  assert.equal(unrelated.body.profileLines.length+unrelated.body.lines.length,0);
  const full=await post('/inject',{...request,purpose:'query'});
  assert.match(full.body.block,/杭州/);assert.match(full.body.block,/玫瑰/);
});
