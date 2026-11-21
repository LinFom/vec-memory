// M4 第二段（LLM 模式判定）· 单元测试（纯离线：LLM 由桩注入，不联网、不读存档）。
//
// 覆盖清单（对面 `0033` 开工单逐条）：
//   ① 出境白名单字段（多一字段都不行，rawExemplar 永不出现）
//   ② 占位符双向断言（输入侧：明文 id ⇒ 整批拒收；输出侧：回显明文 ⇒ 该簇降级）
//   ③ 枚举外值 ⇒ 直接 ambiguous，不重试
//   ④ 格式错 ⇒ 重试一次；仍失败 ⇒ 整批跳过 + LLM_PARSE_FAILED（不落 ambiguous）
//   ⑤ LLM_PARSE_FAILED 与 ambiguous 在观测层可区分（reason 单列）
//   ⑥ dryRun 不落库、不调 LLM、回传完整出境内容
//   ⑦ 退避不是重试队列（失败翻倍间隔、拒绝即跳过、成功归零）
//   ⑧ endpointKind 缺省 ⇒ 拒绝启动（fail-closed）
//   ⑨ 簇级原子（一个非法 fact kind ⇒ 整簇降级，facts 丢弃）
//   ⑩ 落库计划 + FactStore 真盘（临时目录）：pattern + semantic 槽都写、证据带簇成员 id
//
// 测试纪律：**全套件通用纪律的单一来源在 `test/README.md`**（别在此手抄，会分叉）。
// 本文件相关的一条：**子串断言必须圈定范围** —— 曾用 `JSON.stringify(prompt).includes('self')`
// 断言"self 不在出境里"，命中的是 system 提示的 "it**self**"（详见 README §纪律 1）。
//
// 运行：node test/judge.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PATTERN_TYPES, SEMANTIC_KINDS, OUTBOUND_FIELDS,
  JudgeError, RateLimiter, containsBareId, BARE_ID_RE,
  buildOutboundRecord, buildBatchPrompt, parseBatchResponse, planClusterWrites, runJudgeBatch,
  SYSTEM_MESSAGE_MARKERS, isSystemMessage, looksLikeSymbolFragment
} from '../src/core/judge.mjs';
import { openFactStore } from '../src/core/factstore.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));


const throws = (fn, code) => {
  try { fn(); return code === null; }
  catch (err) { return code === null ? false : err?.code === code; }
};
const throwsAsync = async (fn, code) => {
  try { await fn(); return code === null; }
  catch (err) { return code === null ? false : err?.code === code; }
};

/** 造一个"已触发"的最小簇（占位符形态合法）。 */
function mkCluster(over = {}) {
  return {
    speaker: 'P1001', target: 'P1002', scope: 'group:C2001',
    size: 3, verbatim: false,
    exemplar: '在吗在吗在吗', rawExemplar: '在吗在吗在吗',
    memberIds: ['m1', 'm2', 'm3'],
    times: [1000, 2000, 3000], spanMs: 2000,
    ...over
  };
}

console.log('\n══ M4 第二段 · LLM 判定（出境断言 / 解析降级 / dryRun / 频率闸门）════════');

