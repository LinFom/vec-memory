// tools/offline-core.mjs —— 离线备份/验收的**共享只读静态层**（新票 01 / 旧票 16 · [by:DS] 2026-10-29）
//
// ══ 为什么要有这一层 ═════════════════════════════════════════════════════════
// 上一版备份与验收各写了一遍"这个文件该长什么样"，于是同一个错误在两边有不同答案：
// 备份觉得"拷完了就是完整"，验收觉得"没抛异常就是能读"。两份宽松的解析器互相盖章，
// 结果 `slots.jsonl` 坏掉、活槽 0 条，verdict 仍然是 ok。
//
// 所以这里只放**一处**判定：
//   · `classify(rel)`      —— 一个文件属于哪一类资产（未知类型不猜，标 unclassified）
//   · `validateAsset()`    —— 每类资产的**格式**校验（只读、纯静态、不构造任何 loader）
//   · `scanLibrary()`      —— 遍历 + 校验 + 汇总成 `expect`（可后续与真实 loader 的读数对账）
//
// ══ 纪律 ═════════════════════════════════════════════════════════════════════
// ① **不 import 会写盘的类**（`FactStore` / `VecStore` 的构造函数都会 `ensureDir`）。
//    这里只 import 纯函数：`factSlotKey` / `isFactKind`（`facts.mjs` 里没有 IO）。
// ② **坏行一律算失败，不是计数**。上一版把 `JSON.parse` 失败数进 `bad` 字段就放行，
//    等于"看见了却当没看见"。同理 `readLineage` 返回的 `{ok:false}` 不是成功。
// ③ **未知不等于空**。没有的资产要**显式声明**为 absent，不许靠"文件不在"静默略过。
// ④ 路径只认**相对、在根内**的形态；`..`、绝对路径、盘符、符号链接一律判越界。
//
// ══ R2 返工（2026-10-29 · [by:DS]）═════════════════════════════════════════
// 上一版仍有**集成缺口**：核心 v1 新增的 `manual/revisions.jsonl`、
// `subjects/transactions.jsonl`、`policy-baseline.json` 全被归到 `unclassified` ——
// 备份照拷、验收只看哈希，于是"空隔离库里塞三个坏文件 + 完全匹配的清单"
// 能拿到 `verdict=ok`。这一轮把三类资产变成**明确类型**并逐项校验：
//   · DurableLog v1 的链（version / seq / previous / hash）、重复 operationId、data 结构；
//   · 主体事务的**引用关系**（观察必须指向已登记主体、合并目标必须存在、链不能成环）；
//   · `policy-baseline.json` 只认 `{version:1, profilePolicy:"group-peers"}`；
//   · `pending-windows` 的 `observationRequests` 必填字段 + 指向的主体必须已登记；
//   · 事实行的 `provenance` / `itemProvenance` 结构（并计数，B 阶段验 loader 是否保留）。
// 校验只做**静态读**：不构造 `ManualRevisions` / `SubjectStore`（它们的 DurableLog
// 虽然构造时不写盘，但"在不可变备份上打开写库"这条纪律不靠运气）。
//
// ⚠️ 因此这里有两份"同一份判据"的实现（这份镜像 + `src/core/durable-log.mjs`）。
//    唯一可靠的护栏是`test/offline-restore.mjs`里那条"静态层与真实 loader 对同一份
//    正常日志给出相同读数"的用例 —— 改任一侧都要跑它。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { factSlotKey, isFactKind, FACT_KINDS } from '../src/core/facts.mjs';
// 纯常量与纯函数：模块加载期不建目录、不写盘（纪律 ① 只禁"会写盘的**类**"）。
import { digest } from '../src/core/durable-log.mjs';
import { SUBJECT_KINDS } from '../src/core/subjects.mjs';
import { POLICY_VERSION } from '../src/core/visibility.mjs';

/** 清单格式版本。改结构就 +1，旧清单**拒绝**而不是"尽力理解"。
 *  v3（2026-10-29 · [by:DS]）：新增 `manual/` `subjects/` `policy-baseline.json` 三类资产、
 *  `expect` 多了 manual/subjects/policy/provenance 四节、`unvalidatedAssets` 必填，
 *  且 `identity` 成为**独立必需判定**。v2 备份缺这些字段 ⇒ 一律拒绝（不"尽力理解"）。 */
export const MANIFEST_VERSION = 3;
export const MANIFEST_NAME = 'OFFLINE-MANIFEST.json';

