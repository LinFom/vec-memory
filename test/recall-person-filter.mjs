// test/recall-person-filter.mjs —— 票 08：按人检索先筛选再取前几条 · [by:DS] 2026-10-28
//
// ── 这一层为什么必须端点级测 ─────────────────────────────────────────────────
// 评审 F09 的失败形态是**假空**：`/recall?who=目标&k=1` 返回 0 条，看起来像
// "这个人什么都没被记过"。而底层（`store.search({filter})`）明明能返回那条 ——
// 差别只在**顺序**：改前是"先取 Top-K（或 6×K、或 500 条）再在内存里按人筛"，
// 目标项排在候选之外就永久看不见。纯函数层（`test/tokens.mjs`）全绿也挡不住，
// 因为它测的是"分数对不对"，不是"候选集怎么来的"。
//
// ── 本文件的写法：每条都带**反向对照** ────────────────────────────────────────
// 只断言"现在能查到"是不够的 —— 那种断言在数据造得太温柔时，改不改都能绿。
// 所以每条都同时断言"**用改前的口径做同一件事会空**"，证明这个场景真的能触发 bug。
//
// ── 纪律（同 `test/exact-search.mjs`）────────────────────────────────────────
//   · 临时 dataRoot ⇒ 一个字节都不碰真库。
//   · 关键词路用「没配端点」的配置跑（那正是它要验的场景）；
//     向量路**在端点级**跑（票 08 复审 · A4）—— 见下方 ⑥ 与嵌入桩说明。
//
// ── 复审补的那条（2026-10-28 · [by:DS]）────────────────────────────────────
// 上一版只证明"`store.search({filter})` 能把人筛到"，**没有一条用例经过 `/recall` 的
// 向量分支**。而失败形态恰恰藏在那一层：端点探活失败 / 编码身份不匹配 / 取 K 顺序错了，
// 任一条都会让 `/recall` 悄悄降级到 exact（`recent.degraded` 里写个理由），这时
// store 层那几条断言**照样全绿**，报告看起来"向量路已验证"。所以 ⑥ 必须在端点级跑，
// 并显式断言 `mode==='vector'`、`degraded===null`、以及**嵌入端点真的被调过**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';
import { encodingIdentity } from '../src/core/vector-generation.mjs';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-recall-person-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

// ── 嵌入端点桩（只回答 `/embeddings`，恒定返回 V(0)）─────────────────────────
// 「恒定 V(0)」是刻意的：查询向量与 505 条干扰块**完全相同**（余弦 1），
// 目标块是 [1,0.1,…]（余弦 ≈0.995）⇒ 目标必然被挤出 Top-1。这样"没筛选就会假空"
// 才是可复现的事实，而不是靠语料碰巧。
//
// 合不合法性由**生产契约**决定（`encodingIdentity`）——桩不伪造编码身份，
// 种子按当前 settings 算出来的身份标记，校验照原样跑。绕过校验去凑绿是不许的。
const DIM = 8;
const V0 = (() => { const a = new Array(DIM).fill(0); a[0] = 1; return a; })();
const EMBED_CALLS = { n: 0, texts: 0 };
const embedStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* 空体照答 */ }
    const input = Array.isArray(payload.input) ? payload.input : [payload.input];
    EMBED_CALLS.n += 1;
    EMBED_CALLS.texts += input.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      model: String(payload.model || 'stub-8'),
      data: input.map((_, i) => ({ object: 'embedding', index: i, embedding: V0 }))
    }));
  });
});
await new Promise((ok) => embedStub.listen(0, '127.0.0.1', ok));
const EMBED_BASE = `http://127.0.0.1:${embedStub.address().port}`;

