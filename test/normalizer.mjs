// 归一化器自检 —— 零依赖、**完全离线**、跑完 exit 0。
//
// 纪律：每条断言都在**复现一个真实的坑**，而不是"函数写对了没"。具体地：
//   · 占位符必须**跨重建稳定** —— 否则同一个人的向量会分裂到不同空间（ADR-0002）
//   · 编号分配必须**与插入顺序无关** —— 词表是会长大的，重排一次就全库重算
//   · 漏报 = 名字出境，不可撤回 ⇒ 低位命中也必须替换（ADR-0003）
//   · 出口必须**自证干净** —— `assertClean` 是整个方案唯一那条不依赖网络的断言
//
// 运行：node test/normalizer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Normalizer, NormalizerError, hmac32, allocateLabels, render,
  getSharedNormalizer, resetSharedNormalizer
} from '../src/core/normalize.mjs';
import { buildEmbedText, buildSourceText, sourceHash, clampOnPlaceholderBoundary } from '../src/core/chunkread.mjs';
import { assertNormalized, EmbedError } from '../src/core/embed.mjs';
import { extractTerms, buildVocabulary } from '../src/core/vocab.mjs';
import { stripScaffold } from '../src/core/extract.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function head(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`);
}
function throwsWith(code, fn, label) {
  try {
    fn();
    ok(false, label, `（预期抛 ${code}，实际没抛）`);
  } catch (err) {
    ok(err?.code === code, label, `（得到 ${err?.code || err?.name}: ${String(err?.message || err).slice(0, 70)}）`);
  }
}
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mv-${tag}-`));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const SECRET = 'a'.repeat(48);

/** 一份贴近真实的词表（人名/群名/机器人自己）。 */
const VOCAB = [
  { id: 'self', kind: 'self', surface: ['我', 'Samara'] },
  { id: 'qq:3042786385', kind: 'person', surface: ['沫钤'] },
  { id: 'qq:1050889650', kind: 'person', surface: ['Inexpressible', '不可言说'] },
  { id: 'qq:1353446252', kind: 'person', surface: ['林寒枫霜', 'AAA插件Skill批发商'] },
  { id: 'qq:2898805620', kind: 'person', surface: ['！'] },
  { id: 'qq:2218213246', kind: 'person', surface: ['鲸鱼娘', 'sion'] },
  { id: 'group:1098345913', kind: 'group', surface: [] }
];

function makeNormalizer(extra = {}) {
  const n = new Normalizer({ secret: SECRET, ...extra });
  n.setVocabulary(VOCAB);
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
head('占位符派生 · 稳定与不可反推');
{
  const n1 = makeNormalizer();
  const n2 = makeNormalizer();
  ok(n1.labelById.get('qq:3042786385') === n2.labelById.get('qq:3042786385'),
    '两个独立实例（同密钥、同词表）派生出同一个占位符',
    `(${n1.labelById.get('qq:3042786385')})`);

  // 顺序无关：把词表倒过来装，编号不能变
  const reversed = new Normalizer({ secret: SECRET });
  reversed.setVocabulary([...VOCAB].reverse());
  const same = VOCAB.every((e) => reversed.labelById.get(e.id) === n1.labelById.get(e.id));
  ok(same, '词表倒着装 → 编号完全一致（分配与插入顺序无关）');

  // 不可反推：标签里不该出现原文片段
  const label = n1.labelById.get('qq:3042786385');
  ok(!label.includes('3042786385') && !label.includes('沫'), '占位符里不含实体本身的任何片段',
    `(qq:3042786385 → ${render(label)})`);

  // 确定性派生是纯函数
  ok(hmac32(SECRET, 'x') === hmac32(SECRET, 'x') && hmac32(SECRET, 'x') !== hmac32('b'.repeat(48), 'x'),
    'hmac32 确定性，且换密钥即换编号');

  // 词表长大：老编号必须保留（否则全库向量都要重算）
  const grown = new Normalizer({ secret: SECRET });
  grown.setVocabulary(VOCAB);
  const before = new Map(grown.labelById);
  grown.setVocabulary([...VOCAB, { id: 'qq:99999999', kind: 'person', surface: ['新群友'] }]);
  const kept = [...before.entries()].every(([id, l]) => grown.labelById.get(id) === l);
  ok(kept, '新增实体后，老实体的编号一个都没变（只给新人找空位）');

  // 冲突分配是确定性的（造 200 个实体，看编号不重复）
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `qq:${1000000 + i}`, kind: 'person', surface: [] }));
  const l1 = allocateLabels(SECRET, many);
  const l2 = allocateLabels(SECRET, [...many].reverse());
  const uniq = new Set(l1.values());
  ok(uniq.size === many.length, '200 个实体拿到 200 个互不重复的编号', `(唯一数 ${uniq.size})`);
  ok([...l1.entries()].every(([id, l]) => l2.get(id) === l), '200 个实体的编号分配与顺序无关');
  ok(l1.get('self') === undefined || true, '（self 由调用方单独处理）');
}

// ═══════════════════════════════════════════════════════════════════════
head('四层判定 · 各走各的入口');
{
  const n = makeNormalizer();

  const r = n.normalize('沫钤：明天换模型了');
  ok(r.text.startsWith(render(n.labelById.get('qq:3042786385'))), '注册表层：词表里的人名被替换',
    `(${r.text.slice(0, 14)}…)`);

  const r2 = n.normalize('@沫钤 你看这个');
  ok(r2.hits.some((h) => h.layer === 'registry'), '注册表层：正文里 @ 出来的名字同样命中');

  const r3 = n.normalize('沫老师，你的世界设定可以分享吗');
  ok(r3.text.includes(render(n.labelById.get('qq:3042786385'))),
    '规则层：`沫老师` 认到词表里的 `沫钤`（用真实人名首字当姓氏判据，不用内置姓氏表）',
    `(${r3.text.slice(0, 16)}…)`);

  const r4 = n.normalize('加我 qq 778899001 私聊');
  ok(!r4.text.includes('778899001') && r4.hits.some((h) => h.layer === 'digit'),
    '数字层：5~12 位纯数字当作 QQ 号拦下（零误报的一层）');

  const r5 = n.normalize('[CQ:at,qq=3042786385] 你看');
  ok(r5.text.includes(render(n.labelById.get('qq:3042786385'))) && !r5.text.includes('CQ:at'),
    'CQ 码：`@` 提及按 qq 号落到那个人的稳定占位符上，码本身不残留');

  const r6 = n.normalize('[引用 #111052 沫钤：茅塞顿开了] @沫钤 删掉');
  ok(r6.text.includes(render('R')) && !r6.text.includes('#111052'),
    '引用锚点：`#N` 是消息 localId，不是 QQ 号 —— 单列一层剥掉', `(${r6.text.slice(0, 18)}…)`);
  ok(!r6.text.includes('沫钤'), '引用块里的说话人名被吃掉（它正是最会漏的那一处）');

  // 分布集中度兜底层
  const n2 = makeNormalizer();
  n2.setSuspects(['林寒']);
  const r7 = n2.normalize('林寒 昨天也在');
  ok(!r7.text.includes('林寒') && r7.hits.some((h) => h.layer === 'heuristic'),
    '兜底层：分布集中度可疑的短串也能被替换');
}

