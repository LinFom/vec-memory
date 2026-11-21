// 六维打分的自检 —— **不联网**。
//
// 三块内容：
//   A. 契约：src 三值 / missing ≠ 0 / 逐维公式
//   B. **与 shipped kernel 对拍**：直接 import 那份真内核，逐函数比数值。
//      抄来的东西必须证明是数值等价，不能"参考着写" ——
//      这是本项目一贯的规矩（内核自己也是这么证明 1.0 与 1.1 等价的）。
//      找不到内核文件 → 打印「⚠️ 跳过 + 原因」，**不算失败**（环境做不到 ≠ 代码有问题）。
//   C. 分布判据：六维逐维必须给出 n / 档数 / 极差 / dead；
//      有真块时顺手跑一遍全量，把真实分布打出来。
//
// 运行：
//   node test/rank.mjs                       # 只跑合成数据 + 尝试对拍
//   node test/rank.mjs "E:/Tools/QQ-Agent-整合版-20260922"   # 顺带跑真数据分布
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  RANK_VERSION, DIM_ORDER, DIM_LABEL, DIM_SOURCE, DAY_MS,
  clamp, halfLifeDays, effectiveWeight, scoreOf, importanceFromText,
  dims, scoreOfChunk
} from '../src/core/rank.mjs';
import { scanCorpus, rankDistribution, entityKeysOf } from '../src/core/rankscan.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

let skipped = 0;
const skip = (label, why) => { skipped++; console.log(`  ⚠️ 跳过 ${label} —— ${why}`); };

// ── 确定性伪随机（对拍要可复现，不能用 Math.random）──────────────────────
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

console.log(`\n六维打分自检 (${RANK_VERSION})`);

// ══════════════════════════════════════════════════════════════════════════
// A. 契约
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A. 契约 ────────────────────────────────────────');

