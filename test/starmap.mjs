// 星图布局纯函数测试（`web/starmap-layout.mjs`）。
//
// 为什么这个文件存在：星图的**画面**没法在这里断言，但**坐标**可以。
// 布局一旦改错（方向合成、半径映射、深浅档），肉眼大概率看不出来 ——
// 图会照样"好看"，只是每一颗星都站错了地方。那是本项目最怕的一类错：
// **看起来在工作**。所以口径全部在 node 里钉住。
//
// 运行：node test/starmap.mjs
import {
  buildUniverse, percentileRanks, hash01, fibonacciDirection, normalize3,
  intimacyScore, tierOf, widthOf, alphaOf, rotationMatrix, applyRotation, project, hitTest, placeLabels,
  saturate, DEPTH_SAT_INTER, DEPTH_SAT_COO,
  strictRanks, smoothstep, starRadiusPx, worldNNSep, resolvability, individuationPolicy,
  pointInRect, spokeAlpha, lineScaleForZoom,
  R_MAX, R_INNER_MAX, R_INNER_MIN, TIER_COUNT,
  BALL_K, CORE_R_MIN, CORE_R_MAX, IN_BALL_R_MIN, FALLBACK_R,
  STAR_R_MIN, STAR_R_MAX, RES_MERGED, RES_SEPARATED, CLOUD_ALPHA_MIN, BRIGHT_ALPHA_MIN,
  CHORD_DEEP_KEEP, CHORD_TIER_CEIL, CHORD_ALPHA_FLOOR, SPOKE_ALPHA_MAX,
  LINE_W_MIN, LINE_W_MAX, LINE_W_POW,
  LINE_ZOOM_REF, LINE_SCALE_MIN, LINE_SCALE_MAX, GLOW_FAR_FALLBACK, GLOW_FAR_FALLBACK_SPAN,
  GLOW_FAR_SPACING_K, GLOW_FAR_ALPHA_LO, GLOW_FAR_ALPHA_SPAN, GLOW_ALPHA_MUL, GLOW_STOPS, glowProfileMean,
  galaxyShape, shapeOffset, orbitOmega, starWorldPos, bridgePosAt, bestFitNormal,
  DISK_SQUASH, DISK_ELONG, CLUMP_COUNT, CLUMP_PULL,
  ORBIT_CORE_OMEGA, ORBIT_RHO0, DRIFT_OMEGA
} from '../web/starmap-layout.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));

console.log('\n── ① 百分位 ───────────────────────────────────────');
{
  ok(percentileRanks([]).length === 0, '空集 ⇒ 空数组（不崩）');
  ok(percentileRanks([5]).join() === '1', '单元素 ⇒ 1（不是 0：唯一的边不该是最细的）');
  const p = percentileRanks([10, 20, 30, 40]);
  ok(near(p[0], 0) && near(p[3], 1), '两端**真的**映射到 0 与 1（最小那条弦不该有下限）', `[${p.map((x) => x.toFixed(2)).join(',')}]`);
  const t = percentileRanks([7, 7, 7]);
  ok(t.every((x) => near(x, 0.5)), '并列取平均名次（三个并列 ⇒ 都是 0.5）', `[${t.join(',')}]`);
  const m = percentileRanks([1, 1, 2]);
  ok(near(m[0], 0.25) && near(m[1], 0.25) && near(m[2], 1), '并列名次按 1-based 平均', `[${m.join(',')}]`);
}

console.log('\n── ② 稳定散列与球面 ───────────────────────────────');
{
  const a = hash01('〔P1234〕', 'jit-a');
  const b = hash01('〔P1234〕', 'jit-a');
  ok(a === b && a >= 0 && a < 1, '同一 (id,salt) 永远同一个值且在 [0,1)');
  ok(hash01('〔P1234〕', 'jit-a') !== hash01('〔P1234〕', 'jit-b'), '不同 salt 给出不同值');
  let spread = 0;
  for (let i = 0; i < 50; i++) spread += Math.abs(hash01(`x${i}`) - 0.5);
  ok(spread / 50 < 0.30, '散列分布不偏（50 个样本与 0.5 的平均距离 < 0.30）', `(${(spread / 50).toFixed(3)})`);

  let badLen = 0;
  const dirs = [];
  for (let i = 0; i < 5; i++) {
    const d = fibonacciDirection(i, 5);
    if (!near(Math.hypot(d[0], d[1], d[2]), 1, 1e-9)) badLen++;
    dirs.push(d);
  }
  ok(badLen === 0, 'fibonacciDirection 都是单位向量');
  let minAngle = Math.PI;
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) minAngle = Math.min(minAngle, angle(dirs[i], dirs[j]));
  }
  ok(minAngle > 0.6, '5 个方向互相拉开（最近的一对 > 0.6 rad）', `(${minAngle.toFixed(3)} rad)`);
}

