// instances.js — 多实例总览页（`ADR-0029`）。
//
// 一次 `GET /api/vec/instances` 拿到两样东西：**清单**（仓根 `instances.json`）+ 每个实例的
// **探活结果**（服务端并发打各自的 `/health`，见 `router.mjs`）。存活实例再由本页并发拉
// `/status` 补统计数字（跨实例只读；服务对回环来源放行 CORS）。
//
// ⚠️ 本页**没有任何写操作**，也不提供启停 —— 浏览器里点一下就能停服务，等于给了本服务一个
// 远程 kill 开关，而它**没有认证**（`server.mjs`：只有"够不着"，没有"认证"）。启停在仓根
// `启动-全部实例.bat`。
const $ = (s) => document.querySelector(s);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ── 主题：与星图页同一套机制（`?theme=` 初值 + 宿主 iframe 发来的 `mv-theme`）──────
function applyTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  if (document.documentElement.dataset.theme === next) return;
  document.documentElement.dataset.theme = next;
}
{
  const qp = new URLSearchParams(location.search).get('theme');
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches === true;
  applyTheme(qp || (prefersLight ? 'light' : 'dark'));
}
window.addEventListener('message', (e) => {
  const d = e?.data;
  if (d && d.type === 'mv-theme' && (d.theme === 'dark' || d.theme === 'light')) applyTheme(d.theme);
});

