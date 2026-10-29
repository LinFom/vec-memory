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
// One process owns a library. No writes on open. Every acknowledged append is fsynced.
// A damaged/unrecognized journal blocks reads AND writes: an unknown hide must not disappear.
export class DurableLog {
  constructor(file, validate, io = fs) {
    this.file = path.resolve(file); this.io = io; this.rows = []; this.operations = new Map();
    this.readOnlyReason = null; this.bytes = 0;
    try {
      const raw = io.existsSync(this.file) ? io.readFileSync(this.file, 'utf8') : '';
      this.bytes = Buffer.byteLength(raw);
      if (raw && !raw.endsWith('\n')) throw new Error('Incomplete journal tail');
      for (const line of raw.split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.version !== 1 || row.seq !== this.rows.length + 1 || row.previous !== (this.rows.at(-1)?.hash || '') ||
            typeof row.operationId !== 'string' || !row.operationId || typeof row.fingerprint !== 'string' ||
            !row.result || row.result.ok !== true || this.operations.has(row.operationId)) throw new Error('Invalid journal record');
        const { hash, ...payload } = row;
        if (hash !== digest(payload)) throw new Error('Journal hash mismatch');
        validate(row, this.rows);
        this.rows.push(row); this.operations.set(row.operationId, row);
      }
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
