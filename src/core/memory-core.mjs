import { ManualRevisions } from './manual-revisions.mjs';
import { openSubjectStore } from './subjects.mjs';
import { readLineage } from './lineage.mjs';
import { digest, MemoryError } from './durable-log.mjs';
import { evaluateVisibility, PROFILE_POLICIES, POLICY_VERSION } from './visibility.mjs';
import { buildProfileCandidates, selectInjectLines } from './inject.mjs';
const cores = new WeakMap();
export function memoryCoreOf(rt,facts) {
  let core=cores.get(rt);
  if(!core) {
    core={subjects:openSubjectStore(rt.dir),manual:new ManualRevisions(rt.dir,facts,{identityVersion:()=>{
      const lineage=readLineage(rt.dir); if(!lineage.ok) throw new MemoryError('STORAGE_UNAVAILABLE',lineage.error,503);
      return digest(lineage.entries);
    }}),instanceId:`library-${digest(rt.dir).slice(0,16)}`};
    cores.set(rt,core);
  }
  core.manual.facts=facts;
  return core;
}
export function profileSummary({winners,people,normalizer,lineage={},nowScope,policy,profileTotal=8}) {
  const input={winners:[...winners],people,normalizer,lineage,nowScope,profilePolicy:policy.id};
  // The internal all-scope diagnostic collects only relevant, renderable trait slots.
  const eligible=buildProfileCandidates({...input,nowScope:'*',allowCrossScope:true});
  const refs=new Map(eligible.flatMap(c=>c.rec.sourceRecords).map(r=>[r.key,r]));
  const decisions=[...refs.values()].map(r=>evaluateVisibility({sourceScope:r.scope,targetScope:nowScope,isSelf:r.speaker==='SELF',policy:policy.id}));
  const candidates=buildProfileCandidates(input);
  const {lines}=selectInjectLines({candidates,sims:null,mode:'boost',perPerson:1,total:profileTotal});
  const details=lines.map(l=>{const c=candidates.find(c=>c.who===l.who&&c.line===l.line);return {text:`${l.who}：${l.line}`,sourceSlots:c.sourceSlots,mixedScopes:c.mixedScopes,conflicts:c.conflicts};});
  const reasons={}; for(const d of decisions) if(!d.allowed) reasons[d.reason]=(reasons[d.reason]||0)+1;
  return {candidates,lines,details,summary:{id:policy.id,origin:policy.origin,policyVersion:POLICY_VERSION,eligibleSlots:refs.size,
    allowedSlots:decisions.filter(d=>d.allowed).length,blockedSlots:decisions.filter(d=>!d.allowed).length,
    selectedSourceSlots:new Set(details.flatMap(d=>d.sourceSlots.map(s=>s.key))).size,renderedLines:lines.length,reasons}};
}
export function policyImpact(input) {
  const winners=[...input.winners];
  const policies=PROFILE_POLICIES.map(id=>profileSummary({...input,winners,policy:{id,origin:'comparison'}}));
  return {ok:true,snapshotId:digest(winners),policyVersion:POLICY_VERSION,policies:policies.map(p=>({...p.summary,
    crossScopeSources:new Set(p.details.flatMap(d=>d.sourceSlots.filter(s=>!['same','self'].includes(s.relation)).map(s=>s.key))).size,details:p.details}))};
}
export function subjectSection(subjects,scope,text,limit=4) {
  const details=subjects.select({scope,text,limit});
  return {subjectDetails:details,subjectLines:details.map(o=>`${o.knowledgeStatus==='candidate'?'【待确认】':o.authority==='manual'?'【人工修订】':''}${o.possibleConflict?'【存在不同说法】':''}${o.subject.label} · ${o.aspect}（${o.claimType}）：${o.statement}`)};
}
