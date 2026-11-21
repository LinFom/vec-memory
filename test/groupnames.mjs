// groupnames.mjs —— 星系标签的群名：**纯函数判据 + 假宿主端到端**。
//
// ── 为什么两种都测 ────────────────────────────────────────────────────────
// · 纯函数部分（归一化 / 派生 / 缓存）错在哪，只有形状层面能看清；
// · 「服务去问宿主要群名」是一条**跨进程**的路 —— 上一轮刚吃过
//   "静态图 + 单测全绿，而形状被猜错"的亏（适配层 0.9.9 的 `/health`）。
//   所以这里起一个**真 HTTP 服务**冒充宿主，让服务真的去 fetch 它，
//   断言 `/identity/names` 的真响应里有群名。
//
// 跑：node test/groupnames.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import {
  hostApiBase, normalizeGroupList, fetchGroupList, groupScopeNames,
  readGroupNameCache, writeGroupNameCache, refreshGroupNames, groupNamesFor,
  HOST_API_PORT_FALLBACK, GROUP_NAMES_FILE
} from '../src/core/groupnames.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-gn-'));

/** 起一个"假宿主"：只回 /api/onebot/groups。 */
function fakeHost(handler) {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/onebot/groups')) return handler(req, res);
    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } });
  }));
}
const jsonReply = (payload, status = 200) => (_q, res) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
};

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── ① hostApiBase：设置项 > 宿主 config.json 的 server.port > 兜底 ──');
{
  const root = path.join(tmp, 'host-cfg');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { port: 4321 } }), 'utf8');
  ok(hostApiBase(root).base === 'http://127.0.0.1:4321' && hostApiBase(root).source === 'host-config',
    '没配置设置项 ⇒ 从宿主 config.json 的 server.port 推（这就是"留空=自动"）', hostApiBase(root).base);
  ok(hostApiBase(root, { groupNamesBaseURL: ' http://127.0.0.1:9999/ ' }).base === 'http://127.0.0.1:9999',
    '设置项优先，且去掉尾斜杠与空白（否则拼出来的 URL 会多一层 //）');
  ok(hostApiBase(root, { groupNamesBaseURL: 'http://127.0.0.1:9999' }).source === 'setting',
    '来源标签是 setting（界面上要说清名字是哪来的）');
  const bare = path.join(tmp, 'no-cfg');
  fs.mkdirSync(bare, { recursive: true });
  ok(hostApiBase(bare).base === `http://127.0.0.1:${HOST_API_PORT_FALLBACK}` && hostApiBase(bare).source === 'default',
    'config.json 读不到 ⇒ 兜底端口且**不抛**（与 readSkillConfig / resolveSourceRoot 同口径）');
  const bad = path.join(tmp, 'bad-cfg');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'config.json'), '{ 坏 JSON', 'utf8');
  ok(hostApiBase(bad).source === 'default', '坏 JSON ⇒ 也算读不到，不抛');
}

console.log('\n── ② normalizeGroupList：容三种形状（协议端实现之间不一致）──');
{
  ok(normalizeGroupList([{ id: '1', name: 'A' }]).length === 1, '裸数组');
  ok(normalizeGroupList({ groups: [{ id: '1', name: 'A' }] }).length === 1, '`{groups:[…]}`（宿主自己的形状）');
  ok(normalizeGroupList({ data: [{ group_id: '1', group_name: 'A' }] }).length === 1, '`{data:[…]}` + `group_id/group_name`（OneBot 原生）');
  ok(normalizeGroupList({ nope: 1 }).length === 0, '不认识的形状 ⇒ 空表，不抛');
  ok(normalizeGroupList([{ name: '没有 id' }, { id: '' , name: 'id 是空串' }]).length === 0,
    '没有 id 的条目直接丢（留下只会生成一个键不对的映射）');
  const mixed = normalizeGroupList([{ id: '1', name: '  A  ' }, { id: '2' }]);
  ok(mixed[0].name === 'A', '名字去空白');
  ok(mixed[1].name === '', '名字缺失 ⇒ 空串（**空名不写进映射**，让它退回占位符）');
}

console.log('\n── ③ groupScopeNames：键必须是**占位符**，不是群号 ──');
{
  let threw = false;
  try { groupScopeNames([{ id: '123', name: 'X' }], null); } catch { threw = true; }
  ok(threw, '缺 scopeLabel ⇒ **抛**（退回明文键 = 静默重开泄密通道）');

  const seen = [];
  const names = groupScopeNames([{ id: '123456', name: '扒手总部' }, { id: '999', name: '' }], (k) => {
    seen.push(k); return 'group:C7';
  });
  ok(Object.keys(names).length === 1 && names['group:C7'] === '扒手总部',
    '群名按占位符键落表，空名不进表', JSON.stringify(names));
  ok(seen[0] === 'group:123456', 'scopeLabel 拿到的是 `group:<群号>`（与 edges 的会话键同形）');
  ok(!JSON.stringify(names).includes('123456'), '表里**不含**明文群号');
}

