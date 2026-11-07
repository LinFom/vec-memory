// 记忆库备份 —— 两种容器并存 [by:WorkBuddy 2026-11-08]
//
// 为什么要有 v2：v1 把整库读进内存、base64 成一个大 JSON 再 gzip，单线程同步跑完。
// 库一大就三件事一起发生：① 512MiB 上限必然触发（单个 input/messages.jsonl 就能超）；
// ② 失败前已经读了 512MB 并转成 base64，峰值内存 1.2GB 以上；③ 全程没有 await，
// 服务事件循环被冻住，前端所有请求一起卡死。v2 改成「明文头 + gzip 流 + 可选 AES-256-GCM」，
// 顺序读写、内存恒定；体积在扫描阶段就判定，超限时一个字节都不用读。
//
// v1 保留的用途：小库仍可同步拿到 Buffer（现成调用方与测试依赖它）；v1 的读取/恢复路径保留，
// 保证旧 .vmb 永远打得开。新写入一律走 v2。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv, createHash} from 'node:crypto';
import {gzipSync, gunzipSync, createGzip, createGunzip} from 'node:zlib';
import {Readable, Transform, PassThrough, pipeline} from 'node:stream';
import {promisify} from 'node:util';
import {MemoryError} from '../core/durable-log.mjs';

const pipe = promisify(pipeline);

// v1 是「整个备份进一个 Buffer」，512 MiB 是它的物理上限。
const MAX_INLINE = 512 * 1024 * 1024;
// v2 是流式的，上限只防呆；真正的约束是磁盘剩余空间。
const MAX_STREAM = 8 * 1024 * 1024 * 1024;
const MAGIC = Buffer.from('VMB2');
const HEADER_FIXED = 4 + 1 + 16 + 12 + 4; // magic + flags + salt + iv + headerLen = 37
const TAG_LEN = 16;
const TRAILER_MARK = 0xffffffff;
const SPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

const sha = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new MemoryError('INVALID_BACKUP', message); };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); return b; };

export function writeBackup(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function replaceRestored(file, value) { const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }

function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(s => !s || s === '.' || s === '..' || /[:\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) || path.isAbsolute(name)) fail('Unsafe archive path');
  return name;
}

// 运行态与临时产物不进备份：要么能重建，要么是别的恢复留下的半成品。
function skippedEntry(name) {
  return name === '.service.lock' || name === 'backups' || name.endsWith('.tmp');
}

// 只做 lstat，不读内容 —— 体积判定必须发生在任何一次 readFile 之前。
function collect(root, limit) {
  if (!fs.existsSync(root)) return {files: [], totalBytes: 0, largest: null};
  const files = []; let totalBytes = 0; let largest = null;
  const visit = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (skippedEntry(name)) continue;
      const file = path.join(dir, name), stat = fs.lstatSync(file), relative = prefix + name;
      if (stat.isSymbolicLink()) fail('Symbolic links cannot be backed up');
      if (stat.isDirectory()) { visit(file, relative + '/'); continue; }
      if (!stat.isFile()) fail('Unsupported file type');
      totalBytes += stat.size;
      if (!largest || stat.size > largest.size) largest = {name: relative, size: stat.size};
      if (totalBytes > limit) {
        const top = largest ? `最大单文件 ${largest.name} 已占 ${(largest.size / 1048576).toFixed(1)} MiB。` : '';
        throw new MemoryError('BACKUP_TOO_LARGE',
          `Backup exceeds the ${Math.round(limit / 1048576)} MiB limit (${(totalBytes / 1048576).toFixed(1)} MiB scanned). ${top}` +
          '请改用流式备份（createBackupTo / 在线备份接口），或先排除可重建的向量目录。');
      }
      files.push({file, name: safeName(relative), size: stat.size});
    }
  };
  visit(root, '');
  return {files, totalBytes, largest};
}

// ---------------------------------------------------------------- v1（同步，兼容保留）

