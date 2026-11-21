#!/usr/bin/env node
// tools/offline-verify.mjs —— 离线备份的**两阶段验收**（新票 01 / 旧票 16 · [by:DS] 2026-10-29 二次返工）
//
// ══ 上一版为什么"假通过" ═══════════════════════════════════════════════════
// 复审用一份**哈希全对、内容全坏**的副本试它，结果 exit=0、verdict=ok：
//   · `new FactStore()` 没 `open()` ⇒ 活槽恒 0，而 0 被当成"正常空库"；
//   · `readLineage()` 返回的 `{ok:false}` 被当成成功，`Object.keys()` 数出的是
//     `{ok,entries,error}` 三个字段 —— "备注 3 条"其实就是这三个键；
//   · 事件只数非空行；outbox 有坏行仍算过；游标/pending 完全没校验；
//   · 自己拼代目录 `new VecStore()`，绕开 `openActiveVectors` 的完整性保护；
//   · 打开后的任何漂移都放行（连文件消失也不报）。
// 一句话：它证明的是"没有抛异常"，不是"这份副本能恢复"。
//
// ══ 现在的两段（**A 失败不进 B**）══════════════════════════════════════════
// 阶段 A —— 只读校验一个**不可变**备份：
//     manifest 结构 / 版本 / 路径安全（`..`、盘符、绝对、符号链接、realpath 越界）/
//     逐个 sha256 / 未声明文件 / 声明与实际矛盾 / 覆盖声明 / **每类资产的格式**
//     （用 `offline-core.mjs` 的静态校验，**不构造任何 loader** ⇒ 不建目录、不写索引、
//      不回放 journal）。
// 阶段 B —— 复制到**新的演练目录**，按生产布局摆好，再用**真实 loader** 打开：
//     `openFactStore` / `openActiveVectors` / `readLineage` / `readNotes` /
//     `loadConsolidateState` / `readEventRows(strict)` / `readHitLog`，
//     逐项与清单里的 `expect` 对账；再做一次重复打开，要求**幂等**。
//
// ══ 三个判定分开报，且 unknown 不算过 ═════════════════════════════════════
//   `hash_valid`     —— 字节层面：缺/多/不符
//   `schema_valid`   —— 格式层面：坏行、坏 JSON、键拼不回、向量尺寸不符、日志链断裂…
//   `recovery_valid` —— 语义层面：真实 loader 读出来的数与清单描述一致
//   `identity_valid` —— **这是不是那个实例的库**（R2 起为独立必需项）
// 只在 `--stage=a` 或 A 失败时会后者为 `null`（unknown）⇒ **verdict 一律 fail**。
// `identity_valid` 没有 `--expect-source-root` 时也是 `null`：不传目标根 = **未验收**，
// 上一版用 `same !== false` 把"没核对"当成了"没问题"。
//
// ══ 打开副本会**合法地**改动它 ═════════════════════════════════════════════
// 向量库打开时若发现 `put-pending.json`，会按日志回滚未完成的写（生产恢复逻辑）。
// 所以：哈希在**打开之前**核对；打开之后的漂移**逐项分类** ——
// 只有"journal 回放会造成的那几个文件"允许变，其余任何变化/消失都判失败。
// 同理：`policy-baseline.json` **只能读文件**，绝不能调 `loadPolicyBaseline()`
// （它会在文件不存在时写一个出来，等于伪造"新库默认值已钉住"）。
//
// 用法（`--expect-source-root` 从 R2 起是**恢复批准的必要条件**）：
//   node tools/offline-verify.mjs --root=<备份目录> --expect-source-root=<原库根>
//        [--stage=a|b|both] [--drill-dir=<空目录>] [--keep-drill] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MANIFEST_NAME, MANIFEST_VERSION, DECLARABLE, HOST_DECLARABLE,
  scanLibrary, sha256File, listFiles, checkRel, checkInside
} from './offline-core.mjs';
import { openFactStore } from '../src/core/factstore.mjs';
import { openActiveVectors } from '../src/core/vector-generation.mjs';
import { readLineage } from '../src/core/lineage.mjs';
import { readNotes } from '../src/core/notes.mjs';
import { ManualRevisions } from '../src/core/manual-revisions.mjs';
import { SubjectStore } from '../src/core/subjects.mjs';
import { digest } from '../src/core/durable-log.mjs';
import {
  loadConsolidateState, readEventRows, readHitLog, consolidatePaths
} from '../src/core/consolidate.mjs';

const args = process.argv.slice(2);
const opt = (n) => {
  const p = args.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : '';
};
const has = (f) => args.includes(f);
const AS_JSON = has('--json');
const KEEP_DRILL = has('--keep-drill');
const STAGE = (opt('stage') || 'both').toLowerCase();

const ROOT = opt('root');
const EXPECT_SRC = opt('expect-source-root');

function die(msg) {
  console.error(`\n[offline-verify] 拒绝执行：${msg}\n`);
  process.exit(2);
}
if (!ROOT) die('缺少 --root=<备份目录>。本工具**不**提供默认目标（更不会默认指向生产库）。');
if (!path.isAbsolute(ROOT)) die(`--root 必须是绝对路径（收到 ${ROOT}）`);
if (!['a', 'b', 'both'].includes(STAGE)) die(`--stage 只接受 a / b / both（收到 ${STAGE}）`);
if (!fs.existsSync(ROOT)) die(`--root 不存在：${ROOT}`);

const root = fs.realpathSync(ROOT);
const rootReal = root;

const check = (id, ok, detail = '') => ({ id, ok, detail });

// ══════════════════════════════════════════════════════════════════════════
// 阶段 A：只读
// ══════════════════════════════════════════════════════════════════════════
const A = {
  ran: true,
  hash_valid: false,
  schema_valid: false,
  checks: [],
  problems: [],
  files: 0, bytes: 0,
  manifest: null
};

