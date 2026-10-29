import { isCanonicalSource, canonicalFingerprint, canonicalSources, canonicalCorpus } from './input-source.mjs';
// 语料入口：把"老宿主块 + 派生块"合成一份列表，供索引/检索/状态共用。
//
// ── 为什么要有这一层 ─────────────────────────────────────────────────────
// 索引主流程里对语料的用法只有两个动作：`listChunks(dir)` 拿清单、`readChunk(dir, id)` 拿内容。
// 老块在磁盘上，派生块是**算出来的**（不落盘，见 derive.mjs），两者形状不同。
// 如果让调用方各自 if/else，5 个调用点会各写一遍"派生块在哪"，迟早漏一处 ——
// 那种漏是静默的：索引少一批、状态少一批，没有任何报错。
// 所以把差异收在这里：调用方只认 `listCorpus / readCorpusItem` 一对函数。
//
// ── 缓存 ─────────────────────────────────────────────────────────────────
// 派生一次要读 57 个存档文件（实测 248,007 条消息 / 约 70MB JSON）。status 端点被面板轮询，
// 每次都重算会让服务端变成一台常开的风扇。所以按**源签名**缓存：
// 热文件逐个 stat、冷分片只看目录 mtime（新增分片必然改目录 mtime）。
// 签名变了才重算 —— 既不漏新消息，也不做无谓的解码。

import fs from 'node:fs';
import path from 'node:path';

import { listChunks, readChunk } from './chunkread.mjs';
import { deriveChunks, mergeSources } from './derive.mjs';

/** 派生块在落库元数据里的来源标记（`chunkMeta.source`），面板据此区分原件与派生件。 */
export const SOURCE_CORE = 'core-chunk';
export const SOURCE_DERIVED = 'derived-messages';

/** 单块 summary 的归一化**前**预算。归一化会把实体名换成占位符，长度会变，所以留 25% 余量。 */
function budgetFor(maxChars) {
  const n = Number(maxChars);
  const base = Number.isFinite(n) && n > 0 ? n : 1200;
  return Math.max(240, Math.round(base * 0.75));
}

const state = {
  root: '',
  sig: '',
  items: [],
  stats: { at: 0, core: 0, derived: 0, messages: 0, buckets: 0, skippedExisting: 0, skippedEmpty: 0, readErrors: 0 },
  error: null
};

let seq = 0;

function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return '-';
  }
}

/** 源签名：热消息逐文件、冷分片与块目录看 mtime。任一变化都意味着"该重算了"。 */
function signatureOf(root) {
  if (isCanonicalSource(root)) return canonicalFingerprint(root).sig;
  const parts = [];
  const hotDir = path.join(root, 'messages');
  let hot = [];
  try { hot = fs.readdirSync(hotDir).filter((f) => f.endsWith('.json')).sort(); } catch { /* 目录不存在 = 只有老块 */ }
  for (const f of hot) parts.push(`h:${f}:${statSig(path.join(hotDir, f))}`);
  parts.push(`c:${statSig(path.join(root, 'messages-cold'))}`);
  parts.push(`k:${statSig(path.join(root, 'memory-v2', 'chunks'))}`);
  return parts.join('|');
}

function readJson(file) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return JSON.parse(t);
}

/** 从文件名兜底推 chatKey（`group_1051103978.00001.json` → `group:1051103978`）。 */
function chatKeyFromFile(name) {
  const base = String(name).replace(/\.json$/i, '').replace(/\.\d+$/, '');
  const m = /^(group|private)_(.+)$/.exec(base);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * 读宿主存档（热 + 冷）。坏文件**计入 readErrors 并继续** ——
 * 一个坏分片不该让整轮索引停摆，但也不能当没发生过。
 */
function readHostSources(root) {
  if (isCanonicalSource(root)) return {sources:canonicalSources(root),readErrors:0};
  const parts = [];
  let readErrors = 0;
  for (const dirName of ['messages', 'messages-cold']) {
    const dir = path.join(root, dirName);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      try {
        const raw = readJson(path.join(dir, name));
        const messages = Array.isArray(raw) ? raw : (raw?.messages || []);
        if (!Array.isArray(messages) || !messages.length) continue;
        parts.push({ chatKey: String(raw?.chatKey || chatKeyFromFile(name)), messages });
      } catch {
        readErrors++;
      }
    }
  }
  return { sources: mergeSources(parts), readErrors };
}

