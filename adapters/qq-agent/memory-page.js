// 记忆库页（宿主 nav.page 插槽）：iframe 嵌 vec-memory 服务的 `/manage.html`。
//
// 2026-10-31（用户令）：宿主的插件设置页与旧记忆页（`/memory.html`）都不再使用 ——
//   点「记忆库」直接就是服务自己的**新管理页**（memory-suite 0.30 的「记忆管理 · 本机工作台」）。
//   旧面板（`settings-ui.js`，131 KB 的关系星图/检索/记忆/诊断合集）已移除；它的配置项
//   仍全部在 `plugin.json` 的 `configSchema` 里声明，所以「插件管理 → 向量记忆库 → 设置」
//   的通用表单照样能改（服务地址 / 自动启动 / 注入开关 / 协议 v1 凭据），不会失去配置通道。
//
// 为什么 iframe 而不是在插件模块里重写整个 UI：
//   页面本体（manage.html + manage.js + manage.css）已经在 vec-memory 仓 `web/` 下，
//   它 fetch 的 `/api/vec/*` 与页面**同源**（都由数据面服务提供）—— iframe 跨端口加载没有
//   CORS 问题，页面内部请求也天然同源。本模块只做三件事：开窗、探活、跟着插件配置换地址。
//   两端各自演进互不牵连：vec-memory 改页面不需要动这个文件，反之亦然。
//
// ctx（宿主 createPluginViewCtx 的契约，字段只增不删）：
//   ctx.config() → state.config.skills['memory-vec'] —— 里面有 serviceBaseURL。
//
// 挂载语义：离开插件页宿主会 unmount（cleanup 被调），再进来会重新 render+bind
// ⇒ iframe 每次进来都重开一次 = 天然刷新，不用自己做定时刷新。

const FALLBACK_BASE = 'http://127.0.0.1:8088';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function baseOf(ctx) {
  let cfg = null;
  try { cfg = ctx?.config?.(); } catch { /* 配置读不到就用兜底地址 */ }
  return String(cfg?.serviceBaseURL || FALLBACK_BASE).replace(/\/+$/, '');
}

/** 只接受 http(s) + 无内嵌凭据的地址；其余一律不出链接（避免把 token 拼进 URL）。 */
function safeOrigin(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch { return ''; }
}

export function render(ctx) {
  // 独立协议 v1：管理面是服务自带的 `standalone.html`（要管理员凭据，凭据只在页面内存里）。
  // 页面在独立来源的 iframe 中验证管理凭据；适配器不向它传递项目令牌。
  const v1=ctx?.config?.()?.protocolV1===true;
  const origin=safeOrigin(baseOf(ctx));
  if(v1&&!origin)return '<p>请在插件设置中填写有效的记忆库服务地址。</p>';
  return `
  <div style="height:calc(100vh - 88px);min-height:520px;display:flex;flex-direction:column;margin:6px 10px 10px">
    ${v1?`<div style="font-size:12px;padding:4px">独立记忆库 · 在下方输入管理凭据。<a href="${esc(origin)}/standalone.html" target="_blank" rel="noopener noreferrer">新窗口打开</a></div>`:''}
    <div id="vecmem-status" style="padding:10px 4px;font-size:12px;line-height:1.7">正在连接向量记忆库…</div>
    <iframe id="vecmem-frame" title="记忆管理"
      style="flex:1;width:100%;border:1px solid rgba(128,128,128,.25);border-radius:10px;background:transparent">
    </iframe>
  </div>`;
}

export function bind(root, ctx) {
  const v1=ctx?.config?.()?.protocolV1===true;
  const frame = root.querySelector('#vecmem-frame');
  const status = root.querySelector('#vecmem-status');
  let dead = false;

  async function boot() {
    if (dead || !frame?.isConnected) return;
    const base = v1?safeOrigin(baseOf(ctx)):baseOf(ctx);
    const page=v1?'standalone.html':'manage.html';
    try {
      // 探活用 /api/vec/status（无鉴权依赖、恒 200；只看 HTTP 状态，不解析 body）
      const r = await fetch(`${base}${v1?'/health':'/api/vec/status'}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      frame.src = `${base}/${page}`;
      if (status) status.hidden = true;
    } catch (err) {
      if (!status) return;
      status.hidden = false;
      status.innerHTML = `向量记忆库服务不在线（<code>${esc(base)}</code>）：${esc(String(err?.message || err))}
        —— 管理页在 <code>${esc(base)}/${page}</code>，服务起来后点重试。
        地址不对就在「插件管理 → 向量记忆库 → 设置」里改 serviceBaseURL。
        <button type="button" id="vecmem-retry" style="margin-left:8px;cursor:pointer">重试</button>`;
      status.querySelector('#vecmem-retry')?.addEventListener('click', () => {
        status.textContent = '正在重连…';
        boot();
      });
    }
  }

  boot();
  return () => { dead = true; };
}
