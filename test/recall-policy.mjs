// test/recall-policy.mjs —— 票 03 读侧策略层专项 [by:WorkBuddy] 2026-11-06
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy, rerankHits, recallTopN, trimToK, makeInjectionExposureFactor,
  POLICY_SETTINGS_KEYS, SIGNAL_NAMES } from '../src/core/recall-policy.mjs';
import { createExposureState, channelKey } from '../src/core/exposure.mjs';
import { selectInjectLines } from '../src/core/inject.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NOW = Date.parse('2026-11-06T12:00:00Z');
const QUERY = '绿茶 不加糖';

// a 的 base 最高，但其余四个信号全垫底 —— 用来证明重排不是「换个说法的余弦排序」
const mkHits = () => [
  { id: 'a', score: 0.99, meta: { text: '火星火箭发射计划', when: '2020-01-01T00:00:00Z', chatKey: 'group:other', hits: 0 } },
  { id: 'b', score: 0.82, meta: { text: '喜欢绿茶，不加糖', when: '2026-11-05T10:00:00Z', chatKey: 'group:lobby', hits: 5 } },
  { id: 'c', score: 0.71, meta: { text: '绿茶 不加糖 早餐', when: '2026-11-06T10:00:00Z', chatKey: 'group:lobby', hits: 2 } },
  { id: 'd', score: 0.60, meta: { text: '喜欢红茶 加蜂蜜', when: '2020-01-01T00:00:00Z', chatKey: 'group:lobby', hits: 0 } }
];
const ids = (hits) => hits.map((h) => h.id);

test('off 是 fail-closed：原数组原顺序、无诊断、无曝光记录', () => {
  const cfg = parsePolicy({});
  assert.equal(cfg.ok, true);
  assert.equal(cfg.mode, 'off');
  assert.equal(cfg.strategy, 'rrf');
  assert.equal(cfg.weights, null); // 免调权，不存在手抄的 0.45/0.20
  const hits = mkHits();
  const out = rerankHits({ hits, query: QUERY, chatKey: 'group:lobby', cfg, now: NOW });
  assert.equal(out.hits, hits);
  assert.equal(out.diagnostics, null);
  assert.equal(out.degraded, null);
  assert.equal(out.applied, false);
  assert.deepEqual(out.recordIds, []);
});

test('shadow 只算不排、零副作用：顺序原样但分量与建议顺序齐全', () => {
  const cfg = parsePolicy({ recallPolicyMode: 'shadow' });
  const hits = mkHits();
  const out = rerankHits({ hits, query: QUERY, chatKey: 'group:lobby', cfg, now: NOW });
  assert.equal(out.hits, hits, 'shadow 必须返回同一个数组，连复制都不做');
  assert.equal(out.diagnostics.applied, false);
  assert.deepEqual(out.diagnostics.originalOrder, ids(hits));
  assert.equal(out.diagnostics.proposedOrder.length, hits.length);
  assert.equal(out.diagnostics.scoreSource, 'hits-only');
  assert.equal(out.diagnostics.items.length, hits.length);
  for (const item of out.diagnostics.items) {
    for (const name of SIGNAL_NAMES) assert.equal(typeof item.components[name], 'number');
    assert.ok(Number.isFinite(item.fused) && Number.isFinite(item.final));
  }
  assert.deepEqual(out.recordIds, [], 'shadow 绝不写曝光状态');
});

test('enabled 改变顺序但不改变候选集合，且顺序可解释', () => {
  const cfg = parsePolicy({ recallPolicyMode: 'enabled' });
  const hits = mkHits();
  const out = rerankHits({ hits, query: QUERY, chatKey: 'group:lobby', cfg, now: NOW });
  assert.equal(out.applied, true);
  assert.deepEqual([...ids(out.hits)].sort(), [...ids(hits)].sort(), '只重排，不增不删');
  assert.notDeepEqual(ids(out.hits), ids(hits), '多信号必须能推翻纯余弦顺序');
  assert.deepEqual(out.diagnostics.proposedOrder, ids(out.hits));
  const first = out.diagnostics.items.find((i) => i.id === ids(out.hits)[0]);
  assert.equal(first.proposedRank, 1);
  assert.ok(first.originalRank >= 1);
  assert.deepEqual(out.recordIds.slice(0, 2), ids(out.hits).slice(0, 2));
});

