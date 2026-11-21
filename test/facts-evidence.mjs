// test/facts-evidence.mjs —— `GET /facts/evidence`（`contracts` B）
//
// 这一层唯一的失败形态是**过度声称**：
//   · 窗口级来源被标成 `exact` ⇒ 界面给出"这是原话出处"，而窗口提交后原文早已不留档；
//   · 账本读不动时把"没核对上"折成"核对过了、没找到" ⇒ 一样是拿未知当结论；
//   · 请求了 itemKey 却没有项级来源，仍报 `level=item` ⇒ 拿整槽来源冒充单项来源；
//   · 凭 hash 造"原会话链接" ⇒ 不可反查的东西被包装成可点。
// 所以判据必须是双向的：**带来源的槽要落到 window-match**，**没来源的槽必须 unavailable**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf, disposeMemoryVec } from '../src/core/backend.mjs';
import { runConsolidate } from '../src/core/consolidate.mjs';
import { readChatArchive } from '../src/core/crosschat.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-evidence-'));
const config = {
  autoIndexEnabled: false, consolidateEnabled: false, crossChatEnabled: false,
  embedBaseURL: '', embedModel: ''
};
const router = createRouter({ dataRoot: root, settings: { getSkillConfig: (_, defaults) => ({ ...defaults, ...config }) } });
const rt = await getRuntime();
for (let i = 0; !rt.lastIdentityCheck && i < 200; i++) await new Promise((r) => setTimeout(r, 10));

const A = '10001111';
const B = '10002222';
const CHAT = 'group:10009999';
rt.normalizer.setVocabulary([
  { id: 'qq:' + A, kind: 'person', surface: ['Alpha'] },
  { id: 'qq:' + B, kind: 'person', surface: ['Beta'] },
  { id: 'group:' + CHAT.slice(6), kind: 'group', surface: ['Test'] }
]);
const call = (route, body) => router.handle({ path: route, method: body === undefined ? 'GET' : 'POST', body });
const q = (s) => encodeURIComponent(s);

const BASE = 1_800_000_000_000;
const MIN = 60_000;