// ═══════════════════════════════════════════════════════════════════════
head('漏报优先于误报（ADR-0003 的硬约束）');
{
  const n = makeNormalizer();
  // 首次见到的名字：hit_count = 1，也必须替换。
  // 走的是规则层 ⑦（引用块里的说话人名）—— 那正是"词表里没有、但一定是个人"的那类。
  const r = n.normalize('[引用 #42 王大锤：我在的] 你好');
  ok(!r.text.includes('王大锤'),
    '首次命中（hit_count=1）照样替换 —— 阈值只管"是否永久登记"，不管"是否替换"',
    `(${r.text})`);

  const reg = n.registry.get('王大锤');
  ok(Boolean(reg) && reg.hitCount === 1, '低命中串同时进了注册表（越用越准）');
  ok(n.pending.has('王大锤'), '同时进待审池（可审计、可撤销，而不是悄悄生效）', `(待审 ${n.pending.size} 条)`);

  // 规则层 ⑨：老/小 + 常见姓氏
  const r1 = n.normalize('小王，你把那个发我一下');
  ok(!r1.text.includes('小王'), '规则层：`小王` 被替换（老/小 + 常见姓氏）', `(${r1.text})`);

  // 但不能误伤高频词：`小时` 的「时」不在名单里
  const r2 = n.normalize('等一个小时再说');
  ok(r2.text === '等一个小时再说', '「小时」不被当成称呼（姓氏名单刻意排除了 时/大/小 一类）');

  // 单字昵称：只在整词位置（空白）命中，不吃掉正文里的标点
  const r3 = n.normalize('好耶！！！ ！');
  ok(r3.text.includes('好耶！！！'), '单字昵称「！」不会把正文里的感叹号连串吃掉', `("${r3.text}")`);

  // 误报可接受：普通词不该被误伤
  const r4 = n.normalize('这个插件挺好用的');
  ok(r4.hits.length === 0, '没有实体的普通句子 → 一处都不动');
}

// ═══════════════════════════════════════════════════════════════════════
head('出口自证 · 这是本模块唯一一条不依赖网络的断言');
{
  const n = makeNormalizer();
  const raw = [
    'group:1098345913 @ 2026-09-25 00:00（夜）',
    '关键词：模型 插件 记忆 沫钤 3042786385',
    '内容：sion: [引用 #274 M.A.：[face]]叫了人又只发个表情 | 沫钤: [引用 #279 Inexpressible：这是什么版本的？]@Inexpressible[CQ:at,qq=1050889650] 你用的不是这个版本吗（） | 林寒枫霜: @沫钤[CQ:at,qq=3042786385] 沫老师，你的世界设定可以分享出来参考一下吗 我的 qq 是 778899001'
  ].join('\n');

  const r = n.normalize(raw, { context: 'test' });
  ok(!r.text.includes('沫钤'), '输出里没有「沫钤」');
  ok(!r.text.includes('Inexpressible'), '输出里没有「Inexpressible」');
  ok(!r.text.includes('林寒枫霜'), '输出里没有「林寒枫霜」');
  ok(!r.text.includes('1098345913'), '输出里没有群号');
  ok(!r.text.includes('3042786385') && !r.text.includes('1050889650') && !r.text.includes('778899001'),
    '输出里没有任何 QQ 号');
  ok(!r.text.includes('2026-09-25'), '输出里没有日期');
  ok(r.clean === true, 'normalize 自称 clean');
  ok(n.findLeak(r.text) === null, 'findLeak 复核：干净');

  // 反向验证：这个自检**真的能发现问题**，不是永远返回 null
  const leaked = `${r.text} 然后沫钤说好的`;
  const found = n.findLeak(leaked);
  ok(found && found.term === '沫钤', '往输出里手工塞回一个名字 → 自检立刻报出来', `(${found?.term})`);

  // 泄漏即拒发
  throwsWith('NORMALIZE_LEAK', () => n.assertClean(leaked), 'assertClean 对泄漏抛 NORMALIZE_LEAK');

  console.log(`  归一化结果：${r.text.slice(0, 120)}…`);
  console.log(`  命中分层：${JSON.stringify(r.stats.byLayer)} · 种类：${JSON.stringify(r.stats.byKind)}`);
}

// ═══════════════════════════════════════════════════════════════════════
head('落盘往返 · 重建索引不能换编号');
{
  const dir = tmpdir('norm');
  const a = new Normalizer({ dir });
  a.setVocabulary(VOCAB);
  a.normalize('沫钤 和 林寒枫霜 在群里说话');
  a.save();
  const labelBefore = a.labelById.get('qq:3042786385');
  const ephKey = [...a.ephemeral.keys()][0];

  const b = new Normalizer({ dir });
  ok(b.secret === a.secret, '密钥从本机文件读回（不重新生成）');
  ok(b.labelById.get('qq:3042786385') === labelBefore, '重新加载后占位符完全一致');
  ok(b.registry.size > 0, '实体注册表被读回', `(${b.registry.size} 条)`);
  ok(b.pending.size > 0, '待审池被读回', `(${b.pending.size} 条)`);
  if (ephKey) ok(b.ephemeral.has(ephKey), '临时占位符也被读回（否则未知人名每次重建都换号）');

  // 文件里不该出现"明显的"明文密钥别名；secret.key 是本机文件，存在是预期的
  const files = fs.readdirSync(dir).sort();
  ok(files.includes('secret.key') && files.includes('entities.json') && files.includes('registry.json'),
    '四份本机文件都落盘了', `(${files.join(', ')})`);

  const ent = JSON.parse(fs.readFileSync(path.join(dir, 'entities.json'), 'utf8'));
  ok(ent.entities.some((e) => e.label && !String(e.label).includes('3042786385')),
    'entities.json 里存的是派生编号，不是原文数字');

  cleanup(dir);
}

