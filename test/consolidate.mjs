// test/consolidate.mjs — 事件整理（M5）
//
// 这一层几乎全是**静默失败**形态，必须逐条钉住：
//   · 窗口切在"正在聊"的当口 ⇒ 一个话题被劈成两半，两边都读不出完整事件；
//   · LLM 挂了却推进游标 ⇒ 那一段对话**永久丢失**，用户只看到"她记性有洞"，没有任何报错；
//   · 事件 id 不确定 ⇒ 同一窗口重跑写两遍，注入时同一件事念两次；
//   · 认不出 QQ 号却退回昵称 ⇒ 槽挂在一个谁也认不出的人身上；
//   · 事件段不按 chatKey 取 ⇒ 私聊的事被念到群里（社死级，且不会报错）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONSOLIDATE_KINDS,
  tsOfRow,
  cleanText,
  clockOf,
  pickWindows,
  renderTranscript,
  buildConsolidatePrompt,
  parseConsolidateJson,
  extractJsonObject,
  eventIdOf,
  eventRowId,
  eventTextOf,
  renderEventSection,
  readEventLedger,
  readRecentEvents,
  consolidatePaths,
  loadConsolidateState,
  saveConsolidateState,
  readEvidenceRows,
  runConsolidate,
  bumpEventHits,
  readHitLog,
  compactHitLog,
  promoteEvents,
  retireStaleEvents,
  runLayerMaintenance,
  eventRetention,
  eventDimWeight,
  RETIRE_HALFLIFE_GAIN,
  RETIRE_MIN_RECALL,
  RETIRE_HARD_RATIO,
  RETIRE_DIM_WEIGHT,
  PROMOTE_HITS,
  REHEARSAL_COOLDOWN_MS,
  workingLayerOverview,
  salvageJsonObjects,
  WINDOW_FAIL_SKIP
} from '../src/core/consolidate.mjs';
import { buildEventIndex, searchEvents } from '../src/core/event-index.mjs';
import { itemKeyOf, isMultiItemKind, MULTI_ITEM_KINDS } from '../src/core/inject.mjs';

const MIN = 60_000;
const NOW = 1_800_000_000_000;   // 固定"现在"，避免测试跟系统时钟赛跑

function tmp(prefix = 'mv-consol-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一条 evidence 行（字段与宿主实产一致：at/chatKey/speakerId/speakerName/text）。 */
function ev(at, chatKey, qq, name, text, extra = {}) {
  return { at, chatKey, id: `e-${at}-${qq}`, speakerId: String(qq), speakerName: name, text, ...extra };
}

// ── ① 时间戳口径 ────────────────────────────────────────────────────────
test('① tsOfRow：秒/毫秒/at/t/ts 都认，坏值给 0', () => {
  assert.equal(tsOfRow({ at: 1_800_000_000_000 }), 1_800_000_000_000);
  assert.equal(tsOfRow({ at: 1_800_000_000 }), 1_800_000_000_000);     // 秒 ⇒ 毫秒
  assert.equal(tsOfRow({ t: 1_800_000_000_000 }), 1_800_000_000_000);
  assert.equal(tsOfRow({ ts: 1_800_000_000_000 }), 1_800_000_000_000);
  assert.equal(tsOfRow({}), 0);
  assert.equal(tsOfRow({ at: 'x' }), 0);
  assert.equal(tsOfRow(null), 0);
});

test('① cleanText：控制字符/换行/CQ 码都清掉，超长截断', () => {
  assert.equal(cleanText('a\nb\tc'), 'a b c');
  assert.equal(cleanText('你好\u0000世界'), '你好世界');
  assert.equal(cleanText('[CQ:at,qq=123] 在吗'), '在吗');
  assert.ok(cleanText('字'.repeat(400)).length <= 161);
});

// ── ② 窗口切分 ──────────────────────────────────────────────────────────
test('② pickWindows：游标之后才算待整理', () => {
  const rows = [
    ev(NOW - 30 * MIN, 'group:1', '111111', 'A', '旧'),
    ev(NOW - 10 * MIN, 'group:1', '111111', 'A', '新')
  ];
  const all = pickWindows({ rows, now: NOW, settleMs: 0 });
  assert.equal(all.length, 1);
  assert.equal(all[0].msgCount, 2);

  const withCursor = pickWindows({ rows, now: NOW, settleMs: 0, state: { chats: { 'group:1': { lastTs: NOW - 20 * MIN } } } });
  assert.equal(withCursor.length, 1);
  assert.equal(withCursor[0].msgCount, 1, '游标之前的消息不该再被整理');
});

test('② pickWindows：正在聊的那几分钟留给下一轮（settleMs）', () => {
  const rows = [
    ev(NOW - 10 * MIN, 'group:1', '111111', 'A', '沉淀够了'),
    ev(NOW - 1 * MIN, 'group:1', '111111', 'A', '刚说的')
  ];
  const w = pickWindows({ rows, now: NOW, settleMs: 3 * MIN });
  assert.equal(w.length, 1);
  assert.equal(w[0].msgCount, 1, '刚说的那条必须留给下一轮');
  assert.equal(w[0].rows[0].text, '沉淀够了');
});

test('② pickWindows：条数上限与时间跨度上限，谁先到就切', () => {
  const rows = [];
  // 每 10 分钟一条：跨度上限 15min ⇒ 每条自己一个窗口；条数上限 4 ⇒ 4 条一窗
  for (let i = 0; i < 10; i++) rows.push(ev(NOW - (100 - i * 10) * MIN, 'group:1', '111111', 'A', `m${i}`));
  const byMsgs = pickWindows({ rows, now: NOW, settleMs: 0, maxMsgs: 4, maxSpanMs: 999 * MIN, limit: 9 });
  assert.deepEqual(byMsgs.map((w) => w.msgCount), [4, 4, 2]);

  const bySpan = pickWindows({ rows, now: NOW, settleMs: 0, maxMsgs: 999, maxSpanMs: 15 * MIN, limit: 9 });
  assert.ok(bySpan.length >= 3, `时间跨度应切出多窗，实际 ${bySpan.length}`);
  for (const w of bySpan) assert.ok(w.toTs - w.fromTs <= 15 * MIN);
});

test('② pickWindows：会话之间互不串窗，且 limit 是全局闸门', () => {
  const rows = [
    ev(NOW - 30 * MIN, 'group:1', '111111', 'A', 'a'),
    ev(NOW - 29 * MIN, 'group:2', '222222', 'B', 'b'),
    ev(NOW - 28 * MIN, 'group:1', '111111', 'A', 'a2')
  ];
  const w = pickWindows({ rows, now: NOW, settleMs: 0, limit: 9 });
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.chatKey).sort(), ['group:1', 'group:2']);
  assert.equal(w.find((x) => x.chatKey === 'group:1').msgCount, 2);

  const one = pickWindows({ rows, now: NOW, settleMs: 0, limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].chatKey, 'group:1', 'limit=1 时取时间最早的那个窗口（时间线不倒着长）');
});

// ── ③ 提示词正文 ────────────────────────────────────────────────────────
test('③ renderTranscript：每行带 名字(QQ号)，自己的消息标「我」', () => {
  const rows = [
    ev(NOW, 'group:1', '1353446252', '林枫', '我上周搬去成都了'),
    ev(NOW + 1000, 'group:1', '3390614495', '小鱼', '欢迎欢迎'),
    ev(NOW + 2000, 'group:1', 'self', '小萨', '我也欢迎')
  ];
  const t = renderTranscript(rows, { maxChars: 6000 });
  assert.match(t, /林枫\(1353446252\): 我上周搬去成都了/);
  assert.match(t, /小鱼\(3390614495\): 欢迎欢迎/);
  assert.match(t, /我\(小萨\): 我也欢迎/, 'self 不能带一串假号码');
});

test('③ renderTranscript：超预算时均匀抽样并保住最后一条', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(ev(NOW + i * 1000, 'group:1', '111111', 'A', `第${i}条`));
  const t = renderTranscript(rows, { maxChars: 600 });
  assert.ok(t.length <= 900, `抽样后不该还这么长：${t.length}`);
  assert.match(t, /第199条/, '最后一条必须留在里面（最新的最该被记住）');
});

