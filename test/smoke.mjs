/**
 * 冒烟：把"选定的工具链确实可用"钉成一条可执行的断言。
 *
 * 为什么值得存在：`ADR-0002` 的结论建立在"node:sqlite + sqlite-vec 零原生编译可用"之上。
 * 这条前提一旦悄悄失效（Node 降级、平台不支持、包被撤），ADR 的整个论证就悬空了 ——
 * 而它不会自己报错。所以把它变成测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { load as loadVec, getLoadablePath } from 'sqlite-vec';
import fs from 'node:fs';

test('node:sqlite 可用且允许加载扩展', () => {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  assert.equal(typeof db.loadExtension, 'function');
  db.close();
});

test('sqlite-vec 有本平台预编译二进制（无原生编译）', () => {
  const p = getLoadablePath();
  assert.ok(fs.existsSync(p), `扩展不存在：${p}`);
});

test('vec0 虚拟表可建可查（D=8，最小闭环）', () => {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  loadVec(db);
  assert.match(db.prepare('select vec_version() v').get().v, /^v\d+\.\d+\.\d+$/);
  db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[8]);');
  const ins = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)');
  for (let i = 0; i < 5; i += 1) {
    ins.run(BigInt(i), Buffer.from(new Float32Array(8).fill(i / 10).buffer));
  }
  const hit = db.prepare('SELECT rowid FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
    .all(Buffer.from(new Float32Array(8).fill(0.4).buffer));
  assert.equal(hit.length, 1);
  assert.equal(Number(hit[0].rowid), 4);   // 读回来是 JS number（node:sqlite 只在超过 2^53 时给 BigInt）
  db.close();
});

test('vec0 的 rowid 只收整数 —— JS number 会被绑成 REAL 而报错（踩过的坑）', () => {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  loadVec(db);
  db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[8]);');
  const ins = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)');
  const buf = Buffer.from(new Float32Array(8).buffer);
  assert.throws(() => ins.run(1, buf), /Only integers/);
  ins.run(BigInt(1), buf);          // 同一个值，换成 BigInt 就过
  db.close();
});
