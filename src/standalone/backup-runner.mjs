// 主线程侧的 worker 包装 [by:WorkBuddy 2026-11-08]
// 只负责起线程、等结果、超时与异常归一；所有备份逻辑都在 backup-worker.mjs 里。
import {Worker} from 'node:worker_threads';
import {MemoryError} from '../core/durable-log.mjs';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function runBackupTask(action, args, {timeoutMs = DEFAULT_TIMEOUT_MS, memoryMb = 768} = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {action, args},
        // 不继承父进程的 execArgv：--input-type / -e 这类参数会让 worker 无法按文件加载。
        execArgv: [],
        // 流式之后内存应该只有几十 MB；给 768MB 是为了让「又变回整库读内存」的回归立刻炸出来。
        resourceLimits: {maxOldGenerationSizeMb: memoryMb}
      });
    } catch (error) {
      reject(new MemoryError('BACKUP_FAILED', 'Cannot start backup worker: ' + error.message, 500));
      return;
    }
    let settled = false;
    const finish = fn => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new MemoryError('BACKUP_TIMEOUT', 'Backup task timed out', 504))), timeoutMs);
    worker.once('message', message => finish(() => {
      if (message.ok) resolve(message.result);
      else reject(new MemoryError(message.code || 'BACKUP_FAILED', message.message || 'Backup task failed', message.status || 500));
    }));
    worker.once('error', error => finish(() => reject(new MemoryError('BACKUP_FAILED', error.message, 500))));
    worker.once('exit', code => { if (code !== 0) finish(() => reject(new MemoryError('BACKUP_FAILED', `Backup worker exited with code ${code}`, 500))); });
  });
}
