// 补丁演练 —— 在临时目录里对**真实核心文件**跑一遍完整的 打→验→摘→比。
//
// 这份脚本存在的理由：补丁是这套插件里唯一"会改别人文件"的部分，也是最容易
// 变成事故的部分。设计手册的测试清单第 1、2 条就是它：
//   1. 演练：把真实 src/ 拷进临时目录，在演练根上 apply —— 必须一次成功、
//      node --check 全部落点文件通过；
//   2. 可逆：同一演练根跑 remove，再与真实文件逐字节比对 —— 必须完全一致。
//
// 特别地，真实仓库里的 src/app.js **已经带着 murmur 的标记块**（整合版默认启用）。
// 所以这份演练同时验证了"我的块与别人的块能不能共存"—— 这正是最容易翻车的地方。
//
// 运行：
//   node test/dryrun.mjs "E:/Tools/QQ-Agent-整合版-20260922"
//   node test/dryrun.mjs             # 部署进 plugins/ 之后可以省掉参数
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`); }
}
/** 环境做不到的检查：**明说**，既不冒充通过，也不冤枉成失败。 */
function skipCheck(label, why) {
  skip++;
  console.log(`  ⚠️ 跳过：${label} —— ${why}`);
}

const ROOT = path.resolve(process.argv[2] || process.env.QQ_AGENT_ROOT || path.resolve(PLUGIN_DIR, '..', '..'));
const REL_TARGETS = ['src/app.js'];

console.log(`\n演练根（真实宿主）：${ROOT}`);
if (!fs.existsSync(path.join(ROOT, 'src', 'app.js'))) {
  console.error(`❌ 找不到 ${path.join(ROOT, 'src', 'app.js')}`);
  console.error('   用法：node test/dryrun.mjs "<QQ-Agent 根目录>"');
  process.exit(2);
}

// ── 1. 把真实文件拷进临时根 ──────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dryrun-'));
console.log(`临时演练根：${TMP}\n`);

for (const rel of REL_TARGETS) {
  const src = path.join(ROOT, rel);
  const dst = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
const appJsPath = path.join(TMP, 'src', 'app.js');

// ── 2. 指向演练根，并把它归一化到**干净态** ──────────────────────────────
// 必须在 import patch.mjs **之前**设环境变量：DEFAULT_ROOT 是在模块顶层求值的。
process.env.MEMORY_VEC_PATCH_ROOT = TMP;
process.env.MEMORY_VEC_BACKUP_DIR = path.join(TMP, '__backup');
const patch = await import('../patch.mjs');

// ⚠️ 演练源（真实宿主）**可能本来就带着缝** —— 只要插件在宿主里被启用过一次，缝就打上了
//    （2026-10-08 实测撞到）。那时"原件"并不是干净核心：apply 成空操作，而最后的 revert
//    会把**演练源自带的缝**一并摘掉 ⇒ 逐字节比对必然不等（原始 175395B → 172744B），
//    红在一个与本次改动无关的地方。所以先摘一次建立**干净基线**，再拿它比对 ——
//    这条断言证的仍然是"打一次 + 摘一次，回到出发时的样子"，而不是"宿主此刻恰好没打过缝"。
const pre = patch.revert();
if (pre?.ok === false) {
  console.error(`❌ 无法把演练源归一化到干净态（state=${pre?.state}）：${(pre.conflicts || []).map((c) => `${c.file} ${c.detail}`).join('; ')}`);
  process.exit(2);
}
if ((pre?.changed || []).length) {
  console.log(`（演练源自带缝，已先摘除作为干净基线：${pre.changed.join(', ')}）`);
}

const originals = new Map();
for (const rel of REL_TARGETS) originals.set(rel, fs.readFileSync(path.join(TMP, rel)));
const before = fs.readFileSync(appJsPath, 'utf8');
const hadMurmur = before.includes('[[murmur-graph:');
console.log(`真实 app.js：${before.length} 字符，${before.split('\n').length} 行${hadMurmur ? '，**已含 murmur 标记块**' : ''}\n`);

function syntaxCheck(file) {
  const r = spawnSync(NODE, ['--check', file], { encoding: 'utf8' });
  // 子进程起不来（沙箱/杀软/EBUSY）与"语法错"是两件事，必须分开报 ——
  // 混成一个 ❌ 会让人去查根本不存在的语法问题（本项目猎的就是这类"失效不报错"）。
  if (r.error) return { ok: false, unavailable: true, err: `无法启动子进程：${r.error.code || r.error.message}` };
  return { ok: r.status === 0, err: (r.stderr || '').trim().split('\n').slice(0, 4).join('\n') };
}

console.log('── 打缝 ─────────────────────────────────────────────');
let applyResult = null;
try {
  applyResult = patch.apply();
  console.log(`  apply 返回：state=${applyResult?.state} ok=${applyResult?.ok} changed=[${(applyResult?.changed || []).join(', ')}]`);
  if (applyResult?.conflicts?.length) {
    for (const c of applyResult.conflicts) console.log(`    conflict: ${c.file} — ${c.detail}`);
  }
  if (applyResult?.problems?.length) {
    for (const p of applyResult.problems) console.log(`    problem: ${typeof p === 'string' ? p : JSON.stringify(p)}`);
  }
} catch (err) {
  console.error(`  apply 抛错：${err?.message ?? err}`);
}

ok(applyResult && applyResult.ok !== false, 'apply 一次成功（不报 conflict）');
const after = fs.readFileSync(appJsPath, 'utf8');
ok(after.includes('[[memory-vec:routes]]'), 'routes 标记已写入');
ok(after.includes('[[memory-vec:stop]]'), 'stop 标记已写入');
ok(after.includes('[[/memory-vec:routes]]') && after.includes('[[/memory-vec:stop]]'), '两个块的闭合标记都在');

// 关键：别人的块必须还在。
// ⚠️ 演练源里**没有** murmur 缝时，这两条断言无从执行 —— 必须**显式跳过**，不许静默不跑：
//    静默不跑在计数里和"通过"长得一模一样（2026-10-08 实测：宿主 src/app.js 里的 murmur
//    缝后来不见了，这两条就悄悄消失，结果照样"全绿"，只有把跳过说出来才看得见）。
if (hadMurmur) {
  const murmurBefore = (before.match(/\[\[murmur-graph:/g) || []).length;
  const murmurAfter = (after.match(/\[\[murmur-graph:/g) || []).length;
  ok(murmurBefore === murmurAfter, 'murmur 的标记块数量未变（共存）', `(${murmurBefore} → ${murmurAfter})`);
  ok(after.includes('[[murmur-graph:routes]]'), 'murmur 的 routes 块仍在原位');
} else {
  skipCheck('murmur 共存断言（演练源里没有 murmur 缝）',
    '演练源 src/app.js 里没有 murmur-graph 标记块 → 共存断言无从执行（**不算通过**）');
}

// 幂等
console.log('\n── 幂等（再 apply 一次）───────────────────────────');
const second = patch.apply();
ok((second?.changed || []).length === 0, '再次 apply 是空操作（changed 为空）', `(changed=[${(second?.changed || []).join(', ')}])`);
const after2 = fs.readFileSync(appJsPath, 'utf8');
ok(after2 === after, '文件内容与首次 apply 后完全一致');

// 语法体检
console.log('\n── 语法体检 ───────────────────────────────────────');
const sc = syntaxCheck(appJsPath);
if (sc.unavailable) {
  skipCheck('node --check（落点文件语法正确）', `${sc.err} —— 请在有权限起子进程的环境里重跑这一项`);
} else {
  ok(sc.ok, 'node --check 通过（落点文件语法正确）', sc.ok ? '' : `\n${sc.err}`);
}

// ── 3. remove 并逐字节比对 ──────────────────────────────────────────────
console.log('\n── 摘缝 ─────────────────────────────────────────────');
let removeResult = null;
try {
  // 引擎的摘除函数叫 revert（CLI 里 apply|remove|status 的 remove 走它）。
  // 默认 restoreFromBackup=true：拿备份整文件还原 —— 这正是"可卸载"要验证的路径。
  removeResult = patch.revert();
  console.log(`  revert 返回：state=${removeResult?.state} ok=${removeResult?.ok} changed=[${(removeResult?.changed || []).join(', ')}]`);
} catch (err) {
  console.error(`  revert 抛错：${err?.message ?? err}`);
}
const restored = fs.readFileSync(appJsPath);
for (const rel of REL_TARGETS) {
  const orig = originals.get(rel);
  const now = rel === 'src/app.js' ? restored : fs.readFileSync(path.join(TMP, rel));
  ok(Buffer.compare(orig, now) === 0, `${rel} 摘缝后与原始逐字节一致（可卸载的硬证据）`,
    Buffer.compare(orig, now) === 0 ? '' : `(原始 ${orig.length}B → 现在 ${now.length}B)`);
}
const reverted = fs.readFileSync(appJsPath, 'utf8');
ok(!reverted.includes('memory-vec:'), '文件里不再有任何 memory-vec 痕迹');

// status 复查
console.log('\n── status 复查 ────────────────────────────────────');
const st = patch.status();
console.log(`  ${JSON.stringify(st, null, 0).slice(0, 300)}`);

// ── 4. 收尾 ─────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(64)}`);
console.log(`演练结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过（环境做不到，已明说）` : ''}`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);
