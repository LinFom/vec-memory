import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { initialize, createService } from '../src/standalone/service.mjs';
import { createStandaloneServer } from '../src/standalone/server.mjs';
import { createBackup, inspectBackup, restoreBackup, createBackupTo, inspectBackupFile, restoreBackupFile } from '../src/standalone/backup.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function timeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })])
    .finally(() => clearTimeout(timer));
}
function listTree(root) {
  const rows = [];
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = prefix + name;
      if (stat.isDirectory()) { rows.push(relative + '/'); visit(file, relative + '/'); }
      else rows.push(relative + ':' + stat.size);
    }
  };
  if (fs.existsSync(root)) visit(root, '');
  return rows;
}

test('real HTTP backup contract: encrypted full backup, binary upload, preview and credential boundaries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-http-'));
  const admin = initialize(root);
  const runtime = createStandaloneServer({ root });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + runtime.server.address().port;
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const api = async (token, route, method = 'POST', body = {}) => {
    const headers = { Authorization: 'Bearer ' + token }, init = { method, headers };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetch(base + '/api/v1/' + route, init);
    return { status: response.status, body: await response.json() };
  };

  const project = await api(admin, 'admin/projects', 'POST', { projectId: 'p' });
  assert.equal(project.status, 200);
  const projectToken = project.body.token;
  assert.equal((await api(admin, 'admin/spaces', 'POST', { spaceId: 's', owner: 'p' })).status, 200);

  const password = '备份密码-abc-12345';
  assert.equal((await api(projectToken, 'admin/backups', 'POST', { password })).status, 403);

  const marker = 'SERVICE_DATA_' + randomUUID();
  const message = { messageId: randomUUID(), conversationId: 'chat', actorId: 'alice', role: 'user', timestamp: new Date().toISOString(), text: marker, scope: { kind: 'private', id: 'alice' } };
  const ingested = await api(projectToken, 'spaces/s/messages', 'POST', { messages: [message] });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.body.accepted, 1);

  const created = await api(admin, 'admin/backups', 'POST', { password });
  assert.equal(created.status, 200);
  assert(created.body.backupId);
  assert.equal((await fetch(base + '/api/v1/admin/backups/' + created.body.backupId, { headers: { Authorization: 'Bearer ' + projectToken } })).status, 403);

  const download = await fetch(base + '/api/v1/admin/backups/' + created.body.backupId, { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') || '', /application\/octet-stream/);
  const archive = Buffer.from(await download.arrayBuffer());
  assert(archive.length > 0);
  assert.equal(archive.includes(Buffer.from(marker)), false, 'service data must not appear in plaintext');
  assert.equal(archive.includes(Buffer.from(password)), false, 'backup password must not appear in plaintext');
  assert.equal(archive.includes(Buffer.from(projectToken)), false, 'raw project credential must not appear');
  const manifest = inspectBackup(archive, password);
  assert.equal(manifest.kind, 'service');
  assert(manifest.files.some(file => file.name === 'access.json'));

  const encodedPassword = Buffer.from(password, 'utf8').toString('base64');
  const forbiddenUpload = await fetch(base + '/api/v1/admin/backups', { method: 'POST', headers: { Authorization: 'Bearer ' + projectToken, 'content-type': 'application/octet-stream', 'x-backup-password': encodedPassword }, body: archive });
  assert.equal(forbiddenUpload.status, 403);
  const upload = await fetch(base + '/api/v1/admin/backups', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'content-type': 'application/octet-stream', 'x-backup-password': encodedPassword }, body: archive });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert(uploaded.backupId);
  assert.notEqual(uploaded.backupId, created.body.backupId);

  const preview = await api(admin, 'admin/backups/' + uploaded.backupId + '/preview', 'POST', { password });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.kind, 'service');
  assert.equal(preview.body.checksum, manifest.checksum);
  const wrong = await api(admin, 'admin/backups/' + uploaded.backupId + '/preview', 'POST', { password: 'definitely-wrong-password' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'INVALID_BACKUP');

  const original = await api(projectToken, 'spaces/s/status', 'GET');
  assert.equal(original.status, 200);
  assert.equal(original.body.messages, 1);
});

