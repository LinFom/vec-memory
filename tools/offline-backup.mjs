#!/usr/bin/env node
// tools/offline-backup.mjs —— 记忆库**离线一致备份**（新票 01 / 旧票 16 · [by:DS] 2026-10-29 二次返工）
//
// ══ 这一版修的是什么 ═══════════════════════════════════════════════════════
// 上一版最大的问题不是"漏了某个文件"，而是**它用一张固定白名单声称"全库"**：
//   · 真实库根里还有 `_patchbackup/`、`normalizer/_purge-*/` 这类历史残留，
//     白名单一个都不认识 ⇒ 副本看起来齐了，其实不是全量；
//   · `labels.json` / `notes.json` 在**宿主数据根**，不在库根；
//     上一版按库根去找 ⇒ 一个都没拷到，而清单里写着"沿革/备注"两节，读起来像齐了。
// 现在：**库根全量递归拷贝**（不认识的文件归 `unclassified`，照样拷），
// 宿主侧的具名资产**逐个声明**（在 / 不在，都在清单里写清楚原因），
// 并且**把格式校验结果写进清单**（`schema.ok`）—— 备份不再替验收下结论。
//
// ══ 它承诺什么、不承诺什么 ═════════════════════════════════════════════════
// 承诺：「**停写之后**做一份逐字节一致的副本，并如实记录来源、覆盖范围、期望值与格式结论。」
// 不承诺：① 在线热备（边写边拷 = 半行 jsonl，且不会报错）；
//         ② 有这份备份就能从零重建（源聊天存档是**另一个资产域**，不在范围内）；
//         ③ 恢复后业务立刻正确（journal 要由生产恢复逻辑在打开时回放）。
//
// ══ 纪律 ═══════════════════════════════════════════════════════════════════
//   · 源与目标必须**显式**给出；目标必须为空且不在源内；不留半个旧目标；
//   · 符号链接**拒绝**（不跟进、不复制）—— 跟进就可能把根外的文件抄进来；
//   · 密钥/配置**复制内容**（恢复需要它），但报告里只有 sha256 与字节数；
//   · 复制后逐文件复核哈希，不一致 ⇒ 退出 1 并让人整份重做（不修单点）；
//   · 格式有问题的源**仍然备份**（可能是唯一一份待抢救的数据），但退出 1 且清单里
//     `schema.ok=false` —— 这份副本不得被当成"可恢复"。
//
// 用法：
//   node tools/offline-backup.mjs --from=<库根> --to=<空目录> [--host-data=<数据根>]
//                                 [--instances=<instances.json>] [--dry-run] [--json]
import fs from 'node:fs';
import path from 'node:path';

import {
  MANIFEST_VERSION, MANIFEST_NAME, DECLARABLE, HOST_DECLARABLE,
  scanLibrary, sha256File, fmtBytes, summarizeExpect, validateAsset
} from './offline-core.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (n) => {
  const p = args.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : '';
};

const FROM = opt('from');
const TO = opt('to');
const HOST_DATA = opt('host-data');
const INSTANCES = opt('instances');
const DRY = has('--dry-run');
const AS_JSON = has('--json');

function die(msg, code = 2) {
  console.error(`\n[offline-backup] 拒绝执行：${msg}\n`);
  process.exit(code);
}

if (!FROM) die('缺少 --from=<库根>（例如 <DATA_DIR>/memory-vec）。本工具**不**提供默认源。');
if (!TO) die('缺少 --to=<目标目录>。本工具**不**提供默认目标。');
if (!path.isAbsolute(FROM)) die(`--from 必须是绝对路径（收到 ${FROM}）`);
if (!path.isAbsolute(TO)) die(`--to 必须是绝对路径（收到 ${TO}）`);
if (!fs.existsSync(FROM)) die(`--from 不存在：${FROM}`);

const fromAbs = fs.realpathSync(FROM);
const toAbs = path.resolve(TO);
if (!fs.statSync(fromAbs).isDirectory()) die(`--from 不是目录：${fromAbs}`);
if (fromAbs === toAbs) die('源与目标是同一个目录');
{
  const rel = path.relative(fromAbs, toAbs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) die('目标在源目录**内部**（会把自己拷进去，越拷越大）');
}

