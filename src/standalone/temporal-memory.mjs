import { DurableLog, MemoryError, requireText } from '../core/durable-log.mjs';
import { canonicalChatKey } from '../core/input-source.mjs';

export function openTemporalMemory(file, lookupMessage) {
  const journal = new DurableLog(file, row => {
    if (!['assert', 'retract'].includes(row.data?.action) || row.data.id !== row.operationId) {
      throw new Error('Invalid temporal memory record');
    }
  });

  function key(request) {
    return {
      chatKey: canonicalChatKey(request.scope),
      actorId: requireText(request.actorId, 'actorId', 200),
      attribute: requireText(request.attribute, 'attribute', 80),
    };
  }

  function write(request) {
    const id = requireText(request.operationId, 'operationId', 200);
    const target = key(request);
    const action = request.action ?? 'assert';
    if (!['assert', 'retract'].includes(action)) throw new MemoryError('INVALID_ARGUMENT', 'Expected assert or retract');
    const messageId = requireText(request.messageId, 'messageId', 200);
    const message = lookupMessage(messageId);
    if (!message || message.role !== 'user' || message.actorId !== target.actorId ||
        canonicalChatKey(message.scope) !== target.chatKey) {
      throw new MemoryError('INVALID_EVIDENCE', 'Use a first-person source message in the requested scope');
    }
    const sourceRef = { type: 'message', id: messageId, chatKey: target.chatKey };
    const record = { ...target, action, id, sourceRef, statedAt: message.timestamp };
    if (action === 'assert') {
      record.value = requireText(request.value, 'value', 500);
      if (!message.text.includes(record.value)) throw new MemoryError('INVALID_EVIDENCE', 'Value must occur in the source message');
      if (request.effectiveAt != null && !Number.isSafeInteger(request.effectiveAt)) {
        throw new MemoryError('INVALID_ARGUMENT', 'effectiveAt must be epoch milliseconds');
      }
      record.effectiveAt = request.effectiveAt ?? null;
    } else {
      record.targetId = requireText(request.targetId, 'targetId', 200);
      const original = journal.operations.get(record.targetId)?.data;
      if (original?.action !== 'assert' || !matches(original, target) ||
          original.statedAt > message.timestamp || original.sourceRef.id === messageId) {
        throw new MemoryError('INVALID_ARGUMENT', 'Correction must target an earlier assertion for the same actor, attribute and scope');
      }
    }
    return journal.replay(id, record) ?? journal.append(id, record, record, { ok: true, id });
  }

  function query(request) {
    journal.assertReadable();
    const target = key(request);
    const view = request.view ?? 'current';
    if (!['current', 'history'].includes(view)) throw new MemoryError('INVALID_ARGUMENT', 'Expected current or history');
    const records = journal.rows.map(row => row.data).filter(record => matches(record, target));
    const retracted = new Set(records.filter(record => record.action === 'retract').map(record => record.targetId));
    const assertions = records.filter(record => record.action === 'assert').reverse()
      .sort((a, b) => (b.effectiveAt ?? b.statedAt) - (a.effectiveAt ?? a.statedAt) || b.statedAt - a.statedAt);
    const current = assertions.find(record => (record.effectiveAt ?? record.statedAt) <= Date.now());
    const selected = view === 'current' ? [current].filter(Boolean) : assertions;
    return { ok: true, items: selected.filter(record =>
      !retracted.has(record.id) && lookupMessage(record.sourceRef.id)
    ).map(record => ({
      id: record.id, value: record.value, statedAt: record.statedAt, effectiveAt: record.effectiveAt,
      sourceRefs: [record.sourceRef],
    })) };
  }

  return { write, query, audit: () => journal.assertReadable() };
}

function matches(record, target) {
  return record.chatKey === target.chatKey && record.actorId === target.actorId && record.attribute === target.attribute;
}
