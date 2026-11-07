// src/core/rerank-backend.mjs —— 票 04 可选 cross-encoder 精排后端（外部 HTTP 客户端）
// [by:WorkBuddy] 2026-11-07
//
// 职责：把「票 03 多信号重排后的同类候选」送到一个**独立外部** rerank 服务逐对打分，
// 用返回的相关性分数得到一个建议顺序。vec-memory 只做 HTTP 客户端：不内嵌模型、
// 不引入第三方 embedding、不写任何真值层、不进 encodingIdentity / sourceHash。
//
// 协议（D1）：POST {baseURL}/rerank
//   body    { model, query, documents: [string], top_n }
//   成功     { results: [{ index, relevance_score }] }
//   兼容     { data: [...] } 或顶层数组；行内分数也接受 `score`（TEI 形态）。
//   index 是**原始文档下标**（0..documents.length-1），用来把分数映射回 hits。
//
// 失败纪律：超时 / 条数不符 / 非 JSON / HTTP 错误 / 载荷非法 ⇒ 稳定 degraded 码，
//   不抛 5xx、不退回关键词支路（那是另一种语义），由调用方回落到票 03 的 out.hits。
//   连续 3 次 degraded ⇒ 进程内内存熔断，跳过精排（不落盘、不改配置、不进编码身份）。
//
// 这个文件**含 I/O（fetch）**，刻意与纯函数层 recall-policy.mjs 分开（那边有禁词守卫，
// 见 test/recall-policy.mjs 的源码断言）。本文件不 import 任何真值层模块。

export const RERANK_SETTINGS_KEYS = Object.freeze([
  'rerankEnabled', 'rerankBaseURL', 'rerankApiKey', 'rerankModel',
  'rerankTimeoutMs', 'rerankTopN'
]);

// 默认关闭（fail-closed）：不配就零请求、零新增响应字段、externalModelRequests 保持 0。
// timeoutMs：默认 400ms、硬上限 800ms（/search 总预算 1500ms，需要给回退留余量）。
// topN：0 = 不设上限（把全部候选都送去打分）；>0 时只送前 N 条，其余按原序保留。
export const RERANK_DEFAULTS = Object.freeze({
  enabled: false,
  baseURL: '',
  apiKey: '',
  model: '',
  timeoutMs: 400,
  topN: 0
});
export const RERANK_TIMEOUT_HARD_CAP_MS = 800;
export const RERANK_DEGRADE_LIMIT = 3;
const RERANK_TOPN_MAX = 200;

// 稳定降级码（票面建议集）。调用方按码分支：文案可漂、码不漂。
export const RERANK_DEGRADED = Object.freeze({
  TIMEOUT: 'RERANK_TIMEOUT',
  COUNT_MISMATCH: 'RERANK_COUNT_MISMATCH',
  BAD_JSON: 'RERANK_BAD_JSON',
  HTTP_ERROR: 'RERANK_HTTP_ERROR',
  FAILED: 'RERANK_FAILED',
  DISABLED: 'RERANK_DISABLED'
});

function badRerank(enabled, reason, detail) {
  return { ...RERANK_DEFAULTS, ok: false, enabled, reason, detail };
}

/**
 * 严格解析精排配置。任何非法值都显式返回 ok:false + 稳定原因，绝不「差不多就用」。
 * `enabled` 在任何返回里都反映用户的开关意图，好让调用方区分「默认关闭」与「配错」。
 *
 * @param {object} settings
 * @returns {{ok:boolean, enabled:boolean, baseURL:string, apiKey:string, model:string,
 *   timeoutMs:number, topN:number, reason:string|null, detail:string|null}}
 */
export function parseRerankConfig(settings = {}) {
  const src = settings && typeof settings === 'object' ? settings : {};
  let enabled = RERANK_DEFAULTS.enabled;
  const rawEnabled = src.rerankEnabled;
  if (rawEnabled !== undefined && rawEnabled !== null) {
    if (typeof rawEnabled !== 'boolean') {
      return badRerank(true, 'RERANK_CONFIG_INVALID', 'rerankEnabled must be a boolean');
    }
    enabled = rawEnabled;
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const baseURL = str(src.rerankBaseURL);
  const apiKey = str(src.rerankApiKey);
  const model = str(src.rerankModel);

  let timeoutMs = RERANK_DEFAULTS.timeoutMs;
  if (src.rerankTimeoutMs !== undefined && src.rerankTimeoutMs !== null
    && String(src.rerankTimeoutMs).trim() !== '') {
    const n = Number(src.rerankTimeoutMs);
    if (!Number.isFinite(n) || n <= 0) {
      return badRerank(enabled, 'RERANK_CONFIG_INVALID', 'rerankTimeoutMs must be a positive finite number');
    }
    timeoutMs = Math.min(RERANK_TIMEOUT_HARD_CAP_MS, Math.max(1, Math.round(n)));
  }

  let topN = RERANK_DEFAULTS.topN;
  if (src.rerankTopN !== undefined && src.rerankTopN !== null
    && String(src.rerankTopN).trim() !== '') {
    const n = Number(src.rerankTopN);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > RERANK_TOPN_MAX) {
      return badRerank(enabled, 'RERANK_CONFIG_INVALID',
        `rerankTopN must be an integer 0..${RERANK_TOPN_MAX} (0 = unlimited)`);
    }
    topN = n;
  }

  // 只有真正开启才要求端点与模型；关闭时缺这些不算错 ⇒ 旧配置照常启动。
  if (enabled) {
    if (!baseURL || !model) {
      return badRerank(true, 'RERANK_CONFIG_INVALID',
        'rerankEnabled requires non-empty rerankBaseURL and rerankModel');
    }
    let parsedURL;
    try { parsedURL = new URL(baseURL); }
    catch { return badRerank(true, 'RERANK_CONFIG_INVALID', 'rerankBaseURL is not a valid URL'); }
    if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
      return badRerank(true, 'RERANK_CONFIG_INVALID', 'rerankBaseURL must be an http(s) URL');
    }
  }

  return { ok: true, enabled, baseURL, apiKey, model, timeoutMs, topN, reason: null, detail: null };
}

