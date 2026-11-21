#!/usr/bin/env node
// tools/audit-active-generation.mjs —— **只读对账**：当前活代 ⟷ 语料 ⟷ 编码身份
//
// [by:DS] 2026-10-29 建。主审要求"补交证据"里第一条就是它：活代是哪个、观测时间、
// 语料**应索引 id 集合**与实际 id 集合的差异、事件 id 集合/编码信息、`sourceHash` 当前性。
// 这些用"条数相等"回答不了 —— 1426 = 1426 既可能是全对，也可能是漏一条多一条。
//
// ── 四条硬纪律（它存在的理由）─────────────────────────────────────────────
//  ① **不构造 `VecStore`**：它的构造函数会 `mkdirSync` + `_recoverPut()`（可能写 index、
//     删 journal）。审计一个库却顺手改了它，是最坏的一种"观测扰动"。
//     所以这里只做**静态读**：`index.json` / `meta.jsonl` 直接 `JSON.parse`。
//  ② **不起 HTTP 服务**：`start()` 会 `armTimer()` 挂定时索引 —— 一次审计不该给被审计的库
//     装上一个"60 分钟后自动花钱"的定时器。
//  ③ **不调模型**：只复算 `sourceHash`（本地 FNV），不碰 embedding 端点。
//  ④ **不落盘**：`ensureIdentity(rt, {dryRun:true})` 只装内存词表，跳过 `normalizer.save()`
//     与写沿革 —— 否则"看一眼"就会重写 entities/registry/pending 三份本机敏感文件。
//
// 用法：
//   node tools/audit-active-generation.mjs --name=主号 [--json]
//   node tools/audit-active-generation.mjs --data-root "E:/.../data" [--source-root ...] [--json]
//   ... --no-hash     只做 id 集合对账（不构建文本、不装词表，秒级）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}
const args = parseArgs(process.argv);
const asJson = Boolean(args.json);
const withHash = !args['no-hash'];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 实例解析与 `rebuild-generation.mjs` 同口径。**故意复制一份**而不是 import 那个文件：
// 它是可执行脚本（import 会跑主逻辑），而审计工具必须能被单独调用、且永远只读。
function resolveInstance() {
  if (args['data-root']) {
    return {
      name: String(args.name || path.basename(path.resolve(args['data-root']))),
      dataRoot: path.resolve(args['data-root']),
      sourceRoot: args['source-root'] ? path.resolve(args['source-root']) : ''
    };
  }
  const file = args.instances ? path.resolve(args.instances) : path.join(REPO, 'instances.json');
  const list = readJson(file)?.instances || [];
  const hit = list.find((i) => (args.name && i.name === args.name) || (args.port && Number(i.port) === Number(args.port)))
    || (list.length === 1 ? list[0] : null);
  if (!hit) {
    console.error(`\n✗ 实例清单里找不到目标实例（可用：${list.map((i) => i.name).join(' / ') || '无'}）\n`);
    process.exit(1);
  }
  return {
    name: hit.name,
    port: hit.port,
    dataRoot: path.resolve(REPO, hit.dataRoot),
    sourceRoot: hit.sourceRoot ? path.resolve(hit.sourceRoot) : ''
  };
}

/**
 * 静态读一个库目录：**不构造 VecStore**。
 * 行号=slot 的语义在这里不还原（审计只关心 id 集合与元数据），
 * 但"同 id 出现多行 alive"必须数出来 —— 那是墓碑欠账的规模。
 */