// ── ① 白名单与裸号码检测 ────────────────────────────────────────────────────
{
  console.log('\n── ① 出境白名单（封闭枚举）──');
  ok(PATTERN_TYPES.length === 3 && PATTERN_TYPES.includes('ambiguous'), 'PATTERN_TYPES = 封闭三态', PATTERN_TYPES.join('/'));
  ok(Object.isFrozen(PATTERN_TYPES) && Object.isFrozen(SEMANTIC_KINDS), '两个枚举都 frozen（封闭集合不许运行期改）');

  const rec = buildOutboundRecord(mkCluster(), 0);
  ok(OUTBOUND_FIELDS.every((k) => k in rec), '出境记录含全部白名单字段', OUTBOUND_FIELDS.join(','));
  ok(Object.keys(rec).every((k) => OUTBOUND_FIELDS.includes(k)), '出境记录**不含**白名单之外的字段');
  ok(!('rawExemplar' in rec) && !('times' in rec), 'rawExemplar / 原始时间戳 **不出境**（times 只以 spanMs 派生形态出境）');

  ok(!containsBareId('在吗在吗〔P7722〕在吗'), '占位符 4 位数字不误伤');
  ok(!containsBareId('〔P123456〕你好'), '占位符长数字（P 前缀）不误伤');
  ok(!containsBareId('group:C12345 里聊'), 'scope 占位符 group:C#### 不误伤');
  ok(!containsBareId('买了 1234567890123 个'), '13 位订单号式长数字不误伤');
  ok(containsBareId('1353446252 你在吗'), '裸 QQ 号命中');
  ok(containsBareId('group:1098345913 冒号后裸数字'), '明文会话键命中');
  ok(throws(() => buildOutboundRecord(mkCluster({ exemplar: '加我 1353446252' }), 0), 'RAW_ID_OUTBOUND'),
    'exemplar 含裸号码 ⇒ 拒绝出境（RAW_ID_OUTBOUND）');

  // 字段级明文（输入侧断言）
  ok(throws(() => buildOutboundRecord(mkCluster({ speaker: '1353446252' }), 0), 'RAW_ID_OUTBOUND'),
    'speaker 明文 QQ ⇒ RAW_ID_OUTBOUND');
  ok(throws(() => buildOutboundRecord(mkCluster({ scope: 'group:1098345913' }), 0), 'RAW_ID_OUTBOUND'),
    'scope 明文群号 ⇒ RAW_ID_OUTBOUND');
  ok(throws(() => buildOutboundRecord(mkCluster({ speaker: '' }), 0), 'PLAIN_IDENTITY'),
    'speaker 为空 ⇒ PLAIN_IDENTITY（身份键分量缺省即抛）');
  ok(throws(() => buildOutboundRecord(mkCluster({ target: '' }), 0), null) === true,
    'target 可空（说话人级簇）—— `throws(fn, null)` = 期待不抛');
  ok(throws(() => buildOutboundRecord(mkCluster({ exemplar: '   ' }), 0), 'EMPTY_EXEMPLAR'),
    'exemplar 空 ⇒ EMPTY_EXEMPLAR');
}

// ── ② prompt 组装 ───────────────────────────────────────────────────────────
{
  console.log('\n── ② prompt 组装（标准进 system，user 只放 JSON）──');
  const p = buildBatchPrompt([mkCluster(), mkCluster({ speaker: 'P1003', exemplar: '哈哈哈哈哈哈' })]);
  ok(p.system.includes('joke') && p.system.includes('sincere') && p.system.includes('ambiguous'),
    'system 段含三态判定标准');
  ok(p.system.includes('anonymity'), 'system 段声明占位符是 anonymity token');
  const parsedUser = JSON.parse(p.user);
  ok(Array.isArray(parsedUser) && parsedUser.length === 2, 'user 段是**纯 JSON 数组**（无自然语言包装）');
  ok(parsedUser[0].idx === 0 && parsedUser[1].idx === 1, 'idx 内部索引齐全（映射回簇用）');
  ok(p.fieldsSent.length === OUTBOUND_FIELDS.length, `fieldsSent = 白名单清单（${p.fieldsSent.length} 字段）`);
  ok(throws(() => buildBatchPrompt([mkCluster(), mkCluster({ speaker: '12345678' })]), 'RAW_ID_OUTBOUND'),
    '**一个坏簇 ⇒ 整批拒收**（上游归一化坏了是系统性信号）');
}

