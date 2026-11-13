import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { canonicalChatKey } from '../core/input-source.mjs';

const format = 1;
const encoding = 'nfkc-lower-han-bigram-word-v1';
const checksumOf = value => createHash('sha256').update(value).digest('hex');

function terms(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const result = new Set();
  for (const token of normalized.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) || []) {
    const letters = Array.from(token);
    if (!/^\p{Script=Han}/u.test(token) || letters.length < 2) result.add(token);
    else for (let i = 1; i < letters.length; i++) result.add(letters[i - 1] + letters[i]);
  }
  return result;
}

function add(postings, message, offset) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') return;
  const scope = canonicalChatKey(message.scope);
  if (!postings.has(scope)) postings.set(scope, new Map());
  const scoped = postings.get(scope);
  for (const term of terms(message.text)) {
    if (!scoped.has(term)) scoped.set(term, []);
    scoped.get(term).push(offset);
  }
}

export function createHistoryIndex(root, log) {
  const directory = path.join(root, 'derived-history');
  const pointer = path.join(directory, 'active.json');
  let active;
  let persisted;
  let building;

  const head = count => log.rows[count - 1]?.hash || '';
  const matchesSource = state => Number.isSafeInteger(state.watermark) &&
    state.watermark >= 0 && state.watermark <= log.rows.length && state.sourceHead === head(state.watermark);

  function readGeneration(generation) {
    const { state, checksum } = JSON.parse(fs.readFileSync(path.join(directory, generation + '.json'), 'utf8'));
    if (state.format !== format || state.encoding !== encoding || state.generation !== generation ||
        !matchesSource(state) || checksum !== checksumOf(JSON.stringify(state))) return;
    return { ...state, postings: new Map(state.postings.map(([scope, entries]) => [scope, new Map(entries)])) };
  }

  function load() {
    try {
      const { current, previous } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      for (const generation of [current, previous]) {
        if (typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)) continue;
        try {
          active = readGeneration(generation);
          if (active) {
            persisted = { generation, watermark: active.watermark, sourceHead: active.sourceHead };
            return;
          }
        } catch {
          // Try the retained generation before reading the full journal.
        }
      }
    } catch {
      // Derived data is disposable. The journal is checked before rebuilding it.
    }
  }

  function refresh() {
    log.assertReadable();
    if (!active) load();
    if (!active || !matchesSource(active)) {
      active = { format, encoding, generation: null, watermark: 0, sourceHead: '', postings: new Map() };
    }
    for (let i = active.watermark; i < log.rows.length; i++) {
      add(active.postings, log.rows[i].data.message, i);
    }
    active.watermark = log.rows.length;
    active.sourceHead = head(active.watermark);
    return active;
  }

  async function rebuild() {
    log.assertReadable();
    const watermark = log.rows.length;
    const postings = new Map();
    building = { indexedRows: 0, sourceRows: watermark };
    try {
      for (let offset = 0; offset < watermark; offset++) {
        add(postings, log.rows[offset].data.message, offset);
        if ((offset + 1) % 1000 === 0) {
          building.indexedRows = offset + 1;
          await setImmediate();
        }
      }
      building.indexedRows = watermark;
      log.assertReadable();
      return await activate(postings, watermark);
    } finally {
      building = undefined;
    }
  }

  async function activate(postings, watermark) {
    const generation = randomUUID();
    const state = {
      format, encoding, generation, watermark, sourceHead: head(watermark),
      postings: [...postings].map(([scope, entries]) => [scope, [...entries]]),
    };
    if (!active) load();
    const previous = active?.generation ?? null;
    fs.mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify(state);
    const checksum = checksumOf(payload);
    const generationFile = path.join(directory, generation + '.json');
    const serialized = `{"state":${payload},"checksum":"${checksum}"}`;
    await fs.promises.writeFile(generationFile, serialized,
      { flag: 'wx', mode: 0o600, flush: true });
    if (await fs.promises.readFile(generationFile, 'utf8') !== serialized) throw new Error('History index generation verification failed');
    const staged = path.join(directory, generation + '.tmp');
    log.assertReadable();
    if (!matchesSource(state)) throw new Error('History index source changed during rebuild');
    fs.writeFileSync(staged, JSON.stringify({ current: generation, previous }), { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(staged, pointer);
    active = { ...state, postings };
    persisted = { generation, watermark, sourceHead: state.sourceHead };
    for (const file of fs.readdirSync(directory)) {
      if (/^[a-f0-9-]{36}\.(?:json|tmp)$/.test(file) && file !== generation + '.json' && file !== previous + '.json') {
        try { fs.unlinkSync(path.join(directory, file)); } catch {}
      }
    }
    const { building: _building, ...result } = status();
    return result;
  }

  function status() {
    if (!active) load();
    const generation = persisted && matchesSource(persisted) ? persisted : null;
    return {
      format, encoding, generation: generation?.generation ?? null,
      watermark: generation?.watermark ?? 0, sourceHead: generation?.sourceHead ?? '',
      sourceRows: log.rows.length,
      ...(building ? { building: { ...building } } : {}),
    };
  }

  function search(query, { chatKey, conversationId, exclude, limit }) {
    const scoped = refresh().postings.get(chatKey);
    if (!scoped) return [];
    const queryTerms = terms(query);
    const candidates = new Map();
    for (const term of queryTerms) {
      for (const offset of scoped.get(term) || []) {
        const message = log.rows[offset]?.data.message;
        if (!message || !['user', 'assistant'].includes(message.role) ||
            canonicalChatKey(message.scope) !== chatKey || exclude.has(message.messageId) ||
            (conversationId && message.conversationId !== conversationId)) continue;
        candidates.set(message, (candidates.get(message) || 0) + 1);
      }
    }
    return [...candidates]
      .map(([message, matches]) => ({ message, score: matches / queryTerms.size }))
      .filter(hit => hit.score >= 0.2)
      .sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp)
      .slice(0, limit);
  }

  return { rebuild, search, status };
}
