import path from 'node:path';
import { DurableLog, MemoryError, copy, digest, requireText } from './durable-log.mjs';
import { normalizeTraitKey, renderAttributeLine } from './inject.mjs';
import { factSlotKey, FACT_KINDS } from './facts.mjs';

const address = (key,itemKey) => JSON.stringify([key,itemKey]);
function baseItems(rec) {
  if (Array.isArray(rec?.content?.items)) return rec.content.items.map(i => ({ itemKey:rec.manualTextKey && i.k==='整体' ? null : normalizeTraitKey(i.k), value:String(i.v ?? '') }));
  if (typeof rec?.content?.text === 'string') return [{itemKey:null,value:rec.content.text}];
  const rendered=renderAttributeLine(rec);
  return rendered ? [{itemKey:null,value:rendered}] : [];
}
function validate(row) {
  const d = row.data;
  if (d?.type === 'addition') {
    if (!d.record || d.key !== d.record.key || typeof d.itemKey !== 'string' || !d.itemKey ||
        typeof d.value !== 'string' || !d.value.trim() || typeof d.operationId !== 'string' ||
        !FACT_KINDS.includes(d.record.fact_kind) || d.record.fact_kind === 'pattern' ||
        d.key !== factSlotKey(d.record.speaker,'',d.record.fact_kind,d.record.scope)) throw new Error('Invalid manual addition');
    return;
  }
  if (!d || d.type !== 'revision' || typeof d.key !== 'string' || !(d.itemKey === null || typeof d.itemKey === 'string') ||
      !['replace','hide','restore'].includes(d.op) || !Number.isInteger(d.revision) || d.revision < 1 ||
      typeof d.baseFingerprint !== 'string' || (d.op === 'replace' && typeof d.value !== 'string')) throw new Error('Invalid manual revision');
}
export class ManualRevisions {
  constructor(root, factStore, { identityVersion = () => '', io } = {}) {
    this.facts = factStore; this.identityVersion = identityVersion;
    this.log = new DurableLog(path.join(root,'manual','revisions.jsonl'),validate,io);
  }
  state() {
    this.log.assertReadable();
    const map = new Map();
    for (const row of this.log.rows) if (row.data.type === 'revision') map.set(address(row.data.key,row.data.itemKey),row.data);
    return map;
  }
  // Human additions share the canonical slot identity, but live outside machine truth.
  // Rebuilding or replacing the machine slot cannot erase a confirmed human entry.
  records() {
    this.assertFacts(); this.log.assertReadable();
    const records = new Map([...this.facts.slots.values()].map(r=>[r.key,copy(r)]));
    for (const {data:d} of this.log.rows) {
      if (d.type !== 'addition') continue;
      let rec = records.get(d.key);
      if (!rec) { rec = copy(d.record); records.set(d.key,rec); }
      if(typeof rec.content.text==='string') rec.manualTextKey=true;
      const items = baseItems(rec).map(i=>({k:i.itemKey ?? '整体',v:i.value}));
      const pos = items.findIndex(i=>i.k===d.itemKey);
      const item = {k:d.itemKey,v:d.value};
      if (pos < 0) items.push(item); else items[pos]=item;
      rec.content = {...rec.content,items}; delete rec.content.text;
      rec.itemProvenance = {...rec.itemProvenance,[d.itemKey]:[{type:'manual',id:d.operationId,title:d.reason || '人工新增记忆'}]};
      rec.manualAdditions = {...rec.manualAdditions,[d.itemKey]:d.operationId};
    }
    return [...records.values()];
  }
  create(request) {
    this.assertFacts();
    const replay=this.log.replay(request?.operationId,request); if(replay) return replay;
    const speaker=requireText(request.speaker,'speaker',100), scope=requireText(request.scope,'scope',100);
    const kind=request.kind;
    if(!FACT_KINDS.includes(kind)||kind==='pattern') throw new MemoryError('INVALID_ARGUMENT','Unsupported manual memory kind');
    const itemKey=normalizeTraitKey(requireText(request.itemKey,'itemKey',100));
    if(!itemKey || itemKey==='整体') throw new MemoryError('INVALID_ARGUMENT','请填写具体的属性或事项名称，不能使用「整体」');
    const value=requireText(request.value,'value',4000);
    if(request.chatKey!=null && !/^(group|private):\d{5,15}$/.test(request.chatKey)) throw new MemoryError('INVALID_ARGUMENT','Invalid source chatKey');
    if(request.reason!=null) requireText(request.reason,'reason',1000);
    const key=factSlotKey(speaker,'',kind,scope), existing=this.records().find(r=>r.key===key);
    if(existing && baseItems(existing).some(i=>i.itemKey===itemKey)) throw new MemoryError('ITEM_EXISTS','该分类和场合下已有同名项目，请编辑已有项目或更换事项名称',409);
    const record={key,speaker,target:'',fact_kind:kind,scope,rev:1,content:{items:[],source:'human-manual'},
      evidence_n:1,caliber:'manual',content_fingerprint:digest({kind,itemKey,value}),derived_from:{at:new Date().toISOString()}};
    const data={type:'addition',key,itemKey,value,record,operationId:request.operationId,reason:request.reason||null,at:record.derived_from.at,...(request.chatKey?{sourceChatKey:request.chatKey}:{})};
    return this.log.append(request.operationId,request,data,{ok:true,operationId:request.operationId,replayed:false,key,itemKey});
  }
  assertFacts() { if (this.facts.readOnlyReason) throw new MemoryError('STORAGE_UNAVAILABLE','Fact store is read-only',503); }
  item(rec, itemKey, state = this.state(), identity = this.identityVersion(rec)) {
    const base = baseItems(rec).find(i => i.itemKey === itemKey);
    const edit = state.get(address(rec.key,itemKey));
    if (!base && !edit) return null;
    const baseFingerprint = digest({ content:rec.content, rev:rec.rev, fingerprint:rec.content_fingerprint });
    const active = edit && edit.op !== 'restore';
    const etag = digest({ key:rec.key,itemKey,baseFingerprint,revision:edit?.revision || 0,identity });
    return { key:rec.key,rev:rec.rev,etag,kind:rec.fact_kind,scope:rec.scope,itemKey,
      value:active && edit.op === 'replace' ? edit.value : base?.value ?? null,
      editable:Array.isArray(rec.content?.items)||typeof rec.content?.text==='string',
      originalValue:base?.value ?? null,origin:active ? 'manual' : rec.manualAdditions?.[itemKey] ? 'human' : 'machine',
      humanCreated:!!rec.manualAdditions?.[itemKey],
      sourceState:active && edit.baseFingerprint !== baseFingerprint ? 'source_changed' : 'current',
      hidden:active && edit.op === 'hide' || !base && !(active && edit.op === 'replace'),conflicts:[],
      manualRevision:edit?.revision || 0,operationId:edit?.operationId || null };
  }
  items(records = this.records()) {
    this.assertFacts(); const state = this.state(), identity=this.identityVersion(), out=[];
    for (const rec of records) {
      const keys = new Set(baseItems(rec).map(i => i.itemKey));
      for (const d of state.values()) if (d.key === rec.key) keys.add(d.itemKey);
      for (const k of keys) out.push(this.item(rec,k,state,identity));
    }
    return out;
  }
  commit(request) {
    this.assertFacts();
    const replay = this.log.replay(request?.operationId,request); if (replay) return replay;
    if (!request || !['replace','hide','restore'].includes(request.op)) throw new MemoryError('INVALID_ARGUMENT','Invalid revision operation');
    const { target,expectedEtag,op }=request;
    requireText(target?.key,'target.key',300); requireText(expectedEtag,'expectedEtag',100);
    if (!(target.itemKey === null || typeof target.itemKey === 'string' && target.itemKey === normalizeTraitKey(target.itemKey) && target.itemKey.length > 0)) throw new MemoryError('INVALID_ARGUMENT','Canonical target.itemKey is required');
    if (op === 'replace') requireText(request.value,'value',4000);
    else if (Object.hasOwn(request,'value')) throw new MemoryError('INVALID_ARGUMENT','Only replace accepts value');
    if (request.reason != null) requireText(request.reason,'reason',1000);
    const rec = this.records().find(r=>r.key===target.key);
    if (!rec) throw new MemoryError('NOT_FOUND','Fact slot not found',404);
    if(!Array.isArray(rec.content?.items) && typeof rec.content?.text!=='string') throw new MemoryError('INVALID_ARGUMENT','This structured fact kind is read-only in v1');
    const current = this.item(rec,target.itemKey);
    if (!current) throw new MemoryError('NOT_FOUND','Fact item not found',404);
    if (current.etag !== expectedEtag) throw new MemoryError('STALE_REVISION','Fact changed; reload before editing',409,{currentEtag:current.etag});
    const revision = current.manualRevision + 1;
    const data = { type:'revision',key:rec.key,itemKey:target.itemKey,op,revision,operationId:request.operationId,
      baseFingerprint:digest({content:rec.content,rev:rec.rev,fingerprint:rec.content_fingerprint}),
      ...(op === 'replace' ? {value:request.value.trim()} : {}),reason:request.reason || null,at:new Date().toISOString() };
    const nextState = this.state(); nextState.set(address(rec.key,target.itemKey),data);
    const item = this.item(rec,target.itemKey,nextState);
    return this.log.append(request.operationId,request,data,{ok:true,operationId:request.operationId,replayed:false,item,etag:item.etag});
  }
  project(records = this.records()) {
    this.assertFacts(); const state=this.state(), identity=state.size?this.identityVersion():null, out=[];
    for (const rec of records) {
      const clone=copy(rec), originals=baseItems(rec);
      if (![...state.values()].some(d=>d.key===rec.key)) {out.push(clone);continue;}
      if (!originals.length) { out.push(clone); continue; }
      const keys=new Set(originals.map(i=>i.itemKey));
      for (const d of state.values()) if(d.key===rec.key) keys.add(d.itemKey);
      const visible=[...keys].map(k=>this.item(rec,k,state,identity)).filter(i=>i && !i.hidden && i.value !== null);
      if (!visible.length) continue;
      if (Array.isArray(rec.content.items)) clone.content.items=visible.map(i=>({...(rec.content.items.find(x=>normalizeTraitKey(x.k)===i.itemKey)||{}),k:i.itemKey ?? '整体',v:i.value}));
      else clone.content.text=visible[0].value;
      out.push(clone);
    }
    return out;
  }
  readStore() {
    const records=this.project(), slots=new Map(records.map(r=>[r.key,r]));
    return new Proxy(this.facts,{get(target,key){
      if(key==='slots') return slots;
      if(key==='count') return slots.size;
      if(key==='list') return ({scope,factKind,speaker,offset=0,limit=100}={})=>{
        const all=records.filter(r=>(!scope||r.scope===scope)&&(!factKind||r.fact_kind===factKind)&&(!speaker||r.speaker===speaker)).sort((a,b)=>a.key.localeCompare(b.key));
        return {total:all.length,offset,limit,items:all.slice(offset,limit?offset+limit:undefined)};
      };
      if(key==='get') return k=>slots.get(k)||null;
      if(key==='slotsOfSpeaker') return s=>records.filter(r=>r.speaker===s);
      if(key==='speakers') return ()=>[...new Set(records.map(r=>r.speaker))].map(s=>({speaker:s,slots:records.filter(r=>r.speaker===s).length}));
      if(['put','markMerged','clearMerged','reset'].includes(key)) return ()=>{throw new MemoryError('READ_ONLY','Projected read model cannot write',503);};
      const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value;
    }});
  }
}