test('③ buildConsolidatePrompt：时间范围与条数进正文（模型要知道这段有多长）', () => {
  const p = buildConsolidatePrompt({
    chatKey: 'group:1', fromTs: NOW, toTs: NOW + 20 * MIN, msgCount: 37, transcript: 'x'
  });
  assert.match(p.user, /group:1/);
  assert.match(p.user, /37 条消息/);
  assert.match(p.system, /只输出一个 JSON 对象/);
  assert.match(p.system, /speaker_profile/);
});

// ── ④ 模型输出解析 ──────────────────────────────────────────────────────
test('④ extractJsonObject：容忍 ```json 围栏与前后废话', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('好的，结果如下：{"a":1} 以上'), { a: 1 });
  assert.equal(extractJsonObject('没有 JSON'), null);
  assert.deepEqual(extractJsonObject('{"a":"}"}'), { a: '}' }, '字符串里的花括号不能当结构');
});

test('④ parseConsolidateJson：非法 kind / 非法 qq 一律丢，不猜', () => {
  const r = parseConsolidateJson(JSON.stringify({
    events: [{ title: '吵架了', detail: 'A 和 B 争起来', at: '15:10', who: ['111111', 'abc'] }],
    people: [
      { qq: '111111', kind: 'speaker_profile', text: '说话短，爱接梗' },
      { qq: '222222', kind: 'speaker-profile', text: '拼错的 kind' },
      { qq: '昵称', kind: 'trait', text: '没给号码' },
      { qq: '333333', kind: 'trait', attr: '', text: '缺属性名' },
      { qq: '444444', kind: 'trait', attr: '职业', text: '在写代码' }
    ]
  }));
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].who, ['111111'], '非号码的 who 要剔掉');
  assert.equal(r.people.length, 2, 'kind 拼错、qq 不是号码、text 空的都要丢');
  assert.equal(r.people[1].attr, '职业');
});

test('④ CONSOLIDATE_KINDS 不含 pattern（成簇判定的产物，不是看一段对话能下的结论）', () => {
  assert.ok(!CONSOLIDATE_KINDS.includes('pattern'));
  assert.ok(CONSOLIDATE_KINDS.includes('speaker_profile'));
  assert.ok(CONSOLIDATE_KINDS.includes('trait'));
});

// ── ⑤ 事件落盘与注入 ────────────────────────────────────────────────────
test('⑤ eventIdOf：同窗口同 id（重跑不能写两遍）', () => {
  const a = eventIdOf({ chatKey: 'group:1098345913', fromTs: NOW, toTs: NOW + 5 * MIN });
  const b = eventIdOf({ chatKey: 'group:1098345913', fromTs: NOW, toTs: NOW + 5 * MIN });
  assert.equal(a, b);
  assert.match(a, /^evt_group_1098345913_\d+_\d+$/);
});

test('⑤ eventTextOf：编号串成一件事一件事的读法', () => {
  assert.equal(
    eventTextOf([{ title: '定了时间', detail: '周六晚上八点' }, { title: '有人退群', detail: '' }]),
    '1. 定了时间：周六晚上八点 2. 有人退群'
  );
});

test('⑤ renderEventSection：空数组 ⇒ 空串（不产出"最近事件："这种空壳标题）', () => {
  assert.equal(renderEventSection([]), '');
  const s = renderEventSection([{ at: '10:23', toTs: NOW + 30 * MIN, summary: '讨论了搬家' }]);
  assert.match(s, /【最近事件/);
  assert.match(s, /10:23 讨论了搬家/, '有 at 就用事件自己的时刻（ADR-0048 一事一行后不再打窗口抬头）');
  // 没 at ⇒ 退回 toTs 的时刻，绝不能渲染出空时间
  assert.match(renderEventSection([{ toTs: NOW + 30 * MIN, summary: 'x' }]), /\d{2}:\d{2} x/);
});

test('⑤ readRecentEvents / readEventLedger：按 chatKey 过滤 + 时间倒序', () => {
  const libDir = tmp();
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const rows = [
    { id: 'e1', chatKey: 'group:1', fromTs: NOW, toTs: NOW + MIN, msgCount: 3, summary: '甲事件' },
    { id: 'e2', chatKey: 'private:9', fromTs: NOW, toTs: NOW + 2 * MIN, msgCount: 3, summary: '私聊事件' },
    { id: 'e3', chatKey: 'group:1', fromTs: NOW, toTs: NOW + 5 * MIN, msgCount: 4, summary: '乙事件' }
  ];
  fs.writeFileSync(p.events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const recent = readRecentEvents({ libDir, chatKey: 'group:1', limit: 5 });
  assert.deepEqual(recent.map((r) => r.id), ['e3', 'e1'], '必须倒序，且不能混进私聊');
  assert.equal(readRecentEvents({ libDir, chatKey: 'group:1', limit: 1 }).length, 1);
  assert.equal(readEventLedger({ libDir, chatKey: 'private:9' })[0].id, 'e2');
});

test('⑤ readRecentEvents：默认跳过已回收（retiredAt）', () => {
  const libDir = tmp();
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const rows = [
    { id: 'alive', chatKey: 'group:1', toTs: NOW + MIN, summary: '活着的' },
    { id: 'dead', chatKey: 'group:1', toTs: NOW + 2 * MIN, summary: '已回收的', retiredAt: '2026-01-01T00:00:00Z' }
  ];
  fs.writeFileSync(p.events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  assert.deepEqual(readRecentEvents({ libDir, chatKey: 'group:1', limit: 9 }).map((r) => r.id), ['alive']);
  assert.equal(readRecentEvents({ libDir, chatKey: 'group:1', limit: 9, includeRetired: true }).length, 2);
});

// ── ⑤b 一事一行（ADR-0048）──────────────────────────────────────────────
test('⑤b eventRowId：确定性 + 1-based 序号', () => {
  assert.equal(eventRowId('evt_group_1_10_20', 0), 'evt_group_1_10_20_1');
  assert.equal(eventRowId('evt_group_1_10_20', 2), 'evt_group_1_10_20_3');
  assert.equal(eventRowId('', 0), '', '没有窗口 id 就不该造出 "_1" 这种孤儿 id');
});

test('⑤b itemKeyOf：多值槽看 kind，trait 必须给属性名', () => {
  assert.equal(itemKeyOf('trait', { attr: '工作' }), '职业', '属性名走别名归并');
  assert.equal(itemKeyOf('trait', {}), '', '没有 attr ⇒ 空串（调用方据此拒写）');
  assert.equal(itemKeyOf('speaker_profile', {}), '整体', '缺 aspect ⇒ 整体（兼容旧 {text} 槽）');
  assert.equal(itemKeyOf('preference', { aspect: '吃' }), '吃');
  assert.equal(itemKeyOf('grudge', { aspect: '称呼' }), '称呼');
  assert.equal(itemKeyOf('preference', { aspect: '  吃  ' }), '吃', '空白要折掉，否则同一方面会并存两份');
  assert.equal(itemKeyOf('event', { aspect: 'x' }), '', '单值 kind 不参与项级 upsert');
  assert.deepEqual([...MULTI_ITEM_KINDS], ['speaker_profile', 'preference', 'grudge']);
  assert.equal(isMultiItemKind('event'), false);
});

/** 只记 put 的假向量库（验证"要不要建向量"这件事，不是验证嵌入本身）。 */
function fakeVecStore() {
  const puts = [];
  return { puts, get: () => null, put: (rec) => { puts.push(rec); } };
}

test('⑤b runConsolidate：一个窗口 3 件事 ⇒ 账本 3 行、共用 windowId、summary 各自独立', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [
    ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '我搬去成都了'),
    ev(NOW - 19 * MIN, 'group:1', '222222', '小鱼', '成都好啊')
  ]);
  const store = fakeVecStore();
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(),
    store, callLlm: async () => JSON.stringify({
      events: [
        { title: '搬家', detail: '林枫说搬去成都', at: '10:00', who: ['111111'] },
        { title: '约火锅', detail: '周六去吃', at: '10:05', who: [] },
        { title: '换头像', detail: '小鱼换了猫图', at: '10:09', who: ['222222'] }
      ],
      people: []
    })
  }, { now: NOW });

  assert.equal(r.events, 3, '落盘的是 3 条事件（不是 1 条窗口）');
  const rows = readEventLedger({ libDir, chatKey: 'group:1' });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((x) => x.windowId)).size, 1, '三条共用同一个窗口 id');
  assert.deepEqual(rows.map((x) => x.idx).sort(), [1, 2, 3]);
  // 每条 summary 只含自己那一件事 —— 这是"一事一行"的核心收益
  const byTitle = Object.fromEntries(rows.map((x) => [x.title, x.summary]));
  assert.match(byTitle['搬家'], /搬家/);
  assert.doesNotMatch(byTitle['搬家'], /火锅/, 'summary 不许把同窗口的别的事拼进来');
  assert.match(byTitle['约火锅'], /周六去吃/);
  // 短期层的运行时字段必须初始化（排练计数从此处起算）
  assert.equal(rows[0].hits, 0);
  assert.equal(rows[0].promotedAt, '');

  // ③ 事件不再自动进向量（要先攒够排练次数）
  assert.equal(store.puts.length, 0, 'eventAutoEmbed 默认关 ⇒ 整理阶段不许建向量');
});

