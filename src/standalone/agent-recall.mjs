// Produce a display view only after retrieval and evidence checks.
import { naturalRecallLimit } from './natural-recall.mjs';
export function agentRecallItems(items, request, normalizer, entities) {
  const automatic = request.purpose === 'automatic';
  const limit = automatic ? (request.natural === true ? naturalRecallLimit(request) : 1) : Math.min(8, Math.max(1, Number(request.limit) || 3));
  const perItem = automatic ? 180 : 240;
  const names = new Map(entities.map(e => [e.id, e.displayName]));
  function person(label) {
    const id = normalizer.byLabel.get(label);
    if (!id) return '未识别成员（' + label + '）';
    const entity = normalizer.entities.get(id);
    return names.get(id) || [...(entity?.surface || [])][0] || id;
  }
  const seen = new Set(), result = [];
  for (const item of items) {
    const text = String(item.text || '').replace(/〔(P\d+)〕|(?<![A-Za-z0-9_])(P\d+)(?=[：:])/g,
      (token, wrapped, speaker) => person(wrapped || speaker)).trim();
    if (!text) continue;
    const excerpt = text.length > perItem ? text.slice(0, perItem - 1) + '…' : text;
    if (seen.has(excerpt)) continue;
    seen.add(excerpt);
    result.push({...item, text:excerpt});
    if (result.length >= limit) break;
  }
  return result;
}
