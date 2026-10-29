import { MemoryError, requireText, digest } from './durable-log.mjs';
export function normalizeReferences(input = []) {
  if (!Array.isArray(input) || input.length > 500) throw new MemoryError('INVALID_PROVENANCE', 'Invalid provenance array');
  const refs = input.map(r => {
    if (!r || !['message','window','manual'].includes(r.type)) throw new MemoryError('INVALID_PROVENANCE', 'Invalid reference type');
    const out = { type: r.type, id: requireText(r.id,'reference.id',300), chatKey: r.chatKey == null ? null : requireText(r.chatKey,'chatKey',200),
      fromTs: r.fromTs ?? null, toTs: r.toTs ?? null, title: r.title == null ? null : requireText(r.title,'title',300), matchMethod: r.matchMethod || 'persisted-reference' };
    for (const k of ['fromTs','toTs']) if (out[k] !== null && (!Number.isFinite(out[k]) || out[k] < 0)) throw new MemoryError('INVALID_PROVENANCE', 'Invalid reference time');
    if (out.fromTs !== null && out.toTs !== null && out.fromTs > out.toTs) throw new MemoryError('INVALID_PROVENANCE', 'Invalid reference interval');
    return out;
  });
  return [...new Map(refs.map(r => [digest(r),r])).values()];
}
export function windowReferences(win, windowId) {
  return normalizeReferences([{ type:'window', id:windowId, chatKey:win.chatKey, fromTs:win.fromTs, toTs:win.toTs, matchMethod:'persisted-window' }]);
}
// Existence is checked by the adapter. A persisted reference is not proof of an available source.
export function evidenceView(record, itemKey = null, exists = () => false) {
  const itemRefs = itemKey !== null ? record?.itemProvenance?.[itemKey] : null;
  const references = normalizeReferences(itemRefs || record?.provenance || []);
  const level = itemRefs ? 'item' : 'slot';
  const available = references.filter(exists);
  const state = !references.length || !available.length ? 'unavailable'
    : references.every(r => r.type === 'manual') ? 'manual'
    : references.length === available.length ? 'exact' : 'ambiguous';
  return { ok:true, key:record?.key, itemKey, level, state, references,
    reason: !references.length ? 'No persisted source reference; legacy hashes are not reversible' : available.length !== references.length ? 'Some source references cannot be resolved' : null };
}
