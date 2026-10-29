// groupnames.mjs — 星系标签（群）的**本机真名**来源。
//
// ── 这一条修的是什么 ────────────────────────────────────────────────────
// 星图上的星系标签一直是 `群 C9814` —— 那是 `scopeLabel()` 派生的**占位符**
// （`group:C9814`），不是群名。用户看的是自己的群，看到代号只会问「这谁啊」。
//
// ── 为什么不能"从存档里读" ───────────────────────────────────────────────
// 存档里**确实没有群名**：`data/messages/group_*.json` 只有 `chatKey` + 消息
// （`senderName` 是**人**名）。所以旧结论是"群名没有任何本机来源"。
// 但**宿主有**：它经 OneBot `get_group_list` 拿得到 `group_name`（`src/app.js`
// 的 `/api/onebot/groups` 就是它），并已经挂在 HTTP 面上。本机、只读、无需新端口。
//
// ── 做法 ────────────────────────────────────────────────────────────────
//   ① 问宿主要那张表：`GET <宿主>/api/onebot/groups` → `[{id, name}]`
//   ② 把 `群号 → 占位符`（`scopeLabel('group:'+id)`，本机密钥算，不可反推）
//      与 `群名` 拼成本机映射，落进**库根**的缓存文件
//   ③ 渲染期由 `/identity/names` 贴到星图上（页面只认占位符，不认群号）
//
// ⚠️ **缓存键是占位符，不是群号** —— 与 `notes.mjs` 同一条纪律：这张表即使被导出，
//    也不含明文群号。群名是"真名"，按 `ADR-0010`（隐私边界画在出境处、不画在界面）
//    属于**界面层可以显示**的那一类；它不进任何出境文本（出境的是脱敏后的聊天块）。
//
// ── 为什么不是"宿主落盘一份、服务读文件" ─────────────────────────────────
// 那要改宿主核心（`src/`）—— 本项目的硬约束是**禁止动核心**（工作记忆·铁律）。
// 宿主的 HTTP 面是既有的、稳定的对接点（外接模式的全部意义），所以走它。
//
// ── 降级（必须显式，不许静默）─────────────────────────────────────────────
// 宿主没开 / 没连 OneBot / 超时 ⇒ 用**上次缓存**；连缓存也没有 ⇒ 退回占位符显示。
// 无论哪条路，`error` 都要带回调用方 —— 否则"群本来就没名字"与"拉不到名字"
// 在界面上长得一模一样，这正是本项目一直在消灭的那类故障。

import fs from 'node:fs';
import path from 'node:path';

/** 宿主 HTTP 面的兜底端口（读不到宿主 config.json 时用；实测宿主 `server.port = 3210`）。 */
export const HOST_API_PORT_FALLBACK = 3210;
/** 群名表缓存文件名（落在**库根**，与 `notes.json` 同级）。 */
export const GROUP_NAMES_FILE = 'group-names.json';
/** 多旧的缓存算陈旧（超过就后台刷一次）。群改名不频繁，10 分钟足够。 */
export const GROUP_NAMES_MAX_AGE_MS = 10 * 60_000;
/** 首次（还没有缓存）时**等**多久 —— 这是唯一会阻塞响应的那条路，所以给短一点。 */
export const GROUP_NAMES_FIRST_TIMEOUT_MS = 2500;
/** 后台刷新用的超时（不阻塞任何人，可以给宽一点）。 */
export const GROUP_NAMES_BG_TIMEOUT_MS = 6000;

/**
 * 宿主 HTTP 面在哪。
 *
 * 优先级：设置项 `groupNamesBaseURL` > `<源根>/config.json` 的 `server.port` > 兜底 3210。
 * 读宿主配置**失败按"没配"处理**（与 `readSkillConfig` / `resolveSourceRoot` 同口径：
 * 配置读不到不能拒绝服务）。`source` 一并回报，便于界面上说清"这个名字是哪来的"。
 *
 * @param {string} sourceRoot 宿主 data 根（记录面板设置的那份 config.json 就在它下面）
 * @param {object} [settings]  本插件设置
 * @returns {{base:string, source:'setting'|'host-config'|'default'}}
 */
export function hostApiBase(sourceRoot, settings) {
  const fromSetting = String(settings?.groupNamesBaseURL || '').trim().replace(/\/+$/, '');
  if (fromSetting) return { base: fromSetting, source: 'setting' };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(String(sourceRoot || '')), 'config.json'), 'utf8'));
    const port = Number(raw?.server?.port) || 0;
    if (port > 0) return { base: `http://127.0.0.1:${port}`, source: 'host-config' };
  } catch { /* 读不到 ⇒ 兜底 */ }
  return { base: `http://127.0.0.1:${HOST_API_PORT_FALLBACK}`, source: 'default' };
}

