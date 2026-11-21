// test/exact-search.mjs —— 关键词层（`ADR-0033`）的**端点级**验证。
//
// ── 为什么单独一个文件 ────────────────────────────────────────────────────────
// `test/tokens.mjs` 测的是**纯函数**（分词、跳字 bigram、重合度数值），那一层全绿
// **挡不住**本文件要测的四类问题 —— 它们全都在"函数被怎么用"上：
//
//   ① `/search` 在**没有嵌入端点**时会怎样。修复前是**直接 400**（唯一读路），
//      也就是"没配模型 = 完全查不了"。这是本层存在的**原始动机**。
//   ② **派生倒排索引**的生命周期：惰性建、增量追加、整表替换时作废、建表失败时全扫兜底。
//      "索引偏掉"的失败形态是**静默**的（搜不到/搜出不存在的），纯函数层看不见。
//   ③ `/inject` 的 **token 路**：门槛是**另一把尺子**（1 ~ 2 vs 余弦 0.5 ~ 1），
//      复用 `minScore` 就会用尺子量温度 —— 而它**不报错**，只是默默选错人。
//   ④ `/person?q=` 的**两条命中路**必须**分开标**（名字对上了 vs 记忆里有关），
//      合起来显示会让人分不清下一步该做什么。
//
// ── 纪律（同 `test/person.mjs` / `test/inject-endpoint.mjs`）────────────────────
//   · **临时 dataRoot**（`os.tmpdir()`）⇒ 一个字节都不碰真库。
//     ⚠️ 这条不是形式主义：`createRouter` **只注入 `DATA_DIR`、不注入 `SOURCE_DIR`**
//     （`src/transport/inproc.mjs:88-94`）⇒ 源根会落成同一个临时目录。真库那边
//     `ensureIdentity` 会**按空档案重建词表并覆盖**（实测 958 → 1，`ADR-0033 §8`）。
//   · **不碰网络**：全程不配嵌入端点 ⇒ 关键词路就是被验证的那条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';
import { VecStore } from '../src/core/vecstore.mjs';
import { DEFAULT_MIN_SCORE, DEFAULT_TOKEN_MIN_SCORE } from '../src/core/inject.mjs';
import { docIndex, tokensForLine } from '../src/core/tokens.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-exact-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

const router = createRouter({ dataRoot });
const rt = await getRuntime();

// ⚠️ 等 runtime 构造时那次 fire-and-forget 的 `ensureIdentity` 结束（详见 `test/trait.mjs`）——
// 不等就会与断言交错，且临时根下它扫不到档案、跑得极快，等它是纯收益。
const deadline = Date.now() + 30_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });
const ids = (hits) => hits.map((h) => h.id).sort();
/** 正交单位向量（互不相干 ⇒ 向量路即使能跑也排不出关系，正好凸显关键词路）。 */
const V = (i) => { const a = new Array(8).fill(0); a[i] = 1; return a; };
const MODEL = 'test-8';

// ═══════════════════════════════════════════════════════════════════════════
// ① `/search`：没有嵌入端点也必须能查（`mode` 三态 + 显式降级）
// ═══════════════════════════════════════════════════════════════════════════

// 先给向量库灌三条**互不相干**的文档。`doc-skip` 是刻意做的**跳字**样本：
// 它的正文里没有 `推歌` 这个词，只有 `推荐歌单` —— 字面对不上，跳字对得上。
rt.store.put({ id: 'doc-lit', vector: V(0), model: MODEL, meta: { title: '', text: '推歌', chatKey: 'group:1098345913', when: 3000 } });
rt.store.put({ id: 'doc-skip', vector: V(1), model: MODEL, meta: { title: '', text: '推荐歌单', chatKey: 'group:1098345913', when: 2000 } });
rt.store.put({ id: 'doc-none', vector: V(2), model: MODEL, meta: { title: '', text: '今天天气不错', chatKey: 'group:1098345913', when: 1000 } });