// ── 资产分类 ────────────────────────────────────────────────────────────────
// `section` 是报告里分组用的；`kind` 决定用哪个校验器。**顺序敏感**：先具体后笼统。
const RULES = [
  { re: /^facts\/slots\.jsonl$/, section: 'facts', kind: 'facts-slots' },
  { re: /^facts\/index\.json$/, section: 'facts', kind: 'facts-index' },
  { re: /^facts\/merged\.json$/, section: 'facts', kind: 'facts-merged' },
  { re: /^facts\/evidence\.jsonl$/, section: 'facts', kind: 'facts-evidence' },

  { re: /^consolidate\/state\.json$/, section: 'consolidate', kind: 'consolidate-state' },
  { re: /^consolidate\/events\.jsonl$/, section: 'consolidate', kind: 'consolidate-events' },
  { re: /^consolidate\/hits\.jsonl$/, section: 'consolidate', kind: 'consolidate-hits' },
  { re: /^consolidate\/pending-windows\.json$/, section: 'consolidate', kind: 'consolidate-pending' },

  // ── 核心 v1 的新资产（R2）──────────────────────────────────────────────
  // 这两条是 DurableLog：**提交后才发布**、每行带链式哈希。丢了/坏了不是"少几条记录"，
  // 而是"人工隐藏项会重新出现"与"主体合并关系断掉"——都属静默错。
  { re: /^manual\/revisions\.jsonl$/, section: 'manual', kind: 'manual-revisions' },
  { re: /^subjects\/transactions\.jsonl$/, section: 'subjects', kind: 'subject-transactions' },
  // 空库首次建立才写；它的存在意味着"这台新库的默认可见性已被钉住"。
  { re: /^policy-baseline\.json$/, section: 'policy', kind: 'policy-baseline' },

  { re: /^labels\.json$/, section: 'identity', kind: 'lineage' },
  { re: /^notes\.json$/, section: 'identity', kind: 'notes' },
  { re: /^group-names\.json$/, section: 'identity', kind: 'group-names' },
  { re: /^normalizer\/secret\.key$/, section: 'normalizer', kind: 'secret', secret: true },
  { re: /^normalizer\/entities\.json$/, section: 'normalizer', kind: 'normalizer', secret: true },
  { re: /^normalizer\/registry\.json$/, section: 'normalizer', kind: 'normalizer', secret: true },
  { re: /^normalizer\/pending\.json$/, section: 'normalizer', kind: 'normalizer', secret: true },
  // `normalizer/_purge-*` 这类历史残留也是资产的一部分（谁也不知道里面有没有别的东西），
  // 归到同一 section 但**不做格式校验**：它不是任何解析器认得的文件，硬校验只会误判。
  { re: /^normalizer\//, section: 'normalizer', kind: 'opaque', secret: true },

  { re: /^(index\.json|meta\.jsonl|vectors\.bin|put-pending\.json|vector-active\.json)$/, section: 'vectors', kind: 'vectors' },
  { re: /^vector-generations\//, section: 'vectors', kind: 'vectors' },

  // ⚠️ 沿革与备注在**宿主数据根**，不在库根（`writeLineage(await dataDir())`）。
  //    上一版按库根找 ⇒ 一个都没拷到，而清单里仍写着这两节。备份里它们落在 `_host/`。
  { re: /^_host\/labels\.json$/, section: 'identity', kind: 'lineage' },
  { re: /^_host\/notes\.json$/, section: 'identity', kind: 'notes' },
  { re: /^_host\/memory-vec-outbox\.jsonl$/, section: 'host', kind: 'host-outbox' },
  { re: /^_host\/memory-vec-checkpoint-state\.json$/, section: 'host', kind: 'host-checkpoint' },
  { re: /^_config\//, section: 'config', kind: 'config', secret: true }
];

/** 一个相对路径属于哪一类资产。未知 ⇒ `unclassified`（**仍然备份**，只是不做格式断言）。 */
export function classify(rel) {
  const r = String(rel || '').split(path.sep).join('/');
  if (r === MANIFEST_NAME) return { section: 'manifest', kind: 'manifest', secret: false };
  for (const rule of RULES) {
    if (rule.re.test(r)) return { section: rule.section, kind: rule.kind, secret: Boolean(rule.secret) };
  }
  return { section: 'unclassified', kind: 'unclassified', secret: false };
}

/**
 * 「格式上**必须存在**」的资产 —— 只列"有就一定校验，没有就必须在 manifest 里声明 absent"的那些。
 * 刻意不把 `facts/slots.jsonl` 列为必须存在：**空的新库是合法的**（指派明确要求）。
 * 缺它的判据是"声明"而不是"存在"。
 *
 * ⚠️ 备份与验收都**从这张表取**：上一版备份手写了一份名单、验收手写另一份，
 *    于是"备份没拷"和"验收没查"可以各自成立而没人发现。
 */
export const DECLARABLE = [
  'facts/slots.jsonl', 'facts/index.json', 'facts/merged.json', 'facts/evidence.jsonl',
  'consolidate/state.json', 'consolidate/events.jsonl', 'consolidate/hits.jsonl', 'consolidate/pending-windows.json',
  'manual/revisions.jsonl', 'subjects/transactions.jsonl', 'policy-baseline.json',
  'labels.json', 'notes.json', 'group-names.json',
  'normalizer/entities.json', 'normalizer/registry.json', 'normalizer/pending.json', 'normalizer/secret.key',
  'index.json', 'meta.jsonl', 'vectors.bin', 'put-pending.json', 'vector-active.json'
];

/**
 * 宿主侧 / 配置侧的具名资产（备份里落在 `_host/` 与 `_config/`）。
 * 它们同样**要么在清单里、要么显式声明没有** —— "没提供 --host-data" 是"没做"，不是"没有"。
 */
export const HOST_DECLARABLE = [
  '_host/labels.json', '_host/notes.json',
  '_host/memory-vec-outbox.jsonl', '_host/memory-vec-checkpoint-state.json',
  '_config/host-config.json', '_config/instances.json'
];

// ── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * 相对路径的**词法**检查：不许绝对、不许 `..`、不许盘符、不许反斜杠。
 * 为什么词法检查不够还要 realpath：目录里可能有一个指向外的 junction，词法上完全合法。
 */
export function checkRel(rel) {
  const raw = String(rel ?? '');
  if (!raw) return { ok: false, reason: '路径为空' };
  if (raw.includes('\0')) return { ok: false, reason: '路径含 NUL' };
  if (raw.includes('\\')) return { ok: false, reason: '路径含反斜杠（清单只认 /）' };
  // 盘符要**先于** isAbsolute 判：Windows 上 `C:/x` 同时成立，先判 isAbsolute 会让
  // 报告说"绝对路径"而非"含盘符" —— 两者对操作者的意义不同（后者是"从别的盘抄来的清单"）。
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, reason: '含盘符' };
  if (path.isAbsolute(raw)) return { ok: false, reason: '绝对路径' };
  if (raw.split('/').some((s) => s === '..')) return { ok: false, reason: '含 ..' };
  if (raw.startsWith('/')) return { ok: false, reason: '以 / 开头' };
  const norm = path.posix.normalize(raw);
  if (norm !== raw) return { ok: false, reason: `未规范化（${raw} → ${norm}）` };
  return { ok: true, reason: '' };
}

/**
 * 落到磁盘的**实际**检查：目标必须存在、不是符号链接、realpath 仍在根内。
 * `rootReal` 由调用方一次性算好（`fs.realpathSync`），避免每次调都做一遍系统调用。
 */
export function checkInside(rootReal, rel) {
  const lex = checkRel(rel);
  if (!lex.ok) return { ok: false, reason: lex.reason };
  const abs = path.join(rootReal, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return { ok: false, reason: `不存在或无权访问（${e.code || e.message}）` }; }
  if (st.isSymbolicLink()) return { ok: false, reason: '是符号链接（可能指向根外）' };
  let real;
  try { real = fs.realpathSync(abs); } catch (e) { return { ok: false, reason: `realpath 失败（${e.message}）` }; }
  const relReal = path.relative(rootReal, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { ok: false, reason: `realpath 落在根外（${real}）` };
  }
  return { ok: true, reason: '', abs, bytes: st.size };
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 递归列文件。返回**相对路径**（`/` 分隔）、字节数，以及单独挑出来的符号链接
 * （符号链接本身要报，不能跟进 —— 跟进就可能把根外的东西抄进备份）。
 */
export function listFiles(root) {
  const rootReal = fs.realpathSync(root);
  const out = { root, rootReal, files: [], symlinks: [], errors: [] };
  const stack = [''];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(rootReal, d), { withFileTypes: true }); }
    catch (e) { out.errors.push({ rel: d || '.', error: String(e?.message || e) }); continue; }
    for (const e of entries) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.symlinks.push(rel); continue; }
      if (e.isDirectory()) { stack.push(rel); continue; }
      if (!e.isFile()) { out.errors.push({ rel, error: '既不是普通文件也不是目录' }); continue; }
      const abs = path.join(rootReal, rel);
      out.files.push({ rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) });
    }
  }
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  out.symlinks.sort();
  return out;
}

// ── 每类资产的格式校验（纯静态，不构造 loader）────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const bad = (problems, rel, code, message, extra = {}) => problems.push({ rel, code, message, ...extra });

/** JSONL：逐行解析。`checkRow` 返回错误串（或空）表示该行是否合法。 */
function readJsonl(abs, { rel, problems, checkRow, maxSamples = 5 }) {
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { bad(problems, rel, 'IO', `读不动：${e.message}`); return { lines: 0, rows: [], badLines: 0 }; }
  const out = { lines: 0, rows: [], badLines: 0 };
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    out.lines += 1;
    let row;
    try { row = JSON.parse(s); } catch (e) {
      out.badLines += 1;
      if (out.badLines <= maxSamples) bad(problems, rel, 'BAD_JSON_LINE', `第 ${i + 1} 行不是合法 JSON：${e.message}`, { line: i + 1 });
      continue;
    }
    const why = checkRow ? checkRow(row, i + 1) : '';
    if (why) {
      out.badLines += 1;
      if (out.badLines <= maxSamples) bad(problems, rel, 'BAD_ROW', `第 ${i + 1} 行：${why}`, { line: i + 1 });
      continue;
    }
    out.rows.push(row);
  }
  return out;
}

