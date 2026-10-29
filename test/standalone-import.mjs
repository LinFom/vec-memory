import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Normalizer} from '../src/core/normalize.mjs';import {openFactStore} from '../src/core/factstore.mjs';import {VecStore} from '../src/core/vecstore.mjs';import {listCorpus} from '../src/core/corpus.mjs';
import {migrate} from '../tools/standalone-migrate.mjs';import {importSnapshot} from '../tools/standalone-import.mjs';import {createSpaceEngine} from '../src/standalone/engine.mjs';
test('offline import preserves evidence IDs, original labels, facts and indexed documents without a host source',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vec-offline-import-'));let engine;
 try{
 const from=path.join(temp,'old'),lib=path.join(from,'memory-vec'),sourceRoot=path.join(temp,'host'),to=path.join(temp,'new'),chatKey='group:123456',ts=Date.now()-600000;
 fs.mkdirSync(path.join(sourceRoot,'memory'),{recursive:true});fs.mkdirSync(path.join(sourceRoot,'memory-v2','chunks'),{recursive:true});
 const row={id:'original-message-123',speakerId:'1234567',speakerName:'Alice',chatKey,at:ts,text:'喜欢绿茶，周末约好露营'};
 fs.writeFileSync(path.join(sourceRoot,'memory','evidence.jsonl'),JSON.stringify(row)+'\n');
 const chunkId='hour_group_123456_2026-10-2810';fs.writeFileSync(path.join(sourceRoot,'memory-v2','chunks',chunkId+'.json'),JSON.stringify({id:chunkId,chatKey,summary:'周末去露营，记得带绿茶',title:'露营',keywords:['露营'],hourKey:'2026-10-28 10'}));
 const normalizer=new Normalizer({dir:path.join(lib,'normalizer')});normalizer.setVocabulary([{id:'qq:1234567',kind:'person',surface:['Alice'],aliases:['1234567']}]);normalizer.save();
 const speaker=normalizer.resolveKnown('1234567').label,scope=normalizer.scopeLabel(chatKey),facts=openFactStore(path.join(lib,'facts'));
 facts.put({speaker,target:'',fact_kind:'preference',scope,content:{text:'喜欢绿茶',source:'assistant-remember'},evidenceIds:[row.id],provenance:[{type:'message',id:row.id,chatKey}],at:new Date().toISOString()});
 const vectors=new VecStore(lib);vectors.put({id:chunkId,meta:{kind:'hour',chatKey,text:'周末去露营，记得带绿茶',title:'露营'},vector:[1,0,0],model:'legacy-model'});
 const {spaceRoot}=migrate({from,to,sourceRoot,spaceId:'qq-a'});
 let result=importSnapshot({spaceRoot});assert.equal(result.imported,1);assert.equal(result.corpus,1);assert.equal(importSnapshot({spaceRoot}).duplicates,1);
 const corpus=listCorpus(path.join(spaceRoot,'input'));assert(corpus.some(c=>c.id===chunkId&&c.chunk.summary.includes('露营')));
 fs.renameSync(sourceRoot,path.join(temp,'removed-host'));fs.renameSync(path.join(spaceRoot,'imported-source'),path.join(spaceRoot,'unused-snapshot'));
 engine=createSpaceEngine({root:spaceRoot});const recalled=await engine.call('recall',{query:'露营',scope:{kind:'group',id:'123456'},actorIds:['1234567']});
 assert(recalled.items.some(i=>i.layer==='semantic'&&i.sourceRefs.some(r=>r.id===row.id)));assert(recalled.items.some(i=>i.layer==='long-term'&&i.text.includes('露营')));
 const entity=await engine.call('entity',{entityId:'1234567',displayName:'Alice new'});assert.equal(entity.label,speaker);
 assert((await engine.call('recall',{query:'绿茶',scope:{kind:'group',id:'123456'},actorIds:['1234567']})).items.some(i=>i.layer==='semantic'));
 }finally{await engine?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