test('⑤b runConsolidate：eventAutoEmbed=true 但没配嵌入端点 ⇒ 只告警，事件照落盘', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', 'x')]);
  const store = fakeVecStore();
  const warns = [];
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: { eventAutoEmbed: true }, normalizer: fakeNormalizer(),
    factStore: fakeFactStore(), store, log: (lv, m) => warns.push(`${lv}:${m}`),
    callLlm: async () => JSON.stringify({ events: [{ title: 'A', detail: '', at: '', who: [] }], people: [] })
  }, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(readEventLedger({ libDir }).length, 1, '向量化失败不许影响落盘');
  assert.equal(store.puts.length, 0);
  assert.ok(warns.some((w) => /事件向量化失败/.test(w)), '必须留下可查的告警');
});

test('⑤b runConsolidate：同一窗口重跑 3 件事不重复（幂等仍按行 id）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', 'x')]);
  const callLlm = async () => JSON.stringify({
    events: [{ title: 'A', detail: '', at: '', who: [] }, { title: 'B', detail: '', at: '', who: [] }],
    people: []
  });
  await runConsolidate({ sourceRoot: root, libDir, settings: { eventAutoEmbed: true }, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: fakeVecStore(), callLlm }, { now: NOW });
  saveConsolidateState({ libDir, state: { version: 1, chats: {} } });   // 模拟重跑
  await runConsolidate({ sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null, callLlm }, { now: NOW });
  assert.equal(readEventLedger({ libDir }).length, 2, '两件事两行，重跑不再加两行');
});

// ── ⑦⑧ 排练计数 / 升长期 / 惰性回收 ──────────────────────────────────
/** 起一个假的 OpenAI 兼容嵌入端点（真要 HTTP，因为 `embedDocuments` 走 fetch）。 */
async function fakeEmbedServer(dim = 8) {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let n = 1;
      try { n = (JSON.parse(body).input || []).length || 1; } catch { /* 按 1 条算 */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: dim }, () => 0.1) }))
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    // ⚠️ 给的是 **base**（embed.mjs 内部 `joinUrl(baseURL, '/embeddings')`）——
    // 写成完整 `…/v1/embeddings` 会被拼成 `…/v1/embeddings/embeddings` ⇒ 404
    baseURL: `http://127.0.0.1:${srv.address().port}/v1`,
    close: () => new Promise((r) => srv.close(r))
  };
}

function writeLedger(libDir, rows) {
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.events, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return p;
}

test('⑥ bumpEventHits：冷却窗口内同一件事只计一次', () => {
  const libDir = tmp();
  const a = bumpEventHits({ libDir, ids: ['e1', 'e2'], now: NOW });
  assert.deepEqual(a.bumped, ['e1', 'e2']);
  // 紧接一轮（同一批事件又被注入）：不重复计数，否则几十秒就攒满 9 次
  const b = bumpEventHits({ libDir, ids: ['e1', 'e2'], now: NOW + 60_000 });
  assert.deepEqual(b.bumped, []);
  assert.equal(b.skipped, 2);
  // 过了冷却 ⇒ 再计一次（"过一会儿又想起它了"，这才算第二次排练）
  const c = bumpEventHits({ libDir, ids: ['e1'], now: NOW + REHEARSAL_COOLDOWN_MS + 1 });
  assert.deepEqual(c.bumped, ['e1']);
  const { counts } = readHitLog({ libDir });
  assert.equal(counts.get('e1').n, 2);
  assert.equal(counts.get('e2').n, 1);
});

test('⑥ readHitLog：坏行只跳过；compact 之后聚合值不变', () => {
  const libDir = tmp();
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.hits, [
    JSON.stringify({ i: 'e1', t: NOW }),
    '{坏行',
    JSON.stringify({ i: 'e1', t: NOW + 1000 }),
    JSON.stringify({ i: 'e2', n: 5, t: NOW + 2000 })
  ].join('\n') + '\n', 'utf8');
  const { counts, badLines } = readHitLog({ libDir });
  assert.equal(badLines, 1);
  assert.equal(counts.get('e1').n, 2);
  assert.equal(counts.get('e2').n, 5);
  const before = [...counts.entries()].map(([k, v]) => `${k}:${v.n}`).sort().join(',');
  const c = compactHitLog({ libDir });
  assert.equal(c.compacted, 2);
  const after = [...readHitLog({ libDir }).counts.entries()].map(([k, v]) => `${k}:${v.n}`).sort().join(',');
  assert.equal(after, before, 'compact 不许改变聚合结果');
});

test('⑧ promoteEvents：攒够 9 次才建向量，不够的一条都不碰', async () => {
  const libDir = tmp();
  const base = { chatKey: 'group:1', fromTs: NOW - MIN, toTs: NOW, msgCount: 10, createdAt: new Date(NOW - MIN).toISOString() };
  writeLedger(libDir, [
    { ...base, id: 'hot', windowId: 'w1', idx: 1, title: '露营', summary: '露营：约好周六去', hits: 0 },
    { ...base, id: 'warm', windowId: 'w1', idx: 2, title: '显卡', summary: '显卡：聊 5080', hits: 0 }
  ]);
  for (let k = 0; k < PROMOTE_HITS; k++) bumpEventHits({ libDir, ids: ['hot'], now: NOW + k * (REHEARSAL_COOLDOWN_MS + 1) });
  for (let k = 0; k < PROMOTE_HITS - 1; k++) bumpEventHits({ libDir, ids: ['warm'], now: NOW + k * (REHEARSAL_COOLDOWN_MS + 1) });

  const ep = await fakeEmbedServer();
  const store = { puts: [], get: () => null, put(rec) { this.puts.push(rec); } };
  const r = await promoteEvents({
    libDir, store, normalizer: fakeNormalizer(), now: NOW + 10 * MIN,
    settings: { embedBaseURL: ep.baseURL, embedModel: 'fake' }
  });
  await ep.close();

  assert.equal(r.promoted, 1, `failed=${r.failed} reason=${r.reason}`);
  assert.deepEqual(r.ids, ['hot']);
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].id, 'hot');
  const rows = readEventLedger({ libDir });
  assert.ok(rows.find((x) => x.id === 'hot').promotedAt, '升过长期的要留时间戳（回收据此跳过）');
  assert.ok(!rows.find((x) => x.id === 'warm').promotedAt, '没攒够的不许动');
});

test('⑧ promoteEvents：没配嵌入端点 ⇒ 明确说明，不假装升过', async () => {
  const libDir = tmp();
  writeLedger(libDir, [{ id: 'hot', chatKey: 'group:1', title: 'x', summary: 'x', hits: 99 }]);
  const r = await promoteEvents({ libDir, store: {}, settings: {} });
  assert.equal(r.promoted, 0);
  assert.equal(r.reason, 'embed-unconfigured');
  assert.ok(!readEventLedger({ libDir })[0].promotedAt);
});

