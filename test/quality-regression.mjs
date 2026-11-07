// [by:WorkBuddy] 票 05：数值快照验收 + 票 04 遗留的「降级原序」真实执行验证。
//
// 票 04 的 test/rerank-backend.mjs 只能做源码级结构断言，把顺序回退交给本票。
// 这里直接调用从 router.mjs 导出的 applyRecallPolicy()，传入构造好的同类候选，
// 真正跑过「精排失败 ⇒ 回落票 03 的 out.hits」那条分支并逐字比对命中顺序。
// ⚠️ 如实边界：这不是 HTTP /search 全链路（没有起服务、没有真实召回）；
//    真实 cross-encoder 成功往返也只由 stub 覆盖，见 docs/quality-regression-20261107.md §3。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyRecallPolicy} from '../src/router.mjs';
import {parsePolicy} from '../src/core/recall-policy.mjs';
import {resetRerankState} from '../src/core/rerank-backend.mjs';
import {comparable} from '../tools/evaluate-quality-regression.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

test('三份快照字段齐全，且新特性关闭时与历史基线逐字可比', () => {
  const before = readJson('docs/quality-regression-before-20261107.json');
  const after = readJson('docs/quality-regression-after-20261107.json');
  const baseline = readJson('docs/recall-evaluation-20261101.json');
  for (const [name, snap] of [['before', before], ['after', after]]) {
    for (const key of ['precisionAt8', 'recallAt8', 'falseInjectionRate', 'latencyMs', 'externalModelRequests']) {
      assert.equal(typeof snap[key], 'number', `${name}.${key} 必须是数值`);
      assert.ok(Number.isFinite(snap[key]), `${name}.${key} 必须是有限数`);
    }
    assert.equal(snap.queries, 6);
    assert.equal(snap.rows.length, 6);
    assert.equal(snap.externalModelRequests, 0);
    assert.match(snap.limitations.join(' '), /NOT \/search/, '必须自证这套评测测不到重排顺序');
    for (const row of snap.rows) assert.equal(typeof row.latencyMs, 'number');
  }
  assert.equal(before.baselineComparableExcludingLatency, true);
  assert.deepEqual(comparable(before), comparable(baseline),
    '关闭新特性时除 latencyMs 外必须与 20261101 基线逐字一致');
  assert.equal(after.importRegression.snapshot.externalModelRequests, 0);
  assert.deepEqual(comparable(after.importRegression.snapshot), comparable(baseline),
    '第三方导入数据不得弄坏原有标注查询（场合隔离）');
  assert.match(after.positionalNote, /不经过 \/search/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/quality-regression-20261107.md'), 'utf8'), /未端到端实跑|未实跑/);
});

test('精排端点不可用 ⇒ 真实走降级分支，保持票 03 原序、稳定码、截回 k', async () => {
  resetRerankState();
  const NOW = Date.parse('2026-11-07T00:00:00Z');
  const hits = [
    ['a', '喜欢绿茶不加糖'], ['b', '常聊插件与绿茶'], ['c', '昨天一起喝绿茶'],
    ['d', '绿茶冷笑话'], ['e', '答应带绿茶'], ['f', '讨厌排队买绿茶']
  ].map(([id, text], i) => ({
    id, score: 0.9 - i * 0.05,
    meta: {text, title: text, when: NOW - i * 86400000, chatKey: 'group:42', hits: i, id}
  }));
  const settings = {recallPolicyMode: 'enabled', recallExposureWindow: 3, recallExposureDecay: 0.3,
    rerankEnabled: false, rerankBaseURL: 'http://127.0.0.1:1', rerankModel: 'stub-rerank', rerankTimeoutMs: 60};
  const rt = {dir: 'quality-test', settings};
  const cfg = parsePolicy({recallPolicyMode: 'enabled', recallExposureWindow: 3, recallExposureDecay: 0.3});
  assert.equal(cfg.ok, true);
  const args = (chatKey) => ({query: '绿茶', chatKey, k: 4, cfg, now: NOW});

  // ① 只开票 03、精排关闭 ⇒ 这是「原序」。用独立 chatKey 隔离曝光状态，
  //    否则第一次调用的曝光记录会改变第二次的票 03 顺序，把曝光误判成精排问题。
  const baseline = await applyRecallPolicy(rt, hits, args('group:baseline'));
  assert.equal(baseline.policy?.rerank, undefined, '精排关闭时不得新增 rerank 字段');
  assert.equal(baseline.hits.length, 4, '放大召回后必须截回请求 k');

  // ② 精排开启但端点不可达 ⇒ 必须回落票 03 的顺序，不抛异常、不换召回语义。
  settings.rerankEnabled = true;
  const degraded = await applyRecallPolicy(rt, hits, args('group:degrade'));
  assert.deepEqual(degraded.hits.map((h) => h.id), baseline.hits.map((h) => h.id),
    '降级时顺序必须与票 03 原序逐字一致');
  assert.equal(degraded.hits.length, 4, '降级时不得把放大后的候选漏出去');
  const code = degraded.policy?.rerank?.degraded;
  assert.equal(typeof code, 'string', '必须回报稳定 degraded 码');
  assert.match(code, /^RERANK_/);
  assert.equal(degraded.policy.rerank.applied, false);

  // ③ kill switch：切回 off 后连策略函数都不调用，policy 为 null、hits 原样返回。
  const offCfg = parsePolicy({recallPolicyMode: 'off'});
  const off = await applyRecallPolicy(rt, hits, {...args('group:off'), cfg: offCfg});
  assert.equal(off.policy, null, 'off 时响应不得新增 policy 字段');
  assert.equal(off.hits, hits, 'off 时返回原数组本身（storeK === k，未放大召回）');
  resetRerankState();
});
