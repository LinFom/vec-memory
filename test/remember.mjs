// test/remember.mjs —— 写侧端点 `/remember`：模型在对话里直写一条事实。
//
// 与 `inject.mjs` 的分工：那个测**读侧纯函数**（候选挑选 / 渲染），这个测**端点**——
// 参数校验、占位符化、幂等、scope 派生。这些行为**只有走一遍 `handleMemoryVec` 才看得见**
// （纯函数层盖不住，因为它们横跨"请求解析 → 归一化 → 落库 → 返回"四段）。
//
// 两条纪律：
//   · 用**临时 dataRoot**（`os.tmpdir()`）⇒ 一个字节都不碰真库。在真库里跑测试会往
//     用户的事实层写测试数据，而事实层是 append-only 的：写进去就留痕。
//   · 写侧的失败**必须是可断言的**。读侧可以静默降级（少一段背景），写侧不能 ——
//     静默的写失败 = 模型以为记住了、实际没有。所以每条拒绝路径都断言了 status 与文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-remember-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 先等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束。
// 它会从 sourceRoot 扫存档**重建词表并覆盖**已装的那份（`backend.mjs:341`）；
// 临时 dataRoot 下它扫不到东西 ⇒ 装成空表 ⇒ 把下面这份测试词表冲掉。
// 症状很隐蔽：手工 `resolveKnown('qq:…')` 命中，走 `handle` 却报"认不出这个 QQ 号"
// —— 因为两次调用之间词表被换了。判据用 `lastIdentityCheck`：它在装载与跳过两条
// 分支上都会写（`backend.mjs:328/362`），是"这一次跑完了"的可靠信号。
const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

// 空目录没有词表 ⇒ 装一个最小的，够 `resolveKnown` 认出人即可。
// 这一步不是"为了让测试跑通"，而是**被测行为的一部分**：写侧不肯拿昵称当身份，
// 认不出人就拒绝 —— 下面第一组就断言了这条。
rt.normalizer.setVocabulary([
  { id: 'qq:1006837688', kind: 'person', surface: ['测试群友', '群友甲'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);

const GROUP = 'group:1098345913';
const UID = '1006837688';
const post = (body) => router.handle({ method: 'POST', path: '/remember', body });

test('拒绝路径：每条都给出可行动的原因（写侧不允许静默失败）', async () => {
  const noKey = await post({});
  assert.equal(noKey.status, 400);
  assert.match(noKey.body.error, /chatKey/, '缺 chatKey 要指名道姓');

  const badId = await post({ chatKey: GROUP, userId: 'abc', text: 'x' });
  assert.equal(badId.status, 400);
  assert.match(badId.body.error, /QQ 号/);

  const unknown = await post({ chatKey: GROUP, userId: '1000000001', text: 'x' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /认不出/, '词表里没有的 QQ ⇒ 拒绝，不许猜');
  assert.match(unknown.body.error, /昵称/, '要给出"别改用昵称"的理由');

  const emptyText = await post({ chatKey: GROUP, userId: UID, text: '   ' });
  assert.equal(emptyText.status, 400);

  const badKind = await post({ chatKey: GROUP, userId: UID, text: 'x', kind: 'pattern' });
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /kind/, 'pattern 是成簇判定产的，不接受直写');
});

test('写入：speaker 落成占位符，正文出境前已归一化', async () => {
  const r = await post({ chatKey: GROUP, userId: UID, text: '偏好买断制单机' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, 'update');
  assert.match(r.body.speaker, /^P\d+$/, 'speaker 必须是占位符，不是 QQ 号');
  assert.equal(r.body.previous, null);

  const n = await post({
    chatKey: GROUP, userId: UID, kind: 'speaker_profile',
    text: '群友甲[CQ:at,qq=1006837688] 是夜猫子'
  });
  assert.equal(n.body.identityRewritten, true, '文本里出现过真实身份 ⇒ 标记为真');
  assert.ok(!n.body.text.includes('群友甲'), '真名已被替换');
  assert.ok(!n.body.text.includes('1006837688'), 'QQ 号已被替换');
});

test('幂等：同内容重写是 noop（rev 不变）', async () => {
  // 这条守的是 `content` 的**确定性**：第一版把 `at: new Date().toISOString()` 塞进
  // content，而 content 进 `contentFingerprint` ⇒ 指纹每次都变 ⇒ noop 永不生效、
  // 同一条事实重复记会无界涨版本（实测 rev 1→2）。时间戳现在只落 `derived_from.at`。
  const a = await post({ chatKey: GROUP, userId: UID, text: '幂等样本', kind: 'topic' });
  const b = await post({ chatKey: GROUP, userId: UID, text: '幂等样本', kind: 'topic' });
  assert.equal(a.body.action, 'update');
  assert.equal(b.body.action, 'noop');
  assert.equal(b.body.saved, false);
  assert.equal(b.body.rev, a.body.rev, 'noop 不涨版本');
});

test('同类覆盖：把被替换掉的旧条目回报出来（不静默丢）', async () => {
  await post({ chatKey: GROUP, userId: UID, text: '第一版喜好', kind: 'preference' });
  const r = await post({ chatKey: GROUP, userId: UID, text: '第二版喜好', kind: 'preference' });
  assert.equal(r.body.action, 'update');
  assert.equal(r.body.previous.text, '第一版喜好');
  assert.equal(r.body.previous.source, 'assistant-remember', '来源要能认出来');
});

test('证据集变化 ⇒ 重判（同内容也算新版本）', async () => {
  const a = await post({ chatKey: GROUP, userId: UID, text: '证据样本', kind: 'promise' });
  const b = await post({ chatKey: GROUP, userId: UID, text: '证据样本', kind: 'promise', evidence: ['m1'] });
  assert.equal(a.body.action, 'update');
  assert.equal(b.body.action, 'update', '证据集变了就是一次新的判断');
  assert.equal(a.body.evidenceN, 1, '没给证据时记一条来源标记 self-report');
});

test('scope 是身份的一部分：换个会话就是新槽，不是覆盖', async () => {
  const a = await post({ chatKey: GROUP, userId: UID, text: '跨群样本', kind: 'event' });
  const b = await post({ chatKey: 'group:999999999', userId: UID, text: '跨群样本', kind: 'event' });
  assert.equal(a.body.previous, null);
  assert.equal(b.body.previous, null, '另一个群 ⇒ 另一个槽（"在哪儿说的"是身份）');
});
