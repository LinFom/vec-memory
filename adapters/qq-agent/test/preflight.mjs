// 启动前预检（`lib/preflight.mjs` 核心 + `preflight.mjs` CLI）的回归测试。
//
// 它要钉住的是**装配时机**这件事 —— 也就是第 60 轮那次事故的根因：
//   缝必须在核心 src/app.js 被加载**之前**就位，否则那一次启动拿不到路由，
//   用户被迫"启用→重启→仍失效→再重启"。
//
// 断言清单：
//   ① 缝缺失 + 插件启用 ⇒ 真的补上（"一次启动即生效"的前提）
//   ② 缝已在 ⇒ 空操作，文件逐字节不变（幂等）
//   ③ 插件停用 ⇒ 一个字节都不动（按设计"停用不占缝"）
//   ④ 读不到宿主配置 ⇒ action='no-config'，**不抛**（非致命：预检坏掉不许拖垮启动）
//   ⑤ CLI 契约：退出码 0 + stdout 恰好一行 + 全 ASCII（给启动脚本用）
// 另加：别人的标记块（murmur）必须原样共存。
//
// 为什么断言打在**核心返回的 action**上而不是 stdout 文案上：文案是给日志看的、会改；
// `action` 是契约。CLI 那层薄到只剩格式化，它的契约（退出码/单行/ASCII）单独测一次就够。
//
// ⚠️ 为什么每改一次 config.json 都要 `reloadConfig()`：宿主的 `getConfig()` 是
//   **模块级缓存**（`currentConfig`，一个进程一份快照）—— 生产上完全正确（进程起来读一次，
//   之后改动都走 `updateConfig` 写内存+落盘）。但测试要在**同一进程**里观察两种配置状态，
//   就必须走宿主自己提供的重读入口 `reloadConfig()`（它就是给热重启用做的那件事）。
//   这不是替宿主绕路，是照它的真实语义操作 —— 顺带把"这份缓存的存在"钉进测试。
//
// 为什么把宿主 config 链一并拷进演练根：启用判据必须用**宿主真的那一份**
// （`src/skills/config.js` 的 `isSkillEnabledInConfig`），不许在测试里造一个假的
// —— "测试里替生产补那一步"正是本项目栽过的跟头（ADR-0023）。
// 这条链只有 4 个文件、personas/tier-slider 零依赖，拷起来很便宜。
//
// 运行：
//   node test/preflight.mjs "E:/Tools/QQ-Agent-整合版-20260922"
//   node test/preflight.mjs            # 部署进 plugins/ 之后可以省掉参数
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PREFLIGHT_CLI = path.join(PLUGIN_DIR, 'preflight.mjs');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`); }
}
function skipCheck(label, why) {
  skip++;
  console.log(`  ⚠️ 跳过：${label} —— ${why}`);
}

const ROOT = path.resolve(process.argv[2] || process.env.QQ_AGENT_ROOT || path.resolve(PLUGIN_DIR, '..', '..'));
console.log(`\n宿主（真核心来源）：${ROOT}`);
if (!fs.existsSync(path.join(ROOT, 'src', 'app.js'))) {
  console.error(`❌ 找不到 ${path.join(ROOT, 'src', 'app.js')}`);
  console.error('   用法：node test/preflight.mjs "<QQ-Agent 根目录>"');
  process.exit(2);
}

// ── 1. 搭演练根：真 app.js + 真 config 链 ─────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-preflight-'));
const DATA = path.join(TMP, 'data');
const APP = path.join(TMP, 'src', 'app.js');

/** 宿主的启用判据链：config.js → personas.js + tier-slider.js；skills/config.js → config.js。 */
const CONFIG_CHAIN = [
  'src/config.js',
  'src/personas.js',
  'src/tier-slider.js',
  path.join('src', 'skills', 'config.js'),
];

function copyInto(target, rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(target, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function seedRoot(target, { withConfigChain = true } = {}) {
  copyInto(target, 'src/app.js');
  if (withConfigChain) for (const rel of CONFIG_CHAIN) copyInto(target, rel);
}
function writeSkillsConfig(enabled) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'),
    `${JSON.stringify({ skills: { 'memory-vec': { enabled } } }, null, 2)}\n`, 'utf8');
}

seedRoot(TMP);
writeSkillsConfig(true);
console.log(`演练根：${TMP}\n`);

// ── 2. 环境变量必须在 import 之前设好（都是模块顶层求值的）─────────────────
process.env.MEMORY_VEC_PATCH_ROOT = TMP;                            // patch.mjs 的 DEFAULT_ROOT
process.env.MEMORY_VEC_BACKUP_DIR = path.join(TMP, '__backup');
process.env.QQ_AGENT_DATA_DIR = DATA;                               // 宿主 config.js 的 CONFIG_FILE
const patch = await import('../patch.mjs');
const { runPreflight } = await import('../lib/preflight.mjs');
// 与核心内部解析到的是**同一个** config.js 模块实例（都是无 query 的同一路径）。
const hostConfig = await import(pathToFileURL(path.join(TMP, 'src', 'config.js')).href);

/** 改盘上的开关 + 强制宿主重读（见文件头那条 ⚠️）。 */
function setEnabled(v) {
  writeSkillsConfig(v);
  hostConfig.reloadConfig();
}

// ── 3. 把演练根的 app.js 归一化到**干净态**（没有 memory-vec 的缝）──────────
function normalizeClean() {
  const r = patch.revert({ restoreFromBackup: false });
  return { r, text: fs.readFileSync(APP, 'utf8') };
}
const norm = normalizeClean();
if (norm.r?.ok === false) {
  console.error(`❌ 无法把演练根归一化到干净态（state=${norm.r?.state}）：${(norm.r.conflicts || []).map((c) => `${c.file} ${c.detail}`).join('; ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(2);
}
const clean = norm.text;
console.log(`干净基线：${clean.length} 字符${clean.includes('[[memory-vec:') ? ' ⚠️ 仍有 memory-vec 痕迹' : '，无 memory-vec 痕迹'}`);
ok(!clean.includes('[[memory-vec:'), '演练根已归一化到干净态（revert 生效）');
const murmurBefore = (clean.match(/\[\[murmur-graph:/g) || []).length;

// ── ① 缝缺失 + 启用 ⇒ 必须补上 ────────────────────────────────────────────
console.log('\n── ① 缝缺失 + 插件启用 ─────────────────────────────');
setEnabled(true);
const r1 = await runPreflight({ root: TMP });
console.log(`  → action=${r1.action} state=${r1.state} changed=[${r1.changed.join(', ')}]`);
ok(r1.action === 'applied', "action='applied'（不是 already / nothing）");
ok(r1.changed.includes('src/app.js'), 'changed 里点名了 src/app.js');
const after1 = fs.readFileSync(APP, 'utf8');
ok(after1.includes('[[memory-vec:routes]]'), 'routes 标记已写入');
ok(after1.includes('[[memory-vec:stop]]'), 'stop 标记已写入');
ok(after1.length > clean.length, '文件确实变长了（不是空操作）', `(${clean.length} → ${after1.length})`);

if (murmurBefore > 0) {
  const murmurAfter = (after1.match(/\[\[murmur-graph:/g) || []).length;
  ok(murmurBefore === murmurAfter, 'murmur 标记块数量未变（共存）', `(${murmurBefore} → ${murmurAfter})`);
} else {
  skipCheck('murmur 共存断言（真核心里没有 murmur 缝）', '来源 src/app.js 里没有 murmur-graph 标记块 ⇒ 该断言无从执行（**不算通过**）');
}

// ── ② 缝已在 ⇒ 空操作 ───────────────────────────────────────────────────
console.log('\n── ② 缝已在 ⇒ 空操作（幂等）───────────────────────');
const bytes1 = fs.readFileSync(APP);
const r2 = await runPreflight({ root: TMP });
console.log(`  → action=${r2.action} state=${r2.state} changed=[${r2.changed.join(', ')}]`);
ok(r2.action === 'already', "action='already'");
ok(r2.changed.length === 0, 'changed 为空');
ok(Buffer.compare(bytes1, fs.readFileSync(APP)) === 0, 'app.js 逐字节未变（幂等）');

// ── ③ 停用 ⇒ 一个字节都不许动 ────────────────────────────────────────────
// 先把 ① 打进演练根的缝摘掉，回到干净态 —— 否则"停用没写东西"会被上面那次写入掩盖。
console.log('\n── ③ 插件停用 ⇒ 不占缝 ────────────────────────────');
const back = normalizeClean();
ok(back.r?.ok !== false && !back.text.includes('[[memory-vec:'), '演练根已重新归一化到干净态（为 ③ 做准备）');
setEnabled(false);
const r3 = await runPreflight({ root: TMP });
console.log(`  → action=${r3.action}`);
const after3 = fs.readFileSync(APP, 'utf8');
ok(r3.action === 'disabled', "action='disabled'");
ok(!after3.includes('[[memory-vec:'), 'app.js 里没有 memory-vec 痕迹（停用不占缝）');
ok(after3 === clean, 'app.js 与干净基线逐字节一致');

// ── ④ 读不到宿主配置 ⇒ 不抛、非致命 ─────────────────────────────────────
console.log('\n── ④ 读不到宿主配置 ⇒ 非致命 ──────────────────────');
const BARE = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-preflight-bare-'));
copyInto(BARE, 'src/app.js');            // 有核心文件，但**没有** src/skills/config.js
const bareBefore = fs.readFileSync(path.join(BARE, 'src', 'app.js'));
const r4 = await runPreflight({ root: BARE });
console.log(`  → action=${r4.action} detail=${JSON.stringify(r4.detail.slice(0, 80))}`);
ok(r4.action === 'no-config', "action='no-config'（不抛）");
ok(Buffer.compare(bareBefore, fs.readFileSync(path.join(BARE, 'src', 'app.js'))) === 0, 'BARE 根的 app.js 未被改动');
fs.rmSync(BARE, { recursive: true, force: true });

// ── ⑤ CLI 契约：退出码 0 + 单行 + 全 ASCII ──────────────────────────────
console.log('\n── ⑤ CLI 契约（启动脚本调的那一层）───────────────');
setEnabled(true);
const cli = spawnSync(NODE, [PREFLIGHT_CLI], {
  encoding: 'utf8',
  env: { ...process.env, MEMORY_VEC_PATCH_ROOT: TMP, MEMORY_VEC_BACKUP_DIR: path.join(TMP, '__backup'), QQ_AGENT_DATA_DIR: DATA },
});
if (cli.error) {
  skipCheck('CLI 子进程（本环境起不了子进程）', `${cli.error.code || cli.error.message} —— 请在有权限起子进程的环境里重跑这一项`);
} else {
  const out = (cli.stdout || '') + (cli.stderr || '');
  console.log(`  stdout: ${JSON.stringify(out.trim())}`);
  ok(cli.status === 0, '退出码 0（非致命契约）', `(code=${cli.status})`);
  const lines = out.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  ok(lines.length === 1, 'stdout 恰好一行', `(实际 ${lines.length} 行)`);
  ok(/^[\x20-\x7E]*$/.test(out.replace(/[\r\n]/g, '')), 'stdout 全 ASCII（防启动日志乱码）');
  ok(/preflight:/.test(out), '带 [memory-vec] preflight: 前缀（启动日志里认得出是谁）');
}

// ── 收尾 ────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(64)}`);
console.log(`preflight：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过（环境做不到，已明说）` : ''}`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);
