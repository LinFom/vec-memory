import fs from 'node:fs/promises';
import path from 'node:path';
import { DurableLog, digest } from '../src/core/durable-log.mjs';
import { canonicalChatKey } from '../src/core/input-source.mjs';
import { openContinuity } from '../src/standalone/continuity.mjs';
import { openTemporalMemory } from '../src/standalone/temporal-memory.mjs';

// Logical records carry the original operation receipt to preserve retry semantics.
// Journal sequence numbers and hash chains belong to the receiving backend.
export const continuityTypes = new Map([
  ['vec-memory.temporal-memory', {file:'input/temporal-memory.jsonl', prefix:'temporal:'}],
  ['vec-memory.continuity-task', {file:'input/continuity-tasks.jsonl', prefix:'task:'}],
  ['vec-memory.role-note', {file:'role-notes.jsonl', prefix:'role-note:'}],
]);

export function supportsContinuity(record) {
  return record?.protocol === 'vec-memory/record@1' && continuityTypes.has(record.kind) &&
    record.schemaVersion === 1 && record.operation === 'put' && !record.extensions;
}

export function continuityReferences(kind, data, namespace) {
  const sources = kind === 'vec-memory.temporal-memory' ? [data.sourceRef] : data.sourceRefs;
  const refs = (sources ?? []).map(ref => ({key:{namespace,id:ref.id}, revision:1, relation:'vec-memory.evidence'}));
  if (kind === 'vec-memory.temporal-memory' && data.action === 'retract') {
    refs.push({key:{namespace,id:'temporal:'+data.targetId}, revision:1, relation:'vec-memory.corrects'});
  }
  return refs;
}

export async function exportContinuityRecords(space, namespace, {includeRoleNotes=true}={}) {
  const records = [];
  for (const [kind, {file,prefix}] of continuityTypes) {
    if (kind === 'vec-memory.role-note' && !includeRoleNotes) continue;
    const log = new DurableLog(path.join(space,file), () => {});
    log.assertReadable();
    for (const row of log.rows) {
      records.push({protocol:'vec-memory/record@1', kind, schemaVersion:1,
        key:{namespace,id:prefix+row.data.id}, revision:row.data.revision ?? 1,
        operation:'put', recordedAt:null, references:continuityReferences(kind,row.data,namespace),
        payload:{...row.data, sourceOperation:{id:row.operationId,fingerprint:row.fingerprint,result:row.result}}});
    }
  }
  return records;
}

function scopeOf(chatKey) {
  if (typeof chatKey !== 'string') throw Error('Invalid imported chat scope');
  const index = chatKey.indexOf(':');
  const scope = {kind:chatKey.slice(0,index),id:chatKey.slice(index+1)};
  if (canonicalChatKey(scope) !== chatKey) throw Error('Invalid imported chat scope');
  return scope;
}

// Run imported records through the same write rules as live requests, then retain
// their original operation fingerprints. Only a closed, private staging space is used.
export async function importContinuityRecords(space, records) {
  if (!records.length) return;
  const messages = new DurableLog(path.join(space,'input/messages.jsonl'), () => {});
  messages.assertReadable();
  const lookup = id => messages.operations.get(digest(id))?.data?.message;
  for (const [kind, {file,prefix}] of continuityTypes) {
    const selected = records.filter(record => record.kind === kind).sort((a,b) =>
      kind === 'vec-memory.temporal-memory'
        ? Number(a.payload?.action === 'retract') - Number(b.payload?.action === 'retract')
        : a.key.id.localeCompare(b.key.id) || a.revision-b.revision);
    if (!selected.length) continue;
    const location = path.join(space,file);
    const writer = kind === 'vec-memory.temporal-memory' ? openTemporalMemory(location,lookup)
      : openContinuity(location,lookup,kind === 'vec-memory.role-note');
    const receipts = new Map();
    // Temporal corrections depend on assertions; preserve the exported source order.
    for (const record of selected) {
      if (!supportsContinuity(record)) throw Error('Unsupported continuity record');
      const {sourceOperation, ...data} = record.payload ?? {};
      if (!sourceOperation || !/^[a-f0-9]{64}$/.test(sourceOperation.fingerprint) ||
          typeof sourceOperation.id !== 'string' || !sourceOperation.id || sourceOperation.result?.ok !== true ||
          record.key?.id !== prefix+data.id || record.revision !== (data.revision ?? 1) ||
          digest(record.references ?? []) !== digest(continuityReferences(kind,data,record.key.namespace))) {
        throw Error('Invalid continuity envelope or operation receipt');
      }
      const scope = scopeOf(data.chatKey), operationId = sourceOperation.id;
      let request;
      if (kind === 'vec-memory.temporal-memory') {
        request = {operationId,scope,actorId:data.actorId,attribute:data.attribute,
          messageId:data.sourceRef?.id,action:data.action,
          ...(data.action === 'assert' ? {value:data.value,effectiveAt:data.effectiveAt} : {targetId:data.targetId})};
      } else if (data.revision === 1) {
        if (data.id !== operationId || data.status !== 'open') throw Error('Invalid initial continuity revision');
        request = {operationId,scope,text:data.text,roleId:data.roleId,kind:data.kind,
          dayKind:data.dayKind,at:data.at,messageId:data.sourceRefs?.[0]?.id};
      } else {
        const prior = new DurableLog(location,() => {});
        prior.assertReadable();
        const previous = prior.rows.filter(row => row.data.id === data.id).at(-1)?.data;
        const occurred = previous?.dayKind === 'planned' && data.dayKind === 'occurred';
        request = {operationId,scope,id:data.id,roleId:data.roleId,expectedRevision:data.revision-1,
          ...(occurred ? {dayKind:'occurred',at:data.at,messageId:data.sourceRefs?.at(-1)?.id} : {status:data.status})};
      }
      writer.write(request);
      const check = new DurableLog(location,() => {});
      check.assertReadable();
      const written = check.operations.get(operationId);
      if (!written || digest(written.data) !== digest(data) || digest(written.result) !== digest(sourceOperation.result)) {
        throw Error('Imported continuity record differs from validated runtime state');
      }
      receipts.set(operationId,sourceOperation.fingerprint);
    }
    const journal = new DurableLog(location,() => {});
    journal.assertReadable();
    let previous = '';
    const lines = journal.rows.map(row => {
      const {hash, ...payload} = row;
      payload.previous = previous;
      payload.fingerprint = receipts.get(row.operationId) ?? row.fingerprint;
      const next = {...payload,hash:digest(payload)};
      previous = next.hash;
      return JSON.stringify(next)+'\n';
    });
    const handle = await fs.open(location,'w',0o600);
    try {await handle.writeFile(lines.join(''));await handle.sync();} finally {await handle.close();}
  }
}
