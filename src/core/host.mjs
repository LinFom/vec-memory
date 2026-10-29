// host.mjs — 宿主环境注入点（**唯一入口**）
//
// ── 它解决什么 ───────────────────────────────────────────────────────────
// 拆仓前，core 用 `await import('../../src/config.js')` 去够宿主的配置模块 ——
// 那条路径**把"本文件住在 <宿主>/plugins/<id>/ 里"这件事写死了**。
// 拆仓后本文件不再知道自己在哪，于是改成：**谁用谁注入**。
//
// ── 纪律 ─────────────────────────────────────────────────────────────────
// ① **只有一个注入函数** `bindHost()`。多个入口会让"忘了注入"变成一种可能，
//    而忘了注入的后果是**静默降级**（拿到 null ⇒ 走兜底路径 ⇒ 写错目录）。
// ② **注入的是模块本身，不是它的拷贝** —— 宿主场景下注入 `src/config.js` 与
//    `src/skills/config.js` 这两个 module namespace，于是 `DATA_DIR` 与
//    `getSkillConfig` 与宿主读到的是**同一份实例**（配置热重载才跟着动）。
// ③ `hostFallbackRoot()` 只在**注入缺席**时被用到，是"保证不崩"的兜底，
//    不是正常路径 —— 它的值**不该被写进任何产物**。

/** @type {{ config: object|null, settings: object|null, fallbackRoot: string|null }} */
const host = { config: null, settings: null, fallbackRoot: null };
let bound = false;

/**
 * 绑定宿主环境。幂等；后调用者覆盖前者（测试里会重复绑定）。
 * @param {{ config?: object|null, settings?: object|null, fallbackRoot?: string|null }} h
 */
export function bindHost(h = {}) {
  if (h.config !== undefined) host.config = h.config;
  if (h.settings !== undefined) host.settings = h.settings;
  if (h.fallbackRoot !== undefined) host.fallbackRoot = h.fallbackRoot;
  bound = true;
  return host;
}

/** 注入过没有 —— 供启动期自检用（"注入了"和"注入了空对象"是两件事）。 */
export function hostBound() { return bound; }

/** 宿主的 `src/config.js`（取 `DATA_DIR`）。未注入 ⇒ null，调用点走原兜底分支。 */
export function hostConfig() { return host.config; }

/** 宿主的 `src/skills/config.js`（取 `getSkillConfig`）。未注入 ⇒ null。 */
export function hostSettings() { return host.settings; }

/** 兜底根：仅在两个注入都缺席时用于拼一个"不崩"的路径（绝不写盘）。 */
export function hostFallbackRoot() { return host.fallbackRoot || process.cwd(); }

/** 重置（测试用）。 */
export function resetHost() {
  host.config = null; host.settings = null; host.fallbackRoot = null; bound = false;
}
