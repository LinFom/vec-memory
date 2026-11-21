// 备份/校验/恢复在独立线程里跑 [by:WorkBuddy 2026-11-08]
//
// 备份是重 I/O + 重 CPU（读盘、gzip、scrypt、逐行校验哈希链）。留在主线程上，
// 一次备份就会把整个 HTTP 服务的响应停住 —— 前端表现就是「点一下页面卡死」。
// 这里把它挪到 worker：主线程只等消息，继续处理请求（备份窗口内按设计返回 503 维护态，
// 但那是明确的 503，而不是无响应的转圈）。
//
// 进度也是从这里回传：worker 每完成一段就 postMessage 一条 progress，主线程写进进度登记表，
// 前端轮询 GET /api/v1/admin/backups/progress 就能看到真百分比（不是定时器假动画）。
import {parentPort, workerData} from 'node:worker_threads';
import {createBackupTo, inspectAnyFile, restoreAnyFile} from './backup.mjs';

const {action, args} = workerData;

// 15 次/秒足够让进度条看起来连续，又不至于让消息通道变成瓶颈。
const PROGRESS_INTERVAL_MS = 150;
let lastSent = 0;
const onProgress = patch => {
  const now = Date.now();
  if (now - lastSent < PROGRESS_INTERVAL_MS) return;
  lastSent = now;
  try { parentPort.postMessage({type: 'progress', progress: patch}); } catch { /* 进度丢一帧不影响备份 */ }
};

try {
  let result;
  if (action === 'create') result = await createBackupTo(args.root, args.destination, {...args, onProgress});
  else if (action === 'inspect') result = await inspectAnyFile(args.file, args.password, onProgress);
  else if (action === 'restore') result = await restoreAnyFile(args.file, args.destination, {...args, onProgress});
  else throw new Error('Unknown backup action: ' + action);
  parentPort.postMessage({ok: true, result});
} catch (error) {
  parentPort.postMessage({ok: false, code: error.code || 'BACKUP_FAILED', message: error.message, status: error.status || 500});
}
