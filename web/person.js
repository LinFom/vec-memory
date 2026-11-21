// web/person.js —— 人物卡查阅页（`ADR-0032`）
//
// 纪律（与 instances.js 同）：
//   · 服务自带页面必须**双击就能跑** —— 不引外部字体/图标/构建工具，零依赖；
//   · **失败要看得见**：三种"没东西"（认不出人 / 词表里有但从没记过 / 记过但在别的场合）
//     在 UI 上必须是**三句不同的话**。合成一句"暂无数据"就是把本页最该回答的问题弄丢了；
//   · 全部文本走 `textContent`（不用 innerHTML 拼），因为库里是**用户说的话** ——
//     拼字符串迟早把某人的 `<` 当成标签吃掉。

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

/** 事实类别的中文名（**UI 层的事**，不往 `core/facts.mjs` 里塞显示用词表）。 */
const KIND_CN = {
  trait: '档案', preference: '偏好', promise: '承诺', event: '事件', topic: '话题',
  joke: '梗', grudge: '芥蒂',
  pattern: '说话方式', speaker_profile: '画像'
};
const kindCN = (k) => KIND_CN[k] || k;

let 当前选中 = null;
let 当前with = null;   // 「双人视图」过滤：只显示与这个人有关的事实（星图「两人之间」入口带进来）
// 标签筛选（多选）。空集 = 全部 —— **空集不是"什么都要"的隐喻，是"没设筛选"**。
// 服务端的 `kinds` 也是这个口径（缺省 = 全部），两边同义才不会出现"点空等于全空"。
let 当前kinds = new Set();

