import {unionGraphs} from '../core/graph-union.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { MemoryError, digest } from '../core/durable-log.mjs';
import { createSpaceEngine } from './engine.mjs';
import { naturalRecallLimit } from './natural-recall.mjs';
import { inspectAnyFile, restoreAnyFile, normalizeBackupMode } from './backup.mjs';
import { runBackupTask } from './backup-runner.mjs';
import { beginProgress, reportProgress, finishProgress, progressSnapshot } from './backup-progress.mjs';
import { SETTINGS_FIELDS, validateValue } from '../core/settings-editor.mjs';
const IMPLEMENTATION_VERSION=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;

// 可写设置面的唯一来源是 core/settings-editor.mjs 的 SETTINGS_FIELDS —— 面板、CLI、这里共用同一份。
// 之前这里手抄了一条正则，只覆盖 32 个键，被挡住的那 20 个（injectThreshold / injectPerPerson /
// injectMode / shadowMode / crossChat* / retireDays ...）正是「采用与召回」和「跨会话近况」的核心，
// 于是面板能看见却改不了。抄本还会随 schema 漂移，所以改成派生而不是再抄一遍。
// 身份键不开放：botName / selfAliases 写错会让归一化器认错人，属于「改错不报错」的一类。
const IDENTITY_SETTINGS = new Set(['botName', 'selfAliases']);
const settingsFields = new Map(
  SETTINGS_FIELDS.filter(field => !IDENTITY_SETTINGS.has(field.key)).map(field => [field.key, field])
);

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

async function trackBackup(action, label, run, extra) {
  beginProgress(action, label);
  try {
    const result = await run();
    finishProgress(null, extra);
    return result;
  } catch (error) {
    finishProgress(error);
    throw error;
  }
}

export function initialize(root) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, 'access.json'))) throw new Error('Already initialized');
  const token = randomBytes(32).toString('base64url');
  saveJson(path.join(root, 'access.json'), { version: 1, adminHash: hash(token), projects: {}, spaces: {} });
  return token;
}