test.after(() => {
  disposeMemoryVec();
  assert.ok(path.basename(root).startsWith('mv-evidence-'));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 用**真实整理路径**产出带窗口来源的槽（手搓 JSON 可能恰好只有我的校验器能读）──
const evDir = path.join(root, 'memory');
fs.mkdirSync(evDir, { recursive: true });
const evLines = [];
for (let i = 0; i < 6; i++) {
  evLines.push(JSON.stringify({
    at: BASE + i * 1000, chatKey: CHAT, id: `m${i}`,
    speakerId: A, speakerName: 'Alpha',
    text: i % 2 ? '我最近在学吉他' : '嗯嗯'
  }));
}
fs.writeFileSync(path.join(evDir, 'evidence.jsonl'), evLines.join('\n') + '\n', 'utf8');

// ── 宿主会话存档（来源反查读的就是它）· [by:DS] 2026-10-29 ────────────────
// 真存档：`<dataRoot>/messages/<chatKey 的冒号换成下划线>.json`，
// 内容 `{ chatKey, messages:[{ id, ts, senderId, senderName, text }] }`。
// 这里让它与 evidence 行**同 id 同时间**，这样窗口引用能真的取回原话。
const msgDir = path.join(root, 'messages');
fs.mkdirSync(msgDir, { recursive: true });
fs.writeFileSync(
  path.join(msgDir, `${CHAT.replace(':', '_')}.json`),
  JSON.stringify({
    chatKey: CHAT,
    messages: evLines.map((l) => {
      const o = JSON.parse(l);
      return { id: o.id, ts: o.at, senderId: o.speakerId, senderName: o.speakerName, text: o.text };
    })
  }),
  'utf8'
);

const consolidateOnce = () => runConsolidate({
  sourceRoot: root, libDir: rt.dir,
  settings: { consolidateWindowMsgs: 20, consolidateSettleMin: 0, consolidateWindowSpanMin: 120, maxChars: 1200 },
  normalizer: rt.normalizer, factStore: factStoreOf(rt), store: null,
  callLlm: async () => JSON.stringify({
    events: [{ title: '学吉他', detail: 'Alpha 说最近在学吉他', at: '10:00', who: [A] }],
    people: [{ qq: A, kind: 'trait', attr: '爱好', text: '吉他' }]
  })
}, { now: BASE + 10 * MIN });

test('① 整理产出的槽：窗口级来源只能到 window-match，不许冒充消息级 exact', async () => {
  const r = await consolidateOnce();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.slots, 1, '应产出一个 trait 槽');
  const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
  assert.ok(slot, '应能取到槽');
  assert.ok(Array.isArray(slot.provenance) && slot.provenance.length, '整理写入必须带来源引用');

  const res = await call(`/facts/evidence?key=${q(slot.key)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'window-match', '窗口级来源只能是 window-match');
  assert.notEqual(res.body.state, 'exact');
  assert.equal(res.body.references.length, 1);
  assert.equal(res.body.references[0].type, 'window');
  assert.equal(res.body.references[0].resolved, true, '窗口确实在账本里（事件行带同一个 windowId）');
  assert.deepEqual(res.body.unresolved, []);
  // 只回引用/时间/标题，不回整段原文
  assert.ok(!('text' in res.body.references[0]) && !('summary' in res.body.references[0]));
  assert.match(res.body.note, /window-match/);
});

test('② 请求 itemKey：有项级来源才报 level=item，否则明说"整槽来源，不能证明此项"', async () => {
  const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
  const withItem = await call(`/facts/evidence?key=${q(slot.key)}&itemKey=${q('爱好')}`);
  assert.equal(withItem.status, 200);
  assert.equal(withItem.body.requestedItemKey, '爱好');
  // 整理写入会把项级来源一起记下 ⇒ 这里应是 item
  assert.equal(withItem.body.level, 'item');
  assert.equal(withItem.body.state, 'window-match');

  const noItem = await call(`/facts/evidence?key=${q(slot.key)}&itemKey=${q('不存在的项')}`);
  assert.equal(noItem.status, 200);
  assert.equal(noItem.body.level, 'slot', '没有项级来源时必须退回 slot');
  assert.match(noItem.body.reason, /整槽来源/);
});

test('③ /remember 直写的槽没有来源引用 ⇒ unavailable，不给"好像有来源"的视图', async () => {
  const r = await call('/remember', { chatKey: CHAT, userId: B, kind: 'trait', attr: '职业', text: '画家' });
  assert.equal(r.status, 200);
  const slot = [...factStoreOf(rt).slots.values()]
    .find((s) => JSON.stringify(s.content || {}).includes('画家'));
  assert.ok(slot, '应能找到直写槽');
  const res = await call(`/facts/evidence?key=${q(slot.key)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'unavailable');
  assert.equal(res.body.level, 'slot');
  assert.deepEqual(res.body.references, []);
  assert.match(res.body.reason, /旧 hash 不可反查/);
  // 没有 message 引用时**不许**去读消息账本（那是白读一个大文件）
  assert.equal(res.body.ledgers.messages, null);
});

test('④ 参数与错误码：缺 key 400、未知 key 404，都带 code', async () => {
  const miss = await call('/facts/evidence');
  assert.equal(miss.status, 400);
  assert.equal(miss.body.code, 'INVALID_ARGUMENT');
  const ghost = await call('/facts/evidence?key=no-such-slot');
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.code, 'NOT_FOUND');
  assert.equal(ghost.body.retryable, false);
});

test('⑤ 未知 facts 动作仍 400，且 allowed 里列出 evidence', async () => {
  const r = await call('/facts/whatever');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.allowed, ['versions', 'merged', 'evidence']);
});

test('⑥ 证据视图只读：查一次不改变任何事实文件字节', async () => {
  const file = factStoreOf(rt).slotsFile;
  const before = fs.readFileSync(file);
  const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
  await call(`/facts/evidence?key=${q(slot.key)}`);
  await call(`/facts/evidence?key=${q(slot.key)}&itemKey=${q('爱好')}`);
  assert.deepEqual(fs.readFileSync(file), before, '证据视图不许写事实文件');
});