test('⑦ retireStaleEvents：只看惰性（max(最后排练, 出生)），升过长期的不回收', () => {
  const libDir = tmp();
  const old = new Date(NOW - 40 * 24 * 3600_000).toISOString();
  const fresh = new Date(NOW - 2 * 24 * 3600_000).toISOString();
  writeLedger(libDir, [
    { id: 'stale', chatKey: 'group:1', title: '旧事', summary: '旧事', createdAt: old, toTs: NOW - 40 * 24 * 3600_000 },
    // 40 天前出生，但昨天被排练过 ⇒ 最该留的那条
    { id: 'revived', chatKey: 'group:1', title: '老梗', summary: '老梗', createdAt: old, toTs: NOW - 40 * 24 * 3600_000 },
    { id: 'promoted', chatKey: 'group:1', title: '已升长期', summary: '已升长期', createdAt: old, promotedAt: old, toTs: NOW - 40 * 24 * 3600_000 },
    { id: 'young', chatKey: 'group:1', title: '新事', summary: '新事', createdAt: fresh, toTs: NOW - 2 * 24 * 3600_000 }
  ]);
  bumpEventHits({ libDir, ids: ['revived'], now: NOW - 24 * 3600_000 });
  const r = retireStaleEvents({ libDir, days: 30, now: NOW });
  // `ADR-0048 ⑪`：闲置 40 天（hits=0）⇒ 保持率 ≈0.046 —— 跌破了 rMin=0.1，
  // 但**没跌破**硬阈值 0.03 ⇒ 只**变暗**，不再直接出索引。这是软回收的全部意义。
  assert.deepEqual(r.ids, [], '40 天还没到硬阈值，不该出索引');
  assert.deepEqual(r.dimmedIds, ['stale']);
  const rows = Object.fromEntries(readEventLedger({ libDir }).map((x) => [x.id, x]));
  assert.ok(!rows.stale.retiredAt, '跌破 rMin 只该变暗');
  assert.ok(rows.stale.dimmedAt, '变暗要落盘，否则索引侧看不见');
  assert.ok(!rows.revived.retiredAt, '按出生时间算会误杀"一年前但最近常被提起"的');
  assert.ok(!rows.promoted.retiredAt, '升过长期的不回收');
  assert.ok(!rows.young.retiredAt, '新事件不回收');
  // 回收只打标记，不删数据
  assert.equal(readEventLedger({ libDir, limit: 99 }).length, 4);
});
test('⑩ eventRetention：锚点与旧阈值逐位等价，额度随排练线性变长', () => {
  // **锚点**（这次改造不回退的唯一依据）：0 次排练、idleDays === days ⇒ 正好跌到阈值
  const at30 = eventRetention({ idleDays: 30, hits: 0, days: 30 });
  assert.ok(Math.abs(at30.retention - 0.1) < 1e-9, `锚点保持率应为 0.1，实际 ${at30.retention}`);
  assert.ok(Math.abs(at30.retireAfterDays - 30) < 1e-9, '0 次排练的额度必须正好等于 days');
  // 边界行为与旧判据一致：29 天还在，31 天已忘
  assert.ok(eventRetention({ idleDays: 29, hits: 0, days: 30 }).retention > 0.1);
  assert.ok(eventRetention({ idleDays: 31, hits: 0, days: 30 }).retention < 0.1);

  // ⚠️ 代数事实，必须在测试里钉死：解 R = rMin 时 rMin 被约掉 ⇒
  // 额度 = days·(1 + gain·hits)。这意味着**判据本身等价于线性延长**，
  // 指数形状只在"展示强度值"时有独立意义。
  for (const hits of [0, 1, 3, 8]) {
    const c = eventRetention({ idleDays: 0, hits, days: 30, gain: 0.4 });
    assert.ok(Math.abs(c.retireAfterDays - 30 * (1 + 0.4 * hits)) < 1e-9, `hits=${hits}`);
  }
  const a = eventRetention({ idleDays: 0, hits: 3, rMin: 0.1 });
  const b = eventRetention({ idleDays: 0, hits: 3, rMin: 0.5 });
  assert.ok(Math.abs(a.retireAfterDays - b.retireAfterDays) < 1e-9, '额度与 rMin 无关');
  assert.ok(b.halfLifeDays > a.halfLifeDays, '阈值越宽松（越容易判忘）⇒ 同样额度需要更长的半衰期');

  // 单调：排练越多 ⇒ 半衰期越长、闲置同样天数后剩得越多
  const rs = [0, 1, 3, 8].map((hits) => eventRetention({ idleDays: 40, hits }));
  for (let i = 1; i < rs.length; i++) {
    assert.ok(rs[i].retention > rs[i - 1].retention, `hits 多的该剩更多（${i}）`);
    assert.ok(rs[i].halfLifeDays > rs[i - 1].halfLifeDays);
  }
  // gain=0 ⇒ 完全退化成旧的固定阈值（紧急回退开关）
  assert.ok(Math.abs(eventRetention({ idleDays: 0, hits: 8, gain: 0 }).retireAfterDays - 30) < 1e-9);
  // 时钟回拨：`idleDays` 为负被截成 0 ⇒ 保持率封顶 1 ⇒ 绝不回收（安全侧）
  assert.equal(eventRetention({ idleDays: -5, hits: 0 }).retention, 1);
});
test('⑩ retireStaleEvents：同样闲置 40 天，被想起过 3 次的留下、0 次的回收', () => {
  const libDir = tmp();
  const D = 86400000;
  const old = new Date(NOW - 40 * D).toISOString();
  writeLedger(libDir, [
    { id: 'never', chatKey: 'group:1', title: '没人提过', summary: 'x', createdAt: old, toTs: NOW - 40 * D, hits: 0 },
    { id: 'thrice', chatKey: 'group:1', title: '被提过 3 次', summary: 'x', createdAt: old, toTs: NOW - 40 * D, hits: 3 }
  ]);
  const r = retireStaleEvents({ libDir, days: 30, now: NOW });
  assert.deepEqual(r.ids, [], '40 天只到"变暗"，没到硬回收');
  assert.deepEqual(r.dimmedIds, ['never'], '额度 30 天的该变暗；额度 66 天的才闲置 40 天，不该');
  const rows = Object.fromEntries(readEventLedger({ libDir }).map((x) => [x.id, x]));
  assert.ok(rows.never.dimmedAt);
  assert.ok(!rows.thrice.dimmedAt, '被想起过的活得久 —— 这正是曲线相对固定阈值的唯一增量');
  // 配置关掉增益 ⇒ 退化成旧行为：两条都变暗
  const libDir2 = tmp();
  writeLedger(libDir2, [
    { id: 'never', chatKey: 'group:1', title: 'a', summary: 'a', createdAt: old, toTs: NOW - 40 * D, hits: 0 },
    { id: 'thrice', chatKey: 'group:1', title: 'b', summary: 'b', createdAt: old, toTs: NOW - 40 * D, hits: 3 }
  ]);
  const r2 = retireStaleEvents({ libDir: libDir2, days: 30, now: NOW, gain: 0 });
  assert.deepEqual(r2.dimmedIds.sort(), ['never', 'thrice'], 'gain=0 时必须完全退化成固定 30 天');
});

