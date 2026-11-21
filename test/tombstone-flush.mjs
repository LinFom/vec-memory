// 同 id 重嵌时，盘上的旧行必须最终落成墓碑。
//
// ⚠️ 病因与后果都要说准（2026-10-29 实测纠正过一次）：
//   · `_put` 更新时只把 `metas[slot]` 置 null（为崩溃安全，新行 append 成功前不许动盘），
//     而 `_rewriteMeta` 只被 `del()` 调 ⇒ "更新"永远不往盘上写墓碑。
//   · **检索不会因此重复** —— `_load()` 有一步隐式去重（"同 id 后者覆盖前者"，见 :235）。
//     旧库实测：slots=5553 / alive=1425 / 可检索 1425 / Top20 无重复 id。
//   · 真正的代价是**槽位膨胀**：每次更新都 append 一个永久占位的新槽（bin 里占 dim×4 字节），
//     而回收只能靠 `compact()`。旧库主号 5553 槽只服务 1425 条，4 倍膨胀。
// 所以 flush 是"把盘上状态写对"，压缩才是"把空间要回来" —— 两件事，别混。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VecStore } from '../src/core/vecstore.mjs';

const V = [1, 0.5, 0.25, 1];
const rec = (id, hash) => ({ id, vector: V, model: 'm', meta: { text: `文本 ${hash}`, sourceHash: hash } });

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-tomb-'));
  t.after(() => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'vmm-tomb-'))); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const rows = (dir) => fs.readFileSync(path.join(dir, 'meta.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const binSlots = (dir, dim) => fs.statSync(path.join(dir, 'vectors.bin')).size / (dim * 4);

test('同 id 重嵌：盘上旧行最终落成墓碑，检索不出现重复 id', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir, { model: 'm' });
  s.put(rec('hour_1', 'h1'));
  s.put(rec('hour_1', 'h2'));                    // 同一块重嵌（这次的日常：哈希漂移后重嵌 2240 条）

  assert.equal(s.metas.filter(Boolean).length, 1, '内存读模型里只有一个 id');
  assert.equal(rows(dir).filter((m) => m.state === 'alive').length, 2,
    'append 阶段：新行已落、旧行**必须**还在（新行没落稳就改旧行，崩了两边都没了）');

  // 不 flush 直接重开 = 断电现场。`_load` 的隐式去重让它**不重复**，但槽位白占着。
  const crashed = new VecStore(dir, { model: 'm' });
  assert.equal(crashed.metas.filter(Boolean).length, 1, '_load 会把同 id 的旧槽置 null ⇒ 检索不重复');
  assert.equal(crashed.index.alive, 1);
  assert.equal(crashed.index.slots, 2, '但槽位已经是 2 —— 旧槽永久占着 bin 的位置');

  s.flushTombstones();
  assert.equal(rows(dir).filter((m) => m.state === 'alive').length, 1, 'flush 之后盘上只有一行 alive');
  assert.equal(rows(dir).filter((m) => m.state === 'deleted').length, 1,
    '旧行变成墓碑行，并且**保留原位**（行号=slot，删中间一行会错位）');

  const reopened = new VecStore(dir, { model: 'm' });
  assert.equal(reopened.get('hour_1').meta.sourceHash, 'h2', '活着的是新版本');
  const ids = reopened.search({ vector: V, k: 10 }).hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, `Top-K 无重复 id —— 实得 ${ids.join(',')}`);

  // 空间回收是另一件事：要显式 compact
  assert.equal(binSlots(dir, 4), 2, '压缩前：bin 里 2 个槽');
  reopened.compact();
  assert.equal(binSlots(dir, 4), 1, 'compact 之后 bin 只剩 1 个槽（这才是"把空间要回来"）');
  assert.equal(rows(dir).length, 1, 'meta 行数也回到 1');
});

test('没人调 flush 也不会让 pending 无上限增长（阈值兜底）', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir, { model: 'm' });
  s.put(rec('hour_x', 'v0'));
  for (let i = 1; i <= 300; i++) s.put(rec('hour_x', `v${i}`));
  assert.ok(s.pendingTombstones.size < 300, `pending 应该被阈值自动清掉一部分，实得 ${s.pendingTombstones.size}`);

  s.flushTombstones();
  const reopened = new VecStore(dir, { model: 'm' });
  assert.equal(reopened.metas.filter(Boolean).length, 1, '300 次重嵌之后仍然只有一个 id 活着');
  assert.equal(reopened.get('hour_x').meta.sourceHash, 'v300', '留下的是最后一次写入的版本');
});

test('compact 会把 pending 里的旧槽号作废（槽号重排后那些号已经指向别人）', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir, { model: 'm' });
  s.put(rec('a', 'a1'));
  s.put(rec('a', 'a2'));            // pending 里现在有 slot 0
  s.put(rec('b', 'b1'));
  assert.equal(s.pendingTombstones.size, 1);
  s.compact();
  assert.equal(s.pendingTombstones.size, 0, 'compact 之后不能再拿旧槽号去写墓碑');
  assert.equal(rows(dir).length, 2, '压缩后只剩两条活记录（墓碑槽被丢掉）');
  assert.equal(new VecStore(dir, { model: 'm' }).index.alive, 2);
});

