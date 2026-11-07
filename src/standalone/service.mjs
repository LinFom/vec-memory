import {unionGraphs} from '../core/graph-union.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { MemoryError, digest } from '../core/durable-log.mjs';
import { createSpaceEngine } from './engine.mjs';
import { createBackup, inspectBackup, restoreBackup, writeBackup } from './backup.mjs';
const IMPLEMENTATION_VERSION=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;

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

export function createService({ root, engineFactory = createSpaceEngine, localAdmin = false } = {}) {
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
  const intentFile = path.join(root,'import-intent.json');
  try {
  if (fs.existsSync(intentFile)) {
    const intent = read(intentFile), prefix = path.join(root,'spaces') + path.sep;
    for (const target of [intent.destination,intent.staging,intent.rollback].filter(Boolean)) if (!path.resolve(target).startsWith(prefix)) throw new Error('Invalid import recovery path');
    if (!fs.existsSync(intent.destination)) fs.renameSync(fs.existsSync(intent.staging)?intent.staging:intent.rollback,intent.destination);
    const recovered=read(accessFile); recovered.spaces[intent.sid]={owner:intent.owner,readers:[]};saveJson(accessFile,recovered);fs.unlinkSync(intentFile);
  }
  } catch (error) {fs.unlinkSync(lockFile);throw error;}
  const engines = new Map(), queues = new Map();
  async function validateRestored(directory, kind) {
    const spaces = kind==='space' ? [directory] : Object.keys(read(path.join(directory,'access.json')).spaces).map(sid=>path.join(directory,'spaces',id(sid)));
    for (const space of spaces) { const validator=engineFactory({root:space,maintenance:true}); try {await validator.call('audit',{});} finally {await validator.close();} }
  }
  let closed = false, closePromise, maintenance = false, active = 0;
  async function exclusive(fn) {
    maintenance = true;
    const reopen = [...engines.keys()];
    try {
      while (active > 1) await new Promise(resolve => setTimeout(resolve, 10));
      await Promise.allSettled([...queues.values()]);
      await Promise.all([...engines.values()].map(e => e.call('quiesce', {})));
      await Promise.all([...engines.values()].map(e => e.close())); engines.clear();
      return await fn();
    } finally {
      await Promise.allSettled([...engines.values()].map(e=>e.close()));engines.clear();
      maintenance = false;
      for (const sid of reopen) engine(sid);
      const access = read(accessFile);
      for (const sid of Object.keys(access.spaces)) for (const job of Object.values(state(sid).jobs)) if (job.status === 'queued') setImmediate(() => void runJob(sid,job.id));
    }
  }
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
  // localAdmin（0.32.2 起）：仅当请求来自回环地址且**没有**携带凭据时才放行为管理员。
  // 带错凭据仍然拒绝 —— 免凭据是"没给钥匙就开门"，不是"钥匙错了也开门"。
  // 绑定非回环地址时由 server.mjs 直接拒绝启动，避免这个开关被暴露到局域网。
  function principal(token, access, local) {
    if (!token) {
      if (localAdmin && local) return { admin: true, projectId: null, anonymous: true };
      throw new MemoryError('UNAUTHENTICATED', 'Bearer credential required', 401);
    }
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
    if (closed || maintenance) return;
    await serial(sid, async () => {
      const current = state(sid), job = current.jobs[jobId];
      if (!job || !['queued', 'running'].includes(job.status)) return;
      if(job.pauseRequested){job.status='paused';saveJson(stateFile(sid),current);return;}
      job.status = 'running'; job.startedAt = new Date().toISOString(); saveJson(stateFile(sid), current);
      try {
        const result = await engine(sid).call(job.type==='relations'?'relationBackfill':'job', { type: job.type, ...job.options,jobId:job.id });
        if (result?.ok === false) throw new MemoryError(result.code || 'JOB_FAILED', result.error || 'Job failed', 503);
        Object.assign(job, { status: job.type==='relations'&&!result.done?'queued':'completed', result });
        if(job.type==='relations')job.options.offset=result.offset;
      } catch (error) { Object.assign(job, { status: 'failed', error: { code: error.code || 'JOB_FAILED', message: error.message } }); }
      job.finishedAt = new Date().toISOString();
      const latest = state(sid);if(latest.jobs[jobId]?.pauseRequested&&job.status==='queued'){job.pauseRequested=true;job.status='paused';}
      latest.jobs[jobId] = job; saveJson(stateFile(sid), latest);
      if(job.status==='queued')setImmediate(()=>void runJob(sid,jobId));
    });
  }
  const access = read(accessFile);
  for (const sid of Object.keys(access.spaces)) for (const job of Object.values(state(sid).jobs)) {
    if (['queued', 'running'].includes(job.status)) setImmediate(() => void runJob(sid, job.id));
  }
  return {
    async handle({ method = 'GET', path: requestPath, token, body = {}, local = false }) {
      if (maintenance) return {status:503,body:{ok:false,code:'MAINTENANCE',error:'Backup or import in progress; retry shortly'}};
      active++;
      try {
        if (closed) throw new MemoryError('UNAVAILABLE', 'Service is closed', 503);
        const access = read(accessFile), who = principal(token, access, local);
        const url = new URL(requestPath, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== 'api' || parts[1] !== 'v1') throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
        const finish = value => ({ status: 200, body: { ok: true, ...value } });
        if (parts[2] === 'version' && method === 'GET') return finish({ protocolVersion: 1, implementationVersion: IMPLEMENTATION_VERSION, capabilities: ['spaces', 'messages', 'entities', 'memories', 'recall', 'adoptions', 'jobs', 'sharing', 'subjects', 'discoveries', 'subject-revisions','backups','scenes','account-links','person-revisions','relationship-graph','relationship-revisions','relation-backfill'] });
        if (parts[2] === 'admin') {
          if (!who.admin) throw new MemoryError('FORBIDDEN', 'Administrator credential required', 403);
          if (parts[3] === 'backups') {
            const dir = path.join(root,'backups'); fs.mkdirSync(dir,{recursive:true});
            const file = name => path.join(dir,id(name)+'.vmb');
            if (parts[4] && method === 'GET') return {status:200,binary:fs.readFileSync(file(parts[4])),filename:parts[4]+'.vmb'};
            if (!parts[4] && method === 'POST') {
              const backupId = randomUUID();
              if (body.upload) { inspectBackup(body.upload,body.password); writeBackup(file(backupId),body.upload); }
              else await exclusive(async () => { if(body.spaceId) permit(access,who,id(body.spaceId)); writeBackup(file(backupId),createBackup(root,body)); });
              return finish({backupId,download:'/api/v1/admin/backups/'+backupId});
            }
            if (parts[4] && parts[5] === 'preview' && method === 'POST') {
              const archive = inspectBackup(fs.readFileSync(file(parts[4])),body.password);
              return finish({kind:archive.kind,files:archive.files.length,totalBytes:archive.totalBytes,checksum:archive.checksum,sourceSpaceId:archive.spaceId,automaticTasksSuspendedOnRestore:true});
            }
            if (parts[4] && parts[5] === 'restore' && method === 'POST') return finish(await exclusive(async () => {
              const bytes = fs.readFileSync(file(parts[4])), archive = inspectBackup(bytes,body.password);
              if (!body.expectedChecksum || body.expectedChecksum !== archive.checksum) throw new MemoryError('BACKUP_CHANGED','Preview and supply its checksum first',409);
              if (archive.kind === 'service') {const result=restoreBackup(bytes,root+'.restore-'+randomUUID(),body);await validateRestored(result.destination,'service');return {...result,validated:true};}
              const sid = id(body.spaceId), owner = id(body.owner);
              if (!access.projects[owner]) throw new MemoryError('INVALID_OWNER','Known owner required');
              if (access.spaces[sid] && body.replace !== true) throw new MemoryError('ALREADY_EXISTS','Choose a new space or explicitly replace',409);
              const destination = path.join(root,'spaces',sid), staging = destination+'.import-'+randomUUID();
              const result = restoreBackup(bytes,staging,body);
              await validateRestored(staging,'space');
              const rollback = fs.existsSync(destination) ? destination+'.rollback-'+randomUUID() : null;
              // Durable intent makes an interrupted pair of renames recoverable on startup.
              const intentFile=path.join(root,'import-intent.json');
              saveJson(intentFile,{destination,staging,rollback,sid,owner});
              if (rollback) fs.renameSync(destination,rollback);
              fs.renameSync(staging,destination);
              access.spaces[sid]={owner,readers:[]}; saveJson(accessFile,access); fs.unlinkSync(intentFile);
              return {...result,destination,spaceId:sid,rollback};
            }));
          }
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
              const allowed = /^(embed(BaseURL|ApiKey|Model|Revision|BatchSize|TimeoutMs|Dimensions)|llm(BaseURL|ApiKey|Model|TimeoutMs|EndpointKind)|topK|consolidateEnabled|consolidateIntervalMin|consolidateWindowMsgs|consolidateWindowSpanMin|consolidateSettleMin|consolidateMaxWindowsPerRun|consolidateTimeoutMs|promoteHits|autoIndexEnabled|autoIndexIntervalMin|injectEnabled|rememberEnabled|profileCrossScope|thingDiscoveryEnabled|subjectMemoryEnabled|recallPolicyMode|recallPolicyWeights|recallExposureWindow|recallExposureDecay|rerankEnabled|rerankBaseURL|rerankApiKey|rerankModel|rerankTimeoutMs|rerankTopN)$/;
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
        if(operation==='graph'&&method==='POST') {
          if(!Array.isArray(body.sharedSpaceIds??[])||(body.sharedSpaceIds||[]).length>20)throw new MemoryError('INVALID_ARGUMENT','sharedSpaceIds must be an array (maximum 20)');
          const sources=[...new Set([sid,...(body.sharedSpaceIds||[])])];sources.forEach(s=>permit(access,who,id(s)));
          const results=await Promise.all(sources.map(async source=>({source,result:await invoke(source,'graph',{...body,admin:who.admin})})));
          const fresh=read(accessFile,null);sources.forEach(s=>permit(fresh,principal(token,fresh,local),s));
          return finish({...unionGraphs(results),sources:results.map(r=>({spaceId:r.source,stats:r.result.stats})),range:results[0]?.result.range});
        }
        if(operation==='relationships'&&method==='POST'){
          permit(access,who,sid,true);if(!who.admin)throw new MemoryError('FORBIDDEN','Relationship maintenance requires administration',403);
          return finish(await serial(sid,()=>invoke(sid,'relationship',body)));
        }
        if(operation==='graph-identity'&&method==='POST'){
          permit(access,who,sid,true);if(!who.admin)throw new MemoryError('FORBIDDEN','Identity verification requires administration',403);
          return finish(await serial(sid,()=>invoke(sid,'graphIdentity',body)));
        }
        if(operation==='graph-evidence'&&method==='POST'){
          permit(access,who,sid);return finish(await invoke(sid,'graphEvidence',{...body,admin:who.admin}));
        }
        if(operation==='graph-memories'&&method==='POST'){
          permit(access,who,sid);if(!who.admin)throw new MemoryError('FORBIDDEN','Memory expansion requires administration',403);
          return finish(await invoke(sid,'graphMemories',{...body,admin:true}));
        }
        if(operation==='relation-backfill'&&method==='POST'){
          permit(access,who,sid,true);if(!who.admin)throw new MemoryError('FORBIDDEN','Historical backfill requires administration',403);
          if(body.action==='preview')return finish(await invoke(sid,'relationBackfill',{...body,preview:true}));
          if(['pause','resume'].includes(body.action)){
            const current=state(sid),job=current.jobs[body.jobId];if(!job||job.type!=='relations')throw new MemoryError('NOT_FOUND','Backfill job not found',404);
            if(body.action==='pause')job.pauseRequested=true;else{if(!['paused','failed'].includes(job.status))throw new MemoryError('INVALID_JOB','Only paused or failed jobs can resume');job.pauseRequested=false;job.status='queued';delete job.error;}
            saveJson(stateFile(sid),current);if(body.action==='resume')setImmediate(()=>void runJob(sid,job.id));return finish({job});
          }
          if(body.action==='start'){
            const preview=await invoke(sid,'relationBackfill',{...body,preview:true});if(!preview.modelConfigured)throw new MemoryError('LLM_UNCONFIGURED','Configure a model before starting historical backfill');
            const current=state(sid),job={id:randomUUID(),type:'relations',options:{from:body.from,to:body.to,scope:body.scope,snapshotCount:preview.total,offset:0},status:'queued',createdAt:new Date().toISOString()};current.jobs[job.id]=job;saveJson(stateFile(sid),current);setImmediate(()=>void runJob(sid,job.id));return finish({job});
          }
          throw new MemoryError('INVALID_OPERATION','Use preview/start/pause/resume');
        }
        if (operation === 'workspace' && method === 'POST') {
          permit(access,who,sid,!['query','scenes'].includes(body.action));
          if (['state','scene','link','retract','preview'].includes(body.action) && !who.admin) throw new MemoryError('FORBIDDEN','Administrator credential required',403);
          const readOnly=['state','scenes','query','preview'].includes(body.action);
          const call=()=>invoke(sid,'workspace',{...body,admin:who.admin});
          return finish(await (readOnly?call():serial(sid,call)));
        }
        if (operation === 'people' && method === 'POST') {
          permit(access,who,sid,body.action==='revision');
          const call=()=>invoke(sid,'person',{...body,admin:who.admin});
          return finish(await (body.action==='revision'?serial(sid,call):call()));
        }
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
          const latestAccess = read(accessFile); const latestWho = principal(token, latestAccess, local);
          for (const source of sources) permit(latestAccess, latestWho, source);
          let items = results.flatMap(({source, result}) => (result.items || []).map(item => ({ ...item, id: `${source}:${item.id}`, localId: item.id, spaceId: source })));
          if(body.purpose==='automatic') {
            const leads=new Set(items.filter(i=>['semantic','profile'].includes(i.layer))
              .sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)).slice(0,2).map(i=>i.id));
            items=items.filter(i=>!['semantic','profile'].includes(i.layer)||leads.has(i.id));
          }
          const receiptId = randomUUID();
          await serial(sid, async () => {
            const current = state(sid);
            current.receipts = Object.fromEntries(Object.entries(current.receipts).filter(([,r]) => r.expiresAt > Date.now()));
            current.receipts[receiptId] = { projectId: who.projectId, expiresAt: Date.now() + 60000, items, sources: results.map(({source,result}) => ({ spaceId: source, receiptId: result.receiptId })), adopted: [] };
            saveJson(stateFile(sid), current);
          });
          const finalAccess = read(accessFile), finalWho = principal(token, finalAccess, local);
          for (const source of sources) permit(finalAccess, finalWho, source);
          const block=body.purpose==='automatic'?(items.length?'<!--mv-inject-->\n'+items.map(i=>`[${i.spaceId}]【${i.layer}】${i.text}`).join('\n'):''):results.map(({source,result}) => result.block ? `[${source}]\n${result.block}` : '').filter(Boolean).join('\n\n');
          return finish({ items, block, receiptId, actualMode: Object.fromEntries(results.map(({source,result}) => [source,result.actualMode])), degraded:Object.fromEntries(results.filter(({result})=>result.degraded).map(({source,result})=>[source,result.degraded])), sources });
        }
        if (operation === 'adoptions' && method === 'POST') return finish(await serial(sid, async () => {
          const current = state(sid), receipt = current.receipts[body.receiptId];
          if (!receipt || receipt.expiresAt <= Date.now()) throw new MemoryError('INVALID_RECEIPT', 'Receipt missing or expired', 409);
          if (receipt.projectId !== who.projectId) throw new MemoryError('FORBIDDEN', 'Receipt belongs to another project', 403);
          const fresh = read(accessFile), actor = principal(token, fresh, local);
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
      finally { active--; }
    },
    close() { return closePromise ??= (async () => { closed = true; while(active>0)await new Promise(resolve=>setTimeout(resolve,10));await Promise.allSettled([...queues.values()]); await Promise.allSettled([...engines.values()].map(e => e.close())); if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); })(); }
  };
}
