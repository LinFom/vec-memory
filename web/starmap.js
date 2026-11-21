// starmap.js — 「关系星图」的绘制与交互（服务自带页面，`ADR-0013`）。
//
// 分工：`starmap-layout.mjs` 只算坐标（纯函数、可在 node 断言）；本文件只画与听。
// 所有口径写在 ADR-0011 / ADR-0012 里，本文件不发明新口径。
//
// ── 面板纪律（`ADR-0012` §6，照抄 starlink 踩过的坑）────────────────────
// 1. 状态集中在 `state` 里，**不放在模块级单例** —— 页面被挂载两次时两份互不干扰。
// 2. `rAF` 句柄必须能 `cancel`（切走/卸载就停，别白烧 CPU）。
// 3. 事件监听挂在**自己的 canvas / 窗口**上，并提供 `dispose()`。
// 4. 画布尺寸**每次 `draw()` 都重新读**（面板可伸缩、可隐藏）。
import {
  buildUniverse, rotationMatrix, applyRotation, project, hitTest, placeLabels,
  starRadiusPx, resolvability, individuationPolicy, pointInRect,
  spokeAlpha, lineScaleForZoom, CHORD_ALPHA_FLOOR, widthOf, starWorldPos,
  CORE_GLOW_K, CORE_ALPHA_FAR, CORE_ALPHA_NEAR,
  GLOW_ALPHA_MUL, GLOW_STOPS,
  TIER_COUNT
} from '/starmap-layout.mjs';

// ── 配色：四个通道各管一件事（ADR-0012 §8）──────────────────────────────
// 群色（辐条 + 星点）：与"深厚档色"**语义不同**，靠图例显式声明区分。
const GALAXY_COLORS = {
  dark: ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc'],
  light: ['#0369a1', '#6d28d9', '#be185d', '#047857', '#b45309', '#be123c', '#0e7490', '#7e22ce']
};
// 深厚档色：暖 → 冷（深 = 暖金 / 中 = 橙铜 / 浅 = 冷蓝灰）
const TIER_COLORS = {
  dark: ['#7c8aa5', '#d97706', '#f5c451'],
  light: ['#94a3b8', '#c2410c', '#b45309']
};
const TIER_NAMES = ['浅', '中', '深'];

// 相机距离（与 `project()` 的默认值必须一致 —— 显式传进去，别让两处各写一个魔数）。
const CAM_DIST = 3.2;
// 默认缩放：**要让宇宙填满画布**。世界半径上限 R_MAX=1，相机距离 3.2 ⇒ 投影比例
// s = min(W,H)·0.5·zoom/3.2。zoom=1 时整个宇宙只占画布高度的约 1/3，中间一小坨，
// 观感就是"这也没有星星啊"（用户原话）。解 0.5·zoom/3.2 = 0.39 ⇒ zoom ≈ 2.5。
// ⚠️ 2.5 → 3.4：**取景**问题（用户："这看起来不像星空啊"）。
//    实测（1280×728 / 真数据）整个宇宙的屏幕包围盒：2.5× 只有 492×472px ——
//    只占画布宽度的 **38%**，于是"一整幅图里有一小块东西"读起来是**空**，不是星空。
//    选 3.4× 的判据：包围盒 ≈ 669×642，**高度刚好铺满、宽度 52%，且五团一个不少**；
//    再往上（4.3× 起）纵向就开始出血（超出画布 111%），"全景"这条就没了。
//    这是**取景**，不是尺度法则：`LINE_ZOOM_REF`（线宽基准）仍然独立在 2.5。
const DEFAULT_ZOOM = 3.4;
const DEFAULT_YAW = 0.5;
const DEFAULT_PITCH = 0.26;
// 相机自漂移（ADR-0022）：**「动」的主角从此是星，不是相机**。
// 旧值 0.055 rad/s 在半径 200px 处给出 11px/s 的切向速度 —— 它会**盖住**星系自转
// （实测星的切向速度只有 4~6px/s）⇒ 用户根本看不出"成员在自己转"。收到 0.012
// 只剩一点空间纵深感，镜头不再抢戏。
const CAMERA_DRIFT = 0.012;
// ── 缩放范围（ADR-0014 §4）──────────────────────────────────────────────
// 尺寸与缩放脱钩之后，要分开 979 颗星需要 zoom ≈ 8–11×（判据：可分辨度 ≥ 2），
// 而旧上限是 3.2 —— **滚到底也到不了**。放开到 24× 覆盖千人群；万级不承诺
// （但可分辨度本身是自适应的，降级路径是天然的：云会更早出现）。
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 24;
const ZOOM_STEP = 1.15;          // 乘性步进（对数手感），不是加减
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(z) || DEFAULT_ZOOM));

const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

// ── 天的颜色：与主题**无关**，所以**在模块加载时读一次**就够 ─────────────────
// ⚠️ 这里踩过一个静默坑：天的读取原本写在 `applyTheme()` 里，而那个函数开头有一句
//    "主题没变就直接 return"。于是**默认主题（暗色）下它永远不执行** ⇒ `state.css.skyHi`
//    是 undefined ⇒ `addColorStop(undefined)` 抛异常 ⇒ **整幅画布全黑，且只有暗色主题黑**
//    （亮色主题因为"主题确实变了"反而正常）。教训：**带 early-return 的缓存初始化不是初始化** ——
//    与主题无关的值不要挂在主题切换上。现在由 `readSky()` 在加载时无条件读一次。
const SKY_HI_DEFAULT = '#0e1730', SKY_LO_DEFAULT = '#03050b', SKY_FG_DEFAULT = '#e8edf7';
function readSky() {
  const cs = getComputedStyle(document.documentElement);
  state.css = {
    skyHi: cs.getPropertyValue('--sky-hi').trim() || SKY_HI_DEFAULT,
    skyLo: cs.getPropertyValue('--sky-lo').trim() || SKY_LO_DEFAULT,
    fg: cs.getPropertyValue('--sky-fg').trim() || SKY_FG_DEFAULT
  };
}

const state = {
  theme: 'dark',
  graph: null, names: {}, notes: {},
  uni: null,
  policy: null,                    // 每帧由「可分辨度」算出的个体化策略（ADR-0014）
  yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, zoom: DEFAULT_ZOOM,
  hover: null, selected: null,
  playing: !REDUCED, showNames: true, onlyLinked: false,
  clock: 0,                        // 运动时钟（秒，ADR-0022）：星的位置 = starWorldPos(星, clock)
  dpr: 1, w: 0, h: 0,
  raf: 0, last: 0, dragging: false, moved: 0, dragFrom: null,
  dirty: true,                     // 脏标记（ADR-0020）：不转/不拖/不变 ⇒ 不重绘（静止时 0 帧）
  projected: [], nebulaeProjected: [], sprites: new Map(),
  css: { skyHi: SKY_HI_DEFAULT, skyLo: SKY_LO_DEFAULT, fg: SKY_FG_DEFAULT }   // 由 readSky() 在加载时覆盖
};

const $ = (s) => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d', { alpha: false });