{
  // 关键词/摘要一个都没有的块：S 必须回落到 3（内核口径：判不出来回落 3，不是 0）
  const empty = dims({ id: 'x', keywords: [], summary: '', snippets: [], msgCount: 0 });
  ok(empty.parts.sRaw === 3, 'S：判不出来回落 3（不是 0）', `sRaw=${empty.parts.sRaw}`);
  ok(Math.abs(empty.S - 0.6) < 1e-12, 'S = sRaw / 5（与 scoreOf 里的 imp/5 同口径）', `S=${empty.S}`);

  // 命中雷点词 → 5
  const hot = dims({ id: 'y', keywords: ['雷点', '猫'], summary: '她说这是雷点' });
  ok(hot.parts.sRaw === 5 && Math.abs(hot.S - 1) < 1e-12, 'S：命中雷点词判 5', `S=${hot.S}`);

  // E 维：没有词表 ⇒ 必须 null + src=missing。**这条是本文件最重要的一条。**
  ok(empty.E === null, 'E：无判定源时值是 null（不是 0）');
  ok(empty.src.E === 'missing', 'E：src 明确标 missing');
  ok(typeof empty.note.E === 'string' && empty.note.E.includes('不做'), 'E：note 里写明"记为不做"', empty.note.E.slice(0, 24) + '…');

  // R 维：块里没有实体 ⇒ null（"没原料"不等于"不可检索")
  ok(empty.R === null, 'R：无实体时是 null（不是 0）');
  ok(empty.src.R === 'missing', 'R：src 标 missing');
  const withEnt = dims({ id: 'z', keywords: [], summary: '' }, { entityKeys: ['P1', 'P2'], entitySessions: 5, entityRecur: 0 });
  ok(withEnt.R === 1 && withEnt.src.R === 'derived', 'R：5 条通路 = 满分 1（内核 reachOf 口径）', `R=${withEnt.R}`);

  // D 维三档
  const d0 = dims({ id: 'd0', snippets: [], msgCount: 100 });
  const d1 = dims({ id: 'd1', snippets: new Array(5).fill({ w: 1 }), msgCount: 100 });   // cov 5%
  const d2 = dims({ id: 'd2', snippets: new Array(40).fill({ w: 1 }), msgCount: 100 });  // cov 40%
  ok(d0.D === 0.2, 'D：无原话 → 0.2', `D=${d0.D}`);
  ok(d1.D === 0.2, 'D：覆盖率 5% 且原话 5 条 → 0.2', `D=${d1.D}`);
  const d15 = dims({ id: 'd15', snippets: new Array(15).fill({ w: 1 }), msgCount: 100 });
  ok(d15.D === 0.5, 'D：覆盖率 15% → 0.5', `D=${d15.D}`);
  ok(d2.D === 0.8, 'D：覆盖率 40% → 0.8', `D=${d2.D}`);

  // I 维：与内核 centralityOf 同权重（来源 0.25 / 重逢 0.40 / 参与 0.35）
  const iCase = dims({ id: 'i1', snippets: [{ who: 'a' }, { who: 'b' }, { who: 'c' }, { who: 'd' }] },
    { entityKeys: ['P1'], entitySessions: 3, entityRecur: 10 });
  // srcScore = min(1,3/3)*0.25 = 0.25 ; hitScore = min(1,10/10)*0.4 = 0.4 ; part = min(1,4/4)*0.35 = 0.35
  ok(Math.abs(iCase.I - 1.0) < 1e-12, 'I：三项全满 = 1（与内核权重一致）', `I=${iCase.I}`);
  const iLow = dims({ id: 'i2', snippets: [{ who: 'a' }] }, { entityKeys: ['P1'], entitySessions: 0, entityRecur: 0 });
  ok(Math.abs(iLow.I - 0.0875) < 1e-12, 'I：只剩参与项 1/4×0.35 = 0.0875', `I=${iLow.I}`);

  // C 维：consolidatedAt 有值 + 重逢
  const c0 = dims({ id: 'c0' }, { entityKeys: [], entitySessions: 0, entityRecur: 0 });
  const c1 = dims({ id: 'c1', consolidatedAt: 123 }, { entityKeys: ['P1'], entitySessions: 1, entityRecur: 10 });
  ok(c0.C === 0, 'C：没巩固、没重逢 → 0');
  ok(Math.abs(c1.C - 1) < 1e-12, 'C：巩固 + 重逢满分 → 1', `C=${c1.C}`);

  // scoreOfChunk：两个口径都要能手算复现（分数不可复盘 = 出问题无法查）
  const now0 = 1792000000000;
  const chunkS = { id: 's1', keywords: ['雷点'], summary: '', msgCount: 10, when: now0, snippets: [{ w: 1 }] };
  const dS = dims(chunkS);
  const un = scoreOfChunk(chunkS, dS, now0, 30, false);   // w0=1，age 0 ⇒ 0.65 + 5/5×0.35 = 1
  const wt = scoreOfChunk(chunkS, dS, now0, 30, true);    // w0=1/3 ⇒ 0.65/3 + 0.35
  ok(Math.abs(un - 1) < 1e-9, 'scoreOfChunk（内核口径 w0=1）能手算复现', `=${un.toFixed(6)}`);
  ok(Math.abs(wt - (0.65 / 3 + 0.35)) < 1e-9, 'scoreOfChunk（w0=显著性）能手算复现', `=${wt.toFixed(6)}`);

  // 六维齐全且顺序固定
  ok(DIM_ORDER.length === 6 && DIM_ORDER.every((k) => k in empty), '六维齐全（S D E R I C）');
  ok(DIM_ORDER.every((k) => typeof DIM_LABEL[k] === 'string' && DIM_LABEL[k].length > 0 &&
    typeof DIM_SOURCE[k] === 'string' && DIM_SOURCE[k].length > 0), '六维都有中文名与来源说明');
}

// ══════════════════════════════════════════════════════════════════════════
// B. 与 shipped kernel 对拍
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B. 与 shipped kernel 对拍 ──────────────────────');

const CANDIDATES = [
  process.argv[2] && path.join(process.argv[2], 'memory_plugin', 'src', 'memory6d-kernel.js'),
  process.env.QQ_AGENT_ROOT && path.join(process.env.QQ_AGENT_ROOT, 'memory_plugin', 'src', 'memory6d-kernel.js'),
  'E:/Tools/QQ-Agent-整合版-20260922/memory_plugin/src/memory6d-kernel.js',
  path.join(PLUGIN_DIR, '..', '..', 'memory_plugin', 'src', 'memory6d-kernel.js')
].filter(Boolean);

