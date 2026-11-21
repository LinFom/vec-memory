import { digest, MemoryError } from '../core/durable-log.mjs';
import { resolveReminderDate } from './reminder-date.mjs';

const intent = /^(?:请)?提醒我[：:，,\s]+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))[：:，,\s]+([^\r\n]{1,160})$/u;

const action = /(?:还|交|取|带|买|去|到|见|参加|提交|归还|发送|付款|缴|预约|复查|开会|考试|面试|出发|接|签|检查|完成|上线|发布|备份|提醒)/u;
const uncertain = /[?？]|(?:如果|假如|可能|也许|不一定|打个比方|比如说|据说|听说|能不能|要不要|是否)/u;
const change = /(?:改到|改成|改为|改期|推迟到|提前到|延期到)/u;
const cancellation = /(?:取消|不(?:用|要|再).*了)/u;
const completion = /(?:完成了|办完了|(?:已经|已)(?:还|交|取|买|提交|归还|发送|付).*(?:了|完)|(?:还|交|取|买|提交|归还|发送|付).*(?:好了|完了|了))/u;
const taskKey = text => String(text).normalize('NFKC').replace(/^(.+?)(?:已经|已)(还|交|取|买)(?:好|完)?了$/u,'$2$1').replace(/(?:提醒我|记得|别忘了|已经|完成了|办完了|好了|完了|取消|改到|改成|改为|推迟到|提前到|延期到)/gu, '')
  .replace(/[我将会要已了的把去再不必不用，,。.!！\s]/gu, '');

// Sources have already passed immutable message ingestion. Relative dates are
// anchored to that source, and all results cross the normal evidence checks.
export function captureExplicitReminder(message, observations, now, origin, { timeZone = 'UTC' } = {}) {
  if (message.role !== 'user' || message.timestamp > now) return null;
  const text = message.text.trim(), hash = digest(message.messageId);
  const operationId = 'capture:' + hash;
  const replay = observations.captureResult(operationId);
  if (replay) return replay;
  const match = intent.exec(text);
  if (!match && (text.length > 240 || uncertain.test(text) || /[“”「」『』"\n]/u.test(text))) return null;
  const date = match ? { dueAt: match[1], duePrecision: 'minute' } : resolveReminderDate(text, message.timestamp, timeZone);
  const status = !match && cancellation.test(text) ? 'cancelled' : !match && completion.test(text) ? 'completed' : 'planned';
  if (!match && (status === 'planned' ? (!date && !/(?:提醒我|记得|别忘了|我(?:要|会|打算|计划))/u.test(text)) || !action.test(text) : !action.test(text))) return null;
  let label = match?.[2]?.trim() || (date ? (text.slice(0,date.start) + text.slice(date.end)).trim() : text)
    .replace(/^[，,\s]*(?:我(?:要|会|将)?|请|记得|别忘了|提醒我|要|会|将)+/u,'').replace(/^[，,\s]+|[，,。！!\s]+$/gu,'');
  if (!label || label.length > 160 || !text.includes(label)) label = text.length <= 160 ? text : '';
  if (!label) return null;
  // A dated sentence about another person is evidence, not the speaker's task.
  // Undated completion/cancellation still has to match an existing own task below.
  if (!match && status === 'planned' && !change.test(text) && !new RegExp('^(?:' + action.source + ')','u').test(label)) return null;
  const revises = !match && (change.test(text) || status !== 'planned');
  let latest;
  if (revises) {
    const key = taskKey(label.replace(change, ''));
    const candidates = observations.captured(message.scope, message.actorId).filter(row => {
      if (row.payload.status !== 'planned') return false;
      const previous = taskKey(row.payload.reminder?.label);
      return message.replyTo && row.references.some(ref=>ref.key.id===message.replyTo) ||
        previous.length >= 2 && key === previous;
    }).filter(row => row.references.every(ref => observations.sourceTime(ref.key.id) <= message.timestamp));
    if (candidates.length !== 1) return null;
    latest = candidates[0];
    if (status === 'planned' && !date) return null;
  }
  const namespace = latest?.key.namespace || origin || observations.namespace() || 'vec-memory.capture';
  const references = [...(latest?.references || []), { key: { namespace, id: message.messageId }, revision: 1, relation: 'vec-memory.evidence' }];
  try {
    return observations.write({
      operationId, scope: message.scope,
      record: {
        protocol: 'vec-memory/record@1', kind: 'vec-memory.observation', schemaVersion: 2,
        operation: 'put', key: latest?.key || { namespace, id: 'reminder:' + hash }, revision: (latest?.revision || 0) + 1,
        references: references.length>20 ? [references[0],...references.slice(-19)] : references,
        payload: { subject: message.actorId, predicate: 'reminder', status,
          effectiveFrom: message.timestamp, occurredAt: message.timestamp,
          dueAt: date?.dueAt ?? latest?.payload.dueAt ?? null,
          ...(date?.duePrecision ? { duePrecision: date.duePrecision, timeZone } :
            latest?.payload.duePrecision ? { duePrecision: latest.payload.duePrecision, timeZone: latest.payload.timeZone } : {}),
          reminder: { enabled: status === 'planned', label: latest?.payload.reminder?.label || label } },
      },
    }, { now });
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    return { ok: false, code: error.code };
  }
}
