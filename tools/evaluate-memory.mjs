import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../test/fixtures/recall-labelled.json',import.meta.url))),root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-eval-'));
const engine=createSpaceEngine({root,maintenance:true});
try{
 let operation=0;
 for(const m of fixture.memories){await engine.call('entity',{entityId:m.actorId,displayName:m.displayName});await engine.call('remember',{...m,operationId:'fixture-'+ ++operation,kind:'preference',source:'manual'});}
 const rows=[];let relevant=0,returned=0,expected=0,falseInjection=0;
 for(const q of fixture.queries){const start=performance.now(),r=await engine.call('recall',q),items=r.items.filter(i=>i.layer==='semantic');
  const hits=items.filter(i=>q.expected.some(text=>i.text.includes(text))).length;
  relevant+=hits;returned+=items.length;expected+=q.expected.length;falseInjection+=items.some(i=>!q.expected.some(text=>i.text.includes(text)))?1:0;
  rows.push({id:q.id,expected:q.expected,actual:items.map(i=>i.text),correct:hits,actualMode:r.actualMode,latencyMs:Math.round(performance.now()-start)});
 }
 const result={fixtureVersion:fixture.version,queries:rows.length,precisionAt8:returned?relevant/returned:1,recallAt8:expected?relevant/expected:1,falseInjectionRate:falseInjection/rows.length,externalModelRequests:0,scope:'Synthetic keyword semantic retrieval only; not a claim about production LLM accuracy or comparative superiority',rows};
 const output=process.argv[2];if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await engine.close();fs.rmSync(root,{recursive:true,force:true});}