// ── 进程内内存熔断（不落盘、不改配置、不进 encodingIdentity）[by:WorkBuddy] ──
// 连续 3 次 degraded ⇒ autoDisabled，本进程余下请求直接跳过精排，避免对一个明显
// 不健康的服务反复烧 400ms 预算。状态只在内存里，重启归零；不写任何文件。
const breaker = { consecutiveDegraded: 0, autoDisabled: false, totalDegraded: 0, totalSuccess: 0 };

/** 只读快照，供 diagnostics 与测试观察。 */
export function rerankState() {
  return { ...breaker };
}
/** 仅测试用：把熔断状态清回初始（生产中不需要，重启即归零）。 */
export function resetRerankState() {
  breaker.consecutiveDegraded = 0;
  breaker.autoDisabled = false;
  breaker.totalDegraded = 0;
  breaker.totalSuccess = 0;
}
function noteDegraded() {
  if (breaker.autoDisabled) return;
  breaker.totalDegraded += 1;
  breaker.consecutiveDegraded += 1;
  if (breaker.consecutiveDegraded >= RERANK_DEGRADE_LIMIT) breaker.autoDisabled = true;
}
function noteSuccess() {
  breaker.totalSuccess += 1;
  breaker.consecutiveDegraded = 0; // 成功打断连续失败计数
}

const documentText = (h) => String(
  (h && h.meta && h.meta.text) ?? (h && h.text) ?? (h && h.meta && h.meta.title) ?? ''
);

/** 统一构造返回值，保证每个分支字段齐全（降级分支也带真因、带熔断快照）。 */
function makeResult(started, now, hits, partial) {
  return {
    ok: false,
    order: null,
    scores: null,
    degraded: null,
    detail: null,
    autoDisabled: breaker.autoDisabled,
    requestMade: false,
    skipped: true,
    at: now,
    latencyMs: Date.now() - started,
    count: Array.isArray(hits) ? hits.length : 0,
    ...partial
  };
}

/** 一次「服务端/响应」失败：记一次连续 degraded，并刷新熔断标志。 */
function failDegraded(code, detail) {
  noteDegraded();
  return {
    ok: false, order: null, scores: null, degraded: code, detail,
    autoDisabled: breaker.autoDisabled, requestMade: true, skipped: false
  };
}

/**
 * 把候选送给外部 rerank 服务，返回按相关性排序的「原始下标」顺序。
 *
 * @param {object} p
 * @param {Array}   p.hits        票 03 rerankHits() 的 out.hits（同类候选，已被放大召回）
 * @param {string}  p.query       已归一化的查询串
 * @param {object}  p.cfg         parseRerankConfig() 的产物（ok:true / enabled:true）
 * @param {Function}p.fetchImpl   注入的 fetch（stub 测试用），默认 globalThis.fetch
 * @param {number}  p.now         参考时间戳（可注入，便于确定性测试）
 * @param {AbortSignal|null} p.signal 可选外部取消信号（如客户端断开）；与超时信号 any 合并
 * @returns {Promise<{ok:boolean, order:number[]|null, scores:Array|null, degraded:string|null,
 *   detail:string|null, autoDisabled:boolean, requestMade:boolean, skipped:boolean,
 *   at:number, latencyMs:number, count:number}>}
 */
