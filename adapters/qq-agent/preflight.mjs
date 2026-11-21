// memory-vec — 启动前预检的 **CLI 外壳**（由 launch.ps1 在 Electron 起来**之前**调用）。
//
// 这一层只做三件事：调核心、把结果翻成**一行 ASCII**、退出码恒为 0。
// 逻辑（什么时候打、打谁、判据从哪来）全在 `lib/preflight.mjs` —— 那里能在进程内被测试，
// 这里只能在子进程里被测试，所以薄到没有可测的东西才是对的。
//
// 两条纪律：
//   · **非致命**：退出码恒为 0。预检坏掉不该让机器人起不来 —— 兜底仍在 index.js 的顶层 apply()。
//   · **stdout 只用 ASCII**：launch.ps1 是纯 ASCII 文件，且 PowerShell 5.1 解码子进程输出用的是
//     控制台代码页（中文 Windows 上是 936），子进程写 UTF-8 中文进日志会成乱码。
//     日志是排障用的，宁可英文也别乱码；中文解释留在本文件/核心模块的注释里。
import { runPreflight } from './lib/preflight.mjs';

const TAG = '[memory-vec] preflight:';

const describe = (r) => {
  switch (r.action) {
    case 'applied': return `seam applied (${r.changed.join(', ')}) - effective on this start`;
    case 'already': return 'seam already in place - nothing to do';
    case 'disabled': return 'skipped (plugin disabled - by design it keeps no seam)';
    case 'no-config': return `skipped (cannot read host config: ${r.detail})`;
    case 'conflict': return `NOT applied (${r.state}): ${r.detail}`;
    case 'nothing': return `nothing to do (state=${r.state})`;
    default: return `error, ignored (startup not affected): ${r.detail}`;
  }
};

/** 单行收尾：先等 stdout 排空再退，避免走管道时被截断。 */
function finish(line) {
  process.stdout.write(`${TAG} ${line}\n`, () => process.exit(0));
}

runPreflight()
  .then((r) => finish(describe(r)))
  .catch((error) => finish(`error, ignored (startup not affected): ${error?.message ?? error}`));
