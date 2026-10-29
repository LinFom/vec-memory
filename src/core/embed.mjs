import { setTimeout as delay } from 'node:timers/promises';
// 嵌入客户端 —— 只做一件事：把文本批量换成向量，并且**失败时报得清清楚楚**。
//
// ── 设计纪律（每一条都对应一个真实踩过的坑）──────────────────────────────
// 1. **说话**。这是整个插件里唯一会联网的地方，也最容易"静默降级"：超时返回空数组、
//    维度对不上照样塞进库、模型名写错返回 404 被 catch 吞掉 —— 全都表现为
//    "向量库是空的但没有任何错误"。所以这里每一种失败都抛带上下文的 Error。
// 2. **维度必须显式校验**。宿主没有 embedding 能力，端点由用户填；换个端点维度就
//    可能从 1024 变成 1536。库里混两种维度的向量，余弦算出来是垃圾且不报错。
//    因此这里把"返回维度"作为返回值的一部分交出去，由调用方与库维度对账。
// 3. **不重试到底**。有限次重试（默认 2），失败即抛。无限重试会把一个配置错误
//    变成一晚上的空转。
// 4. **批量有上限，而且这个上限是端点的外部事实**。默认 10 条/次（见 `DEFAULT_BATCH_SIZE`
//    的来历注释）；端点嫌多时会**明说自己最多收几条**，所以这里不只是"默认小一点"，
//    还**按端点的话自动降批重试**（`parseBatchLimit` + 外层重切），并把探到的上限回报给
//    调用方。截断每条文本发生在 chunkread，不在这里。
// 5. **两侧必须非对称**（ADR-0001 / ADR-0002）。Qwen3-Embedding 这类模型
//    文档侧**不加**指令前缀、查询侧**必须加** `Instruct: …\nQuery:…`。
//    写反了不会报错，只会**静默降分** —— 和漏归一化是同一类病。
//    所以上线的两个入口是 `embedDocuments` / `embedQueries`，不是裸的 `embedTexts`。
const DEFAULT_TIMEOUT_MS = 30_000;

/** Qwen3-Embedding 官方推荐用法的默认任务描述（检索型）。 */
export const DEFAULT_QUERY_INSTRUCTION =
  'Given a web search query, retrieve relevant passages that answer the query';

/**
 * 单批条数的默认值 —— **10**，不是"手感值"，是最严的那个已知云端上限。
 *
 * 来历（2026-10-14，截图事故）：默认曾写 **16**，而阿里云百炼 `text-embedding-v3`
 * 单批上限是 **10**，于是"装上就建索引"在最常见的云端端点上**必然 400**：
 * `batch size is invalid, it should not be larger than 10: input.contents`。
 * 更刺眼的是**面板自己的提示就写着"云端端点常有上限（如阿里云 ≤ 10）"** ——
 * 默认值与自家文档自相矛盾，等于把"看文档"当成不变量，而用户不会去看。
 *
 * 为什么不干脆留 16（本机 llama.cpp 批量大点更省往返）：
 *   · 默认值的职责是**开箱即通**，不是"在最快的端点上最快"。10 在两条路线上都成立。
 *   · 被拒的代价不是"慢一点"——是**整轮索引停在第一片 400 上**（`data-2` 实测：
 *     只嵌入 2/16 块就死了），而失败的第一次请求对用户就是"这功能是坏的"。
 *   · 真在本机跑、真嫌慢的人会去改面板，那是他的**显式选择**，不是我们要替他赌的默认。
 *
 * ⚠️ 上限**不止条数**：多数端点还同时限总 token，所以"选个安全的默认值"永远只能覆盖
 * 一部分情况。真正兜底的是下面的自动降批（`parseBatchLimit`）—— 默认值只负责
 * **第一发别打歪**，不负责把外部事实写死。
 */
export const DEFAULT_BATCH_SIZE = 10;

/** 单批条数上限（**代码护栏**，不是端点事实）。端点说自己能收更多也不越过它。 */
export const MAX_BATCH_SIZE = 64;

