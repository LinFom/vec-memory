// test/caliber-governed.mjs —— 「口径管辖」判据（2026-10-16）
//
// ── 为什么需要这一层 ─────────────────────────────────────────────────────────
// `logic_version`（`PRAGMATIC_VERSION`）是个**全局戳**，但**只有判定路径受它管辖**：
//   判定路径：`backend.mjs` 候选构造 → `extract.mjs` 判定 → `put()`
//   直写路径：`POST /remember`（`ADR-0024`）—— **不经过任何判定逻辑**
//
// 直写槽的 `target` 是**硬编码 `''`**（`router.mjs` 的 remember 分支）、`content` 是
// 人/模型当次写下的一句话 ⇒ 口径变更**不会**让它产出新 key，也**没有**任何来源可重建。
//
// 把直写槽算进"待重建"，后果**不是"多报几条"**：`staleKeys()` 同时是 `retire-stale`
// 的处方 ⇒ 它会**盲杀**这些槽，而重判**补不回来**（直写 key 的 target 恒 `''`，
// 判定产出的 key 带 target ⇒ 两者 key 空间不相交）。
//
// 实测 A 号（365 条活动槽）：报陈旧 354 条，其中 **336 条是直写**
// （一次 10-12 的 `people/*.json` → factstore 迁移产物），真 stale 只 **18 条**
// ⇒ 真问题被噪音淹没，且一键 `retire-stale` = 336 条事实蒸发。
//
// ── 纪律（同 `test/merged-retire.mjs`）────────────────────────────────────────
//   · **临时 dataRoot**（`os.tmpdir()`）⇒ 一个字节都不碰真库。
//     （`createRouter` 只注入 `DATA_DIR`、不注入 `SOURCE_DIR`，见 `ADR-0033 §8`。）
//   · 不碰网络。
//   · ⚠️ 断言必须**双向**：直写槽留下 + 派生槽退役。只断言一边 ⇒ 把判据写成恒真/恒假
//     也能全绿（"假通过"，本仓已栽两次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf } from '../src/core/backend.mjs';
import { PRAGMATIC_VERSION } from '../src/core/edges.mjs';
import { isCaliberGoverned, DIRECT_WRITE_SOURCE } from '../src/core/factstore.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-governed-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（详见 `test/trait.mjs`）。
const deadline = Date.now() + 30_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const UID = '1006837691';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['丁丁'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);
const GROUP = 'group:1098345913';
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
assert.ok(LABEL, '测试前提：这个人能在词表里认出来');

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });

const store = factStoreOf(rt);
const SCOPE = rt.normalizer.scopeLabel(GROUP);

// 一个**不等于**当前口径的版本号。不写死数字：将来 bump 到那个数字时用例不该失效。
const CURRENT = String(PRAGMATIC_VERSION);
const OLD_V = CURRENT === '4' ? '6' : '4';

/**
 * **直写槽**：`content.source` 标死 —— 生产形态（10-12 那次 people → factstore 迁移的产物）。
 * 用**旧版本号**构造，正是"版本号更早但不该被重建"的那个矛盾点。
 */
function addDirect(kind, text, lv = OLD_V) {
  const r = store.put({
    speaker: LABEL, fact_kind: kind, scope: SCOPE,
    content: { text, source: DIRECT_WRITE_SOURCE },
    evidenceIds: [`direct-${kind}`], logicVersion: lv
  });
  return r.key;
}

/** **派生槽**：`content` 里**没有** `source` 键 —— 判定产物的形态。这条**该**被重建。 */
function addDerived(kind, text, lv = OLD_V) {
  const r = store.put({
    speaker: LABEL, fact_kind: kind, scope: SCOPE,
    content: { text },
    evidenceIds: [`derived-${kind}`], logicVersion: lv
  });
  return r.key;
}

const DIRECT_KEY = addDirect('preference', '喜欢雨天（迁移产物）');
const DERIVED_KEY = addDerived('event', '旧口径判定留下的槽');

// 前提自检：两条都真的是"版本号陈旧"，差别只在**来源**
assert.equal(store.count, 2, '前提：两条活动槽');
assert.equal(store.get(DIRECT_KEY).logic_version, OLD_V);
assert.equal(store.get(DERIVED_KEY).logic_version, OLD_V);

// ═══════════════════════════════════════════════════════════════════════════
// ① 判据本身（纯函数）
// ═══════════════════════════════════════════════════════════════════════════