console.log('\n── ④ 缓存：原子写 + 读回 + 坏文件不抛 ──');
{
  const dir = path.join(tmp, 'cache');
  ok(writeGroupNameCache(dir, { at: 123, base: 'http://x', source: 'setting', names: { 'group:C1': '甲' } }).ok,
    '写缓存成功（目录不存在会自己建）');
  const r = readGroupNameCache(dir);
  ok(r.ok && r.at === 123 && r.names['group:C1'] === '甲', '读回一致', JSON.stringify(r.names));
  ok(fs.existsSync(path.join(dir, GROUP_NAMES_FILE)), `文件名就是 ${GROUP_NAMES_FILE}`);
  ok(!fs.existsSync(path.join(dir, `${GROUP_NAMES_FILE}.tmp`)), '临时文件已 rename 掉（不留半截）');
  const r2 = readGroupNameCache(path.join(tmp, 'never'));
  ok(r2.ok === false && Object.keys(r2.names).length === 0 && typeof r2.error === 'string',
    '没缓存 ⇒ ok:false + **带原因**（不许把"没拉过"说成"群没名字"）');
}

console.log('\n── ⑤ fetchGroupList：真 HTTP（成 / 非 200 / 超时）──');
{
  const host = await fakeHost(jsonReply({ groups: [{ id: '5', name: '机器人测试群' }] }));
  const r = await fetchGroupList(host.base, { timeoutMs: 2000 });
  ok(r.ok && r.groups.length === 1 && r.groups[0].name === '机器人测试群', '拿到群列表', JSON.stringify(r.groups));
  host.close();

  const bad = await fakeHost(jsonReply({ error: 'onebot 没连' }, 502));
  const r2 = await fetchGroupList(bad.base, { timeoutMs: 2000 });
  ok(r2.ok === false && /502/.test(r2.error), '宿主回 502 ⇒ ok:false 且**真因里带状态码**', r2.error);
  bad.close();

  // 超时路径：连上但不回 —— 宿主"开着却没连协议端"时就是这条（不靠它只能干等）。
  const hang = await new Promise((resolve) => {
    const srv = http.createServer(() => { /* 故意不回 */ });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
  const t0 = Date.now();
  const r3 = await fetchGroupList(hang.base, { timeoutMs: 400 });
  const dt = Date.now() - t0;
  ok(r3.ok === false && /没回应/.test(r3.error), '不回应 ⇒ 超时收口，真因写"没回应"', `${r3.error} (${dt}ms)`);
  ok(dt < 3000, '而且真的在超时时间附近返回（不是无限挂）', `${dt}ms`);
  hang.srv.closeAllConnections?.();
  hang.srv.close();

  // 端口没人听：连接被拒（立刻回，不是超时）
  const deadPort = await new Promise((resolve) => {
    const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const r4 = await fetchGroupList(`http://127.0.0.1:${deadPort}`, { timeoutMs: 1500 });
  ok(r4.ok === false && /连不上宿主/.test(r4.error), '宿主没开 ⇒ 连接被拒也收成同一句话（可展示）', r4.error);
}

console.log('\n── ⑥ refreshGroupNames：拉不到**不覆盖**旧缓存 ──');
{
  const libDir = path.join(tmp, 'lib-notouch');
  writeGroupNameCache(libDir, { at: 777, base: 'http://old', source: 'setting', names: { 'group:C9': '旧名' } });
  const deadPort = await new Promise((resolve) => {
    const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const r = await refreshGroupNames({
    libDir, sourceRoot: tmp, settings: { groupNamesBaseURL: `http://127.0.0.1:${deadPort}` },
    scopeLabel: () => 'group:C9', timeoutMs: 800
  });
  ok(r.ok === false && typeof r.error === 'string', '失败回报 ok:false + error', r.error);
  ok(readGroupNameCache(libDir).at === 777 && readGroupNameCache(libDir).names['group:C9'] === '旧名',
    '旧缓存**原样保留**（宿主重启一次不该把整套群名擦掉）');
}

console.log('\n── ⑦ 端到端：真服务 + 假宿主 ⇒ /identity/names 里出群名 ──');
{
  const root = path.join(tmp, 'e2e');
  fs.mkdirSync(path.join(root, 'memory', 'people'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'people', 'a.json'), JSON.stringify({ userId: '111', name: '小鲸鱼' }), 'utf8');

  const host = await fakeHost(jsonReply({
    groups: [{ id: '1098345913', name: '！？大肥鱼？！' }, { id: '711432247', name: '扒手总部' }]
  }));
  const router = createRouter({
    dataRoot: root,
    settings: { getSkillConfig: (id, defaults) => ({ ...defaults, groupNamesBaseURL: host.base }) }
  });
  const names = (await router.handle({ method: 'GET', path: '/identity/names' })).body;

  const vals = Object.values(names.names).map((x) => x.display);
  ok(names.ok === true, '/identity/names 正常');
  ok(vals.includes('！？大肥鱼？！') && vals.includes('扒手总部'),
    '两个群名都进了 names（星图靠它渲染星系标签）', JSON.stringify(vals));
  ok(Object.values(names.names).some((x) => x.kind === 'group'), '群条目的 kind 是 group（页面可据此区分）');
  ok(names.groups?.count === 2 && names.groups?.error === null && names.groups?.source === 'setting',
    '同时回传诊断：取到几个 / 从哪来 / 有没有错', JSON.stringify(names.groups));
  ok(!Object.keys(names.names).includes('group:1098345913'),
    '**不带明文群号当键**（键是占位符）');

  // 缓存落在**库根**（`dataDir()` = <DATA_DIR>/memory-vec），与 notes.json 同级。
  const cachePath = path.join(root, 'memory-vec', GROUP_NAMES_FILE);
  const cacheTxt = fs.readFileSync(cachePath, 'utf8');
  ok(!cacheTxt.includes('1098345913'), '缓存文件里也**不含明文群号**（可安全导出）', cacheTxt.slice(0, 70));

  // 强制刷新端点
  const rr = await router.handle({ method: 'POST', path: '/identity/groupnames/refresh' });
  ok(rr.status === 200 && rr.body.ok === true && rr.body.count === 2, '强制刷新端点可用', JSON.stringify(rr.body));

  // 宿主关掉之后：**仍 200**，名字来自缓存（临时重启不该把整套群名擦掉）
  host.close();
  const rr2 = await router.handle({ method: 'POST', path: '/identity/groupnames/refresh' });
  ok(rr2.status === 502 && rr2.body.ok === false && typeof rr2.body.error === 'string',
    '宿主没了 ⇒ 强制刷新如实报 502 + 真因', rr2.body.error);
  const after = (await router.handle({ method: 'GET', path: '/identity/names' })).body;
  ok(after.ok === true && Object.values(after.names).map((x) => x.display).includes('扒手总部'),
    '同一时刻的名字仍来自**缓存**（拉不到不覆盖旧值）', JSON.stringify(after.groups));
}

console.log('\n── ⑧ 降级：一次都没拉到 ⇒ 退回占位符，但**必须带原因** ──');
{
  // 这一节直接测 `groupNamesFor` 的契约，不走路由：**一个进程只有一个 runtime**
  // （`getRuntime` 是单例，`rt.dir` 绑第一个数据根）—— 再建一个 router 只是换设置，
  // 换不掉库根，那样测出来的是上一节的缓存（实测踩过：第七节的缓存被当成本节的结果）。
  const libDir = path.join(tmp, 'lib-dead');
  const deadPort = await new Promise((resolve) => {
    const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rt = {
    dir: libDir,
    settings: { groupNamesBaseURL: `http://127.0.0.1:${deadPort}` },
    normalizer: { scopeLabel: (k) => `group:C${k.length}` }
  };
  const gn = await groupNamesFor(rt, { sourceRoot: tmp, firstTimeoutMs: 800 });
  ok(Object.keys(gn.names).length === 0, '拉不到且没缓存 ⇒ 名字表为空（星系退回代号）');
  ok(typeof gn.error === 'string' && gn.error.length > 0,
    '而且**带真因** —— 不许把"拉不到"说成"群本来就没名字"', gn.error);
  ok(gn.stale === false, '首次那条路是**等**结果（不是"先给旧的、后台再刷"）—— 否则第一眼永远是代号');

  const host2 = await fakeHost(jsonReply({ groups: [{ id: '7', name: '扒手总部' }] }));
  const rt2 = { dir: path.join(tmp, 'lib-dead2'), settings: { groupNamesBaseURL: host2.base }, normalizer: { scopeLabel: () => 'group:C1' } };
  const g2 = await groupNamesFor(rt2, { sourceRoot: tmp });
  ok(Object.keys(g2.names).length === 1 && g2.error === null, '同一个函数的成路径也过一遍（不是只测失败）', JSON.stringify(g2.names));
  host2.close();

  const rt3 = { dir: libDir, settings: { groupNamesBaseURL: host2.base }, normalizer: { scopeLabel: () => 'group:C1' } };
  await groupNamesFor(rt3, { sourceRoot: tmp });   // 失败一次，制造 last.error
  ok(readGroupNameCache(libDir).ok === false, '失败**不落**缓存文件（不污染下一轮判断）');
}

console.log(`\n# groupnames: ${tally.pass} pass / ${tally.fail} fail`);
process.exit(tally.fail ? 1 : 0);