// ── ⑪ 软回收三态（`ADR-0048 ⑪`，从仿生记忆模块 v1.6.8 的 `forget(soft)` 学到的闭环）──
test('⑪ eventDimWeight：跌破才降权，且降到底有个下限', () => {
  assert.equal(eventDimWeight({ retention: 1, rMin: 0.1 }), 1, '没暗 ⇒ 权重 1');
  assert.equal(eventDimWeight({ retention: 0.1, rMin: 0.1 }), 1, '刚好在阈值上也算没暗');
  // 连续取值，不是一刀切：刚跌破一点点不该被重罚
  assert.ok(Math.abs(eventDimWeight({ retention: 0.05, rMin: 0.1 }) - 0.5) < 1e-9);
  assert.ok(Math.abs(eventDimWeight({ retention: 0.03, rMin: 0.1 }) - 0.3) < 1e-9);
  // 下限：`RETIRE_DIM_WEIGHT`，再淡也留得住（变暗 ≠ 消失）
  assert.equal(eventDimWeight({ retention: 0.0001, rMin: 0.1 }), RETIRE_DIM_WEIGHT);
  assert.equal(eventDimWeight({ retention: 0, rMin: 0.1 }), RETIRE_DIM_WEIGHT);
  // 与硬阈值的关系必须成立：跌到硬阈值时权重正好触底，不会"先消失再被判已回收"
  assert.ok(Math.abs(eventDimWeight({ retention: RETIRE_MIN_RECALL * RETIRE_HARD_RATIO, rMin: RETIRE_MIN_RECALL })
    - RETIRE_DIM_WEIGHT) < 1e-9);
});
test('⑪ retireStaleEvents 三态：40 天变暗、50 天出索引、被想起的会复活', () => {
  const D = 86400000;
  const libDir = tmp();
  const at = (d) => new Date(NOW - d * D).toISOString();
  writeLedger(libDir, [
    { id: 'dim', chatKey: 'group:1', title: '变暗', summary: 'x', createdAt: at(40), toTs: NOW - 40 * D, hits: 0 },
    { id: 'gone', chatKey: 'group:1', title: '硬回收', summary: 'x', createdAt: at(50), toTs: NOW - 50 * D, hits: 0 }
  ]);
  // hits=0 ⇒ H=13.03 天：硬阈值 0.03 落在 ≈45.7 天 ⇒ 40 天变暗、50 天出索引
  const r = retireStaleEvents({ libDir, days: 30, now: NOW });
  assert.deepEqual(r.dimmedIds, ['dim']);
  assert.deepEqual(r.ids, ['gone']);
  const rows = Object.fromEntries(readEventLedger({ libDir }).map((x) => [x.id, x]));
  assert.ok(rows.dim.dimmedAt && !rows.dim.retiredAt);
  assert.ok(rows.gone.retiredAt);

  // ── 复活：这是软回收的另一半，没有它"变暗"只是把死刑推迟几天 ──
  // 给 `dim` 补一次排练（昨天）⇒ 保持率回升过 rMin ⇒ 下次整理清掉 `dimmedAt`
  bumpEventHits({ libDir, ids: ['dim'], now: NOW - 1 * D });
  const r2 = retireStaleEvents({ libDir, days: 30, now: NOW });
  assert.deepEqual(r2.revivedIds, ['dim'], '真被想起过 ⇒ 该亮回来');
  const after = Object.fromEntries(readEventLedger({ libDir }).map((x) => [x.id, x]));
  assert.ok(!after.dim.dimmedAt, '复活的标志是 dimmedAt 被清掉');
  assert.ok(!after.dim.retiredAt);
  // 没被想起的那条不受影响
  assert.ok(after.gone.retiredAt);
  // 数据一行都没删
  assert.equal(readEventLedger({ libDir, limit: 99 }).length, 2);
});
test('⑪ 变暗的行仍在关键词索引里，但分数降到约 RETIRE_DIM_WEIGHT 倍', () => {
  const libDir = tmp();
  const D = 86400000;
  writeLedger(libDir, [
    { id: 'bright', chatKey: 'group:1', title: '露营装备', summary: '买了登山杖和帐篷', toTs: NOW - D },
    // 同一件事的"变暗版"：内容几乎一样，但 idle 到跌破阈值
    { id: 'dim', chatKey: 'group:1', title: '露营装备', summary: '买了登山杖和帐篷', toTs: NOW - 40 * D, dimmedAt: new Date(NOW - D).toISOString() }
  ]);
  const idx = buildEventIndex(readEventLedger({ libDir }));
  assert.equal(idx.dropped, 0, '变暗**不是**出索引 —— 出索引是旧行为的 bug 面');
  assert.equal(idx.N, 2);
  const hits = searchEvents(idx, '露营装备', { chatKey: 'group:1', limit: 10, minScore: 0 });
  const byId = Object.fromEntries(hits.map((h) => [h.id, h.score]));
  assert.ok(byId.bright > byId.dim, '变暗的必须排在亮的后面');
  assert.ok(byId.dim > 0, '变暗的必须还能被找到（软回收的意义）');
  assert.ok(Math.abs(byId.dim / byId.bright - RETIRE_DIM_WEIGHT) < 0.02,
    `变暗权重应约等于 ${RETIRE_DIM_WEIGHT}，实际 ${(byId.dim / byId.bright).toFixed(4)}`);
});
test('⑨ 短期层概览：队列分得对（快升长期 / 快被回收 / 未排练 / 已回收）', () => {
  const libDir = tmp('mv-lib-');
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const NOW = Date.now();
  const D = 86400000;
  const row = (id, o = {}) => JSON.stringify({
    id, chatKey: o.chatKey || 'group:1', title: `事-${id}`, summary: `摘要-${id}`,
    toTs: o.toTs ?? NOW - 2 * D, createdAt: new Date(o.born ?? (NOW - 2 * D)).toISOString(),
    hits: o.hits ?? 0, lastHitAt: o.lastHitAt ?? 0,
    promotedAt: o.promotedAt || '', retiredAt: o.retiredAt || ''
  });
  fs.writeFileSync(p.events, [
    row('hot', { hits: 8, lastHitAt: NOW - D }),        // 快升长期（8/9）
    row('warm', { hits: 2, lastHitAt: NOW - D }),       // 普通
    row('fresh', { hits: 0 }),                          // 从未排练
    // 闲置 35 天 ⇒ 快被回收。**额度随排练变长**（hits=1 ⇒ 42 天），所以判据是
    // "剩不到自己额度的 30%"（≤12.6 天），不再是统一的 30*0.7；35 天闲置 ⇒ 还剩 7 天 ⇒ 进队。
    // 出生必须**早于**最后一次被想起，否则 `max(lastHitAt, born)` 取到出生时间。
    row('idle', { hits: 1, lastHitAt: NOW - 35 * D, born: NOW - 40 * D, toTs: NOW - 40 * D }),
    row('promoted', { hits: 9, promotedAt: new Date(NOW - D).toISOString() }),
    row('dead', { hits: 0, retiredAt: new Date(NOW - D).toISOString() }),
    row('superseded', { hits: 3, supersededBy: ['x'] }) // 被历史拆分替代 ⇒ 不该出现在任何队列
  ].join('\n') + '\n');

  const ov = workingLayerOverview({ libDir, now: NOW, promoteHits: 9, retireDays: 30, limit: 8 });

  assert.equal(ov.counts.working, 5, '短期层 5 条（已升长期的 1 + 在短期 4… 见下）');
  assert.equal(ov.counts.promoted, 1);
  assert.equal(ov.counts.retired, 1);
  assert.equal(ov.counts.fresh, 1);

  const ids = (q) => (ov.queues[q] || []).map((x) => x.id);
  assert.deepEqual(ids('nearPromote'), ['hot'], '8/9 该进"快升长期"，2/9 不该');
  assert.deepEqual(ids('idleSoon'), ['idle'], '闲置 35 天（额度 42）该进，1 天的不该');
  assert.deepEqual(ids('fresh'), ['fresh']);
  assert.deepEqual(ids('promoted'), ['promoted']);
  assert.deepEqual(ids('retired'), ['dead']);
  assert.ok(!JSON.stringify(ov.queues).includes('superseded'), '被拆替代的旧窗口行不进任何队列');

  // 进度条要能算：命中次数与闲置天数都得给出来（面板据此画条）
  assert.equal(ov.queues.nearPromote[0].hits, 8);
  assert.equal(ov.queues.idleSoon[0].idleDays, 35);
  // 遗忘曲线字段：闲置 35 天 / 排练 1 次 ⇒ 半衰期 18.2 天、额度 42 天、还剩 7 天、保持率 ≈0.147
  assert.equal(ov.queues.idleSoon[0].halfLifeDays, 18.2);
  assert.equal(ov.queues.idleSoon[0].retireAfterDays, 42);
  assert.equal(ov.queues.idleSoon[0].retireInDays, 7);
  assert.ok(ov.queues.idleSoon[0].retention > 0.1 && ov.queues.idleSoon[0].retention < 0.2);
  assert.equal(ov.thresholds.promoteHits, 9);
  assert.equal(ov.thresholds.retireDays, 30);
  assert.equal(ov.thresholds.retireHalfLifeGain, RETIRE_HALFLIFE_GAIN);
  assert.equal(ov.thresholds.retireMinRecall, RETIRE_MIN_RECALL);
});