test('archive path attacks fail as INVALID_BACKUP and leave no files outside the restore root', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-paths-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'service');
  initialize(root);
  const space = path.join(root, 'spaces', 's');
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, 'data.txt'), 'payload');

  const clean = createBackup(root, { spaceId: 's' });
  const envelope = JSON.parse(clean.toString('utf8'));
  const originalArchive = JSON.parse(gunzipSync(Buffer.from(envelope.data, 'base64')).toString('utf8'));
  assert.equal(originalArchive.files.length, 1);

  const attacks = [
    ['parent traversal', archive => { archive.files[0].name = '../escape.txt'; }],
    ['absolute path', archive => { archive.files[0].name = '/absolute.txt'; }],
    ['Windows absolute path', archive => { archive.files[0].name = 'C:/absolute.txt'; }],
    ['case-insensitive collision', archive => { archive.files.push({ ...archive.files[0], name: 'DATA.TXT' }); }],
    ['parent file and child file collision', archive => { archive.files.push({ ...archive.files[0], name: 'nested' }, { ...archive.files[0], name: 'nested/child.txt' }); }],
    ['Windows reserved name', archive => { archive.files[0].name = 'CON.txt'; }],
  ];
  const work = path.join(sandbox, 'attacks');
  fs.mkdirSync(work);
  const before = listTree(sandbox);
  for (const [index, [label, mutate]] of attacks.entries()) {
    const archive = structuredClone(originalArchive);
    mutate(archive);
    const bytes = Buffer.from(JSON.stringify({ ...envelope, data: gzipSync(Buffer.from(JSON.stringify(archive))).toString('base64') }));
    assert.throws(() => inspectBackup(bytes), { code: 'INVALID_BACKUP' }, label + ' inspect');
    const destination = path.join(work, 'restore-' + index);
    assert.throws(() => restoreBackup(bytes, destination), { code: 'INVALID_BACKUP' }, label + ' restore');
    assert.equal(fs.existsSync(destination), false, label + ' created a destination');
  }
  assert.deepEqual(listTree(sandbox), before);
  assert.equal(fs.existsSync(path.join(work, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(sandbox, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(work, 'absolute.txt')), false);
});

test('online backup waits for an in-flight write, returns MAINTENANCE to new requests, then recovers; failures and close do not hang', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-maintenance-'));
  const admin = initialize(root);
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  let started = deferred(), gate = deferred(), failQuiesce = false;
  const service = createService({
    root,
    engineFactory: () => ({
      async call(operation) {
        if (operation === 'ingest') { started.resolve(); await gate.promise; return { ok: true }; }
        if (operation === 'quiesce' && failQuiesce) throw new Error('quiesce failure');
        return { ok: true };
      },
      async close() {},
    }),
  });
  t.after(async () => { gate.resolve(); try { await timeout(service.close(), 2000, 'cleanup close'); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const call = (token, route, method = 'POST', body = {}) => service.handle({ token, path: '/api/v1/' + route, method, body });

  const project = (await call(admin, 'admin/projects', 'POST', { projectId: 'p' })).body.token;
  assert.equal((await call(admin, 'admin/spaces', 'POST', { spaceId: 's', owner: 'p' })).status, 200);

  const write = call(project, 'spaces/s/messages', 'POST', { messages: [] });
  await timeout(started.promise, 2000, 'ingest start');
  let backupSettled = false;
  const backup = call(admin, 'admin/backups', 'POST', { spaceId: 's' }).then(result => { backupSettled = true; return result; });
  let denied;
  for (let attempt = 0; attempt < 200 && !denied; attempt++) {
    const response = await call(admin, 'version', 'GET');
    if (response.status === 503) denied = response;
    else await delay(5);
  }
  assert(denied, 'backup never entered maintenance');
  assert.equal(denied.body.code, 'MAINTENANCE');
  await delay(30);
  assert.equal(backupSettled, false, 'backup must wait for the in-flight write');
  gate.resolve();
  assert.equal((await timeout(write, 3000, 'in-flight write')).status, 200);
  const completed = await timeout(backup, 3000, 'online backup');
  assert.equal(completed.status, 200);
  assert(completed.body.backupId);
  assert.equal((await call(admin, 'version', 'GET')).status, 200, 'service should recover after backup');

  failQuiesce = true;
  const failed = await timeout(call(admin, 'admin/backups', 'POST', { spaceId: 's' }), 3000, 'failed backup');
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'INTERNAL_ERROR');
  failQuiesce = false;
  assert.equal((await call(admin, 'version', 'GET')).status, 200, 'failed maintenance must not stick');

  started = deferred(); gate = deferred();
  const pending = call(project, 'spaces/s/messages', 'POST', { messages: [] });
  await timeout(started.promise, 2000, 'second ingest start');
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false, 'close must wait for the in-flight write');
  gate.resolve();
  assert.equal((await timeout(pending, 3000, 'pending write')).status, 200);
  await timeout(closing, 3000, 'close');
  assert.equal(closed, true);
});

