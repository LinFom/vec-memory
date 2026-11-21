// G1 边取数 · 真数据仪表 —— 关系边（共现 / 互动）的**分布观测**。
//
// 为什么先有这台仪表、再有星图：本项目反复验证过 ——
// `selftest 全绿` 与 `165 条同分` 可以同时成立。人造数据天生没有分布问题。
// 边权也一样：`intimacy_score` 的权重**留空**（ADR-0005），
// 要先看 `cooccurrence.normalized × interaction.normalized` 的**四象限散点**，
// 才允许定权重。这个脚本就是那把尺子。
//
// 它做四件事：
//   ① 两通道分布（档数 / 极差 / topTiers / **打满比例** —— 饱和纪律）
//   ② 四象限散点（轴写死：x = cooc.normalized，y = interaction.normalized；ADR-0009 决定 1）
//   ③ **共现时间窗扫描**：W 不是拍脑袋的常数，看分布选（刻度纪律）
//   ④ 出境红线断言：节点 ID 必须是占位符，**不许出现 QQ 明文**
//
// 运行：
//   node test/edges.mjs "E:/Tools/QQ-Agent-整合版-20260922"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Normalizer } from '../src/core/normalize.mjs';
import { buildVocabulary } from '../src/core/vocab.mjs';
import { distribution, judge, summarize } from '../src/core/stats.mjs';
import { extractScopeEdges, mergeScopeEdges, computeGstamp, gstampParams, verifyGstamp, pruneEdges, baseParams, layerStamp, modelStamp, EDGE_ALGO_VERSION, PRAGMATIC_VERSION } from '../src/core/edges.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 本用例对着**真实宿主存档**跑。拆仓后本仓不再猜宿主在哪 —— 原先按 `../..` 推算
// 只在"插件住在 <宿主>/plugins/<id>/ 里"时成立，拆出来后会得到一个**错的根**
// （实测推成 `E:\`），然后以一个与代码无关的理由红掉。⇒ 没给就说跳过。
const ROOT = process.argv[2] || process.env.QQ_AGENT_ROOT || '';
const DATA_ROOT = ROOT ? path.join(ROOT, 'data') : '';


if (!DATA_ROOT || !fs.existsSync(DATA_ROOT)) {
  console.log('\n⏭  跳过（未指定宿主数据根）—— 本用例需要真实存档。');
  console.log('   用法：QQ_AGENT_ROOT=<QQ-Agent 根> node test/edges.mjs');
  process.exit(0);
}

console.log(`\n真实数据根：${ROOT}`);
console.log(`边算法版本：${EDGE_ALGO_VERSION}`);
console.log('\n【口径声明】（分层统计纪律：样本取法 + 注册表状态 + 口径表）');
console.log('  样本取法：**全量**存档（不抽样、不分层；`data/messages` + `data/messages-cold`）');
console.log('  注册表状态：**冷启动**（归一化器未预热；占位符只由词表 + 别名派生）');
console.log('  口径表：');
console.log('    · 共现 = 会话内时间窗共现（窗口 W 内都发过言的不同说话人两两 +1）');
console.log('    · 互动 = 群会话的 `[CQ:at,qq=N]` 与 `[引用 #n]` 反查（**私聊不建互动边**）');
console.log('    · normalized = Σ(raw_s) / Σ(msgs_s)，对**该边出现过的会话**求和');
console.log('    · intimacy_score ≡ null（权重留空，ADR-0005 硬约束）');

// ── 词表 + 归一化器（节点 ID 必须由占位符派生）─────────────────────────
const t0 = Date.now();
const vocab = buildVocabulary({ dataDir: DATA_ROOT });
const normalizer = new Normalizer({ secret: 'edges-test-'.repeat(4) });
normalizer.setVocabulary(vocab.entities);
console.log(`\n词表：实体 ${vocab.stats.entities}（人 ${vocab.stats.byKind.person || 0} · 群 ${vocab.stats.byKind.group || 0} · 自己 1）· 锚点 ${vocab.stats.anchorCount}（耗时 ${Date.now() - t0}ms）`);
console.log(`selfId：${vocab.stats.selfId || '(未判定)'} ← ${vocab.stats.selfIdSource || '无'}`);

const PLACEHOLDER = /^(SELF|P\d+|G\d+|Q\d+|X\d+)$/;

