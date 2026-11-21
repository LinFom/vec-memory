// 事实层存储 · 单元测试（不联网、不读存档：用临时目录 + 合成归一化器）。
//
// 为什么这个测试重要：`lib/facts.mjs` 把**键**落成了纯函数，但"键接上盘"是另一件事 ——
// 本项目吃过"**声称了没落地**"（`rank_version`）的亏。这里断言的是**接线**：
// 键 → 盘 → 可查；以及三条纪律：
//   ① 身份键 append-only（同 key 新行 = 更新，旧版本留痕）
//   ② 真值先落、派生量后落（崩在 index = 自愈；崩在 jsonl = 只读报错）
//   ③ 出境红线（scope 必须是占位符，不许明文 QQ/群号）
//   ④ 装配必载入（测试与生产**同走 `openFactStore`** —— 见 ⑫ 与 `ADR-0023`）
//
// 运行：node test/factstore.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Normalizer } from '../src/core/normalize.mjs';
import { FactStore, FactStoreError, openFactStore } from '../src/core/factstore.mjs';
import { PRAGMATIC_VERSION } from '../src/core/edges.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));


/** 每次给一个全新临时目录，测试间不互相污染。 */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `memory-vec-facts-${tag}-`));
}

/** 合成归一化器：只需 secret（scopeLabel 是 HMAC 派生，无状态）。 */
function mkNorm() {
  const n = new Normalizer({ secret: 'factstore-test-'.repeat(3) });
  return n;
}

/** 数 slots.jsonl 行数（= 版本数，不是槽数）。 */
function linesOf(store) {
  if (!fs.existsSync(store.slotsFile)) return 0;
  return fs.readFileSync(store.slotsFile, 'utf8').split('\n').filter(Boolean).length;
}

console.log('\n══ 事实层存储（四元组键接线 · append-only · 红线）══════════════════════');