export function createBackup(root, {spaceId, password} = {}) {
  if (!spaceId && (typeof password !== 'string' || password.length < 8)) throw new MemoryError('PASSWORD_REQUIRED','Full backups require a password of at least 8 characters');
  if (spaceId && !SPACE_ID_RE.test(spaceId)) fail('Invalid space ID');
  const source = spaceId ? path.join(root,'spaces',spaceId) : root;
  // 先量体积再读文件：超限时不应该已经吃掉 512MB 内存。
  const {files: listing} = collect(source, MAX_INLINE);
  const files = [];
  for (const item of listing) {
    let data = fs.readFileSync(item.file);
    if (spaceId && item.name === 'settings.json') {
      const settings = JSON.parse(data); for (const key of Object.keys(settings)) if (/key|token|secret|password/i.test(key)) delete settings[key];
      settings.autoIndexEnabled = false; settings.consolidateEnabled = false; data = Buffer.from(JSON.stringify(settings));
    }
    if (spaceId && item.name === 'state.json') data = Buffer.from(JSON.stringify({jobs:{},receipts:{}}));
    files.push({name:item.name, size:data.length, sha256:sha(data), data:data.toString('base64')});
  }
  const archive = {format:'vec-memory-backup',version:1,kind:spaceId?'space':'service',spaceId:spaceId || null,createdAt:new Date().toISOString(),files};
  const compressed = gzipSync(Buffer.from(JSON.stringify(archive)));
  if (!password) return Buffer.from(JSON.stringify({format:'vec-memory-envelope',version:1,encrypted:false,data:compressed.toString('base64')}));
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password,salt,32), cipher = createCipheriv('aes-256-gcm',key,iv);
  const encrypted = Buffer.concat([cipher.update(compressed),cipher.final()]);
  return Buffer.from(JSON.stringify({format:'vec-memory-envelope',version:1,encrypted:true,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));
}

// ---------------------------------------------------------------- v2（流式，默认路径）

// payload 顺序帧（不需要预知长度）：
//   entry := [nameLen u32][name][chunk]*[0 u32]
//   chunk := [len u32][bytes]            len === 0 表示该 entry 结束
//   tail  := [0xFFFFFFFF][trailerLen u32][trailer JSON]
// 每个文件的 sha256 只能事后补，所以放在 tail 里。
async function* payloadOf(files, spaceId) {
  const records = [];
  for (const item of files) {
    const name = Buffer.from(item.name, 'utf8');
    yield u32(name.length); yield name;
    const hash = createHash('sha256'); let size = 0;
    const special = spaceId && (item.name === 'settings.json' || item.name === 'state.json');
    if (special) {
      let data = fs.readFileSync(item.file);
      if (item.name === 'settings.json') {
        const settings = JSON.parse(data);
        for (const key of Object.keys(settings)) if (/key|token|secret|password/i.test(key)) delete settings[key];
        settings.autoIndexEnabled = false; settings.consolidateEnabled = false;
        data = Buffer.from(JSON.stringify(settings));
      } else data = Buffer.from(JSON.stringify({jobs:{},receipts:{}}));
      hash.update(data); size = data.length;
      if (data.length) { yield u32(data.length); yield data; }
    } else {
      for await (const chunk of fs.createReadStream(item.file, {highWaterMark: 1 << 20})) {
        if (!chunk.length) continue;
        hash.update(chunk); size += chunk.length;
        yield u32(chunk.length); yield chunk;
      }
    }
    yield u32(0);
    records.push({name: item.name, size, sha256: hash.digest('hex')});
  }
  const trailer = Buffer.from(JSON.stringify({files: records}), 'utf8');
  yield u32(TRAILER_MARK); yield u32(trailer.length); yield trailer;
}

function headerOf({kind, spaceId, createdAt, fileCount, totalBytes, encrypted, salt, iv}) {
  const header = Buffer.from(JSON.stringify({
    format: 'vec-memory-backup', version: 2, kind, spaceId: spaceId || null, createdAt,
    fileCount, totalBytes, compression: 'gzip', encryption: encrypted ? 'aes-256-gcm' : null
  }), 'utf8');
  const fixed = Buffer.alloc(HEADER_FIXED);
  MAGIC.copy(fixed, 0);
  fixed[4] = encrypted ? 1 : 0;
  salt.copy(fixed, 5); iv.copy(fixed, 21);
  fixed.writeUInt32LE(header.length, 33);
  return {fixed, header};
}

