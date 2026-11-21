// tools/evidence-trace.mjs —— 「这条印象是从哪儿来的」只读反查器。
// [by:DS] 2026-10-28
//
// ## 为什么需要它
// `slots.jsonl` 的每一行**不存证据 id**，只存两个派生量：
//   · `evidence_n`         —— 去重后的证据**条数**
//   · `evidence_set_hash`  —— 证据集合的 sha1 前 16 位（单向）
// 所以"点开看证据"在没有额外工具时**做不到**，而面板上那个「证据 11」只说了条数。
//
// ## 为什么还能反查
// 两类写入的证据形态不同（`consolidate.mjs:1649-1665`、`router.mjs:1516`）：
//   · **多值槽**（trait / preference / grudge / speaker_profile）证据 = `window:<窗口id>`，
//     而窗口 id 全在 `consolidate/events.jsonl` 里 ⇒ **可以枚举 + 对撞 hash 还原**。
//   · **非多值槽**（event / topic / promise / joke / pattern）证据 = 最多 40 条真实消息 id
//     ⇒ 组合不可枚举 ⇒ **还原不了**，只能给条数。
//   · **直写**（`/remember` 多值槽恒用）证据 = `self-report` 常量 ⇒ 本来就没有消息级出处。
//
// 这个工具把三类**分开报**，不把"反查不到"混成一句"没有证据"。
//
// ## 纪律
// 只读。不改任何文件、不联网、不碰 secret。输出留占位符，不回明文号码。
//
// 用法：
//   node tools/evidence-trace.mjs --root=data
//   node tools/evidence-trace.mjs --root=data-2 --who=P7335 --kind=trait --limit=10
//   node tools/evidence-trace.mjs --root=data --json
import fs from 'node:fs';
import path from 'node:path';

import { evidenceSetHash } from '../src/core/facts.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => argv.includes(`--${k}`);

const ROOT = path.resolve(opt('root', 'data'));
const LIB = path.join(ROOT, 'memory-vec');
const SLOTS = path.join(LIB, 'facts', 'slots.jsonl');
const EVENTS = path.join(LIB, 'consolidate', 'events.jsonl');
const WHO = opt('who');
const KIND = opt('kind');
const LIMIT = Number(opt('limit', '0')) || 0;
const JSON_OUT = has('json');

