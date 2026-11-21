// memory-vec — 启动前预检的**核心**（不打印、不退出，只返回结构化结果）。
//
// 为什么需要预检（第 60 轮实测出来的）：
//   本插件的路由不是走 API 注册，而是把标记块 [[memory-vec:routes]] 打进核心 src/app.js。
//   而"打缝"这件事只能由插件自己在**被加载之后**触发 —— 那时核心文件早已 import 过一遍，
//   本次启动拿不到新缝。`patch.apply()` 返回的 `needsRestart:true` 就是在说这件事。
//   后果：缝缺失的那一次启动必然失效。用户看到的是
//     启用插件 → 重启 → 面板仍报「未知 API：POST /api/memory-vec/search」→ 再重启才好。
//   实测样本：进程 00:40:24 启动，src/app.js 00:40:48 才被写入（晚 24 秒）⇒ 当次失效。
//
// 做法：挂到启动脚本上，在核心文件被加载**之前**先跑一遍。缝在加载前就位 ⇒ 一次启动即生效。
//
// 为什么拆成 core + CLI 两层：CLI 那层要 `process.exit()`，一旦和逻辑写在同一个模块里，
// 逻辑就**再也无法在进程内被测试**（只能起子进程 —— 而子进程在受限环境里起不来，
// 于是测试只能整块跳过，等于没有）。所以这里只算、不说、不退。
//
// 纪律：
//   1. **一个 root**：要打谁，就问谁。root 默认取 `patch.DEFAULT_ROOT`（与 status/apply 同源，
//      因此自动尊重给测试/演练用的 `MEMORY_VEC_PATCH_ROOT`），"插件启用了吗"也去
//      **同一个 root** 的 `src/skills/config.js` 里问 —— 不存在"补丁打在 A、判据读的是 B"的劈叉。
//   2. **启用判据复用宿主自己的 `isSkillEnabledInConfig`** —— 与 index.js 用的是同一个函数。
//      不另写一份"启用状态"的影子判断（`src/skills/config.js` 首页明令禁止影子开关）。
//   3. **它不许抛**：任何异常都翻成 `action:'error'` 返回。预检坏掉不该让机器人起不来 ——
//      兜底仍在 index.js 的顶层 apply()，预检没跑成时行为与从前完全一样。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 按 root 解析宿主的某个模块（不用相对路径 —— 见纪律 1："要打谁就问谁"）。 */
const hostModule = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);

/**
 * 跑一次预检。
 *
 * @param {{ root?: string }} [opts] root 省略时用 `patch.DEFAULT_ROOT`。
 * @returns {Promise<{action:'applied'|'already'|'disabled'|'no-config'|'conflict'|'nothing'|'error',
 *                    root:string, state:string|null, changed:string[], detail:string}>}
 */
export async function runPreflight({ root } = {}) {
  const result = { action: 'error', root: '', state: null, changed: [], detail: '' };
  try {
    const patch = await import('../patch.mjs');
    const ROOT = root ? path.resolve(root) : patch.DEFAULT_ROOT;
    result.root = ROOT;

    // ① 插件启用了吗 —— 问宿主的配置读取器，不自己解析 config.json
    let enabled;
    try {
      const mod = await hostModule(ROOT, path.join('src', 'skills', 'config.js'));
      enabled = mod.isSkillEnabledInConfig('memory-vec', false);
    } catch (error) {
      result.action = 'no-config';
      result.detail = String(error?.message ?? error);
      return result;
    }
    if (!enabled) { result.action = 'disabled'; return result; }

    // ② 备份指到 data/ 下：plugins/ 被 fs.watch 全量监听，往插件目录写文件会触发一次
    //    全量重扫（插件被 deactivate 再重载）。拿不到 DATA_DIR 就落回插件目录下的 backup/，
    //    不影响正确性。（index.js 里也有同一处赋值 —— 两条独立入口都得设，不是冗余。）
    try {
      const { DATA_DIR } = await hostModule(ROOT, path.join('src', 'config.js'));
      if (DATA_DIR) process.env.MEMORY_VEC_BACKUP_DIR = path.join(DATA_DIR, 'memory-vec', '_patchbackup');
    } catch { /* 见上 */ }

    // ③ 补缝
    const before = patch.status({ root: ROOT });
    result.state = before.state;
    if (before.state === 'patched') { result.action = 'already'; return result; }

    const r = patch.apply({ root: ROOT });
    result.state = r.state;
    result.changed = r.changed || [];
    if (r.conflicts?.length) {
      const c = r.conflicts[0];
      result.action = 'conflict';
      result.detail = `${c.file} - ${c.detail}`;
      return result;
    }
    result.action = result.changed.length ? 'applied' : 'nothing';
    return result;
  } catch (error) {
    result.action = 'error';
    result.detail = String(error?.message ?? error);
    return result;
  }
}
