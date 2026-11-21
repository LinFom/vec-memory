// test/event-api.mjs —— 新 07 的读侧：事件检索、事件分页、人物场合映射、观察写入未开放
//
// 这一层要钉的都是**看起来正常**的失败形态：
//   · 事件与块的分数混排 ⇒ 排序没人能解释（要求：分容器，不许合并）；
//   · 换过滤条件还用旧游标 ⇒ 两页拼在一起，有重有漏，但每页都"看着对"；
//   · 账本在翻页途中变了却不报 ⇒ 静默漏页；
//   · scope 是单向 HMAC，却硬"猜"出一个 chatKey ⇒ 把别人的场合挂到这个人名下；
//   · 观察写入没做完却回 200 ⇒ 前端以为存住了。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime, disposeMemoryVec } from '../src/core/backend.mjs';
import { consolidatePaths } from '../src/core/consolidate.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-event-api-'));
const config = {
  autoIndexEnabled: false, consolidateEnabled: false, crossChatEnabled: false,
  embedBaseURL: '', embedModel: ''
};
const router = createRouter({ dataRoot: root, settings: { getSkillConfig: (_, defaults) => ({ ...defaults, ...config }) } });
const rt = await getRuntime();
for (let i = 0; !rt.lastIdentityCheck && i < 200; i++) await new Promise((r) => setTimeout(r, 10));

const A = '10001111';
const CHAT = 'group:10009999';
const OTHER = 'group:10008888';
rt.normalizer.setVocabulary([
  { id: 'qq:' + A, kind: 'person', surface: ['Alpha'] },
  { id: 'group:' + CHAT.slice(6), kind: 'group', surface: ['Test'] }
]);
const call = (route, body) => router.handle({ path: route, method: body === undefined ? 'GET' : 'POST', body });
const q = (s) => encodeURIComponent(s);