// ── 源库根扫描：全量 + 格式校验 + 期望值 ────────────────────────────────────
const lib = scanLibrary(fromAbs);
if (!lib.files.length) {
  // **空的新库合法**（指派明确要求：不强制必须已有事实行）。但"空"必须真的是空：
  // 只允许"什么都还没有"或"只有已知目录壳"。有未知条目 ⇒ 更像路径写错了。
  const KNOWN_DIRS = new Set(['facts', 'consolidate', 'normalizer', 'vector-generations', 'manual', 'subjects']);
  const unknown = fs.readdirSync(fromAbs).filter((e) => !KNOWN_DIRS.has(e));
  if (unknown.length) {
    die(`源目录里没有任何可识别的资产，却有未知条目：${unknown.slice(0, 6).join(', ')}\n`
      + `  这更像"路径写错了"而不是空库。真的空库会只有 facts/ consolidate/ normalizer/ 这类目录壳。`);
  }
  lib.empty = true;
}

// ── 宿主侧具名资产 ─────────────────────────────────────────────────────────
// 为什么是"具名"而不是"整个宿主根全量"：宿主数据根里有源聊天存档、缓存、别的插件状态，
// 那是**另一个资产域**（抄进来既没必要，也会让"这份备份能重建什么"变得说不清）。
// 但每一个**都显式声明**存在与否 —— 上一版的错就错在"找不到就当没有"。
const HOST_ASSETS = [
  { rel: '_host/labels.json', from: 'labels.json', why: '沿革（身份合并史）—— 丢了星图上同一人裂成两颗且再也合不回去', kind: 'lineage' },
  { rel: '_host/notes.json', from: 'notes.json', why: '人工备注（显示名）', kind: 'notes' },
  { rel: '_host/memory-vec-outbox.jsonl', from: 'memory-vec-outbox.jsonl', why: '补发队列 —— 丢了等于"写失败的那些印象"永久消失', kind: 'host-outbox' },
  { rel: '_host/memory-vec-checkpoint-state.json', from: 'memory-vec-checkpoint-state.json', why: '检查点计数 —— 丢了检查点节律回到 0', kind: 'host-checkpoint' }
];
const CONFIG_ASSETS = [
  { rel: '_config/host-config.json', from: 'config.json', why: '宿主配置（含本插件的运行参数与令牌）—— 恢复必需，报告不打印内容', kind: 'config' }
];

// 备份侧的具名清单必须与验收侧的 `HOST_DECLARABLE` **逐项一致**：
// 一边多一条 = 另一边的"资产声明完整"永远为假（或永远为真），而报告只会说"清单少了"。
// （`_config/instances.json` 由下面的路径探测决定，见稍后的第二条断言。）
{
  const mine = [...HOST_ASSETS, ...CONFIG_ASSETS].map((a) => a.rel).sort();
  const want = HOST_DECLARABLE.filter((r) => r !== '_config/instances.json').sort();
  if (JSON.stringify(mine) !== JSON.stringify(want)) {
    die(`内部不一致：备份的宿主资产清单与 offline-core 的 HOST_DECLARABLE 不匹配\n`
      + `  备份：${mine.join(', ')}\n  契约：${want.join(', ')}`);
  }
}

const hostRoot = HOST_DATA ? fs.realpathSync(path.resolve(HOST_DATA)) : '';
const hostRows = [];
const absent = [];

if (HOST_DATA) {
  if (!fs.existsSync(hostRoot) || !fs.statSync(hostRoot).isDirectory()) die(`--host-data 不是目录：${hostRoot}`);
  for (const a of [...HOST_ASSETS, ...CONFIG_ASSETS]) {
    const abs = path.join(hostRoot, a.from);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hostRows.push({ ...a, abs, bytes: fs.statSync(abs).size, sha256: sha256File(abs) });
    } else {
      absent.push({ rel: a.rel, reason: `宿主数据根里没有 ${a.from}（不是失败：这个资产可能还没生成）` });
    }
  }
} else {
  for (const a of [...HOST_ASSETS, ...CONFIG_ASSETS]) {
    absent.push({ rel: a.rel, reason: '未提供 --host-data ⇒ 宿主侧资产**未备份**（这不是"没有"，是"没做"）' });
  }
}