/** 拉一个实例的运行状态（只读；失败返回 null，页面显示"读不到"而不是崩）。 */
async function statusOf(base) {
  try {
    const r = await fetch(`${base}/api/vec/status`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function cardHtml(it) {
  const up = it.alive === true;
  const h = it.health || {};
  // 存活 ⇒ 显示**运行期实际**的根（"它到底连了哪个库"）；没起 ⇒ 显示清单里写的。
  const dataRoot = up ? (h.dataRoot || it.dataRoot) : it.dataRoot;
  const sourceRoot = up ? (h.sourceRoot || it.sourceRoot) : it.sourceRoot;
  const mismatch = up && (it.dataRootMatch === false || it.sourceRootMatch === false);

  const cls = ['card', up ? 'up' : '', it.self ? 'self' : ''].filter(Boolean).join(' ');
  const badges = [
    `<span class="badge ${up ? 'up' : 'down'}">${up ? '运行中' : '未运行'}</span>`,
    it.self ? '<span class="badge self">本站</span>' : '',
    it.port ? `<span class="badge">127.0.0.1:${it.port}</span>` : '<span class="badge down">清单里没有端口</span>'
  ].filter(Boolean).join('');

  const acts = it.baseURL ? `<div class="acts">
      <a href="${esc(it.baseURL)}/" target="_blank" rel="noopener" ${up ? '' : 'aria-disabled="true"'}>关系星图</a>
      <a href="${esc(it.baseURL)}/memory.html" target="_blank" rel="noopener" ${up ? '' : 'aria-disabled="true"'}>记忆</a>
      <a href="${esc(it.baseURL)}/person.html" target="_blank" rel="noopener" ${up ? '' : 'aria-disabled="true"'}>人物卡</a>
      <a href="${esc(it.baseURL)}/instances.html" target="_blank" rel="noopener" ${up ? '' : 'aria-disabled="true"'}>本页</a>
      <a href="${esc(it.baseURL)}/working.html" target="_blank" rel="noopener" ${up ? '' : 'aria-disabled="true"'}>体检</a>
    </div>` : '';

  return `<section class="${cls}">
    <h2>${esc(it.name)} <span class="port">${it.port ? `:${it.port}` : ''}</span></h2>
    <div class="badges">${badges}</div>
    <dl>
      <dt>库根</dt><dd title="${esc(dataRoot)}">${esc(dataRoot || '（未写）')}</dd>
      <dt>源根</dt><dd title="${esc(sourceRoot)}">${esc(sourceRoot || '（随库根 config.json）')}</dd>
    </dl>
    ${mismatch ? '<p class="warn">⚠️ 清单与运行期**不一致** —— 这个实例实际连的不是清单里那两份根。先「刷新」再确认，仍不一致就得改清单或重启它。</p>' : ''}
    ${up
      ? `<div class="stat" data-base="${esc(it.baseURL)}"><span class="spin"></span> 读运行状态…</div>`
      : `<p class="reason">${esc(it.reason || '未运行')}</p>`}
    ${it.note ? `<p class="reason">${esc(it.note)}</p>` : ''}
    ${acts}
  </section>`;
}

async function fillStats(root) {
  const nodes = [...root.querySelectorAll('.stat[data-base]')];
  await Promise.all(nodes.map(async (el) => {
    const j = await statusOf(el.dataset.base);
    if (!j || j.ok === false) { el.textContent = '（读不到运行状态）'; return; }
    const c = j.core || {}, s = j.settings || {};
    const cov = Number(j.coverage) || 0;
    el.innerHTML = [
      `<span><b>${c.chunkCount ?? '?'}</b> 块</span>`,
      `<span>已嵌入 <b>${j.embedded ?? '?'}</b>（${(cov * 100).toFixed(0)}%）</span>`,
      `<span>实体 <b>${j.identity?.entities ?? '?'}</b></span>`,
      `<span>自动索引 <b>${s.autoIndexEnabled ? `开 · ${s.autoIndexIntervalMin} 分` : '关'}</b></span>`
    ].join('');
  }));
}

async function load() {
  const boot = $('#boot'), grid = $('#grid'), dot = $('#health-dot');
  boot.hidden = false;
  boot.innerHTML = '<span class="spin"></span> 正在读清单并探活…';
  grid.innerHTML = '';
  dot.className = 'dot';

  let man;
  try {
    const r = await fetch('/api/vec/instances');
    man = await r.json();
    if (!r.ok || man?.ok === false) {
      // 旧服务的 `/api/vec/*` 里**没有** instances 端点（回 404「未知端点」）⇒
      // 直接说"重启服务"，别让用户对着一句"未知端点"猜。
      boot.hidden = true;
      grid.innerHTML = `<div class="note bad">读不到实例清单：${esc(man?.error || `HTTP ${r.status}`)}。` +
        (r.status === 404 ? '<br>这多半是<b>服务还在跑旧代码</b>（本轮新增了 /instances 端点）—— 重启服务即可。' : '') +
        '</div>';
      return;
    }
  } catch (e) {
    boot.hidden = true;
    grid.innerHTML = `<div class="note bad">连不上本站服务：${esc(e?.message ?? e)}</div>`;
    return;
  }

  dot.className = 'dot ok';
  const list = Array.isArray(man.instances) ? man.instances : [];
  const upCount = list.filter((i) => i.alive).length;

  const parts = [];
  if (!man.manifestExists) {
    parts.push(`<div class="note bad"><b>清单不在</b>：<code>${esc(man.manifestPath)}</code><br>` +
      `${esc(man.manifestError || '')}<br>加一个号 = 在仓根建这个文件（见 <code>docs/multi-instance.md</code>）。</div>`);
  }
  if (man.manifestExists && man.manifestError) {
    parts.push(`<div class="note bad"><b>清单读不了</b>：${esc(man.manifestError)}</div>`);
  }
  if ((man.problems || []).length) {
    parts.push(`<div class="note"><b>清单里有 ${man.problems.length} 处问题</b>：` +
      esc(man.problems.join('；')) + '</div>');
  }
  if (!list.length && man.manifestExists && !man.manifestError) {
    parts.push('<div class="note">清单里一条实例都没有 —— 在 <code>instances.json</code> 的 ' +
      '<code>instances</code> 数组里加一条。</div>');
  }
  parts.push(...list.map(cardHtml));

  grid.innerHTML = parts.join('');
  boot.hidden = true;

  $('#stats').innerHTML = `<span>实例 <b>${list.length}</b></span>` +
    `<span>运行中 <b>${upCount}</b></span>` +
    `<span>本页所在 <b>${esc(location.host)}</b></span>`;
  $('#fine').innerHTML =
    `清单：<code>${esc(man.manifestPath)}</code>（仓根 <code>${esc(man.repoRoot)}</code>）<br>` +
    `探活打的是每个实例自己的 <code>/health</code>（运行期事实）⇒「未运行」是实况，不是清单声明。<br>` +
    `启停实例在仓根 <code>启动-全部实例.bat</code>；本页只读，不在浏览器里提供任何启停。`;

  await fillStats(grid);
}

$('#btn-reload').addEventListener('click', load);
load();
