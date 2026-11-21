// test/inject-endpoint.mjs —— 读侧端点 `/inject`：**参数收敛层**。
//
// ── 与 `test/inject.mjs` 的分工 ───────────────────────────────────────────────
// 那个测**纯函数**（候选挑选 / 渲染 / 阈值比较）；这个测**路由怎么把「请求参数 +
// 落盘设置」收敛成实参**。两者不可互替。
//
// ── 为什么非要有这一层（本文件的存在理由）────────────────────────────────────
// `minScore` 曾**恒为 `NaN`**（`ROADMAP` 4.3 / `ADR-0028`）：`router.mjs` 写作
//   `Number(body.minScore) ?? Number(s.injectThreshold) ?? 0.85`
// 而 `Number(undefined)` 是 **`NaN`**、`NaN ?? x` **不回退**（`??` 只挡 null/undefined）
// ⇒ `sim >= NaN` 恒 false ⇒ `hot` 恒 false ⇒「话题相关性加成」永久失效。
// **纯函数层永远测不出这个 bug** —— `selectInjectLines` 的默认参数是好的，
// 坏在调用方传进来的实参。修在 `core/inject.mjs` 的 `resolveMinScore()`。
//
// ── 两条纪律 ─────────────────────────────────────────────────────────────────
//   · 用**临时 dataRoot**（`os.tmpdir()`）⇒ 一个字节都不碰真库。
//   · **不碰网络**：不传 `people`、不传 `topic` ⇒ 走不到嵌入那段（`sims` 保持 null）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';
import { DEFAULT_MIN_SCORE } from '../src/core/inject.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-inject-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 先等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（同 `test/remember.mjs`）：
// 它会扫 sourceRoot 重建词表。临时根下它扫不到东西、跑得极快，等它是为了**避免异步写
// 与断言交错**。判据 `lastIdentityCheck` 在"装载"与"跳过"两条分支上都会写。
const deadline = Date.now() + 20_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const inject = (body) => router.handle({ method: 'POST', path: '/inject', body });
const show = (v) => JSON.stringify(v);

test('/inject：阈值必须收敛成有限数（NaN 回归）+ 三级优先级 + 0=未设', async () => {
  const base = await inject({ dry: true, chatKey: 'group:1' });
  assert.equal(base.status, 200);
  assert.equal(base.body.ok, true);
  assert.ok(
    Number.isFinite(base.body.minScore),
    `minScore 必须是有限数（修复前是 NaN、JSON 化后为 null），实际 ${show(base.body.minScore)}`
  );
  assert.equal(base.body.minScore, DEFAULT_MIN_SCORE, '无请求参数、无落盘设置 ⇒ 回落代码默认');

  const override = await inject({ dry: true, chatKey: 'group:1', minScore: 0.9 });
  assert.equal(override.body.minScore, 0.9, '请求参数优先于落盘设置/默认');

  // 面板 `collect()`（settings-ui.js:731-734）把**空输入**写成 0，且每次保存都遍历全部字段
  const zero = await inject({ dry: true, chatKey: 'group:1', minScore: 0 });
  assert.equal(
    zero.body.minScore, DEFAULT_MIN_SCORE,
    '0 = 未设（面板空值口径）⇒ 回落默认；否则一次保存就把阈值静默改成 0'
  );

  const clampHigh = await inject({ dry: true, chatKey: 'group:1', minScore: 5 });
  assert.equal(clampHigh.body.minScore, 1, '上界收敛到 1');
  const clampLow = await inject({ dry: true, chatKey: 'group:1', minScore: -3 });
  assert.equal(clampLow.body.minScore, DEFAULT_MIN_SCORE, '负数 = 未设 ⇒ 回落默认');

  const junk = await inject({ dry: true, chatKey: 'group:1', minScore: 'abc' });
  assert.equal(junk.body.minScore, DEFAULT_MIN_SCORE, '非数值 = 未设 ⇒ 回落默认');
});

test('/inject：空库 + 无候选 ⇒ 空结果 + ok:true（绝不 500），且 hard 降级 boost', async () => {
  const r = await inject({ dry: true, chatKey: 'group:1', mode: 'hard', topic: '画图' });
  assert.equal(r.status, 200, '热路径不允许抛 500');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.injected, false, '空库 ⇒ 不注入');
  assert.deepEqual(r.body.lines, []);
  // ⚠️ 这里以前断言 `'embed-unavailable'` —— 那是**错误归因**：真原因是"没有候选"，
  //    不是"端点坏了"。号A 实测按旧值去查端点，查到的是"端点 200 正常、带 topic 就 ok"。
  assert.equal(r.body.simNote, 'no-candidates', '没有候选 ⇒ 压根没走嵌入（与"端点不可用"区分开）');
  assert.equal(r.body.mode, 'boost', '没有相似度信息（sims=null）时 hard 必须降级 boost');
});