const manifestPath = path.join(root, MANIFEST_NAME);
if (!fs.existsSync(manifestPath)) die(`清单不存在：${manifestPath}（先跑 tools/offline-backup.mjs）`);

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  A.checks.push(check('清单可解析', false, `不是合法 JSON：${e.message}`));
}
if (manifest) {
  A.manifest = {
    path: manifestPath, version: manifest.version, at: manifest.at,
    source: manifest.source, scope: manifest.scope, identity: manifest.identity
  };
  const versionOk = manifest.version === MANIFEST_VERSION;
  A.checks.push(check('清单格式版本', versionOk, versionOk ? `v${manifest.version}` : `未知版本 ${manifest.version}（本工具只认 v${MANIFEST_VERSION}）—— 拒绝"尽力理解"`));
  // `files` 允许为空：**合法空库**（还没写过任何东西）就该是 0 个文件。
  const shapeOk = Array.isArray(manifest.files)
    && manifest.source && typeof manifest.source.libraryRoot === 'string';
  A.checks.push(check('清单必要字段', shapeOk, shapeOk ? `${manifest.files?.length || 0} 个文件条目` : '缺少 files[] / source.libraryRoot'));
  const completeOk = manifest.scope?.complete === true;
  A.checks.push(check('覆盖声明为全量', completeOk,
    completeOk ? '' : `scope.complete=${JSON.stringify(manifest.scope?.complete)} —— 声明不全的副本不得当恢复基准`));

  // ── A1 逐文件：路径安全 + 存在 + 哈希 ──────────────────────────────────
  const hash = { ok: 0, missing: [], mismatch: [], unsafe: [], extra: [], undeclared: [], contradiction: [] };
  const declared = new Set();
  for (const f of manifest.files || []) {
    const rel = String(f.rel || '');
    declared.add(rel);
    // 三层分开判，别混成一个"不安全"：
    //   词法不合法 → unsafe；文件不在 → missing；在但越界/是链接 → unsafe
    const lex = checkRel(rel);
    if (!lex.ok) { hash.unsafe.push({ rel, why: lex.reason }); continue; }
    const abs = path.join(rootReal, rel);
    if (!fs.existsSync(abs)) { hash.missing.push(rel); continue; }
    const inside = checkInside(rootReal, rel);
    if (!inside.ok || inside.bytes === undefined) { hash.unsafe.push({ rel, why: inside.reason || '不可读' }); continue; }
    const got = sha256File(inside.abs);
    if (got !== f.sha256) hash.mismatch.push({ rel, want: f.sha256, got });
    else hash.ok += 1;
    A.files += 1;
    A.bytes += inside.bytes;
  }
  // ── A2 未声明文件 / 符号链接 ────────────────────────────────────────────
  // 多一份 `vector-active.json.bak` 看着无害，实际会让"当前代是谁"变成靠文件名排序决定。
  //
  // ⚠️ 这一段必须**排在"路径安全"判定之前**：目录里的 junction 不在清单里，
  //    只会在遍历时被发现。上一版的顺序是先 push「路径安全 ✓」再遍历补 `hash.unsafe`，
  //    于是报告里出现「路径安全 ✓ / 其余全 ✓」而 `hash_valid = false` —— 自相矛盾的报告
  //    比没有报告更坏（操作者会去翻别的判据）。`listFiles` 不跟进符号链接，所以遍历本身安全。
  const walked = listFiles(rootReal);
  for (const s of walked.symlinks) hash.unsafe.push({ rel: s, why: '是符号链接（可能指向根外）' });
  for (const f of walked.files) {
    if (f.rel === MANIFEST_NAME) continue;
    if (!declared.has(f.rel)) hash.extra.push(f.rel);
  }

  A.checks.push(check('路径安全', hash.unsafe.length === 0,
    hash.unsafe.map((u) => `${u.rel}（${u.why}）`).join('; ')));
  A.checks.push(check('文件齐备', hash.missing.length === 0, hash.missing.join(', ')));
  A.checks.push(check('哈希一致', hash.mismatch.length === 0,
    hash.mismatch.map((m) => `${m.rel}（清单 ${String(m.want).slice(0, 12)}… / 实际 ${m.got.slice(0, 12)}…）`).join('; ')));
  A.checks.push(check('无未声明文件', hash.extra.length === 0,
    hash.extra.length ? `${hash.extra.join(', ')} —— 备份后新增的文件必须重做清单` : ''));

  // ── A3 声明与实际不能互相矛盾 ──────────────────────────────────────────
  for (const a of manifest.absent || []) {
    const rel = String(a.rel || '');
    const lex = checkRel(rel);
    if (declared.has(rel)) hash.contradiction.push(`${rel}（既声明 absent 又列在 files）`);
    else if (lex.ok && fs.existsSync(path.join(rootReal, rel))) hash.contradiction.push(`${rel}（声明 absent 但文件在）`);
  }
  A.checks.push(check('声明一致', hash.contradiction.length === 0, hash.contradiction.join('; ')));

  // ── A4 覆盖：已知资产必须"要么在清单里、要么显式声明没有" ────────────────
  // 名单来自 `offline-core` 的声明表（备份侧用**同一张表**），不再各写一份。
  const absentSet = new Set((manifest.absent || []).map((a) => a.rel));
  const mustDeclare = [...DECLARABLE, ...HOST_DECLARABLE];
  const undeclared = mustDeclare.filter((rel) => !declared.has(rel) && !absentSet.has(rel));
  A.checks.push(check('资产声明完整', undeclared.length === 0,
    undeclared.length ? `${undeclared.join(', ')} —— 既不在 files 也没声明 absent（"缺"必须是声明，不能靠不在）` : ''));

  // ── A5 格式校验（静态，不构造 loader）──────────────────────────────────
  const scan = scanLibrary(rootReal);
  A.problems = scan.problems;
  A.unvalidated = scan.unvalidated;
  // 备份根里沿革/备注在 `_host/`：`scanLibrary` 已按候选列表取，这里只做"数值是否被篡改"的对账
  const expectMismatch = [];
  if (manifest.expect) {
    const cmp = (label, got, want) => {
      if (want === undefined || want === null) return;
      if (JSON.stringify(got) !== JSON.stringify(want)) expectMismatch.push(`${label}：清单 ${JSON.stringify(want)} / 实际 ${JSON.stringify(got)}`);
    };
    cmp('facts.lines', scan.expect.facts?.lines ?? null, manifest.expect.facts?.lines ?? null);
    cmp('facts.keys', scan.expect.facts?.keys ?? null, manifest.expect.facts?.keys ?? null);
    cmp('facts.receipts', scan.expect.facts?.receipts ?? null, manifest.expect.facts?.receipts ?? null);
    cmp('facts.provRows', scan.expect.facts?.provRows ?? 0, manifest.expect.facts?.provRows ?? 0);
    cmp('facts.itemRefKeys', scan.expect.facts?.itemRefKeys ?? 0, manifest.expect.facts?.itemRefKeys ?? 0);
    cmp('vectors.dim', scan.expect.vectors?.dim ?? null, manifest.expect.vectors?.dim ?? null);
    cmp('vectors.slots', scan.expect.vectors?.slots ?? null, manifest.expect.vectors?.slots ?? null);
    cmp('vectors.alive', scan.expect.vectors?.alive ?? null, manifest.expect.vectors?.alive ?? null);
    // R2：新增资产的行数/最终状态数必须与清单一致 —— 否则"清单说 3 条隐藏、实际 1 条"
    // 会在 B 阶段被当成"恢复后数据不一样"，而没人知道是清单旧了还是文件被换了。
    for (const k of ['rows', 'items', 'replace', 'hide', 'restore']) {
      cmp(`manual.${k}`, scan.expect.manual?.[k] ?? null, manifest.expect.manual?.[k] ?? null);
    }
    for (const k of ['rows', 'subjects', 'active', 'merged', 'observations', 'merges', 'unmerges', 'aliases']) {
      cmp(`subjects.${k}`, scan.expect.subjects?.[k] ?? null, manifest.expect.subjects?.[k] ?? null);
    }
    cmp('policy.profilePolicy', scan.expect.policy?.profilePolicy ?? null, manifest.expect.policy?.profilePolicy ?? null);
    for (const k of ['pendingWindows', 'observationRequests', 'windowsWithRequests']) {
      cmp(`consolidate.${k}`, scan.expect.consolidate?.[k] ?? null, manifest.expect.consolidate?.[k] ?? null);
    }
  }
  A.checks.push(check('清单期望与实际内容一致', expectMismatch.length === 0, expectMismatch.join('; ')));

  A.schema_valid = scan.problems.length === 0;
  A.checks.push(check('格式校验', A.schema_valid,
    scan.problems.length ? `${scan.problems.length} 条，前几条：` + scan.problems.slice(0, 6).map((p) => `${p.rel}[${p.code}] ${p.message}`).join(' | ') : ''));

  // ── A5b 未做语义校验的资产：**只能原样携带，不许被说成已验证** ──────────
  // 清单里的名单是备份当时的声明；现在重扫一遍，两边必须一致。
  // 少报 = 有人删了声明（等于声称"这些也验证过了"）；多报 = 备份后新增（哈希那关也会红）。
  const declaredUnvalidated = new Set((manifest.unvalidatedAssets || []).map((u) => u.rel));
  const actualUnvalidated = new Set(scan.unvalidated.map((u) => u.rel));
  const unvDiff = [
    ...[...actualUnvalidated].filter((r) => !declaredUnvalidated.has(r)).map((r) => `${r}（实际未校验，清单没说）`),
    ...[...declaredUnvalidated].filter((r) => !actualUnvalidated.has(r)).map((r) => `${r}（清单声明未校验，实际已校验或不存在）`)
  ];
  A.checks.push(check('未校验资产声明一致', unvDiff.length === 0, unvDiff.join('; ')));

  // ── A6 实例对账（**独立必需判定**）─────────────────────────────────────
  // 上一版的写法是 `same !== false`：**没传 --expect-source-root 时 same=null，检查照样通过**。
  // 于是"给哪份备份都能拿到 ok"，而生产恢复最要紧的那件事（这是不是那个实例的库）
  // 恰好是唯一没被判的东西。现在：不传 ⇒ `identity_valid = null` ⇒ 整体**不算通过**。
  const claim = String(manifest.identity?.libraryRoot || manifest.source?.libraryRoot || '');
  let same = null;
  let detail = '';
  if (!claim) {
    detail = '清单里没有 identity.libraryRoot（无法判断这份副本属于哪个实例）';
  } else if (EXPECT_SRC) {
    const want = path.resolve(EXPECT_SRC);
    const wantReal = fs.existsSync(want) ? fs.realpathSync(want) : want;
    same = wantReal === path.resolve(claim);
    detail = same ? `自述来源 ${claim}`
      : `清单自述来自 ${claim}，但期望恢复 ${wantReal} —— 跨实例误配，停止`;
  } else {
    detail = `未提供 --expect-source-root ⇒ **未验收**（清单自述 ${claim}，但不做对账；未知不得记为通过）`;
  }
  A.checks.push(check('实例对应', same === true, detail));
  A.identity = { expect: EXPECT_SRC ? path.resolve(EXPECT_SRC) : null, manifest: claim || null, same };
  // **三态**：true（确认是它）/ false（确认不是它）/ null（没核对 = 未验收）。
  // 把 null 折成 false 会让报告写"跨实例误配"——那是另一个意思，会把人引向错误的排查方向。
  A.identity_valid = same === null ? null : same;
  // 目标根必须显式给出：本工具**不**从清单里猜"那就按它自己说的恢复吧"。
  A.checks.push(check('目标实例已指定', Boolean(EXPECT_SRC),
    EXPECT_SRC ? '' : '恢复批准必须明确核对目标实例：补 --expect-source-root=<原库根>'));

  A.hash_valid = hash.unsafe.length === 0 && hash.missing.length === 0 && hash.mismatch.length === 0
    && hash.extra.length === 0 && hash.contradiction.length === 0 && versionOk;
  A.hash = hash;
  A.expect = manifest.expect || null;
  A.filesList = manifest.files || [];
  A.absent = manifest.absent || [];
}

