/**
 * Spike：新项目的向量层选型实测。
 *
 * 规矩（本项目纪律 1）：**换件先量规模** —— 先报两个数：当前 N 条的实测延迟 + 该边界的阈值。
 *  ① 量 sqlite-vec（node:sqlite 内嵌，零原生编译）在 D=1024 下的写/查延迟；
 *  ② 量现有自研 VecStore 在同一 D 下的写/查延迟，做同口径对照。
 *
 * ⚠️ 旧实现 `put()` 是逐条 O(N²)（每次重建整个 Float32Array），所以它的样本必须小得多 ——
 *    这本身就是结论的一部分，不是偷懒。分段输出，前半段先落盘，别被后半段拖住。
 */

import { DatabaseSync } from 'node:sqlite';
import { load as loadVec } from 'sqlite-vec';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DIM = 1024;
const K = 8;
const QUERIES = 30;

const rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
function unitVec(d) {
  const v = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i += 1) { const x = rnd() * 2 - 1; v[i] = x; n += x * x; }
  n = Math.sqrt(n);
  for (let i = 0; i < d; i += 1) v[i] /= n;
  return v;
}
const ms = (t) => Number(t.toFixed(2));
const out = [];
const say = (s) => { out.push(s); console.log(s); };

// ── ① sqlite-vec ─────────────────────────────────────────────────────────
function benchSqliteVec(NS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecspike-'));
  const dbPath = path.join(dir, 'spike.db');
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  loadVec(db);
  say(`sqlite-vec version: ${db.prepare('select vec_version() v').get().v}`);
  db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${DIM}]);`);
  db.exec('CREATE TABLE meta(id INTEGER PRIMARY KEY, chatKey TEXT, kind TEXT);');

  const insV = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)');
  const insM = db.prepare('INSERT INTO meta(id, chatKey, kind) VALUES (?, ?, ?)');
  const q = db.prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT ?');
  // vec0 的 KNN 必须带 `k = ?` 或直接 LIMIT；带 JOIN 时把约束留在 vec0 那一侧的子查询里。
  const qf = db.prepare(`SELECT m.chatKey, v.distance FROM (
                           SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ?
                         ) v JOIN meta m ON m.id = v.rowid
                         WHERE m.chatKey = ? ORDER BY v.distance LIMIT ?`);

  const rows = [];
  const probe = unitVec(DIM);
  let written = 0;
  for (const N of NS) {
    const t0 = performance.now();
    db.exec('BEGIN');
    for (; written < N; written += 1) {
      insV.run(BigInt(written), Buffer.from(unitVec(DIM).buffer));   // rowid 只收整数
      insM.run(BigInt(written), `group:C${written % 50}`, written % 3 === 0 ? 'summary' : 'keyword');
    }
    db.exec('COMMIT');
    const insertMs = performance.now() - t0;

    let acc = 0;
    for (let i = 0; i < QUERIES; i += 1) {
      const t = performance.now();
      q.all(Buffer.from(probe.buffer), K);
      acc += performance.now() - t;
    }
    let acc2 = 0;
    for (let i = 0; i < QUERIES; i += 1) {
      const t = performance.now();
      qf.all(Buffer.from(probe.buffer), 200, `group:C${i}`, K);
      acc2 += performance.now() - t;
    }
    const row = {
      实现: 'sqlite-vec',
      N,
      写入总ms: ms(insertMs),
      '写入均值ms/条': Number((insertMs / N).toFixed(4)),
      KNN查询ms: ms(acc / QUERIES),
      'KNN+元数据过滤ms': ms(acc2 / QUERIES),
    };
    rows.push(row);
    say(`  N=${N}  写入 ${row.写入总ms}ms  查询 ${row.KNN查询ms}ms  过滤查询 ${row['KNN+元数据过滤ms']}ms`);
  }
  const size = fs.statSync(dbPath).size;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { rows, sizeTop: size };
}

// ── ② 现有自研 VecStore（同口径对照，故意用小样本）──────────────────────
async function benchOld(NS) {
  const OLD = 'E:/Tools/QQ-Agent-整合版-20260922/plugins/memory-vec/lib/vecstore.mjs';
  if (!fs.existsSync(OLD)) { say(`旧实现不在本机（${OLD}），跳过对照`); return { rows: [] }; }
  const { VecStore } = await import('file:///' + OLD.replace(/\\/g, '/'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecold-'));
  const store = new VecStore(dir, { dim: DIM });
  const rows = [];
  let written = 0;
  const probe = unitVec(DIM);
  for (const N of NS) {
    const t0 = performance.now();
    for (; written < N; written += 1) {
      store.put({ id: `c${written}`, vector: unitVec(DIM), chatKey: `group:C${written % 50}` });
    }
    const insertMs = performance.now() - t0;
    let acc = 0;
    for (let i = 0; i < QUERIES; i += 1) {
      const t = performance.now();
      store.search({ vector: probe, k: K });
      acc += performance.now() - t;
    }
    const row = {
      实现: 'VecStore(自研)',
      N,
      写入总ms: ms(insertMs),
      '写入均值ms/条': Number((insertMs / N).toFixed(4)),
      KNN查询ms: ms(acc / QUERIES),
      'KNN+元数据过滤ms': null,
    };
    rows.push(row);
    say(`  N=${N}  写入 ${row.写入总ms}ms  查询 ${row.KNN查询ms}ms`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { rows };
}

say('=== ① sqlite-vec（node:sqlite 内嵌 + 预编译 dll，零原生编译）D=1024 ===');
const a = benchSqliteVec([1_000, 10_000, 50_000]);
say(`  50k 时库文件 ${(a.sizeTop / 1024 / 1024).toFixed(1)} MiB`);

say('\n=== ② 现有自研 VecStore（同 D，小样本 —— 它 put() 是 O(N²)）===');
const b = await benchOld([500, 1_000, 2_000]);

say('\n=== 汇总 ===');
console.table([...a.rows, ...b.rows]);
fs.writeFileSync('spike/bench-result.json', JSON.stringify({ sqliteVec: a.rows, old: b.rows, sizeTop50k: a.sizeTop }, null, 2));
say('结果已写入 spike/bench-result.json');