async function j(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/** 名字优先、占位符兜底 —— 面板给人看，不该先甩一串 `P2358`。 */
function 显示名(face, fallback) {
  const n = face?.names?.[0];
  return n || fallback || '（无名字）';
}

// ── 左栏：有哪些人 ────────────────────────────────────────────────────────

async function 载入列表(q = '') {
  const box = $('list');
  try {
    const data = await j('/api/vec/person' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    $('listcnt').textContent = `${data.count} 人${q ? '（已筛）' : ''}`;
    box.replaceChildren();
    if (!data.people.length) {
      box.append(el('div', 'empty', q
        ? `没有匹配「${q}」的人。\n搜的是词表（昵称 / QQ 号 / 占位符），不是记忆内容。`
        : '一个人都没有 —— 事实库还是空的。'));
      return;
    }
    for (const p of data.people) {
      const row = el('div', 'row' + (p.speaker === 当前选中 ? ' on' : ''));
      row.append(el('span', 'nm', 显示名(p, p.speaker)));
      row.append(el('span', 'lb', p.speaker));
      const n = el('span', 'n' + (p.slots ? '' : ' zero'), p.slots ? `${p.slots} 条` : '0 条');
      if (!p.slots) n.title = '词表认得这个人，但记忆里一条都没有';
      row.append(n);
      row.addEventListener('click', () => 载入卡(p.speaker));
      box.append(row);
    }
  } catch (e) {
    box.replaceChildren(el('div', 'empty', `读列表失败：${e.message}`));
  }
}

// ── 右栏：卡 ──────────────────────────────────────────────────────────────

/** 谁在卡里被点过名（target → 出现次数）。跨全部场合数。 */
function 目标计数(data) {
  const m = new Map();
  for (const col of data.scopes || []) {
    for (const arr of Object.values(col.factsByKind || {})) {
      for (const f of arr) {
        if (!f.target) continue;
        m.set(f.target, (m.get(f.target) || 0) + 1);
      }
    }
  }
  return m;
}

/** 双人视图过滤后的卡还剩没有内容（决定"空"该说哪句话）。 */
function 过滤后有条数(data) {
  for (const col of data.scopes || []) {
    for (const arr of Object.values(col.factsByKind || {})) {
      if ((arr || []).some((f) => f.target === 当前with)) return true;
    }
  }
  return false;
}

/**
 * 标签筛选条（多选）。
 *
 * `allKinds` 是**过滤前**的全量计数 —— 所以筛过一次之后，其它标签仍在条上、仍点得回去。
 * 若拿"筛后"结果算选项，第一次点击就会把菜单吃掉，只剩一条路：刷新页面。
 */
function 渲染标签条(data) {
  const all = data.allKinds || {};
  const keys = Object.keys(all).sort((a, b) => all[b] - all[a]);
  if (!keys.length) return null;

  const sec = el('div', 'sec');
  sec.append(el('h4', null, '按标签看（可多选）'));
  const kv = el('div', 'kv');

  const 全部 = el('span', 'chip' + (当前kinds.size ? '' : ' on'), `全部 ${data.allSlots ?? data.totalSlots}`);
  全部.style.cursor = 'pointer';
  全部.title = '清掉标签筛选';
  全部.addEventListener('click', () => {
    if (!当前kinds.size) return;
    当前kinds.clear();
    载入卡(当前选中, null);
  });
  kv.append(全部);

  for (const k of keys) {
    const on = 当前kinds.has(k);
    const chip = el('span', 'chip' + (on ? ' on' : ''), `${kindCN(k)} ${all[k]}`);
    chip.style.cursor = 'pointer';
    chip.title = on ? `取消「${kindCN(k)}」` : `只看「${kindCN(k)}」`;
    chip.addEventListener('click', () => {
      if (on) 当前kinds.delete(k); else 当前kinds.add(k);
      载入卡(当前选中, null);
    });
    kv.append(chip);
  }
  sec.append(kv);
  return sec;
}

function 渲染卡(data) {
  const box = $('card');
  box.replaceChildren();

  // ① 认不出这个人
  if (!data.found) {
    const s = el('div', 'say bad');
    s.append(el('b', null, '认不出这个人。'), el('div', null, data.reason || ''));
    box.append(s);
    $('cardcnt').textContent = '';
    return;
  }

  const who = data.who || {};
  const rel = data.related || {};
  const 名 = (label) => (label && label in rel) ? 显示名(rel[label], label) : null;

  const head = el('div', 'cardhead');
  head.append(el('span', 'nm', 显示名(who, who.query)));
  head.append(el('span', 'mono', who.labels?.[0] || ''));
  box.append(head);
  const idline = el('p', 'idline');
  idline.textContent = [
    who.id ? `id ${who.id}` : null,
    who.kind ? who.kind : null,
    who.names?.length > 1 ? `别名 ${who.names.slice(1).join(' / ')}` : null
  ].filter(Boolean).join(' · ');
  box.append(idline);

  // 标签条放在**空态判断之前** —— 筛空时它必须还在，否则用户被锁在"什么都没"的页面里，
  // 连"取消筛选"都点不到。
  if (!当前with) {
    const bar = 渲染标签条(data);
    if (bar) box.append(bar);
  }

  // ② 双人视图的横幅：从星图「两人之间」点进来的那一路。
  //    它要回答的永远是同一个问题——"这俩之间记下了什么"，别的都是干扰。
  if (当前with) {
    const b = el('div', 'say');
    const with名 = 名(当前with) || 当前with;
    b.append(el('b', null, `只看与 ${with名} 有关的记忆。`));
    b.append(el('div', null, '档案（这人是谁）和画像（这人怎么说话）是 TA 自己的，不属于任何一段关系，这里不显示。'));
    const btn = el('button', null, `看 ${显示名(who, who.query)} 的完整卡`);
    btn.style.cssText = 'margin-top:6px;cursor:pointer';
    btn.addEventListener('click', () => 载入卡(当前选中, null));
    b.append(btn);
    box.append(b);
  }

  // ③ 词表里有、但一条事实都没有
  const 全量 = data.allSlots ?? data.totalSlots;
  if (!全量) {
    const s = el('div', 'say');
    s.append(el('b', null, 当前with ? `两人之间没有记下任何东西。` : '一条事实都没有。'), el('div', null, data.reason || ''));
    box.append(s);
    $('cardcnt').textContent = '0 条';
    return;
  }
  // ③b 有记忆，但被标签筛空了 —— 与 ③a 必须是**两句不同的话**
  //     （一个该去聊出来，一个该点回"全部"；写成同一句，用户会以为记的东西丢了）
  if (!data.totalSlots) {
    const s = el('div', 'say');
    s.append(el('b', null, `有 ${全量} 条记忆，但没有你选中的那几类。`), el('div', null, data.reason || ''));
    const btn = el('button', null, '取消筛选，看全部');
    btn.style.cssText = 'margin-top:6px;cursor:pointer';
    btn.addEventListener('click', () => { 当前kinds.clear(); 载入卡(当前选中, null); });
    s.append(btn);
    box.append(s);
    $('cardcnt').textContent = `0 / ${全量} 条`;
    return;
  }
  if (当前with && !过滤后有条数(data)) {
    const s = el('div', 'say');
    s.append(el('b', null, `与 ${名(当前with) || 当前with} 之间没有记下任何东西。`),
      el('div', null, 'TA 自己有记忆，但没有一条是"关于你们俩"的 —— 记事实时没点名到 TA。'));
    box.append(s);
    $('cardcnt').textContent = '0 条相关';
    return;
  }

  // ④ 相关的人：在这张卡的事实里被点过名的角色。点一下 = 切到"两人之间"的视图
  //    （那个人为视角，只显示与他俩有关的事实）—— 星图「两人之间」链接走的就是同一路。
  const counts = 目标计数(data);
  const relatedLabels = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : 1));
  if (relatedLabels.length) {
    const sec = el('div', 'sec');
    sec.append(el('h4', null, '有关的人（事实里被点过名）'));
    const kv = el('div', 'kv');
    for (const lb of relatedLabels) {
      const chip = el('span', 'chip');
      chip.style.cursor = 'pointer';
      chip.title = `点开与 ${名(lb) || lb} 之间记下的印象 / 事件`;
      chip.append(el('b', null, '↔ '));
      chip.append(document.createTextNode(`${名(lb) || lb} `));
      chip.append(el('b', null, `${counts.get(lb)}`));
      chip.addEventListener('click', () => 载入卡(lb, 当前选中));
      kv.append(chip);
    }
    sec.append(kv);
    box.append(sec);
  }

  $('cardcnt').textContent = 当前with
    ? `${relatedLabels.reduce((a, lb) => a + (lb === 当前with ? counts.get(lb) : 0), 0)} 条相关 · ${data.scopeCount} 个场合`
    : `${data.totalSlots} 条 · ${data.scopeCount} 个场合`;

  const showAll = !当前with;
  for (const col of data.scopes) {
    // 双人视图：只留有相关事实的场合，档案/画像不显示（不属于"关系"）
    const factsByKind = {};
    let factTotal = 0;
    for (const [k, arr] of Object.entries(col.factsByKind || {})) {
      const hit = 当前with ? (arr || []).filter((f) => f.target === 当前with) : (arr || []);
      if (hit.length) { factsByKind[k] = hit; factTotal += hit.length; }
    }
    if (!showAll && !factTotal) continue;

    const c = el('div', 'col');
    const ch = el('div', 'colhead');
    ch.append(el('span', 'tag ' + col.kind, col.kind === 'group' ? '群聊' : (col.kind === 'private' ? '私聊' : '其它')));
    ch.append(el('span', 'scope', col.scope));
    ch.append(el('span', 'tag count', showAll
      ? `档案 ${col.counts.profile} · 画像 ${col.counts.facets} · 事实 ${col.counts.facts}`
      : `事实 ${factTotal}`));
    c.append(ch);

    // 档案：结构化键值 —— **放在最前**，它回答"这人是谁"
    if (showAll && col.profile.length) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, '档案（固定特征）'));
      const kv = el('div', 'kv');
      for (const p of col.profile) {
        const chip = el('span', 'chip');
        chip.append(el('b', null, `${p.k}=`), document.createTextNode(p.v));
        kv.append(chip);
      }
      sec.append(kv);
      c.append(sec);
    }

    if (showAll && col.facets.length) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, '画像（这人怎么说话）'));
      const lines = el('div', 'lines');
      for (const f of col.facets) {
        const ln = el('div', 'ln', f.line);
        const m = el('span', 'meta', `${kindCN(f.kind)} · 证据 ${f.evidence_n} · 可信度 ${f.credibility}`);
        ln.append(m);
        lines.append(ln);
      }
      sec.append(lines);
      c.append(sec);
    }

    // 事实：按 kind 分组
    const kinds = Object.keys(factsByKind);
    if (kinds.length) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, showAll ? '事实' : '与 ' + (名(当前with) || 当前with) + ' 有关的记忆'));
      for (const k of kinds) {
        const lines = el('div', 'lines');
        for (const f of factsByKind[k]) {
          const ln = el('div', 'ln');
          if (f.target && 名(f.target)) {
            const to = el('span', 'to');
            to.style.cursor = 'pointer';
            to.title = `点开 ${名(f.target)} 的完整卡`;
            to.append(document.createTextNode(`对 ${名(f.target)}：`));
            // 点名字 = 跳到那个人的完整卡（不是双人视图 —— 想看"两人之间"走上面的 chips）
            to.addEventListener('click', () => 载入卡(f.target, null));
            ln.append(to);
          }
          ln.append(document.createTextNode(f.line));
          ln.append(el('span', 'meta', `${kindCN(k)} · 证据 ${f.evidence_n} · rev ${f.rev}`));
          lines.append(ln);
        }
        sec.append(lines);
      }
      c.append(sec);
    }

    if (showAll) {
      const foot = el('div', 'colfoot', '这个场合学到的只在这个场合出现 —— 换群 / 进私聊都看不到这栏。');
      c.append(foot);
    }
    box.append(c);
  }

  if (showAll && data.scopeCount > 1) {
    box.append(el('div', 'colfoot', `共 ${data.scopeCount} 个场合 —— 故意**不合并**成一栏，见页脚说明。`));
  }
}