// 实例判定**单独成派**：它既不该被"格式全绿"掩盖，也不该被算进 hash/schema。
// 三个判定之外再加一个必需项 —— 少一项就等于"任意一份备份都能拿到 ok"。
const IDENTITY_CHECKS = new Set(['实例对应', '目标实例已指定']);
const aHardOk = A.checks.filter((c) => !IDENTITY_CHECKS.has(c.id)).every((c) => c.ok);
const identityOk = A.identity_valid === true;
if (manifest) {
  A.hash_valid = A.hash_valid && A.checks.filter((c) => ['路径安全', '文件齐备', '哈希一致', '无未声明文件', '声明一致', '清单格式版本'].includes(c.id)).every((c) => c.ok);
  A.schema_valid = A.schema_valid && A.checks.filter((c) => ['格式校验', '清单期望与实际内容一致', '资产声明完整', '覆盖声明为全量', '未校验资产声明一致'].includes(c.id)).every((c) => c.ok);
}

// ══════════════════════════════════════════════════════════════════════════
// 阶段 B：复制到演练目录，用真实 loader 打开
// ══════════════════════════════════════════════════════════════════════════
const B = { ran: false, recovery_valid: null, checks: [], diffs: [], drift: null, drill: null, actual: null, idempotent: null };

/** 备份布局 → **生产布局**。这一步必须显式，否则"恢复出来的目录"跟线上长不一样，loader 会读空。 */
function planRestore(files) {
  const map = [];
  for (const f of files) {
    const rel = String(f.rel);
    let to;
    if (rel.startsWith('_host/')) to = rel.slice('_host/'.length);
    else if (rel === '_config/host-config.json') to = 'config.json';
    else if (rel === '_config/instances.json') to = 'instances.json';
    else if (rel.startsWith('_config/')) to = rel.slice('_config/'.length);
    else to = `memory-vec/${rel}`;
    map.push({ from: rel, to });
  }
  return map;
}