/**
 * 语料清单（按 id 倒序 = 新的在前，与 `listChunks` 同口径）。
 *
 * 每项都带 `source`；老块带 `file`（绝对路径），派生块带 `chunk`（内容已在内存里，
 * 不必再编码一次 —— 那 70MB 已经解过一轮了，落盘再读回来纯属自找）。
 *
 * @param {string} root 宿主 data 目录（含 memory-v2/、messages/、messages-cold/）
 * @param {{maxChars?:number}} [opts]
 */
export function listCorpus(root, opts = {}) {
  const r = String(root || '').trim();
  if (!r) return [];
  const sig = `${signatureOf(r)}|b${budgetFor(opts.maxChars)}`;
  if (state.items.length && state.root === r && state.sig === sig) return state.items;

  const chunksDir = path.join(r, 'memory-v2', 'chunks');
  const core = isCanonicalSource(r) ? canonicalCorpus(r) : listChunks(chunksDir);
  const existingIds = new Set(core.map((c) => c.id));

  const { sources, readErrors } = readHostSources(r);
  const { chunks, stats } = deriveChunks({
    sources,
    existingIds,
    budgetChars: budgetFor(opts.maxChars)
  });

  const items = [];
  for (const c of core) {
    items.push({
      id: c.id,
      kind: c.kind,
      chatKey: c.chatKey,
      dayKey: c.dayKey,
      hourKey: c.hourKey,
      source: SOURCE_CORE,
      ...(c.chunk ? {chunk:c.chunk} : {file:path.join(chunksDir,c.file)}),
      mtime:c.mtime || 0
    });
  }
  for (const c of chunks) {
    items.push({
      id: c.id,
      kind: c.kind,
      chatKey: c.chatKey,
      dayKey: c.dayKey,
      hourKey: c.hourKey,
      source: SOURCE_DERIVED,
      chunk: c,
      mtime: 0
    });
  }
  items.sort((a, b) => (a.id < b.id ? 1 : -1));

  state.root = r;
  state.sig = sig;
  state.items = items;
  state.stats = {
    at: ++seq,
    core: core.length,
    derived: chunks.length,
    messages: stats.messages,
    buckets: stats.buckets,
    skippedExisting: stats.skippedExisting,
    skippedEmpty: stats.skippedEmpty,
    readErrors
  };
  state.error = null;
  return items;
}

/**
 * 读一项。老块读盘（坏文件返回 error，不抛），派生块直接返回内存里的内容。
 * 返回形状与 `readChunk` 一致，调用方不用分叉。
 */
export function readCorpusItem(item) {
  if (!item || typeof item !== 'object') return { id: '', error: '语料项为空' };
  if (item.chunk) return { id: item.id, chunk: item.chunk, file: null };
  if (item.file) {
    return readChunk(path.dirname(item.file), item.id);
  }
  return { id: item.id, error: '语料项既没有 chunk 也没有 file' };
}

/** 按 id 读（面板 `/api/vec/...` 单块查看用）。找不到返回 error，不抛。 */
export function readCorpusById(root, id, opts = {}) {
  const want = String(id || '');
  if (!want) return { id: '', error: 'id 为空' };
  const hit = listCorpus(root, opts).find((c) => c.id === want);
  if (!hit) return { id: want, error: '找不到该块' };
  return readCorpusItem(hit);
}

/** 上次构建的统计（状态页/自检用）。派生件为 0 且宿主有消息时，说明这条链路断了。 */
export function corpusStats() {
  return { ...state.stats, error: state.error, cached: state.sig !== '' };
}

/** 强制丢弃缓存（配置改完/手动重建用）。 */
export function resetCorpusCache() {
  state.sig = '';
  state.items = [];
}