// ★ 端点**默认关闭**：关键词路的用例必须真的走关键词路（有端点就会走向量分支，
//   那样 ② 这条"6 倍候选会假空"的反向对照就测不到了 —— 它是本票的核心证据）。
//   ⑥ 里临时打开开关，跑完立刻关回去。
let EMB_ON = false;
// ⚠️ `embedModel` 必须与种子写库时用的 `model` **同名**（`test-8`）。
// 这里踩过一次真实降级：写成 `'stub-8'` ⇒ `assertQueryCompatibility` 抛 MODEL_MISMATCH
// ⇒ `/recall` 悄悄 `takeExact()`，`mode` 变 `exact`、`degraded` 里写一句"请重建索引"。
// 状态码照样 200、`ok:true` —— 这正是"向量断言其实一条都没跑"的形态。
const EMB = { embedBaseURL: EMBED_BASE, embedModel: 'test-8', embedDimensions: String(DIM), embedMode: 'auto' };
const settings = { getSkillConfig: (_id, defaults) => ({ ...defaults, ...(EMB_ON ? EMB : {}) }) };

const router = createRouter({ dataRoot, settings });
const rt = await getRuntime();

const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const UID = '1006837800';
const UID2 = '1006837801';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲瓶'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙罐'] }
]);
const GROUP = 'group:1098345913';
const PRIV = `private:${UID}`;
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
assert.ok(LABEL, '测试前提：乙能在词表里认出来');

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });
const MODEL = 'test-8';
const V = (i) => { const a = new Array(8).fill(0); a[i] = 1; return a; };
const hasLabel = (m) => String(m?.text || '').includes(`〔${LABEL}〕`);
const mark = `〔${LABEL}〕`;

// 编码身份必须**按当前 settings 算**，并逐条写进种子 —— 不能事后把校验关掉去凑绿。
// 算的是「打开端点之后」的那份 settings（`{...rt.settings, ...EMB}`），因为 ⑥ 里
// `/recall` 会用它去 `assertQueryCompatibility`；两边必须来自同一个函数、同一个输入。
const ENC = encodingIdentity({ ...rt.settings, ...EMB });

// ── 造库：目标块**最先写** ⇒ slot 最小 ⇒ `list` 倒序时排在最后 ────────────────
// 505 条干扰 = 刚好超出 `list` 的 500 上限。选 505 而不是"几百"，是因为本票的
// 第二条验收明确要求"前 500 条之外仍可发现" —— 499 条测不出这个边界。
const NOISE = 505;
const GUITAR_NOISE = 20;      // 其中 20 条含查询词「吉他」，用来做"6 倍候选"那一档
const TARGET_VEC = [1, 0.1, 0, 0, 0, 0, 0, 0];   // 与查询向量 V(0) 的余弦 ≈ 0.995
rt.store.put({ id: 'tgt', vector: TARGET_VEC, model: MODEL, encoding: ENC, meta: { title: '', text: `${mark} 我在学吉他`, chatKey: GROUP, when: 1000 } });
for (let i = 0; i < NOISE; i++) {
  rt.store.put({
    id: `noise-${i}`,
    vector: V(0),                                  // 与查询向量完全相同 ⇒ 余弦 1，比目标更近
    model: MODEL,
    encoding: ENC,
    meta: {
      title: '',
      text: i < GUITAR_NOISE ? '他们都在聊吉他' : '无关的别的内容',
      chatKey: GROUP,
      when: 2000 + i
    }
  });
}
// 私聊的块也提到她：用来验证 chatKey 筛选仍在**候选阶段**生效
rt.store.put({ id: 'priv', vector: V(0), model: MODEL, encoding: ENC, meta: { title: '', text: `${mark} 私聊里也提过她`, chatKey: PRIV, when: 9000 } });

