// test/query-budget.mjs —— 主动查询的嵌入预算（`contracts` E）
//
// 这一层要钉三件事，全都是"看不出来"的：
//   · `/search`、`/recall` 的 auto 路必须是 **1500ms 总预算 + retries=0**。
//     改成"默认 30s + 重试 2 次"从功能上完全正常，只会在网络慢的时候让用户等 4 秒以上。
//   · 降级原因必须是**稳定码**（`budget-exhausted` / `network-error`），
//     而不是一句随时会被改写的自然语言 —— 运维上这是两件事（一个是慢，一个是挂）。
//   · 显式 `mode=vector` **不静默换模式**：给 502 + `EMBED_BUDGET_EXHAUSTED` / `EMBED_FAILED`。
//
// 反例证明方式：**量时间**。重试 2 次的退避是 400+800ms、单次超时 1500ms ⇒ 总耗时会到
// 4.5s 以上；只发一次的话 ≤1.6s 就该回来。所以阈值取 2600ms 能把两者分开。
//
// ⚠️ **一个进程只能有一个 runtime**（`backend.mjs` 的模块级单例，`dir` 与 `store` 都在里面）。
//    所以本文件**只建一个 router、一个桩端点**，用 `mode` 变量切换端点行为，
//    而不是"每个用例起一套环境"—— 后者会让第二个用例其实还在用第一个的 runtime。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRouter } from '../src/index.mjs';
import { getRuntime, disposeMemoryVec } from '../src/core/backend.mjs';

/** 受控桩端点：`mode` 决定"挂住不回"还是"立刻 500"。 */
const stub = { mode: 'hang' };
const sockets = new Set();
const srv = http.createServer((req, res) => {
  if (stub.mode === 'fail') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
    return;
  }
  // 'hang'：故意不结束响应，让客户端吃满预算
});
srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${srv.address().port}`;

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-budget-'));
const config = {
  autoIndexEnabled: false, consolidateEnabled: false, crossChatEnabled: false,
  embedBaseURL: baseURL, embedModel: 'stub-embed'
};
const router = createRouter({ dataRoot, settings: { getSkillConfig: (_, defaults) => ({ ...defaults, ...config }) } });
const rt = await getRuntime();
const deadline = Date.now() + 20_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

const call = (route, body) => router.handle({ path: route, method: body === undefined ? 'GET' : 'POST', body });

test.after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => srv.close(r));
  disposeMemoryVec();
  assert.ok(path.basename(dataRoot).startsWith('mv-budget-'));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('① 慢连接：auto 路耗尽 1500ms 预算就降级，且**只试一次**（总耗时 < 2.6s）', async () => {
  stub.mode = 'hang';
  const t0 = Date.now();
  const r = await call('/search', { q: '露营', mode: 'auto', chatKey: 'group:1' });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200, 'auto 不许 500');
  assert.equal(r.body.mode, 'exact', '必须降级到关键词路');
  assert.equal(r.body.degraded.code, 'budget-exhausted');
  assert.equal(r.body.degraded.budgetMs, 1500);
  assert.ok(elapsed < 2600, `单次预算 + 不重试才可能这么快，实测 ${elapsed}ms`);
  assert.ok(elapsed >= 1400, `预算要真的用满 1500ms 才降级，实测 ${elapsed}ms`);
});

test('② 慢连接 + 显式 vector：502 带稳定码，不静默换模式', async () => {
  stub.mode = 'hang';
  const r = await call('/search', { q: '露营', mode: 'vector', chatKey: 'group:1' });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'EMBED_BUDGET_EXHAUSTED');
  assert.equal(r.body.retryable, true);
  assert.equal(r.body.mode, 'vector');
});

test('③ 立刻失败：码是 network-error（不是 budget-exhausted），且没有退避重试', async () => {
  stub.mode = 'fail';
  const t0 = Date.now();
  const r = await call('/search', { q: '露营', mode: 'auto', chatKey: 'group:1' });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(r.body.degraded.code, 'network-error');
  // 重试 2 次的退避是 400+800ms ⇒ 只要 >1000ms 就说明重试还在，本条判据就失效了
  assert.ok(elapsed < 1000, `立即失败不许退避重试，实测 ${elapsed}ms`);
  const hard = await call('/search', { q: '露营', mode: 'vector', chatKey: 'group:1' });
  assert.equal(hard.status, 502);
  assert.equal(hard.body.code, 'EMBED_FAILED');
});

test('④ /recall 走同一份预算：慢连接时降级原因也是稳定码', async () => {
  stub.mode = 'hang';
  const t0 = Date.now();
  const r = await call('/recall?chatKey=group:1&q=' + encodeURIComponent('露营'));
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(r.body.recent.degraded.code, 'budget-exhausted');
  assert.ok(elapsed < 2600, `实测 ${elapsed}ms`);
});

test('⑤ /inject 的预算仍是 1800ms（不许被这次改动顺手拉成 1500）', async () => {
  stub.mode = 'hang';
  // 热路径只在"**有候选且有话题**"时才真的去嵌 —— 没候选时 `simNote=no-candidates`，
  // 4ms 就回来了，那样测的是"没走这条路"，而不是预算。
  rt.normalizer.setVocabulary([{ id: 'qq:10001111', kind: 'person', surface: ['Alpha'] }]);
  await call('/remember', { chatKey: 'group:1', userId: '10001111', kind: 'trait', attr: '职业', text: '工程师' });
  // ⚠️ trait 走**档案段**（不参与相似度重排）⇒ 光有 trait 时 `simNote=no-candidates`，
  //    根本没碰嵌入。要触发重排必须有**属性段**的候选（preference / event 这类）。
  await call('/remember', { chatKey: 'group:1', userId: '10001111', kind: 'preference', text: '喜欢拿铁' });
  const t0 = Date.now();
  const r = await call('/inject', { chatKey: 'group:1', topic: '露营', people: [{ id: '10001111' }], dry: true });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200, '/inject 不许 500');
  assert.notEqual(r.body.simNote, 'no-candidates', '必须真的走到了嵌入那一段，否则测的不是预算');
  assert.ok(elapsed >= 1700, `热路径预算 1800ms，实测 ${elapsed}ms`);
  assert.ok(elapsed < 3000, `不许重试把热路径拖长，实测 ${elapsed}ms`);
});