// ── ③ 解析：格式错 vs 枚举外 ────────────────────────────────────────────────
{
  console.log('\n── ③ 响应解析（失败分两类）──');
  const good = JSON.stringify([
    { idx: 0, pattern_type: 'joke', facts: [], confidence_note: 'ok' },
    { idx: 1, pattern_type: 'sincere', facts: [{ kind: 'preference', text: '喜欢被夸' }], confidence_note: '' }
  ]);
  const r = parseBatchResponse(good, { count: 2 });
  ok(r.ok && r.results.length === 2, '合法响应解析通过');
  ok(r.results[1].patternType === 'sincere' && r.results[1].facts.length === 1, 'facts 透传');

  // 格式错（retryable）
  const f1 = parseBatchResponse('not json {', { count: 1 });
  ok(!f1.ok && f1.retryable && f1.reason === 'FORMAT_JSON', 'JSON 不合法 ⇒ FORMAT_JSON + retryable');
  const f2 = parseBatchResponse('[{"idx":0}]', { count: 1 });
  ok(!f2.ok && f2.retryable && f2.reason === 'FORMAT_FIELDS', '缺 pattern_type ⇒ FORMAT_FIELDS + retryable');
  const f3 = parseBatchResponse('[{"idx":0,"pattern_type":"joke","facts":[]}]', { count: 2 });
  ok(!f3.ok && f3.retryable && f3.reason === 'FORMAT_FIELDS', '漏答一簇 ⇒ FORMAT_FIELDS（响应不完整）');
  const f4 = parseBatchResponse('{"idx":0}', { count: 1 });
  ok(!f4.ok && f4.retryable && f4.reason === 'FORMAT_JSON', '非数组 ⇒ FORMAT_JSON');
  const f5 = parseBatchResponse('[{"idx":0,"pattern_type":"joke","facts":[{"kind":"joke","text":" "}]}]', { count: 1 });
  ok(!f5.ok && f5.retryable && f5.reason === 'FORMAT_FIELDS', 'fact.text 空白 ⇒ FORMAT_FIELDS（结构问题走 retry）');

  // 枚举外（不 retry，降级）
  const e1 = parseBatchResponse('[{"idx":0,"pattern_type":"rant","facts":[]}]', { count: 1 });
  ok(e1.ok && e1.results[0].patternType === 'ambiguous' && e1.results[0].degraded === 'OUT_OF_ENUM',
    'pattern_type 枚举外 ⇒ 直接 ambiguous + OUT_OF_ENUM（**不重试**）');

  // 输出侧反向泄漏
  const e2 = parseBatchResponse('[{"idx":0,"pattern_type":"joke","facts":[],"confidence_note":"qq 1353446252 said"}]', { count: 1 });
  ok(e2.ok && e2.results[0].patternType === 'ambiguous' && e2.results[0].degraded === 'RAW_ID_ECHO',
    'confidence_note 回显明文 id ⇒ 该簇 ambiguous + RAW_ID_ECHO（明文也出不来）');
  const e2b = parseBatchResponse('[{"idx":0,"pattern_type":"joke","facts":[{"kind":"event","text":"群里 1353446252 出现"}]}]', { count: 1 });
  ok(e2b.ok && e2b.results[0].degraded === 'RAW_ID_ECHO', 'facts 文本回显明文 id ⇒ 同样拦');

  // 簇级原子
  const e3 = parseBatchResponse('[{"idx":0,"pattern_type":"joke","facts":[{"kind":"mood","text":"开心"}]}]', { count: 1 });
  ok(e3.ok && e3.results[0].patternType === 'ambiguous' && e3.results[0].degraded === 'FACT_KIND_OUT_OF_ENUM' && e3.results[0].facts.length === 0,
    'fact kind 枚举外 ⇒ **整簇降级**（判定与事实同生共死，facts 丢弃）');
}

