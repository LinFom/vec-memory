// 历史词法索引 [2026-11-14]
//
// 为什么需要它：input/messages.jsonl 是 hash 链操作日志，真库已经是 50 万行 / 300+MB。
// 每次按原话回查历史都全量解析这份 JSON，既慢又吃内存，而且没法告诉用户「索引覆盖到哪一行」。
//
// 做法：给每一条原料行记一条 16 字节定长记录 —— 8 字节字节偏移 + 8 字节词法指纹（64 位 bloom）。
// 检索时先扫指纹挑候选（509k 行只要读 8MB），再按偏移 seek 回原文逐条验真。
// 只读原料，绝不改原料；索引自己写在 <space>/history-index/ 下，随时可删可重建。
//
// 目录结构：
//   history-index/
//     active.json                 当前生效代的指针（generation/覆盖行数/原料指纹）
//     generations/<generation>/
//       meta.json                 该代的完整元数据
//       rows.bin                  每行 16 字节：offset(u64 BE) + bloom(u32,u32 BE)
//
// 覆盖语义（前端「当前索引水位 / 原料行数」就是这两个数）：
//   indexedRows = 建索引时实际写进 rows.bin 的行数
//   sourceRows  = 原料当前的行数
// 原料在建索引之后又长长了，sourceRows 会大于 indexedRows —— 这是真相，不要抹平，
// 用户就该看到「索引落后于原料」，然后决定要不要重建。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {MemoryError,digest} from '../core/durable-log.mjs';

export const INDEX_VERSION = 1;
export const TOKENIZER_VERSION = 1;
export const INDEX_DIR = 'history-index';
export const SOURCE_REL = 'messages.jsonl';
export const RECORD_BYTES = 16;
const HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 1 << 20;
// 没建过索引、又读不动一个超大原料时，宁可知不知道 —— 报 null，让界面显示「原料行数未知」，
// 而不是编一个数字糊过去。
const FULL_COUNT_LIMIT = 32 * 1024 * 1024;
const KEEP_GENERATIONS = 2;
const PROGRESS_MIN_INTERVAL_MS = 400;

const sourcePathOf = spaceDir => path.join(spaceDir, 'input', SOURCE_REL);
const indexDirOf = spaceDir => path.join(spaceDir, INDEX_DIR);
const generationsDirOf = spaceDir => path.join(indexDirOf(spaceDir), 'generations');
const activeFileOf = spaceDir => path.join(indexDirOf(spaceDir), 'active.json');
const generationDirOf = (spaceDir, generation) => path.join(generationsDirOf(spaceDir), generation);

/* ---------------- 词法指纹 ---------------- */

// 32 位 FNV-1a：够快，且分布对这种「只为挑候选」的用途足够。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/;

// 中文没有空格，按「单字 + 相邻二元」切；拉丁/数字按词切。
// 只做召回用的粗切分，验真那一步是原文比对，所以这里不需要分词词典。
function termHashes(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const out = [];
  const re = /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const run = m[0];
    if (CJK_RUN.test(run)) {
      for (let i = 0; i < run.length; i++) {
        out.push(fnv1a('c' + run[i]));
        if (i + 1 < run.length) out.push(fnv1a('b' + run.slice(i, i + 2)));
      }
    } else if (run.length >= 2) {
      out.push(fnv1a('w' + run));
    }
  }
  return out;
}

// 64 位 bloom 用两个 32 位字表示：低位字 + 高位字。
function bloomOf(text) {
  let lo = 0, hi = 0;
  for (const h of termHashes(text)) {
    const bit = h & 63;
    if (bit < 32) lo = (lo | (1 << bit)) >>> 0;
    else hi = (hi | (1 << (bit - 32))) >>> 0;
  }
  return {lo, hi};
}

/* ---------------- 原料读数 ---------------- */