/** JSON：解析 + 形状。`check` 返回错误串表示形状不对。 */
function readJsonFile(abs, { rel, problems, check }) {
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { bad(problems, rel, 'IO', `读不动：${e.message}`); return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { bad(problems, rel, 'BAD_JSON', `不是合法 JSON：${e.message}`); return null; }
  const why = check ? check(obj) : '';
  if (why) { bad(problems, rel, 'BAD_SHAPE', why); return null; }
  return obj;
}

// ── 来源引用（provenance）的静态形状 ───────────────────────────────────────
// 与 `src/core/provenance.mjs#normalizeReferences` 同一套字段。这里不复用那个函数，
// 因为它**会抛 MemoryError**，而我们要的是一句"第几行哪个字段不对"的报告。
const REF_TYPES = new Set(['message', 'window', 'manual']);
function checkRefs(refs, where) {
  if (!Array.isArray(refs)) return `${where} 不是数组`;
  if (!refs.length) return `${where} 为空（没有来源的观察/事实不该被当成"已核验"）`;
  if (refs.length > 500) return `${where} 超过 500 条`;
  for (const r of refs) {
    if (!isObj(r)) return `${where} 里有非对象条目`;
    if (!REF_TYPES.has(r.type)) return `${where} 的 type 非法：${JSON.stringify(r.type)}`;
    if (typeof r.id !== 'string' || !r.id) return `${where} 的条目缺少 id`;
    if (r.chatKey !== null && r.chatKey !== undefined && typeof r.chatKey !== 'string') return `${where} 的 chatKey 非字符串`;
    for (const k of ['fromTs', 'toTs']) {
      if (r[k] !== null && r[k] !== undefined && (!isNum(r[k]) || r[k] < 0)) return `${where} 的 ${k} 非法：${r[k]}`;
    }
    if (isNum(r.fromTs) && isNum(r.toTs) && r.fromTs > r.toTs) return `${where} 的时间区间倒置`;
  }
  return '';
}

// ── DurableLog v1 的静态读 ─────────────────────────────────────────────────
/**
 * 逐行核对 `src/core/durable-log.mjs` 的不变量：
 *   version===1 / seq===行号 / previous===上一行 hash / hash===digest(其余字段) /
 *   operationId 非空且**不重复** / result.ok===true / data 形状由 `checkData` 判。
 *
 * ⚠️ 与真实 `DurableLog` 的差别只有一处（有意）：真实实现**遇到第一个错就把整份日志
 *    标成只读**并停止解析；这里要把同一次坏法的所有症状报出来（操作者不想修一个跑一次）。
 *    代价是链断了之后的后续行不再核 `previous`（否则一行坏会衍生几百条噪声）。
 */
function readDurableLog(abs, rel, problems, { checkData, onData, maxSamples = 5 }) {
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { bad(problems, rel, 'IO', `读不动：${e.message}`); return { rows: 0, badLines: 0 }; }
  // 真实实现：`raw && !raw.endsWith('\n')` ⇒ 'Incomplete journal tail' ⇒ 整份只读。
  // 末尾没换行 = 最后一次 append 被截断（短写/掉电），那行**不能**算提交成功。
  if (raw && !raw.endsWith('\n')) {
    bad(problems, rel, 'INCOMPLETE_TAIL', '文件末尾不是换行 —— 最后一个操作是截断的（未完成 fsync，不能算已提交）');
  }
  const lines = raw.split('\n');
  const seenOps = new Set();
  let prev = '';
  let chainBroken = false;
  let rows = 0;
  let badLines = 0;
  const say = (code, message, line) => {
    badLines += 1;
    if (badLines <= maxSamples) bad(problems, rel, code, `第 ${line} 行：${message}`, { line });
  };

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    rows += 1;
    let row;
    try { row = JSON.parse(s); } catch (e) { say('BAD_JSON_LINE', `不是合法 JSON（${e.message}）`, i + 1); chainBroken = true; continue; }
    if (!isObj(row)) { say('BAD_ROW', '不是对象', i + 1); chainBroken = true; continue; }
    if (row.version !== 1) { say('UNKNOWN_VERSION', `未知日志版本 ${JSON.stringify(row.version)}（本工具只认 1）`, i + 1); chainBroken = true; continue; }
    if (row.seq !== rows) say('SEQ_MISMATCH', `seq=${JSON.stringify(row.seq)}，应为 ${rows}（有行被删/被重排）`, i + 1);
    if (!chainBroken && row.previous !== prev) {
      say('CHAIN_BROKEN', `previous=${String(row.previous).slice(0, 12)}… 与上一行的 hash=${String(prev).slice(0, 12)}… 不一致（日志链断裂）`, i + 1);
      chainBroken = true;
    }
    if (typeof row.operationId !== 'string' || !row.operationId) say('BAD_ROW', '缺少 operationId', i + 1);
    else if (seenOps.has(row.operationId)) say('DUPLICATE_OPERATION', `operationId 重复：${row.operationId}（重放判定会拿错结果）`, i + 1);
    if (typeof row.fingerprint !== 'string' || !row.fingerprint) say('BAD_ROW', '缺少 fingerprint（重试无法判定"同一请求"）', i + 1);
    if (!isObj(row.result) || row.result.ok !== true) say('BAD_ROW', 'result 不是 {ok:true,…}（提交记录必须带成功结果）', i + 1);
    const { hash, ...payload } = row;
    if (typeof hash !== 'string' || hash !== digest(payload)) {
      say('HASH_MISMATCH', '行哈希与内容不符（被改过，或写入时短写）', i + 1);
      chainBroken = true;
    } else {
      prev = hash;
    }
    const why = checkData ? checkData(row.data, i + 1, row) : '';
    if (why) say('BAD_DATA', why, i + 1);
    else if (onData) onData(row.data, row, i + 1);
    if (row.operationId) seenOps.add(row.operationId);
  }
  return { rows, badLines };
}

/** 主体事务里出现的**已登记主体 id**（供 `pending-windows` 的跨文件对账用）。 */
function readSubjectIds(abs) {
  const ids = new Set();
  let raw = '';
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return ids; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try { row = JSON.parse(s); } catch { continue; }
    for (const sub of row?.data?.subjects || []) if (typeof sub?.id === 'string') ids.add(sub.id);
  }
  return ids;
}

const SCOPE_RE = /^(?:group|private|desk|game):[A-Za-z0-9]+$/;
const PLACEHOLDER_RE = /^(?:P\d+|G\d+|SELF|X\d+|[A-Za-z]+:[A-Za-z0-9]+)$/;

/**
 * 单个资产的静态校验。返回 `{ok, problems, stats}`。
 * `stats` 会汇总进 `expect`，供 B 阶段与真实 loader 的读数对账。
 */