test('/search：mode=exact 在无嵌入端点时可用（这就是修复的那个缺口）', async () => {
  const r = await post('/search', { q: '推歌', mode: 'exact' });
  assert.equal(r.status, 200, '修复前：没配端点直接 400 ⇒ 完全查不了');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mode, 'exact');
  assert.equal(r.body.scoredBy, 'token-overlap');
  assert.equal(r.body.degraded, null, '**明确要**关键词路 ⇒ 没有"降级"可言');
  assert.equal(r.body.indexBuilt, true, '惰性索引在本轮建起来了');
  assert.equal(typeof r.body.qNormalized, 'string', '归一化仍要跑（真名→占位符）');

  const got = ids(r.body.hits);
  assert.ok(got.includes('doc-lit'), `字面命中必须进来，实际 ${JSON.stringify(got)}`);
  assert.ok(got.includes('doc-skip'), '跳字命中（推歌 ↔ 推荐歌单）也必须进来');
  assert.ok(!got.includes('doc-none'), '一个字都没沾上的文档不进结果');
  assert.equal(r.body.hits[0].id, 'doc-lit', '并列（都 1.2）时按「命中词数」分先后：doc-lit 命中真词 推歌');
  assert.deepEqual(r.body.hits[0].matched, ['推歌'], 'matched 是**实词**清单，给调用方解释排序用');

  // ⚠️ 分值本身必须**按正确方向**算出来。方向反过来（拿文档当 content，见 `tokens.mjs` 头注释）
  //    的话，`推歌` 就查不到 `推荐歌单` 的字符位置 ⇒ doc-skip 掉到 0.2。
  //    只断言"它在结果里"是**不够**的 —— 0.2 也在结果里（`score > 0` 就收）⇒ 变异会溜过去。
  //    必须钉住**数值**。这是本文件第二次遇到"断言太宽 ⇒ 假通过"（第一次见 `test/tokens.mjs`）。
  const skipHit = r.body.hits.find((h) => h.id === 'doc-skip');
  assert.ok(skipHit.score >= 1, `跳字命中必须按真词算（≥1），实际 ${skipHit.score} —— 0.2 说明方向反了`);

  // chatKey 过滤：顺带钉住"墓碑不进结果"（`metas[slot]` 为 null 时不能被当成一篇文档去读字段）
  const scoped = await post('/search', { q: '推歌', mode: 'exact', chatKey: 'group:1098345913' });
  assert.equal(scoped.status, 200);
  assert.deepEqual(ids(scoped.body.hits), got, '同场合 ⇒ 结果不变（且不能因为读墓碑字段而抛）');
  const other = await post('/search', { q: '推歌', mode: 'exact', chatKey: 'group:0000000000' });
  assert.deepEqual(other.body.hits, [], '别的场合 ⇒ 一条都不给（场合是筛选条件，不是排序偏好）');

  // ⚠️ `score` 是**话题重合度**（0~2），不是余弦。把按余弦校准的字段（distribution/judgment）
  //    混进来就是"两个量纲混进同一张图" —— 所以这条断言是**反向**的：它们必须**不在**。
  assert.ok(!('distribution' in r.body) && !('judgment' in r.body),
    'exact 路不得回报按余弦校准的分布/判定字段');
  assert.match(String(r.body.note), /不是语义相似度/, '必须有一句口径说明，别让上游把 0~2 当相似度用');
});

test('/search：mode=auto + 端点不可用 ⇒ **显式**降级（不许静默换语义）', async () => {
  const r = await post('/search', { q: '推歌' });
  assert.equal(r.status, 200, 'auto 是默认路 ⇒ 端点缺席不该是错误');
  assert.equal(r.body.mode, 'exact');
  assert.equal(r.body.requested, 'auto');
  assert.equal(r.body.degraded?.from, 'vector', '必须说清"本来想走哪条"');
  // ⚠️ 锚 `^` 是**必须**的，而且必须匹配"这一条"而不是"含这几个字"：
  //    另一条降级路（探活通过、真发时失败）的 reason 是 `嵌入调用失败：嵌入端点不可用：…`
  //    —— 它**包含**这几个字。用 `match(/嵌入端点不可用/)` 时两条路无法区分，
  //    变异验证实测：把探活判据整个删掉、让它走"真发失败"那条，测试照样全绿（**假通过**）。
  assert.match(String(r.body.degraded?.reason), /^嵌入端点不可用/,
    'reason 必须**就是**"端点不可用"这一条 —— 以"嵌入调用失败"开头说明判据换成了探活之外的路径');
  assert.equal(ids(r.body.hits).join(','), ids((await post('/search', { q: '推歌', mode: 'exact' })).body.hits).join(','),
    '降级目标与显式 exact 的结果一致');
});

test('/search：mode=vector + 端点不可用 ⇒ 400（旧契约保留，配置缺失是客户端错）', async () => {
  const r = await post('/search', { q: '推歌', mode: 'vector' });
  assert.equal(r.status, 400, '明确要向量 ⇒ 给明确失败，不悄悄换成关键词');
  assert.equal(r.body.mode, 'vector');
  assert.ok(Array.isArray(r.body.problems) && r.body.problems.length > 0, '要给出可操作的 problems');
});