/**
 * 单批条数收敛：**带默认值的数字配置项一律先 `Number.isFinite` 挡一道**（同上）；
 * `0` / 负数 / 非数值 / 缺省 = "未设" ⇒ 用默认值（`0` 对"几条一批"没有意义，
 * 但 ⚠️ 面板 `collect()` 会把**每个空数值输入**写成 `0` —— 见宿主记忆 §一.10 ⇒
 * 这里必须把 `0` 判成"未设"，否则每点一次保存所有空项都会被打成 1）。
 *
 * **单一来源**：调用方（`core/backend.mjs` 的建索引循环）也用它，不许各写一份 `|| 16`。
 * @param {unknown} v
 * @returns {number} 1..MAX_BATCH_SIZE
 */
export function clampBatchSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(n)));
}

/**
 * 从端点的报错正文里读出"单批最多几条"。**读不出来返回 0**（= 没有可用的判据）。
 *
 * 为什么值得写：上限是**端点的**事实，而且换模型、换厂商、换网关都会变
 * （实测阿里云 `text-embedding-v3` = 10；不少网关是 25 / 32；本机端点能上千）。
 * 代码里写死任何一个数字都只是**赌**，而端点**每次都把答案写在报错里** ——
 * 不去读它，就是把"重发一次就能成"的请求变成"让用户去改配置"。
 *
 * 三种已知措辞（宁可少认，不瞎认）：
 *   · 阿里云/百炼：`it should not be larger than 10: input.contents`
 *   · OpenAI 系：`maximum of 10 inputs per request` / `no more than 32`
 *   · 区间式：`Range of input length should be [1, 10]`
 *
 * ⚠️ **误认的代价是被夹住的**：调用方只在 `limit < 当前批大小` 时才降批，
 * 所以哪怕把一个"单条文本长度上限"（如 `[1, 8192]`）错认成批上限，结果也只是
 * "不降批 ⇒ 原样抛出"，不会把正常的请求改坏。反过来漏认的代价才是真的
 * （整轮索引死在 400），所以这里的取舍是**偏向识别**。
 * @param {string} text 端点返回的正文（或错误 message）
 * @returns {number} 识别出的上限；0 = 没识别出来
 */
export function parseBatchLimit(text) {
  const s = String(text || '');
  if (!s) return 0;
  const patterns = [
    /(?:not\s+be\s+|is\s+)?(?:larger|greater)\s+than\s+(\d+)/i,
    /(?:no\s+more\s+than|less\s+than\s+or\s+equal\s+to|at\s+most|maximum\s+(?:of\s+|batch\s+size\s+)?|up\s+to)\s*(\d+)/i,
    /\[1\s*,\s*(\d+)\s*\]/,
    /(?:最多|不超过|不能超过|上限(?:为|是)?|最大(?:值)?(?:为|是)?)\s*(\d+)/,
    /batch\s*size[^0-9]{0,24}(\d+)/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    // 1..MAX 之外一律当没识别出来：`larger than 0` 这类不是我们要的，
    // 而超大数字（token 数）被错认成批上限也不会降批（调用方有 `limit < 批大小` 闸门）。
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n;
  }
  return 0;
}

/**
 * 这是不是"余额 / 额度用完了"？
 *
 * 为什么要单独认这一类（2026-10-29，建新代时用户的原话："跑一半没余额了打标记，
 * 以免重新充值后把已经跑过的也跑了"）：
 *   · 它**不是**确定性故障（充值后就没了），不该被记成 `failed` 让人以为是 bug；
 *   · 它**不能重试**——重试只是把同一笔请求再打一次，余额不会因为重试而变多，
 *     只会让日志里多两条同样的 402；
 *   · 它必须能被上层识别成"可以原地续跑"的中断，而不是"整轮作废"。
 * 所以这里给出稳定的判据，由调用方抛专用码 `EMBED_QUOTA_EXHAUSTED` 并落暂停标记。
 *
 * 判据分两路（宁可漏认成普通失败，也不要把密钥失效错判成余额不足 ——
 * 那会让用户去充值，而真正该做的是换 Key）：
 *   ① 状态码 402（Payment Required）—— 唯一无歧义的；
 *   ② 正文关键词。**只认明确的余额/额度措辞**，不认 401/403 的 `unauthorized`。
 * 阿里云百炼实测长这样：`Arrearage`、`Access denied, please make sure your account is in good standing`；
 * OpenAI 系：`insufficient_quota`、`exceeded your current quota`。
 * @param {any} err EmbedError / 原始错误
 * @returns {boolean}
 */