function dirSnapshot(dir) {
  const inv = listFiles(dir);
  const m = new Map();
  for (const f of inv.files) m.set(f.rel, f.sha256);
  return m;
}

function diffSnapshots(before, after, { journalBefore }) {
  const changed = [];
  const removed = [];
  const added = [];
  for (const [rel, sha] of before) {
    if (!after.has(rel)) removed.push(rel);
    else if (after.get(rel) !== sha) changed.push(rel);
  }
  for (const rel of after.keys()) if (!before.has(rel)) added.push(rel);

  // 允许的变化只有"journal 回放"这一种，而且**必须**真的有过 journal。
  const replayable = (rel) => /^memory-vec\/(put-pending\.json|index\.json|meta\.jsonl|vectors\.bin)$/.test(rel)
    || /^memory-vec\/vector-generations\/[a-f0-9]{32}\/(put-pending\.json|index\.json|meta\.jsonl|vectors\.bin)$/.test(rel);
  const allowedChanged = journalBefore ? changed.filter(replayable) : [];
  const unexpectedChanged = changed.filter((r) => !allowedChanged.includes(r));
  const allowedRemoved = journalBefore ? removed.filter((r) => replayable(r)) : [];
  const unexpectedRemoved = removed.filter((r) => !allowedRemoved.includes(r));

  return {
    allowed: { changed: allowedChanged, removed: allowedRemoved },
    unexpected: { changed: unexpectedChanged, removed: unexpectedRemoved, added },
    journalBefore: Boolean(journalBefore)
  };
}

const eq = (id, actual, expected, note = '') => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  B.checks.push(check(id, ok, ok ? '' : `${note}期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`));
  if (!ok) B.diffs.push({ id, expected, actual, note });
  return ok;
};

function openAll(drillDir, openOpts = {}) {
  const libDir = path.join(drillDir, 'memory-vec');
  const dataDir = drillDir;
  const out = { libDir, dataDir, facts: null, vectors: null, lineage: null, notes: null, consolidate: null, errors: {} };
  const guard = (key, fn) => {
    try { return fn(); } catch (e) { out.errors[key] = String(e?.message || e); return null; }
  };

  // 事实：**必须真的 open**（上一版就是少这一步，活槽恒 0 还报 ok）
  const factsStore = guard('facts', () => openFactStore(path.join(libDir, 'facts')));
  if (factsStore) {
    const rows = [...factsStore.versions.values()].reduce((a, b) => a + b.length, 0);
    out.facts = {
      readOnlyReason: String(factsStore.readOnlyReason || ''),
      slots: factsStore.slots.size,
      keys: factsStore.versions.size,
      rows,
      receipts: [...factsStore.versions.values()].reduce((a, b) => a + b.filter((r) => r?.delivery?.id).length, 0),
      // 来源引用是否**活着到了恢复后**（不是只核行数）
      provRows: [...factsStore.slots.values()].filter((r) => Array.isArray(r?.provenance) && r.provenance.length).length,
      itemRefKeys: [...factsStore.slots.values()].reduce((a, r) => a + Object.keys(r?.itemProvenance || {}).length, 0),
      merged: factsStore.mergedStats(),
      verify: factsStore.verify()
    };
  }

  // 人工修订：用**真实类**打开（`DurableLog` 在构造期只读不写）。
  // 事实参数是真正的 `openFactStore`；身份版本用只读沿革摘要 —— 与 `memory-core.mjs` 一致。
  out.manual = guard('manual', () => {
    if (!factsStore) throw new Error('事实库不可打开 ⇒ 人工修订无法投影（它按事实项定位）');
    const revs = new ManualRevisions(libDir, factsStore, {
      identityVersion: () => {
        const lin = readLineage(dataDir);
        if (!lin.ok) throw new Error(`沿革不可读：${lin.error || 'unknown'}`);
        return digest(lin.entries || {});
      }
    });
    const state = revs.state();          // 真实类自己的重放结果（不是我们另算一遍）
    const byOp = { replace: 0, hide: 0, restore: 0 };
    const finalOps = [];
    for (const d of state.values()) {
      byOp[d.op] += 1;
      // 逐个核"重放后这条改动的**语义**有没有生效"：隐藏真的隐藏、替换真的换值、
      // 恢复真的回机器值；并且投影必须绑在**这一行**日志上（operationId/revision 对得上）。
      const rec = factsStore.get(d.key);
      if (!rec) {
        finalOps.push({ key: d.key, itemKey: d.itemKey, op: d.op, missingRecord: true,
          loggedOperationId: d.operationId, loggedRevision: d.revision });
        continue;
      }
      const item = revs.item(rec, d.itemKey, state);
      finalOps.push({
        key: d.key, itemKey: d.itemKey, op: d.op,
        hidden: Boolean(item?.hidden), origin: item?.origin ?? null,
        value: item && item.value !== undefined ? item.value : null,
        loggedValue: d.op === 'replace' ? d.value : null,
        manualRevision: item?.manualRevision ?? 0, operationId: item?.operationId ?? null,
        loggedOperationId: d.operationId, loggedRevision: d.revision
      });
    }
    return {
      readOnlyReason: String(revs.log.readOnlyReason || ''),
      rows: revs.log.rows.length,
      revisions: state.size,
      byOp, finalOps
    };
  });

  // 主体：`new SubjectStore` 用于**隔离打开/恢复校验**（运行时单例在 `openSubjectStore`）。
  out.subjects = guard('subjects', () => {
    const store = new SubjectStore(libDir);
    const snap = store.snapshot();       // 重放后的主体/观察快照
    const subjects = [...snap.subjects.values()];
    let merges = 0;
    let unmerges = 0;
    for (const s of subjects) if (s.status === 'merged') merges += 1;
    // 引用关系：每个合并 id 必须解析到一个**活着**的主体；每条观察必须能找回主人。
    const resolved = new Map();
    for (const s of subjects) {
      if (s.status !== 'merged') continue;
      const target = store.canonical(s.id, snap);   // 断链/成环会在这里抛
      if (target.status !== 'active') throw new Error(`合并目标 ${s.mergedInto} 不是活主体（链未收敛）`);
      resolved.set(s.id, target.id);
    }
    for (const o of snap.observations.values()) {
      const owner = store.canonical(o.subjectId, snap);
      if (!owner || !owner.id) throw new Error(`观察 ${o.id} 的主人 ${o.subjectId} 解析不到`);
    }
    const mergedGroups = new Map();
    for (const [from, to] of resolved) mergedGroups.set(to, (mergedGroups.get(to) || 0) + 1);
    return {
      readOnlyReason: String(store.log.readOnlyReason || ''),
      rows: store.log.rows.length,
      subjects: subjects.length,
      active: subjects.filter((s) => s.status === 'active').length,
      merged: merges,
      // 不是"合并了几次"，而是"当前有多少条合并仍生效"。撤销过的不能算进 merged。
      observations: snap.observations.size,
      aliases: subjects.reduce((a, s) => a + (Array.isArray(s.aliases) ? s.aliases.length : 0), 0),
      resolved: Object.fromEntries(resolved),
      mergedGroups: Object.fromEntries(mergedGroups)
    };
  });

  // 可见性基线：**只读原文件**。绝不能调 `loadPolicyBaseline()` ——
  // 那个函数在文件不存在时会 `mkdirSync` 并写盘，等于把"没有基线"变成"有基线"。
  out.policy = guard('policy', () => {
    const f = path.join(libDir, 'policy-baseline.json');
    if (!fs.existsSync(f)) return { absent: true };
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { absent: false, version: raw.version, profilePolicy: raw.profilePolicy };
  });

  // 向量：走**活动代解析**（会被拒绝的情况：指针非法、代不存在、代不完整）
  // ⚠️ 清单声明"没有向量"时**不打开**：`new VecStore()` 会 `ensureDir` ⇒ 一个空代被静默造出来，
  //    然后"0 条"看起来像健康。这一条就是复审点名的"禁止静默创建空向量代后宣布健康"。
  if (openOpts.vectors === false) { out.vectors = null; } else out.vectors = guard('vectors', () => {
    const store = openActiveVectors(libDir);
    return {
      count: store.count,
      dim: store.dim,
      model: store.index?.model ?? null,
      encoding: store.index?.encoding ?? null,
      readOnlyReason: String(store.readOnlyReason || ''),
      slots: store.index?.slots ?? null
    };
  });

  out.lineage = guard('lineage', () => readLineage(dataDir));      // ← 宿主数据根，不是库根
  out.notes = guard('notes', () => readNotes(dataDir));
  out.consolidate = guard('consolidate', () => ({
    state: loadConsolidateState({ libDir }),
    events: readEventRows({ libDir, strict: true }),
    hits: readHitLog({ libDir })
  }));
  out.outbox = guard('outbox', () => {
    const f = path.join(dataDir, 'memory-vec-outbox.jsonl');
    if (!fs.existsSync(f)) return { absent: true, lines: 0, bad: 0 };
    const lines = fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    let bad = 0;
    for (const l of lines) { try { const o = JSON.parse(l); if (!o || typeof o.id !== 'string') bad += 1; } catch { bad += 1; } }
    return { absent: false, lines: lines.length, bad };
  });
  out.checkpoint = guard('checkpoint', () => {
    const f = path.join(dataDir, 'memory-vec-checkpoint-state.json');
    if (!fs.existsSync(f)) return { absent: true, chats: 0 };
    return { absent: false, chats: Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))).length };
  });
  return out;
}