export function recoverSpaceImport(root) {
  const intentFile = path.join(root, 'import-intent.json');
  if (!fs.existsSync(intentFile)) return;
  const intent = read(intentFile);
  const spaces = path.join(root, 'spaces');
  const destination = path.join(spaces, id(intent.sid));
  if (path.resolve(intent.destination) !== destination ||
      [intent.staging, intent.rollback].filter(Boolean).some(target =>
        path.dirname(path.resolve(target)) !== spaces)) throw Error('Invalid import recovery path');
  if (!fs.existsSync(destination)) {
    fs.renameSync(fs.existsSync(intent.staging) ? intent.staging : intent.rollback, destination);
  }
  if (intent.preserveAccess !== true) {
    const accessFile = path.join(root, 'access.json');
    const access = read(accessFile);
    access.spaces[intent.sid] = { owner: intent.owner, readers: [] };
    saveJson(accessFile, access);
  }
  fs.unlinkSync(intentFile);
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
  try { recoverSpaceImport(root); } catch (error) { fs.unlinkSync(lockFile); throw error; }
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
      await Promise.all([...engines.values()].map(async worker => {
        if (worker.closed) return;
        try { await worker.call('quiesce', {}); }
        catch (error) { if (!worker.closed) throw error; }
      }));
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
    const current = engines.get(spaceId);
    if (!current || current.closed) engines.set(spaceId, engineFactory({ root: path.join(root, 'spaces', spaceId) }));
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
  // 索引事实在 worker（history-index/ 目录），任务事实在主进程（state.json）。
  // status 是唯一要把两边拼起来的地方，权限也顺手在这里判：
  // 只读读者能看索引状态，但不能重建 —— 这条和前端「当前账号仅可查看」是同一件事。
  function withHistoryJob(body, sid, access, who) {
    const space = access.spaces[id(sid)];
    const jobs = Object.values(state(sid).jobs).filter(job => job.type === 'history-lexical');
    jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const latest = jobs[0] || null;
    const hi = body.historyIndex || { generation: null, watermark: 0, sourceRows: 0, format: 'jsonl', encoding: 'utf-8', sourceHead: null };
    const building = latest && ['queued','running'].includes(latest.status) && latest.building
      ? { ...latest.building, jobId: latest.id } : null;
    return {
      ...body,
      canRebuildHistoryIndex: who.admin === true || space?.owner === who.projectId,
      historyIndex: {
        ...hi,
        building,
        lastJob: latest ? { id: latest.id, status: latest.status, createdAt: latest.createdAt ?? null, finishedAt: latest.finishedAt ?? null, error: latest.error ?? null, operationId: latest.operationId ?? null } : null
      }
    };
  }
  // 重建进度写回任务表：前端轮询 GET /jobs/{id} 读的就是 job.building.indexedRows。
  // 这里每来一条就落盘一次，所以 worker 侧已经按 400ms 节流，不要在这里再攒。
  function recordHistoryProgress(sid, jobId, progress) {
    const latest = state(sid), job = latest.jobs[jobId];
    if (!job || !['queued','running'].includes(job.status)) return;
    job.building = { indexedRows: Number(progress?.indexedRows) || 0, sourceRows: Number(progress?.sourceRows) || 0, jobId };
    saveJson(stateFile(sid), latest);
  }
  function updateReaders(access, space, projectIds) {
    if (!Array.isArray(projectIds) || projectIds.some(project => !access.projects[project])) {
      throw new MemoryError('INVALID_ARGUMENT', 'Known projectIds required');
    }
    space.readers = [...new Set(projectIds)];
    saveJson(accessFile, access);
  }
  async function runJob(sid, jobId) {
    if (closed || maintenance) return;
    await serial(sid, async () => {
      const current = state(sid), job = current.jobs[jobId];
      if (!job || !['queued', 'running'].includes(job.status)) return;
      if(job.pauseRequested){job.status='paused';saveJson(stateFile(sid),current);return;}
      job.status = 'running'; job.startedAt = new Date().toISOString(); saveJson(stateFile(sid), current);
      try {
        const result = await engine(sid).call(job.type==='relations'?'relationBackfill':'job', { type: job.type, ...job.options,jobId:job.id }, job.type==='history-lexical'?{onProgress:progress=>{try{recordHistoryProgress(sid,jobId,progress);}catch{}}}:{});
        if (result?.ok === false) throw new MemoryError(result.code || 'JOB_FAILED', result.error || 'Job failed', 503);
        Object.assign(job, { status: job.type==='relations'&&!result.done?'queued':'completed', result });
        // 完成/失败时进度条要收掉：building 只描述「正在建」，留着会让界面一直显示跑不完的进度。
        delete job.building;
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
      const url = new URL(requestPath, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      // 进度查询故意放在维护闸之前、且不计入 active：
      //   ① 备份/恢复全程 maintenance=true，放到闸后前端永远读不到进度，只能看到 503；
      //   ② 计入 active 会让 exclusive() 的「排空在跑请求」一直等到轮询不再进来，进而互相等死。
      if (method === 'GET' && parts.length === 5 && parts.join('/') === 'api/v1/admin/backups/progress') {
        const access = read(accessFile);
        const who = principal(token, access, local);
        if (!who.admin) return {status:403,body:{ok:false,code:'FORBIDDEN',error:'Administrator credential required'}};
        return {status:200,body:{ok:true,...progressSnapshot()}};
      }
      if (maintenance) return {status:503,body:{ok:false,code:'MAINTENANCE',error:'Backup or import in progress; retry shortly'}};
      active++;
      try {
        if (closed) throw new MemoryError('UNAVAILABLE', 'Service is closed', 503);
        const access = read(accessFile), who = principal(token, access, local);
        if (parts[0] !== 'api' || parts[1] !== 'v1') throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
        function recheckAccess(spaceIds, write = false) {
          const latest = read(accessFile);
          const actor = principal(token, latest, local);
          for (const spaceId of spaceIds) permit(latest, actor, spaceId, write);
        }
        const finish = value => ({ status: 200, body: { ok: true, ...value } });
        if (parts[2] === 'version' && method === 'GET') return finish({ protocolVersion: 1, implementationVersion: IMPLEMENTATION_VERSION, capabilities: ['spaces', 'messages', 'entities', 'memories', 'observations', 'natural-recall', 'recall', 'adoptions', 'jobs', 'sharing', 'subjects', 'discoveries', 'subject-revisions','backups','scenes','account-links','person-revisions','relationship-graph','relationship-revisions','relation-backfill','temporal-memory','role-notes','continuity-tasks','space-readiness'] });
        if (parts[2] === 'admin') {
          if (!who.admin) throw new MemoryError('FORBIDDEN', 'Administrator credential required', 403);
          if (parts[3] === 'backups') {
            const dir = path.join(root,'backups'); fs.mkdirSync(dir,{recursive:true});
            const file = name => path.join(dir,id(name)+'.vmb');
            if (parts[4] && method === 'GET') {
              // 流式下发：几百 MB 的备份不再整体读进内存再一次性写出去。
              const target = file(parts[4]), stat = fs.statSync(target);
              return {status:200,stream:()=>fs.createReadStream(target),size:stat.size,filename:parts[4]+'.vmb'};
            }
            if (!parts[4] && method === 'POST') {
              const backupId = randomUUID();
              if (body.uploadPath) {
                // 上传走临时文件：先校验，通过才落到正式文件名。校验放 worker —— 几百 MB 的
                // gzip 解开算哈希留在主线程会让整个页面变慢。
                await trackBackup('upload', '正在校验上传的备份', async () => {
                  await runBackupTask('inspect', {file: body.uploadPath, password: body.password}, {onProgress: reportProgress});
                  fs.renameSync(body.uploadPath, file(backupId));
                }, {backupId});
              } else {
                // 默认证据级：只带记忆与证据。要全量原始记录必须显式说 mode:'full'。
                const mode = normalizeBackupMode(body.mode);
                // 进度在 exclusive 之前开始：关引擎/排空在跑请求那几秒也要显示「在动」。
                const what = body.spaceId ? '正在导出空间备份' : (mode === 'evidence' ? '正在导出证据级备份' : '正在生成完整备份');
                await trackBackup('create', what, () => exclusive(async () => {
                  if (body.spaceId) permit(access, who, body.spaceId);
                  await runBackupTask('create', {root, destination:file(backupId), spaceId:body.spaceId, password:body.password, mode, includeRoleNotes:body.includeRoleNotes === true}, {onProgress: reportProgress});
                }), {backupId});
              }
              return finish({backupId,download:'/api/v1/admin/backups/'+backupId});
            }
            if (parts[4] && parts[5] === 'preview' && method === 'POST') {
              const archive = await trackBackup('inspect', '正在校验备份', () =>
                runBackupTask('inspect', {file:file(parts[4]),password:body.password}, {onProgress: reportProgress}));
              return finish({kind:archive.kind,files:archive.files.length,totalBytes:archive.totalBytes,checksum:archive.checksum,sourceSpaceId:archive.spaceId,
                  mode:archive.mode||'full',evidenceOnly:(archive.mode||'full')==='evidence',excluded:archive.excluded||[],automaticTasksSuspendedOnRestore:true});
            }
            if (parts[4] && parts[5] === 'restore' && method === 'POST') {
              // 进度在 exclusive 之前就开始：关引擎/排空在跑请求那几秒同样要显示「在动」。
              return finish(await trackBackup('restore', '正在准备恢复（暂停后台任务）', () => exclusive(async () => {
                reportProgress({label:'正在校验备份'});
                const source = file(parts[4]), archive = await inspectAnyFile(source, body.password, reportProgress);
                if (!body.expectedChecksum || body.expectedChecksum !== archive.checksum) throw new MemoryError('BACKUP_CHANGED','Preview and supply its checksum first',409);
                // 上面这一遍已经验过整份文件（密码 + 校验和），restore 里不必再解压一遍。
                const options = {...body, onProgress: reportProgress, verifiedChecksum: archive.checksum};
                reportProgress({label:'正在恢复文件'});
                if (archive.kind === 'service') {
                  const result = await restoreAnyFile(source, root + '.restore-' + randomUUID(), options);
                  reportProgress({phase:'validate',label:'正在校验恢复结果'});
                  await validateRestored(result.destination, 'service');
                  return {...result, validated: true};
                }
                const sid = id(body.spaceId), owner = id(body.owner);
                if (!access.projects[owner]) throw new MemoryError('INVALID_OWNER','Known owner required');
                if (access.spaces[sid] && body.replace !== true) throw new MemoryError('ALREADY_EXISTS','Choose a new space or explicitly replace',409);
                const destination = path.join(root,'spaces',sid), staging = destination+'.import-'+randomUUID();
                const result = await restoreAnyFile(source,staging,options);
                reportProgress({phase:'validate',label:'正在校验恢复结果'});
                await validateRestored(staging,'space');
                const rollback = fs.existsSync(destination) ? destination+'.rollback-'+randomUUID() : null;
                // Durable intent makes an interrupted pair of renames recoverable on startup.
                const intentFile=path.join(root,'import-intent.json');
                saveJson(intentFile,{destination,staging,rollback,sid,owner});
                if (rollback) fs.renameSync(destination,rollback);
                fs.renameSync(staging,destination);
                access.spaces[sid]={owner,readers:[]}; saveJson(accessFile,access);
                // intent 文件删不掉不该让「已经成功的恢复」被报成失败：启动时的重放逻辑是幂等的
                // （destination 已存在就什么都不做），残留只是一个下次启动会顺手清掉的小文件。
                try { fs.unlinkSync(intentFile); } catch { /* 幂等重放兜底 */ }
                return {...result,destination,spaceId:sid,rollback};
              })));
            }
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
          const sid = parts[4];
          const space = permit(access, who, sid);
          if (parts[3] === 'spaces' && parts[5] === 'readers' && method === 'PUT') {
            updateReaders(access, space, body.projectIds);
            return finish({ spaceId: sid });
          }
          if (parts[3] === 'spaces' && parts[5] === 'settings') {
            const file = path.join(root, 'spaces', sid, 'settings.json');
            if (method === 'GET') {
              const settings = read(file, {});
              // fields 一并下发：面板据此渲染分组/标签/取值范围，不必自己再抄一份 schema，
              // 也不必去 import 源码。它和 PUT 的校验用的是同一份 SETTINGS_FIELDS。
              return finish({
                values: Object.fromEntries(Object.entries(settings).filter(([k]) => !/key|token|secret/i.test(k))),
                secrets: Object.fromEntries(Object.entries(settings).filter(([k]) => /key|token|secret/i.test(k)).map(([k, v]) => [k, Boolean(v)])),
                fields: [...settingsFields.values()]
              });
            }
            if (method === 'PUT') {
              const patch = body.patch;
              if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new MemoryError('INVALID_ARGUMENT', 'patch required');
              const settings = read(file, {});
              const clean = {};
              for (const [key, value] of Object.entries(patch)) {
                const field = settingsFields.get(key);
                if (!field) throw new MemoryError('INVALID_SETTING', 'Unsupported setting');
                // 空字符串的密钥框 = 保持原值（面板显示的是「已设置」，不该被空值覆盖）。
                if (field.type === 'secret' && value === '') continue;
                clean[key] = value === null ? null : validateValue(field, value);
              }
              for (const [key, value] of Object.entries(clean)) { if (value === null) delete settings[key]; else settings[key] = value; }
              saveJson(file, settings); return finish({ changed: true, keys: Object.keys(clean) });
            }
          }
          throw new MemoryError('NOT_FOUND', 'Unknown management route', 404);
        }
        if (parts[2] !== 'spaces') throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
        const sid = id(parts[3]), operation = parts[4];
        if(operation==='graph'&&method==='POST') {
          if(!Array.isArray(body.sharedSpaceIds??[])||(body.sharedSpaceIds||[]).length>20)throw new MemoryError('INVALID_ARGUMENT','sharedSpaceIds must be an array (maximum 20)');
          const sources=[...new Set([sid,...(body.sharedSpaceIds||[])])];
          for (const source of sources) permit(access, who, source);
          const results=await Promise.all(sources.map(async source=>({source,result:await invoke(source,'graph',{...body,admin:who.admin})})));
          recheckAccess(sources);
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
          updateReaders(access, space, body.projectIds);
          return finish({ spaceId: sid });
        }
        if (['temporal-memory', 'role-notes', 'continuity-tasks'].includes(operation) && method === 'POST') {
          const engineOperation = operation === 'temporal-memory' ? 'temporal' : operation === 'role-notes' ? 'roleNotes' : 'tasks';
          const write = parts.length === 5;
          if (write || parts.length === 6 && parts[5] === 'query') {
            permit(access, who, sid, write);
            if (write) return finish(await serial(sid, () => {
              recheckAccess([sid], true);
              return invoke(sid, engineOperation + 'Write', body);
            }));
            const result = await invoke(sid, engineOperation + 'Query', body);
            recheckAccess([sid]);
            return finish(result);
          }
        }
        const writes = ['messages','entities','memories','observations','jobs','adoptions','discoveries'];
        permit(access, who, sid, writes.includes(operation) || operation === 'subjects' && method !== 'GET');
        if (operation === 'discoveries' && parts.length === 5 && method === 'POST') return finish(await serial(sid, () => invoke(sid, 'discover', body)));
        if (operation === 'subjects' && [5,6].includes(parts.length) && method === 'GET') {
          const scope = { kind: url.searchParams.get('scopeKind'), id: url.searchParams.get('scopeId') };
          return finish(await invoke(sid, parts[5] ? 'subject' : 'subjects', { scope, q: url.searchParams.get('q') || '', subjectId: parts[5] }));
        }
        if (operation === 'subjects' && parts.length === 7 && parts[6] === 'revisions' && method === 'POST') return finish(await serial(sid, () => invoke(sid, 'subjectRevision', { ...body, subjectId: parts[5] })));
        if (operation === 'messages' && method === 'POST') return finish(await serial(sid, () => engine(sid).call('ingest', body)));
        if (operation === 'entities' && method === 'PUT') return finish(await serial(sid, () => engine(sid).call('entity', { ...body, entityId: decodeURIComponent(parts[5] || '') })));
        if (operation === 'observations' && method === 'POST') return finish(await serial(sid, () => invoke(sid, 'observe', body)));
        if (operation === 'memories' && method === 'POST') return finish(await serial(sid, () => engine(sid).call('remember', body)));
        if (operation === 'status' && method === 'GET') {
          const body = await engine(sid).call('status', {});
          return finish(withHistoryJob(body, sid, access, who));
        }
        if (operation === 'readiness' && method === 'GET' && parts.length === 5) {
          const result = await invoke(sid, 'readiness', {});
          recheckAccess([sid]);
          return finish(result);
        }
        if (operation === 'recall' && method === 'POST') {
          if (body.observations !== undefined) {
            if (body.purpose !== 'query' || (body.sharedSpaceIds !== undefined &&
                (!Array.isArray(body.sharedSpaceIds) || body.sharedSpaceIds.length))) {
              throw new MemoryError('INVALID_ARGUMENT', 'Structured recall requires a query in one space');
            }
            const result = await invoke(sid, 'recall', body);
            const freshAccess = read(accessFile);
            permit(freshAccess, principal(token, freshAccess, local), sid);
            return finish(result);
          }
          if (!Array.isArray(body.sharedSpaceIds ?? [])) throw new MemoryError('INVALID_ARGUMENT', 'sharedSpaceIds must be an array');
          const sources = [...new Set([sid, ...(body.sharedSpaceIds || [])])];
          for (const source of sources) permit(access, who, source);
          const results = await Promise.all(sources.map(async source => ({ source, result: await invoke(source, 'recall', { ...body, sharedSpaceIds: [] }) })));
          // Permissions may have been revoked while an embedding call was in flight.
          recheckAccess(sources);
          let items = results.flatMap(({source, result}) => (result.items || []).map(item => ({ ...item, id: `${source}:${item.id}`, localId: item.id, spaceId: source })));
          if (body.purpose === 'automatic' && body.natural === true) {
            const limit=naturalRecallLimit(body);
            const priority = { observation: 2, subject: 1, semantic: 0, profile: 0, evidence: 0 };
            items=items.filter(item=>Object.hasOwn(priority,item.layer))
              .sort((a,b)=>priority[b.layer]-priority[a.layer] || (Number(b.score)||0)-(Number(a.score)||0)).slice(0,limit);
          } else if(body.purpose==='automatic') {
            const leads=new Set(items.filter(i=>['semantic','profile'].includes(i.layer))
              .sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)).slice(0,2).map(i=>i.id));
            items=items.filter(i=>!['semantic','profile'].includes(i.layer)||leads.has(i.id));
          }
          if (body.agentView === true) {
            const limit = body.purpose === 'automatic' ? body.natural===true?naturalRecallLimit(body):1 : Math.min(8, Math.max(1, Number(body.limit) || 3));
            const seen = new Set();
            items = items.filter(item => {
              if (seen.has(item.text)) return false;
              seen.add(item.text);
              return true;
            }).slice(0, limit);
          }
          const receiptId = randomUUID();
          await serial(sid, async () => {
            const current = state(sid);
            current.receipts = Object.fromEntries(Object.entries(current.receipts).filter(([,r]) => r.expiresAt > Date.now()));
            current.receipts[receiptId] = { projectId: who.projectId, expiresAt: Date.now() + 60000, items, sources: results.map(({source,result}) => ({ spaceId: source, receiptId: result.receiptId })), adopted: [] };
            saveJson(stateFile(sid), current);
          });
          recheckAccess(sources);
          const block=body.agentView===true ? items.map(i=>i.text).join('\n') : body.purpose==='automatic'?(items.length?'<!--mv-inject-->\n'+items.map(i=>`[${i.spaceId}]【${i.layer}】${i.text}`).join('\n'):''):results.map(({source,result}) => result.block ? `[${source}]\n${result.block}` : '').filter(Boolean).join('\n\n');
          return finish({ items, block, receiptId, actualMode: Object.fromEntries(results.map(({source,result}) => [source,result.actualMode])), degraded:Object.fromEntries(results.filter(({result})=>result.degraded).map(({source,result})=>[source,result.degraded])), sources });
        }
        if (operation === 'adoptions' && method === 'POST') return finish(await serial(sid, async () => {
          const current = state(sid), receipt = current.receipts[body.receiptId];
          if (!receipt || receipt.expiresAt <= Date.now()) throw new MemoryError('INVALID_RECEIPT', 'Receipt missing or expired', 409);
          if (receipt.projectId !== who.projectId) throw new MemoryError('FORBIDDEN', 'Receipt belongs to another project', 403);
          recheckAccess(receipt.sources.map(source => source.spaceId));
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
          if (!['consolidate','index','history-lexical'].includes(body.type)) throw new MemoryError('INVALID_JOB', 'type must be consolidate, index or history-lexical');
          if (body.reembedEvents !== undefined && (body.type !== 'index' || typeof body.reembedEvents !== 'boolean')) throw new MemoryError('INVALID_JOB','reembedEvents is a boolean index option');
          const result = await serial(sid, async () => {
            const current = state(sid);
            if (body.operationId) { const old = Object.values(current.jobs).find(j => j.operationId === body.operationId); if (old) { if (old.fingerprint !== digest(body)) throw new MemoryError('OPERATION_CONFLICT', 'Job operation conflict', 409); return old; } }
            const job = { id: randomUUID(), type: body.type, options: body.reembedEvents === true ? {reembedEvents:true} : {}, operationId: body.operationId, fingerprint: digest(body), status: 'queued', createdAt: new Date().toISOString() };
            current.jobs[job.id] = job; saveJson(stateFile(sid), current); return job;
          });
          setImmediate(() => void runJob(sid, result.id)); return finish({ job: result, jobId: result.id });
        }
        if (operation === 'jobs' && method === 'GET') { const jobs = state(sid).jobs; if (parts[5]) { const job = jobs[parts[5]]; if (!job) throw new MemoryError('NOT_FOUND', 'Job not found', 404); return finish({ job }); } return finish({ jobs: Object.values(jobs) }); }
        throw new MemoryError('NOT_FOUND', 'Unknown route', 404);
      } catch (error) { return { status: error.status || 500, body: { ok: false, code: error.code || 'INTERNAL_ERROR', error: error.status ? error.message : 'Internal service error' } }; }
      finally { active--; }
    },
    close() {
      return closePromise ??= (async () => {
        closed = true;
        while (active > 0) await new Promise(resolve => setTimeout(resolve, 10));
        await Promise.allSettled([...queues.values()]);
        await Promise.allSettled([...engines.values()].map(e => e.call('quiesce', {})));
        await Promise.allSettled([...engines.values()].map(e => e.close()));
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      })();
    }
  };
}