console.log('\n── ③ 深厚分：单调、定档、幂律 ─────────────────────');
{
  ok(near(intimacyScore(0, 0), 0) && near(intimacyScore(1, 1), 1), '深厚分端点 0 / 1');
  ok(intimacyScore(1, 0) > intimacyScore(0, 1), '互动比共现更值钱（0.67 vs 0.33）');
  let mono = true;
  for (let i = 1; i <= 20; i++) {
    if (widthOf(i / 20) <= widthOf((i - 1) / 20)) mono = false;
    if (alphaOf(i / 20) <= alphaOf((i - 1) / 20)) mono = false;
  }
  ok(mono, '线宽与透明度对深厚分**严格单调**（"越深越粗"不许被幂律破坏）');
  // ── 宽度通道必须是"活的"（ADR-0016）────────────────────────────────────
  // 起因：用户看到"每个人的线都一样粗"，问「每个人的关系都很深厚吗?」。
  // 病根不是审美，是**通道死了**：旧式 `1 + 5·deep**0.4` 把"长尾压缩"指数用在了
  // **已经归一化的百分位**上（`deep` 实测 p10=0.30 / p50=0.40 / p90=0.87，不是长尾），
  // 于是中段整片被抬到接近上限：p90/p10 只有 1.40，100% 的线 ≥3px。
  // 这三条断言把"区分度"、"浅端不粗"、"深端不消失"三件事同时钉住 ——
  // 只调 max 或只调 pow 都会让其中一条失败（它们是同一个动态范围的两端）。
  ok(LINE_W_POW > 1, '指数必须 >1：深厚分是**绝对量饱和**（多数关系挤在低位），只有**拉开**深端才能从细丝里站出来（ADR-0016 教训在新口径下的等价形式）', `pow=${LINE_W_POW}`);
  const W_LO = 0.142, W_HI = 0.987;    // 真弦实测的 p90 / 最深一条（A 号 98,716 条，0.26.0 口径；p50=0.038、p99=0.428）
  const W_DEF = 3.4;                   // web/starmap.js 的 DEFAULT_ZOOM（默认视角）
  const ratio = widthOf(W_HI) / widthOf(W_LO);
  ok(ratio >= 2.5, '宽度通道必须**活着**：最深弦 vs p90 ≥ 2.5 倍（浅端本来就该全是细丝 —— 区分度只需要在"深"的那端成立）', `最深/p90=${ratio.toFixed(2)}`);
  ok(widthOf(W_LO) * lineScaleForZoom(W_DEF) < 1.0, 'p90 弦在默认视角 <1px（90% 的关系就是细丝 —— 这才是诚实的读数）',
    `${(widthOf(W_LO) * lineScaleForZoom(W_DEF)).toFixed(2)}px`);
  ok(widthOf(1) * lineScaleForZoom(W_DEF) >= 1.6, '最深一条在默认视角 ≥1.6px（远景"关系存在"的骨架不许看不见）',
    `${(widthOf(1) * lineScaleForZoom(W_DEF)).toFixed(2)}px`);
  ok(near(widthOf(0), LINE_W_MIN) && near(widthOf(1), LINE_W_MAX), '端点取到 W_MIN / W_MAX（不在中段凭空多一档）');
  ok(near(tierOf(0), 0) && near(tierOf(0.99), TIER_COUNT - 1), '深厚分 0/1 落在首尾档');
  ok(tierOf(1) === TIER_COUNT - 1 && tierOf(-1) === 0 && tierOf(NaN) === 0, '档位对越界/NaN 收敛到合法值');

  // ── 深度的绝对锚（0.26.0，ADR-0040）────────────────────────────────
  // 起因是用户的原话："怎么是个人随随便便关系都能做到'深'啊" —— 质问成立。
  // 旧口径把**百分位**喂给深厚分：百分位是纯排位，无论真实互动多稀薄都均匀铺满 [0,1]
  // ⇒ **最深档永远有人**（A 号实测 95% 的弦互动 ≤1、p90=0，中位弦却照样拿中档）。
  // 这一组用例锁死：深由**绝对证据量**挣来，不由排位挣来。
  {
    ok(saturate(0) === 0 && saturate(-5) === 0, '零/负证据 ⇒ 深度输入 0（不假装认识）');
    ok(saturate(DEPTH_SAT_INTER) === 1 && saturate(99999) === 1, '达到/超过饱和点 ⇒ 封顶 1');
    let sat_mono = true;
    for (const n of [1, 2, 5, 17, 50, 115]) {   // 都在饱和点以下 —— 封顶之后是常数，谈不上严格单调
      if (!(saturate(n) > saturate(n / 2))) sat_mono = false;
    }
    ok(sat_mono, '饱和曲线对互动量严格单调（多一次互动就多一分深）');
    ok(near(saturate(1, DEPTH_SAT_INTER), 0.121, 0.01), '1 次互动 ≈ 0.12（是"见过"，不是"熟"）',
      `(${saturate(1, DEPTH_SAT_INTER).toFixed(3)})`);

    // 回归锁（用户的质问本体）：一整群人互动都 ≤2 次 ⇒ **没有任何人**能拿中档或深档。
    // 旧百分位口径下这是**构造性不可能**的 —— 名次永远均匀铺开，top 1/3 必然"中/深"。
    const coldSpokes = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, cooc: 0.01, inter: 0.001, coocRaw: i % 3, interRaw: i % 2,
      byScope: { 'group:COLD': { cooccurrence: { normalized: 0.01 }, interaction: { normalized: 0.001 } } }
    }));
    const coldChords = [];
    for (let i = 0; i + 1 < 30; i += 2) {
      coldChords.push({ a: `c${i}`, b: `c${i + 1}`, cooc: 0.01, inter: 0.001, coocRaw: i % 3, interRaw: i % 2, byScope: {} });
    }
    const cold = buildUniverse({
      centerId: 'S',
      scopes: [{ scope: 'group:COLD', kind: 'group', messages: 500, members: 30 }],
      spokes: coldSpokes, chords: coldChords
    });
    ok(cold.stars.every((st) => st.depth < 1 / 3), '全员互动 ≤2 次的人群里**没有人过中档线**（旧排位制必有人"深"—— 那是假的）',
      `(最深 ${(Math.max(...cold.stars.map((x) => x.depth)) * 100).toFixed(1)}%)`);
    ok(cold.chords.every((c) => c.tier === 0), '同样条件下所有弦都是浅档（0.26.0 前中位弦就能拿中档）');

    // 反向：深必须挣得动 —— 真金白银的互动量能把人推到深档。
    const earned = buildUniverse({
      centerId: 'S',
      scopes: [{ scope: 'group:E', kind: 'group', messages: 50000, members: 3 }],
      spokes: [
        { id: 'pal', cooc: 0.3, inter: 0.2, coocRaw: 350, interRaw: 400, byScope: { 'group:E': { cooccurrence: { normalized: 0.3 }, interaction: { normalized: 0.2 } } } },
        { id: 'nod', cooc: 0.01, inter: 0, coocRaw: 3, interRaw: 0, byScope: { 'group:E': { cooccurrence: { normalized: 0.01 }, interaction: { normalized: 0 } } } }
      ],
      chords: [{ a: 'pal', b: 'nod', cooc: 0.02, inter: 0, coocRaw: 4, interRaw: 0, byScope: {} }]
    });
    const pal = earned.stars.find((x) => x.id === 'pal');
    ok(pal.depth >= 2 / 3, '400 次直接互动 ⇒ 深档（`DEPTH_SAT_INTER=300` 封顶后 0.67 权重兜底）',
      `(depth ${(pal.depth * 100).toFixed(0)}%)`);
    ok(pal.depth > earned.stars.find((x) => x.id === 'nod').depth * 3, '深者与点头之交**差出一个量级**（不是挤在一起）');
    // raw 缺失 ⇒ 退化为 0，不假装（宁可全浅，不许拿 normalized 冒充 raw 全员满分）
    const noRaw = buildUniverse({
      centerId: 'S',
      scopes: [{ scope: 'group:NR', kind: 'group', messages: 100, members: 2 }],
      spokes: [{ id: 'x', cooc: 0.9, inter: 0.9, byScope: { 'group:NR': { cooccurrence: { normalized: 0.9 }, interaction: { normalized: 0.9 } } } }],
      chords: []
    });
    ok(noRaw.stars[0].depth === 0, '载荷缺 raw ⇒ 深度 0（normalized 是份额不是次数，拿来冒充会全员假深）');
  }
}