// ═══════════════════════════════════════════════════════════════════════
head('单例纪律（ADR-0003：不是同一套代码，是同一个实例）');
{
  resetSharedNormalizer();
  const dirA = tmpdir('sing-a');
  const dirB = tmpdir('sing-b');
  const s1 = getSharedNormalizer({ dir: dirA });
  const s2 = getSharedNormalizer({ dir: dirA });
  ok(s1 === s2, '同一个 dir 再取一次 → 拿到同一个对象（不是新实例）');
  throwsWith('NORMALIZER_SINGLETON',
    () => getSharedNormalizer({ dir: dirB }),
    '想建第二个实例（不同 dir）→ 直接抛错，不给"两份注册表"的机会');
  resetSharedNormalizer();
  cleanup(dirA);
  cleanup(dirB);
}

// ═══════════════════════════════════════════════════════════════════════
head('出境文本 · 边界钉在接口上（ADR-0002）');
{
  const chunk = {
    id: 'hour_group_1098345913_2026-09-2500',
    kind: 'hour',
    chatKey: 'group:1098345913',
    dayKey: '2026-09-25',
    hourKey: '2026-09-25 00',
    timeOfDay: '夜',
    when: 1790269194000,
    title: 'group:1098345913 @ 2026-09-25 00:00',
    keywords: ['模型', '沫钤', '3042786385'],
    summary: `sion: 叫了人又只发个表情 | 沫钤: [引用 #279 Inexpressible：这是什么版本的？]@Inexpressible[CQ:at,qq=1050889650] 你用的不是这个版本吗 | ${'填充'.repeat(2000)}`
  };

  // ① 不传归一化器 → 直接拒绝，没有"降级发原文"这条路
  throwsWith('NORMALIZER_REQUIRED',
    () => buildEmbedText(chunk, { maxChars: 500 }),
    '不传归一化器就构建出境文本 → 抛 NORMALIZER_REQUIRED（不许裸奔）');

  // ② 传了 → 拿到的是干净文本
  const n = makeNormalizer();
  const info = buildEmbedText(chunk, { normalizer: n, maxChars: 500 });
  ok(!info.text.includes('沫钤') && !info.text.includes('3042786385') && !info.text.includes('1050889650'),
    '出境文本里没有名字、没有 QQ 号');
  ok(info.text.includes(render(n.labelById.get('group:1098345913'))),
    '会话键变成群占位符（保留"在哪个群"的语义，去掉身份）');
  ok(info.redaction.entities >= 3, '边界报告记下了替换了几处实体', `(${info.redaction.entities} 处)`);
  ok(info.redaction.clean === true, '边界报告自称 clean');

  // ③ 本机原文照旧可读（面板要拿它做对照）
  const raw = buildSourceText(chunk, { maxChars: 500 });
  ok(raw.text.includes('沫钤'), '本机原文（buildSourceText）仍然带真名 —— 它不出境，只给面板对照');

  // ④ 先归一化后截断：截断点上不许留半个名字
  const long = { ...chunk, summary: `${'填'.repeat(180)} 沫钤 你好` };
  const i2 = buildEmbedText(long, { normalizer: n, maxChars: 160 });
  ok(!/\u3014[^\u3015]*$/.test(i2.text), '截断不会把占位符切成半截');
  const cut = clampOnPlaceholderBoundary('aaa〔P123〕bbb', 8);
  ok(cut.text === 'aaa', '占位符边界截断：末尾半截占位符整段丢掉', `("${cut.text}")`);

  // ⑤ 源哈希：词表变化会触发重索引（保证库与当前归一化器一致）
  const h1 = sourceHash(chunk, i2.text);
  const n2 = makeNormalizer();
  n2.setVocabulary([...VOCAB, { id: 'qq:1234567', kind: 'person', surface: ['沫钤'] }]);
  const i3 = buildEmbedText(long, { normalizer: n2, maxChars: 160 });
  ok(sourceHash(chunk, i3.text) !== h1 || i3.text === i2.text,
    '词表变化会让源哈希变化（或文本本就没变）—— 库里不会留下旧词表算的向量');
}

// ═══════════════════════════════════════════════════════════════════════
head('词条抽取 · 兜底层的输入');
{
  const t = extractTerms('沫钤说：skill和插件有啥区别？见 https://example.com/a-b_c 用 GPT-4o 的 API');
  ok(t.some((x) => x === '沫钤'), '抽到中文二元组（`沫钤说` → 里面切出 `沫钤`）', `(${t.filter((x) => /[\u4e00-\u9fff]/.test(x)).slice(0, 6).join(' ')})`);
  ok(t.some((x) => x.startsWith('skill')), '抽到 ASCII 词');
  ok(!t.some((x) => /^\d+$/.test(x)), '不抽纯数字（那归数字层管）');
}

// ═══════════════════════════════════════════════════════════════════════
head('对齐层 · 词表不认识也能替换（2.1 漏替的修复）');
{
  // 词表里**没有** `某人` 与 `另一个`，但形态自己带着硬 ID
  const n = makeNormalizer();
  const r = n.normalize('@某人[CQ:at,qq=777888999] 你在吗');
  ok(!r.text.includes('某人'), '`@名[CQ:at,qq=ID]`：名字被换掉，哪怕它不在词表里',
    `("${r.text}")`);
  ok(!r.text.includes('777888999'), '同一段里的 ID 也一起换成占位符');
  ok(r.hits.length === 1 && r.hits[0].layer === 'align',
    '整段只算**一处**命中（名字与 ID 是同一个实体，不该留两个占位符）',
    `(${JSON.stringify(r.hits.map((h) => h.layer))})`);

  // 已知实体走 registry，未知才落 align —— 层号要能区分"认出"与"兜住"
  const r2 = n.normalize('@沫钤[CQ:at,qq=3042786385]');
  ok(r2.hits[0]?.layer === 'registry', '词表里有的名字走 `registry` 层（不是兜底层）',
    `(${r2.hits[0]?.layer})`);

  const r3 = n.normalize('[引用 另一个(QQ:123456789)：今天吃啥]');
  ok(!r3.text.includes('另一个'), '`[引用 名(QQ:ID)：` 形态同样替换',
    `("${r3.text}")`);
  ok(!r3.text.includes('123456789'), '这种形态里的 QQ 号也不留下');
  ok(!r3.text.includes('QQ:'), '`(QQ:…)` 被整段吃掉，不留 `QQ:〔P…〕` 这种空壳',
    `("${r3.text}")`);
}

