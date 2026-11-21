// test/event-index.mjs — 短期层的关键词索引（倒排 + IDF）
//
// 这一层要钉住的是**排序口径**，不是"能搜到"：
//   · 单字必须自己淡出（IDF 的 df 惩罚）——否则刷屏群里的"不/人/大"能顶满所有事件；
//   · 罕见词必须压过常见词 —— 这是 IDF 存在的唯一理由；
//   · 会话隔离：短期层按 chatKey 物理隔离，跨会话给一条就是社死级事故；
//   · 已回收（retiredAt）不进索引 —— 否则"回收"只是个摆设。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEventIndex, searchEvents, idfOf, DEFAULT_EVENT_MIN_SCORE
} from '../src/core/event-index.mjs';

const NOW = 1_800_000_000_000;

function row(id, title, detail, extra = {}) {
  return {
    id,
    chatKey: 'group:1',
    toTs: NOW,
    at: '10:00',
    title,
    detail,
    summary: `${title}：${detail}`,
    ...extra
  };
}

const ROWS = [
  row('e1', '决定周末露营', '几个人约好去青城山搭帐篷'),
  row('e2', '讨论新显卡', '在聊 5080 的价格和功耗'),
  row('e3', '猫又拆家了', '小鱼的猫把键盘线咬断'),
  row('e4', '决定周末开黑', '约好周六晚上打排位'),
  row('e5', '群友退群', '有人因为刷屏吵起来退了')
];

test('④ 空索引 / 空查询都不炸，也不返回垃圾', () => {
  const empty = buildEventIndex([]);
  assert.equal(empty.N, 0);
  assert.deepEqual(searchEvents(empty, '露营'), []);
  const idx = buildEventIndex(ROWS);
  assert.deepEqual(searchEvents(idx, ''), []);
  assert.deepEqual(searchEvents(idx, '   '), []);
  assert.deepEqual(searchEvents(idx, null), []);
});

test('④ IDF：罕见词的 idf 必须大于常见词', () => {
  const idx = buildEventIndex(ROWS);
  const rare = idfOf(idx, '露营');     // 只出现在 e1
  const common = idfOf(idx, '的');     // 停用词 ⇒ tokenize 里就被丢了，df=0
  assert.ok(rare > 0);
  assert.equal(common, 0, '停用词不进索引');
  const mid = idfOf(idx, '周末');      // e1/e4 都有
  assert.ok(rare > mid, `罕见词该更值钱：露营=${rare} 周末=${mid}`);
  assert.equal(idfOf(idx, '不存在的词'), 0);
});

test('④ 检索：查询「周末去哪露营」只该命中 e1，且分数过门槛', () => {
  const idx = buildEventIndex(ROWS);
  const hits = searchEvents(idx, '周末去哪露营', { chatKey: 'group:1', limit: 5 });
  assert.equal(hits[0].id, 'e1');
  assert.ok(hits[0].score >= DEFAULT_EVENT_MIN_SCORE, `分数 ${hits[0].score} 该过默认门槛`);
  assert.ok(hits[0].matched.includes('露营'));
});

test('④ 检索：单字不该把八竿子打不着的事件顶上来', () => {
  const idx = buildEventIndex(ROWS);
  // 真信号（"猫"在 e3 里，一个长一点的查询能凑够多个单字落地）—— 该命中
  const cat = searchEvents(idx, '我家猫又把键盘咬断了', { chatKey: 'group:1', limit: 3 });
  assert.equal(cat[0].id, 'e3', `期望命中 e3，实际 ${JSON.stringify(cat)}`);
  // 短查询里只落地一个单字 ⇒ **不算相关**（宁可空着，也不能靠一个「猫」凑热闹）
  assert.deepEqual(searchEvents(idx, '猫呢', { chatKey: 'group:1', limit: 3 }), []);
  // 一个满篇停用词/虚拟词的查询 ⇒ 什么都别给
  const noise = searchEvents(idx, '我是不太懂这个', { chatKey: 'group:1', limit: 3 });
  assert.deepEqual(noise, [], '只有停用词/单字巧合的查询必须返回空，不能靠噪声凑热闹');
});

test('④ 检索：会话隔离（private 的事件绝不出现在 group 的结果里）', () => {
  const rows = [
    row('g1', '聊露营', '群里约露营'),
    row('p1', '聊露营', '私聊也约露营', { chatKey: 'private:9' })
  ];
  const idx = buildEventIndex(rows);
  const inGroup = searchEvents(idx, '露营', { chatKey: 'group:1' });
  assert.deepEqual(inGroup.map((h) => h.id), ['g1']);
  const inPrivate = searchEvents(idx, '露营', { chatKey: 'private:9' });
  assert.deepEqual(inPrivate.map((h) => h.id), ['p1']);
});

