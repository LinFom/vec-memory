import path from 'node:path';
import {DurableLog, MemoryError, digest, requireText, copy} from './durable-log.mjs';
import {canonicalChatKey} from './input-source.mjs';

// One journal commit replaces a whole revision, including dependent retractions.
// Account links are a read projection, never a destructive identity merge.
export class SceneMemory {
  constructor(root) {
    this.log = new DurableLog(path.join(root, 'workspace.jsonl'), row => {
      if (!row.data?.state || row.data.state.version !== 1) throw Error('Invalid workspace revision');
    });
  }
  state() { this.log.assertReadable(); return copy(this.log.rows.at(-1)?.data.state || {version:1, scenes:{}, entries:{}, links:{}}); }
  mutate(p, fn) {
    const operationId = requireText(p.operationId, 'operationId', 200), old = this.log.replay(operationId, p);
    if (old) return old;
    const state = this.state(), result = fn(state);
    return this.log.append(operationId, p, {state}, {ok:true, ...result});
  }
  scene(p) { return this.mutate(p, s => {
    const sceneId = requireText(p.sceneId, 'sceneId', 200);
    if (['__proto__','constructor','prototype','toString'].includes(sceneId)) throw new MemoryError('INVALID_ARGUMENT','Reserved scene ID');
    const previous = Object.hasOwn(s.scenes,sceneId)?s.scenes[sceneId]:null;
    if (previous && p.expectedRev !== previous.rev) throw new MemoryError('STALE_REVISION', 'Reload scene before editing', 409);
    const bindings = p.bindings || previous?.bindings || [];
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 50) throw new MemoryError('INVALID_ARGUMENT', 'Scene bindings required');
    bindings.forEach(canonicalChatKey);
    const scene = {sceneId, name:requireText(p.name, 'name', 200), type:requireText(p.type || 'channel', 'type', 80), bindings, rev:(previous?.rev || 0)+1};
    s.scenes[sceneId] = scene; return {scene};
  }); }
  entry(p, {admin = false, evidence = []} = {}) { return this.mutate(p, s => {
    const scene = s.scenes[p.sceneId];
    if (!scene) throw new MemoryError('NOT_FOUND', 'Scene not found', 404);
    const sourceScope = canonicalChatKey(p.scope), same = scene.bindings.some(b => canonicalChatKey(b) === sourceScope);
    const kind = requireText(p.kind || 'impression', 'kind', 80), text = requireText(p.text, 'text', 4000);
    const signature = digest([scene.sceneId, kind, text.normalize('NFKC').trim()]);
    if (!p.entryId && s.rejectedSignatures?.includes(signature)) return {blocked:true,reason:'Previously corrected or retracted impression'};
    const previous = p.entryId ? s.entries[p.entryId] : Object.values(s.entries).find(e => e.signature === signature);
    if (previous && !p.entryId) {
      const merged=[...new Map([...previous.evidence,...evidence].map(r=>[JSON.stringify([r.chatKey,r.id]),r])).values()];
      if(merged.length!==previous.evidence.length){previous.evidence=merged;previous.rev++;}
      return {entry:previous, duplicate:true}; // adoption/repetition is never a truth score
    }
    if (p.entryId && (!previous || previous.sceneId !== p.sceneId)) throw new MemoryError('NOT_FOUND', 'Entry not found', 404);
    if (previous && p.expectedRev !== previous.rev) throw new MemoryError('STALE_REVISION', 'Reload entry before editing', 409);
    if (previous && !admin) throw new MemoryError('FORBIDDEN','Only administrator can revise an existing scene entry; submit a candidate instead',403);
    if (!admin && !evidence.length) throw new MemoryError('EVIDENCE_REQUIRED', 'Use accepted user message IDs');
    if ((p.shareable === true || p.confirm === true) && !admin) throw new MemoryError('FORBIDDEN', 'Only administrator can publish or confirm entries', 403);
    const derivedFrom = p.derivedFrom || [];
    if (!Array.isArray(derivedFrom) || derivedFrom.some(id => (!s.entries[id] || s.entries[id].status === 'retracted') && !/^person:[a-f0-9]{64}$/.test(id))) throw new MemoryError('INVALID_DEPENDENCY', 'Use active entry IDs');
    if (previous && derivedFrom.some(id => id === previous.id || this.dependencies(s, previous.id).includes(id))) throw new MemoryError('INVALID_DEPENDENCY', 'Dependency cycle');
    const entry = {id:previous?.id || 'scene-'+digest([p.sceneId,p.operationId]), sceneId:p.sceneId, kind, text, signature,
      rev:(previous?.rev || 0)+1, status:p.confirm && admin ? 'confirmed' : same && evidence.length ? 'observed' : 'candidate',
      shareable:admin ? p.shareable === true : previous?.shareable === true, sourceScope, evidence:copy(evidence),
      authority:admin ? 'manual' : 'source', derivedFrom, legacy:p.legacy === true && admin,
      legacyRecord:p.legacy === true && admin ? copy(p.legacyRecord || {}) : previous?.legacyRecord,
      history:[...(previous?.history || []), ...(previous ? [{...previous,history:undefined}] : [])]};
    if (previous?.authority === 'manual' && !admin) throw new MemoryError('MANUAL_PROTECTED', 'Submit a separate candidate instead of overwriting a manual entry', 409);
    if (previous) {
      const preview=this.preview(previous.id);
      if(p.previewToken!==preview.previewToken)throw new MemoryError('STALE_REVISION','Preview affected entries before correction',409);
      s.rejectedSignatures=[...new Set([...(s.rejectedSignatures||[]),previous.signature])];
      for(const id of preview.proven.filter(id=>id!==previous.id)){const child=s.entries[id];child.history.push({...child,history:undefined});child.status='retracted';child.rev++;child.reason='Source entry corrected';}
    }
    s.entries[entry.id] = entry; return {entry};
  }); }
  dependencies(s, rootId) {
    const ids = new Set([rootId]);
    for (let changed = true; changed;) { changed = false; for (const e of Object.values(s.entries)) if (!ids.has(e.id) && e.derivedFrom.some(id => ids.has(id))) { ids.add(e.id); changed = true; } }
    return [...ids].filter(id => id !== rootId);
  }
  preview(entryId) {
    const s = this.state(), root = s.entries[entryId]; if (!root && !/^person:[a-f0-9]{64}$/.test(entryId)) throw new MemoryError('NOT_FOUND','Entry not found',404);
    const proven = [entryId,...this.dependencies(s,entryId)].filter(id=>s.entries[id]), evidenceIds = new Set((root?.evidence||[]).map(e => e.id));
    const suspected = Object.values(s.entries).filter(e => !proven.includes(e.id) && e.evidence.some(r => evidenceIds.has(r.id))).map(e => e.id);
    return {ok:true, entryId, proven, suspected, previewToken:digest(proven.map(id => [id,s.entries[id].rev]))};
  }
  retract(p) { return this.mutate(p, s => {
    const preview = this.preview(p.entryId);
    if (p.previewToken !== preview.previewToken) throw new MemoryError('STALE_REVISION','Preview changed; review again',409);
    for (const id of preview.proven) { const e = s.entries[id]; e.history.push({...e,history:undefined}); e.status = 'retracted'; e.rev++; e.reason = requireText(p.reason,'reason',1000); s.rejectedSignatures=[...new Set([...(s.rejectedSignatures||[]),e.signature])]; }
    return {affected:preview.proven, suspected:preview.suspected};
  }); }
  support(p,evidence) {return this.mutate(p,s=>{
    const e=s.entries[p.entryId];if(!e||e.status==='retracted')throw new MemoryError('NOT_FOUND','Active candidate not found',404);
    if(!s.scenes[e.sceneId].bindings.some(b=>canonicalChatKey(b)===canonicalChatKey(p.scope)))throw new MemoryError('INVALID_EVIDENCE','Support must come from target scene');
    if(!evidence.length)throw new MemoryError('EVIDENCE_REQUIRED','Explicit target-scene messages required');
    const merged=[...new Map([...e.evidence,...evidence].map(r=>[JSON.stringify([r.chatKey,r.id]),r])).values()];
    if(merged.length===e.evidence.length&&e.status!=='candidate')return {entry:e,duplicate:true};
    e.evidence=merged;if(e.status==='candidate')e.status='observed';e.rev++;return {entry:e};
  });}
  link(p) { return this.mutate(p, s => {
    const a = requireText(p.a,'a',200), b = requireText(p.b,'b',200);
    if (a === b || ![a,b].every(id=>id.includes(':')||/^\d+$/.test(id))) throw new MemoryError('INVALID_ACCOUNT','Use distinct platform:stableId accounts (legacy QQ numeric IDs are accepted)');
    const id = digest([a,b].sort()), previous = s.links[id];
    if (previous && p.expectedRev !== previous.rev) throw new MemoryError('STALE_REVISION','Reload account link',409);
    if (p.confirmed !== true) throw new MemoryError('CONFIRMATION_REQUIRED','A person must confirm the account link');
    const link = {id,a,b,active:p.active !== false,rev:(previous?.rev || 0)+1,confirmedAt:new Date().toISOString()};
    s.links[id] = link; return {link};
  }); }
  accounts(account) {
    const ids = new Set([account]), links = Object.values(this.state().links).filter(l => l.active);
    for (let changed = true; changed;) { changed = false; for (const l of links) if (ids.has(l.a) || ids.has(l.b)) for (const id of [l.a,l.b]) if (!ids.has(id)) {ids.add(id);changed=true;} }
    return [...ids];
  }
  query({scope, sceneId, includeCandidates = false}) {
    const s = this.state(), source = canonicalChatKey(scope);
    return Object.values(s.entries).filter(e => (!sceneId || e.sceneId === sceneId) && e.status !== 'retracted' &&
      (includeCandidates || e.status !== 'candidate') && (s.scenes[e.sceneId].bindings.some(b => canonicalChatKey(b) === source) || e.shareable));
  }
}
