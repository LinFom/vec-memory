// test/preview-purity.mjs —— 票 03：预演和启动诊断不改变记忆 · [by:DS] 2026-10-28
//
// ── 为什么要单独一个文件 ─────────────────────────────────────────────────────
// "预演"是全库唯一一个**故意把真实管线跑一半**的功能：它调模型、读账本、渲染候选，
// 与正式路径逐行相同，唯一差别是"不落盘"。这种"只差一行写入"的结构，**读代码判断
// 不可靠** —— 差的那一行可能藏在另一条分支里（评审 F03 就是这么漏的：成功分支有不落盘
// 保护，失败分支却照写失败计数并推进 lastTs）。所以这里一律用**前后快照比对**来钉。
//
// ── 两条纪律 ─────────────────────────────────────────────────────────────────
//   · 临时 dataRoot（`os.tmpdir()`）⇒ 一个字节都不碰真库。
//   · 不传 `people` / `topic` ⇒ 走不到嵌入那段 ⇒ 不碰网络。
//
// ── 与既有测试的分工（别重复造）──────────────────────────────────────────────
//   `test/commit-integrity.mjs`「dry-run failures never advance or persist retry state」
//   已钉住 F03 的**游标 + 失败计数**（`state.chats` 同时承载两者）。那份是 [by:GPT6A]
//   2026-10-28 07:58 那批写的，本文件不重复它，只补它**没覆盖**的两件事：
//   ① `dryRun` 成功路径的**文件级**零副作用（评审 F03 只测了失败分支）；
//   ② 注入预览（评审 F11 前半）：候选与正式一致，但排练不增加。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';
import { runConsolidate, consolidatePaths, loadConsolidateState } from '../src/core/consolidate.mjs';

const NOW = 1800000000000;

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vmm-preview-${tag}-`));
}

// ── ① 注入预览：候选与正式一致，排练不增加（评审 F11 前半）──────────────────
//
// 评审原文：「临时事件执行 /inject {dry:true} 后 rehearsed=1、hits.jsonl 已创建」。
// 判据不是"代码里有没有 `!body.dry`"，而是**跑完看 hits.jsonl 在不在**。
test('① 注入预览不产生排练；正式注入仍计排练（原行为保留）', async (t) => {
  const dataRoot = tmpRoot('inject');
  fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });
  const router = createRouter({ dataRoot });
  const rt = await getRuntime();
  t.after(() => {
    assert.ok(dataRoot.startsWith(path.join(os.tmpdir(), 'vmm-preview-')));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  // 先等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（同 `test/remember.mjs`
  // 与 `test/inject-endpoint.mjs`）——避免它的异步写与断言交错。
  const deadline = Date.now() + 20_000;
  while (!rt.lastIdentityCheck && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const p = consolidatePaths(rt.dir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.events, [
    { id: 'ev1', chatKey: 'group:1', title: '露营', summary: '周末一起去露营', toTs: NOW - 3600e3, createdAt: new Date(NOW - 3600e3).toISOString(), hits: 0 },
    { id: 'ev2', chatKey: 'group:1', title: '烧烤', summary: '露营的时候烧烤', toTs: NOW - 7200e3, createdAt: new Date(NOW - 7200e3).toISOString(), hits: 0 }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const inject = (body) => router.handle({ method: 'POST', path: '/inject', body });

  const a = await inject({ dry: true, chatKey: 'group:1' });
  assert.equal(a.status, 200, '热路径不允许抛 500');
  assert.equal(a.body.events?.applied, true, '预览必须能看到事件段，否则这条测试什么都没测到');
  assert.ok((a.body.events?.count || 0) >= 2, `两条事件都该进候选，实际 ${a.body.events?.count}`);
  assert.equal(a.body.events.rehearsed, 0, '★ 预演：rehearsed 必须是 0');
  assert.equal(a.body.rehearsalMode, 'dry');
  assert.ok(!fs.existsSync(p.hits), '★ 预演不该创建 hits.jsonl（评审 F11 的原始症状）');

  // 连做两次：预演必须**无状态** —— 第二次的候选与第一次逐字相同
  const b = await inject({ dry: true, chatKey: 'group:1' });
  assert.equal(b.body.block, a.body.block, '★ 两次预览的注入块必须完全一致（预演不可累积状态）');
  assert.equal(b.body.events.rehearsed, 0);

  // 正式路径：原有行为必须保留（否则"修预演"会顺手废掉排练计数）
  const c = await inject({ chatKey: 'group:1' });
  assert.ok(c.body.events.rehearsed > 0, '★ 正式注入仍要计排练');
  assert.ok(fs.existsSync(p.hits), '正式注入后 hits.jsonl 必须存在');
  assert.equal(c.body.block, a.body.block, '★ 正式与预览的**内容**必须一致（只差副作用）');
});

// ── ② 整理预演：成功路径的文件级零副作用 ──────────────────────────────────
//
// `commit-integrity.mjs` 已钉住失败三次后的 `state.chats === {}`。这里补的是
// **成功解析**那一路：`parsed.ok` 之后必须直接 continue，绝不能摸到
// `applyWindow` / `advanceCursor` / `savePending` 任何一个。
test('② 整理预演成功路径不落盘：facts 写入器一次都不该被调用', async (t) => {
  const root = tmpRoot('consolidate');
  const libDir = path.join(root, 'lib');
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'memory/evidence.jsonl'),
    [NOW - 20 * 60e3, NOW - 19 * 60e3]
      .map((at, i) => JSON.stringify({ id: `e${i}`, at, chatKey: 'group:1', speakerId: '111111', text: '周末一起露营' }))
      .join('\n') + '\n'
  );
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'vmm-preview-')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  let factWrites = 0;
  const deps = {
    sourceRoot, libDir,
    settings: { layerMaintenance: false },
    normalizer: { normalize: (text) => ({ text }), scopeLabel: () => 'group:C1' },
    factStore: { put() { factWrites++; throw new Error('预演不该写事实'); } },
    store: null,
    // 正常返回**可解析**的结果：这样才走到 parsed.ok 之后那条分支
    callLlm: async () => JSON.stringify({ events: [{ title: '露营', detail: '', who: [] }], people: [] })
  };

  const r = await runConsolidate(deps, { now: NOW, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.processed, 1, '预演要真的跑完（否则测不到"跑完但不落盘"）');
  assert.equal(r.events, 0, '预演的 result.events 不该累加（那些事没被记住）');
  assert.equal(factWrites, 0, '★ 预演不得调用 factStore.put');

  const p = consolidatePaths(libDir);
  assert.deepEqual(loadConsolidateState({ libDir }).chats, {}, '★ 游标与失败计数都不该被写');
  const files = fs.existsSync(p.base) ? fs.readdirSync(p.base) : [];
  assert.deepEqual(files, [],
    `★ 预演不得产生任何落盘文件（state/events/hits/pending 全都不该出现），实际：${files.join(',') || '(空)'}`);
});
