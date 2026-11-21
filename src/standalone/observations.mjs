import { DurableLog, MemoryError, requireText } from '../core/durable-log.mjs';
import { canonicalChatKey } from '../core/input-source.mjs';
import { zonedParts } from './reminder-date.mjs';

const statuses = ['observed', 'planned', 'completed', 'cancelled'];
const invalid = message => new MemoryError('INVALID_OBSERVATION', message);
const own = (object, key) => Object.hasOwn(object, key);

function timestamp(value, name) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw invalid(name + ' must be epoch milliseconds or an ISO timestamp with an offset');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalid(name + ' is invalid');
  const day = new Date(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw invalid(name + ' has an invalid calendar date');
  return parsed;
}

const timeOr = (value, fallback, name) => value == null ? fallback : timestamp(value, name);

function interval(input, name) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input) || input.from == null || input.to == null) {
    throw invalid(name + ' requires from and to');
  }
  const from = timestamp(input.from, name + '.from'), to = timestamp(input.to, name + '.to');
  if (from >= to) throw invalid(name + ' must be increasing');
  return { from, to };
}

const includes = (range, instant) => !range || instant != null && instant >= range.from && instant < range.to;

function readAmount(input) {
  if (input == null) return null;
  if (!Number.isSafeInteger(input.value)) throw invalid('amount.value must be a safe integer in the stated unit');
  return { value: input.value, unit: requireText(input.unit, 'amount.unit', 60) };
}

