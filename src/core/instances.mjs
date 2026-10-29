// instances.mjs — 多实例清单：读 + 校验 + 路径解析 + 并发探活（`ADR-0029`）。
//
// ── 为什么需要这份东西 ───────────────────────────────────────────────────
// 一个 QQ 号 = 一套独立身份 + 一份独立 `DATA_DIR` + 一份独立记忆。多号并存的落地形态
// 是**多进程多库**：每个号一个服务进程、一个库根；隔离靠"不同的库根"，**不是**字段过滤。
// `server.mjs` 本来就支持 `--data-root / --port / --source-root`（这是 0.9.3 外接模式
// 的产物）⇒ 这一步**零代码改动服务主体**。
//
// 于是"**有哪些实例、各自连哪个库、哪个端口**"必须有一份**唯一事实源**，否则总启动器
// 与总览页会各扫各的、各说各话（"两处不一致"是本项目反复咬人的那类故障）。那份东西就是
// **仓根 `instances.json`**，本模块是它唯一的读口。
//
// ── 三条纪律 ─────────────────────────────────────────────────────────────
// ① **永不抛**。清单不在 / 坏 JSON / 单条非法，都回结构化结果让界面说明 ——
//    总览页"直接打不开"是最差的失败：用户连"哪一条错了"都看不到。
// ② 探活问的是**运行期事实**。清单写的是"打算连哪个库"，`/health` 回的是"实际连了哪个库"。
//    两者不一致必须**看得见**（`dataRootMatch` / `sourceRootMatch`），而不是靠"按理应该对"
//    糊过去（同 `server.mjs` 里 `dataRoot 必须出现在 /health 里` 那条教训）。
// ③ 路径**相对仓根**解析。`dataRoot` 写 `data` 比写一整条绝对路径更耐搬机器；绝对路径也认。
import fs from 'node:fs';
import path from 'node:path';
import { hostConfig, hostFallbackRoot } from './host.mjs';

export const MANIFEST_NAME = 'instances.json';
/** 探活超时：本机回环上"没起"是**立刻**的（ECONNREFUSED）；这个上限只为防"端口被别的
 *  进程占着却回话很慢"。1.5s 足够回环握手，又不至于让总览页干等。 */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * 仓根 —— 库根的**父目录**。`DATA_DIR = <仓>/data` ⇒ 父即仓根。
 * 取不到 `DATA_DIR` 时退回 `fallbackRoot`（`server.mjs` 把它传成了 `path.resolve(dataRoot,'..')`，
 * 所以两条路在服务下同值；`fallbackRoot` 末路只是保证"不崩"）。
 */
export function repoRoot() {
  const dir = hostConfig()?.DATA_DIR;
  if (dir) return path.resolve(dir, '..');
  return path.resolve(hostFallbackRoot());
}

/** 清单文件路径：`<仓根>/instances.json`。 */
export function manifestPath() {
  return path.join(repoRoot(), MANIFEST_NAME);
}

/** 路径解析：相对路径按**仓根**解析；绝对路径原样。空值 ⇒ 空串（"没写"要能与"写了空"区分开）。 */
export function resolveInRepo(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(repoRoot(), s);
}

/** 本服务进程自己的库根（绝对）—— `self` 判定与 `dataRootMatch` 的基准。 */
function selfDataRoot() {
  const dir = hostConfig()?.DATA_DIR;
  return dir ? path.resolve(dir) : '';
}

/**
 * 读清单。**永不抛**。
 * @returns {{exists:boolean, path:string, repoRoot:string, version:number, instances:Array, self:string, problems:string[], error?:string}}
 */
