// 记忆页（2026-10-23 新增）：短期层的**浏览**视图。
// 与 `working.html` 的分工：那边是体检（五个队列 + 排练分布），这边是按会话翻事件流。
// 两个端点，同源（本页由 vec-memory 服务提供）：
//   GET /api/vec/working          → 概览 + 会话汇总（`chats`）
//   GET /api/vec/working/items    → 全量分页（chatKey / queue / q / offset / limit）

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const dot = $('#health-dot');
const PAGE = 60;

const state = {
  overview: null,
  chatKey: '',
  queue: 'all',
  q: '',
  offset: 0,
  items: []
};

const QUEUES = [
  ['all', '全部'],
  ['nearPromote', '快升长期'],
  ['idleSoon', '快被回收'],
  ['dimmed', '已变暗'],
  ['fresh', '未排练'],
  ['promoted', '已长期'],
  ['retired', '已回收']
];

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.ok) throw new Error(j?.error || '接口未返回 ok=true');
  return j;
}

function whenOf(ts) {
  if (!Number(ts)) return '';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 左栏：会话列表 ───────────────────────────────────────────────────────

function renderCounts() {
  const c = state.overview?.counts || {};
  const box = $('#counts');
  box.innerHTML = [
    ['', '在短期', c.working],
    ['dimmed', '已变暗', c.dimmed],
    ['promoted', '已长期', c.promoted],
    ['retired', '已回收', c.retired],
    ['fresh', '未排练', c.fresh]
  ].map(([cls, label, n]) => `<div class="k ${cls}"><b>${esc(n ?? '—')}</b><span>${esc(label)}</span></div>`).join('');
}

function renderChips() {
  $('#chips').innerHTML = QUEUES
    .map(([k, label]) => `<button type="button" class="chipbtn${k === state.queue ? ' on' : ''}" data-q="${esc(k)}">${esc(label)}</button>`)
    .join('');
  $('#chips').querySelectorAll('[data-q]').forEach((b) => {
    b.addEventListener('click', () => {
      state.queue = b.dataset.q || 'all';
      state.offset = 0;
      renderChips();
      loadItems();
    });
  });
}

function renderList() {
  const chats = state.overview?.chats || [];
  const q = state.q.toLowerCase();
  const rowOf = (key, name, sub, n) => `
    <div class="row${key === state.chatKey ? ' on' : ''}" data-key="${esc(key)}">
      <div class="nm">${esc(name)}<span class="n">${esc(n)} 事</span></div>
      <div class="sub">${esc(sub || '　')}</div>
    </div>`;
  const hit = (ch) => !q
    || String(ch.chatLabel || '').toLowerCase().includes(q)
    || String(ch.chatKey || '').toLowerCase().includes(q)
    || String(ch.latestTitle || '').toLowerCase().includes(q);
  const rows = chats.filter(hit).map((ch) => rowOf(
    String(ch.chatKey || ''),
    String(ch.chatLabel || '').trim() || String(ch.chatKey || '') || '（未知会话）',
    String(ch.latestTitle || ''),
    ch.count
  ));
  const total = state.overview?.counts?.total ?? '—';
  const list = $('#list');
  list.innerHTML = rowOf('', '全部会话', q ? '按关键词过滤中' : '按时间倒序', total)
    + (rows.length ? rows.join('') : (q ? '<div class="empty">没有匹配的会话。</div>' : ''));
  list.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('click', () => {
      state.chatKey = el.dataset.key || '';
      state.offset = 0;
      renderList();
      loadItems();
    });
  });
  $('#listcnt').textContent = `${chats.length} 个会话`;
}

// ── 右栏：事件流 ─────────────────────────────────────────────────────────

function evHtml(ev) {
  const pct = Math.round((Number(ev.retention) || 0) * 100);
  const col = pct > 60 ? 'var(--ok)' : pct > 30 ? 'var(--warn)' : 'var(--bad)';
  // `ADR-0048 ⑪`：三态 —— 变暗不是回收，它还在索引里（权重降到 30%），还能被找到
  const isDim = ev.state === 'dimmed' || (!ev.retiredAt && !ev.promotedAt && pct < 10);
  const dim = ev.retiredAt || isDim ? ' dim' : '';
  const tags = [
    ev.retiredAt ? '已回收（出索引）' : '',
    isDim ? '已变暗（还能找到，但排后面）' : '',
    ev.promotedAt ? '已在长期层' : ''
  ].filter(Boolean).join(' · ');
  return `
    <div class="ev${dim}">
      <div class="hd">
        <span class="t">${esc(ev.title || '(无标题)')}</span>
        <span class="meta">${esc(whenOf(ev.toTs))} · 想起 ${esc(ev.hits ?? 0)} 次 · 记得 ${pct}% · 还剩 ${esc(ev.retireInDays ?? 0)} 天${tags ? ` · ${esc(tags)}` : ''}</span>
      </div>
      ${ev.summary ? `<div class="sum">${esc(ev.summary)}</div>` : ''}
      ${ev.chatLabel && !state.chatKey ? `<div class="chat">${esc(ev.chatLabel)}</div>` : ''}
      <div class="bar" title="还能想起 ${pct}%（只表示记得多少，不代表说得对不对）· 变暗额度 ${esc(ev.retireAfterDays ?? 0)} 天 · 出索引额度 ${esc(ev.retireHardAfterDays ?? 0)} 天 · 半衰期 ${esc(ev.halfLifeDays ?? 0)} 天">
        <i style="width:${Math.max(2, pct)}%;background:${col}"></i>
      </div>
    </div>`;
}