console.log('\n── ④ 建宇宙：方位 = 跨群共现加权 ──────────────────');
{
  const scopes = [
    { scope: 'group:CA', kind: 'group', messages: 1000 },
    { scope: 'group:CB', kind: 'group', messages: 1000 },
    { scope: 'private:CC', kind: 'private', messages: 200 }
  ];
  const spokes = [
    // 只在 A：应贴着 A 的星团
    { id: 'onlyA', cooc: 0.10, inter: 0.02, coocRaw: 100, interRaw: 40, byScope: { 'group:CA': { cooccurrence: { normalized: 0.10 }, interaction: { normalized: 0.02 } } } },
    // 一半 A 一半 B：应落在两个星系**之间**
    { id: 'both', cooc: 0.08, inter: 0.01, coocRaw: 60, interRaw: 20, byScope: {
      'group:CA': { cooccurrence: { normalized: 0.05 }, interaction: { normalized: 0.005 } },
      'group:CB': { cooccurrence: { normalized: 0.05 }, interaction: { normalized: 0.005 } } } },
    // 只有私聊：内环
    { id: 'dmOnly', cooc: 0.03, inter: 0, coocRaw: 20, interRaw: 0, byScope: { 'private:CC': { cooccurrence: { normalized: 0.03 }, interaction: { normalized: 0 } } } }
  ];
  const chords = [
    { a: 'onlyA', b: 'both', cooc: 0.06, inter: 0.01, coocRaw: 30, interRaw: 10, byScope: {} },
    { a: 'onlyA', b: 'dmOnly', cooc: 0.05, inter: 0, coocRaw: 25, interRaw: 0, byScope: {} },      // 零互动 ⇒ 必须虚线
    { a: 'ghost1', b: 'ghost2', cooc: 0.04, inter: 0.02, coocRaw: 20, interRaw: 10, byScope: {} }   // 没跟中心有边的人
  ];
  const u = buildUniverse({ centerId: '〔SELF〕', scopes, spokes, chords });
  const byId = new Map(u.stars.map((s) => [s.id, s]));
  const gA = u.galaxies.find((g) => g.scope === 'group:CA');
  const gB = u.galaxies.find((g) => g.scope === 'group:CB');

  ok(u.galaxies.length === 2, '私聊**不占方位**（只把群铺在球面上）', `(${u.galaxies.length} 个星系)`);
  ok(angle(byId.get('onlyA').dir, gA.dir) < 0.5, '只在一个群的人贴着那个群的方向', `(${angle(byId.get('onlyA').dir, gA.dir).toFixed(3)} rad)`);

  // 「桥是算出来的」这条 ADR-0012 的核心主张，判据要能真的证伪它：
  //   ① 它在两个星系**之间**（与两边的夹角都小于两星系之间的夹角）；
  //   ② 等权 ⇒ 到两**球心**的欧氏距离大致相等（球几何下"中点"的正确形状 ——
  //     ADR-0017 改成球之后，"角等分"不再是中点：球心距离不同时方向不等分）。
  const angleAB = angle(gA.dir, gB.dir);
  const posOf = (s) => [s.dir[0] * s.radius, s.dir[1] * s.radius, s.dir[2] * s.radius];
  const dist3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const aToA = angle(byId.get('both').dir, gA.dir);
  const aToB = angle(byId.get('both').dir, gB.dir);
  ok(aToA < angleAB - 0.05 && aToB < angleAB - 0.05,
    '跨两个群的人**物理上落在两团之间**（比任何一边都更靠近中间）',
    `(A ${aToA.toFixed(3)} / B ${aToB.toFixed(3)} / 两团相距 ${angleAB.toFixed(3)} rad)`);
  {
    const p = posOf(byId.get('both'));
    const dA = dist3(p, gA.core);
    const dB = dist3(p, gB.core);
    ok(Math.abs(dA - dB) < Math.max(dA, dB) * 0.25, '等权 ⇒ 到两球心的欧氏距离大致相等（没有被某个星系单独拉走）',
      `(A ${dA.toFixed(3)} / B ${dB.toFixed(3)})`);
  }
  ok(!byId.get('both').inner && byId.get('dmOnly').inner, '只有私聊的人被标成内环，其余不是');

  // 半径（ADR-0017 球几何）：内环仍在内环带；所有星都在世界半径内；
  // 成员真的落在**主场球内**（|pos − 球心| ≤ ballR）。
  ok(byId.get('dmOnly').radius <= R_INNER_MAX + 1e-9, '内环半径**不超过内环带上限**', `(${byId.get('dmOnly').radius.toFixed(3)})`);
  ok(u.stars.every((s) => s.radius <= R_MAX + 1e-9), '所有星都在世界半径上限之内');
  {
    const p = posOf(byId.get('onlyA'));
    const d = dist3(p, gA.core);
    ok(d <= gA.ballR * 1.02 + 1e-9, '成员落在主场球的球内（|pos−球心| ≤ ballR）',
      `(${d.toFixed(3)} ≤ ${gA.ballR.toFixed(3)})`);
  }
  const deep = byId.get('onlyA');
  ok(deep.radius <= R_MAX + 1e-9, '半径不超过世界上限', `(${deep.radius.toFixed(3)})`);

  // 球内径向 = 亲疏（ADR-0017 对 ADR-0011 的改写）：同一个群里，越熟越靠球心。
  // 场景：同群两人，互动/共现一个明显高一个明显低 ⇒ 深度高者的 |pos−球心| 必须更小。
  {
    const scopes2 = [{ scope: 'group:CR', kind: 'group', messages: 500, members: 3 }];
    const mk = (id, cooc, inter) => ({
      id, cooc, inter,
      // raw = normalized × 1000（同比例放大，保持"warm 比 cold 深"的相对关系）
      coocRaw: cooc * 1000, interRaw: inter * 1000,
      byScope: { 'group:CR': { cooccurrence: { normalized: cooc }, interaction: { normalized: inter } } }
    });
    const u2 = buildUniverse({
      centerId: 'S', scopes: scopes2,
      spokes: [mk('cold', 0.01, 0.0), mk('warm', 0.30, 0.20)], chords: []
    });
    const g = u2.galaxies[0];
    const dWarm = dist3(posOf(u2.stars.find((s) => s.id === 'warm')), g.core);
    const dCold = dist3(posOf(u2.stars.find((s) => s.id === 'cold')), g.core);
    ok(dWarm < dCold, '同群内**越熟越靠球心**（球内径向 = 亲疏，ADR-0017）',
      `(warm ${dWarm.toFixed(3)} < cold ${dCold.toFixed(3)})`);
    ok(dCold <= g.ballR * 1.02 + 1e-9 && dCold >= g.ballR * IN_BALL_R_MIN - 1e-9,
      '球内径向落在 [IN_BALL_R_MIN, 1]×ballR 内（防奇点下限真的生效）',
      `(${(dCold / g.ballR).toFixed(3)} × ballR)`);
  }

  // 弦：虚实表性质，不表强度
  const dm = u.chords.find((c) => c.b === 'dmOnly');
  ok(dm.dashed === true, '零互动的弦**恒虚线**（"熟悉的陌生人"的唯一可见形态）');
  ok(u.chords.every((c) => c.dashed === !(c.inter > 0)), '虚实**只**由 inter 决定，与深厚分无关');
  const strongest = u.chords.slice().sort((x, y) => y.score - x.score)[0];
  ok(strongest.dashed === (strongest.inter <= 0), '最深的弦也没有因为"深"而被改成实线');

  // 弦拉进来的人也得有星（否则弦指向虚空）
  ok(byId.has('ghost1') && byId.has('ghost2'), '只出现在人-人弦里、没跟中心有边的人仍然有星');
  ok(byId.get('ghost1').touchedCenter === false, '并标出它没跟中心直接有边（降级要点明，不假装）');

  // 确定性
  const u2 = buildUniverse({ centerId: '〔SELF〕', scopes, spokes, chords });
  ok(JSON.stringify(u) === JSON.stringify(u2), '两次建宇宙结果逐字节相同（布局可复现，ADR 禁力导向的理由）');

  // 球几何（ADR-0017）：球半径 ∝ ∛成员数；更热的群球心更靠中心；标定带不被越界
  const big = buildUniverse({
    centerId: 'S',
    scopes: [
      { scope: 'group:BIG', kind: 'group', messages: 100000, members: 900 },
      { scope: 'group:TINY', kind: 'group', messages: 10, members: 2 }
    ],
    spokes: [], chords: []
  });
  const bigG = big.galaxies.find((g) => g.scope === 'group:BIG');
  const tinyG = big.galaxies.find((g) => g.scope === 'group:TINY');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  ok(bigG.ballR > tinyG.ballR, '大群的球大于小群', `(${bigG.ballR.toFixed(3)} vs ${tinyG.ballR.toFixed(3)})`);
  ok(near(bigG.ballR, BALL_K * Math.cbrt(900)) && near(tinyG.ballR, BALL_K * Math.cbrt(2)),
    '球半径严格 = BALL_K × ∛成员数（体积 ∝ 人数，密度恒定）',
    `(${bigG.ballR.toFixed(4)} / ${tinyG.ballR.toFixed(4)})`);
  ok(bigG.coreR < tinyG.coreR, '更热的群（消息量更大）球心更靠中心',
    `(${bigG.coreR.toFixed(3)} < ${tinyG.coreR.toFixed(3)})`);
  ok(bigG.coreR >= CORE_R_MIN - 1e-9 && tinyG.coreR <= CORE_R_MAX + 1e-9,
    '球心距离落在标定带 [CORE_R_MIN, CORE_R_MAX] 内');
}

console.log('\n── ⑤ 投影与命中 ───────────────────────────────────');
{
  const view = { width: 800, height: 600, zoom: 1 };
  const origin = project([0, 0, 0], view);
  ok(near(origin.x, 400) && near(origin.y, 300), '原点投到画布中心');
  ok(project([0, 0, 99], view).visible === false, '跑到相机后面 ⇒ visible=false（不画反向的鬼影）');

  // 「把某颗星转到镜头正前方」的逆解必须真的成立 —— 搜索定位功能全靠它
  let worst = 0;
  for (const d0 of [[0, 0, 1], [1, 0, 0], [0.3, -0.5, 0.8], [-0.6, 0.2, -0.5], [0.1, 0.95, 0.2]]) {
    const d = normalize3(d0);
    const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
    const yaw = Math.atan2(-d[0], d[2]);
    const cam = applyRotation(d, rotationMatrix(yaw, pitch));
    worst = Math.max(worst, Math.hypot(cam[0], cam[1]));
  }
  ok(worst < 1e-9, 'focus 的 yaw/pitch 逆解正确（旋转后方向落在相机 +Z 轴上）', `(最大偏差 ${worst.toExponential(1)})`);

  const projected = [
    { star: { id: 'a' }, screen: { x: 100, y: 100, visible: true }, radiusPx: 3 },
    { star: { id: 'b' }, screen: { x: 106, y: 100, visible: true }, radiusPx: 3 }
  ];
  ok(hitTest(projected, 101, 101)?.star.id === 'a', '命中测试取最近的那颗');
  ok(hitTest(projected, 105, 100)?.star.id === 'b', '离谁近就选谁（不是"第一个碰到"）');
  ok(hitTest(projected, 400, 400) === null, '点空白 ⇒ null（不乱选）');
  ok(hitTest([{ star: { id: 'z' }, screen: { x: 0, y: 0, visible: false }, radiusPx: 3 }], 0, 0) === null,
    '不可见的点（在相机背后）不参与命中');
}
console.log('\n── ⑧ 标签避让（placeLabels）─────────────────────────');
{
  // 背景：世界半径上限只有 1，中心密集区几十颗星挤在几十像素内 ⇒ 不避让名字必然糊成一团
  // （用户原话"都看不出来谁是谁"）。避让是纯几何判定，所以必须在这里钉住。
  const box = (x, y, w, extra = {}) => ({ x: x, y: y, width: w, ...extra });
  const hits = (a, b) => a.box.x1 > b.box.x0 && a.box.x0 < b.box.x1 && a.box.y1 > b.box.y0 && a.box.y0 < b.box.y1;

  // ① 完全重叠的两个候选：只留深度高的那个
  {
    const r = placeLabels([box(100, 100, 40, { id: 'lo', depth: 0.2 }), box(100, 100, 40, { id: 'hi', depth: 0.9 })]);
    ok(r.length === 1 && r[0].id === 'hi', '重叠的两个只留一个，且是深度高的那个', `(${r.map((x) => x.id).join(',')})`);
  }
  // ② 钉住的优先：与"更深的非钉住标签"撞在一起时，留下的是钉住的
  {
    const r = placeLabels([box(100, 100, 40, { id: 'pin', pinned: true }), box(100, 100, 40, { id: 'deep', depth: 0.99 })]);
    ok(r.length === 1 && r[0].id === 'pin',
      '钉住的优先：撞上"更深的非钉住标签"时留下的是钉住的（选中/悬停的人不被深度抢走）',
      `(${r.map((x) => x.id).join(',')})`);
  }
  // ②b 钉住的**无条件画**：撞上调用方给的已占位（地标名字）也照画
  {
    const r = placeLabels([box(100, 100, 40, { id: 'pin', pinned: true })], { occupied: [{ x0: 70, x1: 130, y0: 86, y1: 100 }] });
    ok(r.length === 1 && r[0].id === 'pin', '钉住的无条件画：撞上地标名字也照画（用户点名的人不能被吞掉）');
  }
  // ③ 水平不重叠的两个都留
  {
    const r = placeLabels([box(100, 100, 40, { id: 'a' }), box(200, 100, 40, { id: 'b' })]);
    ok(r.length === 2, '不重叠的都留下（避让不能退化成"只画一个"）');
  }
  // ④ max 只截断非钉住的
  {
    const many = Array.from({ length: 10 }, (_, i) => box(i * 200, 100 + i * 40, 30, { id: `n${i}` }));
    const r = placeLabels([...many, box(5000, 5000, 30, { id: 'pin', pinned: true })], { max: 3 });
    ok(r.filter((x) => !x.pinned).length === 3 && r.some((x) => x.id === 'pin'),
      'max 截断非钉住的那批，钉住的不计入上限', `(非钉住 ${r.filter((x) => !x.pinned).length})`);
  }
  // ⑤ occupied 种子只挡不画（星系核名字先占位）
  {
    const r = placeLabels([box(100, 100, 40, { id: 'x' })], { occupied: [{ x0: 70, x1: 130, y0: 86, y1: 100 }] });
    ok(r.length === 0, 'occupied（已占位）只挡不画：撞上地标名字的星名被跳过');
  }
  // ⑥ 结果自身两两不重叠（真正的保证）
  {
    const cands = Array.from({ length: 40 }, (_, i) => box(300 + (i % 7) * 9, 300 + Math.floor(i / 7) * 4, 70, { id: `c${i}`, depth: i / 40 }));
    const r = placeLabels(cands, { max: 28, height: 14 });
    let clash = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (hits(r[i], r[j])) clash++;
    ok(clash === 0, '输出的任意两个标签框都不相交（这就是"不糊成一团"的可证形式）', `(${r.length} 个标签)`);
  }
  // ⑦ 确定性：同样输入两次结果一致（与"禁力导向"同一条纪律）
  {
    const cands = Array.from({ length: 20 }, (_, i) => box(100 + (i % 5) * 6, 200 + Math.floor(i / 5) * 5, 60, { id: `d${i}`, depth: 0.5 }));
    ok(JSON.stringify(placeLabels(cands)) === JSON.stringify(placeLabels(cands)),
      '两次调用逐字节相同（标签位置不会每次打开都变）');
  }
}

