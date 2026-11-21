// `--compact` 的**统计对象**回归（主审 P2 · 2026-10-29 · [by:DS]）
//
// 病因：切过代之后 `openActiveVectors(dir)` 返回的是 `vector-generations/<sha>/` 里的 store，
// `compact()` 改的也是那里的 bin；而工具用 `path.join(libDir,'vectors.bin')` 量大小
// ⇒ 报的一直是**旧库**的体积（通常纹丝不动），看起来"压缩没省空间"，
// 真正被压缩的那个文件从未出现在输出里。
//
// 所以这条测试只钉两件事，都落在**用户看得见的输出与文件系统**上：
//   ① 输出里的"压缩目标/实际文件"必须是活代那个 bin，字节数跟着活代变；
//   ② 库根那份旧库（切代后仍在，是回退路径）**一个字节都不能动**。
//
// 用真实子进程跑工具而不是 import 它：这个 bug 就在"脚本打印什么"这一层，
// 把函数拆出来单测等于测一个用户看不到的替代品。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VecStore } from '../src/core/vecstore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '..', 'tools', 'rebuild-generation.mjs');
const DIM = 64;
const vec = () => Array.from({ length: DIM }, (_, i) => 0.5 + (i % 7) * 0.01);

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-compact-'));
  t.after(() => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'vmm-compact-'))); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** 建一个小库：`reput` 个 id 各被重写一次 ⇒ 槽位比活条数多。 */
function seedStore(dir, ids, reput) {
  const s = new VecStore(dir, { model: 'm' });
  for (const id of ids) s.put({ id, vector: vec(), model: 'm', meta: { text: `正文 ${id}`, sourceHash: `${id}-a` } });
  for (const id of ids.slice(0, reput)) s.put({ id, vector: vec(), model: 'm', meta: { text: `正文 ${id} v2`, sourceHash: `${id}-b` } });
  const st = { slots: s.index.slots, alive: s.count };
  return st;
}

function runTool(args) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    // 沙箱/工具链里可能注入了 fs 包装（bulk-delete shim），子进程不需要它
    env: { ...process.env, NODE_OPTIONS: '' }
  });
}

test('--compact 的统计对象是活代那个 bin，库根旧库原样不动', (t) => {
  const root = tmp(t);
  const lib = path.join(root, 'memory-vec');
  const gen = 'ab'.repeat(16);
  const genDir = path.join(lib, 'vector-generations', gen);
  fs.mkdirSync(genDir, { recursive: true });

  const st = seedStore(genDir, ['r0', 'r1', 'r2'], 1);   // 4 槽 / 3 活
  assert.deepEqual(st, { slots: 4, alive: 3 });

  fs.writeFileSync(path.join(lib, 'vector-active.json'),
    JSON.stringify({ version: 1, generation: gen, encoding: '{"test":1}' }));
  // 库根那份旧库：内容刻意与活代不同，用来证明"没被动过"
  const legacyBin = path.join(lib, 'vectors.bin');
  const legacyBytes = Buffer.alloc(4096, 7);
  fs.writeFileSync(legacyBin, legacyBytes);
  fs.writeFileSync(path.join(lib, 'meta.jsonl'), `${JSON.stringify({ slot: 0, id: 'legacy', state: 'alive', dim: DIM })}\n`);
  fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ version: 1, dim: DIM, slots: 1, alive: 1 }));

  const out = runTool([`--data-root=${root}`, '--compact']);

  assert.match(out, new RegExp(`压缩目标：代 ${gen}`), `输出必须点名压缩的是哪个代：\n${out}`);
  assert.match(out, /实际文件：vector-generations\/[a-f0-9]{32}\/vectors\.bin/,
    `输出必须给出真正被压缩的文件（不是库根那份）：\n${out}`);
  // 4 槽 × 64 维 × 4 字节 = 1024 → 3 槽 = 768
  assert.match(out, /1,024 → 768 字节/, `字节数必须来自活代：\n${out}`);
  assert.match(out, /槽位：4 → 3/);
  assert.match(out, /活条数：3 → 3/);

  // 真值：活代缩小、库根原样
  assert.equal(fs.statSync(path.join(genDir, 'vectors.bin')).size, 3 * DIM * 4);
  assert.deepEqual(fs.readFileSync(legacyBin), legacyBytes, '库根旧库是回退路径，压缩不能碰它');
  assert.ok(out.includes('库根还有一份旧库'), '应当提示"库根那份没动"，免得人以为压缩失败');
});

test('没有活代指针时压缩的是库根（旧扁平布局），输出要写明', (t) => {
  const root = tmp(t);
  const lib = path.join(root, 'memory-vec');
  fs.mkdirSync(lib, { recursive: true });
  const st = seedStore(lib, ['a', 'b'], 1);              // 3 槽 / 2 活
  assert.deepEqual(st, { slots: 3, alive: 2 });

  const out = runTool([`--data-root=${root}`, '--compact']);
  assert.match(out, /压缩目标：无指针 ⇒ 旧扁平布局（库根）/);
  assert.match(out, /实际文件：vectors\.bin/);
  assert.match(out, /槽位：3 → 2/);
  assert.equal(fs.statSync(path.join(lib, 'vectors.bin')).size, 2 * DIM * 4);
});