export function readManifest() {
  const root = repoRoot();
  const file = path.join(root, MANIFEST_NAME);
  const base = { path: file, repoRoot: root, version: 1, instances: [], self: selfDataRoot(), problems: [] };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...base, exists: false, error: `清单不在：${file}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ...base, exists: true, error: `清单不是合法 JSON：${e?.message ?? e}` };
  }

  const list = Array.isArray(doc?.instances) ? doc.instances : null;
  if (!list) return { ...base, exists: true, error: '清单里没有 instances 数组' };

  const problems = [];
  const instances = list.map((it, i) => {
    const name = String(it?.name ?? '').trim();
    const port = Number(it?.port);
    const portOk = Number.isInteger(port) && port > 0 && port <= 65535;
    if (!name) problems.push(`第 ${i + 1} 条缺 name`);
    if (!portOk) problems.push(`第 ${i + 1} 条（${name || '无名'}）port 非法：${JSON.stringify(it?.port)}`);
    const dataRoot = resolveInRepo(it?.dataRoot);
    if (!dataRoot) problems.push(`第 ${i + 1} 条（${name || '无名'}）缺 dataRoot（库根）`);
    return {
      name: name || `#${i + 1}`,
      port: portOk ? port : null,
      dataRoot,
      sourceRoot: resolveInRepo(it?.sourceRoot),
      note: String(it?.note ?? ''),
      baseURL: portOk ? `http://127.0.0.1:${port}` : '',
      self: Boolean(selfDataRoot() && dataRoot && path.resolve(dataRoot) === selfDataRoot())
    };
  });

  // 端口重复是"配置看起来对、实际互相踩"的典型：两个号共用一个端口，后起的那个
  // 会**静默连到先起的那个库**（启动器探活会说"已在运行"、然后跳过）。提前点名。
  const byPort = new Map();
  for (const it of instances) {
    if (it.port == null) continue;
    if (byPort.has(it.port)) problems.push(`端口 ${it.port} 被多条实例共用（${byPort.get(it.port)} / ${it.name}）`);
    else byPort.set(it.port, it.name);
  }

  return { ...base, exists: true, version: Number(doc?.version) || 1, instances, problems };
}

/**
 * 并发探活：`GET <baseURL>/health`。**只读、无副作用**；缺席/超时/端口上不是 vec-memory
 * 都算 `alive:false`（不抛）。
 *
 * 为什么探活放在**服务端**而不是总览页的前端：把"运行期事实"的判据收在一处，
 * 且总览页在**任何**一个活着的实例上打开都能看到全貌（前端不必跨源去问别的端口）。
 *
 * @param {Array<{baseURL:string, dataRoot:string, sourceRoot:string}>} instances
 */
export async function probeAll(instances, timeoutMs = PROBE_TIMEOUT_MS) {
  return Promise.all(instances.map(async (it) => {
    if (!it.baseURL) return { ...it, alive: false, reason: '清单里没有合法端口' };
    const t0 = Date.now();
    try {
      const r = await fetch(`${it.baseURL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      let j = null;
      try { j = await r.json(); } catch { /* 端口上不是本服务 / 非 JSON */ }
      const ok = r.ok && j?.status === 'ok' && j?.service === 'vec-memory';
      if (!ok) {
        return {
          ...it, alive: false, ms: Date.now() - t0, dataRootMatch: null, sourceRootMatch: null,
          reason: `端口上不是 vec-memory 服务（HTTP ${r.status}）`
        };
      }
      return {
        ...it,
        alive: true,
        ms: Date.now() - t0,
        health: { dataRoot: j.dataRoot, sourceRoot: j.sourceRoot },
        // 对账：清单写的 vs 运行期实际。`sourceRoot` 没写就"不适用"（null），不是"不一致"。
        dataRootMatch: path.resolve(String(j.dataRoot || '')) === path.resolve(it.dataRoot),
        sourceRootMatch: it.sourceRoot ? path.resolve(String(j.sourceRoot || '')) === path.resolve(it.sourceRoot) : null
      };
    } catch (e) {
      return {
        ...it,
        alive: false,
        ms: Date.now() - t0,
        dataRootMatch: null,
        sourceRootMatch: null,
        reason: e?.name === 'TimeoutError' ? `探活超时（>${timeoutMs}ms）` : '连不上（服务没起？）'
      };
    }
  }));
}

/** 读清单 + 探活一步到位（路由端点用）。 */
export async function loadInstances({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const man = readManifest();
  const probed = await probeAll(man.instances, timeoutMs);
  return { ...man, instances: probed };
}