test('加权和策略：权重自动归一化，base 先 min-max 归一化，量纲不主导', () => {
  const cfg = parsePolicy({ recallPolicyMode: 'enabled', recallPolicyWeights: '{"base":1,"entity":1}' });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.strategy, 'weighted');
  assert.ok(Math.abs(cfg.weights.base + cfg.weights.entity - 1) < 1e-9);
  const hits = mkHits().map((h) => ({ ...h, score: h.score * 1000 })); // 换成完全不同的量纲
  const out = rerankHits({ hits, query: QUERY, chatKey: 'group:lobby', cfg, now: NOW });
  for (const item of out.diagnostics.items) {
    assert.ok(item.components.base >= 0 && item.components.base <= 1, 'base 必须已归一化到 [0,1]');
  }
  assert.notDeepEqual(ids(out.hits), ids(hits));
});

test('配置非法一律显式退回 off + 稳定码，绝不静默放行', () => {
  const cases = [
    { recallPolicyMode: 'on' },
    { recallPolicyWeights: '{bad json' },
    { recallPolicyWeights: '{"unknown":1}' },
    { recallPolicyWeights: '{"base":-1}' },
    { recallPolicyWeights: '{"base":0,"entity":0}' },
    { recallExposureWindow: 99 },
    { recallExposureDecay: 0 }
  ];
  for (const bad of cases) {
    const cfg = parsePolicy({ recallPolicyMode: 'enabled', ...bad });
    assert.equal(cfg.ok, false, JSON.stringify(bad));
    assert.equal(cfg.mode, 'off', JSON.stringify(bad));
    assert.equal(cfg.reason, 'POLICY_CONFIG_INVALID');
    const hits = mkHits();
    const out = rerankHits({ hits, cfg, now: NOW });
    assert.equal(out.hits, hits);
    assert.equal(out.degraded.code, 'POLICY_CONFIG_INVALID');
  }
  assert.equal(rerankHits({ hits: null, cfg: parsePolicy({}) }).degraded, null);
});

test('曝光是软降权：连续多轮让位，但永不排除；与采用次数分开', () => {
  const ex = createExposureState({ maxTurns: 8 });
  const cfg = { ...parsePolicy({ recallPolicyMode: 'enabled' }), exposureWindow: 3, exposureDecay: 0.6 };
  const key = channelKey('space', 'search', 'group:lobby');
  ex.record(key, ['b', 'c'], NOW);
  ex.record(key, ['b', 'c'], NOW + 1);
  ex.record(key, ['b', 'c'], NOW + 2);
  const exposed = rerankHits({ hits: mkHits(), query: QUERY, chatKey: 'group:lobby', spaceKey: 'space', cfg, exposure: ex, now: NOW + 3 });
  const clean = rerankHits({ hits: mkHits(), query: QUERY, chatKey: 'group:lobby', spaceKey: 'space', cfg, exposure: null, now: NOW + 3 });
  const eb = exposed.diagnostics.items.find((i) => i.id === 'b');
  const cb = clean.diagnostics.items.find((i) => i.id === 'b');
  assert.equal(eb.exposureCount, 3);
  assert.ok(Math.abs(eb.exposureFactor - 0.216) < 1e-6);
  assert.equal(cb.exposureCount, 0);
  assert.ok(eb.final < cb.final, '被曝光过的分数必须更低');
  assert.ok(exposed.diagnostics.items.every((i) => i.final > 0), '软降权不能把任何条目变成 0/排除');
  assert.ok(ids(exposed.hits).includes('b'), '让位 ≠ 消失');
});