// 实例清单：内容必须**复制**（只存哈希等于没备份 —— 恢复时不知道库该配哪个宿主）
let instancesRow = null;
{
  const guess = INSTANCES
    ? path.resolve(INSTANCES)
    : (hostRoot ? path.join(path.dirname(hostRoot), 'instances.json') : path.join(fromAbs, '..', '..', 'instances.json'));
  if (INSTANCES && !fs.existsSync(guess)) die(`--instances 不存在：${guess}`);
  if (fs.existsSync(guess) && fs.statSync(guess).isFile()) {
    let n = null;
    try { const j = JSON.parse(fs.readFileSync(guess, 'utf8')); n = Array.isArray(j?.instances) ? j.instances.length : null; }
    catch (e) { die(`--instances 读不动（不是合法 JSON）：${e.message}`); }
    instancesRow = {
      rel: '_config/instances.json', from: 'instances.json', abs: guess,
      bytes: fs.statSync(guess).size, sha256: sha256File(guess), instances: n,
      why: '实例清单（每个号的库根/端口/来源根）—— 恢复后要靠它对账"这是哪个实例"'
    };
    hostRows.push(instancesRow);
  } else {
    absent.push({ rel: '_config/instances.json', reason: `没找到 instances.json（找过 ${guess}）；用 --instances=<path> 指定` });
  }
}

// 库根里声明缺哪些资产（"缺"必须是**声明**，不能靠文件不在就静默略过）
// ⚠️ 名单从 `DECLARABLE` 取，**不再手写一份** —— 手写的那份在新增 `manual/`、`subjects/`、
//    `policy-baseline.json` 之后就与验收侧脱节了（备份不说、验收也不问，双双"通过"）。
{
  const present = new Set(lib.files.map((f) => f.rel));
  for (const rel of DECLARABLE) {
    if (!present.has(rel)) absent.push({ rel, reason: '源里不存在（空库或该资产尚未生成）' });
  }
}

// 第二条内部断言：`instances.json` 必须**要么备份了、要么声明了**（没有第三条路）。
{
  const declared = new Set([...hostRows.map((r) => r.rel), ...absent.map((a) => a.rel)]);
  if (!declared.has('_config/instances.json')) die('内部不一致：instances.json 既没备份也没声明缺');
}

// 宿主侧资产也要过**同一套**格式校验：上一版把 outbox 的坏行当"正常，只是计数"，
// 于是带着残行的副本照样通过。这里并入 `lib.problems`，清单里同一个 `schema.ok` 说话。
for (const r of hostRows) {
  const base = path.basename(r.rel);
  const kind = r.rel.startsWith('_config/') ? 'config'
    : base === 'labels.json' ? 'lineage'
      : base === 'notes.json' ? 'notes'
        : base.endsWith('.jsonl') ? 'host-outbox' : 'host-checkpoint';
  const v = validateAsset(kind, r.abs, r.rel);
  for (const p of v.problems) lib.problems.push(p);
  // 沿革/备注的**真实位置在宿主数据根** ⇒ 期望值也必须从这边取，
  // 否则清单会写"沿革 0 条"而实际有 393 字节（上一版就是这样把有当成没有）。
  if (kind === 'lineage' && v.stats) lib.expect.lineage = v.stats;
  if (kind === 'notes' && v.stats) lib.expect.notes = v.stats;
  if (kind === 'host-outbox' && v.stats) lib.expect.host.outbox = v.stats;
  if (kind === 'host-checkpoint' && v.stats) lib.expect.host.checkpoint = v.stats;
  if (kind === 'config' && v.stats) {
    if (base === 'instances.json') lib.expect.host.instances = v.stats;
    else lib.expect.host.config = v.stats;
  }
}

