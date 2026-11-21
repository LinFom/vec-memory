// 端到端实跑 —— 用**真实的小时块**跑完整链路：读块 → 构建文本 → 嵌入 → 落库 → 搜索。
//
// 为什么必须用真数据：前面几轮的结论在这里同样成立 —— 人造数据天生没有分布问题，
// 所以它能通过自检、却在真数据上一败涂地。这个脚本专门用来在**交付前**看见真数据的形状：
// 每个块实际被截掉多少、向量库多大、自检索能不能命中自己、分数是怎么分布的。
//
// 嵌入端点用**本地假服务**（hashing vectorizer），所以不联网、不花钱、结果可复现。
// 它检验的是"这条链通不通"，不是"你的嵌入模型好不好"。
//
// 运行：
//   node test/realloop.mjs "E:/Tools/QQ-Agent-整合版-20260922" [块数]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { VecStore } from '../src/core/vecstore.mjs';
import { embedTexts, embedDocuments, embedQueries } from '../src/core/embed.mjs';
import { listChunks, readChunk, buildSourceText, buildEmbedText, sourceHash, chunkMeta } from '../src/core/chunkread.mjs';
import { Normalizer } from '../src/core/normalize.mjs';
import { buildVocabulary } from '../src/core/vocab.mjs';
import { distribution, judge, summarize } from '../src/core/stats.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 同 edges.mjs：不再推算宿主根（拆仓后推算会得到错的根）。没给 ⇒ 跳过。
const ROOT = process.argv[2] || process.env.QQ_AGENT_ROOT || '';
const TAKE = Number(process.argv[3]) || 60;
const DATA_ROOT = ROOT ? path.join(ROOT, 'data') : '';


const CHUNKS = ROOT ? path.join(ROOT, 'data', 'memory-v2', 'chunks') : '';
if (!CHUNKS || !fs.existsSync(CHUNKS)) {
  console.log('\n⏭  跳过（未指定宿主数据根）—— 本用例需要真实存档。');
  console.log('   用法：QQ_AGENT_ROOT=<QQ-Agent 根> node test/realloop.mjs [块数]');
  process.exit(0);
}