// ── ⑥ 主流程（用假 LLM / 假事实库，不联网）────────────────────────────────
function fakeNormalizer() {
  const known = { '111111': '〔P1〕', '222222': '〔P2〕' };
  return {
    resolveKnown(id) {
      const k = String(id).replace(/^qq:/, '');
      return known[k] ? { id: `qq:${k}`, label: known[k], kind: 'person' } : null;
    },
    scopeLabel(chatKey) { return chatKey.startsWith('group:') ? 'group:C1' : 'private:C2'; },
    normalize(text) {
      // ⚠️ `stats.hits` 是真实归一化器的契约（`chunkread.mjs:199` 读它做"替了几处"的统计）
      // ⇒ 假实现也必须给，否则升长期那条路会静默抛 `reading 'hits'`
      return {
        text: String(text).replace(/111111/g, '〔P1〕').replace(/222222/g, '〔P2〕'),
        stats: { hits: 0 }
      };
    },
    // 出境闸门（`chunkread.mjs:178` + `embed.mjs:381`）：升长期要把事件正文送去嵌入，
    // 这条路要求真实的归一化器契约 —— `assertNoEntityForm`（构建期）
    // 与 `findLeak` / `findEntityForm`（联网前自检）。缺一个就静默失败成"升不上去"。
    assertNoEntityForm(text) { if (/\d{5,15}/.test(String(text))) throw new Error(`文本里还有实体形态：${text.slice(0, 40)}`); },
    findLeak(text) { const m = String(text).match(/\d{5,15}/); return m ? { term: m[0], layer: 'qq' } : null; },
    findEntityForm(text) { const m = String(text).match(/@\S{1,12}/); return m ? { kind: 'at', sample: m[0] } : null; }
  };
}

function fakeFactStore() {
  const slots = new Map();
  const calls = [];
  return {
    readOnlyReason: null,
    calls,
    getSlot({ speaker, target, fact_kind, scope }) {
      return slots.get(`${speaker}|${target}|${fact_kind}|${scope}`) || null;
    },
    put(args) {
      calls.push(args);
      const key = `${args.speaker}|${args.target}|${args.fact_kind}|${args.scope}`;
      const prev = slots.get(key);
      const fp = JSON.stringify(args.content);
      if (prev && prev.fp === fp) return { action: 'noop', rev: prev.rev, key };
      const rev = (prev?.rev || 0) + 1;
      slots.set(key, { fp, rev, content: args.content });
      return { action: 'update', rev, key };
    }
  };
}

function mkEvidence(sourceRoot, rows) {
  fs.mkdirSync(path.join(sourceRoot, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'memory', 'evidence.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );
}

test('⑥ runConsolidate：产事件 + 写人物印象 + 推进游标', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [
    ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '我搬去成都了'),
    ev(NOW - 19 * MIN, 'group:1', '222222', '小鱼', '成都好啊')
  ]);
  const factStore = fakeFactStore();
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore,
    store: null, callLlm: async () => JSON.stringify({
      events: [{ title: '搬家', detail: '林枫说搬去成都', at: '10:00', who: ['111111'] }],
      people: [
        { qq: '111111', kind: 'trait', attr: '所在地', text: '成都' },
        { qq: '222222', kind: 'speaker_profile', text: '爱附和，说话短' }
      ]
    })
  }, { now: NOW });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.windows, 1);
  assert.equal(r.events, 1);
  assert.equal(r.slots, 2);
  assert.equal(factStore.calls.length, 2);
  assert.equal(factStore.calls[0].scope, 'group:C1', 'scope 必须由 chatKey 派生');
  assert.equal(factStore.calls[0].content.source, 'consolidate', '出处要能跟直写区分开');
  assert.equal(factStore.calls[0].content.items[0].v, '成都');
  assert.equal(r.details[0].chatKey, 'group:1');

  const state = loadConsolidateState({ libDir });
  assert.equal(state.chats['group:1'].lastTs, NOW - 19 * MIN, '游标要停在窗口末端');

  // 事件账本落了、且摘要里没有裸 QQ 号（归一化闸门）
  const ledger = readEventLedger({ libDir, chatKey: 'group:1' });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].msgCount, 2);
});

test('⑥ runConsolidate：重跑同一窗口不重复写事件（幂等）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '我搬去成都了')]);
  const callLlm = async () => JSON.stringify({ events: [{ title: '搬家', detail: '', at: '', who: [] }], people: [] });

  await runConsolidate({ sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null, callLlm }, { now: NOW });
  // 把游标退回起点，模拟"重跑"
  saveConsolidateState({ libDir, state: { version: 1, chats: {} } });
  await runConsolidate({ sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null, callLlm }, { now: NOW });

  assert.equal(readEventLedger({ libDir }).length, 1, '同 id 只该有一行');
});

test('⑥ runConsolidate：LLM 挂了 ⇒ 游标不推进（下次重试，不永久丢）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '重要的事')]);

  const bad = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => { throw new Error('503'); }
  }, { now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.failedWindows, 1);
  assert.equal(bad.skippedWindows, 0, '第一次失败只是重试，不认输');
  const st1 = loadConsolidateState({ libDir }).chats['group:1'] || {};
  assert.ok(!st1.lastTs, '失败绝不能推进游标（`fails` 簿记可以有，`lastTs` 不能有）');
  assert.equal(st1.fails?.[String(Math.floor(NOW - 20 * MIN))]?.n, 1, '失败要记账 —— 攒够次数才能认输跳过');

  // 下游重试能捞回来
  const good = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => JSON.stringify({ events: [{ title: '救回来了', detail: '', at: '', who: [] }], people: [] })
  }, { now: NOW });
  assert.equal(good.ok, true);
  assert.equal(readEventLedger({ libDir }).length, 1);
});

test('⑥ 截断抢救：输出被 maxTokens 切掉一半 ⇒ 前面完整的事件照记，不整段作废', () => {
  // 实测样本（2026-10-23 主号 dryRun）：窗口 group:1130569413 的回复在第二个事件的
  // detail 中间被切断 ⇒ `extractJsonObject` 判死 ⇒ 改前整窗作废 + 游标卡住。
  const cut = '{"events":[{"title":"秋颜月色连串提问试探大肥鱼","detail":"他先后问时间、可口可乐、凉白'
    + '开，大肥鱼一律故意听错。","at":"16:08","who":["2510078418"]},{"title":"另一件事","det';
  const dead = parseConsolidateJson(cut);
  assert.equal(dead.ok, true, '截断不该判死 —— 前面有完整事件');
  assert.equal(dead.salvaged, true, '要标出来：这是抢救，不是完整解析（后面被切掉了）');
  assert.equal(dead.events.length, 1, '只收完整那个；半截的必须丢');
  assert.equal(dead.events[0].title, '秋颜月色连串提问试探大肥鱼');

  // 抢救也要过同一套校验：不合规的元素照样丢
  const junk = '{"events":[{"title":"","detail":""},{"title":"真事","detail":"x","at":"","who":["abc"]}]';
  assert.equal(parseConsolidateJson(junk).events.length, 1);
  // 真的一句 JSON 都没有 ⇒ 该判死还得判死
  assert.equal(parseConsolidateJson('抱歉，我不太确定').ok, false);
});