// ── ① 默认窗口：抽 + 并 + 分布 ─────────────────────────────────────────
function run(windowMs) {
  const { scopes, horizon, stats } = extractScopeEdges({ dataDir: DATA_ROOT, normalizer, coocWindowMs: windowMs });
  const params = gstampParams({ horizon, coocWindowMs: windowMs });
  const gstamp = computeGstamp({ horizon, coocWindowMs: windowMs });
  const edges = mergeScopeEdges(scopes, { gstamp, params, horizon, at: '2026-10-08T00:40:00.000Z' });
  return { scopes, horizon, stats, gstamp, edges };
}

const t1 = Date.now();
const base = run(60 * 60 * 1000);
console.log(`\n── 默认窗口（1 小时）取数 ──────────────────────────`);
console.log(`  会话 ${base.stats.scopes} 个 · 消息 ${base.stats.messages} 条 · 共现桶 ${base.scopes.reduce((n, s) => n + s.bins, 0)} 个（耗时 ${Date.now() - t1}ms）`);
console.log(`  观察窗：${base.horizon.days} 天（${base.horizon.start} → ${base.horizon.end}）`);
console.log(`  互动命中：@ ${base.stats.atHits} 次 · 引用 ${base.stats.quoteHits} 次 · 引用反查不到 ${base.stats.quoteUnresolved} 次`);
console.log(`  gstamp：${base.gstamp}`);
for (const s of base.scopes) {
  console.log(`    ${s.scope.padEnd(22)} 消息 ${String(s.messages).padStart(6)} · 桶 ${String(s.bins).padStart(5)} · ` +
    `共现对 ${String(s.cooc.size).padStart(6)} · 互动对 ${String(s.inter.size).padStart(5)}${s.interactionMined ? '' : '  (不建互动边)'}`);
}
console.log(`  合并后边：**${base.edges.length}** 条`);

ok(base.edges.length > 0, '存档里能抽出关系边');

// ── ② 出境红线：节点 ID 必须是占位符 ───────────────────────────────────
const badNodes = new Set();
for (const e of base.edges) for (const n of [e.a, e.b]) if (!PLACEHOLDER.test(n)) badNodes.add(n);
ok(badNodes.size === 0, '全部节点 ID 都是占位符（HMAC 派生，**没有任何 QQ 明文**）',
  badNodes.size ? `(违规样例：${[...badNodes].slice(0, 5).join(', ')})` : `(${new Set(base.edges.flatMap((e) => [e.a, e.b])).size} 个节点)`);

// 反向复核：把词表里所有真名/真号拿去撞节点 ID，一条都不许命中
{
  const labels = new Set(base.edges.flatMap((e) => [e.a, e.b]));
  const surfaces = [];
  for (const ent of vocab.entities) {
    if (ent.id === 'self') continue;
    for (const s of ent.surface) if (s && s.length >= 3) surfaces.push(s);
    const q = ent.id.replace(/^qq:/, '');
    if (/^\d{5,}$/.test(q)) surfaces.push(q);
  }
  const hit = surfaces.filter((s) => labels.has(s));
  ok(hit.length === 0, '拿词表真名 / 真号去撞节点 ID：一条都撞不上（出境红线）',
    hit.length ? `(命中：${hit.slice(0, 5).join(', ')})` : `(撞了 ${surfaces.length} 个候选)`);
}

// ── ②b 出境红线：`scope` / `scopes` 也必须是占位符（本轮新增的通道）────────
//    `scope` 曾是**明文 `chatKey`**，私聊时 `private:1353446252` 就是**对方的明文 QQ**。
//    节点 `a`/`b` 早就走占位符，`scope` 却一直漏检（旧断言只查 `e.a`/`e.b`）。
//    本轮把 `scope` 提进产事实级键（ADR-0015）⇒ 它更必须落成占位符 token。
{
  const SCOPE_TOKEN = /^(group|private):C\d+$/;
  const scopeStrings = base.edges.flatMap((e) => [e.scope, ...(e.scopes || [])]).map(String);
  const badScopes = new Set(scopeStrings.filter((s) => !SCOPE_TOKEN.test(s)));
  ok(badScopes.size === 0, '`scope` / `scopes` 全是占位符 token（`group:C…` / `private:C…`）',
    badScopes.size ? `(违规样例：${[...badScopes].slice(0, 5).join(', ')})` : `(${new Set(scopeStrings).size} 个会话 token)`);

  // 反向复核：词表里的真 QQ 号 / 真群号，一条都不许出现在任何 scope 里。
  const rawIds = new Set();
  for (const ent of vocab.entities) {
    const q = String(ent.id || '').replace(/^qq:/, '');
    if (/^\d{5,}$/.test(q)) rawIds.add(q);
  }
  const leaked = scopeStrings.filter((s) => [...rawIds].some((q) => s.includes(q)));
  ok(leaked.length === 0, '拿词表真号去撞 scope：一条都撞不上（出境红线：scope 通道）',
    leaked.length ? `(泄漏：${leaked.slice(0, 3).join(', ')})` : `(撞了 ${rawIds.size} 个真号)`);
}

