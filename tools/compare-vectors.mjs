#!/usr/bin/env node
// tools/compare-vectors.mjs —— **只读**对拍两个向量库目录（逐条 id / sourceHash / 向量摘要）
//
// [by:DS] 2026-10-29 建。用途：`compact()` 前后必须能回答"有没有丢、有没有变、有没有多"，
// 而"活条数相等"只是必要条件 —— 1100 条里丢一条、多一条，总数照样相等。
// 所以这里按**唯一 id 集合 + 向量字节摘要**逐条比。
//
// ── 纪律 ─────────────────────────────────────────────────────────────────
//  ① 不构造 `VecStore`（构造函数会 mkdir + `_recoverPut` 写盘），只静态读三个文件。
//  ② 行号=slot 的语义在这里**要还原**：同 id 多行 alive 时取最后一行（与 `_load` 同口径），
//     否则会拿"压缩前被墓碑掉的旧版本"去和"压缩后留下的那个版本"比，得到假的"变了"。
//  ③ 向量摘要 = 该 slot 在 `vectors.bin` 里那段 float32 字节的 sha256。
//     比数值相等更严格也更便宜：NaN/-0 这类"看起来相等"的差异也会被抓到。
//
// 用法：
//   node tools/compare-vectors.mjs --a _rollback/20261029-compact/A \
//                                  --b data/memory-vec/vector-generations/<sha> [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}
const args = parseArgs(process.argv);
const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

/** 静态读一个库目录：返回 { dim, ids: Map<id,{slot,sourceHash,digest}> } */
function readStore(dir) {
  const p = path.resolve(dir);
  for (const f of ['index.json', 'meta.jsonl', 'vectors.bin']) {
    if (!fs.existsSync(path.join(p, f))) fail(`${p} 不是完整的库目录（缺 ${f}）`);
  }
  const index = JSON.parse(fs.readFileSync(path.join(p, 'index.json'), 'utf8'));
  const dim = Number(index.dim);
  if (!Number.isInteger(dim) || dim <= 0) fail(`${p} 的 index.json 没有合法 dim`);
  const bin = fs.readFileSync(path.join(p, 'vectors.bin'));

  const lines = fs.readFileSync(path.join(p, 'meta.jsonl'), 'utf8').split('\n');
  // 先按行号=slot 建表（与 `_load` 一致：同 id 后者覆盖前者）
  const byId = new Map();
  let rows = 0;
  let deleted = 0;
  for (let slot = 0; slot < lines.length; slot++) {
    const line = lines[slot];
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { fail(`${p} 第 ${slot + 1} 行不是合法 JSON`); }
    rows++;
    if (m?.state !== 'alive' || !m.id) { deleted++; continue; }
    const start = slot * dim * 4;
    const end = start + dim * 4;
    if (end > bin.length) fail(`${p} 第 ${slot + 1} 行的向量越界（bin 只有 ${bin.length} 字节）`);
    byId.set(String(m.id), {
      slot,
      sourceHash: m.sourceHash ?? null,
      kind: m.kind ?? null,
      digest: createHash('sha256').update(bin.subarray(start, end)).digest('hex').slice(0, 16)
    });
  }
  const expectBytes = lines.filter((l) => l.trim()).length * dim * 4;
  return { dir: p, dim, rows, deleted, unique: byId.size, binBytes: bin.length, expectBytes, ids: byId };
}

function main() {
  if (!args.a || !args.b) fail('需要 --a <目录> 与 --b <目录>');
  const A = readStore(args.a);
  const B = readStore(args.b);
  if (A.dim !== B.dim) fail(`维度不同（${A.dim} vs ${B.dim}）—— 这两个库不可逐条比`);

  const onlyA = [];      // 压缩前有、压缩后没有 ⇒ 丢了
  const onlyB = [];      // 压缩后多出来 ⇒ 多写了
  const hashChanged = [];
  const vecChanged = [];
  let same = 0;
  for (const [id, a] of A.ids) {
    const b = B.ids.get(id);
    if (!b) { onlyA.push(id); continue; }
    if (a.sourceHash !== b.sourceHash) hashChanged.push({ id, a: a.sourceHash, b: b.sourceHash });
    if (a.digest !== b.digest) vecChanged.push({ id, a: a.digest, b: b.digest, slotA: a.slot, slotB: b.slot });
    if (a.sourceHash === b.sourceHash && a.digest === b.digest) same++;
  }
  for (const id of B.ids.keys()) if (!A.ids.has(id)) onlyB.push(id);

  const out = {
    a: { dir: A.dir, dim: A.dim, rows: A.rows, deletedRows: A.deleted, uniqueIds: A.unique, binBytes: A.binBytes },
    b: { dir: B.dir, dim: B.dim, rows: B.rows, deletedRows: B.deleted, uniqueIds: B.unique, binBytes: B.binBytes },
    // "没丢"判据是**集合**：onlyA 为空。行数相等只是必要条件，不写在这里当结论。
    lost: onlyA.length, added: onlyB.length,
    sourceHashChanged: hashChanged.length, vectorChanged: vecChanged.length, identical: same,
    lostIds: onlyA.slice(0, 50), addedIds: onlyB.slice(0, 50),
    sourceHashSamples: hashChanged.slice(0, 10), vectorSamples: vecChanged.slice(0, 10)
  };

  if (args.json) { console.log(JSON.stringify(out, null, 2)); }
  else {
    const mb = (n) => `${(n / 1048576).toFixed(2)}MB`;
    console.log(`\nA（压缩前）：${A.dir}`);
    console.log(`  行 ${A.rows}（墓碑 ${A.deleted}）· 唯一 id ${A.unique} · bin ${mb(A.binBytes)}`);
    console.log(`B（压缩后）：${B.dir}`);
    console.log(`  行 ${B.rows}（墓碑 ${B.deleted}）· 唯一 id ${B.unique} · bin ${mb(B.binBytes)}`);
    console.log(`\n逐条对拍（以唯一 id 集合为准）：`);
    console.log(`  两边都在且完全一致：${same}`);
    console.log(`  A 有 B 无（丢）：${out.lost}${out.lostIds.length ? '  ' + out.lostIds.slice(0, 5).join(', ') : ''}`);
    console.log(`  B 有 A 无（多）：${out.added}${out.addedIds.length ? '  ' + out.addedIds.slice(0, 5).join(', ') : ''}`);
    console.log(`  sourceHash 变了：${out.sourceHashChanged}`);
    console.log(`  向量字节变了：${out.vectorChanged}`);
    console.log(`\n⇒ 压缩无损：${out.lost === 0 && out.added === 0 && out.sourceHashChanged === 0 && out.vectorChanged === 0 ? '是 ✓' : '否 ✗'}\n`);
  }
  process.exitCode = out.lost === 0 && out.added === 0 && out.sourceHashChanged === 0 && out.vectorChanged === 0 ? 0 : 3;
}

main();