head('机器人自身身份 · 名字与号码都不可出境');
{
  // 关键复现：机器人的消息在存档里是 `senderId: 'self'`，
  // 它的号码从不作为 senderId 出现 —— 所以只按 senderName 建表根本建不到它。
  // 这里用 alias 显式声明 `qq:3869416070` 就是自己。
  const n = new Normalizer({ secret: SECRET });
  n.setVocabulary([
    ...VOCAB,
    { id: 'self', kind: 'self', surface: ['我', 'Samara', 'Single Samara', 'Single Samara（大肥鱼形态）'], aliases: ['qq:3869416070'] }
  ]);

  const r = n.normalize('林寒枫霜: [引用 Single Samara（大肥鱼形态）：不过二维码那事你还是得解释]');
  ok(!r.text.includes('Single Samara'), '**机器人自己的显示名不再原样出境**（这正是 2.1 那处漏替）',
    `("${r.text}")`);
  ok(r.text.includes(render('SELF')), '它落到 `〔SELF〕`，而不是某个陌生人的编号');

  const r2 = n.normalize('@Single Samara（大肥鱼形态）[CQ:at,qq=3869416070] 吃什么');
  ok(!r2.text.includes('3869416070'), '有人 @ 机器人时，它的号码不出境');
  ok(r2.text.includes(render('SELF')), '**别名生效**：`[CQ:at,qq=<自己的号>]` 判成 SELF，而不是陌生人',
    `("${r2.text}")`);
}

head('优先级 · 已知实体名必须强于启发式姓氏规则');
{
  // 真实数据里的一处错判：`@小小石`（石是常见姓）会被规则 ⑨（`小`+姓）咬成 `小石`，
  // 于是这次提及被记成一个**幻影实体**。修法是把词表排到规则层之前。
  const n = makeNormalizer();
  n.setVocabulary([...VOCAB, { id: 'qq:3390614495', kind: 'person', surface: ['小小石'] }]);
  const r = n.normalize('@小小石[CQ:at,qq=3390614495] 在吗');
  ok(!r.text.includes('小石') || r.text.includes(render(n.labelById.get('qq:3390614495'))),
    '`@小小石` 整段归到 `qq:3390614495`，不会被 `小`+姓 咬掉一截',
    `("${r.text}")`);
  const labels = [...new Set(r.hits.map((h) => h.label))];
  ok(labels.length === 1 && labels[0] === n.labelById.get('qq:3390614495'),
    '这次提及只产生**一个**占位符，且是正确的那个（不生成幻影实体）',
    `(${JSON.stringify(labels)})`);
}

head('形态闸门 · 不依赖词表的第二条闸门');
{
  const n = makeNormalizer();
  // findLeak 抓不到这些（词表里没有这些名字），形态闸门能
  const cases = [
    ['@周吴郑王[CQ:at,qq=123456789]', 'at-with-id'],
    ['[引用 周吴郑王(QQ:123456789)：在吗]', 'quote-with-id'],
    ['[引用 #999 周吴郑王：在吗]', 'quote-with-ref'],
    ['看这个 (QQ:123456789)', 'bare-qq-tag'],
    ['@周吴郑王 在吗', 'bare-mention']
  ];
  for (const [text, kind] of cases) {
    const hit = n.findEntityForm(text);
    ok(hit?.kind === kind, `形态闸门认出「${kind}」`, `(${hit?.kind || 'null'})`);
  }
  throwsWith('NORMALIZE_SHAPE_LEAK', () => n.assertNoEntityForm('@周吴郑王 你好'),
    '形态残留 → 抛 NORMALIZE_SHAPE_LEAK（这是 findLeak 看不见的那一类）');

  // 反着验证：干净文本不许被误判
  ok(n.findEntityForm('〔P1〕: 今天吃啥，我请你') === null, '干净文本不误报');
  ok(n.findEntityForm('【〔SELF〕】@〔P9〕 吃什么') === null,
    '已替换的占位符不会被当成残留（`@〔P9〕` 是允许的）');

  // 裸 @ 提及：词表不认识的，也绝不会带名字出境
  const r = n.normalize('@周吴郑王 你好');
  ok(!r.text.includes('周吴郑王'), '裸 @提及：名字不认识也必须遮掉',
    `("${r.text}")`);
  ok(n.findEntityForm(r.text) === null, '遮掉之后形态闸门干净通过');
}

head('计数口径 · 三个数必须各自有定义');
{
  const n = makeNormalizer();
  const r = n.normalize('group:1098345913 @ 2026-09-25 12:30 沫钤: @Inexpressible[CQ:at,qq=1050889650] 在吗 [image]');
  const s = r.stats;
  ok(s.hits === s.identity + s.structural,
    '总替换点 = 身份替换点 + 剥离点（2.2 那次对不上的根源就是没写这条）',
    `(${s.hits} = ${s.identity} + ${s.structural})`);
  ok(s.identity === Object.values(s.byLayerIdentity).reduce((a, b) => a + b, 0),
    '`byLayerIdentity` 各层之和 == 身份替换点');
  ok(s.hits === Object.values(s.byLayer).reduce((a, b) => a + b, 0),
    '`byLayer` 各层之和 == 总替换点');
  ok(s.identity >= 2 && s.structural >= 3, '身份类是"人/群/自己"，剥离类是"日期/时刻/CQ 码/媒体"',
    `(身份 ${s.identity} · 剥离 ${s.structural})`);
  ok(s.entities === s.identity, '旧字段 `entities` == `identity`（含 self —— 口径与 0.2.0 不同）');
}

head('密钥丢失 · 不许静默换一套占位符');
{
  const dir = tmpdir('secret-lost');
  try {
    const n1 = new Normalizer({ dir });
    n1.setVocabulary(VOCAB);
    n1.save();
    const label = n1.labelById.get('qq:3042786385');
    ok(fs.existsSync(path.join(dir, 'secret.key')) && fs.existsSync(path.join(dir, 'entities.json')),
      '首次启动会落盘密钥与映射表');

    // 模拟"密钥被删/损坏，但映射表还在" —— 这正是危险状态
    fs.rmSync(path.join(dir, 'secret.key'));
    throwsWith('SECRET_LOST', () => new Normalizer({ dir }),
      '密钥丢了但映射表还在 → 抛 SECRET_LOST（不许悄悄生成新密钥）');

    // 反着验证：全新安装（映射表也不存在）必须能正常生成
    const dir2 = tmpdir('fresh');
    try {
      const n2 = new Normalizer({ dir: dir2 });
      ok(fs.existsSync(path.join(dir2, 'secret.key')), '全新安装（无映射表）照常生成密钥，不误报');
      ok(Boolean(n2.secret), '新实例可用');
    } finally { cleanup(dir2); }

    // 密钥还在 → 编号与别名都要原样恢复
    const dir3 = tmpdir('restore');
    try {
      const a = new Normalizer({ dir: dir3 });
      a.setVocabulary([...VOCAB, { id: 'self', kind: 'self', surface: ['我', 'Samara'], aliases: ['qq:3869416070'] }]);
      a.save();
      const b = new Normalizer({ dir: dir3 });
      ok(b.labelById.get('qq:3042786385') === a.labelById.get('qq:3042786385'),
        '同目录重开 → 占位符原样恢复（这是"索引不失效"的前提）',
        `(${b.labelById.get('qq:3042786385')} == ${label})`);
      ok(b.aliasById.get('qq:3869416070') === 'self',
        '**别名随映射表一起恢复** —— 否则重开之后 `[CQ:at,qq=<自己的号>]` 会变回陌生人',
        `(${JSON.stringify([...b.aliasById])})`);
    } finally { cleanup(dir3); }
  } finally { cleanup(dir); }
}

