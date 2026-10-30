import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableLog, MemoryError, copy, digest, requireText } from './durable-log.mjs';
import { scopeType, evaluateVisibility } from './visibility.mjs';
import { normalizeReferences } from './provenance.mjs';
export const SUBJECT_KINDS = Object.freeze(['group','work','project','object','case','concept','meme']);
const canonicalScope = s => typeof s === 'string' && /^(group|private):C[0-9]+$/.test(s);
const mentions = (text,name) => {
  if (!/^[A-Za-z0-9 _.-]+$/.test(name)) return text.includes(name);
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^A-Za-z0-9_])'+escaped+'($|[^A-Za-z0-9_])','i').test(text);
};
const fail = (code,message,status=400)=>{throw new MemoryError(code,message,status);};
function validate(row) {
  const d=row.data;
  if(!d || d.type!=='subject-transaction' || !Array.isArray(d.subjects) || !Array.isArray(d.observations)) throw new Error('Invalid subject transaction');
  for(const s of d.subjects) if(!s.id || !SUBJECT_KINDS.includes(s.kind) || !s.label || !Array.isArray(s.aliases) || !Number.isInteger(s.rev) || s.rev<1 || !['active','merged'].includes(s.status) || (s.kind==='group' && scopeType(s.scopeBinding)!=='group')) throw new Error('Invalid subject');
  for(const o of d.observations) if(!o.id || !o.subjectId || !o.statement || !['fact','opinion','pattern'].includes(o.claimType) || !scopeType(o.sourceScope) || !Array.isArray(o.provenance) || !o.provenance.length || !['active','retracted'].includes(o.status)) throw new Error('Invalid observation');
}
export class SubjectStore {
  constructor(root, { io }={}) { this.log=new DurableLog(path.join(root,'subjects','transactions.jsonl'),validate,io); }
  snapshot() {
    this.log.assertReadable(); const subjects=new Map(),observations=new Map();
    for(const row of this.log.rows) { for(const s of row.data.subjects) subjects.set(s.id,copy(s)); for(const o of row.data.observations) observations.set(o.id,copy(o)); }
    return {subjects,observations};
  }
  has(id) { return this.snapshot().subjects.has(id); }
  canonical(id,state=this.snapshot()) {
    const seen=new Set(); let s=state.subjects.get(id);
    while(s?.status==='merged') { if(seen.has(s.id)) fail('STORAGE_UNAVAILABLE','Subject merge cycle',503); seen.add(s.id); s=state.subjects.get(s.mergedInto); }
    if(!s) fail('NOT_FOUND','Subject not found',404); return s;
  }
  get(id) {
    const state=this.snapshot(),subject=state.subjects.get(id); if(!subject) fail('NOT_FOUND','Subject not found',404);
    const resolved=this.canonical(id,state);
    const observations=[...state.observations.values()].filter(o=>this.canonical(o.subjectId,state).id===resolved.id);
    return {ok:true,subject,resolvedSubjectId:resolved.id,observations,
      groups:[...new Set(observations.filter(o=>o.status==='active').map(o=>o.aspect))].map(aspect=>({aspect,relation:'unknown',observationIds:observations.filter(o=>o.aspect===aspect && o.status==='active').map(o=>o.id)}))};
  }
  list({kind,q=''}={}) {
    if(kind && !SUBJECT_KINDS.includes(kind)) fail('INVALID_ARGUMENT','Invalid subject kind');
    return [...this.snapshot().subjects.values()].filter(s=>(!kind||s.kind===kind)&&(!q||[s.label,...s.aliases].some(v=>v.toLowerCase().includes(q.toLowerCase())))).sort((a,b)=>a.id.localeCompare(b.id));
  }
  transact(request,work) {
    const replay=this.log.replay(request?.operationId,request); if(replay) return replay;
    const state=this.snapshot(), {subjects=[],observations=[],extra={}}=work(state);
    return this.log.append(request.operationId,request,{type:'subject-transaction',subjects,observations},
      {ok:true,operationId:request.operationId,replayed:false,...extra});
  }
  create(request) {
    return this.transact(request,state=>{
      const {kind}=request; if(!SUBJECT_KINDS.includes(kind)) fail('INVALID_ARGUMENT','Invalid subject kind');
      const label=requireText(request.label,'label',200),scopeBinding=request.scopeBinding ?? null;
      if(scopeBinding!==null && !canonicalScope(scopeBinding)) fail('INVALID_ARGUMENT','Invalid scopeBinding');
      if(kind==='group' && scopeType(scopeBinding)!=='group') fail('INVALID_ARGUMENT','Group requires canonical group scope');
      if(kind==='group' && [...state.subjects.values()].some(s=>s.kind==='group'&&s.scopeBinding===scopeBinding)) fail('SUBJECT_EXISTS','Group subject already exists',409);
      const subject={id:randomUUID(),kind,label,aliases:[],scopeBinding,status:'active',mergedInto:null,rev:1};
      return {subjects:[subject],extra:{subject}};
    });
  }
  ensureGroup(scope) {
    if(!canonicalScope(scope) || scopeType(scope)!=='group') fail('INVALID_ARGUMENT','Not a group scope');
    const found=this.list({kind:'group'}).find(s=>s.scopeBinding===scope);
    return found || this.create({operationId:`group:${scope}`,kind:'group',label:scope,scopeBinding:scope}).subject;
  }
  active(state,id,expectedRev) {
    const s=state.subjects.get(id); if(!s) fail('NOT_FOUND','Subject not found',404);
    if(s.status!=='active') fail('SUBJECT_MERGED','Use the active subject',409);
    if(!Number.isInteger(expectedRev)||s.rev!==expectedRev) throw new MemoryError('STALE_REVISION','Subject changed',409,{currentRev:s.rev});
    return s;
  }
  addObservation(request,{verifyReference}={}) {
    return this.transact(request,state=>{
      const s=this.active(state,request.subjectId,request.expectedSubjectRev);
      if(!canonicalScope(request.sourceScope) || s.scopeBinding && s.scopeBinding!==request.sourceScope) fail('SCOPE_MISMATCH','Observation scope does not match subject');
      const provenance=normalizeReferences(request.provenance);
      if(!provenance.length || typeof verifyReference!=='function' || !provenance.every(r=>r.type!=='manual' && verifyReference(r,request.sourceScope)===true)) fail('INVALID_PROVENANCE','Every observation requires a verified source in its scope');
      if(!['fact','opinion','pattern'].includes(request.claimType)) fail('INVALID_ARGUMENT','Invalid claimType');
      if(!Number.isFinite(request.observedAt)||request.observedAt<0) fail('INVALID_ARGUMENT','Invalid observedAt');
      const observation={id:randomUUID(),subjectId:s.id,aspect:requireText(request.aspect,'aspect',100),statement:requireText(request.statement,'statement',2000),
        claimType:request.claimType,sourceScope:request.sourceScope,reporterLabel:request.reporterLabel==null?null:requireText(request.reporterLabel,'reporterLabel',100),
        provenance,observedAt:request.observedAt,operationId:request.operationId,status:'active',rev:1};
      const subject={...s,rev:s.rev+1};
      return {subjects:[subject],observations:[observation],extra:{subject,observation}};
    });
  }
  // Human revisions preserve the original claim and evidence rather than rewriting history.
  reviseObservation(request) {
    return this.transact(request,state=>{
      const subject=this.active(state,request.subjectId,request.expectedSubjectRev??state.subjects.get(request.subjectId)?.rev);
      const old=state.observations.get(request.observationId);
      if(!old || this.canonical(old.subjectId,state).id!==subject.id) fail('NOT_FOUND','Observation not found',404);
      if(old.rev!==request.expectedRev || old.status!=='active') fail('STALE_REVISION','Observation changed',409);
      if(!['correct','retract'].includes(request.action)) fail('INVALID_ARGUMENT','action must be correct or retract');
      const at=Number(request.observedAt??Date.now());
      if(!Number.isFinite(at)||at<0) fail('INVALID_ARGUMENT','Invalid observedAt');
      const previous={...old,status:'retracted',rev:old.rev+1,retractionReason:requireText(request.reason,'reason',1000)};
      const observations=[previous]; let observation=null;
      if(request.action==='correct') {
        observation={...old,id:randomUUID(),statement:requireText(request.statement,'statement',2000),status:'active',rev:1,
          operationId:request.operationId,observedAt:at,authority:'manual',knowledgeStatus:'observed',supersedes:old.id,
          provenance:[{type:'manual',id:request.operationId,reason:request.reason}],originalProvenance:copy(old.provenance)};
        observations.push(observation);
      }
      const updated={...subject,rev:subject.rev+1};
      return {subjects:[updated],observations,extra:{subject:updated,observation,retracted:previous}};
    });
  }
  applyDiscovery(request, {verifyEntry}={}) {
    return this.transact(request,state=>{
      if(!canonicalScope(request.scope)||!Array.isArray(request.entries)) fail('INVALID_DISCOVERY','Invalid discovery batch');
      const changed=new Map(),observations=[],results=[];
      for(const entry of request.entries) {
        if(typeof verifyEntry!=='function'||!verifyEntry(entry,request.scope)) fail('INVALID_PROVENANCE','Discovery evidence no longer matches its user messages');
        const key=v=>v.normalize('NFC').toLowerCase();
        const names=new Set([entry.label,...entry.aliases].map(key));
        const matches=[...state.subjects.values()].filter(s=>s.status==='active'&&s.scopeBinding===request.scope&&[s.label,...s.aliases].some(n=>names.has(key(n))));
        // Ambiguous names stay visible as distinct candidates; no similarity-based identity merges.
        const compatible=matches.filter(s=>s.kind===entry.kind),ambiguous=matches.length>1||matches.length===1&&!compatible.length;
        const discoveryKey=digest({scope:request.scope,kind:entry.kind,label:key(entry.label),ambiguous:true});
        let subject=!ambiguous&&compatible.length===1?compatible[0]:[...state.subjects.values()].find(s=>s.status==='active'&&s.discoveryKey===discoveryKey);
        if(!subject) {
          subject={id:randomUUID(),kind:entry.kind,label:entry.label,aliases:[],scopeBinding:request.scope,status:'active',mergedInto:null,rev:1,knowledgeStatus:'candidate',discovered:true,...(ambiguous?{discoveryKey}:{})};
          state.subjects.set(subject.id,subject);
        }
        // An explicitly attested alias can join exactly one identity; collisions remain unassigned.
        const safeAliases=entry.aliases.filter(alias=>![...state.subjects.values()].some(s=>s.id!==subject.id&&s.status==='active'&&s.scopeBinding===request.scope&&[s.label,...s.aliases].some(n=>key(n)===key(alias))));
        const manual=[...state.observations.values()].find(o=>o.subjectId===subject.id&&o.aspect===entry.aspect&&o.status==='active'&&o.authority==='manual');
        const knowledgeStatus=ambiguous||entry.interpretation==='mention'||manual?'candidate':'observed';
        if(knowledgeStatus==='observed')for(const prior of state.observations.values()){
          if(prior.subjectId===subject.id&&prior.status==='active'&&prior.interpretation==='mention'){
            const resolved={...prior,status:'retracted',rev:prior.rev+1,resolutionReason:'definition-added'};
            observations.push(resolved);state.observations.set(prior.id,resolved);
          }
        }
        const duplicate=[...state.observations.values()].find(o=>o.subjectId===subject.id&&o.status==='active'&&o.aspect===entry.aspect&&o.statement===entry.statement&&o.claimType===entry.claimType&&digest(o.provenance)===digest(entry.provenance));
        if(duplicate) {results.push({subjectId:subject.id,observationId:duplicate.id,duplicate:true});continue;}
        const observation={id:randomUUID(),subjectId:subject.id,aspect:entry.aspect,statement:entry.statement,claimType:entry.claimType,
          sourceScope:request.scope,reporterLabel:null,provenance:entry.provenance,observedAt:entry.observedAt,operationId:request.operationId,
          status:'active',rev:1,authority:'automatic',knowledgeStatus,interpretation:entry.interpretation,
          ...(ambiguous?{reviewReason:'ambiguous-name',possibleSubjectIds:matches.map(s=>s.id)}:manual?{reviewReason:'manual-override',conflictsWith:manual.id}:{})};
        observations.push(observation);state.observations.set(observation.id,observation);
        subject={...subject,aliases:[...new Set([...subject.aliases,...safeAliases])],rev:subject.rev+1,
          knowledgeStatus:subject.knowledgeStatus==='observed'||knowledgeStatus==='observed'?'observed':'candidate'};
        state.subjects.set(subject.id,subject);changed.set(subject.id,subject);
        results.push({subjectId:subject.id,observationId:observation.id,knowledgeStatus,ambiguous});
      }
      return {subjects:[...changed.values()],observations,extra:{discoveries:results}};
    });
  }
  aliases(request) {
    return this.transact(request,state=>{
      const s=this.active(state,request.subjectId,request.expectedRev);
      if(!Array.isArray(request.aliases)||request.aliases.length>30) fail('INVALID_ARGUMENT','aliases must be an array, max 30');
      const subject={...s,aliases:[...new Set(request.aliases.map(v=>requireText(v,'alias',200)))],rev:s.rev+1};
      return {subjects:[subject],extra:{subject}};
    });
  }
  merge(request) {
    return this.transact(request,state=>{
      if(request.fromId===request.intoId) fail('INVALID_ARGUMENT','Cannot merge subject into itself');
      const from=this.active(state,request.fromId,request.expectedFromRev),into=this.active(state,request.intoId,request.expectedIntoRev);
      if(from.kind!==into.kind || from.scopeBinding!==into.scopeBinding) fail('SCOPE_MISMATCH','Merge requires equal kind and scope binding');
      const subject={...from,status:'merged',mergedInto:into.id,rev:from.rev+1},target={...into,rev:into.rev+1};
      return {subjects:[subject,target],extra:{subject,target,affectedObservationIds:[...state.observations.values()].filter(o=>this.canonical(o.subjectId,state).id===from.id).map(o=>o.id)}};
    });
  }
  unmerge(request) {
    return this.transact(request,state=>{
      const s=state.subjects.get(request.subjectId); if(!s) fail('NOT_FOUND','Subject not found',404);
      if(s.status!=='merged') fail('INVALID_ARGUMENT','Subject is not merged');
      if(s.rev!==request.expectedRev) throw new MemoryError('STALE_REVISION','Subject changed',409,{currentRev:s.rev});
      // Undo a chain from the destination first; never silently repoint another merge.
      const into=state.subjects.get(s.mergedInto);
      if(into?.status!=='active') fail('MERGE_ORDER','Undo downstream merge first',409);
      const subject={...s,status:'active',mergedInto:null,rev:s.rev+1},target={...into,rev:into.rev+1};
      return {subjects:[subject,target],extra:{subject,target}};
    });
  }
  matchingSubjectIds({scope,text=''}) {
    const state=this.snapshot(),selected=new Set(),names=new Map();
    for(const s of state.subjects.values()) {
      if(s.status==='active'&&s.kind==='group'&&s.scopeBinding===scope) selected.add(s.id);
      if(s.kind!=='group' && (!s.scopeBinding || s.scopeBinding===scope)) for(const name of [s.label,...s.aliases]) {
        const token=name.normalize('NFC').toLowerCase();
        const ids=names.get(token)||new Set();ids.add(this.canonical(s.id,state).id);names.set(token,ids);
      }
    }
    for(const [name,ids] of names) if(ids.size===1 && mentions(text.normalize('NFC').toLowerCase(),name)) selected.add([...ids][0]);
    return selected;
  }
  select({scope,text='',subjectId=null,limit=4}={}) {
    if(!canonicalScope(scope)) return [];
    const state=this.snapshot(),selected=subjectId?new Set([this.canonical(subjectId,state).id]):this.matchingSubjectIds({scope,text});
    // Read-side ambiguity is displayed, while write-side matching stays unambiguous.
    if(!subjectId)for(const s of state.subjects.values())if(s.status==='active'&&s.scopeBinding===scope&&[s.label,...s.aliases].some(name=>mentions(text.normalize('NFC').toLowerCase(),name.normalize('NFC').toLowerCase())))selected.add(s.id);
    return [...state.observations.values()].filter(o=>o.status==='active' && selected.has(this.canonical(o.subjectId,state).id) &&
      evaluateVisibility({sourceScope:o.sourceScope,targetScope:scope,section:'subject'}).allowed)
      .sort((a,b)=>(b.authority==='manual')-(a.authority==='manual')||(a.knowledgeStatus==='candidate')-(b.knowledgeStatus==='candidate')||b.observedAt-a.observedAt || a.id.localeCompare(b.id)).slice(0,Math.max(0,limit))
      .map(o=>({ ...o,subject:this.canonical(o.subjectId,state),relation:'same',possibleConflict:[...state.observations.values()].some(other=>other.id!==o.id&&other.status==='active'&&other.aspect===o.aspect&&other.statement!==o.statement&&other.sourceScope===o.sourceScope&&this.canonical(other.subjectId,state).id===this.canonical(o.subjectId,state).id) }));
  }
  // Freeze requests alongside the model output, BEFORE applying any window output.
  prepareWindow({win,windowId,scope,candidates=[],normalize=s=>s,allowedSubjectIds=null,resolveReporter=()=>null}) {
    const known=new Set(win.rows.map(r=>String(r.id))),requests=[];
    const groupscope=scopeType(scope)==='group';
    let group=this.list({kind:'group'}).find(s=>s.scopeBinding===scope);
    const revisions=new Map();
    for(let i=0;i<candidates.length;i++) {
      const c=candidates[i];
      if(!c || !Array.isArray(c.evidenceIds)||!c.evidenceIds.length || !c.evidenceIds.every(id=>known.has(String(id)))) fail('INVALID_OBSERVATION','Observation evidence is outside this window');
      if(c.subjectRef==='current-group') { if(!groupscope) fail('INVALID_OBSERVATION','Not a group window'); group ||= this.ensureGroup(scope); }
      if(c.subjectRef!=='current-group' && (!allowedSubjectIds || !allowedSubjectIds.has(c.subjectRef))) fail('INVALID_OBSERVATION','Subject was not unambiguously mentioned in this window');
      const s=c.subjectRef==='current-group'?group:this.snapshot().subjects.get(c.subjectRef);
      if(!s || s.status!=='active' || (s.scopeBinding && s.scopeBinding!==scope)) fail('INVALID_OBSERVATION','Unregistered or out-of-scope subject');
      if(c.reporterLabel != null) fail('INVALID_OBSERVATION','Model output must use reporterId, never invent reporterLabel');
      let reporterLabel=null;
      if(c.reporterId != null) {
        const id=String(c.reporterId).replace(/^qq:/,'');
        if(!win.rows.some(r=>String(r.speakerId||'').replace(/^qq:/,'')===id)) fail('INVALID_OBSERVATION','Reporter is outside this window');
        reporterLabel=resolveReporter(id);
        if(!reporterLabel) fail('INVALID_OBSERVATION','Reporter cannot be resolved');
      }
      const rev=revisions.get(s.id)??s.rev; revisions.set(s.id,rev+1);
      requests.push({operationId:`window:${windowId}:observation:${i}`,subjectId:s.id,expectedSubjectRev:rev,
        aspect:c.aspect,statement:normalize(c.statement),claimType:c.claimType,reporterLabel,sourceScope:scope,observedAt:win.toTs,
        provenance:c.evidenceIds.map(id=>({type:'message',id:String(id),chatKey:win.chatKey,fromTs:win.fromTs,toTs:win.toTs,matchMethod:'window-evidence-id'}))});
    }
    return requests;
  }
  applyPrepared(requests,win,scope) {
    const known=new Set(win.rows.map(r=>String(r.id)));
    return requests.map(r=>this.addObservation(r,{verifyReference:(ref,sc)=>sc===scope&&ref.chatKey===win.chatKey&&known.has(ref.id)}));
  }
}

const stores = new Map();
export function openSubjectStore(root) { const key=path.resolve(root); if(!stores.has(key)) stores.set(key,new SubjectStore(key)); return stores.get(key); }
