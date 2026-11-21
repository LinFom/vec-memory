import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { inspectAnyFile, restoreAnyFile } from '../src/standalone/backup.mjs';
import { DurableLog } from '../src/core/durable-log.mjs';
import { createSpaceEngine } from '../src/standalone/engine.mjs';
import { canonicalMessages, canonicalEntities, canonicalChatKey } from '../src/core/input-source.mjs';
import { continuityTypes, exportContinuityRecords, supportsContinuity } from './continuity-records.mjs';

const segmentPath = /^records\/[a-z0-9][a-z0-9_-]{0,79}\.ndjson$/;
const assetPath = /^assets\/[a-f0-9]{64}$/;
const sha256 = /^[a-f0-9]{64}$/;
const inventory = new Map([
  ['input/messages.jsonl', 'vec-memory.message'],
  ['input/entities.json', 'vec-memory.entity'],
  ['input/observations.jsonl', 'vec-memory.observation'],
  ...Array.from(continuityTypes, ([kind,{file}]) => [file,kind]),
  ['input/memory-operations.jsonl', 'vec-memory.memory-operation'],
  ['input/correction-intents.jsonl', 'vec-memory.correction'],
  ['input/workspace.jsonl', 'vec-memory.workspace-operation'],
  ['input/relationships.jsonl', 'vec-memory.relationship-revision'],
  ['input/graph-identities.jsonl', 'vec-memory.identity-operation'],
  ['legacy/data/memory-vec/normalizer/entities.json', 'vec-memory.normalizer-entity-registry'],
  ['legacy/data/memory-vec/normalizer/secret.key', 'vec-memory.identity-key'],
  ['legacy/data/memory-vec/consolidate/events.jsonl', 'vec-memory.event'],
  ['legacy/data/memory-vec/facts/slots.jsonl', 'vec-memory.fact'],
]);


export function supportsMessage(record) {
  const message = record.payload;
  const validId = (value, max = 200) => typeof value === 'string' && value.trim() === value &&
    value.length > 0 && value.length <= max;
  return record.protocol === 'vec-memory/record@1' && record.kind === 'vec-memory.message' &&
    record.schemaVersion === 1 && record.operation === 'put' && record.revision === 1 &&
    validId(record.key?.namespace, 256) && validId(record.key.id) && record.key.id === message?.messageId &&
    validId(message.actorId) && validId(message.conversationId) &&
    typeof message.text === 'string' && message.text.length <= 100000 &&
    ['user', 'assistant', 'system', 'tool'].includes(message.role) &&
    ['private', 'group', 'game', 'channel'].includes(message.scope?.kind) && validId(message.scope.id, 180) &&
    Number.isFinite(message.timestamp) && message.timestamp > 0 &&
    !record.extensions && !record.references?.length;
}

export function supportsObservation(record) {
  return record.protocol === 'vec-memory/record@1' && record.kind === 'vec-memory.observation' &&
    [1, 2].includes(record.schemaVersion) && ['put', 'delete'].includes(record.operation) && !record.extensions;
}