// ── 打印 / dry-run ────────────────────────────────────────────────────────
const totalBytes = lib.files.reduce((a, f) => a + f.bytes, 0) + hostRows.reduce((a, r) => a + r.bytes, 0);
const totalFiles = lib.files.length + hostRows.length;

function report() {
  const line = (s = '') => console.log(s);
  line('');
  line('═'.repeat(78));
  line(`离线备份 · ${fromAbs}`);
  line('═'.repeat(78));
  line(`目标：${toAbs}${DRY ? '（dry-run，不写盘）' : ''}`);
  line(`宿主数据根：${hostRoot || '(未提供 --host-data)'}`);
  line('');
  line(`■ 库根（**全量递归**）${lib.files.length} 个文件 / ${fmtBytes(lib.files.reduce((a, f) => a + f.bytes, 0))}`);
  const bySection = new Map();
  for (const f of lib.files) bySection.set(f.section, [...(bySection.get(f.section) || []), f]);
  for (const [sec, rows] of bySection) {
    line(`  ─ ${sec}：${rows.length} 个`);
    for (const f of rows) {
      // 密钥/通讯录只报哈希前 12 位：报告会被贴进工单与聊天
      const tag = f.secret ? `secret sha256:${f.sha256.slice(0, 12)}…` : fmtBytes(f.bytes);
      line(`      ${f.rel.padEnd(44)} ${tag}`);
    }
  }
  line('');
  line(`■ 宿主侧具名资产 ${hostRows.length} 个`);
  for (const r of hostRows) line(`  ${r.rel.padEnd(46)} ${fmtBytes(r.bytes)}  ← ${r.why}`);
  if (absent.length) {
    line('');
    line(`※ 未纳入 / 不存在（${absent.length} 项，逐项有原因）：`);
    for (const a of absent) line(`  · ${a.rel || a.rel}  ${a.reason}`);
  }
  line('');
  line(`合计 ${totalFiles} 个文件 / ${fmtBytes(totalBytes)}`);
  line('');
  line('※ 范围声明：**库根全量**（含不认识的残留目录，归 unclassified 一并拷走）；');
  line('  宿主侧只有上面那几个**具名**资产 —— 源聊天存档（`<DATA_DIR>/memory/evidence.jsonl` 等）');
  line('  属于另一个资产域 ⇒ 有这份备份**不能**声称能从零重建全部记忆。');
  if (lib.problems.length) {
    line('');
    line(`✗ 源库格式问题 ${lib.problems.length} 条（备份会照做，但这份副本不得当"可恢复"）：`);
    for (const p of lib.problems.slice(0, 10)) line(`  · ${p.rel}  [${p.code}] ${p.message}`);
  }
  line('');
  line('期望值（写进清单，供验收阶段与真实 loader 对账）：');
  for (const [k, v] of Object.entries(summarizeExpect(lib.expect))) line(`  ${k}：${v}`);
  if (lib.unvalidated.length) {
    line('');
    line(`※ 未做语义校验（${lib.unvalidated.length} 个，**原样携带**，不声称已验证）：`);
    for (const u of lib.unvalidated.slice(0, 12)) line(`  · ${u.rel}  ← ${u.why}`);
    if (lib.unvalidated.length > 12) line(`  … 其余 ${lib.unvalidated.length - 12} 个见清单 unvalidatedAssets`);
  }
  line('');
}

if (DRY) {
  report();
  process.exit(lib.problems.length ? 1 : 0);
}

// ── 目标检查 ──────────────────────────────────────────────────────────────
if (fs.existsSync(toAbs)) {
  const entries = fs.readdirSync(toAbs);
  if (entries.length) die(`目标已存在且非空（${entries.length} 项）：${toAbs}。本工具不覆盖、不合并。`);
} else {
  fs.mkdirSync(toAbs, { recursive: true });
}