export async function rerankCandidates({
  hits = [], query = '', cfg, fetchImpl = globalThis.fetch, now = Date.now(),
  signal: externalSignal = null
} = {}) {
  const started = Date.now();
  const count = Array.isArray(hits) ? hits.length : 0;

  // 配置非法 / 默认关闭 / 熔断跳闸 / 候选不足 / 无 fetch ⇒ 零请求，原顺序交给调用方。
  if (!cfg || cfg.ok === false) {
    return makeResult(started, now, hits, {
      degraded: RERANK_DEGRADED.FAILED, detail: cfg?.detail || 'invalid rerank config',
      autoDisabled: breaker.autoDisabled, requestMade: false, skipped: true
    });
  }
  if (!cfg.enabled || breaker.autoDisabled) {
    return makeResult(started, now, hits, {
      degraded: RERANK_DEGRADED.DISABLED,
      detail: breaker.autoDisabled ? 'auto-disabled after consecutive degraded' : 'rerank disabled by config',
      autoDisabled: breaker.autoDisabled, requestMade: false, skipped: true
    });
  }
  if (!Array.isArray(hits) || hits.length < 2 || typeof fetchImpl !== 'function') {
    return makeResult(started, now, hits, {
      degraded: RERANK_DEGRADED.FAILED, detail: 'too few candidates or fetch unavailable',
      autoDisabled: breaker.autoDisabled, requestMade: false, skipped: true
    });
  }

  const cap = cfg.topN > 0 ? Math.min(cfg.topN, hits.length) : hits.length;
  const documents = hits.slice(0, cap).map(documentText);
  const url = `${cfg.baseURL.replace(/\/+$/, '')}/rerank`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const payload = { model: cfg.model, query: String(query || ''), documents, top_n: documents.length };
  const timeoutMs = Math.min(RERANK_TIMEOUT_HARD_CAP_MS,
    Math.max(1, Number(cfg.timeoutMs) || RERANK_DEFAULTS.timeoutMs));

  // 参考 embed.mjs:231-232/245/334：AbortController + 超时 + finally clearTimeout，
  // 有外部取消信号时用 AbortSignal.any 合并。在线热路径 retries=0（不重试）。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal;
  try {
    const res = await fetchImpl(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal
    });
    if (!res || !res.ok) {
      return makeResult(started, now, hits,
        failDegraded(RERANK_DEGRADED.HTTP_ERROR, `rerank 端点返回 ${res?.status ?? '?'}`));
    }
    let text;
    try { text = await res.text(); }
    catch (e) {
      return makeResult(started, now, hits,
        failDegraded(RERANK_DEGRADED.BAD_JSON, `读取响应失败：${String(e?.message || e).slice(0, 120)}`));
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      return makeResult(started, now, hits,
        failDegraded(RERANK_DEGRADED.BAD_JSON, `响应不是合法 JSON：${String(text).slice(0, 120)}`));
    }

    const rows = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed?.results) ? parsed.results
        : Array.isArray(parsed?.data) ? parsed.data : null);
    if (!rows) {
      return makeResult(started, now, hits,
        failDegraded(RERANK_DEGRADED.BAD_JSON, '响应 JSON 里找不到 results/data/数组'));
    }
    if (rows.length !== documents.length) {
      return makeResult(started, now, hits,
        failDegraded(RERANK_DEGRADED.COUNT_MISMATCH,
          `返回条数不符：要 ${documents.length} 条，得到 ${rows.length} 条`));
    }

    const seen = new Set();
    const scored = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const idx = Number(row.index);
      const rawScore = row.relevance_score ?? row.score;
      const score = Number(rawScore);
      if (!Number.isInteger(idx) || idx < 0 || idx >= documents.length || seen.has(idx)) {
        return makeResult(started, now, hits,
          failDegraded(RERANK_DEGRADED.FAILED, `第 ${i} 条 index 越界或重复：${String(row.index)}`));
      }
      if (!Number.isFinite(score)) {
        return makeResult(started, now, hits,
          failDegraded(RERANK_DEGRADED.FAILED, `第 ${i} 条 relevance_score 不是有限数：${String(rawScore)}`));
      }
      seen.add(idx);
      scored.push({ index: idx, score });
    }
    // 平局用原始下标稳定；这是把「外部分数」映回 hits 的唯一依据。
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const headOrder = scored.map((x) => x.index);
    // topN 截断时，没送去打分的尾部候选按原下标原序保留（只重排、不增不删）。
    const order = headOrder.concat(Array.from({ length: hits.length - cap }, (_, i) => cap + i));
    const byIndex = new Map(scored.map((x) => [x.index, x.score]));
    const scores = Array.from({ length: hits.length }, (_, i) =>
      (byIndex.has(i) ? byIndex.get(i) : null));
    noteSuccess();
    return makeResult(started, now, hits, {
      ok: true, order, scores, degraded: null, detail: null,
      autoDisabled: false, requestMade: true, skipped: false
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || ctrl.signal.aborted;
    return makeResult(started, now, hits, failDegraded(
      aborted ? RERANK_DEGRADED.TIMEOUT : RERANK_DEGRADED.FAILED,
      aborted ? `${timeoutMs}ms 内没回应` : String(err?.message || err).slice(0, 160)
    ));
  } finally {
    clearTimeout(timer);
  }
}