/**
 * 归一化宿主回的群列表。
 *
 * 容三种形状：裸数组 / `{groups:[…]}` / `{data:[…]}`（OneBot 实现之间不一致，
 * 宿主自己也同时容了 `list?.data ?? []`）。字段同理：`id|group_id`、`name|group_name`。
 * **没有 id 的条目直接丢**（丢它安全：留下只会生成一个键不对的映射）。
 *
 * @param {any} payload
 * @returns {Array<{id:string, name:string}>}
 */
export function normalizeGroupList(payload) {
  const arr = Array.isArray(payload) ? payload
    : Array.isArray(payload?.groups) ? payload.groups
      : Array.isArray(payload?.data) ? payload.data
        : [];
  const out = [];
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id ?? g.group_id ?? '').trim();
    if (!id) continue;
    // 名字可能为空（协议端没给）—— 空名不写进映射，让它退回占位符（别写空串当名字）。
    const name = String(g.name ?? g.group_name ?? '').trim();
    out.push({ id, name });
  }
  return out;
}

/**
 * 拉宿主那张群列表。
 *
 * 失败一律**带真因**回来（超时 / HTTP 状态 / 连接被拒），不抛 —— 调用方只需要
 * 一个可判断的结果。超时用 `AbortController`：宿主没开时是"连接被拒"（立刻回），
 * 但宿主**开着却没连 OneBot** 时可能一直挂着，那条路只能靠超时收。
 *
 * @param {string} baseUrl 宿主 HTTP 面
 * @param {{timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, groups:Array<{id:string,name:string}>, error:string|null}>}
 */