async function headHash(src) {
  const fh = await fsp.open(src, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const {bytesRead} = await fh.read(buf, 0, HEAD_BYTES, 0);
    return 'sha256:' + digest(['history-source-head', buf.subarray(0, bytesRead).toString('base64')]);
  } finally {
    await fh.close();
  }
}

// 数换行。末尾没有换行符但确实有一行内容时补 1。
async function countLines(src, {from = 0, base = 0, limit} = {}) {
  const st = await fsp.stat(src);
  const size = st.size;
  const start = Math.max(0, Math.min(from, size));
  if (limit != null && size - start > limit) return null;
  const fh = await fsp.open(src, 'r');
  try {
    let pos = start, nl = 0, lastByte = 10;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    while (pos < size) {
      const len = Math.min(CHUNK_BYTES, size - pos);
      const {bytesRead} = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) nl++;
      lastByte = buf[bytesRead - 1];
      pos += bytesRead;
    }
    if (size > start && lastByte !== 10) nl++;
    return base + nl;
  } finally {
    await fh.close();
  }
}

/* ---------------- 元数据 ---------------- */

export async function readActive(spaceDir) {
  try {
    const raw = await fsp.readFile(activeFileOf(spaceDir), 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || meta.version !== INDEX_VERSION || typeof meta.generation !== 'string' || !meta.generation) return null;
    return meta;
  } catch {
    return null;
  }
}

async function writeActive(spaceDir, meta) {
  await fsp.mkdir(indexDirOf(spaceDir), {recursive: true});
  const file = activeFileOf(spaceDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fsp.rename(tmp, file);
}

// 状态查询：只读文件，不建索引。前端轮询会频繁调它，必须廉价。
export async function historyFacts(spaceDir) {
  const meta = await readActive(spaceDir);
  const src = sourcePathOf(spaceDir);
  let st = null;
  try {
    st = await fsp.stat(src);
  } catch {
    st = null;
  }
  const base = {
    generation: meta ? meta.generation : null,
    format: 'jsonl',
    encoding: 'utf-8',
    sourceHead: meta ? meta.sourceHead : null
  };
  if (!st) return {...base, watermark: 0, sourceRows: 0};

  let sourceRows = null;
  if (meta && meta.sourceSize === st.size && meta.sourceMtime === st.mtimeMs) {
    // 原料一字未动，直接用建索引时记下的数，零 I/O。
    sourceRows = meta.sourceRows;
  } else if (meta && typeof meta.sourceSize === 'number' && st.size > meta.sourceSize) {
    // 原料只增不减（追加），只数新增那段，不重扫全文。
    const tail = await countLines(src, {from: meta.sourceSize, base: meta.sourceRows});
    sourceRows = tail;
  } else {
    sourceRows = await countLines(src, {limit: FULL_COUNT_LIMIT});
  }
  const indexed = meta ? Number(meta.indexedRows) || 0 : 0;
  return {...base, watermark: sourceRows == null ? indexed : Math.min(indexed, sourceRows), sourceRows};
}

/* ---------------- 建索引 ---------------- */

async function pruneGenerations(spaceDir, keepGeneration) {
  const dir = generationsDirOf(spaceDir);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const gens = [];
  for (const name of names) {
    if (name.startsWith('.tmp-')) {
      // 上次跑到一半崩了留下的临时目录，超过一天就清掉。
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) await fsp.rm(path.join(dir, name), {recursive: true, force: true});
      } catch {}
      continue;
    }
    try {
      const st = await fsp.stat(path.join(dir, name));
      gens.push({name, mtime: st.mtimeMs});
    } catch {}
  }
  gens.sort((a, b) => b.mtime - a.mtime);
  const drop = gens.filter((g, i) => i >= KEEP_GENERATIONS && g.name !== keepGeneration);
  for (const g of drop) await fsp.rm(path.join(dir, g.name), {recursive: true, force: true}).catch(() => {});
}

