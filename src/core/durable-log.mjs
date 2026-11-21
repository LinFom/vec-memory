import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export class MemoryError extends Error {
  constructor(code, message, status = 400, detail = {}) { super(message); Object.assign(this, { code, status, ...detail }); }
}
export const copy = value => structuredClone(value);
export function requireText(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError('INVALID_ARGUMENT', `${name} must be a nonempty string (max ${max})`);
  return value.trim();
}
// Journal 读取的分块大小。**不是性能旋钮，是正确性下限**：V8 单个字符串上限
// 0x1fffffe8（512 MiB），单行日志文件超过它时 `readFileSync(file,'utf8')` 直接抛
// RangeError ⇒ 构造期就把 readOnlyReason 写死 ⇒ 之后每次 assertReadable() 都 503，
// 读侧（recall/inject）与写侧（ingest append）**一起永久停摆**，而且日志里只有一句
// "Cannot create a string longer than 0x1fffffe8 characters"。
// 实测（qq-secondary 545 MB / 827598 行）：分块读 22 s、堆 861 MB，服务堆上限 8 GB 够用。
// 小文件仍走原路径，行为与错误文案逐字不变（测试与其余 5 个日志文件都在这条路上）。
const READ_CHUNK = 8 * 1024 * 1024;

/** 逐行喂给 onLine，返回文件的**原始字节数**（与 statSync().size 同口径，供 assertReadable 比对）。 */
function eachJournalLine(io, file, onLine) {
  if (!io.existsSync(file)) return 0;
  const size = io.statSync(file).size;
  if (size <= READ_CHUNK) {
    const raw = io.readFileSync(file, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete journal tail');
    for (const line of raw.split('\n')) if (line) onLine(line);
    return Buffer.byteLength(raw);
  }
  const fd = io.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let pending = Buffer.alloc(0), total = 0;
    for (;;) {
      const n = io.readSync(fd, buf, 0, READ_CHUNK, total);
      if (!n) break;
      total += n;
      // 按 0x0A 切 Buffer、只在完整行边界解码：多字节 UTF-8 字符永远不会被切开。
      pending = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const cut = pending.lastIndexOf(0x0a);
      if (cut === -1) continue;
      for (const line of pending.subarray(0, cut).toString('utf8').split('\n')) if (line) onLine(line);
      pending = pending.subarray(cut + 1);
    }
    if (pending.length) throw new Error('Incomplete journal tail');
    return total;
  } finally { io.closeSync(fd); }
}

// One process owns a library. No writes on open. Every acknowledged append is fsynced.
// A damaged/unrecognized journal blocks reads AND writes: an unknown hide must not disappear.
export class DurableLog {
  constructor(file, validate, io = fs) {
    this.file = path.resolve(file); this.io = io; this.rows = []; this.operations = new Map();
    this.readOnlyReason = null; this.bytes = 0;
    try {
      this.bytes = eachJournalLine(io, this.file, (line) => {
        const row = JSON.parse(line);
        if (row.version !== 1 || row.seq !== this.rows.length + 1 || row.previous !== (this.rows.at(-1)?.hash || '') ||
            typeof row.operationId !== 'string' || !row.operationId || typeof row.fingerprint !== 'string' ||
            !row.result || row.result.ok !== true || this.operations.has(row.operationId)) throw new Error('Invalid journal record');
        const { hash, ...payload } = row;
        if (hash !== digest(payload)) throw new Error('Journal hash mismatch');
        validate(row, this.rows);
        this.rows.push(row); this.operations.set(row.operationId, row);
      });
    } catch (e) { this.readOnlyReason = String(e.message); }
    this.validate = validate;
  }
  assertReadable() {
    if (this.readOnlyReason) throw new MemoryError('STORAGE_UNAVAILABLE', this.readOnlyReason, 503);
    let bytes;
    try { bytes = this.io.existsSync(this.file) ? this.io.statSync(this.file).size : 0; }
    catch (e) { throw new MemoryError('STORAGE_UNAVAILABLE', e.message, 503); }
    if (bytes !== this.bytes) { this.readOnlyReason = 'Journal changed outside its owning runtime'; throw new MemoryError('STORAGE_UNAVAILABLE', this.readOnlyReason, 503); }
  }
  replay(operationId, request) {
    this.assertReadable(); requireText(operationId, 'operationId', 200);
    const row = this.operations.get(operationId);
    if (!row) return null;
    if (row.fingerprint !== digest(request)) throw new MemoryError('OPERATION_CONFLICT', 'operationId was already used for another request', 409);
    return { ...copy(row.result), replayed: true };
  }
  append(operationId, request, data, result) {
    this.assertReadable();
    const payload = { version: 1, seq: this.rows.length + 1, previous: this.rows.at(-1)?.hash || '', operationId,
      fingerprint: digest(request), data: copy(data), result: copy(result) };
    const row = { ...payload, hash: digest(payload) };
    this.validate(row, this.rows);
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    let fd;
    try {
      this.io.mkdirSync(path.dirname(this.file), { recursive: true });
      fd = this.io.openSync(this.file, this.io.existsSync(this.file) ? 'r+' : 'wx+');
      let written = 0;
      while (written < bytes.length) { const n = this.io.writeSync(fd, bytes, written, bytes.length - written, this.bytes + written); if (!n) throw new Error('Short journal write'); written += n; }
      this.io.fsyncSync(fd);
    } catch (e) {
      try { if (fd !== undefined) { this.io.ftruncateSync(fd, this.bytes); this.io.fsyncSync(fd); } }
      catch { this.readOnlyReason = 'Failed journal append and rollback'; }
      throw new MemoryError('STORAGE_UNAVAILABLE', e.message, 503);
    } finally { if (fd !== undefined) this.io.closeSync(fd); }
    this.bytes += bytes.length; this.rows.push(row); this.operations.set(operationId, row);
    return copy(result);
  }
}