// ── ③ 两通道分布（饱和纪律：档数/极差之外必须报打满比例）────────────────
console.log(`\n── 两通道分布（合并后 ${base.edges.length} 条边）──────────────`);
function report(edges, field, precision = 8) {
  const vals = edges.map((e) => Number(e[field]?.normalized) || 0);
  const raw = edges.map((e) => Number(e[field]?.raw) || 0);
  const d = distribution(vals, { precision, topK: 10 });
  const dr = distribution(raw, { precision: 0, topK: 10 });
  const jd = judge(d, { minTiers: 3, minRange: 0.01, topK: 10 });
  const fill = d.n ? d.sorted.filter((v) => v === d.max).length / d.n : 0;
  console.log(`  ${field.padEnd(13)} normalized: ${summarize(d)} · 打满 ${(fill * 100).toFixed(1)}%`);
  console.log(`  ${''.padEnd(13)} raw       : ${summarize(dr)}`);
  console.log(`  ${''.padEnd(13)} 判据      : ${jd.ok ? '通过' : '不通过'}（${jd.checks.map((c) => `${c.label}=${c.pass ? '✓' : '✗(' + c.actual + ')'}`).join(' ')}）`);
  return { d, dr, jd, fill };
}
const cooc = report(base.edges, 'cooccurrence');
const inter = report(base.edges, 'interaction');

// 零值占比（"没互动"是不是主流 —— 这本身是四象限里"熟悉的陌生人"那一类的证据）
const zeroInter = base.edges.filter((e) => (Number(e.interaction?.raw) || 0) === 0).length;
console.log(`  interaction.raw = 0 的边：**${zeroInter}/${base.edges.length}**（${(zeroInter / base.edges.length * 100).toFixed(1)}%）—— 高共现零互动 = 「熟悉的陌生人」`);

// ── ④ 四象限散点（轴写死：x = cooc.normalized，y = interaction.normalized）──
console.log(`\n── 四象限散点（ADR-0009 决定 1：轴写死）────────────────`);
function quadrants(edges, xf, yf, pct = 0.5) {
  const pick = (field) => {
    const s = edges.map((e) => Number(e[field]?.normalized) || 0).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * pct))] : 0;
  };
  const tx = pick(xf);
  const ty = pick(yf);
  const q = { '密友（高共现·高互动）': 0, '熟悉的陌生人（高共现·零互动）': 0, '新热聊（低共现·高互动）': 0, '点头之交（低共现·低互动）': 0 };
  for (const e of edges) {
    const x = Number(e[xf]?.normalized) || 0;
    const y = Number(e[yf]?.normalized) || 0;
    if (x >= tx && y >= ty) q['密友（高共现·高互动）']++;
    else if (x >= tx) q['熟悉的陌生人（高共现·零互动）']++;
    else if (y >= ty) q['新热聊（低共现·高互动）']++;
    else q['点头之交（低共现·低互动）']++;
  }
  return { tx, ty, q };
}
for (const p of [0.5, 0.75]) {
  const { tx, ty, q } = quadrants(base.edges, 'cooccurrence', 'interaction', p);
  console.log(`  切点 p${String(Math.round(p * 100)).padStart(2)}：x≥${tx.toExponential(2)} · y≥${ty.toExponential(2)}`);
  for (const [k, v] of Object.entries(q)) console.log(`    ${k.padEnd(26)} ${String(v).padStart(6)}  (${(v / base.edges.length * 100).toFixed(1)}%)`);
}
// ⚠️ 关键发现：`interaction` 的**中位数是 0**（95.5% 的边零互动），
//    所以"按中位数切 y"会把"高互动"退化成"有互动" —— 四象限在 y 轴上塌掉了一半。
//    这正是 ADR-0005 说"先跑 3~7 天看分布再定权重"要抓的那种事：**分布本身是退化的**。
//    补一个 y 口径 = `>0` 的切法，让两类的边界可见。
{
  const xs = base.edges.map((e) => Number(e.cooccurrence.normalized) || 0).sort((a, b) => a - b);
  const tx = xs[Math.floor(xs.length * 0.75)];
  let rich = 0, familiar = 0, fresh = 0, nod = 0;
  for (const e of base.edges) {
    const x = Number(e.cooccurrence.normalized) || 0;
    const y = Number(e.interaction.raw) || 0;
    if (x >= tx && y > 0) rich++;
    else if (x >= tx) familiar++;
    else if (y > 0) fresh++;
    else nod++;
  }
  const n = base.edges.length;
  console.log(`  切点 x=p75 · y>0：x≥${tx.toExponential(2)}`);
  console.log(`    ${'密友（高共现·高互动）'.padEnd(26)} ${String(rich).padStart(6)}  (${(rich / n * 100).toFixed(1)}%)`);
  console.log(`    ${'熟悉的陌生人（高共现·零互动）'.padEnd(26)} ${String(familiar).padStart(6)}  (${(familiar / n * 100).toFixed(1)}%)`);
  console.log(`    ${'新热聊（低共现·高互动）'.padEnd(26)} ${String(fresh).padStart(6)}  (${(fresh / n * 100).toFixed(1)}%)`);
  console.log(`    ${'点头之交（低共现·低互动）'.padEnd(26)} ${String(nod).padStart(6)}  (${(nod / n * 100).toFixed(1)}%)`);
  ok(n === rich + familiar + fresh + nod, '四象限计数自洽（和 = 总边数）');
}

