// server.mjs — http 传输（独立进程跑的那条路）
//
// ── 与 inproc 的关系 ─────────────────────────────────────────────────────
// **同一个 `handleMemoryVec`**，只是这次的 req/res 是真的。所以 PROTOCOL.md §1
// 要求的"两种传输行为一致"是**同源保证**，不是靠两处实现对齐维持的。
//
// ── 安全模型（这是"去掉核心缝"换来的代价，必须写清楚）──────────────────
// 去缝之后面板直连本服务，**宿主那套 `authorize()` 用不上了**。补偿措施有三条：
//   ① 默认只绑 `127.0.0.1` —— 网络层就够不着；
//   ② 绑非回环地址需要**显式** `--allow-remote`（fail-closed：默认拒绝，不是默认放行）；
//   ③ 请求侧再查一次 `remoteAddress` 是不是回环（防"绑上了但被转发"）。
// ⇒ 结论一句话：**它没有认证，只有"够不着"**。所以 `--allow-remote` 时会在日志里
//    打一条**显式**警告，不能让它悄悄发生。
//
// ── 优雅降级 ─────────────────────────────────────────────────────────────
// 服务缺席时调用方（宿主适配层）必须退回"没装这个插件"的行为 —— 见 ADR-0001 §决定 5。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { bindHost } from './core/host.mjs';
import { handleMemoryVec } from './router.mjs';
import { createFileSettingsEditor } from './core/settings-editor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 服务自带的静态页面目录（星图页）—— `ADR-0013`：星图归服务，不归宿主面板。 */
const WEB_DIR = path.resolve(HERE, '..', 'web');

/** 路径前缀。PROTOCOL.md §4 的路由表就是它下面的（`/api/vec/status` …）。 */
export const PREFIX = '/api/vec/';
/** 路由层内部用的是宿主那套前缀；这里做一次映射，路由表只存一份。 */
const INTERNAL = '/api/memory-vec/';

export const DEFAULT_PORT = 8088;
export const DEFAULT_HOST = '127.0.0.1';

/** 父进程守护的轮询间隔（见 `watchParent`）。5 秒是"宿主关了到服务关"的最坏延迟。 */
const PARENT_WATCH_MS = 5000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 读本插件的设置 —— **按宿主 `getSkillConfig` 的同一口径重实现**。
 *
 * ── 为什么重实现而不是 import 宿主的那个 ─────────────────────────────────
 * 独立服务去 import `<宿主>/src/skills/config.js`，就把"服务必须住在宿主目录里"
 * 这条耦合重新引回来了 —— 而拆仓的全部意义就是去掉它。
 *
 * ── 为什么必须有它（不是可选项）─────────────────────────────────────────
 * 不注入 settings 的话，core 会静默落到 `{ ...DEFAULT_SETTINGS }`：
 * **用户在面板里存的嵌入端点 / 模型 / topK / 自动索引开关全部不生效，而且不报错**。
 * 这正是这个项目一直在消灭的那类故障（"看起来正常"的错值）。
 *
 * ── 口径（必须与 `<宿主>/src/skills/config.js` 一致）─────────────────────
 * `{ ...defaults }`，再用盘上的**显式值**覆盖，跳过 `undefined`。
 * 每次调用都**重新读盘**（不缓存）—— 面板改完设置点按钮就该生效，而不是"改完要重启服务"。
 * 读失败（文件不存在 / 读到半截）⇒ 退回 defaults，**不抛**：服务不能因为配置读不到就拒绝回答。
 */
export function readSkillConfig(dataRoot, id, defaults = {}) {
  const merged = { ...(defaults || {}) };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(dataRoot), 'config.json'), 'utf8'));
    const s = raw?.skills?.[String(id)];
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s)) if (v !== undefined) merged[k] = v;
    }
  } catch { /* 读不到就全默认 */ }
  return merged;
}

function isLoopback(addr) {
  if (!addr) return false;
  return LOOPBACK.has(addr) || addr.startsWith('127.');
}

