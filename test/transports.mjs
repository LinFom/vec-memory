// transports.mjs —— 判据 1：**两种传输跑同一批用例，结果一致**
//
// 为什么这条能成立：inproc 与 http **用的是同一个 `handleMemoryVec`**（inproc 靠伪造
// req/res 驱动它）。所以这里不是在"验证两份实现对齐"，而是在**证明它们确实没分叉**
// —— 一旦有人给 http 那条路单独加逻辑，这条会红。
//
// 跑：node test/transports.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { start, PREFIX } from '../src/server.mjs';
import { ok, tally } from './lib/_helpers.mjs';


// 空库即可覆盖"路由通不通、错误码对不对"；不需要真实存档（那属于 edges/graph/realloop）。
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-tx-'));
fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });

// ── 易变字段：跨两次调用必然不同，不能参与比对 ───────────────────────────
// ⚠️ 这不是"把差异藏起来"——`uptimeMs`/`at` 本来就是**每次调用都变**的量。
//    剔它反而是对的：不剔的话这条用例会随机红，然后被人加 `|| true` 糊过去。
const VOLATILE = new Set(['uptimeMs', 'at', 'ms', 'elapsedMs', 'startedAt', 'loadedAt', 'ts', 'now', 'durationMs']);
function stable(v, key) {
  if (Array.isArray(v)) return v.map((x) => stable(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (VOLATILE.has(k)) { out[k] = '<volatile>'; continue; }
      out[k] = stable(v[k], k);
    }
    return out;
  }
  return v;
}
const shape = (body) => JSON.stringify(stable(body));

const CASES = [
  ['GET', '/status', null],
  ['GET', '/identity', null],
  ['GET', '/rank', null],
  ['GET', '/items?limit=3', null],
  ['GET', '/graph?k=6', null],
  ['POST', '/search', { q: '不存在的句子', k: 2 }],
  ['GET', '/nonexistent', null]
];

console.log('\n── ① 双传输一致性（inproc vs http，逐条比对）──');

const router = createRouter({ dataRoot });
const started = await start({ dataRoot, port: 0 });
const base = started.url;

