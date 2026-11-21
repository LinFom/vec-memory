#!/usr/bin/env node
// tools/bench-recall.mjs —— 查询质量与耗时**可重复基线**（票 17，二轮返工 · [by:DS] 2026-10-28）
//
// ══ 为什么有这一版（上一版被判"不通过"）══════════════════════════════════════
// 第一版跑出来三条门槛全 PASS、退出码 0，但**所有查询都是 exact 降级、嵌入调用总数 0**。
// 报告没有把"应走 vector 却没走"判成失败，于是"向量检索的质量"一个字都没被验证，
// 而报告看起来是绿的。这不是阈值问题，是**判据缺失**：
//
//   · 正常向量用例必须同时断言 `mode='vector'` + `degraded=null` + **嵌调次数=预期**
//     （`mode` 是服务自己报的一句话，`embedCalls` 才是"真调用过"的物证）；
//   · 关键词降级是**另一条基线**，不能混进向量基线里充数；
//   · 只有"有明确目标 ID、且真的看前 N 名"的用例才算 hit@N；结构检查与隔离另列；
//   · `items/scanned` 不是"宿主采用率"，改名 `returnedCandidateRatio`，采用率写
//     `null / not-measured`（要真跑一轮 LLM 读 `events.applied` 才知道，本工具不跑）；
//   · 最后，加一条**自检**：故意让向量不可用，正常向量门槛**必须失败**。
//     这条是本文件的"守卫的守卫"——没有它，上面所有断言都可能是永真的。
//
// ══ 三条自我约束（票 17 明写的，不是可选项）═════════════════════════════════
// 1. **门槛先定、再测、再选方案**：`THRESHOLDS` 在文件顶部，报告逐条 PASS/FAIL。
// 2. **不声称线上延迟、不声称模型质量**：嵌入用**本地桩**（字符 bigram 哈希），
//    每条用例带 `semantic:false`。桩是**词面**匹配器，不是语义模型。
// 3. **不碰真实数据**：全部在 `os.tmpdir()` 的临时 dataRoot 里合成。
//
// ══ 用法 ═══════════════════════════════════════════════════════════════════
//   node tools/bench-recall.mjs                     # 向量基线 + 关键词降级基线（两块分别判）
//   node tools/bench-recall.mjs --mode=vector       # 只跑向量基线
//   node tools/bench-recall.mjs --mode=keyword      # 只跑关键词降级基线
//   node tools/bench-recall.mjs --self-check        # 自检：向量不可用时正常门槛必须失败
//   node tools/bench-recall.mjs --json | --save
//
// 退出码：0 = 该模式下的门槛全过；1 = 有门槛未达标；自检模式下 **0 = 自检成功**
//（即"正常向量门槛确实失败了"），1 = 自检失败（测试永远绿）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createRouter } from '../src/index.mjs';
import { getRuntime } from '../src/core/backend.mjs';
import { encodingIdentity } from '../src/core/vector-generation.mjs';
import { buildEventIndex, searchEvents } from '../src/core/event-index.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name, dflt) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : dflt;
};
const MODE = opt('mode', 'both');              // both | vector | keyword
const SELF_CHECK = has('--self-check');
// `--force-vector-down=dead|wrong-model`：把**正常向量基线**的端点故意弄坏后照常跑，
// 让它的门槛**按正常语义失败**（退出码 1）。这是验收原文要的那一步：
// "强制错模型/断开桩服务的正常向量用例非零退出"。
// 与 `--self-check` 的区别：自检断言"门槛确实失败了"（成功则退出 0）；
// 这个开关只是把故障注入进去，退出码仍由门槛决定 —— 两者一正一反，都要在。
const FORCE_DOWN = opt('force-vector-down', '');
const asJson = has('--json');
const wantSave = has('--save');

// ══ ① 门槛（**先定**，任何改动先看这一块）═══════════════════════════════════
//
// 向量基线（`mode=vector`）与关键词基线（`mode=keyword`）**各有各的门槛、分开判**。
// 把两者混成一个"命中率"，会让"向量全崩、关键词满分"看起来只是差一点。
const THRESHOLDS = {
  // ── 向量基线 ──
  vectorHitAt3: 1.0,        // 仅计「有明确目标 ID 且在报告里真的看前 3 名」的用例
  vectorModeAll: 1.0,       // 有 q 的向量用例里，mode=vector 且 degraded=null 的比例
  embedCallsExact: 1,       // 每条向量查询的嵌入请求数（批量 1 次；0 = 根本没走向量）
  personPrecision: 1.0,     // 按人筛：返回条目中属于目标人的比例
  crossChatLeak: 0,         // 跨会话泄漏条数（零容忍）
  p95VectorSearchMs: 150,   // 本机 + 300 块 + 桩嵌入；**不是线上 SLA**
  // ── 关键词降级基线 ──
  keywordRouteDegraded: 1.0, // 降级用例必须**真的降级**了（exact + 有理由），否则测的不是这条路
  keywordHitRanked: 1.0,     // 降级后仍有明确目标 ID 的用例，按各自 rank 命中率
  keywordEmptyIsZero: true,  // 关键词段对库内不存在的词必须真返回 0 条
  p95KeywordSearchMs: 50
};

// ══ ② 本地嵌入桩（OpenAI `/embeddings` 形状）════════════════════════════════
//
// 只做两件事：把文本按字符 bigram 哈希成定长向量、数请求次数。
// **不模拟语义**：同义不同词在这里相似度就是低 —— 这正是要量的那条裂缝，
// 所以要如实保留它，不能让桩"看起来像个好模型"。
//
// 维度取 512（不是 64）：64 维下 300 块语料的哈希碰撞会把余弦压成噪声，
// 于是"共享字面能否召回"这件事测出来是随机的。512 维让词面重合真正主导分数，
// 但这仍然是**词面**相似度，不是语义 —— 别把它的通过读成"语义召回过关"。
const DIM = 512;
const embedStat = { calls: 0, texts: 0 };

