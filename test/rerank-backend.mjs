// test/rerank-backend.mjs —— 票 04 可选 cross-encoder 精排后端专项
// [by:WorkBuddy] 2026-11-07
//
// 只测 src/core/rerank-backend.mjs 这个「外部 HTTP 客户端」的契约：
//   stub 五情形 / 兼容形状 / 配置严格性 / 内存熔断 / 载荷校验 / topN 截断 / 源码守卫。
// rerankState()/breaker 是**模块级单例**，每个用例开头都 resetRerankState() 隔离。
// 降级时「原序不变」的端到端顺序回退由票 05 质量回归覆盖，本文件只做源码级结构断言，
// 不宣称在本专项里跑过端到端（applyRecallPolicy 未导出，无法直接驱动）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  RERANK_SETTINGS_KEYS, RERANK_DEFAULTS, RERANK_TIMEOUT_HARD_CAP_MS,
  RERANK_DEGRADE_LIMIT, RERANK_DEGRADED,
  parseRerankConfig, rerankCandidates, rerankState, resetRerankState
} from '../src/core/rerank-backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BASE = 'http://rerank.local';

// 开启态配置（带合法端点与模型），extra 可覆盖单字段用于边界用例。
const enabledCfg = (extra = {}) => parseRerankConfig({
  rerankEnabled: true, rerankBaseURL: BASE, rerankModel: 'bge-reranker', ...extra
});

// 候选带 meta.text，便于检查 documentText / order / scores 的映射关系。
const mkHits = (n = 4) => Array.from({ length: n }, (_, i) => ({
  id: `h${i}`, score: Number((0.9 - i * 0.05).toFixed(4)),
  meta: { text: `文档 ${i}` }
}));

// 成功响应的 fetch stub：实现读的是 res.ok + res.text()（不是 res.json()）。
// body 传字符串即原样返回（用来造非法 JSON），传对象则 JSON.stringify。
// 同时记录调用参数，便于断言 payload / documents / top_n / url / headers。
const okFetch = (body) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true, status: 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  };
  return { fetchImpl, calls };
};

