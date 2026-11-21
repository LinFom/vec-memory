// G1 星图视图 · 测试（真数据 + 纯函数 + 出境红线）。
//
// 它断言的是**展示层**那三件事：
//   ① 剪枝只在展示层（`edgeCountRaw` 留全量，`edgeCount` 是剪后）
//   ② 节点聚合（度数 / 两通道合计）从边来，且序稳定
//   ③ 出境红线：节点 `a`/`b` 与 `scope` **全是占位符，一个明文 QQ/群号都没有**
//
// 运行：node test/graph.mjs "<QQ-Agent 根目录>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Normalizer } from '../src/core/normalize.mjs';
import { buildVocabulary } from '../src/core/vocab.mjs';
import { extractEdges, buildGraphView, buildGraphNodes, filterGraphByScope, publicEdge } from '../src/core/edges.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 同 edges.mjs：不再推算宿主根（拆仓后推算会得到错的根）。没给 ⇒ 跳过。
const ROOT = process.argv[2] || process.env.QQ_AGENT_ROOT || '';
const DATA_ROOT = ROOT ? path.join(ROOT, 'data') : '';


if (!DATA_ROOT || !fs.existsSync(DATA_ROOT)) {
  console.log('\n⏭  跳过（未指定宿主数据根）—— 本用例需要真实存档。');
  console.log('   用法：QQ_AGENT_ROOT=<QQ-Agent 根> node test/graph.mjs');
  process.exit(0);
}

console.log(`\n真实数据根：${ROOT}`);
console.log('\n【口径声明】节点 / scope 全部由归一化器**占位符**派生；明文 QQ/群号一个都不许出现。');

// ── 取真边 ────────────────────────────────────────────────────────────────
const vocab = buildVocabulary({ dataDir: DATA_ROOT });
const normalizer = new Normalizer({ secret: 'graph-test-'.repeat(4) });
normalizer.setVocabulary(vocab.entities);

const { edges, scopes } = extractEdges({ dataDir: DATA_ROOT, normalizer });

console.log(`\n抽到 ${edges.length} 条边（${scopes.length} 个会话）`);

// ── ① 视图组装：剪枝 + 节点 ───────────────────────────────────────────────
{
  const view = buildGraphView(edges, { k: 6 });
  ok(Array.isArray(view.edges) && view.edges.length > 0, 'buildGraphView 产出边', `(${view.edges.length} 条)`);
  ok(view.edgeCountRaw === edges.length, '`edgeCountRaw` 保留**全量**（剪枝只在展示层，原始可复算）');
  ok(view.edgeCount <= view.edgeCountRaw, '`edgeCount` ≤ 全量（top-K 剪枝只减不增）');
  ok(view.k === 6, 'k 回显正确');

  const nodeMap = new Map(view.nodes.map((n) => [n.id, n]));
  ok(view.nodes.length > 0, '节点数 > 0', `(${view.nodes.length} 个)`);
  ok(view.edges.every((e) => nodeMap.has(e.a) && nodeMap.has(e.b)), '每条边的两端都在节点表里（无悬挂边）');

  // 度数一致性：节点 degree 应等于它在剪后边里出现的次数
  const deg = new Map();
  for (const e of view.edges) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
  ok(view.nodes.every((n) => n.degree === (deg.get(n.id) || 0)), '节点 degree 与剪后边的出现次数一致');

  // 序稳定：度数降序
  let sorted = true;
  for (let i = 1; i < view.nodes.length; i++) if (view.nodes[i - 1].degree < view.nodes[i].degree) sorted = false;
  ok(sorted, '节点按度数降序（渲染确定性）');

  // 权重留空 —— 数据里也要是 null，不能悄悄给个 0 冒充
  ok(view.edges.every((e) => e.intimacy_score === null), '`intimacy_score` **恒 null**（权重留空，ADR-0005）');
}

// ── ② 剪枝确实在起作用（k 越小边越少）────────────────────────────────────
{
  const k2 = buildGraphView(edges, { k: 2 }).edgeCount;
  const k6 = buildGraphView(edges, { k: 6 }).edgeCount;
  const k20 = buildGraphView(edges, { k: 20 }).edgeCount;
  ok(k2 <= k6 && k6 <= k20, '边数随 k 单调不减（k=2 ≤ k=6 ≤ k=20）', `(${k2} / ${k6} / ${k20})`);
}