function hashVector(text) {
  // 查询侧会被 `formatQuery` 包一层 `Instruct: ...\nQuery: ...`。桩里剥掉，
  // 否则那串**恒定**的前缀会稀释余弦（桩的哈希对长度敏感，真实模型不一定）。
  const s = String(text || '').replace(/^[\s\S]*?\bQuery:\s*/, '').toLowerCase();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < s.length; i++) {
    const bg = s.slice(i, i + 2);
    if (!bg) continue;
    let h = 0;
    for (let j = 0; j < bg.length; j++) h = (h * 131 + bg.charCodeAt(j)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

async function startEmbedStub() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { input: [] }; }
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      embedStat.calls += 1;
      embedStat.texts += input.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        model: String(payload.model || 'bench-stub'),
        data: input.map((t, i) => ({ object: 'embedding', index: i, embedding: hashVector(t) }))
      }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

// （`deadBase()` 已删除：'dead' 场景改为「起桩 → 记下 base → 关端口」，
//   保留 baseURL 才能让降级理由是"连不上"而不是"编码身份不符"。）


// ══ ③ 合成语料（确定性，不读真实数据）══════════════════════════════════════
const CHATS = [
  ['group:1000001', '甲群'],
  ['group:1000002', '乙群'],
  ['group:1000003', '丙群'],
  ['private:2000001', '私聊甲'],
  ['private:2000002', '私聊乙'],
  ['private:2000003', '私聊丙']
];
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 28, 1, 0, 0);

/** 语料：每个会话 50 块，只有少数块里埋了目标/目标词。
 *  ⚠️ `label` 必须由调用方先解析出来再传进来：`/recall` 的按人筛只认 **占位符
 *  形态 `〔P1234〕`**，写明文名字一个都匹配不到（第一版就栽在这里）。 */
