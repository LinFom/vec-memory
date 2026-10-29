import fs from 'node:fs';
import path from 'node:path';
import { DurableLog, digest, MemoryError } from './durable-log.mjs';

export const isCanonicalSource = root => fs.existsSync(path.join(root, 'source.json'));
export function canonicalMessages(root) {
  const log = new DurableLog(path.join(root, 'messages.jsonl'), () => {});
  log.assertReadable();
  return log.rows.map(r => r.data.message);
}
export function canonicalEntities(root) {
  const file = path.join(root, 'entities.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}
export function canonicalFingerprint(root) {
  const messages = canonicalMessages(root), entities = canonicalEntities(root),corpus=canonicalCorpus(root);
  return {sig:digest({messages,entities,corpus}),files:3,bytes:Buffer.byteLength(JSON.stringify({messages,entities,corpus}))};
}
export function canonicalChatKey(scope) {
  if (!scope || !['private','group'].includes(scope.kind) || typeof scope.id !== 'string' || !scope.id.trim() || scope.id.length > 180) throw new MemoryError('INVALID_SCOPE','scope requires kind private/group and a stable id');
  return `${scope.kind}:${scope.id.trim()}`;
}
export function canonicalEvidence(root) {
  const entities = new Map(canonicalEntities(root).map(e => [e.id,e]));
  return canonicalMessages(root).map(m => ({id:m.messageId,chatKey:canonicalChatKey(m.scope),ts:m.timestamp,
    speakerId:m.actorId,speakerName:entities.get(m.actorId)?.displayName || m.actorId,
    text:m.text,self:m.role==='assistant',role:m.role,conversationId:m.conversationId,
    mentions:m.mentions || [],replyTo:m.replyTo || null}));
}
export function canonicalSources(root) {
  const byChat = new Map();
  for(const r of canonicalEvidence(root)) {
    if(!byChat.has(r.chatKey)) byChat.set(r.chatKey,[]);
    byChat.get(r.chatKey).push({...r,senderId:r.speakerId,senderName:r.speakerName});
  }
  return [...byChat].map(([chatKey,messages])=>({chatKey,messages}));
}
export function canonicalVocabulary(root, previous=[]) {
  const rows=canonicalMessages(root), map=new Map(previous.map(e=>[e.id,{...e,surface:[...(e.surface||[])],aliases:[...(e.aliases||[])]}]));
  for(const e of canonicalEntities(root)) map.set(e.id,{id:e.id,kind:e.kind||'person',surface:[e.displayName,...(e.surfaces||[])].filter(Boolean),aliases:e.aliases||[]});
  for(const m of rows) {
    if(map.has(m.actorId)) continue;
    const known=[...map.values()].find(e=>e.aliases.includes(m.actorId)||(/^\d+$/.test(m.actorId)&&e.id===`qq:${m.actorId}`));
    if(known) {if(!known.aliases.includes(m.actorId))known.aliases.push(m.actorId);}
    else map.set(m.actorId,{id:m.actorId,kind:'person',surface:[],aliases:[]});
  }
  const range=rows.reduce((a,r)=>({start:Math.min(a.start,r.timestamp),end:Math.max(a.end,r.timestamp)}),{start:Infinity,end:0}),start=rows.length?range.start:0,end=range.end;
  return {entities:[...map.values()],horizon:{start:start?new Date(start).toISOString():null,end:end?new Date(end).toISOString():null,days:(end-start)/86400000,messages:rows.length},identity:{source:'protocol',selfId:null},stats:{messages:rows.length,entities:map.size,source:'protocol'}};
}

export function canonicalCorpus(root) { const file=path.join(root,'corpus.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[]; }