// ── ① 基本写入：首见 ⇒ update v1；同内容 ⇒ noop ────────────────────────────
{
  const dir = tmpDir('basic');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });

  const r1 = st.put({
    speaker: 'P7722', target: 'SELF', fact_kind: 'pattern', chatKey: 'group:1098345913',
    content: { topic: '表白梗', pattern_type: 'joke' }, evidenceIds: [101, 102, 103]
  });
  ok(r1.action === 'update' && r1.rev === 1, '首见 ⇒ `update` rev=1');
  ok(st.count === 1, '槽数=1');
  ok(linesOf(st) === 1, 'slots.jsonl 追加 1 行（真值先落）');

  const r2 = st.put({
    speaker: 'P7722', target: 'SELF', fact_kind: 'pattern', chatKey: 'group:1098345913',
    content: { topic: '表白梗', pattern_type: 'joke' }, evidenceIds: [101, 102, 103]
  });
  ok(r2.action === 'noop' && r2.rev === 1, '**同内容**再写 ⇒ `noop`（不产新版本、rev 不变）');
  ok(linesOf(st) === 1, '`noop` **不写盘**（行数仍为 1）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ② append-only：内容变 ⇒ rev+1 且**追加新行**（旧版本留痕）──────────────
{
  const dir = tmpDir('append');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  const base = { speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1098345913' };

  st.put({ ...base, content: { pattern_type: 'joke' }, evidenceIds: [1, 2, 3] });
  const r2 = st.put({ ...base, content: { pattern_type: 'sincere' }, evidenceIds: [1, 2, 3, 4] });
  ok(r2.action === 'update' && r2.rev === 2, '内容变 ⇒ `update` rev+1(=2)');
  ok(st.count === 1, '仍是**同一个槽**（键 append-only 不变）⇒ 槽数=1');
  ok(linesOf(st) === 2, '追加第 2 行（旧版本留痕，可审计"改过几次"）');

  // 重开：同 key 取**最后一行**
  const st2 = openFactStore(dir, { normalizer: norm });
  ok(st2.count === 1, '重开后槽数仍=1（同 key 重放取最后一行）');
  const rec = st2.getSlot({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1098345913' });
  ok(rec && rec.rev === 2 && rec.content.pattern_type === 'sincere', '取到的是**最新版本**（rev=2, sincere）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ③ scope 由 scopeLabel 派生（无状态、确定性、不泄明文）────────────────
{
  const dir = tmpDir('scope');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });

  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1098345913', content: { a: 1 } });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'private:1353446252', content: { a: 1 } });

  const g = norm.scopeLabel('group:1098345913');
  const p = norm.scopeLabel('private:1353446252');
  ok(g.startsWith('group:C') && p.startsWith('private:C'), 'scopeLabel 产出占位符 token', `(${g} / ${p})`);
  ok(g !== p, '不同会话 ⇒ 不同 scope ⇒ 不同槽（群/私聊不并槽）');
  ok(st.count === 2, '两次 put 落到**两个槽**（scope 进身份）');

  const all = [...st.slots.values()];
  ok(all.every((r) => !/[0-9]{7,}/.test(r.scope)), '落盘的 scope **不含明文长数字**（不泄 QQ/群号）');
  ok(new Set(all.map((r) => r.scope)).size === 2, '两个 scope 互不相同');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ④ 红线守卫：缺 scope / 明文 scope / 空 fact_kind ⇒ put 抛 ──────────────
{
  const dir = tmpDir('guard');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });

  const throws = (fn) => { try { fn(); return false; } catch (e) { return e; } };

  const e1 = throws(() => st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', content: {} }));
  ok(e1 instanceof FactStoreError, '既无 `chatKey` 也无 `scope` ⇒ **抛**（scope 是身份的一部分）');

  const e2 = throws(() => st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', scope: 'private:1353446252', content: {} }));
  ok(e2 instanceof FactStoreError, '`scope` 传明文 id ⇒ **抛**（键不得带明文 QQ）');

  const e3 = throws(() => st.put({ speaker: 'P1', target: 'P2', fact_kind: '', chatKey: 'group:1', content: {} }));
  ok(e3 instanceof FactStoreError, '空 `fact_kind` ⇒ **抛**（它是身份键的一段）');

  const e4 = throws(() => st.put({ speaker: 'qq:1353446252', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: {} }));
  ok(e4 instanceof FactStoreError, '`speaker` 是明文 id（`qq:<QQ>`）⇒ **抛**');

  // ⚠️ `fact_kind` 进身份键 ⇒ 只查"非空"不够：拼写错误会**静默变成一个全新的槽**（ADR-0017）。
  const e5 = throws(() => st.put({ speaker: 'P1', target: 'P2', fact_kind: 'speaker-profile', chatKey: 'group:1', content: {} }));
  ok(e5 instanceof FactStoreError && e5.code === 'BAD_FACT_KIND',
    '`fact_kind` 拼写错（`speaker-profile`）⇒ **抛** `BAD_FACT_KIND`（否则 = 静默新建一个槽）');
  const e6 = throws(() => st.put({ speaker: 'P1', target: 'P2', fact_kind: 'Pattern', chatKey: 'group:1', content: {} }));
  ok(e6 instanceof FactStoreError && e6.code === 'BAD_FACT_KIND', '`fact_kind` 大小写错（`Pattern`）⇒ **抛**');

  ok(linesOf(st) === 0, '六次非法 put **一行都没落盘**（拒绝在写之前，不产生半成品）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ④b. 合法 kind 分布：语用段与语义段都收 ───────────────────────────────
{
  const dir = tmpDir('kinds');
  const st = openFactStore(dir, { normalizer: mkNorm() });
  const r1 = st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { v: 1 } });
  const r2 = st.put({ speaker: 'P1', target: 'P2', fact_kind: 'preference', chatKey: 'group:1', content: { v: 2 } });
  ok(r1.keyed && r2.keyed && r1.key !== r2.key, '同 speaker/target/scope、**不同 kind ⇒ 不同槽**（kind 是身份分量）');
  ok(st.count === 2, '两个合法 kind 各落一槽', `= ${st.count}`);
  ok(st.verify().ok === true, 'verify() 对合法 kind 全绿');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑤ 崩溃恢复：半截 JSON ⇒ 进只读并报错，且拒绝再写 ──────────────────────
{
  const dir = tmpDir('crash');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  // 造一个"崩在 jsonl 中途"的现场：追加半截 JSON（无换行结尾）
  fs.appendFileSync(st.slotsFile, '{"key":"P1\\u0000P2\\u0000pattern\\u0000group:C1","speaker":"P1"', 'utf8');

  const st2 = openFactStore(dir, { normalizer: norm });
  ok(st2.readOnlyReason, '半截行 ⇒ 打开即进**只读**（并带原因）', `(${String(st2.readOnlyReason).slice(0, 30)}…)`);
  const e = (() => { try { st2.put({ speaker: 'P9', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: {} }); return null; } catch (x) { return x; } })();
  ok(e instanceof FactStoreError && e.code === 'READ_ONLY', '只读态下 put ⇒ **抛** `READ_ONLY`（不静默丢写）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑥ 派生量自愈：删掉 index.json，重开仍从 jsonl 重建 ───────────────────
{
  const dir = tmpDir('heal');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  st.put({ speaker: 'P1', target: 'P3', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 2 } });
  const before = st.index.count;

  fs.rmSync(st.indexFile);                 // 模拟"崩在派生量上"
  const st2 = openFactStore(dir, { normalizer: norm });
  ok(st2.index.count === before && st2.count === 2,
    'index.json 丢失 ⇒ 重开从 `slots.jsonl` **重数一遍即自愈**（派生量）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑦ verify()：键可重拼、无明文；index 陈旧可检出 ────────────────────────
{
  const dir = tmpDir('verify');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  const v = st.verify();
  ok(v.ok && v.problems.length === 0, 'verify() 全绿（键可重拼 + 无明文）');

  // 手工把 index 改陈旧 ⇒ verify 检出 indexStale（但不报"损坏"）
  st.index = { ...st.index, count: 999 };
  const v2 = st.verify();
  ok(v2.indexStale === true, 'index 与实测数不符 ⇒ `indexStale` 检出（可从 jsonl 重建，非损坏）');
  ok(v2.ok === true, '`indexStale` **不算损坏**（派生量可重建）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑧ reset()：唯一能清只读态的动作 ──────────────────────────────────────
{
  const dir = tmpDir('reset');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  fs.appendFileSync(st.slotsFile, '{bad', 'utf8');
  const st2 = openFactStore(dir, { normalizer: norm });
  ok(st2.readOnlyReason, '先制造只读态');
  st2.reset();
  ok(st2.readOnlyReason === null && st2.count === 0, 'reset() ⇒ 清空 + **清掉只读原因**');
  const r = st2.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  ok(r.action === 'update', 'reset 后可正常写入');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑨ 无归一化器 ⇒ 拒绝（不退回明文）─────────────────────────────────────
{
  const dir = tmpDir('nonorm');
  const st = openFactStore(dir, { normalizer: null });
  const e = (() => { try { st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: {} }); return null; } catch (x) { return x; } })();
  ok(e instanceof FactStoreError && e.code === 'NO_SCOPE_LABEL',
    '没有 `scopeLabel` ⇒ **抛**（绝不退回明文 chatKey）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑩ 分层戳：derived_from 是**语用层戳**，且随词表/视窗变而变 ─────────────
{
  const dir = tmpDir('stamp');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({
    speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1',
    content: { a: 1 }, vocabVersion: 2, vocabHash: 'vh1', horizon: { start: '2026-01-01', end: '2026-02-01' }
  });
  const rec = st.getSlot({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1' });
  ok(rec.derived_from && String(rec.derived_from.pstamp).startsWith('g'), 'derived_from 带**分层戳**（`g` 前缀）', `(${rec.derived_from.pstamp})`);
  ok(rec.derived_from.params && rec.derived_from.params.vocab_version === 2, 'derived_from 同时存**原始参数**（可溯源）');

  st.put({
    speaker: 'P1', target: 'P3', fact_kind: 'pattern', chatKey: 'group:1',
    content: { a: 1 }, vocabVersion: 2, vocabHash: 'vh2', horizon: { start: '2026-01-01', end: '2026-02-01' }
  });
  const rec2 = st.getSlot({ speaker: 'P1', target: 'P3', fact_kind: 'pattern', chatKey: 'group:1' });
  ok(rec.derived_from.pstamp !== rec2.derived_from.pstamp, '词表内容指纹变 ⇒ **语用层戳变**（read-model 可判过期）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑪ rebuild_required 探针（对面 `0030` 建议 B）：旧版本 read-model 必须可观测 ──
{
  // ⑪a 全部当前版本 ⇒ 不报
  const dir = tmpDir('probe-clean');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 } });
  const rec = st.getSlot({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1' });
  ok(rec.logic_version === String(PRAGMATIC_VERSION), '记录显式落盘 `logic_version`（hash 不可反解 ⇒ 只能写下来）', `= ${rec.logic_version}`);
  ok(st.index.by_logic_version && st.index.by_logic_version[String(PRAGMATIC_VERSION)] === 1, 'index 带 `by_logic_version` 计数');
  ok(st.rebuildRequired === null, '全部当前版本 ⇒ **不报** rebuild_required');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // ⑪b 有旧版本记录 ⇒ 启动时置 rebuildRequired（并喊日志 —— 日志在 open() 里，这里断言状态位）
  const dir = tmpDir('probe-stale');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  st.put({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1', content: { a: 1 }, logicVersion: 1 });   // 旧版本
  st.put({ speaker: 'P3', target: 'P2', fact_kind: 'joke', chatKey: 'group:1', content: { a: 2 } });                       // 当前版本
  ok(!!st.rebuildRequired, '★ 写入旧版本后**状态实时可查**（`recount()` 同步重算；**日志只在 `open()` 喊**，不刷屏）',
    `stale=${JSON.stringify(st.rebuildRequired?.stale)}`);
  // 模拟"版本 bump 之后重启"：新建实例重新 open 同一目录
  const st2 = openFactStore(dir, { normalizer: norm });
  ok(!!st2.rebuildRequired, '★ 旧版本 read-model 非空 ⇒ **rebuild_required**（对面建议 B）',
    `stale=${JSON.stringify(st2.rebuildRequired?.stale)}`);
  ok(st2.rebuildRequired.current === String(PRAGMATIC_VERSION) && st2.rebuildRequired.stale['1'] === 1,
    '探测结果带**当前版本**与**各旧版本计数**（v1×1）');
  ok(st2.verify().rebuildRequired && st2.stats().rebuildRequired, '`verify()` / `stats()` 都暴露该状态（面板可读）');
  st2.reset();
  ok(st2.rebuildRequired === null, 'reset() ⇒ 探针归零（read-model 清空即无过期可言）');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // ⑪c 空库 + 旧版本 ⇒ 不报（零 read-model ⇒ 零重判成本，这正是 ADR-0018 决定 5 的链条）
  const dir = tmpDir('probe-empty');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  ok(st.rebuildRequired === null, '空库 ⇒ 不报（重建集为空）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑫ 装配入口：`openFactStore` 必须**载入既有台账**（`ADR-0023` 回归）──────────
// 回归背景：生产端曾 `new FactStore()` 而**不 `open()`** ⇒ `this.slots` 恒空 ⇒
//   ① `rev` 跨进程归零；② `compareAndUpdate` 的 noop **跨进程失效**（重跑同语料全量重写）；
//   ③ `open()` 里的损坏检测（半截 JSON ⇒ 只读）没机会跑。
// 而本文件过去每处都**手写 `.open()`**，33 条断言全绿却盖不住 ——
// 所以现在测试**也走生产入口**（`openFactStore`）：同一条路径才谈得上覆盖。
{
  const dir = tmpDir('assemble');
  const norm = mkNorm();
  const assemble = () => openFactStore(dir, { normalizer: norm });  // ← 与 backend 的 factStoreOf 同入口
  const slotOf = (v) => ({
    speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1',
    content: { a: v }, evidenceIds: [1, 2, 3]
  });

  const a = assemble();
  ok(a.slots.size === 0, '空目录 ⇒ 装配后无历史槽');
  a.put(slotOf(1));
  ok(linesOf(a) === 1, '写入 1 行');

  // 模拟**进程重启**：新实例，仍走同一入口
  const b = assemble();
  ok(b.count === 1, '★ 装配入口**载入既有台账**（重启后历史槽可见）');
  const r1 = b.put(slotOf(1));
  ok(r1.action === 'noop' && r1.rev === 1, '★ 重启后**同内容 ⇒ noop**（不再全量重写）');
  ok(linesOf(b) === 1, '★ noop **不落新行** ⇒ 台账不膨胀（生产曾"跑一次涨一批"）');
  const r2 = b.put(slotOf(2));
  ok(r2.action === 'update' && r2.rev === 2, '★ `rev` **跨实例续增**（=2，不归零）');
  ok(linesOf(b) === 2, '内容变 ⇒ 追加第 2 行（旧版本留痕）');

  // 反向对撞：证明"**必须**走入口"，而不是"入口恰好没用"
  const raw = new FactStore(dir, { normalizer: norm });
  ok(raw.slots.size === 0, '反向对撞：只 `new` 不 `open` ⇒ **看不到台账**（这正是生产曾犯的错）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑬ 证据集口径同源（评审 F07）：重复证据**不算**多份支持 · [by:DS] 2026-10-28 ──
//
// 改前：指纹按 `Set` 去重、`evidence_n` 按**数组长度** ⇒ 同一条消息重复上报三次
// 就等于"三份独立支持"，能压过真有两份独立证据的版本（`resolveSlotRows` 按
// `evidence_n` 取赢家）⇒ **静默挑错赢家**。这里同时钉住两件事：
//   ① 计数只数独立证据；② 计数与指纹读同一个集合，所以"去重后同一批"必须判 noop。
{
  const dir = tmpDir('evset');
  const norm = mkNorm();
  const st = openFactStore(dir, { normalizer: norm });
  const slot = (evidenceIds) => ({
    speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1',
    content: { a: 1 }, evidenceIds
  });

  st.put(slot(['m1', 'm2', 'm1', 'm1', '', null]));
  const rec = st.getSlot({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1' });
  ok(rec.evidence_n === 2,
    '★ 重复证据只算 1 份（`m1`×3 ⇒ 1）+ 空项不计 ⇒ evidence_n=2',
    `(${rec.evidence_n})`);

  // 顺序不同、重复残留 ⇒ 仍是**同一个集合** ⇒ 指纹相同 ⇒ 必须 noop
  const r2 = st.put(slot(['m2', 'm1', 'm1']));
  ok(r2.action === 'noop', '★ 同一集合（顺序/重复不同）⇒ **noop**（计数与指纹同源）');
  ok(linesOf(st) === 1, 'noop 不落新行 ⇒ 台账不膨胀');

  // 真新增一条独立证据 ⇒ 指纹变 ⇒ 必须判新版本
  const r3 = st.put(slot(['m1', 'm2', 'm3']));
  ok(r3.action === 'update' && r3.rev === 2, '真新增独立证据 ⇒ 指纹变 ⇒ rev+1');
  const rec3 = st.getSlot({ speaker: 'P1', target: 'P2', fact_kind: 'pattern', chatKey: 'group:1' });
  ok(rec3.evidence_n === 3, '独立证据 3 条 ⇒ evidence_n=3');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`事实层存储：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