// ── ⑤ 共现窗口扫描（刻度纪律：W 由分布扫出来）──────────────────────────
console.log(`\n── 共现时间窗扫描（W 不是拍脑袋的常数）────────────`);
console.log('   W       边数    共现档数  打满%   top10档  零互动%');
const windows = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3600_000];
const sweep = [];
for (const W of windows) {
  const r = W === 3600_000 ? base : run(W);
  const d = distribution(r.edges.map((e) => Number(e.cooccurrence.normalized) || 0), { precision: 8, topK: 10 });
  const fill = d.n ? d.sorted.filter((v) => v === d.max).length / d.n : 0;
  const z = r.edges.filter((e) => (Number(e.interaction?.raw) || 0) === 0).length / r.edges.length;
  sweep.push({ W, edges: r.edges.length, tiers: d.tiers, fill, topTiers: d.topTiers });
  console.log(`  ${(W / 60000).toFixed(0).padStart(4)}min  ${String(r.edges.length).padStart(7)}  ${String(d.tiers).padStart(7)}  ${(fill * 100).toFixed(1).padStart(6)}  ${String(d.topTiers).padStart(6)}   ${(z * 100).toFixed(1).padStart(6)}`);
}
ok(sweep.every((s) => s.edges > 0), '每个窗口下都能抽出边（不是靠某个特殊 W 才成立）');

// ── ⑥ 结构性断言 ──────────────────────────────────────────────────────
console.log(`\n── 结构性断言 ─────────────────────────────────────`);
ok(base.scopes.filter((s) => s.kind === 'private').every((s) => s.inter.size === 0),
  '私有会话**零互动边**（ADR-0005 决定 2）');
ok(base.edges.every((e) => e.a < e.b), '每条边的端点按字典序固定（无向边不会分裂成两条）');
ok(base.edges.every((e) => e.intimacy_score === null), '`intimacy_score` 全为 null（权重留空，只算不用）');
ok(base.edges.every((e) => e.derived_from && e.derived_from.gstamp === base.gstamp && e.derived_from.rev >= 1),
  '每条边都带 `derived_from { gstamp, params, rev, at }`（没有指纹的 read-model 过期了无从发现）');
ok(base.edges.every((e) => e.derived_from?.params && verifyGstamp(e.derived_from.gstamp, e.derived_from.params)),
  '`derived_from.params` 存**原始参数**、且能与 `gstamp` 互校（hash 单向 ⇒ 只存 hash 的话词表升级后溯源会断）');

