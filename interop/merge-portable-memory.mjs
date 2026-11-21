import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/core/durable-log.mjs';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { recoverSpaceImport, saveJson, initialize } from '../src/standalone/service.mjs';
import { readPortableBundle, spacePortableRecords, supportsMessage, supportsObservation } from './preview-memory-data.mjs';
import { supportsContinuity, importContinuityRecords } from './continuity-records.mjs';

async function locate(root, spaceId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(spaceId ?? '')) throw Error('Invalid space ID');
  root = await fs.realpath(root);
  const access = JSON.parse(await fs.readFile(path.join(root, 'access.json'), 'utf8'));
  if (!Object.hasOwn(access.spaces ?? {}, spaceId)) throw Error('Space is not registered');
  const space = path.join(root, 'spaces', spaceId);
  if (await fs.realpath(space) !== space) throw Error('Unexpected space directory');
  return { root, space, spaceId, access };
}

async function versionOf(space, access) {
  const files = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Space contains a symbolic link');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const st = await fs.stat(full, { bigint:true });
        files.push([path.relative(space, full), String(st.size), String(st.mtimeNs), String(st.ctimeNs)]);
      } else throw Error('Unsupported space file');
    }
  }
  await visit(space);
  return digest([access, files]);
}

function identity(record) {
  if (typeof record?.key?.namespace !== 'string' || !record.key.namespace ||
      typeof record?.key?.id !== 'string' || !record.key.id || !Number.isSafeInteger(record.revision) ||
      record.revision < 1) throw Error('Bundle record lacks a stable revision key');
  return JSON.stringify([record.key.namespace, record.key.id]);
}

async function readPlan(root, spaceId, source) {
  const target = await locate(root, spaceId);
  const before = await versionOf(target.space, target.access);
  const incoming = await readPortableBundle(source);
  if (incoming.unsupportedCapabilities.length || incoming.assetCount) throw Error('Bundle requires unsupported capabilities or assets');
  const namespaces = new Set(incoming.records.filter(row => supportsMessage(row) || supportsObservation(row) || supportsContinuity(row))
    .map(row => row.key.namespace));
  if (namespaces.size !== 1) throw Error('Expected exactly one writable source namespace');
  const namespace = [...namespaces][0];
  const existing = await spacePortableRecords(target.space, namespace);
  const byKey = new Map();
  const install = row => {
    const key = identity(row);
    if (!byKey.has(key)) byKey.set(key, new Map());
    const versions = byKey.get(key);
    if (versions.has(row.revision) && digest(versions.get(row.revision)) !== digest(row)) {
      throw Error('Existing space contains conflicted record revisions');
    }
    versions.set(row.revision, row);
  };
  existing.forEach(install);
  const decisions = [], additions = [];
  const suppliedMessages = new Map(incoming.records.filter(supportsMessage).map(row => [identity(row), row]));
  const evidenceIntact = row => Array.isArray(row.references) && row.references.length > 0 &&
    row.references.filter(ref => ref.relation === 'vec-memory.evidence').every(ref =>
      ref.revision === 1 && suppliedMessages.has(identity({ key: ref.key, revision: ref.revision })));
  const ordered = [...incoming.records].sort((a,b)=>
    identity(a).localeCompare(identity(b)) || a.revision-b.revision);
  for (const row of ordered) {
    const key = identity(row);
    const versions = byKey.get(key);
    const same = versions?.get(row.revision);
    const latest = versions && [...versions.values()].reduce((a,b)=>a.revision>b.revision?a:b);
    let status;
    if (latest?.kind && latest.kind !== row.kind) status = 'kind-conflict';
    else if (same) status = digest(same) === digest(row) ? 'duplicate' : 'revision-conflict';
    else if (latest?.operation === 'delete' && latest.revision > row.revision) status = 'suppressed';
    else if (latest?.operation === 'delete') status = 'deletion-conflict';
    else if (supportsMessage(row)) {
      status = latest ? 'immutable-message-conflict' : 'add-message';
    } else if (supportsObservation(row) || supportsContinuity(row)) {
      const requiresEvidence = supportsObservation(row) || row.kind !== 'vec-memory.role-note' ||
        row.payload?.sourceRefs?.length || row.payload?.dayKind === 'occurred';
      if (row.operation === 'put' && requiresEvidence && !evidenceIntact(row)) {
        status = 'missing-evidence-conflict';
        decisions.push({ key: row.key, kind: row.kind, revision: row.revision, status });
        continue;
      }
      status = row.revision === (latest?.revision ?? 0) + 1 && (row.operation !== 'delete' || latest)
        ? supportsObservation(row) ? 'add-observation' : 'add-continuity' : 'revision-gap-conflict';
    } else {
      status = row.operation === 'delete' || (row.kind === 'vec-memory.message' && row.operation !== 'put')
        ? 'unsupported-deletion-conflict' : 'retain';
    }
    decisions.push({ key: row.key, kind: row.kind, revision: row.revision, status });
    if (status.startsWith('add-') || status === 'retain') {
      install(row);
      additions.push({ row, status });
    }
  }
  const fresh = await locate(root, spaceId);
  const after = await versionOf(fresh.space, fresh.access);
  if (before !== after) throw Error('Target changed during preview');
  const acceptedMessages = new Set(decisions.filter(row => row.kind === 'vec-memory.message' &&
    ['duplicate', 'add-message'].includes(row.status)).map(identity));
  for (const {row,status} of additions) {
    if (['add-observation','add-continuity'].includes(status) && row.operation === 'put' &&
        (row.references ?? []).filter(ref => ref.relation === 'vec-memory.evidence')
          .some(ref => !acceptedMessages.has(identity({ key: ref.key, revision: ref.revision })))) {
      decisions.push({ key: row.key, kind: row.kind, revision: row.revision, status: 'missing-evidence-conflict' });
    }
  }
  const token = digest([target.root, spaceId, before, namespace, incoming.records]);
  const counts = {};
  for (const { status } of decisions) counts[status] = (counts[status] ?? 0) + 1;
  return { target, namespace, existing, additions, version: before,
    report: { token, counts, canCommit: decisions.every(item => !item.status.endsWith('-conflict')), decisions } };
}