let kernelPath = null;
for (const c of CANDIDATES) {
  try { if (fs.existsSync(c)) { kernelPath = c; break; } } catch { /* 路径非法，下一个 */ }
}

if (!kernelPath) {
  skip('与内核对拍', `找不到 memory6d-kernel.js（试过 ${CANDIDATES.length} 个位置）—— 抄来的纯函数这轮**没有数值证据**`);
} else {
  let K = null;
  try {
    K = await import(pathToFileURL(kernelPath).href);
  } catch (err) {
    skip('与内核对拍', `内核文件存在但 import 失败：${err?.message || err}`);
  }
  if (K) {
    console.log(`  内核：${kernelPath}  (${K.KERNEL_VERSION})`);
    const rnd = lcg(20261007);
    const N = 274;   // 与内核自己那次对拍同量级
    let bad = { halfLifeDays: 0, effectiveWeight: 0, scoreOf: 0, importanceFromText: 0, clamp: 0 };
    const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-12;
    const texts = ['今天很困', '她说过这是雷点', '约定每周三一起看', '他养了一只橘猫', '别再提这个了', ''];
    for (let i = 0; i < N; i++) {
      const imp = 1 + Math.floor(rnd() * 5);
      const base = 10 + Math.floor(rnd() * 60);
      const w = rnd();
      const age = rnd() * 400;
      const now = 1791000000000 + Math.floor(rnd() * 1e9);
      const entry = { weight: w, importance: imp, lastTouchedAt: now - age * DAY_MS };
      if (!eq(halfLifeDays(imp, base), K.halfLifeDays(imp, base))) bad.halfLifeDays++;
      if (!eq(effectiveWeight(entry, now, base), K.effectiveWeight(entry, now, base))) bad.effectiveWeight++;
      if (!eq(scoreOf(entry, now, base), K.scoreOf(entry, now, base))) bad.scoreOf++;
      const t = texts[i % texts.length];
      if (importanceFromText(t) !== K.importanceFromText(t)) bad.importanceFromText++;
      const n = (rnd() - 0.5) * 100;
      if (!eq(clamp(n, 0, 1), K.clamp(n, 0, 1))) bad.clamp++;
    }
    ok(bad.halfLifeDays === 0, `halfLifeDays 对拍 ${N}/${N} 一致`);
    ok(bad.effectiveWeight === 0, `effectiveWeight 对拍 ${N}/${N} 一致`);
    ok(bad.scoreOf === 0, `scoreOf 对拍 ${N}/${N} 一致`);
    ok(bad.importanceFromText === 0, `importanceFromText 对拍 ${N}/${N} 一致`);
    ok(bad.clamp === 0, `clamp 对拍 ${N}/${N} 一致（含 NaN 边界）`);

    // 边界：pinned / weight 缺省 / 时间戳缺省 —— 对拍要覆盖"兜底分支"，否则只测到 happy path
    const edge = [{ pinned: true }, { weight: 0 }, {}, { importance: 9 }, { importance: -3 }];
    let edgeBad = 0;
    for (const e of edge) {
      if (!eq(effectiveWeight(e, 1791000000000, 30), K.effectiveWeight(e, 1791000000000, 30))) edgeBad++;
      if (!eq(scoreOf(e, 1791000000000, 30), K.scoreOf(e, 1791000000000, 30))) edgeBad++;
    }
    ok(edgeBad === 0, `兜底分支对拍一致（pinned / weight=0 / 空对象 / importance 越界）`);

    // I 维的公式也来自内核：用同权重独立复算 centralityOf
    let iBad = 0;
    for (let i = 0; i < 60; i++) {
      const nSrc = Math.floor(rnd() * 6);
      const hits = Math.floor(rnd() * 20);
      const parts = Math.floor(rnd() * 6);
      const mine = Math.min(1, Math.min(1, nSrc / 3) * 0.25 + Math.min(1, hits / 10) * 0.4 + Math.min(1, parts / 4) * 0.35);
      const theirs = K.centralityOf({
        sources: Array.from({ length: nSrc }, (_, j) => ({ chatKey: `group:${100 + j}` })),
        hits, participants: new Array(parts).fill(0)
      });
      if (!eq(mine, theirs)) iBad++;
    }
    ok(iBad === 0, 'I 维权重与内核 centralityOf 等价（60 例）');

    // R 维同理
    let rBad = 0;
    for (let i = 0; i < 60; i++) {
      const nSrc = Math.floor(rnd() * 8);
      const mine = Math.min(1, nSrc / 5);
      const theirs = K.reachOf({ sources: Array.from({ length: nSrc }, (_, j) => ({ chatKey: `private:${200 + j}` })) });
      if (!eq(mine, theirs)) rBad++;
    }
    ok(rBad === 0, 'R 维归一化与内核 reachOf 等价（60 例）');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// C. 分布判据
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C. 分布判据 ────────────────────────────────────');

{
  // 合成一批刻意做出分布的块，验证"仪表能把分布量出来"
  const chunks = [];
  for (let i = 0; i < 120; i++) {
    const samples = i % 45;
    // 关键字里带上"人 0"与一个 QQ —— 核心真块的关键词本来就长这样（实测含群名片与 QQ 号），
    // 不带的话兜底口径抠不出实体，R/I/C 会集体变成"无原料"。
    const kw = (i % 7 === 0 ? ['雷点'] : (i % 3 === 0 ? ['约定', '猫'] : ['猫', '狗']))
      .concat(['人0', String(100000000 + (i % 4))]);
    chunks.push({
      id: `hour_group_1_2026-09-${String(1 + (i % 28)).padStart(2, '0')}00`,
      chatKey: `group:${1 + (i % 3)}`,
      when: 1790000000000 + i * 3600000,
      consolidatedAt: i % 4 ? 1790000000000 + i * 3600000 : 0,
      keywords: kw,
      summary: `第 ${i} 段`,
      msgCount: 100,
      snippets: Array.from({ length: samples }, (_, j) => ({
        who: `人${j % (1 + (i % 5))}`, w: 1 + (j % 3), text: 'x'
      }))
    });
  }
  const scan = scanCorpus(chunks, { now: 1792000000000, baseDays: 30 });
  ok(scan.rows.length === chunks.length, `扫描全部块（${scan.rows.length}/${chunks.length}）`);
  ok(scan.inv.entities > 0, `实体倒排建起来了（${scan.inv.entities} 个键）`);

  const dist = rankDistribution(scan, { topK: 5 });
  ok(DIM_ORDER.every((k) => dist.dims[k]), '每一维都出现在分布表里（不许漏维）');
  ok(DIM_ORDER.every((k) => typeof dist.dims[k].tiers === 'number' && typeof dist.dims[k].range === 'number'),
    '每一维都有档数与极差');
  ok(DIM_ORDER.every((k) => typeof dist.dims[k].dead === 'boolean'), '每一维都有 dead 检测');
  ok(dist.dims.E.n === 0 && dist.dims.E.missing === chunks.length,
    'E 维：全部计入 missing，一个都没被当成 0');
  ok(dist.dims.E.ok === null, 'E 维：无样本时判据是 null（**不算通过**），不是 true');

  // 一个"装了个常数维度"的现场：全部块 D 都相同 ⇒ dead 必须为 true
  const flat = chunks.map((c) => ({ ...c, snippets: [], msgCount: 0 }));
  const flatDist = rankDistribution(scanCorpus(flat, { now: 1792000000000 }), { topK: 5 });
  ok(flatDist.dims.D.dead === true, 'D 维全同时被标成 dead（这正是"165 条同分"那类病）');
  ok(flatDist.dims.D.ok === false, 'D 维全同时判据不通过');

  ok(typeof dist.verdict === 'object' || Array.isArray(dist.verdict), 'verdict 可直接打进面板/日志');
  ok(dist.dims.S.tiers >= 3, `S 维在合成数据上分出 ${dist.dims.S.tiers} 档`, dist.dims.S.summary);

  // 兜底口径：没有归一化器时也能出实体键（否则仪表比被测对象还难启动）
  const keys = entityKeysOf({
    keywords: ['123456789', '小猫', '哈哈'],
    snippets: [{ who: '小猫' }]
  }, null);
  ok(keys.includes('qq:123456789') && keys.includes('name:小猫') && !keys.includes('name:哈哈'),
    '无归一化器时的兜底实体键（数字当 QQ、snippets.who 里的 CJK 当人名）', JSON.stringify(keys));

  // 归一化器口径：走真实例，抠占位符
  const norm = await import('../src/core/normalize.mjs');
  const n = new norm.Normalizer({ secret: 'a'.repeat(32), autoLoad: false });
  n.setVocabulary([
    { id: 'qq:123456789', kind: 'person', surface: ['小猫'] },
    { id: 'group:42', kind: 'group', surface: ['测试群'] }
  ]);
  const keys2 = entityKeysOf({ keywords: ['小猫'], summary: '在测试群里', snippets: [] }, n);
  ok(keys2.length === 2 && keys2.every((k) => /^[A-Za-z]/.test(k) || k === 'SELF'),
    '有归一化器时抠出的是占位符（不是原文）', JSON.stringify(keys2));
}

// ══════════════════════════════════════════════════════════════════════════
// D. 真数据（可选）
// ══════════════════════════════════════════════════════════════════════════
const ROOT = path.resolve(process.argv[2] || process.env.QQ_AGENT_ROOT || 'E:/Tools/QQ-Agent-整合版-20260922');
const CHUNKS = path.join(ROOT, 'data', 'memory-v2', 'chunks');

console.log('\n── D. 真数据分布 ──────────────────────────────────');
if (!fs.existsSync(CHUNKS)) {
  skip('真数据分布', `找不到 ${CHUNKS} —— 传一个 QQ-Agent 根目录就能跑`);
} else {
  const { listChunks, readChunk } = await import('../src/core/chunkread.mjs');
  const listed = listChunks(CHUNKS);
  const all = [];
  for (const p of listed) {
    const { chunk, error } = readChunk(CHUNKS, p.id);
    if (!error && chunk) all.push(chunk);
  }
  ok(all.length > 0, `读到真实小时块 ${all.length} 个（目录里 ${listed.length} 个）`);

  const t0 = Date.now();
  const scan = scanCorpus(all, { now: Date.now(), baseDays: 30 });
  const dist = rankDistribution(scan, { topK: 5 });
  console.log(`  扫描耗时 ${Date.now() - t0} ms · 实体键 ${dist.inv.entities} 个（**兜底口径**：没加载词表）`);

  const pad = (s, n) => String(s).padEnd(n, ' ');
  const printDist = (d, title) => {
    console.log(`\n  ── ${title} ──`);
    console.log('  维  名称        n/missing  覆盖    档数  极差        top档  最多并列  dead  判据');
    console.log('  ' + '─'.repeat(86));
    for (const k of DIM_ORDER) {
      const v = d.dims[k];
      console.log(`  ${pad(k, 3)} ${pad(v.label, 10)} ${pad(`${v.n}/${v.missing}`, 10)} ${pad(v.coverage, 7)} ` +
        `${pad(v.tiers, 5)} ${pad(v.range, 10)} ${pad(v.topTiers, 5)} ${pad(v.maxTie, 9)} ` +
        `${pad(v.dead ? 'YES' : '-', 5)} ${v.ok === null ? 'n/a（无样本）' : v.ok ? '过' : '不过'}`);
    }
    console.log('  附带量：' + Object.values(d.extras)
      .map((v) => `${v.label} 档数=${v.tiers} 极差=${v.range} top档=${v.topTiers}${v.ok ? ' 过' : ' 不过'}`).join(' | '));
    // 饱和诊断：头部全平是最隐蔽的"没分辨力" —— 注入的永远只有 top-K
    const sat = DIM_ORDER.map((k) => ({ k, v: d.dims[k] })).filter((x) => x.v.n > 0 && x.v.atMaxShare >= 0.4);
    if (sat.length) {
      console.log('  饱和：' + sat.map((x) => `${x.k} ${(x.v.atMaxShare * 100).toFixed(1)}% 打满 ${x.v.max}`).join(' | '));
    }
    for (const k of DIM_ORDER) {
      if (d.dims[k].deadReason) console.log(`  · ${k} 诊断：${d.dims[k].deadReason}`);
    }
  };

  printDist(dist, '兜底口径（未加载词表）');

  // ── 换成运行期口径：与索引侧同一个归一化器 ──────────────────────────────
  // R/I/C 的原料是"占位符级实体"，所以必须用**真正的词表**跑一遍 ——
  // 兜底口径（数字当 QQ、who 里的人名）只覆盖块里显式出现的少数键，
  // 会把 R 的覆盖率系统性压低。两套口径都要看得见。
  let tmpDir = null;
  try {
    const { Normalizer } = await import('../src/core/normalize.mjs');
    const { buildVocabulary } = await import('../src/core/vocab.mjs');
    // ⚠️ 归一化器要落 secret/entities，**绝不能写进宿主的 data 目录** —— 用临时目录。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rank-'));
    const nz = new Normalizer({ dir: path.join(tmpDir, 'normalizer') });
    const v = buildVocabulary({ dataDir: path.join(ROOT, 'data') });
    nz.setVocabulary(v.entities);
    const scan2 = scanCorpus(all, { normalizer: nz, now: Date.now(), baseDays: 30 });
    const dist2 = rankDistribution(scan2, { topK: 5 });
    printDist(dist2, `运行期口径（词表 ${v.entities.length} 个实体）`);

    console.log('\n  ── 结论（运行期口径）──');
    for (const line of dist2.verdict) console.log(`  · ${line.replace(/\*\*/g, '')}`);

    ok(dist2.inv.entities > dist.inv.entities,
      `词表口径抠出的实体键更多（${dist2.inv.entities} > ${dist.inv.entities}）`,
      `R 覆盖率 ${dist.dims.R.coverage} → ${dist2.dims.R.coverage}`);
    ok(dist2.dims.E.n === 0 && dist2.dims.E.src === 'missing', '真数据上 E 维仍是 missing（不伪造）');
    ok(DIM_ORDER.every((k) => dist2.dims[k].ok !== true || (dist2.dims[k].tiers >= 3 && dist2.dims[k].range > 0.01)),
      '凡判据通过的维度，都满足 档数≥3 且 极差>0.01（不许放宽）');
    ok(dist2.dims.S.tiers >= 1, 'S 维在真数据上有值（哪怕是常数，也必须看得见）', dist2.dims.S.summary);
    ok(dist2.inv.entities > 0, '真实块里抠出了实体键（否则 R/I/C 全无原料）');

    // 诊断本身的契约：只报"不过"是不够的 —— 必须说清是"没原料"还是"阈值要重扫"，
    // 因为这两种病的改法完全不同（前者记「不做」，后者重扫阈值）。
    ok(DIM_ORDER.every((k) => typeof dist2.dims[k].atMaxShare === 'number'), '每一维都有饱和度量 atMaxShare');
    ok(DIM_ORDER.every((k) => {
      const v = dist2.dims[k];
      if (v.n === 0) return true;
      return (!v.dead && v.atMaxShare < 0.4) || typeof v.deadReason === 'string';
    }), '凡是死的或头部饱和的维度，都必须带一条诊断原因（不许只报"不过"）');
    ok(DIM_ORDER.every((k) => dist2.dims[k].baseline !== null || k === 'E'),
      '派生维都有原料基线（distinct / mode / modeShare）');

    // 影子账本：只记分布形状，追加写
    const { appendShadowSnapshot, readShadowSnapshots } = await import('../src/core/rankscan.mjs');
    const shadowDir = path.join(tmpDir, 'shadow');
    const f1 = appendShadowSnapshot(dist2, shadowDir);
    const f2 = appendShadowSnapshot(dist2, shadowDir);
    const back = readShadowSnapshots(shadowDir);
    ok(Boolean(f1) && f1 === f2, '影子快照追加写进同一天的文件（不覆盖）');
    ok(back.length === 2 && back[1].dims.S.tiers === dist2.dims.S.tiers,
      '影子账本读得回来且形状一致', `${back.length} 条`);
    ok(back.every((b) => b.dims.E.missing === all.length),
      '影子账本里 missing 是**计数**、不是 0 分（否则读的人会以为 E 打过分）');
  } catch (err) {
    skip('运行期口径（词表）', `装载词表/归一化器失败：${err?.message || err}`);
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响结论 */ } }
  }
}

console.log(`\n结果：${tally.pass} 通过 / ${tally.fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}\n`);
process.exit(tally.fail ? 1 : 0);
