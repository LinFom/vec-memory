// tools/scope-map.mjs —— `chatKey` ↔ 场合标签（`group:C4012` / `private:C2383`）对照表。
// [by:DS] 2026-10-28
//
// ## 为什么需要它
// 事实槽的身份键是 `(speaker, target, fact_kind, scope)`，而 `scope` 是
// `HMAC(secret, 'scope\0' + chatKey) % 9999 + 1` 派生出来的**散列**（`normalize.mjs:580-585`）：
//
//   · 从 `group:C4012` **反推不出**是哪个群 —— 不是加密强度问题，是设计上就不打算能推；
//   · 所以手写一条档案时，`chatKey` 填错 ⇒ 派生出一个**新 scope** ⇒ 卡片上多出一块，
//     而你以为是在改原来那条。**这是静默失败**：接口回 200，卡上那一条纹丝不动。
//
// 这个工具把两边对上，让"改哪一条"变成可以看着选的事。
//
// ## 纪律
// 只读。`secret.key` **只在本进程内用于算 hmac**，不打印、不落任何输出。
//
// 用法：
//   node tools/scope-map.mjs --root=data
//   node tools/scope-map.mjs --root=data --scope=group:C4012     # 反查是哪个群
//   node tools/scope-map.mjs --root=data --chat=group:1130689942  # 正查会落到哪个 scope
import fs from 'node:fs';
import path from 'node:path';

import { hmac32 } from '../src/core/normalize.mjs';

const LABEL_SPACE = 9999;   // 与 normalize.mjs:85 同值；那边没导出常量，这里写死并在此声明来源

const argv = process.argv.slice(2);
const opt = (k, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const ROOT = path.resolve(opt('root', 'data'));
const LIB = path.join(ROOT, 'memory-vec');
const ASK_SCOPE = opt('scope');
const ASK_CHAT = opt('chat');

const die = (m) => { console.error(`[scope-map] ${m}`); process.exit(2); };

const secretFile = path.join(LIB, 'normalizer', 'secret.key');
if (!fs.existsSync(secretFile)) die(`找不到 ${secretFile}（--root 要指向数据根）`);
const secret = fs.readFileSync(secretFile, 'utf8').trim();
if (secret.length < 16) die('secret.key 长度异常（<16），与本机归一化器不匹配');

const scopeOf = (chatKey) => {
  const k = String(chatKey || '');
  const kind = k.startsWith('group:') ? 'group' : 'private';
  const n = (hmac32(secret, `scope\u0000${k}`) % LABEL_SPACE) + 1;
  return `${kind}:C${n}`;
};

// ── 收集"已知的 chatKey"：整理游标 + 事件账本（这两处是仅有的持久清单）──
const known = new Set();
const stateFile = path.join(LIB, 'consolidate', 'state.json');
if (fs.existsSync(stateFile)) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const k of Object.keys(st.chats || {})) known.add(k);
  } catch { /* 坏 JSON 不致命：还有账本那条路 */ }
}
const evFile = path.join(LIB, 'consolidate', 'events.jsonl');
let evRows = 0;
if (fs.existsSync(evFile)) {
  for (const line of fs.readFileSync(evFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      evRows += 1;
      const e = JSON.parse(line);
      if (e.chatKey) known.add(String(e.chatKey));
    } catch { /* 跳过坏行 */ }
  }
}

// ── 统计每个 scope 上有多少活槽（回答"这块卡是谁的"）──
const slotCount = new Map();
const slotsFile = path.join(LIB, 'facts', 'slots.jsonl');
let liveSlots = 0;
if (fs.existsSync(slotsFile)) {
  const best = new Map();
  for (const line of fs.readFileSync(slotsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const p = best.get(r.key);
      if (!p || (Number(r.rev) || 0) > (Number(p.rev) || 0)) best.set(r.key, r);
    } catch { /* 跳过坏行 */ }
  }
  liveSlots = best.size;
  for (const r of best.values()) slotCount.set(r.scope, (slotCount.get(r.scope) || 0) + 1);
}

// ── 单点查询 ─────────────────────────────────────────────────────────────
if (ASK_SCOPE) {
  const hits = [...known].filter((k) => scopeOf(k) === ASK_SCOPE);
  console.log(`scope ${ASK_SCOPE}：`);
  console.log(`  该 scope 上的活槽：${slotCount.get(ASK_SCOPE) || 0}`);
  if (!hits.length) {
    console.log('  对应的 chatKey：**已知清单里没有**');
    console.log('  说明：清单只含"整理游标 + 事件账本里出现过"的会话；');
    console.log('        如果这个 scope 的槽是直写来的、且该会话从未被整理过，就不会出现在清单里。');
    console.log('        此时不要猜 chatKey —— 写错会派生新 scope（见文件头）。');
  } else {
    for (const k of hits) console.log(`  chatKey = ${k}`);
  }
  process.exit(0);
}

if (ASK_CHAT) {
  const sc = scopeOf(ASK_CHAT);
  console.log(`${ASK_CHAT}  ⇒  ${sc}（该 scope 现有活槽 ${slotCount.get(sc) || 0} 条）`);
  process.exit(0);
}

// ── 全表 ─────────────────────────────────────────────────────────────────
const rows = [...known].map((k) => ({ chatKey: k, scope: scopeOf(k), slots: slotCount.get(scopeOf(k)) || 0 }))
  .sort((a, b) => b.slots - a.slots || a.chatKey.localeCompare(b.chatKey));

console.log(`库：${ROOT}`);
console.log(`活槽 ${liveSlots} 个，分布在 ${slotCount.size} 个 scope 上`);
console.log(`已知会话 ${known.size} 个（来源：整理游标 + 事件账本 ${evRows} 行）`);
console.log('');
console.log('  chatKey'.padEnd(30) + 'scope'.padEnd(18) + '该 scope 活槽');
for (const r of rows) {
  console.log(`  ${r.chatKey.padEnd(28)}${r.scope.padEnd(18)}${r.slots}`);
}

// ── 有槽却没对上任何已知会话的 scope（这些是最容易踩空的坑）─────────────
const mapped = new Set(rows.map((r) => r.scope));
const orphans = [...slotCount.entries()].filter(([sc]) => !mapped.has(sc)).sort((a, b) => b[1] - a[1]);
if (orphans.length) {
  console.log('');
  console.log('找不到 chatKey 的 scope（槽在，但账本里没有这个会话）：');
  for (const [sc, n] of orphans) console.log(`  ${sc.padEnd(18)}${n} 条`);
  console.log('  ⇒ 改这些卡时**不要猜 chatKey**：手写会派生新 scope，原槽不动（接口照样 200）。');
}