export async function createBackupTo(root, destination, {spaceId, password, limit = MAX_STREAM} = {}) {
  if (!spaceId && (typeof password !== 'string' || password.length < 8)) throw new MemoryError('PASSWORD_REQUIRED','Full backups require a password of at least 8 characters');
  if (spaceId && !SPACE_ID_RE.test(spaceId)) fail('Invalid space ID');
  const source = spaceId ? path.join(root, 'spaces', spaceId) : root;
  const {files, totalBytes} = collect(source, limit);

  const encrypted = typeof password === 'string' && password.length > 0;
  const salt = encrypted ? randomBytes(16) : Buffer.alloc(16);
  const iv = encrypted ? randomBytes(12) : Buffer.alloc(12);
  const kind = spaceId ? 'space' : 'service';
  const createdAt = new Date().toISOString();
  const {fixed, header} = headerOf({kind, spaceId, createdAt, fileCount: files.length, totalBytes, encrypted, salt, iv});

  const partial = destination + '.partial-' + randomUUID();
  const digest = createHash('sha256');
  const tap = new Transform({
    transform(chunk, _enc, callback) { digest.update(chunk); callback(null, chunk); }
  });
  const stages = [createGzip({level: 6})];
  let cipher = null;
  if (encrypted) { cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv); stages.push(cipher); }

  // 明文头必须留在压缩/加密流之外：读的时候要靠 flags 与 salt/iv 才能开始解密。
  try {
    const fd = fs.openSync(partial, 'wx', 0o600);
    try {
      const head = Buffer.concat([fixed, header]);
      fs.writeSync(fd, head, 0, head.length, 0);
      // 校验和覆盖「明文头 + 压缩/密文正文」，不含末尾认证标签（标签是完整性凭证，不是内容）。
      // 先喂头再喂正文，顺序必须与读取侧一致。
      digest.update(head);
      const out = fs.createWriteStream(null, {fd, start: head.length, autoClose: false});
      await pipe(Readable.from(payloadOf(files, spaceId)), ...stages, tap, out);
      if (cipher) {
        const tag = cipher.getAuthTag();
        fs.writeSync(fd, tag, 0, tag.length, fs.fstatSync(fd).size);
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    await fsp.rename(partial, destination);
    const stat = await fsp.stat(destination);
    return {ok:true, kind, spaceId: spaceId || null, files: files.length, totalBytes,
      storedBytes: stat.size, checksum: digest.digest('hex'), createdAt};
  } catch (error) {
    await fsp.rm(partial, {force: true}).catch(() => {});
    if (error instanceof MemoryError) throw error;
    if (error.code === 'EEXIST') throw new MemoryError('DESTINATION_EXISTS', 'Backup destination already exists', 409);
    throw new MemoryError('BACKUP_FAILED', 'Backup failed: ' + error.message, 500);
  }
}

// 顺序解析：把解密/解压后的字节流还原成「文件 → 数据块」。
class ByteReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.ended = false; }
  async fill(n) {
    while (this.buffer.length < n && !this.ended) {
      const {value, done} = await this.iterator.next();
      if (done) { this.ended = true; break; }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
    if (this.buffer.length < n) fail('Backup is truncated');
  }
  async read(n) {
    await this.fill(n);
    const out = Buffer.from(this.buffer.subarray(0, n));
    this.buffer = Buffer.from(this.buffer.subarray(n));
    return out;
  }
  async u32() { return (await this.read(4)).readUInt32LE(0); }
}

