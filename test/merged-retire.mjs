// test/merged-retire.mjs —— 软删旁路（`ADR-0034`）+ `rebuildRequired` 出口（`ADR-0033` 的姊妹项）。
//
// ── 为什么单独一个文件 ────────────────────────────────────────────────────────
// 这一层有两件事，都是**"信息在、但没有出口"**型的问题，纯函数层测不到：
//
//   ① `rebuildRequired` 早就由 `factstore.recount()` 算出来了（"代码已 v7，库还是 v4/v6"），
//      但 `/status` 的 `facts` 块是**读盘组装**的（只挑 `index.json` 的 `by_kind`）⇒
//      运行期那个结论**经不到面板**。库自己知道，人看不见。这与 `shadowMode` 同病。
//   ② 软删旁路 `facts/merged.json`：重判会产出**新 key**（`target` 进身份键），老槽不会消失
//      ⇒ 不先退役 ⇒ `/inject` 里同一件事出两遍。旁路必须是**只读侧过滤**（`slots.jsonl` 一行不改、
//      回滚 = 删一条记载），且**它的失败形态全是静默的**：
//        · 标了个**不存在**的 key ⇒ "标了却没用"，没有任何别的症状；
//        · `merged.json` 读不动 ⇒ 本想"不滤"，看起来就像"从没合并过"；
//        · `applied` 若写成累加计数器 ⇒ 面板数字会漂移，而它看起来完全正常。
//      这三条都只能靠**端点/装配级**的断言逼出来。
//
// ── 纪律（同 `test/person.mjs` / `test/exact-search.mjs`）──────────────────────
//   · **临时 dataRoot**（`os.tmpdir()`）⇒ 一个字节都不碰真库。
//     ⚠️ 这条不是形式主义：`createRouter` **只注入 `DATA_DIR`、不注入 `SOURCE_DIR`**
//     （`src/transport/inproc.mjs`）⇒ 源根会落成同一个临时目录。真库那边 `ensureIdentity`
//     会按**空档案**重建词表并**写回**（实测 `entities` 958 → 1，`ADR-0033 §8`）。
//   · 不碰网络（全程不配嵌入端点）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf } from '../src/core/backend.mjs';
import { PRAGMATIC_VERSION } from '../src/core/edges.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-merged-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（详见 `test/trait.mjs`）。
const deadline = Date.now() + 30_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const UID = '1006837691';
const UID2 = '1006837692';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['丁丁'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['戊戊'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);

const GROUP = 'group:1098345913';
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
const LABEL2 = rt.normalizer.resolveKnown(`qq:${UID2}`)?.label || '';
assert.ok(LABEL && LABEL2, '测试前提：两个人都能在词表里认出来');

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });

const store = factStoreOf(rt);
// ⚠️ `factStoreOf(rt)` 建实例时**不注入 normalizer**（生产端一直显式给 `scope`，不是给 `chatKey`）
//    ⇒ 直接 `put({chatKey})` 会抛 `NO_SCOPE_LABEL`。这里跟着走 `scope`。
const SCOPE = rt.normalizer.scopeLabel(GROUP);

/**
 * 造一条**旧口径**的活动槽（`logic_version: '4'`）。每条用**不同的 kind** ⇒ 键必然不同
 * （键 = speaker+target+kind+scope，同 kind 会撞成一个槽）。
 *
 * 为什么要现造而不是一次造好：下面测试 ③ 的"自动解除"会把槽**升级**成当前口径
 * （新证据按 v7 写）⇒ 陈旧槽就此消失。那正是应然行为，所以后续用例按需再造。
 */
function addStale(kind, text) {
  const r = store.put({
    speaker: LABEL, fact_kind: kind, scope: SCOPE,
    content: { text }, evidenceIds: [`legacy-${kind}`], logicVersion: '4'
  });
  return r.key;
}

// ── 建槽：三条走**真实端点**（口径 = 当前 `PRAGMATIC_VERSION`）+ 一条旧口径 ──
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '喜欢雨天' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'event', text: '上周去爬山' });
await post('/remember', { chatKey: GROUP, userId: UID2, kind: 'grudge', text: '讨厌排队' });
const LEGACY_KEY = addStale('pattern', '旧口径留下的槽');
assert.equal(store.count, 4, '前提：四条活动槽');
assert.equal(store.get(LEGACY_KEY).logic_version, '4');

// ═══════════════════════════════════════════════════════════════════════════
// ① `rebuildRequired` 必须有出口（修复前：算出来了，但 /status 读盘组装 ⇒ 看不见）
// ═══════════════════════════════════════════════════════════════════════════

