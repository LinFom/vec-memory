// test/trait.mjs —— 固定特征档案层（`fact_kind:'trait'`，`ADR-0031`）+ 多值槽机制（`ADR-0044`，⑥段）
//
// 为什么单独一个文件：`trait` 是**第一个** content 为多值列表的 kind（`ADR-0044` 起
// `speaker_profile` 也并入同一机制），它的三条性质都无法从既有测试推出来 ——
//   ① **并存**（同一人的多个属性互不覆盖，而其余 kind 是"同槽只剩一条"）；
//   ② **latest-wins**（靠 evidence_n 恒 1 让 evidence-max 口径退化成"最新赢"）；
//   ③ **独立注入**（不参与相似度排序、不占属性段的 `perPerson` 配额）。
// 这三条都横跨"请求解析 → 落库 → 聚合 → 注入"四段 ⇒ 纯函数层盖不住，走端点测。
//
// 纪律（同 `test/remember.mjs`）：
//   · **临时 dataRoot**，一个字节都不碰真库（事实层 append-only，写进去就留痕）；
//   · 写侧失败必须可断言（status + 文案），读侧才允许静默降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf } from '../src/core/backend.mjs';
import {
  renderProfileLine, buildProfileCandidates, buildInjectCandidates,
  renderCombinedBlock, normalizeTraitKey, isMultiValueTrait, mergeMultiValue, TRAIT_PER_PERSON,
  profileScopeAllowed, PROFILE_SCOPE_ALL,
  renderAttributeLine, upsertSlotItem, slotItems, LEGACY_ITEM_KEY
} from '../src/core/inject.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-trait-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束 —— 它会重建词表并
// 覆盖已装的那份（详见 `test/remember.mjs` 的同名注释）。不等 ⇒ `resolveKnown` 时灵时不灵。
const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

rt.normalizer.setVocabulary([
  { id: 'qq:1006837688', kind: 'person', surface: ['测试群友', '群友甲'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);

const GROUP = 'group:1098345913';
const UID = '1006837688';
const PEOPLE = [{ id: UID, name: '测试群友' }];
const post = (p, body) => router.handle({ method: 'POST', path: p, body });

// ⚠️ 占位符 label（`P7129` 这种）是**动态生成**的 ⇒ 必须现场取，不能硬编码。
// 且 `resolveKnown` 认的是 `qq:` 前缀形态（与 `/remember` 端点同一个口径）。
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
const SCOPE = rt.normalizer.scopeLabel(GROUP);
assert.ok(LABEL, '测试前提：词表里能认出这个 QQ 号');
assert.ok(SCOPE, '测试前提：scope 能从 chatKey 派生');

// ═══════════════════════════════════════════════════════════════════════════
// ① 纯函数：属性名归一化 / 档案行渲染
// ═══════════════════════════════════════════════════════════════════════════

test('normalizeTraitKey：折空白 + 全角冒号转半角 ⇒ "职业 " 与 "职业" 是同一个属性', () => {
  assert.equal(normalizeTraitKey('职业'), '职业');
  assert.equal(normalizeTraitKey(' 职业 '), '职业');
  assert.equal(normalizeTraitKey('职 业'), '职业');
  assert.equal(normalizeTraitKey('爱好：'), '爱好:');
});

test('renderProfileLine：多值渲染成 `k=v / k=v`；空槽 / 缺值 ⇒ null', () => {
  const line = renderProfileLine({ content: { items: [{ k: '职业', v: '程序员' }, { k: '年龄', v: '25' }] } });
  assert.equal(line, '职业=程序员 / 年龄=25');

  assert.equal(renderProfileLine({ content: { items: [] } }), null);
  assert.equal(renderProfileLine({ content: {} }), null);
  assert.equal(renderProfileLine({}), null);
  // 值缺失的条目跳过，但不影响其它条目
  assert.equal(renderProfileLine({ content: { items: [{ k: '职业', v: '' }, { k: '年龄', v: '25' }] } }), '年龄=25');
});

test(`renderProfileLine：一人最多 ${TRAIT_PER_PERSON} 条（兜住 prompt 预算）`, () => {
  const items = Array.from({ length: TRAIT_PER_PERSON + 3 }, (_, i) => ({ k: `a${i}`, v: `v${i}` }));
  const line = renderProfileLine({ content: { items } });
  assert.equal(line.split(' / ').length, TRAIT_PER_PERSON);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 端点：写入 —— 并存 / 覆盖 / 幂等
// ═══════════════════════════════════════════════════════════════════════════

test('拒绝路径：kind=trait 但没给 attr ⇒ 400 且指名道姓（写侧不许静默失败）', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', text: '程序员' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /attr/, '要说明缺的是 attr');
  assert.match(r.body.error, /挤掉/, '要说明后果：整槽覆盖会把别的属性挤掉');
});

test('① 并存：同一个人的多个属性**互不覆盖**（这是 trait 与其余 kind 的根本区别）', async () => {
  const a = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '职业', text: '程序员' });
  const b = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '年龄', text: '25' });
  const c = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '忌口', text: '香菜' });
  for (const r of [a, b, c]) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'update', '首见 ⇒ 记账');
  }

  const store = factStoreOf(rt);
  const slot = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  assert.ok(slot, 'trait 槽存在');
  assert.equal(slot.content.items.length, 3, '三条属性并存，不是只剩最后一条');
  const kv = Object.fromEntries(slot.content.items.map((x) => [x.k, x.v]));
  assert.deepEqual(kv, { 职业: '程序员', 年龄: '25', 忌口: '香菜' });
});