function renderDetail(total) {
  const th = state.overview?.thresholds || {};
  const gain = Math.round((Number(th.retireHalfLifeGain) || 0) * 100);
  const head = `
    <div class="head">
      <h3>${esc(state.chatKey ? (currentChatName() || '会话') : '全部会话')}</h3>
      <span class="sub">共 ${esc(total ?? 0)} 条 · 想起 ${esc(th.promoteHits ?? 9)} 次升长期 ·
        额度锚点 ${esc(th.retireDays ?? 30)} 天（每多想起一次 +${esc(gain)}%）·
        ${esc(Math.round((Number(th.retireHardRatio) || 0.3) * 100))}% 阈值才彻底出索引</span>
      <span class="sub" style="opacity:.75">「记得 N%」只说明现在还能想起多少，与当初说得对不对无关。</span>
    </div>`;
  const left = Math.max(0, Number(total || 0) - state.offset - state.items.length);
  const more = left > 0
    ? `<div class="more"><button type="button" class="chipbtn" id="btn-more">加载更多（还有 ${esc(left)} 条）</button></div>`
    : '';
  const body = state.items.length
    ? state.items.map(evHtml).join('') + more
    : '<div class="empty-hint">这个筛选下没有事件。</div>';
  $('#detail').innerHTML = head + body;
  $('#detailcnt').textContent = `${state.items.length} / ${total ?? 0} 条`;
  $('#btn-more')?.addEventListener('click', () => {
    state.offset += PAGE;
    loadItems({ append: true });
  });
}

function currentChatName() {
  const ch = (state.overview?.chats || []).find((c) => String(c.chatKey || '') === state.chatKey);
  return ch ? (String(ch.chatLabel || '').trim() || ch.chatKey) : '';
}

async function loadItems({ append = false } = {}) {
  if (!append) state.offset = 0;
  try {
    const qs = new URLSearchParams({ queue: state.queue, limit: String(PAGE), offset: String(state.offset) });
    if (state.chatKey) qs.set('chatKey', state.chatKey);
    if (state.q) qs.set('q', state.q);
    const data = await getJson(`/api/vec/working/items?${qs.toString()}`);
    const rows = Array.isArray(data.items) ? data.items : [];
    state.items = append ? state.items.concat(rows) : rows;
    renderDetail(data.total);
  } catch (err) {
    $('#detail').innerHTML = `<div class="empty-hint">事件列表读取失败：${esc(String(err?.message || err))}</div>`;
  }
}

// ── 载入 ─────────────────────────────────────────────────────────────────

async function load() {
  $('#boot').hidden = false;
  try {
    state.overview = await getJson('/api/vec/working');
    dot.className = 'dot up';
    dot.title = '服务在线';
    renderCounts();
    renderChips();
    renderList();
    await loadItems();
    const c = state.overview.counts || {};
    $('#stats').textContent = `事件 ${c.total ?? '—'} 条 · 短期 ${c.working ?? '—'} · 长期 ${c.promoted ?? '—'} · 回收 ${c.retired ?? '—'} · 未排练 ${c.fresh ?? '—'}`;
    $('#fine').innerHTML = '';
  } catch (err) {
    dot.className = 'dot down';
    dot.title = String(err?.message || err);
    $('#list').innerHTML = `<div class="empty">读不到短期层：${esc(String(err?.message || err))}
      <br><br>常见原因：这个号从没开过整理（还没有事件账本），或服务没起。</div>`;
    $('#detail').innerHTML = '';
  } finally {
    $('#boot').hidden = true;
  }
}

let typing = null;
$('#q')?.addEventListener('input', (e) => {
  const v = String(e.target.value || '').trim();
  clearTimeout(typing);
  typing = setTimeout(() => {
    state.q = v;
    state.offset = 0;
    renderList();
    loadItems();
  }, 250);
});
$('#btn-reload')?.addEventListener('click', load);

$('#fine').innerHTML = `
  <b>两层怎么分：</b>短期层（本页）= 关键词检索，装"还没被反复想起"的事；长期层 = 向量相似度，
  装事实槽与<b>已升长期</b>的事件。<b>"想起过"怎么数：</b>一条事件<b>真的进了 <code>/inject</code>
  的最终文本</b>才算一次 —— <code>/search</code> 返回、候选池命中都不算（那只是"被扫到"，不是"被想起"）。<br>
  <b>颜色条 = 保持率</b>（遗忘曲线 <code>R = exp(-Δ/H)</code>）：绿 &gt;60%、橙 &gt;30%、红以下快被回收。
  额度随想起次数变长 —— 想起 0 次是 ${esc(state.overview?.thresholds?.retireDays ?? 30)} 天，每多想起一次 +40%。<br>
  <b>本页只读：</b>没有升级 / 回收 / 删除按钮。升降的判据只能是行为（被想起过几次），
  手点的那条没被真正想起过，塞进长期层就是污染。
`;

load();
