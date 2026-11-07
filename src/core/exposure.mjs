// src/core/exposure.mjs —— 跨轮曝光软降权状态（纯内存 / 有界 / 可丢弃派生量）
// [by:WorkBuddy] 2026-11-06，票 03 + docs/cost-and-mitigations-20261106.md §1(C1/C6)
//
// ⚠️ 本模块**故意不落盘**。原设计要写 `<space>/state/policy-state.json`，复核后否决：
//   ① 每次查询路径上的同步小文件写；② 一旦进完整备份，恢复出来的计数与事实层不同步；
//   ③ 最贵的：若误进 `encodingIdentity()`，改一次权重就会触发整库重嵌。
// 按 CQRS projection 的纪律，read model 是缓存不是真值 —— 那就干脆不落。
//
// 口径（2026-11-07 更新）：同一个实例同时承载**两个互不串味的通道**——
//   · 'search'：本服务 `/search` 最近返回过哪些文档 id；
//   · 'inject'：真正进过 prompt 的属性/档案行 id（`who|line`）。
// 两侧 id 空间根本不同（文档 id vs 注入行），混在一个 key 里 lookup 永远不命中，
// 所以由 `channelKey()` 统一把 channel 编进 key，物理隔离（票 03 收尾）。
// 注入级只在 enabled 态写：shadow 只算不记，off 完全不碰。
//
// 与「采用次数」严格分开（CONTEXT.md:16「采用次数不是真实性评分」）：
// 本模块只影响 hits 顺序，不写任何事实、不改任何 meta、不参与 sourceHash。
// 进程重启后状态归零 ⇒ 前 N 轮无曝光记忆，这是已知且可接受的退化。

export const EXPOSURE_LIMITS = Object.freeze({
  maxSessions: 256,
  maxTurns: 8,
  maxIdsPerTurn: 32,
  ttlMs: 10 * 60 * 1000
});

/** 统一 key 构造：space + channel + chatKey，保证检索级与注入级互不污染。 */
export function channelKey(spaceKey, channel, chatKey) {
  return `${String(spaceKey || 'default')}|${String(channel || 'search')}|${String(chatKey ?? '')}`;
}

function intIn(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

/**
 * @param {object} [overrides]
 * @returns {{record:Function, lookup:Function, stats:Function, reset:Function, limits:object}}
 */
export function createExposureState(overrides = {}) {
  const limits = {
    maxSessions: intIn(overrides.maxSessions, 1, 4096, EXPOSURE_LIMITS.maxSessions),
    maxTurns: intIn(overrides.maxTurns, 1, 64, EXPOSURE_LIMITS.maxTurns),
    maxIdsPerTurn: intIn(overrides.maxIdsPerTurn, 1, 256, EXPOSURE_LIMITS.maxIdsPerTurn),
    ttlMs: intIn(overrides.ttlMs, 1000, 86400000, EXPOSURE_LIMITS.ttlMs)
  };
  // key = `${spaceKey}|${chatKey}` → { lastSeen, turns:[{ts, ids:Set}] }
  const sessions = new Map();

  function sweep(now) {
    for (const [key, s] of sessions) {
      if (now - s.lastSeen > limits.ttlMs) { sessions.delete(key); continue; }
      s.turns = s.turns.filter((t) => now - t.ts <= limits.ttlMs);
      if (!s.turns.length) sessions.delete(key);
    }
    while (sessions.size > limits.maxSessions) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, s] of sessions) if (s.lastSeen < oldest) { oldest = s.lastSeen; oldestKey = k; }
      if (oldestKey === null) break;
      sessions.delete(oldestKey);
    }
  }

  /** 记录一轮曝光。同一 (key, now) 重复调用只合并去重，不累加 ⇒ 幂等。 */
  function record(key, ids, now = Date.now()) {
    const scope = String(key || 'default');
    const list = Array.isArray(ids) ? ids.slice(0, limits.maxIdsPerTurn).map((x) => String(x)) : [];
    if (!list.length) return { recorded: 0, turns: 0 };
    sweep(now);
    let s = sessions.get(scope);
    if (!s) { s = { lastSeen: now, turns: [] }; sessions.set(scope, s); }
    const sameTurn = s.turns.find((t) => t.ts === now);
    if (sameTurn) for (const id of list) sameTurn.ids.add(id);
    else s.turns.push({ ts: now, ids: new Set(list) });
    while (s.turns.length > limits.maxTurns) s.turns.shift();
    s.lastSeen = now;
    // 刷新插入顺序，让 sweep 的超限淘汰近似 LRU
    sessions.delete(scope);
    sessions.set(scope, s);
    return { recorded: list.length, turns: s.turns.length };
  }

  /** 返回该 id 在最近 window 轮里被曝光了几次、以及应乘的软降权因子（永不排除）。 */
  function lookup(key, id, now = Date.now(), window = 3, decay = 0.6) {
    const scope = String(key || 'default');
    const s = sessions.get(scope);
    if (!s) return { count: 0, factor: 1 };
    if (now - s.lastSeen > limits.ttlMs) {
      sessions.delete(scope);
      return { count: 0, factor: 1 };
    }
    const w = intIn(window, 1, limits.maxTurns, 3);
    const rawDecay = Number(decay);
    const d = Number.isFinite(rawDecay) ? Math.min(1, Math.max(0.01, rawDecay)) : 0.6;
    const recent = s.turns.slice(-w).filter((t) => now - t.ts <= limits.ttlMs);
    let count = 0;
    for (const t of recent) if (t.ids.has(String(id))) count += 1;
    return { count, factor: Math.pow(d, count) };
  }

  function stats(now = Date.now()) {
    sweep(now);
    let turns = 0;
    let ids = 0;
    for (const s of sessions.values()) {
      turns += s.turns.length;
      for (const t of s.turns) ids += t.ids.size;
    }
    return { sessions: sessions.size, turns, ids, limits: { ...limits } };
  }

  function reset() { sessions.clear(); }

  return { record, lookup, stats, reset, limits };
}

/** 进程级单例。多空间靠 key 里的 spaceKey 隔离，不共享计数。 */
export const defaultExposureState = createExposureState();