function staticRead(dir) {
  const rows = [];
  let raw = '';
  try { raw = fs.readFileSync(path.join(dir, 'meta.jsonl'), 'utf8'); } catch { return { rows, alive: new Map(), dupRows: 0, deleted: 0, raw: '' }; }
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { bad++; continue; }
    rows.push(m);
  }
  const alive = new Map();   // id → 最后一行的（与 `_load` 的"同 id 后者覆盖"同口径）
  let dupRows = 0;
  let deleted = 0;
  for (const m of rows) {
    if (m?.state !== 'alive') { deleted++; continue; }
    if (m.id) {
      // `_load` 会把旧槽置 null 但**行数不变** —— 所以这里既记唯一 id，也记"多出来的行"
      if (alive.has(m.id)) dupRows++;
      alive.set(m.id, m);
    }
  }
  return { rows, alive, dupRows, deleted, bad, raw };
}

async function main() {
  const inst = resolveInstance();
  const lib = path.join(inst.dataRoot, 'memory-vec');
  if (!fs.existsSync(lib)) {
    console.error(`\n✗ 库根不存在：${lib}\n`);
    process.exit(1);
  }

  // 源根：显式参数 > 库根 config.json 的 skills.memory-vec.sourceRoot > 库根自身
  const { resolveSourceRoot, readSkillConfig } = await import('../src/server.mjs');
  const srcRoot = resolveSourceRoot(inst.dataRoot, inst.sourceRoot || '');

  // 与 `createServer()` **逐字同口径**的注入：审计读到必须是生产那份配置，
  // 否则"哈希陈旧"的结论会来自审计自己的默认值。
  const { bindHost } = await import('../src/core/host.mjs');
  const { DEFAULT_SETTINGS, ensureIdentity, dataRoot } = await import('../src/core/backend.mjs');
  const { encodingIdentity } = await import('../src/core/vector-generation.mjs');
  const { getSharedNormalizer } = await import('../src/core/normalize.mjs');

  bindHost({
    config: { DATA_DIR: path.resolve(inst.dataRoot), SOURCE_DIR: srcRoot },
    settings: { getSkillConfig: (id, defaults) => readSkillConfig(srcRoot, id, defaults) },
    fallbackRoot: path.resolve(inst.dataRoot, '..')
  });
  const settings = readSkillConfig(srcRoot, 'memory-vec', DEFAULT_SETTINGS);

  const pointer = readJson(path.join(lib, 'vector-active.json'));
  const generation = /^[a-f0-9]{32}$/.test(String(pointer?.generation || '')) ? pointer.generation : null;
  const storeDir = generation ? path.join(lib, 'vector-generations', generation) : lib;
  const index = readJson(path.join(storeDir, 'index.json'));
  const store = staticRead(storeDir);

  const out = {
    instance: inst.name,
    observedAt: new Date().toISOString(),
    observedAtLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
    libDir: lib,
    sourceRoot: srcRoot,
    layout: generation ? 'generation' : 'legacy-flat',
    generation,
    storeDir,
    storeFileMtime: (() => { try { return fs.statSync(path.join(storeDir, 'index.json')).mtime.toISOString(); } catch { return null; } })(),
    binBytes: (() => { try { return fs.statSync(path.join(storeDir, 'vectors.bin')).size; } catch { return null; } })(),
    index: {
      dim: index?.dim ?? null,
      model: index?.model ?? null,
      slots: index?.slots ?? null,
      alive: index?.alive ?? null,
      encoding: index?.encoding ?? null,
      updatedAt: index?.updatedAt ? new Date(index.updatedAt).toISOString() : null
    },
    pointerEncoding: pointer?.encoding ?? null,
    meta: {
      rows: store.rows.length,
      aliveRows: store.rows.filter((m) => m?.state === 'alive').length,
      deletedRows: store.deleted,
      uniqueIds: store.alive.size,
      duplicateAliveRows: store.dupRows,   // = 墓碑欠账规模（不是"检索重复"）
      unparsableLines: store.bad || 0
    },
    encoding: {
      current: encodingIdentity(settings),
      matchesIndexEncoding: index?.encoding ? encodingIdentity(settings) === index.encoding : null,
      matchesPointerEncoding: pointer?.encoding ? encodingIdentity(settings) === pointer.encoding : null
    },
    settingsUsed: {
      embedModel: settings.embedModel || '', embedDimensions: settings.embedDimensions ?? '',
      embedRevision: settings.embedRevision || '', maxChars: settings.maxChars,
      withKeywords: settings.withKeywords !== false, withSummary: settings.withSummary !== false,
      keywordsSource: settings.keywordsSource, keywordsCaliber: settings.keywordsCaliber
    }
  };

  // ── 事件向量单独结账（它们**不在语料里**，所以不能算"多余"）────────────────
  const eventIds = new Set();
  const eventModels = {};
  const eventDims = {};
  const carried = {};
  const carryRecorded = {};   // 搬运当时记下的 carryVerdict（与本次重算的结论对账）
  for (const [id, m] of store.alive) {
    if (m.kind !== 'event') continue;
    eventIds.add(id);
    const mk = `${m.model ?? '(meta 无 model 字段)'}/${m.embedDim ?? '(无 embedDim)'}`;
    eventModels[mk] = (eventModels[mk] || 0) + 1;
    eventDims[String(m.embedDim ?? 'none')] = (eventDims[String(m.embedDim ?? 'none')] || 0) + 1;
    const c = m.carriedFrom || '(无 carriedFrom)';
    carried[c] = (carried[c] || 0) + 1;
    const cv = m.carryVerdict || '(未记录 carryVerdict)';
    carryRecorded[cv] = (carryRecorded[cv] || 0) + 1;
  }

  // ── 来源身份：读**旧库**原始行，绝不读目标代（目标代标签是搬运时写的）─────────
  // 旧库默认就是库根：切代后 `vector-active.json` 指向 `vector-generations/<sha>/`，
  // 库根的 `meta.jsonl` 停留在切代前那一刻，里面每条事件的 `model`/`dim` 是
  // **promote 当时**写下的，属于来源侧记录。
  const { compareSourceIdentity, parseEncoding, IDENTITY_FIELDS } = await import('../src/core/vector-generation.mjs');
  const legacyDir = (() => {
    if (args.legacy) return path.resolve(String(args.legacy));
    if (path.resolve(storeDir) !== path.resolve(lib) && fs.existsSync(path.join(lib, 'meta.jsonl'))) return lib;
    return null;
  })();
  const legacyIndex = legacyDir ? readJson(path.join(legacyDir, 'index.json')) : null;
  const legacyStore = legacyDir ? staticRead(legacyDir) : { alive: new Map(), rows: [] };
  const sourceEncoding = legacyIndex?.encoding ?? null;   // 旧扁平布局 = null（这就是 unknown 的来源）
  const currentIdentity = encodingIdentity(settings);

  const perEvent = [];
  const srcModelHist = {};
  const srcDimHist = {};
  const missingInSource = [];
  for (const id of eventIds) {
    const row = legacyStore.alive.get(id);
    if (!row) {
      missingInSource.push(id);
      perEvent.push({ id, verdict: 'unknown', reason: '旧库里没有这个 id，来源不可追溯' });
      continue;
    }
    const sm = row.model ?? null;
    const sd = row.dim ?? row.embedDim ?? null;
    srcModelHist[String(sm)] = (srcModelHist[String(sm)] || 0) + 1;
    srcDimHist[String(sd)] = (srcDimHist[String(sd)] || 0) + 1;
    const v = compareSourceIdentity(
      { model: sm, dim: sd, encoding: sourceEncoding },
      { model: settings.embedModel, dim: index?.dim ?? null, encoding: currentIdentity }
    );
    perEvent.push({ id, verdict: v.verdict, reason: v.reason, fields: v.fields });
  }
  // 汇总取**最严**：任一 incompatible 就 incompatible；否则任一 unknown 就 unknown。
  const agg = (() => {
    if (!eventIds.size) return { verdict: 'n/a', reason: '没有事件向量' };
    const inc = perEvent.filter((e) => e.verdict === 'incompatible');
    const unk = perEvent.filter((e) => e.verdict === 'unknown');
    if (inc.length) return { verdict: 'incompatible', reason: `${inc.length} 条来源身份与当前不一致`, sample: inc.slice(0, 3) };
    if (unk.length) return { verdict: 'unknown', reason: `${unk.length} 条来源身份无法证实`, sample: unk.slice(0, 3) };
    return { verdict: 'compatible', reason: '全部 6 项均有来源记录且与当前一致' };
  })();
  const provenance = {
    legacyDir,
    found: Boolean(legacyDir),
    legacyIndexModel: legacyIndex?.model ?? null,
    legacyIndexDim: legacyIndex?.dim ?? null,
    // 这一行是本次要承认的事实：旧扁平布局不记 encoding ⇒ 4 项无从证实
    legacyIndexEncoding: sourceEncoding,
    legacyEncodingFields: (() => {
      const e = parseEncoding(sourceEncoding);
      return e ? Object.keys(e) : null;
    })(),
    rowModelHistogram: srcModelHist,
    rowDimHistogram: srcDimHist,
    missingInSource,
    verdict: agg.verdict,
    reason: agg.reason,
    ...(agg.sample ? { sample: agg.sample } : {}),
    // 逐字段矩阵（取第一条有 fields 的记录作代表；逐条不一致时看 sample）
    fields: perEvent.find((e) => e.fields)?.fields ?? null,
    note: legacyDir
      ? '来源身份取自旧库行内 model/dim 与旧库 index.encoding；缺失字段记为 unknown'
      : '找不到旧库（库根就是活代）⇒ 来源身份不可得'
  };
  out.events = {
    count: eventIds.size,
    storeModel: index?.model ?? null,
    storeDim: index?.dim ?? null,
    // ① 目标代自身的**标签自洽** —— 只说明"标签等于它所在 index 的身份"。
    //    ⚠️ 标签是搬运时写进去的，所以这一层**不能**用来证明来源。
    //    2026-10-29 主审驳回的正是"拿它当兼容证据"。
    labelConsistency: {
      byModelAndDim: eventModels,
      byEmbedDim: eventDims,
      byCarriedFrom: carried,
      byCarryVerdict: carryRecorded,
      matchesStoreIndex: (() => {
        if (!eventIds.size) return null;
        const okModel = Object.keys(eventModels).every((k) => k.split('/')[0] === String(index?.model));
        const okDim = eventDims && Object.keys(eventDims).every((d) => d !== 'none' && Number(d) === Number(index?.dim));
        return okModel && okDim;
      })(),
      note: '只证明目标行标签与其所在 index 一致；标签由搬运写入 ⇒ 不构成来源证明'
    },
    // ② 来源身份：必须从**旧库**读原始行（`--legacy=`，默认取库根）。
    sourceProvenance: provenance,
    // ③ 最终结论只看 ②。来源不可得 ⇒ unknown，**绝不**退化成 ① 的"看起来一致"。
    verdict: provenance.verdict,
    reason: provenance.reason
  };

  if (!withHash) {
    out.corpus = { skipped: true };
    out.reconcile = null;
  } else {
    const { listCorpus, readCorpusItem } = await import('../src/core/corpus.mjs');
    const { buildEmbedText, sourceHash } = await import('../src/core/chunkread.mjs');

    const items = listCorpus(await dataRoot(), { maxChars: settings.maxChars });
    const normalizer = getSharedNormalizer({ dir: path.join(inst.dataRoot, 'memory-vec', 'normalizer') });
    // 只装内存词表：`dryRun` 跳过 save() 与沿革写入
    await ensureIdentity({ settings, normalizer, dir: lib }, { dryRun: true, force: true });

    const expected = new Set();
    const hashOf = new Map();
    const unreadable = [];
    const rejected = [];
    const emptyText = [];
    // 与 `runIndex` 同构的两遍：先登记（只落真值），再构建（不改变注册表）
    const built = [];
    for (const it of items) {
      const { chunk, error } = readCorpusItem(it);
      if (error || !chunk) { unreadable.push({ id: it.id, error: String(error || '空文件') }); continue; }
      built.push({ it, chunk });
      try {
        buildEmbedText(chunk, {
          normalizer, maxChars: settings.maxChars,
          withKeywords: settings.withKeywords !== false, keywordsSource: settings.keywordsSource,
          withSummary: settings.withSummary !== false, register: true
        });
      } catch { /* 第 ② 遍会如实记成 rejected */ }
    }
    for (const { it, chunk } of built) {
      expected.add(it.id);
      let info;
      try {
        info = buildEmbedText(chunk, {
          normalizer, maxChars: settings.maxChars,
          withKeywords: settings.withKeywords !== false, keywordsSource: settings.keywordsSource,
          withSummary: settings.withSummary !== false, register: false
        });
      } catch (e) {
        rejected.push({ id: it.id, code: e?.code || '', message: String(e?.message || e).slice(0, 200) });
        continue;
      }
      if (!info.text) { emptyText.push({ id: it.id }); continue; }
      hashOf.set(it.id, sourceHash(chunk, info.text));
    }

    const corpusIds = new Set([...expected, ...unreadable.map((u) => u.id), ...emptyText.map((u) => u.id)]);
    const missing = [...corpusIds].filter((id) => !store.alive.has(id));
    const notInCorpus = [...store.alive.keys()].filter((id) => !corpusIds.has(id));
    const orphans = notInCorpus.filter((id) => !eventIds.has(id));
    const stale = [];
    for (const [id, h] of hashOf) {
      const m = store.alive.get(id);
      if (!m) continue;
      if (m.sourceHash !== h) stale.push({ id, stored: m.sourceHash ?? null, current: h });
    }

    out.corpus = {
      listed: items.length,
      readable: built.length,
      expectedIds: corpusIds.size,
      hashComputed: hashOf.size,
      unreadable: unreadable.length,
      rejected: rejected.length,
      emptyText: emptyText.length,
      unreadableList: unreadable.slice(0, 20),
      rejectedList: rejected.slice(0, 20)
    };
    out.reconcile = {
      // 唯一 id 集合对账（**不是**行数等式）
      missingInStore: missing.length,          // 语料有、库里没有 ⇒ 真漏
      missingIds: missing.slice(0, 50),
      eventsOutsideCorpus: eventIds.size,
      orphansInStore: orphans.length,          // 库里有、语料已无 ⇒ 源块被删后留下的
      orphanIds: orphans.slice(0, 50),
      staleHash: stale.length,                 // 同 id 但当前归一化器算出的哈希不同 ⇒ 待重嵌
      staleList: stale.slice(0, 20),
      // 完整性判定：id 集合差集为空 且 无陈旧哈希，才算"与当前语料一致"
      complete: missing.length === 0 && orphans.length === 0 && stale.length === 0,
      // 事件向量的"原样搬运"不经过本工具，故这里只声明它的规模，不并入 complete
      note: '事件向量不在语料里，单独结账（见 events）；本对账的 complete 只覆盖语料块'
    };
  }

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }

  const L = [];
  L.push(`\n实例：${inst.name}    观测：${out.observedAtLocal}（${out.observedAt}）`);
  L.push(`库根：${out.libDir}`);
  L.push(`源根：${out.sourceRoot}`);
  L.push(`活代：${generation || '（无指针 ⇒ 旧扁平布局，库根）'}`);
  L.push(`代目录：${path.relative(lib, storeDir).replace(/\\/g, '/') || '.'}   index.json mtime ${out.storeFileMtime || '—'}`);
  L.push(`index.json：slots=${out.index.slots} alive=${out.index.alive} dim=${out.index.dim} model=${out.index.model || '—'}`);
  L.push(`meta.jsonl：${out.meta.rows} 行（alive ${out.meta.aliveRows} / deleted ${out.meta.deletedRows}）`
    + `  唯一 id ${out.meta.uniqueIds}`
    + (out.meta.duplicateAliveRows ? `  ⚠ 同 id 多行 alive ${out.meta.duplicateAliveRows}（墓碑欠账，槽位白占；检索不重复）` : ''));
  L.push(`bin：${out.binBytes == null ? '—' : (out.binBytes / 1048576).toFixed(1) + 'MB'}`);
  L.push(`编码身份：当前 ${out.encoding.matchesIndexEncoding === null ? '（库里没记 encoding）'
    : out.encoding.matchesIndexEncoding ? '= index.encoding ✓' : '≠ index.encoding ✗'}`
    + ` / 指针 ${out.encoding.matchesPointerEncoding === null ? '（无指针）' : out.encoding.matchesPointerEncoding ? '= ✓' : '≠ ✗'}`);
  L.push(`事件向量：${out.events.count} 条   来源身份判定：${out.events.verdict}（${out.events.reason}）`);
  if (out.events.count) {
    const lc = out.events.labelConsistency;
    L.push(`  ① 目标标签自洽（**不构成来源证明**）：model/dim ${JSON.stringify(lc.byModelAndDim)}`
      + `  搬运标记 ${JSON.stringify(lc.byCarriedFrom)}  当时判定 ${JSON.stringify(lc.byCarryVerdict)}`);
    const sp = out.events.sourceProvenance;
    L.push(`  ② 来源库：${sp.legacyDir ?? '（未找到）'}`
      + `  index model=${sp.legacyIndexModel} dim=${sp.legacyIndexDim} encoding=${sp.legacyIndexEncoding ? '有记录' : '**无记录（旧扁平布局）**'}`);
    if (sp.found) L.push(`     来源行 model ${JSON.stringify(sp.rowModelHistogram)} dim ${JSON.stringify(sp.rowDimHistogram)}`);
    if (sp.missingInSource?.length) L.push(`     旧库里找不到的事件 id：${sp.missingInSource.length} 条（来源不可追溯）`);
    if (sp.fields) {
      const f = sp.fields;
      L.push('     逐字段：' + IDENTITY_FIELDS.map((k) => `${k}=${f[k]?.result ?? '?'}(${f[k]?.source ?? '—'}→${f[k]?.target ?? '—'})`).join('  '));
    }
  }
  if (!withHash) {
    L.push('语料对账：已跳过（--no-hash）');
  } else {
    L.push(`\n语料：枚举 ${out.corpus.listed} · 可读 ${out.corpus.readable} · 应索引 id ${out.corpus.expectedIds}`
      + ` · 复算哈希 ${out.corpus.hashComputed}`);
    L.push(`  读不出 ${out.corpus.unreadable} · 闸门拒 ${out.corpus.rejected} · 空文本 ${out.corpus.emptyText}`);
    L.push('\n对账（唯一 id 集合）：');
    L.push(`  语料有·库里无：${out.reconcile.missingInStore}`);
    L.push(`  库里有·语料无：${out.reconcile.orphansInStore}（另有事件 ${out.reconcile.eventsOutsideCorpus} 条，不在语料里属正常）`);
    L.push(`  同 id 但哈希陈旧：${out.reconcile.staleHash}`);
    L.push(`  ⇒ 与当前语料一致：${out.reconcile.complete ? '是 ✓' : '否 ✗'}`);
    if (out.reconcile.missingIds.length) L.push(`  缺失样例：${out.reconcile.missingIds.slice(0, 8).join(', ')}`);
    if (out.reconcile.staleList.length) L.push(`  陈旧样例：${out.reconcile.staleList.slice(0, 5).map((s) => `${s.id}(${s.stored}→${s.current})`).join(', ')}`);
  }
  L.push('');
  console.log(L.join('\n'));
}

await main();
