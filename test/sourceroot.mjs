// sourceroot.mjs —— 0.9.3 外接模式：**库根**（dataRoot，服务自持）与**源根**（sourceRoot，
// 指回宿主 data，只读）分离。
//
// 为什么要有这条测试：外接模式下服务从仓里跑，库数据归仓；索引源（memory-v2/chunks、
// 存档、身份）仍在宿主 data。分离配错的表现是"库在仓里、索引却在扫仓里不存在的宿主
// 文件" ⇒ 静默空索引——**不报错**，正是本项目一直在消灭的那类故障。
// 判据一律问**运行期事实**（/health 回报 + /status 实际扫到了什么），不问"配置写了什么"。
//
// 跑：node test/sourceroot.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSourceRoot, start, PREFIX } from '../src/server.mjs';
import { getRuntime, disposeMemoryVec } from '../src/core/backend.mjs';
import { ok, tally } from './lib/_helpers.mjs';


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-src-'));
const libRoot = path.join(tmp, 'lib');          // 库根：只有 config.json（配 sourceRoot）
const srcRoot = path.join(tmp, 'host-data');    // 源根：模拟宿主 data，放一个 chunk
fs.mkdirSync(libRoot, { recursive: true });
fs.mkdirSync(path.join(srcRoot, 'memory-v2', 'chunks'), { recursive: true });
fs.writeFileSync(path.join(libRoot, 'config.json'),
  JSON.stringify({ skills: { 'memory-vec': { sourceRoot: srcRoot } } }), 'utf8');
// 文件名必须匹配 parseChunkFileName 的 hour|day|ep 模式，否则 listChunks 不认
fs.writeFileSync(path.join(srcRoot, 'memory-v2', 'chunks', 'hour_group_10000_2026-01-0100.json'),
  JSON.stringify({ id: 'hour_group_10000_2026-01-0100', chatKey: 'group:10000', title: 't', summary: 's' }), 'utf8');

console.log('\n── ① resolveSourceRoot：优先级 参数 > 配置 > 同根 ──');
ok(resolveSourceRoot(libRoot, srcRoot) === path.resolve(srcRoot),
  '显式参数最高优先');
ok(resolveSourceRoot(libRoot) === path.resolve(srcRoot),
  '没给参数 ⇒ 从 <dataRoot>/config.json 的 skills.memory-vec.sourceRoot 读');
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-src-bare-'));
ok(resolveSourceRoot(bare) === path.resolve(bare),
  '没配 sourceRoot ⇒ 与库根同根（兼容旧部署，不抛）');
const badCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-src-bad-'));
fs.writeFileSync(path.join(badCfg, 'config.json'), '{ 坏掉的 JSON', 'utf8');
ok(resolveSourceRoot(badCfg) === path.resolve(badCfg),
  'config.json 读不了 ⇒ 退回同根且**不抛**（与 readSkillConfig 同口径）');

console.log('\n── ② 运行期事实：/health 两个根都对 ──');
const s = await start({ dataRoot: libRoot, port: 0 });
try {
  const h = await (await fetch(s.url + '/health')).json();
  ok(path.resolve(h.dataRoot) === path.resolve(libRoot),
    '/health 回报库根 dataRoot', h.dataRoot);
  ok(path.resolve(h.sourceRoot) === path.resolve(srcRoot),
    '/health 回报源根 sourceRoot（外接模式第二事实）', h.sourceRoot);

  console.log('\n── ③ 行为证明：索引真的扫源根、库真的在库根 ──');
  // 库根里**没有** memory-v2/chunks，源根里有 1 个 ⇒ chunkCount=1 只能来自源根。
  const st = await (await fetch(s.url + PREFIX + 'status')).json();
  ok(st.core?.chunkCount === 1 && st.core?.chunksDir === path.join(srcRoot, 'memory-v2', 'chunks'),
    '/status 的索引源来自 sourceRoot（库根无 chunks 却扫到了）',
    `chunkCount=${st.core?.chunkCount}`);
  ok(st.embedded === 0,
    '库（向量）仍在库根一侧：新库根下 embedded=0，没有被源根数据污染');
} finally {
  await new Promise(resolve => s.server.close(resolve));
  const runtime = await getRuntime();
  const deadline = Date.now() + 8000;
  while (!runtime.__groupNamesWarm && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  disposeMemoryVec();
  for (const dir of [tmp, bare, badCfg]) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('vmm-src-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(resolved, {recursive:true,force:true});
  }
}

console.log(`\n# sourceroot: ${tally.pass} pass / ${tally.fail} fail`);
// Let pending Windows/undici handles close naturally after the server shutdown.
process.exitCode = tally.fail ? 1 : 0;