function buildCorpus(label) {
  const rows = [];
  const mark = label ? `〔${label}〕` : '甲瓶';
  let n = 0;
  for (const [chatKey, chatName] of CHATS) {
    for (let i = 0; i < 50; i++) {
      n += 1;
      const id = `bench-${String(n).padStart(3, '0')}`;
      const when = i % 17 === 0 ? NOW - 400 * DAY : NOW - (i * 37) * 60000;
      let title = `${chatName} 日常 ${i}`;
      let text = `今天在${chatName}聊了聊晚饭和天气，没什么特别的（第 ${i} 段）。`;
      if (chatKey === 'group:1000001' && i === 3) {
        title = '服务器又崩了';
        text = '下午三点服务器又崩了，报错是连接池打满，重启之后才恢复。';
      }
      if (chatKey === 'group:1000001' && i === 9) {
        title = '机器点不亮';
        text = '他那台机器点不亮，主板红灯常亮，怀疑是电源或者内存条的问题。';
      }
      if (chatKey === 'group:1000002' && i === 5) {
        title = '换了新键盘';
        text = '乙群有人换了新键盘，说是静音轴，敲起来手感很奇怪。';
      }
      if (chatKey === 'group:1000003' && i % 5 === 0) text += ` ${mark}今天也在，说要去修车。`;
      if (chatKey === 'group:1000001' && i % 7 === 0) text += ` ${mark}提了一句修车的事。`;
      if (i % 23 === 0) {
        title = `很久以前的事 ${i}`;
        text = '这是很久以前的一段记录，里面提到过「灯塔」这个词，后来再没聊过。';
      }
      rows.push({ id, chatKey, when, title, text, vector: hashVector(`${title} ${text}`) });
    }
  }
  return rows;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-bench-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

// ══ ④ 装配：嵌入端点是**可变注入点**，靠它切基线/切故障 ══════════════════════
//
// 一次进程里要跑三种状态：正常端点、拒绝连接的端点、模型名对不上的端点。
// 三者都只是"同一份 settings 换个值" —— 不重写路由、不改生产校验、不 mock fetch。
let EMB = null;                                   // 由 main() 按模式注入
const stubHolder = { stub: null };
const settings = { getSkillConfig: (_id, defaults) => ({ ...defaults, ...(EMB || {}) }) };

const router = createRouter({ dataRoot, settings });
const rt = await getRuntime();

const deadline = Date.now() + 60_000;
while (!rt.lastIdentityCheck && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

const UID = '1006837800';
const UID2 = '1006837801';
rt.normalizer.setVocabulary([
  { id: `qq:${UID}`, kind: 'person', surface: ['甲瓶', '瓶瓶'] },
  { id: `qq:${UID2}`, kind: 'person', surface: ['乙罐'] },
  { id: 'group:1000001', kind: 'group', surface: ['甲群'] }
]);
const LABEL = rt.normalizer.resolveKnown(`qq:${UID}`)?.label || '';
if (!LABEL) throw new Error('基线前提不成立：词表里解析不出目标人的占位符，按人筛用例无从谈起');

const post = (p, body) => router.handle({ method: 'POST', path: p, body });
const get = (p) => router.handle({ method: 'GET', path: p });
const round = (v, d = 2) => Number(Number(v).toFixed(d));

// ══ ⑤ 用例定义（每条都写清"什么算过"与"凭什么算"）══════════════════════════
//
// `expect.mode` 是**硬判据**，不是期望值：向量基线里 `mode='exact'` 直接算该用例失败
// （上一版把它当"降级也能过"，于是全部降级时报告全绿）。
// `targetId` 只在"真的看名次"的用例上给；结构检查（返回 ≤ k、不报错）不给 ——
// 把它们混进 hit@3 会把命中率稀释成一个好看的数字。
/** 块层用例。`fam`：vector = 向量基线专有；keyword = 关键词基线专有；any = 两边都跑。
 *  `expectMode` 是**硬判据**：向量基线里 `expectMode='vector'` 的用例一旦降级 → 该用例 FAIL；
 *  关键词基线里 `expectMode='keyword'` 的用例**必须**是 exact + 有降级理由，否则说明它
 *  偷偷走向量了、这条降级基线根本没在测降级。 */
const chunkCases = [
  {
    id: 'paraphrase-shared-token',
    fam: 'vector',
    layer: 'chunk',
    expectMode: 'vector',
    desc: '同义改写（共享词可及）：问"服务器崩溃"，块标题"服务器又崩了"',
    semantic: false,          // 桩是词面匹配器 ⇒ 这条测的是"共享字面能否召回"
    targetId: 'bench-004',
    rank: 3,
    run: () => get('/recall?q=' + encodeURIComponent('服务器崩溃') + '&chatKey=group:1000001&k=3'),
    expect: 'bench-004 出现在前 3（并列时必须由桩的词面重合决定，不是靠排序随机）'
  },
  {
    id: 'paraphrase-semantic-gap',
    fam: 'vector',
    layer: 'chunk',
    expectMode: 'vector',
    desc: '同义改写（需语义）：问"电脑开不了机"，块里写的是"机器点不亮，主板红灯"',
    semantic: false,
    gate: false,              // **不计分**，见下
    targetId: null,
    run: () => get('/recall?q=' + encodeURIComponent('电脑开不了机') + '&chatKey=group:1000001&k=3'),
    // 为什么不换标签了事（复审第 7 条）：这条只有在**真实嵌入模型**下才有判别力。
    // 桩换成大维度、换个名字都不会让它变成"已验真实语义" —— 那只是把"没测"改写成
    // "测过了"的说法。所以保留 `gate:false` + `semantic:false`，把它钉在案上：
    // 裂缝在词面层，跨界要靠向量层，而向量层的**语义**质量本轮无权评价。
    expect: '【仅记录，不计分】需真实嵌入模型才有意义；桩再调也不是语义验证'
  },
  {
    id: 'person-filter',
    fam: 'any',
    layer: 'chunk',
    expectMode: 'list',       // 无 q ⇒ 走 list，本来就该这样，不算降级
    desc: '按人筛：目标人只出现在 1/7 的块里，前面有大量他人块挡路',
    semantic: false,
    targetId: null,
    run: () => get('/recall?who=' + encodeURIComponent(UID) + '&k=8'),
    measure: (r) => {
      const items = r.body.recent.items || [];
      // 精确率是**测量值**，不做成布尔：0.6 与 0.0 在报告里必须看得出差别。
      const hit = items.filter((it) => String(it.text || '').includes(`〔${LABEL}〕`)).length;
      return { precision: items.length ? round(hit / items.length, 3) : null, items: items.length, hit };
    },
    check: (r) => (r.body.recent.items || []).length > 0,
    expect: '返回条目全部含目标人的占位符（precision=1.0），且条数 ≥ 1'
  },
  {
    id: 'cross-chat',
    fam: 'any',
    layer: 'chunk',
    expectMode: 'vector',
    desc: '跨会话：在甲群问只存在于乙群的词，不得返回乙群的块',
    semantic: false,
    targetId: null,
    run: () => get('/recall?q=' + encodeURIComponent('静音轴 键盘') + '&chatKey=group:1000001&k=3'),
    leak: (r) => (r.body.recent.items || []).filter((it) => it.chatKey !== 'group:1000001').length,
    check: (r) => (r.body.recent.items || []).every((it) => it.chatKey === 'group:1000001'),
    expect: '返回条目 chatKey 全为 group:1000001（泄漏条数单列，记进 crossChatLeak 门槛）'
  },
  {
    id: 'old-event',
    fam: 'any',
    layer: 'chunk',
    expectMode: 'vector',
    desc: '老事件：400 天前的块，用它的独特词仍能检索到（向量库没有 TTL）',
    semantic: false,
    targetId: 'bench-024',    // `i % 23 === 0` 的第一条"灯塔"块（甲群 i=0 ⇒ 第 1 块）
    rank: 3,
    run: () => get('/recall?q=' + encodeURIComponent('灯塔') + '&chatKey=group:1000001&k=3'),
    check: (r) => (r.body.recent.items || []).some((x) => x.id === 'bench-024'),
    expect: 'bench-024 出现在前 3（不因"老"被忽略）'
  },
  {
    id: 'empty-hit',
    fam: 'vector',
    layer: 'chunk',
    expectMode: 'vector',
    desc: '空命中：问一个库里完全没有的词 —— 向量段会照常返回 k 条低分项（余弦没有绝对门槛）',
    semantic: false,
    targetId: null,
    kind: 'structure',
    run: () => get('/recall?q=' + encodeURIComponent('量子色动力学禁闭') + '&chatKey=group:1000001&k=3'),
    check: (r) => r.status === 200 && r.body.ok === true && (r.body.recent.items || []).length <= 3,
    expect: '200 + ok:true + 条数 ≤ k（结构检查，不计入 hit@3）'
  },
  {
    id: 'keyword-empty-hit',
    fam: 'keyword',
    layer: 'chunk',
    expectMode: 'keyword',
    desc: '关键词段对库内不存在的词必须真返回 0 条（与向量段不同：这里有权重门槛）',
    semantic: false,
    targetId: null,
    kind: 'empty',
    run: () => get('/recall?q=' + encodeURIComponent('量子色动力学禁闭') + '&chatKey=group:1000001&k=3'),
    check: (r) => (r.body.recent.items || []).length === 0,
    expect: '0 条 —— 关键词段有 minScore，不会"没相关也返回满 k"'
  },
  {
    id: 'keyword-shared-token',
    fam: 'keyword',
    layer: 'chunk',
    expectMode: 'keyword',
    desc: '关键词段：问"服务器崩溃"必须命中"服务器又崩了"（共享 2-gram「服务」「务器」）',
    semantic: false,
    targetId: 'bench-004',
    rank: 1,
    run: () => get('/recall?q=' + encodeURIComponent('服务器崩溃') + '&chatKey=group:1000001&k=3'),
    check: (r) => (r.body.recent.items || []).some((x) => x.id === 'bench-004'),
    expect: 'bench-004 出现在第 1 名（降级后仍有明确目标）'
  }
];

// ── 事件层（短期层倒排索引，与向量库是两套存储）──────────────────────────────
const eventRows = [];
for (let i = 0; i < 120; i++) {
  eventRows.push({
    id: `ev-fill-${i}`,
    chatKey: CHATS[i % 4][0],
    title: `琐事 ${i}`,
    summary: '群里聊了些日常，没有什么值得记的结论。',
    toTs: NOW - i * 3600000
  });
}
eventRows.push(
  {
    id: 'ev-target', chatKey: 'group:1000001', title: '服务器连接池打满',
    summary: '下午三点服务器连接池打满，重启后恢复。', toTs: NOW - 2 * DAY
  },
  {
    id: 'ev-same-words-other-chat', chatKey: 'group:1000002', title: '服务器连接池打满',
    summary: '乙群也有人提到连接池打满，但那是另一台机器。', toTs: NOW - 2 * DAY
  },
  {
    id: 'ev-old', chatKey: 'group:1000003', title: '很久以前的灯塔',
    summary: '很久以前提过灯塔这个词，后来再没聊过。', toTs: NOW - 500 * DAY
  },
  // 软回收（`ADR-0048 ⑪`）的验收对：同文本，一条变暗、一条正常
  {
    id: 'ev-live-twin', chatKey: 'group:1000001', title: '旧项目复盘',
    summary: '把旧项目的复盘重新过了一遍，结论是架构没问题。', toTs: NOW - 3 * DAY
  },
  {
    id: 'ev-dimmed-twin', chatKey: 'group:1000001', title: '旧项目复盘',
    summary: '把旧项目的复盘重新过了一遍，结论是架构没问题。', toTs: NOW - 4 * DAY,
    dimmedAt: new Date(NOW - DAY).toISOString()
  }
);
const evIndex = buildEventIndex(eventRows);
// 事件检索的 hits **不带 chatKey**（`event-index.mjs` 只回 id/score/matched/coverage/maxIdf）。
// 所以隔离判据必须回查源行 —— 上一版直接读 `h.chatKey`（恒 undefined）⇒ 每条都算"泄漏"，
// 反向对照反而把正确的实现判成红的。这类"字段其实不存在"的断言，错的方向是**看起来更严**。
const evChat = new Map(eventRows.map((r) => [r.id, r.chatKey]));
const evSearch = (q, opts) => ({ status: 200, body: { hits: searchEvents(evIndex, q, { limit: 3, ...opts }) } });
const evCases = [
  {
    id: 'event-hit', fam: 'any', layer: 'event', desc: '事件层：问"连接池打满"，目标事件必须进前 3',
    semantic: false, targetId: 'ev-target', rank: 3,
    run: () => evSearch('连接池打满', { chatKey: 'group:1000001' }),
    check: (r) => (r.body.hits || []).some((h) => h.id === 'ev-target'),
    expect: 'ev-target 出现在前 3（标题算 2 次 tf，正文算 1 次）'
  },
  {
    id: 'event-empty', fam: 'any', layer: 'event', desc: '事件层：无关词必须 0 条（与向量段不同，这里有 minScore 门槛）',
    semantic: false, targetId: null, kind: 'empty',
    run: () => evSearch('量子色动力学禁闭', { chatKey: 'group:1000001' }),
    check: (r) => (r.body.hits || []).length === 0,
    expect: '0 条 —— 关键词段没有"最低分照样返回 k 条"的行为'
  },
  {
    id: 'event-cross-chat', fam: 'any', layer: 'event', desc: '事件层：chatKey 过滤后不得混入别群事件',
    semantic: false, targetId: null, kind: 'isolation',
    run: () => evSearch('连接池打满', { chatKey: 'group:1000001' }),
    leak: (r) => (r.body.hits || []).filter((h) => evChat.get(h.id) !== 'group:1000001').length,
    check: (r) => (r.body.hits || []).every((h) => evChat.get(h.id) === 'group:1000001'),
    expect: '另一群的同词事件不出现（隔离条数单列）'
  },
  {
    id: 'event-old', fam: 'any', layer: 'event', desc: '事件层：500 天前的事件仍能检索到',
    semantic: false, targetId: 'ev-old', rank: 3,
    run: () => evSearch('灯塔', {}),
    check: (r) => (r.body.hits || []).some((h) => h.id === 'ev-old'),
    expect: 'ev-old 出现在前 3（短期层不按"年龄"过滤，只按回收标记）'
  },
  {
    id: 'event-dimmed-still-findable', fam: 'any', layer: 'event',
    desc: '事件层：变暗（dimmed）仍可检索，但应排在同样内容的正常行之后',
    semantic: false, targetId: null, kind: 'structure',
    run: () => evSearch('旧项目复盘', { chatKey: 'group:1000001' }),
    check: (r) => {
      const ids = (r.body.hits || []).map((h) => h.id);
      const live = ids.indexOf('ev-live-twin');
      const dim = ids.indexOf('ev-dimmed-twin');
      // 变暗行的全部意义：**还能被找到**（dim >= 0），但名次更靠后。
      return live >= 0 && (dim < 0 || dim > live);
    },
    expect: '正常行出现且排在变暗行之前；变暗行若出现则必须更靠后'
  }
];

// ══ ⑥ 执行器 ══════════════════════════════════════════════════════════════
const seeded = { done: false, count: 0, ms: 0 };
async function seed() {
  // 一个进程里两条基线共用同一份库（重建两次既慢又会掩盖"第二次种子失败"）。
  // 但报告里的语料数必须是**真实块数**，不能第二次返回 0（上一版就打印过"语料 0 块"）。
  if (seeded.done) return { count: seeded.count, ms: seeded.ms };
  // 种子的编码身份 = **当前 settings 算出来的那一份**（`encodingIdentity` 是唯一契约）。
  // 上一版没写 `encoding` ⇒ 库里 `index.encoding` 为 null ⇒ 每次查询都抛
  // `ENCODING_MISMATCH` ⇒ 静默降级 exact。这正是"全绿但向量一条没跑"的成因。
  const ENC = encodingIdentity({ ...rt.settings });
  const t0 = Date.now();
  const corpus = buildCorpus(LABEL);
  for (const r of corpus) {
    rt.store.put({
      id: r.id,
      vector: r.vector,
      model: 'bench-stub',
      encoding: ENC,                      // ★ 编码身份随种子落库，不是事后绕过校验
      meta: { title: r.title, text: r.text, chatKey: r.chatKey, when: r.when, kind: 'hour' }
    });
  }
  await post('/remember', { chatKey: 'group:1000001', userId: UID, kind: 'trait', attr: '职业', text: '修车师傅' });
  await post('/remember', { chatKey: 'group:1000001', userId: UID, kind: 'preference', text: '喜欢喝美式' });
  seeded.done = true;
  seeded.count = corpus.length;
  seeded.ms = Date.now() - t0;
  return { count: seeded.count, ms: seeded.ms };
}

/** 收集一条用例的观测值。**只记录，不判定** —— 判定在 gates 里统一做。 */
function observe(c, r, ms, callsBefore) {
  const body = r.body || {};
  const recent = body.recent || {};
  const items = recent.items || [];
  const hits = body.hits || [];
  const isChunk = (c.layer || 'chunk') === 'chunk';
  const targetId = c.targetId || null;
  // 名次：只在"真的看前 N 名"的用例上算；结构检查不给名次（否则会把 hit@3 稀释）。
  let rank = null;
  let hitAtRank = null;
  if (targetId) {
    const ids = isChunk ? items.map((x) => x.id) : hits.map((x) => x.id);
    const idx = ids.indexOf(targetId);
    rank = idx < 0 ? null : idx + 1;
    hitAtRank = rank !== null && rank <= (c.rank || 3);
  }
  const scanned = isChunk ? (recent.scanned ?? null) : evIndex.N;
  const measured = c.measure ? c.measure(r) : null;
  const scored = c.gate !== false;
  return {
    id: c.id,
    fam: c.fam || 'any',
    layer: c.layer || 'chunk',
    kind: c.kind || (targetId ? 'retrieval' : 'structure'),
    desc: c.desc,
    semantic: c.semantic,
    expect: c.expect,
    scored,
    passed: !scored ? null : (r.status === 200 ? Boolean(c.check ? c.check(r) : hitAtRank) : false),
    // ── 口径 ──
    expectMode: c.expectMode || null,
    mode: isChunk ? (recent.mode ?? null) : 'keyword-inverted',
    degraded: isChunk ? (recent.degraded?.reason ?? null) : null,
    items: isChunk ? items.length : hits.length,
    scanned,
    // ★ 改名（复审第 4 条）：这是"候选里有多少被返回"，**不是**宿主采用率。
    returnedCandidateRatio: scanned ? round((isChunk ? items.length : hits.length) / scanned, 4) : null,
    targetId,
    rank,
    hitAtRank,
    precision: measured?.precision ?? null,
    leak: c.leak ? c.leak(r) : 0,
    embedCalls: embedStat.calls - callsBefore,
    ms: round(ms),
    // ★ 采用率（复审第 4 条）：**没测就写没测**。
    // 宿主侧 `events.applied` 只能证明"这一轮的消息里带了块"，不能证明模型用了它 ——
    // 那要真跑一轮 LLM 并读输出语义，本工具不跑 LLM，也不替它下结论。
    adoption: {
      value: null,
      measured: false,
      note: 'host-adoption not-measured：需真跑一轮 LLM；events.applied 只证明块进了 messages，不证明模型采用'
    }
  };
}

async function runCases(cases) {
  const out = [];
  for (const c of cases) {
    const before = embedStat.calls;
    const t0 = process.hrtime.bigint();
    const r = await c.run();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    out.push(observe(c, r, ms, before));
  }
  return out;
}

// ══ ⑦ 耗时：只在**同一操作重复**上算 p95 ═══════════════════════════════════
//
// 复审第 6 条：别把不同类型单次查询混成一个"稳定延迟分布"。
// 所以这里每一族单独热身 + 单独采样，并**显式记样本次数**；冷启动（第一次调用要建
// 倒排/加载块）单独量、单独报 —— 它和热态不是一个量级（实测差 40 倍）。
function timing(fn, n = 30) {
  const cold0 = process.hrtime.bigint();
  fn();                                        // 冷启动：第一次真实调用（含惰性建索引）
  const coldMs = Number(process.hrtime.bigint() - cold0) / 1e6;
  const arr = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    arr.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  arr.sort((a, b) => a - b);
  return {
    samples: n,
    coldMs: round(coldMs),
    p50: round(arr[Math.floor(arr.length * 0.5)]),
    p95: round(arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))])
  };
}

