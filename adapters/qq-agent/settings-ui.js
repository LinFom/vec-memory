// 向量记忆库 · 设置面板（浏览器侧）
//
// 协议（来自 ui/app.js 的 mountPluginSection）：
//   render(ctx) → HTML 字符串；bind(root, ctx) → cleanup 函数
//   ctx = { pluginId, api, config(), save(settings), setEnabled(bool), reload() }
//
// ── 两个 tab 挤在一个文件里，是宿主的硬约束 ────────────────────────────────
// 宿主的 normalizeSettingsUi 里写着 `Array.isArray(value) → return null` ——
// **一个插件只能有一个自定义面板**。所以「设置」和「向量库」必须是同一文件里的两个 tab，
// 这不是偷懒，是契约。
//
// ── 数据从哪来 ───────────────────────────────────────────────────────────
// 配置读写走 ctx.config() / ctx.save()（宿主原生通道）。
// 库数据走 /api/memory-vec/*（由 src/app.js 的 routes 缝挂上）。
// 缝没打时那里会回 404 —— 面板必须**说清楚**这件事，而不是显示一堆空表格。
//
// ── 配色策略 ─────────────────────────────────────────────────────────────
// 不写死任何背景色，只用 color-mix(in srgb, currentColor N%, transparent) 画边框与底色。
// 这样面板自动跟随宿主的明暗主题，不会在深色主题里糊成一片白。

const T = (s) => String(s ?? '');

