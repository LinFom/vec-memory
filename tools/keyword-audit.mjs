// 关键词出境审计 —— `ROADMAP #5` 的量表。**离线、零 LLM、不写盘**。
//
// 它回答一个问题：三种关键词来源在**真数据**上各自漏多少、丢多少？
//   · core     —— 现状：核心 `tokenize()` 在**未脱敏**文本上的分词
//   · filtered —— 保留核心分词，按词表剔掉实体碎片与结构碎片
//   · redacted —— 从**已脱敏**文本重抽（口径分宽/窄两种）
//
// 用法：
//   node tools/keyword-audit.mjs --data-root "E:\Tools\QQ-Agent-整合版-20260922\data"
//   node tools/keyword-audit.mjs --data-root <data> --limit 200 --json out.json
//
// 判据纪律：本工具**只读**。跑完会核对 `normalizer/` 下几个文件的 (mtime,size) ——
// 变了就大声报出来（审计工具污染被审计的数据 = 最坏的一种"看起来正常"）。
import fs from 'node:fs';
import path from 'node:path';

import { getSharedNormalizer } from '../src/core/normalize.mjs';
import { listChunks, readChunk, buildKeywordLine } from '../src/core/chunkread.mjs';
import { keywordFragments, filterCoreKeywords, extractKeywords, STRUCTURAL_TOKENS } from '../src/core/keywords.mjs';

function arg(name, dflt = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const DATA_ROOT = arg('data-root');
if (!DATA_ROOT) {
  console.error('用法：node tools/keyword-audit.mjs --data-root <宿主 data 目录> [--limit N] [--json out.json]');
  process.exit(2);
}
const LIMIT = Number(arg('limit', '0')) || 0;
const JSON_OUT = arg('json', '');
const chunksDir = path.join(path.resolve(DATA_ROOT), 'memory-v2', 'chunks');
const normDir = path.join(path.resolve(DATA_ROOT), 'memory-vec', 'normalizer');

if (!fs.existsSync(chunksDir)) {
  console.error(`找不到块目录：${chunksDir}\n（这个 data-root 看起来不是在跑这个插件的宿主数据目录）`);
  process.exit(2);
}

/** 归一化器目录下几个文件的指纹（跑完比对，确保审计没写盘）。 */
function fingerprint(dir) {
  const out = {};
  for (const f of ['entities.json', 'registry.json', 'pending.json', 'secret.key']) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      out[f] = `${st.size}:${st.mtimeMs}`;
    } catch { out[f] = 'missing'; }
  }
  return out;
}

const before = fingerprint(normDir);
const normalizer = getSharedNormalizer({ dir: normDir });
const surfaces = normalizer.knownSurfaces();
console.log(`data-root : ${path.resolve(DATA_ROOT)}`);
console.log(`词条表    : ${surfaces.length} 条（词表 + 注册表 + 疑似池 + 临时占位符里的字面）`);

let chunks = listChunks(chunksDir);
if (LIMIT) chunks = chunks.slice(0, LIMIT);
console.log(`块        : ${chunks.length} 个\n`);

const stat = {
  blocks: 0, badChunks: 0,
  core: { total: 0, empty: 0, frag: 0, fragBlocks: 0, structural: 0 },
  filtered: { total: 0, empty: 0, frag: 0 },
  wide: { total: 0, empty: 0, frag: 0, skippedSnippets: 0, chars: 0 },
  narrow: { total: 0, empty: 0, frag: 0 }
};
const fragExamples = new Map();   // keyword → {surface, count}
const diffExamples = [];