test('② 覆盖：同 attr 再写 ⇒ 更新该条，其余**不受影响**；回执带旧值', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '职业', text: '产品经理' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'update');
  assert.equal(r.body.attr, '职业', '回执带 attr —— 适配层靠它区分"属性更新"与"整条替换"');
  assert.equal(r.body.previous?.text, '程序员', '回执要给出被替换掉的旧值');

  const store = factStoreOf(rt);
  const slot = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  const kv = Object.fromEntries(slot.content.items.map((x) => [x.k, x.v]));
  assert.equal(slot.content.items.length, 3, '仍是 3 条，没把别的属性顶掉');
  assert.deepEqual(kv, { 职业: '产品经理', 年龄: '25', 忌口: '香菜' });
});

test('③ 幂等：同 attr 同值重写 ⇒ noop（items 不带时间戳，指纹才稳）', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '职业', text: '产品经理' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'noop', '值没变 ⇒ 不写盘、rev 不涨');
});

test('④ latest-wins：evidence_n **恒为 1** ⇒ evidence-max 退化为"最新赢"（档案会过期）', async () => {
  const store = factStoreOf(rt);
  const key = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE })?.key;
  const versions = store.versionsOf(key);
  assert.ok(versions.length >= 4, `应有多次写入（实测 ${versions.length}）`);
  for (const v of versions) {
    assert.equal(v.evidence_n, 1, `每个版本 evidence_n 都必须是 1（实测 ${v.evidence_n}）—— 否则聚合会挑错赢家`);
  }
  // 赢家 = rev 最大者（平票取最新），而不是 evidence 最多的那个
  const winner = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  const maxRev = Math.max(...versions.map((v) => Number(v.rev) || 0));
  assert.equal(Number(winner.rev), maxRev, '赢家必须是 rev 最大的版本');
  assert.equal(
    Object.fromEntries(winner.content.items.map((x) => [x.k, x.v]))['职业'],
    '产品经理',
    '职业的最新值是"产品经理"（"程序员"已过期）'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ②之二 软词表：多值累加 / 单值覆盖 / 别名归并
// ═══════════════════════════════════════════════════════════════════════════

test('多值属性**累加**不覆盖：爱好=画画 → 再写 爱好=打游戏 ⇒ "画画、打游戏"', async () => {
  const a = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '爱好', text: '画画' });
  assert.equal(a.body.action, 'update');
  const b = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '爱好', text: '打游戏' });
  assert.equal(b.body.action, 'update');
  assert.equal(b.body.previous?.text, '画画', '回执给出累加前的旧值');

  const store = factStoreOf(rt);
  const slot = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  const hobby = slot.content.items.find((x) => x.k === '爱好');
  assert.equal(hobby?.v, '画画、打游戏', '两个爱好都在 —— 覆盖掉前面一个就是丢东西');
  assert.equal(slot.content.items.filter((x) => x.k === '爱好').length, 1, '合并成**一条**（渲染成 `爱好=画画、打游戏`）');
});