async function stageB() {
  B.ran = true;
  const map = planRestore(A.filesList);

  // 演练目录：必须显式、必须空、必须在备份之外
  let drill = opt('drill-dir') ? path.resolve(opt('drill-dir')) : '';
  if (drill) {
    if (drill === root) die('--drill-dir 不能等于 --root');
    const relRoot = path.relative(root, drill);
    if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) die('--drill-dir 在备份目录内部（会污染不可变输入）');
    if (fs.existsSync(drill) && fs.readdirSync(drill).length) die(`--drill-dir 必须为空：${drill}`);
    fs.mkdirSync(drill, { recursive: true });
  } else {
    drill = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-recovery-'));
    if (!path.resolve(drill).startsWith(path.resolve(os.tmpdir()))) die(`临时演练目录不在 tmpdir：${drill}`);
  }
  B.drill = drill;

  // 按**生产布局**摆放（不是照抄备份的扁平结构）
  for (const m of map) {
    const src = path.join(rootReal, m.from);
    const dst = path.join(drill, m.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  B.checks.push(check('复制到演练目录', true, `${map.length} 个文件 → ${drill}`));

  const journalBefore = fs.existsSync(path.join(drill, 'memory-vec', 'put-pending.json'))
    || (fs.existsSync(path.join(drill, 'memory-vec', 'vector-generations'))
      && fs.readdirSync(path.join(drill, 'memory-vec', 'vector-generations'))
        .some((g) => fs.existsSync(path.join(drill, 'memory-vec', 'vector-generations', g, 'put-pending.json'))));

  const exp = A.expect || {};
  const expVec0 = exp.vectors || null;
  const wantVectors = !(expVec0 && expVec0.layout === 'none');

  const before = dirSnapshot(drill);
  const first = openAll(drill, { vectors: wantVectors });
  const afterFirst = dirSnapshot(drill);
  B.drift = diffSnapshots(before, afterFirst, { journalBefore });
  B.actual = first;

  const f = first.facts;
  if (!f) {
    B.checks.push(check('事实库可打开', false, first.errors.facts || '未知错误'));
  } else {
    eq('事实:只读原因为空', f.readOnlyReason, '', 'loader 处于只读 ⇒ 这份副本读不动，不能当可恢复');
    eq('事实:verify 通过', f.verify?.ok === true, true, `problems=${JSON.stringify((f.verify?.problems || []).slice(0, 3))} `);
    if (exp.facts) {
      eq('事实:版本总数', f.rows, exp.facts.lines, '「打开少了几行」= 静默丢记录');
      eq('事实:键数', f.keys, exp.facts.keys);
      eq('事实:活槽+被合并', f.slots + (f.merged?.applied || 0), exp.facts.keys, '活槽数必须能被"键数 − 被合并"解释');
      eq('事实:投递收据', f.receipts, exp.facts.receipts);
      // R2：来源引用必须**活着到恢复后**。备份里拷了、loader 打开后没了 = 证据链断。
      if (exp.facts.provRows !== undefined) eq('事实:带来源的槽数', f.provRows, exp.facts.provRows, '引用没被保留 ⇒ 证据查不到');
      if (exp.facts.itemRefKeys !== undefined) eq('事实:条目级来源数', f.itemRefKeys, exp.facts.itemRefKeys);
      // `index.json` 是**派生量**（`factstore.verify()` 自己就说"陈旧可从 jsonl 重建，不算损坏"）
      // ⇒ 这里只报告，不判失败。但它必须能在报告里被看见，否则"索引是旧的"永远查不出来。
      B.checks.push(check('事实:派生索引状态', true,
        f.verify?.indexStale
          ? `index.count=${f.verify?.indexCount} 与实际活槽 ${f.slots} 不一致 —— 陈旧（可重建，不算损坏）`
          : `index.count=${f.verify?.indexCount} 与实际一致`));
    }
    B.checks.push(check('事实:证据样本可读', (f.slots === 0) || (f.rows > 0), (f.slots === 0) ? '空库（合法）' : `${f.rows} 个版本行`));
  }

  // 向量
  const v = first.vectors;
  const expVec = expVec0;
  if (expVec && expVec.layout === 'none') {
    eq('向量:声明为无', fs.existsSync(path.join(drill, 'memory-vec', 'index.json')), false, '清单说没有向量，实际却有 index.json');
    eq('向量:不构造空代', v, null, '清单声明无向量时**不得**打开生成器（否则会静默造一个空代）');
  } else if (expVec && expVec.layout === 'broken') {
    B.checks.push(check('向量:源本身坏了', false, '清单里 layout=broken ⇒ 这份备份不能当恢复基准'));
  } else if (expVec) {
    if (!v) {
      B.checks.push(check('向量:活动代可打开', false, first.errors.vectors || '未知错误'));
    } else {
      eq('向量:只读原因为空', v.readOnlyReason, '', '向量库只读 ⇒ 索引不可用');
      eq('向量:条数', v.count, expVec.alive);
      eq('向量:维度', v.dim, expVec.dim);
      eq('向量:模型', v.model, expVec.model);
      eq('向量:编码身份', v.encoding ?? null, expVec.encoding ?? null, '编码身份不符 = 检索会静默降级');
      eq('向量:slots', v.slots, expVec.slots);
      // journal 存在时，"回滚是否真的发生了"只能这样看：回放后的状态必须**落在**
      // journal 记录的旧 index 上。对不上 = 回放被跳过，半提交被当成正常。
      if (expVec.journal) {
        eq('向量:回放落到 journal 记录的状态',
          [v.slots, v.count], [expVec.journal.index.slots, expVec.journal.index.alive],
          'journal 没被回放 ⇒ 半提交状态被当成正常');
      }
    }
  }

  // 沿革 / 备注：**看 ok 字段**，不是数对象键（上一版就栽在这里）
  const lin = first.lineage;
  if (!lin) B.checks.push(check('沿革可读', false, first.errors.lineage || '未知错误'));
  else {
    eq('沿革:readLineage.ok', lin.ok === true, true, `error=${lin.error || ''} `);
    if (exp.lineage) eq('沿革:条数', Object.keys(lin.entries || {}).length, exp.lineage.entries);
  }
  const nt = first.notes;
  if (!nt) B.checks.push(check('备注可读', false, first.errors.notes || '未知错误'));
  else {
    eq('备注:readNotes.ok', nt.ok === true, true, `error=${nt.error || ''} `);
    if (exp.notes) eq('备注:条数', Object.keys(nt.notes || {}).length, exp.notes.count);
  }

  // ── 人工修订（R2）──────────────────────────────────────────────────────
  const man = first.manual;
  if (!man) {
    B.checks.push(check('人工修订可读', false, first.errors.manual || '未知错误'));
  } else {
    eq('人工修订:日志只读原因为空', man.readOnlyReason, '', '链断/坏行 ⇒ 整份只读；这时恢复出的"隐藏项"会全部复活');
    if (exp.manual) {
      eq('人工修订:行数', man.rows, exp.manual.rows, '少一行 = 一次人工修改丢了');
      eq('人工修订:生效条目数', man.revisions, exp.manual.items);
      // 「最终生效」的三态：同一条被改多次时只看最后一条 —— 这正是重放的意义。
      eq('人工修订:最终 op 分布', man.byOp, {
        replace: exp.manual.replace, hide: exp.manual.hide, restore: exp.manual.restore
      }, '分布不对 = 重放顺序错或某条被丢弃');
    }
    // 逐条核语义（只比计数会让"三条都 hide、值却还在"过关）
    const semantic = [];
    for (const f2 of man.finalOps) {
      if (f2.missingRecord) { semantic.push({ key: f2.key, itemKey: f2.itemKey, ok: true, note: '事实槽已不存在（合并/删除），跳过' }); continue; }
      const expectHidden = f2.op === 'hide';
      const expectOrigin = f2.op === 'replace' ? 'manual' : f2.op === 'hide' ? 'manual' : 'machine';
      const ok = f2.hidden === expectHidden && f2.origin === expectOrigin
        && f2.operationId === f2.loggedOperationId && f2.manualRevision === f2.loggedRevision
        && (f2.op !== 'replace' || f2.value === f2.loggedValue);
      semantic.push({ key: f2.key, itemKey: f2.itemKey, op: f2.op, ok, hidden: f2.hidden, origin: f2.origin });
    }
    const badSem = semantic.filter((s) => !s.ok);
    B.checks.push(check('人工修订:重放后的隐藏/替换/恢复语义正确', badSem.length === 0,
      badSem.length ? `${badSem.length} 条不对：${JSON.stringify(badSem.slice(0, 3))}` : `${semantic.length} 条逐条核过`));
  }

  // ── 主体（R2）──────────────────────────────────────────────────────────
  const sub = first.subjects;
  if (!sub) {
    B.checks.push(check('主体库可读', false, first.errors.subjects || '未知错误'));
  } else {
    eq('主体:日志只读原因为空', sub.readOnlyReason, '', '主体日志只读 ⇒ 合并关系与观察全部不可用');
    if (exp.subjects) {
      eq('主体:行数', sub.rows, exp.subjects.rows);
      eq('主体:主体数', sub.subjects, exp.subjects.subjects);
      eq('主体:活/合并', [sub.active, sub.merged], [exp.subjects.active, exp.subjects.merged], '「合并」按当前仍生效的算，不是合并次数');
      eq('主体:观察数', sub.observations, exp.subjects.observations, '少一条 = 一条印象丢了主人');
      eq('主体:别名数', sub.aliases, exp.subjects.aliases);
    }
    // 引用关系：合并 id 必须解析到活主体、观察必须找回主人（在 openAll 里做，抛错即失败）
    eq('主体:合并全部可解析', Object.keys(sub.resolved || {}).length, sub.merged, '有合并却解析不出来 = 链断了/成环');
  }

  // ── 可见性基线（R2）────────────────────────────────────────────────────
  const pol = first.policy;
  if (!pol) {
    B.checks.push(check('可见性基线可读', false, first.errors.policy || '未知错误'));
  } else if (!exp.policy) {
    eq('可见性基线:不应存在', pol.absent, true, '清单说没有基线，恢复后却出现了（= 被谁写出来的）');
  } else {
    eq('可见性基线:内容', [pol.absent, pol.version, pol.profilePolicy],
      [false, exp.policy.version, exp.policy.profilePolicy], '新库默认策略被改了 ⇒ 重启后可见性静默变化');
  }

  // 整理管线
  const c = first.consolidate;
  if (!c) {
    B.checks.push(check('整理管线可读', false, first.errors.consolidate || '未知错误'));
  } else {
    if (exp.consolidate) {
      eq('整理:会话游标数', Object.keys(c.state?.chats || {}).length, exp.consolidate.chats);
      eq('整理:事件行数', c.events?.rows?.length ?? 0, exp.consolidate.events, 'strict 模式下坏行会直接抛，这里再核条数');
      eq('整理:事件坏行', c.events?.badLines ?? 0, 0);
      eq('整理:排练日志行数', c.hits?.lines ?? 0, exp.consolidate.hits);
      eq('整理:排练坏行', c.hits?.badLines ?? 0, 0);
    }
    // pending-windows 的严格校验在阶段 A 做过；这里确认 loader 视角能读
    const p = consolidatePaths(path.join(drill, 'memory-vec'));
    const pendingFile = path.join(p.base, 'pending-windows.json');
    if (fs.existsSync(pendingFile)) {
      const ok = (() => { try { const o = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o); } catch { return false; } })();
      B.checks.push(check('整理:待补窗口可解析', ok, ok ? '' : 'pending-windows.json 不是合法对象'));
      if (exp.consolidate) eq('整理:待补窗口数', Object.keys(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).length, exp.consolidate.pendingWindows);
    }
  }

  // 宿主侧
  if (first.outbox) {
    eq('宿主:outbox 坏行', first.outbox.bad, 0, '带着残行的副本不算可恢复（生产插件会跳过坏行）');
    if (exp.host?.outbox) eq('宿主:outbox 行数', first.outbox.lines, exp.host.outbox.lines);
  }

  // 漂移
  if (B.drift) {
    B.checks.push(check('打开后变化已分类', true,
      B.drift.journalBefore
        ? `journal 回放：改了 ${B.drift.allowed.changed.length} 个 / 删了 ${B.drift.allowed.removed.length} 个（允许）`
        : '无 journal，任何变化都不允许'));
    eq('打开后无未预期变化', B.drift.unexpected.changed, [], '除了 journal 回放涉及的向量文件，谁都不许变');
    eq('打开后无文件消失', B.drift.unexpected.removed, []);
    eq('打开后无文件新增', B.drift.unexpected.added, []);
  }

  // 幂等：第二次打开读数必须一样，且不再有变化
  const before2 = dirSnapshot(drill);
  const second = openAll(drill, { vectors: wantVectors });
  const after2 = dirSnapshot(drill);
  const drift2 = diffSnapshots(before2, after2, { journalBefore: fs.existsSync(path.join(drill, 'memory-vec', 'put-pending.json')) });
  const sameFacts = JSON.stringify({ s: second.facts?.slots, k: second.facts?.keys, r: second.facts?.rows })
    === JSON.stringify({ s: first.facts?.slots, k: first.facts?.keys, r: first.facts?.rows });
  const sameVec = JSON.stringify({ c: second.vectors?.count, d: second.vectors?.dim }) === JSON.stringify({ c: first.vectors?.count, d: first.vectors?.dim });
  B.idempotent = { countsStable: sameFacts && sameVec, driftOnReopen: drift2.unexpected };
  eq('重复打开:读数不变', sameFacts && sameVec, true, '第二次打开读数漂了 ⇒ 恢复不幂等，重建后会越开越少');
  eq('重复打开:无额外变化', drift2.unexpected.changed.concat(drift2.unexpected.removed, drift2.unexpected.added), []);

  B.recovery_valid = B.checks.every((c) => c.ok);

  if (!KEEP_DRILL) {
    // 只清自己造出来的临时目录；显式 --drill-dir 的默认也清（它被声明为"演练用"），除非 --keep-drill
    try { fs.rmSync(drill, { recursive: true, force: true }); } catch { /* 留给人工 */ }
  }
}