for (const c of chunks) {
  const { chunk, error } = readChunk(chunksDir, c.id);
  if (error || !chunk) { stat.badChunks += 1; continue; }
  stat.blocks += 1;

  const core = Array.isArray(chunk.keywords) ? chunk.keywords : [];
  const coreFrag = keywordFragments(core, surfaces);
  const coreStructural = core.filter((k) => STRUCTURAL_TOKENS.has(String(k).toLowerCase()));

  stat.core.total += core.length;
  if (!core.length) stat.core.empty += 1;
  stat.core.frag += coreFrag.length;
  stat.core.structural += coreStructural.length;
  if (coreFrag.length) stat.core.fragBlocks += 1;
  for (const f of coreFrag) {
    const cur = fragExamples.get(f.keyword) || { surface: f.surface, count: 0 };
    cur.count += 1;
    fragExamples.set(f.keyword, cur);
  }

  const filtered = filterCoreKeywords(core, { surfaces });
  stat.filtered.total += filtered.length;
  if (!filtered.length) stat.filtered.empty += 1;
  stat.filtered.frag += keywordFragments(filtered, surfaces).length;

  // 归一化：summary 与 snippets 各自走一遍（宽/窄两种口径的素材）
  const summaryText = normalizer.normalize(String(chunk.summary || ''), { context: 'audit:summary', register: false }).text;
  const sn = [];
  let skipped = 0;
  let budget = 6000;
  for (const s of (Array.isArray(chunk.snippets) ? chunk.snippets : []).slice(0, 60)) {
    const t = String(s?.text ?? '').trim();
    if (!t) continue;
    try {
      const red = normalizer.normalize(t, { context: 'audit:snippet', register: false }).text;
      sn.push(red);
      budget -= red.length;
      if (budget <= 0) break;
    } catch { skipped += 1; }
  }
  stat.wide.skippedSnippets += skipped;

  const wideWords = extractKeywords([summaryText, sn.join('\n')].join('\n'), { limit: 24 });
  const narrowWords = extractKeywords(summaryText, { limit: 24 });
  stat.wide.total += wideWords.length;
  if (!wideWords.length) stat.wide.empty += 1;
  stat.wide.chars += summaryText.length + sn.join('\n').length;
  stat.wide.frag += keywordFragments(wideWords, surfaces).length;
  stat.narrow.total += narrowWords.length;
  if (!narrowWords.length) stat.narrow.empty += 1;
  stat.narrow.frag += keywordFragments(narrowWords, surfaces).length;

  if (diffExamples.length < 5) {
    diffExamples.push({
      id: c.id,
      core,
      filtered,
      redacted: wideWords
    });
  }
}

const after = fingerprint(normDir);
const dirty = Object.keys(before).filter((k) => before[k] !== after[k]);

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
console.log('┌─ 关键词来源对比（按块聚合）────────────────────────────────┐');
console.log(`│ core     总词 ${String(stat.core.total).padStart(6)} · 空表 ${String(stat.core.empty).padStart(4)} 块 · 实体碎片 ${String(stat.core.frag).padStart(4)} 条（${pct(stat.core.frag, stat.core.total)}，涉 ${stat.core.fragBlocks} 块）· 结构碎片 ${stat.core.structural}`);
console.log(`│ filtered 总词 ${String(stat.filtered.total).padStart(6)} · 空表 ${String(stat.filtered.empty).padStart(4)} 块 · 实体碎片 ${String(stat.filtered.frag).padStart(4)} 条（目标 0）`);
console.log(`│ redacted 总词 ${String(stat.wide.total).padStart(6)} · 空表 ${String(stat.wide.empty).padStart(4)} 块 · 实体碎片 ${String(stat.wide.frag).padStart(4)} 条 · 素材 ${stat.wide.chars} 字 · 跳过 snippet ${stat.wide.skippedSnippets}`);
console.log(`│ 窄口径   总词 ${String(stat.narrow.total).padStart(6)} · 空表 ${String(stat.narrow.empty).padStart(4)} 块 · 实体碎片 ${String(stat.narrow.frag).padStart(4)} 条`);
console.log('└───────────────────────────────────────────────────────────┘');

const topFrag = [...fragExamples.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
if (topFrag.length) {
  console.log('\n最常出现的"实体碎片"关键词（core 模式的实际出境内容）：');
  for (const [kw, v] of topFrag) console.log(`  ${kw.padEnd(18)} ← 来自「${v.surface}」  (${v.count} 块)`);
}

console.log('\n样例（core → filtered → redacted）：');
for (const d of diffExamples) {
  console.log(`\n  ${d.id}`);
  console.log(`    core     : ${d.core.join(' ')}`);
  console.log(`    filtered : ${d.filtered.join(' ')}`);
  console.log(`    redacted : ${d.redacted.join(' ')}`);
}

console.log(`\n写盘核对：${dirty.length ? `❌ 变了 —— ${dirty.join(', ')}` : '✅ normalizer/ 下所有文件 (mtime,size) 未变'}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ dataRoot: path.resolve(DATA_ROOT), blocks: stat.blocks, stat, topFrag, diffExamples, dirty }, null, 2)}\n`, 'utf8');
  console.log(`报告已写：${JSON_OUT}`);
}