// 流式建索引。失败时临时目录留着由 pruneGenerations 清理，active.json 一律不动 ——
// 也就是「重建失败，旧索引仍然可用」，不会把用户弄成没有索引的状态。
export async function buildIndex({spaceDir, onProgress = () => {}, signal} = {}) {
  const src = sourcePathOf(spaceDir);
  let st;
  try {
    st = await fsp.stat(src);
  } catch {
    throw new MemoryError('HISTORY_SOURCE_MISSING', 'Space has no messages.jsonl to index', 409);
  }
  const sourceRows = await countLines(src);
  const sourceHead = await headHash(src);
  const generation = digest(['history-index', INDEX_VERSION, TOKENIZER_VERSION, sourceHead, st.size]).slice(0, 32);

  const base = indexDirOf(spaceDir);
  const gens = generationsDirOf(spaceDir);
  await fsp.mkdir(gens, {recursive: true});
  const tmp = path.join(base, `.tmp-${generation}-${process.pid}-${Date.now()}`);
  await fsp.mkdir(tmp, {recursive: true});

  let rows = 0;
  let lastEmit = 0;
  const rowsHandle = await fsp.open(path.join(tmp, 'rows.bin'), 'w');
  try {
    // 攒一批再写，避免每行一次 write 系统调用。
    const batch = Buffer.allocUnsafe(RECORD_BYTES * 2048);
    let batchLen = 0;
    const flush = async () => {
      if (!batchLen) return;
      await rowsHandle.write(batch, 0, batchLen);
      batchLen = 0;
    };
    const pushRecord = async (offset, bloom) => {
      const at = batchLen;
      batch.writeBigUInt64BE(BigInt(offset), at);
      batch.writeUInt32BE(bloom.lo, at + 8);
      batch.writeUInt32BE(bloom.hi, at + 12);
      batchLen += RECORD_BYTES;
      rows++;
      if (batchLen + RECORD_BYTES > batch.length) await flush();
    };

    const stream = fs.createReadStream(src, {highWaterMark: CHUNK_BYTES});
    let carry = Buffer.alloc(0);
    let consumed = 0;
    for await (const chunk of stream) {
      if (signal?.aborted) throw new MemoryError('HISTORY_REBUILD_ABORTED', 'History index rebuild aborted', 409);
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0, idx;
      while ((idx = buf.indexOf(10, start)) !== -1) {
        const line = buf.subarray(start, idx);
        await ingestLine(line, consumed + start);
        start = idx + 1;
      }
      consumed += start;
      carry = buf.subarray(start);
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_MIN_INTERVAL_MS) {
        lastEmit = now;
        onProgress({indexedRows: rows, sourceRows});
      }
    }
    if (carry.length) await ingestLine(carry, consumed);
    await flush();

    async function ingestLine(line, offset) {
      if (!line.length) return;
      let text = '';
      try {
        const obj = JSON.parse(line.toString('utf8'));
        text = obj?.data?.message?.text ?? '';
      } catch {
        // 坏行也要占一个行位 —— 否则 offset 表和原料行号对不上，以后按行号取原文会错位。
        text = '';
      }
      await pushRecord(offset, text ? bloomOf(text) : {lo: 0, hi: 0});
    }
  } finally {
    try {
      await rowsHandle.sync();
    } catch {}
    await rowsHandle.close().catch(() => {});
  }

  const meta = {
    version: INDEX_VERSION,
    generation,
    format: 'jsonl',
    encoding: 'utf-8',
    sourceHead,
    sourceSize: st.size,
    sourceMtime: st.mtimeMs,
    sourceRows,
    indexedRows: rows,
    tokenizer: TOKENIZER_VERSION,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2));

  const target = generationDirOf(spaceDir, generation);
  await fsp.rm(target, {recursive: true, force: true});
  await fsp.rename(tmp, target);
  await writeActive(spaceDir, meta);
  await pruneGenerations(spaceDir, generation);
  onProgress({indexedRows: rows, sourceRows});
  return meta;
}