async function parsePayload(stream, onEntry) {
  const reader = new ByteReader(stream);
  for (;;) {
    const marker = await reader.u32();
    if (marker === TRAILER_MARK) {
      const length = await reader.u32();
      if (length > 64 * 1024 * 1024) fail('Trailer too large');
      return JSON.parse((await reader.read(length)).toString('utf8'));
    }
    if (!marker) fail('Empty entry name');
    const name = safeName((await reader.read(marker)).toString('utf8'));
    const sink = onEntry ? await onEntry(name) : null;
    const hash = createHash('sha256'); let size = 0;
    for (;;) {
      const length = await reader.u32();
      if (!length) break;
      if (length > 64 * 1024 * 1024) fail('Chunk too large');
      const chunk = await reader.read(length);
      hash.update(chunk); size += length;
      if (sink && sink.write) await sink.write(chunk);
    }
    if (sink && sink.end) await sink.end(size);
  }
}

// 同步版只给 v2 的 Buffer 入口用（测试与小文件），大文件必须走文件流。
function parsePayloadSync(buffer) {
  let offset = 0;
  const need = n => { if (offset + n > buffer.length) fail('Backup is truncated'); const out = buffer.subarray(offset, offset + n); offset += n; return out; };
  const readU32 = () => need(4).readUInt32LE(0);
  for (;;) {
    const marker = readU32();
    if (marker === TRAILER_MARK) { const length = readU32(); return JSON.parse(need(length).toString('utf8')); }
    if (!marker) fail('Empty entry name');
    safeName(need(marker).toString('utf8'));
    for (;;) { const length = readU32(); if (!length) break; need(length); }
  }
}

function assertArchiveHeader(header) {
  if (!header || header.format !== 'vec-memory-backup' || header.version !== 2) fail('Unsupported backup format');
  if (!['space', 'service'].includes(header.kind)) fail('Unsupported backup format');
  if (!Number.isFinite(header.fileCount) || !Number.isFinite(header.totalBytes)) fail('Unsupported backup format');
}

function openEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER_FIXED) return null;
  if (!bytes.subarray(0, 4).equals(MAGIC)) return null;
  const headerLength = bytes.readUInt32LE(33);
  if (headerLength > 1024 * 1024 || bytes.length < HEADER_FIXED + headerLength) fail('Backup header is truncated');
  let header;
  try { header = JSON.parse(bytes.subarray(HEADER_FIXED, HEADER_FIXED + headerLength).toString('utf8')); } catch { fail('Backup is damaged'); }
  return {encrypted: !!(bytes[4] & 1), salt: Buffer.from(bytes.subarray(5, 21)), iv: Buffer.from(bytes.subarray(21, 33)), header, headerEnd: HEADER_FIXED + headerLength};
}

function decodeStages(encrypted, salt, iv, password) {
  const stages = [];
  if (encrypted) {
    if (typeof password !== 'string' || salt.length !== 16 || iv.length !== 12) fail('Invalid encryption metadata or missing password');
    stages.push(createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv));
  }
  stages.push(createGunzip({maxOutputLength: MAX_STREAM * 2}));
  return stages;
}

async function readHeaderFromFile(file) {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, 'r');
  let fixed, header;
  try {
    fixed = Buffer.alloc(HEADER_FIXED);
    const {bytesRead} = await handle.read(fixed, 0, HEADER_FIXED, 0);
    if (bytesRead < HEADER_FIXED || !fixed.subarray(0, 4).equals(MAGIC)) throw new MemoryError('INVALID_BACKUP', 'Not a v2 backup');
    const headerLength = fixed.readUInt32LE(33);
    if (headerLength > 1024 * 1024) fail('Backup header is malformed');
    const buf = Buffer.alloc(headerLength);
    const read = await handle.read(buf, 0, headerLength, HEADER_FIXED);
    if (read.bytesRead < headerLength) fail('Backup header is truncated');
    header = JSON.parse(buf.toString('utf8'));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    fail('Backup is damaged');
  } finally { await handle.close(); }
  const encrypted = !!(fixed[4] & 1);
  const headerEnd = HEADER_FIXED + fixed.readUInt32LE(33);
  const endExclusive = stat.size - (encrypted ? TAG_LEN : 0);
  if (endExclusive <= headerEnd) fail('Backup is truncated');
  return {file, stat, header, encrypted, salt: Buffer.from(fixed.subarray(5, 21)), iv: Buffer.from(fixed.subarray(21, 33)),
    fixed, headerEnd, endExclusive, tags: {tagLength: fixed.readUInt32LE(33)}};
}