export function validateAsset(kind, abs, rel) {
  const problems = [];
  let stats = null;

  switch (kind) {
    // ── 事实层（长期段的唯一真源）────────────────────────────────────────
    case 'facts-slots': {
      const seen = new Set();
      let provRows = 0;
      let itemRefKeys = 0;
      const r = readJsonl(abs, {
        rel, problems,
        checkRow: (row, ln) => {
          if (!isObj(row)) return '不是对象';
          if (typeof row.key !== 'string' || !row.key) return '缺少 key';
          if (typeof row.speaker !== 'string' || !row.speaker) return '缺少 speaker';
          if (!isFactKind(row.fact_kind)) return `fact_kind 不在 FACT_KINDS：${row.fact_kind}`;
          if (!SCOPE_RE.test(String(row.scope || ''))) return `scope 不是占位符形态：${row.scope}`;
          if (!Number.isInteger(row.rev) || row.rev < 1) return `rev 不是正整数：${row.rev}`;
          if (row.evidence_n !== undefined && (!Number.isInteger(row.evidence_n) || row.evidence_n < 0)) return `evidence_n 非法：${row.evidence_n}`;
          if (!('content' in row)) return '缺少 content';
          // 身份键必须**能原样重拼**：拼不出来说明这一行会让 loader 在 verify() 里报错，
          // 或者干脆被当新槽 —— 两种都不该被"备份通过"盖章。
          let rebuilt;
          try { rebuilt = factSlotKey(row.speaker, row.target, row.fact_kind, row.scope); }
          catch (e) { return `键无法重拼：${e.message}`; }
          if (rebuilt !== row.key) return `键与四元组不一致（${row.key} ≠ ${rebuilt}）`;
          // ── 来源引用（R2）：可选字段，但**有了就必须形状对** ────────────
          // 它是"这条印象的证据在哪"的唯一持久记录；结构坏了 = `evidenceView` 静默降级
          // 成 unavailable，而用户会以为"这条没证据"。
          if (row.provenance !== undefined) {
            const why = checkRefs(row.provenance, 'provenance');
            if (why) return why;
            provRows += 1;
          }
          if (row.itemProvenance !== undefined) {
            if (!isObj(row.itemProvenance)) return 'itemProvenance 不是对象';
            for (const [ik, refs] of Object.entries(row.itemProvenance)) {
              const why = checkRefs(refs, `itemProvenance[${ik}]`);
              if (why) return why;
              itemRefKeys += 1;
            }
          }
          return '';
        }
      });
      for (const row of r.rows) seen.add(row.key);
      stats = {
        lines: r.lines,
        keys: seen.size,
        receipts: r.rows.filter((x) => x && isObj(x.delivery) && x.delivery.id).length,
        badLines: r.badLines,
        // B 阶段按这两个数核"loader 打开后引用还在"（不是只核行数）
        provRows, itemRefKeys
      };
      break;
    }
    case 'facts-index': {
      const idx = readJsonFile(abs, {
        rel, problems,
        check: (o) => {
          if (!isObj(o)) return '顶层不是对象';
          if (!Number.isInteger(o.count)) return 'count 不是整数';
          if (o.count < 0) return 'count 为负';
          if (!isObj(o.by_scope) && o.by_scope !== undefined) return 'by_scope 不是对象';
          return '';
        }
      });
      stats = idx ? { count: idx.count } : null;
      break;
    }
    case 'facts-merged': {
      const m = readJsonFile(abs, {
        rel, problems,
        check: (o) => {
          if (!isObj(o)) return '顶层不是对象（应是 { "<槽key>": {…} }）';
          for (const [k, v] of Object.entries(o)) {
            if (!k) return '有空键';
            if (!isObj(v)) return `条目 ${k} 不是对象`;
            if (v.into !== undefined && v.into !== null && typeof v.into !== 'string') return `条目 ${k} 的 into 非法`;
          }
          return '';
        }
      });
      stats = m ? { keys: Object.keys(m).length } : null;
      break;
    }
    case 'facts-evidence': {
      const r = readJsonl(abs, {
        rel, problems,
        checkRow: (row) => {
          if (!isObj(row)) return '不是对象';
          if (typeof row.id !== 'string' || !row.id) return '缺少 id';
          if (!isNum(row.at)) return `at 不是数字：${row.at}`;
          return '';
        }
      });
      stats = { lines: r.lines, badLines: r.badLines };
      break;
    }

    // ── 整理管线（事件 / 排练 / 游标 / 待补窗口）──────────────────────────
    case 'consolidate-state': {
      const st = readJsonFile(abs, {
        rel, problems,
        check: (o) => {
          if (!isObj(o)) return '顶层不是对象';
          if (o.chats !== undefined && !isObj(o.chats)) return 'chats 不是对象';
          return '';
        }
      });
      stats = st ? { chats: Object.keys(st.chats || {}).length, updatedAt: Number(st.updatedAt) || 0 } : null;
      break;
    }
    case 'consolidate-events': {
      const r = readJsonl(abs, {
        rel, problems,
        checkRow: (row) => {
          if (!isObj(row)) return '不是对象';
          if (typeof row.id !== 'string' || !row.id) return '缺少 id（去重与排练计数都靠它）';
          if (typeof row.chatKey !== 'string' || !row.chatKey) return '缺少 chatKey';
          if (!isNum(row.fromTs) || !isNum(row.toTs)) return 'fromTs/toTs 不是数字';
          if (row.toTs < row.fromTs) return `toTs 早于 fromTs（${row.toTs} < ${row.fromTs}）`;
          return '';
        }
      });
      stats = { events: r.lines, badLines: r.badLines };
      break;
    }
    case 'consolidate-hits': {
      const r = readJsonl(abs, {
        rel, problems,
        checkRow: (row) => {
          if (!isObj(row)) return '不是对象';
          const id = String(row.i ?? row.id ?? '').trim();
          if (!id) return '缺少事件 id（i / id）';
          const n = Number(row.n ?? 1);
          if (!Number.isFinite(n) || n < 1) return `n 非法：${row.n}`;
          return '';
        }
      });
      stats = { hits: r.lines, badLines: r.badLines };
      break;
    }
    case 'consolidate-pending': {
      // ⚠️ 与 `consolidate.mjs` 里私有的 `readPending` 同一判据：对象、非数组、每条有 win。
      //    那个函数不导出（不改生产代码），这里是**镜像**，两边口径必须一起改。
      let requests = 0;
      let windowsWithRequests = 0;
      const p = readJsonFile(abs, {
        rel, problems,
        check: (o) => {
          if (!isObj(o)) return '顶层不是对象（或成了数组）';
          for (const [k, v] of Object.entries(o)) {
            if (!isObj(v)) return `条目 ${k} 不是对象`;
            if (!isObj(v.win)) return `条目 ${k} 缺少 win`;
            if (typeof v.win.chatKey !== 'string' || !v.win.chatKey) return `条目 ${k} 的 win.chatKey 非法`;
            if (!isNum(v.win.fromTs) || !isNum(v.win.toTs)) return `条目 ${k} 的 win 时间戳非法`;
            // ── 冻结的观察请求（核心 v1 · R2）────────────────────────────
            const reqs = v.observationRequests;
            if (reqs !== undefined) {
              if (!Array.isArray(reqs)) return `条目 ${k} 的 observationRequests 不是数组`;
              for (let j = 0; j < reqs.length; j++) {
                const r = reqs[j];
                const at = `条目 ${k} 的 observationRequests[${j}]`;
                if (!isObj(r)) return `${at} 不是对象`;
                for (const f of ['operationId', 'subjectId', 'aspect', 'statement', 'claimType', 'sourceScope']) {
                  if (typeof r[f] !== 'string' || !r[f]) return `${at} 缺少 ${f}`;
                }
                if (!Number.isInteger(r.expectedSubjectRev) || r.expectedSubjectRev < 1) return `${at} 的 expectedSubjectRev 非法：${r.expectedSubjectRev}`;
                if (!isNum(r.observedAt) || r.observedAt < 0) return `${at} 的 observedAt 非法：${r.observedAt}`;
                if (!['fact', 'opinion', 'pattern'].includes(r.claimType)) return `${at} 的 claimType 非法：${r.claimType}`;
                if (!SCOPE_RE.test(String(r.sourceScope))) return `${at} 的 sourceScope 不是占位符形态：${r.sourceScope}`;
                const why = checkRefs(r.provenance, `${at} 的 provenance`);
                if (why) return why;
                requests += 1;
              }
              if (reqs.length) windowsWithRequests += 1;
            }
            // 镜像 `consolidate.mjs` 的提交期断言：有观察候选却没有冻结请求 ⇒
            // 重试到这里会抛 'Pending observations have no prepared requests'，窗口被永久阻塞。
            // 备份若把这种状态当"可恢复"，恢复后第一次整理就会卡住。
            if (v.parsed && Array.isArray(v.parsed.observations) && v.parsed.observations.length && !reqs?.length) {
              return `条目 ${k} 有 ${v.parsed.observations.length} 条观察候选却没有 observationRequests —— 恢复后重试会拒绝提交，观察会丢`;
            }
          }
          return '';
        }
      });
      stats = p ? { pendingWindows: Object.keys(p).length, observationRequests: requests, windowsWithRequests } : null;
      break;
    }

    // ── 人工修订（DurableLog v1 · R2）────────────────────────────────────
    case 'manual-revisions': {
      // 镜像 `src/core/manual-revisions.mjs#validate`（私有函数，不导出）。
      const addresses = new Set();
      const lastOp = new Map();
      const r = readDurableLog(abs, rel, problems, {
        checkData: (d) => {
          if (!isObj(d)) return 'data 不是对象';
          if (d.type !== 'revision') return `data.type 不是 revision：${JSON.stringify(d.type)}`;
          if (typeof d.key !== 'string' || !d.key) return 'data 缺少 key';
          if (!(d.itemKey === null || typeof d.itemKey === 'string')) return 'data.itemKey 必须是字符串或 null';
          if (!['replace', 'hide', 'restore'].includes(d.op)) return `未知 op：${JSON.stringify(d.op)}`;
          if (!Number.isInteger(d.revision) || d.revision < 1) return `revision 非法：${JSON.stringify(d.revision)}`;
          if (typeof d.baseFingerprint !== 'string' || !d.baseFingerprint) return 'data 缺少 baseFingerprint';
          if (d.op === 'replace' && typeof d.value !== 'string') return 'replace 缺少字符串 value';
          return '';
        },
        onData: (d) => {
          const k = JSON.stringify([d.key, d.itemKey]);
          addresses.add(k);
          lastOp.set(k, d.op);
        }
      });
      const count = { replace: 0, hide: 0, restore: 0 };
      for (const op of lastOp.values()) count[op] += 1;
      stats = {
        rows: r.rows,
        // 「最终生效」的三种状态：同一个 item 被改多次时只看**最后一条**
        items: addresses.size,
        ...count,
        badLines: r.badLines
      };
      break;
    }

    // ── 主体事务（DurableLog v1 · R2）────────────────────────────────────
    case 'subject-transactions': {
      // 镜像 `src/core/subjects.mjs#validate`，**外加**真实的引用关系：
      // 观察必须指向已登记主体、合并目标必须存在、合并链不能成环、rev 不能回退。
      const state = {
        subjects: new Map(),      // id → 最近一次快照
        observations: new Set(),  // id
        merges: 0,
        unmerges: 0
      };
      const r = readDurableLog(abs, rel, problems, {
        checkData: (d) => {
          if (!isObj(d)) return 'data 不是对象';
          if (d.type !== 'subject-transaction') return `data.type 不是 subject-transaction：${JSON.stringify(d.type)}`;
          if (!Array.isArray(d.subjects) || !Array.isArray(d.observations)) return '缺少 subjects[] / observations[]';
          const rowSubjects = new Map();
          for (const s of d.subjects) {
            if (!isObj(s)) return 'subjects 里有非对象条目';
            if (typeof s.id !== 'string' || !s.id) return '主体缺少 id';
            if (!SUBJECT_KINDS.includes(s.kind)) return `主体 ${s.id} 的 kind 非法：${JSON.stringify(s.kind)}`;
            if (typeof s.label !== 'string' || !s.label) return `主体 ${s.id} 缺少 label`;
            if (!Array.isArray(s.aliases)) return `主体 ${s.id} 的 aliases 不是数组`;
            if (!Number.isInteger(s.rev) || s.rev < 1) return `主体 ${s.id} 的 rev 非法：${JSON.stringify(s.rev)}`;
            if (!['active', 'merged'].includes(s.status)) return `主体 ${s.id} 的 status 非法：${JSON.stringify(s.status)}`;
            if (s.kind === 'group' && !/^group:[^\s:]+$/.test(String(s.scopeBinding || ''))) {
              return `群主体 ${s.id} 的 scopeBinding 不是群场合：${JSON.stringify(s.scopeBinding)}`;
            }
            const prevSubject = state.subjects.get(s.id);
            if (prevSubject && s.rev <= prevSubject.rev) return `主体 ${s.id} 的 rev 未递增（${prevSubject.rev} → ${s.rev}）`;
            rowSubjects.set(s.id, s);
          }
          // 合并目标可能在同一行的**后半段**（merge 写 [from, target]）⇒ 先收齐再判
          for (const s of rowSubjects.values()) {
            if (s.status !== 'merged') continue;
            if (!rowSubjects.has(s.mergedInto) && !state.subjects.has(s.mergedInto)) {
              return `主体 ${s.id} 合并指向不存在的主体 ${JSON.stringify(s.mergedInto)}（撤销/解析都会 404）`;
            }
          }
          for (const o of d.observations) {
            if (!isObj(o)) return 'observations 里有非对象条目';
            if (typeof o.id !== 'string' || !o.id) return '观察缺少 id';
            if (typeof o.subjectId !== 'string' || !o.subjectId) return `观察 ${o.id} 缺少 subjectId`;
            if (typeof o.statement !== 'string' || !o.statement) return `观察 ${o.id} 缺少 statement`;
            if (!['fact', 'opinion', 'pattern'].includes(o.claimType)) return `观察 ${o.id} 的 claimType 非法：${JSON.stringify(o.claimType)}`;
            if (!SCOPE_RE.test(String(o.sourceScope || ''))) return `观察 ${o.id} 的 sourceScope 不是占位符形态：${o.sourceScope}`;
            if (!['active', 'retracted'].includes(o.status)) return `观察 ${o.id} 的 status 非法：${JSON.stringify(o.status)}`;
            if (!state.subjects.has(o.subjectId) && !rowSubjects.has(o.subjectId)) {
              return `观察 ${o.id} 指向不存在的主体 ${o.subjectId}（引用关系断了 ⇒ 这条印象永远查不到主人）`;
            }
            if (state.observations.has(o.id)) return `观察 id 重复：${o.id}`;
            const why = checkRefs(o.provenance, `观察 ${o.id} 的 provenance`);
            if (why) return why;
          }
          // 合并链必须终止（A→B、B→A 会让 canonical() 无限解析）
          for (const s of rowSubjects.values()) {
            if (s.status !== 'merged') continue;
            const seen = new Set();
            let cur = s.id;
            for (;;) {
              const node = rowSubjects.get(cur) || state.subjects.get(cur);
              if (!node || node.status !== 'merged') break;
              if (seen.has(cur)) return `合并链成环：${[...seen, cur].join(' → ')}`;
              seen.add(cur);
              cur = node.mergedInto;
            }
          }
          return '';
        },
        onData: (d) => {
          for (const s of d.subjects) {
            const before = state.subjects.get(s.id);
            if (before?.status === 'merged' && s.status === 'active') state.unmerges += 1;
            if (before?.status !== 'merged' && s.status === 'merged') state.merges += 1;
            state.subjects.set(s.id, s);
          }
          for (const o of d.observations) state.observations.add(o.id);
        }
      });
      let active = 0;
      let merged = 0;
      let aliases = 0;
      for (const s of state.subjects.values()) {
        if (s.status === 'merged') merged += 1; else active += 1;
        aliases += Array.isArray(s.aliases) ? s.aliases.length : 0;
      }
      stats = {
        rows: r.rows,
        subjects: state.subjects.size,
        active,
        merged,
        observations: state.observations.size,
        merges: state.merges,
        unmerges: state.unmerges,
        aliases,
        badLines: r.badLines
      };
      break;
    }

    // ── 可见性基线（R2）──────────────────────────────────────────────────
    case 'policy-baseline': {
      // 镜像 `visibility.mjs#loadPolicyBaseline`：**只认** {version:1, profilePolicy:"group-peers"}。
      // 它只在**空库首次建立**时写；若被改成别的值，重启后新库会静默换一个默认策略
      // —— 而"谁能看到谁的印象"是这套系统里最不该静默变化的东西。
      const o = readJsonFile(abs, {
        rel, problems,
        check: (x) => {
          if (!isObj(x)) return '顶层不是对象';
          if (x.version !== POLICY_VERSION) return `未知版本 ${JSON.stringify(x.version)}（本工具只认 ${POLICY_VERSION}）`;
          if (x.profilePolicy !== 'group-peers') return `profilePolicy 必须是 group-peers（收到 ${JSON.stringify(x.profilePolicy)}）—— 它只是"新库默认值已钉住"的标记，不是策略编辑入口`;
          return '';
        }
      });
      stats = o ? { version: o.version, profilePolicy: o.profilePolicy } : null;
      break;
    }

    // ── 身份 / 沿革 / 备注 ────────────────────────────────────────────────
    case 'lineage': {
      const o = readJsonFile(abs, {
        rel, problems,
        check: (x) => {
          if (!isObj(x)) return '顶层不是对象';
          if (x.entries !== undefined && !isObj(x.entries)) return 'entries 不是对象';
          for (const [k, v] of Object.entries(x.entries || {})) {
            if (!isObj(v)) return `条目 ${k} 不是对象`;
            if (typeof v.to !== 'string' || !v.to) return `条目 ${k} 缺少 to`;
          }
          return '';
        }
      });
      stats = o ? { entries: Object.keys(o.entries || {}).length } : null;
      break;
    }
    case 'notes': {
      const o = readJsonFile(abs, {
        rel, problems,
        check: (x) => {
          if (!isObj(x)) return '顶层不是对象';
          for (const [k, v] of Object.entries(x)) {
            if (!k) return '有空键';
            if (typeof v !== 'string' && !isObj(v)) return `条目 ${k} 既不是字符串也不是对象`;
          }
          return '';
        }
      });
      stats = o ? { count: Object.keys(o).length } : null;
      break;
    }
    case 'group-names': {
      const o = readJsonFile(abs, { rel, problems, check: (x) => (isObj(x) ? '' : '顶层不是对象') });
      stats = o ? { keys: Object.keys(o).length } : null;
      break;
    }
    case 'normalizer': {
      const o = readJsonFile(abs, {
        rel, problems,
        check: (x) => {
          if (!isObj(x)) return '顶层不是对象';
          const arrKey = Array.isArray(x.entities) ? 'entities' : (Array.isArray(x.entries) ? 'entries' : null);
          if (!arrKey) return '既没有 entities 也没有 entries 数组';
          for (const it of x[arrKey]) {
            if (!isObj(it)) return `${arrKey} 里有非对象条目`;
            if (arrKey === 'entities' && !String(it.id ?? '').trim()) return 'entities 条目缺少 id';
            if (arrKey === 'entries' && !String(it.term ?? '').trim()) return 'entries 条目缺少 term';
          }
          return '';
        }
      });
      stats = o ? { records: (o.entities || o.entries || []).length } : null;
      break;
    }
    case 'secret': {
      let raw = '';
      try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { bad(problems, rel, 'IO', `读不动：${e.message}`); break; }
      if (!raw.trim()) bad(problems, rel, 'BAD_SECRET', '密钥文件为空');
      // ⚠️ 只报长度，绝不打印内容 —— 它是可反推身份的本机密钥。
      stats = { bytes: Buffer.byteLength(raw, 'utf8') };
      break;
    }

    // ── 向量 ──────────────────────────────────────────────────────────────
    case 'vectors':
      // 向量是**一组**文件，单独由 `validateVectors()` 处理（要跨文件核对）。
      break;

    case 'host-outbox': {
      const r = readJsonl(abs, {
        rel, problems,
        checkRow: (row) => {
          if (!isObj(row)) return '不是对象';
          if (typeof row.id !== 'string' || !row.id) return '缺少 id';
          return '';
        }
      });
      // 生产插件对坏行是**跳过**（一行被截断不该毁整条队列）；备份验收不接这个宽容：
      // 带着坏行的副本不算"可恢复"，坏了几行就报几行。
      stats = { lines: r.lines, badLines: r.badLines };
      break;
    }
    case 'host-checkpoint': {
      const o = readJsonFile(abs, {
        rel, problems,
        check: (x) => {
          if (!isObj(x)) return '顶层不是对象';
          for (const [k, v] of Object.entries(x)) {
            if (!isObj(v)) return `条目 ${k} 不是对象`;
            if (v.turns !== undefined && !isNum(v.turns)) return `条目 ${k} 的 turns 不是数字`;
          }
          return '';
        }
      });
      stats = o ? { chats: Object.keys(o).length } : null;
      break;
    }

    case 'config': {
      const o = readJsonFile(abs, { rel, problems, check: (x) => (isObj(x) ? '' : '顶层不是对象') });
      // 只报顶层键数（键名本身不含密钥值），用于"配置确实被复制了"的可核对证据。
      stats = o ? { keys: Object.keys(o).length } : null;
      break;
    }

    case 'opaque':
    case 'unclassified':
    case 'manifest':
      break;

    default:
      bad(problems, rel, 'UNKNOWN_KIND', `未知资产类型：${kind}`);
  }

  return { ok: problems.length === 0, problems, stats };
}