async function 载入卡(who, withWho = null) {
  当前选中 = who;
  当前with = withWho;
  // URL 同步：星图带参跳进来、页面内互跳，都让地址栏跟住当前视图 ——
  // 刷新 / 发给别人看到的是同一张卡（who=…&with=…&kinds=…，缺省 = 完整卡）。
  // `kinds` 也进 URL：**筛选是视图的一部分**，不该只在内存里活一次刷新就丢。
  const kindsQs = [...当前kinds].join(',');
  try {
    const u = new URL(location.href);
    u.searchParams.set('who', who);
    if (withWho) u.searchParams.set('with', withWho); else u.searchParams.delete('with');
    if (kindsQs) u.searchParams.set('kinds', kindsQs); else u.searchParams.delete('kinds');
    history.replaceState(null, '', u);
  } catch { /* file:// 等环境下失败无害 */ }

  document.querySelectorAll('.list .row').forEach((r) => r.classList.remove('on'));
  $('cardcnt').textContent = '…';
  try {
    const qs = new URLSearchParams({ who });
    if (kindsQs) qs.set('kinds', kindsQs);
    const data = await j(`/api/vec/person?${qs.toString()}`);
    渲染卡(data);
  } catch (e) {
    const box = $('card');
    box.replaceChildren();
    const s = el('div', 'say bad');
    s.append(el('b', null, '读卡失败。'), el('div', null, `${e.message} —— 服务还在跑吗？`));
    box.append(s);
  }
  // 左栏高亮（列表可能还没渲染完，静默即可）
  const rows = [...document.querySelectorAll('.list .row')];
  const hit = rows.find((r) => r.querySelector('.lb')?.textContent === who);
  if (hit) hit.classList.add('on');
}

