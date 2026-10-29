// 记忆库页（宿主 nav.page 插槽，2026-10-23）：iframe 嵌 vec-memory 服务的 /memory.html。
//
// 为什么 iframe 而不是在插件模块里重写整个 UI：
//   页面本体（memory.html + memory.js）已经在 vec-memory 仓 `web/` 下，它 fetch 的
//   `/api/vec/*` 与页面**同源**（都由数据面服务提供）—— iframe 跨端口加载没有 CORS 问题，
//   页面内部请求也天然同源。本模块只做三件事：开窗、探活、跟着插件配置换地址。
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

export function render(ctx) {
  if(ctx?.config?.()?.protocolV1 === true) {
    let href='';
    try {const url=new URL(String(ctx.config().serviceBaseURL||FALLBACK_BASE));if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)href=url.origin+'/standalone.html';}catch{}
    return `<div style="padding:20px"><h3>独立混合记忆库</h3><p>当前使用独立协议 v1。模型设置、空间授权和整理任务在独立服务管理页维护。</p><p>${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">打开记忆库管理页</a>`:'请先填写有效的 HTTP 服务地址。'}</p><p>管理页需要单独输入管理凭据；插件只保存项目凭据，不向页面传递令牌。</p></div>`;
  }
  return `
  <div style="height:calc(100vh - 88px);min-height:520px;display:flex;flex-direction:column;margin:6px 10px 10px">
    <div id="vecmem-status" style="padding:10px 4px;font-size:12px;line-height:1.7">正在连接向量记忆库…</div>
    <iframe id="vecmem-frame" title="记忆库"
      style="flex:1;width:100%;border:1px solid rgba(128,128,128,.25);border-radius:10px;background:transparent">
    </iframe>
  </div>`;
}

export function bind(root, ctx) {
  if(ctx?.config?.()?.protocolV1 === true)return ()=>{};
  const frame = root.querySelector('#vecmem-frame');
  const status = root.querySelector('#vecmem-status');
  let dead = false;

  const baseOf = () => {
    let cfg = null;
    try { cfg = ctx?.config?.(); } catch { /* 配置读不到就用兜底地址 */ }
    return String(cfg?.serviceBaseURL || FALLBACK_BASE).replace(/\/+$/, '');
  };

  async function boot() {
    if (dead || !frame?.isConnected) return;
    const base = baseOf();
    try {
      // 探活用 /api/vec/status（无鉴权依赖、恒 200；只看 HTTP 状态，不解析 body）
      const r = await fetch(`${base}/api/vec/status`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      frame.src = `${base}/memory.html`;
      if (status) status.hidden = true;
    } catch (err) {
      if (status) {
        status.hidden = false;
        status.innerHTML = `向量记忆库服务不在线（<code>${esc(base)}</code>）：${esc(String(err?.message || err))}
          —— 页面本体在 <code>${esc(base)}/memory.html</code>，服务起来后点重试。
          <button type="button" id="vecmem-retry" style="margin-left:8px;cursor:pointer">重试</button>`;
        status.querySelector('#vecmem-retry')?.addEventListener('click', () => {
          status.textContent = '正在重连…';
          boot();
        });
      }
    }
  }

  boot();
  return () => { dead = true; };
}
