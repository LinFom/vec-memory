import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { MemoryError, digest } from '../core/durable-log.mjs';
import { createSpaceEngine } from './engine.mjs';

const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new MemoryError('INVALID_ID', 'Invalid identifier');
  return value;
};
const hash = token => createHash('sha256').update(token).digest('hex');
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }

export function initialize(root) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, 'access.json'))) throw new Error('Already initialized');
  const token = randomBytes(32).toString('base64url');
  saveJson(path.join(root, 'access.json'), { version: 1, adminHash: hash(token), projects: {}, spaces: {} });
  return token;
}

export function createService({ root, engineFactory = createSpaceEngine } = {}) {
  root = path.resolve(root);
  const accessFile = path.join(root, 'access.json');
  if (!fs.existsSync(accessFile)) throw new Error('Initialize the standalone service first');
  const lockFile = path.join(root, '.service.lock');
  if (fs.existsSync(lockFile)) {
    const owner = read(lockFile);
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another service owns this data root');
    fs.unlinkSync(lockFile);
  }
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); fs.closeSync(lock);
  const engines = new Map(), queues = new Map();
  let closed = false, closePromise;
  const engine = spaceId => {
    if (!engines.has(spaceId)) engines.set(spaceId, engineFactory({ root: path.join(root, 'spaces', spaceId) }));
    return engines.get(spaceId);
  };
  async function invoke(sid, operation, payload) {
    const result = await engine(sid).call(operation, payload);
    if (result?.ok === false || operation === 'adoption' && result?.accepted === false) throw new MemoryError(result?.code || 'ENGINE_REJECTED', result?.error || result?.reason || 'Engine rejected operation', 409);
    return result;
  }
  const stateFile = sid => path.join(root, 'spaces', sid, 'state.json');
  const state = sid => read(stateFile(sid), { jobs: {}, receipts: {} });
  const serial = (sid, fn) => {
    const next = (queues.get(sid) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(sid, next); return next;
  };
  function principal(token, access) {
    if (!token) throw new MemoryError('UNAUTHENTICATED', 'Bearer credential required', 401);
    const fingerprint = hash(token);
    if (fingerprint === access.adminHash) return { admin: true, projectId: null };
    const match = Object.entries(access.projects).find(([, p]) => p.tokenHash === fingerprint);
    if (!match) throw new MemoryError('UNAUTHENTICATED', 'Invalid credential', 401);
    return { admin: false, projectId: match[0] };
  }
  function permit(access, who, sid, write = false) {
    const space = access.spaces[id(sid)];
    if (!space) throw new MemoryError('NOT_FOUND', 'Space not found', 404);
    if (who.admin || space.owner === who.projectId || !write && space.readers.includes(who.projectId)) return space;
    throw new MemoryError('FORBIDDEN', 'Space permission denied', 403);
  }
  async function runJob(sid, jobId) {
    if (closed) return;
    await serial(sid, async () => {
      const current = state(sid), job = current.jobs[jobId];
      if (!job || !['queued', 'running'].includes(job.status)) return;
      job.status = 'running'; job.startedAt = new Date().toISOString(); saveJson(stateFile(sid), current);
      try {
        const result = await engine(sid).call('job', { type: job.type, ...job.options });
        if (result?.ok === false) throw new MemoryError(result.code || 'JOB_FAILED', result.error || 'Job failed', 503);
        Object.assign(job, { status: 'completed', result });
      } catch (error) { Object.assign(job, { status: 'failed', error: { code: error.code || 'JOB_FAILED', message: error.message } }); }
      job.finishedAt = new Date().toISOString();
      const latest = state(sid); latest.jobs[jobId] = job; saveJson(stateFile(sid), latest);
    });
  }
  const access = read(accessFile);
  for (const sid of Object.keys(access.spaces)) for (const job of Object.values(state(sid).jobs)) {
    if (['queued', 'running'].includes(job.status)) setImmediate(() => void runJob(sid, job.id));
  }
  return {
    async handle({ method = 'GET', path: requestPath, token, body = {} }) {
      try {
        if (closed) throw new MemoryError('UNAVAILABLE', 'Service is closed', 503);
        const access = read(accessFile), who = principal(token, access);
        const url = new URL(requestPath, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== 'api' || parts[1] !== 'v1') throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
        const finish = value => ({ status: 200, body: { ok: true, ...value } });
        if (parts[2] === 'version' && method === 'GET') return finish({ protocolVersion: 1, implementationVersion: '0.31.0', capabilities: ['spaces', 'messages', 'entities', 'memories', 'recall', 'adoptions', 'jobs', 'sharing', 'subjects', 'discoveries', 'subject-revisions'] });
        if (parts[2] === 'admin') {
          if (!who.admin) throw new MemoryError('FORBIDDEN', 'Administrator credential required', 403);
          if (parts[3] === 'projects' && parts.length === 4 && method === 'POST') {
            const projectId = id(body.projectId);
            if (access.projects[projectId]) throw new MemoryError('ALREADY_EXISTS', 'Project already exists', 409);
            const projectToken = randomBytes(32).toString('base64url');
            access.projects[projectId] = { tokenHash: hash(projectToken) }; saveJson(accessFile, access);
            return finish({ projectId, token: projectToken });
          }
          if (parts[3] === 'spaces' && parts.length === 4 && method === 'GET') return finish({ spaces: access.spaces, projects: Object.keys(access.projects) });
          if (parts[3] === 'spaces' && parts.length === 4 && method === 'POST') {
            const sid = id(body.spaceId), owner = id(body.owner);
            if (!access.projects[owner]) throw new MemoryError('INVALID_OWNER', 'Unknown project');
            if (access.spaces[sid]) throw new MemoryError('ALREADY_EXISTS', 'Space already exists', 409);
            access.spaces[sid] = { owner, readers: [] }; saveJson(accessFile, access);
            return finish({ spaceId: sid });
          }
          const sid = id(parts[4]); permit(access, who, sid);
          if (parts[3] === 'spaces' && parts[5] === 'readers' && method === 'PUT') {
            if (!Array.isArray(body.projectIds) || body.projectIds.some(p => !access.projects[p])) throw new MemoryError('INVALID_ARGUMENT', 'Known projectIds required');
            access.spaces[sid].readers = [...new Set(body.projectIds)]; saveJson(accessFile, access); return finish({ spaceId: sid });
          }
          if (parts[3] === 'spaces' && parts[5] === 'settings') {
            const file = path.join(root, 'spaces', sid, 'settings.json');
            if (method === 'GET') {
              const settings = read(file, {});
              return finish({ values: Object.fromEntries(Object.entries(settings).filter(([k]) => !/key|token|secret/i.test(k))), secrets: Object.fromEntries(Object.entries(settings).filter(([k]) => /key|token|secret/i.test(k)).map(([k, v]) => [k, Boolean(v)])) });
            }
            if (method === 'PUT') {
              const patch = body.patch;
              if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new MemoryError('INVALID_ARGUMENT', 'patch required');
              const allowed = /^(embed(BaseURL|ApiKey|Model|Revision|BatchSize|TimeoutMs|Dimensions)|llm(BaseURL|ApiKey|Model|TimeoutMs|EndpointKind)|topK|consolidateEnabled|consolidateIntervalMin|consolidateWindowMsgs|consolidateWindowSpanMin|consolidateSettleMin|consolidateMaxWindowsPerRun|consolidateTimeoutMs|promoteHits|autoIndexEnabled|autoIndexIntervalMin|injectEnabled|rememberEnabled|profileCrossScope|thingDiscoveryEnabled|subjectMemoryEnabled)$/;
              if (Object.keys(patch).some(k => !allowed.test(k))) throw new MemoryError('INVALID_SETTING', 'Unsupported setting');
              const settings = read(file, {});
              for (const [k,v] of Object.entries(patch)) { if (/key/i.test(k) && v === '') continue; if (v === null) delete settings[k]; else settings[k] = v; }
              saveJson(file, settings); return finish({ changed: true });
            }
          }
          throw new MemoryError('NOT_FOUND', 'Unknown management route', 404);
        }
        if (parts[2] !== 'spaces') throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
        const sid = id(parts[3]), operation = parts[4];
        if (operation === 'readers' && method === 'PUT') {
          const space = permit(access, who, sid, true);
          if (!Array.isArray(body.projectIds) || body.projectIds.some(p => !access.projects[p])) throw new MemoryError('INVALID_ARGUMENT', 'Known projectIds required');
          space.readers = [...new Set(body.projectIds)]; saveJson(accessFile, access); return finish({ spaceId: sid });
        }
        const writes = ['messages','entities','memories','jobs','adoptions','discoveries'];
        permit(access, who, sid, writes.includes(operation) || operation === 'subjects' && method !== 'GET');
        if (operation === 'discoveries' && parts.length === 5 && method === 'POST') return finish(await serial(sid, () => invoke(sid, 'discover', body)));
        if (operation === 'subjects' && [5,6].includes(parts.length) && method === 'GET') {
          const scope = { kind: url.searchParams.get('scopeKind'), id: url.searchParams.get('scopeId') };
          return finish(await invoke(sid, parts[5] ? 'subject' : 'subjects', { scope, q: url.searchParams.get('q') || '', subjectId: parts[5] }));
        }
        if (operation === 'subjects' && parts.length === 7 && parts[6] === 'revisions' && method === 'POST') return finish(await serial(sid, () => invoke(sid, 'subjectRevision', { ...body, subjectId: parts[5] })));
        if (operation === 'messages' && method === 'POST') return finish(await serial(sid, () => engine(sid).call('ingest', body)));
        if (operation === 'entities' && method === 'PUT') return finish(await serial(sid, () => engine(sid).call('entity', { ...body, entityId: decodeURIComponent(parts[5] || '') })));
        if (operation === 'memories' && method === 'POST') return finish(await serial(sid, () => engine(sid).call('remember', body)));
        if (operation === 'status' && method === 'GET') return finish(await engine(sid).call('status', {}));
        if (operation === 'recall' && method === 'POST') {
          if (!Array.isArray(body.sharedSpaceIds ?? [])) throw new MemoryError('INVALID_ARGUMENT', 'sharedSpaceIds must be an array');
          const sources = [...new Set([sid, ...(body.sharedSpaceIds || [])])];
          for (const source of sources) permit(access, who, source);
          const results = await Promise.all(sources.map(async source => ({ source, result: await invoke(source, 'recall', { ...body, sharedSpaceIds: [] }) })));
          // Permissions may have been revoked while an embedding call was in flight.
          const latestAccess = read(accessFile); const latestWho = principal(token, latestAccess);
          for (const source of sources) permit(latestAccess, latestWho, source);
          const items = results.flatMap(({source, result}) => (result.items || []).map(item => ({ ...item, id: `${source}:${item.id}`, localId: item.id, spaceId: source })));
          const receiptId = randomUUID();
          await serial(sid, async () => {
            const current = state(sid);
            current.receipts = Object.fromEntries(Object.entries(current.receipts).filter(([,r]) => r.expiresAt > Date.now()));
            current.receipts[receiptId] = { projectId: who.projectId, expiresAt: Date.now() + 60000, items, sources: results.map(({source,result}) => ({ spaceId: source, receiptId: result.receiptId })), adopted: [] };
            saveJson(stateFile(sid), current);
          });
          const finalAccess = read(accessFile), finalWho = principal(token, finalAccess);
          for (const source of sources) permit(finalAccess, finalWho, source);
          return finish({ items, block: results.map(({source,result}) => result.block ? `[${source}]\n${result.block}` : '').filter(Boolean).join('\n\n'), receiptId, actualMode: Object.fromEntries(results.map(({source,result}) => [source,result.actualMode])), sources });
        }
        if (operation === 'adoptions' && method === 'POST') return finish(await serial(sid, async () => {
          const current = state(sid), receipt = current.receipts[body.receiptId];
          if (!receipt || receipt.expiresAt <= Date.now()) throw new MemoryError('INVALID_RECEIPT', 'Receipt missing or expired', 409);
          if (receipt.projectId !== who.projectId) throw new MemoryError('FORBIDDEN', 'Receipt belongs to another project', 403);
          const fresh = read(accessFile), actor = principal(token, fresh);
          for (const source of receipt.sources) permit(fresh, actor, source.spaceId);
          const selected = body.itemIds ?? receipt.items.map(item => item.id);
          if (!Array.isArray(selected) || selected.some(itemId => !receipt.items.some(item => item.id === itemId))) throw new MemoryError('INVALID_ARGUMENT', 'Unknown item in receipt');
          const pending = [...new Set(selected)].filter(itemId => !receipt.adopted.includes(itemId));
          for (const source of receipt.sources) {
            const local = receipt.items.filter(item => item.spaceId === source.spaceId && pending.includes(item.id)).map(item => item.localId);
            if (local.length && source.receiptId) await invoke(source.spaceId, 'adoption', { receiptId: source.receiptId, itemIds: local });
          }
          receipt.adopted.push(...pending); saveJson(stateFile(sid), current);
          return { adopted: pending.length, replayed: !pending.length };
        }));
        if (operation === 'jobs' && method === 'POST') {
          if (!['consolidate','index'].includes(body.type)) throw new MemoryError('INVALID_JOB', 'type must be consolidate or index');
          const result = await serial(sid, async () => {
            const current = state(sid);
            if (body.operationId) { const old = Object.values(current.jobs).find(j => j.operationId === body.operationId); if (old) { if (old.fingerprint !== digest(body)) throw new MemoryError('OPERATION_CONFLICT', 'Job operation conflict', 409); return old; } }
            const job = { id: randomUUID(), type: body.type, options: {}, operationId: body.operationId, fingerprint: digest(body), status: 'queued', createdAt: new Date().toISOString() };
            current.jobs[job.id] = job; saveJson(stateFile(sid), current); return job;
          });
          setImmediate(() => void runJob(sid, result.id)); return finish({ job: result, jobId: result.id });
        }
        if (operation === 'jobs' && method === 'GET') { const jobs = state(sid).jobs; if (parts[5]) { const job = jobs[parts[5]]; if (!job) throw new MemoryError('NOT_FOUND', 'Job not found', 404); return finish({ job }); } return finish({ jobs: Object.values(jobs) }); }
        throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
      } catch (error) { return { status: error.status || 500, body: { ok: false, code: error.code || 'INTERNAL_ERROR', error: error.status ? error.message : 'Internal service error' } }; }
    },
    close() { return closePromise ??= (async () => { closed = true; await Promise.allSettled([...queues.values()]); await Promise.allSettled([...engines.values()].map(e => e.close())); if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); })(); }
  };
}