function die(msg) {
  console.error(`[evidence-trace] ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(SLOTS)) {
  die(`找不到 ${SLOTS}\n  提示：--root 指向**数据根**（下有 memory-vec/facts/slots.jsonl），不是 memory-vec 本身。`);
}

// ── 读槽：每个 key 取 rev 最大的那行（= 活着的那个版本）─────────────────────
const allRows = fs.readFileSync(SLOTS, 'utf8').trim().split('\n').filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { die(`slots.jsonl 第 ${i + 1} 行不是合法 JSON：${e.message}`); }
});
const live = new Map();
for (const r of allRows) {
  const p = live.get(r.key);
  if (!p || (Number(r.rev) || 0) > (Number(p.rev) || 0)) live.set(r.key, r);
}

// ── 读窗口账本，建 hash → 窗口 的映射 ─────────────────────────────────────
// 三种拼法都试：多值槽用 `window:<id>`；直写用 `self-report`；非多值槽用 id 数组（不可枚举）。
const SELF_REPORT_HASH = evidenceSetHash(['self-report']);
const hashToWindow = new Map();
let eventRows = 0;
if (fs.existsSync(EVENTS)) {
  const evs = fs.readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  eventRows = evs.length;
  for (const e of evs) {
    const wid = String(e.windowId || e.id || '').trim();
    if (!wid) continue;
    const h = evidenceSetHash([`window:${wid}`]);
    // 同一 hash 可能被多个窗口命中（窗口 id 重复/事件行重复）⇒ 留第一个并记数
    const prev = hashToWindow.get(h);
    if (prev) prev.also.push(wid);
    else hashToWindow.set(h, { windowId: wid, chatKey: e.chatKey, fromTs: e.fromTs, toTs: e.toTs, title: e.title, summary: e.summary, also: [] });
  }
}

// 先扫一遍活槽：同一个证据指纹被**多少条槽**共用。
// 用途见 `traceOne` —— 共用的那个不是"某人看过的几条消息"，而是某一代写入通路的常量标记。
const sharedHashes = new Map();
for (const r of live.values()) {
  const h = r.evidence_set_hash;
  sharedHashes.set(h, (sharedHashes.get(h) || 0) + 1);
}

const fmtTs = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

/** 一行槽 → { 证据形态, 能否反查, 窗口, 说明 } */
function traceOne(rec) {
  const n = Number(rec.evidence_n) || 0;
  if (rec.evidence_set_hash === SELF_REPORT_HASH) {
    return {
      form: 'self-report', traceable: false, n,
      note: '直写标记：模型自述的一条，没有消息级出处（多值槽恒用这个，见 router.mjs:1516）'
    };
  }
  const w = hashToWindow.get(rec.evidence_set_hash);
  if (w) {
    return {
      form: 'window', traceable: true, n,
      window: {
        windowId: w.windowId, chatKey: w.chatKey,
        from: fmtTs(w.fromTs), to: fmtTs(w.toTs),
        title: w.title || '', summary: w.summary || '',
        duplicateHits: w.also.length
      },
      note: '证据 = 该整理窗口（窗口内的消息行）。窗口内具体是哪几条，账本没按槽切分。'
    };
  }
  // 走到这里只剩两种情况，而且**不能合并成一句"没有证据"**：
  //   · 真的是一批消息 id（`consolidate` 非多值槽走这条，最多 40 条）⇒ hash 单向、组合不可枚举；
  //   · 某代的**常量标记**（本仓改过口径，旧行留下的 `['self-report']` 之外的常量）
  //     ⇒ 它连"有哪些证据"都不表示，只表示"这一条是某条通路写的"。
  // 判据：同一个 hash 出现在**多个不同说话人**身上 ⇒ 它是常量，不是某人的一批消息。
  const shared = sharedHashes.get(rec.evidence_set_hash) || 0;
  const isConst = shared >= 3;
  return {
    form: isConst ? 'constant-marker' : 'message-ids', traceable: false, n,
    note: isConst
      ? `常量标记（同一指纹在 ${shared} 个槽上重复出现）—— 它表示"哪条通路写的"，不表示"看了哪些消息"`
      : (n > 0
        ? `证据是 ${n} 条消息 id 的集合，hash 单向 ⇒ 不可枚举还原（组合空间太大）`
        : '没有证据记录')
  };
}

const rows = [...live.values()]
  .filter((r) => (WHO ? String(r.speaker) === WHO : true))
  .filter((r) => (KIND ? String(r.fact_kind) === KIND : true))
  .map((r) => {
    const t = traceOne(r);
    const items = Array.isArray(r.content?.items) ? r.content.items : null;
    return {
      speaker: r.speaker,
      kind: r.fact_kind,
      scope: r.scope,
      rev: r.rev,
      source: r.content?.source || '(无)',
      summary: items
        ? items.map((x) => `${x.k}="${x.v}"`).join(' / ')
        : String(r.content?.text || ''),
      evidence: { n: t.n, form: t.form, traceable: t.traceable, window: t.window || null, note: t.note },
      key: r.key
    };
  })
  .sort((a, b) => String(a.speaker).localeCompare(String(b.speaker)) || String(a.kind).localeCompare(String(b.kind)));

const shown = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;

// ── 汇总：三形态分开计数，不合并成一句 ────────────────────────────────────
const overview = {
  root: ROOT,
  slotsFile: SLOTS,
  totalLines: allRows.length,
  liveSlots: live.size,
  filtered: rows.length,
  eventRows,
  windowsInLedger: hashToWindow.size,
  byForm: {},
  bySource: {}
};
for (const r of rows) {
  const f = r.evidence.form;
  overview.byForm[f] = overview.byForm[f] || { count: 0, traceable: 0 };
  overview.byForm[f].count += 1;
  if (r.evidence.traceable) overview.byForm[f].traceable += 1;
  overview.bySource[r.source] = (overview.bySource[r.source] || 0) + 1;
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: true, overview, rows: shown }, null, 1));
  process.exit(0);
}

const L = (s = '') => console.log(s);
L(`库：${ROOT}`);
L(`活槽 ${overview.liveSlots} 个（文件里 ${overview.totalLines} 行历史）；窗口账本 ${overview.eventRows} 行 / ${overview.windowsInLedger} 个可枚举窗口`);
L(`来源：${Object.entries(overview.bySource).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
L('');
L('证据形态（**分三类报，因为能不能反查取决于它**）：');
for (const [form, v] of Object.entries(overview.byForm)) {
  const label = form === 'window' ? '整理窗口（可反查）'
    : form === 'self-report' ? '直写标记（本来就没有出处）'
      : form === 'constant-marker' ? '常量标记（只说明哪条通路写的）'
        : '消息 id 集合（hash 单向，不可还原）';
  L(`  ${form.padEnd(16)} ${String(v.count).padStart(4)} 条   ${label}`);
}
L('');
L('明细：');
for (const r of shown) {
  const ev = r.evidence;
  const tag = ev.traceable ? `← ${ev.window.from} ~ ${ev.window.to}` : `（${ev.form}）`;
  L(`  [${r.kind}] ${r.speaker} @ ${r.scope} rev${r.rev} · ${r.source}`);
  L(`      ${r.summary.slice(0, 110)}`);
  L(`      证据 ${ev.n} 条 ${tag}${ev.traceable && ev.window.title ? ` · ${ev.window.title}` : ''}`);
  if (ev.traceable && ev.window.summary) L(`      窗口摘要：${ev.window.summary.slice(0, 160)}`);
}
if (LIMIT > 0 && rows.length > LIMIT) L(`\n…还有 ${rows.length - LIMIT} 条，用 --limit=0 看全部。`);
L('');
L('注：`self-report` 与 `message-ids` 这两类**没有可点开的原文**，不是本工具没做，是落盘时就没存');
L('（`factstore.put()` 只把 evidenceIds 算成 `evidence_set_hash` + `evidence_n` 两个派生量）。');
