import fs from 'node:fs';
import path from 'node:path';

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function watchAgentOwners(root, onIdle, { pollMs = 1000, idleMs = 5000 } = {}) {
  const dir = path.join(root, '.agent-owners');
  let emptySince = null;
  const timer = setInterval(() => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        emptySince = null;
        return;
      }
      entries = [];
    }
    let active = false;
    for (const entry of entries) {
      if (!entry.isFile() || !/^[1-9]\d{0,9}$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid > 0x7fffffff) continue;
      if (processExists(pid)) active = true;
      else {
        try { fs.rmSync(path.join(dir, entry.name), { force: true }); } catch { /* retry on the next poll */ }
      }
    }
    if (active) {
      emptySince = null;
      return;
    }
    const now = Date.now();
    emptySince ??= now;
    if (now - emptySince >= idleMs) {
      clearInterval(timer);
      onIdle();
    }
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