// ── 跑 ────────────────────────────────────────────────────────────────────
if (STAGE === 'b' && !manifest) die('--stage=b 需要可解析的清单（A 的产物）');
if (STAGE !== 'a' && aHardOk && identityOk) {
  try { await stageB(); } catch (e) {
    B.checks.push(check('阶段 B 未完成', false, String(e?.stack || e).slice(0, 400)));
    B.recovery_valid = false;
  }
} else if (STAGE !== 'a' && aHardOk && !identityOk) {
  // 实例没确认就打开 loader = 在**不知道这是谁的库**的前提下造恢复现场。
  // 这一步不是"跳过检查"，而是"根本不该开始"：所以 recovery 留 unknown（不是 true）。
  B.checks.push(check('阶段 B 未执行', true,
    '实例未确认（未传 --expect-source-root 或跨实例误配）⇒ 不复制、不打开任何 loader'));
} else if (STAGE !== 'a') {
  B.checks.push(check('阶段 B 未执行', false, '阶段 A 未通过 ⇒ 不打开任何 loader（避免"先污染再判定"）'));
}

// ══ 输入不变性：无论如何都不许改动备份 ═════════════════════════════════════
let inputsUnchanged = true;
const inputChanged = [];
if (manifest && Array.isArray(manifest.files)) {
  for (const f of manifest.files) {
    const inside = checkInside(rootReal, String(f.rel || ''));
    if (!inside.ok || inside.bytes === undefined) { inputsUnchanged = false; inputChanged.push(`${f.rel}（消失或越界）`); continue; }
    if (sha256File(inside.abs) !== f.sha256) { inputsUnchanged = false; inputChanged.push(f.rel); }
  }
}

