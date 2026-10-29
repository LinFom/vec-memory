import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DurableLog,digest,MemoryError} from '../src/core/durable-log.mjs';
import {canonicalEntities,canonicalCorpus} from '../src/core/input-source.mjs';
import {readEvidenceRows,tsOfRow} from '../src/core/consolidate.mjs';
import {buildVocabulary,listArchiveFiles,readArchive} from '../src/core/vocab.mjs';
import {listChunks,readChunk} from '../src/core/chunkread.mjs';
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.import.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
function scopeOf(chatKey){const match=/^(private|group):(.+)$/.exec(chatKey);if(!match)throw new Error('Legacy message has no explicit private/group chatKey');return {kind:match[1],id:match[2]};}
function fromRow(row,chatKey){
 const actorId=String(row.speakerId||row.senderId||row.sender?.id||''),messageId=String(row.id??row.messageId??'');
 const timestamp=tsOfRow(row);if(!actorId||!messageId||!timestamp)throw new Error('Legacy message lacks stable messageId, actorId or timestamp; cannot fabricate evidence');
 const scope=scopeOf(chatKey);
 const rawText=String(row.text||'');
 return {messageId,conversationId:chatKey,actorId,role:row.self?'assistant':'user',timestamp,text:rawText.replace(/\[CQ:at,qq=(\d+)\]/g,'').replace(/\[CQ:[^\]]+\]/g,''),scope,mentions:[...rawText.matchAll(/\[CQ:at,qq=(\d+)\]/g)].map(m=>m[1]),...(row.reply?.mid!=null?{replyTo:`${chatKey}:${row.reply.mid}`}:{})};
}
/** Explicit, offline conversion. Reads only the copied snapshot and never contacts QQ or a model. */
export function importSnapshot({spaceRoot}) {
 if(!spaceRoot||!path.isAbsolute(spaceRoot))throw new Error('spaceRoot must be an explicit absolute path');spaceRoot=path.resolve(spaceRoot);
 const source=path.join(spaceRoot,'imported-source'),input=path.join(spaceRoot,'input');
 if(!fs.existsSync(path.join(spaceRoot,'migration-manifest.json'))||!fs.statSync(source).isDirectory())throw new Error('Requires a migration snapshot with imported-source');
 const evidence=readEvidenceRows({sourceRoot:source});if(evidence.badLines)throw new Error('Evidence snapshot has invalid JSON lines');
 const messages=[],platformIndex=new Map(),evidenceAliases={};
 let archiveRows=0,archiveMatchedEvidence=0,ambiguousEvidence=0;
 const signature=(m,platformId)=>digest([m.conversationId,String(platformId),m.actorId,m.role,m.timestamp,m.text]);
 for(const {file}of listArchiveFiles(source)){
   const archive=readArchive(file);if(archive.error)throw new Error('Unreadable archive snapshot');
   const chatKey=archive.chatKey||path.basename(file).replace(/\.\d+\.json$|\.json$/g,'').replace(/^(private|group)_/,'$1:');
   for(const row of archive.messages){archiveRows++;const m=fromRow(row,chatKey);m.messageId=`${chatKey}:${m.messageId}`;messages.push(m);
     if(row.mid!=null){const key=signature(m,row.mid),ids=platformIndex.get(key)||[];ids.push(m.messageId);platformIndex.set(key,ids);}
   }
 }
 for(const row of evidence.rows){const m=fromRow(row,String(row.chatKey||'')),ids=platformIndex.get(signature(m,m.messageId));
   if(ids?.length===1){evidenceAliases[m.messageId]=ids[0];archiveMatchedEvidence++;}
   else {if(ids?.length>1)ambiguousEvidence++;messages.push(m);}
 }
 const vocabulary=buildVocabulary({dataDir:source}),prior=new Map(canonicalEntities(input).map(e=>[e.id,e]));
 for(const e of vocabulary.entities){const existing=prior.get(e.id);prior.set(e.id,{id:e.id,kind:e.kind,displayName:existing?.displayName||e.surface[0]||e.id,surfaces:[...new Set([...(existing?.surfaces||[]),...e.surface])],aliases:[...new Set([...(existing?.aliases||[]),...e.aliases])]});}
 const chunks=[];for(const info of listChunks(path.join(source,'memory-v2','chunks'))){const r=readChunk(path.join(source,'memory-v2','chunks'),info.id);if(r.error)throw new Error(`Unreadable original corpus item: ${info.id}`);chunks.push({...info,chunk:{...r.chunk,id:r.chunk.id||info.id,chatKey:r.chunk.chatKey||info.chatKey}});}
 fs.mkdirSync(input,{recursive:true});const log=new DurableLog(path.join(input,'messages.jsonl'),()=>{});log.assertReadable();
 // Validate the full batch before appending any conflicting historical message.
 const seen=new Map();for(const m of messages){const id=digest(m.messageId);if(seen.has(id)&&digest(seen.get(id))!==digest(m))throw new MemoryError('MESSAGE_CONFLICT','Conflicting IDs in import snapshot',409);seen.set(id,m);log.replay(id,m);}
 let imported=0,duplicates=0;
 const additions=[];for(const [id,m] of seen){if(log.replay(id,m)){duplicates++;continue;}additions.push([id,m]);}
 // Offline batch commit: frame each row identically to DurableLog, fsync the complete
 // replacement, then atomically publish. No imported message is acknowledged early.
 if(additions.length){const temporary=path.join(input,`messages.import-${process.pid}-${Date.now()}.tmp`);let fd;
   try{
     if(log.bytes)fs.copyFileSync(log.file,temporary,fs.constants.COPYFILE_EXCL);
     fd=fs.openSync(temporary,log.bytes?'a':'wx');let seq=log.rows.length,previous=log.rows.at(-1)?.hash||'';
     for(const [operationId,m]of additions){const payload={version:1,seq:++seq,previous,operationId,fingerprint:digest(m),data:{message:m},result:{ok:true,messageId:m.messageId}},row={...payload,hash:digest(payload)};
       const bytes=Buffer.from(JSON.stringify(row)+'\n');let written=0;while(written<bytes.length){const n=fs.writeSync(fd,bytes,written,bytes.length-written);if(!n)throw new Error('Short import write');written+=n;}previous=row.hash;imported++;
     }
     fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,log.file);
   }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 }
 atomic(path.join(input,'entities.json'),[...prior.values()]);const corpus=new Map(canonicalCorpus(input).map(c=>[c.id,c]));for(const c of chunks){const old=corpus.get(c.id);if(old&&digest(old)!==digest(c))throw new Error(`Canonical corpus conflict: ${c.id}`);corpus.set(c.id,c);}atomic(path.join(input,'corpus.json'),[...corpus.values()]);
 atomic(path.join(input,'evidence-aliases.json'),evidenceAliases);
 atomic(path.join(input,'source.json'),{version:1,kind:'canonical'});
 const result={ok:true,imported,duplicates,evidenceRows:evidence.rows.length,archiveRows,archiveMatchedEvidence,ambiguousEvidence,entities:prior.size,corpus:corpus.size,evidenceSource:evidence.missing?'archives':'evidence+archives',sourceDependency:'none',activated:false};
 atomic(path.join(spaceRoot,'import-result.json'),{...result,at:new Date().toISOString()});return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const i=process.argv.indexOf('--space-root');console.log(JSON.stringify(importSnapshot({spaceRoot:i<0?'':process.argv[i+1]}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