// ── ④/⑤ 批处理：重试、LLM_PARSE_FAILED、skip ───────────────────────────────
{
  console.log('\n── ④⑤ 批处理（格式错重试 1 次 / 解析失败独立 reason / 不可达跳过）──');
  const clusters = [mkCluster(), mkCluster({ speaker: 'P1003', exemplar: '哈哈哈哈哈哈' })];
  const goodResp = JSON.stringify([
    { idx: 0, pattern_type: 'joke', facts: [], confidence_note: '' },
    { idx: 1, pattern_type: 'sincere', facts: [{ kind: 'preference', text: '喜欢长句' }], confidence_note: '' }
  ]);

  // endpointKind fail-closed
  ok(await throwsAsync(() => runJudgeBatch({ clusters, callLlm: async () => goodResp, endpointKind: '' }), 'NO_ENDPOINT_KIND'),
    'endpointKind 缺省 ⇒ NO_ENDPOINT_KIND（dryRun 也拒 —— 先声明去哪）');
  ok(await throwsAsync(() => runJudgeBatch({ clusters, callLlm: async () => goodResp, endpointKind: 'cloud' }), 'NO_ENDPOINT_KIND'),
    'endpointKind 非法值 ⇒ NO_ENDPOINT_KIND');

  // happy path
  let calls = 0;
  const okRun = await runJudgeBatch({
    clusters, endpointKind: 'local',
    callLlm: async () => { calls++; return goodResp; }
  });
  ok(okRun.ok && calls === 1, '成功路径：一次调用（一批一调）', `calls=${calls}`);
  ok(okRun.writes.length === 2 && okRun.writes[0].patternPut.fact_kind === 'pattern', '每簇一条 pattern 槽写入计划');
  ok(okRun.writes[1].factPuts.length === 1 && okRun.writes[1].factPuts[0].fact_kind === 'preference', '语义事实随判定同批落');
  ok(okRun.writes[0].patternPut.content.self_n === 0 && okRun.writes[1].factPuts[0].content.self_n === 0,
    '落槽带 self_n（缺省 selfN ⇒ 0，不炸不猜）');
  const selfPlan = planClusterWrites(mkCluster({ selfN: 2 }), { patternType: 'joke', reason: 'OK', facts: [] });
  ok(selfPlan.patternPut.content.self_n === 2, '★ self_n 标注：self=true 成员数进槽（**不排除、只标注**，分析层可区分贡献）');

  // ★ `target`（对谁）必须原样传进**槽键的两个落点**（`patternPut` 与每个 `factPut`）——
  //   槽键 = `(speaker, target, fact_kind, scope)`。丢了它，`ROADMAP #97` 就白做：
  //   同一句话 @ 甲 与 @ 乙 会塌回同一条槽（正是"恒空 target"的老毛病）。
  const tPlan = planClusterWrites(mkCluster({ target: 'P1002' }), {
    patternType: 'joke', reason: 'OK', facts: [{ kind: 'event', text: '甲和乙一起去过线下' }]
  });
  ok(tPlan.patternPut.target === 'P1002', '`target` 进 `patternPut`（槽键分量）', `= ${JSON.stringify(tPlan.patternPut.target)}`);
  ok(tPlan.factPuts.length === 1 && tPlan.factPuts[0].target === 'P1002', '`target` 进每个 `factPut`', `= ${JSON.stringify(tPlan.factPuts[0]?.target)}`);
  const tPlan2 = planClusterWrites(mkCluster({ target: 'P1003' }), { patternType: 'joke', reason: 'OK', facts: [] });
  ok(tPlan2.patternPut.target !== tPlan.patternPut.target,
    '★ 换一个 target ⇒ plan 里的 target 跟着变（同一句话对不同人 = 不同槽）');
  // ⚠️ 圈定范围：只查**出境记录**这条 JSON，不查整个 prompt（见文件头测试纪律 —— "itself" 乌龙）
  ok(!JSON.stringify(buildOutboundRecord(mkCluster({ selfN: 2 }), 0)).includes('self'),
    'self 标注**不进出境白名单**（判定不需要它，不动 OUTBOUND_FIELDS 契约）');
  ok(okRun.log.fieldsSent.length > 0 && okRun.log.clusterIds.length === 2 && !JSON.stringify(okRun.log).includes('在吗'),
    '日志无内容（只有字段名与簇下标）');

  // 格式错重试一次后成功
  let n = 0;
  const retryRun = await runJudgeBatch({
    clusters, endpointKind: 'local',
    callLlm: async () => { n++; return n === 1 ? 'oops not json' : goodResp; }
  });
  ok(retryRun.ok && n === 2, '格式错 ⇒ 重试 1 次后成功', `calls=${n}`);

  // 格式错重试仍失败 ⇒ LLM_PARSE_FAILED（不落 ambiguous）
  let n2 = 0;
  const failRun = await runJudgeBatch({
    clusters, endpointKind: 'local',
    callLlm: async () => { n2++; return 'still not json'; }
  });
  ok(!failRun.ok && failRun.skipped && failRun.reason === 'LLM_PARSE_FAILED' && n2 === 2,
    '重试仍失败 ⇒ 整批跳过 + LLM_PARSE_FAILED（fail-visible）', `calls=${n2}`);
  ok(!('results' in failRun) && !('writes' in failRun), '解析失败 ⇒ **零写入计划**（"没判成"不落 ambiguous）');

  // LLM 不可达 ⇒ 跳过、不重试
  let n3 = 0;
  const downRun = await runJudgeBatch({
    clusters, endpointKind: 'local',
    callLlm: async () => { n3++; throw new Error('ECONNREFUSED'); }
  });
  ok(!downRun.ok && downRun.skipped && downRun.reason === 'LLM_UNAVAILABLE' && n3 === 1,
    'LLM 不可达 ⇒ 本轮跳过，**不重试不排队**（退避只拉长批间间隔）');

  // 空批
  const emptyRun = await runJudgeBatch({
    clusters: [mkCluster({ size: 1 })], endpointKind: 'local', callLlm: async () => goodResp
  });
  ok(!emptyRun.ok && emptyRun.reason === 'EMPTY_BATCH', '无一触发 ⇒ EMPTY_BATCH（触发过滤在批内做）');

  // 触发过滤：verbatim / size 不足的不进批
  let seen = -1;
  await runJudgeBatch({
    clusters: [
      mkCluster({ verbatim: true }),
      mkCluster({ size: 2, speaker: 'P1004' }),
      mkCluster({ speaker: 'P1005', exemplar: '别急别急别急' })
    ],
    endpointKind: 'local',
    callLlm: async ({ user }) => { seen = JSON.parse(user).length; return JSON.stringify([{ idx: 0, pattern_type: 'joke', facts: [] }]); }
  });
  ok(seen === 1, 'shouldTrigger 过滤生效（verbatim / size 不足不出现在 prompt 里）', `seen=${seen}`);
}

