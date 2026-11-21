// test/recall.mjs —— 统一检索（长期事实 + 近期块）与**标签筛选**
//
// 为什么单独一个文件：这一层有四条性质，都不是既有测试能推出来的 ——
//   ① **长期/近期是两套存储**（`slots.jsonl` 的结构化事实 vs 向量库的小时块），
//      `/search` 只认识后者 ⇒ "搜年龄搜不到 21岁" 不是 bug，而是这一层缺失；
//   ② `kinds` 是**多值封闭枚举**，接受单标签 / 组名 / all，拼错必须 400
//      （静默空结果与"从没记过"无法区分，是本仓明令禁止的失败形态）；
//   ③ `/person?kinds=` 筛空时必须与"这个人从来没记过"**分开说**；
//   ④ `allKinds` 必须在过滤**之前**统计 —— 否则一次筛选会把筛选菜单自己吃掉。
//
// 纪律（同 `test/person.mjs`）：临时 dataRoot，一个字节都不碰真库。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-recall-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

const UID = '1006837800';
const UID2 = '1006837801';
const UID3 = '1006837802';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲瓶', '瓶瓶'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙罐'] },
  { id: `qq:${UID3}`, kind: 'person', surface: ['丙碗'] },   // 词表里有、一条事实都没有
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);

const GROUP = 'group:1098345913';
const PRIV = `private:${UID}`;
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
assert.ok(LABEL, '测试前提：甲能在词表里认出来');

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });

// 甲：群里的档案 ×2 + 偏好；私聊的档案 ×1（验证场合分栏仍生效）
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '职业', text: '程序员' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '爱好', text: '画画' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '爱喝美式' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'promise', text: '答应带乙罐去看海' });
await post('/remember', { chatKey: PRIV, userId: UID, kind: 'trait', attr: '所在地', text: '成都' });
// 乙：一条偏好 —— 不该出现在甲的检索结果里
await post('/remember', { chatKey: GROUP, userId: UID2, kind: 'preference', text: '爱喝拿铁' });

// ═══════════════════════════════════════════════════════════════════════════
// ① `/recall`：长期段按人可查，两套存储分两段返回
// ═══════════════════════════════════════════════════════════════════════════

test('recall 按人取长期事实，且**不混进别人的**', async () => {
  const r = await get(`/recall?who=${UID}`);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.ok, true);
  assert.ok(b.found, '人在词表里');
  assert.equal(b.longTerm.total, 4, '槽数：群 trait + preference + promise + 私聊 trait');
  assert.equal(b.longTerm.entries, 5, '展开后的键值数：职业/爱好/所在地 + 偏好 + 承诺');
  assert.ok(!b.longTerm.items.some((x) => x.line.includes('拿铁')), '乙的偏好不许进来');
  // 场合分栏照旧：私聊那条也在（recall 不按场合隔离，只按场合**过滤**）
  assert.ok(b.longTerm.items.some((x) => x.kind === 'trait' && x.items.some((i) => i.k === '所在地')));
  assert.equal(b.longTerm.byKind.trait, 2, '群 1 槽（职业+爱好）+ 私聊 1 槽 —— trait 是多值单槽');
});

test('recall 的 longTerm 与 recent **分段返回**，不合并排序', async () => {
  const b = (await get(`/recall?who=${UID}`)).body;
  assert.ok(Array.isArray(b.longTerm.items) && Array.isArray(b.recent.items));
  assert.ok(b.recent.items.every((x) => x.source === 'chunks'), '近期段每条都标 source=chunks');
  assert.ok(b.longTerm.items.every((x) => x.source === 'facts'), '长期段每条都标 source=facts');
  assert.ok(/不可比/.test(b.note || ''), '必须明说两段分数不可比');
});

test('recall 的 `kinds` 单选：只要 trait', async () => {
  const b = (await get(`/recall?who=${UID}&kinds=trait`)).body;
  assert.ok(b.longTerm.items.length > 0);
  assert.ok(b.longTerm.items.every((x) => x.kind === 'trait'), '不许混入 preference/promise');
  assert.equal(b.longTerm.total, 2, '两个 trait 槽（群 1 + 私聊 1）');
  assert.equal(b.longTerm.entries, 3, '三个键值：职业 / 爱好 / 所在地');
});

test('recall 的 `kinds` 多选：trait + preference', async () => {
  const b = (await get(`/recall?who=${UID}&kinds=trait,preference`)).body;
  const kinds = new Set(b.longTerm.items.map((x) => x.kind));
  assert.deepEqual([...kinds].sort(), ['preference', 'trait']);
  assert.ok(!kinds.has('promise'), 'promise 不在请求里');
});