/**
 * CORS：只对"够得着的来源"放行。
 * - **没有 Origin** ⇒ 非浏览器（curl / 服务端调用）⇒ 放行，且不加 CORS 头。
 * - `Origin: null` ⇒ Electron 的 `file://` 面板 ⇒ 放行。
 * - `http://127.0.0.1:*` / `http://localhost:*` ⇒ 放行。
 * - 其它 ⇒ **不加** CORS 头（浏览器自己会拦），**不报错**（免得把攻击探测变成信息）。
 * @returns {string|null} 允许回显的 origin
 */
function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === 'null') return 'null';
  try {
    const u = new URL(origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (u.hostname === 'localhost' || isLoopback(u.hostname)) return origin;
    }
  } catch { /* 非法 Origin ⇒ 不放行 */ }
  return null;
}

/** 与宿主 `json()` helper 同签名。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

// ── 静态页（星图页，`ADR-0013`）──────────────────────────────────────────
// 只服务 `web/` 一个目录，且**只认扁平路径**（`/`、`/starmap.js`…）：
// 不做多级子目录、不认识 `..`、不认识盘符 —— 路径穿越在这三层里任一层都过不去。
// 服务本身仍然"没有认证、只有够不着"（默认绑回环），所以静态页也只在回环上可达。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

/** @returns {boolean} 是否已处理（true = 响应已发出） */
function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  } catch {
    return false;   // 非法百分号编码 ⇒ 交给后面的 404
  }
  if (!rel || rel.includes('\\') || rel.split('/').length > 1) return false;   // 只认扁平文件名
  const root = path.resolve(WEB_DIR);
  const target = path.resolve(root, rel);
  if (target !== path.join(root, rel)) return false;                            // 归一化后必须仍在 root 下
  let st;
  try { st = fs.statSync(target); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    // 页面是**随服务版本走**的本地资产：不缓存，免得旧页面连新端点（排障时最恨这种）。
    'cache-control': 'no-store'
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/**
 * 解析**源根**（index source root）—— 宿主的 data 目录：小时块、存档、身份（botName /
 * per-chat-persona）都在那儿，**只读**。与**库根**（本服务自持的 `memory-vec/`）刻意分开：
 * 外接模式下服务从自己的项目里跑，库数据归仓，源数据仍指回宿主。
 *
 * 优先级：显式参数 > 配置文件 `skills.memory-vec.sourceRoot` > 库根自身（＝不分离，兼容旧部署）。
 * 读失败按"没配"处理 —— 与 readSkillConfig 同口径：配置读不到不能拒绝服务。
 */
export function resolveSourceRoot(dataRoot, override = '') {
  if (override) return path.resolve(override);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(dataRoot), 'config.json'), 'utf8'));
    const s = String(raw?.skills?.['memory-vec']?.sourceRoot || '').trim();
    if (s) return path.resolve(s);
  } catch { /* 没配就是没分离 */ }
  return path.resolve(dataRoot);
}

/**
 * 建服务（**不起监听** —— 便于测试用 port 0）。
 * @param {{dataRoot:string, sourceRoot?:string, settings?:object, allowRemote?:boolean, logger?:object}} opts
 */