function esc(s) {
  return T(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * 数据面：**直连独立服务**（`adr/0003` 决定 1：去缝）。
 *
 * 去缝之后宿主不再提供 `/api/memory-vec/*`，所以这里不再走 `ctx.api`（那是宿主 3210 的客户端）。
 *
 * · **base 可配**：取设置项 `serviceBaseURL`，默认 `http://127.0.0.1:8088` —— 端口改了不用改代码。
 * · **路径仍按宿主的 `/api/memory-vec/*` 写**，只在这一个函数里映射成 `/api/vec/*`
 *   ⇒ 23 处调用点一个字都不用动，也就不存在"改漏一处"。
 * · **不带 `x-console-token`**：那是宿主 3210 的鉴权标记；8088 的边界是"只绑回环"，
 *   而且带上它会触发 CORS 预检（服务端 `allow-headers` 里没有它）⇒ 请求直接被浏览器拦掉。
 * · **服务缺席不静默**：返回 `{ ok:false, __offline:true }`，由调用方给出可操作的提示，
 *   而不是显示一堆空表格。
 * · **响应形状有两套约定，别混**：`/api/vec/*` 用 `ok:true`（**业务面**，`router.mjs` 里逐个手写）；
 *   `/health` 用 `status:'ok'`（**探针语义**，它压根没有 `ok` 字段）。判存活一律走 `healthVerdict()`，
 *   不要在这里凭 `ok` 判 —— 2026-10-11 的"星图看不见"就是这么误报的（见 `healthVerdict` 的注释）。
 */
function serviceBase(ctx) {
  let v = '';
  try { v = String(ctx?.config?.()?.serviceBaseURL || '').trim(); } catch { /* 读不到就用默认 */ }
  return (v || 'http://127.0.0.1:8088').replace(/\/+$/, '');
}

/** `/api/memory-vec/x` → `/api/vec/x`；其它原样（便于将来服务与宿主同源时复用）。 */
function toServicePath(path) {
  const p = String(path ?? '');
  return p.startsWith('/api/memory-vec')
    ? '/api/vec' + p.slice('/api/memory-vec'.length)
    : p;
}

/** 把"抛错"和"返回错误对象"统一成 { ok:false, error }，不让它炸掉面板。 */
async function req(ctx, path, opts) {
  const base = serviceBase(ctx);
  const o = opts || {};
  try {
    const res = await fetch(base + toServicePath(path), {
      ...o,
      headers: { 'content-type': 'application/json', ...(o.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}`, __http: res.status };
    return data && typeof data === 'object' ? data : { ok: true, raw: data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), __offline: true, __base: base };
  }
}

/**
 * 存活判据的**唯一产地**（纯函数；`test/panelcheck.mjs` 直接拿它跑对拍）。
 *
 * ⚠️ 2026-10-11 实测教训（用户在界面上看到的是"星图看不见，还说不出为什么"）：
 *   这里原本的调用点写的是 `if (!health?.ok)`。可 `/health` 回的是
 *   `{status:'ok', dataRoot, sourceRoot}` —— **它没有 `ok` 字段**（`ok:true` 是 `/api/vec/*`
 *   业务面的约定，健康探针不是业务面）。于是**服务完全健康，面板却判它"回了错"**，
 *   而 `health.error` 同样不存在 ⇒ 界面上只剩那句"服务回了错：未知错误"：
 *   既没信息量、也不可操作，用户只会以为插件坏了。
 * ⇒ 定死约定：**两套都认**（`status:'ok'` = 探针语义 / `ok:true` = 业务面语义），
 *   且判"不活"时**必须给出可行动的细节**，不许拿"未知错误"当兜底。
 *
 * @param {any} r `req(ctx, '/health')` 的返回（或任何同形状的对象）
 * @returns {{alive:boolean, offline:boolean, detail:string}}
 */
export function healthVerdict(r) {
  if (r?.__offline === true) return { alive: false, offline: true, detail: String(r.error || '连接被拒绝') };
  if (r?.__http) return { alive: false, offline: false, detail: 'HTTP ' + r.__http + (r.error ? ' · ' + r.error : '') };
  if (r?.status === 'ok' || r?.ok === true) {
    // 成功时把**运行期事实**带出来（这个实例实际对着哪个库根）：
    // "连上了"不等于"连对了那一个"——2026-10-09 的"点错副本"就是这一类静默失败。
    return { alive: true, offline: false, detail: r.dataRoot ? '库根 ' + r.dataRoot : '' };
  }
  return { alive: false, offline: false, detail: '响应里没有 status:"ok"（探针），也没有 ok:true（业务面）' };
}

/** 探一次服务。判据（`healthVerdict`）与 IO 分开——分开，判据才测得了。 */
async function probeService(ctx) {
  return healthVerdict(await req(ctx, '/health'));
}

const STYLE = `
.mv-root { width: 100%; min-width: 0; box-sizing: border-box; font-size: 13px; line-height: 1.6;
  --mv-line: color-mix(in srgb, currentColor 13%, transparent);
  --mv-line-2: color-mix(in srgb, currentColor 26%, transparent);
  --mv-fill: color-mix(in srgb, currentColor 4%, transparent);
  --mv-fill-2: color-mix(in srgb, currentColor 8%, transparent);
  --mv-dim: color-mix(in srgb, currentColor 60%, transparent);
  --mv-dim-2: color-mix(in srgb, currentColor 46%, transparent);
  --mv-ok: #1e8449; --mv-warn: #d68910; --mv-bad: #c0392b;
}
.mv-root * { box-sizing: border-box; }

/* ── 顶部 tab：分段控件，选中态一眼可辨 ───────────────────────────── */
.mv-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 16px; padding: 3px;
  border: 1px solid var(--mv-line); border-radius: 10px; background: var(--mv-fill); }
.mv-tab { appearance: none; background: transparent; color: inherit; border: 0; border-radius: 7px;
  padding: 7px 14px; cursor: pointer; font-size: 12.5px; font-family: inherit; opacity: .6; white-space: nowrap; }
.mv-tab:hover { opacity: .92; background: var(--mv-fill-2); }
.mv-tab.is-on { opacity: 1; font-weight: 600; background: color-mix(in srgb, currentColor 13%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, currentColor 8%, transparent); }
.mv-pane[data-hidden="1"] { display: none; }

/* ── 页面头：每页第一眼「这页是干什么的」 ─────────────────────────── */
.mv-pagehead { margin: 0 0 14px; }
.mv-pagehead > h3 { margin: 0 0 3px; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.mv-pagehead > p { margin: 0; font-size: 12px; color: var(--mv-dim); }

.mv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.mv-card { border: 1px solid var(--mv-line); border-radius: 10px; padding: 11px 13px; background: var(--mv-fill); }
.mv-card b { display: block; font-size: 19px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; letter-spacing: -.2px; }
.mv-card span { font-size: 11px; color: var(--mv-dim); letter-spacing: .2px; }
.mv-sec { border: 1px solid var(--mv-line); border-radius: 10px; padding: 15px 16px; margin-bottom: 14px; background: var(--mv-fill); }
.mv-sec > h4 { margin: 0 0 6px; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.mv-sec > h4::before { content: ''; width: 3px; height: 13px; border-radius: 2px;
  background: color-mix(in srgb, currentColor 42%, transparent); flex: none; }
.mv-sec > p.hint { margin: 0 0 12px; font-size: 12px; color: var(--mv-dim); line-height: 1.7; }

/* ── 技术细节折叠：人话在前，术语在后 ─────────────────────────────── */
.mv-more { border: 1px solid var(--mv-line); border-radius: 8px; margin: 0 0 14px; background: transparent; }
.mv-more > summary { cursor: pointer; padding: 9px 12px; font-size: 12px; color: var(--mv-dim);
  list-style: none; user-select: none; display: flex; align-items: center; gap: 7px; border-radius: 8px; }
.mv-more > summary::-webkit-details-marker { display: none; }
.mv-more > summary::before { content: '▸'; font-size: 10px; opacity: .7; transition: transform .12s ease; }
.mv-more[open] > summary::before { transform: rotate(90deg); }
.mv-more > summary:hover { color: inherit; background: var(--mv-fill-2); }
.mv-more > .mv-more-body { padding: 2px 13px 13px; font-size: 12px; color: var(--mv-dim); line-height: 1.7;
  border-top: 1px solid var(--mv-line); margin-top: 2px; padding-top: 11px; }
.mv-more > .mv-more-body b { color: inherit; }
.mv-empty { border: 1px dashed var(--mv-line-2); border-radius: 9px; padding: 22px 16px; text-align: center;
  font-size: 12px; color: var(--mv-dim); }
.mv-field { margin-bottom: 12px; }
.mv-field > label { display: block; font-size: 12px; margin-bottom: 5px; font-weight: 500; }
.mv-field > .desc { font-size: 11.5px; color: var(--mv-dim); line-height: 1.65; margin-top: 4px; }
.mv-field input[type=text], .mv-field input[type=password], .mv-field input[type=number], .mv-field select {
  width: 100%; padding: 7px 9px; border-radius: 7px; font-size: 12.5px; font-family: inherit;
  border: 1px solid var(--mv-line-2);
  background: color-mix(in srgb, currentColor 2%, transparent); color: inherit; }
.mv-field input:focus, .mv-field select:focus, .mv-input:focus, textarea:focus {
  outline: none; border-color: color-mix(in srgb, currentColor 52%, transparent); }
.mv-input { padding: 6px 9px; border-radius: 7px; border: 1px solid var(--mv-line-2);
  background: color-mix(in srgb, currentColor 2%, transparent); color: inherit; font-size: 12.5px; font-family: inherit; }
.mv-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mv-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; margin-bottom: 10px; cursor: pointer; line-height: 1.5; }
.mv-check input { margin: 3px 0 0; flex: none; }
.mv-btn { appearance: none; cursor: pointer; font-size: 12.5px; font-family: inherit; padding: 6px 13px; border-radius: 7px;
  border: 1px solid var(--mv-line-2); background: var(--mv-fill-2); color: inherit; transition: background .1s ease; }
.mv-btn:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.mv-btn:disabled { opacity: .45; cursor: not-allowed; }
.mv-btn.primary { font-weight: 600; background: color-mix(in srgb, currentColor 20%, transparent);
  border-color: color-mix(in srgb, currentColor 40%, transparent); }
.mv-btn.primary:hover { background: color-mix(in srgb, currentColor 27%, transparent); }
.mv-btn.danger { color: #c0392b; border-color: color-mix(in srgb, #c0392b 45%, transparent); }
.mv-note { border-radius: 9px; padding: 11px 13px; font-size: 12px; margin-bottom: 14px; line-height: 1.7;
  border: 1px solid var(--mv-line); border-left-width: 3px; background: var(--mv-fill); }
.mv-note.warn { border-color: color-mix(in srgb, #d68910 50%, transparent); background: color-mix(in srgb, #d68910 9%, transparent); }
.mv-note.bad { border-color: color-mix(in srgb, #c0392b 50%, transparent); background: color-mix(in srgb, #c0392b 9%, transparent); }
.mv-note.good { border-color: color-mix(in srgb, #1e8449 50%, transparent); background: color-mix(in srgb, #1e8449 9%, transparent); }
.mv-note code { font-size: 11.5px; padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); }
.mv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mv-table th, .mv-table td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--mv-line); }
.mv-table th { font-weight: 600; font-size: 11px; letter-spacing: .3px; color: var(--mv-dim);
  background: var(--mv-fill); position: sticky; top: 0; }
.mv-table tbody tr:hover { background: var(--mv-fill-2); }
.mv-table td.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.mv-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.mv-tag { display: inline-block; font-size: 10.5px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--mv-line-2);
  color: var(--mv-dim); vertical-align: 1px; }
.mv-clip { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-bar { height: 5px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; min-width: 60px; }
.mv-bar > i { display: block; height: 100%; background: color-mix(in srgb, currentColor 62%, transparent); }
.mv-hist { display: flex; align-items: flex-end; gap: 3px; height: 44px; margin-top: 6px; }
.mv-hist > div { flex: 1; background: color-mix(in srgb, currentColor 30%, transparent); border-radius: 2px 2px 0 0; min-height: 2px; }
.mv-pager { display: flex; gap: 8px; align-items: center; margin-top: 10px; font-size: 12px; opacity: .8; }
.mv-kv { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 12px; }
.mv-kv dt { color: var(--mv-dim); }
.mv-kv dd { margin: 0; word-break: break-all; }
.mv-pre { max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.65;
  border: 1px solid var(--mv-line); border-radius: 8px; padding: 10px 12px; background: var(--mv-fill); }
.mv-drawer { border: 1px solid var(--mv-line-2); border-radius: 10px; padding: 15px; margin-top: 14px; }
.mv-drawer[data-hidden="1"] { display: none; }
.mv-spin { display: inline-block; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor; border-radius: 50%; animation: mv-spin .8s linear infinite; vertical-align: -1px; }
@keyframes mv-spin { to { transform: rotate(360deg); } }
.mv-sub { font-size: 11.5px; color: var(--mv-dim); margin-left: 6px; }
/* 星图页的容器：真正的画面在 iframe 里（服务提供），面板只给个壳 */
#mv-graph-frame iframe { width: 100%; }
`;

const OPT_KEYS = [
  'autoIndexEnabled', 'autoIndexIntervalMin', 'shadowMode', 'injectEnabled',
  'embedBaseURL', 'embedApiKey', 'embedModel', 'embedDimensions',
  'embedBatchSize', 'embedTimeoutMs', 'maxChars', 'withKeywords', 'withSummary', 'keywordsSource', 'topK',
  'queryInstruction',
  'injectThreshold', 'injectPerPerson', 'injectTotal',
  'selfAliases',
  'llmEndpointKind', 'llmBaseURL', 'llmApiKey', 'llmModel', 'judgeDryRun', 'judgePerMinute',
  'rememberCheckpointEnabled', 'rememberCheckpointEvery',
  'consolidateEnabled', 'consolidateIntervalMin', 'consolidateWindowMsgs',
  'consolidateWindowSpanMin', 'consolidateSettleMin', 'consolidateMaxWindowsPerRun',
  'consolidateInjectCount'
];

const NUMERIC = new Set(['autoIndexIntervalMin', 'embedBatchSize', 'embedTimeoutMs', 'maxChars', 'topK', 'judgePerMinute', 'injectThreshold', 'injectPerPerson', 'injectTotal', 'rememberCheckpointEvery', 'consolidateIntervalMin', 'consolidateWindowMsgs', 'consolidateWindowSpanMin', 'consolidateSettleMin', 'consolidateMaxWindowsPerRun', 'consolidateInjectCount']);
const BOOLS = new Set(['autoIndexEnabled', 'shadowMode', 'injectEnabled', 'withKeywords', 'withSummary', 'judgeDryRun', 'rememberCheckpointEnabled', 'consolidateEnabled']);

// 「0 = 未设」的三个键（`0.27.1`）。
// 旧树时期这几项没有默认值，存量配置里落的是 0；而**语义上 0 从来不是合法取值**：
// 服务端 `resolveMinScore` 对 `n <= 0` 直接跳过，`Number(body.total) || 8` 也会把 0 兜回 8。
// 面板若把 0 原样渲染进 `min="1"` 的输入框，浏览器标红、人读到的是「只注入 0 条」——
// 与面板既有口径「数值框留空 = 用默认」自相矛盾。统一显示为空，保存逻辑不动（不清空就不改数据）。
const UNSET_WHEN_ZERO = new Set(['injectPerPerson', 'injectTotal', 'injectThreshold']);

export async function render(ctx) {
  const c = { ...(ctx.config() || {}) };
  const v = (k, d) => (c[k] === undefined || c[k] === null ? d : c[k]);
  const chk = (k, d) => (v(k, d) ? ' checked' : '');

  // `dflt` 是**未配置时显示的值**，必须与代码里的兜底一致（`req()` 的 `serviceBase`）——
  // 否则会出现"面板显示空、实际连的是 8088"这种两边说法不一致的状态。
  const field = (key, label, desc, type = 'text', extra = '', dflt = '') => {
    let cur = v(key, dflt);
    if (UNSET_WHEN_ZERO.has(key) && Number(cur) === 0) cur = ''; // 见 UNSET_WHEN_ZERO
    return `
    <div class="mv-field">
      <label for="mv-${key}">${esc(label)}</label>
      <input id="mv-${key}" data-key="${key}" type="${type}" value="${esc(cur)}" ${extra}>
      ${desc ? `<div class="desc">${desc}</div>` : ''}
    </div>`;
  };

  if(c.protocolV1 === true) {
    let href='';try{const u=new URL(serviceBase(ctx));if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)href=u.origin+'/standalone.html';}catch{}
    return `<div class="mv-root" data-protocol-v1="1"><style>${STYLE}</style><h3>独立记忆库连接</h3>
      <p>当前使用通用协议 v1。模型、空间、共享授权和任务请到${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">独立管理页</a>`:'独立管理页'}设置。此页只保存 QQ 连接配置，旧版星图与数据面板不适用于此协议。</p>
      <p>管理页单独要求管理凭据。不要在下方填写管理凭据；项目令牌不会通过链接传递。</p>
      <label><input type="checkbox" data-key="protocolV1" checked>使用独立协议 v1（改动后重启插件）</label>
      ${field('serviceBaseURL','服务地址','HTTP / HTTPS 地址。','text','','http://127.0.0.1:8088')}
      ${field('spaceId','记忆空间 ID','填此 QQ 实例对应空间。')}
      ${field('serviceToken','项目访问令牌','只填项目令牌。','password')}
      <label><input type="checkbox" data-key="injectEnabled"${chk('injectEnabled',true)}>回复前召回记忆</label>
      <button type="button" id="mv-v1-save">保存连接</button><span id="mv-v1-note"></span></div>`;
  }
  return `
<div class="mv-root" id="mv-root">
  <style>${STYLE}</style>
  <div class="mv-tabs">
    <button class="mv-tab is-on" data-tab="graph" type="button" title="谁和谁常在一起、谁主动找谁">关系星图</button>
    <button class="mv-tab" data-tab="cfg" type="button" title="连接、开关与保存">设置</button>
    <button class="mv-tab" data-tab="lib" type="button" title="存了什么、搜一搜、维护">记忆库</button>
    <button class="mv-tab" data-tab="idn" type="button" title="检查出去的内容里还有没有真名">隐私脱敏</button>
    <button class="mv-tab" data-tab="rank" type="button" title="给记忆打分，看分数有没有分辨力（只诊断，不影响回复）">打分诊断</button>
    <button class="mv-tab" data-tab="judge" type="button" title="让 LLM 读聊天，判断哪些是梗、哪些是真心话">模式判定</button>
  </div>

  <!-- ══════════ 设置 ══════════ -->
  <div class="mv-pane" data-pane="cfg" data-hidden="1">
    <div class="mv-pagehead">
      <h3>设置</h3>
      <p>第一次使用：填好「嵌入端点」→ 保存设置 → 测试连接 → 去「记忆库」建一次索引。之后这里几乎不用再动。</p>
    </div>
    <div class="mv-note" id="mv-boot-note"></div>

    <div class="mv-sec">
      <h4>嵌入端点 <span class="mv-tag">必填 · 把文字变成向量</span></h4>
      <p class="hint">记忆的存储和搜索都靠它。独立于聊天模型 —— 换它不影响机器人聊天用哪个模型。
      填完先点底部「测试连接」，通了再去「记忆库」建索引。<b>换模型名或维度必须重建整个库</b>（插件会拒绝混用两种模型的向量）。</p>
      <div class="mv-row" style="margin-bottom:11px">
        <button class="mv-btn" id="mv-prefill" type="button">从聊天模型一键填入</button>
        <span class="mv-sub" id="mv-prefill-note"></span>
      </div>
      ${field('embedBaseURL', '端点地址', 'OpenAI 兼容的 <code>/embeddings</code> 服务。例：本地 <code>http://127.0.0.1:8081/v1</code>，云端 <code>https://…/compatible-mode/v1</code>。')}
      ${field('embedApiKey', 'API Key', '只给嵌入用。本地端点留空即可；云端端点必填（漏填会被端点回 401）。', 'password')}
      ${field('embedModel', '嵌入模型名', '例：<code>Qwen3-Embedding-0.6B</code>、<code>text-embedding-v3</code>。<b>换名字 = 换模型 = 必须重建库。</b>')}
      ${field('embedDimensions', '显式维度（可选）', '部分端点支持 <code>dimensions</code> 参数。留空用端点默认；改它等于换维度，同样要重建。')}
    </div>

    <details class="mv-more">
      <summary>高级：向量化细节（截断长度、关键词来源、批量与超时）</summary>
      <div class="mv-more-body">
        <p style="margin:0 0 12px">小时块的摘要由原始消息拼接（单块可达上万字），必须截断后再送嵌入端点；面板的条目详情里能看到每条实际用了多少、截了多少。
        <b>改「关键词来源」会改变出境文本 ⇒ 触发整库重嵌入。</b></p>
        ${field('maxChars', '单条文本上限（字）', '默认 1200 字 ≈ 600–900 token。', 'number', 'min="120" max="6000" step="20"')}
        <label class="mv-check"><input type="checkbox" data-key="withKeywords"${chk('withKeywords', true)}> 带上关键词（核心已提炼，信号质量高于原始摘要）</label>
        <label class="mv-check"><input type="checkbox" data-key="withSummary"${chk('withSummary', true)}> 带上摘要正文</label>
        <div class="mv-field">
          <label for="mv-keywordsSource">关键词来源</label>
          <select id="mv-keywordsSource" data-key="keywordsSource">
            <option value="core"${v('keywordsSource', 'filtered') === 'core' ? ' selected' : ''}>core —— 核心分词原样（会带碎片出境：single/samara、cq/qq）</option>
            <option value="filtered"${v('keywordsSource', 'filtered') === 'filtered' ? ' selected' : ''}>filtered —— 按词表剔掉实体碎片与结构碎片（默认，推荐）</option>
            <option value="redacted"${v('keywordsSource', 'filtered') === 'redacted' ? ' selected' : ''}>redacted —— 从已脱敏文本重抽</option>
          </select>
          <div class="mv-desc">切换前建议先用 <code>tools/keyword-audit.mjs</code> 在真实数据上核对。</div>
        </div>
        ${field('topK', '默认召回条数', '默认 8。', 'number', 'min="1" max="50" step="1"')}
        ${field('embedBatchSize', '单批条数', '默认 10（最严的已知云端上限，如阿里云 ≤ 10）。端点嫌多时会在报错里说"最多收几条"，服务会自动改小重发 —— 不改也能跑通，改了只是省一次试错。', 'number', 'min="1" max="64" step="1"')}
        ${field('embedTimeoutMs', '单次超时（毫秒）', '默认 30000，失败共重试 3 次。', 'number', 'min="1000" max="120000" step="1000"')}
        ${field('queryInstruction', '查询侧指令前缀（一般留空）', 'Qwen3-Embedding 这类模型要求查询侧带 <code>Instruct: …</code>、文档侧不带（非对称编码）。留空 = 用官方默认；由代码强制，换非 Qwen3 系模型时才需要调整。')}
      </div>
    </details>

    <div class="mv-sec">
      <h4>记忆怎么积累</h4>
      <p class="hint">默认什么都不做 —— 装上但不开开关时，宿主的行为与没装这个插件完全一样。</p>
      <label class="mv-check"><input type="checkbox" data-key="autoIndexEnabled"${chk('autoIndexEnabled', false)}> <span>定时自动索引（新聊天自动进记忆库）</span></label>
      ${field('autoIndexIntervalMin', '自动索引间隔（分钟）', '0 = 不自动（默认）。内容没变的块会被跳过，不重复花钱。', 'number', 'min="0" max="1440" step="5"')}
      <label class="mv-check"><input type="checkbox" data-key="rememberCheckpointEnabled"${chk('rememberCheckpointEnabled', true)}> <span>记忆检查点（每隔一段对话，在消息末尾提醒模型把<strong>稳定事实</strong>用「记事实」工具入库）</span></label>
      <div class="mv-desc" style="margin:2px 0 10px">背景：写通路只靠模型自觉（实测 0.21.0 修复注入后 10 会话 0 次调用；0.27.x 期间 1504 次 offered 只换来 5 次调用）。检查点把提醒放到<strong>消息末尾的近因位置</strong>，并要求模型先记后答、不在回复里提起。模型记过一条后计数重新起算。<br>
      <b>0.28.0 起配套「记人」常驻节</b>：每轮都在消息末尾挂一节行为指令（该记什么 / 节律 / 怎么查），对照老 memory_append 在宿主人设里的专属节补的对齐 —— 它不受检查点开关影响，也不依赖向量服务。</div>
      ${field('rememberCheckpointEvery', '检查点间隔（轮）', '0 = 用默认 4（0.28.0 前是 10，实测 10 轮太稀：73 分钟仅 7 次提醒、0 响应）。每个会话单独计数；关闭再打开不影响。', 'number', 'min="0" max="200" step="1"')}
    </div>

    <div class="mv-sec">
      <h4>事件整理 <span class="mv-tag">记忆库侧</span></h4>
      <p class="hint">在<strong>记忆库服务</strong>里跑：读宿主的 evidence 账本（每条入站消息一行），把「上次整理结束 → 现在」这段切成一窗一窗，调模型整理成<strong>事件</strong>（这期间发生了什么）和<strong>人物印象</strong>（对谁形成了什么印象）。</p>
      <div class="mv-desc" style="margin:0 0 10px">
      与宿主的「自动整理」（<code>memory.consolidateEnabled</code>）<b>不是一回事</b>：那个产出 observations/episodes 到宿主 data，已于 2026-10-22 停用；这一组是记忆库自己的管道，产出事件账本与人物槽。
      <br>⚠️ 会调模型<b>花钱</b>，所以默认关。当前实测单窗约 120 条消息、一次调用 ≈ 2-3k 输入 token。
      </div>
      <label class="mv-check"><input type="checkbox" data-key="consolidateEnabled"${chk('consolidateEnabled', false)}> <span><b>开启事件整理</b>（定时自动跑；关掉后只能手动触发）</span></label>
      ${field('consolidateIntervalMin', '整理间隔（分钟）', '0 = 用默认 30。它管频率，「开不开」由上面那个勾选框管。', 'number', 'min="0" max="1440" step="5"')}
      ${field('consolidateMaxWindowsPerRun', '单轮最多几个窗口', '成本闸门。积压多时每轮只消化这么多，下一轮接着来；0 = 用默认 3。', 'number', 'min="0" max="50" step="1"')}
      ${field('consolidateWindowMsgs', '窗口条数', '一个窗口最多几条消息，默认 120。', 'number', 'min="20" max="1000" step="10"')}
      ${field('consolidateSettleMin', '沉淀分钟', '窗口末端必须早于「现在 - 这么多分钟」，默认 3 —— 正在聊的那段留给下一轮，避免把一个话题劈成两半。', 'number', 'min="0" max="120" step="1"')}
      ${field('consolidateInjectCount', '注入几条事件', '每轮回复前，把本会话最近的 N 条事件放进提示词（按时间倒序，不走向量相似度），默认 3；0 = 不注入。', 'number', 'min="0" max="10" step="1"')}
    </div>

    <div class="mv-sec">
      <h4>回复时注入什么 <span class="mv-tag">人格属性</span></h4>
      <label class="mv-check"><input type="checkbox" data-key="injectEnabled"${chk('injectEnabled', true)}> <span><b>开启人格属性注入</b> —— 让机器人回复前参考长期记忆</span></label>
      <div class="mv-desc" style="margin:0 0 12px">每轮回复前，从句子里挑出与当前话题相关的「人格属性句」（如 <code>某人：表达真诚、说到做到（例："……"）</code>）悄悄附加在系统提示词里参考 —— <b>不主动提及</b>。
      服务没起 / 超时 2.5 秒 / 关闭 ⇒ 静默跳过，绝不影响回复。</div>
      ${field('injectThreshold', '话题相关度阈值', '属性与当前话题的向量相似度 ≥ 此值时视为「现在就用得上」（排最前）。默认 0.5 —— 按真库实测校准过（0.85 下 hot 恒 0、首次生效在 0.45~0.5）。换嵌入模型后分布会变，需重新校准。', 'number', 'min="0" max="1" step="0.01"')}
      ${field('injectPerPerson', '每人最多几条', '对齐宿主「群友印象」机制的每人 2 条。默认 2。', 'number', 'min="1" max="6" step="1"')}
      ${field('injectTotal', '单轮总上限', '多人同时在场时按可信度截断，兜住提示词预算。默认 8。', 'number', 'min="1" max="24" step="1"')}
      <label class="mv-check" style="margin-top:12px"><input type="checkbox" data-key="profileCrossScope"${chk('profileCrossScope', true)}> <span><b>档案跨场合</b> —— 私聊里记的固定特征（年龄、职业这类），群里也用得上</span></label>
      <div class="mv-desc" style="margin:2px 0 0">档案是<b>长期固定特征</b>（如「林枫：年龄=21岁」），与话题无关、每轮常驻。默认开：在你告诉它的那个会话里记下来，换个场合（群 ↔ 私聊）也认得出 —— 人对自己的年龄没有「只能在哪说」的预期。<br>
      <b>关掉会发生什么：</b>档案退回「只在本场合生效」——私聊说的不进群、群 A 说的不进群 B。这是旧行为，防的是住址、真名、性取向、病情这类一句话就社死的信息。代价是同一个人的档案在别处等于没记过（实测：私聊说过 21 岁，群里问就答不出）。</div>
      <details class="mv-more" style="margin:0">
        <summary>高级：阈值是硬门槛还是只影响排序</summary>
        <div class="mv-more-body">
          <div class="mv-field">
            <label for="mv-injectMode">阈值用法</label>
            <select id="mv-injectMode" data-key="injectMode">
              <option value="boost"${v('injectMode', 'boost') === 'boost' ? ' selected' : ''}>boost —— 阈值只影响排序，其余属性照常注入（默认）</option>
              <option value="hard"${v('injectMode', 'boost') === 'hard' ? ' selected' : ''}>hard —— 只有 ≥ 阈值的属性才注入（嵌入服务缺席时自动降级为 boost）</option>
            </select>
          </div>
        </div>
      </details>
    </div>

    <div class="mv-sec">
      <h4>跨会话近况 <span class="mv-tag">别的群刚说了什么</span></h4>
      <label class="mv-check"><input type="checkbox" data-key="crossChatEnabled"${chk('crossChatEnabled', true)}> <span><b>开启跨会话近况</b> —— 把别的会话最近几分钟的原话摘一节给她</span></label>
      <div class="mv-desc" style="margin:0 0 12px">宿主把短期记忆<b>按会话物理隔离</b>（群归群、私聊归私聊）：群里刚说的话，私聊的提示词里一行都没有，所以她「转头就忘」。这一项只读宿主的 <code>messages/</code> 存档，把别的会话最近的原话摘成一小段附在提示词里。<br>
      <b>代价：</b>每轮多读一次存档（按修改时间缓存，没变就不重解析）；提示词末尾多 1~2 行。宿主 <code>api.architecture.crossChatAwareness</code> 那组键在新树里<b>没有消费方</b>（实现随旧插件移除），打开它无效，所以能力落在这里。</div>
      <label class="mv-check"><input type="checkbox" data-key="crossChatInPrivate"${chk('crossChatInPrivate', true)}> <span><b>私聊也收别处动静</b> —— 私聊时也参考群里最近说的话</span></label>
      <div class="mv-desc" style="margin:2px 0 10px">目标侧开关。默认开（2026-10-19 拍板）：你在群里说完话转头私聊，她接得上。关掉 = 私聊只认自己的历史与长期事实（宿主 2026-09-23 的旧口径：「群内梗/当前进度」归当前会话）。</div>
      <label class="mv-check"><input type="checkbox" data-key="crossChatInGroup"${chk('crossChatInGroup', true)}> <span><b>群聊也收别处动静</b> —— 群 A 里参考群 B 最近说的话（当前群永远排除）</span></label>
      <div class="mv-desc" style="margin:2px 0 10px">目标侧开关。默认开：宿主旧口径是「跨群只该在群与群之间发生」。<b>觉得群聊里串味</b>（她提到别的群的事）就关掉这一条 —— 只关群侧、保留私聊那份，别把总闸关了。</div>
      <label class="mv-check"><input type="checkbox" data-key="crossChatIncludePrivate"${chk('crossChatIncludePrivate', false)}> <span><b>让私聊内容当来源</b> —— 私聊里说的话也出现在别的群里</span></label>
      <div class="mv-desc" style="margin:2px 0 10px">来源侧开关，<b>默认关</b>。打开等于把私聊内容漏进群，风险与「档案跨场合」不是一个量级（那个是固定特征，这个是逐字原话）。<b>别随手开。</b></div>
      ${field('crossChatMinutes', '近况时间窗（分钟）', '只摘最近这么多分钟的原话。默认 10 —— 越短越像「刚刚」，越长越像翻旧账。', 'number', 'min="1" max="240" step="1"')}
      ${field('crossChatMaxChats', '最多几个会话', '按最近活跃排序取前 N 个，兜住提示词预算。默认 2。', 'number', 'min="1" max="8" step="1"')}
      ${field('crossChatMaxChars', '每个会话的字符上限', '单个来源会话最多摘多少字，超了在句子边界截断。默认 120。', 'number', 'min="40" max="600" step="10"')}
    </div>

    <div class="mv-sec">
      <h4>模式判定 <span class="mv-tag">可选 · 会调用 LLM</span></h4>
      <p class="hint">让 LLM 读一段聊天，判断哪些反复出现的表达是「梗」、哪些是「真心话」，并提取话里的事实。
      判定会把脱敏后的文本发给 LLM —— 这是出境、去哪必须明确声明，所以<b>「端点类型」留空时判定拒绝启动</b>。不配它不影响其它任何功能。</p>
      <div class="mv-field">
        <label for="mv-llmEndpointKind">端点类型（必填）</label>
        <select id="mv-llmEndpointKind" data-key="llmEndpointKind">
          <option value=""${v('llmEndpointKind', '') === '' ? ' selected' : ''}>（未选择 —— 判定不会启动）</option>
          <option value="local"${v('llmEndpointKind', '') === 'local' ? ' selected' : ''}>本机推理（llama.cpp 等）—— 文本不出本机</option>
          <option value="external"${v('llmEndpointKind', '') === 'external' ? ' selected' : ''}>外部 API —— 脱敏后的文本会发送到外部（如 DeepSeek）</option>
        </select>
        <div class="desc">选「外部 API」时文本会离开本机。出境内容只有白名单字段（占位符身份、簇大小、剥掉脚手架后的原文），原始时间戳与引用块原文永不发送 —— 在「模式判定」页可逐条核对。</div>
      </div>
      ${field('llmBaseURL', 'LLM 端点地址', 'OpenAI 兼容的 <code>/chat/completions</code>。例：<code>https://api.deepseek.com</code>、本机 <code>http://127.0.0.1:8082/v1</code>。')}
      ${field('llmApiKey', 'LLM 端点 Key', '云端端点必填；本机推理留空。', 'password')}
      ${field('llmModel', 'LLM 模型名', '例：<code>deepseek-flash</code>。判定固定温度 0 且要求严格 JSON 输出，建议用非推理模型。')}
      <label class="mv-check"><input type="checkbox" data-key="judgeDryRun"${chk('judgeDryRun', false)}> <span>模拟模式：只走流程、不调用、不写盘</span></label>
      <div class="desc" style="margin:0 0 12px">打开后判定只展示「会送出去的内容」不真的调用 LLM —— 建议第一次先这样看一眼。</div>
      ${field('judgePerMinute', '调用频率上限（次/分钟）', '默认 10。连续失败会自动放慢（最多 5 分钟一次）；抽不到名额就跳过 —— 不积压、不重试风暴。')}
    </div>

    <details class="mv-more">
      <summary>高级：记忆服务的地址（端口）</summary>
      <div class="mv-more-body">
        <p style="margin:0 0 12px">记忆数据跑在一个<b>独立服务</b>里（默认 8088 端口）—— 装卸这个插件都不改 QQ-Agent 的源文件；服务没起时本面板会明确提示，不会显示空表格。改这里不用重启 QQ-Agent。</p>
        <label class="mv-check"><input type="checkbox" data-key="protocolV1"${chk('protocolV1', false)}> 使用独立记忆协议 v1（完成迁移后启用，重启插件生效）</label>
        ${field('spaceId', '记忆空间 ID', '由独立记忆库管理页创建。')}
        ${field('serviceToken', '项目访问令牌', '只填写此项目凭据，不填写管理凭据。', 'password')}
        ${field('serviceBaseURL', '服务地址', '默认 <code>http://127.0.0.1:8088</code>。改端口要同步改服务启动参数。', 'text', '', 'http://127.0.0.1:8088')}
        ${field('groupNamesBaseURL', '群名来源（可留空）', '星图上的星系标签要显示群昵称，而群名只有宿主知道（协议端的 <code>get_group_list</code>）—— 存档里只有群号。服务会去读宿主的 <code>GET /api/onebot/groups</code>。<b>留空 = 自动</b>：从宿主 <code>config.json</code> 的 <code>server.port</code> 推（实测 3210）。填一个连不上的地址就等同于关掉这一路：星系标签退回代号「群 C9814」，星图页脚会写清原因。', 'text', '', '')}
      </div>
    </details>

    <div class="mv-row">
      <button class="mv-btn primary" id="mv-save" type="button">保存设置</button>
      <button class="mv-btn" id="mv-ping" type="button">测试连接</button>
      <span class="mv-sub" id="mv-save-note"></span>
    </div>
  </div>

  <!-- ══════════ 记忆库 ══════════ -->
  <div class="mv-pane" data-pane="lib" data-hidden="1">
    <div class="mv-pagehead">
      <h3>记忆库</h3>
      <p>这里存着机器人全部长期记忆的向量索引：建索引、搜一搜、看每条内容的原始样子。</p>
    </div>
    <div class="mv-note" id="mv-lib-boot">
      <span class="mv-spin"></span> 正在读取库状态…
    </div>

    <div class="mv-grid" id="mv-cards"></div>

    <div class="mv-sec">
      <h4>建索引与维护</h4>
      <p class="hint">建索引 = 读聊天压缩块 → 截断 → 送嵌入端点 → 存进库。已存在且内容没变的块会自动跳过（重复点不重复花钱）。</p>
      <div class="mv-row">
        <button class="mv-btn primary" id="mv-index" type="button">更新记忆（只处理新内容）</button>
        <button class="mv-btn" id="mv-index-force" type="button">全部重新索引</button>
        <button class="mv-btn" id="mv-selfcheck" type="button">完整性检查</button>
        <button class="mv-btn" id="mv-compact" type="button">释放空间</button>
        <button class="mv-btn danger" id="mv-reset" type="button">清空记忆库</button>
        <span class="mv-sub" id="mv-job-note"></span>
      </div>
      <div id="mv-checks" style="margin-top:12px"></div>
    </div>

    <div class="mv-sec">
      <h4>搜一搜</h4>
      <p class="hint">输入一句话（问句也行），看哪些记忆块被召回、相似度各是多少 —— 这就是「人格属性注入」在幕后做的同一件事。
      <b>看分数分布比看命中的条目更有用</b>：前几名挤在一起，说明这个查询在这套向量上没有分辨力。</p>
      <div class="mv-row">
        <input type="text" id="mv-q" class="mv-input" placeholder="例如：她说过什么关于换模型的事？" style="flex:1;min-width:220px">
        <button class="mv-btn" id="mv-search" type="button">搜索</button>
        <span class="mv-sub" id="mv-search-note"></span>
      </div>
      <div id="mv-search-out" style="margin-top:12px"></div>
    </div>

    <div class="mv-sec">
      <h4>按人 / 按标签查</h4>
      <p class="hint">
        <b>长期记忆</b>（结构化事实，存在 <code>slots.jsonl</code>）和<b>近期记忆</b>（聊天块，在向量库里）
        是两套存储 —— 上面那个「搜一搜」只认后者，所以搜「年龄」永远搜不到那条「年龄=21岁」。
        这里一次给你两段，<b>分开列</b>（一个是关键词重合度、一个是余弦，两个数不可比）。<br>
        人可以用 QQ 号 / 昵称 / 占位符；标签点一下选中、再点取消，「全部」清空。
      </p>
      <div class="mv-row">
        <input type="text" id="mv-rc-who" class="mv-input" placeholder="谁（留空 = 所有人）" style="min-width:170px">
        <button class="mv-btn primary" id="mv-rc-go" type="button">查</button>
        <span class="mv-sub" id="mv-rc-note"></span>
      </div>
      <div class="mv-row" id="mv-rc-kinds" style="margin-top:8px;flex-wrap:wrap;gap:6px"></div>
      <div id="mv-rc-out" style="margin-top:12px"></div>
    </div>

    <div class="mv-sec">
      <h4>库里的每一条</h4>
      <div class="mv-row" style="margin-bottom:10px">
        <input type="text" id="mv-fq" class="mv-input" placeholder="按标题/摘要过滤" style="flex:1;min-width:180px">
        <select id="mv-fchat" class="mv-input"><option value="">全部会话</option></select>
        <button class="mv-btn" id="mv-reload" type="button">刷新</button>
      </div>
      <div id="mv-list"></div>
      <div class="mv-pager" id="mv-pager"></div>
    </div>

    <div class="mv-drawer" id="mv-drawer" data-hidden="1"></div>
  </div>

  <!-- ══════════ 隐私脱敏 ══════════ -->
  <div class="mv-pane" data-pane="idn" data-hidden="1">
    <div class="mv-pagehead">
      <h3>隐私脱敏</h3>
      <p>确保离开本机的内容里没有真名：谁被认成了谁、还有没有漏网的。</p>
    </div>
    <div class="mv-note" id="mv-idn-boot"><span class="mv-spin"></span> 正在读取脱敏名单…</div>

    <div class="mv-note">
      <b>这一页回答一个问题：发出去的内容里，还有没有真名。</b><br>
      聊天块里写着 QQ 号和群名片，直接送云端就是身份出境。所以出境前有一道闸门：把实体换成<b>占位符</b>（<code>〔P1234〕</code>）。
      占位符由本机密钥派生、跨重建稳定；本页所有数据都在本机，<b>不随索引导出</b>。
    </div>

    <div class="mv-grid" id="mv-idn-cards"></div>

    <div id="mv-idn-self"></div>

    <div class="mv-sec">
      <h4>名单新鲜度</h4>
      <div id="mv-idn-fresh"></div>
    </div>

    <div class="mv-sec">
      <h4>自我别称</h4>
      <p class="hint">「我是谁」自动从三处识别：<code>config.json</code> 的 <code>botName</code>、人设名、以及存档里「主人怎么叫我」（如「小萨」）。
      但多词名字被拆开的碎片（<code>Single Samara</code> 里的 <code>samara</code>）没有任何独立来源，实测会原样出境 —— 所以这里<b>交给你声明</b>，不让代码去猜（猜「多词名字每一块都算我」会把普通词 <code>single</code> 也替成自己）。
      逗号 / 顿号 / 换行分隔；<b>留空 = 不额外声明、不做任何猜测</b>。</p>
      ${field('selfAliases', '自我别称', '每一项都会被替换成 〔SELF〕。改完回「设置」页点保存，再点下面「更新脱敏名单」—— 不用重启宿主。')}
    </div>

    <div class="mv-sec">
      <h4>统计范围</h4>
      <p class="hint">关系星图与关系边的统计边界。它是<b>存档的深度</b>（不是插件安装日），会随聊天自动变深。
      范围太短时界面会明说 —— 否则你会把「装完之后活跃的人」误读成「本来关系就近的人」。</p>
      <div id="mv-idn-horizon"></div>
    </div>

    <div class="mv-sec">
      <h4>检查与维护 <span class="mv-tag">全部离线 · 不花钱</span></h4>
      <p class="hint">「全库隐私体检」是唯一能在花 token 之前跑完的检查 —— 建完索引先跑它。</p>
      <div class="mv-row">
        <button class="mv-btn" id="mv-idn-vocab" type="button">更新脱敏名单</button>
        <button class="mv-btn" id="mv-idn-suspect" type="button">找漏网的名字</button>
        <button class="mv-btn primary" id="mv-idn-dry" type="button">全库隐私体检</button>
        <span class="mv-sub" id="mv-idn-note"></span>
      </div>
      <div id="mv-idn-dryout" style="margin-top:12px"></div>
      <div style="margin-top:14px">
        ${field('suspectMinCount', '漏网判定：最小出现次数', '默认 8。太小会把噪声也当成名字。', 'number', 'min="2" max="500" step="1"')}
        ${field('suspectMaxSpread', '漏网判定：最大分散度', '判据是「命中的会话数 ÷ 总会话数」。真名集中在少数群（低），普通词在所有群近似均匀（高）。默认 0.35。', 'number', 'min="0.02" max="1" step="0.01"')}
        <p class="hint">改完记得回「设置」页点保存，再回来点「找漏网的名字」。</p>
      </div>
    </div>

    <div class="mv-sec">
      <h4>试用：贴一段看看会变成什么</h4>
      <p class="hint">贴一段真实聊天记录进来，看它被替换成什么样、每一处是被哪一层判出来的。<b>不落库、不联网。</b></p>
      <textarea id="mv-idn-text" rows="4" class="mv-input" style="width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px" placeholder="例如：沫钤: [引用 #279 Inexpressible：这是什么版本的？]@Inexpressible[CQ:at,qq=1050889650] 你用的不是这个版本吗"></textarea>
      <div class="mv-row" style="margin-top:9px">
        <button class="mv-btn" id="mv-idn-check" type="button">跑一遍</button>
      </div>
      <div id="mv-idn-checkout" style="margin-top:12px"></div>
    </div>

    <div class="mv-sec">
      <h4>待确认名单</h4>
      <p class="hint">出现次数少、拿不准的串<b>照样被替换</b>（宁可误替，不可漏替 —— 漏报是名字出境，不可撤回），同时落到这里等你确认。
      确认只是把它转正为永久名单，<b>不确认也已经在替换了</b>。</p>
      <div id="mv-idn-pending"></div>
    </div>

    <div class="mv-sec">
      <h4>同名合并 <span class="mv-tag">只信你点名 · 绝不自动焊</span></h4>
      <p class="hint">下面是<b>撞名</b>的候选：同一个名字被多个不同 QQ 号用着。同名<b>不等于</b>同一个人
      （中文短昵称在群里很容易撞车），所以系统只列建议、<b>永远不自动合并</b>；
      你点「是同一人」才写入词表（被并方从此共用同一个占位符，边、星、备注全部自动归位）。
      合并错了可以取消 —— 恢复独立实体，并把他原本的备注沿着沿革表搬回去。</p>
      <div id="mv-idn-merge"></div>
    </div>
  </div>

  <!-- ══════════ 打分诊断 ══════════ -->
  <div class="mv-pane" data-pane="rank" data-hidden="1">
    <div class="mv-pagehead">
      <h3>打分诊断</h3>
      <p>给每条记忆算六个维度的分数，检查这些分数有没有分辨力 —— 本页只诊断，不影响回复。</p>
    </div>
    <div class="mv-note" id="mv-rank-boot"><span class="mv-spin"></span> 正在计算分数分布…</div>

    <div class="mv-note">
      <b>这一页回答一个问题：打出来的分，有没有分辨力。</b><br>
      自动测试全绿、和「所有记忆的分数几乎一样（极差 0.0004）」可以<b>同时成立</b> —— 因为测试数据天生没有分布问题，你总是记得传不同的值。
      所以分数算完第一件事不是接进排序，是<b>把分布摊开看</b>。<br>
      判据：<b>档数 ≥ 3 且极差 &gt; 0.01</b> —— 档数少 = 分不出高低，极差小 = 名次由浮点噪声决定。<br>
      <b>整页都是影子：只算不注入。</b>没有一条分数参与检索或提示词。
    </div>

    <div class="mv-grid" id="mv-rank-cards"></div>

    <div class="mv-sec">
      <h4>逐维分布</h4>
      <p class="hint"><b>打满</b>那一列比极差更容易漏看：档数可能不止一个（有长尾），
      但头部全平 —— 而注入用的永远只有前几名。有些维度就是「有分布，却恰好分布在你用不到的地方」。</p>
      <div id="mv-rank-table"></div>
    </div>

    <div class="mv-sec">
      <h4>诊断：是「没原料」还是「阈值要重扫」</h4>
      <p class="hint">这两种情况的改法完全不同 —— 前者该记「不做」，后者该重扫阈值。只报一句"不过"，等于把两件事糊在一起。</p>
      <div id="mv-rank-diag"></div>
    </div>

    <div class="mv-sec">
      <h4>分布账本</h4>
      <p class="hint">每次跑分布记一条<b>形状快照</b>（不记逐条分数 —— 六维是确定性规则，逐条存只是复制数据）。
      攒几天看它变不变：块在长、名单在长、群在解散，变的正是这个。</p>
      <div id="mv-rank-shadow"></div>
    </div>

    <div class="mv-sec">
      <h4>操作</h4>
      <label class="mv-check"><input type="checkbox" data-key="shadowMode"${chk('shadowMode', true)}> <span><b>影子模式（打分只算不用）</b> —— 打开时六维分数只用于诊断、不参与回复排序</span></label>
      <div class="mv-row">
        <button class="mv-btn primary" id="mv-rank-run" type="button">重新计算分布</button>
        <button class="mv-btn" id="mv-rank-snap" type="button">记录一次快照</button>
        <span class="mv-sub" id="mv-rank-note"></span>
      </div>
      <div id="mv-rank-checks" style="margin-top:12px"></div>
    </div>
  </div>

  <!-- ══════════ 关系星图（插件首页 · 默认打开） ══════════ -->
  <div class="mv-pane" data-pane="graph">
    <div class="mv-pagehead">
      <h3>关系星图</h3>
      <p>一个群 = 一个星系，每个人 = 一颗星，中心是她。这一页由<b>向量记忆库服务自己</b>提供。</p>
    </div>
    <div class="mv-note" id="mv-graph-boot"><span class="mv-spin"></span> 正在连接向量记忆库服务…</div>
    <div id="mv-graph-frame"></div>
    <div id="mv-graph-off"></div>

    <div class="mv-row" style="margin-top:10px">
      <button class="mv-btn" id="mv-graph-refresh" type="button">重新加载星图</button>
      <a class="mv-btn" id="mv-graph-open" href="#" target="_blank" rel="noopener"
         style="text-decoration:none">在新窗口打开</a>
      <span class="mv-sub" id="mv-graph-note"></span>
    </div>

    <details class="mv-more">
      <summary>这一页在说什么 —— 读图之前值得看一眼</summary>
      <div class="mv-more-body">
        <b>它为什么在服务里，而不在面板里。</b>星图是纯数据可视化：它只读关系边、不写宿主的任何配置。
        所以它<b>整个搬进了向量记忆库服务</b>（<code>ADR-0013</code>），在这里只是一块嵌入式面板 ——
        用浏览器直接打开 <code>http://127.0.0.1:8088/</code> 是同一张图，不依赖 QQ-Agent。
        <br><br>
        <b>图怎么读。</b>中心是她；<b>方位</b>=群归属（一个群一个星系），<b>半径</b>=与她的关系深度（越熟越靠中心）。
        人与她之间每个群各画一条<b>辐条</b>（颜色=群色，恒细恒淡）；
        人与人之间画<b>弦</b> —— 颜色/粗细/透明度表<b>深厚档</b>（暖→冷），<b>虚实表关系性质</b>
        （实线=有主动互动，虚线=只有共现，也就是「熟悉的陌生人」）。
        <br><br>
        <b>两路信号分开存、不合并</b>：<code>共现</code>管方位与距离，<code>互动</code>管粗细与虚实。
        图表上唯一的合成分数是<b>深厚分</b>（<code>0.67×互动饱和 + 0.33×共现饱和</code>；饱和 = <code>log(1+次数)/log(1+300)</code>，互动共现各按 300/400 封顶；再按 <code>^3</code> 压成线宽）——
        <b>深由绝对互动量挣来，不由在人群里的排位挣来</b>（0.26.0 前输入的是百分位：名次永远均匀铺开，
        哪怕所有人加起来没说过几句话也"总有人最深"—— 那是排位的数学性质，不是关系好）。它<b>只作用于视觉</b>：
        <b>不落盘、不进 read-model、不下"关系好坏"的结论</b>。权重与饱和点都<b>没有分布学证据</b>，标为可重校（<code>ADR-0040</code>）。
        <br><br>
        <b>隐私。</b>节点与群一概是<b>占位符</b>（没有明文 QQ / 群号）；真名只在本机渲染的那一刻从词表反查贴上，
        <b>不随索引出境</b>。你写的备注也只在本地文件里（<code>notes.json</code>），同样不进词表、不影响脱敏。
      </div>
    </details>
  </div>

  <!-- ══════════ 模式判定（M4 第二段） ══════════ -->
  <div class="mv-pane" data-pane="judge" data-hidden="1">
    <div class="mv-pagehead">
      <h3>模式判定</h3>
      <p>让 LLM 读一段聊天，判断哪些反复出现的话是「梗」、哪些是「真心话」，并提取话里的事实。</p>
    </div>
    <div class="mv-note" id="mv-judge-boot">这一页<b>不自动跑</b> —— 先点「模拟运行」看清会送什么出去，确认无误再点「正式判定」。</div>

    <div class="mv-note">
      两个动作分开：<code>模拟运行</code>走完整流程但<b>用固定桩</b>（<b>不调 LLM、不落库</b>），把<b>真正会出境的那份内容</b>摊在这里给你逐条过目；
      <code>正式判定</code>才真的调用 LLM，并把判定写进事实表。<br>
      两条铁律：① 出境体里<b>只允许占位符</b>（人 / 群 / 自己全部替换，明文实体串过不了闸门）；
      ② <b>判不成就不落库</b> —— 「没判成」与「判了但不确定」是两件事，前者整批跳过，<b>不写进 <code>ambiguous</code></b>。<br>
      ⚠️ 正式判定会<b>写盘</b>（<code>facts/slots.jsonl</code>，只追加）。写的是语用段 —— <code>pattern</code>（这个人怎么说话）走独立表，所以 <code>facts = 0</code> 是<b>正常</b>的，不是失败。<br>
      本页<b>不合并「共现/互动」口径、不合成关系结论</b>；这里只有「判定」与「落库」两个事实。
    </div>

    <div class="mv-sec">
      <h4>运行</h4>
      <p class="hint">窗口取<b>存档尾部</b> N 条（默认 15,000）。调小只在想快看一遍时用 —— 窗口一小，触发的簇会跟着少：判定要求「同一窗口内至少 N 条同类表达」，窗口就是那个「同一窗口」。</p>
      <div class="mv-row">
        <label class="mv-sub">窗口条数</label>
        <input id="mv-judge-limit" type="number" min="500" max="60000" step="500" value="15000" class="mv-input" style="width:96px">
        <button class="mv-btn" id="mv-judge-dry" type="button">模拟运行（不调用、不写盘）</button>
        <button class="mv-btn primary" id="mv-judge-run" type="button">正式判定（调用 LLM、写盘）</button>
        <span class="mv-sub" id="mv-judge-note"></span>
      </div>
      <p class="hint" style="margin-top:8px">正式判定是<b>两段式确认</b>：第一次点只会把按钮变成
      「再点一次＝真的写盘」，10 秒内再点一次才真的跑 —— 面板里没有「悄悄写一次盘」这种路径。</p>
    </div>

    <div class="mv-sec">
      <h4>筛选漏斗</h4>
      <p class="hint">从存档到触发判定，每一层掉了多少都要看得见。只报一句"触发了 N 条"，
      分不清是<b>真没有</b>还是<b>筛丢了</b> —— 这两件事的改法完全不同。</p>
      <div class="mv-grid" id="mv-judge-funnel"></div>
      <div id="mv-judge-funnel-note"></div>
    </div>

    <div class="mv-sec">
      <h4>判官能看到的字段</h4>
      <p class="hint">这就是<b>判官能看到的全部</b>。白名单是硬编码的（常量名 <code>OUTBOUND_FIELDS</code>），不在这张表里的字段根本不会被送出去 ——
      在这里核对，比在提示词里找放心。</p>
      <div id="mv-judge-fields"></div>
    </div>

    <div class="mv-sec">
      <h4>判官看到的内容（逐条）</h4>
      <p class="hint">逐条就是判官看到的样子，<b>这里是人工过目的唯一位置</b>。
      表头照抄出境白名单 —— <code>self_n</code> 这类<b>本地标注不在其中</b>
      （它只落进槽的分析字段 <code>content.self_n</code>，<b>不随判定出境</b>）。<br>
      残留扫描是<b>启发式</b>的：剥掉 <code>〔…〕</code> 后还剩 ≥3 个连续字母 / ≥5 位数字就标黄。
      <b>标黄不等于泄漏，没标黄也不等于一定干净</b>（子串会误报，名单没覆盖的名字不会标出来）。</p>
      <div id="mv-judge-outbound"></div>
    </div>

    <div class="mv-sec">
      <h4>判定结果</h4>
      <div id="mv-judge-results"></div>
    </div>

    <div class="mv-sec">
      <h4>写进库的内容</h4>
      <p class="hint">只有正式判定才有这一栏。<b>写入数 ≠ 槽位数</b>：同一个说话人的多条 pattern 打的是同一个键，
      逐次追加、<code>rev</code> 递增 ⇒ 行数会多于唯一槽数。</p>
      <div id="mv-judge-applied"></div>
    </div>

    <div class="mv-sec">
      <h4>运行日志（不含聊天内容）</h4>
      <p class="hint">只记字段名与簇的<b>内部下标</b>，不记聊天原文、不记身份值 —— 所以这份日志可以随便贴出来。</p>
      <div id="mv-judge-log" class="mv-pre"></div>
    </div>
  </div>
</div>`;
}

export async function bind(root, ctx) {
  if(root.querySelector('[data-protocol-v1]')) {
    const button=root.querySelector('#mv-v1-save');
    const save=async()=>{const note=root.querySelector('#mv-v1-note');try{const patch={};for(const el of root.querySelectorAll('[data-key]'))patch[el.dataset.key]=el.type==='checkbox'?el.checked:el.value;await ctx.save(patch);note.textContent='已保存，重启插件生效。';}catch(e){note.textContent=`保存失败：${e.message}`;}};
    button?.addEventListener('click',save);return ()=>button?.removeEventListener('click',save);
  }
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const cleanups = [];
  let patched = false;

  const bootNotes = [
    { el: $('#mv-boot-note'), for: '设置' },
    { el: $('#mv-lib-boot'), for: '库' }
  ];

  function say(node, kind, html) {
    if (!node) return;
    node.className = `mv-note${kind ? ` ${kind}` : ''}`;
    node.innerHTML = html;
  }

  // ── tab 切换 ────────────────────────────────────────────────────────────
  for (const t of $$('.mv-tab')) {
    const h = () => {
      for (const x of $$('.mv-tab')) x.classList.toggle('is-on', x === t);
      for (const p of $$('.mv-pane')) p.dataset.hidden = p.dataset.pane === t.dataset.tab ? '0' : '1';
      if (t.dataset.tab === 'lib') refreshAll();
      if (t.dataset.tab === 'idn') refreshIdentity();
      if (t.dataset.tab === 'rank') refreshRank();
      if (t.dataset.tab === 'graph') syncGraphTheme();
      // 真判页**不自动跑**：它会出境 + 花 LLM 调用。进页面只把"上一次判定"的日志回填，
      // 要不要跑由人点。默认自动跑的话，切个 tab 就等于偷偷发了一次请求。
      if (t.dataset.tab === 'judge') refreshJudgeLast();
    };
    t.addEventListener('click', h);
    cleanups.push(() => t.removeEventListener('click', h));
  }

  // ── 配置读写 ────────────────────────────────────────────────────────────
  function collect() {
    const out = {};
    for (const el of $$('[data-key]')) {
      const k = el.dataset.key;
      if (el.type === 'checkbox') out[k] = el.checked;
      else if (NUMERIC.has(k)) {
        const n = Number(el.value);
        out[k] = Number.isFinite(n) ? n : 0;
      } else out[k] = el.value;
    }
    return out;
  }

  async function saveSettings() {
    const note = $('#mv-save-note');
    const patch = collect();
    try {
      await ctx.save(patch);
      say(note, 'good', '✅ 已保存');
      return true;
    } catch (e) {
      say(note, 'bad', `❌ 保存失败：${esc(e?.message || e)}`);
      return false;
    }
  }

  const saveBtn = $('#mv-save');
  if (saveBtn) {
    const h = async () => saveSettings();
    saveBtn.addEventListener('click', h);
    cleanups.push(() => saveBtn.removeEventListener('click', h));
  }

  // ── 「用宿主端点预填」──────────────────────────────────────────────────
  {
    const btn = $('#mv-prefill');
    const note = $('#mv-prefill-note');
    const h = async () => {
      note.textContent = '读取中…';
      const r = await req(ctx, '/api/memory-vec/status');
      const preset = r?.preset;
      if (!preset) {
        note.textContent = '没读到宿主的端点配置（可以手动填）';
        return;
      }
      const bu = $('#mv-embedBaseURL');
      if (bu && !bu.value) bu.value = preset.baseURL || '';
      const mk = $('#mv-embedApiKey');
      if (mk && preset.apiKeyPresent && !mk.value) mk.value = preset.apiKey || '';
      note.textContent = `来自「${preset.displayName || '宿主 provider'}」${preset.apiKeyPresent ? '（Key 已带上）' : '（宿主那边没存 Key，需要手填）'}`;
    };
    btn?.addEventListener('click', h);
    cleanups.push(() => btn?.removeEventListener('click', h));
  }

  // ── 测试连通（真发一次嵌入请求）────────────────────────────────────────
  {
    const btn = $('#mv-ping');
    const note = $('#mv-save-note');
    const h = async () => {
      await saveSettings();
      btn.disabled = true;
      note.textContent = '正在测试…';
      const r = await req(ctx, '/api/memory-vec/search', {
        method: 'POST',
        body: JSON.stringify({ q: '连通性测试', k: 1 })
      });
      btn.disabled = false;
      if (r?.ok) say(note, 'good', `✅ 端点可用，返回 ${r.dim} 维向量（扫描 ${r.scanned} 条）。${r.scanned === 0 ? '库还是空的，去「更新记忆」跑一轮。' : ''}`);
      else say(note, 'bad', `❌ ${esc(r?.error || '未知错误')}`);
    };
    btn?.addEventListener('click', h);
    cleanups.push(() => btn?.removeEventListener('click', h));
  }

  // ── 库状态 ──────────────────────────────────────────────────────────────
  let statusCache = null;
  let page = { offset: 0, limit: 20 };

  // 「按人 / 按标签查」的状态。
  // `rcKindCounts` 来自 `/status` 的 `facts.by_kind` —— 用**库里实际有的标签**画选项，
  // 而不是把 `FACT_KINDS` 抄一份到前端：抄一份就会漂移，而漂移的表现是"点了一个永远空的标签"。
  // 中文名是**界面层**的事，不往回塞进 core（同 `web/person.js` 的口径）。
  const KIND_CN = {
    trait: '档案', preference: '偏好', promise: '承诺', event: '事件', topic: '话题',
    joke: '梗', grudge: '芥蒂', pattern: '说话方式', speaker_profile: '画像'
  };
  const rcKinds = new Set();
  let rcKindCounts = {};

  function renderCards(s) {
    const el = $('#mv-cards');
    if (!el || !s) return;
    const st = s.store || {};
    const cards = [
      ['已索引', `${st.alive ?? 0}`, `核心共 ${s.core?.chunkCount ?? 0} 个块`],
      ['覆盖率', pct(s.coverage), s.coverage >= 0.999 ? '全部已索引' : '还有块没索引'],
      ['维度', st.dim ?? '—', st.model ? `模型 ${st.model}` : '还没锁定'],
      ['待回收', `${st.deleted ?? 0}`, '删除后的空槽'],
      ['磁盘', fmtBytes(st.bytesTotal), `bin ${fmtBytes(st.bytes?.bin)}`],
      ['会话数', `${s.core?.chats ?? 0}`, '小时块覆盖的会话']
    ];
    el.innerHTML = cards.map(([label, val, sub]) => `
      <div class="mv-card"><span>${esc(label)}</span><b>${esc(val)}</b><span>${esc(sub)}</span></div>`).join('');
  }

  function renderJob(s) {
    const note = $('#mv-job-note');
    if (!note) return;
    const j = s.indexJob;
    if (j?.running) {
      const t = j.total ? ` ${j.done ?? 0}/${j.total}` : '';
      note.innerHTML = `<span class="mv-spin"></span> 索引中：${esc(j.phase)}${t}`;
      return;
    }
    const li = s.lastIndex;
    if (li) {
      note.textContent = `上次索引 ${fmtTime(li.at)}：扫描 ${li.scanned}，写入 ${li.embedded}，跳过 ${li.skipped}，坏块 ${li.broken}（耗时 ${li.ms}ms）`;
    } else {
      note.textContent = '还没跑过索引';
    }
  }

  async function refreshAll() {
    const r = await req(ctx, '/api/memory-vec/status');
    statusCache = r;
    if (!r?.ok) {
      // 去缝后数据面在**独立服务**里（默认 127.0.0.1:8088），不再依赖核心标记块。
      // 所以最常见的原因从"缝没打 / 没重启"变成了"服务没启动"。
      const isOffline = r?.__offline === true;
      for (const b of bootNotes) {
        say(b.el, 'bad', isOffline
          ? `连不上向量记忆库服务 <code>${esc(r?.__base || '')}</code>。<br>
             数据面是<b>外接</b>的独立服务：到 vec-memory 仓根目录双击
             <code>启动-向量记忆库服务.bat</code> 启动它——那是唯一的启动器；<br>
             如果服务在别的端口/机器，把「设置 → 向量记忆库」里的<b>服务地址</b>改成实际地址。<br>
             <span class="mv-sub">原始错误：${esc(r?.error || '无')}</span>`
          : `读不到库状态：${esc(r?.error || '未知错误')}`);
      }
      return;
    }
    patched = true;
    const bootMsg = `
      <b>M0 · 只读观测</b> —— 这一版只做「看见」，不做「注入」。索引默认不会自动跑，也不会进提示词。<br>
      数据落在 <code>${esc(r.store?.dir || '')}</code>，核心的记忆文件一个字都没动（想撤销：删掉这个目录即可）。`;
    say($('#mv-boot-note'), '', bootMsg);
    say($('#mv-lib-boot'), 'good', bootMsg);
    renderCards(r);
    renderJob(r);
    // 标签选项取自库里的**实际**分布（`facts.by_kind`）：没记过这个类，就不该出现这个按钮。
    rcKindCounts = (r.facts && r.facts.by_kind) || {};
    renderRcKinds();
    if (r.core?.chunkCount === 0) {
      say($('#mv-lib-boot'), 'warn', bootMsg + '<br>⚠️ 没有读到任何核心小时块，索引会无从下手。确认宿主的 <code>data/memory-v2/chunks/</code> 里有内容。');
    }
    await loadList();
  }

  async function loadList() {
    const listEl = $('#mv-list');
    const pagerEl = $('#mv-pager');
    if (!listEl) return;
    const q = encodeURIComponent($('#mv-fq')?.value || '');
    const chat = encodeURIComponent($('#mv-fchat')?.value || '');
    const r = await req(ctx, `/api/memory-vec/items?offset=${page.offset}&limit=${page.limit}&q=${q}&chatKey=${chat}`);
    if (!r?.ok) {
      listEl.innerHTML = `<div class="mv-note bad">读列表失败：${esc(r?.error || '未知错误')}</div>`;
      pagerEl.innerHTML = '';
      return;
    }

    // 会话过滤器（只在第一次或数据变了时重建，避免抖动）
    const sel = $('#mv-fchat');
    if (sel && r.chats && sel.dataset.count !== String(r.chats.length)) {
      const cur = sel.value;
      sel.innerHTML = `<option value="">全部会话</option>` +
        r.chats.map((c) => `<option value="${esc(c.chatKey)}">${esc(c.chatKey)}（${c.count}）</option>`).join('');
      sel.value = cur;
      sel.dataset.count = String(r.chats.length);
    }

    if (!r.items.length) {
      listEl.innerHTML = `<div class="mv-note">库里还没有数据。去上面点「索引（增量）」跑一轮 —— 前提是嵌入端点已经填好并通过了连通测试。</div>`;
      pagerEl.innerHTML = '';
      return;
    }

    listEl.innerHTML = `
      <table class="mv-table">
        <thead><tr><th>标题 / 摘要</th><th>会话</th><th>时间</th><th class="num">用量</th><th></th></tr></thead>
        <tbody>
        ${r.items.map((it) => `
          <tr>
            <td><div class="mv-clip" title="${esc(it.title)}">${esc(it.title || it.id)}</div>
                <div class="mv-clip mv-sub" style="max-width:460px" title="${esc(it.text)}">${esc(it.text || '')}</div></td>
            <td class="mono">${esc(it.chatKey || '')}</td>
            <td class="mono">${esc(fmtTime(it.when))}</td>
            <td class="num">${it.truncated ? `<span title="原文 ${it.fullChars} 字，只用了 ${it.usedChars} 字">${it.usedChars}/${it.fullChars}</span>` : esc(it.usedChars ?? '')}</td>
            <td class="num">
              <button class="mv-btn" data-open="${esc(it.id)}" type="button">详情</button>
              <button class="mv-btn danger" data-del="${esc(it.id)}" type="button">删</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    const from = r.offset + 1;
    const to = Math.min(r.offset + r.limit, r.total);
    pagerEl.innerHTML = `
      <button class="mv-btn" id="mv-prev" type="button"${r.offset <= 0 ? ' disabled' : ''}>上一页</button>
      <span>${from}–${to} / 共 ${r.total}</span>
      <button class="mv-btn" id="mv-next" type="button"${to >= r.total ? ' disabled' : ''}>下一页</button>`;

    $('#mv-prev')?.addEventListener('click', () => { page.offset = Math.max(0, page.offset - page.limit); loadList(); });
    $('#mv-next')?.addEventListener('click', () => { page.offset += page.limit; loadList(); });
    for (const b of listEl.querySelectorAll('[data-open]')) {
      b.addEventListener('click', () => openDetail(b.dataset.open));
    }
    for (const b of listEl.querySelectorAll('[data-del]')) {
      b.addEventListener('click', () => doDelete(b.dataset.del));
    }
  }

  async function doDelete(id) {
    const drawer = $('#mv-drawer');
    if (!window.confirm(`确定从库里删掉这条向量？\n\n${id}\n\n注意：只删向量副本，核心的小时块没动 —— 下次索引会把它加回来。`)) return;
    const r = await req(ctx, '/api/memory-vec/delete', { method: 'POST', body: JSON.stringify({ id }) });
    if (r?.ok) {
      if (drawer) drawer.dataset.hidden = '1';
      await refreshAll();
    } else {
      window.alert(`删除失败：${r?.error || '未知错误'}`);
    }
  }

  async function openDetail(id) {
    const drawer = $('#mv-drawer');
    if (!drawer) return;
    drawer.dataset.hidden = '0';
    drawer.innerHTML = `<span class="mv-spin"></span> 读取 ${esc(id)}…`;
    const r = await req(ctx, `/api/memory-vec/item/${encodeURIComponent(id)}`);
    if (!r?.ok) {
      drawer.innerHTML = `<div class="mv-note bad">${esc(r?.error || '读取失败')}</div>`;
      return;
    }
    const m = r.meta || {};
    const vp = r.vectorPreview || {};
    drawer.innerHTML = `
      <div class="mv-row" style="justify-content:space-between;margin-bottom:10px">
        <h4 style="margin:0;font-size:13px">${esc(m.title || id)}</h4>
        <button class="mv-btn" id="mv-close" type="button">关闭</button>
      </div>
      <dl class="mv-kv" style="margin-bottom:14px">
        <dt>块 id</dt><dd class="mono">${esc(id)}</dd>
        <dt>会话 / 时段</dt><dd>${esc(m.chatKey || '—')} · ${esc(m.hourKey || '—')}</dd>
        <dt>时间</dt><dd>${esc(fmtTime(m.when))}</dd>
        <dt>向量</dt><dd>${vp.dim || 0} 维 · 模长 ${vp.norm ?? '—'} · 前几维 [${(vp.head || []).join(', ')}${vp.dim > 12 ? ', …' : ''}]</dd>
        <dt>索引时间</dt><dd>${esc(fmtTime(m.indexedAt))}</dd>
        <dt>源哈希</dt><dd class="mono">${esc(m.sourceHash || '—')}</dd>
      </dl>

      <h4 style="font-size:12.5px;margin:0 0 5px">实际送去向量化的文本
        <span class="mv-sub">${r.usedChars} 字${r.truncated ? `（原文 ${r.fullChars} 字，截掉了 ${r.fullChars - r.usedChars} 字）` : '（未截断）'}</span></h4>
      <div class="mv-pre">${esc(r.usedText || '（空）')}</div>

      <h4 style="font-size:12.5px;margin:14px 0 5px">核心原始块摘要
        <span class="mv-sub">${r.coreError ? `读不到：${esc(r.coreError)}` : '（前 4000 字）'}</span></h4>
      <div class="mv-pre">${esc(r.coreChunk?.summary || '（无）')}</div>

      <h4 style="font-size:12.5px;margin:14px 0 5px">最近邻
        <span class="mv-sub">这条记忆在向量空间里离谁最近</span></h4>
      <div id="mv-nb"><span class="mv-spin"></span> 计算中…</div>`;

    $('#mv-close')?.addEventListener('click', () => { drawer.dataset.hidden = '1'; });

    const nb = await req(ctx, `/api/memory-vec/neighbors/${encodeURIComponent(id)}?k=8`);
    const nbEl = $('#mv-nb');
    if (!nbEl) return;
    if (!nb?.ok) {
      nbEl.innerHTML = `<div class="mv-note bad">${esc(nb?.error || '取最近邻失败')}</div>`;
      return;
    }
    if (!nb.hits.length) {
      nbEl.innerHTML = `<div class="mv-note">这是库里唯一一条，没有邻居可算。</div>`;
      return;
    }
    nbEl.innerHTML = `
      <table class="mv-table">
        <thead><tr><th>相似度</th><th>标题</th><th>会话</th><th>时间</th></tr></thead>
        <tbody>${nb.hits.map((h) => `
          <tr><td style="width:120px"><div class="mv-row"><span class="mono">${h.score.toFixed(4)}</span>
            <div class="mv-bar" style="flex:1"><i style="width:${Math.max(2, h.score * 100).toFixed(1)}%"></i></div></div></td>
            <td><div class="mv-clip" title="${esc(h.title)}">${esc(h.title || h.id)}</div></td>
            <td class="mono">${esc(h.chatKey || '')}</td>
            <td class="mono">${esc(fmtTime(h.when))}</td></tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── 搜索 ────────────────────────────────────────────────────────────────
  async function doSearch() {
    const out = $('#mv-search-out');
    const note = $('#mv-search-note');
    const q = $('#mv-q')?.value?.trim();
    if (!q) { say(note, '', '先输入点什么'); return; }
    note.textContent = '搜索中…';
    out.innerHTML = '';
    const r = await req(ctx, '/api/memory-vec/search', { method: 'POST', body: JSON.stringify({ q, k: 10 }) });
    if (!r?.ok) { say(note, 'bad', `❌ ${esc(r?.error || '搜索失败')}`); return; }
    note.textContent = `扫描 ${r.scanned} 条，返回 ${r.hits.length} 条`;

    const d = r.distribution || {};
    const j = r.judgment || { checks: [] };
    const hist = (d.buckets || []);
    const maxC = Math.max(1, ...hist.map((b) => b.count));
    out.innerHTML = `
      <div class="mv-note ${j.ok ? 'good' : 'warn'}">
        <b>这次查询的分辨力</b>：档数 ${d.tiers}，极差 ${Number(d.range ?? 0).toFixed(4)}，前十名里 ${d.topTiers} 档。
        ${j.ok ? '分数分得开，排序可信。' : '分数挤在一起 —— 排序接近随机，别把名次当回事。'}
        <div class="mv-hist">${hist.map((b) => `<div style="height:${Math.round((b.count / maxC) * 100)}%" title="第${b.from}–${b.to}名：${b.count} 条"></div>`).join('')}</div>
      </div>
      <table class="mv-table">
        <thead><tr><th style="width:130px">相似度</th><th>标题 / 摘要</th><th>会话</th><th>时间</th></tr></thead>
        <tbody>${r.hits.map((h) => `
          <tr>
            <td><div class="mv-row"><span class="mono">${h.score.toFixed(4)}</span>
              <div class="mv-bar" style="flex:1"><i style="width:${Math.max(2, h.score * 100).toFixed(1)}%"></i></div></div></td>
            <td><div class="mv-clip" title="${esc(h.title)}">${esc(h.title || h.id)}</div>
                <div class="mv-clip mv-sub" style="max-width:420px">${esc(h.text || '')}</div></td>
            <td class="mono">${esc(h.chatKey || '')}</td>
            <td class="mono">${esc(fmtTime(h.when))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${r.hits.length ? `<div class="mv-sub" style="margin-top:8px">库里只有这些 —— 搜索范围是整个库，不是当前页。</div>` : ''}`;
  }

  // ── 按人 / 按标签查（长期 + 近期两段）───────────────────────────────────
  //
  // 为什么不复用一个搜索框：`/search` 是**纯向量检索**，它只认识小时块；
  // 长期事实在 `slots.jsonl` 里，**从没进过向量空间**。硬合成一个列表，
  // 就会让人拿"余弦 0.62"和"关键词重合 0.9"比大小 —— 那是两个量纲。
  function renderRcKinds() {
    const box = $('#mv-rc-kinds');
    if (!box) return;
    const keys = Object.keys(rcKindCounts).sort((a, b) => (rcKindCounts[b] - rcKindCounts[a]) || a.localeCompare(b));
    if (!keys.length) {
      box.innerHTML = '<span class="mv-sub">库里还没有事实槽（长期记忆为空）—— 先确认注入/写入是开着的，或者先在聊天里让它记点东西。</span>';
      return;
    }
    const onStyle = 'border-color:currentColor;font-weight:600;';
    const base = 'padding:4px 10px;font-size:12px;';
    box.innerHTML =
      `<button class="mv-btn" type="button" data-kind="" style="${base}${rcKinds.size ? '' : onStyle}">全部</button>`
      + keys.map((k) => `<button class="mv-btn" type="button" data-kind="${esc(k)}" `
        + `style="${base}${rcKinds.has(k) ? onStyle : ''}">${esc(KIND_CN[k] || k)} `
        + `<span class="mv-sub">${rcKindCounts[k]}</span></button>`).join('');
  }

  async function doRecall() {
    const out = $('#mv-rc-out');
    const note = $('#mv-rc-note');
    if (!out) return;
    const who = $('#mv-rc-who')?.value?.trim() || '';
    const kinds = [...rcKinds].join(',');
    note.textContent = '查…';
    const qs = new URLSearchParams({ k: '8' });
    if (who) qs.set('who', who);
    if (kinds) qs.set('kinds', kinds);
    const r = await req(ctx, `/api/memory-vec/recall?${qs.toString()}`);
    if (!r?.ok) {
      note.textContent = '';
      out.innerHTML = `<div class="mv-note bad">❌ ${esc(r?.error || '查询失败')}${
        r?.__http === 404
          ? '<br>这个服务还没有 <code>/recall</code> —— 要重启的是<b>服务进程</b>（重载插件只会探活，不会换代码）。'
          : ''}</div>`;
      return;
    }

    const lt = r.longTerm || { items: [], total: 0 };
    const rc = r.recent || { items: [], mode: '' };
    const when = (v) => (v ? fmtTime(typeof v === 'number' ? v : Date.parse(v)) : '—');

    if (r.found === false) {
      note.textContent = '';
      out.innerHTML = `<div class="mv-note warn">${esc(r.reason || '认不出这个人')}</div>`;
      return;
    }
    note.textContent = `长期 ${lt.total} 条 · 近期 ${rc.items.length} 条`;

    const ltRows = (lt.items || []).map((x) => `
      <tr>
        <td><span class="mv-sub">${esc(KIND_CN[x.kind] || x.kind)}</span></td>
        <td>${esc(x.line || '')}</td>
        <td class="mono">${esc(x.scope || '')}</td>
        <td class="num">${esc(String(x.evidence_n ?? ''))}</td>
        <td class="mono">${esc(when(x.updatedAt))}</td>
      </tr>`).join('');

    const rcRows = (rc.items || []).map((x) => `
      <tr>
        <td class="mono">${x.score != null ? Number(x.score).toFixed(4) : '—'}</td>
        <td><div class="mv-clip" title="${esc(x.title)}">${esc(x.title || x.id)}</div>
            <div class="mv-clip mv-sub" style="max-width:420px">${esc(x.text || '')}</div></td>
        <td class="mono">${esc(x.chatKey || '')}</td>
        <td class="mono">${esc(when(x.when))}</td>
      </tr>`).join('');

    out.innerHTML = `
      <div class="mv-note">
        <b>长期</b> ${lt.total} 条${lt.entries && lt.entries !== lt.total ? `（展开 ${lt.entries} 条）` : ''}
        · <b>近期</b> ${rc.items.length} 条（模式 <code>${esc(rc.mode || '—')}</code>）
        ${rc.degraded ? `<br>⚠️ 近期段降级：${esc(rc.degraded.reason)}` : ''}
      </div>
      ${ltRows ? `<h4 style="margin:12px 0 6px">长期（结构化事实）</h4>
      <table class="mv-table">
        <thead><tr><th style="width:70px">标签</th><th>内容</th><th style="width:110px">场合</th><th style="width:50px">证据</th><th style="width:130px">记录时间</th></tr></thead>
        <tbody>${ltRows}</tbody>
      </table>` : ''}
      ${rcRows ? `<h4 style="margin:14px 0 6px">近期（聊天块）</h4>
      <table class="mv-table">
        <thead><tr><th style="width:90px">相似度</th><th>标题 / 摘要</th><th style="width:110px">会话</th><th style="width:130px">时间</th></tr></thead>
        <tbody>${rcRows}</tbody>
      </table>` : ''}
      ${!ltRows && !rcRows ? '<div class="mv-sub">两段都空 —— 换个标签、换个人，或者那个人确实还没被记过。</div>' : ''}
      <div class="mv-sub" style="margin-top:8px">${esc(r.note || '')}</div>`;
  }

  // ── 索引与维护 ──────────────────────────────────────────────────────────
  let jobTimer = null;

  async function doIndex(force) {
    const note = $('#mv-job-note');
    const btns = ['#mv-index', '#mv-index-force'].map((s) => $(s));
    btns.forEach((b) => { if (b) b.disabled = true; });
    note.innerHTML = `<span class="mv-spin"></span> 已提交，正在跑第一轮…`;
    // 索引可能是分钟级的，起一个轮询把进度显示出来
    jobTimer = setInterval(async () => {
      const s = await req(ctx, '/api/memory-vec/status');
      if (s?.ok) renderJob(s);
    }, 1500);
    cleanups.push(() => clearInterval(jobTimer));

    const r = await req(ctx, '/api/memory-vec/index', { method: 'POST', body: JSON.stringify({ force: Boolean(force) }) });
    clearInterval(jobTimer);
    btns.forEach((b) => { if (b) b.disabled = false; });

    if (!r?.ok) {
      say(note, 'bad', `❌ 索引失败：${esc(r?.error || '未知错误')}`);
      return;
    }
    say(note, r.broken > 0 ? 'warn' : 'good',
      `✅ 扫描 ${r.scanned} · 写入 ${r.embedded} · 跳过 ${r.skipped} · 坏块 ${r.broken}（${r.ms}ms）` +
      (r.broken > 0 ? `<br>坏块示例：${r.brokenList.slice(0, 3).map((b) => `${esc(b.id)}（${esc(b.error)}）`).join('；')}` : ''));
    await refreshAll();
  }

  async function doMaintenance(action, confirmWord) {
    const checks = $('#mv-checks');
    const r = await req(ctx, '/api/memory-vec/maintenance', { method: 'POST', body: JSON.stringify({ action, confirm: confirmWord }) });
    if (!r?.ok) { say(checks, 'bad', `❌ ${esc(r?.error || '操作失败')}`); return; }
    if (action === 'verify') {
      const v = r.result;
      say(checks, v.ok ? 'good' : 'bad', v.ok
        ? '✅ 落盘一致：bin 大小、meta 行数、id 映射三者相符。'
        : `❌ 发现不一致：<br>${v.problems.map(esc).join('<br>')}`);
      return;
    }
    if (action === 'compact') {
      say(checks, 'good', `✅ 压缩完成：回收 ${r.result.removed} 个空槽（${r.result.before} → ${r.result.after}）。`);
      await refreshAll();
      return;
    }
    if (action === 'reset') {
      say(checks, 'warn', '库已清空。核心记忆没动 —— 重新点「索引」就能再建一份。');
      page.offset = 0;
      await refreshAll();
    }
  }

  async function doSelfcheck() {
    const checks = $('#mv-checks');
    checks.innerHTML = `<span class="mv-spin"></span> 自检中…`;
    const r = await req(ctx, '/api/memory-vec/selfcheck', { method: 'POST' });
    if (!r?.ok) { say(checks, 'bad', `❌ 自检失败：${esc(r?.error || '未知错误')}`); return; }
    checks.innerHTML = `
      <table class="mv-table">
        <thead><tr><th style="width:26px"></th><th>项</th><th>结果</th></tr></thead>
        <tbody>${r.checks.map((c) => `
          <tr>
            <td>${c.pass === true ? '✅' : c.pass === null ? '➖' : '❌'}</td>
            <td>${esc(c.label)}</td>
            <td>${esc(c.detail)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  const wiring = [
    ['#mv-index', () => doIndex(false)],
    ['#mv-index-force', () => doIndex(true)],
    ['#mv-selfcheck', () => doSelfcheck()],
    ['#mv-compact', () => doMaintenance('compact')],
    ['#mv-reset', () => { if (window.confirm('清空整个记忆库？\n\n核心记忆不受影响，重新索引即可再建。')) doMaintenance('reset', 'RESET'); }],
    ['#mv-search', () => doSearch()],
    ['#mv-rc-go', () => doRecall()],
    ['#mv-reload', () => { page.offset = 0; loadList(); }]
  ];
  for (const [sel, fn] of wiring) {
    const el = $(sel);
    if (!el) continue;
    const h = (e) => { e.preventDefault(); fn(); };
    el.addEventListener('click', h);
    cleanups.push(() => el.removeEventListener('click', h));
  }
  {
    const q = $('#mv-q');
    const h = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
    q?.addEventListener('keydown', h);
    cleanups.push(() => q?.removeEventListener('keydown', h));
    const fq = $('#mv-fq');
    const h2 = () => { page.offset = 0; loadList(); };
    fq?.addEventListener('input', h2);
    cleanups.push(() => fq?.removeEventListener('input', h2));
    const fc = $('#mv-fchat');
    const hc = () => { page.offset = 0; loadList(); };
    fc?.addEventListener('change', hc);
    // 之前这里写的是 removeEventListener('change', h2) —— 注销的是另一个 handler，
    // 等于这个监听器永远摘不掉（面板每次重渲染就多挂一个）。顺手修掉。
    cleanups.push(() => fc?.removeEventListener('change', hc));

    // 标签芯片是 `innerHTML` 动态生成的 ⇒ 用**容器代理**，不给每个按钮挂 listener
    // （挂上去的那些在下次 innerHTML 覆盖时全成垃圾，而且 cleanups 里也收不回来）。
    const kbox = $('#mv-rc-kinds');
    const hk = (e) => {
      const b = e.target.closest('button[data-kind]');
      if (!b) return;
      const k = b.dataset.kind;
      if (!k) rcKinds.clear();
      else if (rcKinds.has(k)) rcKinds.delete(k);
      else rcKinds.add(k);
      renderRcKinds();
      doRecall();
    };
    kbox?.addEventListener('click', hk);
    cleanups.push(() => kbox?.removeEventListener('click', hk));

    const rcWho = $('#mv-rc-who');
    const hw = (e) => { if (e.key === 'Enter') { e.preventDefault(); doRecall(); } };
    rcWho?.addEventListener('keydown', hw);
    cleanups.push(() => rcWho?.removeEventListener('keydown', hw));
  }

  // ── 六维（Tab 4 · 影子）────────────────────────────────────────────────
  // 这一页存在的理由只有一句：**仪表必须先于算法**。
  // 打分函数写完，不能靠"我觉得它有分布"上线；要看的是真数据上每一维的
  // 档数 / 极差 / 打满比例 / 覆盖率，以及"死"的时候到底死于哪一种原因。

  let rankLast = null;

  async function refreshRank({ force = false, snapshot = true } = {}) {
    const boot = $('#mv-rank-boot');
    const note = $('#mv-rank-note');
    say(boot, '', '<span class="mv-spin"></span> 正在计算分数分布…');
    const r = await req(ctx,
      `/api/memory-vec/rank?${force ? 'force=1&' : ''}${snapshot ? '' : 'snapshot=0'}`);
    if (!r?.ok) {
      say(boot, 'bad', `跑不出分数分布：${esc(r?.error || '记忆服务未启动？')}`);
      return;
    }
    const d = r.dist || {};
    rankLast = r;
    say(boot, 'good', `扫了 <b>${d.n}</b> 个块（坏块 ${d.broken || 0}）· 实体键 <b>${d.inv?.entities ?? '—'}</b> 个 · 版本 <span class="mono">${esc(d.version || '')}</span>`);
    if (note) note.textContent = '';
    renderRankCards(d);
    renderRankTable(d);
    renderRankDiag(d);
    renderRankShadow(r.shadow || []);
    renderRankChecks(r.checks || []);
  }

  function renderRankCards(d) {
    const el = $('#mv-rank-cards');
    if (!el) return;
    const dims = d.dims || {};
    const canEnter = Object.entries(dims)
      .filter(([, v]) => v.n > 0 && v.ok).map(([k]) => k);
    const dead = Object.entries(dims)
      .filter(([, v]) => v.n > 0 && v.dead).map(([k]) => k);
    const none = Object.entries(dims)
      .filter(([, v]) => v.src === 'missing' && v.n === 0).map(([k]) => k);
    const sat = Object.entries(dims)
      .filter(([, v]) => v.n > 0 && v.atMaxShare >= 0.4).map(([k]) => k);
    const card = (label, val, hint) =>
      `<div class="mv-card"><span>${esc(label)}</span><b>${esc(String(val))}</b>${hint ? `<span class="mv-sub">${hint}</span>` : ''}</div>`;
    el.innerHTML = [
      card('样本块', d.n ?? 0, `坏块 ${d.broken || 0}`),
      card('够格进排序', canEnter.length ? canEnter.join(' ') : '0 个', '档数≥3 且极差>0.01'),
      card('是常数（dead）', dead.length ? dead.join(' ') : '无', dead.length ? '装了等于没装' : ''),
      card('无判定源', none.length ? none.join(' ') : '无', none.length ? '记为「不做」，不是 0' : ''),
      card('头部饱和', sat.length ? sat.join(' ') : '无', sat.length ? '≥40% 打满' : '')
    ].join('');
  }

  function renderRankTable(d) {
    const el = $('#mv-rank-table');
    if (!el) return;
    const dims = d.dims || {};
    const rows = Object.entries(dims).map(([k, v]) => {
      const verdict = v.n === 0 ? '<span class="mv-sub">无样本（不算通过）</span>'
        : v.ok ? '<b>过</b>' : '<span class="warn">不过</span>';
      const src = v.src === 'missing'
        ? '<span class="warn">missing</span>' : v.src === 'field' ? 'field' : 'derived';
      const sat = v.n > 0 && v.atMaxShare >= 0.4
        ? `<span class="warn">${pct(v.atMaxShare)}</span>` : (v.n ? pct(v.atMaxShare) : '—');
      return `<tr>
        <td class="mono">${esc(k)}</td>
        <td>${esc(v.label || '')}</td>
        <td class="mono">${src}</td>
        <td class="num">${v.n ?? 0}<span class="mv-sub">/${v.missing ?? 0}</span></td>
        <td class="num">${v.n ? pct(v.coverage) : '—'}</td>
        <td class="num">${v.n ? v.tiers : '—'}</td>
        <td class="num">${v.n ? Number(v.range).toFixed(4) : '—'}</td>
        <td class="num">${v.n ? v.topTiers : '—'}</td>
        <td class="num">${sat}</td>
        <td>${v.dead ? '<span class="warn">YES</span>' : '—'}</td>
        <td>${verdict}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="mv-table">
      <thead><tr>
        <th>维</th><th>名称</th><th>原料</th><th>n/missing</th><th>覆盖</th>
        <th>档数</th><th>极差</th><th>top档</th><th>打满</th><th>dead</th><th>判据</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" style="margin-top:8px"><b>n/missing</b> —— missing 是<b>计数</b>，不是 0 分。
    「没打过分」和「打了 0 分」在这里必须是两件事，否则覆盖率会看起来 100%、实际全是假的。</p>`;
  }

  function renderRankDiag(d) {
    const el = $('#mv-rank-diag');
    if (!el) return;
    const dims = d.dims || {};
    const blocks = [];
    for (const [k, v] of Object.entries(dims)) {
      if (v.deadReason) {
        blocks.push(`<div class="mv-note ${v.dead ? 'bad' : 'warn'}">
          <b>${esc(k)} · ${esc(v.label || '')}</b> —— ${esc(v.deadReason)}
          ${v.baseline ? `<br><span class="mv-sub">原料「${esc(v.baseline.key)}」：${v.baseline.distinct} 种取值，
            ${pct(v.baseline.modeShare)} 集中在 ${esc(String(v.baseline.mode))}</span>` : ''}
        </div>`);
      } else if (v.n > 0 && v.ok) {
        blocks.push(`<div class="mv-note good"><b>${esc(k)} · ${esc(v.label || '')}</b>
          —— 够格进 scoreOf（${esc(v.summary)}）</div>`);
      }
    }
    const verdict = Array.isArray(d.verdict) ? d.verdict : [];
    if (verdict.length) {
      blocks.push(`<div class="mv-note"><b>结论</b><ul style="margin:6px 0 0;padding-left:18px">${
        verdict.map((t) => `<li>${esc(String(t).replace(/\*\*/g, ''))}</li>`).join('')}</ul></div>`);
    }
    el.innerHTML = blocks.join('') || '<div class="mv-note">没有需要诊断的维度。</div>';
  }

  function renderRankShadow(list) {
    const el = $('#mv-rank-shadow');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="mv-note">还没有快照。点一次「重跑分布」就会记一条。</div>';
      return;
    }
    const recent = list.slice(-8);
    const rows = recent.map((s) => {
      const ds = s.dims || {};
      const cell = (k) => {
        const v = ds[k];
        if (!v) return '—';
        if (v.missing !== undefined && v.n === 0) return '<span class="warn">missing</span>';
        return `${v.tiers}档/${Number(v.range).toFixed(2)}${v.dead ? ' <span class="warn">dead</span>' : ''}`;
      };
      return `<tr>
        <td class="mono">${esc(fmtTime(s.at))}</td>
        <td class="num">${s.n ?? 0}</td>
        ${['S', 'D', 'E', 'R', 'I', 'C'].map((k) => `<td class="num">${cell(k)}</td>`).join('')}
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="mv-table">
      <thead><tr><th>时刻</th><th>块数</th><th>S</th><th>D</th><th>E</th><th>R</th><th>I</th><th>C</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="hint" style="margin-top:8px">共 ${list.length} 条快照，显示最近 ${recent.length} 条。
      每格是「档数 / 极差」—— <b>要看的不是某一行的形状，是这几行有没有变。</b></p>`;
  }

  function renderRankChecks(checks) {
    const el = $('#mv-rank-checks');
    if (!el || !checks.length) return;
    el.innerHTML = checks.map((c) => {
      const mark = c.pass === null ? '➖' : c.pass ? '✅' : '❌';
      const kind = c.pass === null ? '' : c.pass ? 'good' : 'bad';
      return `<div class="mv-note ${kind}">${mark} <b>${esc(c.label)}</b>
        <div class="mv-sub">${esc(c.detail || '')}</div></div>`;
    }).join('');
  }

  for (const [id, opts] of [
    ['mv-rank-run', { force: true, snapshot: false }],
    ['mv-rank-snap', { force: false, snapshot: true }]
  ]) {
    const btn = $(`#${id}`);
    if (!btn) continue;
    const h = () => refreshRank(opts);
    btn.addEventListener('click', h);
    cleanups.push(() => btn.removeEventListener('click', h));
  }

  // ── 真判（Tab 6 · M4 第二段）────────────────────────────────────────────
  // 这一页存在的理由跟别页不一样：**它是唯一会出境的一页**。
  // 索引出去的是"文本向量"，判官出去的是"文本本身" —— 所以这一页的第一职责不是"跑"，
  // 是**让人看清会送什么出去**。干跑存在的意义就是把"送什么"和"调不调模型"拆成两件事：
  // 不拆的话，人只有两个选择 —— 要么闭着眼跑，要么完全不跑。

  let judgeArm = 0;          // 真跑的两段式确认时间戳（0 = 未武装）
  let judgeArmTimer = null;

  /** 启发式残留扫描（**只显示，不参与任何判定**）：剥掉占位符后还剩什么"像明文"的串。 */
  function judgeResidue(text) {
    const t = String(text ?? '').replace(/〔[^〕]*〕/g, '');
    const ascii = [...t.matchAll(/[A-Za-z]{3,}/g)].map((m) => m[0]);
    const digits = [...t.matchAll(/\d{5,}/g)].map((m) => m[0]);
    return [...new Set([...ascii, ...digits])];
  }

  function renderJudgeFunnel(corpus, obs, triggered) {
    const el = $('#mv-judge-funnel');
    if (!el) return;
    const c = corpus || {};
    const cs = c.clusterStats || {};
    const card = (label, val, hint) =>
      `<div class="mv-card"><span>${esc(label)}</span><b>${esc(String(val ?? '—'))}</b>${hint ? `<span class="mv-sub">${hint}</span>` : ''}</div>`;
    el.innerHTML = [
      card('存档总数', c.archivedTotal ?? '—', '整库条目'),
      card('取窗口', c.windowSize ?? '—', '尾部 N 条'),
      card('归一化成功', c.normalized ?? '—', `拒收 ${(c.windowSize ?? 0) - (c.normalized ?? 0)} 条（闸门抛）`),
      card('过句长下限', (cs.input ?? 0) - (cs.droppedByFloor ?? 0), `掉 ${cs.droppedByFloor ?? 0} 条`),
      card('簇', cs.clusters ?? '—', `分组 ${cs.groups ?? 0}`),
      card('其中口头禅', cs.verbatimClusters ?? '—', '逐字相同 → 单列'),
      card('触发判定', triggered ?? '—', '同窗口 ≥N 条')
    ].join('');
    const note = $('#mv-judge-funnel-note');
    if (note) {
      note.innerHTML = obs?.fragmentExemplarClusters != null
        ? `<p class="hint">触发簇里<b>疑似符号残片</b>（简谱 / 表情码之类）的簇数：<b>${obs.fragmentExemplarClusters}</b>。
           <b>只计数、不干预判定</b> —— 回头翻 <code>ambiguous</code> 有多少是这一类贡献的，靠的是这个数。</p>`
        : '';
    }
  }

  function renderJudgeFields(fieldsSent) {
    const el = $('#mv-judge-fields');
    if (!el) return;
    const f = Array.isArray(fieldsSent) ? fieldsSent : [];
    el.innerHTML = `<div class="mv-pre">${esc(f.join('\n'))}</div>
      <p class="hint" style="margin-top:8px">共 <b>${f.length}</b> 个字段。身份字段只有
      <code>speaker</code> / <code>target</code> / <code>scope</code> —— 全是占位符 token。</p>`;
  }

  function renderJudgeOutbound(outbound, results) {
    const el = $('#mv-judge-outbound');
    if (!el) return;
    let recs = [];
    try { recs = JSON.parse(String(outbound?.user ?? '[]')); } catch { recs = []; }
    if (!recs.length) { el.innerHTML = '<div class="mv-note">没有触发簇（模拟运行也不会送任何东西出去）。</div>'; return; }
    const byIdx = new Map((results || []).map((r) => [r.idx, r]));
    const rows = recs.map((r) => {
      const res = byIdx.get(r.idx);
      const residue = judgeResidue(r.exemplar);
      const rt = residue.length
        ? `<span class="warn">${esc(residue.slice(0, 4).join(' '))}</span>${residue.length > 4 ? `…+${residue.length - 4}` : ''}`
        : '<span class="mv-sub">—</span>';
      // 这一列照抄 `OUTBOUND_FIELDS` —— 表里有什么，判官就看到什么。
      // `verbatim` = 该簇是否与上文逐字相同（口头禅），是判定的一路输入。
      const verdict = res
        ? `${esc(res.patternType || '')}${res.degraded ? `<span class="mv-sub">/${esc(res.degraded)}</span>` : ''}`
        : '<span class="mv-sub">（待判）</span>';
      return `<tr>
        <td class="num">${esc(r.idx)}</td>
        <td class="mono">${esc(r.speaker || '')}</td>
        <td class="num">${esc(r.size ?? '')}</td>
        <td>${r.verbatim ? '是' : '否'}</td>
        <td>${verdict}</td>
        <td>${rt}</td>
        <td>${esc(String(r.exemplar ?? '').slice(0, 90))}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="mv-table">
      <thead><tr><th>idx</th><th>speaker</th><th>size</th><th>口头禅</th><th>判定</th><th>疑似残留</th><th>exemplar（判官看到的样子）</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" style="margin-top:8px">表头就是 <code>OUTBOUND_FIELDS</code> 白名单本身
    （<code>idx / speaker / target / scope / size / verbatim / spanMs / exemplar</code>，后四个是身份与规模字段）。<br>
    ⚠️ <b><code>self_n</code> 不在这里</b> —— "这个簇里有多少条是宿主账号自己发的"是<b>本地标注</b>
    （<code>ADR-0019</code> 观察项 #5：机器人回复与主人手打共用同一身份，所以<b>只标注、不排除</b>），
    它只落进槽的分析字段（<code>facts/slots.jsonl</code> 的 <code>content.self_n</code>），
    <b>不随判定出境</b>，本页也就不显示它 —— 摆出来会让人以为它也被送出去了。</p>`;
  }

  function renderJudgeResults(results) {
    const el = $('#mv-judge-results');
    if (!el) return;
    const rs = Array.isArray(results) ? results : [];
    if (!rs.length) {
      el.innerHTML = '<div class="mv-note">还没判过。点上面的「模拟运行」或「正式判定」。</div>';
      return;
    }
    const dist = {};
    for (const r of rs) dist[r.patternType] = (dist[r.patternType] || 0) + 1;
    const distCards = Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<div class="mv-card"><span>${esc(k)}</span><b>${v}</b><span class="mv-sub">${pct(v / rs.length)}</span></div>`)
      .join('');
    const degraded = rs.filter((r) => r.degraded).length;
    const factsN = rs.reduce((s, r) => s + (r.facts?.length || 0), 0);
    el.innerHTML = `<div class="mv-grid">${distCards}</div>
      <div class="mv-kv">
        <dt>判了</dt><dd>${rs.length} 条</dd>
        <dt>抽到事实</dt><dd>${factsN} 条${factsN === 0 ? ' —— 本批只有 patterns（语用段），没抽到可落事实，<b>不是失败</b>' : ''}</dd>
        <dt>降级</dt><dd>${degraded} 条${degraded ? '（模型回了但值域不在枚举内 ⇒ 降级为 ambiguous 并留痕）' : ''}</dd>
      </div>
      <p class="hint" style="margin-top:8px">判定口径说明：<b>"没判成"不会出现在这张表里</b> ——
      整批跳过（超时 / 速率 / 格式坏）走的是另一条路，不写 <code>ambiguous</code>。
      否则"模型说它不确定"和"模型这次没答"会被记成同一件事。</p>`;
  }

  function renderJudgeApplied(r) {
    const el = $('#mv-judge-applied');
    if (!el) return;
    if (r?.dryRun) {
      el.innerHTML = `<div class="mv-note warn">这是<b>模拟运行</b> —— 没有落库（真值不被桩数据污染）。要真正判定请点「正式判定」。</div>`;
      return;
    }
    const a = r?.applied;
    if (!a) { el.innerHTML = '<div class="mv-note">这一轮没有落库（跳过或未跑正式判定）。</div>'; return; }
    el.innerHTML = `<div class="mv-kv">
      <dt>pattern 写入</dt><dd>${a.pattern} 次<b>（语用段独立表）</b></dd>
      <dt>事实写入</dt><dd>${a.facts} 条</dd>
      <dt>重复（noop）</dt><dd>${a.noop} 次 —— 同一键同内容再写一次，被指纹判为无变化</dd>
      <dt>落盘位置</dt><dd class="mono">memory-vec/facts/slots.jsonl（append-only）</dd>
    </div>
    <p class="hint" style="margin-top:8px">同一个说话人的多条 pattern 打的是<b>同一个键</b>
    （<code>speaker+target+fact_kind+scope</code>），append-only 逐次落行、<code>rev</code> 递增
    ⇒ <b>写入次数会多于唯一槽数</b>。这不是重复计算，是"同一个槽被改了 N 次"。</p>`;
  }

  function renderJudgeLog(log) {
    const el = $('#mv-judge-log');
    if (!el) return;
    el.textContent = log ? JSON.stringify(log, null, 1) : '（还没有跑过）';
  }

  async function refreshJudgeLast() {
    const r = await req(ctx, '/api/memory-vec/status');
    if (!r?.ok) return;
    if (r.lastJudge) renderJudgeLog(r.lastJudge);
  }

  async function runJudge({ dryRun }) {
    const note = $('#mv-judge-note');
    const boot = $('#mv-judge-boot');
    const dryBtn = $('#mv-judge-dry');
    const runBtn = $('#mv-judge-run');
    const limit = Math.max(500, Math.min(60_000, Number($('#mv-judge-limit')?.value) || 15_000));

    // 真跑 = 写盘 + 花 LLM 调用 ⇒ 两段式确认。
    // 不做"弹个 confirm 就放行"：那个确认框会被肌肉记忆点掉，而这一步会真写盘。
    if (!dryRun) {
      if (Date.now() - judgeArm > 10_000) {
        judgeArm = Date.now();
        if (runBtn) { runBtn.textContent = '再点一次＝真的写盘'; runBtn.classList.add('danger'); }
        say(note, 'warn',
          `会真调判官并把判定写进 <code>facts/slots.jsonl</code>（append-only，<b>不可撤回</b>）。` +
          `窗口取尾部 <b>${limit}</b> 条。10 秒内再点一次确认。`);
        clearTimeout(judgeArmTimer);
        judgeArmTimer = setTimeout(() => {
          if (Date.now() - judgeArm >= 10_000) {
            judgeArm = 0;
            if (runBtn) { runBtn.textContent = '正式判定（调用 LLM、写盘）'; runBtn.classList.remove('danger'); }
          }
        }, 10_100);
        return;
      }
      judgeArm = 0;
      clearTimeout(judgeArmTimer);
      if (runBtn) { runBtn.textContent = '正式判定（调用 LLM、写盘）'; runBtn.classList.remove('danger'); }
    }

    for (const b of [dryBtn, runBtn]) if (b) b.disabled = true;
    say(boot, '', `<span class="mv-spin"></span> ${dryRun ? '模拟运行中（不调用、不写盘）…' : '正式判定中（调用 LLM、写盘）…'}`);
    if (note) note.textContent = '';

    const path = `/api/memory-vec/judge?dryRun=${dryRun ? 1 : 0}&limit=${limit}`;
    const r = await req(ctx, path, { method: 'POST' });

    for (const b of [dryBtn, runBtn]) if (b) b.disabled = false;

    if (!r?.ok) {
      say(boot, 'bad', `跑不动：${esc(r?.error || '未知错误')}`);
      if (r?.skipped) say(note, 'warn', `跳过（${esc(r.reason || '')}）—— 这不是失败，是"这一轮不判"。`);
      renderJudgeLog(r?.log);
      return;
    }
    say(boot, 'good',
      `${dryRun ? '模拟运行' : '正式判定'}完成 · 触发 <b>${(r.results || []).length}</b> 条 · 用时 ${r.log?.elapsedMs ?? '—'}ms · ` +
      `目的地 <span class="mono">${esc(r.log?.endpointKind || '')}</span>`);
    renderJudgeFunnel(r.corpus, r.obs, (r.results || []).length);
    renderJudgeFields(r.outbound?.fieldsSent);
    renderJudgeOutbound(r.outbound, r.results);
    renderJudgeResults(r.results);
    renderJudgeApplied(r);
    renderJudgeLog(r.log);
  }

  for (const [id, dryRun] of [['mv-judge-dry', true], ['mv-judge-run', false]]) {
    const btn = $(`#${id}`);
    if (!btn) continue;
    const h = () => runJudge({ dryRun });
    btn.addEventListener('click', h);
    cleanups.push(() => btn.removeEventListener('click', h));
  }
  cleanups.push(() => clearTimeout(judgeArmTimer));

  // ── 关系星图（插件首页）──────────────────────────────────────────────
  // ⚠️ 这一页**不在这里画图**：星图整个归向量记忆库服务（`ADR-0013`）。
  // 分界线是「这一页要不要写宿主的配置」：其余 tab 要写 config.json、要用 ctx.save，
  // 只能在宿主 UI 里跑；星图是**纯数据可视化**（零配置写入），所以它搬进了服务。
  // 面板在这里只剩两件事：把服务那个页面嵌进来；服务缺席时说清楚"去哪儿启动它"。
  //
  // 为什么必须是 iframe、而不是自己拉数据画一遍：布局/投影/绘制是一整套东西，
  // 放两份必然漂移。放服务里，用浏览器直接打开 8088 就是同一张图。

  /** 宿主 UI 现在是什么主题 —— iframe 是独立文档，不继承宿主样式，只能问一句。 */
  function hostTheme() {
    try {
      const el = document.body || document.documentElement;
      const bg = getComputedStyle(el).backgroundColor || '';
      const m = /rgba?\((\s*\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg);
      if (m) {
        const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
        return lum > 0.5 ? 'light' : 'dark';
      }
    } catch { /* 读不到就按深色（深色是默认主题） */ }
    return 'dark';
  }

  async function mountGraph() {
    const boot = $('#mv-graph-boot');
    const holder = $('#mv-graph-frame');
    const off = $('#mv-graph-off');
    const open = $('#mv-graph-open');
    const base = serviceBase(ctx);
    if (open) open.href = `${base}/`;
    say(boot, '', '<span class="mv-spin"></span> 正在连接向量记忆库服务…');
    if (holder) holder.innerHTML = '';
    if (off) off.innerHTML = '';

    // 先探一次服务：离线就用自己的中文提示**替代** iframe ——
    // 否则 iframe 里会是浏览器的错误页，既没信息量也不可操作，用户只会以为"插件坏了"。
    // ⚠️ 判据在 `healthVerdict()` 里，**不要**在这里判 `ok` —— 见它上面的注释（2026-10-11 的误报就是它）。
    const probe = await probeService(ctx);
    if (!probe.alive) {
      say(boot, 'bad', probe.offline
        ? `连不上向量记忆库服务 <code>${esc(base)}</code>`
        : `服务回了错：${esc(probe.detail)}`);
      if (off) {
        // 两种"不活"要给两条不同的出路：**起服务**和**这里跑的不是它**，
        // 拿同一段"去双击启动器"去打发第二种，用户会照着做一遍然后更困惑。
        off.innerHTML = probe.offline
          ? `<div class="mv-note warn">
          星图由<b>向量记忆库服务自己</b>提供 —— 服务没起来就看不到它（这是外接模式的正常降级，不是插件坏了）。<br>
          到 vec-memory 仓根目录双击 <code>启动-向量记忆库服务.bat</code>，再点上面的「重新加载星图」。<br>
          <span class="mv-sub">服务在别的端口/机器？改「设置」页的<b>服务地址</b>（默认 <code>http://127.0.0.1:8088</code>）。</span>
        </div>`
          : `<div class="mv-note warn">
          服务在 <code>${esc(base)}</code> 上答了话，但答的不是它该答的（${esc(probe.detail)}）。<br>
          多半是<b>这个端口上跑着别的东西</b>，或者服务版本比面板旧。先在命令行看一眼它到底回的什么：
          <code>curl ${esc(base)}/health</code><br>
          <span class="mv-sub">服务在别的端口/机器？改「设置」页的<b>服务地址</b>（默认 <code>http://127.0.0.1:8088</code>）。</span>
        </div>`;
      }
      return;
    }

    const src = `${base}/?theme=${hostTheme()}`;
    if (holder) {
      holder.innerHTML = `<iframe id="mv-graph-iframe" src="${esc(src)}" title="关系星图"
        style="width:100%;height:min(74vh,780px);min-height:480px;border:1px solid var(--mv-line);border-radius:10px;display:block;background:transparent"></iframe>`;
    }
    // 连上时把**运行期事实**（库根）一起显示：双态/多副本并存时，"连上了"不等于"连对了那一个"。
    say(boot, 'good',
      `星图由服务提供（<code>${esc(base)}</code>${probe.detail ? ' · ' + esc(probe.detail) : ''}）· 与「在新窗口打开」是同一张图。`);
  }

  /** 主题跟随：面板换了主题，iframe 里那个文档不知道 ⇒ 用 postMessage 说一声。
   *  （不去读 iframe 内部样式：跨文档读会被同源策略拦，而且那属于动别人的页面。） */
  function syncGraphTheme() {
    const fr = $('#mv-graph-iframe');
    if (!fr) return;
    try { fr.contentWindow?.postMessage({ type: 'mv-theme', theme: hostTheme() }, '*'); } catch { /* 还没加载好就算了 */ }
  }

  {
    const btn = $('#mv-graph-refresh');
    if (btn) {
      const h = () => mountGraph();
      btn.addEventListener('click', h);
      cleanups.push(() => btn.removeEventListener('click', h));
    }
  }

  // ── 身份边界（Tab 3）────────────────────────────────────────────────────
  // 这一页只做三件事：把词表的**形状**摊开、把闸门**当场跑一遍**、把待审的词摆出来。
  // 它刻意不显示"占位符 ↔ 真名"的对照表 —— 那份对照是本机最敏感的资产，
  // 看得见的地方越少越好。

  async function refreshIdentity() {
    const boot = $('#mv-idn-boot');
    const r = await req(ctx, '/api/memory-vec/identity');
    if (!r?.ok) {
      say(boot, 'bad', `读不到脱敏信息：${esc(r?.error || '未知错误')}`);
      return;
    }
    const s = r.identity || {};
    say(boot, 'good', '脱敏名单已装载。以下是本机数据 —— 不随索引导出。');
    renderSelf(s);
    renderIdnCards(s);
    renderFresh(r.freshness);
    renderHorizon(r.horizon);
    renderPending(r.pending || []);
    refreshMerge();
  }

  // 词表新鲜度：判据的三个输入（装载时刻 / 别称签名 / 存档指纹）与结论一起摆出来。
  // 2026-10-11 的教训：判据少了"存档长没长"这个输入，6 小时落后无人察觉 —— 所以这一格
  // 必须把"输入"也露出来，让用户能核对判据本身，而不只是看一个结论。
  function renderFresh(f) {
    const el = $('#mv-idn-fresh');
    if (!el) return;
    if (!f) {
      el.innerHTML = `<div class="mv-sub">（服务版本较旧，没有新鲜度信息 —— 可无视）</div>`;
      return;
    }
    const state = f.stale
      ? `<span class="warn">有更新</span>`
      : `<span style="color:var(--mv-ok,#3a9)">最新</span>`;
    const loaded = f.loadedAt ? fmtTime(f.loadedAt) : '—';
    el.innerHTML = `<div class="mv-note ${f.stale ? 'warn' : 'good'}">
      名单状态：<b>${state}</b>（装载于 ${esc(loaded)}）
      ${f.stale && f.newestName ? `<br>最新动过的存档：<span class="mono">${esc(f.newestName)}</span>${f.newest ? `（${esc(f.newest.replace('T', ' ').slice(0, 16))}）` : ''}` : ''}
      ${f.stale ? '<br>下一次用到名单时会<b>自动重装</b>（几秒），不用点任何按钮。' : ''}
      <br><span class="mv-sub">判据输入：装载指纹 <span class="mono">${esc(String(f.loadedSig || '—').slice(0, 12))}</span>
      ↔ 当前指纹 <span class="mono">${esc(String(f.currentSig || '—').slice(0, 12))}</span>（覆盖 ${esc(f.files ?? 0)} 个文件）。
      ${f.relabels ? `上次重装顺带记录了 ${esc(f.relabels)} 个标签沿革。` : ''}</span>
    </div>`;
  }

  // ── 同名合并（建议表 + 点名合并 + 取消合并）────────────────────────────────
  async function refreshMerge() {
    const el = $('#mv-idn-merge');
    if (!el) return;
    const r = await req(ctx, '/api/memory-vec/identity/suggest');
    if (!r?.ok) {
      el.innerHTML = `<div class="mv-sub">读不到合并建议：${esc(r?.error || '未知错误')}</div>`;
      return;
    }
    if (!r.groups?.length) {
      el.innerHTML = `<div class="mv-sub good">没有同名候选。${r.alreadyMerged?.length ? `已点过名的名字：${esc(r.alreadyMerged.join('、'))}。` : ''}</div>`;
      return;
    }
    const rows = r.groups.slice(0, 20).map((g, gi) => `
      <tr><td class="mono">${esc(g.surface)}</td>
      <td>${g.candidates.map((c, ci) => `
        <span style="white-space:nowrap"><span class="mono">${esc(c.label)}</span>（${esc(c.id)}，${esc(c.messages ?? '?')} 条）
        <button class="mv-btn" data-mg-from="${esc(c.id)}" data-mg-into="${esc(g.candidates[ci === 0 ? 1 : 0].id)}"
          data-mg-desc="${esc(c.label)} → ${esc(g.candidates[ci === 0 ? 1 : 0].label)}" type="button" title="把左边这位并进右边的实体">并入→</button></span>`).join('<br>')}</td></tr>`).join('');
    el.innerHTML = `
      <table class="mv-table">
        <thead><tr><th>名字</th><th>用这个名字的人</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="mv-sub">只有你确定两个号真是同一个人时才点 —— 看聊天记录里两人的说话风格/时间是否连续再决定。合并<b>可取消</b>（见下）。</div>
      <div id="mv-idn-merge-note"></div>`;
    for (const b of el.querySelectorAll('[data-mg-from]')) {
      const h = async () => {
        if (!confirm(`确认合并：${b.dataset.mgDesc}？\n（合并后两个号共用同一个占位符；可取消）`)) return;
        const note = $('#mv-idn-merge-note');
        b.disabled = true;
        const r2 = await req(ctx, '/api/memory-vec/identity', {
          method: 'POST',
          body: JSON.stringify({ action: 'merge', from: b.dataset.mgFrom, into: b.dataset.mgInto })
        });
        if (r2?.ok) { say(note, 'good', `✅ 已合并：${esc(b.dataset.mgDesc)}。星图与备注会在下次读取时自动归位。`); await refreshIdentity(); }
        else say(note, 'bad', `❌ ${esc(r2?.error || '失败')}`), (b.disabled = false);
      };
      b.addEventListener('click', h);
      cleanups.push(() => b.removeEventListener('click', h));
    }
  }

  // 机器人自己是谁、怎么判出来的 —— 摆在最上面。
  // 2.1 那处漏替的教训：它没进词表时，`findLeak` 完全看不见，
  // 所以这一格必须**默认可见**，而不是藏在详情里。
  function renderSelf(s) {
    const el = $('#mv-idn-self');
    if (!el) return;
    const me = s.identity;
    if (!me) {
      el.innerHTML = `<div class="mv-note warn">还没判定过"我是谁"。点「更新脱敏名单」会读 <span class="mono">config.json</span> 的
        <span class="mono">persona.botName</span> 与存档里的「名字↔QQ号」锚点，两条本地路线互证。</div>`;
      return;
    }
    const names = me.selfSurface || [];
    const others = (me.otherCandidates || []).filter((o) => o.proved > 0);
    el.innerHTML = `<div class="mv-note ${me.selfId ? 'good' : 'warn'}">
      <b>我自己</b>：
      ${me.selfId
        ? `<span class="mono">${esc(me.selfId)}</span> ← ${esc(me.selfIdSource || '未注明来源')}`
        : '<b class="warn">没判定出来</b> —— 名字若不在名单里会原样出境'}
      <br>已收录 <b>${names.length}</b> 个自称：<span class="mono">${esc(names.slice(0, 8).join('、'))}${names.length > 8 ? ' …' : ''}</span>
      <br><span class="mv-sub">判定只用本机数据：配置里的 <span class="mono">botName</span> 与存档里
        <span class="mono">@名[CQ:at,qq=号]</span> / <span class="mono">[引用 名(QQ:号)：</span> 这类"名字紧挨号码"的锚点。
        交叉验证：带号码的引用锚点里，引文能在自己的发言里找到的只有自己（其余候选全是 0 命中）。</span>
      ${me.selfProof ? `<br><span class="mv-sub">引文比对：${esc(me.selfProof)} 处命中${others.length ? `；其他候选 ${otherCandidatesText(others)}` : ''}。</span>` : ''}
      ${(me.selfAliases && me.selfAliases.length)
        ? `<br><span class="mv-sub">另有你声明的别称 ${me.selfAliases.length} 个：<span class="mono">${esc(me.selfAliases.slice(0, 8).join('、'))}</span></span>`
        : `<br><span class="mv-sub warn">还没声明任何自我别称 —— 名字的<b>残缺形态</b>（多词名字被拆开的单块）认不出来，会原样出境。下面「自我别称」里补。</span>`}
    </div>`;
  }

  function otherCandidatesText(list) {
    return list.slice(0, 4).map((o) => `${esc(o.id)}(${esc(o.proved)}/${esc(o.claims)})`).join('、');
  }

  function renderIdnCards(s) {
    const el = $('#mv-idn-cards');
    if (!el) return;
    const bk = s.byKind || {};
    const cards = [
      ['在册实体', `${s.entities ?? 0}`, `人 ${bk.person ?? '—'} · 群 ${bk.group ?? '—'} · 自己 1`],
      ['名字（surface）', `${s.surfaces ?? 0}`, s.multiNameEntities ? `${s.multiNameEntities} 个改过名` : '含旧群名片'],
      ['锚点补名', `${s.alignedNames ?? 0}`, `从 ${s.anchors ?? 0} 条"名字↔号"锚点挖出`],
      ['永久注册', `${s.registry ?? 0}`, '越用越准的那一批'],
      ['临时占位符', `${s.ephemeral ?? 0}`, '名单外但已确认是实体'],
      ['待审', `${s.pending ?? 0}`, '已替换，等人工确认'],
      ['兜底词', `${s.suspects ?? 0}`, '分布集中度扫描来的']
    ];
    el.innerHTML = cards.map(([label, val, sub]) => `
      <div class="mv-card"><span>${esc(label)}</span><b>${esc(val)}</b><span>${esc(sub)}</span></div>`).join('');
  }

  function renderHorizon(h) {
    const el = $('#mv-idn-horizon');
    if (!el) return;
    if (!h) {
      el.innerHTML = `<div class="mv-note warn">还没算过观察窗（点上面的「更新脱敏名单」会一并算出）。</div>`;
      return;
    }
    const short = Number(h.days) < 30;
    el.innerHTML = `<div class="mv-note${short ? ' warn' : ' good'}">
      观察窗 <b>${esc(h.days)} 天</b>（${esc(String(h.start || '').slice(0, 10))} → ${esc(String(h.end || '').slice(0, 10))}），
      覆盖 ${esc(h.messages ?? 0)} 条存档。
      ${short ? '<br>⚠️ 窗口偏短 —— 关系边与关系星图<b>必须</b>在界面上明说"关系建立在这么短的观察窗上"，否则会制造系统性偏差。' : ''}
      <br><span class="mv-sub">这不是插件安装日，是存档本身有多少天。存档不限量，所以它会自己变好。</span>
    </div>`;
  }

  function renderPending(list) {
    const el = $('#mv-idn-pending');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = `<div class="mv-sub">还没有待审词条。</div>`;
      return;
    }
    el.innerHTML = `
      <table class="mv-table">
        <thead><tr><th>词条</th><th>层</th><th>命中</th><th></th></tr></thead>
        <tbody>
          ${list.slice(0, 40).map((p) => `<tr>
            <td class="mono">${esc(p.term)}</td>
            <td>${esc(p.layer)}</td>
            <td>${esc(p.count)}</td>
            <td><button class="mv-btn" data-confirm="${esc(p.term)}" type="button">确认</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="mv-sub">最多显示 40 条。**未确认的词条也已经在替换了** —— 这里只是让它们变得可审计。</div>`;

    for (const b of $$('[data-confirm]')) {
      const h = async () => {
        const term = b.dataset.confirm;
        b.disabled = true;
        const r = await req(ctx, '/api/memory-vec/identity', {
          method: 'POST', body: JSON.stringify({ action: 'confirm', term })
        });
        if (r?.ok) { b.textContent = '已确认'; await refreshIdentity(); }
        else b.textContent = '失败';
      };
      b.addEventListener('click', h);
      cleanups.push(() => b.removeEventListener('click', h));
    }
  }

  {
    const bindIdn = (sel, run) => {
      const btn = $(sel);
      if (!btn) return;
      const h = async () => {
        const note = $('#mv-idn-note');
        btn.disabled = true;
        note.textContent = '跑着…';
        try { await run(btn, note); } finally { btn.disabled = false; }
      };
      btn.addEventListener('click', h);
      cleanups.push(() => btn.removeEventListener('click', h));
    };

    bindIdn('#mv-idn-vocab', async (btn, note) => {
      const t0 = Date.now();
      const r = await req(ctx, '/api/memory-vec/identity', { method: 'POST', body: JSON.stringify({ action: 'rebuild-vocab' }) });
      if (!r?.ok) { say(note, 'bad', `❌ ${esc(r?.error || '失败')}`); return; }
      say(note, 'good', `✅ 脱敏名单已更新（${r.identity?.entities ?? 0} 个实体，耗时 ${Date.now() - t0}ms）`);
      await refreshIdentity();
    });

    bindIdn('#mv-idn-suspect', async (btn, note) => {
      const t0 = Date.now();
      const r = await req(ctx, '/api/memory-vec/identity', { method: 'POST', body: JSON.stringify({ action: 'scan-suspects' }) });
      if (!r?.ok) { say(note, 'bad', `❌ ${esc(r?.error || '失败')}`); return; }
      say(note, 'good', `✅ 找漏网的名字：${r.suspects} 个疑似专名（扫了 ${r.stats?.candidates ?? 0} 个候选，耗时 ${Date.now() - t0}ms）`);
      await refreshIdentity();
    });

    bindIdn('#mv-idn-dry', async (btn, note) => {
      const out = $('#mv-idn-dryout');
      out.innerHTML = `<div class="mv-note"><span class="mv-spin"></span> 正在逐个块生成出境文本（不联网、不花钱）…</div>`;
      const r = await req(ctx, '/api/memory-vec/identity', { method: 'POST', body: JSON.stringify({ action: 'dryrun-all' }) });
      if (!r) { out.innerHTML = `<div class="mv-note bad">请求失败</div>`; return; }
      say(note, r.ok ? 'good' : 'bad', r.ok ? '✅ 全部块都能干净出境' : `❌ 有 ${r.blocked} 个块被拒绝出境`);
      out.innerHTML = `
        <div class="mv-note ${r.ok ? 'good' : 'bad'}">
          抽查 ${esc(r.chunks)} 个块：${esc(r.chunks - r.blocked)} 个可以出境，${esc(r.blocked)} 个被拒绝。<br>
          ${esc(r.bodiesTouched)} 个块里有东西被替换，共替换 <b>${esc(r.entitiesReplaced)}</b> 处实体。<br>
          分层命中：<span class="mono">${esc(JSON.stringify(r.byLayer || {}))}</span>
          ${r.blocked ? `<br>⚠️ 被拒绝的块<b>不会</b>降级成发原文 —— 它们会被跳过并报错。` : ''}
        </div>
        ${r.failures?.length ? `<pre class="mv-pre">${esc(JSON.stringify(r.failures, null, 2))}</pre>` : ''}`;
    });

    const cbtn = $('#mv-idn-check');
    if (cbtn) {
      const h = async () => {
        const text = $('#mv-idn-text')?.value || '';
        const out = $('#mv-idn-checkout');
        if (!text.trim()) { out.innerHTML = `<div class="mv-note warn">先贴一段文本。</div>`; return; }
        const r = await req(ctx, '/api/memory-vec/identity', {
          method: 'POST', body: JSON.stringify({ action: 'check', text })
        });
        if (!r) { out.innerHTML = `<div class="mv-note bad">请求失败</div>`; return; }
        if (!r.ok && !r.output) {
          out.innerHTML = `<div class="mv-note bad">归一化被拒绝：${esc(r.error || '')}</div>`;
          return;
        }
        out.innerHTML = `
          <div class="mv-note good">输出里 ${r.leak ? '⚠️ 仍有泄漏' : '没有发现任何原始实体串'}。</div>
          <div class="mv-pre"><b>输入</b>
${esc(r.input)}</div>
          <div class="mv-pre"><b>出境文本</b>
${esc(r.output)}</div>
          <div class="mv-pre"><b>命中（${esc(r.stats?.hits ?? 0)} 处）</b>
${esc((r.hits || []).map((x) => `${x.layer.padEnd(10)}${x.kind.padEnd(8)}${x.term} → 〔${x.label}〕`).join('\n'))}</div>`;
      };
      cbtn.addEventListener('click', h);
      cleanups.push(() => cbtn.removeEventListener('click', h));
    }
  }

  // 首屏 —— 关系星图是默认打开的页（插件首页），必须跟状态一起加载，
  // 否则首屏会停在「正在连接向量记忆库服务…」的转圈上。
  await Promise.all([refreshAll(), mountGraph()]);

  return () => {
    if (jobTimer) clearInterval(jobTimer);
    for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
  };
}