test('recall 的 `kinds` 支持组名（pragmatic / semantic）与 all', async () => {
  const p = (await get(`/recall?who=${UID}&kinds=pragmatic`)).body;
  assert.ok(p.longTerm.items.every((x) => ['pattern', 'speaker_profile', 'trait'].includes(x.kind)));
  assert.equal(p.longTerm.total, 2, '这个人只有 trait 属于 pragmatic（群 1 + 私聊 1）');

  const s = (await get(`/recall?who=${UID}&kinds=semantic`)).body;
  assert.ok(s.longTerm.items.every((x) => ['event', 'topic', 'promise', 'joke', 'grudge', 'preference'].includes(x.kind)));
  assert.equal(s.longTerm.total, 2, 'preference + promise');

  const a = (await get(`/recall?who=${UID}&kinds=all`)).body;
  assert.equal(a.longTerm.total, 4);
});

test('recall 的 `kinds` 拼错必须 400，并列出合法值（不许静默空）', async () => {
  const r = await get(`/recall?who=${UID}&kinds=traits`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /traits/);
  assert.ok(Array.isArray(r.body.allowed) && r.body.allowed.includes('trait'));
});

test('recall 的 `q` 只做**长期段**的关键词筛（事实行级）', async () => {
  const b = (await get(`/recall?who=${UID}&q=${encodeURIComponent('美式')}`)).body;
  assert.equal(b.longTerm.total, 1);
  assert.match(b.longTerm.items[0].line, /美式/);
  assert.ok(b.longTerm.items[0].score > 0, '有 q 时长期段带 score');
});

test('recall 认不出人时**明说**，不给空结果假装没记过', async () => {
  const b = (await get('/recall?who=99999999999')).body;
  assert.equal(b.ok, true);
  assert.equal(b.found, false);
  assert.match(b.reason || '', /认不出/);
  assert.equal(b.longTerm.total, 0);
});

test('recall 无 q 时近期段走 list 模式，空库不报错', async () => {
  const b = (await get(`/recall?who=${UID}`)).body;
  assert.equal(b.recent.mode, 'list');
  assert.equal(b.recent.items.length, 0, '临时库里没有块');
});

test('recall 按 chatKey 过滤长期段（scope 由 chatKey 派生）', async () => {
  const g = (await get(`/recall?who=${UID}&chatKey=${encodeURIComponent(GROUP)}`)).body;
  assert.equal(g.longTerm.total, 3, '群里的 3 个槽');
  assert.ok(!g.longTerm.items.some((x) => x.items?.some((i) => i.k === '所在地')), '私聊那条不在群里');

  const p = (await get(`/recall?who=${UID}&chatKey=${encodeURIComponent(PRIV)}`)).body;
  assert.equal(p.longTerm.total, 1, '私聊只有 1 条');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② `/person?kinds=`：卡片侧筛选
// ═══════════════════════════════════════════════════════════════════════════

test('person 带 kinds 筛选：只剩该类，但 allKinds 仍是**全量**', async () => {
  const b = (await get(`/person?who=${UID}&kinds=trait`)).body;
  assert.equal(b.found, true);
  assert.equal(b.totalSlots, 2, '筛后 2 个 trait 槽（群 1 + 私聊 1）');
  assert.equal(b.allSlots, 4, '全量 4 个槽要能看见');
  assert.equal(b.allKinds.trait, 2);
  assert.equal(b.allKinds.preference, 1);
  assert.equal(b.allKinds.promise, 1);
});

test('person 筛空 vs 从没记过：两种"没东西"必须分开说', async () => {
  const empty = (await get(`/person?who=${UID}&kinds=joke`)).body;
  assert.match(empty.reason || '', /没有一条/, '筛空要说"有 N 条但没有该标签"');
  assert.ok(empty.allSlots > 0);
  assert.match(empty.reason, /现有的标签/);

  // 词表里有、但一条事实都没有的人 —— 第三种情形，文案必须不同
  const never = (await get(`/person?who=${UID3}`)).body;
  assert.equal(never.found, true);
  assert.match(never.reason || '', /一条事实都没有/);
  assert.notEqual(never.reason, empty.reason, '两种"空"的文案不许一样');
});

test('person 的 kinds 拼错同样 400', async () => {
  const r = await get(`/person?who=${UID}&kinds=nope`);
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.allowed));
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ `/search` 的 `kind` 是**块粒度**，不是事实标签
// ═══════════════════════════════════════════════════════════════════════════

test('/search 传事实标签必须 400（否则命中 0 条却回 ok:true，与"没记过"无法区分）', async () => {
  const r = await post('/search', { q: '美式', kind: 'trait' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.allowedChunkKinds, ['hour', 'day', 'ep']);
  assert.match(r.body.error || '', /\/recall/);
});

test('/search 传块粒度照常放行（不误伤既有调用）', async () => {
  const r = await post('/search', { q: '美式', kind: 'hour', mode: 'exact' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'exact');
});
