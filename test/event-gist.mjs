// test/event-gist.mjs —— 票 07「更像人的记忆组织」专项 [by:WorkBuddy] 2026-11-07
//
// 本票不重写衰减算法：只锁住既有三态衰减的可复现性，并验证「evidenceIds 回指 /
// 引文前缀 / unattributed」三件新增物。风格参照 test/recall-policy.mjs 的源码守卫。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  deriveEvidenceIds, eventRefsOf, verifyQuotation, auditEventQuotation,
  unattributedSummary, MAX_EVIDENCE_IDS
} from '../src/core/event-gist.mjs';
import {
  eventRetention, eventDimWeight, retireStaleEvents, readEventRows, consolidatePaths,
  RETIRE_DAYS, PROMOTE_HITS, RETIRE_MIN_RECALL, RETIRE_HARD_RATIO, RETIRE_DIM_WEIGHT
} from '../src/core/consolidate.mjs';
import { validateImportDocument } from '../interop/validate-import.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'event-gist-'));
function writeEventLedger(libDir, rows) {
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.events, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function mkEventRow(overrides = {}) {
  return {
    version: 1, id: 'evt-1', windowId: 'win-1', idx: 1, chatKey: 'group:team',
    fromTs: T0, toTs: T0, msgCount: 1, at: '', title: '露营', detail: '周末约好去露营', who: [],
    summary: '周末约好去露营', evidenceIds: ['m-001', 'm-002'],
    items: [{ at: '', title: '露营', detail: '周末约好去露营', who: [] }],
    hits: 0, lastHitAt: 0, promotedAt: '', retiredAt: '', createdAt: new Date(T0).toISOString(),
    ...overrides
  };
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}
// 跨平台：把相对路径统一成 '/'（Windows 的 path.sep 是 '\\'），断言才好写。
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

// ── ① 多时间点衰减 / 淘汰可复现（live → dimmed → retired）──────────────────
test('多时间点衰减可复现：live → dimmed → retired（用既有函数，不重写算法）', () => {
  // 纯函数三态边界（D10：常数沿用 consolidate.mjs，未校准，不另造/不照抄）
  const { retention: rLive, retireAfterDays, retireHardAfterDays } = eventRetention({ idleDays: 0, hits: 0 });
  assert.equal(rLive, 1);
  assert.ok(rLive >= RETIRE_MIN_RECALL, 't0 = live');
  assert.equal(Math.round(retireAfterDays), RETIRE_DAYS, 'hits=0 锚点：正好第 RETIRE_DAYS 天跌破 rMin');
  assert.ok(retireHardAfterDays > retireAfterDays, '变暗后还有一段观察期才硬回收');
  const hardRecall = RETIRE_MIN_RECALL * RETIRE_HARD_RATIO;
  const rDim = eventRetention({ idleDays: 35, hits: 0 }).retention;
  const rRet = eventRetention({ idleDays: 50, hits: 0 }).retention;
  assert.ok(rDim < RETIRE_MIN_RECALL && rDim >= hardRecall, 'day35 = dimmed（仍在索引里）');
  assert.ok(rRet < hardRecall, 'day50 = retired（出索引）');
  assert.equal(eventDimWeight({ retention: rLive }), 1, 'live 权重 1');
  const wDim = eventDimWeight({ retention: rDim });
  assert.ok(wDim < 1 && wDim >= RETIRE_DIM_WEIGHT, 'dimmed 权重连续落在 [floor,1)');
  assert.ok(eventRetention({ idleDays: 35, hits: PROMOTE_HITS }).retention > rDim, '排练越多越不容易忘（既有行为）');

  // 真实账本上的三态：只打标记，不删行
  const tmp = mkTmp();
  try {
    const libDir = path.join(tmp, 'lib');
    writeEventLedger(libDir, [mkEventRow()]);
    const r1 = retireStaleEvents({ libDir, now: T0 + 1 * DAY, hitCounts: new Map() });
    assert.equal(r1.dimmed, 0); assert.equal(r1.retired, 0); assert.equal(r1.revived, 0);
    const r2 = retireStaleEvents({ libDir, now: T0 + 35 * DAY, hitCounts: new Map() });
    assert.equal(r2.dimmed, 1); assert.equal(r2.retired, 0);
    const r3 = retireStaleEvents({ libDir, now: T0 + 50 * DAY, hitCounts: new Map() });
    assert.equal(r3.retired, 1);
    const rows = readEventRows({ libDir }).rows;
    assert.equal(rows.length, 1, '只打标记，不删数据');
    assert.ok(rows[0].retiredAt, '已淘汰');
    assert.deepEqual(rows[0].evidenceIds, ['m-001', 'm-002'], '淘汰不动回指字段');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── ② 淘汰后原消息正文只存在一份（数据级 + 源码级）────────────────────────
test('淘汰后原消息正文只存在一份：数据级 + 源码级（不新建 jsonl 事实文件、不复制 text）', () => {
  const ORIG = 'ORIGINAL-露营装备清单-9f3a-唯一原文';
  const tmp = mkTmp();
  try {
    const input = path.join(tmp, 'input');
    const libDir = path.join(tmp, 'lib');
    fs.mkdirSync(input, { recursive: true });
    // 唯一真值源：input/messages.jsonl（一行一原话）
    fs.writeFileSync(path.join(input, 'messages.jsonl'), JSON.stringify({
      data: { message: { messageId: 'm-001', conversationId: 'c-1', actorId: 'u-1', role: 'user',
        timestamp: T0, text: `我们周末约好去露营吧，${ORIG}`, scope: { kind: 'group', id: 'team' } } }
    }) + '\n', 'utf8');
    // 事件行只带 gist + evidenceIds，绝不带 text 副本
    writeEventLedger(libDir, [mkEventRow({ summary: '周末约好去露营', evidenceIds: ['m-001'] })]);
    const jsonlBefore = walk(tmp).filter((f) => f.endsWith('.jsonl')).map((f) => rel(tmp, f)).sort();
    retireStaleEvents({ libDir, now: T0 + 50 * DAY, hitCounts: new Map() });

    // 数据级①：整个库里 ORIG 唯一原文串只出现在一个文件
    const filesWithOrig = walk(tmp)
      .filter((f) => fs.readFileSync(f, 'utf8').includes(ORIG))
      .map((f) => rel(tmp, f));
    assert.deepEqual(filesWithOrig, ['input/messages.jsonl'], '原话正文只在唯一真值源出现一次');
    // 数据级②：事件行仍在（只标记），且没有 text 字段、没有第二份正文
    const rows = readEventRows({ libDir }).rows;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].retiredAt);
    assert.equal(Object.hasOwn(rows[0], 'text'), false, '事件记录不得复制 text');
    assert.ok(!JSON.stringify(rows[0]).includes(ORIG));
    assert.deepEqual(rows[0].evidenceIds, ['m-001'], '回指用 id，不落正文');
    // 数据级③：淘汰流程没有新建任何 jsonl 事实文件
    const jsonlAfter = walk(tmp).filter((f) => f.endsWith('.jsonl')).map((f) => rel(tmp, f)).sort();
    assert.deepEqual(jsonlAfter, jsonlBefore, '不新建 jsonl 事实文件');
    // 源码级①：派生回指只读 id、不读 text
    const ids = deriveEvidenceIds({ rows: [{ id: 'm-001', text: ORIG }, { id: 'm-002', text: '别的原文' }] });
    assert.deepEqual(ids, ['m-001', 'm-002']);
    assert.ok(ids.every((x) => typeof x === 'string' && !x.includes(ORIG)), '派生值只含 id');
    // 源码级②：event-gist.mjs 零 fs / 零 I/O
    const gistSrc = read('src/core/event-gist.mjs');
    for (const w of ['node:fs', 'readFileSync', 'writeFileSync', 'appendFileSync', 'fetch('])
      assert.ok(!gistSrc.includes(w), `event-gist.mjs 不得出现 ${w}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── ③ 摘要带 evidenceIds，且能回查到原消息 id ─────────────────────────────
test('摘要带 evidenceIds，eventRefsOf 产 message 级引用，可回查到原消息 id', () => {
  const tmp = mkTmp();
  try {
    const libDir = path.join(tmp, 'lib');
    writeEventLedger(libDir, [mkEventRow({ summary: '周末约好去露营', evidenceIds: ['m-001', 'm-002'], fromTs: T0, toTs: T0 + 1000 })]);
    const stored = readEventRows({ libDir }).rows[0];
    assert.ok(Array.isArray(stored.evidenceIds), '落盘记录带派生 evidenceIds');
    assert.deepEqual(stored.evidenceIds, ['m-001', 'm-002']);

    const refs = eventRefsOf(stored);
    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((r) => r.type), ['message', 'message']);
    assert.deepEqual(refs.map((r) => r.id), ['m-001', 'm-002']);
    assert.equal(refs[0].chatKey, 'group:team');
    assert.equal(refs[0].matchMethod, 'persisted-window');

    // 按 id 回查原话（单一真值源），三重校验全过
    const messages = new Map([
      ['m-001', { messageId: 'm-001', text: '我们周末约好去露营吧', timestamp: T0, chatKey: 'group:team' }],
      ['m-002', { messageId: 'm-002', text: '周末约好去露营，别忘了', timestamp: T0 + 500, chatKey: 'group:team' }]
    ]);
    for (const ref of refs) {
      const r = verifyQuotation({ message: messages.get(ref.id), quote: stored.summary,
        chatKey: stored.chatKey, fromTs: stored.fromTs, toTs: stored.toTs, expectedId: ref.id });
      assert.equal(r.code, 'QUOTE_OK', `${ref.id}: ${r.code}`);
    }

    // 源码级：consolidate record 加了 evidenceIds、没有把 text 复制到第二处
    const cs = read('src/core/consolidate.mjs');
    assert.match(cs, /deriveEvidenceIds\(win\)/, '用纯函数派生，不新建文件');
    assert.match(cs, /evidenceIds,\s*items:/, 'evidenceIds 是同一条 record 内的字段');
    const recordBlock = /const record = \{[\s\S]*?\n\s*\};/.exec(cs)[0];
    assert.ok(!/\btext\s*:/.test(recordBlock), '事件 record 不得复制 text 到第二处');
    // 老事件行（无 evidenceIds）原样退回 window 级形状
    const legacy = { id: 'evt-0', windowId: 'win-0', chatKey: 'group:team', fromTs: T0, toTs: T0 + 1000 };
    assert.deepEqual(eventRefsOf(legacy),
      [{ type: 'window', id: 'win-0', chatKey: 'group:team', fromTs: T0, toTs: T0 + 1000, matchMethod: 'persisted-window' }]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── ④ verifyQuotation 三重校验各失败分支 + 失败时注入被拦下 ───────────────
test('verifyQuotation 三重校验：三个失败分支 + QUOTE_OK，失败时注入被拦下', () => {
  const msg = { messageId: 'm-001', text: '我们周末约好去露营吧', timestamp: T0, chatKey: 'group:team' };
  const base = { message: msg, quote: '周末约好去露营', chatKey: 'group:team', fromTs: T0, toTs: T0 + 1000, expectedId: 'm-001' };
  assert.deepEqual(verifyQuotation(base), { ok: true, code: 'QUOTE_OK' });
  // ① 来源 id 不一致（含查不到消息 / 跨会话）
  assert.deepEqual(verifyQuotation({ ...base, expectedId: 'm-999' }), { ok: false, code: 'QUOTE_ID_MISMATCH' });
  assert.deepEqual(verifyQuotation({ ...base, message: undefined }), { ok: false, code: 'QUOTE_ID_MISMATCH' });
  assert.deepEqual(verifyQuotation({ ...base, message: { ...msg, chatKey: 'group:other' } }), { ok: false, code: 'QUOTE_ID_MISMATCH' });
  // ② 时间窗外（消息时间越界 / 窗口本身不含消息）
  assert.deepEqual(verifyQuotation({ ...base, message: { ...msg, timestamp: T0 + 5000 } }), { ok: false, code: 'QUOTE_OUT_OF_WINDOW' });
  assert.deepEqual(verifyQuotation({ ...base, fromTs: T0 + 2000, toTs: T0 + 3000 }), { ok: false, code: 'QUOTE_OUT_OF_WINDOW' });
  // ③ 引文前缀/包含失败（改引文 / 空引文 / 改原话）
  assert.deepEqual(verifyQuotation({ ...base, quote: '去滑雪' }), { ok: false, code: 'QUOTE_TEXT_MISMATCH' });
  assert.deepEqual(verifyQuotation({ ...base, quote: '' }), { ok: false, code: 'QUOTE_TEXT_MISMATCH' });
  assert.deepEqual(verifyQuotation({ ...base, message: { ...msg, text: '完全不同的话' } }), { ok: false, code: 'QUOTE_TEXT_MISMATCH' });

  // 注入闸门（纯函数，与 worker.mjs recall() 的 gate 同口径）
  const evt = { id: 'evt-1', chatKey: 'group:team', fromTs: T0, toTs: T0 + 1000,
    summary: '周末约好去露营', evidenceIds: ['m-001'] };
  const lookup = (id) => (id === 'm-001' ? msg : undefined);
  assert.equal(auditEventQuotation(evt, { lookupMessage: lookup, quote: evt.summary }).ok, true);
  const idBad = auditEventQuotation({ ...evt, evidenceIds: ['m-404'] }, { lookupMessage: lookup, quote: evt.summary });
  assert.equal(idBad.ok, false); assert.equal(idBad.code, 'QUOTE_ID_MISMATCH'); assert.ok(idBad.failures.length);
  const winBad = auditEventQuotation({ ...evt, fromTs: T0 + 9000, toTs: T0 + 9999 }, { lookupMessage: lookup, quote: evt.summary });
  assert.equal(winBad.ok, false); assert.equal(winBad.code, 'QUOTE_OUT_OF_WINDOW');
  const txtBad = auditEventQuotation(evt, { lookupMessage: lookup, quote: '去滑雪' });
  assert.equal(txtBad.ok, false); assert.equal(txtBad.code, 'QUOTE_TEXT_MISMATCH');

  // 「失败时注入被拦下」：与 worker.mjs gate 相同判定装配，失败 ⇒ 不 push（fail-closed）
  const assemble = (ev, lookupMessage, quote) => {
    const items = [];
    const a = auditEventQuotation(ev, { lookupMessage, quote });
    if (a.ok) items.push({ id: `event:${ev.id}`, text: ev.summary });
    return { items, audit: a };
  };
  const denied = assemble(evt, lookup, '去滑雪');
  assert.equal(denied.items.length, 0, '校验失败 ⇒ 不注入该项');
  assert.equal(denied.audit.code, 'QUOTE_TEXT_MISMATCH');
  const allowed = assemble(evt, lookup, evt.summary);
  assert.equal(allowed.items.length, 1, '校验通过 ⇒ 正常注入');
  // [by:WorkBuddy] 票 07 回归修复：派生摘要不是逐字引文。未声明 quote 时跳过第三重，
  // 但 ①来源 id + ②时间窗 仍必须生效 —— 不声明引文 ≠ 不校验。
  const noQuote = verifyQuotation({message: msg, chatKey: 'group:team',
    fromTs: T0, toTs: T0 + 1000, expectedId: 'm-001'});
  assert.equal(noQuote.ok, true);
  assert.equal(noQuote.quoteSkipped, true);
  const skipped = auditEventQuotation(evt, {lookupMessage: lookup});
  assert.equal(skipped.ok, true, '正常事件行不得因摘要不是逐字引文而被拦下');
  assert.equal(skipped.checked, 1);
  const stillGuarded = auditEventQuotation({...evt, fromTs: T0 + 9000, toTs: T0 + 9999},
    {lookupMessage: lookup});
  assert.equal(stillGuarded.code, 'QUOTE_OUT_OF_WINDOW', '跳过第三重后时间窗校验仍生效');
  const stillIdGuarded = auditEventQuotation({...evt, evidenceIds: ['m-404']},
    {lookupMessage: lookup});
  assert.equal(stillIdGuarded.code, 'QUOTE_ID_MISMATCH', '跳过第三重后来源 id 校验仍生效');
  assert.equal(verifyQuotation({...base, quote: undefined, message: undefined}).code,
    'QUOTE_ID_MISMATCH', '前两重失败不因跳过第三重而放行');
  // 老事件行（无 evidenceIds）放行，向后兼容
  const legacy = { ...evt }; delete legacy.evidenceIds;
  const la = auditEventQuotation(legacy, { lookupMessage: lookup, quote: legacy.summary });
  assert.equal(la.ok, true); assert.equal(la.code, 'NO_EVIDENCE_IDS'); assert.equal(la.checked, 0);
});

// ── ⑤ D11：缺 actorId 标 unattributed、不挂人物档案 ───────────────────────
test('D11：缺 actorId 的 entry 标 unattributed / usableAsEvidence:false；挂 person 被拒', () => {
  const base = JSON.parse(read('interop/examples/minimal-valid.json'));
  // 最小合法样例：entry-002 无 actorId，仍 ok:true，只多 warning + summary 字段
  const good = validateImportDocument(base);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.summary.unattributed, ['entry-002']);
  const warn = good.warnings.find((w) => w.code === 'UNATTRIBUTED_ENTRY');
  assert.ok(warn); assert.equal(warn.index, 1); assert.equal(warn.usableAsEvidence, false);
  assert.ok(!good.errors.some((e) => e.code === 'UNATTRIBUTED_PERSON'));
  // 纯函数与校验器离线镜像口径一致
  assert.deepEqual(unattributedSummary(base).unattributed, good.summary.unattributed);
  // 未署名 + subject.kind:'person' ⇒ ok:false + UNATTRIBUTED_PERSON
  const bad = { ...base, entries: [base.entries[0], { ...base.entries[1], subject: { id: 'ghost', kind: 'person' } }] };
  const r = validateImportDocument(bad);
  assert.equal(r.ok, false);
  const hit = r.errors.find((e) => e.code === 'UNATTRIBUTED_PERSON');
  assert.ok(hit); assert.equal(hit.index, 1); assert.match(hit.path, /entries\[1\]/);
  assert.equal(unattributedSummary(bad).violations.length, 1);
  // 补上 actorId 后不再标 unattributed，也不再触发 person 拒绝
  const fixed = { ...bad, entries: [bad.entries[0], { ...bad.entries[1], actorId: 'u-9' }] };
  const rf = validateImportDocument(fixed);
  assert.equal(rf.ok, true);
  assert.deepEqual(rf.summary.unattributed, []);
  // 导出签名不变
  assert.deepEqual(Object.keys(good).sort(), ['contract', 'errors', 'ok', 'summary', 'warnings']);
});

// ── ⑥ 源码守卫（四道，风格参照 test/recall-policy.mjs:144-201）────────────
test('源码守卫四道：事实层/向量代零改动、vector-active.json 未写、无第二份原文、router 不被碰', () => {
  // 守① git diff：事实层 / 向量代 / 令牌 / 真值源文件对本票零改动
  const guarded = ['src/core/factstore.mjs', 'src/core/vecstore.mjs', 'src/core/vector-generation.mjs',
    'src/core/embed.mjs', 'src/core/tokens.mjs', 'src/core/durable-log.mjs',
    'src/core/input-source.mjs', 'src/core/scene-memory.mjs'];
  const diff = spawnSync('git', ['diff', '--name-only', 'c06e8fe', '--', ...guarded],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(diff.status, 0, `git diff 必须可执行：${diff.error?.message || diff.stderr}`);
  assert.equal(diff.stdout.trim(), '', '票 07 不得修改事实层 / 向量代 / 令牌 / 真值源文件');

  // 守② vector-active.json 未被写（整库扫描，排除 .git / node_modules）
  const hits = [];
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) scan(f); else if (e.name === 'vector-active.json') hits.push(f);
    }
  };
  scan(ROOT);
  assert.deepEqual(hits, [], '不得写出 vector-active.json');

  // 守③ event-gist.mjs 零 I/O；deriveEvidenceIds 限 40 / 去重 / 全字符串 / 只产 id
  const gs = read('src/core/event-gist.mjs');
  for (const w of ['node:fs', 'readFileSync', 'writeFileSync', 'appendFileSync', 'fetch(', 'node:http'])
    assert.ok(!gs.includes(w), `event-gist.mjs 含 ${w}（违反零 I/O）`);
  const many = deriveEvidenceIds({ rows: Array.from({ length: 45 }, (_, i) => ({ id: 'm-' + i, text: '原文-' + i })) });
  assert.equal(many.length, MAX_EVIDENCE_IDS, '限 40');
  assert.ok(many.every((x) => typeof x === 'string' && !x.includes('原文')));
  assert.deepEqual(deriveEvidenceIds({ rows: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }, { id: 'b', text: 'z' }] }),
    ['a', 'b'], '去重');

  // 守④ 接线位置：三重校验在 worker 注入侧，不碰 router.mjs（另一个代理独占）
  const routerSrc = read('src/router.mjs');
  const ws = read('src/standalone/worker.mjs');
  assert.ok(!routerSrc.includes('auditEventQuotation') && !routerSrc.includes('verifyQuotation'),
    '回查闸门不得写进 router.mjs');
  assert.match(ws, /auditEventQuotation\(/, '闸门在 worker.mjs');
  assert.match(ws, /if\(!g\)continue;/, '校验失败在 items.push 前被 continue 拦下');
  assert.match(ws, /quoteAudit/, '留可观测计数/诊断');
  assert.match(ws, /eventRefsOf\(/, '注入引用改用 eventRefsOf');
});
