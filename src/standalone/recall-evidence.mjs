import { tokenize } from '../core/tokens.mjs';
import { canonicalChatKey } from '../core/input-source.mjs';
import { assertNormalized } from '../core/embed.mjs';

const MAX_CANDIDATES = 48;
const RECENT_SEARCH_ROWS = 300;
const MAX_EVIDENCE = 3;
const MAX_QUOTE = 280;

export function recallEvidence({ query, chatKey, conversationId, messages, items, lookupMessage, indexed = [], normalizer }) {
  const terms = new Set(tokenize(query.slice(0, 600)).filter(term => term.length > 1 || /^\d$/.test(term)));
  if (!terms.size) return [];
  const candidates = new Map();
  const add = (message, derived = false) => {
    if (!message || !['user', 'assistant'].includes(message.role) || canonicalChatKey(message.scope) !== chatKey ||
        (conversationId && message.conversationId !== conversationId)) return;
    const existing = candidates.get(message.messageId);
    if (!existing) candidates.set(message.messageId, { message, derived });
    else existing.derived ||= derived;
  };
  for (const item of items) {
    if (candidates.size >= MAX_CANDIDATES) break;
    for (const ref of item.sourceRefs ?? []) {
      if (candidates.size >= MAX_CANDIDATES) break;
      if (ref.type === 'message' && ref.chatKey === chatKey) add(lookupMessage(ref.id), true);
    }
  }
  for (const message of indexed) add(message);
  for (const message of messages.slice(-RECENT_SEARCH_ROWS)) add(message);

  const ranking = [];
  for (const { message, derived } of candidates.values()) {
    const words = new Set(tokenize(message.text));
    const matched = [...terms].filter(term => words.has(term));
    if (!matched.length) continue;
    const score = matched.reduce((sum, term) => sum + (/\d/.test(term) ? 3 : 1), 0) + (derived ? 0.5 : 0);
    ranking.push({ message, matched, score });
  }
  ranking.sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp);
  const result = [];
  for (const { message, matched, score } of ranking) {
    if (result.length === MAX_EVIDENCE) break;
    const lower = message.text.toLowerCase();
    const offsets = matched.map(term => lower.indexOf(term)).filter(offset => offset >= 0);
    const start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 64);
    const label = normalizer.resolveKnown(message.actorId)?.label;
    const role = message.role === 'user' ? (label ? `用户〔${label}〕原话` : '未识别用户原话') : '助手原话';
    try {
      const quote = normalizer.normalize(message.text.slice(start, start + MAX_QUOTE), {
        context: 'document', register: false,
      }).text;
      if (!quote) continue;
      const text = `[${new Date(message.timestamp).toISOString()}] ${role}：${quote}`;
      assertNormalized([text], normalizer);
      result.push({
        id: `evidence:${message.messageId}`, layer: 'evidence', text, score,
        sourceRefs: [{ type: 'message', id: message.messageId, chatKey,
          fromTs: message.timestamp, toTs: message.timestamp, reporterId:message.actorId, matchMethod: 'source-quote' }],
      });
    } catch {
      // A source that cannot safely be rendered does not become outbound evidence.
    }
  }
  return result;
}