console.log('\n── ⑩ 尺度法则：尺寸脱钩 / 可分辨度 / 千人自适应（ADR-0014）──────');
{
  // ① 尺寸与缩放**脱钩**的可证形式：`starRadiusPx` 只有一个参数，zoom 根本进不来。
  //    这比"记得别乘 zoom"强 —— 它是结构上的，改回去必然被这条断言挡住。
  ok(starRadiusPx.length === 1, 'starRadiusPx 只接受一个参数（深度）⇒ zoom 在结构上进不来');
  ok(near(starRadiusPx(0), STAR_R_MIN) && near(starRadiusPx(1), STAR_R_MAX),
    '深度 0/1 分别落在 STAR_R_MIN / STAR_R_MAX', `${starRadiusPx(0)} → ${starRadiusPx(1)}`);
  {
    let prev = -1, mono = true;
    for (let i = 0; i <= 40; i++) { const r = starRadiusPx(i / 40); if (r <= prev) mono = false; prev = r; }
    ok(mono, '越深越大（严格单调，40 个采样点）');
    ok(starRadiusPx(0.5) > STAR_R_MIN && starRadiusPx(0.5) < STAR_R_MAX * 0.8,
      '幂律压缩：中位深度 ≠ 中位半径（浅星不至于小到看不见）', `${starRadiusPx(0.5).toFixed(3)}px`);
    ok(near(starRadiusPx(-5), STAR_R_MIN) && near(starRadiusPx(9), STAR_R_MAX), '越界的深度被夹住（不崩也不反向）');
  }

  // ② 世界最近邻间距：用**已知解析解**的点阵对拍（简单立方 d=0.5 ⇒ 最近邻恒为 0.5）。
  {
    const d = 0.5, pts = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) pts.push([i * d, j * d, k * d]);
    ok(near(worldNNSep(pts), d, 1e-9), '立方点阵 d=0.5 ⇒ 最近邻间距中位恰好 0.5', `${worldNNSep(pts)}`);
    ok(worldNNSep([]) === 0 && worldNNSep([[0, 0, 0]]) === 0, '空集 / 单点 ⇒ 0（不返回 Infinity）');
    const shuffled = pts.slice().reverse();
    ok(near(worldNNSep(shuffled), worldNNSep(pts), 1e-12), '与输入顺序无关（中位数是集合量）');
    const two = [[0, 0, 0], [0.2, 0, 0]];
    ok(near(worldNNSep(two), 0.2, 1e-9), '两点 ⇒ 就是它们的距离');
  }

  // ③ 可分辨度：线性于屏幕比例、反比于半径 —— 这正是"人数翻四倍 ⇒ res 减半"的机制。
  {
    const s = resolvability(0.02, 300, 2);
    ok(near(resolvability(0.02, 600, 2), s * 2, 1e-9), 'res 线性于屏幕比例（屏幕拉大一倍 ⇒ res 翻倍）');
    ok(near(resolvability(0.02, 300, 1), s * 2, 1e-9), 'res 反比于星点半径（点小一半 ⇒ res 翻倍）');
    ok(near(resolvability(0.02, 300, 2), 0.02 * 300 / 2, 1e-9), '口径就是 间距×屏幕比例 ÷ 半径');
    ok(resolvability(0, 100, 2) === 0, '没有间距 ⇒ res=0（⇒ 全云，不会崩）');
    ok(Number.isFinite(resolvability(0.02, 300, 0)), '半径给 0 不返回 Infinity（有内夹）');
  }

  // ④ 个体化策略：两端精确、中间连续（**无 LOD 跳变**是本条的全部意义）
  {
    const p0 = individuationPolicy(RES_MERGED * 0.5);
    const p1 = individuationPolicy(RES_SEPARATED * 1.5);
    ok(p0.t === 0 && p1.t === 1, 'res ≤ merged ⇒ t 恰为 0；res ≥ separated ⇒ t 恰为 1');
    {
      let prev = -1, mono = true, maxJump = 0;
      const N = 400, a = RES_MERGED * 0.5, b = RES_SEPARATED * 1.5;
      for (let i = 0; i <= N; i++) {
        const t = individuationPolicy(a + (b - a) * (i / N)).t;
        if (t < prev - 1e-12) mono = false;
        if (i) maxJump = Math.max(maxJump, Math.abs(t - prev));
        prev = t;
      }
      ok(mono, 't 随 res 单调不减（400 个采样点）');
      ok(maxJump < 0.02, 't 是连续的：相邻采样点的最大跳变 < 0.02 ⇒ 没有 LOD 跳变', `(最大 ${maxJump.toFixed(4)})`);
    }
    ok(near(p0.starAlpha(0.4), p0.cloudAlpha(0.4), 1e-12) && near(p1.starAlpha(0.4), p1.brightAlpha(0.4), 1e-12),
      't=0 走云剖面、t=1 走个体剖面（两端各自退化到它该有的那条）');
    {
      let bad = 0;
      for (const res of [0, 1, 2.5, 4, 9]) {
        const p = individuationPolicy(res);
        for (let d = 0; d <= 1.0001; d += 0.1) {
          const a = p.starAlpha(Math.min(1, d));
          if (!(a >= 0 && a <= 1)) bad++;
        }
      }
      ok(bad === 0, '任何 res × 任何深度下，星点亮度都落在 [0,1]');
    }
    ok(p0.cloudAlpha(0) === CLOUD_ALPHA_MIN && p1.brightAlpha(0) === BRIGHT_ALPHA_MIN,
      '云基底 / 个体基底就是声明的那两个常数（没有暗藏的偏置）');
    {
      // 弦的三档：远景只有深档活着（骨架），近景三档全开，且始终单调。
      ok(p0.gates[0] === 0 && p0.gates[1] === 0, '远景时浅档与中档**完全不画**（gate 恰为 0）');
      ok(near(p0.gates[2], CHORD_DEEP_KEEP, 1e-6), '远景保留深档骨架（= CHORD_DEEP_KEEP）');
      ok(near(p1.gates[2], CHORD_TIER_CEIL[2], 1e-9), '近景时深档回到满值（"一条不少"）');
      let mono = true;
      for (let i = 0; i < 3; i++) if (p1.gates[i] < p0.gates[i] - 1e-12) mono = false;
      ok(mono, '三档的落点随 t 单调抬升（放大过程中只会逐档出现，不会倒退）');
      ok(p1.chordAlphaFactor(0) < p1.chordAlphaFactor(1) && p1.chordAlphaFactor(1) < p1.chordAlphaFactor(2),
        '同一 t 下：越深的档越亮（档位的语义没被压反）');
      ok(p0.chordAlphaFactor(0) === 0 && p0.chordAlphaFactor(1) === 0,
        '远景算出来的浅/中档系数恰为 0 ⇒ 配合 CHORD_ALPHA_FLOOR 就是"不画"');
      ok(CHORD_ALPHA_FLOOR > 0 && p0.chordAlphaFactor(2) > CHORD_ALPHA_FLOOR,
        '深档骨架必须**在可见下限之上**（否则"保留骨架"是空话）', `(深档 ${p0.chordAlphaFactor(2).toFixed(3)} vs 下限 ${CHORD_ALPHA_FLOOR})`);
    }
  }

  // ⑤ 光晕：远景大而软、近景紧而亮；且**远景大小跟着邻居间距走**（人数变多 ⇒ 自动收细）
  {
    const sep = 4;                                    // 屏幕上邻居间距 4px
    const pFar = individuationPolicy(0, { spacingPx: sep });
    const pNear = individuationPolicy(99, { spacingPx: sep });
    const rp = starRadiusPx(0.5);
    // 远景光晕半径**只由"邻居间距"决定、与星点大小无关**（画布乘回星点半径正好抵消）。
    // 这把"云的手感不随人数变"钉成了结构性质，而不是一句注释。
    const a1 = starRadiusPx(0.1), a2 = starRadiusPx(0.9);
    ok(near(pFar.glowMul(0.3, a1) * a1, pFar.glowMul(0.3, a2) * a2, 1e-9),
      '远景光晕半径只由邻居间距决定（与星点半径无关）',
      `(点 ${a1.toFixed(2)}px → 晕 ${(pFar.glowMul(0.3, a1) * a1).toFixed(2)}px；点 ${a2.toFixed(2)}px → 晕 ${(pFar.glowMul(0.3, a2) * a2).toFixed(2)}px)`);
    ok(pNear.glowMul(0.3, rp) * rp < 5, '近景光晕只比星点大一圈（大光晕才是"糊"的元凶）',
      `(${(pNear.glowMul(0.3, rp) * rp).toFixed(2)}px，星点本身 ${rp.toFixed(2)}px)`);

    // ── ⑤b「光晕不许叠爆」——本轮事故的判据（用户："这看起来不像星空啊"）──────────
    // 均匀点阵、间距 s、光晕半径 R = s·K·(LO+SPAN·a) 时，每像素累积光度
    //   Σ A·g(r_i) = A·a·n·∫g = A·a·(1/s²)·π·R²·剖面均值
    // 超过 ~1 就饱和成死白 —— 整片星团糊成一块没有颗粒的色斑（"水彩"）。
    // 旧值 K=7.0 ⇒ 实测 2.5~28 倍过饱和；这就是"不像星空"的算术原因。
    const satAt = (a) => GLOW_ALPHA_MUL * a * Math.PI * Math.pow(GLOW_FAR_SPACING_K * (GLOW_FAR_ALPHA_LO + GLOW_FAR_ALPHA_SPAN * a), 2) * glowProfileMean();
    const satDust = satAt(CLOUD_ALPHA_MIN), satMid = satAt(0.35), satHi = satAt(0.6);
    ok(satDust < 0.5 && satMid < 1 && satHi < 1.3,
      '均匀点阵下每像素累积光度不饱和（尘埃/中档/较亮三档都在 1 附近或以下）',
      `(尘埃 ${satDust.toFixed(2)} / 中 ${satMid.toFixed(2)} / 亮 ${satHi.toFixed(2)}；>1 即叠爆)`);
    ok(satAt(1) < 2, '即便最亮的那批星也不会把整片星团烧成死白', `(${satAt(1).toFixed(2)})`);
    ok(GLOW_FAR_SPACING_K <= 3,
      '远景光晕半径 ≤ 邻居间距 ×3（7× 时每个光晕覆盖 30~90 个邻居的位置 ⇒ 2.5~28 倍过饱和）',
      `(K=${GLOW_FAR_SPACING_K}，覆盖约 ${(Math.PI * GLOW_FAR_SPACING_K ** 2).toFixed(0)} 个邻居位置)`);
    ok(glowProfileMean() > 0 && glowProfileMean() < 1, '光晕剖面均值在 (0,1) 内（用于上面的不等式）',
      `(均值 ${glowProfileMean().toFixed(3)}，色标 ${GLOW_STOPS.length} 段)`);
    // 千人自适应：间距减半 ⇒ 远景光晕半径也减半（云的手感不随人数变）
    const pHalf = individuationPolicy(0, { spacingPx: sep / 2 });
    ok(near(pHalf.glowMul(0.3, rp) * rp, pFar.glowMul(0.3, rp) * rp / 2, 1e-9),
      '远景光晕半径 ∝ 邻居间距：人数翻四倍（间距减半）⇒ 光晕同步收细，云不糊成一块',
      `(${(pHalf.glowMul(0.3, rp) * rp).toFixed(2)}px vs ${(pFar.glowMul(0.3, rp) * rp).toFixed(2)}px)`);
    const fb = individuationPolicy(0);
    ok(near(fb.glowMul(0.5, rp), GLOW_FAR_FALLBACK + GLOW_FAR_FALLBACK_SPAN * 0.5, 1e-9),
      '拿不到邻居间距时退回固定倍数（不会算成 NaN / 0）');
    ok(pFar.glowMul(0.3, rp) > 0 && Number.isFinite(pFar.glowMul(1, rp)), '光晕倍数恒为正有限值');
  }

  // ⑥ 辐条：可见度 = **那个人**的可见度（唯一会随人数线性恶化的糊源，被这一条接进旋钮）
  {
    ok(spokeAlpha(0) === 0 && near(spokeAlpha(1), SPOKE_ALPHA_MAX, 1e-9),
      '全暗的人没有辐条；最亮的人拿到上限');
    ok(spokeAlpha(CLOUD_ALPHA_MIN) === 0, '尘埃级的亮度 ⇒ 辐条系数恰为 0（"云里的人，辐条也是云"）');
    ok(spokeAlpha(0.5) < SPOKE_ALPHA_MAX * 0.35, '中间亮度只给一点点（能顺着看清的只有浮出尘埃的那几十人）',
      `(${spokeAlpha(0.5).toFixed(3)} / ${SPOKE_ALPHA_MAX})`);
    let mono = true, prev = -1;
    for (let i = 0; i <= 20; i++) { const v = spokeAlpha(i / 20); if (v < prev - 1e-12) mono = false; prev = v; }
    ok(mono, '单调不减');
    ok(near(spokeAlpha(1, { max: 0.5 }), 0.5, 1e-9), '上限可被调用方覆盖（设置/预览要能用同一函数）');
  }

  // ⑦ 墨量守恒：线宽与透明度同乘一个系数 ⇒ 局部墨量 ∝ 系数²；系数²×倍率随倍率**下降**
  {
    ok(near(lineScaleForZoom(LINE_ZOOM_REF), 1, 1e-9), '默认倍率处系数恰为 1（线宽/透明度就是原值）');
    ok(lineScaleForZoom(1e6) === LINE_SCALE_MIN && lineScaleForZoom(1e-6) === LINE_SCALE_MIN,
      '两端极端倍率都钳到下限（线细，不粗）');
    ok(LINE_SCALE_MAX === 1 && lineScaleForZoom(0.05) === LINE_SCALE_MIN,
      '**缩小绝不变粗**：系数上限恒为 1（曾经是 1.6，实测 0.4× 的局部墨量 p90 冲到 66）');
    ok(near(lineScaleForZoom(0.4), 0.4 / LINE_ZOOM_REF, 1e-9) && lineScaleForZoom(0.4) < 0.2,
      '**缩小时线真的变细**（ADR-0018：旧律在 zoom<2.5 恒给 1，0.4× 时 p90 线 2.68px 打在 52px 的宇宙上）',
      `(0.4× ⇒ ${lineScaleForZoom(0.4).toFixed(2)})`);
    ok(lineScaleForZoom(0.4) < lineScaleForZoom(1) && lineScaleForZoom(1) < lineScaleForZoom(2.5),
      '缩小方向单调变细，在 z=REF 处与放大半边连续');
    let mono = true, prev = Infinity, inkGrowth = [];
    for (const z of [2.5, 4, 6, 8, 11, 16, 24]) {
      const sc = lineScaleForZoom(z);
      if (sc > prev + 1e-12) mono = false;
      prev = sc;
      inkGrowth.push([z, sc * sc * z]);          // 墨量 ∝ s²，屏幕里的线长 ∝ 倍率
    }
    ok(mono, '倍率越大线越细（用户那句"比例尺越大那些看起来更细"的直接落实）');
    // 只断言"没触底"的那一段：超过 `LINE_ZOOM_REF / LINE_SCALE_MIN` 后系数已被夹住，
    // "线随倍率变细"这件事自然停止（再细就没有像素了），墨量模型不再适用。
    const zClamp = LINE_ZOOM_REF / LINE_SCALE_MIN;
    let nonGrowth = true, seg = [];
    for (const [z, v] of inkGrowth) { if (z > zClamp + 1e-9) break; seg.push(`${z}×:${v.toFixed(2)}`); }
    for (let i = 1; i < seg.length; i++) if (+seg[i].split(':')[1] > +seg[i - 1].split(':')[1] + 1e-9) nonGrowth = false;
    ok(seg.length >= 3 && nonGrowth, `每单位屏幕面积的墨量随倍率**不增**（放大只让结构散开，不会越看越糊）`,
      `${seg.join(' ')} ｜ ${zClamp}× 之后触底为 ${LINE_SCALE_MIN}`);
    ok(lineScaleForZoom(zClamp * 3) === LINE_SCALE_MIN && lineScaleForZoom(zClamp) > LINE_SCALE_MIN - 1e-9,
      '钳位点就在 LINE_ZOOM_REF / LINE_SCALE_MIN 处（不是随手一个魔数）', `(${zClamp}×)`);
  }

  // ⑦b 弦的屏幕尺寸退场（ADR-0018 —— 用户 #8）：锚是宇宙包围盒像素直径 ÷ 画布高
  {
    const base = { spacingPx: 0 };
    const full = individuationPolicy(0, { ...base, spanPx: 1000, canvasH: 500 });
    const mid = individuationPolicy(0, { ...base, spanPx: 100, canvasH: 500 });   // < H/4、≥ H/8
    const far = individuationPolicy(0, { ...base, spanPx: 50, canvasH: 500 });    // < H/8
    const noSig = individuationPolicy(0, { spacingPx: 0 });                        // 没给尺寸信号
    ok(full.chordFloor === 0, '宇宙 ≥ 画布高 1/4 ⇒ 档位照旧（res 通道管）');
    ok(mid.chordFloor === 2, '宇宙 < 画布高 1/4 ⇒ 只留深档（浅/中退场）', `(floor=${mid.chordFloor})`);
    ok(far.chordFloor === 3, '宇宙 < 画布高 1/8 ⇒ 弦全退，只剩星云', `(floor=${far.chordFloor})`);
    ok(noSig.chordFloor === 0, '拿不到尺寸信号 ⇒ 不剔（缺数据时宁可多画，不静默丢内容）');
    ok(individuationPolicy(1, { ...base, spanPx: 50, canvasH: 500 }).chordFloor === 3,
      '尺寸通道与 res 通道**取更严者**（个体化再高也救不回 1/8 以下的弦）');
  }

  // ⑧ 视口判定：端点必须**含边界**，否则边缘上的星会被凭空丢掉
  {
    const r = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    ok(pointInRect(0, 0, r) && pointInRect(10, 10, r), '边界上的点算在视口内（含端点）');
    ok(pointInRect(5, 5, r), '内部的点在');
    ok(!pointInRect(-0.01, 5, r) && !pointInRect(5, 10.01, r), '外面的点不在');
  }

  // ⑨ 群内活跃名次必须**严格全序**且**均匀**（并列同名次会让一圈人挤在同一个半径上）
  {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, v: i }));
    const m = strictRanks(items);
    const vals = items.map((x) => m.get(x.id));
    ok(new Set(vals).size === 50, '50 个不同的值 ⇒ 50 个互不相同的名次（严格全序）');
    ok(near(Math.min(...vals), 0) && near(Math.max(...vals), 1), '名次刚好铺满 [0,1]');
    ok(near(vals.reduce((a, b) => a + b, 0) / 50, 0.5, 1e-9), '名次均匀（均值 0.5 ⇒ 半径均匀 ⇒ 面密度 ∝ 1/r）');
    const p10 = m.get('p10');
    ok(near(p10, 10 / 49, 1e-9), '名次与真值次序一致', '(p10 → ' + p10.toFixed(4) + ')');
    const tied = strictRanks(Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, v: 0 })));
    ok(new Set([...tied.values()]).size === 30, '**全部并列**时仍给出 30 个不同名次（实测踩过的那颗雷）');
    const again = strictRanks(items);
    ok(items.every((x) => m.get(x.id) === again.get(x.id)), '同一输入两次 ⇒ 逐字节相同（布局可复现）');
    ok(strictRanks([{ id: 'only', v: 0 }]).get('only') === 1, '单元素 ⇒ 1（唯一的边不该被甩到最外缘）');
  }

  // ⑩ 千人自适应（端到端）：同一个视角下人数翻四倍 ⇒ 世界更挤 ⇒ res 更低 ⇒ 更早进入"云"。
  //    这就是"防止超大型千人群糊作一团"在**代码层**的保证 —— 不是靠给千人群手调阈值。
  {
    const mk = (n) => {
      const spokes = Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        cooc: (i + 1) / n,
        inter: (i % 7) / 7,
        byScope: { 'group:big': { cooccurrence: { normalized: (i + 1) / n }, interaction: { normalized: (i % 7) / 7 } } }
      }));
      return buildUniverse({
        centerId: 'her',
        scopes: [{ scope: 'group:big', kind: 'group', messages: 100000 }],
        spokes,
        chords: []
      });
    };
    const u1 = mk(200), u4 = mk(800);
    const refScale = Math.min(1280, 860) * 0.5 * 2.5 / 3.2;   // 与页面默认视角同口径
    const resOf = (u) => resolvability(u.stats.worldNNSep, refScale, starRadiusPx(0.5));
    ok(u4.stats.worldNNSep < u1.stats.worldNNSep,
      '人数 ×4 ⇒ 世界最近邻间距变小（真的更挤了）',
      `(${u1.stats.worldNNSep.toFixed(5)} → ${u4.stats.worldNNSep.toFixed(5)})`);
    ok(resOf(u4) < resOf(u1) * 0.75,
      '人数 ×4 ⇒ 可分辨度显著下降 ⇒ t 更低 ⇒ **更早变成云**（无需人手调阈值）',
      `(res ${resOf(u1).toFixed(2)} → ${resOf(u4).toFixed(2)}，t ${individuationPolicy(resOf(u1)).t.toFixed(3)} → ${individuationPolicy(resOf(u4)).t.toFixed(3)})`);
    ok(u4.stats.stars === 800 && u1.stats.stars === 200, '两颗宇宙的星数照实（对照组本身没跑偏）');
  }
}

