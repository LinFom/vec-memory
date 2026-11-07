// 备份/校验/恢复在独立线程里跑 [by:WorkBuddy 2026-11-08]
//
// 备份是重 I/O + 重 CPU（读盘、gzip、scrypt、逐行校验哈希链）。留在主线程上，
// 一次备份就会把整个 HTTP 服务的响应停住 —— 前端表现就是「点一下页面卡死」。
// 这里把它挪到 worker：主线程只等消息，继续处理请求（备份窗口内按设计返回 503 维护态，
// 但那是明确的 503，而不是无响应的转圈）。
import {parentPort, workerData} from 'node:worker_threads';
import {createBackupTo, inspectAnyFile, restoreAnyFile} from './backup.mjs';

const {action, args} = workerData;
try {
  let result;
  if (action === 'create') result = await createBackupTo(args.root, args.destination, args);
  else if (action === 'inspect') result = await inspectAnyFile(args.file, args.password);
  else if (action === 'restore') result = await restoreAnyFile(args.file, args.destination, args);
  else throw new Error('Unknown backup action: ' + action);
  parentPort.postMessage({ok: true, result});
} catch (error) {
  parentPort.postMessage({ok: false, code: error.code || 'BACKUP_FAILED', message: error.message, status: error.status || 500});
}
