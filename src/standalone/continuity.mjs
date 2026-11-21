import { DurableLog, MemoryError, requireText } from '../core/durable-log.mjs';
import { canonicalChatKey } from '../core/input-source.mjs';

const roleKinds = ['thought', 'concern', 'day'];
const dayKinds = ['planned', 'occurred', 'fictional'];
const recordKind = item => item.kind ?? 'thought';

export function openContinuity(file, lookupMessage, isRole = false) {
  const entries = new Map();
  let loading = true;
  function validate({data}) {
    if (!data?.id || !data.chatKey || !['open', 'completed', 'cancelled'].includes(data.status)) {
      throw new Error('Invalid continuity record');
    }
    const previous = entries.get(data.id);
    if (previous && (previous.revision >= data.revision || !visible(previous, data) ||
        recordKind(previous) !== recordKind(data))) {
      throw new Error('Invalid continuity revision');
    }
    if (isRole && (!data.roleId || !roleKinds.includes(recordKind(data)) ||
        (data.kind === 'day' && (!dayKinds.includes(data.dayKind) || !Number.isSafeInteger(data.at) ||
          (data.dayKind === 'occurred' && !data.sourceRefs?.length))))) {
      throw new Error('Invalid role record');
    }
    if (loading) entries.set(data.id, data);
  }
  const log = new DurableLog(file, validate);
  loading = false;

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

  function sourceRefs(request, ctx, required) {
    if (request.messageId == null && !required) return [];
    const messageId = requireText(request.messageId, 'messageId', 200);
    if (!evidence(messageId, ctx.chatKey)) {
      throw new MemoryError('INVALID_EVIDENCE', 'Use an accepted user message from this scope');
    }
    return [{type: 'message', id: messageId, chatKey: ctx.chatKey}];
  }

  function dayFields(request) {
    if (!dayKinds.includes(request.dayKind) || !Number.isSafeInteger(request.at) ||
        request.at < 0 || request.at > 8640000000000000) {
      throw new MemoryError('INVALID_ARGUMENT', 'Use a valid dayKind and UTC timestamp in milliseconds');
    }
    return {dayKind: request.dayKind, at: request.at};
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
      if (isRole && request.kind != null && !roleKinds.includes(request.kind)) {
        throw new MemoryError('INVALID_ARGUMENT', 'Invalid role record kind');
      }
      const kind = isRole ? request.kind : undefined;
      const day = kind === 'day' ? dayFields(request) : {};
      item = {...ctx, id, text, status: 'open', revision: 1,
        ...(kind ? {kind, ...day} : {}),
        sourceRefs: sourceRefs(request, ctx, !isRole || day.dayKind === 'occurred')};
    } else {
      if (!visible(previous, ctx)) throw new MemoryError('NOT_FOUND', 'Continuity record not found', 404);
      if (request.expectedRevision !== previous.revision || previous.status !== 'open') {
        throw new MemoryError('STALE_REVISION', 'Reload the open record before changing it', 409);
      }
      if (isRole && request.dayKind != null) {
        if (previous.kind !== 'day' || previous.dayKind !== 'planned' || request.dayKind !== 'occurred' ||
            request.status != null) {
          throw new MemoryError('INVALID_ARGUMENT', 'Only a planned event can be recorded as occurred');
        }
        const sources = sourceRefs(request, ctx, true);
        const refs = [...previous.sourceRefs.filter(ref => ref.id !== sources[0].id), ...sources];
        item = {...previous, ...dayFields(request), sourceRefs: refs, revision: previous.revision + 1};
      } else {
        if (!['completed', 'cancelled'].includes(request.status)) {
          throw new MemoryError('INVALID_ARGUMENT', 'Expected completed or cancelled');
        }
        item = {...previous, status: request.status, revision: previous.revision + 1};
      }
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
    const kind = isRole ? request.kind ?? 'thought' : null;
    if (isRole && !roleKinds.includes(kind)) {
      throw new MemoryError('INVALID_ARGUMENT', 'Invalid role record kind');
    }
    const {dayKind, from, to} = request;
    if (kind === 'day' && ((dayKind != null && !dayKinds.includes(dayKind)) ||
        (from != null && !Number.isSafeInteger(from)) || (to != null && !Number.isSafeInteger(to)) ||
        (from != null && to != null && from >= to))) {
      throw new MemoryError('INVALID_ARGUMENT', 'Invalid dayKind or time range');
    }
    const items = [...entries.values()].filter(item => visible(item, ctx) &&
      (!isRole || recordKind(item) === kind) &&
      (kind !== 'day' || ((dayKind == null || item.dayKind === dayKind) &&
        (from == null || item.at >= from) && (to == null || item.at < to))) &&
      (status === 'all' || item.status === status) && item.sourceRefs.every(ref => evidence(ref.id, ctx.chatKey)));
    if (kind === 'day') items.sort((a, b) => a.at - b.at);
    return {ok: true, items};
  }

  return {write, query, audit: () => log.assertReadable()};
}
