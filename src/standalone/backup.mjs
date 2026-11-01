import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash, randomUUID} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {MemoryError} from '../core/durable-log.mjs';

const MAX = 512 * 1024 * 1024;
const sha = data => createHash('sha256').update(data).digest('hex');
export function writeBackup(file, bytes) {
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function replaceRestored(file, value) { const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }
function fail(message) { throw new MemoryError('INVALID_BACKUP', message); }
function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(s => !s || s === '.' || s === '..' || /[:\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) || path.isAbsolute(name)) fail('Unsafe archive path');
  return name;
}
function walk(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (name === '.service.lock' || name === 'backups' || name.endsWith('.tmp')) continue;
    const file = path.join(root,name), stat = fs.lstatSync(file), relative = prefix + name;
    if (stat.isSymbolicLink()) fail('Symbolic links cannot be backed up');
    if (stat.isDirectory()) result.push(...walk(file,relative+'/'));
    else if (stat.isFile()) result.push({file, name:safeName(relative)});
    else fail('Unsupported file type');
  }
  return result;
}
export function createBackup(root, {spaceId, password} = {}) {
  if (!spaceId && (typeof password !== 'string' || password.length < 8)) throw new MemoryError('PASSWORD_REQUIRED','Full backups require a password of at least 8 characters');
  if (spaceId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(spaceId)) fail('Invalid space ID');
  const source = spaceId ? path.join(root,'spaces',spaceId) : root;
  const files = []; let size = 0;
  for (const item of walk(source)) {
    let data = fs.readFileSync(item.file);
    if (spaceId && item.name === 'settings.json') {
      const settings = JSON.parse(data); for (const key of Object.keys(settings)) if (/key|token|secret|password/i.test(key)) delete settings[key];
      settings.autoIndexEnabled = false; settings.consolidateEnabled = false; data = Buffer.from(JSON.stringify(settings));
    }
    if (spaceId && item.name === 'state.json') data = Buffer.from(JSON.stringify({jobs:{},receipts:{}}));
    size += data.length; if (size > MAX) throw new MemoryError('BACKUP_TOO_LARGE','Backup exceeds the 512 MiB uncompressed limit');
    files.push({name:item.name, size:data.length, sha256:sha(data), data:data.toString('base64')});
  }
  const archive = {format:'vec-memory-backup',version:1,kind:spaceId?'space':'service',spaceId:spaceId || null,createdAt:new Date().toISOString(),files};
  const compressed = gzipSync(Buffer.from(JSON.stringify(archive)));
  if (!password) return Buffer.from(JSON.stringify({format:'vec-memory-envelope',version:1,encrypted:false,data:compressed.toString('base64')}));
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password,salt,32), cipher = createCipheriv('aes-256-gcm',key,iv);
  const encrypted = Buffer.concat([cipher.update(compressed),cipher.final()]);
  return Buffer.from(JSON.stringify({format:'vec-memory-envelope',version:1,encrypted:true,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));
}
export function inspectBackup(bytes, password) {
  if (bytes.length > MAX * 2) fail('Archive exceeds size limit');
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
    archive = JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX*2}));
  } catch (error) { if (error instanceof MemoryError) throw error; fail('Backup is damaged or the password is incorrect'); }
  if (archive.format !== 'vec-memory-backup' || archive.version !== 1 || !['space','service'].includes(archive.kind) || !Array.isArray(archive.files)) fail('Unsupported backup format');
  const names = new Set(); let size = 0;
  for (const file of archive.files) {
    safeName(file.name); const key = file.name.toLowerCase();
    if (names.has(key) || [...names].some(n => n.startsWith(key+'/') || key.startsWith(n+'/'))) fail('Colliding archive paths');
    names.add(key); const data = Buffer.from(file.data,'base64'); size += data.length;
    if (size > MAX || data.length !== file.size || sha(data) !== file.sha256) fail('File checksum or size mismatch');
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
// Restore only to a new sibling directory. Existing data is never overwritten.
export function restoreBackup(bytes, destination, {password, expectedChecksum} = {}) {
  const archive = inspectBackup(bytes,password);
  if (expectedChecksum && expectedChecksum !== archive.checksum) throw new MemoryError('BACKUP_CHANGED','Backup differs from reviewed preview',409);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new MemoryError('DESTINATION_EXISTS','Restore requires a new destination',409);
  const staging = destination+'.staging-'+randomUUID(); fs.mkdirSync(staging,{recursive:true});
  try {
    for (const file of archive.files) { const target = path.join(staging,...file.name.split('/')); fs.mkdirSync(path.dirname(target),{recursive:true}); writeBackup(target,Buffer.from(file.data,'base64')); }
    // Restored automatic model tasks are deliberately suspended until explicitly re-enabled.
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