// ══ ⑧ 门槛判定 ══════════════════════════════════════════════════════════════
const cmpOK = (g) => (g.cmp === '>=' ? g.got >= g.need : g.cmp === '<=' ? g.got <= g.need : g.got === g.need);

function buildGates(results, timings, which) {
  const gates = [];
  // `fam:'any'` 的用例**两条基线都算**（它们本来就该在两种路由下都成立）。
  const inFam = (r, fam) => r.fam === fam || r.fam === 'any';
  if (which === 'vector') {
    const mine = results.filter((r) => inFam(r, 'vector') && r.scored);
    // ① 向量路由：`expectMode='vector'` 的每一条都必须是 mode=vector 且无降级。
    //    这是本版的**核心判据** —— 上一版缺的就是它，于是全部 exact 降级照样"全绿"。
    const routedRows = mine.filter((r) => r.expectMode === 'vector');
    const routed = routedRows.filter((r) => r.mode === 'vector' && r.degraded === null);
    gates.push({
      id: 'vectorModeAll', need: THRESHOLDS.vectorModeAll,
      got: routedRows.length ? round(routed.length / routedRows.length, 3) : 0, cmp: '>=',
      note: routedRows.length - routed.length
        ? `未走向量：${routedRows.filter((r) => !(r.mode === 'vector' && r.degraded === null)).map((r) => `${r.id}(${r.mode})`).join(',')}`
        : ''
    });
    // ② 嵌入请求数：真调用过才有资格谈向量质量。逐条断言"恰好 1 次"（批量）。
    const callRows = routedRows.filter((r) => r.embedCalls !== THRESHOLDS.embedCallsExact);
    gates.push({
      id: 'embedCallsExact', need: 0, got: callRows.length, cmp: '<=',
      note: callRows.length ? `不符合"恰好 1 次"：${callRows.map((r) => `${r.id}=${r.embedCalls}`).join(',')}` : ''
    });
    // ③ hit@3：**只计有明确目标 ID、且判据真的是前 3 名**的用例（复审第 3 条）。
    //    结构检查（返回 ≤k / 不报错）、空结果、隔离全部排除在分母之外 ——
    //    把它们混进来会把命中率稀释成一个好看的数字。
    const ranked = mine.filter((r) => r.kind === 'retrieval' && r.targetId && r.rank === 3);
    gates.push({ id: 'vectorHitAt3', need: THRESHOLDS.vectorHitAt3, got: ranked.length ? round(ranked.filter((r) => r.hitAtRank).length / ranked.length, 3) : 0, cmp: '>=' });
    // ④ 按人筛精确率（复审第 3 条：必须真的落到 gates 里）
    const pr = results.find((r) => r.id === 'person-filter')?.precision ?? null;
    gates.push({ id: 'personPrecision', need: THRESHOLDS.personPrecision, got: pr, cmp: '>=' });
    // ⑤ 跨会话泄漏（两层的 leak 都算）
    const leaks = results.reduce((a, r) => a + (r.leak || 0), 0);
    gates.push({ id: 'crossChatLeak', need: THRESHOLDS.crossChatLeak, got: leaks, cmp: '<=' });
    gates.push({ id: 'p95VectorSearchMs', need: THRESHOLDS.p95VectorSearchMs, got: timings['search(余弦)']?.p95 ?? null, cmp: '<=' });
    // ⑥ 防呆：向量基线里必须**真的存在**向量用例。数量为 0 时上面的比值恒 0 会"看起来只是差"，
    //    这里单独拦一道，避免"没有向量用例的向量基线"。
    gates.push({ id: 'vectorCaseCount', need: 1, got: mine.length, cmp: '>=' });
  } else {
    const mine = results.filter((r) => inFam(r, 'keyword') && r.scored);
    // ① 降级**必须真发生**：`expectMode='keyword'` 的用例要 exact + 有降级理由。
    //    否则这条"降级基线"可能正在偷偷跑向量，测的根本不是它自称的那条路。
    const kwRows = mine.filter((r) => r.expectMode === 'keyword');
    const fell = kwRows.filter((r) => r.mode === 'exact' && r.degraded !== null);
    gates.push({
      id: 'keywordRouteDegraded', need: 1, got: kwRows.length ? round(fell.length / kwRows.length, 3) : 0, cmp: '>=',
      note: kwRows.length - fell.length
        ? `没降级：${kwRows.filter((r) => !(r.mode === 'exact' && r.degraded !== null)).map((r) => `${r.id}(${r.mode})`).join(',')}`
        : ''
    });
    const ranked = mine.filter((r) => r.kind === 'retrieval' && r.targetId);
    gates.push({ id: 'keywordHitRanked', need: THRESHOLDS.keywordHitRanked, got: ranked.length ? round(ranked.filter((r) => r.hitAtRank).length / ranked.length, 3) : 0, cmp: '>=' });
    const empty = mine.find((r) => r.id === 'keyword-empty-hit');
    gates.push({ id: 'keywordEmptyIsZero', need: THRESHOLDS.keywordEmptyIsZero, got: empty ? empty.items === 0 : null, cmp: '===' });
    gates.push({ id: 'p95KeywordSearchMs', need: THRESHOLDS.p95KeywordSearchMs, got: timings['searchText(倒排+IDF)']?.p95 ?? null, cmp: '<=' });
  }
  for (const g of gates) g.pass = cmpOK(g);
  return gates;
}