test.after(() => {
  assert.ok(dataRoot.startsWith(path.join(os.tmpdir(), 'vmm-recall-person-')));
  fs.rmSync(dataRoot, { recursive: true, force: true });
  embedStub.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// ① 无查询词：目标块在 500 条之外，仍必须被发现（验收 2）
// ═══════════════════════════════════════════════════════════════════════════
test('① 无 q：目标块排在 500 条之外，仍能按人查到；改前的"先取 500 再筛"会假空', async () => {
  // 反向对照：这就是改前的口径（limit:500 取第一页，再在内存里按人筛）
  const oldWay = rt.store.list({ offset: 0, limit: 500, chatKey: GROUP })
    .items.filter(hasLabel);
  assert.equal(oldWay.length, 0,
    '★ 反向对照必须为空 —— 否则这条测试没有真正触发 F09（说明目标块其实排进了前 500）');

  const r = await get(`/recall?who=${UID}&chatKey=${GROUP}&k=1`);
  assert.equal(r.status, 200);
  assert.ok(r.body.found, '人在词表里');
  assert.equal(r.body.recent.items.length, 1, '★ 必须返回目标块，不能伪称无记录');
  assert.match(r.body.recent.items[0].text, /学吉他/, '★ 返回的正是目标块');
  assert.equal(r.body.recent.total, 1, '★ total 是筛完之后的总数（1），不是"扫了多少条"');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 关键词查询：干扰数是候选的 6 倍以上，仍必须返回目标（验收 1 · 关键词路）
// ═══════════════════════════════════════════════════════════════════════════
test('② 有 q（关键词）：6 倍以上干扰挡住时仍返回目标；改前的"取 6×k 再筛"会假空', async () => {
  // 反向对照：改前是 `searchText({k: kLimit*6})` 再内存筛。kLimit=1 ⇒ 取 6 条，
  // 前 6 条全是含「吉他」的干扰（when 更新 ⇒ 排前），目标被挡在候选之外。
  const oldHits = rt.store.searchText({ text: '吉他', k: 6, chatKey: GROUP })
    .hits.filter((h) => hasLabel(h.meta));
  assert.equal(oldHits.length, 0,
    '★ 反向对照必须为空 —— 证明"6 倍候选"这一档确实能触发 F09');

  const r = await get(`/recall?who=${UID}&chatKey=${GROUP}&q=${encodeURIComponent('吉他')}&k=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.recent.mode, 'exact', '没配嵌入端点 ⇒ 走关键词路（本文件要验的就是它）');
  assert.equal(r.body.recent.items.length, 1, '★ 必须返回目标块');
  assert.match(r.body.recent.items[0].text, /学吉他/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 向量路：筛选必须在**打分循环内**生效（验收 1 · 向量路，store 层）
// ═══════════════════════════════════════════════════════════════════════════
// 端点不可用时 `/recall` 会降级到 exact ⇒ 走不到向量分支。所以这条路在 store 层验：
// 它正是 `/recall` 与 `/inject` 共用的那一个 `search()`。
test('③ 向量路：filter 在打分前生效；无 filter 的 Top-1 会取到干扰', () => {
  const qv = V(0);
  // 反向对照：不带 filter 的 Top-1 —— 干扰块与查询向量完全相同（余弦 1）⇒ 目标被挤掉
  const top1 = rt.store.search({ vector: qv, k: 1, chatKey: GROUP });
  assert.equal(top1.hits.length, 1);
  assert.ok(!hasLabel(top1.hits[0].meta), '★ 反向对照：裸 Top-1 拿到的是干扰（正是 F09 的形态）');

  // 带 filter：只剩目标参与排序 ⇒ 必须命中
  const filtered = rt.store.search({ vector: qv, k: 1, chatKey: GROUP, filter: hasLabel });
  assert.equal(filtered.hits.length, 1, '★ 带 filter 的 Top-1 必须是目标');
  assert.match(filtered.hits[0].meta.text, /学吉他/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 会话筛选仍在候选阶段生效（验收 3）
// ═══════════════════════════════════════════════════════════════════════════
test('④ 会话筛选在候选阶段生效：别处的块不会混进来', async () => {
  const inGroup = await get(`/recall?who=${UID}&chatKey=${GROUP}&k=5`);
  assert.ok(inGroup.body.recent.items.every((x) => x.chatKey === GROUP),
    '★ chatKey 筛选必须生效（私聊块不许出现在群检索里）');
  assert.ok(!inGroup.body.recent.items.some((x) => /私聊里也提过她/.test(x.text)));

  const inPriv = await get(`/recall?who=${UID}&chatKey=${PRIV}&k=5`);
  assert.equal(inPriv.body.recent.items.length, 1, '★ 私聊那边只有它自己那一条');
  assert.match(inPriv.body.recent.items[0].text, /私聊里也提过她/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 长期段与近期段继续分段，分数不混排（验收 3 后半）
// ═══════════════════════════════════════════════════════════════════════════
test('⑤ 长期/近期仍分两段返回，两段的 score 不混在一个数组里', async () => {
  await post('/remember', { chatKey: GROUP, userId: UID, kind: 'preference', text: '爱喝美式' });
  const r = await get(`/recall?who=${UID}&chatKey=${GROUP}&k=5`);
  const b = r.body;

  assert.ok(Array.isArray(b.longTerm.items) && Array.isArray(b.recent.items), '两段各自是数组');
  assert.ok(b.longTerm.items.every((x) => x.source === 'facts'), '长期段条目标 source=facts');
  assert.ok(b.recent.items.every((x) => x.source === 'chunks'), '近期段条目标 source=chunks');
  assert.ok(b.longTerm.items.some((x) => x.line.includes('美式')), '长期段能查到刚写的事实');
  assert.equal(b.longTerm.items.filter((x) => x.source === 'chunks').length, 0, '★ 两段不互相混入');
  assert.match(b.note, /不可比/, 'note 必须声明两段分数不可比（不然前端会拿一个数排序两套量纲）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 向量路**端点级**（复审补，票 08 · A4）
// ═══════════════════════════════════════════════════════════════════════════
// 验收原文：大量他人高分项阻挡目标，明确断言 `mode=vector`、`degraded=null`、
// 目标仍出现、错误会话不出现。
//
// 这条必须走 `/recall` 而不是 `store.search()`：降级发生在路由层（探活失败 / 编码身份
// 不匹配 / 抛错都会 `takeExact()`），而 `recent.degraded` 只是**一句理由**、不影响状态码。
// 换句话说，向量路坏了的表现是「200 + ok:true + mode:exact」，任何只看结果的断言都绿。
test('⑥ /recall 向量路（端点级）：他人高分项挡路仍返回目标，且不串会话', async () => {
  EMB_ON = true;
  try {
    // 反向对照 A：**不带人**的裸查询 Top-1 必然是干扰块（它与查询向量完全相同）。
    // 这一条同时证明"端点确实在答"——否则 mode 会是 exact，下面的 mode 断言会立刻红。
    const callsBefore = EMBED_CALLS.n;
    const bare = await get(`/recall?q=${encodeURIComponent('吉他')}&chatKey=${GROUP}&k=1`);
    assert.equal(bare.body.recent.mode, 'vector',
      `★ 必须真走向量路（实测 ${bare.body.recent.mode}；降级理由：${JSON.stringify(bare.body.recent.degraded)}）`);
    assert.equal(bare.body.recent.degraded, null, '★ 不得降级 —— 降级时 store 层断言照样全绿，等于没测');
    assert.ok(EMBED_CALLS.n > callsBefore, '★ 端点必须真被调用（mode 只是它自己报的一句话）');
    assert.equal(bare.body.recent.items.length, 1);
    assert.ok(!hasLabel(bare.body.recent.items[0]?.text),
      '★ 反向对照：不带人时 Top-1 是干扰块 —— 证明这个场景真能触发 F09（否则这条测试没有判别力）');

    // 正题：带 who ⇒ 筛选在打分循环内生效，目标必须出现
    const r = await get(`/recall?who=${UID}&chatKey=${GROUP}&q=${encodeURIComponent('吉他')}&k=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.recent.mode, 'vector', '★ 同样必须走向量路（不能因为带人而退回 exact）');
    assert.equal(r.body.recent.degraded, null);
    assert.equal(r.body.recent.items.length, 1, '★ 目标必须出现，不能伪称无记录');
    assert.match(r.body.recent.items[0].text, /学吉他/, '★ 返回的正是目标块');
    assert.equal(r.body.recent.items[0].chatKey, GROUP, '★ 来源会话必须是当前会话');

    // 错误会话：私聊那条与查询向量同样余弦 1、也带目标人的占位符 ——
    // 只有 chatKey 在**候选阶段**生效才能把它挡住（不是"取回来再过滤"）。
    assert.ok(!r.body.recent.items.some((x) => /私聊里也提过她/.test(x.text)),
      '★ 私聊块不得出现在群检索里（社死级）');

    // 汇总层：`who` 解析失败要能区分"人不存在"和"没有记忆"
    assert.equal(r.body.found, true, '人在词表里 ⇒ found 必须为 true（与"筛不到"分开）');
  } finally {
    EMB_ON = false;
  }
});