test('/status：透出 rebuildRequired（"库知道、人看不见"的那个缺口）', async () => {
  const r = await get('/status');
  assert.equal(r.status, 200);
  const rb = r.body.facts?.rebuildRequired;
  assert.ok(rb, '有 v4 的活动槽 ⇒ 必须报出"需要重建"');
  assert.equal(rb.current, String(PRAGMATIC_VERSION), '当前口径 = 代码里的常量');
  assert.equal(rb.stale['4'], 1, '陈旧分布要具体到版本号 × 条数（面板要能照抄）');
  // `/status` 的 `facts` 同时要给出旁路字段（否则面板拿不到）
  assert.equal(r.body.facts.merged.count, 0, '还没合并过');
  assert.equal(r.body.facts.merged.error, null);
});

test('/selfcheck：口径与旁路都落进自检（否则"看不见"只是换了个地方藏）', async () => {
  const r = await post('/selfcheck', {});
  assert.equal(r.status, 200);
  const byId = new Map(r.body.checks.map((c) => [c.id, c]));
  const cal = byId.get('fact-caliber');
  assert.ok(cal, '要有 fact-caliber 这一条');
  // `pass: null` = "等你拍板"，不是故障 —— 标红会把真故障淹掉
  assert.equal(cal.pass, null, '待重判是"待决策"状态，不是失败');
  assert.match(cal.detail, /v4/, '详情里要出现具体的陈旧版本');
  const mg = byId.get('fact-merged');
  assert.ok(mg, '要有 fact-merged 这一条');
  assert.equal(mg.pass, true, '旁路可读 ⇒ 通过');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 软删旁路：标记 / 过滤 / 回滚
// ═══════════════════════════════════════════════════════════════════════════

test('旁路标记：从活动视图摘掉，但 versions 全留（可审计、可回滚）', () => {
  const before = store.count;
  const r = store.markMerged([LEGACY_KEY], { into: null, by: 'test' });
  assert.deepEqual(r.marked, [LEGACY_KEY]);
  assert.deepEqual(r.missing, [], 'key 存在 ⇒ 不该报 missing');
  assert.equal(r.count, 1, '记载 1 条');
  assert.equal(store.count, before - 1, '活动槽少一个');
  assert.equal(store.slots.has(LEGACY_KEY), false);
  assert.ok(store.versions.has(LEGACY_KEY), 'versions **必须**保留 —— 回滚的唯一依据');
  assert.equal(store.mergedEntries()[0].into, null, '退役标记 = into:null（spec §七.5）');
  assert.equal(store.mergedStats().applied, 1, 'applied = **现算**的 merged ∩ versions');

  // 落盘了（重启后仍生效）
  const onDisk = JSON.parse(fs.readFileSync(store.mergedFile, 'utf8'));
  assert.ok(onDisk[LEGACY_KEY], 'merged.json 里要有这条');
  assert.equal(onDisk[LEGACY_KEY].into, null);
});

test('旁路是**只读侧过滤**：open() 重放后依然滤掉（不是内存里的一次性效果）', () => {
  const before = store.count;
  store.open();                       // 模拟重启：全部从盘上重放
  assert.equal(store.slots.has(LEGACY_KEY), false, '重放后仍被滤掉');
  assert.equal(store.count, before, '总数不变');
  assert.equal(store.mergedStats().applied, 1);
});

test('旁路回滚：删掉记载，槽立刻回来（不用碰真值）', () => {
  const before = store.count;
  const r = store.clearMerged([LEGACY_KEY]);
  assert.deepEqual(r.cleared, [LEGACY_KEY]);
  assert.deepEqual(r.missing, []);
  assert.ok(store.slots.has(LEGACY_KEY), '槽回来了');
  assert.equal(store.count, before + 1);
  assert.equal(store.merged.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(store.mergedFile, 'utf8'))[LEGACY_KEY], undefined, '盘上也清了');

  // 再 clear 一次 ⇒ 报 missing（已无记载），**不静默**
  const again = store.clearMerged([LEGACY_KEY]);
  assert.deepEqual(again.cleared, []);
  assert.deepEqual(again.missing, [LEGACY_KEY]);
});

test('⚠️ 标记一个不存在的 key ⇒ 必须点名 missing（否则"标了却没用"毫无症状）', () => {
  const bogus = 'P0000\u0000\u0000\u0000\u0000不存在';
  const r = store.markMerged([bogus], { into: null, by: 'test' });
  assert.deepEqual(r.marked, [], '不存在的 key 不能进记载');
  assert.deepEqual(r.missing, [bogus], '要点名报出来');
  assert.equal(store.merged.has(bogus), false);
  assert.equal(JSON.parse(fs.readFileSync(store.mergedFile, 'utf8'))[bogus], undefined);
});

test('⚠️ `into` 指向不存在的槽 ⇒ 记 missingInto（标了但查不到去向，不能装作没事）', () => {
  const r = store.markMerged([LEGACY_KEY], { into: 'P1111\u0000\u0000\u0000\u0000无此槽', by: 'test' });
  assert.equal(r.marked.length, 1, '退役效果仍然成立（into 只是去向信息）');
  assert.ok(r.missingInto, '去向查不到 ⇒ 必须报出来');
  store.clearMerged([LEGACY_KEY]);
});

test('⚠️ `applied` ≠ `count`：记载了但库里没有那个 key（手改过 merged.json / key 已被清库）', () => {
  const before = store.count;
  // 手写一条形状合法、但指向不存在 key 的记载 —— `markMerged` 会拦这种输入，
  // 但**手改文件**绕得过去（旁路本来就是"可手改、可回滚"的）。
  fs.writeFileSync(store.mergedFile, JSON.stringify({
    'P9999\u0000\u0000\u0000\u0000幽灵槽': { into: null, at: '2026-01-01T00:00:00.000Z', by: 'hand' }
  }, null, 2), 'utf8');
  store.open();
  assert.equal(store.mergedReadError, null, '形状合法 ⇒ 不算读错');
  assert.equal(store.mergedStats().count, 1, '记载 1 条');
  // 这一条断言就是防"`applied` 写成累加计数器 / 直接用 merged.size"：
  // 那种写法的数字会漂移，而它看起来**完全正常**。
  assert.equal(store.mergedStats().applied, 0, '但它没指向库里的槽 ⇒ 一个也没滤掉');
  assert.equal(store.count, before, '活动槽数不变');

  fs.rmSync(store.mergedFile);
  store.open();
  assert.equal(store.mergedStats().count, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 自动解除：被合并的槽又拿到新证据 ⇒ 标记作废（否则新证据永远进不了注入）
// ═══════════════════════════════════════════════════════════════════════════
test('自动解除：put() 到被退役的槽 ⇒ 标记作废，且 rev **接得上**（不从 1 重来）', () => {
  const rec = store.versions.get(LEGACY_KEY).at(-1);
  const origRev = Number(rec.rev) || 1;
  store.markMerged([LEGACY_KEY], { into: null, by: 'test' });
  assert.equal(store.slots.has(LEGACY_KEY), false, '前提：已退役');

  const res = store.put({
    speaker: rec.speaker, target: rec.target, fact_kind: rec.fact_kind, scope: rec.scope,
    content: { text: '新证据回来了' }, evidenceIds: ['e-new']
  });
  assert.equal(res.action, 'update', '内容变了 ⇒ update，不是 noop');
  assert.equal(res.rev, origRev + 1,
    'rev = 旧 rev + 1 ⇒ 说明**先恢复了历史赢家**再比。若直接 put，prev 是 null ⇒ rev 从 1 重来（历史倒流）');
  assert.ok(store.slots.has(LEGACY_KEY), '槽回到活动视图');
  assert.equal(store.merged.has(LEGACY_KEY), false, '标记已解除');
  assert.equal(store.mergedAutoReleased, 1);
  // 盘上也解除了（重启后不该"复活"这条退役标记）
  assert.equal(JSON.parse(fs.readFileSync(store.mergedFile, 'utf8'))[LEGACY_KEY], undefined);
  // 顺带的**行为可见化**：槽被升级成当前口径 ⇒ 它不再是陈旧槽
  assert.equal(store.get(LEGACY_KEY).logic_version, String(PRAGMATIC_VERSION));
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 旁路读不动 ⇒ **fail-open + 喊出来**（真值没坏，只是"不知道滤哪些"）
// ═══════════════════════════════════════════════════════════════════════════

test('⚠️ merged.json 坏掉 ⇒ 不拦服务、不静默：退化成"不滤"，并把错误暴露到 stats/status/selfcheck', async () => {
  const K2 = addStale('topic', '另一条旧口径');
  store.markMerged([K2], { into: null, by: 'test' });
  const filtered = store.count;        // 已滤掉 K2
  fs.writeFileSync(store.mergedFile, '{ 这不是 JSON', 'utf8');

  store.open();
  assert.ok(store.mergedReadError, '必须记下错误（否则"合并了却还在"会变成一句无解释的抱怨）');
  assert.equal(store.merged.size, 0, '读不动 ⇒ 本次不滤任何槽');
  assert.equal(store.count, filtered + 1, '槽**全部可见**（比该看到的多，不是"看到错的"）');
  assert.equal(store.readOnlyReason, null, '⚠️ **不**进只读：旁路不是真值 ⇒ 不该让服务停摆');

  const st = await get('/status');
  assert.equal(st.body.facts.merged.error, store.mergedReadError, '/status 要透出这个错');
  const sc = await post('/selfcheck', {});
  const mg = new Map(sc.body.checks.map((c) => [c.id, c])).get('fact-merged');
  assert.equal(mg.pass, false, '自检要把旁路不可读判成失败');
  assert.match(mg.detail, /merged\.json/);

  // 恢复
  fs.rmSync(store.mergedFile);
  store.open();
  assert.equal(store.mergedReadError, null, '删掉坏文件 ⇒ 恢复正常');
  assert.equal(store.count, filtered + 1, '没有记载 ⇒ 不滤');
  assert.equal(store.slots.has(K2), true, 'K2 重新可见（标记丢了，这正是 fail-open 的代价，已被上面喊出来）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 端点：/facts/merged 的读与写，含 retire-stale 的显式确认
// ═══════════════════════════════════════════════════════════════════════════

test('GET /facts/merged：列出记载 + 口径陈旧的活动槽计数', async () => {
  // ⚠️ 不在这里再造陈旧槽：上一节的 fail-open 已经把 K2 放回活动视图（它仍是 v4）⇒
  //    此刻恰好有 1 条陈旧活动槽。多造一条会把这个断言变成"数我自己的测试脚手架"。
  const r = await get('/facts/merged');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.count, 'number');
  assert.equal(typeof r.body.applied, 'number');
  assert.equal(typeof r.body.autoReleased, 'number');
  assert.equal(r.body.error, null);
  assert.ok(Array.isArray(r.body.entries));
  assert.equal(r.body.stale.current, String(PRAGMATIC_VERSION));
  assert.equal(r.body.stale.count, 1, '刚才那条 v4 的活动槽要被数出来');
});

test('POST /facts/merged：mark / clear 往返', async () => {
  const key = store.staleKeys().keys[0];
  assert.ok(key, '前提：有一条口径陈旧的活动槽');
  const m = await post('/facts/merged', { action: 'mark', keys: [key], into: null, by: 'test-api' });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.marked, [key]);
  assert.equal(store.slots.has(key), false);

  const c = await post('/facts/merged', { action: 'clear', keys: [key] });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.cleared, [key]);
  assert.ok(store.slots.has(key));

  // 参数缺失 / 未知动作 ⇒ 400（不猜）
  assert.equal((await post('/facts/merged', { action: 'mark' })).status, 400);
  const bad2 = await post('/facts/merged', { action: '胡说' });
  assert.equal(bad2.status, 400);
  assert.deepEqual(bad2.body.allowed, ['mark', 'clear', 'retire-stale']);
});

test('POST /facts/merged {action:"retire-stale"}：要先显式确认，跑完 stale 归零', async () => {
  // 没给确认词 ⇒ 拒绝，但顺手回报"将要退役几条"（这本身就是有用的信息）
  const dry = await post('/facts/merged', { action: 'retire-stale' });
  assert.equal(dry.status, 400);
  assert.ok(dry.body.willRetire >= 1, '拒绝时要告诉用户"这一下会动几条"');
  assert.equal(dry.body.current, String(PRAGMATIC_VERSION));

  const retired = await post('/facts/merged', { action: 'retire-stale', confirm: 'retire-stale' });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.retired, 1, '退役的就是那条 v4');
  assert.equal(retired.body.missing.length, 0);

  const after = await get('/facts/merged');
  assert.equal(after.body.stale.count, 0, '活动槽里再没有旧口径 ⇒ 重判前置就绪');
  assert.equal(after.body.entries[0].into, null, '退役标记 into:null');

  // 一并验证：退役后 /status 的 rebuildRequired 消失（库与代码口径一致了）
  const st = await get('/status');
  assert.equal(st.body.facts.rebuildRequired, null, '没有陈旧活动槽 ⇒ 不再报"需要重建"');
  assert.equal(st.body.facts.merged.count, 1);

  // 收尾：回滚，保持测试独立性
  await post('/facts/merged', { action: 'clear', keys: after.body.entries.map((e) => e.key) });
  assert.equal((await get('/facts/merged')).body.count, 0);
});