// ── 主题 ────────────────────────────────────────────────────────────────
function applyTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  if (state.theme === next && document.documentElement.dataset.theme === next) return;
  state.theme = next;
  document.documentElement.dataset.theme = next;
  state.sprites = new Map();       // 光晕贴图按色缓存 ⇒ 换主题要重建
  state.dirty = true;              // 面板色变了（天色不变）⇒ 重绘（ADR-0020）
  // 天的颜色**不在这里读**（它与主题无关，见 readSky）。这里只管 DOM 主题与贴图缓存。
  try { window.parent?.postMessage({ type: 'mv-starmap-theme', theme: next }, '*'); } catch { /* 独立打开时没有 parent */ }
}
readSky();   // ⚠️ 必须在任何 draw 之前（且不依赖主题切换），见上面的教训
{
  const qp = new URLSearchParams(location.search).get('theme');
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches === true;
  applyTheme(qp || (prefersLight ? 'light' : 'dark'));
}
window.addEventListener('message', (e) => {
  const d = e?.data;
  if (d && d.type === 'mv-theme' && (d.theme === 'dark' || d.theme === 'light')) applyTheme(d.theme);
});

const pickColor = (arr, i) => {
  const n = Number(i);
  if (!Number.isFinite(n)) return arr[arr.length - 1];
  return arr[((Math.trunc(n) % arr.length) + arr.length) % arr.length];
};
// ── 「面板色」与「天色」是两套（本轮新定；起因：用户"这看起来不像星空啊"）──────
// ⚠️ 星是**发光体** —— 它只在暗背景上成立。白底上无论怎么画，得到的都是
//    "墨点 + 网格线"（一张星座图 / 散点图），**不可能是星空**。实测亮色主题下
//    92.6% 的像素是纯白，星点与光晕全被背景吃掉。
//    宿主面板的亮/暗主题管的是**面板 chrome**（顶栏、图例、侧栏），不该管这片天。
//    所以：**画布与画布上的一切恒定走暗色一套**（天底色 / 星星 / 深厚档 / 名字 / 标签）。
//    `galaxyColor` / `tierColor` 留给 DOM；画布一律用 `skyGalaxy` / `skyTier`。
const galaxyColor = (i) => pickColor(GALAXY_COLORS[state.theme], i);
const tierColor = (t) => TIER_COLORS[state.theme][Math.min(TIER_COUNT - 1, Math.max(0, t))];
const SKY = 'dark';
const skyGalaxy = (i) => pickColor(GALAXY_COLORS[SKY], i);
const skyTier = (t) => TIER_COLORS[SKY][Math.min(TIER_COUNT - 1, Math.max(0, t))];
const SKY_FG = '#cbd5e1';           // 天上的字（恒星名 / 群名）：亮色一套
const SKY_HALO = 'rgba(0,0,0,.75)'; // 字的描边（暗底上要暗描边，才不是一团糊）

// ── 星的"芯"与"晕"是两个颜色（用户："这看起来不像星空啊"）─────────────────
// 直接用群色画实心点 ⇒ 得到一颗颗**高饱和的糖豆**（青/粉/紫），一眼是散点图。
// 真实的星是**白热的**，颜色只出现在它周围那圈光晕里。所以：
//   **白芯 + 彩晕** —— 既像星星，又没有丢掉"颜色 = 群"这条通道（ADR-0012 §8）。
// ⚠️ 只在暗底掺白：亮底的星是"墨点"（深色群色），掺白会在白底上消失。
function lightenToWhite(hex, k) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(full, 16);
  const m = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
}
const CORE_WHITE_MIX = 0.58;          // 掺白比例：0.58 ⇒ 明显是"白星"但仍看出偏色
const coreColorCache = new Map();
const starCore = (color) => {
  if (SKY !== 'dark') return color;   // 天永远是暗的 ⇒ 这条分支不生效，留着是为了语义显式
  let c = coreColorCache.get(color);
  if (!c) { c = lightenToWhite(color, CORE_WHITE_MIX); coreColorCache.set(color, c); }
  return c;
};

/** 光晕贴图（预渲染，避免每帧造 radialGradient —— 上千颗星时那是纯浪费）。 */
function sprite(color) {
  let c = state.sprites.get(color);
  if (c) return c;
  const S = 64;
  c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // 剖面**只在布局层定义一次**（`GLOW_STOPS`）—— 测试要用它算"叠爆不等式"，
  // 抄一份在这里就等于让那条不等式失去唯一的真相。
  for (const [off, a] of GLOW_STOPS) grd.addColorStop(off, a >= 1 ? color : colorWithAlpha(color, a));
  g.fillStyle = grd;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
  state.sprites.set(color, c);
  return c;
}

function colorWithAlpha(hex, a) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── 显示名（ADR-0010：隐私边界在出境处，不在界面）──────────────────────
function displayName(id) {
  if (!id) return '';
  const note = state.notes?.[id]?.text;
  if (note) return note;
  const n = state.names?.[id];
  if (n?.display) return n.display;
  const g = state.uni?.galaxies?.find((x) => x.scope === id);
  if (g) return `群 ${id.replace(/^group:/, '')}`;
  return id;
}
function subLabel(id) {
  const n = state.names?.[id];
  const surfaces = n?.surfaces || [];
  const others = surfaces.filter((s) => s !== n?.display);
  return others.length ? `又名 ${others.slice(0, 4).join('、')}` : '';
}
function isSelf(id) { return id && id === state.uni?.center?.id; }

// 三类轨道的中文口径（ADR-0022）——**摆出来**：用户看到"星在动"，得知道它按什么在动，
// 否则只能猜（"它们在乱飘"）。同一句话同时用在提示框与右侧详情里，不写两套。
const ORBIT_NAMES = {
  galaxy: '星系内自转（离盘心越近越快）',
  bridge: '绕宇宙中心公转（依次经过它参与的每个群）',
  drift: '绕宇宙中心慢转（没有群属）'
};
const orbitName = (star) => ORBIT_NAMES[star?.orbit?.kind] || '—';

/**
 * 给页脚那句"几个群"补上**群名取到了没有**（`state.groupNames`，来自 `/identity/names`）。
 * 拉不到时把服务器的原话带出来 —— 否则"群名没取到"与"群本来就没名字"在界面上一样。
 */
function groupNamesNote() {
  const g = state.groupNames;
  if (!g) return '';                       // 旧服务：没有这项诊断，不编
  if (g.count > 0) return ` 群名 ${g.count} 个（取自宿主${g.stale ? '，陈旧 · 正在后台刷新' : ''}）。`;
  return ` 群名没取到：${g.error || '宿主没有返回任何群'}（群标签暂用代号）。`;
}

/**
 * **画在星图上的**名字：过长的昵称截断（完整名 + 备注在悬停提示与右侧详情里看）。
 * 实测数据里真有 19 个字的群昵称（"路边装忧郁险些被鬼火撞飞靠正态扭腰躲过"）——
 * 不截断的话它一条就把中心区横扫掉，别的名字全被它挤没了。截断只影响画布，不改数据。
 */
const LABEL_MAX_CHARS = 12;
function labelName(id) {
  const n = displayName(id);
  return n.length > LABEL_MAX_CHARS ? `${n.slice(0, LABEL_MAX_CHARS)}…` : n;
}

/**
 * 12px 字体下的一行文字宽度估算（标签避让用）。
 * CJK ≈ 12px/字、ASCII ≈ 6.5px/字，**再加 6px 描边余量**（`strokeWidth=3` ⇒ 左右各外扩 3px）。
 * 粗估够用；**宁可估宽**：估宽只是少放几个名字，估窄会让名字继续重叠
 * （那条正是要被消灭的现象）。实测：漏掉描边余量时，看着仍有挤在一起的名字。
 */
function labelWidth(text) {
  let w = 6;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 0x2e80 ? 12 : 6.5;
  return w;
}