test('曝光状态有界、幂等、TTL 可回收，且纯内存不落盘', () => {
  const ex = createExposureState({ maxSessions: 3, maxTurns: 2, maxIdsPerTurn: 8, ttlMs: 10000 });
  ex.record('s1|k', ['x'], NOW);
  ex.record('s1|k', ['x'], NOW); // 同一轮重复 ⇒ 幂等，不累加
  assert.equal(ex.lookup('s1|k', 'x', NOW + 1, 3, 0.6).count, 1);
  ex.record('s1|k', ['x'], NOW + 2);
  assert.equal(ex.lookup('s1|k', 'x', NOW + 3, 3, 0.6).count, 2);
  ex.record('s1|k', ['x'], NOW + 4);
  assert.equal(ex.lookup('s1|k', 'x', NOW + 5, 3, 0.6).count, 2, '超出 maxTurns 的老轮次被裁掉');
  for (let i = 0; i < 10; i += 1) ex.record(`s${i}|k`, ['x'], NOW + 10 + i);
  assert.ok(ex.stats(NOW + 20).sessions <= 3);
  assert.equal(ex.lookup('s1|k', 'x', NOW + 20000, 3, 0.6).count, 0, 'TTL 过期清零');
  const before = ex.stats(NOW + 20).sessions;
  ex.reset();
  assert.ok(ex.stats(NOW + 20).sessions <= before);
});

test('源码守卫：策略层不得写真值、不得碰向量代/备份/编码身份', () => {
  const forbidden = ['slots.jsonl', 'vectors.bin', 'vector-active.json', 'appendFileSync',
    'writeFileSync', 'encodingIdentity', 'sourceHash', 'factstore', 'vecstore', 'node:fs'];
  for (const file of ['src/core/recall-policy.mjs', 'src/core/exposure.mjs']) {
    // 只看代码：文件头注释里写着「不进 encodingIdentity / 不碰 factstore」，
    // 那是纪律声明，不能因为提到这个名字就判定违规。
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
      .toLowerCase();
    for (const word of forbidden) {
      assert.ok(!code.includes(word.toLowerCase()), `${file} 代码中不得出现 ${word}`);
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'policy-state.json')), false);
});

test('四处配置白名单同步，且默认关闭', () => {
  const files = ['src/core/backend.mjs', 'src/core/settings-editor.mjs',
    'src/standalone/service.mjs', 'adapters/qq-agent/plugin.json'];
  for (const f of files) {
    const src = read(f);
    for (const key of POLICY_SETTINGS_KEYS) assert.ok(src.includes(key), `${f} 缺 ${key}`);
  }
  assert.match(read('src/core/backend.mjs'), /recallPolicyMode:\s*'off'/);
  assert.match(read('adapters/qq-agent/plugin.json'), /"recallPolicyMode":\s*"off"/);
  const plugin = JSON.parse(read('adapters/qq-agent/plugin.json'));
  for (const key of POLICY_SETTINGS_KEYS) {
    assert.ok(Object.hasOwn(plugin.settings, key), `settings 缺 ${key}`);
    assert.ok(Object.hasOwn(plugin.configSchema, key), `configSchema 缺 ${key}`);
  }
});