test('⑥ 坏窗认输：同一窗连续失败 3 次 ⇒ 推进游标放过它（否则后面永远轮不到）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  // 两个窗口：**老的那个**必然失败、**新的那个**能成功。
  // 没有认输机制时，老的会永久堵死新的 —— 这正是要钉住的失败形态。
  // ⚠️ 两条必须落在**两个**窗口里：间隔要大于 `pickWindows` 的 `maxSpanMs`（2h），
  //    否则它们被并进同一个窗口，就测不到"坏窗堵死后面"这件事。
  mkEvidence(root, [
    ev(NOW - 200 * MIN, 'group:1', '111111', '林枫', '重要的事'),
    ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '另一件重要的事')
  ]);
  const bad = async () => { throw new Error('503'); };
  const opt = { now: NOW };
  const base = { sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null };

  // 前两轮：老窗口撞 503；同会话后窗等待，不允许越过未确认的缺口。
  let r = await runConsolidate({ ...base, callLlm: bad }, opt);
  assert.equal(r.failedWindows, 1);
  assert.equal(r.skippedWindows, 0, '第一次只是重试');
  r = await runConsolidate({ ...base, callLlm: bad }, opt);
  assert.equal(r.skippedWindows, 0, '第二次仍只是重试');

  // 第三轮：**老窗口继续失败**（n=3 ⇒ 认输跳过），新窗口正常 ⇒ 必须能落库。
  // 没有认输机制时，老窗口会把游标钉死，新窗口永远轮不到 —— 这就是要钉的形态。
  const oldFails = async (p) => {
    if (String(p.user).includes('另一件')) {
      return JSON.stringify({ events: [{ title: '新窗口', detail: '它得记下来', at: '', who: [] }], people: [] });
    }
    throw new Error('503');
  };
  r = await runConsolidate({ ...base, callLlm: oldFails }, opt);
  assert.equal(r.skippedWindows, 1, '第三次 ⇒ 认输跳过那个坏窗');
  const titles = readEventLedger({ libDir }).map((x) => x.title);
  assert.deepEqual(titles, ['新窗口'], `认输之后必须能继续往前走，实际：${JSON.stringify(titles)}`);

  // 认输**不清账**：失败记录留着给面板/排障看（跳过≠静默丢弃）
  const st = loadConsolidateState({ libDir }).chats['group:1'] || {};
  const failN = Object.values(st.fails || {}).map((f) => f.n);
  assert.ok(failN.includes(3), `失败账本里要留着「试过 3 次」，实际：${JSON.stringify(failN)}`);
});

test('⑥ runConsolidate：模型回的不是 JSON ⇒ 算失败，不写空事件', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', 'A', 'x')]);
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => '抱歉，我不太确定'
  }, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(readEventLedger({ libDir }).length, 0);
});

test('⑥ runConsolidate：认不出的 QQ 号 ⇒ 丢弃并计数，不退回昵称', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '999999', '陌生人', '路过')]);
  const factStore = fakeFactStore();
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore, store: null,
    callLlm: async () => JSON.stringify({
      events: [], people: [{ qq: '999999', kind: 'speaker_profile', text: '话很少' }]
    })
  }, { now: NOW });
  assert.equal(r.skippedPeople, 1);
  assert.equal(factStore.calls.length, 0, '认不出的人不许写槽');
});

test('⑥ runConsolidate：读不到 evidence ⇒ 标明降级（不许伪装成"没有新消息"）', async () => {
  const libDir = tmp('mv-lib-');
  const r = await runConsolidate({
    sourceRoot: tmp('mv-empty-'), libDir, settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => '{}'
  }, { now: NOW });
  // 不再整轮失败（层维护跟这本账无关，见 ⑧ 组），但**必须**让人分得清
  // "确实没有新消息"和"根本不知道有哪些消息" —— 后者不能长得像前者。
  assert.equal(r.ok, true, '维护跑完了，不该整轮判失败');
  assert.equal(r.windows, 0);
  assert.equal(r.evidenceMissing, true);
  assert.equal(r.degraded.code, 'EVIDENCE_MISSING');
  assert.equal(r.error, '', 'error 是"整轮失败"的字段，降级不能用它');

  // 反向对照：正常的"没有新消息"那一轮**不许**带这个标记
  const root2 = tmp('mv-src-');
  mkEvidence(root2, []);
  const clean = await runConsolidate({
    sourceRoot: root2, libDir: tmp('mv-lib-'), settings: {}, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => '{}'
  }, { now: NOW });
  assert.equal(clean.windows, 0);
  assert.equal(clean.evidenceMissing, undefined, '没有新消息 ≠ 账本读不到');
  assert.equal(clean.degraded, undefined);
});

test('⑥ runConsolidate：dryRun 只调模型、不落盘、不推进游标', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', 'x')]);
  const factStore = fakeFactStore();
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(), factStore, store: null,
    callLlm: async () => JSON.stringify({ events: [{ title: 'A', detail: '', at: '', who: [] }], people: [] })
  }, { now: NOW, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.details[0].dryRun, true);
  assert.equal(factStore.calls.length, 0);
  assert.equal(readEventLedger({ libDir }).length, 0);
  assert.equal(loadConsolidateState({ libDir }).chats['group:1'], undefined);
});

test('⑥ readEvidenceRows：坏行只计数（一次断电不能永久堵死整理）', () => {
  const root = tmp('mv-src-');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'memory', 'evidence.jsonl'),
    `${JSON.stringify(ev(NOW, 'group:1', '111111', 'A', 'ok'))}\n{半行坏数据\n${JSON.stringify(ev(NOW + 1, 'group:1', '111111', 'A', 'ok2'))}\n`,
    'utf8'
  );
  const r = readEvidenceRows({ sourceRoot: root });
  assert.equal(r.rows.length, 2);
  assert.equal(r.badLines, 1);
});

// ── ⑦ 层维护与"有没有新窗口"解耦（新票 06 · [by:DS] 2026-10-29）────────────
//
// 上一版把 `promotion → retirement` 写在 `runConsolidate` 的**函数尾部**，而
// "没有可整理的窗口"那条分支在到达尾部之前就 `return` 了。后果不是"少跑几次"，是**方向性错**：
// 越冷清的会话越不会被回收 —— 而遗忘曲线的全部意义是"没人说话时也在变淡"。
// 下面每条都钉住一个具体形态，且**只用固定时钟**（`NOW`），不跟系统时钟赛跑。

const DAY_MS = 86_400_000;

/** 手写事件账本（只为本组用例：这里测的是维护，不是整理落盘）。 */
function mkEventLedger(libDir, rows) {
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p.events;
}
const ledRow = (id, ageDays, extra = {}) => {
  const ts = NOW - ageDays * DAY_MS;
  return {
    id, chatKey: 'group:1', title: id, summary: id, fromTs: ts, toTs: ts,
    createdAt: new Date(ts).toISOString(), hits: 0, promotedAt: '', retiredAt: '', dimmedAt: '',
    supersededBy: '', ...extra
  };
};

test('⑦ 没有窗口时维护照跑：陈年事件照样变暗/回收（不是"没窗口就什么都不做"）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, []);                        // 没有新消息 ⇒ 0 个窗口
  mkEventLedger(libDir, [ledRow('ev-dim', 40), ledRow('ev-gone', 90)]);
  let llmCalls = 0;
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {},
    normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => { llmCalls += 1; return JSON.stringify({ events: [], people: [] }); }
  }, { now: NOW });

  assert.equal(r.windows, 0);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.maintenance.ran, true, '没有窗口也必须跑维护');
  assert.equal(llmCalls, 0, '维护不该调模型');
  // 没有向量库 / 没有嵌入端点时，升长期**必须说明原因**（`no-store` / `embed-unconfigured`），
  // 而不是报一个"0 条已升"的假成功 —— 后者会让面板以为"今天没什么可升的"。
  assert.equal(r.promotion.promoted, 0);
  assert.ok(['no-store', 'embed-unconfigured'].includes(r.promotion.reason), `升长期应说明原因，实际 ${r.promotion.reason}`);
  assert.equal(r.retirement.dimmed, 1, '40 天未排练 ⇒ 变暗（retention 跌破 rMin）');
  assert.equal(r.retirement.retired, 1, '90 天未排练 ⇒ 硬回收');
  const rows = readEventLedger({ libDir });
  assert.ok(rows.find((x) => x.id === 'ev-dim').dimmedAt, '变暗要落盘（面板靠它显示三态）');
  assert.ok(rows.find((x) => x.id === 'ev-gone').retiredAt, '回收要落盘');
});

test('⑦ 被想起来了就复亮：dimmed 行 + 新排练 ⇒ revived，dimmedAt 清空', async () => {
  const libDir = tmp('mv-lib-');
  const p = mkEventLedger(libDir, [ledRow('ev-back', 40, { dimmedAt: new Date(NOW - DAY_MS).toISOString() })]);
  // 排练日志：这一次"想起"发生在 NOW（idle 归零 ⇒ 保持率回到 1）
  fs.writeFileSync(consolidatePaths(libDir).hits, `${JSON.stringify({ i: 'ev-back', n: 1, t: NOW })}\n`, 'utf8');

  const layer = await runLayerMaintenance({ libDir, store: null, settings: {}, now: NOW });
  assert.equal(layer.retirement.revived, 1, '排练回来必须复亮（否则排练对可见性毫无意义）');
  const row = readEventLedger({ libDir }).find((x) => x.id === 'ev-back');
  // 复亮时实现是**删掉** `dimmedAt` 键（不是写成空串）⇒ 判"没有这个标记"，用真值断言。
  assert.ok(!row.dimmedAt, '复亮要清掉 dimmedAt，不然面板一直显示"变暗"');
  assert.ok(p);
});