async function inspectEntry(root, entry, pattern, onChunk = () => {}) {
  if (!pattern.test(entry?.file) || !sha256.test(entry?.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw Error('Invalid bundle entry');
  const full = path.join(root, entry.file);
  const actual = await fs.realpath(full);
  if (path.relative(root, actual) !== path.normalize(entry.file)) throw Error('Unexpected bundle entry location');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(actual)) {
    size += chunk.length;
    if (size > entry.bytes) throw Error(`Byte count mismatch: ${entry.file}`);
    hash.update(chunk);
    await onChunk(chunk);
  }
  if (size !== entry.bytes || hash.digest('hex') !== entry.sha256) throw Error(`Integrity check failed: ${entry.file}`);
}

async function previewBundle(directory, onRecord = null) {
  const root = await fs.realpath(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.protocol !== 'vec-memory/bundle@1' || !['full','evidence'].includes(manifest.profile) ||
      ![manifest.datasets, manifest.segments, manifest.assets, manifest.requiredCapabilities].every(Array.isArray)) {
    throw Error('Unsupported bundle manifest');
  }
  const paths = new Set(), counts = new Map();
  const keys = new Set(), revisions = new Set(), outgoing = [];
  const keyOf = key => {
    if (typeof key?.namespace !== 'string' || !key.namespace.trim() ||
        typeof key?.id !== 'string' || !key.id.trim()) throw Error('Invalid record key');
    return JSON.stringify([key.namespace, key.id]);
  };
  const references = { checked: 0, missing: 0, unavailable: 0, examples: [] };
  function reserve(entry) {
    if (paths.has(entry?.file)) throw Error('Duplicate bundle entry');
    paths.add(entry?.file);
  }
  for (const segment of manifest.segments) {
    reserve(segment);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let tail = '', rows = 0;
    await inspectEntry(root, segment, segmentPath, async chunk => {
      const lines = (tail + decoder.decode(chunk, { stream: true })).split('\n');
      tail = lines.pop();
      if (tail.length > 8 * 1024 * 1024) throw Error('Record exceeds preview size limit');
      for (const line of lines) {
        if (line.includes('\r') || line.startsWith('\uFEFF')) throw Error('Invalid NDJSON encoding');
        const record = JSON.parse(line);
        if (!record || typeof record.kind !== 'string') throw Error('Missing record kind');
        if (record.protocol === 'vec-memory/record@1') {
          const key = keyOf(record.key);
          if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw Error('Invalid record revision');
          keys.add(key);
          revisions.add(JSON.stringify([key, record.revision]));
          if (record.references !== undefined && !Array.isArray(record.references)) throw Error('Invalid record references');
          for (const ref of record.references ?? []) {
            const target = keyOf(ref?.key);
            if (ref.revision !== undefined && (!Number.isSafeInteger(ref.revision) || ref.revision < 1)) {
              throw Error('Invalid reference revision');
            }
            outgoing.push({ target, revision: ref.revision, kind: record.kind, locator: segment.file,
              line: rows + 1, id: ref.key.id });
          }
        }
        const tally = counts.get(record.kind) ?? { records: 0, unsupported: 0 };
        tally.records++;
        if (!supportsMessage(record) && !supportsObservation(record) && !supportsContinuity(record)) tally.unsupported++;
        counts.set(record.kind, tally);
        if (onRecord) await onRecord(record);
        rows++;
      }
    });
    if (tail || decoder.decode() || rows !== segment.records) throw Error(`Invalid record count or ending: ${segment.file}`);
  }
  for (const asset of manifest.assets) {
    reserve(asset);
    if (asset?.file !== `assets/${asset?.sha256}`) throw Error('Invalid asset address');
    await inspectEntry(root, asset, assetPath);
  }
  for (const ref of outgoing) {
    const present = ref.revision === undefined ? keys.has(ref.target) : revisions.has(JSON.stringify([ref.target, ref.revision]));
    if (present) {
      references.checked++;
    } else if (manifest.profile === 'evidence' || manifest.datasets.some(row => row.status !== 'complete')) {
      references.unavailable++;
    } else {
      references.checked++;
      references.missing++;
    }
    if (!present && references.examples.length < 20) {
      references.examples.push({ kind: ref.kind, locator: ref.locator, line: ref.line, id: ref.id });
    }
  }
  return { format: manifest.protocol, profile: manifest.profile, sourceSpace: manifest.sourceSpace, references,
    datasets: manifest.datasets, counts: Object.fromEntries(counts),
    unsupportedCapabilities: manifest.requiredCapabilities, assetCount: manifest.assets.length };
}

function inventoryReport(files, prefix) {
  const byName = new Map(files.filter(file => file.name.startsWith(prefix))
    .map(file => [file.name.slice(prefix.length), file]));
  return Array.from(inventory, ([name, kind]) => {
    const entry = byName.get(name);
    return entry ? { kind, status: 'present', locator: entry.name, bytes: entry.size } : { kind, status: 'missing' };
  });
}


async function previewLegacyRecords(space, datasets) {
  const input = path.join(space, 'input');
  const present = kind => datasets.some(row => row.kind === kind && row.status === 'present');
  const hasMessages = present('vec-memory.message');
  const messages = hasMessages ? canonicalMessages(input) : [];
  const sources = new Map(messages.map(row => [row.messageId, canonicalChatKey(row.scope)]));
  const counts = {};
  if (hasMessages) counts['vec-memory.message'] = { records: messages.length, unsupported: 0 };
  if (present('vec-memory.entity')) {
    const entities = canonicalEntities(input);
    counts['vec-memory.entity'] = { records: entities.length, unsupported: entities.length };
  }
  const references = { checked: 0, missing: 0, unavailable: 0, examples: [] };
  for (const [file, kind] of inventory) {
    if (!file.endsWith('.jsonl') || kind === 'vec-memory.message' || !present(kind)) continue;
    const lines = createInterface({ input: createReadStream(path.join(space, file)), crlfDelay: Infinity });
    const count = { records: 0, unsupported: 0 };
    counts[kind] = count;
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      count.records++;
      if (!continuityTypes.has(kind)) count.unsupported++;
      const refs = new Map();
      if (continuityTypes.has(kind)) {
        for (const ref of row.data?.sourceRefs ?? [row.data?.sourceRef].filter(Boolean)) {
          if (ref?.type === 'message' && typeof ref.id === 'string') refs.set(ref.id,ref.chatKey);
        }
      }
      for (const id of Array.isArray(row?.evidenceIds) ? row.evidenceIds : []) {
        if (typeof id === 'string') refs.set(id, row.chatKey);
      }
      for (const provenance of [row?.provenance, ...Object.values(row?.itemProvenance ?? {})]) {
        for (const ref of Array.isArray(provenance) ? provenance : []) {
          if (ref?.type === 'message' && typeof ref.id === 'string') refs.set(ref.id, ref.chatKey);
        }
      }
      for (const [id, chatKey] of refs) {
        if (!hasMessages) {
          references.unavailable++;
          continue;
        }
        references.checked++;
        if (sources.has(id) && (!chatKey || sources.get(id) === chatKey)) continue;
        references.missing++;
        if (references.examples.length < 20) references.examples.push({ kind, locator: file, line: lineNumber, id });
      }
    }
  }
  return { counts, references };
}

