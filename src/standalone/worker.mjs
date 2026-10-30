import fs from 'node:fs';
import path from 'node:path';
import {parentPort,workerData} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {DurableLog,MemoryError,requireText,digest} from '../core/durable-log.mjs';
import {canonicalMessages,canonicalEntities,canonicalChatKey,bindCanonicalMessages} from '../core/input-source.mjs';
import {createRouter} from '../transport/inproc.mjs';
import {bindHost} from '../core/host.mjs';
import {getRuntime,ensureIdentity,DEFAULT_SETTINGS,factStoreOf,endpointOf,runConsolidateNow,runIndex} from '../core/backend.mjs';
import {buildInjectCandidates,buildProfileCandidates,selectInjectLines,tokenOverlapSims,DEFAULT_TOKEN_MIN_SCORE,cosine,itemKeyOf,upsertSlotItem,isMultiValueTrait} from '../core/inject.mjs';
import {embedQueries,embedDocuments,checkEndpoint} from '../core/embed.mjs';
import {memoryCoreOf,subjectSection} from '../core/memory-core.mjs';
import {readLineage} from '../core/lineage.mjs';
import {readRecentEvents,readEventsById,readEventRows,readHitLog,bumpEventHits} from '../core/consolidate.mjs';
import {getEventIndex,searchEvents} from '../core/event-index.mjs';
import {FACT_KINDS} from '../core/facts.mjs';
import {prepareDiscoveries,applyDiscoveries} from '../core/thing-discovery.mjs';
import {openSubjectStore} from '../core/subjects.mjs';
const root=path.resolve(workerData.root),input=path.join(root,'input'),legacy=path.join(root,'legacy','data');
fs.mkdirSync(input,{recursive:true});fs.mkdirSync(legacy,{recursive:true});
if(!fs.existsSync(path.join(input,'source.json'))) fs.writeFileSync(path.join(input,'source.json'),JSON.stringify({version:1,kind:'canonical'}));
const log=new DurableLog(path.join(input,'messages.jsonl'),()=>{});
bindCanonicalMessages(input,()=>{log.assertReadable();return log.rows.map(r=>r.data.message);});
const memoryOperations=new DurableLog(path.join(input,'memory-operations.jsonl'),()=>{});
function configuredSettings(){const file=path.join(root,'settings.json');return {...DEFAULT_SETTINGS,...workerData.settings,...(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{})};}
// Background work is serialized by this worker rather than by legacy global timers.
function settings(){return {...configuredSettings(),autoIndexEnabled:false,consolidateEnabled:false};}
const router=createRouter({dataRoot:legacy,settings:{getSkillConfig:(_id,defaults)=>({...defaults,...settings()})}});
bindHost({config:{DATA_DIR:legacy,SOURCE_DIR:input},settings:{getSkillConfig:(_id,defaults)=>({...defaults,...settings()})},fallbackRoot:root});
const receipts=new Map();
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
function message(raw){
 const m={messageId:requireText(raw?.messageId,'messageId',200),conversationId:requireText(raw?.conversationId,'conversationId',200),actorId:requireText(raw?.actorId,'actorId',200),role:requireText(raw?.role,'role',20),timestamp:typeof raw?.timestamp==='number'?raw.timestamp:Date.parse(raw?.timestamp),text:typeof raw?.text==='string'?raw.text:null,scope:raw?.scope};
 canonicalChatKey(m.scope);m.scope={kind:m.scope.kind,id:m.scope.id.trim()};
 if(!['user','assistant','system','tool'].includes(m.role)||!Number.isFinite(m.timestamp)||m.timestamp<=0||m.text===null||m.text.length>100000)throw new MemoryError('INVALID_MESSAGE','Invalid role, timestamp or text');
 if(raw.mentions!==undefined){if(!Array.isArray(raw.mentions)||raw.mentions.length>100)throw new MemoryError('INVALID_MESSAGE','mentions must be an array');m.mentions=raw.mentions.map(x=>requireText(typeof x==='string'?x:x?.actorId,'mention actorId',200));}
 if(raw.replyTo!=null)m.replyTo=requireText(raw.replyTo,'replyTo',200);
 return m;
}
async function entity(p){
 const id=requireText(p.entityId||p.id,'entityId',200),all=canonicalEntities(input),rt=await getRuntime();
 const existing=rt.normalizer.resolveKnown(id)||(/^\d+$/.test(id)?rt.normalizer.resolveKnown(`qq:${id}`):null),canonicalId=existing?.id||id;
 const previousEntity=rt.normalizer.entities.get(canonicalId);
 const e={id:canonicalId,kind:p.kind||previousEntity?.kind||'person',displayName:p.displayName||p.name||id,surfaces:[...new Set([...(previousEntity?.surface||[]),...(p.surfaces||[])])],aliases:[...new Set([...(previousEntity?.aliases||[]),...(p.aliases||[]),...(canonicalId!==id?[id]:[])])]};
 if(!['person','group','self','other'].includes(e.kind)||typeof e.displayName!=='string'||!Array.isArray(e.surfaces)||!Array.isArray(e.aliases)||[...e.surfaces,...e.aliases].some(x=>typeof x!=='string'||!x||x.length>200))throw new MemoryError('INVALID_ENTITY','Invalid entity kind, surfaces or aliases');
 for(const other of all)if(other.id!==canonicalId&&e.aliases.some(a=>other.id===a||other.aliases?.includes(a)))throw new MemoryError('ENTITY_ALIAS_CONFLICT','Alias belongs to another entity',409);
 const index=all.findIndex(x=>x.id===canonicalId);if(index<0)all.push(e);else all[index]=e;
 atomic(path.join(input,'entities.json'),all);await ensureIdentity(rt,{force:true});return {ok:true,entityId:id,label:rt.normalizer.resolveKnown(id)?.label};
}
async function ingest(p){
 if(!Array.isArray(p.messages)||p.messages.length>500)throw new MemoryError('INVALID_ARGUMENT','messages must be an array with at most 500 items');
 const results=[];let accepted=0,duplicates=0,rejected=0;
 for(const raw of p.messages){try{const m=message(raw),operationId=digest(m.messageId),old=log.replay(operationId,m);if(old){duplicates++;results.push({messageId:m.messageId,status:'duplicate'});continue;}
 log.append(operationId,m,{message:m},{ok:true,messageId:m.messageId});accepted++;results.push({messageId:m.messageId,status:'accepted'});
 }catch(e){rejected++;results.push({messageId:raw?.messageId??null,status:e.status===409?'conflict':'invalid',code:e.status===409?'MESSAGE_CONFLICT':e.code||'INVALID_MESSAGE',error:e.message});}}
 const rt=await getRuntime();await ensureIdentity(rt,{force:true});return {ok:true,accepted,duplicates,rejected,results};
}
async function remember(p){
 const operationId=requireText(p.operationId||p.deliveryId||digest(p),'operationId',200),replayed=memoryOperations.replay(operationId,p);if(replayed)return replayed;
 const actorId=requireText(p.actorId||p.userId,'actorId',200),text=requireText(p.text,'text',12000),chatKey=canonicalChatKey(p.scope),kind=p.kind||'preference';
 if(!FACT_KINDS.includes(kind)||kind==='pattern')throw new MemoryError('INVALID_KIND','Unsupported explicit memory kind');
 const rt=await getRuntime();await ensureIdentity(rt);const hit=rt.normalizer.resolveKnown(actorId)||rt.normalizer.resolveKnown(`qq:${actorId}`);
 if(!hit)throw new MemoryError('UNKNOWN_ENTITY','Register actor before writing memory');
 const source=p.source||'assistant';if(!Array.isArray(p.evidenceIds||[]))throw new MemoryError('INVALID_EVIDENCE','evidenceIds must be an array');
 const ids=[...new Set(p.evidenceIds||[])];if(ids.some(x=>typeof x!=='string'))throw new MemoryError('INVALID_EVIDENCE','evidenceIds must be strings');
 const messages=new Map(canonicalMessages(input).map(m=>[m.messageId,m]));
 const aliasesFile=path.join(input,'evidence-aliases.json');if(fs.existsSync(aliasesFile)){for(const [alias,target]of Object.entries(JSON.parse(fs.readFileSync(aliasesFile,'utf8')))){if(messages.has(target)&&!messages.has(alias))messages.set(alias,messages.get(target));}}
 if(!['manual','assistant','evidence'].includes(source))throw new MemoryError('INVALID_SOURCE','source must be manual, assistant or evidence');
 if(source!=='manual'&&!ids.length)throw new MemoryError('EVIDENCE_REQUIRED','Non-manual memories require accepted source messages');
 const refs=ids.map(id=>{const m=messages.get(id);if(!m||canonicalChatKey(m.scope)!==chatKey||source!=='manual'&&m.role!=='user')throw new MemoryError('INVALID_EVIDENCE','Evidence must be an accepted user message in the requested scope');return {type:'message',id,chatKey,fromTs:m.timestamp,toTs:m.timestamp};});
 if(source==='manual')refs.push({type:'manual',id:operationId,chatKey});
 const scope=rt.normalizer.scopeLabel(chatKey),store=factStoreOf(rt),previous=store.getSlot({speaker:hit.label,target:'',fact_kind:kind,scope}),normalized=rt.normalizer.normalize(text,{register:false}).text;
 const itemKey=itemKeyOf(kind,{attr:p.attr||p.itemKey,aspect:p.aspect||p.itemKey});if(kind==='trait'&&!itemKey)throw new MemoryError('INVALID_ARGUMENT','trait requires attr or itemKey');
 const content=itemKey?{items:upsertSlotItem(previous,itemKey,normalized,{mergeMulti:kind==='trait'&&isMultiValueTrait(itemKey)}).items,source:source==='manual'?'manual':'assistant-remember'}:{text:normalized,source:source==='manual'?'manual':'assistant-remember'};
 const delivery={id:digest(operationId),fingerprint:digest(p)},existing=store.deliveryOf(delivery.id);
 if(existing&&existing.delivery.fingerprint!==delivery.fingerprint)throw new MemoryError('OPERATION_CONFLICT','operationId content differs',409);
 let result;
 if(existing) result={ok:true,saved:false,replayed:true,rev:existing.rev,kind};
 else {const r=store.put({speaker:hit.label,target:'',fact_kind:kind,scope,content,evidenceIds:itemKey?[`item:${scope}:${hit.label}:${itemKey}`]:(ids.length?ids:[`manual:${operationId}`]),provenance:refs,itemProvenance:itemKey?{[itemKey]:refs}:{},delivery,at:new Date().toISOString()});result={ok:true,saved:r.action==='update',action:r.action,rev:r.rev,kind,itemKey,speaker:hit.label};}
 return memoryOperations.append(operationId,p,{kind,actorId,scope,source},result);
}
function eventRefs(e){return [{type:'window',id:e.windowId||e.id,chatKey:e.chatKey,fromTs:e.fromTs,toTs:e.toTs,matchMethod:'persisted-window'}];}
function subjectScope(p) { return canonicalChatKey(p.scope); }
async function subjects(p) {
 const rt=await getRuntime(),scope=rt.normalizer.scopeLabel(subjectScope(p)),store=openSubjectStore(rt.dir);
 return {ok:true,subjects:store.list({q:p.q||''}).filter(s=>s.scopeBinding===scope)};
}
async function subject(p) {
 const rt=await getRuntime(),scope=rt.normalizer.scopeLabel(subjectScope(p)),store=openSubjectStore(rt.dir),result=store.get(requireText(p.subjectId,'subjectId',200));
 if(result.subject.scopeBinding!==scope)throw new MemoryError('NOT_FOUND','Subject not found in this scope',404);
 return {...result,observations:result.observations.filter(o=>o.sourceScope===scope)};
}
async function discover(p) {
 const operationId='thing:'+digest(requireText(p.operationId||digest(p),'operationId',200)),old=memoryOperations.replay(operationId,p);if(old)return old;
 const chatKey=subjectScope(p),name=requireText(p.name||p.label,'name',200);
 if(!Array.isArray(p.evidenceIds)||!p.evidenceIds.length)throw new MemoryError('EVIDENCE_REQUIRED','Provide the user messages that introduced this thing');
 if(p.evidenceIds.some(id=>typeof id!=='string')||p.aliases!==undefined&&(!Array.isArray(p.aliases)||p.aliases.some(a=>typeof a!=='string')))throw new MemoryError('INVALID_DISCOVERY','evidenceIds and aliases must be string arrays');
 const all=new Map(canonicalMessages(input).map(m=>[m.messageId,m]));
 const aliasesFile=path.join(input,'evidence-aliases.json');if(fs.existsSync(aliasesFile))for(const [alias,target]of Object.entries(JSON.parse(fs.readFileSync(aliasesFile,'utf8'))))if(all.has(target)&&!all.has(alias))all.set(alias,all.get(target));
 const ids=[...new Set(p.evidenceIds.map(String))],messages=ids.map(id=>{const m=all.get(id);if(!m||m.role!=='user'||canonicalChatKey(m.scope)!==chatKey)throw new MemoryError('INVALID_EVIDENCE','Use accepted user messages from this scope');return {...m,id};});
 const rt=await getRuntime();await ensureIdentity(rt);
 const statement=p.statement||'',quote=p.quote||messages.find(m=>m.text.includes(name)&&(p.aliases||[]).every(a=>m.text.includes(a)))?.text||'';
 const win={chatKey,rows:messages.map(m=>({id:m.id,text:m.text,role:m.role,self:false})),fromTs:messages.reduce((n,m)=>Math.min(n,m.timestamp),Infinity),toTs:messages.reduce((n,m)=>Math.max(n,m.timestamp),0)};
 const scope=rt.normalizer.scopeLabel(chatKey),requests=prepareDiscoveries({win,windowId:'api:'+digest(operationId),scope,discoveries:[{label:name,kind:p.kind||'concept',statement,quote,interpretation:p.interpretation||(statement?'definition':'mention'),aspect:p.aspect,aliases:p.aliases||[],claimType:p.claimType||'fact',evidenceIds:ids}],normalize:text=>rt.normalizer.normalize(String(text),{register:false}).text});
 const results=applyDiscoveries(openSubjectStore(rt.dir),requests,win,scope),result={ok:true,saved:true,discoveries:results.flatMap(r=>r.discoveries||[])};
 return memoryOperations.append(operationId,p,{scope,name},result);
}
async function subjectRevision(p) {
 const operationId='subject-revision:'+digest(requireText(p.operationId,'operationId',200));
 const old=memoryOperations.replay(operationId,p);if(old)return old;
 await subject(p);const rt=await getRuntime();
 const request={...p,operationId};
 if(p.action==='correct')request.statement=rt.normalizer.normalize(requireText(p.statement,'statement',2000),{register:false}).text;
 const updated=openSubjectStore(rt.dir).reviseObservation(request);
 return memoryOperations.append(operationId,p,{subjectId:p.subjectId},updated);
}
async function recall(p){
 const chatKey=canonicalChatKey(p.scope),rt=await getRuntime();await ensureIdentity(rt);
 const query=typeof p.query==='string'?p.query.trim():'',scope=rt.normalizer.scopeLabel(chatKey),facts=memoryCoreOf(rt,factStoreOf(rt)).manual.readStore();if(facts.readOnlyReason)throw new MemoryError('STORAGE_UNAVAILABLE',facts.readOnlyReason,503);
 const lineage=readLineage(rt.dir);if(!lineage.ok)throw new MemoryError('STORAGE_UNAVAILABLE',lineage.error,503);
 const actorIds=Array.isArray(p.actorIds)?p.actorIds:[...new Set(canonicalMessages(input).filter(m=>canonicalChatKey(m.scope)===chatKey).map(m=>m.actorId))];
 const people=actorIds.map(id=>({id,name:canonicalEntities(input).find(e=>e.id===id||e.aliases?.includes(id))?.displayName||id}));
 // All v1 layers use the same explicit scope, including SELF and manual overrides.
 const winners=[...facts.slots.values()].filter(r=>r.scope===scope);
 const candidates=buildInjectCandidates({winners,people,normalizer:rt.normalizer,lineage:lineage.entries,nowScope:scope}),items=[];
 let sims=null,metric='none',degraded=null;
 if(query&&candidates.length){const q=rt.normalizer.normalize(query,{context:'query',register:false}).text;const ep={...endpointOf(rt.settings),signal:AbortSignal.timeout(1800),retries:0};
  if(checkEndpoint(ep).ok)try{const qv=(await embedQueries([q],{...ep,normalizer:rt.normalizer})).vectors[0],dv=(await embedDocuments(candidates.map(c=>c.line),{...ep,normalizer:rt.normalizer})).vectors;sims=dv.map(v=>cosine(qv,v));metric='vector';}catch(e){degraded={code:'EMBED_FAILED',reason:e.message};}
  else degraded={code:'EMBED_UNCONFIGURED',reason:'Embedding endpoint or model is missing'};
  if(!sims){sims=tokenOverlapSims(candidates.map(c=>c.line),q);metric='keyword';}
 }
 const selected=selectInjectLines({candidates,sims,minScore:metric==='keyword'?DEFAULT_TOKEN_MIN_SCORE:rt.settings.injectThreshold,mode:'boost',perPerson:2,total:8});
 for(const l of selected.lines){const c=candidates.find(c=>c.line===l.line&&c.who===l.who);items.push({id:`fact:${digest(c.rec.key)}`,text:`${l.who}：${l.line}`,layer:'semantic',sourceRefs:c.rec.provenance||[],score:l.score});}
 const profiles=buildProfileCandidates({winners,people,normalizer:rt.normalizer,lineage:lineage.entries,nowScope:scope,profilePolicy:'same-scope',allowCrossScope:false});
 for(const l of selectInjectLines({candidates:profiles,perPerson:1,total:8}).lines){const c=profiles.find(c=>c.line===l.line&&c.who===l.who);items.push({id:`profile:${digest(c.sourceSlots)}`,text:`${l.who}：${l.line}`,layer:'profile',sourceRefs:c.rec.sourceRecords.flatMap(r=>r.provenance||[])});}
 const hitCounts=readHitLog({libDir:rt.dir}).counts,recent=readRecentEvents({libDir:rt.dir,chatKey,limit:rt.settings.consolidateInjectCount||6,hitCounts}),eventIds=new Set(recent.map(e=>e.id));
 let eventRows=recent;
 if(query){const q=rt.normalizer.normalize(query,{register:false}).text,hits=searchEvents(getEventIndex({libDir:rt.dir}),q,{chatKey,limit:3,minScore:rt.settings.consolidateEventMinScore||0.18,exclude:eventIds});eventRows=[...recent,...readEventsById({libDir:rt.dir,chatKey,ids:hits.map(h=>h.id),hitCounts})];}
 for(const e of eventRows){eventIds.add(e.id);items.push({id:`event:${e.id}`,text:e.summary,layer:e.promotedAt?'long-term':'episodic',sourceRefs:eventRefs(e)});}
 if(query){const r=await router.handle({method:'POST',path:'/search',body:{q:query,chatKey,k:p.limit||8,mode:p.mode||'auto',includeEvents:false}});if(!r.body?.ok)throw new MemoryError(r.body?.code||'SEARCH_FAILED',r.body?.error||'Search failed',r.status);
  metric=r.body.mode==='vector'?'vector':metric==='vector'?'hybrid':'keyword';degraded=degraded||r.body.degraded;
  const events=new Map(readEventRows({libDir:rt.dir}).rows.map(e=>[e.id,e]));
  for(const h of r.body.hits||[]){if(h.chatKey!==chatKey)continue;const e=events.get(h.id);if(e&&eventIds.has(e.id))continue;items.push({id:`document:${h.id}`,text:h.text||h.title||'',layer:'long-term',sourceRefs:e?eventRefs(e):[{type:'window',id:h.id,chatKey,matchMethod:'corpus-document'}],score:h.score});if(e)eventIds.add(e.id);}
 }
 const subjects=subjectSection(memoryCoreOf(rt,factStoreOf(rt)).subjects,scope,query,4);
 for(const d of subjects.subjectDetails)items.push({id:`subject:${d.id||digest(d)}`,text:`${d.knowledgeStatus==='candidate'?'【待确认】':d.authority==='manual'?'【人工修订】':'【来源观察】'}${d.possibleConflict?'【存在不同说法】':''}${d.subject.label} · ${d.aspect}：${d.statement}`,layer:'subject',knowledgeStatus:d.knowledgeStatus||'observed',authority:d.authority||'automatic',possibleConflict:!!d.possibleConflict,sourceRefs:d.provenance||[]});
 const working=canonicalMessages(input).filter(m=>canonicalChatKey(m.scope)===chatKey&&(!p.conversationId||m.conversationId===p.conversationId)).sort((a,b)=>b.timestamp-a.timestamp).slice(0,6).reverse();
 for(const m of working)items.push({id:`message:${m.messageId}`,text:`${m.actorId}：${m.text}`,layer:'working',sourceRefs:[{type:'message',id:m.messageId,chatKey,fromTs:m.timestamp,toTs:m.timestamp}]});
 const unique=[...new Map(items.map(i=>[i.id,i])).values()],receiptId=randomUUID();
 for(const [id,r]of receipts)if(r.expires<Date.now())receipts.delete(id);
 receipts.set(receiptId,{expires:Date.now()+60000,chatKey,itemIds:new Set(unique.map(i=>i.id)),eventIds:new Set(eventIds),adopted:new Set()});
 return {ok:true,items:unique,block:unique.length?'<!--mv-inject-->\n'+unique.map(i=>`【${i.layer}】${i.text}`).join('\n'):'',receiptId,actualMode:metric,degraded};
}
async function adoption(p){const r=receipts.get(p.receiptId);if(!r||r.expires<=Date.now()){receipts.delete(p.receiptId);return {ok:true,accepted:false,reason:'unknown-or-expired'};}
 if(!Array.isArray(p.itemIds)||p.itemIds.some(id=>!r.itemIds.has(id)))throw new MemoryError('INVALID_ADOPTION','itemIds must be a subset of the receipt');
 const fresh=p.itemIds.filter(id=>!r.adopted.has(id));
 const ids=fresh.filter(id=>id.startsWith('event:')).map(id=>id.slice(6));
 const docIds=fresh.filter(id=>id.startsWith('document:')).map(id=>id.slice(9)).filter(id=>r.eventIds.has(id));
 const rt=await getRuntime(),rehearsal=bumpEventHits({libDir:rt.dir,ids:[...new Set([...ids,...docIds])],now:Date.now()});fresh.forEach(id=>r.adopted.add(id));return {ok:true,accepted:true,replayed:!fresh.length,rehearsal};}