test('C7 全路径一致性：四条召回路径都接了策略，且分布口径不被放大召回稀释', () => {
  const src = read('src/router.mjs');
  // 只数真正的调用点（都形如 `const pol = applyRecallPolicy(rt, ...)`），
  // 不把函数定义 `function applyRecallPolicy(rt, ...)` 算进去。
  // 2026-11-07 修正：上一版只数了块层三条，漏掉 `kind=event` 的向量支路 —— 那条
  // 同样是「同类 hits 内部重排」，不接就会出现「大部分路径有重排、这条没有」的静默分叉。
  const calls = src.match(/const pol = applyRecallPolicy\(rt,/g) || [];
  assert.equal(calls.length, 4, '关键词主路 / auto 降级路 / 向量路 / kind=event 向量路各一次');
  assert.equal((src.match(/k: storeK/g) || []).length, 4, '四条 store 调用都必须用放大后的召回量');
  assert.match(src, /const storeK = recallTopN\(k, polCfg\);/);
  // 分布诊断必须按请求 k 的前 k 条算，不能拿 4k 条稀释后的分数当新口径。
  assert.match(src, /result\.hits\.slice\(0, Math\.max\(1, k\)\)\.map\(\(h\) => h\.score\)/);
  // 配置非法 / 运行抛错的分支也必须截回 k，否则「失败但返回 4k 条」是另一种静默失败。
  assert.match(src, /const trim = \(arr\) => trimToK\(arr, k\);/, '截断用可实跑验证的公共函数');
  assert.match(src, /return \{ hits: trim\(out\.hits\), policy: out\.diagnostics \}/);
  assert.match(src, /\.\.\.\(pol\.policy \? \{ policy: pol\.policy \} : \{\}\)/g);
  assert.match(src, /if \(cfg\.mode === 'off'\) return \{ hits, policy: null \};/, 'off 不得新增响应字段');
  // 注入侧：只在非 off 时传因子、只在非 off 时多一个响应字段。
  assert.equal((src.match(/\.\.\.\(injFactor \? \{ exposureFactor: injFactor \} : \{\}\)/g) || []).length, 2);
  assert.match(src, /\.\.\.\(injPolicy \? \{ policy: injPolicy \} : \{\}\)/);
  assert.match(src, /RECALL_EXPOSURE\.record\(receipt\.exposureKey/);
  // `inject.mjs` 不得反向依赖策略层（层次不倒挂）。
  assert.ok(!read('src/core/inject.mjs').includes("from './recall-policy.mjs'"));
  assert.ok(!read('src/core/inject.mjs').includes("from './exposure.mjs'"));
});

test('放大召回：仅非 off 才放大，硬上限 200，off/非法配置原样', () => {
  const off = parsePolicy({});
  const on = parsePolicy({ recallPolicyMode: 'enabled' });
  const shadow = parsePolicy({ recallPolicyMode: 'shadow' });
  assert.equal(recallTopN(8, off), 8);
  assert.equal(recallTopN(8, parsePolicy({ recallPolicyMode: 'bogus' })), 8, '配置非法 fail-closed');
  assert.equal(recallTopN(8, on), 32);
  assert.equal(recallTopN(8, shadow), 32);
  assert.equal(recallTopN(1, on), 20, '下限 20，保证小 k 也有足够候选');
  assert.equal(recallTopN(100, on), 200, '不越过 vecstore 的 k 上限');
});

test('放大召回端到端：40 条候选重排后仍只返回请求 k 条，且顺序是重排后的', () => {
  // 构造一个真正「需要放大」的库：base 分数把最相关的埋在第 25 位，
  // 若只召回 k=8 条，它根本进不了候选；放大到 32 条后才可能被多信号捞上来。
  const hits = Array.from({ length: 40 }, (_, i) => ({
    id: `h${i}`,
    score: Number((0.99 - i * 0.01).toFixed(4)),
    meta: { text: i === 25 ? '喜欢绿茶 不加糖 早餐' : `无关文档 ${i}`,
      when: i === 25 ? '2026-11-06T10:00:00Z' : '2020-01-01T00:00:00Z',
      chatKey: 'group:lobby', hits: i === 25 ? 5 : 0 }
  }));
  const cfg = parsePolicy({ recallPolicyMode: 'enabled' });
  assert.equal(recallTopN(8, cfg), 32);
  const wide = hits.slice(0, recallTopN(8, cfg));
  assert.ok(wide.some((h) => h.id === 'h25'), '放大后 h25 才进入候选池');
  assert.ok(!hits.slice(0, 8).some((h) => h.id === 'h25'), '不放大时 h25 根本不在候选里');
  const out = rerankHits({ hits: wide, query: '绿茶 不加糖', chatKey: 'group:lobby', cfg, now: NOW, k: 8 });
  const trimmed = trimToK(out.hits, 8);
  assert.equal(trimmed.length, 8, '响应契约仍只给 8 条');
  assert.deepEqual(trimmed.map((h) => h.id), out.hits.slice(0, 8).map((h) => h.id), '截断取的是重排后的前 8');
  assert.equal(trimToK(out.hits, 200).length, out.hits.length, 'k 大于候选数时不裁');
  assert.equal(trimToK(null, 8), null, '非数组原样返回');
  // off 侧从来不会放大，自然也不需要截断。
  assert.equal(recallTopN(8, parsePolicy({})), 8);
});

test('检索级与注入级通道物理隔离，两套 id 空间不串味', () => {
  const ex = createExposureState();
  const searchKey = channelKey('space', 'search', 'group:1');
  const injectKey = channelKey('space', 'inject', 'group:1');
  assert.notEqual(searchKey, injectKey);
  ex.record(searchKey, ['doc-1', '甲|喜欢绿茶'], NOW);
  assert.equal(ex.lookup(searchKey, 'doc-1', NOW + 1).count, 1);
  assert.equal(ex.lookup(injectKey, 'doc-1', NOW + 1).count, 0, '注入通道查不到检索通道的曝光');
  assert.equal(ex.lookup(injectKey, '甲|喜欢绿茶', NOW + 1).count, 0);
  assert.equal(ex.lookup(channelKey('other', 'inject', 'group:1'), 'doc-1', NOW + 1).count, 0, '空间也要隔离');
});

const mkCandidates = () => [
  { who: '甲', line: '喜欢绿茶', credibility: 0.9 },
  { who: '甲', line: '喜欢红茶', credibility: 0.8 },
  { who: '乙', line: '住在杭州', credibility: 0.7 }
];
const lineId = (l) => `${String(l.who)}|${String(l.line)}`;

test('注入级曝光：连续多轮同档让位、永不排除、off 逐字不变', () => {
  const ex = createExposureState({ maxTurns: 8 });
  const cfg = parsePolicy({ recallPolicyMode: 'enabled', recallExposureWindow: 3, recallExposureDecay: 0.6 });
  const key = channelKey('space', 'inject', 'group:1');
  ex.record(key, ['甲|喜欢绿茶'], NOW);
  ex.record(key, ['甲|喜欢绿茶'], NOW + 1);
  const f = makeInjectionExposureFactor({ exposure: ex, spaceKey: 'space', chatKey: 'group:1', cfg, now: NOW + 2 });
  assert.equal(typeof f, 'function');
  assert.ok(f('甲|喜欢绿茶') < 1, '被曝光过两轮 ⇒ 软降权');
  assert.equal(f('甲|喜欢红茶'), 1);
  const base = selectInjectLines({ candidates: mkCandidates(), perPerson: 2, total: 3 });
  const withEx = selectInjectLines({ candidates: mkCandidates(), perPerson: 2, total: 3, exposureFactor: f });
  assert.deepEqual(base.lines.map(lineId), ['甲|喜欢绿茶', '甲|喜欢红茶', '乙|住在杭州']);
  // 只断言语义，不锁死具体名次：软因子乘在可信度上，降两轮后 0.9×0.36=0.324，
  // 会连「乙」的 0.7 也让过去 —— 跨人让位同样符合「不排除、只让位」的口径。
  assert.notDeepEqual(withEx.lines.map(lineId), base.lines.map(lineId), '顺序必须变化');
  assert.notEqual(withEx.lines.map(lineId)[0], '甲|喜欢绿茶', '上一轮见过的不再占第一');
  assert.ok(withEx.lines.map(lineId).includes('甲|喜欢绿茶'), '让位 ≠ 消失');
  const byId = (a, b) => lineId(a).localeCompare(lineId(b));
  assert.deepEqual([...withEx.lines].sort(byId), [...base.lines].sort(byId),
    '只改顺序，不改任何行的字段值（credibility 不能被降权因子污染）');
  const offResult = selectInjectLines({ candidates: mkCandidates(), perPerson: 2, total: 3, exposureFactor: null });
  assert.deepEqual(offResult, base, 'off 时返回对象逐字不变');
});

test('shadow 注入侧只算不排，off 连因子都不造', () => {
  const ex = createExposureState();
  const cfg = parsePolicy({ recallPolicyMode: 'shadow' });
  const key = channelKey('s', 'inject', 'c');
  ex.record(key, ['甲|喜欢绿茶'], NOW);
  const f = makeInjectionExposureFactor({ exposure: ex, spaceKey: 's', chatKey: 'c', cfg, now: NOW + 1 });
  assert.equal(f('甲|喜欢绿茶'), 1, 'shadow 因子恒 1');
  assert.equal(f.report().demoted, 1);
  assert.equal(f.report().wouldDemote, 1);
  assert.equal(f.report().mode, 'shadow');
  assert.equal(makeInjectionExposureFactor({ exposure: ex, cfg: parsePolicy({}) }), null);
  assert.equal(makeInjectionExposureFactor({ exposure: null, cfg }), null);
  assert.deepEqual(selectInjectLines({ candidates: mkCandidates(), perPerson: 2, total: 3, exposureFactor: f }),
    selectInjectLines({ candidates: mkCandidates(), perPerson: 2, total: 3 }));
});