test('isCaliberGoverned：content.source === assistant-remember ⇒ 不受口径管辖', () => {
  assert.equal(isCaliberGoverned({ content: { text: 'x', source: DIRECT_WRITE_SOURCE } }), false, '直写 ⇒ 不受管辖');
  assert.equal(isCaliberGoverned({ content: { text: 'x' } }), true, '无 source ⇒ 判定产物 ⇒ 受管辖');
  // 形状缺失一律按"受管辖"处理：宁多报（多一条噪音）也不漏报（漏报 = 静默删数据）
  assert.equal(isCaliberGoverned({ content: null }), true);
  assert.equal(isCaliberGoverned({}), true);
  assert.equal(isCaliberGoverned(null), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② `rebuildRequired`：只报判定产物，直写槽**单列**（信息不丢，只是不算待重建）
// ═══════════════════════════════════════════════════════════════════════════

test('/status：rebuildRequired.stale 只含判定产物；直写槽进 directVersions', async () => {
  const r = await get('/status');
  assert.equal(r.status, 200);
  const rb = r.body.facts?.rebuildRequired;
  assert.ok(rb, '有派生陈旧槽 ⇒ 必须报出"需要重建"');
  assert.deepEqual(rb.stale, { [OLD_V]: 1 },
    `⚠️ 只有 1 条（派生）。直写那条**不许**进来 —— 修复前这里是 {${OLD_V}:2}`);
  assert.equal(rb.directVersions?.[OLD_V], 1,
    '直写槽要**单列**报出：不报的话"354 报陈旧"与"只退役 29"对不上，看起来像退役没生效');
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ `staleKeys`：`retire-stale` 的处方 —— 漏滤 = 静默删数据
// ═══════════════════════════════════════════════════════════════════════════

test('staleKeys：处方只含判定产物，直写槽计入 directKept', () => {
  const s = store.staleKeys();
  assert.deepEqual(s.keys, [DERIVED_KEY], '处方里只有派生那条');
  assert.equal(s.directKept, 1, '直写那条被**故意留下**，且要点名');
  assert.equal(s.current, CURRENT);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 出口：面板与自检要能说清"为什么退役数远小于陈旧数"
// ═══════════════════════════════════════════════════════════════════════════

test('GET /facts/merged：stale.count 只含判定产物 + directSkipped 透出', async () => {
  const r = await get('/facts/merged');
  assert.equal(r.status, 200);
  assert.equal(r.body.stale.count, 1, '陈旧计数 = 1（派生）');
  assert.equal(r.body.stale.directSkipped, 1, '跳过的直写槽要透出');
  assert.equal(r.body.stale.current, CURRENT);
});

test('/selfcheck：fact-caliber 的详情要点明"另有直写槽不计入"', async () => {
  const r = await post('/selfcheck', {});
  const cal = r.body.checks.find((c) => c.id === 'fact-caliber');
  assert.ok(cal, '要有 fact-caliber 这一条');
  assert.equal(cal.pass, null, '待重判是"待决策"状态，不是失败（同 ADR-0034 §2.1）');
  assert.match(cal.detail, new RegExp(`v${OLD_V}`), '详情里要出现具体的陈旧版本');
  assert.match(cal.detail, /直写/, '要点明直写槽的存在与处置 —— 否则用户无法解释数字差');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 端点：`retire-stale` 的命运 —— **双向断言**（这是本轮修复的核心）
// ═══════════════════════════════════════════════════════════════════════════

test('⚠️ retire-stale：退役判定产物、**放过**直写槽（后者无可重建来源）', async () => {
  // 没给确认词 ⇒ 拒绝，但顺手回报"将要退役几条 / 跳过几条"
  const dry = await post('/facts/merged', { action: 'retire-stale' });
  assert.equal(dry.status, 400);
  assert.equal(dry.body.willRetire, 1, '将要退役的只有派生那条');
  assert.equal(dry.body.directSkipped, 1, '拒绝时也要说清会跳过多少条');

  const retired = await post('/facts/merged', { action: 'retire-stale', confirm: 'retire-stale' });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.retired, 1, '⚠️ 只退役 1 条 —— 判据若恒假，这里是 0（过滤过头会全丢）');
  assert.equal(retired.body.directSkipped, 1);

  assert.equal(store.slots.has(DERIVED_KEY), false, '派生槽退役（重判会产出新 key 接替它）');
  assert.equal(store.slots.has(DIRECT_KEY), true,
    '⚠️ 直写槽**必须还在活动视图** —— 判据若恒真，这里会变成 false（336 条事实蒸发）');

  // 收尾：回滚，保持用例独立性
  await post('/facts/merged', { action: 'clear', keys: [DERIVED_KEY] });
  assert.equal(store.slots.has(DERIVED_KEY), true, '回滚后派生槽回来');
  assert.equal(store.slots.has(DIRECT_KEY), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 防"判据只在脚手架上成立"：真走 `/remember` 端点看它写下的形态
// ═══════════════════════════════════════════════════════════════════════════

test('`/remember` 真实产出的槽带 source 标记（判据的依据必须在生产路径上成立）', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'grudge', text: '讨厌排队' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const rec = [...store.slots.values()].find((x) => x.fact_kind === 'grudge');
  assert.ok(rec, '端点写入成功');
  assert.equal(rec.content.source, DIRECT_WRITE_SOURCE,
    '⚠️ 端点真的把 source 标死了 —— 上面所有用例的判据都建立在这个事实上');
  assert.equal(isCaliberGoverned(rec), false);
  assert.equal(rec.logic_version, CURRENT, '端点写的是当前口径 ⇒ 本来就不陈旧');
  assert.equal(store.staleKeys().keys.includes(rec.key), false, '当前口径的直写槽不进处方');
});
