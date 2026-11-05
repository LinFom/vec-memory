import fs from 'node:fs';
import path from 'node:path';
import {DurableLog, digest, MemoryError, requireText} from './durable-log.mjs';
import {canonicalChatKey} from './input-source.mjs';
const instances=new Map();
export function openRelationshipGraph(root){const key=path.resolve(root);if(!instances.has(key))instances.set(key,new RelationshipGraph(key));return instances.get(key);}
export const RELATION_PROMPT='可额外输出 relations:[{sourceActorId,targetActorId,kind:"relationship"|"attitude",predicate,statement,reporterId,evidenceIds:[消息ID],quote,negated:false}]。仅提取明确原话表述的人际身份关系或主观态度，不从互动频率、昵称相似、语气推断。quote 必须是表达者原话中的连续原文，不能是你的改写。双方只能使用给定登记账号ID，不确定则不提取。转述保留实际表达者，否认和冲突作为候选，不覆盖旧关系。没有给空数组。';

// A rebuildable projection. The message journal remains the source of truth.
export class RelationshipGraph {
  constructor(root) {
    this.file=path.join(root,'relationship-index.json');
    this.revisions=new DurableLog(path.join(root,'relationships.jsonl'),()=>{});
    this.cache=null;
  }
  index(rows,lookup) {
    const tail=rows.at(-1)?.hash||'';
    if(this.cache?.tail===tail)return this.cache;
    if(!this.cache&&fs.existsSync(this.file)) {
      try {const c=JSON.parse(fs.readFileSync(this.file,'utf8'));if(c.version===1&&c.count<=rows.length&&(rows[c.count-1]?.hash||'')===c.tail)this.cache=c;}catch {/* disposable cache */}
    }
    const c=this.cache||{version:1,count:0,tail:'',actors:{},channels:{},edges:{},pending:{},unresolved:0};
    Object.setPrototypeOf(c.pending,null);Object.setPrototypeOf(c.actors,null);
    const messages=lookup?{get:lookup}:new Map(rows.map(r=>[r.data.message.messageId,r.data.message]));
    const add=(source,target,type,m)=>{
      if(source===target)return;
      const channel=canonicalChatKey(m.scope),day=Math.floor(m.timestamp/86400000);
      const key=digest([source,target,type,channel,day]);
      const e=c.edges[key]||(c.edges[key]={source,target,type,channel,day,count:0,first:m.timestamp,last:m.timestamp,evidence:[]});
      e.count++;e.first=Math.min(e.first,m.timestamp);e.last=Math.max(e.last,m.timestamp);
      if(e.evidence.length<8)e.evidence.push(m.messageId);
    };
    const interact=m=>{
      const targets=new Map((m.mentions||[]).map(id=>[id,new Set(['mention'])]));
      if(m.replyTo){const target=messages.get(m.replyTo);if(target&&target.role==='user'&&canonicalChatKey(target.scope)===canonicalChatKey(m.scope)){
        if(!targets.has(target.actorId))targets.set(target.actorId,new Set());targets.get(target.actorId).add('reply');
      }else{c.pending[m.messageId]=m.replyTo;}}
      for(const [target,kinds]of targets){add('actor:'+m.actorId,'actor:'+target,'interaction',m);for(const kind of kinds)add('actor:'+m.actorId,'actor:'+target,kind,m);}
    };
    // Late/out-of-order reply targets are resolved once, without recounting mentions.
    for(const [mid,targetId]of Object.entries(c.pending)) {
      const m=messages.get(mid),target=messages.get(targetId);
      if(m&&target&&target.role==='user'&&canonicalChatKey(m.scope)===canonicalChatKey(target.scope)){
        if(!(m.mentions||[]).includes(target.actorId))add('actor:'+m.actorId,'actor:'+target.actorId,'interaction',m);
        add('actor:'+m.actorId,'actor:'+target.actorId,'reply',m);delete c.pending[mid];
      }
    }
    for(let i=c.count;i<rows.length;i++){
      const m=rows[i].data.message;if(m.role!=='user')continue;
      const channel=canonicalChatKey(m.scope);
      c.actors[m.actorId]=(c.actors[m.actorId]||0)+1;
      // Private conversations stay private; project clients must supply a scope.
      c.channels[channel]={id:channel,scope:m.scope};
      add('actor:'+m.actorId,'channel:'+channel,'appearance',m);interact(m);
      for(const id of m.mentions||[])if(!Object.hasOwn(c.actors,id))c.actors[id]=0;
    }
    c.count=rows.length;c.tail=tail;c.unresolved=Object.keys(c.pending).length;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(c));fs.renameSync(tmp,this.file);this.cache=c;return c;
  }
  records(){this.revisions.assertReadable();const map=new Map();for(const r of this.revisions.rows)map.set(r.data.record.id,r.data.record);return [...map.values()];}
  extract(candidates,{rows,entities,windowId}) {
    if(!Array.isArray(candidates)||candidates.length>100)throw new MemoryError('INVALID_RELATIONS','relations must be an array with at most 100 records');
    const messages=new Map(rows.map(m=>[String(m.id||m.messageId),m])),known=new Set(entities.filter(e=>['person','self'].includes(e.kind)).map(e=>e.id));
    let accepted=0,rejected=0;
    for(const p of candidates){
      if(!p||!known.has(p.sourceActorId)||!known.has(p.targetActorId)||p.sourceActorId===p.targetActorId||!['relationship','attitude'].includes(p.kind)||typeof p.statement!=='string'||!p.statement.trim()||p.statement.length>2000||typeof p.predicate!=='string'||!p.predicate.trim()||p.predicate.length>80||typeof p.quote!=='string'||!p.quote.trim()||!Array.isArray(p.evidenceIds)||!p.evidenceIds.length||p.evidenceIds.length>30){rejected++;continue;}
      const refs=p.evidenceIds.map(id=>messages.get(String(id)));
      if(refs.some(m=>!m||m.self||m.role&&m.role!=='user')||!refs.some(m=>(m.speakerId||m.actorId)===p.reporterId&&m.text?.includes(p.quote))){rejected++;continue;}
      const signature=digest([p.sourceActorId,p.targetActorId,p.kind,p.predicate,p.reporterId,p.negated===true,[...p.evidenceIds].sort()]);
      const logicalKey=digest([p.sourceActorId,p.targetActorId,p.kind,p.predicate,p.reporterId,p.negated===true]);
      const operationId='extract:'+signature,request={signature},old=this.revisions.replay(operationId,request);
      if(old){accepted++;continue;}
      // A manual retraction/correction remains authoritative over a replayed source.
      const existing=this.records();
      if(existing.some(r=>(r.signature===signature||r.blockedSignatures?.includes(signature)||r.logicalKey===logicalKey&&p.evidenceIds.some(id=>r.evidenceIds.includes(String(id))))&&r.authority==='manual')){rejected++;continue;}
      const previous=existing.find(r=>r.logicalKey===logicalKey&&r.authority==='source'&&r.status!=='retracted');
      const record={id:previous?.id||'relation:'+signature,signature,logicalKey,rev:(previous?.rev||0)+1,sourceActorId:p.sourceActorId,targetActorId:p.targetActorId,kind:p.kind,predicate:p.predicate,statement:previous?.statement||p.statement,
        status:'candidate',negated:p.negated===true,authority:'source',reporterId:p.reporterId,quote:p.quote,evidenceIds:p.evidenceIds.map(String),windowId,updatedAt:Date.now(),history:[],
        evidence:refs.map(m=>({id:String(m.id||m.messageId),reporterId:m.speakerId||m.actorId,chatKey:m.chatKey||canonicalChatKey(m.scope),timestamp:m.ts||m.timestamp}))};
      if(previous){record.evidence=[...new Map([...previous.evidence,...record.evidence].map(e=>[e.id,e])).values()];record.evidenceIds=record.evidence.map(e=>e.id);}
      this.revisions.append(operationId,request,{record},{ok:true,recordId:record.id});accepted++;
    }
    return {accepted,rejected};
  }
  revise(p,{messages,entities}) {
    const op=requireText(p.operationId,'operationId',200),old=this.revisions.replay(op,p);if(old)return old;
    const records=this.records(),previous=records.find(r=>r.id===p.id);
    if(p.action==='preview')return {ok:true,record:previous,previewToken:digest(previous||null),affected:previous?[previous.id]:[]};
    if(previous&&(p.expectedRev!==previous.rev||p.previewToken!==digest(previous)))throw new MemoryError('STALE_REVISION','Preview current relationship before changing it',409);
    if(p.id&&!previous)throw new MemoryError('NOT_FOUND','Relationship not found',404);
    const action=p.action||'create';if(!['create','confirm','correct','retract'].includes(action))throw new MemoryError('INVALID_OPERATION','Unsupported relationship action');
    const sourceActorId=requireText(p.sourceActorId||previous?.sourceActorId,'sourceActorId',200),targetActorId=requireText(p.targetActorId||previous?.targetActorId,'targetActorId',200);
    if(sourceActorId===targetActorId||![sourceActorId,targetActorId].every(id=>entities.some(e=>e.id===id&&['person','self'].includes(e.kind))))throw new MemoryError('UNKNOWN_ENTITY','Use two distinct registered account IDs');
    const kind=p.kind||previous?.kind||'relationship';if(!['relationship','attitude'].includes(kind))throw new MemoryError('INVALID_ARGUMENT','Invalid relationship kind');
    const statement=requireText(p.statement||previous?.statement,'statement',2000),predicate=requireText(p.predicate||previous?.predicate,'predicate',80);
    const evidenceIds=p.evidenceIds||previous?.evidenceIds||[];if(!Array.isArray(evidenceIds)||evidenceIds.length>100)throw new MemoryError('INVALID_EVIDENCE','Invalid evidenceIds');
    const byId=new Map(messages.map(m=>[m.messageId,m]));
    const evidence=evidenceIds.map(id=>{const m=byId.get(id);if(!m||m.role!=='user')throw new MemoryError('INVALID_EVIDENCE','Use persisted user messages');return {id,reporterId:m.actorId,chatKey:canonicalChatKey(m.scope),timestamp:m.timestamp};});
    const record={id:previous?.id||'relation:'+digest(op),signature:previous?.signature,logicalKey:previous?.logicalKey,reporterId:previous?.reporterId,quote:previous?.quote,negated:p.negated===undefined?previous?.negated===true:p.negated===true,evidenceRole:action==='correct'?'superseded-claim':'supporting-claim',blockedSignatures:previous?.blockedSignatures||[],rev:(previous?.rev||0)+1,sourceActorId,targetActorId,kind,predicate,statement,evidenceIds,evidence,
      status:action==='retract'?'retracted':action==='confirm'?'confirmed':p.candidate?'candidate':'confirmed',authority:'manual',updatedAt:Date.now(),reason:p.reason||'',
      history:[...(previous?.history||[]),...(previous?[{...previous,history:undefined}]:[])]};
    return this.revisions.append(op,p,{record},{ok:true,record});
  }
  project(rows,entities,workspace,p={}) {
    const c=this.index(rows,p.lookupMessage),from=p.from==null?Date.now()-90*86400000:Number(p.from),to=p.to==null?Date.now():Number(p.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw new MemoryError('INVALID_ARGUMENT','Invalid time range');
    const allowed=p.admin?null:new Set([canonicalChatKey(p.scope)]);
    const nodes=new Map(),edges=new Map(),aliases=new Map();
    for(const e of entities){aliases.set(e.id,e.id);for(const a of e.aliases||[])aliases.set(a,e.id);}
    const resolve=id=>p.resolveAccount?.(id)||aliases.get(id)||id;
    const parent=new Map();const find=id=>{while(parent.has(id))id=parent.get(id);return id;};
    for(const l of Object.values(workspace.links||{}))if(l.active){const a=find(resolve(l.a)),b=find(resolve(l.b));if(a!==b)parent.set(b,a);}
    const actor=id=>'actor:'+find(resolve(id));
    const entityMap=new Map(entities.map(e=>[e.id,e]));
    const addActor=id=>{
      const e=entityMap.get(resolve(id));if(e&&!['person','self'].includes(e.kind))return null;
      const key=actor(id);if(!nodes.has(key))nodes.set(key,{id:key,type:'person',label:e?.displayName||id,accounts:[],activity:0});
      const n=nodes.get(key);if(!n.accounts.includes(id))n.accounts.push(id);return n;
    };
    if(p.admin)for(const e of entities)if(['person','self'].includes(e.kind))addActor(e.id);
    const scenes=Object.values(workspace.scenes||{});
    for(const s of scenes)for(const scope of s.bindings||[]){const key=canonicalChatKey(scope);if(!allowed||allowed.has(key))nodes.set('channel:'+key,{id:'channel:'+key,type:'channel',label:s.name||key,scope,activity:0});}
    for(const ch of Object.values(c.channels))if(!allowed||allowed.has(ch.id)){
      const scene=scenes.find(s=>s.bindings?.some(b=>canonicalChatKey(b)===ch.id));
      nodes.set('channel:'+ch.id,{id:'channel:'+ch.id,type:'channel',label:scene?.name||ch.id,scope:ch.scope,activity:0});
    }
    for(const e of Object.values(c.edges)){
      if(allowed&&!allowed.has(e.channel)||e.last<from||e.first>to||['mention','reply'].includes(e.type))continue;
      const a=addActor(e.source.slice(6));if(!a)continue;
      const b=e.type==='appearance'?nodes.get(e.target):addActor(e.target.slice(6));if(!b||a.id===b.id)continue;
      const key=digest([a.id,b.id,e.type,e.channel]);let out=edges.get(key);
      if(!out){out={id:key,source:a.id,target:b.id,type:e.type,channel:e.channel,count:0,evidence:[],first:e.first,last:e.last};edges.set(key,out);}
      out.count+=e.count;out.first=Math.min(out.first,e.first);out.last=Math.max(out.last,e.last);out.evidence.push(...e.evidence.slice(0,Math.max(0,8-out.evidence.length)));a.activity+=e.count;
    }
    const visibleRelations=this.records().filter(r=>r.status!=='retracted'&&(!allowed||r.evidence.length&&r.evidence.every(e=>allowed.has(e.chatKey))));
    const conflictGroups=new Map(),conflictKey=r=>JSON.stringify([r.sourceActorId,r.targetActorId,r.kind,r.predicate]);
    for(const r of visibleRelations){const key=conflictKey(r);if(!conflictGroups.has(key))conflictGroups.set(key,[[],[]]);conflictGroups.get(key)[r.negated===true?1:0].push(r.id);}
    for(const r of visibleRelations){
      const a=addActor(r.sourceActorId),b=addActor(r.targetActorId);if(!a||!b||a.id===b.id)continue;
      const conflicts=conflictGroups.get(conflictKey(r))[r.negated===true?0:1];
      edges.set(r.id,{id:r.id,source:a.id,target:b.id,type:r.kind,count:1,record:{...(p.admin?r:{...r,history:undefined,quote:undefined}),conflicts},evidence:r.evidenceIds});
    }
    const degree=new Map();for(const e of edges.values()){if(!degree.has(e.source))degree.set(e.source,new Set());if(!degree.has(e.target))degree.set(e.target,new Set());degree.get(e.source).add(e.target);degree.get(e.target).add(e.source);}
    for(const n of nodes.values())n.degree=degree.get(n.id)?.size||0;
    return {ok:true,nodes:[...nodes.values()],edges:[...edges.values()],range:{from,to},stats:{indexedMessages:c.count,unresolvedReplies:c.unresolved},semantics:{appearance:'observed-in-channel',interaction:'directed-mention-or-exact-reply',similarity:false}};
  }
}