export async function previewMemoryData(source, { password } = {}) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    try {
      await fs.access(path.join(source, 'manifest.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const input = path.join(source, 'input');
      await fs.access(path.join(input, 'source.json'));
      const files = [];
      for (const name of inventory.keys()) {
        try {
          const entry = await fs.stat(path.join(source, name));
          if (entry.isFile()) files.push({ name, size: entry.size });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const datasets = inventoryReport(files, '');
      return { format: 'vec-memory/canonical-space', profile: 'live', datasets,
        ...(await previewLegacyRecords(source, datasets)) };
    }
    return previewBundle(source);
  }
  const archive = await inspectAnyFile(source, password);
  const prefixes = archive.kind === 'space' ? [''] : [...new Set(archive.files.flatMap(file => {
    const match = /^spaces\/[^/]+\//.exec(file.name);
    return match ? [match[0]] : [];
  }))];
  const parent = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(parent, 'vec-memory-preview-'));
  const destination = path.join(temp, 'space');
  try {
    const restored = await restoreAnyFile(source, destination, { password, expectedChecksum: archive.checksum, verifiedChecksum: archive.checksum });
    if (restored.checksum !== archive.checksum) throw Error('Backup changed during preview');
    const spaces = [];
    for (const prefix of prefixes) {
      const datasets = inventoryReport(archive.files, prefix);
      spaces.push({ sourceSpace: prefix ? prefix.split('/')[1] : archive.spaceId,
        datasets, ...(await previewLegacyRecords(path.join(destination, prefix), datasets)) });
    }
    return { format: `vec-memory/vmb@${archive.version}`, profile: archive.mode ?? 'full',
      checksum: archive.checksum, spaces };
  } finally {
    if (path.dirname(temp) === parent && path.basename(temp).startsWith('vec-memory-preview-')) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}


export async function readPortableBundle(source) {
  const records = [];
  const report = await previewBundle(source, record => records.push(record));
  return { ...report, records };
}

export async function spacePortableRecords(source, namespace, includeObservations = true, {includeRoleNotes=true}={}) {
  if (typeof namespace !== 'string' || !namespace.trim() || namespace !== namespace.trim() || namespace.length > 256) {
    throw Error('A stable source namespace is required');
  }
  const input = path.join(source, 'input');
  await fs.access(path.join(input, 'source.json'));
  const records = canonicalMessages(input).map(message => ({
    protocol: 'vec-memory/record@1', key: { namespace, id: message.messageId },
    kind: 'vec-memory.message', schemaVersion: 1, revision: 1,
    operation: 'put', recordedAt: null, payload: message,
  }));
  if (!includeObservations) return records;
  const origin = await readOptionalJson(path.join(input, 'portable-origin.json'));
  if (origin?.namespace && origin.namespace !== namespace) throw Error('Namespace differs from the space origin');
  const observations = new DurableLog(path.join(input, 'observations.jsonl'), () => {});
  observations.assertReadable();
  for (const row of observations.rows) {
    if (row.data.record.key.namespace !== namespace) throw Error('Observation namespace differs from the message namespace');
    records.push(row.data.record);
  }
  records.push(...await exportContinuityRecords(source,namespace,{includeRoleNotes}));
  const retained = await readOptionalJson(path.join(input, 'portable-retained.json'));
  if (retained) {
    if (!Array.isArray(retained)) throw Error('Invalid retained record file');
    records.push(...retained);
  }
  return records;
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function exportMemoryMessages(source, destination, namespace, { includeObservations = false, includeRoleNotes = false } = {}) {
  const serviceLock = path.join(path.resolve(source),'..','..','.service.lock');
  const owner = await readOptionalJson(serviceLock);
  if (owner) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('Source service lock has no valid owner');
    try {process.kill(owner.pid,0);throw Error('Stop source writes or export from a consistent restored snapshot');}
    catch(error) {if (error.code !== 'ESRCH') throw error;}
  }
  const records = await spacePortableRecords(source, namespace, includeObservations,{includeRoleNotes});
  const file = 'records/messages.ndjson';
  await fs.mkdir(destination);
  await fs.mkdir(path.join(destination, 'records'));
  const hash = createHash('sha256');
  let bytes = 0;
  const handle = await fs.open(path.join(destination, file), 'wx');
  try {
    let batch = [];
    for (const row of records) {
      batch.push(JSON.stringify(row) + '\n');
      if (batch.length < 128) continue;
      const chunk = Buffer.from(batch.join(''));
      await handle.writeFile(chunk);
      hash.update(chunk);
      bytes += chunk.length;
      batch = [];
    }
    if (batch.length) {
      const chunk = Buffer.from(batch.join(''));
      await handle.writeFile(chunk);
      hash.update(chunk);
      bytes += chunk.length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const manifest = {
    protocol: 'vec-memory/bundle@1', bundleId: randomUUID(),
    createdAt: new Date().toISOString(), sourceSpace: path.basename(path.resolve(source)),
    profile: 'evidence',
    datasets: Array.from(new Set([...inventory.values(), ...records.map(row => row.kind)]), kind =>
      kind === 'vec-memory.message' || includeObservations && (kind === 'vec-memory.observation' || continuityTypes.has(kind) &&
        (kind !== 'vec-memory.role-note' || includeRoleNotes))
        ? { kind, status: 'complete' }
        : records.some(row => row.kind === kind)
          ? { kind, status: 'partial', reason: 'Retained portable records' }
          : { kind, status: 'omitted', reason: 'Outside this export scope' }),
    requiredCapabilities: [], assets: [],
    segments: [{ file, bytes, records: records.length, sha256: hash.digest('hex') }],
  };
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function restoreMemoryMessages(source, destination) {
  const target = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(target));
  const temp = await fs.mkdtemp(path.join(parent, 'vec-memory-import-'));
  const staging = path.join(temp, 'space');
  try {
    await fs.access(target).then(() => { throw Error('Destination already exists'); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.mkdir(staging);
    const engine = createSpaceEngine({ root: staging, maintenance: true });
    let restored = 0, namespace = null, batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const result = await engine.call('ingest', { messages: batch });
      if (result.rejected || result.accepted + result.duplicates !== batch.length) {
        throw Error('Bundle contains invalid or conflicting messages');
      }
      restored += result.accepted;
      batch = [];
    };
    try {
      const report = await previewBundle(source, async record => {
        if (!supportsMessage(record)) throw Error('Unsupported message record');
        namespace ??= record.key.namespace;
        if (namespace !== record.key.namespace) throw Error('Bundle contains multiple namespaces');
        batch.push(record.payload);
        if (batch.length >= 128) await flush();
      });
      if (report.unsupportedCapabilities.length) throw Error('Bundle requires unsupported capabilities');
      if (report.assetCount) throw Error('Message restore does not support bundle assets');
      if (!report.datasets.some(item => item.kind === 'vec-memory.message' && item.status !== 'omitted')) {
        throw Error('Bundle has no declared message dataset');
      }
      await flush();
      await engine.call('audit', {});
    } finally {
      await engine.close();
    }
    if (namespace) await fs.writeFile(path.join(staging, 'input', 'portable-origin.json'), JSON.stringify({ namespace }));
    await fs.rename(staging, target);
    return { destination: target, restored, namespace };
  } finally {
    if (path.dirname(temp) === parent && path.basename(temp).startsWith('vec-memory-import-')) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}