// ── 健康灯 ────────────────────────────────────────────────────────────────

async function 探活() {
  const dot = $('health-dot');
  try {
    const r = await fetch('/api/vec/status', { cache: 'no-store' });
    dot.classList.toggle('ok', r.ok);
    dot.classList.toggle('bad', !r.ok);
  } catch {
    dot.classList.add('bad');
  }
}

async function 统计() {
  try {
    const st = await j('/api/vec/status');
    $('stats').replaceChildren();
    const add = (label, v, title) => {
      const n = el('span');
      if (title) n.title = title;
      n.append(document.createTextNode(`${label} `));
      n.append(el('b', null, v));
      $('stats').append(n);
    };
    // ⚠️ `store` 是**向量块**、`facts` 才是**事实槽** —— 两者数量相近时最容易看错
    //    （实测某实例 `store.slots=18` 而事实槽只有 1 条）。分开显示，不拿一个冒充另一个。
    add('事实槽', st.facts?.slots ?? '—', 'factstore 里活着的槽数（人物卡读的就是它）');
    add('覆盖的人', st.facts?.people ?? '—', '至少有一条事实的人');
    add('场合', st.facts?.scopes ?? '—', 'scope 去重后的个数');
    add('向量块', `${st.embedded ?? '—'} / ${st.core?.chunkCount ?? '—'}`,
      '已嵌入 / 源块总数（coverage=' + (st.coverage ?? '—') + '）');
    add('词表实体', st.identity?.entities ?? '—');
    add('索引任务', st.indexJob?.running ? '进行中' : '空闲');
  } catch { /* 统计失败不影响主功能 */ }
}

// ── 启动 ──────────────────────────────────────────────────────────────────

let 搜索定时 = null;
$('q').addEventListener('input', (ev) => {
  clearTimeout(搜索定时);
  const v = ev.target.value.trim();
  // 防抖：每敲一个字就打一次服务，等于把词表扫一遍（500 人 × 每人若干 surface）
  搜索定时 = setTimeout(() => 载入列表(v), 220);
});
$('q').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const v = ev.target.value.trim();
  if (!v) return;
  // 回车 = 直接出卡：搜到第一个人就开。比"先看列表再点"少一步。
  j(`/api/vec/person?q=${encodeURIComponent(v)}`).then((d) => {
    if (d.people?.length) 载入卡(d.people[0].speaker);
    else 载入列表(v);
  }).catch(() => 载入列表(v));
});
$('btn-reload').addEventListener('click', () => { 载入列表($('q').value.trim()); 统计(); });

(async () => {
  await 探活();
  // 星图侧栏「查看人物卡 / 两人之间」带参跳进来：直开那张卡，不让人再找一遍。
  const q = new URLSearchParams(location.search);
  const initWho = q.get('who');
  const initWith = q.get('with');
  const initKinds = (q.get('kinds') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (initKinds.length) 当前kinds = new Set(initKinds);
  await Promise.all([载入列表(), 统计()]);
  if (initWho) await 载入卡(initWho, initWith);
  $('boot').hidden = true;
})().catch((e) => {
  const b = $('boot');
  b.classList.add('bad');
  b.textContent = `页面起不来：${e.message}`;
});