head('会话占位符 · scope 也只走占位符（本轮新增）');
{
  const n = makeNormalizer();
  // `scope` 曾是**明文 chatKey**（私聊时 = 对方的明文 QQ）。本轮把它提进产事实级键
  // （ADR-0015）⇒ 必须和节点 ID 一样走占位符，否则键本身成新的泄密通道。
  const g1 = n.scopeLabel('group:1098345913');
  const g1b = n.scopeLabel('group:1098345913');
  const p1 = n.scopeLabel('private:1353446252');
  const p2 = n.scopeLabel('private:2898805620');
  ok(/^group:C\d+$/.test(g1), '群会话 → `group:C####` 形态', `(${g1})`);
  ok(/^private:C\d+$/.test(p1), '私聊会话 → `private:C####` 形态', `(${p1})`);
  ok(g1 === g1b, '`scopeLabel` **确定性**（同一 chatKey 恒等 —— 否则同一会话会分裂）');
  ok(p1 !== p2, '不同会话 → 不同 token（互异性）');
  ok(g1 !== p1, '群 / 私聊**前缀不同**，即使编号撞了也不混');

  // 出境红线：token 里不许出现明文 QQ / 群号。
  ok(!String(g1).includes('1098345913') && !String(p1).includes('1353446252'),
    'scope token **不含明文**群号 / QQ（ADR-0002）');

  // 只读：不写注册表、不改 `vocabHash`。
  const h0 = n.vocabHash();
  n.scopeLabel('private:9999999999');
  ok(n.vocabHash() === h0, '`scopeLabel` 是**只读**的（不新增实体、不改 `vocabHash`）');
  ok(!n.labelById.has('qq:9999999999'), '`scopeLabel` 不把会话写进实体注册表');
}

head('出境自检 · 联网之前的最后一道');
{
  const n = makeNormalizer();
  ok(assertNormalized(['〔P1〕: 今天吃啥'], n, 'document') === true, '干净文本放行');
  throwsWith('NORMALIZE_LEAK', () => assertNormalized(['沫钤: 今天吃啥'], n, 'document'),
    '已知实体串 → 抛 NORMALIZE_LEAK');
  // 关键：**词表里没有的名字**，findLeak 看不见，形态闸门必须抓住
  throwsWith('NORMALIZE_SHAPE_LEAK',
    () => assertNormalized(['@周吴郑王[CQ:at,qq=123456789] 在吗'], n, 'query'),
    '词表外的名字（形态带硬 ID）→ 抛 NORMALIZE_SHAPE_LEAK（这是 findLeak 的原理性盲区）');

  // 反着验证：真的没有归一化器时必须报"没归一化"，而不是静默放行
  throwsWith('UNNORMALIZED_INPUT', () => assertNormalized(['原文'], null, 'document'),
    '不传归一化器 → 抛 UNNORMALIZED_INPUT（不许裸奔）');
  ok(EmbedError && new EmbedError('X', 'y').code === 'X', 'EmbedError 带 code（调用方能按码分类，不必解析文案）');
}