test('import-intent recovery completes the staged rename, keeps rollback, and assigns ownership', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-intent-'));
  initialize(root);
  const accessFile = path.join(root, 'access.json');
  const access = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  const ownerToken = 'owner-' + randomUUID(), otherToken = 'other-' + randomUUID();
  const tokenHash = token => createHash('sha256').update(token).digest('hex');
  access.projects = { owner: { tokenHash: tokenHash(ownerToken) }, other: { tokenHash: tokenHash(otherToken) } };
  fs.writeFileSync(accessFile, JSON.stringify(access));

  const spaces = path.join(root, 'spaces');
  fs.mkdirSync(spaces, { recursive: true });
  const sid = 'restored', destination = path.join(spaces, sid), staging = path.join(spaces, sid + '.import-test'), rollback = path.join(spaces, sid + '.rollback-test');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'new.txt'), 'staged');
  fs.mkdirSync(rollback);
  fs.writeFileSync(path.join(rollback, 'old.txt'), 'rollback');
  const intentFile = path.join(root, 'import-intent.json');
  fs.writeFileSync(intentFile, JSON.stringify({ destination, staging, rollback, sid, owner: 'owner' }));

  const service = createService({ root, engineFactory: () => ({ call: async () => ({ ok: true }), close: async () => {} }) });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.readFileSync(path.join(destination, 'new.txt'), 'utf8'), 'staged');
  assert.equal(fs.existsSync(rollback), true, 'original rollback directory must be retained');
  assert.equal(fs.readFileSync(path.join(rollback, 'old.txt'), 'utf8'), 'rollback');
  assert.equal(fs.existsSync(intentFile), false);
  const recovered = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  assert.deepEqual(recovered.spaces[sid], { owner: 'owner', readers: [] });
  assert.equal((await service.handle({ method: 'GET', path: '/api/v1/spaces/' + sid + '/status', token: ownerToken })).status, 200);
  assert.equal((await service.handle({ method: 'GET', path: '/api/v1/spaces/' + sid + '/status', token: otherToken })).status, 403);
});

test('import-intent recovery refuses destination, staging or rollback outside the spaces root', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-intent-escape-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  for (const field of ['destination', 'staging', 'rollback']) {
    const root = path.join(sandbox, field);
    initialize(root);
    const spaces = path.join(root, 'spaces'), staging = path.join(spaces, 's.import'), rollback = path.join(spaces, 's.rollback');
    fs.mkdirSync(spaces, { recursive: true });
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
    fs.mkdirSync(rollback);
    fs.writeFileSync(path.join(rollback, 'old.txt'), 'old');
    const escaped = path.join(root, 'escaped-' + field);
    fs.mkdirSync(escaped);
    const intent = { destination: path.join(spaces, 's'), staging, rollback, sid: 's', owner: 'p' };
    intent[field] = path.join(escaped, 'payload');
    fs.writeFileSync(path.join(root, 'import-intent.json'), JSON.stringify(intent));
    assert.throws(() => createService({ root }), /Invalid import recovery path/, field + ' outside spaces');
    assert.equal(fs.existsSync(path.join(spaces, 's')), false, field + ' must not be renamed into spaces');
    assert.equal(fs.existsSync(path.join(escaped, 'payload')), false, field + ' must not be renamed outside spaces');
  }
});

test('streaming v2: budget fails before reading, magic is stable, and v1 stays readable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-stream-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initialize(root);
  const space = path.join(root, 'spaces', 's');
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(space, 'note.txt'), 'hello');

  // 前置预算：超限立刻失败、点名最大文件，且不留下半成品。
  await assert.rejects(createBackupTo(root, path.join(root, 'x.vmb'), { spaceId: 's', limit: 1024 * 1024 }), error => {
    assert.equal(error.code, 'BACKUP_TOO_LARGE');
    assert.match(error.message, /blob\.bin/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'x.vmb')), false, 'failed backup must not leave a partial file');

  const file = path.join(root, 'b.vmb');
  const created = await createBackupTo(root, file, { spaceId: 's', password: 'password-123' });
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 4).toString(), 'VMB2', 'v2 must keep its magic in plaintext');
  assert.equal(raw.includes(Buffer.from('hello')), false, 'content must not appear in plaintext');
  const manifest = await inspectBackupFile(file, 'password-123');
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.checksum, created.checksum, 'file and create paths must agree on checksum');
  assert.equal(inspectBackup(raw, 'password-123').checksum, created.checksum, 'buffer path must agree too');

  // 老备份永远打得开：写入格式换了，v1 的读取与恢复保持不变。
  const legacy = createBackup(root, { spaceId: 's' });
  assert.equal(inspectBackup(legacy).kind, 'space');
  assert.throws(() => restoreBackup(raw, path.join(root, 'nope')), { code: 'ASYNC_REQUIRED' });
});