// ── ⑥ dryRun ────────────────────────────────────────────────────────────────
{
  console.log('\n── ⑥ dryRun（决定 4：全链路 + 桩，不调 LLM 不落库）──');
  const clusters = [mkCluster(), mkCluster({ speaker: 'P1003', exemplar: '哈哈哈哈哈哈' })];
  let called = false;
  const run = await runJudgeBatch({
    clusters, endpointKind: 'external', dryRun: true,
    callLlm: async () => { called = true; return '[]'; }
  });
  ok(!called, 'dryRun **不调 LLM**（callLlm 未被触达）');
  ok(run.ok && run.dryRun === true, 'dryRun 全链路走通（断言/解析/计划全真）');
  ok(run.results.every((r) => r.patternType === 'ambiguous'), '桩返回全 ambiguous（判定全假，管线全真）');
  ok(run.outbound && run.outbound.user.length > 0 && run.outbound.system.length > 0,
    '回传完整出境内容（system + user）—— 真开 LLM 前能看清会送什么出去');
  ok(!JSON.stringify(run.outbound.user).includes('rawExemplar'), '出境内容里没有 rawExemplar');
  ok(run.log.dryRun === true && run.log.outcome === 'DRY_RUN', '日志标记 dryRun（仪表可区分）');
}

// ── ⑦ 频率闸门（退避 ≠ 队列）────────────────────────────────────────────────
{
  console.log('\n── ⑦ RateLimiter（退避拉长间隔，不是重试队列）──');
  const rl = new RateLimiter({ perMinute: 2, baseDelayMs: 1000, maxDelayMs: 8000 });
  ok(rl.tryAcquire(1000).ok && rl.tryAcquire(1500).ok, '窗口内两次调用放行（perMinute=2）');
  const denied = rl.tryAcquire(2000);
  ok(!denied.ok && denied.why === 'PER_MINUTE', '超每分钟上限 ⇒ 拒绝（调用方跳过，**无队列**）', `retryAfterMs=${denied.retryAfterMs}`);
  ok(rl.tryAcquire(61_000).ok, '窗口滑出 ⇒ 放行');

  const rl2 = new RateLimiter({ perMinute: 100, baseDelayMs: 1000, maxDelayMs: 8000 });
  const d1 = rl2.onFailure(0);
  const d2 = rl2.onFailure(0);
  const d3 = rl2.onFailure(0);
  ok(d1 === 1000 && d2 === 2000 && d3 === 4000, '连续失败 ⇒ 间隔翻倍（指数退避）', `1s→2s→4s`);
  ok(!rl2.tryAcquire(1000).ok && rl2.tryAcquire(1000).why === 'BACKOFF', '退避窗口内 tryAcquire 拒绝（跳过，不排队）');
  ok(rl2.tryAcquire(4001).ok, '退避窗口过后放行');
  rl2.onSuccess();
  ok(rl2.failures === 0 && rl2.blockedUntil === 0, '成功 ⇒ 退避归零');

  // 批处理层：限流拒绝 ⇒ RATE_LIMITED，且不调 LLM
  const rl3 = new RateLimiter({ perMinute: 100 });
  rl3.onFailure(0);   // 人为置一次退避
  let called = false;
  const limited = await runJudgeBatch({
    clusters: [mkCluster()], endpointKind: 'local', rateLimiter: rl3, now: 100,
    callLlm: async () => { called = true; return '[]'; }
  });
  ok(!limited.ok && limited.reason === 'RATE_LIMITED' && !called, '限流中 ⇒ RATE_LIMITED 跳过（callLlm 未触达）');
}