export function openObservations(file, lookupMessage) {
  const current = new Map();
  const scopes = new Map();
  const log = new DurableLog(file, ({ data }) => {
    if (data?.record?.kind !== 'vec-memory.observation' || ![1, 2].includes(data.record.schemaVersion) ||
        (data.record.operation === 'put' && canonicalChatKey(data.record.payload.scope) !== data.chatKey)) {
      throw Error('Invalid stored observation');
    }
  });
  let applied = 0;
  function refresh() {
    log.assertReadable();
    while (applied < log.rows.length) {
      const { chatKey, record } = log.rows[applied++].data;
      const { key } = record;
      const identity = JSON.stringify([chatKey, key.namespace, key.id]);
      current.set(identity, record);
      if (!scopes.has(chatKey)) scopes.set(chatKey, new Map());
      const bucket = scopes.get(chatKey);
      if (!bucket.has(identity)) bucket.set(identity, []);
      bucket.get(identity).push(record);
    }
  }

  function write(request, { imported = false, now: runtimeNow = Date.now() } = {}) {
    const operationId = requireText(request.operationId, 'operationId', 200);
    const prior = log.replay(operationId, request);
    if (prior) return prior;
    refresh();
    const chatKey = canonicalChatKey(request.scope);
    const source = request.record;
    if (!source || source.protocol !== 'vec-memory/record@1' || source.kind !== 'vec-memory.observation' ||
        ![1, 2].includes(source.schemaVersion) || source.operation !== 'put' || !source.payload ||
        (!imported && own(source, 'recordedAt')) || own(source, 'extensions')) throw invalid('Expected a writable observation record');
    const key = { namespace: requireText(source.key?.namespace, 'key.namespace', 256), id: requireText(source.key?.id, 'key.id', 200) };
    const latest = current.get(JSON.stringify([chatKey, key.namespace, key.id]));
    const revision = (latest?.revision ?? 0) + 1;
    if (source.revision !== revision) throw new MemoryError('OBSERVATION_CONFLICT', 'Unexpected observation revision', 409);
    const now = imported ? timestamp(source.recordedAt, 'recordedAt') : runtimeNow;
    const input = source.payload;
    const subject = requireText(input.subject, 'subject', 200);
    const predicate = requireText(input.predicate, 'predicate', 100);
    if (latest?.operation === 'delete') throw new MemoryError('OBSERVATION_DELETED', 'Observation was deleted', 409);
    if (latest && (latest.payload.subject !== subject || latest.payload.predicate !== predicate)) {
      throw invalid('Observation subject and predicate are stable across revisions');
    }
    if (!statuses.includes(input.status)) throw invalid('Unknown observation status');
    const refs = source.references;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 20) throw invalid('Supply 1 to 20 original message references');
    const references = [];
    for (const ref of refs) {
      const id = requireText(ref?.key?.id, 'message reference', 200);
      const message = lookupMessage(id);
      if (ref.key.namespace !== key.namespace || ref.relation !== 'vec-memory.evidence' ||
          ref.revision !== 1 || !message || message.role !== 'user' ||
          canonicalChatKey(message.scope) !== chatKey || message.timestamp > now) {
        throw invalid('Evidence must be an immutable user message in this scope');
      }
      references.push({ key: { namespace: key.namespace, id }, revision: 1, relation: 'vec-memory.evidence' });
    }
    const payload = {
      scope: { kind: request.scope.kind, id: request.scope.id.trim() }, subject, predicate, status: input.status,
      effectiveFrom: timeOr(input.effectiveFrom, now, 'effectiveFrom'),
      effectiveUntil: timeOr(input.effectiveUntil, null, 'effectiveUntil'),
      occurredAt: timeOr(input.occurredAt, null, 'occurredAt'),
      dueAt: timeOr(input.dueAt, null, 'dueAt'),
      amount: readAmount(input.amount),
    };
    if (payload.effectiveUntil !== null && payload.effectiveUntil <= payload.effectiveFrom) {
      throw invalid('effectiveUntil must follow effectiveFrom');
    }
    if (source.schemaVersion === 2) {
      if (input.duePrecision !== undefined) {
        if (!['day','minute'].includes(input.duePrecision) || payload.dueAt === null) throw invalid('duePrecision requires a dated observation');
        const timeZone = input.timeZone ?? 'UTC';
        try { zonedParts(payload.dueAt,timeZone); } catch { throw invalid('timeZone must be an IANA time zone'); }
        payload.duePrecision = input.duePrecision;
        payload.timeZone = timeZone;
      }
      const reminder = input.reminder;
      if (reminder !== undefined && (typeof reminder?.enabled !== 'boolean' || typeof reminder?.label !== 'string')) {
        throw invalid('reminder requires enabled and a label');
      }
      if (reminder) {
        const label = requireText(reminder.label, 'reminder.label', 160);
        if (!references.some(ref => lookupMessage(ref.key.id)?.text.includes(label))) {
          throw invalid('Reminder label must appear in the source message');
        }
        payload.reminder = { enabled: reminder.enabled, label };
      }
    }
    if (imported && latest && now < Date.parse(latest.recordedAt)) throw invalid('Historical revision moves back in recording time');
    const record = { protocol: source.protocol, kind: source.kind, schemaVersion: source.schemaVersion, operation: 'put',
      key, revision, recordedAt: new Date(now).toISOString(), payload, references };
    return log.append(operationId, request, { chatKey, record }, { ok: true, key, revision, recordedAt: record.recordedAt });
  }

  function query(scope, input, now = Date.now()) {
    refresh();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Expected structured query');
    const chatKey = canonicalChatKey(scope);
    const asOf = timeOr(input.asOf, now, 'asOf');
    const effectiveAt = timeOr(input.effectiveAt, asOf, 'effectiveAt');
    const occurred = interval(input.occurred, 'occurred'), due = interval(input.due, 'due');
    const subject = input.subject == null ? null : requireText(input.subject, 'subject', 200);
    const predicate = input.predicate == null ? null : requireText(input.predicate, 'predicate', 100);
    const operation = input.operation ?? 'list';
    const status = input.status ?? (due ? 'planned' : null);
    const order = input.order ?? (due ? 'dueAt' : 'occurredAt');
    const direction = input.direction ?? 'asc';
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!['list', 'count', 'sum'].includes(operation) || status !== null && !statuses.includes(status) ||
        !['occurredAt', 'dueAt', 'effectiveFrom'].includes(order) || !['asc', 'desc'].includes(direction) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw invalid('Invalid query operation, status, sort or paging');
    }
    const unit = operation === 'sum' ? requireText(input.unit, 'unit', 60) : null;
    const rows = [];
    for (const revisions of scopes.get(chatKey)?.values() ?? []) {
      const active = revisions.findLast(row => Date.parse(row.recordedAt) <= asOf && (row.operation === 'delete' || row.payload.effectiveFrom <= effectiveAt));
      if (!active || active.operation === 'delete') continue;
      const p = active.payload;
      if ((p.effectiveUntil !== null && p.effectiveUntil <= effectiveAt) || (subject && p.subject !== subject) ||
          (predicate && p.predicate !== predicate) || (status ? p.status !== status : p.status === 'cancelled') ||
          !includes(occurred, p.occurredAt) || !includes(due, p.dueAt)) continue;
      const intact = active.references.every(ref => {
        const m = lookupMessage(ref.key.id);
        return m?.role === 'user' && canonicalChatKey(m.scope) === chatKey && m.timestamp <= asOf;
      });
      rows.push({ record: active, intact });
    }
    rows.sort((a, b) => {
      const left = a.record.payload[order], right = b.record.payload[order];
      if (left == null || right == null) {
        if (left != null) return -1;
        if (right != null) return 1;
      } else if (left !== right) return (left - right) * (direction === 'desc' ? -1 : 1);
      return a.record.key.namespace.localeCompare(b.record.key.namespace) || a.record.key.id.localeCompare(b.record.key.id);
    });
    const verified = rows.filter(row => row.intact);
    const missingEvidence = rows.length - verified.length;
    let invalidAmounts = 0;
    let aggregate = operation === 'count' && !missingEvidence ? verified.length : null;
    if (operation === 'sum') {
      let total = 0n;
      for (const {record:{payload:{amount}}} of verified) {
        if (amount?.unit !== unit) invalidAmounts++;
        else total += BigInt(amount.value);
      }
      if (!invalidAmounts && !missingEvidence) aggregate = total.toString();
    }
    return {
      ok: true, mode: 'observations', coverage: 'recorded-observations', asOf, effectiveAt,
      operation, aggregate, unit, matches: rows.length, missingEvidence, invalidAmounts,
      records: verified.slice(offset, offset + limit).map(({ record }) => record),
      nextOffset: offset + limit < verified.length ? offset + limit : null,
    };
  }
  function due(scope, now, wasDelivered = () => false) {
    const result = query(scope, { asOf: now, due: { from: Math.max(0, now - 26 * 60 * 60 * 1000),
      to: now + 60 * 60 * 1000 }, limit: 50 });
        let page = result;
    while (page) {
      const next = page.records.find(row => {
        if (row.schemaVersion !== 2 || !row.payload.reminder?.enabled || wasDelivered(row)) return false;
        const p = row.payload;
        if (p.duePrecision !== 'day') return p.dueAt >= now - 6 * 60 * 60 * 1000;
        const day = zonedParts(p.dueAt,p.timeZone), currentDay = zonedParts(now,p.timeZone);
        return day.year === currentDay.year && day.month === currentDay.month && day.day === currentDay.day;
      });
      if (next) return next;
      page = page.nextOffset === null ? null : query(scope, { asOf: now, due: {
        from: Math.max(0, now - 26 * 60 * 60 * 1000), to: now + 60 * 60 * 1000,
      }, limit: 50, offset: page.nextOffset }, now);
    }
    return null;
  }
  function importRecord({ operationId, record }) {
    if (record?.operation !== 'delete') return write({ operationId, scope: record?.payload?.scope, record }, { imported: true });
    refresh();
    const key = record.key;
    const matches = [...current.values()].filter(row => row.key.namespace === key?.namespace && row.key.id === key?.id);
    if (record.protocol !== 'vec-memory/record@1' || record.kind !== 'vec-memory.observation' ||
        ![1, 2].includes(record.schemaVersion) || !record.payload || Object.keys(record.payload).length ||
        record.extensions || record.references?.length || matches.length !== 1 ||
        record.revision !== matches[0].revision + 1 ||
        timestamp(record.recordedAt, 'recordedAt') < Date.parse(matches[0].recordedAt)) {
      throw invalid('Deletion requires one known preceding observation revision');
    }
    const chatKey = log.rows.find(row => row.data.record === matches[0])?.data.chatKey;
    if (!chatKey) throw invalid('Deletion scope is missing');
    return log.append(operationId, record, { chatKey, record }, { ok: true, key, revision: record.revision });
  }
  return { write, query, due, importRecord,
    captureResult: operationId => { log.assertReadable(); const row=log.operations.get(operationId); return row ? {...structuredClone(row.result),replayed:true} : null; },
    captured: (scope, subject) => { refresh(); const chatKey=canonicalChatKey(scope); return [...(scopes.get(chatKey)?.keys() || [])].map(key=>current.get(key)).filter(row=>row.operation==='put' && row.key.id.startsWith('reminder:') && row.payload.subject===subject); },
    sourceTime: id => lookupMessage(id)?.timestamp ?? Infinity,
    currentSource: (scope, id) => {
      refresh(); const chatKey=canonicalChatKey(scope);
      const related=[...(scopes.get(chatKey)?.keys() || [])].map(key=>current.get(key)).filter(row=>row.references?.some(ref=>ref.key.id===id));
      return related.every(row=>row.operation==='put' && row.payload.status==='planned' && row.references.at(-1)?.key.id===id);
    },
    namespace: () => { refresh(); return current.values().next().value?.key.namespace; }, audit: () => log.assertReadable() };
}