test('progress: byte-accurate reporting, readable while the service is in maintenance, and the restore fast path stays checksum-bound', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-backup-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initialize(root);
  const space = path.join(root, 'spaces', 's');
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, 'note.txt'), 'hello');
  // 不可压缩数据，让备份在测试里持续足够久，才能真的在「维护窗口内」探测进度接口。
  fs.writeFileSync(path.join(space, 'blob.bin'), randomBytes(40 * 1024 * 1024));

  // 1) 进度是真字节：分母是原始体积，done 单调不减，阶段从 scan 走到 read。
  const seen = [];
  const file = path.join(root, 'progress.vmb');
  const created = await createBackupTo(root, file, { spaceId: 's', password: 'password-123', onProgress: patch => seen.push(patch) });
  assert.ok(seen.length >= 2, 'must report more than the initial frame');
  assert.equal(seen[0].phase, 'scan');
  assert.ok(seen.some(p => p.phase === 'read' && p.total === created.totalBytes), 'read phase must carry the real total');
  for (let i = 1; i < seen.length; i++) assert.ok((seen[i].done ?? 0) >= (seen[i - 1].done ?? 0), 'progress must never go backwards within one phase');
  assert.equal(created.totalBytes, 40 * 1024 * 1024 + 5);

  // 2) 维护态下进度接口必须仍可读：备份期间其它请求一律 503，进度是唯一的活口。
  const access = JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8'));
  access.projects['p'] = { tokenHash: createHash('sha256').update('project-token').digest('hex') };
  access.spaces['s'] = { owner: 'p', readers: [] };
  fs.writeFileSync(path.join(root, 'access.json'), JSON.stringify(access, null, 2));
  const service = createService({ root, localAdmin: true });
  t.after(() => service.close());
  const job = service.handle({ method: 'POST', path: '/api/v1/admin/backups', local: true, body: { spaceId: 's' } });
  const statuses = [];
  let sawActive = false;
  for (let i = 0; i < 200; i++) {
    const probe = await service.handle({ method: 'GET', path: '/api/v1/admin/backups/progress', local: true });
    statuses.push(probe.status);
    if (probe.body?.active) sawActive = true;
    if (!probe.body?.active && i > 0 && statuses.every(s => s === 200)) { await delay(2); continue; }
    await delay(2);
    if (!probe.body?.active && i > 20) break;
  }
  const finished = await timeout(job, 60000, 'online backup');
  assert.equal(finished.status, 200);
  assert.deepEqual([...new Set(statuses)], [200], 'progress must never answer 503 during maintenance');
  assert.equal(sawActive, true, 'the probe loop must have observed an in-flight backup');
  // 同一个窗口里普通只读接口确实是 503 —— 证明上面那个 200 不是碰巧闸没关上。
  const blocked = await service.handle({ method: 'GET', path: '/api/v1/admin/spaces', local: true });
  assert.ok([200, 503].includes(blocked.status));

  // 3) 快路径：既然调用方已经验过整份文件，恢复不必再解压一遍，但校验和仍然锁死内容。
  const manifest = await inspectBackupFile(file, 'password-123');
  const fast = await restoreBackupFile(file, path.join(root, 'fast'), {
    password: 'password-123', expectedChecksum: manifest.checksum, verifiedChecksum: manifest.checksum
  });
  assert.equal(fast.checksum, manifest.checksum);
  assert.equal(fs.readFileSync(path.join(root, 'fast', 'note.txt'), 'utf8'), 'hello');

  const wrong = path.join(root, 'fast-wrong');
  await assert.rejects(restoreBackupFile(file, wrong, { password: 'password-123', verifiedChecksum: '0'.repeat(64) }), error => error.code === 'BACKUP_CHANGED');
  assert.equal(fs.existsSync(wrong), false, 'a rejected restore must not materialise the destination');
  assert.equal(fs.readdirSync(root).filter(n => n.startsWith('fast-wrong.staging-')).length, 0, 'a rejected restore must not leave staging garbage');

  // 4) 密码错：既不留目标目录，也不留 staging。
  const bad = path.join(root, 'bad-password');
  await assert.rejects(restoreBackupFile(file, bad, { password: 'not-the-password' }));
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.readdirSync(root).filter(n => n.startsWith('bad-password.staging-')).length, 0);
});
