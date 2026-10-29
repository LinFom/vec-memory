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
 return {messageId,conversationId:chatKey,actorId,role:row.self===true?'assistant':'user',timestamp,text:String(row.text||''),scope};
}
/** Explicit, offline conversion. Reads only the copied snapshot and never contacts QQ or a model. */
export function importSnapshot({spaceRoot}) {
 if(!spaceRoot||!path.isAbsolute(spaceRoot))throw new Error('spaceRoot must be an explicit absolute path');spaceRoot=path.resolve(spaceRoot);
 const source=path.join(spaceRoot,'imported-source'),input=path.join(spaceRoot,'input');
 if(!fs.existsSync(path.join(spaceRoot,'migration-manifest.json'))||!fs.statSync(source).isDirectory())throw new Error('Requires a migration snapshot with imported-source');
 const evidence=readEvidenceRows({sourceRoot:source});if(evidence.badLines)throw new Error('Evidence snapshot has invalid JSON lines');
 const messages=[];
 if(!evidence.missing)for(const row of evidence.rows)messages.push(fromRow(row,String(row.chatKey||'')));
 else for(const {file}of listArchiveFiles(source)){const archive=readArchive(file);if(archive.error)throw new Error('Unreadable archive snapshot');const chatKey=archive.chatKey||path.basename(file).replace(/\.\d+\.json$|\.json$/g,'').replace(/^(private|group)_/,'$1:');for(const row of archive.messages)messages.push(fromRow(row,chatKey));}
 const vocabulary=buildVocabulary({dataDir:source}),prior=new Map(canonicalEntities(input).map(e=>[e.id,e]));
 for(const e of vocabulary.entities){const existing=prior.get(e.id);prior.set(e.id,{id:e.id,kind:e.kind,displayName:existing?.displayName||e.surface[0]||e.id,surfaces:[...new Set([...(existing?.surfaces||[]),...e.surface])],aliases:[...new Set([...(existing?.aliases||[]),...e.aliases])]});}
 const chunks=[];for(const info of listChunks(path.join(source,'memory-v2','chunks'))){const r=readChunk(path.join(source,'memory-v2','chunks'),info.id);if(r.error)throw new Error(`Unreadable original corpus item: ${info.id}`);chunks.push({...info,chunk:{...r.chunk,id:r.chunk.id||info.id,chatKey:r.chunk.chatKey||info.chatKey}});}
 fs.mkdirSync(input,{recursive:true});const log=new DurableLog(path.join(input,'messages.jsonl'),()=>{});log.assertReadable();
 // Validate the full batch before appending any conflicting historical message.
 const seen=new Map();for(const m of messages){const id=digest(m.messageId);if(seen.has(id)&&digest(seen.get(id))!==digest(m))throw new MemoryError('MESSAGE_CONFLICT','Conflicting IDs in import snapshot',409);seen.set(id,m);log.replay(id,m);}
 let imported=0,duplicates=0;for(const [id,m] of seen){if(log.replay(id,m)){duplicates++;continue;}log.append(id,m,{message:m},{ok:true,messageId:m.messageId});imported++;}
 atomic(path.join(input,'entities.json'),[...prior.values()]);const corpus=new Map(canonicalCorpus(input).map(c=>[c.id,c]));for(const c of chunks){const old=corpus.get(c.id);if(old&&digest(old)!==digest(c))throw new Error(`Canonical corpus conflict: ${c.id}`);corpus.set(c.id,c);}atomic(path.join(input,'corpus.json'),[...corpus.values()]);
 atomic(path.join(input,'source.json'),{version:1,kind:'canonical'});
 const result={ok:true,imported,duplicates,entities:prior.size,corpus:corpus.size,evidenceSource:evidence.missing?'archives':'evidence',sourceDependency:'none',activated:false};
 atomic(path.join(spaceRoot,'import-result.json'),{...result,at:new Date().toISOString()});return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const i=process.argv.indexOf('--space-root');console.log(JSON.stringify(importSnapshot({spaceRoot:i<0?'':process.argv[i+1]}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
