// transport/inproc.mjs — 进程内传输
//
// ── 核心手法：**不重写路由，而是伪造 req/res** ────────────────────────────
// `handleMemoryVec` 要的是一个 `IncomingMessage` + `ServerResponse`。
// 与其把 600 行分发重写成"纯函数表"（那必然会引入行为漂移，而漂移**不报错**），
// 不如在这里做一对符合接口的**假对象**，让**同一份代码**跑起来。
//
// 由此得到一个白拿的性质：**inproc 与 http 的行为一致性是同源保证**，
// 不是"两份实现靠对齐维持"——`MIGRATION.md §6 判据 1` 因此不需要靠人盯。
//
// ── 它替代了什么 ─────────────────────────────────────────────────────────
// 拆仓前，"进程内"这条路是**不存在**的：调用方只能是宿主的 HTTP 服务器。
// 现在任何 Node 进程都能直接调它，不需要起端口。
import path from 'node:path';
import { bindHost } from '../core/host.mjs';
import { handleMemoryVec } from '../router.mjs';

/** 与宿主一致的路径前缀（PROTOCOL.md §4 的路由就是它下面的）。 */
const PREFIX = '/api/memory-vec/';

/**
 * 伪造的 IncomingMessage。
 * `readJsonBody` 用 `for await (const c of req)` 读体 ⇒ 只需一个 async iterator。
 * `url` 必须给**含 query 的完整路径**：路由层用 `new URL(req.url, 'http://127.0.0.1')`
 * 读 `?limit=` / `?k=` 这类参数 —— 只给 pathname 的话，那些参数会**静默变成默认值**
 * （实测：`/items?limit=3` 返回 limit:50，不报错）。
 */
function fakeRequest(method, body, headers, url) {
  const isStream = body && typeof body[Symbol.asyncIterator] === 'function';
  const buf = isStream ? null
    : body === null || body === undefined ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

  const req = {
    method,
    url,
    headers: { ...(headers || {}) },
    [Symbol.asyncIterator]() {
      let sent = false;
      if (isStream) return body[Symbol.asyncIterator]();
      return {
        next: async () => {
          if (sent || buf === null) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: buf };
        }
      };
    }
  };
  return req;
}

/** 伪造的 ServerResponse：把 status / headers / body 收集起来。 */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: Object.create(null),
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); }
  };
}

/** 与宿主 `json()` helper 同签名：写 status、写 content-type、结束。 */
function makeJson(res) {
  return (r, status, payload) => {
    r.statusCode = status;
    r.setHeader('content-type', 'application/json; charset=utf-8');
    r.end(JSON.stringify(payload));
  };
}

/**
 * 建一个进程内路由。
 *
 * @param {object} opts
 * @param {string} opts.dataRoot  宿主 data 根（其下才有 `memory-vec/`、`memory-v2/chunks/`）。
 *                                这是**注入点**：本仓不再猜自己住在哪。
 * @param {object} [opts.settings] 形如 `{ getSkillConfig(id, defaults) }` 的配置读取器。
 *                                 缺席 ⇒ 一律用 DEFAULT_SETTINGS（与宿主读不到配置时同路）。
 * @param {(req)=>boolean} [opts.authorize] `handleMemoryVec` 的鉴权钩子。
 *                                 inproc 的调用方是本进程内的可信代码 ⇒ 默认放行。
 *                                 **http 传输必须显式传**（见 server.mjs）。
 * @param {object} [opts.logger] `{ warn }`
 */
export function createRouter({ dataRoot, settings = null, authorize = null, logger = null } = {}) {
  // 「装配即载入」：注入与返回句柄是**同一件事**，不留"建完还得再调一下"的第二步。
  bindHost({
    config: dataRoot ? { DATA_DIR: path.resolve(dataRoot) } : null,
    settings,
    fallbackRoot: dataRoot ? path.resolve(dataRoot, '..') : null
  });

  const say = typeof logger?.warn === 'function' ? (m) => logger.warn(m) : () => {};

  return {
    /**
     * 调一条路由。
     * @param {{method?:string, path?:string, body?:any, headers?:object}} call
     *        `path` 是**去掉 `/api/memory-vec` 的段**（`/search`、`/status`、`/item/<id>`）。
     *        也接受带前缀的完整路径，会原样使用。
     * @returns {Promise<{status:number, headers:object, body:any}>}
     */
    async handle(call = {}) {
      const method = String(call.method || 'GET').toUpperCase();

      // 拆 query：`pathname` 交给 handler 做端点匹配（不能带 query，否则 `graph?k=6` 会
      // 匹配不到 `graph` 而落到 404）；`req.url` 带上它，供 `new URL(...)` 取参数。
      const raw = String(call.path || '/');
      const qi = raw.indexOf('?');
      const rawPath = qi >= 0 ? raw.slice(0, qi) : raw;
      const search = qi >= 0 ? raw.slice(qi) : '';
      const pathname = rawPath.startsWith(PREFIX)
        ? rawPath
        : `/api/memory-vec/${rawPath.replace(/^\/+/, '')}`;

      const req = fakeRequest(method, call.body ?? null, call.headers, pathname + search);
      const res = fakeResponse();
      const auth = typeof authorize === 'function' ? authorize : () => true;

      await handleMemoryVec(req, res, pathname, { authorize: auth, json: makeJson(res), say });

      let parsed = res.body;
      if (typeof parsed === 'string') {
        try { parsed = parsed.length ? JSON.parse(parsed) : null; } catch { /* 保留原文 */ }
      }
      return { status: res.statusCode, headers: { ...res.headers }, body: parsed };
    }
  };
}