let same = 0;
for (const [method, p, body] of CASES) {
  let a; let b;
  try {
    const r = await router.handle({ method, path: p, body });
    a = { status: r.status, shape: shape(r.body) };
  } catch (e) { a = { status: 'THROW', shape: e.message }; }
  try {
    const res = await fetch(base + PREFIX + p.replace(/^\//, ''), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    b = { status: res.status, shape: shape(await res.json()) };
  } catch (e) { b = { status: 'THROW', shape: e.message }; }

  const sameStatus = a.status === b.status;
  const sameBody = a.shape === b.shape;
  ok(sameStatus && sameBody, `${method} ${p}`, `inproc ${a.status} / http ${b.status}`);
  if (!(sameStatus && sameBody)) {
    console.log(`      inproc: ${a.shape.slice(0, 200)}`);
    console.log(`      http  : ${b.shape.slice(0, 200)}`);
  }
  if (sameStatus && sameBody) same++;
}

console.log('\n── ② CORS（面板直连的前提）──');

const rOk = await fetch(base + PREFIX + 'status', { headers: { origin: 'http://localhost:3210' } });
ok(rOk.headers.get('access-control-allow-origin') === 'http://localhost:3210',
  '回环来源被回显允许', rOk.headers.get('access-control-allow-origin') || '(无)');

const rFile = await fetch(base + PREFIX + 'status', { headers: { origin: 'null' } });
ok(rFile.headers.get('access-control-allow-origin') === 'null', 'Electron file:// 面板（Origin: null）允许');

const rEvil = await fetch(base + PREFIX + 'status', { headers: { origin: 'http://evil.example.com' } });
ok(!rEvil.headers.get('access-control-allow-origin'), '非回环来源**不发** CORS 头（但仍返回数据，鉴权靠"够不着"）',
  rEvil.headers.get('access-control-allow-origin') || '(无)');

const rPre = await fetch(base + PREFIX + 'search', {
  method: 'OPTIONS',
  headers: {
    origin: 'http://localhost:3210',
    'access-control-request-method': 'POST',
    // 面板**不能**沿用宿主 `api()` 那套请求头：宿主会给每个请求加 `x-console-token`，
    // 而本服务声明的允许列表只有 `content-type` ⇒ 带上它浏览器直接判定预检失败、请求发不出去。
    // 这条断言就是那个约束的钉子（`settings-ui.js` 的 `req()` 因此自己发 fetch，不走 ctx.api）。
    'access-control-request-headers': 'content-type, x-console-token'
  }
});
const preAllow = rPre.headers.get('access-control-allow-headers') || '';
ok(rPre.status === 204 && rPre.headers.get('access-control-allow-methods')?.includes('POST')
  && preAllow === 'content-type',
  '预检 OPTIONS 204、放行 POST，且 allow-headers **只**列 content-type（用不了 x-console-token）',
  `"${preAllow}"`);

console.log('\n── ③ 边界 ──');

const rHealth = await fetch(base + '/health');
const hHealth = await rHealth.json();
ok(rHealth.status === 200 && hHealth.service === 'vec-memory', '/health 存活探针');
ok(typeof hHealth.dataRoot === 'string' && path.resolve(hHealth.dataRoot) === path.resolve(dataRoot),
  '/health 回报运行期 dataRoot（双态启动器据此识别"点错副本"类静默失败）',
  hHealth.dataRoot);
// 判据的**形状本身**也是契约（2026-10-11 事故）：`/health` 的存活标志是它自己的 `status:'ok'`，
// 不是业务面 `/api/vec/*` 那个 `ok:true`（后者由 `router.mjs` 逐个手写）。面板的星图容器曾按
// `ok` 判存活，于是**服务完全健康、界面却报"服务回了错：未知错误"**（用户以为星图坏了）。
// 这条同时挡两个方向：① 别把 `/health` 的判据改成 `ok`；② 别"顺手"给 `/health` 补一个
// 与 `status` 重复的 `ok` —— 同一件事有两个字段，迟早会不一致。
ok(hHealth.status === 'ok' && !('ok' in hHealth),
  '/health 用 status:"ok" 作唯一存活标志（**不带**重复的 ok 字段；面板曾错读它）',
  `status=${hHealth.status}`);

const rOut = await fetch(base + '/api/other/thing');
ok(rOut.status === 404, '前缀外的路径 404（不误吞别的 API 面）');

const rBad = await fetch(base + PREFIX + 'search', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '这不是 JSON'
});
const badBody = await rBad.json();
// ⚠️ 登记（搬迁期**不修**，MIGRATION.md §0 原则 3）：
//    坏 JSON 体现在落到**通用出口** ⇒ **500**，而不是 400。
//    根因：`readJsonBody` 抛的 `Error` 没带 `code`，被 catch 归成 `INTERNAL`。
//    这条只钉"文案可读 + 确实是那条错误"，不把语义改成 400 —— 那是行为变更，得单独一批。
ok(rBad.status === 500 && /JSON/.test(badBody.error || ''),
  '坏 JSON 体 ⇒ 通用出口 + 文案可读（实为 500，见代码内登记）',
  `${rBad.status} / ${badBody.error || '(无文案)'}`);

// ── ④ 数据源必须显式（fail-closed） ──────────────────────────────────────
// 这条用**进程内**判据：createServer 不给 dataRoot 必须抛，而不是悄悄指向一个错目录。
const serverMod = await import('../src/server.mjs');
let threw = '';
try { serverMod.createServer({}); } catch (e) { threw = e.message; }
ok(/dataRoot/.test(threw), 'createServer 无 dataRoot ⇒ 抛（不猜数据在哪）', threw || '(没抛)');

// 默认绑定地址就是这条服务的安全边界 —— 它**没有认证**，只有"够不着"。
ok(serverMod.DEFAULT_HOST === '127.0.0.1',
  '默认绑定 127.0.0.1（"够不着"就是安全边界本身）', serverMod.DEFAULT_HOST);

// ── ⑥ 星图页归服务（`ADR-0013`）：静态页路由 + 两个本机端点 ────────────────
// 这条钉的是一个**架构决定**：星图是服务自带的页面，浏览器直开 8088 就该是完整的图，
// 不依赖 QQ-Agent。所以"根路径出不出页、MIME 对不对、穿越能不能挡住"都是契约的一部分。
{
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  };

  const index = await get('/');
  ok(index.status === 200 && /text\/html/.test(index.type), 'GET / 出星图页（服务自带页面）', `${index.status} ${index.type}`);
  ok(/关系星图/.test(index.text) && /starmap\.js/.test(index.text), '星图页引用了它自己的脚本');

  const js = await get('/starmap.js');
  ok(js.status === 200 && /javascript/.test(js.type), 'GET /starmap.js 的 MIME 是 JavaScript（否则模块加载会被浏览器直接拒）', js.type);
  const layout = await get('/starmap-layout.mjs');
  ok(layout.status === 200 && /javascript/.test(layout.type), '.mjs 也以 text/javascript 提供');
  const css = await get('/styles.css');
  ok(css.status === 200 && /text\/css/.test(css.type), '样式表可达');

  // 路径穿越：三层拦（只认扁平文件名 / 不含反斜杠 / 归一化后必须仍在 web 下）
  const t1 = await get('/../src/server.mjs');
  const t2 = await get('/%2e%2e%2fsrc%2fserver.mjs');
  const t3 = await get('/..%5Csrc%5Cserver.mjs');
  ok(t1.status === 404 && t2.status === 404 && t3.status === 404,
    '路径穿越被挡（不靠"请求看起来奇怪"，靠路由本身不认识）', `${t1.status}/${t2.status}/${t3.status}`);
  ok((await get('/nope.js')).status === 404, 'web/ 里没有的文件 ⇒ 404');
  ok((await get('/api/other')).status === 404, '静态路由**不接管** /api/*（前缀外的 API 面仍是 404）');

  // 备注（显示名）：读写 + 删除 + 拒绝非法键
  const n0 = await (await fetch(base + PREFIX + 'notes')).json();
  ok(n0.ok === true && typeof n0.notes === 'object', 'GET /notes 可达（空库 ⇒ 空表，不报错）');
  const post = (body) => fetch(base + PREFIX + 'notes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const w = await (await post({ key: '〔P1〕', text: '测试名' })).json();
  ok(w.ok === true && w.text === '测试名', 'POST /notes 写入成功');
  const n1 = await (await fetch(base + PREFIX + 'notes')).json();
  ok(n1.notes?.['〔P1〕']?.text === '测试名', '写进去的备注读得回来（落在本机文件里）');
  ok((await post({ key: '', text: 'x' })).status === 400, '空键 ⇒ 400（拒绝，而不是静默写一条无名备注）');
  const del = await (await post({ key: '〔P1〕', text: '' })).json();
  ok(del.ok === true && del.removed === true, '空文本 = 删除该备注（备注是"改名"，不是"记流水"）');
  ok(Object.keys((await (await fetch(base + PREFIX + 'notes')).json()).notes || {}).length === 0, '删干净了');

  // 真名映射：只回显示名，**不回实体 id**（`qq:…` 就是明文号码）
  const names = await (await fetch(base + PREFIX + 'identity/names')).json();
  ok(names.ok === true && typeof names.names === 'object', 'GET /identity/names 可达', `(${names.count ?? 0} 个名字)`);
  ok(JSON.stringify(names).indexOf('"qq:') < 0, '名字映射**不含实体 id**（明文号码不许从这条路出去）');
}

// ── ⑤ 设置注入：服务必须真的从宿主 config.json 读到 skill 配置 ──────────────
// 这条防的是一个**静默失效**：不注入 settings 时 core 会落到 `{...DEFAULT_SETTINGS}`，
// 于是"面板里存的嵌入端点 / 模型 / topK 全都不生效" —— 而服务照常 200、界面照常显示，
// 只有一个症状"改了设置没反应"，且它不会指向真正的原因。
const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-cfg-'));
fs.mkdirSync(path.join(cfgRoot, 'memory-v2', 'chunks'), { recursive: true });
fs.writeFileSync(path.join(cfgRoot, 'config.json'), JSON.stringify({
  skills: { 'memory-vec': { embedModel: 'cfg-test-model', topK: 7 } }
}), 'utf8');

const merged = serverMod.readSkillConfig(cfgRoot, 'memory-vec', { embedModel: 'DEFAULT', topK: 5, keptDefault: true });
ok(merged.embedModel === 'cfg-test-model' && merged.topK === 7 && merged.keptDefault === true,
  'readSkillConfig 按宿主口径浅合并（盘上显式值覆盖，未提到的保留默认）', JSON.stringify(merged));
ok(serverMod.readSkillConfig(path.join(cfgRoot, 'no-such'), 'memory-vec', { a: 1 }).a === 1,
  '配置读不到 ⇒ 退回默认且**不抛**（服务不因配置缺失拒绝回答）');

const s2 = await start({ dataRoot: cfgRoot, port: 0 });
try {
  // ① config 注入：`store.dir` 由 `DATA_DIR` 拼出来 ⇒ 能看出服务用的是哪个数据根
  const st2 = await (await fetch(s2.url + PREFIX + 'status')).json();
  ok(String(st2?.store?.dir || '').replace(/\\/g, '/').endsWith('/memory-vec'),
    '服务的数据根来自注入的 DATA_DIR', String(st2?.store?.dir || '(无)'));

  // ② settings 注入：直接问注入点，看 core 拿到的是**读盘实现**还是 null。
  //    ⚠️ 这里**不用** `/status` 的 `store.model` 当判据 —— 那是**索引文件里记的模型**
  //       （空库时是 null），和"设置里写的模型"是两件事。第一版就是这么写错的：
  //       它红了，但红的原因不是"注入没发生"，而是断言找错了字段。
  const h = await import('../src/core/host.mjs');
  const probe = h.hostSettings()?.getSkillConfig?.('memory-vec', { embedModel: 'DEFAULT' });
  ok(probe?.embedModel === 'cfg-test-model',
    'core 拿到的是读盘实现（不注入 ⇒ 设置静默全默认，且不报错）', JSON.stringify(probe));
} finally {
  await new Promise((r) => s2.server.close(r));
  try { fs.rmSync(cfgRoot, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

await new Promise((r) => started.server.close(r));
fs.rmSync(dataRoot, { recursive: true, force: true });

console.log(`\n════════════════════════════════════════════════════════════════`);
console.log(`双传输一致性：${tally.pass} 通过 / ${tally.fail} 失败  （逐条一致 ${same}/${CASES.length}）`);
console.log(`════════════════════════════════════════════════════════════════`);
process.exitCode = tally.fail ? 1 : 0;