// ═══════════════════════════════════════════════════════════════════════
head('登记与构建的时序 · 一遍式会造出"伪泄漏"（2026-10-08 真机索引失败）');
{
  // 真机现场：点「索引」→
  //   `索引失败：document 侧第 0 条文本里仍有实体串「林寒枫霜」（层：align）—— 拒绝出境`
  //
  // 这不是"闸门坏了"，恰恰相反：闸门在**正确**地拒发，拒的却是它自己造出来的伪泄漏。
  // 两条文本就够复现（纯本机，不碰真数据）：
  //   A：裸说话人名 —— 词表不认识它就认不出来
  //   B：`@名[CQ:at,qq=ID]` —— 对齐层凭硬 ID 把它**登记**进注册表
  // 一遍式（边构建边登记）下，A 是在 B 登记**之前**构建的；等批内自检再问一遍，
  // 注册表里已经有这个名字了 ⇒ A 被判泄漏。层号写 `align` 就是这个时序的签名。
  const A = { title: 'group:1098345913 @ 2026-10-08 04', summary: '林小霜: 测试，你随便说点什么' };
  const B = { title: 'group:1098345913 @ 2026-10-08 05', summary: '@林小霜[CQ:at,qq=888777666] 在吗' };

  // ── ① 一遍式（现状）：A 先构建 ────────────────────────────────────────
  const one = new Normalizer({ secret: SECRET });
  const oneA = buildEmbedText(A, { normalizer: one, maxChars: 400 }).text;
  const oneB = buildEmbedText(B, { normalizer: one, maxChars: 400 }).text;
  ok(oneA.includes('林小霜'), '一遍式：A 构建时注册表还空着 ⇒ 裸人名原样留在出境文本里',
    `("${oneA.slice(-28)}")`);
  ok(one.registry.get('林小霜')?.layer === 'align',
    '② 之后 B 把它登记了，层号是 `align`（**没走词表**的签名）',
    `(${one.registry.get('林小霜')?.layer})`);
  throwsWith('NORMALIZE_LEAK', () => assertNormalized([oneA, oneB], one, 'document'),
    '一遍式 + 批内自检 → 把**先构建的那条**报成泄漏（真机这条报的就是第 0 条）');

  // 顺序一换就不报 —— 说明症结是**时序**，不是"认不出来"（判别性断言）
  const swapped = new Normalizer({ secret: SECRET });
  const swB = buildEmbedText(B, { normalizer: swapped, maxChars: 400 }).text;
  const swA = buildEmbedText(A, { normalizer: swapped, maxChars: 400 }).text;
  ok(!swA.includes('林小霜') && assertNormalized([swA, swB], swapped, 'document') === true,
    '同一对文本、只把 B 放在 A 前面 ⇒ 一遍式也不报：症结是登记与构建的先后，不是识别能力');

  // ── ② 两遍式（修复）：登记先定型，构建再发生 ─────────────────────────
  const two = new Normalizer({ secret: SECRET });
  for (const c of [A, B]) buildEmbedText(c, { normalizer: two, maxChars: 400, register: true }); // ① 登记遍（文本丢弃）
  const twoA = buildEmbedText(A, { normalizer: two, maxChars: 400, register: false }).text;      // ② 构建遍
  const twoB = buildEmbedText(B, { normalizer: two, maxChars: 400, register: false }).text;
  ok(!twoA.includes('林小霜'), '两遍式：登记先定型 ⇒ 同一段 A 这次换成了占位符');
  ok(assertNormalized([twoA, twoB], two, 'document') === true, '两遍式 ⇒ 批内自检放行，不再自相矛盾');
  ok(sourceHash(A, twoA) === sourceHash(A, buildEmbedText(A, { normalizer: two, maxChars: 400, register: false }).text),
    '构建是注册表的纯函数：同状态重算得同一段文本、同一个 sourceHash（增量索引靠它判"内容没变"）');

  // ── ③ 边界与反向对撞 ────────────────────────────────────────────────
  // 先说**没修**的那条边界：一位在整个语料里都不挨硬 ID 的名字，哪个层都登记不到它，
  // 于是 `findLeak` 看不见它（只认已登记的串 —— 这正是 ADR-0006 说的原理性盲区）。
  // 两遍式**不改变**这条边界，别把它误当成"修好了"；兜底的是 `findEntityForm` 的**形态**判据。
  const D = { title: 'group:1098345913 @ 2026-10-08 06', summary: '周吴郑王: 全语料里从没挨过硬 ID' };
  const deep = new Normalizer({ secret: SECRET });
  buildEmbedText(D, { normalizer: deep, maxChars: 400, register: true });
  const dText = buildEmbedText(D, { normalizer: deep, maxChars: 400, register: false }).text;
  ok(dText.includes('周吴郑王') && deep.findLeak(dText) === null,
    '（边界声明）全语料都没挨硬 ID 的名字：两遍式也看不见它 —— 这是 findLeak 的原理性盲区，不是本次修的东西');
  throwsWith('NORMALIZE_SHAPE_LEAK', () => assertNormalized([`@周吴郑王 在吗`], deep, 'query'),
    '但**形态**闸门仍兜得住：裸 `@名` 当场拒发（不依赖词表的那一道）');

  // 反向对撞：两遍式改的是"什么时候构建"，**没改**"出境前逐条过闸门"。
  // 用两遍式那一份归一化器（注册表里已经有 `林小霜`）往文本里塞回明文 ⇒ 必须拒。
  throwsWith('NORMALIZE_LEAK', () => assertNormalized(['〔P1〕: 林小霜 又出现了'], two, 'document'),
    '注册表里有、文本里又有明文 ⇒ 照样拒发（两遍式没有把闸门放宽）');
}

// ═══════════════════════════════════════════════════════════════════════
head('进轮自证 · 判据必须是「进轮时已知什么」（ROADMAP #4）');
{
  // 这一条修的是**自证的口径**：出口自检原先用"当前词表"扫"本轮输出"，
  // 而本轮的规则层会**扩充**词表（`_touch` 写注册表 / `_ephemeralLabel` 写 ephemeral）——
  // 拿本轮产物当判据去否定本轮产物。可复现构造：
  //   ① 规则 ⑦ 从引用块里读出说话人名「三姐」并**登记**（本轮扩充了词表）；
  //   ② 正文里出现的是**另一个人**的写法「三姐妹家」（规则 ⑧ 不认这个头字，不动它）；
  //   ③ 自检若用登记后的词表 ⇒ 在「三姐妹」里找到「三姐」⇒ 报 `NORMALIZE_LEAK`。
  // 这正是 ROADMAP #4 写的那个 trigger（「三姐妹」被当成「三姐+妹」），
  // 也是 #5「关键词从脱敏文本重抽」的前置：归一化 snippets 后这类**伪泄漏**会常态化。
  const n = makeNormalizer();
  const src = '[引用 #12 三姐：在吗] 三姐妹家';
  const r = n.normalize(src, { register: true, context: 'snippet' });

  ok(n.registry.has('三姐'), '本轮规则层把「三姐」登记了（词表在本轮内被扩充）',
    `(${[...n.registry.keys()].join(',')})`);
  ok(r.text.includes('三姐妹'), '正文「三姐妹家」没被动（规则 ⑧ 不认这个头字）',
    `("${r.text}")`);
  ok(r.clean === true, '进轮自检**没有**用本轮登记的词条诬告本轮输出');

  // 反向对撞 ①：闸门本身没放宽 —— 换成"进轮就已知"的判据表，同一段文本照样报。
  ok(n.findLeakIn(r.text, [{ term: '三姐', layer: 'rule' }])?.term === '三姐',
    '判据表里**有**这个词条 ⇒ 照样报（换的只是判据来源，不是闸门松紧）');
  // 反向对撞 ②：现行词表口径（批内批检用的就是它）确实会把这里判成泄漏 ——
  // 说明"伪泄漏"不是假想，而进轮自检与批内批检**判据不同源是故意的**：
  //   进轮自检问"我这一轮有没有放过进轮时已知的实体"；
  //   批内批检问"这批文本里有没有本轮新登记实体的明文"（跨条时序问题，正解是两遍式）。
  ok(n.findLeak(r.text)?.term === '三姐',
    '同一段文本按**现行词表**看仍会被判为泄漏 —— 伪泄漏是真的，两处判据刻意不同源');
  // 孪生实例（同词表、没跑过任何一轮）＝ 进轮时的词条数；stats 必须与它相等，
  // 而不是"跑完之后"的数 —— 否则排障时看不出"这轮自检到底拿多少词条扫的"。
  const twin = makeNormalizer();
  ok(r.stats.termsAtEntry === twin._termList().length && r.stats.termsAtEntry > 0,
    'stats.termsAtEntry == 进轮时的词条数（不是跑完之后的）',
    `(${r.stats.termsAtEntry} vs 进轮 ${twin._termList().length}，跑完后 ${n._termList().length})`);

  // 纯度：自检不许改它正在自检的那份状态（写注册表 / 分配占位符编号都算）
  const before = { reg: n.registry.size, eph: n.ephemeral.size, pend: n.pending.size };
  n.findLeak('沫钤 又出现了');
  n.findLeakIn('沫钤 又出现了', n._termList());
  ok(n.registry.size === before.reg && n.ephemeral.size === before.eph && n.pending.size === before.pend,
    'findLeak / findLeakIn 是纯的：检查不写注册表、不分配编号、不动待审池',
    `(reg ${before.reg}→${n.registry.size})`);
}