async function streamPayload(meta, password, onEntry) {
  const digest = createHash('sha256');
  digest.update(meta.fixed);
  const headerHandle = await fsp.open(meta.file, 'r');
  try {
    const headerBytes = Buffer.alloc(meta.headerEnd - HEADER_FIXED);
    await headerHandle.read(headerBytes, 0, headerBytes.length, HEADER_FIXED);
    digest.update(headerBytes);
  } finally { await headerHandle.close(); }

  const tap = new Transform({ transform(chunk, _enc, callback) { digest.update(chunk); callback(null, chunk); } });
  const stages = decodeStages(meta.encrypted, meta.salt, meta.iv, password);
  if (meta.encrypted) {
    const tag = Buffer.alloc(TAG_LEN);
    const tagHandle = await fsp.open(meta.file, 'r');
    try { await tagHandle.read(tag, 0, TAG_LEN, meta.stat.size - TAG_LEN); } finally { await tagHandle.close(); }
    stages[0].setAuthTag(tag);
  }
  const out = new PassThrough();
  const consuming = parsePayload(out, onEntry);
  // 解析可能先于管道失败：先挂一个空 catch，避免它变成未处理的来拒绝而掩盖真正的错误。
  consuming.catch(() => {});
  try {
    await pipe(fs.createReadStream(meta.file, {start: meta.headerEnd, end: meta.endExclusive - 1}), tap, ...stages, out);
    return {trailer: await consuming, checksum: digest.digest('hex')};
  } catch (error) {
    out.destroy();
    if (error instanceof MemoryError) throw error;
    fail('Backup is damaged or the password is incorrect');
  }
}

export async function inspectBackupFile(file, password) {
  const meta = await readHeaderFromFile(file);
  assertArchiveHeader(meta.header);
  const {trailer, checksum} = await streamPayload(meta, password, null);
  if (!trailer || !Array.isArray(trailer.files)) fail('Backup trailer is missing');
  if (trailer.files.length !== meta.header.fileCount) fail('File count mismatch');
  if (meta.header.kind === 'service' && !trailer.files.some(f => f.name === 'access.json')) fail('Missing service credentials');
  return {...meta.header, files: trailer.files, totalBytes: trailer.files.reduce((sum, f) => sum + f.size, 0), checksum};
}

export async function restoreBackupFile(file, destination, {password, expectedChecksum} = {}) {
  const archive = await inspectBackupFile(file, password);
  if (expectedChecksum && expectedChecksum !== archive.checksum) throw new MemoryError('BACKUP_CHANGED','Backup differs from reviewed preview',409);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new MemoryError('DESTINATION_EXISTS','Restore requires a new destination',409);
  const staging = destination + '.staging-' + randomUUID();
  fs.mkdirSync(staging, {recursive: true});
  const written = [];
  try {
    const meta = await readHeaderFromFile(file);
    const handles = new Map();
    await streamPayload(meta, password, async name => {
      const target = path.join(staging, ...name.split('/'));
      fs.mkdirSync(path.dirname(target), {recursive: true});
      const handle = await fsp.open(target, 'wx', 0o600);
      handles.set(name, handle);
      written.push({name, target});
      return {
        write: chunk => handle.write(chunk),
        end: async () => { await handle.sync().catch(() => {}); await handle.close(); handles.delete(name); }
      };
    });
    for (const handle of handles.values()) await handle.close().catch(() => {});
    // 恢复后自动任务一律暂停，等人工确认再开 —— 恢复出来的库不该自己跑起来。
    for (const item of written.filter(w => w.name === 'settings.json' || /^spaces\/[^/]+\/settings\.json$/.test(w.name))) {
      const settings = JSON.parse(fs.readFileSync(item.target));
      settings.autoIndexEnabled = false; settings.consolidateEnabled = false;
      replaceRestored(item.target, settings);
    }
    for (const item of written.filter(w => w.name === 'state.json' || /^spaces\/[^/]+\/state\.json$/.test(w.name))) {
      const state = JSON.parse(fs.readFileSync(item.target)); state.receipts = {};
      for (const job of Object.values(state.jobs || {})) if (['queued','running'].includes(job.status)) { job.status = 'failed'; job.error = {code:'RESTORED_REVIEW_REQUIRED', message:'Review and resubmit after restore'}; }
      replaceRestored(item.target, state);
    }
    fs.renameSync(staging, destination);
  } catch (error) {
    throw new MemoryError('RESTORE_FAILED', `Restore failed; incomplete staging retained at ${staging}: ${error.message}`, 500);
  }
  return {ok:true,destination,kind:archive.kind,files:archive.files.length,totalBytes:archive.totalBytes,checksum:archive.checksum,automaticTasksSuspended:true};
}