const required = {
  hash_valid: A.hash_valid,
  schema_valid: A.schema_valid,
  recovery_valid: B.recovery_valid,
  // 第四个必需项。上一版没有它 ⇒ "任意一份备份 + 不传目标根"都能拿到 ok。
  identity_valid: A.identity_valid
};
const unknown = Object.entries(required).filter(([, v]) => v === null).map(([k]) => k);
const verdict = (required.hash_valid && required.schema_valid && required.recovery_valid
  && required.identity_valid && inputsUnchanged) ? 'ok' : 'fail';

const out = {
  tool: 'offline-verify',
  version: MANIFEST_VERSION,
  at: new Date().toISOString(),
  root,
  stage: STAGE,
  manifest: A.manifest,
  hash_valid: A.hash_valid,
  schema_valid: A.schema_valid,
  recovery_valid: B.recovery_valid,
  identity_valid: A.identity_valid,
  identity: A.identity,
  inputs_unchanged: inputsUnchanged,
  verdict,
  unknown,
  unvalidatedAssets: A.unvalidated || [],
  stageA: { checks: A.checks, problems: A.problems, files: A.files, bytes: A.bytes },
  stageB: { ran: B.ran, checks: B.checks, diffs: B.diffs, drift: B.drift, idempotent: B.idempotent, drill: B.drill,
    expect: A.expect,
    actual: B.actual ? {
      facts: B.actual.facts && { slots: B.actual.facts.slots, keys: B.actual.facts.keys, rows: B.actual.facts.rows, receipts: B.actual.facts.receipts, provRows: B.actual.facts.provRows, itemRefKeys: B.actual.facts.itemRefKeys, readOnlyReason: B.actual.facts.readOnlyReason },
      vectors: B.actual.vectors,
      lineage: B.actual.lineage && { ok: B.actual.lineage.ok, entries: Object.keys(B.actual.lineage.entries || {}).length },
      notes: B.actual.notes && { ok: B.actual.notes.ok, count: Object.keys(B.actual.notes.notes || {}).length },
      manual: B.actual.manual && { rows: B.actual.manual.rows, revisions: B.actual.manual.revisions, byOp: B.actual.manual.byOp },
      subjects: B.actual.subjects && { rows: B.actual.subjects.rows, subjects: B.actual.subjects.subjects, active: B.actual.subjects.active, merged: B.actual.subjects.merged, observations: B.actual.subjects.observations },
      policy: B.actual.policy,
      outbox: B.actual.outbox
    } : null }
};

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const L = (s = '') => console.log(s);
  L('');
  L('═'.repeat(78));
  L(`离线恢复验收 · ${root}`);
  L('═'.repeat(78));
  L(`清单：${manifestPath}`);
  L(`来源：${manifest?.source?.libraryRoot || '(未记录)'}  ·  备份时间 ${manifest?.at || '?'}`);
  L(`宿主数据根：${manifest?.source?.hostDataRoot || '(未记录)'}`);
  L(`  库根全量 ${A.filesList?.length || 0} 个条目 / ${(A.bytes / 1024 / 1024).toFixed(1)}MB`);
  L('');
  L('阶段 A（只读：清单 / 路径 / 哈希 / 格式）');
  for (const c of A.checks) L(`  ${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? `  ${c.detail}` : ''}`);
  if (A.problems.length) {
    L(`  格式问题（前 8 条，共 ${A.problems.length}）：`);
    for (const p of A.problems.slice(0, 8)) L(`    · ${p.rel} [${p.code}] ${p.message}`);
  }
  L('');
  L('阶段 B（复制到演练目录 + 真实 loader 打开）');
  if (!B.ran) {
    L('  — 未执行（A 未通过，或 --stage=a）');
  } else {
    for (const c of B.checks) L(`  ${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? `  ${c.detail}` : ''}`);
    if (B.drift) {
      const d = B.drift;
      L('');
      L(`  打开后变化：允许 ${d.allowed.changed.length + d.allowed.removed.length} 个`
        + `${d.journalBefore ? '（journal 回放）' : '（无 journal，故为零）'}`
        + ` / 未预期 ${d.unexpected.changed.length + d.unexpected.removed.length + d.unexpected.added.length} 个`);
      for (const r of d.allowed.changed) L(`    允许改变 ${r}`);
      for (const r of d.allowed.removed) L(`    允许删除 ${r}（journal 回放后即提交）`);
      for (const r of d.unexpected.changed) L(`    ✗ 未预期改变 ${r}`);
      for (const r of d.unexpected.removed) L(`    ✗ 未预期删除 ${r}`);
      for (const r of d.unexpected.added) L(`    ✗ 未预期新增 ${r}`);
    }
    if (B.drill) L(`\n  演练目录：${B.drill}${KEEP_DRILL ? '（保留）' : '（已清理）'}`);
  }
  L('');
  L('判定');
  L(`  hash_valid     = ${A.hash_valid}`);
  L(`  schema_valid   = ${A.schema_valid}`);
  L(`  recovery_valid = ${B.recovery_valid === null ? 'unknown（阶段 B 未执行 ⇒ 不算通过）' : B.recovery_valid}`);
  L(`  identity_valid = ${A.identity_valid === null ? 'unknown（未指定目标实例根 ⇒ 未验收）' : A.identity_valid}`);
  L(`  inputs_unchanged = ${inputsUnchanged}${inputsUnchanged ? '' : `（被改过：${inputChanged.join(', ')}）`}`);
  if (unknown.length) L(`  ⚠ unknown：${unknown.join(', ')} —— 必需项未知不得算通过`);
  if ((A.unvalidated || []).length) {
    L('');
    L(`※ 未做语义校验（${A.unvalidated.length} 个，原样携带，**不**计入"已验证"）：`);
    for (const u of A.unvalidated.slice(0, 8)) L(`    · ${u.rel}  ← ${u.why}`);
    if (A.unvalidated.length > 8) L(`    … 其余 ${A.unvalidated.length - 8} 个见 --json 的 unvalidatedAssets`);
  }
  L('');
  L(verdict === 'ok' ? '✓ 验收通过：不可变输入逐字节一致、格式合法、真实 loader 读得出且与清单一致。'
    : '✗ 验收失败 —— 这份副本不能当"可恢复"用。');
  L('');
}

process.exit(verdict === 'ok' ? 0 : 1);