// ══ ⑨ 各模式 ════════════════════════════════════════════════════════════════
async function withEmbed(mode) {
  // mode: 'ok' 端点正常；'dead' 端点**在但连不上**；'wrong-model' 端点活着但模型名对不上。
  //
  // ⚠️ 'dead' 必须**沿用同一个 baseURL**：`encodingIdentity` 把 endpoint 算进身份，
  //    换个端口会先触发 `ENCODING_MISMATCH`，报告里的降级理由变成"请重建索引"——
  //    那不是"服务没起"的现场。真正模拟服务宕机只有一种办法：**关掉那个端口**。
  if (mode === 'ok' || mode === 'wrong-model') {
    if (!stubHolder.stub) stubHolder.stub = await startEmbedStub();
    EMB = {
      embedBaseURL: stubHolder.stub.base,
      embedModel: mode === 'wrong-model' ? 'another-model' : 'bench-stub',
      embedDimensions: String(DIM),
      embedMode: 'auto'
    };
  } else {
    if (!stubHolder.stub) stubHolder.stub = await startEmbedStub();
    const base = stubHolder.stub.base;
    await stubHolder.stub.close();
    stubHolder.stub = null;                 // 端口已关，下次要活得重新起一个（新端口）
    EMB = { embedBaseURL: base, embedModel: 'bench-stub', embedDimensions: String(DIM), embedMode: 'auto' };
  }
  await getRuntime();                    // 刷新 settings 副本（面板改配置也走这条路）
}

