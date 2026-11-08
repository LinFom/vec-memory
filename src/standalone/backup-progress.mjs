// 备份/恢复的进度登记表 [by:WorkBuddy 2026-11-08]
//
// 为什么需要它：一次完整备份要 40s、一次整库恢复要 54s，这段时间前端只有一个「处理中…」
// 胶囊，用户无法区分「在跑」和「卡死」—— 这正是上次页面被判定卡死的直接观感来源。
// 进度必须是真进度（按已处理字节算），不能是定时器假动画：假动画在失败时会走到 99% 不动。
//
// 生命周期：beginProgress → reportProgress*（可多次）→ finishProgress。
// 结束后快照保留 KEEP_FINISHED_MS，让最后一次轮询能看到 100% 或错误码。
// 这是进程内单例：worker 里跑的备份通过 backup-runner.mjs 把进度转发回主线程再写进来。

const KEEP_FINISHED_MS = 8000;

// 一个任务会分阶段跑，但 done 的分母每个阶段都不一样（校验按备份文件大小、写入又从 0 计）。
// 直接拿 done/total 会看到「96% → 1%」的倒退，所以按阶段给区间，让总进度只增不减。
const PHASE_SPAN = {
  restore: {verify: [0, 40], write: [40, 97], validate: [97, 100]},
  create: {scan: [0, 2], read: [2, 97], finalize: [97, 100]},
  upload: {read: [0, 100]},
  inspect: {verify: [0, 100]}
};

let current = null;

function emptySnapshot() {
  return { active: false, action: null, label: null, phase: null, done: 0, total: 0, percent: null, elapsedMs: 0, etaMs: null, bytesPerSec: 0, error: null };
}

export function beginProgress(action, label, total = 0) {
  const now = Date.now();
  current = {
    action: action || 'backup',
    label: label || '',
    phase: 'scan',
    done: 0,
    total: Math.max(0, Number(total) || 0),
    startedAt: now,
    phaseStartedAt: now,
    phaseDone: 0,
    updatedAt: now,
    finishedAt: 0,
    error: null
  };
  return current;
}

export function reportProgress(patch) {
  if (!current || current.finishedAt) return;
  const now = Date.now();
  // 阶段切换时 done 会从头开始（校验按密文，写入又从 0 计），所以速率与 ETA 必须按
  // 「本阶段」算 —— 否则刚进写盘就会显示「约剩 14 分 55 秒」这种吓人的假数字。
  if (patch.phase && patch.phase !== current.phase) {
    current.phase = patch.phase;
    current.phaseStartedAt = now;
    current.phaseDone = 0;
  }
  if (patch.label) current.label = patch.label;
  if (Number.isFinite(patch.total) && patch.total > 0) current.total = patch.total;
  if (Number.isFinite(patch.done)) { current.done = Math.max(0, patch.done); current.phaseDone = current.done; }
  current.updatedAt = now;
}

export function finishProgress(error, extra) {
  if (!current) return;
  current.finishedAt = Date.now();
  current.updatedAt = current.finishedAt;
  current.error = error ? { code: error.code || 'BACKUP_FAILED', message: error.message || String(error) } : null;
  if (!error && current.total > 0) current.done = current.total;
  current.phase = error ? 'failed' : 'done';
  // extra 让「结果」跟着进度一起留在快照里：页面刷新后前端还能拿到这次生成的备份 ID，
  // 否则用户看到 100% 却不知道该下载/恢复哪一个。
  if (extra && !error) current.extra = {...extra};
}

export function progressSnapshot() {
  if (!current) return emptySnapshot();
  const now = Date.now();
  const finished = current.finishedAt > 0;
  if (finished && now - current.finishedAt > KEEP_FINISHED_MS) { current = null; return emptySnapshot(); }
  const elapsedMs = (finished ? current.finishedAt : now) - current.startedAt;
  const phaseElapsedMs = Math.max(1, (finished ? current.finishedAt : now) - current.phaseStartedAt);
  const rate = current.phaseDone / (phaseElapsedMs / 1000);
  const remaining = current.total > 0 ? Math.max(0, current.total - current.done) : 0;
  // 扫描/准备/校验这几个阶段没有可用的字节分母（不知道总大小或已经在跑后续步骤），
  // 报 null 让前端画「不确定」流动条 —— 比停在 97.6% 假装快好了要诚实。
  const unknownPhase = ['scan', 'prepare', 'validate'].includes(current.phase);
  const span = PHASE_SPAN[current.action]?.[current.phase];
  const inPhase = current.total > 0 ? Math.min(1, current.done / current.total) : 0;
  const percent = unknownPhase || !current.total
    ? null
    : Math.round(((span ? span[0] + (span[1] - span[0]) * inPhase : inPhase * 100)) * 10) / 10;
  return {
    active: !finished,
    action: current.action,
    label: current.label,
    phase: current.phase,
    done: current.done,
    total: current.total,
    percent,
    elapsedMs,
    etaMs: rate > 0 && remaining > 0 ? Math.round(remaining / rate * 1000) : (finished ? 0 : null),
    bytesPerSec: Math.round(rate),
    error: current.error,
    ...(current.extra || {})
  };
}

/** 供 worker 侧复用：按时间间隔节流，避免每个 1MB 块都跨线程发一条消息。 */
export function makeTicker(onProgress, intervalMs = 200) {
  if (typeof onProgress !== 'function') return () => {};
  let last = 0;
  return (patch, force = false) => {
    const now = Date.now();
    if (!force && now - last < intervalMs) return;
    last = now;
    try { onProgress(patch); } catch { /* 进度回调永远不能影响备份本身 */ }
  };
}