// ── 分层戳 / 溯源完整性（本轮新增：回答"rank_version 是哪层、pattern 逻辑版本在不在"）──
{
  const H = { start: base.horizon.start, end: base.horizon.end };
  const base1 = baseParams({ vocabHash: 'vhash-A', horizon: H });
  const base2 = baseParams({ vocabHash: 'vhash-B', horizon: H });
  ok(base1.vocab_version === 2 && base1.vocab_hash === 'vhash-A' && !!base1.horizon.start,
    '`baseParams` 只装**层无关**的四项（vocab 版本 + 内容 hash + 窗起止）—— 层版本不进基础参数');

  const edge = layerStamp('edge', `${EDGE_ALGO_VERSION}+cooc:${3600000}`, base1);
  const rank = layerStamp('rank', 'rank-1', base1);
  const prag = layerStamp('pragmatic', PRAGMATIC_VERSION, base1);
  ok(edge !== rank && rank !== prag && edge !== prag,
    '同一份基础参数下，**不同层的戳互不相同**（层名 + 层版本进了 hash）—— 边层不替排序/语用层背书');

  ok(layerStamp('pragmatic', PRAGMATIC_VERSION + 1, base1) !== prag,
    '**语用层判定逻辑版本 +1 ⇒ 语用层戳变**（"触发阈值 3→4"从此**不再静默**）');
  ok(layerStamp('edge', `${EDGE_ALGO_VERSION}+cooc:${3600000}`, base2) !== edge,
    '`vocab_hash` 变 ⇒ 边层戳变（补上"版本号没变、词表内容变了"的盲区）');

  const pg = gstampParams({ horizon: H });
  ok(!('rank_version' in pg) && !('rank_version' in pg),
    '边层参数里**不再有 `rank_version`**（它一直在戳里落 `na`：ADR 声称了、代码没落地 —— 已移除）');

  ok(modelStamp({ edge, rank }) !== modelStamp({ edge, rank, pragmatic: prag }),
    '`modelStamp` 汇总各层戳：新增一层 ⇒ 全局戳变（供"任一层变就整体失效"的消费口）');
  ok(computeGstamp({ horizon: H, vocabHash: 'a' }) !== computeGstamp({ horizon: H, vocabHash: 'b' }),
    '边层戳 `computeGstamp` 对 `vocab_hash` 敏感（与 `params.vocab_hash` 一致）');
}
{
  const nodes = new Set(base.edges.flatMap((e) => [e.a, e.b]));
  ok(nodes.has('SELF'), '机器人自己在图里（interaction 里人和它的边存在）', `(节点 ${nodes.size} 个)`);
}
{
  const sorted = base.edges.every((e) => (Number(e.cooccurrence.normalized) || 0) >= 0 && (Number(e.cooccurrence.normalized) || 0) <= 1
    && (Number(e.interaction.normalized) || 0) >= 0 && (Number(e.interaction.normalized) || 0) <= 1);
  ok(sorted, '归一化后的两个通道都落在 [0,1]（会话内速率，非负且 ≤1）');
}
{
  const pruned = pruneEdges(base.edges, 6, 'interaction');
  ok(pruned.length > 0 && pruned.length <= base.edges.length, '剪枝（每人 top-6 邻居）生效且不增边',
    `(${base.edges.length} → ${pruned.length})`);
}

// ── ⑦ 确定性：对**纯函数**测，不拿活存档测 ──────────────────────────────
{
  // 宿主是活的：两次取数之间可能又来新消息（存档在长）。
  // ⇒ "同输入 → 同输出"必须在**合成输入**上测；拿活存档测会把"存档变了"误报成"代码不确定"。
  const synth = [{
    scope: 'group:1', kind: 'group', messages: 100, bins: 3,
    cooc: new Map([['P1\u0000P2', 5], ['P2\u0000P3', 2]]),
    inter: new Map([['P1\u0000P2', 3]])
  }];
  const a = mergeScopeEdges(synth, { gstamp: 'gX', at: '2026-10-08T00:00:00.000Z' });
  const b = mergeScopeEdges(synth, { gstamp: 'gX', at: '2026-10-08T00:00:00.000Z' });
  ok(JSON.stringify(a) === JSON.stringify(b), '同输入两次合并逐字节一致（纯函数确定性）');
  ok(Math.abs(a[0].cooccurrence.normalized - 5 / 100) < 1e-12,
    '合并口径 = Σraw / Σmsgs（对**该边出现过的会话**求和）', `(${a[0].cooccurrence.normalized})`);
  ok(a[0].a === 'P1' && a[0].b === 'P2', '端点按字典序固定（无向边不分裂）');
}

// ── ⑧ 存档漂移（宿主是活的，不是代码不确定）─────────────────────────────
{
  const again = run(60 * 60 * 1000);
  const grew = again.stats.messages - base.stats.messages;
  console.log(`\n── 存档漂移（信息，非断言）────────────────────────`);
  console.log(`  两次取数之间：消息 ${base.stats.messages} → ${again.stats.messages}（${grew >= 0 ? '+' : ''}${grew}）· ` +
    `边 ${base.edges.length} → ${again.edges.length} · gstamp ${base.gstamp} → ${again.gstamp}`);
  console.log('  宿主是活的，存档在长 —— 这不是代码不确定；**报数字时必须连取样时刻一起报**（分层统计纪律）。');
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`边取数仪表：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