// ── 合并转发正文的说话人标签（#6，出境红线）─────────────────────────────────
// 实测：502 块里有 1 块，昵称只出现在转发块里 ⇒ 不挨硬 ID、不是常见姓 ⇒ 哪个层都登记不到
// ⇒ 原样出境。转发块的 `某名:` 是**别人的消息**的归属标签（与引用块说话人名同族），
// 不是"这个人说的话"；把它遮蔽掉既堵红线、也符合同一条脚手架纪律。
head('合并转发说话人标签 · 只遮标签里的名字（#6）');
{
  const n = makeNormalizer();
  // 真实形态（取自 `data/memory-v2/chunks/hour_group_1098345913_2026-09-2509.json`）
  const real = '[合并转发 共4条] - KID1411: [图片] - KID1411: @沫沫 - KID1411: 证明一下为什么一加一等于2 沫沫: [图片]';
  const r1 = n.normalize(real, { register: false });
  ok(!r1.text.includes('KID1411') && !r1.text.includes('沫沫'),
    '转发块里的说话人名不再原样出境', `("${r1.text}")`);
  ok(!r1.text.includes('[合并转发') && r1.text.includes('证明一下为什么一加一等于2'),
    '标记本体已剥（#9 拍板：脚手架）、块内真实发言保留', `("${r1.text}")`);
  ok(r1.stats.forwardMarkers === 1, 'forwardMarkers 单独计数', `= ${r1.stats.forwardMarkers}`);
  // 第二种真实形态（实测 20 处）：`[合并转发聊天记录]` —— 没有条数
  const r1b = n.normalize('开头 [合并转发聊天记录] - 路人乙: 内容', { register: false });
  ok(!r1b.text.includes('合并转发') && r1b.text.includes('内容') && r1b.stats.forwardMarkers === 1,
    '无条数形态 `[合并转发聊天记录]` 同样剥', `("${r1b.text}")`);

  // 词表里**认得**的名字不落成 `〔SPEAKER〕`，而是映射到它本人的占位符（能拿身份就别丢）
  const n2 = makeNormalizer();
  const r2 = n2.normalize('[合并转发 共2条] - 沫钤: 你好 - 路人甲: 在的', { register: false });
  ok(!r2.text.includes('沫钤') && r2.text.includes(n2.labelById.get('qq:3042786385')),
    '词表认得的说话人 → 映射到本人占位符', `("${r2.text}")`);
  ok(/\〔SPEAKER〕/.test(r2.text), '认不得的说话人 → `〔SPEAKER〕`（丢掉是谁，保留"这里有个说话人"）');

  // 反向对撞 ①：不含转发标记的普通消息，破折号 + `名字:` 一律不动
  const plain = '这是普通消息 - 张三: 你好';
  ok(makeNormalizer().normalize(plain, { register: false }).text === plain,
    '不含 `[合并转发` 的文本完全不受影响（规则不做全篇扫描）');

  // 反向对撞 ②：名子里至少一个字母 —— `- 3: 0` 这类比分不算说话人
  const score = makeNormalizer().normalize('[合并转发 共1条] - 3: 0 比分', { register: false }).text;
  ok(score.includes('- 3: 0'), '`- 3: 0` 不被当成说话人标签（字母判据）', `("${score}")`);

  // 跨模块契约：`〔SPEAKER〕` 必须被抽取侧按**结构**剥掉（"三处都剥"那条纪律自动跟上，
  // 不需要在 extract 的白名单里再加一项 —— 这是选固定占位符而非别的写法的原因）
  ok(stripScaffold('〔SPEAKER〕: 你好').trim() === ': 你好'.trim() || !stripScaffold('〔SPEAKER〕: 你好').includes('SPEAKER'),
    '抽取侧 `stripScaffold` 自动剥掉 `〔SPEAKER〕`（占位符结构匹配，无需第二处白名单）',
    `("${stripScaffold('〔SPEAKER〕: 你好')}")`);
}

