// 关键词来源自检 —— 修 `ROADMAP #5`（关键词碎片出境）。零依赖、完全离线。
//
// 纪律：每条断言都在复现一个**真实**的坑（形态取自 `data/memory-v2/chunks/*.json` 的实测），
// 而不是"函数写对了没"。本文件里的三组：
//   · 碎片判据必须**锚定** —— 否则长群名片会把常用词全判成碎片（实测：`自己`/`直接`/`给我`）
//   · `filtered` 必须把 core 的碎片洗干净（`single`/`samara`/`kid1411`/`cq`/`qq`）
//   · `redacted` 必须在**脱敏之后**抽词（会话键、CQ 码、已知名字都不该出现在关键词里）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSurfaceFragment, filterCoreKeywords, extractKeywords, keywordFragments } from '../src/core/keywords.mjs';
import { Normalizer } from '../src/core/normalize.mjs';
import { buildEmbedText, buildKeywordLine } from '../src/core/chunkread.mjs';

const SECRET = 'a'.repeat(48);

const VOCAB = [
  { id: 'self', kind: 'self', surface: ['我', 'Single Samara'] },
  { id: 'qq:3042786385', kind: 'person', surface: ['沫钤'] },
  { id: 'qq:263543361', kind: 'person', surface: ['KID1411', 'kid1411'] },
  { id: 'qq:2218213246', kind: 'person', surface: ['鲸鱼娘'] },
  // 真实的**长名片**：中间含 `自己` / `直接` 这类常用词（这是锚定判据的由来）
  { id: 'group:1098345913', kind: 'group', surface: ['这个空哥', '放片不看把自己关门外cos无能的丈夫'] }
];

function makeNormalizer() {
  const n = new Normalizer({ secret: SECRET });
  n.setVocabulary(VOCAB);
  return n;
}

test('碎片判据 · 只认"锚定"命中（实测改的）', () => {
  // ① 真碎片：整串 / 块 / 前缀 / 后缀
  assert.equal(isSurfaceFragment('single', 'Single Samara'), true, 'ASCII 块');
  assert.equal(isSurfaceFragment('samara', 'Single Samara'), true, 'ASCII 块（大小写无关）');
  assert.equal(isSurfaceFragment('kid1411', 'KID1411'), true, '等长（大小写不同）');
  assert.equal(isSurfaceFragment('鲸鱼', '鲸鱼娘'), true, '前缀');
  assert.equal(isSurfaceFragment('鱼娘', '鲸鱼娘'), true, '后缀');
  assert.equal(isSurfaceFragment('三姐', '三姐妹'), true, '前缀（「三姐妹」里的「三姐」确实是人名形态）');

  // ② **中间命中不算**：长名片里的常用词不是碎片
  assert.equal(isSurfaceFragment('自己', '放片不看把自己关门外cos无能的丈夫'), false,
    '长名片中间的「自己」不算碎片 —— 否则 filtered 会把常用词删光');
  assert.equal(isSurfaceFragment('直接', '洛西（洛版有问题直接说）'), false, '中间的「直接」同理');
  assert.equal(isSurfaceFragment('codex', 'D'), false, '单字母实体不该把含它的词全卷进来');
  assert.equal(isSurfaceFragment('image', 'image'), true, '整串相等在长度下限之前就成立');

  // ③ 长度下限
  assert.equal(isSurfaceFragment('qq', 'qq'), true, '完全相等不受长度下限约束');
  assert.equal(isSurfaceFragment('at', 'attack on titan'), false, '两字母 ASCII 不判（误伤面太大）');
});

test('filtered · 剔掉实体碎片与结构碎片，其余原样保序', () => {
  const surfaces = VOCAB.flatMap((e) => e.surface);
  const core = ['cq', 'qq', 'single', 'samara', 'kid1411', '怎么', '图片', '引用', '沫钤'];
  const out = filterCoreKeywords(core, { surfaces, limit: 24 });
  assert.deepEqual(out, ['怎么', '图片', '引用'],
    `结构碎片(cq/qq)与实体碎片(single/samara/kid1411/沫钤)都被剔掉，顺序不变 —— 实得 ${JSON.stringify(out)}`);
  assert.equal(keywordFragments(out, surfaces).length, 0, '过滤后不再有碎片');

  // 反向对撞：没有词表时**只**剔结构碎片（不许自作聪明删别的）
  assert.deepEqual(filterCoreKeywords(core, { surfaces: [] }), ['single', 'samara', 'kid1411', '怎么', '图片', '引用', '沫钤'],
    '没有词表 ⇒ 只剔 cq/qq，别的原样留下');
});

test('redacted · 从脱敏文本抽词（会话键/CQ 码/已知名字都不出现）', () => {
  const n = makeNormalizer();
  const chunk = {
    id: 'hour_group_1098345913_2026-09-2509',
    chatKey: 'group:1098345913',
    hourKey: '2026-09-25 09',
    summary: '- KID1411: [CQ:at,qq=263543361] 你接的啥模型？沫钤说这个版本没有 archive.js',
    keywords: ['cq', 'qq', 'kid1411', '模型']
  };
  const info = buildEmbedText(chunk, { normalizer: n, maxChars: 1200, keywordsSource: 'redacted', register: false });
  const kwLine = info.text.split('\n')[0];
  assert.match(kwLine, /^关键词：/, '关键词行在最前（与旧布局一致：被截断时最后才轮到它）');
  for (const bad of ['cq', 'qq', 'kid1411', '1098345913', '263543361', '沫钤', 'KID1411']) {
    assert.ok(!info.text.includes(bad), `出境文本里没有「${bad}」`);
  }
  assert.ok(/模型|版本|archive/.test(kwLine), `关键词来自脱敏后的内容 —— 实得 ${kwLine}`);

  // 确定性：同输入同输出
  const again = buildEmbedText(chunk, { normalizer: makeNormalizer(), maxChars: 1200, keywordsSource: 'redacted', register: false });
  assert.equal(again.text, info.text, '同样输入 ⇒ 同样出境文本（关键词排序必须确定）');
});