/**
 * 向量组校验：**跨文件**核对，这是"缺活动代 / 编码错 / 尺寸不符"能静态发现的地方。
 * @returns {{stats, problems, layout:'generation'|'legacy'|'none'|'broken'}}
 */
export function validateVectors(rootAbs, rels) {
  const problems = [];
  const has = (rel) => rels.has(rel);
  const readJson = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(rootAbs, rel), 'utf8')); }
    catch (e) { problems.push({ rel, code: 'BAD_JSON', message: `不是合法 JSON：${e.message}` }); return null; }
  };
  const size = (rel) => { try { return fs.statSync(path.join(rootAbs, rel)).size; } catch { return -1; } };
  /** 行数。`upto` ≥ 0 时只数该**字节**前缀里的行（journal 回滚只保留到这里）。 */
  const countLines = (rel, upto = -1) => {
    try {
      const buf = fs.readFileSync(path.join(rootAbs, rel));
      const part = upto >= 0 ? buf.subarray(0, upto) : buf;
      return part.toString('utf8').split('\n').filter((l) => l.trim()).length;
    } catch { return -1; }
  };

  const pointerRel = 'vector-active.json';
  let layout = 'none';
  let generation = null;
  let baseDir = rootAbs;
  let baseRel = '';

  if (has(pointerRel)) {
    const p = readJson(pointerRel);
    if (p) {
      if (p.version !== undefined && p.version !== 1) problems.push({ rel: pointerRel, code: 'BAD_POINTER', message: `未知指针版本 ${p.version}` });
      if (!/^[a-f0-9]{32}$/.test(String(p.generation || ''))) {
        problems.push({ rel: pointerRel, code: 'BAD_POINTER', message: `generation 不是 32 位十六进制：${p.generation}` });
        return { stats: { layout: 'broken' }, problems, layout: 'broken' };
      }
      generation = String(p.generation);
      baseRel = `vector-generations/${generation}`;
      baseDir = path.join(rootAbs, baseRel);
      layout = 'generation';
      if (!fs.existsSync(baseDir)) {
        problems.push({ rel: pointerRel, code: 'MISSING_GENERATION', message: `指针指向的代不存在：${baseRel}（缺活动代）` });
        return { stats: { layout: 'broken', generation }, problems, layout: 'broken' };
      }
    }
  } else if (['index.json', 'meta.jsonl', 'vectors.bin'].some(has)) {
    layout = 'legacy';       // 旧库没有代结构，库根本身就是活动代
  }

  if (layout === 'none' || layout === 'broken') return { stats: { layout }, problems, layout };

  const rel = (name) => (baseRel ? `${baseRel}/${name}` : name);
  const need = ['index.json', 'meta.jsonl', 'vectors.bin'];
  const missing = need.filter((n) => !fs.existsSync(path.join(baseDir, n)));
  if (missing.length) {
    problems.push({ rel: baseRel || '.', code: 'INCOMPLETE_GENERATION', message: `活动代缺文件：${missing.join(', ')}` });
    return { stats: { layout: 'broken', generation }, problems, layout: 'broken' };
  }

  const idx = readJson(rel('index.json'));
  if (!idx) return { stats: { layout: 'broken', generation }, problems, layout: 'broken' };
  if (!Number.isInteger(idx.dim) || idx.dim <= 0) problems.push({ rel: rel('index.json'), code: 'BAD_INDEX', message: `dim 非法：${idx.dim}` });
  if (!Number.isInteger(idx.slots) || idx.slots < 0) problems.push({ rel: rel('index.json'), code: 'BAD_INDEX', message: `slots 非法：${idx.slots}` });
  if (!Number.isInteger(idx.alive) || idx.alive < 0) problems.push({ rel: rel('index.json'), code: 'BAD_INDEX', message: `alive 非法：${idx.alive}` });

  // ── 未完成的写（journal）────────────────────────────────────────────────
  // `put-pending.json` 存在 = **上一次 put 崩在中途**。此时 `vectors.bin` / `meta.jsonl`
  // 已经**领先于** `index.json`：多出来的字节与半行正是"没提交的那部分"。
  //   ① 不能因此判失败 —— 那会把"能不能正确回滚"这件事本身判成损坏；
  //   ② 也不能就这么放行 —— 必须验 journal 自己的形状，并把**回滚后的目标值**
  //      （`journal.index`）记下来，交给 B 阶段在真实回放之后对账。
  // 上一版没这条分支：要么整份判坏，要么（更常见）根本不看 journal 就宣布健康。
  const journalRel = rel('put-pending.json');
  let journal = null;
  if (fs.existsSync(path.join(rootAbs, journalRel))) {
    const j = readJson(journalRel);
    if (j) {
      if (j.version !== 1) problems.push({ rel: journalRel, code: 'BAD_JOURNAL', message: `未知 journal 版本 ${j.version}` });
      else if (!isObj(j.index) || !Number.isSafeInteger(j.binBytes) || j.binBytes < 0 || !Number.isSafeInteger(j.metaBytes) || j.metaBytes < 0) {
        problems.push({ rel: journalRel, code: 'BAD_JOURNAL', message: 'journal 形状不对（需要 index 对象 + binBytes/metaBytes 非负整数）' });
      } else {
        journal = { binBytes: j.binBytes, metaBytes: j.metaBytes, index: j.index };
      }
    }
  }
  const defer = Boolean(journal);       // 回滚未完成 ⇒ 尺寸等式交由 B 阶段在回放之后核

  if (journal) {
    const binNow = size(rel('vectors.bin'));
    const metaNow = size(rel('meta.jsonl'));
    // 只会"多"，不会"少"：少了就是真有字节丢失，journal 也救不回来。
    if (binNow < journal.binBytes) problems.push({ rel: rel('vectors.bin'), code: 'JOURNAL_LOST_BYTES', message: `当前 ${binNow} < journal 记录的 ${journal.binBytes}（字节丢了，回滚会拒绝）` });
    if (metaNow < journal.metaBytes) problems.push({ rel: rel('meta.jsonl'), code: 'JOURNAL_LOST_BYTES', message: `当前 ${metaNow} < journal 记录的 ${journal.metaBytes}（字节丢了，回滚会拒绝）` });
  }

  // 尺寸等式：bin == slots × dim × 4。少了就是"截断的向量"，多了就是"没回滚的 journal"。
  const binBytes = size(rel('vectors.bin'));
  const want = idx.dim * idx.slots * 4;
  if (!defer && binBytes !== want) {
    problems.push({ rel: rel('vectors.bin'), code: 'BIN_SIZE', message: `尺寸 ${binBytes} ≠ slots×dim×4 = ${want}（差 ${binBytes - want} 字节）` });
  }
  // meta 行数 == slots；alive == 存活文档的**去重 id 数**（实测口径，见 ADR 记录）
  // ⚠️ journal 存在时，`meta.jsonl` 末尾必然有一段**没写完的半行**（正是那次崩掉的 put）。
  //    只解析 journal.metaBytes 之前的"已提交前缀"，半行属于"将被截掉的垃圾"，
  //    判它坏等于要求"崩溃过的库必须先自己修好才能备份"。
  const metaPrefixEnd = defer ? journal.metaBytes : -1;
  const metaLines = countLines(rel('meta.jsonl'), metaPrefixEnd);
  if (!defer && metaLines !== idx.slots) {
    problems.push({ rel: rel('meta.jsonl'), code: 'META_LINES', message: `行数 ${metaLines} ≠ index.slots ${idx.slots}` });
  }
  let aliveRows = 0;
  const aliveIds = new Set();
  let badMetaLines = 0;
  try {
    const metaBuf = fs.readFileSync(path.join(baseDir, 'meta.jsonl'));
    const raw = (defer ? metaBuf.subarray(0, journal.metaBytes) : metaBuf).toString('utf8').split('\n');
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i].trim();
      if (!s) continue;
      let m;
      try { m = JSON.parse(s); } catch { badMetaLines += 1; continue; }
      if (!isObj(m)) { badMetaLines += 1; continue; }
      if (!Number.isInteger(m.slot)) { badMetaLines += 1; continue; }
      if (m.state === 'alive') { aliveRows += 1; if (m.id) aliveIds.add(String(m.id)); }
      else if (m.state !== 'deleted') { badMetaLines += 1; }
    }
  } catch (e) {
    problems.push({ rel: rel('meta.jsonl'), code: 'IO', message: `读不动：${e.message}` });
  }
  if (badMetaLines) problems.push({ rel: rel('meta.jsonl'), code: 'BAD_META_ROWS', message: `${badMetaLines} 行形状不对（不是 {slot,state,...}）` });
  // journal 存在时 meta 一定比 index 多几行 ⇒ 这条等式只在**已提交**状态下成立
  if (!defer && aliveIds.size !== idx.alive) {
    problems.push({ rel: rel('index.json'), code: 'ALIVE_MISMATCH', message: `index.alive ${idx.alive} ≠ 存活文档去重 id 数 ${aliveIds.size}` });
  }

  // 代指针与索引里的编码身份必须**互相认同**：两处都写、两处都可能坏，只信一处等于没校验。
  const pointerObj = has(pointerRel) ? readJson(pointerRel) : null;
  const pEnc = pointerObj && pointerObj.encoding !== undefined ? pointerObj.encoding : undefined;
  const iEnc = idx.encoding !== undefined ? idx.encoding : undefined;
  if (pEnc !== undefined && iEnc !== undefined && pEnc !== iEnc) {
    problems.push({ rel: pointerRel, code: 'ENCODING_SPLIT', message: `指针 encoding(${JSON.stringify(pEnc)}) ≠ 索引 encoding(${JSON.stringify(iEnc)})` });
  }

  return {
    layout,
    problems,
    stats: {
      layout,
      generation,
      dim: idx.dim ?? null,
      model: idx.model ?? null,
      slots: idx.slots ?? null,
      alive: idx.alive ?? null,
      encoding: iEnc ?? null,
      pointerEncoding: pEnc ?? null,
      binBytes,
      metaLines,
      rowsAlive: aliveRows,
      // journal 的**回滚目标**：B 阶段回放之后必须落在这里，否则"回放被跳过"看不出来
      journal,
      indexSha256: sha256File(path.join(baseDir, 'index.json')),
      pointerSha256: has(pointerRel) ? sha256File(path.join(rootAbs, pointerRel)) : null
    }
  };
}