export function createServer({ dataRoot, sourceRoot = '', settings = null, allowRemote = false, logger = null } = {}) {
  if (!dataRoot) throw new Error('createServer 需要 dataRoot（本仓不猜宿主数据在哪）');

  const srcRoot = resolveSourceRoot(dataRoot, sourceRoot);

  // 装配即载入：与 inproc 走同一个注入入口。
  // `settings` 允许调用方（测试）覆盖；缺省时**必须**给一个读盘实现 —— 见 readSkillConfig
  // 上面那段：不给的话 core 会静默落到 DEFAULT_SETTINGS，用户存的设置全不生效。
  // 设置从**源根**读：外接模式下面板经宿主写入口改的是宿主 config.json（＝源根那份），
  // 服务每次调用重读 ⇒ 面板改完即生效，与"服务跑在仓里"不冲突。
  bindHost({
    config: { DATA_DIR: path.resolve(dataRoot), SOURCE_DIR: srcRoot },
    settings: settings ?? { getSkillConfig: (id, defaults) => readSkillConfig(srcRoot, id, defaults), ...createFileSettingsEditor(srcRoot) },
    fallbackRoot: path.resolve(dataRoot, '..')
  });

  const warn = typeof logger?.warn === 'function' ? (m) => logger.warn(m) : () => {};

  const authorize = (req) => {
    if (!allowRemote) return isLoopback(req.socket?.remoteAddress);
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    const origin = allowedOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
    }

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ⚠️ dataRoot 必须出现在 /health 里（2026-10-09 实测教训）：双态启动器让
    // "开发态副本"与"部署态副本"共用 8088，点错的那次不报错、只是静默连着一个
    // **没有 config.json 的空库**——面板"嵌入端点未配置"就是它。启动器与排障
    // 的判据要问**运行期事实**（这个实例实际对着哪个 data-root），不能问
    // "谁启动的、按理应该是什么"。0.9.3 起外接模式再加 sourceRoot：库根（自持）
    // 与源根（指回宿主）分离，两个都必须可对账。
    if (url.pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        service: 'vec-memory',
        dataRoot: path.resolve(dataRoot),
        sourceRoot: srcRoot
      });
      return;
    }

    if(url.pathname === PREFIX+'memory/settings') {
      // Configuration writes use this service's own page, never cross-origin form posts.
      let trusted=!req.headers.origin;
      try { trusted ||= new URL(req.headers.origin).origin===new URL(`http://${req.headers.host}`).origin; } catch {}
      if(!isLoopback(req.socket?.remoteAddress)||!trusted || req.method==='POST'&&!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) {
        json(res,403,{ok:false,code:'SETTINGS_ORIGIN_DENIED',error:'配置接口仅允许本机同源管理页面或 JSON 客户端访问'});return;
      }
    }

    if (!url.pathname.startsWith(PREFIX)) {
      // 星图页与其资产（`ADR-0013`）：**只有**命中 web/ 里的真实文件才处理。
      // 放在 404 之前，但**不接管 /api/***——那条前缀仍然只认路由表。
      if (!url.pathname.startsWith('/api/') && serveStatic(res, url.pathname)) return;
      json(res, 404, {
        ok: false,
        error: `未知路径：${url.pathname}`,
        hint: `API 在 ${PREFIX}*；星图页在 /（服务自带页面）`
      });
      return;
    }

    // 前缀映射：对外是 /api/vec/*，路由层内部认 /api/memory-vec/* —— 路由表只存一份。
    const pathname = INTERNAL + url.pathname.slice(PREFIX.length);
    try {
      await handleMemoryVec(req, res, pathname, { authorize, json, say: warn });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) });
      else res.end();
    }
  });

  server.allowRemote = allowRemote;
  return server;
}