// ---------------------------------------------------------------- 统一入口

export function isStreamingArchive(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.subarray(0, 4).equals(MAGIC);
}

// 按文件入口：旧 .vmb（v1，最大 512MiB，整体读入没问题）与新 .vmb（v2，流式）自动分流。
export async function inspectAnyFile(file, password) {
  const handle = await fsp.open(file, 'r');
  let head;
  try { head = Buffer.alloc(4); await handle.read(head, 0, 4, 0); } finally { await handle.close(); }
  if (head.equals(MAGIC)) return inspectBackupFile(file, password);
  return inspectLegacy(fs.readFileSync(file), password);
}

export async function restoreAnyFile(file, destination, options = {}) {
  const handle = await fsp.open(file, 'r');
  let head;
  try { head = Buffer.alloc(4); await handle.read(head, 0, 4, 0); } finally { await handle.close(); }
  if (head.equals(MAGIC)) return restoreBackupFile(file, destination, options);
  return restoreBackupLegacy(fs.readFileSync(file), destination, options);
}

export function inspectBackup(bytes, password) {
  if (!isStreamingArchive(bytes)) return inspectLegacy(bytes, password);
  const env = openEnvelope(bytes);
  assertArchiveHeader(env.header);
  const tagLength = env.encrypted ? TAG_LEN : 0;
  const body = bytes.subarray(env.headerEnd, bytes.length - tagLength);
  const digest = createHash('sha256').update(bytes.subarray(0, env.headerEnd)).update(body).digest('hex');
  let plain;
  try {
    let data = body;
    if (env.encrypted) {
      const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, env.salt, 32), env.iv);
      decipher.setAuthTag(Buffer.from(bytes.subarray(bytes.length - TAG_LEN)));
      data = Buffer.concat([decipher.update(body), decipher.final()]);
    }
    plain = gunzipSync(data, {maxOutputLength: MAX_STREAM * 2});
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    fail('Backup is damaged or the password is incorrect');
  }
  const trailer = parsePayloadSync(plain);
  if (!trailer || !Array.isArray(trailer.files)) fail('Backup trailer is missing');
  if (trailer.files.length !== env.header.fileCount) fail('File count mismatch');
  if (env.header.kind === 'service' && !trailer.files.some(f => f.name === 'access.json')) fail('Missing service credentials');
  return {...env.header, files: trailer.files, totalBytes: trailer.files.reduce((sum, f) => sum + f.size, 0), checksum: digest};
}

export function restoreBackup(bytes, destination, options) {
  if (isStreamingArchive(bytes)) throw new MemoryError('ASYNC_REQUIRED', 'v2 archives must be restored with restoreBackupFile(file, ...)', 400);
  return restoreBackupLegacy(bytes, destination, options);
}