// ── ③ 单会话过滤 ─────────────────────────────────────────────────────────
{
  const view = buildGraphView(edges, { k: 8 });
  const scope = scopes[0]?.scope;
  const one = filterGraphByScope(view, scope);
  ok(one.scope === scope, 'filterGraphByScope 回显 scope');
  ok(one.edges.every((e) => e.scope === scope || e.scopes.includes(scope)), '留下的每条边都含该 scope');
  ok(one.nodes.length <= view.nodes.length, '单会话视图的节点 ≤ 全量');
  const one2 = filterGraphByScope(view, 'group:C0000');
  ok(one2.edges.length === 0 && one2.nodes.length === 0, '不存在的 scope ⇒ 空视图（不报错、不退回全量）');
}

// ── ④ 出境红线：占位符，无明文 ───────────────────────────────────────────
{
  const view = buildGraphView(edges, { k: 8 });
  const RAW_QQ = /\b[1-9][0-9]{5,11}\b/;          // 6~12 位裸数字（QQ 号形态）
  const RAW_SCOPE = /^(?:group|private):[0-9]+$/;  // 明文会话键
  let bad = 0;
  for (const e of view.edges) {
    for (const id of [e.a, e.b]) if (RAW_QQ.test(String(id))) bad++;
    if (RAW_SCOPE.test(String(e.scope))) bad++;
    for (const s of (e.scopes || [])) if (RAW_SCOPE.test(String(s))) bad++;
  }
  ok(bad === 0, '节点 / scope **无明文 QQ 或群号**（全占位符）', bad ? `(命中 ${bad} 处)` : '');
  ok(view.nodes.every((n) => !RAW_QQ.test(String(n.id))), '节点 id 无裸数字');

  const pub = publicEdge(view.edges[0]);
  ok(Object.keys(pub).sort().join(',') === ['a', 'b', 'by_scope', 'cooccurrence', 'derived_from', 'horizon', 'intimacy_score', 'interaction', 'scope', 'scopes'].sort().join(','),
    'publicEdge **显式列字段**（不把内部字段 `...` 带出去）');

  // per-scope 分账：每条边的每个会话都得有各自的速率（「一群一星系」的前置，ADR-0012 §4）。
  // 判据问**运行期事实**：边声明的 scopes 与 by_scope 的键必须一一对应，且值自洽。
  {
    let bad = 0;
    let withMulti = 0;
    for (const e of view.edges) {
      const bs = e.by_scope || {};
      const keys = Object.keys(bs).sort().join('|');
      if (keys !== [...(e.scopes || [])].sort().join('|')) bad++;
      if ((e.scopes || []).length > 1) withMulti++;
      for (const v of Object.values(bs)) {
        if (!(v.cooccurrence && typeof v.cooccurrence.normalized === 'number')) bad++;
        if (!(v.interaction && typeof v.interaction.normalized === 'number')) bad++;
      }
    }
    ok(bad === 0, 'by_scope 的键 = scopes，且两通道都是数值', bad ? `(${bad} 处不合)` : '');
    ok(withMulti > 0, '样本里存在跨会话的边（by_scope 确实多键）', `(${withMulti} 条)`);
  }
}

// ── ⑤ buildGraphNodes 纯函数边界 ─────────────────────────────────────────
{
  const empty = buildGraphNodes([]);
  ok(Array.isArray(empty) && empty.length === 0, '空边 ⇒ 空节点（不崩）');
  const two = buildGraphNodes([
    { a: 'P1', b: 'P2', cooccurrence: { normalized: 0.5 }, interaction: { normalized: 0.25 } }
  ]);
  const p1 = two.find((n) => n.id === 'P1');
  ok(two.length === 2 && p1.degree === 1 && Math.abs(p1.cooc - 0.5) < 1e-9 && Math.abs(p1.inter - 0.25) < 1e-9,
    '单边 ⇒ 两个节点各 degree=1，通道合计透传');
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`星图视图：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