async function job(p){const cfg=configuredSettings();if(p.type==='consolidate'){if(!cfg.llmBaseURL||!cfg.llmModel)throw new MemoryError('LLM_UNCONFIGURED','Consolidation requires llmBaseURL and llmModel');const result=await runConsolidateNow({force:true,limit:p.limit,chatKey:p.scope?canonicalChatKey(p.scope):undefined,reason:'v1-job'});if(result.failedWindows>0)throw new MemoryError('CONSOLIDATE_FAILED',result.details?.filter(d=>d.error).map(d=>d.error).join('; ')||'Consolidation failed',502,{result});return result;}
 if(p.type==='index'){const rt=await getRuntime();if(!checkEndpoint(endpointOf(rt.settings)).ok)throw new MemoryError('EMBED_UNCONFIGURED','Indexing requires embedding endpoint and model');return await runIndex({reason:'v1-job'});}throw new MemoryError('INVALID_JOB','type must be consolidate or index');}
async function status(){const rt=await getRuntime();return {ok:true,messages:canonicalMessages(input).length,entities:canonicalEntities(input).length,background:backgroundStatus,embeddingConfigured:checkEndpoint(endpointOf(rt.settings)).ok,llmConfigured:!!(rt.settings.llmBaseURL&&rt.settings.llmModel),dataRoot:legacy,sourceRoot:input};}
const operations={ingest,entity,remember,discover,subjects,subject,subjectRevision,recall,adoption,job,status};
let chain=Promise.resolve();parentPort.on('message',m=>{chain=chain.then(async()=>{try{if(!operations[m.operation])throw new MemoryError('INVALID_OPERATION','Unknown engine operation');parentPort.postMessage({id:m.id,result:await operations[m.operation](m.payload||{})});}catch(e){parentPort.postMessage({id:m.id,error:{message:e.message,code:e.code||'ENGINE_FAILED',status:e.status||500,result:e.result}});}});});

const backgroundStatus={lastConsolidateAt:0,lastIndexAt:0,lastError:null};
setInterval(()=>{const cfg=configuredSettings(),now=Date.now();for(const [type,enabled,minutes,key] of [['consolidate',cfg.consolidateEnabled,Number(cfg.consolidateIntervalMin)||30,'lastConsolidateAt'],['index',cfg.autoIndexEnabled,Number(cfg.autoIndexIntervalMin)||30,'lastIndexAt']])if(enabled===true&&now-backgroundStatus[key]>=Math.max(60000,minutes*60000)){backgroundStatus[key]=now;chain=chain.then(()=>job({type})).catch(e=>{backgroundStatus.lastError={at:Date.now(),type,code:e.code||'BACKGROUND_FAILED',error:e.message};});}},60000).unref();