// ── 汇总：一个目录根 → 校验 + 期望值 ────────────────────────────────────────

/**
 * 扫一个**目录根**（库根，或备份根 —— 备份根多一层 `_host/`、`_config/`）。
 *
 * @returns {{
 *   files: Array<{rel,bytes,sha256,section,kind,secret}>,
 *   symlinks: string[], readErrors: Array,
 *   problems: Array<{rel,code,message}>,      // 格式问题（**非空即失败**）
 *   expect: object                            // 供 B 阶段与真实 loader 对账
 * }}
 */
export function scanLibrary(root) {
  const inv = listFiles(root);
  const files = [];
  const problems = [];
  const rels = new Set();

  for (const f of inv.files) {
    const { section, kind, secret } = classify(f.rel);
    rels.add(f.rel);
    files.push({ ...f, section, kind, secret });
    if (kind === 'vectors' || kind === 'manifest' || kind === 'opaque' || kind === 'unclassified') continue;
    const r = validateAsset(kind, path.join(inv.rootReal, f.rel), f.rel);
    for (const p of r.problems) problems.push(p);
  }
  for (const s of inv.symlinks) {
    problems.push({ rel: s, code: 'SYMLINK', message: '是符号链接（可能指向根外，拒绝跟进）' });
  }
  for (const e of inv.errors) problems.push({ rel: e.rel, code: 'FS', message: e.error });

  // ── 跨文件：冻结的观察请求必须指向**已登记主体** ────────────────────────
  // `prepareWindow` 只会为已存在的主体生成请求，所以"请求里有、日志里没有"必然是
  // 主体事务丢了（或备份漏拷）—— 恢复后这批观察会写到不存在的 subjectId 上。
  {
    const pending = files.find((f) => f.rel === 'consolidate/pending-windows.json');
    if (pending) {
      const subjFile = files.find((f) => f.rel === 'subjects/transactions.jsonl');
      const ids = subjFile ? readSubjectIds(path.join(inv.rootReal, subjFile.rel)) : new Set();
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(path.join(inv.rootReal, pending.rel), 'utf8')); } catch { /* 已在格式校验里报过 */ }
      for (const [k, v] of Object.entries(isObj(obj) ? obj : {})) {
        for (const req of (isObj(v) && Array.isArray(v.observationRequests)) ? v.observationRequests : []) {
          if (isObj(req) && typeof req.subjectId === 'string' && !ids.has(req.subjectId)) {
            problems.push({
              rel: pending.rel, code: 'UNKNOWN_SUBJECT',
              message: `条目 ${k} 的观察请求指向未登记主体 ${req.subjectId}（subjectId 在 subjects/transactions.jsonl 里找不到）`
            });
          }
        }
      }
    }
  }

  // 向量组单独核（跨文件）
  const vec = validateVectors(inv.rootReal, rels);
  for (const p of vec.problems) problems.push(p);

  // ── 未做**语义校验**的资产：原样携带，但不许被说成"已验证" ────────────────
  // 三条来源：① 完全不认识的附件（`unclassified`）；② 认得但刻意不校验的残留
  // （`normalizer/_purge-*`）；③ **非活动代**的向量文件（只有活动代会被打开核对）。
  // 报告里必须列出来 —— 上一版的错是"只复制不验证，然后宣称全库已验证"。
  const activeGen = vec.stats?.generation ? `vector-generations/${vec.stats.generation}/` : null;
  const unvalidated = [];
  for (const f of files) {
    let why = '';
    if (f.kind === 'unclassified') why = '未知资产类型（只原样携带，未做语义校验）';
    else if (f.kind === 'opaque') why = '历史残留（只原样携带，未做语义校验）';
    else if (f.rel.startsWith('vector-generations/') && !(activeGen && f.rel.startsWith(activeGen))) {
      why = '非活动代的向量文件（不会被打开核对）';
    }
    if (why) unvalidated.push({ rel: f.rel, kind: f.kind, why });
  }

  // ── 期望值：只从**字节**推导，不构造 loader ──────────────────────────────
  // `pick` 支持**候选列表**：库根里的 `labels.json` 与备份根里的 `_host/labels.json`
  // 是同一件资产的两个位置（生产把沿革写在宿主数据根，见 `writeLineage(await dataDir())`）。
  const pick = (...cands) => {
    for (const rel of cands) {
      const f = files.find((x) => x.rel === rel);
      if (f) return f;
    }
    return null;
  };
  const statOf = (...cands) => {
    const f = pick(...cands);
    if (!f) return null;
    const r = validateAsset(f.kind, path.join(inv.rootReal, f.rel), f.rel);
    return r.stats;
  };

  const facts = (() => {
    const s = statOf('facts/slots.jsonl');
    if (!s) return null;
    const merged = statOf('facts/merged.json') || { keys: 0 };
    const idx = statOf('facts/index.json') || { count: null };
    return {
      lines: s.lines, keys: s.keys, receipts: s.receipts,
      mergedKeys: merged.keys, indexCount: idx.count,
      // R2：来源引用不是"字段存在就算过" —— 数量要能在 B 阶段与 loader 的读数对上，
      // 否则"备份里有证据、恢复后没了"永远查不出来。
      provRows: s.provRows, itemRefKeys: s.itemRefKeys
    };
  })();

  const vectors = vec.layout === 'none' || vec.layout === 'broken' ? { layout: vec.layout } : vec.stats;

  return {
    root: inv.root,
    rootReal: inv.rootReal,
    files,
    symlinks: inv.symlinks,
    problems,
    unvalidated,
    expect: {
      facts,
      lineage: statOf('labels.json', '_host/labels.json'),
      notes: statOf('notes.json', '_host/notes.json'),
      manual: statOf('manual/revisions.jsonl'),
      subjects: statOf('subjects/transactions.jsonl'),
      policy: statOf('policy-baseline.json'),
      consolidate: (() => {
        const st = statOf('consolidate/state.json');
        const ev = statOf('consolidate/events.jsonl');
        const hi = statOf('consolidate/hits.jsonl');
        const pw = statOf('consolidate/pending-windows.json');
        if (!st && !ev && !hi && !pw) return null;
        return {
          chats: st?.chats ?? 0,
          events: ev?.events ?? 0,
          hits: hi?.hits ?? 0,
          pendingWindows: pw?.pendingWindows ?? 0,
          // ⚠️ 「取不到」和「取到 0」必须能分开：`hits: 0`（真的一次都没被排练过）
          //    与「hits.jsonl 根本不存在」是两件事，报告里都写成 0 就是在制造读数。
          present: { state: Boolean(st), events: Boolean(ev), hits: Boolean(hi), pendingWindows: Boolean(pw) }
        };
      })(),
      vectors,
      host: {
        outbox: statOf('_host/memory-vec-outbox.jsonl', 'memory-vec-outbox.jsonl'),
        checkpoint: statOf('_host/memory-vec-checkpoint-state.json', 'memory-vec-checkpoint-state.json'),
        config: statOf('_config/host-config.json'),
        instances: statOf('_config/instances.json')
      }
    }
  };
}