test('filtered 已是默认（2026-10-09 拍板）· core 可显式选回（并且看得见它漏什么）', () => {
  const n = makeNormalizer();
  const chunk = { id: 'hour_x_2026-09-2500', chatKey: 'group:1', keywords: ['cq', 'qq', 'kid1411', 'single', '模型'], summary: '正文' };
  // 默认即 filtered：碎片不再出境
  const def = buildEmbedText(chunk, { normalizer: n, maxChars: 1200, register: false });
  for (const bad of ['cq', 'qq', 'single', 'kid1411']) {
    assert.ok(!def.text.includes(bad), `默认（filtered）：出境文本里没有「${bad}」`);
  }
  assert.ok(def.text.includes('模型'), '真实内容词保留（不是一刀切删光）');
  assert.equal(def.redaction.keywords.source, 'filtered');

  // 显式选回 core：碎片照样出境（看得见它漏什么 —— 这就是当初要切的理由）
  const core = buildEmbedText(chunk, { normalizer: n, maxChars: 1200, register: false, keywordsSource: 'core' });
  assert.ok(core.text.includes('关键词：cq qq'), 'core：核心关键词照旧进正文');
  assert.ok(core.text.includes('single'),
    '而且**碎片照样出境**（`single` 是机器人名 `Single Samara` 的一块）—— 这就是切走它的理由');
  assert.ok(!core.text.includes('kid1411'),
    '对照：整串在词表里（`kid1411`）的会被归一化器换成占位符 —— 碎片才是漏洞');
  assert.equal(core.redaction.keywords.source, 'core');

  // 未知取值必须**显式**抛，不许静默回落
  assert.throws(
    () => buildKeywordLine(chunk, { keywordsSource: 'nope', normalizer: n }),
    (e) => e.code === 'BAD_KEYWORDS_SOURCE',
    '未知 keywordsSource ⇒ BAD_KEYWORDS_SOURCE（静默回落会让人以为设置生效了）'
  );
});

test('extractKeywords · 确定性与噪声边界', () => {
  assert.deepEqual(extractKeywords(''), [], '空文本 ⇒ 空表');
  assert.deepEqual(extractKeywords('〔P1〕 〔MEDIA〕 〔SELF〕'), [], '全是占位符 ⇒ 空表（占位符不是内容）');

  const a = extractKeywords('今天天气不错，今天心情也不错。', { limit: 5 });
  const b = extractKeywords('今天天气不错，今天心情也不错。', { limit: 5 });
  assert.deepEqual(a, b, '同样输入 ⇒ 同样输出');
  assert.ok(a.includes('今天'), `高频 2 元被选中 —— 实得 ${JSON.stringify(a)}`);

  const en = extractKeywords('archive archive Archive.js', { limit: 5 });
  assert.ok(en.includes('archive'), `ASCII 词小写化并按频次 —— 实得 ${JSON.stringify(en)}`);
  assert.ok(!en.some((w) => w === 'cq' || w === 'qq'), '结构碎片不进词表');
});

test('关键词行 · 夹着实体串的复合词整词丢掉（丢词，不丢块）', () => {
  // 实测（2026-10-29 盘点）：小号 5 个块被拒在**关键词行**上 ——
  // `16g`（夹着昵称 `16`）、`deepseek-v4-pro`（夹着昵称 `deepseek`）。
  // 正文已经干净，是提纲把名字带了出去；而这一行是**拼在归一化之后**的，自己不过闸门。
  const n = new Normalizer({ secret: SECRET });
  n.setVocabulary([
    ...VOCAB,
    { id: 'qq:3878663199', kind: 'person', surface: ['deepseek'] },
    { id: 'qq:3127332917', kind: 'person', surface: ['16'] }
  ]);
  const chunk = {
    id: 'hour_group_1_2026-10-1410', chatKey: 'group:1', summary: '在聊显卡',
    keywords: ['deepseek-v4-pro', '16g', '显存', '内存']
  };
  const line = buildKeywordLine(chunk, { keywordsSource: 'filtered', normalizer: n });
  assert.ok(!line.text.includes('deepseek'),
    `夹着昵称的长复合词整词丢掉 —— 实得 ${line.text}`);
  assert.ok(line.text.includes('16g'),
    `≤3 位的短词条不管关键词行（降权：它不再一票否决）—— 实得 ${line.text}`);
  assert.ok(line.report.droppedLeaky >= 1 && line.report.droppedLeakyList[0].term === 'deepseek',
    '丢掉哪些、为什么，report 里看得见（不是静默少几个词）');

  // 端到端：这块不再被整块拒绝
  const info = buildEmbedText(chunk, { normalizer: n, maxChars: 1200, register: false });
  assert.ok(!info.text.includes('deepseek'), '出境文本里没有名字');
  assert.match(info.text.split('\n')[0], /^关键词：/, '关键词行还在（只是少了那个词）');
});