test('⑦ 坏账本 ⇒ 维护拒写，并留下 threw 原因（不吞成"0 条"的成功计数）', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, []);
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const corrupt = `${JSON.stringify(ledRow('ev-ok', 40))}\n{半行坏数据\n`;
  fs.writeFileSync(p.events, corrupt, 'utf8');

  const r = await runConsolidate({
    sourceRoot: root, libDir,
    // 给一个**真的会走到账本**的升长期配置：`store` 为空会在读账本之前就 short-circuit，
    // 那样这条用例只测到回收，测不到升长期拒写。
    settings: { embedBaseURL: 'http://127.0.0.1:1/v1', embedModel: 'drill' },
    normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: fakeVecStore(), callLlm: null
  }, { now: NOW });

  assert.equal(r.ok, true, '维护失败不该把"这一轮没窗口"判成失败');
  assert.match(String(r.promotion.reason), /^threw: /, '升长期必须说"我没跑成"，不能报 0 条');
  assert.match(String(r.retirement.reason), /^threw: /, '回收必须说"我没跑成"');
  assert.equal(fs.readFileSync(p.events, 'utf8'), corrupt, '坏账本必须**原样不动**（拒写，不是"尽力修一半"）');
});

test('⑦ 没有模型 + 有窗口 ⇒ 明确拒绝（llmMissing），但维护已经跑完', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, [ev(NOW - 20 * MIN, 'group:1', '111111', '林枫', '我搬去成都了')]);
  mkEventLedger(libDir, [ledRow('ev-dim', 40)]);

  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(),
    factStore: fakeFactStore(), store: null, callLlm: null
  }, { now: NOW });

  assert.equal(r.windows, 1);
  assert.equal(r.ok, false, '有窗口却没模型 ⇒ 这一轮不算成功');
  assert.equal(r.llmMissing, true, '要能被调用方识别成"缺配置"（HTTP 400），不是"跑了但失败"');
  assert.equal(r.maintenance.ran, true, '模型缺失不该连按时间变淡一起停');
  assert.equal(r.retirement.dimmed, 1);
});

test('⑦ dryRun 一个字节都不改：维护不跑、账本与游标原样', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  mkEvidence(root, []);
  const eventsFile = mkEventLedger(libDir, [ledRow('ev-dim', 40)]);
  const before = fs.readFileSync(eventsFile, 'utf8');

  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {}, normalizer: fakeNormalizer(),
    factStore: fakeFactStore(), store: null, callLlm: null
  }, { now: NOW, dryRun: true });

  assert.equal(r.ok, true);
  assert.deepEqual(r.maintenance, { ran: false, dryRun: true, reason: 'dry-run' });
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), before, 'dry 的承诺是"一个字节都不改"');
  assert.equal(loadConsolidateState({ libDir }).chats['group:1'], undefined);
});

test('⑦ retireHalfLifeGain=0 合法：不因排练延长（不被 || 折成默认值）', async () => {
  const mk = () => {
    const libDir = tmp('mv-lib-');
    // 45 天未排练、2 次排练：gain=0 时 retention 跌破 rMin（该变暗），
    // gain=0.5 时半衰期翻倍（还活着）。若把 0 折成默认，两条会得出同一个结果。
    mkEventLedger(libDir, [ledRow('ev-mid', 45, { hits: 2 })]);
    return libDir;
  };
  const zero = mk();
  const half = mk();
  const a = await runLayerMaintenance({ libDir: zero, store: null, settings: { retireHalfLifeGain: 0 }, now: NOW });
  const b = await runLayerMaintenance({ libDir: half, store: null, settings: { retireHalfLifeGain: 0.5 }, now: NOW });
  assert.equal(a.retirement.dimmed, 1, 'gain=0 ⇒ 半衰期不被排练延长 ⇒ 45 天该变暗');
  assert.equal(b.retirement.dimmed, 0, 'gain=0.5 ⇒ 半衰期 ×2 ⇒ 还活着');
});

test('⑦ consolidateSettleMin=0 合法：不等沉淀，游标之后的窗口立刻成窗', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  // 消息就在"现在"（默认要等 3 分钟才沉淀 ⇒ 0 窗口）
  mkEvidence(root, [ev(NOW, 'group:1', '111111', '林枫', '刚刚说的')]);
  const base = {
    sourceRoot: root, normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => JSON.stringify({ events: [], people: [] })
  };
  const waited = await runConsolidate({ ...base, libDir, settings: {} }, { now: NOW });
  const immediate = await runConsolidate({ ...base, libDir: tmp('mv-lib-'), settings: { consolidateSettleMin: 0 } }, { now: NOW });
  assert.equal(waited.windows, 0, '默认 settle=3 分钟 ⇒ 刚说的话还没沉淀');
  assert.equal(immediate.windows, 1, 'settleMin=0 ⇒ 立刻成窗（排障/回放要用）');
});

// ── ⑧ 宿主账本坏掉 ≠ 整轮停摆（[by:DS] 2026-10-29）──────────────────────────
//
// 上一版：`evidence.missing` 时整轮 `return`。挑窗口确实依赖那本账（不知道有哪些消息
// 就不该猜），但**层维护不用它** —— 升长期看事件账本 + 命中日志，回收看事件账本 + 时间。
// 于是一个没配好 / 坏掉的宿主账本能把遗忘曲线一起冻住，与"没人说话就不变淡"同一个错。
// 判据要同时钉住两件事：**不猜窗口**、**照淡不误**，并且**不许用 error 报降级**。
test('⑧ 宿主账本读不到 ⇒ 不挑窗口，但层维护照跑（不把"没得挑"当成"没活干"）', async () => {
  const root = tmp('mv-src-');          // 故意不造 memory/evidence.jsonl
  const libDir = tmp('mv-lib-');
  mkEventLedger(libDir, [ledRow('ev-dim', 40), ledRow('ev-gone', 90)]);
  let llmCalls = 0;
  const r = await runConsolidate({
    sourceRoot: root, libDir, settings: {},
    normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null,
    callLlm: async () => { llmCalls += 1; return JSON.stringify({ events: [], people: [] }); }
  }, { now: NOW });

  assert.equal(r.ok, true, '这一轮不是整体失败：维护跑完了，账本读不到只是降级');
  assert.equal(r.evidenceMissing, true);
  assert.equal(r.degraded.code, 'EVIDENCE_MISSING');
  assert.equal(r.degraded.retryable, true);
  assert.match(r.degraded.message, /evidence/);
  assert.equal(r.windows, 0, '不知道有哪些消息 ⇒ 不猜窗口');
  // `error` 是"整轮失败"的字段：拿它报降级会让面板显示成"一条都没做"（维护其实做了）
  assert.equal(r.error, '');
  assert.equal(llmCalls, 0, '维护不该调模型');
  assert.equal(r.maintenance.ran, true);
  assert.equal(r.retirement.dimmed, 1, '账本坏了不该冻住遗忘曲线');
  assert.equal(r.retirement.retired, 1);
  const rows = readEventLedger({ libDir });
  assert.ok(rows.find((x) => x.id === 'ev-gone').retiredAt, '回收要真落盘');
});

test('⑧ 同样这条路上 dryRun 仍然一个字节都不改', async () => {
  const root = tmp('mv-src-');
  const libDir = tmp('mv-lib-');
  const eventsFile = mkEventLedger(libDir, [ledRow('ev-dim', 40)]);
  const before = fs.readFileSync(eventsFile);
  const d = await runConsolidate({
    sourceRoot: root, libDir, settings: {},
    normalizer: fakeNormalizer(), factStore: fakeFactStore(), store: null, callLlm: null
  }, { now: NOW, dryRun: true });
  assert.equal(d.dryRun, true);
  assert.equal(d.evidenceMissing, true);
  assert.equal(d.maintenance.ran, false, 'dry 不许跑会写盘的维护');
  assert.deepEqual(fs.readFileSync(eventsFile), before, 'dry 之后账本字节必须原样');
});