/* ---------------- 检索 ---------------- */

// 先扫指纹挑候选，再 seek 回原文验真。只读，不改任何状态。
// 主动 recall 用 matchAny 取候选，再由证据层重排。
export async function searchHistory({spaceDir, terms = [], limit = 20, accept = null, matchAny = false} = {}) {
  const wanted = (Array.isArray(terms) ? terms : [terms]).map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const meta = await readActive(spaceDir);
  if (!meta) throw new MemoryError('HISTORY_INDEX_MISSING', 'History index has not been built', 409);
  const rowsFile = path.join(generationDirOf(spaceDir, meta.generation), 'rows.bin');
  const blooms = matchAny ? wanted.map(bloomOf) : [bloomOf(wanted.join(' '))];
  const needles = wanted.map(t => t.toLowerCase());

  const buckets = Array.from({ length: blooms.length + 1 }, () => []);
  const maxCandidates = Math.max(limit * 10, 200);
  const matchesBloom = (lo, hi, bloom) => (bloom.lo || bloom.hi) &&
    ((lo & bloom.lo) >>> 0) === bloom.lo && ((hi & bloom.hi) >>> 0) === bloom.hi;
  const fh = await fsp.open(rowsFile, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = 0;
    while (pos < size && (matchAny || buckets[1].length < maxCandidates)) {
      const len = Math.min(CHUNK_BYTES, size - pos);
      const {bytesRead} = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      for (let o = 0; o + RECORD_BYTES <= bytesRead; o += RECORD_BYTES) {
        const lo = buf.readUInt32BE(o + 8), hi = buf.readUInt32BE(o + 12);
        if (lo === 0 && hi === 0) continue;
        const score = blooms.reduce((n, bloom) => n + Number(matchesBloom(lo, hi, bloom)), 0);
        if (!score) continue;
        const bucket = buckets[score];
        if (bucket.length < maxCandidates) bucket.push(Number(buf.readBigUInt64BE(o)));
        if (!matchAny && bucket.length >= maxCandidates) break;
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const candidates = buckets.reverse().flat();
  if (!candidates.length) return [];

  const src = sourcePathOf(spaceDir);
  const srcHandle = await fsp.open(src, 'r');
  const hits = [];
  try {
    for (const offset of candidates) {
      if (hits.length >= limit) break;
      const line = await readLineAt(srcHandle, offset);
      if (!line) continue;
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const text = String(obj?.data?.message?.text ?? '');
      const lower = text.toLowerCase();
      if (!text || !(matchAny ? needles.some(n => lower.includes(n)) : needles.every(n => lower.includes(n)))) continue;
      const message = obj.data.message;
      if (accept && !accept(message)) continue;
      hits.push({
        messageId: message.messageId ?? null,
        conversationId: message.conversationId ?? null,
        actorId: message.actorId ?? null,
        role: message.role ?? null,
        timestamp: message.timestamp ?? null,
        text,
        offset,
        matchMethod: 'history-lexical'
      });
    }
  } finally {
    await srcHandle.close();
  }
  return hits;
}

async function readLineAt(fh, offset) {
  const buf = Buffer.allocUnsafe(64 * 1024);
  let pos = offset, collected = Buffer.alloc(0);
  while (collected.length < 4 * 1024 * 1024) {
    const {bytesRead} = await fh.read(buf, 0, buf.length, pos);
    if (!bytesRead) break;
    const chunk = buf.subarray(0, bytesRead);
    const nl = chunk.indexOf(10);
    if (nl !== -1) return Buffer.concat([collected, chunk.subarray(0, nl)]).toString('utf8');
    collected = Buffer.concat([collected, chunk]);
    pos += bytesRead;
    if (bytesRead < buf.length) break;
  }
  return collected.length ? collected.toString('utf8') : null;
}