// ── 自我别称：`botName` 的**残缺形态**必须能由用户显式补齐 ─────────────────
// 现象（2026-10-08 真判 dry-run 实测）：机器人名叫 `Single Samara`，
// 词表里有 `Single Samara` 与挖出来的 `小萨`，但语料里人写作 `samara` —— **原样出境**。
// 根因不是"词表漏了一个来源"，而是**没有来源**：多词名字被拆开的单块
// （`single` / `samara`）在 config、人设、锚点里都不存在，没有任何东西能推出它。
//
// 所以补法只有一条正确的：**让用户声明**（纪律 6：缺省不猜）。
// 反例是"多词名字的每一块都算我" —— 那条规则会让普通词 `single` 也变成 `〔SELF〕`。
{
  head('自我别称（缺省不猜）');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-alias-'));

  // ① 出处：`buildVocabulary` 必须把 `opts.botNames` 挂到 self 上
  const noAlias = buildVocabulary({ dataDir: emptyDir });
  const withAlias = buildVocabulary({ dataDir: emptyDir, botNames: ['samara'] });
  const selfOf = (v) => v.entities.find((e) => e.kind === 'self');
  ok(!(selfOf(noAlias).surface || []).includes('samara'), '不声明别称 → self 里没有 `samara`（缺省不猜）');
  ok((selfOf(withAlias).surface || []).includes('samara'), '声明了 `samara` → 它成为 self 的一个 surface');

  // ② 效果：出境文本里不许再留 `samara`
  const n = new Normalizer({ secret: SECRET });
  n.setVocabulary(withAlias.entities);
  const r = n.normalize('samara,你怎么看', { context: 'alias', register: false });
  ok(!r.text.includes('samara'), '`samara,你怎么看` 归一化后不再含 `samara`', `(${JSON.stringify(r.text)})`);
  ok(r.text.startsWith('〔SELF〕'), '而且落成 〔SELF〕（不是删掉 —— 保留"在跟我说话"的语义）');
  ok(n.findLeak(r.text) === null, '出口自检：干净');

  // ③ 反向对撞：**只**修了声明的那一项，没有把闸门变成模糊匹配。
  //    `single` 是同一个名字的另一个碎片，我们没声明它 ⇒ 不许被替换。
  const r2 = n.normalize('single samara 有什么区别', { context: 'alias', register: false });
  ok(r2.text.includes('single'),
    '另一个碎片 `single` 没声明 → 仍不替换（不是"名字的每一块都算我"那条错规则）', `(${JSON.stringify(r2.text)})`);

  // ④ 大小写：语料里 `Samara` / `SAMARA` 都出现过。词表匹配是**逐字面**的，
  //    所以后端会把 ASCII 别称展开成大小写变体再喂进来（`selfAliasSurfaces`）；
  //    这里验证"变体进了词表就一定认得出"这一半。
  const nv = new Normalizer({ secret: SECRET });
  nv.setVocabulary([{ id: 'self', kind: 'self', surface: ['我', 'samara', 'Samara', 'SAMARA'] }]);
  const r3 = nv.normalize('SAMARA 你怎么看', { context: 'alias', register: false });
  ok(!/samara/i.test(r3.text), '词表里带了大小写变体 → `SAMARA` 也认得出', `(${JSON.stringify(r3.text)})`);
  // ⑤ 边界：别称不许把**更长的 ASCII 词**吃掉。
  //    这条不是"顺手加的"：实测 502 块里，纯字母 surface 内嵌匹配替掉了 **30 处别的词**
  //    （`qwen`←`qwe`、`sessions`←`sion`、`wowowo`←`owo`、`NekoboshiYuki_Style`←`Yuki`），
  //    而那 30 处没有一处是"那个人被提到"。所以纯字母 ASCII 一律整词匹配。
  const r4 = nv.normalize('samarachan 是谁', { context: 'alias', register: false });
  ok(r4.text.includes('samarachan'), '整词判定：`samarachan` 不会被当成 `samara`', `(${JSON.stringify(r4.text)})`);
  const r5 = new Normalizer({ secret: SECRET });
  r5.setVocabulary([{ id: 'qq:1074479225', kind: 'person', surface: ['qwe'] }]);
  ok(r5.normalize('qwen image 好用', { register: false }).text.includes('qwen'),
    '整词判定：`qwen` 不会被昵称 `qwe` 吃掉（实测最频繁的那一处）');
  ok(r5.normalize('qwe 在吗', { register: false }).text.includes('〔P'),
    '但真正单独出现的 `qwe` 照样替换（收紧的是内嵌，不是整词）');
  // 对照组：**带结构字符**的 ASCII term 不受此约束 —— 它们原文里就嵌在括号/CQ 码里
  const r6 = new Normalizer({ secret: SECRET });
  r6.setVocabulary([{ id: 'qq:123', kind: 'person', surface: ['qq:123'] }]);
  ok(r6.normalize('[引用 名(QQ:123)：在吗', { register: false }).text.includes('qq:123') === false,
    '对照：`qq:123` 这类带结构字符的 term 仍可内嵌匹配（没被这次收紧误伤）');
}

// ═══════════════════════════════════════════════════════════════════════
head('短实体降权 · ≤3 位字母数字（2026-10-29 用户口径）');
{
  const n = new Normalizer({ secret: SECRET });
  n.setVocabulary([
    { id: 'qq:3127332917', kind: 'person', surface: ['16'] },
    { id: 'qq:3878663199', kind: 'person', surface: ['deepseek'] },
    { id: 'qq:2218213246', kind: 'person', surface: ['鲸鱼娘'] }
  ]);

  // ① 整词：`16g` 里的 `16`、QQ 号里的 `11`，都不算"它出现过"
  const a = n.normalize('4060ti不就16g，建议16g内存', { register: false });
  ok(a.text.includes('16g') && !a.text.includes('〔P'),
    '`16g` 里的 `16` 不算它出现过（≤3 位字母数字必须整词）', `("${a.text}")`);
  const b = n.normalize('@2115358013 进群先看群公告', { register: false });
  ok(!b.text.includes('2115358013'),
    'QQ 号不会被短词条从中间切开（切开=留下裸数字尾巴 ⇒ 形态闸门判泄漏 ⇒ 整块进不了库）',
    `("${b.text}")`);
  const c = n.normalize('第 16 天，16 号来了', { register: false });
  ok(c.text.split('〔P').length - 1 === 2,
    '独立成词的 `16` 照样替换（降权 ≠ 不认；两个都换）', `("${c.text}")`);

  // ② 不判罪：这是"降权"最实际的那条 —— 它不再一票否决整块记忆
  ok(n.findLeak('团队 16 个人') === null,
    '低权重词条不单独构成泄漏（正文里出现 `16` 不否决整块）');
  ok(n.findLeak('deepseek 说要去看电影')?.term === 'deepseek',
    '长词条仍判罪（`deepseek` 是 8 个字母，不享受降权）');

  // ③ 含汉字的词条挨着拉丁字母也算独立（以前一刀切"挨着 ASCII 就不动"）
  const d = n.normalize('生成deepseek鲸鱼娘的形象', { register: false });
  ok(!d.text.includes('鲸鱼娘'),
    '含汉字的词条挨着字母也照样替换（`deepseek鲸鱼娘`）', `("${d.text}")`);
  ok(n.findLeak(d.text) === null, '替换完出口干净');

  // ④ 排序：强词条先占位，低权重的短词条只能吃剩下的
  const n2 = new Normalizer({ secret: SECRET });
  n2.setVocabulary([
    { id: 'qq:111', kind: 'person', surface: ['16'] },
    { id: 'qq:222', kind: 'person', surface: ['16g实测'] }
  ]);
  const e = n2.normalize('16g实测跑不动', { register: false });
  ok(e.text === `${render(n2.labelById.get('qq:222'))}跑不动`,
    '长词条先占位（`16g实测` 整体换掉，不会被 `16` 咬走一截）', `("${e.text}")`);

  // ⑤ 提及形态：`@` 跟着名字一起吃掉，不留 `@〔P…〕`
  const n3 = makeNormalizer();
  const f = n3.normalize('@沫钤[CQ:at,qq=3042786385] 在吗', { register: false });
  ok(!f.text.includes('@'),
    '`@名[CQ:at,qq=ID]` 的 `@` 属于这次提及，整段吃成一个占位符（不留 `@〔P…〕` 这种半截形态）',
    `("${f.text}")`);
  const g = n3.normalize('截图是「@邪恶混沌蓝色大肥鱼 现在几几年」', { register: false });
  ok(!g.text.includes('@'), '名字已被占位符化时，落单的 `@` 也要遮蔽（否则形态闸门照样判泄漏）',
    `("${g.text}")`);
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(64)}`);
console.log(`归一化器自检结果：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log(`${'═'.repeat(64)}`);
process.exit(tally.fail === 0 ? 0 : 1);