test('多值累加**去重**：重复写同一个值 ⇒ noop', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '爱好', text: '画画' });
  assert.equal(r.body.action, 'noop', '值已存在 ⇒ 指纹不变 ⇒ 不写盘');
});

test('单值属性仍是**覆盖**（换工作就是换工作，不是累加）', async () => {
  // 上面的 latest-wins 用例已覆盖职业的覆盖；这里确认单值/多值走的是两条分支
  assert.equal(isMultiValueTrait('职业'), false);
  assert.equal(isMultiValueTrait('爱好'), true);
});

test('别名归一："工作" ⇒ 落到 "职业"（不归并就要分裂成两条）', async () => {
  const r = await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '工作', text: '设计师' });
  assert.equal(r.body.attr, '职业', '写入时就把别名并到规范名');
  assert.equal(r.body.previous?.text, '产品经理', '归并后命中的是同一个"职业"槽，旧值被带出来');

  const store = factStoreOf(rt);
  const slot = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  assert.ok(!slot.content.items.some((x) => x.k === '工作'), '库里不该留下"工作"这个别名');
  assert.equal(Object.fromEntries(slot.content.items.map((x) => [x.k, x.v]))['职业'], '设计师');
});

test('mergeMultiValue：拆开去重再拼回，顺序按出现先后', () => {
  assert.equal(mergeMultiValue('画画', '打游戏'), '画画、打游戏');
  assert.equal(mergeMultiValue('画画、打游戏', '看番'), '画画、打游戏、看番');
  assert.equal(mergeMultiValue('画画、打游戏', '画画'), '画画、打游戏', '重复的不再加一遍');
  assert.equal(mergeMultiValue('', '画画'), '画画');
  assert.equal(mergeMultiValue('a, b', 'c'), 'a、b、c', '逗号/顿号都认');
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 注入：档案段独立成块、不占属性配额
// ═══════════════════════════════════════════════════════════════════════════

test('buildInjectCandidates **排除** trait；buildProfileCandidates **只要** trait', async () => {
  const store = factStoreOf(rt);
  await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '爱喝美式' });

  const winners = [...store.slots.values()];
  // ⚠️ 必须**手工补一个带 `content.text` 的 trait 槽**。真库里的 trait 只有 `items`、
  //    没有 `text` ⇒ `renderAttributeLine` 本来就渲染不出东西 ⇒ "属性段不含 trait"
  //    这条断言**恒真**，是**假通过**（突变验证实测：把那道过滤删掉，测试照样全绿）。
  //    只有造出"能渲染、却仍不该进属性段"的槽，才真的测得到过滤存在。
  winners.push({
    key: 'fake-trait-with-text', speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE,
    content: { text: '不该进属性段', items: [{ k: '职业', v: '程序员' }] },
    evidence_n: 1, rev: 1, caliber: 'evidence-max'
  });

  const attrCands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: rt.normalizer });
  // ⚠️ `nowScope` 必须传：场合隔离是**默认闭**的（拿不到场合 ⇒ 一条都不给）。
  const profCands = buildProfileCandidates({
    winners, people: PEOPLE, normalizer: rt.normalizer, nowScope: SCOPE
  });

  assert.ok(attrCands.length > 0, 'preference 槽应产出属性候选');
  assert.ok(!attrCands.some((c) => c.rec?.fact_kind === 'trait'),
    'trait **不得**混进属性段 —— 否则会占 perPerson 配额并被 pattern 槽挤掉');
  assert.ok(!attrCands.some((c) => c.line === '不该进属性段'),
    '即使 trait 槽带 content.text 也**不许**渲染进属性段（过滤要在渲染之前，不是靠渲染失败兜底）');
  assert.ok(profCands.length > 0, 'trait 槽应产出档案候选');
  assert.ok(profCands.every((c) => c.rec?.fact_kind === 'trait'), '档案段只装 trait');
});