export function isQuotaExhausted(err) {
  const status = Number(err?.status) || 0;
  if (status === 402) return true;
  const text = `${err?.body || ''} ${err?.message || ''}`.toLowerCase();
  if (!text.trim()) return false;
  return /insufficient[_ -]?(quota|balance|fund|credit)|exceeded your current quota|quota (?:exceeded|exhausted|exceed)|arrearage|account is (?:not )?in good standing|billing (?:hard )?limit|余额不足|欠费|额度(?:已)?(?:用尽|不足)|账户余额/.test(text);
}

/**
 * @typedef {object} EmbedEndpoint
 * @property {string} baseURL  例如 https://api.deepseek.com（不带 /embeddings）
 * @property {string} [apiKey]  可选：本机推理端点不需要；有值才发 Authorization 头
 * @property {string} model    例如 text-embedding-3-small
 * @property {number} [timeoutMs]
 * @property {number} [batchSize]
 * @property {number} [retries]
 * @property {string} [dimensions]  可选：部分端点支持显式指定维度（OpenAI 的 dimensions 参数）
 * @property {(msg:string)=>void} [log]
 */

export class EmbedError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** 拼端点 URL（`backend.mjs` 的 LLM 调用复用 —— 单一来源，不抄第二份）。 */
export function joinUrl(baseURL, suffix) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base) throw new EmbedError('NO_BASE_URL', '嵌入端点未配置（baseURL 为空）');
  return `${base}${suffix}`;
}