export function inspectLegacy(bytes, password) {
  if (bytes.length > MAX_INLINE * 2) fail('Archive exceeds size limit');
  let archive;
  try {
    const env = JSON.parse(bytes);
    if (env.format !== 'vec-memory-envelope' || env.version !== 1 || typeof env.encrypted !== 'boolean') fail('Unsupported envelope');
    let compressed = Buffer.from(env.data,'base64');
    if (env.encrypted) {
      const salt = Buffer.from(env.salt,'base64'), iv = Buffer.from(env.iv,'base64'), tag = Buffer.from(env.tag,'base64');
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || typeof password !== 'string') fail('Invalid encryption metadata or missing password');
      const decipher = createDecipheriv('aes-256-gcm',scryptSync(password,salt,32),iv); decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(compressed),decipher.final()]);
    }
    archive = JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_INLINE*2}));
  } catch (error) { if (error instanceof MemoryError) throw error; fail('Backup is damaged or the password is incorrect'); }
  if (archive.format !== 'vec-memory-backup' || archive.version !== 1 || !['space','service'].includes(archive.kind) || !Array.isArray(archive.files)) fail('Unsupported backup format');
  const names = new Set(); let size = 0;
  for (const file of archive.files) {
    safeName(file.name); const key = file.name.toLowerCase();
    if (names.has(key) || [...names].some(n => n.startsWith(key+'/') || key.startsWith(n+'/'))) fail('Colliding archive paths');
    names.add(key); const data = Buffer.from(file.data,'base64'); size += data.length;
    if (size > MAX_INLINE || data.length !== file.size || sha(data) !== file.sha256) fail('File checksum or size mismatch');
    if (file.name.endsWith('.json')) { try { JSON.parse(data); } catch { fail('Invalid JSON data: '+file.name); } }
    if (file.name.endsWith('.jsonl')) {
      const text = data.toString('utf8'); if (text && !text.endsWith('\n')) fail('Incomplete journal: '+file.name);
      let previous = '', seq = 0;
      for (const line of text.split('\n').filter(Boolean)) {
        let row; try { row = JSON.parse(line); } catch { fail('Invalid journal: '+file.name); }
        if (row.version === 1 && typeof row.fingerprint === 'string' && row.hash) {
          const {hash,...payload} = row;
          const canonical = v => Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
          if (row.seq !== ++seq || row.previous !== previous || hash !== sha(JSON.stringify(canonical(payload)))) fail('Broken journal chain: '+file.name);
          previous = hash;
        }
      }
    }
  }
  if (archive.kind === 'service' && (!names.has('access.json') || !JSON.parse(Buffer.from(archive.files.find(f=>f.name==='access.json').data,'base64')).adminHash)) fail('Missing service credentials');
  return {...archive,totalBytes:size,checksum:sha(bytes)};
}

export function restoreBackupLegacy(bytes, destination, {password, expectedChecksum} = {}) {
  const archive = inspectLegacy(bytes,password);
  if (expectedChecksum && expectedChecksum !== archive.checksum) throw new MemoryError('BACKUP_CHANGED','Backup differs from reviewed preview',409);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new MemoryError('DESTINATION_EXISTS','Restore requires a new destination',409);
  const staging = destination+'.staging-'+randomUUID(); fs.mkdirSync(staging,{recursive:true});
  try {
    for (const file of archive.files) { const target = path.join(staging,...file.name.split('/')); fs.mkdirSync(path.dirname(target),{recursive:true}); writeBackup(target,Buffer.from(file.data,'base64')); }
    const settingsFiles = archive.files.filter(f=>f.name==='settings.json'||/^spaces\/[^/]+\/settings.json$/.test(f.name));
    for (const file of settingsFiles) { const target=path.join(staging,file.name), settings=JSON.parse(fs.readFileSync(target)); settings.autoIndexEnabled=false;settings.consolidateEnabled=false;replaceRestored(target,settings); }
    for (const file of archive.files.filter(f=>f.name==='state.json'||/^spaces\/[^/]+\/state.json$/.test(f.name))) {
      const target=path.join(staging,file.name), state=JSON.parse(fs.readFileSync(target)); state.receipts={};
      for (const job of Object.values(state.jobs||{})) if (['queued','running'].includes(job.status)) {job.status='failed';job.error={code:'RESTORED_REVIEW_REQUIRED',message:'Review and resubmit after restore'};}
      replaceRestored(target,state);
    }
    fs.renameSync(staging,destination);
  } catch (error) { throw new MemoryError('RESTORE_FAILED',`Restore failed; incomplete staging retained at ${staging}: ${error.message}`,500); }
  return {ok:true,destination,kind:archive.kind,files:archive.files.length,totalBytes:archive.totalBytes,checksum:archive.checksum,automaticTasksSuspended:true};
}