/** 从清单里取 `expect` 的**扁平摘要**（报告用，不含任何正文/密钥）。 */
export function summarizeExpect(expect) {
  // ⚠️ 这里的每个格子都必须能区分「取到 0」和「没有这个资产」：
  //    真实主号库的 `notes.json` 就不存在，上一版摘要直接印「备注 0」——
  //    读者会以为"这个人一条备注都没有"，实际是"这份备份里没有备注资产"。
  const cnt = (n, absent) => (Number.isFinite(n) ? `${n} 条` : `(${absent})`);
  const c = expect.consolidate;
  const cell = (k) => (c && c.present && c.present[k] === false ? '—' : String(c?.[k] ?? 0));
  return {
    '事实活槽/版本/收据': expect.facts
      ? `${expect.facts.keys} 槽 / ${expect.facts.lines} 版本 / ${expect.facts.receipts} 收据 / ${expect.facts.provRows ?? 0} 带来源`
      : '(无事实资产)',
    '沿革/备注': `${cnt(expect.lineage?.entries, '无沿革资产')} / ${cnt(expect.notes?.count, '无备注资产')}`,
    '人工修订': expect.manual
      ? `${expect.manual.rows} 行 · 最终生效 替换 ${expect.manual.replace} / 隐藏 ${expect.manual.hide} / 恢复 ${expect.manual.restore}`
      : '(无人工修订资产)',
    '主体/观察': expect.subjects
      ? `${expect.subjects.subjects} 主体（活 ${expect.subjects.active} / 合并 ${expect.subjects.merged}）· ${expect.subjects.observations} 观察 · 合并 ${expect.subjects.merges} / 撤销 ${expect.subjects.unmerges}`
      : '(无主体资产)',
    '可见性基线': expect.policy ? `v${expect.policy.version} ${expect.policy.profilePolicy}` : '(无基线标记 ⇒ 旧库沿用 legacy 默认)',
    '事件/排练/待补': c ? `${cell('events')} / ${cell('hits')} / ${cell('pendingWindows')}（— = 该资产不存在）` : '(无整理资产)',
    '观察请求（冻结）': c ? `${cell('observationRequests')} 条（${cell('windowsWithRequests')} 个窗口）` : '(无整理资产)',
    '向量': expect.vectors
      ? `${expect.vectors.layout}${expect.vectors.generation ? `:${expect.vectors.generation.slice(0, 8)}` : ''} · ${expect.vectors.alive ?? 0}/${expect.vectors.slots ?? 0} 条 · ${expect.vectors.dim ?? '?'} 维 · ${expect.vectors.model ?? '?'}`
      : '(无向量资产)'
  };
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
