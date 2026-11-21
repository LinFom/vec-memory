// 面板结构检查 —— 把 settings-ui.js 的 render() 真跑一遍，验产出的 HTML 结构完整。
//
// 为什么需要它：面板是整个插件里唯一"没有测试也没法在 node 里渲染"的部分。
// 而它恰恰是用户唯一直接看到的东西 —— 少一个闭合标签就会让整个设置页崩掉，
// 而且崩的时候控制台只报一句"插件设置页加载失败"，看不出是哪一行。
//
// 这里不引入 DOM：render(ctx) 是纯函数（只读 ctx.config()），所以能直接跑。
// 检查的是**结构**：标签配对、字段齐全、没有漏替换的模板占位、配置值真的注入了。
//
// 运行：node test/panelcheck.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`); }
};

// settings-ui.js 是给浏览器用的 ESM，但扩展名是 .js —— 在 node 里直接 import 会被
// 当成 CJS。拷成 .mjs 再 import，是这里最省事且零侵入的办法。
const src = fs.readFileSync(path.join(PLUGIN_DIR, 'settings-ui.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `mv-panel-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(tmp, src, 'utf8');
const mod = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

console.log('\n── 导出契约 ───────────────────────────────────────');
ok(typeof mod.render === 'function', '导出 render(ctx)');
ok(typeof mod.bind === 'function', '导出 bind(root, ctx)');
ok(typeof mod.healthVerdict === 'function', '导出 healthVerdict(判据唯一产地，可离线对拍)');

// ── 0. 存活判据：`/health` 的形状（2026-10-11 事故的钉子）──────────────────
// 事故经过：面板曾用 `if (!health?.ok)` 判存活，而 `/health` 回的是
// `{status:'ok', dataRoot, sourceRoot}` —— **没有 ok 字段**。结果服务完全健康，
// 界面却显示"服务回了错：未知错误"，用户以为星图坏了（其实一行代码的事）。
// 这一节就是把"两套响应约定都要认、且失败必须说人话"钉死：任何一条退回旧写法都会红。
console.log('\n── 存活判据（/health）──────────────────────────────');
const hv = mod.healthVerdict;
{
  // 真服务的形状（现场实测的两个根）：**没有 ok 字段也必须判活**
  const real = { status: 'ok', service: 'vec-memory', dataRoot: 'E:\\WorkSpace\\vec-memory\\data', sourceRoot: 'E:\\Tools\\QQ-Agent-整合版-20260922\\data' };
  const v = hv(real);
  ok(!('ok' in real), '前提：真 `/health` 响应里**确实没有** ok 字段（事故的客观条件）');
  ok(v.alive === true && v.offline === false, '`status:"ok"` ⇒ 判活（**这就是 2026-10-11 误报的那条**）');
  ok(v.detail.includes('库根') && v.detail.includes('vec-memory'), '判活时带出运行期事实（这个实例对着哪个库根）', v.detail);

  // 业务面语义也认（将来 `/health` 补 ok 也不会翻车）
  ok(hv({ ok: true }).alive === true, '`ok:true`（业务面语义）也判活');
  ok(hv({ status: 'ok' }).alive === true && hv({ status: 'ok' }).detail === '',
    '没有 dataRoot 时 detail 为空串（不让界面渲染出"库根 undefined"）');

  // 三种"不活"必须各说各话，且都不许是"未知错误"
  const dead = { ok: false, error: 'boom', __http: 500 };
  const vd = hv(dead);
  ok(vd.alive === false && vd.offline === false && vd.detail.includes('500'),
    'HTTP 层失败 ⇒ 不活、不算离线、detail 带状态码', vd.detail);
  const vo = hv({ ok: false, error: 'fetch failed', __offline: true });
  ok(vo.alive === false && vo.offline === true, '传输层失败 ⇒ 不活且标 offline（界面据此给"去启动服务"的出路）');
  const vs = hv({ hello: 'world' });
  ok(vs.alive === false && vs.offline === false && vs.detail.length > 0,
    '答了话但不是它该答的 ⇒ 不活，**且必须给出可行动的依据**', vs.detail);
  ok([vd, vo, vs].every((x) => x.detail && !/未知错误/.test(x.detail)),
    '判据里不存在"未知错误"这种没信息量的兜底（旧文案就是它）');
  ok(hv(null).alive === false && hv(undefined).alive === false, 'null/undefined 不抛错，判定为不活');
}

// ── 1. 空配置也能渲染（首次进入的路径）────────────────────────────────
const ctxEmpty = { pluginId: 'memory-vec', config: () => ({}), api: async () => ({}), save: async () => ({}) };
let html = '';
try {
  html = await mod.render(ctxEmpty);
} catch (e) {
  ok(false, '空配置下 render 不抛错', `（抛错：${e?.message}）`);
}
console.log('\n── 空配置渲染 ─────────────────────────────────────');
ok(typeof html === 'string' && html.length > 2000, 'render 返回非空 HTML 字符串', `(${html.length} 字符)`);

// ── 2. 标签配对 ────────────────────────────────────────────────────────
console.log('\n── 标签配对 ───────────────────────────────────────');
const PAIRED = ['div', 'span', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'select', 'option',
  'label', 'button', 'dl', 'dt', 'dd', 'style', 'p', 'h4', 'b', 'i'];
const voids = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
let unbalanced = 0;
for (const t of PAIRED) {
  const open = (html.match(new RegExp(`<${t}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${t}>`, 'g')) || []).length;
  if (open !== close) {
    unbalanced++;
    console.log(`     ${t}: 开 ${open} / 闭 ${close}`);
  }
}
ok(unbalanced === 0, '所有成对标签开闭数量一致', unbalanced ? `${unbalanced} 种不配` : '');
ok(!html.includes('${'), '没有漏替换的模板占位（${…}）');
ok(!/>\s*undefined\s*</.test(html), '没有把 undefined 渲染进界面');

// ── 3. 结构完整（五个 tab、关键按钮、字段）─────────────────────────────
console.log('\n── 结构完整 ───────────────────────────────────────');
// 断言改为"跟着 manifest 走"，而不是写死数字 ——
// 写死数字的历史：加第三个 tab 时它会红，而红的原因是"测试没更新"，
// 不是"实现坏了"。这类假警报会训练人忽略红色。
const panes = ['cfg', 'lib', 'idn', 'rank', 'graph', 'judge'];
ok(panes.every((p) => html.includes(`data-pane="${p}"`)), `${panes.length} 个 tab 的面板都在`, `(${panes.join(', ')})`);
// 注意正则要卡住边界：`class="mv-tab` 会连带匹配到外层容器的 `class="mv-tabs"`，
// 第一版就是这么多数了一个（测试写得不精确，不是实现的问题）。
ok((html.match(/class="mv-tab[" ]/g) || []).length === panes.length, `恰好 ${panes.length} 个 tab 按钮`);
ok(!/<script/.test(html), '面板 HTML 里不含 <script>（宿主用 import 加载，插 script 会被 CSP/加载顺序坑）');
// M1 是影子期：面板必须**明说**这些分只算不注入。
// 这不是文案偏好 —— 不写清楚，用户会以为"六维已经在影响她的回答"，
// 然后据此判断效果。属于本项目一路在猎的那类"看起来在工作"。
ok(/只算不注入/.test(html) && /影子/.test(html), '六维页明说「影子 · 只算不注入」（不写清楚会被误读成已生效）');

const BUTTONS = ['mv-save', 'mv-ping', 'mv-prefill', 'mv-index', 'mv-index-force',
  'mv-selfcheck', 'mv-compact', 'mv-reset', 'mv-search', 'mv-reload',
  'mv-idn-vocab', 'mv-idn-suspect', 'mv-idn-dry', 'mv-idn-check',
  'mv-rank-run', 'mv-rank-snap', 'mv-graph-refresh',
  'mv-judge-dry', 'mv-judge-run'];
const missingBtns = BUTTONS.filter((b) => !html.includes(`id="${b}"`));
ok(missingBtns.length === 0, '关键按钮都在', missingBtns.length ? `缺 ${missingBtns.join(', ')}` : `(${BUTTONS.length} 个)`);

// 「关系星图是插件首页」是**结构属性**，必须可断言 ——
// 否则一次随手重排就会把它退回去，而"打开面板看到的第一页"恰恰是用户立刻会察觉的事。
const PANES_ALL = ['cfg', 'lib', 'idn', 'rank', 'graph', 'judge'];
const paneHidden = (id) => new RegExp(`data-pane="${id}" data-hidden="1"`).test(html);
const tabOrder = [...html.matchAll(/class="mv-tab(?: is-on)?" data-tab="([^"]+)"/g)].map((m) => m[1]);
ok(tabOrder[0] === 'graph', 'tab 栏第一个是关系星图', `(${tabOrder.join(' › ')})`);
ok(/class="mv-tab is-on" data-tab="graph"/.test(html), '默认选中项是关系星图');
ok(!paneHidden('graph'), '关系星图默认可见（首屏就是它）');
ok(PANES_ALL.filter((p) => p !== 'graph').every(paneHidden), '其余面板默认隐藏');
ok(!/关系网/.test(html), '旧名「关系网」已从面板文案中消失（统一叫「关系星图」）');

// 星图页必须**明说三件事**，否则会被误读：
//   ① 亲密度权重留空 ⇒ 不合成单一分数、不下"关系好坏"结论；
//   ② 两路信号分开（共现 / 互动）不可相加；
//   ③ 节点/scope 全是占位符，没有明文 QQ / 群号。
// 星图页在 `ADR-0013` 之后**归服务**：面板只留一个壳。要钉住的不是"画得对不对"（那在服务页里测），
// 而是"用户知道它去哪了、服务缺席时会发生什么"：
//   ① 它是服务提供的（否则用户以为图是面板画的，出问题会往错的地方找）；
//   ② 决定有出处（ADR-0013），能被追；
//   ③ 深厚分的性质写在脸上（只作用于视觉 · 不落盘 · 可重校）——
//      不写清楚，用户会以为图上那个分数已经是一条"关系结论"，这正是本项目一路在猎的那类误读；
//   ④ 节点/群仍是占位符；
//   ⑤ 有一条 iframe 之外的路（新窗口打开），iframe 被宿主策略拦时还能用。
ok(/data-pane="graph"/.test(html) && /id="mv-graph-frame"/.test(html), '星图页与内嵌容器都在（#mv-graph-frame）');
ok(/向量记忆库服务自己/.test(html), '星图页明说「由服务自己提供」');
ok(/ADR-0013/.test(html), '星图页把「归服务」的决定对到 ADR-0013');
ok(/深厚分/.test(html) && /不落盘/.test(html) && /可重校/.test(html),
  '星图页明说深厚分的性质（只作用于视觉 · 不落盘 · 可重校）');
ok(/占位符/.test(html) && /没有明文 QQ/.test(html), '星图页明说节点/群是占位符、无明文 QQ');
ok(/id="mv-graph-open"/.test(html), '有「在新窗口打开」的出口（iframe 之外留一条路）');

// 真判页（M4 第二段）是**唯一会出境**的一页 —— 它必须明说四件事，否则会被误读：
//   ① 干跑不调 LLM、**不落库**；
//   ② "判不成"整批跳过，**不写进 ambiguous**；
//   ③ 出境体里只允许占位符；
//   ④ 真跑写盘 ⇒ 两段式确认（不做"弹个框就被肌肉记忆点掉"的确认）。
// 这四条不是文案偏好：缺任何一条，用户对"这一页刚刚做了什么"的判断就是错的。
ok(/data-pane="judge"/.test(html) && /id="mv-judge-outbound"/.test(html), '真判页与「会送出去的内容」容器都在');
ok(/不调 LLM、不落库/.test(html), '真判页明说干跑「不调 LLM、不落库」');
ok(/判不成就不落库/.test(html) && /不写进\s*<code>ambiguous<\/code>/.test(html),
  '真判页明说「判不成不落库 / 不写 ambiguous」（否则"不确定"与"没答"会被混成一件）');
ok(/只允许占位符/.test(html), '真判页明说出境体只允许占位符');
ok(/再点一次/.test(html), '真判页明说真跑是两段式确认（不给出"点一下就写盘"的路径）');
ok(/OUTBOUND_FIELDS/.test(html), '真判页把出境字段与白名单常量对上（字段表可核对到代码）');

// 可配置字段数从 manifest 的 configSchema 推出来（排除面板不出现在 UI 的内部键）
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'plugin.json'), 'utf8'));
const INTERNAL = new Set(['status', 'ops']);
const expectedKeys = Object.keys(MANIFEST.configSchema || {}).filter((k) => !INTERNAL.has(k));
const renderedKeys = [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
const missingKeys = expectedKeys.filter((k) => !renderedKeys.includes(k));
const extraKeys = renderedKeys.filter((k) => !expectedKeys.includes(k));
ok(missingKeys.length === 0 && extraKeys.length === 0,
  `${expectedKeys.length} 个可配置字段都渲染了`,
  missingKeys.length || extraKeys.length
    ? `(缺 ${missingKeys.join(', ') || '无'}；多 ${extraKeys.join(', ') || '无'})`
    : `(${renderedKeys.length} 个)`);

// ── 4. 配置值真的注入进去了 ────────────────────────────────────────────
console.log('\n── 配置注入 ───────────────────────────────────────');
const custom = {
  embedBaseURL: 'https://example.invalid/v1',
  embedModel: 'my-embed-model',
  maxChars: 800,
  topK: 12,
  withSummary: false,
  shadowMode: false,
  autoIndexEnabled: true
};
const html2 = await mod.render({ ...ctxEmpty, config: () => custom });
ok(html2.includes('value="https://example.invalid/v1"'), '文本字段的值被注入');
ok(html2.includes('value="my-embed-model"'), '模型名被注入');
ok(html2.includes('value="800"'), '数字字段被注入', '(maxChars)');
ok(html2.includes('value="12"'), '数字字段被注入', '(topK)');
ok(/data-key="autoIndexEnabled"[^>]*checked/.test(html2), '布尔字段 true → checked', '(autoIndexEnabled)');
ok(!/data-key="withSummary"[^>]*checked/.test(html2), '布尔字段 false → 不 checked', '(withSummary)');
ok(!/data-key="shadowMode"[^>]*checked/.test(html2), '布尔字段 false → 不 checked', '(shadowMode)');

// ── 5. XSS 兜底：值里的尖括号必须被转义 ────────────────────────────────
console.log('\n── 转义 ───────────────────────────────────────────');
const html3 = await mod.render({ ...ctxEmpty, config: () => ({ embedModel: '<img src=x onerror=alert(1)>' }) });
ok(!html3.includes('<img src=x'), '配置值里的 HTML 被转义（不会注入面板）');
ok(html3.includes('&lt;img'), '转义成了实体');

// ── 6. 绑定阶段能在没有 DOM 的情况下优雅失败 ───────────────────────────
// （真跑 bind 需要 DOM；这里只确认它是函数且不因缺 DOM 而在导入期炸）
console.log('\n── 其它 ───────────────────────────────────────────');
ok(mod.bind.length === 2, 'bind 接收 (root, ctx) 两个参数');
ok(html.length > 0 && html2.length > 0 && html3.length > 0, '三种配置下渲染都成功');

console.log(`\n${'═'.repeat(64)}`);
console.log(`面板检查：${pass} 通过 / ${fail} 失败`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);
