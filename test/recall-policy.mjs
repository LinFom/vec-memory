// test/recall-policy.mjs —— 票 03 读侧策略层专项 [by:WorkBuddy] 2026-11-06
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy, rerankHits, POLICY_SETTINGS_KEYS, SIGNAL_NAMES } from '../src/core/recall-policy.mjs';
import { createExposureState } from '../src/core/exposure.mjs';

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
  ex.record('space|group:lobby', ['b', 'c'], NOW);
  ex.record('space|group:lobby', ['b', 'c'], NOW + 1);
  ex.record('space|group:lobby', ['b', 'c'], NOW + 2);
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

test('C7 双入口一致性：三条召回路径都接了策略，且诊断分布仍用原始分数', () => {
  const src = read('src/router.mjs');
  // 只数真正的调用点（都形如 `const pol = applyRecallPolicy(rt, ...)`），
  // 不把函数定义 `function applyRecallPolicy(rt, ...)` 算进去。
  const calls = src.match(/const pol = applyRecallPolicy\(rt,/g) || [];
  assert.equal(calls.length, 3, '关键词主路 / auto 降级路 / 向量路各一次');
  assert.match(src, /const scores = result\.hits\.map\(\(h\) => h\.score\);/);
  assert.match(src, /\.\.\.\(pol\.policy \? \{ policy: pol\.policy \} : \{\}\)/g);
  assert.match(src, /if \(cfg\.mode === 'off'\) return \{ hits, policy: null \};/, 'off 不得新增响应字段');
});