console.log('\n── ⑪ 星系形态与运动（ADR-0022）─────────────────────');
{
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const d3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // ── ① 形态帧：确定性、正交、单位 ─────────────────────────────────────
  {
    const sh = galaxyShape('group:X');
    ok(galaxyShape('group:X') === sh, '同一个群拿到**同一份**形态帧（每次打开形态一样；布局可复现）');
    ok(galaxyShape('group:X').axis.join() !== galaxyShape('group:Y').axis.join(),
      '不同群的形态帧不同（不是所有群共用一个朝向）');
    ok(Math.abs(len(sh.axis) - 1) < 1e-9 && Math.abs(len(sh.p1) - 1) < 1e-9 && Math.abs(len(sh.p2) - 1) < 1e-9,
      '自转轴 / 长轴 / 短轴都是单位向量');
    ok(Math.abs(dot(sh.p1, sh.p2)) < 1e-9 && Math.abs(dot(sh.p1, sh.axis)) < 1e-9 && Math.abs(dot(sh.p2, sh.axis)) < 1e-9,
      '三轴两两正交（正交性坏了 ⇒ 压扁会连带把盘转歪）');
    ok(sh.squash === DISK_SQUASH && sh.squash < 1,
      '自转轴方向**压扁**（< 1 ⇒ 是盘不是球）', `squash=${sh.squash}`);
    ok(sh.clumps.length === CLUMP_COUNT && sh.clumps.every((c) => Math.abs(len(c) - 1) < 1e-9),
      `子团中心有 ${CLUMP_COUNT} 个、且都是单位向量`);
    ok(sh.elong >= DISK_ELONG * 0.5 && sh.elong <= DISK_ELONG * 1.5,
      '盘内长短轴差在声明范围内（逐群随机，带内取值）', `elong=${sh.elong.toFixed(3)}（带 [${(DISK_ELONG * 0.5).toFixed(2)}, ${(DISK_ELONG * 1.5).toFixed(2)}]）`);
  }

  // ── ② 偏移形状：「不是球」的可证形式 ─────────────────────────────────
  {
    const sh = galaxyShape('group:X');
    let mn = 9, mx = -9, worstOut = 0;
    const acc = [0, 0, 0];
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const d = shapeOffset(sh, `s${i}`);
      const L = len(d);
      mn = Math.min(mn, L); mx = Math.max(mx, L);
      worstOut = Math.max(worstOut, Math.abs(dot(d, sh.p1)), Math.abs(dot(d, sh.p2)), Math.abs(dot(d, sh.axis)));
      acc[0] += Math.abs(dot(d, sh.p1)); acc[1] += Math.abs(dot(d, sh.p2)); acc[2] += Math.abs(dot(d, sh.axis));
    }
    ok(mx <= 1 + 1e-9, '|偏移| ≤ 1（**结构上**保证成员不出球 —— 形态只改形状，不改归属）', `max=${mx.toFixed(4)}`);
    ok(mx - mn > 0.2, '偏移长度**不是一个常数**（各向同性球会是 min = max = 1 ⇒ "简单的球"）',
      `[${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
    ok(worstOut <= 1 + 1e-9, '沿三轴的投影都在 ±1 内（同上，夹在球里）');
    const [a1, a2, a3] = acc.map((v) => v / N);
    ok(a1 > a2 + 0.02 && a1 > a3 + 0.05,
      '三轴展布**互不相等**：长轴 > 短轴（盘内各向异性）且长轴 > 自转轴（压扁）—— 各向同性球会三者相等',
      `(${a1.toFixed(3)} > ${a2.toFixed(3)} / ${a3.toFixed(3)})`);
    ok(CLUMP_PULL > 0 && CLUMP_COUNT >= 2, '子团真的把成员往中心拉（子结构 = 凌乱的来源，不是噪声）');
  }

  // ── ③ 角速度：离球心越近越快（用户那条诉求的可证形式）───────────────
  {
    ok(near(orbitOmega(0), ORBIT_CORE_OMEGA, 1e-12), 'ρ=0（最靠球心）⇒ 角速度 = ORBIT_CORE_OMEGA');
    ok(orbitOmega(1) < orbitOmega(0), 'ρ=1（最外圈）更慢 —— **离中心越近越快**',
      `(${orbitOmega(0).toFixed(4)} > ${orbitOmega(1).toFixed(4)} rad/s)`);
    let mono = true, prev = Infinity;
    for (let i = 0; i <= 50; i++) { const v = orbitOmega(i / 50); if (v > prev + 1e-15) mono = false; prev = v; }
    ok(mono, '角速度对半径**严格单调递减**（50 个采样点，不许中段反弹）');
    ok(near(orbitOmega(-3), ORBIT_CORE_OMEGA, 1e-12) && near(orbitOmega(9), orbitOmega(1), 1e-12),
      '越界的 ρ 被夹住（不崩也不反向）');
    ok(orbitOmega(0) / orbitOmega(1) > 1.5, '内外圈差速是**看得出来的**（比值 > 1.5；1.0 就等于刚体转动）',
      `(${(orbitOmega(0) / orbitOmega(1)).toFixed(2)}×)`);
  }

  // ── ④ t = 0 必须逐位等于静止布局（暂停/截图/测试看的就是那一帧）─────
  const scopes = [
    { scope: 'group:A', kind: 'group', messages: 3000, members: 200 },
    { scope: 'group:B', kind: 'group', messages: 1000, members: 80 },
    { scope: 'group:C', kind: 'group', messages: 200, members: 20 },
    { scope: 'private:D', kind: 'private', messages: 300, members: 2 }
  ];
  const w1 = (scope, v, raw) => ({ [scope]: { cooccurrence: { normalized: v, raw }, interaction: { normalized: v, raw: raw * 0.75 } } });
  const spokes = [
    { id: 'onlyA', cooc: 0.40, inter: 0.30, coocRaw: 400, interRaw: 300, byScope: w1('group:A', 0.4, 400) },
    { id: 'onlyB', cooc: 0.05, inter: 0.00, coocRaw: 50, interRaw: 0, byScope: w1('group:B', 0.05, 50) },
    { id: 'bridgeAB', cooc: 0.30, inter: 0.20, coocRaw: 300, interRaw: 200, byScope: { ...w1('group:A', 0.15, 150), ...w1('group:B', 0.15, 150) } },
    { id: 'dmOnly', cooc: 0.02, inter: 0.00, coocRaw: 20, interRaw: 0, byScope: w1('private:D', 0.02, 20) },
    { id: 'nowhere', cooc: 0.01, inter: 0.00, coocRaw: 10, interRaw: 0, byScope: {} }
  ];
  const u = buildUniverse({ centerId: 'me', scopes, spokes, chords: [] });
  const S = new Map(u.stars.map((s) => [s.id, s]));
  {
    let worstStatic = 0, worst = 0;
    for (const s of u.stars) {
      const p = starWorldPos(s, 0);
      worst = Math.max(worst, d3(p, [s.dir[0] * s.radius, s.dir[1] * s.radius, s.dir[2] * s.radius]));
    }
    worstStatic = worst;
    ok(worstStatic < 1e-12, '`starWorldPos(星, 0)` == 静止布局的位置（逐位一致）',
      `(最大偏差 ${worstStatic.toExponential(1)})`);
    ok(starWorldPos(S.get('nowhere'), 0)[0] === S.get('nowhere').dir[0] * S.get('nowhere').radius ||
      Math.abs(starWorldPos(S.get('nowhere'), 0)[0] - S.get('nowhere').dir[0] * S.get('nowhere').radius) < 1e-12,
      '没有轨道的星也退化正确（不会返回 NaN）');
  }

  // ── ⑤ 三类轨道分派正确 ──────────────────────────────────────────────
  {
    ok(S.get('onlyA').orbit.kind === 'galaxy', '只在一个群 ⇒ **绕该群球心自转**');
    ok(S.get('bridgeAB').orbit.kind === 'bridge', '参与两个群 ⇒ **绕宇宙中心公转**');
    ok(S.get('dmOnly').orbit.kind === 'drift', '只有私聊（没有群属）⇒ **绕宇宙中心慢转**（不假装有归属）');
    ok(S.get('nowhere').orbit.kind === 'drift', '哪个群都不在 ⇒ 同样慢转');
    ok(S.get('onlyA').orbit.center.join() === u.galaxies.find((g) => g.scope === 'group:A').core.join(),
      '自转的圆心就是**那个群的球心**（不是宇宙中心）');
    ok(S.get('bridgeAB').orbit.center === undefined && S.get('dmOnly').orbit.center.join() === '0,0,0',
      '公转/慢转的圆心是**宇宙中心**（原点）');
  }

  // ── ⑥ 自转：圆轨道（到球心距离恒定）+ 越熟越快 ──────────────────────
  {
    const a = S.get('onlyA');
    const r0 = len([a.orbit.par[0] + a.orbit.perp[0], a.orbit.par[1] + a.orbit.perp[1], a.orbit.par[2] + a.orbit.perp[2]]);
    let drift = 0;
    for (const t of [0, 3, 17, 61, 240, 999]) {
      const d = d3(starWorldPos(a, t), a.orbit.center);
      drift = Math.max(drift, Math.abs(d - r0) / r0);
    }
    ok(drift < 1e-12, '自转是**圆轨道**：到球心距离不随时间变（周期内不许漂出去）',
      `(相对漂移 ${drift.toExponential(1)})`);
    const wAB = Math.hypot(...starWorldPos(a, 1).map((v, i) => v - starWorldPos(a, 0)[i]));
    ok(wAB > 0, '一分钟内真的动了（角速度非零）', `(1 秒走 ${wAB.toFixed(4)})`);
    // 同一个群里：更熟的人偏移更小 ⇒ ω 更大（"离中心越近越快"的直接读数）
    // ⚠️ 必须用**相对球心的偏移**（orbit.par + orbit.perp），不是 `star.radius`（那是到**原点**的距离）。
    const offLen = (s) => len([0, 1, 2].map((i) => s.orbit.par[i] + s.orbit.perp[i]));
    const rhoOf = (s, scope) => offLen(s) / u.galaxies.find((g) => g.scope === scope).ballR;
    ok(orbitOmega(rhoOf(a, 'group:A')) > orbitOmega(rhoOf(S.get('onlyB'), 'group:B')),
      '同群内更靠球心的人角速度更大（把"越熟越靠球心"与"越近越快"接了起来）',
      `(ρ ${rhoOf(a, 'group:A').toFixed(3)} → ω ${orbitOmega(rhoOf(a, 'group:A')).toFixed(4)} vs ρ ${rhoOf(S.get('onlyB'), 'group:B').toFixed(3)} → ω ${orbitOmega(rhoOf(S.get('onlyB'), 'group:B')).toFixed(4)})`);
  }

  // ── ⑦ 公转：绕宇宙中心、一圈内**依次经过自己参与过的每个群** ────────
  {
    const b = S.get('bridgeAB');
    const T = 2 * Math.PI / Math.abs(b.orbit.omega);
    ok(T > 30 && T < 1000, '一圈的周期是"人看得见"的量级（30s ~ 1000s）', `(${T.toFixed(0)} s)`);
    ok(d3(starWorldPos(b, T), starWorldPos(b, 0)) < 1e-9, '走满一圈**精确回到起点**（闭合环）');
    let minR = Infinity;
    for (let i = 0; i <= 360; i++) minR = Math.min(minR, len(starWorldPos(b, T * i / 360)));
    ok(minR > 0.15, '环上任何一点都不掉进宇宙中心（不是"穿过她"的轨道）', `(最近 ${minR.toFixed(3)})`);
    for (const g of b.galaxies) {
      const core = u.galaxies.find((x) => x.scope === g.scope).core;
      let m = Infinity;
      for (let i = 0; i <= 720; i++) m = Math.min(m, d3(starWorldPos(b, T * i / 720), core));
      ok(m < len(core) * 0.35, `一圈内**经过**它参与的群 ${g.scope}（最近距离远小于该群到圆心的距离）`,
        `(最近 ${m.toFixed(3)} / ${len(core).toFixed(3)})`);
    }
    // 起点 = 加权平均球心（ADR-0012 §2 同口径：桥落在两团之间）
    {
      const p = starWorldPos(b, 0);
      const dA = d3(p, u.galaxies.find((x) => x.scope === 'group:A').core);
      const dB = d3(p, u.galaxies.find((x) => x.scope === 'group:B').core);
      ok(Math.abs(dA - dB) < Math.max(dA, dB) * 0.25, '等权跨群人 t=0 仍落在两团**之间**（ADR-0012 §2 原样保留）',
        `(A ${dA.toFixed(3)} / B ${dB.toFixed(3)})`);
    }
  }

  // ── ⑧ 慢转：半径不变、角速度非零 ────────────────────────────────────
  {
    const d = S.get('dmOnly');
    const r0 = len([d.dir[0] * d.radius, d.dir[1] * d.radius, d.dir[2] * d.radius]);
    let drift = 0;
    for (const t of [0, 11, 53, 301]) drift = Math.max(drift, Math.abs(len(starWorldPos(d, t)) - r0) / r0);
    ok(drift < 1e-12, '慢转也是圆轨道（半径恒定）');
    ok(Math.abs(d.orbit.omega) > 0 && Math.abs(d.orbit.omega) <= DRIFT_OMEGA + 0.05,
      '慢转的角速度在声明范围内（比星系自转慢得多 —— "没有群属"不该抢戏）', `(ω=${d.orbit.omega.toFixed(4)})`);
  }

  // ── ⑨「凌乱」：同群成员的半径**不是一个常数**（打散同心壳）──────────
  {
    const mk = (n) => buildUniverse({
      centerId: 'S',
      scopes: [{ scope: 'group:R', kind: 'group', messages: 50000, members: 400 }],
      spokes: Array.from({ length: n }, (_, i) => ({
        id: `m${i}`, cooc: (i + 1) / n, inter: ((i % 5) + 1) / 5,
        coocRaw: (i + 1) * 3, interRaw: ((i % 5) + 1) * 10,
        byScope: { 'group:R': { cooccurrence: { normalized: (i + 1) / n }, interaction: { normalized: ((i % 5) + 1) / 5 } } }
      })),
      chords: []
    });
    const uu = mk(200);
    const g = uu.galaxies[0];
    const offs = uu.stars.map((s) => d3(starWorldPos(s, 0), g.core) / g.ballR);
    const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
    const sd = Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / offs.length);
    ok(sd > 0.05, '同群成员的 `到球心的距离 ÷ 球半径` **有展布**（各向同性 + 只按深度排 ⇒ σ≈0 的同心壳）',
      `(均值 ${mean.toFixed(3)} / σ ${sd.toFixed(3)})`);
    // 同名次（同深度）的人半径也必须不同 —— 这才是"凌乱"，而不是"换了个形状的壳"
    const tie = buildUniverse({
      centerId: 'S',
      scopes: [{ scope: 'group:R', kind: 'group', messages: 50000, members: 400 }],
      spokes: Array.from({ length: 120 }, (_, i) => ({
        id: `t${i}`, cooc: 0.1, inter: 0.1, coocRaw: 5, interRaw: 5,
        byScope: { 'group:R': { cooccurrence: { normalized: 0.1 }, interaction: { normalized: 0.1 } } }
      })),
      chords: []
    });
    const gt = tie.galaxies[0];
    const rs = tie.stars.map((s) => d3(starWorldPos(s, 0), gt.core));
    ok(new Set(tie.stars.map((s) => s.depth)).size === 1, '构造：这 120 个人深度**完全相同**（并列同值）');
    ok(Math.max(...rs) - Math.min(...rs) > gt.ballR * 0.2,
      '**同深度**的人半径也不同（旧口径下他们全落在同一个球面上 = 同心壳）',
      `(半径 ${Math.min(...rs).toFixed(3)} ~ ${Math.max(...rs).toFixed(3)}，球半径 ${gt.ballR.toFixed(3)})`);
  }

  // ── ⑩「星系更大 / 别吞掉中心」的标定（用户："太空了……再大一点"）────
  {
    const big = BALL_K * Math.cbrt(981);      // 真数据里的主群人数
    ok(big >= 0.30, '主群（981 人）球半径 ≥ 0.30（旧值 0.199 ⇒ 屏幕上直径 ×1.6）',
      `(${big.toFixed(3)}，旧值 0.199)`);
    ok(big > 0.020 * Math.cbrt(981) * 1.4, '确实比 ADR-0017 的旧常数大了 40% 以上', `(×${(big / (0.020 * Math.cbrt(981))).toFixed(2)})`);
    ok(CORE_R_MIN - big > R_INNER_MIN, '最大的球**内缘不越过内环带**（球心距离 − 球半径 > R_INNER_MIN）',
      `(${(CORE_R_MIN - big).toFixed(3)} > ${R_INNER_MIN})`);
    ok(CORE_R_MAX > 0.78, '最冷群的球心被推得更远（整片宇宙在屏幕上更大，填掉"太空"）', `(${CORE_R_MAX})`);
  }

  // ── ⑪ 最优拟合平面：k≥3 时结点在平面内尽量分得开 ────────────────────
  {
    const cores = [
      { core: normalize3([1, 0, 0]) },
      { core: normalize3([0.9, 0.1, 0]) },
      { core: normalize3([0, 0, 1]) }
    ];
    const n = bestFitNormal(cores);
    ok(Math.abs(len(n) - 1) < 1e-9, '法线是单位向量');
    // 最小特征向量 ⇒ 出平面分量的平方和最小（用采样对拍：随便换个方向都应更大）
    const cost = (nn) => cores.reduce((s, c) => s + Math.pow(dot(c.core, nn), 2), 0);
    let better = 0;
    for (let i = 0; i < 200; i++) {
      const r = normalize3([hash01(`n${i}`, 'a') - 0.5, hash01(`n${i}`, 'b') - 0.5, hash01(`n${i}`, 'c') - 0.5]);
      if (cost(r) < cost(n) - 1e-12) better++;
    }
    ok(better === 0, '随机 200 个方向里没有一个比它更贴合（真的是**最优拟合平面**）', `(更优的 ${better} 个)`);
    const two = bestFitNormal([{ core: [1, 0, 0] }, { core: [0, 1, 0] }]);
    ok(Math.abs(Math.abs(two[2]) - 1) < 1e-9, '两个球心 ⇒ 退化回它们张成的平面（法线 ⊥ 两者）');
  }
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`星图布局：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);