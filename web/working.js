// working.js — 短期层（关键词层）体检页（`ADR-0048` ⑨）。
//
// 一次 `GET /api/vec/working` 拿全部内容：**概览计数 + 排练分布 + 五个队列**。
// 队列是"看"的不是"操作"的 —— 本页**没有任何写操作**，理由写在下面 `fine` 里：
// 升长期/回收的判据只有"被想起过几次"，手点的那条没被真正想起过，塞进长期层就是污染。
//
// ⚠️ 与 instances.js 同一条安全边界：本服务**没有认证**（只有"够不着"，没有"认证"），
// 所以浏览器里能点的按钮只限于只读；任何写操作都留在仓根的脚本里。
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

const API = '/api/vec';
const dot = $('#health-dot');
let DATA = null;

/** `1792727000000` → `10-23 11:40`；没有就给个占位（不猜）。 */
function whenOf(ev) {
  if (ev?.at) return esc(ev.at);
  if (Number(ev?.toTs) > 0) {
    const d = new Date(Number(ev.toTs));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return '—';
}

function itemHtml(ev, { bar = null, dim = false } = {}) {
  const hits = Number(ev.hits) || 0;
  const meta = [
    whenOf(ev),
    `想起 ${hits} 次`,
    // 遗忘曲线的强度值（`ADR-0048` ⑩）：指数形状唯一有独立意义的地方就是这块展示
    ev.retention != null && !ev.retiredAt && !ev.promotedAt ? `记得 ${Math.round((Number(ev.retention) || 0) * 100)}%` : '',
    ev.idleDays ? `${ev.idleDays} 天没被提起` : '',
    // `ADR-0048 ⑪`：变暗 ≠ 回收 —— 它还在索引里，只是权重降到 30%
    ev.state === 'dimmed' ? '已变暗（还能找到）' : '',
    ev.retiredAt ? '已回收（出索引）' : '',
    ev.promotedAt ? '已在长期层' : ''
  ].filter(Boolean).map(esc).join(' · ');
  const barHtml = bar
    ? `<div class="bar" title="${esc(bar.tip)}"><i style="width:${Math.max(2, Math.min(100, bar.pct))}%"></i></div>`
    : '';
  return `<li class="${dim ? 'dim' : ''}">
      <div class="hd"><span class="t">${esc(ev.title || ev.summary || '(无标题)')}</span><span class="meta">${meta}</span></div>
      ${ev.summary ? `<div class="sum">${esc(ev.summary)}</div>` : ''}
      ${barHtml}
    </li>`;
}

function queueCard(title, why, list, opts = {}) {
  const n = (list || []).length;
  const body = n
    // `barOf` 按条目算进度条（快升长期看"想起几次/阈值"，逐条不一样）
    ? `<ol class="q">${list.map((ev) => itemHtml(ev, { dim: opts.dim === true, bar: opts.barOf ? opts.barOf(ev) : null })).join('')}</ol>`
    : `<div class="empty">${esc(opts.emptyText || '（空）')}</div>`;
  return `<section class="card">
      <h2>${esc(title)}<span class="n">${n} 条</span></h2>
      <p class="why">${esc(why)}</p>
      ${body}
    </section>`;
}

function render(d) {
  const th = d.thresholds || {};
  const c = d.counts || {};
  const q = d.queues || {};

  // 排练分布：横轴 = 想起次数，纵轴 = 几条事件。**只画有数据的档位**，
  // 不然中间的空档会画成一片零高度的柱子，看着像"数据没了"。
  const dist = Object.entries(d.hitsDist || {}).map(([k, v]) => [Number(k), Number(v)]).sort((a, b) => a[0] - b[0]);
  const maxV = Math.max(1, ...dist.map(([, v]) => v));
  const bars = dist.map(([k, v]) => `<i style="height:${Math.round((v / maxV) * 100)}%" title="想起 ${k} 次：${v} 条"></i>`).join('');

  const overview = `<section class="card">
      <h2>概览<span class="n">阈值：想起 ${esc(th.promoteHits)} 次升长期 · 想起 0 次的 ${esc(th.retireDays)} 天没被提起则回收（每多想起一次，额度 +${esc(Math.round((Number(th.retireHalfLifeGain) || 0) * 100))}%）</span></h2>
      <p class="why">短期层装的是<b>还没被反复想起</b>的事。它只建关键词索引、不建向量 ——
        「刚才这个群发生过什么」必须确定性在场，不能取决于余弦值。</p>
      <div class="counts">
        <div class="k"><b>${esc(c.working)}</b><span>在短期层</span></div>
        <div class="k hot"><b>${esc((q.nearPromote || []).length)}</b><span>快升长期</span></div>
        <div class="k dimmed"><b>${esc(c.dimmed ?? 0)}</b><span>已变暗</span></div>
        <div class="k promoted"><b>${esc(c.promoted)}</b><span>已在长期层</span></div>
        <div class="k retired"><b>${esc(c.retired)}</b><span>已回收</span></div>
      </div>
      <div class="dist">${bars || '<i style="height:2px"></i>'}</div>
      <div class="dist-axis"><span>想起 0 次</span><span>想起 ${esc(Math.max(0, dist.length - 1))} 次</span></div>
    </section>`;

  const gate = Math.max(1, Number(th.promoteHits) || 9);
  const idleGate = Math.max(1, Number(th.retireDays) || 30);
  const grid = [
    overview,
    queueCard('快升长期了', `想起次数已过阈值（${esc(gate)} 次）的 60%。再被对话真的用上几次就会建向量、并入长期层。
      <b>这里没有"手动升级"按钮</b> —— 手点的那条没被想起过，硬塞进长期层就是污染。`,
    q.nearPromote, {
      barOf: (ev) => ({ pct: ((Number(ev.hits) || 0) / gate) * 100, tip: `想起 ${Number(ev.hits) || 0} / ${gate} 次` }),
      emptyText: '还没有哪条被想起这么多次。'
    }),
    queueCard('快被回收了', `剩不到<b>自己额度</b>的 30%。额度不再是固定的 ${esc(idleGate)} 天，而是随想起次数变长
      （0 次 = ${esc(idleGate)} 天，每多想起一次 +${esc(Math.round((Number(th.retireHalfLifeGain) || 0) * 100))}%）——
      被反复提起的事本来就该活得久些。判据仍是<b>惰性而不是年龄</b>：最后一次被想起之后的天数，
      按出生时间算会误杀"很久以前但最近常被提起"的事，那恰恰是最该留的。`,
      q.idleSoon, {
      dim: true,
      barOf: (ev) => {
        const idle = Number(ev.idleDays) || 0;
        const quota = Math.max(1, Number(ev.retireAfterDays) || idleGate);
        const left = Math.max(0, Number(ev.retireInDays) || 0);
        return {
          pct: (idle / quota) * 100,
          tip: `闲置 ${idle} 天 / 额度 ${quota} 天（想起 ${Number(ev.hits) || 0} 次 ⇒ 额度 ×${(quota / idleGate).toFixed(1)}），还剩 ${left} 天`
        };
      },
      emptyText: '没有快被回收的。'
    }),
    queueCard('已变暗（软回收）', `保持率跌破了 ${esc(Math.round((Number(th.retireMinRecall) || 0.1) * 100))}%，但<b>还没到</b>出索引的硬阈值
      （${esc(Math.round((Number(th.retireMinRecall) || 0.1) * (Number(th.retireHardRatio) || 0.3) * 1000) / 10)}%）。
      它们<b>仍在关键词索引里</b>，只是权重降到 ${esc(Math.round((Number(th.retireDimWeight) || 0.3) * 100))}% ⇒ 排得更靠后、
      更难被想起，但<b>问到了还能捞回来</b>。一旦真的被想起来（保持率回升过阈值）就会<b>自动亮回来</b>。
      旧行为是跌破就出索引 ⇒ "记过却想不起来"有一半是我们自己造成的。`,
      q.dimmed, {
      dim: true,
      barOf: (ev) => {
        const hard = Math.max(1, Number(ev.retireHardAfterDays) || idleGate);
        const idle = Number(ev.idleDays) || 0;
        return {
          pct: Math.min(100, (idle / hard) * 100),
          tip: `闲置 ${idle} 天 / 出索引额度 ${hard} 天（还剩 ${Math.max(0, Number(ev.retireHardInDays) || 0)} 天）· 当前权重 ${Math.round((Number(ev.dimWeight) || 0) * 100)}%`
        };
      },
      emptyText: '没有变暗的。'
    }),
    queueCard('还从没被想起过', '刚进短期层、一次都没进过 prompt 的事。它们只靠"最近"在场（【最近事件】段按时间倒序给）；如果一直没被提起，就会走到上面那个队列。',
      q.fresh, { emptyText: '全部都至少被想起过一次。' }),
    queueCard('已在长期层', '已建向量、参与语义检索的事。**它们仍在短期层的账本里**（回收判据看得见"最后一次被想起"，移走就断了这条线），只是不再靠关键词层找回来。',
      q.promoted, { dim: true, emptyText: '还没有升上去的。' }),
    queueCard('已回收', '打了回收标记、检索时跳过。**不物理删除**（定期 compact 才删）—— 记忆不该因为一次静默的定时器就彻底消失。',
      q.retired, { dim: true, emptyText: '还没有被回收的。' })
  ];

  $('#grid').innerHTML = grid.join('');
  $('#stats').textContent = `事件 ${c.total} 条 · 短期 ${c.working} · 变暗 ${c.dimmed ?? 0} · 长期 ${c.promoted} · 回收 ${c.retired} · 未排练 ${c.fresh}`;
}

function fillChats(d) {
  const sel = $('#chat');
  const keys = [...new Set([
    ...(d.queues?.nearPromote || []), ...(d.queues?.idleSoon || []), ...(d.queues?.fresh || []),
    ...(d.queues?.promoted || []), ...(d.queues?.retired || [])
  ].map((x) => x.chatKey).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = ['<option value="">全部会话</option>', ...keys.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`)].join('');
  if (keys.includes(cur)) sel.value = cur;
}

async function load() {
  const chatKey = $('#chat')?.value || '';
  $('#boot').hidden = false;
  try {
    const r = await fetch(`${API}/working?limit=8${chatKey ? `&chatKey=${encodeURIComponent(chatKey)}` : ''}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    dot.className = 'dot up';
    dot.title = '服务在线';
    fillChats(DATA);
    render(DATA);
  } catch (err) {
    dot.className = 'dot down';
    dot.title = String(err?.message || err);
    $('#grid').innerHTML = `<section class="card"><h2>读不到短期层</h2>
      <p class="why">${esc(String(err?.message || err))} —— 常见原因：这个号从没开过整理（还没有事件账本），或服务没起。</p></section>`;
    $('#stats').textContent = '';
  } finally {
    $('#boot').hidden = true;
  }
}

$('#btn-reload')?.addEventListener('click', load);
$('#chat')?.addEventListener('change', load);

$('#fine').innerHTML = `
  <b>两层怎么分：</b>短期层（本页）= 关键词检索，装"还没被反复想起"的事；
  长期层 = 向量相似度，装事实槽与<b>已升长期</b>的事件。
  <b>"想起过"怎么数：</b>一条事件<b>真的进了 <code>/inject</code> 的最终文本</b>才算一次 ——
  <code>/search</code> 返回、候选池命中都不算（那只是"被扫到"，不是"被想起"）。
  <b>本页只读：</b>没有升级/回收/删除按钮。升降的判据只能是行为（被想起过几次），
  手点的那条没被真正想起过，塞进长期层就是污染。<br>
  <b>队列是交叉的：</b>同一条事件可以同时出现在"快升长期"和"快被回收"里 ——
  前者看次数、后者看闲置天数，两个轴本来就独立。
`;

load();