function report({ title, results, gates, timings, corpus, seedMs, extra = {} }) {
  const r = {
    at: new Date().toISOString(),
    title,
    env: {
      corpus: { blocks: corpus, chats: CHATS.length, seedMs },
      embed: { kind: 'stub-hash-bigram', dim: DIM, note: '**不是**真实模型：质量指标只反映管线，不反映语义能力' },
      scale: { note: '合成小库（300 块）。线上量级是它的 10 倍以上 ⇒ p95 不能当线上 SLA' },
      thresholds: THRESHOLDS,
      ...extra
    },
    quality: results,
    latency: timings,
    gates
  };
  return r;
}

function print(title, results, gates, timings, corpus, extraLines = []) {
  const line = (s) => console.log(s);
  line('');
  line('═'.repeat(96));
  line(`${title} · 语料 ${corpus} 块 / ${CHATS.length} 会话 · 嵌入 = 桩（只测管线，不测语义）`);
  line('═'.repeat(96));
  for (const l of extraLines) line(l);
  line('');
  line('用例'.padEnd(28) + '层'.padEnd(7) + '类别'.padEnd(12) + '结果'.padEnd(6)
    + '名次'.padEnd(6) + '条数'.padEnd(5) + '候选比'.padEnd(8) + '模式'.padEnd(10) + '嵌入'.padEnd(5) + 'ms');
  line('─'.repeat(104));
  for (const r of results) {
    line(
      r.id.padEnd(28)
      + String(r.layer).padEnd(7)
      + String(r.kind).padEnd(12)
      + (r.passed === null ? 'N/A' : r.passed ? 'PASS' : 'FAIL').padEnd(6)
      + String(r.rank ?? '—').padEnd(6)
      + String(r.items).padEnd(5)
      + String(r.returnedCandidateRatio ?? '—').padEnd(8)
      + String(r.mode ?? '—').padEnd(10)
      + String(r.embedCalls).padEnd(5)
      + String(r.ms)
    );
  }
  line('');
  line('※ `ms` 列是**单次观测**（n=1），只用于发现"某条突然慢了一个数量级"，**不是分布**；');
  line('  分布看下面的分族 p50/p95（同族重复采样，n 已标出）。两者不可混读（复审第 6 条）。');
  line('');
  line('降级理由（`mode≠vector` 的必须在这里能读到为什么）：');
  const deg = results.filter((r) => r.degraded);
  if (!deg.length) line('  （无）');
  for (const r of deg) line(`  · ${r.id}: ${r.degraded}`);
  line('');
  line('耗时（每族单独热身 + 单独采样；cold = 首次调用，含惰性建索引，**与热态不可比**）：');
  for (const [k, v] of Object.entries(timings)) {
    line(`  ${k.padEnd(24)} cold ${String(v.coldMs).padEnd(8)} p50 ${String(v.p50).padEnd(7)} p95 ${String(v.p95).padEnd(7)} n=${v.samples}`);
  }
  line('');
  line('门槛（先定后测）：');
  for (const g of gates) {
    line(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id.padEnd(20)} 需要 ${g.cmp} ${g.need}，实测 ${g.got}${g.note ? `  ← ${g.note}` : ''}`);
  }
  line('');
  line('采用率：not-measured（宿主侧 adoption 需真跑一轮 LLM；本工具不跑，也不替它下结论）');
  line('');
}

/** 跑一次向量基线。返回 {results, gates, timings}。 */
async function suiteVector() {
  await withEmbed(FORCE_DOWN || 'ok');
  const seedInfo = await seed();
  const cases = chunkCases.filter((c) => c.fam !== 'keyword').concat(evCases.filter((c) => c.fam !== 'keyword'));
  const results = await runCases(cases);
  const qText = '服务器崩溃';
  const timings = {
    'list(全量遍历+chatKey筛)': timing(() => rt.store.list({ offset: 0, limit: 5, chatKey: 'group:1000001' })),
    'searchText(倒排+IDF)': timing(() => rt.store.searchText({ text: qText, k: 3, chatKey: 'group:1000001' })),
    'search(余弦)': timing(() => rt.store.search({ vector: hashVector(qText), k: 3, chatKey: 'group:1000001' }))
  };
  return { results, gates: buildGates(results, timings, 'vector'), timings, seedInfo };
}

/** 跑一次关键词降级基线（端点拒绝连接 ⇒ `/recall` 必须降级）。 */
async function suiteKeyword() {
  await withEmbed('dead');
  const seedInfo = await seed();
  const cases = chunkCases.filter((c) => c.fam !== 'vector').concat(evCases.filter((c) => c.fam !== 'vector'));
  const results = await runCases(cases);
  const timings = { 'searchText(倒排+IDF)': timing(() => rt.store.searchText({ text: '服务器崩溃', k: 3, chatKey: 'group:1000001' })) };
  return { results, gates: buildGates(results, timings, 'keyword'), timings, seedInfo };
}

// ══ ⑩ main ══════════════════════════════════════════════════════════════════
async function main() {
  // ── 自检：**故意让向量不可用**，正常向量门槛必须失败 ──────────────────────
  // 这是"守卫的守卫"（复审第 5 条）。两种故障各验一遍：
  //   · `dead`        —— 端点拒绝连接（最常见的现场：服务没起）
  //   · `wrong-model` —— 端点活着但模型名对不上（最隐蔽：网络通、探活过、每次都降级）
  // 判据：**每一条向量路由判据都必须 FAIL**。若某一条仍 PASS，说明它是永真的装饰。
  if (SELF_CHECK) {
    const scenarios = ['dead', 'wrong-model'];
    const rows = [];
    let ok = true;
    const seedInfo = await (async () => { await withEmbed('ok'); return seed(); })();
    for (const sc of scenarios) {
      await withEmbed(sc);
      const cases = chunkCases.filter((c) => c.fam === 'vector');
      const results = await runCases(cases);
      const timings = { 'search(余弦)': timing(() => rt.store.search({ vector: hashVector('x'), k: 3, chatKey: 'group:1000001' }), 5) };
      const gates = buildGates(results, timings, 'vector');
      // 只关心"向量路由类"判据：它们必须全 FAIL。
      const mustFail = gates.filter((g) => ['vectorModeAll', 'embedCallsExact', 'vectorHitAt3'].includes(g.id));
      const failedAsExpected = mustFail.every((g) => !g.pass);
      if (!failedAsExpected) ok = false;
      rows.push({ scenario: sc, gates: mustFail, failedAsExpected, sample: results.find((r) => r.id === 'paraphrase-shared-token') });
    }
    const out = {
      at: new Date().toISOString(),
      selfCheck: { passed: ok, scenarios: rows, corpus: seedInfo.count, note: '被判失败才是期望结果；某条仍 PASS = 该判据是永真的装饰' }
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('\n自检：强制向量不可用时，正常向量门槛**必须**失败（否则基线永远绿）\n');
      for (const s of rows) {
        console.log(`  场景 ${s.scenario}：${s.failedAsExpected ? '门槛按预期失败 ✓' : '★ 有判据仍 PASS —— 那是永真断言'}`);
        for (const g of s.gates) console.log(`      ${g.pass ? 'PASS ★' : 'FAIL ✓'}  ${g.id.padEnd(18)} 实测 ${g.got}`);
        if (s.sample) {
          console.log(`      样本 ${s.sample.id}: mode=${s.sample.mode} embedCalls=${s.sample.embedCalls}`
            + ` 降级理由=${s.sample.degraded || '(无)'}`);
        }
      }
      console.log(`\n自检结论：${ok ? 'PASS —— 向量门槛确实会失败，基线不是永远绿' : 'FAIL —— 有判据永远为真，必须先修判据'}\n`);
    }
    return ok ? 0 : 1;
  }

  const runs = [];
  if (MODE === 'both' || MODE === 'vector') {
    const v = await suiteVector();
    const rep = report({
      title: '查询质量基线 · 向量路（正常端点）',
      results: v.results, gates: v.gates, timings: v.timings,
      corpus: v.seedInfo.count, seedMs: v.seedInfo.ms,
      extra: { route: 'vector', endpoint: 'stub(ok)', note: '每条向量用例必须 mode=vector + degraded=null + 嵌入恰好 1 次' }
    });
    if (!asJson) print('查询质量基线 · 向量路', v.results, v.gates, v.timings, v.seedInfo.count, [
      '判据：mode=vector 且 degraded=null 且嵌入请求=1（`mode` 是自称，`embedCalls` 是物证）'
    ]);
    runs.push({ report: rep });
  }
  if (MODE === 'both' || MODE === 'keyword') {
    const k = await suiteKeyword();
    const rep = report({
      title: '查询质量基线 · 关键词降级路（端点不可用）',
      results: k.results, gates: k.gates, timings: k.timings,
      corpus: k.seedInfo.count, seedMs: k.seedInfo.ms,
      extra: { route: 'keyword', endpoint: 'dead', note: '降级基线：不与向量基线混判，命中率/空命中/耗时各自成门' }
    });
    if (!asJson) print('查询质量基线 · 关键词降级路', k.results, k.gates, k.timings, k.seedInfo.count, [
      '这是**另一条基线**：端点不可用时的真实行为。它通过 ≠ 向量路通过。'
    ]);
    runs.push({ report: rep });
  }

  const allGates = runs.flatMap((r) => r.report.gates);
  const bad = allGates.filter((g) => !g.pass);

  if (!asJson) {
    console.log(`合计 ${allGates.length} 条门槛：${allGates.length - bad.length} PASS / ${bad.length} FAIL`);
    if (bad.length) {
      console.log('⚠ 未达标 —— 先看对应用例的 expect 说明，再决定是改实现还是改门槛。');
      console.log('  （改门槛必须在同一次提交里写明为什么：门槛的意义是防止"改完就算过"。）');
    } else {
      console.log('✓ 全部门槛达标。这份 JSON 就是后续改动的对比基准。');
    }
    console.log('');
  }

  if (asJson || wantSave) {
    const payload = runs.length === 1 ? runs[0].report : { at: new Date().toISOString(), runs: runs.map((r) => r.report) };
    if (wantSave) {
      const out = path.join(ROOT, '_baseline');
      fs.mkdirSync(out, { recursive: true });
      const f = path.join(out, `recall-${payload.at.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(f, JSON.stringify(payload, null, 2));
      if (!asJson) console.log(`已保存：${f}`);
    }
    if (asJson) console.log(JSON.stringify(payload, null, 2));
  }

  return bad.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} finally {
  if (stubHolder.stub) await stubHolder.stub.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
process.exit(code);