// ── ⑦⑧ 取回原话（`withSource=1`）· [by:DS] 2026-10-29 ──────────────────────
//
// 这一路的危险不是"读不到"，是**读越界**：引用自己带着会话键，若拿它当授权，
// 就等于"谁拿到一条事实 key，就能把任意会话的原话读出来"。
// 所以判据是：**同会话才给**、**跨会话整单拒绝且一条原话都不带**、
// **读不到要分三态**（存档在但没消息 ≠ 存档读不到）。

test('⑦ withSource=1 + 同会话 ⇒ 按窗口区间取回原话', async () => {
  const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
  const res = await call(`/facts/evidence?key=${q(slot.key)}&withSource=1&chatKey=${q(CHAT)}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.sourceLookup, 'withSource=1 必须带 sourceLookup');
  assert.equal(res.body.sourceLookup.chatKey, CHAT);
  const win = res.body.sourceLookup.sources.find((s) => s.type === 'window');
  assert.ok(win, '窗口引用要出现在 sources 里');
  assert.equal(win.status, 'found', `应能在存档里取回原话，实际 ${win.status}/${win.reason}`);
  assert.equal(win.resolved, true);
  assert.equal(win.messages.length, 6, '区间内 6 条消息全取回');
  assert.ok(win.messages.some((m) => m.text.includes('吉他')), '要拿到真话，不是摘要');
  assert.equal(win.messages[0].speaker, 'Alpha', '说话人要标出来');
  assert.equal(win.messages[0].senderId, A);
  assert.ok(win.messages[0].at >= win.messages[1].at ? false : true, '按时间升序');
  // 不承诺"就是当时那一批" —— 窗口是按游标 + 条数上限切的
  assert.match(res.body.sourceLookup.note, /不保证/);
  // 证据状态本身不许因为"能取回原话"就升级成 exact
  assert.equal(res.body.state, 'window-match');
});

test('⑧ 取原话的边界：缺 chatKey 400、跨会话 400 且不带任何原话、三态分得清', async () => {
  const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');

  // ① 只给 key 不给会话 ⇒ 拒绝（不给默认值，那等于替调用方猜一个会话）
  const noChat = await call(`/facts/evidence?key=${q(slot.key)}&withSource=1`);
  assert.equal(noChat.status, 400);
  assert.equal(noChat.body.code, 'INVALID_ARGUMENT');
  assert.ok(!noChat.body.sourceLookup);

  // ② 会话与引用不一致 ⇒ 整单拒绝，**一条原话都不返回**
  const other = await call(`/facts/evidence?key=${q(slot.key)}&withSource=1&chatKey=${q('group:777')}`);
  assert.equal(other.status, 400);
  assert.equal(other.body.code, 'CHATKEY_MISMATCH');
  assert.ok(!other.body.sourceLookup, '拒绝时不许夹带原话');
  assert.equal(other.body.mismatched.length, 1);
  assert.equal(other.body.mismatched[0].chatKey, CHAT);

  // ③ 三态：存档在但这个区间没有消息 ⇒ expired（不是 unavailable，也不是空成功）
  const expired = readChatArchive({ dataDir: root, chatKey: CHAT, fromTs: BASE - 10 * MIN, toTs: BASE - 5 * MIN });
  assert.equal(expired.status, 'expired');
  assert.deepEqual(expired.messages, []);
  assert.equal(expired.reason, 'no-message-in-range');

  // ④ 会话键只用来拼文件名 ⇒ 非法形态必须在读盘之前就被挡住（目录穿越）
  const traversal = readChatArchive({ dataDir: root, chatKey: 'group:../../etc/passwd' });
  assert.equal(traversal.status, 'unavailable');
  assert.equal(traversal.reason, 'bad-chat-key');

  // ⑤ 没有来源引用的槽 ⇒ sources 为空，但请求本身不报错（"问过了，确实没有"）
  const plain = [...factStoreOf(rt).slots.values()]
    .find((s) => JSON.stringify(s.content || {}).includes('画家'));
  const plainRes = await call(`/facts/evidence?key=${q(plain.key)}&withSource=1&chatKey=${q(CHAT)}`);
  assert.equal(plainRes.status, 200);
  assert.deepEqual(plainRes.body.sourceLookup.sources, []);
  assert.equal(plainRes.body.sourceLookup.totalMessages, 0);
});

// ── ⑨⑩⑪ 存档会话绑定（复审反例 · [by:DS] 2026-10-29）───────────────────────
//
// 上一版先信文件名（`group_1.json` 就是 group:1），再用 `内部键 === ck || 文件名 === ck`
// 兜底 ⇒ **内部键不符能靠文件名条件绕过**。`group_1.json` 里装着 `private:2` 的内容
// 完全可能（改名、复用、手工搬移），那就等于把私聊当群聊读出来，而且看代码看不出来。
// 所以判据改成：内部键说了算；文件名**只在确实没有内部键时**作兼容推断，并且要标明。

test('⑨ 会话绑定：内部键说了算，文件名只在"确实没有内部键"时才兼容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-arch-'));
  const mdir = path.join(dir, 'messages');
  fs.mkdirSync(mdir, { recursive: true });
  const W = (name, obj) => fs.writeFileSync(path.join(mdir, name), JSON.stringify(obj), 'utf8');
  const msg = (id, ts, text) => ({ id, ts, senderName: 'X', text });

  // ① 正常：内部键与请求一致
  W('group_1.json', { chatKey: 'group:1', messages: [msg('a', 1000, '群一的话')] });
  const innerHit = readChatArchive({ dataDir: dir, chatKey: 'group:1' });
  assert.equal(innerHit.status, 'found');
  assert.equal(innerHit.matchedBy, 'inner-chat-key');
  assert.equal(innerHit.messages[0].text, '群一的话');

  // ② 同名文件，内部是私聊 ⇒ 按区间、按消息 id **都读不出**（文件名不能救场）
  W('group_2.json', { chatKey: 'private:9', messages: [msg('b', 2000, '私聊的话')] });
  const byRange = readChatArchive({ dataDir: dir, chatKey: 'group:2', fromTs: 0, toTs: 9999 });
  assert.equal(byRange.status, 'unavailable');
  assert.equal(byRange.reason, 'chat-mismatch');
  assert.deepEqual(byRange.messages, [], '区间查询不许读出被拒文件的内容');
  assert.equal(byRange.candidates[0].innerChatKey, 'private:9');
  const byId = readChatArchive({ dataDir: dir, chatKey: 'group:2', ids: ['b'] });
  assert.equal(byId.status, 'unavailable');
  assert.deepEqual(byId.messages, [], '同消息 id 也不许读出');

  // ③ 同名文件矛盾 + 另一个文件内部正确 ⇒ **只给正确那一个**
  W('group_3.json', { chatKey: 'private:7', messages: [msg('c', 3000, '不该出现')] });
  W('moved_elsewhere.json', { chatKey: 'group:3', messages: [msg('d', 3000, '正确的')] });
  const alt = readChatArchive({ dataDir: dir, chatKey: 'group:3' });
  assert.equal(alt.status, 'found');
  assert.equal(alt.file, 'moved_elsewhere.json', '要跳到内部键正确的那个文件');
  assert.equal(alt.matchedBy, 'inner-chat-key');
  assert.deepEqual(alt.messages.map((x) => x.text), ['正确的']);
  assert.ok(!JSON.stringify(alt).includes('不该出现'), '被拒文件的内容一个字都不许带出来');

  // ④ 旧数组存档（确实没有内部键）⇒ 按约定文件名兼容，且**必须自报是推断**
  W('group_4.json', [msg('e', 4000, '老格式')]);
  const legacy = readChatArchive({ dataDir: dir, chatKey: 'group:4' });
  assert.equal(legacy.status, 'found');
  assert.equal(legacy.matchedBy, 'legacy-filename');
  assert.match(legacy.note, /兼容推断/);
  assert.match(legacy.note, /不是内部元数据验证/);

  // ⑤ 内部键不是字符串（数字）⇒ 坏档，**不许**当"没有键"回退到文件名
  W('group_5.json', { chatKey: 12345, messages: [msg('f', 5000, '数字键')] });
  const bad = readChatArchive({ dataDir: dir, chatKey: 'group:5' });
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.reason, 'invalid-inner-chat-key');
  assert.deepEqual(bad.messages, []);

  // ⑥ 没有这个会话的存档
  const missing = readChatArchive({ dataDir: dir, chatKey: 'group:99' });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'chat-archive-missing');

  // ⑦ 文件损坏（名字对上、内容不是 JSON）
  fs.writeFileSync(path.join(mdir, 'group_6.json'), '{半截坏档', 'utf8');
  const corrupt = readChatArchive({ dataDir: dir, chatKey: 'group:6' });
  assert.equal(corrupt.status, 'unavailable');
  assert.equal(corrupt.reason, 'chat-archive-missing');
  assert.equal(corrupt.candidates[0].why, 'unreadable-or-corrupt');

  assert.ok(path.basename(dir).startsWith('mv-arch-'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('⑩ 路由级：存档内部会话与文件名冲突 ⇒ 一条原话都不返回，正文无该内容', async () => {
  const file = path.join(msgDir, `${CHAT.replace(':', '_')}.json`);
  const good = fs.readFileSync(file);
  const poisoned = JSON.parse(good.toString('utf8'));
  poisoned.chatKey = 'private:90000001';
  poisoned.messages = poisoned.messages.map((m) => ({ ...m, text: '私聊里的秘密不该出现在群里' }));
  fs.writeFileSync(file, JSON.stringify(poisoned), 'utf8');
  try {
    const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
    const res = await call(`/facts/evidence?key=${q(slot.key)}&withSource=1&chatKey=${q(CHAT)}`);
    assert.equal(res.status, 200);
    const win = res.body.sourceLookup.sources.find((s) => s.type === 'window');
    assert.equal(win.status, 'unavailable');
    assert.equal(win.reason, 'chat-mismatch');
    assert.deepEqual(win.messages, []);
    assert.equal(win.matchedBy, null);
    assert.equal(win.candidates[0].innerChatKey, 'private:90000001');
    // 判据落在**响应正文**上，不只是 helper 的返回值
    assert.ok(!JSON.stringify(res.body).includes('私聊里的秘密'), '响应正文里不许出现被拒存档的内容');
    // 这条路径同样不许把证据等级改掉
    assert.equal(res.body.state, 'window-match');
  } finally {
    fs.writeFileSync(file, good);
  }
});

test('⑪ 路由级：同名文件矛盾、另一个文件内部正确 ⇒ 只回正确会话的原话', async () => {
  const file = path.join(msgDir, `${CHAT.replace(':', '_')}.json`);
  const good = fs.readFileSync(file);
  const poisoned = JSON.parse(good.toString('utf8'));
  const row = poisoned.messages[0];
  poisoned.chatKey = 'private:90000002';
  poisoned.messages = poisoned.messages.map((m) => ({ ...m, text: '矛盾文件里的内容' }));
  fs.writeFileSync(file, JSON.stringify(poisoned), 'utf8');
  // 另起一个文件名，内部会话键是对的
  const moved = path.join(msgDir, 'zz_moved_archive.json');
  fs.writeFileSync(moved, JSON.stringify({
    chatKey: CHAT,
    messages: [{ id: row.id, ts: row.ts, senderId: row.senderId, senderName: row.senderName, text: '正确存档里的原话' }]
  }), 'utf8');
  try {
    const slot = [...factStoreOf(rt).slots.values()].find((s) => s.fact_kind === 'trait');
    const res = await call(`/facts/evidence?key=${q(slot.key)}&withSource=1&chatKey=${q(CHAT)}`);
    assert.equal(res.status, 200);
    const win = res.body.sourceLookup.sources.find((s) => s.type === 'window');
    assert.equal(win.status, 'found');
    assert.equal(win.file, 'zz_moved_archive.json');
    assert.equal(win.matchedBy, 'inner-chat-key');
    assert.ok(win.messages.some((m) => m.text.includes('正确存档里的原话')));
    assert.ok(!JSON.stringify(res.body).includes('矛盾文件里的内容'));
  } finally {
    fs.rmSync(moved, { force: true });
    fs.writeFileSync(file, good);
  }
});