test('档案段**不占**属性段配额：属性段满额时档案照样注入', async () => {
  // 属性段用不同 kind 造出 ≥3 个候选，再逼 perPerson=1 ⇒ 属性只出 1 条。
  await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '爱喝美式' });
  await post('/remember', { chatKey: GROUP, userId: UID, kind: 'topic', text: '常聊显卡' });
  await post('/remember', { chatKey: GROUP, userId: UID, kind: 'promise', text: '答应借我书' });

  const r = await post('/inject', { chatKey: GROUP, people: PEOPLE, perPerson: 1, total: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.lines.length, 1, '属性段被 perPerson=1 截到 1 条');
  assert.equal(r.body.profileLines.length, 1, '档案段**照样**注入 —— 配额互不挤占');
  assert.match(r.body.block, /【档案/, '块里有档案段');
  // ⚠️ 不断言职业的**具体值**（前面的别名用例会改它），只断言"块里就是槽里的当前值"
  //    —— 这条用例要验的是"配额互不挤占"，不是值本身，硬编码一个值只会让两条用例互相绊倒。
  const slot = factStoreOf(rt).getSlot({ speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE });
  const cur = Object.fromEntries(slot.content.items.map((x) => [x.k, x.v]))['职业'];
  assert.match(r.body.block, new RegExp(`职业=${cur}`), '档案行内容 = 槽里的当前值');
});

test('档案段**不算相似度**：没有 topic 也注入（固定特征与话题无关）', async () => {
  const r = await post('/inject', { chatKey: GROUP, people: PEOPLE });
  assert.equal(r.status, 200);
  assert.equal(r.body.profileLines.length, 1, '不传 topic ⇒ sims 为 null ⇒ 属性段无 hot，但档案段照常');
  // 没传 topic ⇒ `no-topic`（以前是 `embed-unavailable`，把"没试"说成了"端点坏了"）
  assert.equal(r.body.simNote, 'no-topic', '本用例确实没算相似度（没传 topic，不是端点不可用）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 场合隔离（`ADR-0031` §3.8）：档案只在**学到它的那个场合**出现
//
// 为什么单独一节：这条的失败形态是**静默的** —— 记过了、槽在、但换个场合就没了，
// 没有任何报错。所以每条用例都同时断言"该出现的出现"和"该消失的消失"，
// 只验一边（比如只验"同群能注入"）挡不住把隔离整个删掉。
// ═══════════════════════════════════════════════════════════════════════════

const GROUP_B = 'group:2000000001';          // 另一个群（不必进词表：`scopeLabel` 是 hmac 派生的）
const PRIV = `private:${UID}`;               // 与这个人的私聊
const SCOPE_B = rt.normalizer.scopeLabel(GROUP_B);
const SCOPE_P = rt.normalizer.scopeLabel(PRIV);

test('profileScopeAllowed：纯函数判据（同场合放行 / 跨场合挡 / SELF 放行 / 场合不明挡）', () => {
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: SCOPE }), true, '同场合');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: SCOPE_B }), false, '群 A → 群 B');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE_P, nowScope: SCOPE }), false, '私聊 → 群（最要命的一条）');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: SCOPE_P }), false, '群 → 私聊');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE_P, nowScope: SCOPE_P }), true, '同私聊');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: SCOPE_B, isSelf: true }), true,
    'bot 自己的档案不禁（隐私边界保护的是他人，且 `## 自我印象` 本来就是全局的）');
  // fail-closed：场合不明 ⇒ 不敢放行（漏出信息比少给一行严重）
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: '' }), false, '当前场合不明');
  assert.equal(profileScopeAllowed({ slotScope: '', nowScope: SCOPE }), false, '槽自己没记场合');
  assert.equal(profileScopeAllowed({ slotScope: SCOPE, nowScope: PROFILE_SCOPE_ALL }), true, '诊断旁路');
});

