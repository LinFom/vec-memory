// test/person.mjs —— 人物卡（按人聚合的**只读视图**，`ADR-0032`）
//
// 为什么单独一个文件：这一层有四条性质，都不是既有测试能推出来的 ——
//   ① **索引只认 speaker、不认 target**（"对谁说的"不该把一个人的卡拆成多份）；
//   ② **按 scope 分栏**（继承 `ADR-0031 §3.8` 的场合隔离，面板侧同样不许合并）；
//   ③ **三种"没东西"必须可区分**（认不出这个人 / 词表里有但从没记过 / 记过但被场合分了栏）；
//   ④ **索引是派生量**（删了 `index.json` 重开要自愈，且**全扫兜底**本身是条正经行为）。
//
// 纪律（同 `test/trait.mjs`）：
//   · **临时 dataRoot**，一个字节都不碰真库；
//   · 写侧失败必须可断言，读侧只允许"明说"，不允许给一张空卡假装这人没被记过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf } from '../src/core/backend.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-person-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（详见 `test/trait.mjs`）。
const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

const UID = '1006837688';
const UID2 = '1006837689';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲甲', '甲甲甲'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙乙'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] },
  { id: 'group:2000000001', kind: 'group', surface: ['另一个群'] }
]);

const GROUP = 'group:1098345913';
const GROUP_B = 'group:2000000001';
const PRIV = `private:${UID}`;
const PEOPLE = [{ id: UID, name: '甲甲' }];
const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });

// ⚠️ 占位符是动态生成的 ⇒ 现场取，不硬编码。
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
const LABEL2 = rt.normalizer.resolveKnown(`qq:${UID2}`)?.label || '';
const SCOPE = rt.normalizer.scopeLabel(GROUP);
const SCOPE_B = rt.normalizer.scopeLabel(GROUP_B);
const SCOPE_P = rt.normalizer.scopeLabel(PRIV);
assert.ok(LABEL && LABEL2, '测试前提：两个人都能在词表里认出来');
assert.ok(SCOPE !== SCOPE_B && SCOPE !== SCOPE_P, '测试前提：三个场合互不相同');

// ═══════════════════════════════════════════════════════════════════════════
// ① 索引：只认 speaker，且是**派生量**
// ═══════════════════════════════════════════════════════════════════════════

// 甲：群 A 里两条（档案 + 偏好），私聊一条（档案）
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '职业', text: '程序员' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'trait', attr: '爱好', text: '画画' });
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '爱喝美式' });
await post('/remember', { chatKey: PRIV, userId: UID, kind: 'trait', attr: '所在地', text: '成都' });
// 乙：群 A 里一条
await post('/remember', { chatKey: GROUP, userId: UID2, kind: 'preference', text: '爱喝拿铁' });
// 甲对乙的一条（`target` 非空）——**不该**因此进乙的卡
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'promise', text: '答应借乙乙那本书' });

test('bySpeaker 索引：只认 speaker，target 不进索引；计数与槽数一致', () => {
  const store = factStoreOf(rt);
  // ⚠️ **必须手工造一个 `target` 非空的槽**。`/remember` 写出来的槽 `target` **恒为空**
  //    （它是说话人级的）⇒ 没有这个槽，"target 命中不进对方的卡"这条断言**恒真**：
  //    突变验证实测 —— M1 把 target 也塞进索引，测试照样全绿（**假通过**）。
  //    `test/trait.mjs` 踩过同一个坑（那边是"属性段不含 trait"恒真）。
  store.slots.set('fake-targeted', {
    key: 'fake-targeted', speaker: LABEL2, target: LABEL, fact_kind: 'preference', scope: SCOPE,
    content: { text: '乙对甲说的话' }, evidence_n: 1, rev: 1,
    caliber: 'evidence-max', content_fingerprint: 'fp-t'
  });
  store.recount();

  const mine = store.slotsOfSpeaker(LABEL);
  assert.equal(mine.length, 4, '甲：3 条群 A + 1 条私聊 —— 那条 target 指向甲的**不算**');
  assert.ok(mine.every((r) => String(r.speaker) === LABEL), '只返回 speaker 是自己的槽');
  assert.equal(store.slotsOfSpeaker(LABEL2).length, 2, '乙：自己的 1 条 + 这条（它才是 speaker）');
  // ⚠️ 这条是**索引本身**的断言。上面那几条挡不住"索引是空的"——因为
  //    `slotsOfSpeaker` 在索引缺失时会**全扫兜底**（故意的），所以只验返回值等于
  //    "索引压根没建"。必须直接问索引，且**要有非空 target 才问得出区别**。
  assert.equal(store.bySpeaker.get(LABEL)?.length, 4, '内存索引里甲仍是 4 —— 不是 5');
  assert.equal(store.index.by_speaker?.[LABEL], 4, '落盘的 index 里也记了 4');
  assert.equal(store.bySpeaker.get(LABEL2)?.length, 2, '那条归乙的卡，不归甲的');

  // 清干净，别影响后面的用例（派生量按真值重算，删掉再 recount 即可）
  store.slots.delete('fake-targeted');
  store.recount();
});