// ── 取数 ────────────────────────────────────────────────────────────────
async function loadAll() {
  const boot = $('#boot');
  boot.hidden = false;
  boot.className = 'boot';
  boot.innerHTML = '<span class="spin"></span> 正在读取关系边…';
  try {
    const [hr, gr, nr, or] = await Promise.all([
      fetch('/health').then((r) => r.json()).catch(() => null),
      fetch('/api/vec/graph?k=8').then((r) => r.json()),
      fetch('/api/vec/identity/names').then((r) => r.json()).catch(() => ({ names: {} })),
      fetch('/api/vec/notes').then((r) => r.json()).catch(() => ({ notes: {} }))
    ]);
    $('#health-dot').className = `dot ${gr?.ok ? 'ok' : 'bad'}`;
    if (!gr?.ok) throw new Error(gr?.error || '取不到关系边');
    state.graph = gr;
    state.names = nr?.names || {};
    // 群名（星系标签的真名）的取数现状：服务器去问宿主要的群列表。
    // **必须摆出来**：拉不到时群标签会退回 `群 C9814`，不说清原因的话
    // 用户只会以为"这功能没做"，而实际上是宿主没开 / 没连协议端。
    state.groupNames = nr?.groups || null;
    state.notes = or?.notes || {};
    buildFromGraph(gr);
    state.dirty = true;
    boot.hidden = true;
    renderStats(gr);
    renderLegend();
    $("#sub").textContent = gr.center?.id
      ? `中心是 ${displayName(gr.center.id)}；${gr.scopes.filter((s) => s.kind === 'group').length} 个群 = ${gr.scopes.filter((s) => s.kind === 'group').length} 个星系。`
        + groupNamesNote()
      : '没有判定出"我是谁" —— 跑到「隐私脱敏」页点一次「更新脱敏名单」。';
    if (hr === null) $('#health-dot').className = 'dot bad';
  } catch (e) {
    boot.className = 'boot bad';
    boot.innerHTML = `读不到关系边：${esc(String(e?.message || e))}<br>` +
      `服务在跑吗？（<code>/health</code>）数据源配的是宿主 data 吗？`;
  }
}

function buildFromGraph(gr) {
  const centerId = gr.center?.id || '';
  // 0.26.0（ADR-0040）：深度输入从"百分位"换成"绝对量的对数饱和"，所以这里必须把
  // **raw** 一起递给布局 —— normalized 是"占消息总量的份额"，把它当 raw 会全部瞬间饱和。
  const spokes = (gr.center?.spokes || []).map((s) => ({
    id: s.id,
    cooc: Number(s.cooccurrence?.normalized) || 0,
    inter: Number(s.interaction?.normalized) || 0,
    coocRaw: Number(s.cooccurrence?.raw) || 0,
    interRaw: Number(s.interaction?.raw) || 0,
    byScope: s.by_scope || {}
  }));
  // 弦 = 人 ↔ 人：把中心与人的边排除掉 —— 那是辐条，不是弦（ADR-0012 §8 两类线语义不同）。
  const chords = (gr.edges || [])
    .filter((e) => e.a !== centerId && e.b !== centerId)
    .map((e) => ({
      a: e.a, b: e.b,
      cooc: Number(e.cooccurrence?.normalized) || 0,
      inter: Number(e.interaction?.normalized) || 0,
      coocRaw: Number(e.cooccurrence?.raw) || 0,
      interRaw: Number(e.interaction?.raw) || 0,
      byScope: e.by_scope || {}
    }));
  state.uni = buildUniverse({ centerId, scopes: gr.scopes || [], spokes, chords });
}

// ── 画布尺寸（每帧重读，纪律 #4）──────────────────────────────────────
function fitCanvas() {
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w === state.w && h === state.h && dpr === state.dpr) return false;
  state.w = w; state.h = h; state.dpr = dpr;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  return true;
}
// 画布尺寸变化不再靠每帧 `getBoundingClientRect()`（强制布局）轮询 —— 用 RO 观察，
// 只在真的变了的时候把 dirty 打开（ADR-0020）。fitCanvas 本身只在 dirty 帧执行。
try {
  const ro = new ResizeObserver(() => { state.dirty = true; });
  ro.observe(cv);
} catch {
  // 不支持 RO 的环境：loop 每帧调 fitCanvas()（它内部有"尺寸没变就返回"的短路），
  // 回到旧成本 —— 功能正确性优先。
}

// ── 每帧 ────────────────────────────────────────────────────────────────
// ⚠️ 脏标记（ADR-0020）：旧版这里**每帧无条件** `fitCanvas()`（强制布局）+ `draw()`（全量重绘）
//    —— 自转关掉也一样跑满 60fps，静止时也在烧一个核。现在只有 `dirty` 才动手：
//    自转/拖拽把 dirty 打开，其余一切交互（滚轮/点击/开关/主题/数据）在自己的 handler 里打开。
function loop(t) {
  state.raf = requestAnimationFrame(loop);
  const dt = state.last ? Math.min(0.05, (t - state.last) / 1000) : 0;
  state.last = t;
  if (state.playing && !state.dragging && !REDUCED) {
    // `dt` 上限 0.05s：标签页切回来时那一大跳不许把星瞬移出去（也让相位与"看的时间"大致对齐）
    state.clock += dt;                 // 星系自转 / 跨群公转（ADR-0022）
    state.yaw += CAMERA_DRIFT * dt;
    state.dirty = true;
  }
  if (!state.dirty) return;
  state.dirty = false;
  fitCanvas();
  draw();
}