test('档案**跟着场合走**（strict 模式）：群 A 学的在群 B 与私聊都消失', async () => {
  // ⚠️ 2026-10-18 起服务端默认 `profileCrossScope: true`（档案跨场合）。
  //    本节验的是**关掉开关后**的旧行为 ⇒ 必须每次显式送 `false`，
  //    否则测的是另一套策略（而且会"看起来全绿"—— 那种通过没有意义）。
  const r1 = await post('/inject', { chatKey: GROUP, people: PEOPLE, profileCrossScope: false });
  assert.equal(r1.body.profileLines.length, 1, '群 A：档案在');
  assert.equal(r1.body.profileCrossScope, false, '响应要回报实际生效的策略（否则"档案没了"查不出原因）');

  const r2 = await post('/inject', { chatKey: GROUP_B, people: PEOPLE, profileCrossScope: false });
  assert.equal(r2.body.profileLines.length, 0, '群 B：**没有** —— 那里的人当时不在场');
  assert.equal(r2.body.profileBlockedByScope, 1, '被场合挡掉 1 条（要能看见"是被挡了"，不是"没记过"）');
  assert.ok(!/【档案/.test(r2.body.block), '块里也不许出现档案段');

  const r3 = await post('/inject', { chatKey: PRIV, people: PEOPLE, profileCrossScope: false });
  assert.equal(r3.body.profileLines.length, 0, '私聊：**没有** —— 群里听来的不带进私聊');
  assert.equal(r3.body.profileBlockedByScope, 1);

  // ⚠️ 属性段**不受影响**（跨场合注入是既有默认行为，且现网群聊注入全靠它）⇒ 这条是护栏
  assert.ok(r2.body.candidates > 0, '同一请求里属性段候选照常 —— 隔离只管档案段');
});

test('私聊学的档案**绝不**进群（strict 模式，最关键的一条防护）', async () => {
  const w = await post('/remember', { chatKey: PRIV, userId: UID, kind: 'trait', attr: '所在地', text: '成都' });
  assert.equal(w.status, 200, `写入要成功（${JSON.stringify(w.body)}）`);

  const inPriv = await post('/inject', { chatKey: PRIV, people: PEOPLE, profileCrossScope: false });
  assert.match(inPriv.body.block, /所在地=成都/, '同一个私聊：看得到');

  // ⚠️ 别拿 **群 A** 验"档案段整个消失" —— 前面的用例在群 A 学过职业/爱好等，
  //    那里的档案段本来就该在。要验"这条到不了群里" ⇒ 用**没学过任何档案**的群 B。
  const inGroupB = await post('/inject', { chatKey: GROUP_B, people: PEOPLE, profileCrossScope: false });
  assert.equal(inGroupB.body.profileLines.length, 0, '群 B：连档案段都没有');
  assert.ok(!/所在地=成都/.test(inGroupB.body.block));

  // 群 A：档案段在（它自己学过），但**私聊那条**不在 —— 同一场合的档案互不串。
  const inGroupA = await post('/inject', { chatKey: GROUP, people: PEOPLE, profileCrossScope: false });
  assert.equal(inGroupA.body.profileLines.length, 1, '群 A 自己的档案照常');
  assert.ok(!/所在地=成都/.test(inGroupA.body.block), '私聊学的所在地**不串**进群 A');
  assert.equal(inGroupA.body.profileBlockedByScope, 1, '正是那条所在地被挡了');
});