// ── ⑧⑨ 落库计划 + FactStore 真盘 ───────────────────────────────────────────
{
  console.log('\n── ⑧⑨ 落库（簇级原子 + 临时目录真盘）──');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vec-judge-'));
  const store = openFactStore(dir);
  const clusters = [
    mkCluster(),
    mkCluster({ speaker: 'P1003', target: '', exemplar: '早啊早啊早啊', memberIds: ['m4', 'm5'] })
  ];
  const run = await runJudgeBatch({
    clusters, endpointKind: 'local', dryRun: false,
    callLlm: async () => JSON.stringify([
      { idx: 0, pattern_type: 'joke', facts: [{ kind: 'preference', text: '喜欢连发三遍' }], confidence_note: '' },
      { idx: 1, pattern_type: 'sincere', facts: [{ kind: 'mood', text: '非法 kind' }], confidence_note: '' }
    ])
  });
  ok(run.ok && run.writes.length === 2, '批处理完成，两簇都有写入计划');
  ok(run.writes[1].patternPut.content.pattern_type === 'ambiguous' && run.writes[1].factPuts.length === 0,
    '⑨ 簇级原子：非法 fact kind ⇒ 该簇只落 ambiguous 槽、零事实槽');

  // 执行写入计划（backend 的做法）
  for (const w of run.writes) {
    for (const put of [w.patternPut, ...w.factPuts]) store.put(put);
  }
  const st = store.stats();
  ok(st.count === 3, '真盘：3 个槽（P1001 pattern + P1001 preference + P1003 pattern）', `count=${st.count}`);
  ok(st.index.by_logic_version && Object.keys(st.index.by_logic_version).length === 1, 'logic_version 显式落盘（探针输入）');
  const p1001 = store.list({ factKind: 'pattern' }).items.find((r) => r.speaker === 'P1001');
  ok(p1001 && p1001.content.pattern_type === 'joke' && p1001.content.reason === 'OK',
    '⑸ reason 单列进 content（OK 与降级码可区分，不混入 ambiguous 分布）');
  ok(p1001.content.exemplar === '在吗在吗在吗' && p1001.evidence_n === 3, 'pattern 槽带 exemplar 摘要与证据数');
  ok(store.list({ factKind: 'preference' }).items.length === 1, 'preference 槽已落（合法 fact）');
  ok(store.list({ factKind: 'mood' }).items.length === 0, '非法 kind 槽**不存在**（枚举外零落盘）');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑪ 纯系统事件排除 + 符号残片观测（对面 0034 回复的两条建议）───────────────
{
  console.log('\n── ⑪ 系统消息标记（单一来源）与符号残片仪表 ──');

  // SYSTEM_MESSAGE_MARKERS：按证据定清单（实测存档 155 种方括号标记，唯一纯系统事件 = 拍一拍）
  ok(Object.isFrozen(SYSTEM_MESSAGE_MARKERS), 'SYSTEM_MESSAGE_MARKERS 冻结（单一来源，新增只改这一处）');
  ok(SYSTEM_MESSAGE_MARKERS.length === 1 && SYSTEM_MESSAGE_MARKERS[0] === '拍一拍',
    '清单按证据只收 [拍一拍]（撤回/红包/转账/退群在存档里是人类正文的词，不可按词排除）');

  ok(isSystemMessage('[拍一拍] dxxx（开xx）'), '精确标记命中：[拍一拍] 前缀');
  ok(isSystemMessage('哈哈 [拍一拍] 后置也拦'), '标记在中间也命中（消息含系统事件即非人类表达主体）');
  ok(!isSystemMessage('我今天被拍一拍功能吓到了'), '正文里的"拍一拍"**不**命中（无方括号形态）');
  ok(!isSystemMessage('[红包] 收到红包'), '不在清单的标记不命中（宁漏不误剥）');
  ok(!isSystemMessage(''), '空串不命中');
  ok(!isSystemMessage(null), 'null 不命中');

  // looksLikeSymbolFragment：观测仪表，不干预判定（已知代价：纯数字表达会被计，见函数注释）
  ok(looksLikeSymbolFragment('33/3/453-22-'), '符号残片：33/3/453-22- 命中');
  ok(looksLikeSymbolFragment('。。。！！！'), '纯标点命中');
  ok(!looksLikeSymbolFragment('哈哈哈哈'), '正常中文不命中');
  ok(!looksLikeSymbolFragment('在吗在吗在吗'), '重复表达不命中');
  ok(!looksLikeSymbolFragment('okok'), '拉丁字母不命中');
  ok(!looksLikeSymbolFragment('I love you'), '混合字母不命中');
  ok(!looksLikeSymbolFragment('   '), '空白不命中');
  ok(!looksLikeSymbolFragment(''), '空串不命中');
  ok(looksLikeSymbolFragment('666666') === true,
    '已知代价：纯数字命中（口头禅簇到不了 judge；非逐字数字变体只影响计数不影响判定）');
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`judge: ${tally.pass} 通过 / ${tally.fail} 失败`);
process.exitCode = tally.fail ? 1 : 0;