/** 端点体检：不联网，只查必填项。面板用它做"保存前校验"。 */
export function checkEndpoint(ep) {
  const problems = [];
  if (!String(ep?.baseURL || '').trim()) problems.push('端点地址（baseURL）为空');
  if (!String(ep?.model || '').trim()) problems.push('嵌入模型名为空');
  // ⚠️ apiKey **不是**必填项：本机推理端点（llama.cpp 等）压根不校验它，
  //    把它判成"没配齐"等于把本地路线堵死（2026-10-08 实测：本地端点因此永远起不来）。
  //    空 Key 的处理方式是**不发 Authorization 头**（见 embedTexts），不是拒绝请求；
  //    线上端点真漏了 Key，由端点自己回 401（错误晚一步，但更真实、也更通用）。
  let url = '';
  try {
    url = joinUrl(ep?.baseURL, '/embeddings');
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    problems.push(`端点地址不是合法 URL：${ep?.baseURL}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 批量嵌入。
 * @param {string[]} texts
 * @param {EmbedEndpoint} ep
 * @returns {Promise<{ vectors: number[][], dim: number, model: string, batches: number }>}
 */
export async function embedTexts(texts, ep) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''));
  if (!list.length) return { vectors: [], dim: 0, model: String(ep?.model || ''), batches: 0, batchLimit: 0 };
  const health = checkEndpoint(ep);
  if (!health.ok) {
    throw new EmbedError('BAD_ENDPOINT', `嵌入端点不可用：${health.problems.join('；')}`, { problems: health.problems });
  }

  const url = joinUrl(ep.baseURL, '/embeddings');
  // 收敛走共享的 `clampBatchSize`（`0` / 缺省 / 非数值 = 未设 ⇒ 10）。
  // ⚠️ 这里**不能**用 `Math.max(1, Number(ep.batchSize) || 10)` 代替：面板 `collect()`
  //    会把空输入刷成 `0`，`Math.max(1, …)` 会把它当"1 条一批"，于是每批只嵌一条 —— 正确但慢 10 倍，
  //    且**没有任何错误**。这是宿主记忆 §一.10 同款坑的第二个实例（第一个是 `minScore`）。
  let batchSize = clampBatchSize(ep.batchSize);
  // ⚠️ 这里踩过一次真实的坑：`Number(undefined) ?? 2` 得到的是 **NaN** 而不是 2
  // （`??` 只对 null/undefined 生效，NaN 会原样通过），于是 `attempt <= NaN` 恒为 false，
  // 循环体一次都不执行，最后抛出"第 1 批没有拿到结果"—— 信息看起来合理，病根却在三行之外。
  // 凡是"带默认值的数字配置项"都要用 Number.isFinite 挡一道，别指望 `??`。
  const retriesRaw = Number(ep.retries);
  const retries = Number.isFinite(retriesRaw) ? Math.max(0, Math.min(5, retriesRaw)) : 2;
  const timeoutMs = Math.max(1000, Number(ep.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const log = typeof ep.log === 'function' ? ep.log : () => {};

  const vectors = [];
  let dim = 0;
  let batches = 0;
  /** 从端点报错里**探到**的单批上限（0 = 没探到）。回报出去给调用方复用，省掉下一片的试错。 */
  let batchLimit = 0;

  /**
   * 发一片（含有限重试）。成功返回向量数组；失败抛 EmbedError。
   * 抽出来的唯一理由：外层要能在**收到"批量太大"之后换更小的批重发同一片**，
   * 而重试逻辑本身不该被复制第二遍（复制出去的那份一定会先烂）。
   * @param {string[]} slice 这一片文本
   * @param {number} offset 这一片在**整次调用**里的起始下标（报错信息里用它说"第几条"）
   * @param {number} batchNo 批次号（只用于日志）
   */
  const requestBatch = async (slice, offset, batchNo) => {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      ep.signal?.throwIfAborted();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const body = { model: String(ep.model).trim(), input: slice };
        if (ep.dimensions) body.dimensions = Number(ep.dimensions);
        // Authorization 只在**真的填了 Key** 时带上：本机推理端点不校验 Key，
        // 塞一个空的 `Bearer ` 没有意义，有的网关还会判成非法请求直接 400。
        const headers = { 'content-type': 'application/json' };
        const apiKey = String(ep.apiKey ?? '').trim();
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ep.signal ? AbortSignal.any([ctrl.signal, ep.signal]) : ctrl.signal
        });
        const text = await res.text();
        ep.signal?.throwIfAborted();
        if (!res.ok) {
          // 把响应体截一段带出来 —— 端点报错的原因几乎全在 body 里
          throw new EmbedError(
            'HTTP_ERROR',
            `嵌入端点返回 ${res.status}：${text.slice(0, 300)}`,
            { status: res.status, body: text.slice(0, 2000) }
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new EmbedError('BAD_JSON', `嵌入端点返回的不是 JSON：${text.slice(0, 200)}`);
        }
        const data = Array.isArray(parsed?.data) ? parsed.data : null;
        if (!data || data.length !== slice.length) {
          throw new EmbedError(
            'COUNT_MISMATCH',
            `嵌入端点返回条数不符：要 ${slice.length} 条，得到 ${data ? data.length : 0} 条`,
            { expected: slice.length, got: data ? data.length : 0 }
          );
        }
        // 按 index 归位（有的端点不保证顺序）
        const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vecs = [];
        for (let i = 0; i < sorted.length; i++) {
          const v = sorted[i]?.embedding;
          if (!Array.isArray(v) || !v.length) {
            throw new EmbedError('EMPTY_VECTOR', `第 ${offset + i} 条的 embedding 为空`);
          }
          if (!dim) dim = v.length;
          else if (v.length !== dim) {
            throw new EmbedError(
              'DIM_INCONSISTENT',
              `同一次请求里维度不一致：先 ${dim} 维，后又 ${v.length} 维`,
              { first: dim, then: v.length }
            );
          }
          vecs.push(v);
        }
        return vecs;
      } catch (err) {
        if (ep.signal?.aborted) throw new EmbedError('CANCELLED', '嵌入请求已取消或整体预算耗尽');
        lastErr = err;
        const aborted = err?.name === 'AbortError';
        const code = aborted ? 'TIMEOUT' : err?.code || 'NETWORK';
        const msg = aborted ? `请求超时（${timeoutMs}ms）` : err?.message || String(err);
        const status = Number(err?.status) || 0;

        // 余额/额度：**在重试判定之前**拦下。重试一笔注定失败的请求没有意义，
        // 而"把它当普通 4xx 原样抛"会让上层只能记 failed，续跑信息就丢了。
        if (code === 'HTTP_ERROR' && isQuotaExhausted(err)) {
          throw new EmbedError(
            'EMBED_QUOTA_EXHAUSTED',
            `嵌入端点额度不足（HTTP ${status || '?'}）：${String(err?.body || msg).slice(0, 300)}`,
            { status, body: err?.body }
          );
        }

        // 分两类：**会变的错误才值得重试**。
        //   · 契约类（条数不符 / 非 JSON / 同批维度不一致 / 空向量）—— 重试不会变。
        //     原样抛出，免得一次确定性故障被拖成几十秒等待，还把真正的错误码淹进 BATCH_FAILED。
        //   · 认证与参数类（401 / 400 / 404）—— 用户去改配置就好，重试纯属空等。
        //     ⚠️ 但 400 里有一类**是可以当场自救的**：「这批太大」—— 见外层循环。
        //     所以这里仍然原样抛，把判断权交给唯一知道"当前批大小是多少"的那一层。
        //   · 会变的（超时 / 网络 / 429 / 5xx）—— 重试。
        const deterministic = ['COUNT_MISMATCH', 'BAD_JSON', 'DIM_INCONSISTENT', 'EMPTY_VECTOR'].includes(code);
        const retryable = !deterministic
          && (aborted || code === 'NETWORK' || (code === 'HTTP_ERROR' && (status === 429 || status >= 500)));
        const throwRaw = deterministic || (code === 'HTTP_ERROR' && status > 0 && status < 500 && status !== 429);

        if (retryable && attempt < retries) {
          const wait = 400 * (attempt + 1);
          log(`嵌入第 ${batchNo} 批失败（${code}: ${msg}），${wait}ms 后重试 ${attempt + 1}/${retries}`);
          await delay(wait, undefined, { signal: ep.signal });
        } else if (throwRaw) {
          throw err;
        } else {
          throw new EmbedError(
            'BATCH_FAILED',
            `嵌入失败（第 ${batchNo} 批，已重试 ${retries} 次）：${code} — ${msg}`,
            { batch: batchNo, cause: code, body: err?.body }
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new EmbedError('BATCH_FAILED', `第 ${batchNo} 批没有拿到结果`);
  };

  // ── 主循环：**只在这一层知道批大小**，所以"批量太大"只能在这一层处理 ──────
  //
  // 注意 `start` 只在**成功**后推进。被端点按条数拒收时按更小的批重发**同一片**——
  // 这不是"重试"（重试是同参数再发一次，注定还是 400），是**换参数重发**。
  let start = 0;
  while (start < list.length) {
    const slice = list.slice(start, start + batchSize);
    const batchNo = batches + 1;
    let vecs;
    try {
      vecs = await requestBatch(slice, start, batchNo);
    } catch (err) {
      const limit = batchLimitOf(err);
      // 判据用的是**这一片实际发出去的条数**（`slice.length`），不是 `batchSize`：
      // 最后一片往往比 batchSize 短，拿 batchSize 比会把"5 条也被拒"错判成"降批能救"。
      if (limit >= 1 && limit < slice.length) {
        batchSize = Math.min(limit, MAX_BATCH_SIZE);
        batchLimit = batchSize;
        log(
          `端点按单批条数拒收（这批发了 ${slice.length} 条，它最多收 ${limit} 条）` +
          `⇒ 自动改为每次 ${batchSize} 条重切重发，本次调用不再试错` +
          `（把面板「单批条数」也设成 ${batchSize} 可省掉这一发）`
        );
        continue;   // 不推进 start：同一片用更小的批重来
      }
      // 降不了批（已经 ≤ 端点上限 / 没识别出上限）⇒ 这是别的限制（总 token、配额、Key…），
      // 原样抛，别把确定性故障包装成看起来能重试的样子。
      if (limit >= 1) err.batchLimit = limit;
      err.triedBatchSize = batchSize;
      throw err;
    }
    vectors.push(...vecs);
    batches++;
    start += slice.length;
  }

  return { vectors, dim, model: String(ep.model || ''), batches, batchLimit };
}

/**
 * 这是不是一条"端点嫌这批太大"的错误？是 ⇒ 返回它说的上限，不是 ⇒ 0。
 *
 * 只认 `HTTP_ERROR` 且状态码是"请求本身不合法"那一类（400 / 413 / 422）。
 * 不认 401/403（Key）与 404（模型名）—— 那些降批也不会变好，而**误判会让用户
 * 看到"批变小了但还是失败"，比直接报原文更难查**。
 * @param {any} err
 * @returns {number}
 */
function batchLimitOf(err) {
  if (!err || err.code !== 'HTTP_ERROR') return 0;
  const status = Number(err.status) || 0;
  if (status !== 400 && status !== 413 && status !== 422) return 0;
  return parseBatchLimit(err.body || err.message || '');
}

// ── 上线入口：两侧非对称 + 出境前自检 ─────────────────────────────────────
//
// `embedTexts` 是低层件，任意文本都收（测试、故障注入要用）。
// **业务代码请用下面两个**，它们把 ADR-0002 的边界钉在接口上：
//
//   · 必须传共享归一化器 —— 否则抛 `UNNORMALIZED_INPUT`
//   · 出境前逐条跑 `findLeak()` —— 输出里还有实体串就抛 `NORMALIZE_LEAK`
//   · 出境前逐条跑 `findEntityForm()` —— 还有"名字紧挨硬 ID"的引用/提及形态就抛
//     `NORMALIZE_SHAPE_LEAK`。**这一条不依赖词表**，补的是 `findLeak` 的原理性盲区
//     （实测机器人自己的名字就是这样漏出去过一次，见 ADR-0006）
//   · 查询侧自动加 `Instruct:` 前缀，文档侧不加 —— 两侧写反会静默降分

/**
 * 查询侧编码：加指令前缀。
 * 官方用法是 `Instruct: {task}\nQuery:{query}`，**没有** Query 后面的空格。
 */
export function formatQuery(text, instruction) {
  const task = String(instruction || DEFAULT_QUERY_INSTRUCTION).trim();
  return `Instruct: ${task}\nQuery:${String(text ?? '')}`;
}

/**
 * 出境前自检。这是整个插件唯一一处"联网之前先看一眼"的地方，
 * 因为出境之后不可撤回 —— 这一点和向量库的"全零向量拒绝写入"是同一个道理。
 *
 * **两道闸门并联**（ADR-0006）：`findLeak` 只认词表里已有的串，
 * `findEntityForm` 只看形态。少了后者，"词表没认出的实体"就完全没人管。
 */
export function assertNormalized(texts, normalizer, side = 'document') {
  if (!normalizer || typeof normalizer.findLeak !== 'function') {
    throw new EmbedError(
      'UNNORMALIZED_INPUT',
      `${side} 侧编码必须传共享归一化器：小时块的 title 实测含 QQ 号、summary 含群名片，` +
        '未经归一化直接送云端 = 身份出境。',
      { side }
    );
  }
  const list = Array.isArray(texts) ? texts : [texts];
  for (let i = 0; i < list.length; i++) {
    const leak = normalizer.findLeak(list[i]);
    if (leak) {
      throw new EmbedError(
        'NORMALIZE_LEAK',
        `${side} 侧第 ${i} 条文本里仍有实体串「${leak.term}」（层：${leak.layer}）—— 拒绝出境。` +
          '漏报的代价是名字出境且不可撤回，所以这里宁可拒发。',
        { side, index: i, term: leak.term, layer: leak.layer }
      );
    }
    // 形态闸门：**它不依赖词表**，所以是"词表漏了实体"这一类问题的唯一兜底。
    if (typeof normalizer.findEntityForm === 'function') {
      const form = normalizer.findEntityForm(list[i]);
      if (form) {
        throw new EmbedError(
          'NORMALIZE_SHAPE_LEAK',
          `${side} 侧第 ${i} 条文本里残留实体引用形态（${form.kind}：${form.sample}）—— 拒绝出境。` +
            '这说明有实体没被认出来；`findLeak` 只认词表里已有的串，看不见这一类。',
          { side, index: i, shape: form.kind, sample: form.sample }
        );
      }
    }
  }
  return true;
}

/**
 * 逐条过闸门，把"这一条不能出境"从"这一批全废"里拆出来。
 *
 * 【为什么需要】`assertNormalized` 是**整批**判定的：一批 10 条里第 3 条命中词表，
 * 抛出去的是"这批失败"，而调用方只能整轮放弃。现场（2026-10-29 盘点 P1）：
 * 小号有 39 条历史块当前重建会被拒（29 条 `bare-mention` + 6 条实体串 + 4 条
 * `DOC_GATE_LEAK`），它们让**整轮索引**反复中断 —— 块按 id 倒序处理，撞墙点之后
 * （更老的）块长期饿死，日志里 84 次「定时索引失败」就是这么来的。
 *
 * 语义上**没有放宽闸门**：每一条照样跑 `findLeak` + `findEntityForm`，被拒的一条
 * 都不发。变的是"被拒的代价"：从"这一批（乃至今后所有轮次）全不发"变成"只少这一条"，
 * 而且被拒的条目**带原因返回**，可以进报告、可以去补身份词表。
 *
 * @param {string|string[]} texts
 * @param {object} normalizer 共享归一化器
 * @param {'document'|'query'} [side]
 * @returns {{clean: Array<{index:number,text:string}>, rejected: Array<{index:number,text:string,code:string,message:string,term?:string,layer?:string,shape?:string}>}}
 */
export function partitionBySafety(texts, normalizer, side = 'document') {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
  const clean = [];
  const rejected = [];
  for (let i = 0; i < list.length; i++) {
    try {
      assertNormalized([list[i]], normalizer, side);
      clean.push({ index: i, text: list[i] });
    } catch (err) {
      rejected.push({
        index: i,
        text: list[i],
        code: String(err?.code || 'REJECTED'),
        message: String(err?.message || err),
        term: err?.term,
        layer: err?.layer,
        shape: err?.shape
      });
    }
  }
  return { clean, rejected };
}

/**
 * 文档侧编码（入库）。**不加任何前缀。**
 * @param {string[]} texts 必须是归一化文本
 * @param {EmbedEndpoint & {normalizer:object}} ep
 * @param {{prechecked?:boolean}} [opts]
 *   `prechecked: true` 表示调用方**已经逐条**跑过 `assertNormalized`（唯一正当用法是
 *   `partitionBySafety` 分流之后）。它只省掉一次重复扫描，不改变"脏文本不出口"这个事实。
 *   ⚠️ 别拿它来"跳过检查"——那等于把 ADR-0002 的闸门拆掉，且**不会有任何报错**。
 */
export async function embedDocuments(texts, ep, opts = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''));
  if (!opts.prechecked) assertNormalized(list, ep?.normalizer, 'document');
  return embedTexts(list, ep);
}

/**
 * 查询侧编码（检索）。**自动加 `Instruct:` 前缀。**
 * @param {string[]} texts 必须是归一化文本
 * @param {EmbedEndpoint & {normalizer:object, instruction?:string}} ep
 */
export async function embedQueries(texts, ep) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''));
  assertNormalized(list, ep?.normalizer, 'query');
  const framed = list.map((t) => formatQuery(t, ep?.instruction));
  const out = await embedTexts(framed, ep);
  return { ...out, framed };
}