// ── 跨场合（2026-10-18 用户拍板，默认开）──────────────────────────────────
// 起的因：私聊说「我 21 岁」→ 群里问就答不出（`blocked=4`、`profileLines:[]`），
// 而人对自己的年龄没有「只能在哪说」的预期。双向断言：既要证明打开后**真的跨过去**，
// 也要证明关掉后**真的挡住**——只验一边 = 把闸门拆了或者焊死都能全绿。
test('显式旧开关 true：私聊学的档案进群、群 A 学的进群 B（兼容旧配置）', async () => {
  const inGroupB = await post('/inject', { chatKey: GROUP_B, people: PEOPLE, profileCrossScope: true }); // 新安装默认另由 memory-core-api 覆盖
  assert.equal(inGroupB.body.profileCrossScope, true, '显式旧键 true 必须仍映射为 all');
  assert.match(inGroupB.body.block, /所在地=成都/, '私聊记的所在地，群 B 也用得上');
  assert.equal(inGroupB.body.profileBlockedByScope, 0, '开关打开后这个计数恒 0 —— 因此响应里的 profileCrossScope 才是判据');

  const inPriv = await post('/inject', { chatKey: PRIV, people: PEOPLE, profileCrossScope: true });
  assert.match(inPriv.body.block, /职业=设计师/, '群 A 学的职业，私聊里也认得出');

  // 显式 `false` 必须能**盖掉**服务端默认 —— 否则面板上"取消勾选"是无声失效
  const off = await post('/inject', { chatKey: GROUP_B, people: PEOPLE, profileCrossScope: false });
  assert.equal(off.body.profileCrossScope, false);
  assert.equal(off.body.profileLines.length, 0, '传 false ⇒ 立刻退回场合隔离（同一份库里同一批槽）');
});

test('跨场合打开也**不放行场合不明**（nowScope 空 ⇒ 仍然 fail-closed）', async () => {
  const r = await post('/inject', { people: PEOPLE, profileCrossScope: true });
  assert.equal(r.body.profileLines.length, 0, '没 chatKey 就无法证明"在场的人没变" ⇒ 一条都不给');
  assert.equal(r.body.profileScope, null);
});

test('SELF 档案**不受**场合隔离：换个群也在', async () => {
  // `/remember` 只能写词表里认得出的 QQ 号 ⇒ bot 自己的档案**手工造槽**（同 ③ 节的手法）。
  const winners = [
    { key: 'self-trait', speaker: 'SELF', target: '', fact_kind: 'trait', scope: SCOPE,
      content: { items: [{ k: '职业', v: '猫娘' }] }, evidence_n: 1, rev: 1, caliber: 'evidence-max' }
  ];
  const inB = buildProfileCandidates({ winners, people: PEOPLE, normalizer: rt.normalizer, nowScope: SCOPE_B });
  assert.equal(inB.length, 1, '自己的档案在群 B 照常 —— 不存在扩散，禁掉只会让 bot 失忆');
});