// ── 主审 P2（2026-10-29 · [by:DS]）：flush 失败不能丢待处理状态 ──────────────
// 病因：`_rewriteMeta` 在 `atomicWrite` **之前** clear pending。rename 一失败
// （占用/权限/磁盘满），待处理记账就地蒸发 ⇒ 之后既不重试也不会被下一批带走，
// 盘上那行永远停在 `alive`。主审用临时库注入 rename 失败复现过。
//
// ⚠️ 这里注入的是**只针对目标 `meta.jsonl`** 的 rename 失败：`atomicWrite` 同时被
// index / journal / bin 用到，全局失败会把"墓碑写不成"和"整笔写不成"混成一件事，
// 那就测不出这条 bug 的边界了。
function injectMetaRenameFailure() {
  const real = fs.renameSync;
  const state = { hits: 0 };
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('meta.jsonl')) {
      state.hits++;
      const err = new Error('EPERM: rename denied (injected)');
      err.code = 'EPERM';
      throw err;
    }
    return real(from, to);
  };
  return { state, restore: () => { fs.renameSync = real; } };
}

test('墓碑落盘 rename 失败：pending 必须留住，恢复后重试能补齐', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir, { model: 'm' });
  s.put(rec('k', 'h1'));
  s.put(rec('k', 'h2'));                       // append 完成，旧槽进 pending
  assert.equal(s.pendingTombstones.size, 1);
  // 此刻：向量已提交（bin 2 槽 / meta 2 行 alive / index 2 槽），只缺"把旧行改成 deleted"

  const inject = injectMetaRenameFailure();
  t.after(inject.restore);
  assert.throws(() => s.flushTombstones(), /rename denied/, '失败必须抛给调用方');
  assert.equal(inject.state.hits, 1, '确实是那一次 rename 失败');
  assert.equal(s.pendingTombstones.size, 1, '⭐ 失败后待处理不能消失 —— 否则永远补不上');
  assert.ok(s.lastTombstoneError, '失败原因要留下（可观测）');
  assert.equal(rows(dir).filter((m) => m.state === 'alive').length, 2,
    '盘上仍是两行 alive：向量已提交，只是墓碑没落下 —— 这两件事不能混为一谈');

  // 失败期间再调一次：仍应尝试（而不是"看到空集合就返回 0"）
  assert.throws(() => s.flushTombstones(), /rename denied/);
  assert.equal(s.pendingTombstones.size, 1);

  inject.restore();
  assert.equal(s.flushTombstones(), 1, '恢复后重试成功，返回落掉的条数');
  assert.equal(s.lastTombstoneError, null, '成功后告警要擦掉，不能留假警报');
  assert.equal(rows(dir).filter((m) => m.state === 'alive').length, 1);
  assert.equal(rows(dir).filter((m) => m.state === 'deleted').length, 1);

  const reopened = new VecStore(dir, { model: 'm' });
  assert.equal(reopened.index.alive, 1);
  assert.equal(reopened.get('k').meta.sourceHash, 'h2', '重开读到的是最新向量');
  assert.equal(reopened.search({ vector: V, k: 10 }).hits.length, 1, '检索只有一条');
});

test('阈值触发的 flush 失败不能把 put 判成"整笔没写进去"', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir, { model: 'm' });
  s.put(rec('x', 'v0'));

  const inject = injectMetaRenameFailure();
  t.after(inject.restore);
  // 第 256 次更新会撞上 TOMBSTONE_FLUSH_EVERY 的阈值分支。旧实现在这里把异常
  // 逃出 `put()` ⇒ 调用方 `_recoverPut()` 回滚 + 报错，而这一次嵌入的额度已经花掉。
  assert.doesNotThrow(() => {
    for (let i = 1; i <= 260; i++) s.put(rec('x', `v${i}`));
  }, '阈值分支的墓碑失败必须吞掉：向量已提交，重试要再花一次钱');
  assert.ok(s.pendingTombstones.size >= 256, `pending 继续攒着，实得 ${s.pendingTombstones.size}`);
  assert.ok(inject.state.hits >= 1, '确实撞到过阈值分支并失败');
  assert.equal(s.get('x').meta.sourceHash, 'v260', '内存里是最新版本');
  assert.equal(s.count, 1, '内存里只有一个 id');

  inject.restore();
  s.flushTombstones();
  const reopened = new VecStore(dir, { model: 'm' });
  assert.equal(reopened.index.alive, 1);
  assert.equal(rows(dir).filter((m) => m.state === 'alive').length, 1, '盘上只剩一行 alive');
  assert.equal(reopened.get('x').meta.sourceHash, 'v260', '留下的仍是最后一次写入的版本');
});