test('④ 检索：exclude 生效（已由"最近事件"给过的不重复给）', () => {
  const idx = buildEventIndex(ROWS);
  const all = searchEvents(idx, '周末', { chatKey: 'group:1', limit: 9, minScore: 0 });
  assert.ok(all.length >= 2);
  const rest = searchEvents(idx, '周末', { chatKey: 'group:1', limit: 9, minScore: 0, exclude: [all[0].id] });
  assert.ok(!rest.some((h) => h.id === all[0].id));
});

test('④ 索引：已回收（retiredAt）不进索引；空标题空正文的行被丢弃', () => {
  const rows = [
    row('live', '聊露营', '约露营'),
    row('dead', '聊露营', '约露营', { retiredAt: '2026-01-01T00:00:00Z' }),
    { id: 'blank', chatKey: 'group:1', title: '', summary: '' },
    { id: '', chatKey: 'group:1', title: 'x', summary: 'x' }
  ];
  const idx = buildEventIndex(rows);
  assert.equal(idx.N, 1);
  assert.equal(idx.dropped, 3);
  assert.deepEqual(searchEvents(idx, '露营', { chatKey: 'group:1' }).map((h) => h.id), ['live']);
});

test('④ 打分：标题命中要压过纯正文命中（同一批词）', () => {
  const rows = [
    row('t', '露营计划', '定了个时间'),
    row('b', '随便聊聊', '说到露营这件事')
  ];
  const idx = buildEventIndex(rows);
  const hits = searchEvents(idx, '露营', { chatKey: 'group:1', limit: 9, minScore: 0 });
  assert.equal(hits[0].id, 't', '标题命中权重 2x，该排前面');
});

test('④ IDF：bigram 的信息量不该超过它最好的那个字', () => {
  // 这是「通用 bigram 顶掉专名」的修法（生产实测，2026-10-23）：
  // `在` 是停用词（tokenize 直接丢 ⇒ df=0），于是 `在群` 在倒排里几乎独占
  // ⇒ 未约束时 idf(`在群`)=1.466 > idf(`鸽鸽`)=0.788 —— 可它语义上只是「群」的变体。
  const idx = buildEventIndex([
    row('z1', '在群里吵架', '吵到群主出面'),
    row('z2', '群主踢人', '踢了两个刷屏的'),
    row('z3', '群规改了', '加了禁言条款'),
    row('g1', '鸽鸽怂恿', '鸽鸽让人去踢群主'),
    row('g2', '鸽鸽又来', '鸽鸽又提了一嘴')
  ]);
  assert.equal(idx.df.get('在群'), 1, '构造前提：`在群` 比 `鸽鸽` 还稀有');
  assert.equal(idx.df.get('鸽鸽'), 2);
  assert.ok(idfOf(idx, '鸽鸽') > idfOf(idx, '在群'),
    `专名该压过「停用词 + 常见字」拼出来的 bigram：鸽鸽=${idfOf(idx, '鸽鸽')} 在群=${idfOf(idx, '在群')}`);
  assert.ok(idfOf(idx, '在群') <= idfOf(idx, '群') + 1e-9,
    '`在群` 不该比 `群` 更值钱 —— 它多出来的那个字是停用词');
  // 专名**不受损**：它的字同样罕见，上限约束不会碰到它
  assert.ok(Math.abs(idfOf(idx, '鸽鸽') - idfOf(idx, '鸽')) < 1e-9);
});

test('④ 排序：分数并列时，命中「更罕见的词」的一条排前', () => {
  // 手工造索引而**不走** `buildEventIndex`：要精确控制 df，让两条事件的总分只差
  // 千分之几 —— 生产实测的 0.447 vs 0.446 就是这种并列（见 `SCORE_TIE_EPS` 的来由）。
  // token 用 ASCII：`tokenize` 对汉字会展开成「字 + bigram」，手工控不住 df。
  const common = Array.from({ length: 8 }, (_, i) => `common${i}`);
  const df = new Map([['rare', 3], ...common.map((t) => [t, 9])]);
  const post = new Map([
    ['rare', [{ id: 'B', tf: 1, chatKey: 'group:1' }]],
    ...common.map((t) => [t, [{ id: 'A', tf: 1, chatKey: 'group:1' }]])
  ]);
  const idx = { N: 10, df, post, docs: [] };

  // A 靠 8 个常见词堆叠，B 只命中 1 个罕见词 ⇒ 总分几乎相等（实测 0.506 / 0.494）
  const hits = searchEvents(idx, ['rare', ...common].join(' '), { chatKey: 'group:1', limit: 5, minScore: 0 });
  assert.equal(hits.length, 2, `两条都该过线：${JSON.stringify(hits)}`);
  assert.ok(Math.abs(hits[0].score - hits[1].score) < 0.02,
    `这两条本就该判并列：${JSON.stringify(hits.map((h) => h.score))}`);
  assert.equal(hits[0].id, 'B', '并列时靠罕见词赢 —— 只命中「群/里/说」的不该压过命中专名的');
  assert.ok(hits[0].maxIdf > hits[1].maxIdf, '赢的原因要能从返回值里看出来');
});