/** 起监听并返回实际地址（port 0 ⇒ 系统分配，测试用）。 */
export function start(opts = {}) {
  const server = createServer(opts);
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${a.port}`;
      resolve({ server, url, port: a.port });
    });
  });
}

// ── CLI 入口（与逻辑分离，才能进程内测）──────────────────────────────────
function parseArgs(argv) {
  const out = { port: null, host: null, dataRoot: '', sourceRoot: '', allowRemote: false, parentPid: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data-root') out.dataRoot = argv[++i];
    else if (a === '--source-root') out.sourceRoot = argv[++i];
    else if (a === '--parent-pid') out.parentPid = Number(argv[++i]);
    else if (a === '--allow-remote') out.allowRemote = true;
  }
  return out;
}

/**
 * 父进程守护：宿主（QQ-Agent）拉起本服务时传 `--parent-pid <宿主pid>`，
 * 宿主退出就跟着退 —— 不留孤儿进程。
 *
 * 为什么必须由**服务自己**看住，而不是让宿主在退出时来关我：
 *   · Windows 上父进程退出**不会**带走子进程（没有 job object 就没有级联）；
 *   · 宿主崩溃/被强杀时，它的清理钩子（插件 `deactivate`）**根本不会跑**。
 * 只对 `ESRCH` 反应：`EPERM` 表示"进程在，只是没权限发信号"，那也是活着。
 */
function watchParent(parentPid, onGone) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      if (err?.code === 'ESRCH') onGone();
    }
  }, PARENT_WATCH_MS);
  timer.unref?.();
  return timer;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 数据源**必须显式**。拆仓前它是 `path.resolve(HERE,'..','..')` 推算出来的，
  // 拆出来后那条推算只会指向一个错目录，而错目录的表现是"库是空的"——**不报错**。
  const dataRoot = args.dataRoot || process.env.VEC_DATA_ROOT || process.env.QQ_AGENT_DATA_DIR || '';
  if (!dataRoot) {
    console.error('❌ 不知道数据在哪。请显式给出：');
    console.error('   node src/server.mjs --data-root "<库数据目录>"  （外接模式＝仓内 ./data，sourceRoot 在其 config.json 里配）');
    console.error('   或设置环境变量 VEC_DATA_ROOT / QQ_AGENT_DATA_DIR');
    process.exit(2);
  }

  const host = args.host || DEFAULT_HOST;
  if (!isLoopback(host) && !args.allowRemote) {
    console.error(`❌ 拒绝绑非回环地址 ${host} —— 本服务**没有认证**，只有"够不着"。`);
    console.error('   确实需要对外暴露时，显式加 --allow-remote（并自备前置鉴权）。');
    process.exit(2);
  }

  const { server, url } = await start({ dataRoot, sourceRoot: args.sourceRoot, host, port: args.port ?? DEFAULT_PORT, allowRemote: args.allowRemote });
  console.log(`[vec-memory] 监听 ${url}  (data-root: ${path.resolve(dataRoot)})`);
  if (path.resolve(dataRoot) !== resolveSourceRoot(dataRoot, args.sourceRoot)) {
    console.log(`[vec-memory] 外接模式：源数据（索引/身份/存档，只读）指回 ${resolveSourceRoot(dataRoot, args.sourceRoot)}`);
  }
  if (args.allowRemote) console.warn('[vec-memory] ⚠️ --allow-remote 已开启：服务**无认证**，任何能连上的机器都能读写索引。');

  // ── 自动索引的调度**在服务里**（去缝的连带变更）──────────────────────────
  // 去缝前它由宿主进程里那份 backend.mjs 的定时器承担。现在宿主侧不再有 backend（也不再有缝），
  // 而服务本来就是常驻的 ⇒ 调度放到这儿更合适：宿主窗口关掉也不影响按间隔索引。
  // 失败**不能**把服务打挂 —— 它只是"自动"的那一半，手动索引与搜索都不受影响。
  let core = null;
  try {
    core = await import('./core/backend.mjs');
    const rt = await core.getRuntime();   // armTimer 按 autoIndexEnabled / 间隔决定起不起
    if (rt?.timer) console.log(`[vec-memory] 自动索引已排程：每 ${rt.settings?.autoIndexIntervalMin} 分钟`);
    else console.log('[vec-memory] 自动索引未开启（面板里可打开）');
  } catch (err) {
    console.warn('[vec-memory] 自动索引调度未启动（手动索引与搜索不受影响）：', err?.message ?? err);
  }

  // ── 优雅关闭：落盘 + 停定时器 ────────────────────────────────────────────
  // 不接信号的话，Ctrl+C / 关窗口会让定时器与句柄悬着，最后一批写入可能没落盘。
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[vec-memory] 收到 ${sig}，正在退出…`);
    try { core?.disposeMemoryVec?.(); } catch { /* 退出路径不阻断 */ }
    server.close(() => process.exit(0));
    // 兜底：连接没关干净也要退出（unref 保证它自己不阻止进程结束）
    setTimeout(() => process.exit(0), 1500).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── 父进程守护（宿主自动拉起时才生效）──────────────────────────────────
  // 判据：**显式传了 `--parent-pid` 才看住**。手动双击启动器起的服务不带这个参数
  // ⇒ 行为与以前逐字相同（关窗口/任务管理器才是停它的方式）。
  const parentPid = Number(args.parentPid);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    watchParent(parentPid, () => shutdown(`父进程 ${parentPid} 已退出`));
    console.log(`[vec-memory] 受宿主进程 ${parentPid} 守护：它退出本服务即退出`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => { console.error('[vec-memory] 启动失败：', err); process.exit(1); });
}