function draw() {
  const uni = state.uni;
  const W = state.w, H = state.h;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  // 底：**恒定深空**（不跟主题，见文件上方 SKY）+ 极淡的中心辉光。
  // 用一层很宽的径向渐变而不是纯色：纯黑的大方块读起来像"没画完"，
  // 中间略亮、四周更沉的天，才有"天空"的体积感。
  const skyGrd = ctx.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.46, Math.max(W, H) * 0.75);
  skyGrd.addColorStop(0, state.css.skyHi);
  skyGrd.addColorStop(1, state.css.skyLo);
  ctx.fillStyle = skyGrd;
  ctx.fillRect(0, 0, W, H);
  if (!uni) return;

  const m = rotationMatrix(state.yaw, state.pitch);
  const view = { width: W, height: H, zoom: state.zoom, camDist: CAM_DIST };
  const selected = state.selected;

  // ── 可分辨度 → 个体化策略（ADR-0014）────────────────────────────────
  // `res = 屏幕最近邻间距 ÷ 星点半径`。它是**唯一的**"现在能不能分辨个体"的量，
  // 一个旋钮同时驱动：个体显隐 / 弦分档渐显 / 整体压淡。人数翻四倍 ⇒ res 减半
  // ⇒ 云自动更早出现（`res ∝ zoom ÷ √人数`），不需要为千人群手调任何阈值。
  const refScale = Math.min(W, H) * 0.5 * state.zoom / CAM_DIST;
  const res = resolvability(uni.stats?.worldNNSep || 0, refScale, starRadiusPx(0.5));
  // 屏幕上的典型邻居间距：远景光晕的大小按它来定（相邻光晕相接 ⇒ 连成一片云），
  // 于是"人数翻四倍、间距减半 ⇒ 光晕自动收细"，云的手感不随人数变。
  const spacingPx = (uni.stats?.worldNNSep || 0) * refScale;
  // 屏幕尺寸通道（ADR-0018）：宇宙在屏幕上的像素直径 —— 弦"分两层退场"的锚
  const spanPx = (uni.stats?.worldSpan || 0) * refScale;
  const policy = individuationPolicy(res, { spacingPx, spanPx, canvasH: H });
  state.policy = policy;

  // ── 投影全部世界点 ─────────────────────────────────────────────────
  const galaxyIndex = new Map(uni.galaxies.map((g, i) => [g.scope, i]));
  const camCenter = applyRotation([0, 0, 0], m);
  const pCenter = project(camCenter, view);
  const nebulae = uni.galaxies.map((g) => {
    const world = g.core;   // ADR-0017：核光斑画到**球心**（成员就在球里，标记不再挂到没星的天上）
    const cam = applyRotation(world, m);
    return { g, cam, screen: project(cam, view) };
  });
  const stars = [];
  for (const s of uni.stars) {
    if (state.onlyLinked && !s.touchedCenter && s.id !== selected) continue;
    // ⚠️ 位置**不再是常量**：每帧问一次"这颗星此刻在哪"（ADR-0022）。
    //    `state.clock = 0`（暂停 / prefers-reduced-motion）时它逐位等于静止布局，
    //    所以"暂停看到的"就是"建宇宙时算的那一帧" —— 截图与测试都看那一帧。
    const world = starWorldPos(s, state.clock);
    const cam = applyRotation(world, m);
    const sc = project(cam, view);
    // ⚠️ 半径**只看深度、不看缩放**（ADR-0014 §1）—— 这就是"比例尺越大越细"的可证形式。
    stars.push({ star: s, cam, screen: sc, radiusPx: starRadiusPx(s.depth), alpha: policy.starAlpha(s.depth) });
  }
  stars.sort((a, b) => a.cam[2] - b.cam[2]);
  const starById = new Map(stars.map((x) => [x.star.id, x]));
  state.projected = stars;
  // 视口矩形（外扩一圈：半在画布外的星/线仍要画，不然边缘会凭空断掉）。
  // 高倍率下大部分星在画布外 —— 不做这一步，"两端都在画布外、横穿画面"的弦会留下
  // 一条条长长的痕迹，把视野糊成一片（实测 8× 时的假故障）。
  const vp = { minX: -48, minY: -48, maxX: W + 48, maxY: H + 48 };

  // ⚠️ 光晕的混合模式**必须按主题分叉**：暗底用加色（`lighter`，光叠光变亮 —— 那才是星云）；
  //    亮底**不能用加色**：任何颜色加到近白背景上都饱和成白 ⇒ **云与光晕在亮色主题下彻底消失**。
  //    亮底也不用正片叠底（`multiply`）—— 实测它会一路叠成一块深色实心斑（太重）；
  //    亮底用普通叠加（`source-over`）：叠到纯色即饱和，正好是"水彩一层层加深"的手感。
  const glowOp = 'lighter';   // 天恒暗 ⇒ 恒加色（亮底那套已废，见 SKY）

  // ── 星系核（星云的地标）────────────────────────────────────────────
  // 半径跟着**星团自身的张角**走（不再用 `zoom/200` 这类魔数）⇒ 放大时它和星团一起长大；
  // 但**只是星团的一小块核心**（`CORE_GLOW_K`），不是把整个星系盖住的那种大光斑。
  // ⚠️ 曾经它是 `× 1.16`（主群亮斑直径 ≈ 450px）配 0.26 加色 —— 那正是"不像星空"的头号功臣：
  //    一块盖住所有星点的平滑色斑。**密度才是星云的材质，光斑只负责"一眼看出核在哪"。**
  const nebAlpha = CORE_ALPHA_FAR + (CORE_ALPHA_NEAR - CORE_ALPHA_FAR) * policy.t;
  for (const nb of nebulae) {
    if (!nb.screen.visible || !pointInRect(nb.screen.x, nb.screen.y, vp)) continue;
    const color = skyGalaxy(nb.g.colorIndex);
    const r = Math.max(9, nb.screen.scale * nb.g.ballR * CORE_GLOW_K) * (0.75 + 0.5 * nb.g.share);
    ctx.globalCompositeOperation = glowOp;
    ctx.globalAlpha = nebAlpha * (nb.g.kind === 'group' ? 1 : 0.55);
    ctx.drawImage(sprite(color), nb.screen.x - r, nb.screen.y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ── 弦（人 ↔ 人）：按 (档色, 透明度桶, 虚实) 合批 ────────────────────
  const buckets = new Map();
  const dim = selected ? 0.16 : 1;   // 选中时整体压暗，只亮它自己那一圈
  // 线宽/透明度的缩放补偿（ADR-0014 §5）：线宽恒定而线长 ∝ 倍率 ⇒ 墨量 ∝ 倍率。
  // 两边各乘 1/√倍率 ⇒ 墨量与倍率无关，放大只让结构散开、不会越看越糊；
  // 同时"线随比例尺变细"正是用户那句原话的落实。
  const inkScale = lineScaleForZoom(state.zoom);
  for (const c of uni.chords) {
    if (c.tier < policy.chordFloor) continue;   // 屏幕尺寸通道（ADR-0018）：缩到足够小，浅/中/全部依次退场
    const A = starById.get(c.a), B = starById.get(c.b);
    if (!A || !B) continue;
    // 两端都看不见 ⇒ 只是"路过"画面的弦：读不出是谁跟谁，纯粹是噪声（实测 8× 时糊成一片）
    if (!pointInRect(A.screen.x, A.screen.y, vp) && !pointInRect(B.screen.x, B.screen.y, vp)) continue;
    const related = !selected || selected === c.a || selected === c.b;
    // 分档渐显（ADR-0014 §2）：远→近逐档出现，**深档永远留骨架**（CHORD_DEEP_KEEP），
    // 再乘一个随缩放的**整体压淡**系数。意义在于："切在哪"从此是一条**连续曲线**，
    // 而不是"第 741 条被丢掉"那种硬判据（深厚分是百分位，那条线本来就不存在）。
    const alpha = c.alpha * policy.chordAlphaFactor(c.tier) * inkScale * (related ? dim : dim * 0.35);
    // 低于可见下限 ⇒ 不画（"淡到看不见"就该看不见，别抬到看得见 —— 那条钳位会把渐显废掉）
    if (alpha < CHORD_ALPHA_FLOOR) continue;
    const key = `${c.tier}|${c.dashed ? 1 : 0}|${Math.round(alpha * 8)}|${related ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tier: c.tier, dashed: c.dashed, alpha, related, w: c.width, pts: new Path2D() };
      buckets.set(key, b);
    }
    b.pts.moveTo(A.screen.x, A.screen.y);
    b.pts.lineTo(B.screen.x, B.screen.y);
  }
  for (const b of buckets.values()) {
    ctx.strokeStyle = skyTier(b.tier);
    ctx.globalAlpha = Math.min(0.85, b.alpha);   // 下限已在入桶前筛掉（CHORD_ALPHA_FLOOR）
    ctx.lineWidth = Math.max(0.4, (b.related ? b.w : 1) * inkScale);
    ctx.setLineDash(b.dashed ? [4, 4] : []);
    ctx.stroke(b.pts);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // ── 辐条（人 ↔ 中心）：颜色 = 群色，恒细 —— 但**亮度跟着那个人走** ──────
  // ⚠️ 这里是唯一"全都汇于一点"的线族：实测 2.5× 时约 800 条辐条以恒 0.22 实拉，
  //    全叠在她身上 ⇒ 远景那片"糊作一团"的主因是辐条，不是弦（弦在远景只剩深档 0.152）。
  //    修法即 ADR-0014 §2 的第四处同步：`spokeAlpha(那个人的亮度)` —— 云里的人，
  //    他的辐条也只是云的一部分；只有浮出尘埃的那几十人，你才顺着辐条看清"她连着他"。
  //    这同时把"人数"这个唯一会线性恶化墨量的因子接进了同一个旋钮。
  if (pCenter.visible) {
    const spokeBuckets = new Map();
    for (const item of stars) {
      const s = item.star;
      // 只给**看得见的人**画辐条：一条伸向画布外的辐条本身就是噪声（你不知道它是谁的）。
      if (!pointInRect(item.screen.x, item.screen.y, vp)) continue;
      const sa = spokeAlpha(item.alpha) * inkScale;
      if (sa <= 0.008) continue;   // 并入云了 ⇒ 不画（远景时这是绝大多数人）
      if (!s.galaxies?.length) {
        // 只有私聊 / 没进任何群：画一条灰色的内环辐条，别让它看起来"不属于任何地方"
        pushSpoke(spokeBuckets, 'private', item.screen, pCenter, sa);
        continue;
      }
      for (const g of s.galaxies) {
        const gi = uni.galaxies.findIndex((x) => x.scope === g.scope);
        pushSpoke(spokeBuckets, gi >= 0 ? gi : 'private', item.screen, pCenter, sa);
      }
    }
    for (const [, b] of spokeBuckets) {
      ctx.strokeStyle = b.key === 'private' ? '#64748b' : skyGalaxy(Number(b.key));
      ctx.globalAlpha = Math.max(0.02, Math.min(0.85, b.alpha));
      ctx.lineWidth = Math.max(0.4, 1 * inkScale);
      ctx.stroke(b.pts);
    }
    ctx.globalAlpha = 1;
  }

  // ── 星点（ADR-0020 合批）────────────────────────────────────────────
  // ⚠️ 模糊的主因从来不是点，是**光晕**（实测：实心点只覆盖 7% 画布，光晕单独 84%）。
  //    所以光晕的半径与透明度都跟着 `alpha` 走 —— 远景时尘埃星的光晕几乎收成一层膜，
  //    上千个叠起来就是那片云；深星才带大光晕浮在上面。**这就是"涌现式星云"**：
  //    不额外画云，云是淡去的星自己叠出来的（ADR-0014 §2）。
  // ⚠️ 合批：旧版**每颗星切 2 次混合模式**（实测 3.4× 时 2307 次/帧 —— 每次切换都是
  //    一次管线状态翻转）。现在先一次 `glowOp` 画完**所有**光晕、再一次 `source-over`
  //    画完**所有**芯 ⇒ 全帧 2 次切换。视觉逐像素等价：两种混合模式互不依赖绘制顺序
  //    （lighter 加色可交换；芯永远盖在自己的光晕上 —— 同一颗星的光晕先于芯，合批后仍成立）。
  const visibleStars = [];
  for (const item of stars) {
    if (!pointInRect(item.screen.x, item.screen.y, vp)) continue;   // 画布外的星不画（省时间，也不误判）
    const s = item.star;
    const gi = galaxyIndex.get(s.dominant) ?? -1;
    const color = skyGalaxy(gi >= 0 ? gi : 7);
    const a = Math.max(0, Math.min(1, item.alpha));
    item.glowR = item.radiusPx * policy.glowMul(a, item.radiusPx);
    item.color = color;
    item.coreColor = starCore(color);
    item.a = a;
    visibleStars.push(item);
  }
  ctx.globalCompositeOperation = glowOp;
  for (const item of visibleStars) {
    // ⚠️ 0.62 → 0.45：光晕现在**小**了（见 GLOW_FAR_SPACING_K），但"小"必须配"不浓"，否则
    //    密处照样叠爆。**星点才是主角**：单独一颗星看起来应该是"一个亮点 + 一圈晕"，
    //    而不是一团毛。这一条与光晕半径是**同一件事的两半**，改一个必须改另一个。
    ctx.globalAlpha = item.a * GLOW_ALPHA_MUL;
    ctx.drawImage(sprite(item.color), item.screen.x - item.glowR, item.screen.y - item.glowR, item.glowR * 2, item.glowR * 2);
  }
  ctx.globalCompositeOperation = 'source-over';   // 实心点永远实心，不参与叠色
  for (const item of visibleStars) {
    ctx.globalAlpha = item.a;
    ctx.fillStyle = item.coreColor;                // 白芯 + 彩晕（见 starCore）
    ctx.beginPath(); ctx.arc(item.screen.x, item.screen.y, item.radiusPx, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 中心 = 她：最大最亮。
  // ⚠️ 她是**唯一**还跟着缩放走的图形（有意为之，ADR-0014 §1 的例外）：她是地标、
  //    不是"人群里的一员"，不参与拥挤问题 —— 远景收一点免得压住整片云，近景像个太阳。
  if (pCenter.visible) {
    const zk = Math.max(0.60, Math.min(1.5, state.zoom / DEFAULT_ZOOM));
    const r = 30 * zk;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(sprite('#ffd88a'), pCenter.x - r, pCenter.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff3d6';
    ctx.beginPath(); ctx.arc(pCenter.x, pCenter.y, Math.max(3.5, 5.4 * zk), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // ── 名字 ───────────────────────────────────────────────────────────
  // ⚠️ **必须避让**：世界半径 R_MAX=1、相机距离 3.2 时，投影比例 s≈min(W,H)*0.5*zoom/3.2；
  //    中心密集区里几十颗星挤在几十像素内，不避让的话名字会糊成一团 ——
  //    这正是"看不出来谁是谁"的成因（用户最初的原话）。
  //    判定逻辑是**纯函数** `placeLabels()`（web/starmap-layout.mjs，有测试）：这里只负责
  //    量宽度、给候选、按结果画。星系核的名字先占位（它们是地标，且后画，不先占会被盖）。
  ctx.font = '12px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const colorFg = state.css.fg;
  const pin = (x) => x.star.id === state.selected || x.star.id === state.hover?.star?.id;
  const LABEL_H = 14;

  const nbCands = nebulae.filter((nb) => nb.screen.visible && pointInRect(nb.screen.x, nb.screen.y, vp) && labelName(nb.g.scope))
    .map((nb) => ({
      kind: 'galaxy', id: nb.g.scope, name: labelName(nb.g.scope),
      x: nb.screen.x, y: nb.screen.y - 12,
      width: labelWidth(labelName(nb.g.scope)),
      pinned: true, depth: 1, screen: nb.screen
    }));
  const nbPlaced = placeLabels(nbCands, { max: 99, height: LABEL_H });

  // 名字的入选门槛也由可分辨度驱动：远景只标最深的几颗（其余是尘埃，标了也读不出），
  // 近景门槛一路降到 0.45。（总上限仍由 `placeLabels` 的 `max` 兜住，所以不会因为
  // 门槛降低就糊回去。）
  const depthCut = 0.92 + (0.45 - 0.92) * policy.t;
  const starCands = (state.showNames ? stars.filter((x) => pin(x) || x.star.depth >= depthCut) : stars.filter(pin))
    .map((item) => {
      const name = labelName(item.star.id);
      return {
        kind: 'star', id: item.star.id, name, item,
        x: item.screen.x, y: item.screen.y - item.radiusPx - 4,
        width: labelWidth(name),
        pinned: pin(item), depth: item.star.depth
      };
    }).filter((c) => c.name && pointInRect(c.x, c.y, vp));
  const starPlaced = placeLabels(starCands, { max: 28, height: LABEL_H, occupied: nbPlaced.map((p) => p.box) });

  for (const c of starPlaced) {
    ctx.globalAlpha = c.pinned ? 1 : 0.62;
    ctx.lineWidth = 3;
    ctx.strokeStyle = SKY_HALO;
    ctx.strokeText(c.name, c.x, c.y);
    ctx.fillStyle = c.pinned ? colorFg : SKY_FG;
    ctx.fillText(c.name, c.x, c.y);
  }
  // 星系核的名字（群没有真名 ⇒ 显示占位符或你写的备注）
  for (const c of nbPlaced) {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    ctx.strokeStyle = SKY_HALO;
    ctx.strokeText(c.name, c.x, c.y);
    ctx.fillStyle = colorFg;
    ctx.fillText(c.name, c.x, c.y);
  }
  ctx.globalAlpha = 1;
  state.nebulaeProjected = nebulae;
  syncZoomBadge();
}

/**
 * 倍率指示（ADR-0014 §4）：用户能直接说出"比例尺"这个词 ⇒ 看不到当前倍率就没法讨论它。
 * 只在文字真变时才写 DOM（每帧写会触发布局计算）；顺便把"现在是云还是星"标出来。
 */
function syncZoomBadge() {
  const el = $('#zoom-badge');
  if (!el) return;
  const z = state.zoom;
  const txt = `${z < 1 ? z.toFixed(2) : z.toFixed(1)}×`;
  const b = el.querySelector('b');
  if (b && b.textContent !== txt) b.textContent = txt;
  // 一档刻度：把 [ZOOM_MIN, ZOOM_MAX] 按**对数**铺进 64px 的轨道（滚轮本身就是乘性的）
  const tick = $('#zoom-tick');
  if (tick) {
    const p = (Math.log(z) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN));
    const pct = (Math.max(0, Math.min(1, p)) * 100).toFixed(1);
    if (el.dataset.zp !== pct) { el.dataset.zp = pct; tick.style.left = `${pct}%`; }
  }
  const t = state.policy?.t ?? 0;
  const mode = t < 0.15 ? '星云' : (t > 0.85 ? '个体' : '混合');
  const m = el.querySelector('#zoom-mode');
  if (m && m.textContent !== mode) m.textContent = mode;
  if (el.dataset.mode !== mode) el.dataset.mode = mode;
}

function pushSpoke(map, key, from, to, alpha) {
  // 按 (群, 亮度桶) 合批：辐条的亮度**逐人不同**（跟着那个人的可见度走），不能整群一根 0.22。
  const k = `${key}|${Math.round(alpha * 12)}`;
  let b = map.get(k);
  if (!b) { b = { key, alpha, pts: new Path2D() }; map.set(k, b); }
  b.pts.moveTo(to.x, to.y);
  b.pts.lineTo(from.x, from.y);
}

// ── 交互 ────────────────────────────────────────────────────────────────
cv.addEventListener('pointerdown', (e) => {
  state.dragging = true;
  state.moved = 0;
  state.dragFrom = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch };
  cv.setPointerCapture?.(e.pointerId);
  cv.classList.add('dragging');
});
cv.addEventListener('pointermove', (e) => {
  if (state.dragging && state.dragFrom) {
    const dx = e.clientX - state.dragFrom.x;
    const dy = e.clientY - state.dragFrom.y;
    state.moved = Math.max(state.moved, Math.hypot(dx, dy));
    state.yaw = state.dragFrom.yaw + dx * 0.006;
    state.pitch = Math.max(-1.35, Math.min(1.35, state.dragFrom.pitch + dy * 0.005));
    state.dirty = true;
    hideTip();
    return;
  }
  const rect = cv.getBoundingClientRect();
  const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
  const hoverChanged = (hit?.star?.id || null) !== (state.hover?.star?.id || null);
  state.hover = hit;
  if (hoverChanged) state.dirty = true;   // hover 只影响标签避让 ⇒ 变了才重绘（ADR-0020）
  if (hit) showTip(e.clientX - rect.left, e.clientY - rect.top, hit);
  else hideTip();
});
const endDrag = (e) => {
  if (!state.dragging) return;
  state.dragging = false;
  cv.classList.remove('dragging');
  cv.releasePointerCapture?.(e.pointerId);
  if (state.moved < 5) {
    const rect = cv.getBoundingClientRect();
    const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) select(hit.star.id);
    else { state.selected = null; renderSide(); state.dirty = true; }
  } else {
    state.dirty = true;   // 拖拽过的最后一帧惯性对齐（保险；拖拽路径上已设过）
  }
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', () => { state.dragging = false; cv.classList.remove('dragging'); });
cv.addEventListener('pointerleave', () => { hideTip(); state.hover = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.zoom = clampZoom(state.zoom * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
  state.dirty = true;
}, { passive: false });
// 双击复位 —— 24× 的行程很长，靠滚轮滚回去太慢。
cv.addEventListener('dblclick', () => {
  state.yaw = DEFAULT_YAW; state.pitch = DEFAULT_PITCH; state.zoom = DEFAULT_ZOOM;
  state.dirty = true;
});

function pick(x, y) {
  // ⚠️ 不再 `.map()` 分配 1144 个对象 —— pointermove 的高频路径上零分配（ADR-0020）。
  //    判据与 `hitTest` 一致：visible + 半径（含 5px 余量）内取最近。
  let best = null;
  let bestD = Infinity;
  for (const it of state.projected) {
    const sc = it.screen;
    if (!sc?.visible) continue;
    const r = Math.max(4, (it.radiusPx || 3) + 5);
    const d = Math.hypot(sc.x - x, sc.y - y);
    if (d <= r && d < bestD) { bestD = d; best = it; }
  }
  if (best) return best;
  // 星系核也能点（群没有真名 ⇒ 让你能给它写一个备注，这是这一页唯一能命名群的地方）
  for (const nb of (state.nebulaeProjected || [])) {
    if (!nb.screen.visible) continue;
    const r = Math.max(16, 60 * nb.screen.scale / 200);
    if (Math.hypot(nb.screen.x - x, nb.screen.y - y) <= r) return { star: { id: nb.g.scope, _galaxy: nb.g } };
  }
  return null;
}

function showTip(x, y, hit) {
  const tip = $('#tip');
  const id = hit.star.id;
  tip.hidden = false;
  if (hit.star._galaxy) {
    const g = hit.star._galaxy;
    tip.innerHTML = `<div class="tt-name">${esc(displayName(id))}</div>` +
      `<div class="tt-row"><span class="tt-k">星系</span> · ${esc(g.messages)} 条消息 · 占星系 ${(g.share * 100).toFixed(1)}%</div>` +
      `<div class="tt-row"><span class="tt-k">运动</span> 成员各自绕盘心自转（越靠盘心越快）</div>` +
      `<div class="tt-row">点一下可以给它写个显示名</div>`;
  } else {
    const s = hit.star;
    const gs = (s.galaxies || []).map((g) => esc(displayName(g.scope))).join('、') || (s.inner ? '只有私聊（内环）' : '未归属任何星系');
    tip.innerHTML = `<div class="tt-name">${esc(displayName(id))}</div>` +
      (subLabel(id) ? `<div class="tt-row">${esc(subLabel(id))}</div>` : '') +
      `<div class="tt-row"><span class="tt-k">星系</span> ${gs}</div>` +
      `<div class="tt-row"><span class="tt-k">运动</span> ${orbitName(s)}</div>` +
      `<div class="tt-row"><span class="tt-k">与她</span> ${s.depthUnknown
        ? '没同框过（深度未知）'
        : `共现 ${fmt(s.coocSelf)} · 互动 ${fmt(s.interSelf)}`}</div>` +
      `<div class="tt-row"><span class="tt-k">弦</span> ${s.degree} 条 · 点一下看明细</div>`;
  }
  const W = state.w, H = state.h;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.max(6, Math.min(W - tw - 6, x + 14))}px`;
  tip.style.top = `${Math.max(6, Math.min(H - th - 6, y + 14))}px`;
}
function hideTip() { $('#tip').hidden = true; }

function select(id) {
  state.selected = id || null;
  renderSide();
  state.dirty = true;
}

// ── 详情面板 ────────────────────────────────────────────────────────────
function renderSide() {
  const side = $('#side'), body = $('#side-body');
  const id = state.selected;
  if (!id) { side.hidden = true; body.innerHTML = ''; return; }
  side.hidden = false;
  const uni = state.uni;
  const note = state.notes?.[id]?.text || '';
  const noteRow = `
    <div class="note-edit">
      <input id="note-in" maxlength="40" placeholder="给它写个显示名（最多 40 字）" value="${esc(note)}">
      <button type="button" id="note-save">保存</button>
    </div>
    <p class="hint">备注只是<b>显示名</b>：不进词表、不参与脱敏、不改任何出境文本（<code>ADR-0010</code>）。留空 = 删除。</p>`;

  if (isSelf(id)) {
    const n = state.names?.[id] || {};
    body.innerHTML = `<h2>${esc(displayName(id))}</h2><div class="lab">宇宙中心 · 机器人自己</div>
      <dl><dt>占位符</dt><dd><code>${esc(id)}</code></dd>
      <dt>星系</dt><dd>${uni.galaxies.length} 个群</dd>
      <dt>直接关系</dt><dd>${uni.stars.filter((s) => s.touchedCenter).length} 人</dd></dl>
      <p class="hint">她是这张图的中心，位置固定在原点；所有辐条都从这里发出。</p>${noteRow}`;
  } else if (uni.galaxies.some((g) => g.scope === id)) {
    const g = uni.galaxies.find((x) => x.scope === id);
    const members = uni.stars.filter((s) => s.galaxies.some((x) => x.scope === id));
    body.innerHTML = `<h2>${esc(displayName(id))}</h2><div class="lab">星系（一个群）</div>
      <dl><dt>占位符</dt><dd><code>${esc(id)}</code></dd>
      <dt>规模</dt><dd>${g.messages} 条消息</dd>
      <dt>星系占比</dt><dd>${(g.share * 100).toFixed(1)}%
        <div class="bar"><i style="width:${(g.share * 100).toFixed(1)}%"></i></div></dd>
      <dt>在册成员</dt><dd>${members.length} 人（与中心有共现）</dd>
      <dt>形态</dt><dd>压扁的盘（<code>ADR-0022</code>：盘内长短轴 + 自转轴压扁 + 子团）—— 不是球</dd>
      <dt>运动</dt><dd>成员各自绕盘心自转，<b>越靠盘心越快</b>（跨群的人不在这里自转）</dd></dl>
      <p class="hint">群名来自<b>宿主自己的群列表</b>（协议端的 <code>get_group_list</code>）—— 存档里没有群名，
      所以服务器不在或没连协议端时这里会退回占位符，那种情况下 <b>写个备注</b>可以补上。</p>${noteRow}`;
  } else {
    const s = uni.stars.find((x) => x.id === id);
    if (!s) { side.hidden = true; return; }
    const n = state.names?.[id] || {};
    const chords = uni.chords.filter((c) => c.a === id || c.b === id)
      .sort((x, y) => y.score - x.score).slice(0, 12);
    body.innerHTML = `<h2>${esc(displayName(id))}</h2>
      <div class="lab">${s.inner ? '内环（只有私聊）' : '星'}</div>
      ${(n.surfaces || []).length ? `<div class="lab" style="margin-top:4px">词表里的名字：${esc((n.surfaces || []).join('、'))}</div>` : ''}
      <dl>
        <dt>占位符</dt><dd><code>${esc(id)}</code></dd>
        <dt>与她的深度</dt><dd>${s.depthUnknown
          ? '<b>未知</b> —— 从没和她在同一个时间桶里出现过，所以只能放在最外圈（不猜）'
          : `${(s.depth * 100).toFixed(0)}%
          <div class="bar"><i style="width:${(s.depth * 100).toFixed(0)}%"></i></div>`}</dd>
        <dt>共现 / 互动</dt><dd>${s.depthUnknown ? '—' : `${fmt(s.coocSelf)} / ${fmt(s.interSelf)}`}</dd>
        <dt>弦</dt><dd>${s.degree} 条</dd>
        <dt>运动</dt><dd>${esc(orbitName(s))}</dd>
        <dt>星系</dt><dd>${(s.galaxies || []).map((g) =>
          `<span class="tag" style="border-color:${galaxyColor(uni.galaxies.findIndex((x) => x.scope === g.scope))}">${esc(displayName(g.scope))} · ${g.weight.toFixed(4)}</span>`).join('') || '<span class="lab">只有私聊</span>'}</dd>
      </dl>
      <p class="hint">深度按<b>真实互动量</b>算（对数饱和：<code>log(1+n)/log(1+300)</code>），不是在人群里的排位 —— 说了一两次的人到不了深档（<code>ADR-0040</code>）。</p>
      <div style="margin:8px 0"><a class="nav" href="/person.html?who=${encodeURIComponent(id)}" target="_blank" rel="noopener">查看人物卡（记忆 / 印象） →</a></div>
      <div class="lab">最深的弦（前 12）</div>
      <dl>${chords.map((c) => {
        const other = c.a === id ? c.b : c.a;
        return `<dt style="color:${tierColor(c.tier)}">${TIER_NAMES[c.tier]}${c.dashed ? ' · 虚线' : ''}</dt>
          <dd>${esc(displayName(other))} <span class="lab">(${fmt(c.inter)} / ${fmt(c.cooc)})</span>
          <a class="nav" href="/person.html?who=${encodeURIComponent(other)}&with=${encodeURIComponent(id)}" target="_blank" rel="noopener" title="看这两人之间记下的印象 / 事件">两人之间 →</a></dd>`;
      }).join('') || '<dd class="lab">没有</dd>'}</dl>
      ${noteRow}`;
  }

  const save = $('#note-save');
  if (save) save.addEventListener('click', async () => {
    const text = $('#note-in')?.value ?? '';
    save.disabled = true;
    try {
      const r = await fetch('/api/vec/notes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: id, text })
      }).then((x) => x.json());
      if (r?.ok) {
        if (String(text).trim()) state.notes[id] = { text: String(text).trim() };
        else delete state.notes[id];
        renderLegend(); renderSide();
      } else {
        alert(`保存失败：${r?.error || '未知错误'}`);
      }
    } finally { save.disabled = false; }
  });
}

// ── 图例 / 统计 ─────────────────────────────────────────────────────────
// 图例折叠（用户 #2）：默认收起，点按钮弹出。**toggle 按钮常驻**（不然收起后没有入口）。
{
  const tgl = $('#legend-toggle'), lg = $('#legend');
  tgl?.addEventListener('click', () => {
    const show = lg.hidden;
    lg.hidden = !show;
    tgl.textContent = show ? '收起图例' : '图例';
  });
}

function renderLegend() {
  const uni = state.uni;
  if (!uni) return;
  const tiers = TIER_COLORS[state.theme].map((c, i) =>
    `<span class="gl"><span class="gldot" style="background:${c}"></span>${TIER_NAMES[i]}</span>`).join('');
  // 线宽示例（ADR-0016）：**把"粗细"这条通道直接画出来**。
  // 起因是用户看到满屏粗线后问「每个人的关系都很深厚吗?」—— 那条读数说明
  // 光靠一条"线宽 = 深厚档"的文字说明是没用的：得让人亲眼看见三档差多少。
  // 用 `widthOf()`（**唯一的宽度真身**）取实际字节值，按 ~0.9 折到示例小条上（长条会显得更粗）。
  const widths = [0, 1, 2].map((i) => {
    const w = widthOf(i / (TIER_COUNT - 1)) * 0.9;
    return `<span class="gl" title="${TIER_NAMES[i]}档 · ${widthOf(i / (TIER_COUNT - 1)).toFixed(2)}px">` +
      `<span class="glw" style="height:${w.toFixed(1)}px;background:${tierColor(i)}"></span>${TIER_NAMES[i]}</span>`;
  }).join('');
  const gals = uni.galaxies.slice(0, 8).map((g) =>
    `<span class="gl"><span class="gldot" style="background:${galaxyColor(g.colorIndex)}"></span>${esc(displayName(g.scope))}</span>`).join('');
  $('#legend').innerHTML =
    `<div><b>弦（人 ↔ 人）</b>：颜色 / 粗细 / 透明度 = <b>深厚档</b>（暖→冷）；虚实 = <b>关系性质</b>
      <span class="sw" style="background:${tierColor(2)};display:inline-block;vertical-align:middle"></span>
      <span class="sw dash" style="color:${tierColor(0)};display:inline-block;vertical-align:middle"></span>
      <span style="vertical-align:middle">实线 = 有互动 · 虚线 = 只有共现</span></div>
     <div class="row">${tiers}</div>
     <div class="row">${widths}<span class="cap">← 三档的<b>线宽</b>（多数关系只是一根细丝）</span></div>
     <div><b>辐条（人 ↔ 中心）</b>：颜色 = <b>群色</b>（下面这一排），恒 1px / 恒实 / 很淡 —— 视觉上从属于弦。</div>
     <div class="row">${gals}</div>
     <div style="margin-top:4px"><b>星点 = 白芯 + 彩晕</b>：真实的星是<b>白热</b>的，颜色只在它周围那圈光晕里
       —— 所以"这颗星属于哪个群"看<b>晕</b>、不看芯（否则一颗颗高饱和的糖豆，一眼是散点图，不是星空）。</div>
     <div style="margin-top:4px"><b>星系不是球，星也在动</b>（<code>ADR-0022</code>）：每个群是一片<b>压扁的盘 + 子团</b>
       （所以轮廓凌乱、不是一颗光球）；<b>只属于一个群</b>的人绕着<b>这个群的盘心自转</b>，
       <b>离盘心越近越快</b>（差速自转 —— 看久了子团会被剪成旋臂，那正是它在转的证据）；
       <b>同时参与几个群</b>的人绕着<b>宇宙中心公转</b>，一圈里<b>依次经过它参与的每一个群</b>（环形不规则）。
       上方「运动」开关能停住它 —— 停住时看到的就是建图那一帧。</div>
     <div style="margin-top:4px"><b>天永远是暗的</b>：亮/暗主题管的是面板（顶栏、图例、页脚），
       不管这片天 —— 星是<b>发光体</b>，白底上无论怎么画都只会得到"墨点 + 网格线"。</div>
     <div style="margin-top:4px"><b>看远时那片"星云"不是画上去的</b>：它就是<b>淡去的星自己叠出来的</b>
       ——星点大小只由深度决定、<b>不跟着缩放变大</b>，所以滚轮放大时人是一个个<b>分开</b>的，
       不是整团一起放大（右下角的倍率指示会告诉你现在是"星云"还是"个体"）。</div>
     <div style="margin-top:4px">贴在最外圈、且你点开显示"深度未知"的星：他们<b>从没跟中心同框过</b>，
       只是跟别人有边 —— 位置只按"他挂在哪些群"算，所以放在最外圈，不假装知道远近。</div>`;
}
function renderStats(gr) {
  const u = state.uni.stats;
  $('#stats').innerHTML = [
    ['星系（群）', gr.scopes.filter((s) => s.kind === 'group').length],
    ['星（人）', u.stars],
    ['弦（人↔人）', u.chords],
    ['原始边', gr.edgeCountRaw],
    ['剪枝后', gr.edgeCount],
    ['未跟中心直接有边', u.orphanStars],
    ['内环（纯私聊）', u.innerStars],
    ['观察窗', gr.horizon?.days != null ? `${gr.horizon.days} 天` : '—'],
    ['共现窗口', `${gr.coocWindowMs} ms`]
  ].map(([k, v]) => `<span>${esc(k)} <b>${esc(String(v))}</b></span>`).join('');
}

// ── 控件 ────────────────────────────────────────────────────────────────
const redraw = () => { state.dirty = true; };   // ADR-0020：一切改状态的地方都要唤起重绘
$('#btn-reload').addEventListener('click', () => loadAll());
$('#btn-reset').addEventListener('click', () => { state.yaw = DEFAULT_YAW; state.pitch = DEFAULT_PITCH; state.zoom = DEFAULT_ZOOM; redraw(); });
// 键盘 +/-（缩放）、0（复位）。**输入框里打字时不管** —— 否则搜索框里打不出减号。
window.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
  if (e.key === '+' || e.key === '=') { state.zoom = clampZoom(state.zoom * ZOOM_STEP); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { state.zoom = clampZoom(state.zoom / ZOOM_STEP); e.preventDefault(); }
  else if (e.key === '0') { state.yaw = DEFAULT_YAW; state.pitch = DEFAULT_PITCH; state.zoom = DEFAULT_ZOOM; }
  else return;
  redraw();
});
$('#opt-spin').addEventListener('change', (e) => { state.playing = e.target.checked; redraw(); });
$('#opt-names').addEventListener('change', (e) => { state.showNames = e.target.checked; redraw(); });
$('#opt-linked').addEventListener('change', (e) => { state.onlyLinked = e.target.checked; redraw(); });
$('#side-close').addEventListener('click', () => { state.selected = null; renderSide(); redraw(); });
$('#find').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = String(e.target.value || '').trim().toLowerCase();
  if (!q || !state.uni) return;
  const hit = state.uni.stars.find((s) => displayName(s.id).toLowerCase().includes(q)) ||
    state.uni.galaxies.find((g) => displayName(g.scope).toLowerCase().includes(q));
  if (!hit) { alert('没找到。试试备注里的名字，或者占位符本身。'); return; }
  select(hit.id);
  // 把它的**此刻位置**转到镜头正前方（pitch/yaw 的逆解）。
  // ⚠️ 不能用 `hit.dir`：那是 t=0 的方向，而星现在会转 —— 照旧方向转镜头会**指着空气**
  //    （"搜索定位"是会静默失灵的那类功能：画面动了、目标却不在中央，看着像没找到）。
  const w = hit.orbit ? starWorldPos(hit, state.clock) : (hit.dir || null);
  if (w) {
    const len = Math.hypot(w[0], w[1], w[2]) || 1e-9;
    const d = [w[0] / len, w[1] / len, w[2] / len];
    state.playing = false; $('#opt-spin').checked = false;
    state.pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
    state.yaw = Math.atan2(-d[0], d[2]);
    state.dirty = true;
  }
});
if (REDUCED) { $('#opt-spin').checked = false; state.playing = false; }

// ── 卸载 ────────────────────────────────────────────────────────────────
export function dispose() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  hideTip();
}
window.addEventListener('beforeunload', dispose);

// ── 工具 ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(v) {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(1);
  return n.toFixed(4);
}

// ── 启动 ────────────────────────────────────────────────────────────────
await loadAll();
fitCanvas();
state.raf = requestAnimationFrame(loop);