// ── 复制 + 逐文件复核 ─────────────────────────────────────────────────────
const failures = [];
let copied = 0;
function copyOne(srcAbs, rel) {
  const dst = path.join(toAbs, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(srcAbs, dst);
  const want = sha256File(srcAbs);
  const got = sha256File(dst);
  if (got !== want) failures.push({ rel, want, got }); else copied += 1;
  return want;
}

for (const f of lib.files) copyOne(path.join(lib.rootReal, f.rel), f.rel);
for (const r of hostRows) copyOne(r.abs, r.rel);

// ── 清单 ──────────────────────────────────────────────────────────────────
const files = [
  ...lib.files.map((f) => ({ section: f.section, rel: f.rel, bytes: f.bytes, sha256: sha256File(path.join(toAbs, f.rel)), secret: f.secret })),
  ...hostRows.map((r) => ({ section: r.rel.startsWith('_config/') ? 'config' : 'host', rel: r.rel, bytes: r.bytes, sha256: sha256File(path.join(toAbs, r.rel)), secret: true }))
];

const manifest = {
  tool: 'offline-backup',
  version: MANIFEST_VERSION,
  at: new Date().toISOString(),
  note: '离线一致副本：要求源在复制期间**没有写入**。本工具不做在线热备，也不声称能。',
  source: { libraryRoot: fromAbs, hostDataRoot: hostRoot || null, instancesPath: instancesRow?.abs || null },
  scope: {
    // 库根是全量的 ⇒ complete=true；宿主侧是具名的，见 hostAssets
    complete: true,
    libFiles: lib.files.length,
    hostAssets: hostRows.map((r) => r.rel),
    exclusions: [],
    excludedDomains: [
      { what: '<DATA_DIR>/memory/evidence.jsonl 与源聊天存档', why: '另一个资产域：本备份不声称能据此从零重建记忆' }
    ]
  },
  identity: {
    libraryRoot: fromAbs,
    hostDataRoot: hostRoot || null,
    // 判"这份副本是不是那个库"的最强单点证据：事实真值的哈希
    factsFileSha256: files.find((f) => f.rel === 'facts/slots.jsonl')?.sha256 || null,
    instances: instancesRow ? { entries: instancesRow.instances, sha256: instancesRow.sha256 } : null
  },
  expect: lib.expect,
  // 原样携带但**没有做语义校验**的资产。写进清单是为了让"我没验这些"变成
  // 可核对的声明，而不是靠读者相信"备份=全量验证"。
  unvalidatedAssets: lib.unvalidated,
  schema: {
    ok: lib.problems.length === 0,
    problems: lib.problems.slice(0, 200),
    problemCount: lib.problems.length
  },
  files,
  absent
};

fs.writeFileSync(path.join(toAbs, MANIFEST_NAME), JSON.stringify(manifest, null, 2));

report();

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: failures.length === 0 && lib.problems.length === 0,
    target: toAbs, files: totalFiles, copied, failures,
    schemaOk: lib.problems.length === 0, problems: lib.problems.slice(0, 20)
  }, null, 2));
}

if (failures.length) {
  console.error(`\n✗ 复制后有 ${failures.length} 个文件哈希不一致：`);
  for (const f of failures) console.error(`   · ${f.rel}\n     want ${f.want}\n     got  ${f.got}`);
  console.error('   这份副本**不可用**：删掉目标目录整份重做（不要只重拷出错的那几个）。\n');
  process.exit(1);
}

if (lib.problems.length) {
  console.error(`✗ 备份已生成但源库格式有问题（${lib.problems.length} 条）⇒ 清单 schema.ok=false。`);
  console.error(`  这份副本只能用于**抢救与诊断**，不得作为重建前的验收门槛。\n`);
  process.exit(1);
}

console.log(`✓ 已备份 ${copied} 个文件，逐文件 sha256 复核一致。`);
console.log(`  清单：${path.join(toAbs, MANIFEST_NAME)}`);
console.log('  下一步（另一个进程）：node tools/offline-verify.mjs --root=<目标> --expect-source-root=<源>\n');
process.exit(0);