test('正常精排：乱序 relevance_score → order 按分数降序、平局用 index 稳定', async () => {
  resetRerankState();
  const hits = mkHits(4);
  const { fetchImpl, calls } = okFetch({
    results: [
      { index: 0, relevance_score: 0.1 },
      { index: 1, relevance_score: 0.9 },
      { index: 2, relevance_score: 0.9 }, // 与 index 1 平局
      { index: 3, relevance_score: 0.5 }
    ]
  });
  const r = await rerankCandidates({ hits, query: '绿茶', cfg: enabledCfg(), fetchImpl, now: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, null);
  assert.equal(r.requestMade, true);
  assert.equal(r.skipped, false);
  assert.equal(r.autoDisabled, false);
  assert.equal(r.count, 4);
  // 0.9(1) 与 0.9(2) 平局 ⇒ 原下标小的先；再 0.5(3)、0.1(0)。
  assert.deepEqual(r.order, [1, 2, 3, 0]);
  assert.deepEqual(r.scores, [0.1, 0.9, 0.9, 0.5]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/rerank`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  const payload = JSON.parse(calls[0].opts.body);
  assert.equal(payload.model, 'bge-reranker');
  assert.equal(payload.query, '绿茶');
  assert.equal(payload.top_n, 4);
  assert.deepEqual(payload.documents, ['文档 0', '文档 1', '文档 2', '文档 3']);
  resetRerankState();
});

test('超时：AbortController 触发 → RERANK_TIMEOUT', async () => {
  resetRerankState();
  let calls = 0;
  // 不主动 resolve；监听实现传进来的 signal，abort 时以 AbortError reject，
  // 等价于真实 fetch 被 AbortController 掐断。
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    calls += 1;
    opts.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });
  const r = await rerankCandidates({
    hits: mkHits(3), query: 'q',
    cfg: enabledCfg({ rerankTimeoutMs: 20 }), fetchImpl, now: 1
  });
  assert.equal(r.degraded, RERANK_DEGRADED.TIMEOUT);
  assert.equal(r.order, null);
  assert.equal(r.requestMade, true);
  assert.equal(calls, 1);
  assert.equal(rerankState().consecutiveDegraded, 1);
  resetRerankState();
});

test('条数不符 → RERANK_COUNT_MISMATCH，order===null', async () => {
  resetRerankState();
  const { fetchImpl } = okFetch({ results: [{ index: 0, relevance_score: 1 }] }); // 只 1 条，documents 4 条
  const r = await rerankCandidates({ hits: mkHits(4), query: 'q', cfg: enabledCfg(), fetchImpl, now: 1 });
  assert.equal(r.degraded, RERANK_DEGRADED.COUNT_MISMATCH);
  assert.equal(r.order, null, '调用方据此保持票 03 的原序');
  assert.equal(r.requestMade, true);
  resetRerankState();
});

test('非法 JSON → RERANK_BAD_JSON，order===null', async () => {
  resetRerankState();
  const { fetchImpl } = okFetch('{ not json');
  const r = await rerankCandidates({ hits: mkHits(3), query: 'q', cfg: enabledCfg(), fetchImpl, now: 1 });
  assert.equal(r.degraded, RERANK_DEGRADED.BAD_JSON);
  assert.equal(r.order, null);
  resetRerankState();
});

test('默认关闭：parseRerankConfig({}).enabled===false，零 fetch、requestMade===false', async () => {
  resetRerankState();
  const cfg = parseRerankConfig({});
  assert.equal(cfg.ok, true);
  assert.equal(cfg.enabled, false);
  assert.equal(RERANK_DEFAULTS.enabled, false);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, text: async () => '{}' }; };
  const r = await rerankCandidates({ hits: mkHits(4), query: 'q', cfg, fetchImpl, now: 1 });
  assert.equal(calls, 0, '默认关闭绝不能发外部请求');
  assert.equal(r.requestMade, false);
  assert.equal(r.skipped, true);
  assert.equal(r.order, null);
  assert.equal(r.degraded, RERANK_DEGRADED.DISABLED);
  assert.equal(rerankState().consecutiveDegraded, 0, '默认关闭不算一次 degraded');
  resetRerankState();
});

test('兼容形状：{data:[...]} / 顶层数组 / 行内 score 字段', async () => {
  const shapes = [
    { name: '{data:[...]}', body: { data: [{ index: 0, score: 0.2 }, { index: 1, score: 0.8 }] } },
    { name: '顶层数组', body: [{ index: 0, score: 0.2 }, { index: 1, score: 0.8 }] },
    { name: '行内 score', body: { results: [{ index: 0, score: 0.2 }, { index: 1, score: 0.8 }] } }
  ];
  for (const s of shapes) {
    resetRerankState();
    const { fetchImpl } = okFetch(s.body);
    const r = await rerankCandidates({ hits: mkHits(2), query: 'q', cfg: enabledCfg(), fetchImpl, now: 1 });
    assert.equal(r.ok, true, s.name);
    assert.deepEqual(r.order, [1, 0], s.name); // 0.8 > 0.2
    assert.deepEqual(r.scores, [0.2, 0.8], s.name);
  }
  resetRerankState();
});

test('配置严格性：非 boolean / 非法 URL / 超时夹 800 / topN 越界 / 开启缺端点', () => {
  assert.deepEqual(RERANK_SETTINGS_KEYS, [
    'rerankEnabled', 'rerankBaseURL', 'rerankApiKey', 'rerankModel', 'rerankTimeoutMs', 'rerankTopN'
  ]);
  assert.equal(RERANK_TIMEOUT_HARD_CAP_MS, 800);
  assert.equal(RERANK_DEGRADE_LIMIT, 3);
  // 稳定码表：文案可漂、码不漂。
  assert.equal(RERANK_DEGRADED.TIMEOUT, 'RERANK_TIMEOUT');
  assert.equal(RERANK_DEGRADED.COUNT_MISMATCH, 'RERANK_COUNT_MISMATCH');
  assert.equal(RERANK_DEGRADED.BAD_JSON, 'RERANK_BAD_JSON');
  assert.equal(RERANK_DEGRADED.HTTP_ERROR, 'RERANK_HTTP_ERROR');
  assert.equal(RERANK_DEGRADED.FAILED, 'RERANK_FAILED');
  assert.equal(RERANK_DEGRADED.DISABLED, 'RERANK_DISABLED');

  // 非 boolean rerankEnabled
  const nonBool = parseRerankConfig({ rerankEnabled: 'yes' });
  assert.equal(nonBool.ok, false);
  assert.equal(nonBool.reason, 'RERANK_CONFIG_INVALID');
  assert.match(nonBool.detail, /boolean/);

  // 非法 URL（开启时才校验）
  const badURL = parseRerankConfig({ rerankEnabled: true, rerankBaseURL: 'not-a-url', rerankModel: 'm' });
  assert.equal(badURL.ok, false);
  assert.match(badURL.detail, /valid URL/);
  const badProto = parseRerankConfig({ rerankEnabled: true, rerankBaseURL: 'ftp://x', rerankModel: 'm' });
  assert.equal(badProto.ok, false);
  assert.match(badProto.detail, /http\(s\)/);

  // 超时：正数正常取值；超上限夹到 800；非正数显式报错
  assert.equal(enabledCfg({ rerankTimeoutMs: 250 }).timeoutMs, 250);
  assert.equal(enabledCfg({ rerankTimeoutMs: 99999 }).timeoutMs, RERANK_TIMEOUT_HARD_CAP_MS);
  const badTimeout = enabledCfg({ rerankTimeoutMs: -5 });
  assert.equal(badTimeout.ok, false);
  assert.match(badTimeout.detail, /positive finite/);

  // topN：0..200 合法；越界 / 非整数 / 非数一律报错
  for (const v of [201, -1, 1.5, 'x']) {
    const c = enabledCfg({ rerankTopN: v });
    assert.equal(c.ok, false, `rerankTopN=${v}`);
    assert.match(c.detail, /integer 0\.\.200/);
  }
  assert.equal(enabledCfg({ rerankTopN: 0 }).topN, 0);
  assert.equal(enabledCfg({ rerankTopN: 200 }).topN, 200);

  // 开启时缺 baseURL / model 一律报错；关闭时缺端点不算错（旧配置照常启动）
  for (const s of [
    { rerankEnabled: true },
    { rerankEnabled: true, rerankBaseURL: BASE },
    { rerankEnabled: true, rerankModel: 'm' }
  ]) {
    const c = parseRerankConfig(s);
    assert.equal(c.ok, false, JSON.stringify(s));
    assert.match(c.detail, /requires non-empty/);
  }
  assert.equal(parseRerankConfig({ rerankEnabled: false }).ok, true);
});

test('连续 3 次 degraded ⇒ autoDisabled，第 4 次零请求', async () => {
  resetRerankState();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, text: async () => '{ broken' }; }; // BAD_JSON
  const cfg = enabledCfg({ rerankTimeoutMs: 50 });
  for (let i = 0; i < RERANK_DEGRADE_LIMIT; i += 1) {
    const r = await rerankCandidates({ hits: mkHits(3), query: 'q', cfg, fetchImpl, now: 1 });
    assert.equal(r.degraded, RERANK_DEGRADED.BAD_JSON);
    assert.equal(r.requestMade, true);
    assert.equal(r.autoDisabled, i === RERANK_DEGRADE_LIMIT - 1, `第 ${i + 1} 次`);
  }
  assert.equal(rerankState().autoDisabled, true);
  assert.equal(calls, 3);
  // 第 4 次：熔断跳闸 ⇒ 直接跳过，零请求、带 DISABLED 码
  const r4 = await rerankCandidates({ hits: mkHits(3), query: 'q', cfg, fetchImpl, now: 1 });
  assert.equal(r4.requestMade, false);
  assert.equal(r4.skipped, true);
  assert.equal(r4.degraded, RERANK_DEGRADED.DISABLED);
  assert.equal(r4.autoDisabled, true);
  assert.equal(calls, 3, '第 4 次不得再发请求');
  resetRerankState();
});

test('一次成功打断连续 degraded 计数（resetRerankState 隔离单例）', async () => {
  resetRerankState();
  const badFetch = async () => ({ ok: true, text: async () => '{ broken' }); // BAD_JSON
  const goodFetch = async () => ({ ok: true, text: async () => JSON.stringify({
    results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }]
  }) });
  const cfg = enabledCfg();
  const run = (fetchImpl) => rerankCandidates({ hits: mkHits(2), query: 'q', cfg, fetchImpl, now: 1 });

  await run(badFetch);  // consecutive = 1
  await run(badFetch);  // consecutive = 2
  assert.equal(rerankState().consecutiveDegraded, 2);
  assert.equal(rerankState().autoDisabled, false);

  const ok = await run(goodFetch); // 成功 ⇒ consecutive 归零
  assert.equal(ok.ok, true);
  assert.equal(rerankState().consecutiveDegraded, 0);
  assert.equal(rerankState().totalSuccess, 1);

  await run(badFetch);  // consecutive = 1
  await run(badFetch);  // consecutive = 2
  assert.equal(rerankState().autoDisabled, false, '成功打断后，2 次连续失败不该跳闸');
  assert.equal(rerankState().consecutiveDegraded, 2);
  await run(badFetch);  // consecutive = 3 ⇒ 跳闸
  assert.equal(rerankState().autoDisabled, true);
  resetRerankState();
});

test('响应载荷非法：index 越界 / 重复 / 非有限分数 ⇒ RERANK_FAILED 且 order===null', async () => {
  const badBodies = [
    { name: 'index 越界', body: { results: [
      { index: 0, relevance_score: 0.9 }, { index: 5, relevance_score: 0.1 }] } },
    { name: 'index 重复', body: { results: [
      { index: 1, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] } },
    { name: 'relevance_score 非有限数', body: { results: [
      { index: 0, relevance_score: 'oops' }, { index: 1, relevance_score: 0.1 }] } }
  ];
  for (const c of badBodies) {
    resetRerankState();
    const { fetchImpl } = okFetch(c.body);
    const r = await rerankCandidates({ hits: mkHits(2), query: 'q', cfg: enabledCfg(), fetchImpl, now: 1 });
    assert.equal(r.degraded, RERANK_DEGRADED.FAILED, c.name);
    assert.equal(r.order, null, `${c.name}：调用方据此保持票 03 的原序`);
    assert.equal(r.requestMade, true, c.name);
  }
  resetRerankState();
});

test('topN 截断：只送前 N 条去打分，尾部按原下标原序保留，条数不变', async () => {
  resetRerankState();
  const hits = mkHits(5);
  const { fetchImpl, calls } = okFetch({ results: [
    { index: 0, relevance_score: 0.1 },
    { index: 1, relevance_score: 0.9 },
    { index: 2, relevance_score: 0.5 }
  ] });
  const r = await rerankCandidates({
    hits, query: 'q', cfg: enabledCfg({ rerankTopN: 3 }), fetchImpl, now: 1
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  // 前 3 条按分数降序 idx1(0.9), idx2(0.5), idx0(0.1)；尾部 3,4 原序保留。
  assert.deepEqual(r.order, [1, 2, 0, 3, 4]);
  assert.equal(r.order.length, hits.length, '只重排、不增不删');
  assert.deepEqual(r.order.slice(3), [3, 4], '尾部候选按原下标原序保留');
  assert.deepEqual(r.scores, [0.1, 0.9, 0.5, null, null], '没送去打分的尾部没有分数');
  const payload = JSON.parse(calls[0].opts.body);
  assert.equal(payload.documents.length, 3, '只送前 N 条去打分');
  assert.equal(payload.top_n, 3);
  assert.deepEqual(payload.documents, ['文档 0', '文档 1', '文档 2']);
  assert.equal(calls.length, 1);
  resetRerankState();
});

test('HTTP 非 2xx / fetch 抛普通 Error → 稳定降级码，order===null', async () => {
  resetRerankState();
  const httpFetch = async () => ({ ok: false, status: 503, text: async () => '' });
  const r1 = await rerankCandidates({ hits: mkHits(2), query: 'q', cfg: enabledCfg(), fetchImpl: httpFetch, now: 1 });
  assert.equal(r1.degraded, RERANK_DEGRADED.HTTP_ERROR);
  assert.equal(r1.order, null);
  resetRerankState();
  const throwFetch = async () => { throw new Error('network down'); };
  const r2 = await rerankCandidates({ hits: mkHits(2), query: 'q', cfg: enabledCfg(), fetchImpl: throwFetch, now: 1 });
  assert.equal(r2.degraded, RERANK_DEGRADED.FAILED);
  assert.equal(r2.order, null);
  resetRerankState();
});

test('源码守卫：IO 不渗纯函数层 / 不写真值 / 四处白名单 / 4 个真值层零 diff', () => {
  // 与 test/recall-policy.mjs 同一口径：文件头注释里的「不进 encodingIdentity /
  // sourceHash」是纪律声明，剥离注释后只检查代码体，别因提到名字就判违规。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    .toLowerCase();
  const rrCode = stripComments(read('src/core/rerank-backend.mjs'));
  for (const word of ['writefilesync', 'encodingidentity', 'sourcehash']) {
    assert.ok(!rrCode.includes(word), `rerank-backend.mjs 代码体不得出现 ${word}`);
  }
  // 纯函数层连 fetch( 都不能出现：I/O 没有渗进 recall-policy.mjs。
  assert.ok(!read('src/core/recall-policy.mjs').includes('fetch('),
    'recall-policy.mjs 不得出现 fetch(');

  // router.mjs 恰好 4 处 await 调用点（关键词主路 / auto 降级路 / 向量路 / kind=event 向量路）。
  const router = read('src/router.mjs');
  assert.equal((router.match(/const pol = await applyRecallPolicy\(rt,/g) || []).length, 4);

  // 四处配置白名单都含全部 6 个 RERANK_SETTINGS_KEYS。
  const whitelists = ['src/core/backend.mjs', 'src/core/settings-editor.mjs',
    'src/standalone/service.mjs', 'adapters/qq-agent/plugin.json'];
  for (const f of whitelists) {
    const src = read(f);
    for (const key of RERANK_SETTINGS_KEYS) assert.ok(src.includes(key), `${f} 缺 ${key}`);
  }

  // 四个真值层文件相对 c06e8fe 的 git diff --name-only 必须为空（票 04 不碰真值层）。
  const truthFiles = ['src/core/factstore.mjs', 'src/core/vecstore.mjs',
    'src/core/vector-generation.mjs', 'src/core/embed.mjs'];
  const diff = execFileSync('git',
    ['diff', '--name-only', 'c06e8fe', '--', ...truthFiles],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(diff.trim(), '', '票 04 不得改动任何真值层文件');
});

test('降级时「原序不变」：结构断言（端到端顺序回退由票 05 质量回归覆盖，此处是结构断言）', () => {
  // ⚠️ 这是结构断言，不是端到端实跑：applyRecallPolicy 未导出，本专项无法直接驱动
  //    四条召回路径。端到端「降级后顺序 == 票 03 out.hits」由票 05 质量回归覆盖，
  //    此处只锁住 router.mjs 里那段源码的结构，防止有人把回落基线换成 store 原始 hits。
  const src = read('src/router.mjs');
  // 回落基线必须是票 03 rerankHits() 的 out.hits（不是 store 原始 hits）。
  assert.match(src, /let finalHits = out\.hits;/);
  // 只有精排成功且 applied 分支才 finalHits = ordered；全文件 finalHits 赋值恰好 2 处
  // （初始化 + 成功分支），多一处即意味着降级分支偷偷换序。
  assert.match(src, /finalHits = ordered;/);
  assert.equal((src.match(/finalHits =/g) || []).length, 2);
  assert.match(src, /return \{ hits: trim\(finalHits\), policy: diagnostics \};/);
  // 进一步截取降级 else 分支（rr.ok 的 else 到 recordIds 记账之前），
  // 断言这一段只重算 diagnostics、proposedOrder 置 null，绝不碰 finalHits。
  const elseStart = src.indexOf('} else {', src.indexOf('if (rr.ok'));
  const elseEnd = src.indexOf('if (recordIds.length)', elseStart);
  assert.ok(elseStart > 0 && elseEnd > elseStart, '必须能定位到降级 else 分支');
  const degradeBranch = src.slice(elseStart, elseEnd);
  assert.match(degradeBranch, /diagnostics =/);
  assert.match(degradeBranch, /proposedOrder: null/);
  assert.ok(!degradeBranch.includes('finalHits'), '降级分支不得给 finalHits 赋值');
});