export async function previewPortableMerge(root, spaceId, source) {
  return (await readPlan(root, spaceId, source)).report;
}

async function acquireOffline(root) {
  const pathToLock = path.join(root, '.service.lock');
  let lock;
  try {
    lock = await fs.open(pathToLock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('Stop the target service before committing a merge');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    return async () => {
      await lock.close();
      await fs.unlink(pathToLock);
    };
  } catch (error) {
    await lock.close();
    await fs.unlink(pathToLock);
    throw error;
  }
}

async function populate(staging, plan) {
  const engine = createSpaceEngine({ root: staging, maintenance: true });
  try {
    const messages = plan.additions.filter(item => item.status === 'add-message');
    for (let i = 0; i < messages.length; i += 128) {
      const batch = messages.slice(i, i + 128).map(item => item.row.payload);
      const result = await engine.call('ingest', { messages: batch });
      if (result.accepted !== batch.length || result.rejected) throw Error('Staged message merge rejected an entry');
    }
    for (const { row, status } of plan.additions) {
      if (status !== 'add-observation') continue;
      await engine.call('portableObservation', { operationId: 'portable:' + digest(row), record: row });
    }
    await engine.call('audit', {});
  } finally {
    await engine.close();
  }
  await importContinuityRecords(staging,plan.additions.filter(item => item.status === 'add-continuity').map(item => item.row));
  const validator = createSpaceEngine({root:staging,maintenance:true});
  try {await validator.call('audit',{});} finally {await validator.close();}
  const input = path.join(staging, 'input');
  const retainedFile = path.join(input, 'portable-retained.json');
  const incomingRetained = plan.additions.filter(item => item.status === 'retain').map(item => item.row);
  if (incomingRetained.length) {
    let prior = [];
    try { prior = JSON.parse(await fs.readFile(retainedFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    saveJson(retainedFile, [...prior, ...incomingRetained]);
  }
  saveJson(path.join(input, 'portable-origin.json'), { namespace: plan.namespace });
  const actual = new Set((await spacePortableRecords(staging, plan.namespace)).map(digest));
  if (plan.additions.some(({ row }) => !actual.has(digest(row)))) throw Error('Staged records differ from reviewed source');
}

export async function restorePortableRecords(source,destination) {
  const target = path.resolve(destination), parent = await fs.realpath(path.dirname(target));
  await fs.access(target).then(() => {throw Error('Destination already exists');},error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const temporary = await fs.mkdtemp(path.join(parent,'vec-memory-record-restore-'));
  try {
    initialize(temporary);
    const accessFile = path.join(temporary,'access.json');
    const access = JSON.parse(await fs.readFile(accessFile,'utf8'));
    access.projects.portable = {tokenHash:'isolated-restore'};
    access.spaces.restored = {owner:'portable',readers:[]};
    saveJson(accessFile,access);
    const space = path.join(temporary,'spaces/restored');
    const engine = createSpaceEngine({root:space,maintenance:true});
    try {await engine.call('audit',{});} finally {await engine.close();}
    const plan = await previewPortableMerge(temporary,'restored',source);
    const result = await commitPortableMerge(temporary,'restored',source,plan.token);
    await fs.rename(space,target);
    return {destination:target,applied:result.applied,counts:result.counts};
  } finally {
    if (path.dirname(await fs.realpath(temporary)) === parent && path.basename(temporary).startsWith('vec-memory-record-restore-')) {
      await fs.rm(temporary,{recursive:true,force:true});
    }
  }
}

export async function commitPortableMerge(root, spaceId, source, token) {
  root = await fs.realpath(root);
  const release = await acquireOffline(root);
  let staging, intentWritten = false;
  try {
    recoverSpaceImport(root);
    const plan = await readPlan(root, spaceId, source);
    if (plan.report.token !== token) {
      if (plan.report.canCommit && !plan.additions.length) return { ...plan.report, applied: 0, replayed: true };
      throw Error('Target or bundle changed since preview');
    }
    if (!plan.report.canCommit) throw Error('Review the merge conflicts first');
    if (!plan.additions.length) return { ...plan.report, applied: 0, replayed: true };
    const { space } = plan.target;
    staging = space + '.merge-' + randomUUID();
    const rollback = space + '.rollback-' + randomUUID();
    await fs.cp(space, staging, { recursive:true, force:false, errorOnExist:true });
    await populate(staging, plan);
    const fresh = await locate(root, spaceId);
    if (await versionOf(space, fresh.access) !== plan.version) throw Error('Target changed during merge');
    const intent = path.join(root, 'import-intent.json');
    saveJson(intent, { destination:space, staging, rollback, sid: spaceId, preserveAccess: true });
    intentWritten = true;
    await fs.rename(space, rollback);
    await fs.rename(staging, space);
    await fs.unlink(intent).catch(() => {});
    return { ...plan.report, applied: plan.additions.length, rollback };
  } finally {
    try {
      if (staging && !intentWritten && path.dirname(staging) === path.join(root,'spaces') &&
          /^.+\.merge-[a-f0-9-]{36}$/i.test(path.basename(staging))) {
        const actual = await fs.realpath(staging).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (actual === staging) await fs.rm(staging, { recursive:true, force:true });
      }
    } finally {
      await release();
    }
  }
}