export async function fetchGroupList(baseUrl, { timeoutMs = GROUP_NAMES_FIRST_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, groups: [], error: '运行环境没有 fetch' };
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/api/onebot/groups`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(300, Number(timeoutMs) || 0));
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, groups: [], error: `宿主群列表接口回了 ${r.status}` };
    return { ok: true, groups: normalizeGroupList(await r.json()), error: null };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `${timeoutMs}ms 内没回应` : String(err?.message ?? err);
    return { ok: false, groups: [], error: `连不上宿主（${msg}）` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 群列表 + 占位符派生 ⇒ 渲染用的映射。
 *
 * ⚠️ **必须**给 `scopeLabel`：占位符由本机密钥派生（`normalize.mjs` 的 `scopeLabel`），
 * 拿群号当键就等于把明文群号写进缓存文件。缺它**抛**，不退回明文
 * （与 `edges.mjs` 的 `extractScopeEdges` 同一条守卫：退回 = 静默重开泄密通道）。
 *
 * @param {Array<{id:string,name:string}>} groups
 * @param {(chatKey:string)=>string} scopeLabel
 * @returns {Record<string,string>} `{ 'group:C1234': '群名' }`
 */
export function groupScopeNames(groups, scopeLabel) {
  if (typeof scopeLabel !== 'function') {
    throw new Error('groupScopeNames 需要 normalizer.scopeLabel（缓存键必须是占位符，否则会落明文群号）');
  }
  /** @type {Record<string,string>} */
  const names = {};
  for (const g of groups || []) {
    if (!g || !g.id || !g.name) continue;   // 空名不写：宁可退回占位符，也别写个空串当名字
    names[scopeLabel(`group:${g.id}`)] = g.name;
  }
  return names;
}

/** 读缓存（同步、小文件）。读不到 ⇒ `{at:0, names:{}, error}`，不抛。 */
export function readGroupNameCache(libDir) {
  const file = path.join(path.resolve(String(libDir || '.')), GROUP_NAMES_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = (j && typeof j.names === 'object' && j.names) ? j.names : {};
    return { ok: true, at: Number(j?.at) || 0, base: String(j?.base || ''), source: String(j?.source || ''), names, error: null };
  } catch (err) {
    return { ok: false, at: 0, base: '', source: '', names: {}, error: `读不到群名缓存（${err?.code || err?.message || err}）` };
  }
}

/** 写缓存（原子替换：临时文件 + rename，避免面板正读到半截）。 */
export function writeGroupNameCache(libDir, { at, base = '', source = '', names = {} } = {}) {
  const dir = path.resolve(String(libDir || '.'));
  const file = path.join(dir, GROUP_NAMES_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at, base, source, names }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * 拉一次并落盘。**唯一的写盘点**。
 *
 * 失败**不覆盖**旧缓存（`refreshGroupNames` 早退）—— 宿主临时重启一次不该把上次
 * 拿到的一整套群名擦掉。
 *
 * @returns {Promise<{ok:boolean, count:number, at:number, base:string, source:string, error:string|null}>}
 */
export async function refreshGroupNames({ libDir, sourceRoot, settings, scopeLabel, timeoutMs = GROUP_NAMES_BG_TIMEOUT_MS, fetchImpl } = {}) {
  const { base, source } = hostApiBase(sourceRoot, settings);
  const r = await fetchGroupList(base, { timeoutMs, fetchImpl });
  if (!r.ok) return { ok: false, count: 0, at: Date.now(), base, source, error: r.error };
  const names = groupScopeNames(r.groups, scopeLabel);
  const at = Date.now();
  const w = writeGroupNameCache(libDir, { at, base, source, names });
  return {
    ok: true, count: Object.keys(names).length, at, base, source,
    error: w.ok ? null : `拉到了群名但没写进缓存（${w.error}）`
  };
}

// ── 运行期状态（每份 runtime 一套）────────────────────────────────────────
// 用 WeakMap 而不是挂在 rt 上：这是本模块的自有状态，别让调用方去读/写它。
// 挂在 rt 上的代价是"别人也能改"，而它有 busy 这种**互斥**语义 —— 被外面误清就并发刷。
const states = new WeakMap();
function stateOf(rt) {
  let s = states.get(rt);
  if (!s) { s = { busy: false, last: null, lastAttemptAt: 0 }; states.set(rt, s); }
  return s;
}

/**
 * 渲染期取数：**先用缓存立刻回答**，陈旧就顺手在后台刷。
 *
 * 唯一的例外：**一次缓存都没有**（服务刚起来 / 换了库）⇒ 那条路必须阻塞等一下，
 * 否则用户第一次打开星图看到的还是 `群 C9814`，而"再刷一次就好了"没人会做。
 *
 * @param {object} rt 运行期（读 `rt.dir` / `rt.settings` / `rt.normalizer.scopeLabel`）
 * @param {{sourceRoot:string, maxAgeMs?:number, firstTimeoutMs?:number, fetchImpl?:Function}} opts
 * @returns {Promise<{names:Record<string,string>, at:number, stale:boolean, refreshing:boolean, base:string, source:string, error:string|null}>}
 */
export async function groupNamesFor(rt, { sourceRoot, maxAgeMs = GROUP_NAMES_MAX_AGE_MS, firstTimeoutMs = GROUP_NAMES_FIRST_TIMEOUT_MS, fetchImpl } = {}) {
  const s = stateOf(rt);
  const cache = readGroupNameCache(rt?.dir);
  const now = Date.now();
  const scopeLabel = rt?.normalizer?.scopeLabel?.bind(rt.normalizer);
  const stale = !cache.at || (now - cache.at) > Number(maxAgeMs);
  const args = { libDir: rt?.dir, sourceRoot, settings: rt?.settings, scopeLabel, fetchImpl };

  if (!stale || s.busy || typeof scopeLabel !== 'function') {
    return {
      names: cache.names, at: cache.at, stale,
      refreshing: s.busy, base: cache.base, source: cache.source,
      error: s.last?.error ?? cache.error ?? null
    };
  }

  if (!cache.at) {
    // 首次：等（短超时）。这一步失败不回退到"空"——缓存文件本来就没有，如实回报。
    s.busy = true;
    try {
      s.last = await refreshGroupNames({ ...args, timeoutMs: firstTimeoutMs });
    } finally { s.busy = false; s.lastAttemptAt = Date.now(); }
    return {
      names: s.last?.ok ? readGroupNameCache(rt?.dir).names : {}, at: s.last?.at || 0, stale: false,
      refreshing: false, base: s.last?.base || '', source: s.last?.source || '', error: s.last?.error ?? null
    };
  }

  // 有缓存但陈旧：**后台**刷，这一次仍回答旧值（不改用户看到的等待时间）。
  s.busy = true;
  s.lastAttemptAt = now;
  refreshGroupNames(args)
    .then((r) => { s.last = r; })
    .catch((err) => { s.last = { ok: false, error: String(err?.message ?? err) }; })
    .finally(() => { s.busy = false; });

  return {
    names: cache.names, at: cache.at, stale: true, refreshing: true,
    base: cache.base, source: cache.source, error: s.last?.error ?? cache.error ?? null
  };
}

/** 强制刷新（面板/排障用）。清 busy 前先跑完 —— 调用方在等结果。 */
export async function forceRefreshGroupNames(rt, { sourceRoot, timeoutMs = GROUP_NAMES_BG_TIMEOUT_MS, fetchImpl } = {}) {
  const s = stateOf(rt);
  const scopeLabel = rt?.normalizer?.scopeLabel?.bind(rt.normalizer);
  s.busy = true;
  try {
    s.last = await refreshGroupNames({ libDir: rt?.dir, sourceRoot, settings: rt?.settings, scopeLabel, timeoutMs, fetchImpl });
  } finally {
    s.busy = false;
    s.lastAttemptAt = Date.now();
  }
  return s.last;
}
