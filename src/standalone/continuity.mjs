import { DurableLog, MemoryError, requireText } from '../core/durable-log.mjs';
import { canonicalChatKey } from '../core/input-source.mjs';

export function openContinuity(file, lookupMessage, isRole = false) {
  const entries = new Map();
  function validate({data}) {
    if (!data?.id || !data.chatKey || !['open', 'completed', 'cancelled'].includes(data.status)) {
      throw new Error('Invalid continuity record');
    }
    if (entries.has(data.id) && entries.get(data.id).revision >= data.revision) {
      throw new Error('Invalid continuity revision');
    }
  }
  const log = new DurableLog(file, validate);
  for (const {data} of log.rows) entries.set(data.id, data);

  function context(request) {
    return {
      chatKey: canonicalChatKey(request.scope),
      ...(isRole ? {roleId: requireText(request.roleId, 'roleId', 200)} : {}),
    };
  }

  function visible(item, ctx) {
    return item?.chatKey === ctx.chatKey && item.roleId === ctx.roleId;
  }

  function evidence(messageId, chatKey) {
    const message = lookupMessage(messageId);
    return message?.role === 'user' && canonicalChatKey(message.scope) === chatKey &&
      typeof message.text === 'string';
  }

  function write(request) {
    const ctx = context(request);
    const operationId = requireText(request.operationId, 'operationId', 200);
    const replay = log.replay(operationId, request);
    if (replay) return replay;
    const id = request.id == null ? operationId : requireText(request.id, 'id', 200);
    const previous = entries.get(id);
    let item;
    if (request.id == null) {
      if (previous) throw new MemoryError('ALREADY_EXISTS', 'Continuity record already exists', 409);
      const text = requireText(request.text, 'text', 2000);
      const messageId = request.messageId == null && isRole ? null : requireText(request.messageId, 'messageId', 200);
      if (messageId && !evidence(messageId, ctx.chatKey)) {
        throw new MemoryError('INVALID_EVIDENCE', 'Use an accepted user message from this scope');
      }
      item = {...ctx, id, text, status: 'open', revision: 1,
        sourceRefs: messageId ? [{type: 'message', id: messageId, chatKey: ctx.chatKey}] : []};
    } else {
      if (!visible(previous, ctx)) throw new MemoryError('NOT_FOUND', 'Continuity record not found', 404);
      if (request.expectedRevision !== previous.revision || previous.status !== 'open') {
        throw new MemoryError('STALE_REVISION', 'Reload the open record before changing it', 409);
      }
      if (!['completed', 'cancelled'].includes(request.status)) {
        throw new MemoryError('INVALID_ARGUMENT', 'Expected completed or cancelled');
      }
      item = {...previous, status: request.status, revision: previous.revision + 1};
    }
    const result = log.append(operationId, request, item, {ok: true, id, revision: item.revision});
    entries.set(id, item);
    return result;
  }

  function query(request) {
    log.assertReadable();
    const ctx = context(request);
    const status = request.status ?? 'open';
    if (!['open', 'completed', 'cancelled', 'all'].includes(status)) {
      throw new MemoryError('INVALID_ARGUMENT', 'Invalid status');
    }
    const items = [...entries.values()].filter(item => visible(item, ctx) &&
      (status === 'all' || item.status === status) && item.sourceRefs.every(ref => evidence(ref.id, ctx.chatKey)));
    return {ok: true, items};
  }

  return {write, query, audit: () => log.assertReadable()};
}