// ── 本地假嵌入端点（hashing vectorizer，相似文本 → 相似向量）──────────────
const DIM = 96;
function fakeVector(text) {
  const v = new Float64Array(DIM);
  const toks = String(text).toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || [];
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[(h >>> 0) % DIM] += 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return Array.from(v);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* 空体 */ }
    const input = Array.isArray(payload.input) ? payload.input : [payload.input ?? ''];
    const data = input.map((t, i) => ({ index: i, embedding: fakeVector(t) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', model: payload.model, data }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const baseURL = `http://127.0.0.1:${PORT}`;
console.log(`\n真实数据根：${ROOT}`);
console.log(`假嵌入端点：${baseURL}（${DIM} 维，hashing vectorizer，不联网）`);

// ── 1. 读真实块 ─────────────────────────────────────────────────────────
const all = listChunks(CHUNKS);
console.log(`\n── 真实块盘查 ─────────────────────────────────────`);
ok(all.length > 0, '读到核心小时块');
// 均匀采样，不只取一头：块的大小在时间上并不均匀（有的时段刷屏、有的时段只有一句话），
// 只取最近或最早的一批都会得出错误印象（第一版就是这么被骗的：前 60 个块平均 283 字，
// 看着"根本不需要截断"，而早期的块单个就有 1 万多字）。
const step = Math.max(1, Math.floor(all.length / TAKE));
const sample = [];
for (let i = 0; i < all.length && sample.length < TAKE; i += step) sample.push(all[i]);
console.log(`  目录里共 ${all.length} 个块，按每 ${step} 个取 1 个均匀抽 ${sample.length} 个做全链路`);
const built = [];
let broken = 0;
let blocked = 0;
let totalFull = 0;
let totalUsed = 0;
let truncatedCount = 0;
let redactedBodies = 0;
let replacedTotal = 0;
let replacedIdentity = 0;
const byLayer = {};
const byLayerIdentity = {};
let sampleShown = 0;

// 真实词表 + 归一化器（ADR-0002 / ADR-0003）：**出境文本必须由它产出**。
const tVocab = Date.now();
const vocab = buildVocabulary({ dataDir: DATA_ROOT });
const normalizer = new Normalizer({ secret: 'realloop-'.repeat(6) });
normalizer.setVocabulary(vocab.entities);
console.log(`  词表：${vocab.stats.entities} 个实体（人 ${vocab.stats.byKind.person || 0} · 群 ${vocab.stats.byKind.group || 0} · 自己 1）、` +
  `${vocab.stats.surfaces} 个名字、其中 ${vocab.stats.multiNameEntities} 个改过名（耗时 ${Date.now() - tVocab}ms）`);
console.log(`  锚点挖掘：${vocab.stats.anchorCount} 条"名字↔QQ号"锚点，补出 ${vocab.stats.alignedNames} 个显示名`);
console.log(`  机器人自己：${vocab.stats.selfId || '(没判定出来)'} ← ${vocab.stats.selfIdSource || '无来源'}；` +
  `收录 ${(vocab.identity?.selfSurface || []).length} 个自称`);
console.log(`  观察窗：${vocab.horizon.days} 天（${vocab.horizon.start} → ${vocab.horizon.end}）· 存档 ${vocab.stats.messages} 条`);

for (const parsed of sample) {
  const { chunk, error } = readChunk(CHUNKS, parsed.id);
  if (error || !chunk) { broken++; continue; }
  let info;
  try {
    info = buildEmbedText(chunk, { maxChars: 1200, normalizer });
  } catch (err) {
    blocked++;
    console.log(`  ⛔ ${parsed.id} 被拒绝出境：${err?.code} ${err?.message}`);
    continue;
  }
  if (!info.text) { broken++; continue; }
  totalFull += info.fullChars;
  totalUsed += info.usedChars;
  if (info.truncated) truncatedCount++;
  if (info.redaction?.total) redactedBodies++;
  replacedTotal += info.redaction?.total || 0;
  replacedIdentity += info.redaction?.identity || 0;
  for (const [k, n] of Object.entries(info.redaction?.byLayer || {})) byLayer[k] = (byLayer[k] || 0) + n;
  for (const [k, n] of Object.entries(info.redaction?.byLayerIdentity || {})) byLayerIdentity[k] = (byLayerIdentity[k] || 0) + n;
  built.push({ parsed, chunk, info, hash: sourceHash(chunk, info.text) });

  // 抽一条真数据，把"本机原文 / 出境文本"并排打出来 —— 这是本插件最该被看见的一屏
  if (sampleShown < 2 && info.redaction?.identity >= 3) {
    sampleShown++;
    console.log(`\n  ── 对照样本 ${sampleShown}：${parsed.id} ──`);
    console.log(`  本机原文（不出境）：${info.source.slice(0, 190).replace(/\n/g, ' ⏎ ')}…`);
    console.log(`  出境文本（送云端）：${info.text.slice(0, 190).replace(/\n/g, ' ⏎ ')}…`);
    console.log(`  命中分层：${JSON.stringify(info.redaction.byLayer)}`);
  }
}
ok(built.length > 0, '块能读出来并构建出**干净的**出境文本', `(${built.length} 个可用，${broken} 坏，${blocked} 被拒绝出境)`);
ok(blocked === 0, '没有任何块因为"泄漏"被拒绝出境（闸门没有误伤真数据）');
ok(built.every((b) => normalizer.findLeak(b.info.text) === null), '抽样块逐条复核：出境文本里没有任何已知实体串');
ok(built.every((b) => normalizer.findEntityForm(b.info.text) === null),
  '形态闸门：出境文本里没有任何"名字紧挨硬 ID"的残留（**这条不依赖词表**）');
ok(replacedIdentity > 0, '真实数据上确实发生了实体替换（不是"替了个寂寞"）',
  `(身份 ${replacedIdentity} 处 · 语篇标记 ${replacedTotal - replacedIdentity} 处 · 共 ${replacedTotal} 处；${redactedBodies}/${built.length} 个块动过)`);
console.log(`  替换分层（全部替换点）：${JSON.stringify(byLayer)}`);
console.log(`  替换分层（其中换成身份占位符的）：${JSON.stringify(byLayerIdentity)}`);
console.log('  口径：`byLayer` 是"谁判出来的"，两层之和 = 总替换点；');
console.log('        `byLayerIdentity` 只数人/群/自己，差额是剥掉的语篇标记（CQ 码/日期/时刻/#N/裸@）。');
console.log(`  原文合计 ${totalFull} 字 → 实际送去向量化 ${totalUsed} 字（压缩到 ${(totalUsed / (totalFull || 1) * 100).toFixed(1)}%）`);
console.log(`  其中 ${truncatedCount}/${built.length} 个块被截断 —— 这就是"必须截断"的实证`);

// ── 2. 嵌入 + 落库 ──────────────────────────────────────────────────────
console.log(`\n── 嵌入与落库 ─────────────────────────────────────`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-realloop-'));
const store = new VecStore(TMP);
const t0 = Date.now();
const batchSize = 16;
let embedded = 0;
for (let i = 0; i < built.length; i += batchSize) {
  const slice = built.slice(i, i + batchSize);
  // 走**上线入口**（文档侧 + 出境自检），不是低层 embedTexts
  const { vectors, dim } = await embedDocuments(slice.map((b) => b.info.text), {
    baseURL, apiKey: 'fake-key', model: 'fake-hash-96', batchSize, normalizer
  });
  ok(dim === DIM || embedded > 0, '端点返回维度符合预期', `(dim=${dim})`);
  for (let j = 0; j < slice.length; j++) {
    store.put({ id: slice[j].parsed.id, vector: vectors[j], model: 'fake-hash-96', meta: { ...chunkMeta(slice[j].parsed, slice[j].chunk, slice[j].info), sourceHash: slice[j].hash } });
    embedded++;
  }
}
const elapsed = Date.now() - t0;
ok(embedded === built.length, '全部写入成功', `(${embedded} 条，耗时 ${elapsed}ms)`);
const st = store.status();
const perMs = elapsed / Math.max(1, embedded);
console.log(`  库体积 ${(st.bytesTotal / 1024).toFixed(1)} KB（bin ${(st.bytes.bin / 1024).toFixed(1)} KB）· 平均 ${perMs.toFixed(1)} ms/条`);

// 维度锁定：混写下不同维度必须被拒
let rejected = false;
try {
  store.put({ id: 'x', vector: Array.from({ length: DIM + 7 }, () => 1), model: 'fake-hash-96' });
} catch { rejected = true; }
ok(rejected, '换维度写入被明确拒绝（不让两种维度混进一个文件）');

// 换模型也必须被拒
let rejected2 = false;
try {
  store.put({ id: 'y', vector: fakeVector('x'), model: '另一个模型' });
} catch { rejected2 = true; }
ok(rejected2, '换模型写入被明确拒绝');

// ── 3. 幂等：再跑一遍不该新增 ───────────────────────────────────────────
console.log(`\n── 幂等复跑 ───────────────────────────────────────`);
let skipped = 0;
for (const b of built) {
  const existed = store.get(b.parsed.id);
  if (existed && existed.meta?.sourceHash === b.hash) skipped++;
}
ok(skipped === built.length, '全部块在第二次索引时会被跳过（不重复烧 token）', `(${skipped}/${built.length})`);

// ── 4. 自检索一致性 ────────────────────────────────────────────────────
console.log(`\n── 检索 ───────────────────────────────────────────`);
let hitFirst = 0;
const ranks = [];
for (const b of built.slice(0, Math.min(20, built.length))) {
  // 查询侧走 embedQueries：会自动加 `Instruct:` 前缀（假端点不关心，但链路要一致）
  const { vectors } = await embedQueries([b.info.text], { baseURL, apiKey: 'fake-key', model: 'fake-hash-96', normalizer });
  const r = store.search({ vector: vectors[0], k: 5 });
  const idx = r.hits.findIndex((h) => h.id === b.parsed.id);
  if (idx === 0) hitFirst++;
  ranks.push(idx);
}
ok(hitFirst === ranks.length, '用原文检索时，每条命中自己且排第一（自检索一致性）', `(${hitFirst}/${ranks.length})`);

// 跨块检索：拿一个块的原文去全库搜，看分数怎么分布
const probe = built[Math.floor(built.length / 2)];
const { vectors: qv } = await embedQueries([probe.info.text], { baseURL, apiKey: 'fake-key', model: 'fake-hash-96', normalizer });
const result = store.search({ vector: qv[0], k: 10 });
const dist = distribution(result.hits.map((h) => h.score), { topK: 5 });
const jd = judge(dist, { topK: 5 });
console.log(`  扫描 ${result.scanned} 条 · ${summarize(dist)}`);
console.log(`  判据：${jd.ok ? '通过' : '不通过'}（` + jd.checks.map((c) => `${c.label}=${c.pass ? '✓' : '✗(' + c.actual + ')'}`).join(' ') + '）');
ok(dist.n > 0, '检索返回了结果');
ok(result.hits[0].id === probe.parsed.id, '最相似的仍然是自己（余弦性质）');

// ── 4b. 查询侧对称归一化（ADR-0002 第 4 条：最容易漏的一半）────────────────
console.log(`\n── 查询侧（对称归一化）─────────────────────────────`);
{
  // 用真词表里第一个有名字的人，构造一个"问句里带真名"的场景
  const person = vocab.entities.find((e) => e.kind === 'person' && e.surface.length && e.surface[0].length >= 2);
  if (person) {
    const qRaw = `${person.surface[0]} 说过什么关于换模型的事吗`;
    const qNorm = normalizer.normalize(qRaw, { context: 'query', register: false }).text;
    ok(!qNorm.includes(person.surface[0]), '问句里的真名在查询侧也被替换（否则两侧落进不同向量空间，静默降分）',
      `("${qNorm}")`);
    const { vectors: v2, framed } = await embedQueries([qNorm], { baseURL, apiKey: 'fake-key', model: 'fake-hash-96', normalizer });
    ok(/^Instruct: /.test(framed[0]), '查询侧带上了指令前缀', `("${framed[0].slice(0, 34)}…")`);
    const r2 = store.search({ vector: v2[0], k: 5 });
    ok(r2.hits.length > 0, '这条查询能返回结果（不是空集）', `(${r2.hits.length} 条，最高分 ${r2.hits[0]?.score?.toFixed(4)})`);
    console.log(`  原问句：${qRaw}`);
    console.log(`  归一化：${qNorm}`);
    console.log(`  前缀后：${framed[0].slice(0, 70)}…`);
  } else {
    ok(false, '词表里找不到可供演示的人名');
  }
}

// ── 5. 会话过滤 ────────────────────────────────────────────────────────
const chats = store.chats();
console.log(`\n── 会话分布 ───────────────────────────────────────`);
console.log(`  ${chats.length} 个会话：` + chats.slice(0, 5).map((c) => `${c.chatKey}(${c.count})`).join(' '));
if (chats.length) {
  const one = store.search({ vector: qv[0], k: 5, chatKey: chats[0].chatKey });
  ok(one.hits.every((h) => h.meta.chatKey === chats[0].chatKey), '按会话过滤生效', `(${chats[0].chatKey}: ${one.hits.length} 条)`);
}

// ── 6. compact 与落盘复查 ──────────────────────────────────────────────
console.log(`\n── 维护 ───────────────────────────────────────────`);
store.del(built[0].parsed.id);
const cp = store.compact();
ok(cp.removed === 1, 'compact 回收恰好 1 个空槽', `(${JSON.stringify(cp)})`);
const v = store.verify();
ok(v.ok, '落盘一致（verify 通过）', v.ok ? '' : `(${v.problems.join('；')})`);
const reopened = new VecStore(TMP);
ok(reopened.count === store.count, '重新打开后条数一致', `(${reopened.count})`);

// ── 7. 性能外推 ────────────────────────────────────────────────────────
console.log(`\n── 性能外推 ───────────────────────────────────────`);
const scanT0 = Date.now();
for (let i = 0; i < 20; i++) store.search({ vector: qv[0], k: 8 });
const perScan = (Date.now() - scanT0) / 20;
const projected = perScan * (50_000 / Math.max(1, store.count));
console.log(`  当前库 ${store.count} 条，单次全量余弦 ${perScan.toFixed(2)} ms`);
console.log(`  线性外推到 5 万条 ≈ ${projected.toFixed(0)} ms —— QQ 群场景（单次对话几秒量级）够用`);

fs.rmSync(TMP, { recursive: true, force: true });
server.close();

console.log(`\n${'═'.repeat(64)}`);
console.log(`端到端结果：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