test('没传 chatKey ⇒ 档案段为空（`profileScope:null`），且**不静默**', async () => {
  const r = await post('/inject', { people: PEOPLE });
  assert.equal(r.status, 200);
  assert.equal(r.body.profileLines.length, 0, '场合不明 ⇒ 一条都不给（fail-closed）');
  assert.equal(r.body.profileScope, null, '显式告诉我"场合没拿到" —— 否则只能猜');
  assert.ok(r.body.profileBlockedByScope > 0, '并给出被挡掉的条数');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 块渲染：哨兵唯一（宿主判重靠它）
// ═══════════════════════════════════════════════════════════════════════════

test('renderCombinedBlock：哨兵**只出现一次**、在最前；档案在属性之前', () => {
  const prof = [{ who: '甲', line: '职业=程序员' }];
  const attr = [{ who: '甲', line: '爱喝美式' }];

  const both = renderCombinedBlock({ profileLines: prof, lines: attr });
  const hits = both.match(/<!--mv-inject-->/g) || [];
  assert.equal(hits.length, 1, '两段各带一个哨兵会让宿主的判重只挡住第一段');
  assert.ok(both.startsWith('<!--mv-inject-->'), '哨兵必须在最前');
  assert.ok(both.indexOf('【档案') < both.indexOf('【人格属性'), '档案在前：先交代这人是谁');

  // 只有一段时也要带哨兵
  const onlyProf = renderCombinedBlock({ profileLines: prof, lines: [] });
  assert.match(onlyProf, /^<!--mv-inject-->/);
  assert.ok(!/【人格属性/.test(onlyProf), '没有属性行 ⇒ 不渲染空段');
  const onlyAttr = renderCombinedBlock({ profileLines: [], lines: attr });
  assert.match(onlyAttr, /^<!--mv-inject-->/);
  assert.ok(!/【档案/.test(onlyAttr));

  assert.equal(renderCombinedBlock({}), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ speaker_profile 也是多值槽：按「方面」并存（2026-10-22）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么和 trait 放同一个文件：两者现在是**同一套机制**（`upsertSlotItem`）的两个用户，
// 区别只在项名（属性名 vs 方面名）。分开写会让「项级 upsert 的性质」各被验一半。
//
// 被测的关键失败形态：槽键是 `(speaker, target, kind, scope)` ⇒ **一个 kind 一个槽**。
// 若内容是一句话，"说话风格"与"对某人的态度"就互相顶掉 —— 而旧系统 `people/*.json`
// 的 `impressions[]` 是**数组**（一人可躺 4 条）。这是"印象比旧版少"的结构性原因。
// 这个失败**完全静默**：写入成功、status 200、条数看起来正常，只是别的那条没了。

const SP = (o) => post('/remember', { chatKey: GROUP, userId: UID, kind: 'speaker_profile', ...o });

test('⑥a upsertSlotItem：不同方面并存 / 同方面覆盖 / 回执带旧值', () => {
  let r = upsertSlotItem(null, '说话风格', '爱用短句');
  assert.deepEqual(r.items, [{ k: '说话风格', v: '爱用短句' }]);
  assert.equal(r.created, true);
  assert.equal(r.previousValue, '');

  let prev = { content: { items: r.items } };
  r = upsertSlotItem(prev, '对某个人的态度', '常和酥鱼互怼');
  assert.equal(r.items.length, 2, '不同方面必须并存');

  prev = { content: { items: r.items } };
  r = upsertSlotItem(prev, '说话风格', '爱用短句、爱反问');
  assert.equal(r.items.length, 2, '同方面是覆盖，不能新增一条');
  assert.equal(r.previousValue, '爱用短句');
  assert.deepEqual(r.items.find((x) => x.k === '说话风格'), { k: '说话风格', v: '爱用短句、爱反问' });
});

test('⑥b 旧槽 `{text}` 迁进项级结构 ⇒ 落到「整体」，那句总印象不丢', () => {
  const legacy = { content: { text: '说话损但不真生气' } };
  assert.deepEqual(slotItems(legacy), [{ k: LEGACY_ITEM_KEY, v: '说话损但不真生气' }]);

  const r = upsertSlotItem(legacy, '爱好倾向', '爱看冷知识');
  assert.equal(r.items.length, 2, '旧的一句话要留着，新方面接在后面');
  assert.equal(r.items[0].k, LEGACY_ITEM_KEY);

  // `整体` 是**缺省方面** ⇒ 不给 aspect 的写入直接命中它（覆盖，而不是再加一条）
  const r2 = upsertSlotItem(legacy, '', '说话很损');
  assert.equal(r2.items.length, 1);
  assert.equal(r2.previousValue, '说话损但不真生气');
});

test('⑥c renderAttributeLine：多值槽渲染成 `方面：值；方面：值`，`整体` 不带前缀', () => {
  const one = renderAttributeLine({
    fact_kind: 'speaker_profile', content: { items: [{ k: LEGACY_ITEM_KEY, v: '说话损但不真生气' }] }
  });
  assert.equal(one, '说话损但不真生气', '唯一一项是「整体」时，读起来必须和旧的一句话完全一样');

  const two = renderAttributeLine({
    fact_kind: 'speaker_profile',
    content: { items: [{ k: '说话风格', v: '爱用短句' }, { k: '对某个人的态度', v: '常和酥鱼互怼' }] }
  });
  assert.equal(two, '说话风格：爱用短句；对某个人的态度：常和酥鱼互怼');

  assert.equal(renderAttributeLine({ fact_kind: 'speaker_profile', content: { items: [{ k: 'x', v: '' }] } }), null);
});

test('⑥d 端点：两方面并存 → 同方面覆盖（回执 aspect/itemKey，不冒充 attr）', async () => {
  const a = await SP({ aspect: '说话风格', text: '爱用短句、爱反问' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.aspect, '说话风格');
  assert.equal(a.body.itemKey, '说话风格');
  assert.equal(a.body.attr, undefined, 'aspect 不能冒充 attr —— 适配层按 attr 判 trait');

  const b = await SP({ aspect: '对某个人的态度', text: '常和酥鱼互怼，叫他小肥鱼' });
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const store = factStoreOf(rt);
  const keyOf = { speaker: LABEL, target: '', fact_kind: 'speaker_profile', scope: SCOPE };
  let slot = store.getSlot(keyOf);
  assert.equal(slot.content.items.length, 2, '两个方面必须并存（旧行为只剩最后一条）');

  const c = await SP({ aspect: '说话风格', text: '爱用短句、爱反问，偶尔押韵' });
  assert.equal(c.body.previous?.text, '爱用短句、爱反问', '回执要给出被替换掉的旧值');
  slot = store.getSlot(keyOf);
  assert.equal(slot.content.items.length, 2, '同方面覆盖，不能新增一条');
});

test('⑥e 端点：不给 aspect ⇒ 落到「整体」，且不挤掉已有方面', async () => {
  const r = await SP({ text: '整体上话不多但接梗很快' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.aspect, LEGACY_ITEM_KEY);

  const slot = factStoreOf(rt).getSlot({ speaker: LABEL, target: '', fact_kind: 'speaker_profile', scope: SCOPE });
  assert.equal(slot.content.items.length, 3, '前两个方面 + 整体 = 3');
  assert.ok(slot.content.items.some((x) => x.k === LEGACY_ITEM_KEY), '整体那一项要在');
});

test('⑥f latest-wins：多方面槽 evidence_n **恒为 1**（累积型内容的聚合口径）', () => {
  const store = factStoreOf(rt);
  const key = store.getSlot({ speaker: LABEL, target: '', fact_kind: 'speaker_profile', scope: SCOPE })?.key;
  const versions = store.versionsOf(key);
  assert.ok(versions.length >= 3, `应有多次写入（实测 ${versions.length}）`);
  for (const v of versions) {
    assert.equal(v.evidence_n, 1,
      `每个版本 evidence_n 都必须是 1（实测 ${v.evidence_n}）—— 否则聚合会挑证据更多的旧版本，新方面被静默丢掉`);
  }
});

test('⑥g 幂等：同方面同值重写 ⇒ noop（items 不带时间戳）', async () => {
  const r = await SP({ aspect: '说话风格', text: '爱用短句、爱反问，偶尔押韵' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'noop', '值没变 ⇒ 不写盘、rev 不涨');
});

test('⑥h 端到端 /inject：多方面槽进属性段，渲染成 `方面：值`；`整体` 不露字样', async () => {
  // ⚠️ `perPerson: 6`：本用例里同一个人还有 preference / topic / promise 三个槽，加上
  //    speaker_profile 共 4 个候选，evidence_n 全是 1（都走 self-report）⇒ **同分**，
  //    而截断是"顺序决定"（`inject.mjs:571` 记着的老问题：同分时一条会静默顶掉另一条）。
  //    这里要验的是**渲染形态**，不是配额 ⇒ 把配额放到最大，别让本用例替配额问题背锅。
  const r = await post('/inject', { chatKey: GROUP, people: PEOPLE, perPerson: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.lines.length > 0, `前提：属性段应有候选（实际 ${JSON.stringify(r.body.lines)}，candidates=${r.body.candidates}）`);
  assert.match(r.body.block, /说话风格：爱用短句/, '属性段要带方面前缀（否则三个方面连成一句读不通）');
  assert.match(r.body.block, /对某个人的态度：常和酥鱼互怼/);
  assert.match(r.body.block, /话不多但接梗很快/, '「整体」那一项的内容要在');
  assert.ok(!/整体：/.test(r.body.block), '「整体」是缺省项 —— prompt 里不该露出这个内部字样');
});

// 收尾清理临时目录（临时 dataRoot 不该留在磁盘上）
test.after(() => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});