test('/search：空查询 ⇒ 400（不是空结果 —— 那是两件事）', async () => {
  const r = await post('/search', { q: '   ', mode: 'exact' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 倒排索引：**派生量**的完整生命周期
// ═══════════════════════════════════════════════════════════════════════════

const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-kw-store-'));
const st = new VecStore(sdir);

test('倒排索引：惰性构建 + 追加增量', () => {
  st.put({ id: 'a', vector: V(0), model: MODEL, meta: { text: '推歌', chatKey: 'g1', when: 1 } });
  assert.equal(st._kw, null, '建实例/写入都**不**建索引（惰性）—— 库大时启动不受影响');

  const r1 = st.searchText({ text: '推歌' });
  assert.equal(r1.built, true);
  assert.deepEqual(ids(r1.hits), ['a']);
  assert.ok(st._kw instanceof Map, '查过之后索引才存在');

  // 追加：索引已经在 ⇒ put 走**增量**路径（不做重建）
  st.put({ id: 'b', vector: V(1), model: MODEL, meta: { text: '推荐歌单', chatKey: 'g1', when: 2 } });
  assert.ok(st._kw.get('歌单')?.has(1), '新文档的词条当场进索引（槽号 1 = b）');
  assert.deepEqual(ids(st.searchText({ text: '推歌' }).hits), ['a', 'b']);
});

test('倒排索引：整表替换 ⇒ 作废并且从真值重建（不做精细删除）', () => {
  st._load();
  assert.equal(st._kw, null, '`_load()` 是整表替换 ⇒ 索引一并作废');
  const r = st.searchText({ text: '推歌' });
  assert.equal(r.built, true);
  assert.deepEqual(ids(r.hits), ['a', 'b'], '重建后结果不变 ⇒ 作废是安全的');

  // 更新路径：老槽打墓碑 + 整表重写 ⇒ 旧词条必须消失
  st.put({ id: 'a', vector: V(0), model: MODEL, meta: { text: '完全不相干', sourceHash: 'h2', chatKey: 'g1', when: 9 } });
  assert.equal(st._kw, null, '更新路径整体作废（这正是"不写精细删除"的理由）');
  const r2 = st.searchText({ text: '推歌' });
  assert.deepEqual(ids(r2.hits), ['b'], '旧文档换了正文 ⇒ 必须只剩 b（残留就是静默偏掉）');

  // ⚠️ 带 **chatKey** 再查一次：这是唯一能暴露"没跳过墓碑"的形态。
  //    不带 chatKey 时 `q.chatKey && m.chatKey` 会短路，读 `null.chatKey` 根本不发生；
  //    带上之后，墓碑（`metas[slot] === null`）若仍被当成一篇文档读就会**抛**。
  //    变异验证实测：去掉那句 `if (!m) continue` 后只有本条断言会红。
  assert.deepEqual(ids(st.searchText({ text: '推歌', chatKey: 'g1' }).hits), ['b'],
    '场合过滤：墓碑必须被跳过（否则读 null 的字段会抛，不是"安静地多一条"）');
  assert.deepEqual(st.searchText({ text: '推歌', chatKey: 'g-other' }).hits, [], '换个场合 ⇒ 一条都没有');
});

test('倒排索引：建表失败 ⇒ **全扫兜底**，绝不返回"没搜到"', () => {
  const before = ids(st.searchText({ text: '推歌' }).hits);
  st._kw = null;
  st._buildKw = () => { throw new Error('boom'); };
  const r = st.searchText({ text: '推歌' });
  assert.equal(r.built, false, '如实回报"索引没建成"');
  assert.deepEqual(ids(r.hits), before, '全扫兜底：宁可慢，也不能给空结果（空结果 = "确实没有"）');
  assert.equal(st._kw, null, '失败后不留半成品索引');
});

test('文档侧口径：块标题参与检索 + 正文不受 160 字截断（两个都踩过）', () => {
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-kw-doc-'));
  const cs = new VecStore(cdir);
  // 关键词只出现在标题里
  cs.put({ id: 't', vector: V(0), model: MODEL, meta: { title: '独角兽专题', text: '其它内容', when: 2 } });
  assert.ok(ids(cs.searchText({ text: '独角兽' }).hits).includes('t'), '标题也是文档的一部分');

  // 关键词落在 160 字**之后**（正文实测 355 字，最初的实现按话题句口径截到 160 ⇒ 搜不到）
  // ⚠️ 用**两字**词做样本：`tokenize` 对汉字只产「单字 + 相邻 bigram」，没有三字词
  //    （第一版写成 `独角兽`，于是 `set.has('独角兽')` 恒 false —— 一个**恒假**的断言
  //     会把"口径没问题"读成"口径有问题"，与假通过是同一类错误，只是方向相反）。
  const long = `${'前'.repeat(180)}独角`;
  assert.ok(long.length > 160);
  assert.equal(docIndex(long).set.has('独角'), true, '文档口径：整段都进索引');
  assert.equal(tokensForLine(long).set.has('独角'), false,
    '话题句口径会把它截掉 —— 这个**可观测的差异**就是修复前的失败形态');
  assert.equal(tokensForLine(long).pos.has('独'), false, '连字符位置表里都没有它');

  cs.put({ id: 'long', vector: V(1), model: MODEL, meta: { title: '', text: long, when: 1 } });
  assert.ok(ids(cs.searchText({ text: '独角' }).hits).includes('long'),
    '回归：关键词在长正文后段也必须搜得到');
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ `/inject`：token 路 —— 有信号就排，且门槛**不共用**余弦那个数字
// ═══════════════════════════════════════════════════════════════════════════

const UID = '1006837688';
const UID2 = '1006837689';
const GROUP = 'group:1098345913';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲甲'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙乙'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);
const PEOPLE = [{ id: UID, name: '甲甲' }, { id: UID2, name: '乙乙' }];

// 甲：跟"推荐音乐"这件事**字面**沾边；乙：完全不沾边（对照组）。
await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '喜欢民谣和后摇，推荐歌单固定三类' });
await post('/remember', { chatKey: GROUP, userId: UID2, kind: 'preference', text: '喜欢打游戏，常熬夜' });

test('/inject：嵌入缺席时按 token 重合排序，门槛换成**另一把尺子**', async () => {
  const r = await post('/inject', { dry: true, chatKey: GROUP, people: PEOPLE, topic: '她在群里问推荐音乐', mode: 'hard' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'hard', '有信号 ⇒ **不再**无条件降级成 boost（修复前的形态）');
  assert.equal(r.body.simMetric, 'token-overlap');
  // 端点没配齐 ⇒ 先报**缺什么**，再说明降级到了 token。
  // （以前只说 `'token-overlap'`，看不出"为什么走了关键词路"；也不能只说 `embed-unavailable`，
  //   那会把"降级成功"读成"什么都没算"。两段都要。）
  assert.match(r.body.simNote, /^embed-unavailable: .+ → token-overlap$/,
    `实际：${r.body.simNote}`);
  assert.equal(r.body.minScoreCaliber, 'token');
  assert.equal(r.body.minScore, DEFAULT_TOKEN_MIN_SCORE, '生效门槛来自重合度自己的刻度');
  assert.equal(r.body.configuredMinScore, DEFAULT_MIN_SCORE,
    '用户配的那个**余弦**门槛原样回报 —— 免得"我明明设了 0.85"变成查不出来的问题');
  assert.notEqual(r.body.configuredMinScore, DEFAULT_TOKEN_MIN_SCORE,
    '测试前提：两把尺子的默认值本来就不同（0.5 余弦 vs 1 重合度）');
  assert.equal(r.body.minScoreCaliber === 'token' ? r.body.minScore : null, DEFAULT_TOKEN_MIN_SCORE,
    '回报的门槛必须与回报的量纲**一致** —— 报 token 刻度却给余弦的数就是静默选错人');

  const text = r.body.lines.map((l) => l.line).join(' | ');
  assert.match(text, /推荐歌单/, `沾边的属性行必须被选进来，实际 ${JSON.stringify(r.body.lines)}`);
  assert.ok(!/打游戏/.test(text), '不沾边的那条被门槛挡住 —— 这正是"有信号"与"没信号"的区别');
  assert.ok(r.body.droppedByThreshold >= 1, '如实回报被阈值扔掉几条（否则"为什么没注入"无从查起');
});

test('/inject：全都不沾边 ⇒ 一条不注入，但仍然按 hard 走（不偷偷回退 boost）', async () => {
  const r = await post('/inject', { dry: true, chatKey: GROUP, people: PEOPLE, topic: '今天天气真好', mode: 'hard' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'hard', 'sims 是 `[0,0]`（**有**信息，只是全不过阈）而不是 null');
  assert.equal(r.body.simMetric, 'token-overlap');
  assert.deepEqual(r.body.lines, [], 'hard + 全不过阈 ⇒ 什么都不注入');
  assert.equal(r.body.injected, false);
  assert.equal(r.body.droppedByThreshold, r.body.candidates, '候选全被阈值扔掉');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ `/person?q=`：两条命中路必须**分开标**
// ═══════════════════════════════════════════════════════════════════════════

const UID3 = '1006837690';
const UID4 = '1006837691';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲甲'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙乙'] },
  { id: `qq:${UID3}`, kind: 'person', surface: ['丙丙'] },
  { id: `qq:${UID4}`, kind: 'person', surface: ['丁丁'] },
  { id: 'group:1098345913', kind: 'group', surface: ['测试群'] }
]);
const LABEL3 = rt.normalizer.resolveKnown(`qq:${UID3}`)?.label || '';
assert.ok(LABEL3, '测试前提：丙丙能在词表里认出来');

// 丙：两条**内容**事实；丁：只有名字、一条事实都没有（"词表里有、记忆里没有"）
// ⚠️ 丁丁必须是**全新**的人：甲乙在上一节已经各有一条 preference 槽，
//    拿他们来测"记忆里没有"会拿到 `slots:1` —— 断言就变成了在测另一件事。
await post('/remember', { chatKey: GROUP, userId: UID3, kind: 'preference', text: '每天早上一杯手冲' });
// 丙的第二条：正文里提到**自己** ⇒ 归一化后是它自己的占位符（见下面的注释）
await post('/remember', { chatKey: GROUP, userId: UID3, kind: 'promise', text: '丙丙答应的事' });

test('/person?q=：词表命中与事实命中**分开标**，且都给出可解释的计数', async () => {
  // ① 内容命中：丙丙有事实、名字对不上 ⇒ 只标 facts
  const byContent = await get(`/person?q=${encodeURIComponent('手冲')}`);
  assert.equal(byContent.status, 200);
  assert.equal(byContent.body.qMode, 'vocab+facts', '面板要知道这次走的是哪条路');
  assert.equal(byContent.body.people.length, 1, `只有丙丙沾边，实际 ${JSON.stringify(byContent.body.people.map((p) => [p.speaker, p.matchedIn]))}`);
  assert.deepEqual(byContent.body.people[0].matchedIn, ['facts'], '是"记忆里有关"，不是"名字对上了"');
  assert.equal(byContent.body.people[0].factCount, 1);
  assert.ok(String(byContent.body.people[0].factSamples?.[0]?.line).includes('手冲'), '给样本，面板才能显示凭什么命中');

  // ② 名字命中：丁丁一条事实都没有 ⇒ 靠词表列出，`slots:0` 本身就是要看见的信号
  const byName = await get(`/person?q=${encodeURIComponent('丁丁')}`);
  const b = byName.body.people.find((p) => p.matchedIn.includes('vocab'));
  assert.ok(b, '词表里有人、记忆里没有 ⇒ 也必须列出来（否则看着像"查不到"）');
  assert.deepEqual(b.matchedIn, ['vocab']);
  assert.equal(b.slots, 0, '`slots:0` 是"认得出但没记过"的可观测形态');

  // ③ 两路都命中：⚠️ **昵称做不到这件事**，原理值得记一笔 ——
  //    写侧 `normalize()` 会把已知昵称换成占位符，所以**昵称永远不可能出现在已存的
  //    事实正文里**（"甲甲" 在库里是 〔Pxxxx〕）。能被两路同时命中的查询，只有
  //    **占位符/QQ 号本身**（词表认它，而别人的正文里引用的也正是它）。
  const byLabel = await get(`/person?q=${encodeURIComponent(LABEL3)}`);
  const both = byLabel.body.people.find((p) => p.matchedIn.length === 2);
  assert.ok(both, `用占位符查应同时命中两路，实际 ${JSON.stringify(byLabel.body.people.map((p) => [p.speaker, p.matchedIn]))}`);
  assert.deepEqual(both.matchedIn.sort(), ['facts', 'vocab']);
  assert.equal(both.factBest >= DEFAULT_TOKEN_MIN_SCORE, true, '事实路有门槛：至少一个真词（单字巧合不算）');

  // ④ 都不命中 ⇒ 空列表（不是"全列出来"）
  const none = await get('/person?q=zzqqxx');
  assert.deepEqual(none.body.people, []);
  assert.equal(none.body.count, 0);
});

test('/person?q=：单字巧合不算命中（门槛的失败形态是"人人都有关"）', async () => {
  // 「手」在丙丙的正文里，但单字重合封顶 0.2 < 1 ⇒ 不该因为一个字就把人捞出来
  const r = await get(`/person?q=${encodeURIComponent('手')}`);
  const hit = r.body.people.find((p) => p.speaker === LABEL3 && p.matchedIn.includes('facts'));
  assert.equal(hit, undefined, '单字重合不算事实命中 —— 否则"不/人/大/件"会把所有人的卡都捞出来');
});
