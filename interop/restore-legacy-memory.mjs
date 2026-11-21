import fs from 'node:fs/promises';
import path from 'node:path';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { inspectAnyFile, restoreAnyFile } from '../src/standalone/backup.mjs';
import { saveJson } from '../src/standalone/service.mjs';

const markerName = 'portable-restore.json';
const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

async function jsonIfPresent(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryExists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquire(lock) {
  try {
    const handle = await fs.open(lock, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
    return handle;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await jsonIfPresent(lock);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) throw Error('Restore lock has no valid owner');
    try {
      process.kill(owner.pid, 0);
    } catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      await fs.unlink(lock);
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      return handle;
    }
    throw Error('Another restore owns this destination');
  }
}

async function auditRestore(staging, kind) {
  const root = await fs.lstat(staging);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Invalid restored directory');
  let spaces = [staging];
  if (kind === 'service') {
    const access = await jsonIfPresent(path.join(staging, 'access.json'));
    const ids = Object.keys(access?.spaces ?? {});
    if (typeof access?.adminHash !== 'string' || !access.projects || !access.spaces ||
        ids.some(id => !validId.test(id))) throw Error('Invalid restored service access state');
    spaces = ids.map(id => path.join(staging, 'spaces', id));
    for (const [id, grant] of Object.entries(access.spaces)) {
      const known = project => typeof project === 'string' && Object.hasOwn(access.projects, project);
      if (!known(grant?.owner) || !Array.isArray(grant.readers) || !grant.readers.every(known)) {
        throw Error('Invalid restored space permissions: ' + id);
      }
    }
  }
  for (const space of spaces) {
    const entry = await fs.lstat(space);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Missing restored space directory');
    const engine = createSpaceEngine({ root: space, maintenance: true });
    try {
      await engine.call('audit', {});
    } finally {
      await engine.close();
    }
  }
  return spaces.length;
}

export async function restoreLegacyMemory(source, destination, { password, expectedChecksum } = {}) {
  const archive = await inspectAnyFile(source, password);
  if (expectedChecksum !== undefined && expectedChecksum !== archive.checksum) throw Error('Archive differs from reviewed checksum');
  if ((archive.mode ?? 'full') !== 'full') throw Error('A full backup is required for isolated restore');
  const resolved = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(resolved));
  const name = path.basename(resolved);
  const target = path.join(parent, name);
  const lock = path.join(parent, '.' + name + '.portable-restore.lock');
  const checkpoint = path.join(parent, '.' + name + '.portable-restore-' + archive.checksum);
  const staging = path.join(checkpoint, 'space');
  const journal = path.join(checkpoint, 'intent.json');
  const handle = await acquire(lock);
  try {
    const identity = { version: 1, checksum: archive.checksum, kind: archive.kind };
    const matches = state => state?.version === 1 && state.checksum === identity.checksum && state.kind === identity.kind;
    if (await directoryExists(target)) {
      const entry = await fs.lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Destination already exists');
      const marker = await jsonIfPresent(path.join(target, markerName));
      if (!matches(marker) || marker.phase !== 'audited') throw Error('Destination already exists');
      return { ...marker, destination: target, replayed: true };
    }

    await fs.mkdir(checkpoint, { recursive: true });
    if (await fs.realpath(checkpoint) !== checkpoint) throw Error('Unexpected checkpoint location');
    let state = await jsonIfPresent(journal);
    if (state && !matches(state)) throw Error('Checkpoint belongs to a different backup');
    if (!state) {
      state = { ...identity, phase: 'extracting' };
      saveJson(journal, state);
    }
    if (!(await directoryExists(staging))) {
      for (const entry of await fs.readdir(checkpoint, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^space\.staging-[a-f0-9-]{36}$/i.test(entry.name)) continue;
        const partial = path.join(checkpoint, entry.name);
        if (path.dirname(await fs.realpath(partial)) === checkpoint) {
          await fs.rm(partial, { recursive: true, force: true });
        }
      }
      state = { ...identity, phase: 'extracting' };
      saveJson(journal, state);
      const result = await restoreAnyFile(source, staging, {
        password, expectedChecksum: identity.checksum, verifiedChecksum: identity.checksum,
      });
      if (result.checksum !== identity.checksum || result.kind !== identity.kind) throw Error('Backup changed during restore');
    }
    const spaces = await auditRestore(staging, identity.kind);
    const marker = { ...identity, phase: 'audited', spaces, sourceSpace: archive.spaceId ?? null };
    saveJson(path.join(staging, markerName), marker);
    if (await directoryExists(target)) throw Error('Destination already exists');
    await fs.rename(staging, target);
    await fs.unlink(journal).catch(() => {});
    await fs.rmdir(checkpoint).catch(() => {});
    return { ...marker, destination: target, replayed: false };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