test('slotsOfSpeaker 的**全扫兜底**：索引清掉后结果不变（宁可慢也不能给空）', () => {
  const store = factStoreOf(rt);
  const before = store.slotsOfSpeaker(LABEL).map((r) => r.key).sort();
  store.bySpeaker.clear();                       // 模拟"索引没建起来"
  const after = store.slotsOfSpeaker(LABEL).map((r) => r.key).sort();
  assert.deepEqual(after, before, '索引缺失时退回全扫，结果**一样**');
  store.recount();
  assert.equal(store.bySpeaker.get(LABEL)?.length, 4, 'recount() 重建索引');
});

test('by_speaker 是真值派生：删掉 index.json 重开自愈', async () => {
  const store = factStoreOf(rt);
  const n = store.slotsOfSpeaker(LABEL).length;
  // 真值（slots.jsonl）不动，只删派生量文件
  fs.rmSync(path.join(dataRoot, 'memory-vec', 'facts', 'index.json'), { force: true });
  store.open();
  assert.equal(store.slotsOfSpeaker(LABEL).length, n, '重开从 slots.jsonl 重数一遍即自愈');
  assert.equal(store.bySpeaker.get(LABEL)?.length, n, '内存索引也随之重建');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 卡：分区 + 按 scope 分栏
// ═══════════════════════════════════════════════════════════════════════════

test('人物卡：档案 / 语用 / 事实三分区，且按场合分栏', async () => {
  const r = await get(`/person?who=${UID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.who.labels[0], LABEL, 'QQ 号能反解成标签');
  assert.deepEqual(r.body.who.names, ['甲甲', '甲甲甲'], '带出词表里的昵称（面板要显示人话）');

  // ── 分栏：群 A 一栏、私聊一栏 ──
  assert.equal(r.body.scopeCount, 2, '两个场合 ⇒ 两栏（**不许**合并成一张）');
  const colA = r.body.scopes.find((c) => c.scope === SCOPE);
  const colP = r.body.scopes.find((c) => c.scope === SCOPE_P);
  assert.ok(colA && colP, '两栏都能按 scope 找到');
  assert.equal(colA.kind, 'group');
  assert.equal(colP.kind, 'private');

  // ── 档案（trait → 结构化 k=v）──
  const ka = Object.fromEntries(colA.profile.map((x) => [x.k, x.v]));
  assert.equal(ka['职业'], '程序员');
  assert.equal(ka['爱好'], '画画');
  assert.ok(!('所在地' in ka), '私聊那栏的档案**不串**进群 A 栏');
  const kp = Object.fromEntries(colP.profile.map((x) => [x.k, x.v]));
  assert.equal(kp['所在地'], '成都');
  assert.ok(!('职业' in kp), '反向也不串');

  // ── 语用 vs 事实：preference 进事实区，不该混进画像区 ──
  assert.equal(colA.facets.length, 0, '群 A 里没有 pattern / speaker_profile 槽');
  assert.equal(colA.facts.length, 2, '群 A：preference + promise');
  assert.ok(colA.factsByKind.preference?.length === 1, '事实按 kind 分了组');
  assert.ok(colA.factsByKind.promise?.length === 1);
  assert.ok(!colA.facts.some((f) => f.kind === 'trait'), 'trait **不**混进事实区');
  assert.equal(colA.counts.profile, 2);
});

test('pattern 走专属渲染进**语用区**；trait 带 text 也**只**进档案区，不进事实区', async () => {
  const store = factStoreOf(rt);
  // pattern 不接受直写（成簇判定产的）⇒ 手工造槽（同 `test/trait.mjs` 的手法）。
  // ⚠️ 同时造一个 **`content.text` 非空** 的 trait 槽：真 trait 槽只有 `items`、
  //    没有 `text` ⇒ `renderAttributeLine` 本来就渲染不出东西 ⇒ "trait 不进事实区"
  //    这条断言**恒真**（突变验证实测：M4 把那道 `continue` 去掉，测试照样绿）。
  //    只有造出"能渲染、却仍不该进事实区"的槽，才真的测到分隔存在。
  const pat = {
    key: 'fake-pattern', speaker: LABEL, target: '', fact_kind: 'pattern', scope: SCOPE,
    content: { pattern_type: 'joke', exemplar: '又来了' }, evidence_n: 3, rev: 1,
    caliber: 'evidence-max', content_fingerprint: 'fp-pattern'
  };
  const trTxt = {
    key: 'fake-trait-with-text', speaker: LABEL, target: '', fact_kind: 'trait', scope: SCOPE,
    content: { text: '这条文本不该出现在事实区', items: [{ k: '星座', v: '天蝎' }] },
    evidence_n: 1, rev: 1, caliber: 'evidence-max', content_fingerprint: 'fp-tt'
  };
  for (const r of [pat, trTxt]) { store.slots.set(r.key, r); store.versions.set(r.key, [r]); }
  store.recount();

  const r = await get(`/person?who=${LABEL}`);
  const colA = r.body.scopes.find((c) => c.scope === SCOPE);

  // 语用区：pattern 走 `PATTERN_LABELS` 的专属渲染，不是 `content.text`
  const facet = colA.facets.find((f) => f.kind === 'pattern');
  assert.ok(facet, 'pattern 进**语用**区（不是事实区）');
  assert.match(facet.line, /爱开玩笑/, '走专属渲染，不是 content.text');

  // 档案区：那个 trait 槽**确实被处理了**（否则下面那条断言又是恒真）
  assert.ok(colA.profile.some((x) => x.k === '星座' && x.v === '天蝎'),
    '同一个 trait 槽进了档案区 —— 这条是下面"不进其它区"的**前提**');
  // ⚠️ 断言要扫**两个区**，不能只看 facts：`trait` 属于 `pragmatic` 段，一旦穿透
  //    那道 `continue`，它会先落进 **facets**（突变验证实测：只看 facts 抓不到 M4）。
  const nonProfile = [...colA.facets, ...colA.facts];
  assert.ok(!nonProfile.some((x) => /这条文本不该出现在事实区/.test(x.line)),
    'trait **即使带 `content.text`** 也不许混进语用区 / 事实区');
  assert.ok(!nonProfile.some((x) => x.kind === 'trait'), '两个区里都没有 trait');
  assert.ok(!colA.facts.some((f) => f.kind === 'pattern'), 'pattern 也不是"事实"');

  for (const x of [pat, trTxt]) { store.slots.delete(x.key); store.versions.delete(x.key); }
  store.recount();
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 三种"没东西"必须可区分（本功能最容易静默的地方）
// ═══════════════════════════════════════════════════════════════════════════

test('认不出这个人 ⇒ found:false + reason（**不是**一张空卡）', async () => {
  const r = await get('/person?who=99999999999');
  assert.equal(r.status, 200);
  assert.equal(r.body.found, false, '认不出要和"没记过"分开报');
  assert.ok(r.body.reason && /认不出/.test(r.body.reason), '必须说清为什么，别让调用方猜');
});

test('词表里有、但一条事实都没有 ⇒ found:true + totalSlots:0 + 明说原因', async () => {
  // 丙丙：装进词表但从不写事实
  rt.normalizer.setVocabulary([
    { id: `qq:${UID}`, kind: 'person', surface: ['甲甲', '甲甲甲'] },
    { id: `qq:${UID2}`, kind: 'person', surface: ['乙乙'] },
    { id: 'qq:1006837690', kind: 'person', surface: ['丙丙'] },
    { id: 'group:1098345913', kind: 'group', surface: ['测试群'] },
    { id: 'group:2000000001', kind: 'group', surface: ['另一个群'] }
  ]);
  const r = await get('/person?who=1006837690');
  assert.equal(r.body.found, true, '人在词表里 ⇒ found:true');
  assert.equal(r.body.totalSlots, 0);
  assert.ok(/一条事实都没有/.test(r.body.reason || ''), '"从没记过"要给一句明话，与上面那条可区分');
});

test('列人：有槽的在前；带 q 时把"词表里有、记忆里没有"的人也列出来（slots:0）', async () => {
  const all = (await get('/person')).body;
  assert.ok(all.count >= 2);
  assert.ok(all.people[0].slots >= all.people[all.people.length - 1].slots, '按条数降序');
  assert.ok(all.people.every((p) => p.names && p.names.length), '每人带昵称，面板要显示人话');

  const q = (await get('/person?q=丙丙')).body;
  assert.equal(q.count, 1, '昵称能搜到');
  assert.equal(q.people[0].slots, 0, '**slots:0 是最重要的信号** —— 词表认得他，但记忆里是空的');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 端点的边界：不认识的名字、空 who
// ═══════════════════════════════════════════════════════════════════════════

test('who 用昵称也能查（三种写法都试），查不到不抛 500', async () => {
  const byName = await get('/person?who=甲甲');
  assert.equal(byName.status, 200);
  assert.equal(byName.body.found, true);
  assert.ok(byName.body.scopeCount >= 1, '昵称也能落到同一个人');

  const byLabel = await get(`/person?who=${LABEL}`);
  assert.equal(byLabel.body.who.labels[0], LABEL, '占位符标签本身也是合法输入');

  const empty = await get('/person?who=%20');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.count >= 0, true, '空 who 走"列人"分支，不报错');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 只读性：这个端点绝不写盘
// ═══════════════════════════════════════════════════════════════════════════

test('人物卡是**只读视图**：查一百次也不改真值', async () => {
  const file = path.join(dataRoot, 'memory-vec', 'facts', 'slots.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 5; i += 1) {
    await get(`/person?who=${UID}`);
    await get('/person?q=甲');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, '真值一行都没动');
});

// 收尾清理临时目录
test.after(() => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});