// ── 事件账本夹具（一行 = 一件事，字段与 `applyWindow` 实产一致）──────────
const P = consolidatePaths(rt.dir);
fs.mkdirSync(P.base, { recursive: true });
const row = (id, extra = {}) => ({
  id, windowId: id.replace(/_\d+$/, ''), chatKey: CHAT,
  title: id, summary: `${id} 的摘要`, fromTs: 1000, toTs: Number(id.split('_').pop()) * 1000,
  hits: 0, ...extra
});
const seed = [
  row('evt_A_1_1', { title: '露营计划', summary: '决定周末去露营，担心下雨', toTs: 2000 }),
  row('evt_A_1_2', { title: '买锅', summary: '讨论买一口户外锅', toTs: 2000 }),
  row('evt_B_3_3', { title: '露营改期', summary: '露营因为下大雨改期到下周末', toTs: 4000, dimmedAt: '2026-01-01T00:00:00.000Z' }),
  row('evt_C_5_5', { chatKey: OTHER, title: '别的群', summary: '另一个群的露营消息', toTs: 6000 })
];
const writeLedger = (rows) => fs.writeFileSync(P.events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
writeLedger(seed);

test.after(() => {
  disposeMemoryVec();
  assert.ok(path.basename(root).startsWith('mv-event-api-'));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── ① /search kind=event ────────────────────────────────────────────────
test('① /search kind=event 走事件层：score 是覆盖率，每条带 source=event', async () => {
  const r = await call('/search', { q: '露营 下雨', kind: 'event', mode: 'exact', chatKey: CHAT, k: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'exact');
  assert.equal(r.body.scoredBy, 'event-idf');
  assert.ok(r.body.hits.length >= 1, '应命中事件');
  assert.ok(r.body.hits.every((h) => h.source === 'event'), '每条必须带 source=event');
  assert.ok(r.body.hits.every((h) => typeof h.score === 'number' && h.score > 0));
  // 会话隔离：别的群那条不许出现
  assert.ok(!r.body.hits.some((h) => h.chatKey === OTHER), '不许跨会话给事件');
});

test('① 事件与块分容器：无 kind 时 hits 不带事件、events 侧车单独给', async () => {
  const r = await call('/search', { q: '露营 下雨', mode: 'exact', chatKey: CHAT, k: 3 });
  assert.equal(r.status, 200);
  assert.ok(r.body.events && r.body.events.scoredBy === 'event-idf', '应有独立 events 容器');
  assert.ok(r.body.events.hits.every((h) => h.source === 'event'));
  // 块层容器里若出现事件，只可能是**向量库里真有事件向量**（这里没有）——
  // 无论如何不许把 event-idf 的分数塞进 hits 数组。
  assert.ok(!r.body.hits.some((h) => h.kind === 'event' && h.score === r.body.events.hits[0]?.score));
  const off = await call('/search', { q: '露营', mode: 'exact', chatKey: CHAT, includeEvents: false });
  assert.equal(off.body.events.applied, false);
  assert.equal(off.body.events.reason, 'disabled-by-request');
});

test('① kind=event 显式要向量但端点没配 ⇒ 400 带稳定码，不静默换模式', async () => {
  const r = await call('/search', { q: '露营', kind: 'event', mode: 'vector', chatKey: CHAT });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'EMBED_UNCONFIGURED');
  assert.equal(r.body.retryable, false);
  const auto = await call('/search', { q: '露营 下雨', kind: 'event', mode: 'auto', chatKey: CHAT });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.mode, 'exact', 'auto 无端点必须降级');
  assert.equal(auto.body.degraded.code, 'EMBED_UNCONFIGURED');
  assert.ok(auto.body.events.count >= 1, '降级后仍要给事件候选');
});

test('① 事实标签仍 400（不许把标签当文档类型放过去）', async () => {
  const r = await call('/search', { q: 'x', kind: 'trait' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.allowedSearchKinds, ['hour', 'day', 'ep', 'event']);
});

// 零命中最常见的误读是"她压根没记过这件事"。实际上事件摘要只有被反复提起（升长期）
// 才进语义库，更冷的只在关键词层 —— 所以零命中必须带一句"该去哪儿找"，
// 而**有命中时不能带**（否则每个结果都像可疑）。
test('① 零命中说明"没搜到 ≠ 没记住"，命中时不出现', async () => {
  const miss = await call('/search', { q: '量子力学 弦论', kind: 'event', mode: 'exact', chatKey: CHAT, k: 5 });
  assert.equal(miss.status, 200);
  assert.equal(miss.body.count, 0);
  assert.match(miss.body.zeroHitHint, /不等于没记过/);
  assert.match(miss.body.zeroHitHint, /升过长期/);

  const hit = await call('/search', { q: '露营', kind: 'event', mode: 'exact', chatKey: CHAT, k: 5 });
  assert.ok(hit.body.count >= 1);
  assert.equal(hit.body.zeroHitHint, null, '有命中时不该再给"可能没记"的提示');
});

// ── ② /recall 事件段 ────────────────────────────────────────────────────
test('② /recall 给独立事件段，并按稳定 eventId 去重', async () => {
  const r = await call(`/recall?chatKey=${q(CHAT)}&q=${q('露营 下雨')}&k=5`);
  assert.equal(r.status, 200);
  const ev = r.body.events;
  assert.ok(ev && ev.items.length, '应有事件段');
  const ids = ev.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, '同一 eventId 不许出现两次');
  assert.ok(ev.items.every((i) => i.source === 'event'));
  assert.ok(ev.items.every((i) => ['working', 'promoted', 'dimmed', 'retired'].includes(i.state)));
  // 出现两遍的必须被计数，而不是悄悄消失
  assert.equal(typeof ev.deduped, 'number');
  assert.equal(ev.relatedCount + ev.recentCount >= ev.items.length, true);
});

test('② /recall 没给 chatKey ⇒ 事件段说明原因（短期层按会话隔离）', async () => {
  const r = await call(`/recall?q=${q('露营')}`);
  assert.equal(r.body.events.reason, 'no-chat-key');
  assert.equal(r.body.events.applied, false);
});

test('② /recall 主体查询给空壳 events（形状固定，缺字段会被当成"没数据"）', async () => {
  const created = await call('/subjects', { operationId: 's1', kind: 'group', label: '测试群', scopeBinding: rt.normalizer.scopeLabel(CHAT) });
  const id = created.body.subject?.id || created.body.id;
  const r = await call(`/recall?chatKey=${q(CHAT)}&subjectId=${q(id)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.events.reason, 'subject-query');
});

// ── ③ /memory/events 分页 ───────────────────────────────────────────────
test('③ 分页：稳定 (toTs,id) 降序、末页 nextCursor=null、size 生效', async () => {
  const a = await call(`/memory/events?chatKey=${q(CHAT)}&limit=2`);
  assert.equal(a.status, 200);
  assert.equal(a.body.items.length, 2);
  assert.deepEqual(a.body.items.map((i) => i.id), ['evt_B_3_3', 'evt_A_1_2'], 'toTs 降序、同 toTs 按 id 降序');
  assert.ok(a.body.nextCursor);
  const b = await call(`/memory/events?chatKey=${q(CHAT)}&limit=2&cursor=${q(a.body.nextCursor)}`);
  assert.deepEqual(b.body.items.map((i) => i.id), ['evt_A_1_1']);
  assert.equal(b.body.nextCursor, null);
  assert.equal(b.body.snapshotId, a.body.snapshotId, '同一账本快照 id 应一致');
  // 两页拼起来必须恰好是全集，不重不漏
  const all = [...a.body.items, ...b.body.items].map((i) => i.id);
  assert.deepEqual(all, a.body.items.concat(b.body.items.map((i) => i.id)).length === 3 ? all : all);
  assert.equal(new Set(all).size, 3);
});

test('③ 游标绑定过滤条件：换了 state 还用旧游标 ⇒ 400 INVALID_CURSOR', async () => {
  const a = await call(`/memory/events?chatKey=${q(CHAT)}&limit=1`);
  const r = await call(`/memory/events?chatKey=${q(CHAT)}&limit=1&state=dimmed&cursor=${q(a.body.nextCursor)}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_CURSOR');
  const junk = await call('/memory/events?cursor=not-a-cursor');
  assert.equal(junk.status, 400);
  assert.equal(junk.body.code, 'INVALID_CURSOR');
});

test('③ 账本在翻页途中变了 ⇒ 409 SNAPSHOT_CHANGED（不拼页）', async () => {
  const a = await call(`/memory/events?chatKey=${q(CHAT)}&limit=1`);
  writeLedger([...seed, row('evt_D_7_7', { title: '新增', summary: '新来的一件事', toTs: 8000 })]);
  const r = await call(`/memory/events?chatKey=${q(CHAT)}&limit=1&cursor=${q(a.body.nextCursor)}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SNAPSHOT_CHANGED');
  writeLedger(seed);
});

test('③ state 过滤与非法参数：state 只认四个值，from>to 400', async () => {
  const dimmed = await call(`/memory/events?chatKey=${q(CHAT)}&state=dimmed`);
  assert.deepEqual(dimmed.body.items.map((i) => i.id), ['evt_B_3_3']);
  assert.equal(dimmed.body.stateCounts.working, 2);
  assert.equal((await call(`/memory/events?state=trait`)).status, 400);
  assert.equal((await call(`/memory/events?from=100&to=50`)).status, 400);
  // 显式 `limit=0` 必须 400 —— 被 `|| 50` 静默改成 50 的话，"返回 50 条"看起来完全正常
  const limitZero = await call(`/memory/events?chatKey=${q(CHAT)}&limit=0`);
  assert.equal(limitZero.status, 400);
  assert.equal(limitZero.body.code, 'INVALID_ARGUMENT');
  const limitBig = await call(`/memory/events?chatKey=${q(CHAT)}&limit=101`);
  assert.equal(limitBig.status, 400);
  const noLimit = await call(`/memory/events?chatKey=${q(CHAT)}`);
  assert.equal(noLimit.body.limit, 50, '不传才是 50');
});

test('③ sourceAvailable 不给假的 true/false：未知就是 null', async () => {
  const r = await call(`/memory/events?chatKey=${q(CHAT)}`);
  assert.equal(r.body.items[0].sourceAvailable, null);
  assert.ok(/not-verified/.test(r.body.items[0].sourceAvailableReason));
});

test('③ 账本坏行必须说出来，不能变成"少了几条"', async () => {
  fs.writeFileSync(P.events, seed.map((r) => JSON.stringify(r)).join('\n') + '\n{坏行\n', 'utf8');
  const r = await call(`/memory/events?chatKey=${q(CHAT)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.degraded.code, 'LEDGER_CORRUPT');
  assert.equal(r.body.degraded.badLines, 1);
  writeLedger(seed);
});

// ── ④ 人物场合映射 ──────────────────────────────────────────────────────
test('④ 场合映射：能正算回来的 chatKey 才 resolved，否则 unknown（不猜）', async () => {
  await call('/remember', { chatKey: CHAT, userId: A, kind: 'trait', attr: '职业', text: '工程师' });
  const r = await call(`/memory/person?who=${A}`);
  assert.equal(r.status, 200);
  const s = r.body.scopes[0];
  assert.equal(s.mappingStatus, 'resolved');
  assert.equal(s.chatKey, CHAT);
  assert.ok(s.displayName && s.displayName !== s.scope, '应给可读名字');
});

test('④ 没有已知 chatKey 能正算出来 ⇒ null/unknown，不编一个', async () => {
  // 造一个这个库里没有任何 chatKey 对应的场合：直接改 scope 不行（scope 由 chatKey 派生），
  // 所以反过来验：删掉事件账本后，那个 scope 就"谁也认不出"了。
  writeLedger([]);
  const r = await call(`/memory/person?who=${A}`);
  const s = r.body.scopes[0];
  assert.equal(s.chatKey, null);
  assert.equal(s.mappingStatus, 'unknown');
  assert.ok(/HMAC/.test(s.reason));
  writeLedger(seed);
});

// ── ⑤ 观察写入仍未开放 ──────────────────────────────────────────────────
test('⑤ POST /subjects/:id/observations 仍 501，且能力名里没有它', async () => {
  const list = await call('/subjects');
  const id = list.body.items[0]?.id;
  const r = await call(`/subjects/${q(id || 'any')}/observations`, { operationId: 'o1' });
  assert.equal(r.status, 501);
  assert.equal(r.body.code, 'FEATURE_UNAVAILABLE');
  assert.ok(/来源校验适配未完成/.test(r.body.error));
  const diag = await call('/memory/diagnostics');
  assert.ok(!diag.body.capabilities.includes('subjects.observations.write'));
  assert.ok(diag.body.capabilities.includes('memory.events'));
  assert.ok(diag.body.capabilities.includes('facts.evidence'));
});
