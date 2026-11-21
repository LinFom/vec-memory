// starmap-layout.mjs — 「关系星图」的**布局数学**（纯函数，零 DOM、零网络）。
//
// ── 为什么单独一个文件 ───────────────────────────────────────────────────
// 画得好不好看是眼睛的事，但**每颗星落在哪**是数学的事 —— 数学必须能在 node 里断言，
// 否则"改一行布局代码"就只能靠肉眼在浏览器里碰运气（本项目一路在消灭的正是这种局面）。
// 所以：本文件只做**输入数据 → 坐标**，不做任何绘制；绘制在 `starmap.js`。
//
// ── 口径来自 ADR（不要在这里另起一套）────────────────────────────────────
//   ADR-0011 §形态：一个会话 = 一个星系；中心 = self；线宽 = 深厚分
//   ADR-0012 §2  ：星唯一 —— 方向 = normalize(Σ_k w_k · dir_k)，w_k = 他在群 k 里与她的共现
//   ADR-0017     ：**群 = 球**（废止"从中心射出的锥"）：球心距离 = 该群与她的整体亲疏，
//                  球半径 ∝ ∛成员数，球内**深度 → 径向**（越熟越靠球心）
//   ADR-0012 §8  ：线的四个通道各管一件事
//
// ── 三个"有意为之的常数"（无分布证据，面板上标「可重校」）────────────────
//   1. `BALL_K`：球半径 = BALL_K × ∛成员数 —— **体积 ∝ 人数**（密度恒定）。
//      选 ∛ 而不选 √ 是用户拍板的：√ 会让千人群的球是 1 人群的 31 倍，太霸道；
//      ∛ 是 9.9 倍，密度一致、形状干净。
//   2. `CORE_R_*`：球心距离按**该群与她的整体亲疏**（群消息量排名）——
//      「哪个群跟她最热」这条通道由球心距离承载（旧几何里它由张角承载）。
//   3. `R_INNER_*`：只有私聊的人 = 内环（ADR-0012 §1），占一段**最靠中心**的半径带。
//      ⚠️ 内环带与最热球的内缘**允许交叠**：同一个人可以既在群里又有私聊，
//         交叠是数据本身的形状，不是布局错误。
//
// ⚠️ 本文件**同时**被浏览器（`web/starmap.js`）与 node 测试（`test/starmap.mjs`）加载
//    ⇒ 不许 import `node:*`，不许碰 DOM。所以下面的散列是**自带的小实现**，
//    不用 `node:crypto`。

// ── 可重校常数（集中放这里，别散在实现里）──────────────────────────────────
export const SECTOR_SOFTEN = 0.5;        // 群规模 → share 权重：pow(msgs, 0.5)（仍用于光斑亮度）
// ⚠️ 0.020 → 0.032（ADR-0022，用户："现在对整个宇宙来说太空了……可以让它们的星系大小再大一点"）——
//    实测（真数据 1251 星 / 981 人主群）：旧值下最大球半径只有 **0.199** ⇒ 屏幕直径 182px、
//    占画布宽 **14%**，而整个宇宙的包围盒只占宽 26% / 高 62% —— **"空"是量出来的，不是感觉**。
//    0.032 ⇒ 主群球半径 0.318（屏幕上 ×1.6），宇宙包围盒随之占高 ≈86%（还是"全景"，没出血）。
export const BALL_K = 0.034;             // 球半径 = 0.034 × ∛成员数（981 人 → 0.338）
export const CORE_R_MIN = 0.48;          // 球心最近距离（最热的群）—— 同时保证大球的内缘不吞掉中心与内环
export const CORE_R_MAX = 0.94;          // 球心最远距离（最冷的群）
export const IN_BALL_R_MIN = 0.08;       // 球内最近半径（防奇点：深度全 1 也不挤成一个点）
export const FALLBACK_R = 0.94;          // 没进任何已知群的人的壳（与最冷的群同层；无球可归）
export const R_MAX = 1.0;                // 世界半径上限
// 只有私聊的人 = **内环**（ADR-0012 §1）：整段落在最靠中心的一段带里。
// ⚠️ 不能只乘一个系数 —— 那样"深度低的内环人"仍会比"深度高的群友"更靠外，
//    内环就名不副实（实测踩到过：乘 0.45 后，最浅的私聊人 0.45 > 最亲的群友 0.34）。
export const R_INNER_MIN = 0.10;
export const R_INNER_MAX = 0.28;
export const SPHERE_CAP_COS = 0.25;      // 星系方位限制在球冠（见 fibonacciDirection）
export const INTIMACY_INTER_W = 0.67;    // 深厚分：互动权重（ADR-0011；共现占 0.33）

// ── 深度的绝对锚（0.26.0，ADR-0040；推翻 ADR-0011 的"百分位"输入）──────────
// 用户质问："怎么是个人随随便便关系都能做到'深'啊？" —— 质问成立：
// 旧口径把**百分位**喂给 `intimacyScore`，而百分位是纯相对量 —— 无论人群里
// 真实互动量多么稀薄，名次总均匀铺满 [0,1] ⇒ **最深档永远有人**，哪怕他只说过一句话
// （A 号 10-17 实测：98,716 条弦里 95% 互动 ≤1、p90=0，但中位弦照样拿了"中档"）。
// 深必须由**绝对证据量**挣来，不由"在人群里的排位"挣来。
// 校准（A 号 /graph，10-17）：与她的互动 raw —— 头名 340、次席 79、p90=0；
// 共现 raw —— 头名 317、p50=2。据此：
export const DEPTH_SAT_INTER = 300;      // 互动饱和点：≥300 次直接互动 = 深度满分（对数）
export const DEPTH_SAT_COO = 400;        // 共现饱和点：共现是弱信号（同时间桶即可），饱和点更远
// 两个常数**没有分布学证据**，标为可重校（与 INTIMACY_INTER_W 同一地位）；改动只影响
// 视觉半径/档位，不落盘、不进 read-model —— 与 ADR-0011 的"合成分只作用于视觉"同界。

/**
 * 绝对量 → 深度输入：`log1p(n) / log1p(SAT)`，封顶 1。
 * 对数而不是线性：让 5 次和 1 次拉开、但不让 5 次就摸到深档 ——
 * 线性下 1 次互动 ≈ 0.003 全被压扁，档位判据会退化成 0/1 开关。
 */
export function saturate(n, sat = DEPTH_SAT_INTER) {
  const v = Number(n) || 0;
  const s = Number(sat) > 0 ? Number(sat) : 1;
  return Math.min(1, Math.max(0, Math.log1p(Math.max(0, v)) / Math.log1p(s)));
}

// ── 星系形态与运动（ADR-0022）─────────────────────────────────────────────
// 口径：本节注释里的"球心 / 球半径"= **盘心 / 盘半径**（同一个点、同一个量；`ballR` 等代码名不改）。
//       形状变了，名字跟着形状走 —— 用户可见文案与 `CONTEXT.md` 一律写"盘心"。
// 用户原话：「这也太不像是宇宙了」+「星系不应该是个简单的球,分布应该更凌乱一点」。
// 病根：ADR-0017 的球内落点是 `球心 + 单位球面均匀方向 × r` —— **各向同性 + 无子结构**，
// 数学上就是一个**完美的球**（而且 `radial(depth)` 只依赖深度 ⇒ 还带一点"同心壳"味道）。
// 真实星系是**压扁的、带子结构的、有纹理的**。四件套：
// 沿自转轴的压扁（1 = 球）。
//   ⚠️ 0.60 → 0.70 是本轮实测后的折中：**压扁会缩小侧视时的轮廓** ——
//      盘几乎正侧对镜头时，可见面积只剩 squash 倍，于是把 BALL_K 的"更大"吃回去一部分
//      （实测主群屏幕轮廓只涨到预期的 61%）。0.70 仍然明显不是球（配盘内 1:0.87 椭圆 + 子团），
//      但不再薄到"看着更小"。
export const DISK_SQUASH = 0.70;
export const DISK_ELONG = 0.26;          // 盘内长短轴差（0 ⇒ 正圆盘；0.26 ⇒ 略椭圆的盘）
export const CLUMP_COUNT = 6;            // 子团数（"凌乱"来自子结构，不来自噪声）
// ⚠️ 0.75 → 0.55：拉力太强时每个子团被收成一颗**独立的小气球**（放大看是"5 个圆球"，
//    比"一个球"好不了多少）。0.55 让子团彼此咬合、外缘连成一片**不规则**的云。
export const CLUMP_PULL = 0.55;
export const RADIAL_JITTER = 0.14;       // 径向抖动（× 球半径）—— 打散"深度 = 同心壳"
export const AXIS_JITTER = 0.38;         // 每颗星的自转轴相对**星系轴**的扰动：
//   ① 保留"凌乱"—— 全部绕同一根轴差速转 ⇒ 几分钟后子团被磨成规则环（形态被运动吃掉）；
//   ② 于是 t=0 的凌乱能长期活着。轴扰动 0.38 ⇒ 轨道面相对盘面倾斜最多约 21°。

// 运动（用户："只属于这个群聊的成员围绕着星系中心以不同的速度转(离中心越近越快)"；
//        "属于多个群的……以宇宙中心为圆心,依次经过所有自己参与过的群聊做不规则环形运动"）
// `orbitOmega(ρ)`：ρ = 到球心的距离 ÷ 球半径（0 = 最靠球心）。
// ⚠️ 只能做成**角速度**差速（内快外慢）—— 圆轨道上"线速度"在 r→0 处自然趋零，
//    硬把内圈线速度做大 = 让 ω→∞，那是数值爆炸而不是运动。这是真实星系的差速自转，
//    它的可见证据是**同样的时间内内圈转过的角度更多**（几分钟后子团被剪切成旋臂）。
export const ORBIT_CORE_OMEGA = 0.16;    // rad/s：最靠球心的那一档（≈39 秒一圈）
export const ORBIT_RHO0 = 0.25;          // 差速软化：ω = CORE·ρ0/(ρ+ρ0) ⇒ 内外差 5 倍
export const BRIDGE_OMEGA = 0.030;       // rad/s：跨群人绕宇宙中心的基础角速度
export const BRIDGE_OMEGA_SPAN = 0.026;  // 逐人随机加成 ⇒ 不是整齐划一的"行星轨道"
export const BRIDGE_KNOT_SIGMA = 0.50;   // 半径-角度曲线的核宽（相位域，rad）
export const BRIDGE_WOBBLE_R = 0.10;     // 环半径的正弦抖动幅度（"不规则"）
export const BRIDGE_WOBBLE_OUT = 0.09;   // 出平面抖动幅度（"不规则"，第三维）
export const DRIFT_OMEGA = 0.020;        // rad/s：没有群属（内环 / 孤儿）的慢转
export const DRIFT_OMEGA_SPAN = 0.022;

/**
 * 星系内自转的角速度：**离球心越近越快**（用户那条诉求的可证形式）。
 * `ρ = 0` ⇒ `ORBIT_CORE_OMEGA`（最快）；`ρ = 1` ⇒ 它的 `ρ0/(1+ρ0)` 倍（最慢）。严格单调递减。
 */
export function orbitOmega(rho) {
  const p = Math.max(0, Math.min(1, Number(rho) || 0));
  return ORBIT_CORE_OMEGA * ORBIT_RHO0 / (p + ORBIT_RHO0);
}
// ── 深厚分 → 线宽（ADR-0016，**废止** ADR-0011 的 `1 + 5·deep**0.4`）─────────
// ⚠️ 这里曾写 `1 + 5 × deep ** 0.4`（自 ADR-0011 沿用 murmur 的 `combined ** 0.4`）。
//    那个指数是为**原始长尾量**（消息条数那类）设计的"长尾压缩"。而 `deep` 是
//    **百分位合成** `0.67·pct(inter) + 0.33·pct(cooc)` —— 两个均匀百分位的加权和，
//    **天生就在中段集中**（实测 p10=0.301 / p50=0.400 / p90=0.869），压根不是长尾。
//    把"压长尾"的指数用在"已经归一化"的量上，方向正好相反：**它把中段整片抬到接近上限。**
//    实测（7876 条真弦 / 3.4×）：宽度 p10=4.09、p90=5.73px ⇒ **p90/p10 只有 1.40**，
//    100% 的线 ≥3px、0% ≤1.5px。也就是"每个人的线都一样粗、看不出深浅"。
//    用户原话：「怎么每个人的线都这么粗啊，每个人的关系都很深厚吗?」正是这条的读数 ——
//    **这不是画得丑，是一条视觉通道事实上是死的**（说了等于没说）。
//    教训：**归一化是前提，不是可选项** —— 幂律的作用域必须与量的分布形态匹配，
//    把"长尾压缩"搬到"已经压平过的百分位"上，等于做了一次反向放大。
// 现行口径：`W_MIN + (W_MAX − W_MIN) · deep ** W_POW`，**指数 > 1**（拉开，而不是压平）。
//    标定（同一批真弦 / 3.4×）：浅端 0.44px、p50 0.55px、深档 0.97 ~ 2.20px、
//    p90/p10 = 3.26；70% 的弦 <1px、27% 在 1~2px、3% ≥2px ⇒ "多数细丝 + 少数有分量的线"。
//    T3 约束：最深那条 ≥1.6px（远景的"关系存在"骨架不许看不见）。
//    ⚠️ `W_POW` 与 `W_MAX` 是**同一件事的两半**：只把 max 调小而不动 pow ⇒ 又回到"全都一样细"，
//       与只把 pow 调小而不动 max 是同一种错（都是让动态范围塌掉）。
export const LINE_W_MIN = 0.60;
export const LINE_W_MAX = 3.00;
export const LINE_W_POW = 3.0;
export const TIER_COUNT = 3;             // 深厚档数（ADR-0012 §8：多于 3 在远景下只是噪声）
export const JITTER_SEED = 'mv-starmap-v1';

// ── 尺度法则（ADR-0014）──────────────────────────────────────────────────
// 用户报的原话：「比例尺越大，那些都看起来相应的更细才对」+「要做好超大型千人群聊下的准备」。
// 实测病根：旧式 `radiusPx ∝ 屏幕比例 ∝ zoom`，而**间距也 ∝ zoom** ⇒ 半径/间距是个
// **不变量**（实测 zoom=1 与 zoom=2.5 都是 2.93）—— 滚轮放大时重叠比一秒都没变。
// 所以：**尺寸与缩放脱钩**（半径只由深度决定），缩放只放大位置。
export const STAR_R_MIN = 1.0;           // 星点屏幕半径（px）：深度 0
export const STAR_R_MAX = 3.6;           // 深度 1
export const STAR_R_POW = 0.6;           // 幂律压缩（浅星不至于小到看不见）
// 光晕半径倍数（× 星点半径）。**远景大而软、近景紧而亮**，由同一个 t 驱动：
//   · 远景：光晕就是那片云的材质 —— 太小 ⇒ 云看不见（只剩一根根线），太大 ⇒ 糊成白团
//   · 近景：个体要清楚 ⇒ 光晕收到贴着点（实测旧值 3.4× 恒定正是"糊"的元凶：单独就 84% 覆盖）
// ⚠️ 远景**不再用一个固定倍数**：固定倍数意味着"人数翻倍 ⇒ 云变成更亮的一团"，
//    而正确的目标是「相邻光晕彼此相接、连成一片连续的云」—— 那取决于**星与星之间有多远**。
//    所以远景光晕半径 ≈ 邻居间距（= `worldNNSep × screenScale`）× K：
//    人数翻四倍 ⇒ 间距减半 ⇒ 光晕同步收小 ⇒ **云的手感不变，只是更细腻**。
//    这与 `res` 是同一套自适应逻辑（一个量随人数自动走），只是喂给了光晕。
// ⚠️ 这个系数从 7.0 收到 1.5 是本轮的关键修正（用户："这看起来不像星空啊"）。
//    7.0 的算术是对的、结论是错的：光晕半径 = 间距×7 ≈ 21~34px，而间距只有 3.9px
//    ⇒ 每个光晕覆盖 30~90 个邻居的位置，**累积量算出来是 2.5~28 倍过饱和** ——
//    于是整片星团糊成一个平滑色块（"水彩/棉花球"）。
//    **真正的星云质感来自星点的密度，不是来自大光晕。** 银河在天上也不是一团雾，
//    是"密到分不开的点"。所以光晕只做"点周围一圈晕"，云交给密度去长。
export const GLOW_FAR_SPACING_K = 1.5;    // 光晕半径 ≈ 邻居间距 × 1.5 ⇒ 只覆盖紧邻的一圈
// 光晕的**总不透明度倍数**（画布里 `globalAlpha = 星亮度 × 此值`）。
// ⚠️ 它与 `GLOW_FAR_SPACING_K` 是**同一件事的两半**：会不会叠爆只取决于
//    `A · π · K² · (LO+SPAN·a)² · 剖面均值`（均匀点阵下的每像素累积光度）。
//    单独调一个必然翻车 —— 本轮就是这么翻的：K=7 时即便 A 只有 0.62，也算出 2.5~28 倍过饱和。
//    放在这里（而不是画布里）是为了**让测试能对着这条不等式断言**：
//    渲染层的常数测不到，那条"定律"就等于没写在任何地方。
export const GLOW_ALPHA_MUL = 0.45;
/**
 * 光晕贴图的径向剖面 `[offset, alpha]`（**唯一定义处**；画布按它建 radialGradient）。
 * 放在布局层是为了让测试能算出"这张贴图在圆盘上的平均不透明度" —— 它是上面那条不等式的另一半。
 */
export const GLOW_STOPS = [[0, 1], [0.22, 1], [0.55, 0.30], [1, 0]];
/** 贴图在圆盘上的平均不透明度：把 `[offset, alpha]` 折线按**圆环面积**（`o²−o_prev²`）加权。 */
export function glowProfileMean(stops = GLOW_STOPS) {
  let mean = 0, prevOff = 0, prevA = Array.isArray(stops[0]) ? stops[0][1] : 0;
  for (let i = 1; i < stops.length; i++) {
    const o = Number(stops[i][0]), a = Number(stops[i][1]);
    mean += (o * o - prevOff * prevOff) * (prevA + a) / 2;
    prevOff = o; prevA = a;
  }
  return mean;
}
export const GLOW_FAR_ALPHA_LO = 0.70;    // 亮度对远景光晕的加成：深星的光晕更大（浮在云上）
export const GLOW_FAR_ALPHA_SPAN = 0.55;
export const GLOW_FAR_FALLBACK = 2.80;    // 拿不到邻居间距时的退路（旧口径：固定倍数）
export const GLOW_FAR_FALLBACK_SPAN = 2.60;
export const GLOW_NEAR_MIN = 1.00;        // 近景：光晕只比实心点大一圈（糊掉个体的是大光晕）
export const GLOW_NEAR_SPAN = 1.40;

// 可分辨度 = 屏幕最近邻间距 ÷ 星点半径。**它是把"千人级"做成自适应的那一个自变量**：
// 半径固定后 `res ∝ zoom ÷ √人数` ⇒ 人数翻四倍，星云自动提前一半倍率出现，无需手调阈值。
// ⚠️ 两个阈值是**实测标定值**（1000×620 / 979 星 / 主星系 330 人）：
//    · `res < 1.2` ⇒ 中心距不到 1.2 个半径（点几乎贴在一起）⇒ 全云
//    · `res > 3.2` ⇒ 中心距 3.2 个半径 = 1.6 个直径 ⇒ 稳定分开，个体清晰
//    由此得：默认 2.5× 是**纯星云**、约 5× 起混合、**8× 起全个体**。
//    无分布证据、可重校（与深厚分同款纪律）。
export const RES_MERGED = 1.20;          // res ≤ 此值 ⇒ 完全分不开 ⇒ 全云
export const RES_SEPARATED = 5.00;       // res ≥ 此值 ⇒ 稳定分开 ⇒ 全个体（实测 ≈9×，与"到 ≈11× 一条不少"的量级一致）
export const CLOUD_ALPHA_MIN = 0.22;     // 远景：尘埃基底（星点是主角，这一档要**看得见是颗星**）
export const CLOUD_ALPHA_SPAN = 0.78;
export const CLOUD_ALPHA_POW = 1.5;      // 大 ⇒ 只有很深的人才浮出尘埃（长尾剖面）
export const BRIGHT_ALPHA_MIN = 0.55;    // 近景：浅星的落点（不跟着一起变纯白）

// 星系核光斑（"星云的地标"）：**远浓近淡**，且**远小于星系张角**。
// ⚠️ 它曾经是 `半径 ≈ 星系张角 × 1.16 × (0.75+0.5·占比)`（主群亮斑直径 ≈ 450px）
//    配 0.26 的加色 —— 那个巨大平滑球本身就是"不像星空、像水彩"的头号功臣：
//    它盖住了星点，把整个星系变成一块没有颗粒的色斑。
//    现在的定位收缩为"一眼看出核在哪"：真正的星云质感必须由星点密度长出来。
export const CORE_GLOW_K = 0.40;         // 光斑半径 = 星系张角 × 此值（原来隐含 ≈ 1.16）
export const CORE_ALPHA_FAR = 0.16;      // 远景：淡淡的核光
export const CORE_ALPHA_NEAR = 0.06;     // 近景：让个体说话
export const CHORD_DEEP_KEEP = 0.22;     // 远景**保留深档线的骨架**（"关系存在"不该因一端不显眼而消失）
export const CHORD_DIM_MIN = 0.50;       // 弦的整体压淡系数下限（深档单独就是墨量大头）
// 三档在"完全个体化"时的落点（浅档本来就该淡）：只影响**亮度**，不影响"画不画"。
// ⚠️ 从 [0.38, 0.62, 1.00] 收到 [0.26, 0.46, 0.82]：**个体模式的主角是人，不是线**。
//    实测 5.8× 时弦网（hub 一个就有上百条边）会在视觉上盖过星点，画面读起来是"一张网"
//    而不是"一片星"。降下去之后放大时星点浮上来、线退成背景 —— 这正是「可分辨度」
//    该有的方向（越放大越像个体，不像关系图）。
export const CHORD_TIER_CEIL = [0.26, 0.46, 0.82];
// 弦的**可见下限**：算出来比它还淡 ⇒ 干脆不画。
// ⚠️ 为什么需要它：渲染层本来有个"别淡到看不见"的钳位（`max(0.04, alpha)`），
//    这条钳位**把渐显机制废掉了** —— 6× 时浅档算出来只有 0.002~0.008（早就该消失），
//    却被钳到 0.04 照画，3223 条浅档于是变成一层糊在整幅画上的纱。
//    "淡到看不见"就应该是看不见，而不是抬到看得见。两处渲染（Canvas / 预览 SVG）共用此值。
export const CHORD_ALPHA_FLOOR = 0.02;
// 辐条（她 ↔ 每个人）的可见度 —— **跟着那个人自己的可见度走**（ADR-0014 §2 的第四处同步）。
// 为什么必须接策略：辐条是**唯一全都汇于一点**的线。实测 2.5× 时约 800 条辐条以恒 0.22 实拉，
// 全叠在她身上 ⇒ 那一片"糊作一团"的主因根本不是弦（弦在远景已只剩深档 0.152）。
// 语义上也自洽：云里的人，他的辐条也只是那团云的一部分；能让你顺着看清的，
// 只有已经浮出尘埃的那几十个人 —— 这正是「涌现式星云」的同一个规则，不是新增一套判据。
export const SPOKE_ALPHA_MAX = 0.16;     // 最深那批人（浮出尘埃的）的辐条落点（恒细恒淡的上限）
export const SPOKE_STAR_LO = 0.62;       // 亮度 ≤ 此值 ⇒ 辐条完全并入云（不画）
export const SPOKE_STAR_HI = 0.95;       // 亮度 ≥ 此值 ⇒ 辐条满强度

/**
 * 稳定的 0..1 伪随机 —— **同一 id 永远同一个值**（布局必须可复现：图每次打开得一样，
 * 这是 ADR-0012「明确不做力导向」那条纪律的一部分）。
 * 自带实现（FNV-1a + xorshift 混淆），浏览器与 node 都能跑，不依赖 `node:crypto`。
 */
export function hash01(key, salt = '') {
  const s = `${JITTER_SEED}\u0000${salt}\u0000${key}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 再混两轮，避免相近字符串落在相近的值上（星团里 id 是连号的）
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

/** 百分位（0..1，**最小 → 0、最大 → 1**；并列取平均名次）。空集 ⇒ 空数组，单元素 ⇒ 1。
 *
 *  ⚠️ 用 `(平均名次 - 1) / (n - 1)` 而不是 `平均名次 / n`：后者永远取不到 0，
 *  于是"最浅的那条弦"也会被画成有颜色有粗细 —— 视觉上凭空多出一档下限。
 *  这里的口径保证输入的两端**真的**映射到 0 与 1。 */
export function percentileRanks(values) {
  const n = values.length;
  if (!n) return [];
  if (n === 1) return [1];
  const idx = values.map((v, i) => [Number(v) || 0, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;          // 1-based 平均名次
    const pct = (avgRank - 1) / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = pct;
    i = j + 1;
  }
  return out;
}

/**
 * 群内活跃名次：**严格全序**（0 = 最不活跃 ⇒ 甩到星团外缘；1 = 最活跃 ⇒ 落在星系核）。
 *
 * ⚠️ 为什么不用 `percentileRanks`（它给并列值**同一个**名次）：同一名次 ⇒ 同一半径
 * ⇒ 一圈人挤在一个圆上。实测踩到过：主群里大量成员的归一化共现都等于 0（从没跟她在
 * 那个群里同框），于是 200+ 人拿同名次、落同一半径，`worldNNSep` 从 ~0.05 掉到
 * **0.0033**（差一个数量级），"可分辨度"整个失真。
 * 并列的值本身**没有排序信息**，所以并列者之间用一个稳定散列定序 ——
 * 结果：名次是严格全序且均匀分布，既给出了确定的顺序，又不会把一圈人压在同一个半径上。
 */
export function strictRanks(items) {
  const n = items.length;
  const order = items
    .map((x, i) => ({ id: x.id, v: Number(x.v) || 0, i, t: hash01(x.id, 'act-tie') }))
    .sort((a, b) => (a.v - b.v) || (a.t - b.t) || (a.i - b.i));
  const m = new Map();
  order.forEach((x, k) => m.set(x.id, n > 1 ? k / (n - 1) : 1));
  return m;
}

/** 深厚分：ADR-0011 的合成（本项目**唯一有意为之的合成分数**，只用于线宽/颜色/透明度）。 */export function intimacyScore(pctInter, pctCooc, wInter = INTIMACY_INTER_W) {
  return wInter * (pctInter || 0) + (1 - wInter) * (pctCooc || 0);
}

/** 深厚分 → 档位（0 最浅、TIER_COUNT-1 最深）。 */
export function tierOf(score) {
  const t = Math.min(TIER_COUNT - 1, Math.max(0, Math.floor((score || 0) * TIER_COUNT - 1e-9)));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 深厚分 → 线宽。
 *
 * ⚠️ 指数**必须 > 1**（见 `LINE_W_POW` 处的教训）：`deep` 已经是百分位合成，
 * 分布集中在中段，只有幂律**拉开**才能把"少数深厚"从"多数普通"里分出来。
 * 单调性不变 ⇒ "越深越粗"仍然成立（测试断言的是单调，不是"更粗"）。
 */
export function widthOf(score) {
  const s = Math.max(0, Math.min(1, Number(score) || 0));
  return LINE_W_MIN + (LINE_W_MAX - LINE_W_MIN) * Math.pow(s, LINE_W_POW);
}

/** 深厚分 → 透明度（辅助通道；深 ≈ 0.75 → 浅 ≈ 0.10）。 */
export function alphaOf(score) {
  return 0.10 + 0.65 * Math.max(0, Math.min(1, score || 0));
}

/**
 * 星系方位：把 N 个群的中心方向铺在**球冠**上（不是整个球面）。
 *
 * ⚠️ 为什么必须限制在球冠里 —— 这是本文件最容易踩、也最难看出来的一处：
 * §2 的方向公式是 `normalize(Σ_k w_k · dir_k)`。如果两个群的方向**接近对径**
 * （夹角 ≈ 180°），两个等权的人合成出来的向量长度趋近 0，`normalize` 就是拿一个
 * 数值垃圾去做归一化 ⇒ 跨群人会被甩到一个跟数据完全无关的方向上。
 * 实测：`fibonacciDirection` 铺满整球时，n=2 的两个方向夹角 143°，
 * 五五开的人直接**落在两团之外**（与两边各差 82° / 62°）。
 *
 * 把方向限制在球冠（`cosφ ≥ SPHERE_CAP_COS`）里，任意两群的夹角就 ≤ 2·arccos(0.25) ≈ 151°，
 * 且更关键的是**所有 dir 的 z 分量都为正** ⇒ 加权和的模长有下界（不会塌到 0）。
 * 副产品是"所有星系都在同一侧"，读图时没有星系藏在别的星系正后方 —— 这是净赚。
 *
 * @param {number} i 序号（0-based）
 * @param {number} n 总数
 */
export function fibonacciDirection(i, n) {
  const N = Math.max(1, n);
  const k = i + 0.5;
  const cosPhi = Math.max(SPHERE_CAP_COS, Math.min(1, 1 - (1 - SPHERE_CAP_COS) * (k / (N + 0.5))));
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;
  return [Math.cos(theta) * sinPhi, Math.sin(theta) * sinPhi, cosPhi];
}

export function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** 以 `d` 为法线的切平面基（用于在星团内部撒点）。 */
export function tangentBasis(d) {
  const helper = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = normalize3([
    d[1] * helper[2] - d[2] * helper[1],
    d[2] * helper[0] - d[0] * helper[2],
    d[0] * helper[1] - d[1] * helper[0]
  ]);
  const t2 = [
    d[1] * t1[2] - d[2] * t1[1],
    d[2] * t1[0] - d[0] * t1[2],
    d[0] * t1[1] - d[1] * t1[0]
  ];
  return [t1, t2];
}

// ══ 形态与运动（ADR-0022）════════════════════════════════════════════════
//
// 这一节回答用户的两句话：「星系不应该是个简单的球,分布应该更凌乱一点」
// 与「只属于这个群聊的成员围绕着星系中心以不同的速度转(离中心越近越快)；
//     属于多个群的……以宇宙中心为圆心,依次经过所有自己参与过的群聊做不规则环形运动」。
//
// **为什么运动必须算在布局层**：位置从此是 `(星, 时刻)` 的函数 —— 这是"坐标"的事，
// 不是"绘制"的事。所以轨道参数（球心/轴/偏移/角速度/相位）在 `buildUniverse` 里定好，
// 绘制层每帧只调 `starWorldPos(star, t)`。于是：**t = 0 的坐标 == 静止时的坐标**
// （页面暂停 / 截图 / 测试全部看的是这一帧），运动只是它随时间的一部分。

const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 稳定散列 → 单位球面方向（**同一 id + same salt ⇒ 永远同一个方向**）。
 * salt 里 `-z` / `-a` 两个后缀与旧实现逐字一致 ⇒ 换成本函数**不改动任何已有落点**。
 */
export function unitDir(id, salt = 'u') {
  const z = hash01(id, `${salt}-z`) * 2 - 1;
  const a = hash01(id, `${salt}-a`) * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

/** 与 `d` 垂直的确定单位向量（用于"围绕这个方向转"的自转轴）。 */
export function perpAxis(d, id = '') {
  let a = unitDir(id, 'perp');
  const p = dot3(a, d);
  let v = [a[0] - d[0] * p, a[1] - d[1] * p, a[2] - d[2] * p];
  let len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-3) {                     // 退化（散列方向恰好与 d 平行）：换一个 helper 叉乘
    const h = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    v = cross3(d, h);
    len = Math.hypot(v[0], v[1], v[2]) || 1;
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

const _shapeCache = new Map();
/**
 * 一个星系的**形态帧**：自转轴 + 盘内长短轴 + 压扁 + 子团中心。
 * 全部由 `scope` 散列派生 ⇒ 确定性（同一个群每次打开形态一样），且**与成员无关**
 * （子团必须被同一群的所有人共享，否则每人一套 = 又退回均匀分布）。
 *
 * @returns {{axis:number[], p1:number[], p2:number[], elong:number, squash:number,
 *            sign:number, clumps:number[][]}}
 */
export function galaxyShape(scope) {
  const key = String(scope || '');
  const hit = _shapeCache.get(key);
  if (hit) return hit;
  const axis = unitDir(key, 'gal-spin');                       // 自转轴（盘法线）
  const e1 = normalize3(cross3(Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], axis));
  const e2 = normalize3(cross3(axis, e1));
  const rot = hash01(key, 'gal-rot') * Math.PI * 2;            // 盘内长轴指向（散列）
  const ca = Math.cos(rot), sa = Math.sin(rot);
  // 盘内正交对，绕 axis 转一个散列角 ⇒ 长短轴指向每个群不同（且仍是正交单位对）
  const p1 = [e1[0] * ca + e2[0] * sa, e1[1] * ca + e2[1] * sa, e1[2] * ca + e2[2] * sa];   // 长轴
  const p2 = [-e1[0] * sa + e2[0] * ca, -e1[1] * sa + e2[1] * ca, -e1[2] * sa + e2[2] * ca]; // 短轴
  const elong = DISK_ELONG * (0.5 + hash01(key, 'gal-elong'));
  const clumps = [];
  for (let i = 0; i < CLUMP_COUNT; i++) clumps.push(unitDir(`${key}#c${i}`, 'clump'));
  const shape = {
    axis, p1, p2, elong, squash: DISK_SQUASH,
    sign: hash01(key, 'gal-sign') < 0.5 ? 1 : -1,              // 不同群的盘转向不同（有变化才像宇宙）
    clumps
  };
  _shapeCache.set(key, shape);
  return shape;
}

/**
 * 单位方向 → **各向异性偏移**（|结果| ≤ 1 ⇒ 乘上 r 后仍在球内）。
 *   ① 子团：先朝自己那个子团中心靠（`CLUMP_PULL`）⇒ 出来是**团块**，不是均匀壳
 *   ② 各向异性：盘内长轴 ×1、短轴 ×(1−elong)、自转轴 ×squash ⇒ 出来是**扁盘**
 * ⚠️ 长轴系数取 1（不是 1+elong）是**刻意的**：这样 `|偏移| ≤ r ≤ ballR`
 *    在结构上成立 ⇒"成员落在主场球内"这条断言不会被形态改写悄悄破坏。
 */
export function shapeOffset(shape, id) {
  const u = unitDir(id, 'ball');
  const clumps = shape.clumps;
  const cl = clumps[Math.floor(hash01(id, 'clump') * clumps.length) % clumps.length];
  const b = normalize3([
    u[0] + CLUMP_PULL * cl[0],
    u[1] + CLUMP_PULL * cl[1],
    u[2] + CLUMP_PULL * cl[2]
  ]);
  const lx = dot3(b, shape.p1);
  const ly = dot3(b, shape.p2) * (1 - shape.elong);
  const lz = dot3(b, shape.axis) * shape.squash;
  return [
    shape.p1[0] * lx + shape.p2[0] * ly + shape.axis[0] * lz,
    shape.p1[1] * lx + shape.p2[1] * ly + shape.axis[1] * lz,
    shape.p1[2] * lx + shape.p2[2] * ly + shape.axis[2] * lz
  ];
}

/** 圆轨道：绕 `axis`（过 `center`）转，**t = 0 时恰好落在 `off` 处**。 */
export function circularOrbit(center, axis, off, omega, kind) {
  const par = dot3(off, axis);
  const parV = [axis[0] * par, axis[1] * par, axis[2] * par];
  const perp = [off[0] - parV[0], off[1] - parV[1], off[2] - parV[2]];
  return { kind, center, axis, par: parV, perp, w: cross3(axis, perp), omega };
}

/**
 * 跨群环的"半径 → 角度"曲线：**以各结点为核的有理核加权平均**（角度差周期化）。
 *
 * ⚠️ 不能写成归一化**高斯**混合（初版就是这么写的，实测炸了）：高斯在"离所有结点都远"的
 *    角度上会**下溢**（`exp(−(Δ/σ)²)` 在 Δ≈2.3rad 时已经 1e-10 量级）⇒ 分母趋零 ⇒
 *    `num/den` 要么崩、要么被兜底成 0 ⇒ **环半径塌成 0，星直接从宇宙中心穿过去**
 *    （实测：某跨群人一圈里有一步恰好落在原点，`minR = 0.000`）。
 *    有理核 `1/(1+(Δ/σ)²)²` 只按多项式衰减、**永不为零** ⇒ 分母恒 ≥ 1，
 *    且 `R(θ)` 恒落在「最小结点半径 ~ 最大结点半径」之间 —— 这条是**结构性**的，
 *    不是靠调参兜住的。
 */
function ringRadiusRaw(knots, th, sigma) {
  let num = 0, den = 0;
  for (const k of knots) {
    let d = th - k.theta;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const q = 1 + (d * d) / (sigma * sigma);
    const w = 1 / (q * q);
    num += k.r * w;
    den += w;
  }
  return den > 1e-12 ? num / den : 0;
}

/** 跨群环在时刻 t 的位置（**t = 0 精确等于建宇宙时用的加权平均球心**）。 */
export function bridgePosAt(o, t = 0) {
  const th = o.theta0 + o.omega * (Number(t) || 0);
  const d = th - o.theta0;                       // 抖动项以 θ0 为零点 ⇒ t=0 不打折
  const R = ringRadiusRaw(o.knots, th, o.sigma) * o.scale * (1 + o.wobR * Math.sin(o.wobM * d));
  const c = Math.cos(th), s = Math.sin(th);
  const out = o.wobOut * R * Math.sin(o.wobMo * d);
  return [
    (o.e1[0] * c + o.e2[0] * s) * R + o.outPlane[0] + o.n[0] * out,
    (o.e1[1] * c + o.e2[1] * s) * R + o.outPlane[1] + o.n[1] * out,
    (o.e1[2] * c + o.e2[2] * s) * R + o.outPlane[2] + o.n[2] * out
  ];
}

/**
 * 过原点、**最贴合这组球心**的平面法线（= 3×3 协方差的最小特征向量）。
 *
 * 为什么不能只用"最张开的那对方向叉乘"（初版）：`k ≥ 3` 时那张平面可能让第三个球心
 * 几乎落在法线方向上 ⇒ 它的**平面内投影半径被压扁**、角度挤到别处，
 * 于是"半径-角度"曲线到不了它。实测（真数据里那个参与 6 个群的人）：6 个群里只有 3 个
 * 能被经过（误差 0.75~0.96 倍半径，等于没经过）。
 * 换成本函数的**最优拟合平面**后，所有球心的出平面分量同时最小 ⇒ 误差只剩几何上
 * 单值函数无法避免的那部分（同一角度、不同半径的两个群 **数学上不可能同时经过** ——
 * 这一条写进 ADR，不假装）。
 */
export function bestFitNormal(cores) {
  const k = cores.length;
  const pts = cores.map((g) => (g.core ? g.core : g));
  if (k <= 2) {
    const b = pts[1] || pts[0];
    const c = cross3(pts[0], b);
    if (Math.hypot(c[0], c[1], c[2]) > 1e-9) return normalize3(c);
    return perpAxis(normalize3(pts[0]), 'plane-deg');
  }
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const c of pts) { xx += c[0] * c[0]; xy += c[0] * c[1]; xz += c[0] * c[2]; yy += c[1] * c[1]; yz += c[1] * c[2]; zz += c[2] * c[2]; }
  const C = [xx / k, xy / k, xz / k, xy / k, yy / k, yz / k, xz / k, yz / k, zz / k];
  const tr = C[0] + C[4] + C[8];
  // M = tr·I − C：C 的最小特征向量 = M 的最大特征向量（幂迭代；多起点防"初值恰好正交"）
  const M = [tr - C[0], -C[1], -C[2], -C[3], tr - C[4], -C[5], -C[6], -C[7], tr - C[8]];
  let best = null, bestV = -1;
  for (const s0 of [[1, 0.13, 0.37], [0.21, 1, 0.11], [0.07, 0.29, 1], [1, 1, 1]]) {
    let v = normalize3(s0), lam = 0;
    for (let i = 0; i < 48; i++) {
      const nv = [
        M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
        M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
        M[6] * v[0] + M[7] * v[1] + M[8] * v[2]
      ];
      const L = Math.hypot(nv[0], nv[1], nv[2]);
      if (!(L > 1e-12)) break;
      v = [nv[0] / L, nv[1] / L, nv[2] / L];
      lam = L;
    }
    if (lam > bestV) { bestV = lam; best = v; }
  }
  return best || perpAxis(normalize3(pts[0]), 'plane-fb');
}

/**
 * **星的时刻位置** —— 绘制层每帧唯一要调的函数。
 *
 * `t = 0` 逐位退化回"静止布局"（`dir × radius`）⇒ 暂停/截图/测试看到的都是同一帧，
 * 运动只是它在时间上的延续。三类轨道：
 *  · `galaxy`：**只属于一个群**的人 —— 绕该群的球心转，离球心越近角速度越大；
 *  · `bridge`：**跨群**的人 —— 绕宇宙中心做不规则环，依次经过自己参与过的每个群；
 *  · `drift` ：没有群属（只有私聊 / 孤儿）—— 绕宇宙中心慢慢转（不假装有归属）。
 */
export function starWorldPos(star, t = 0) {
  const o = star && star.orbit;
  if (!o) {
    const d = (star && star.dir) || [0, 0, 1];
    const r = Number(star && star.radius) || 0;
    return [d[0] * r, d[1] * r, d[2] * r];
  }
  if (o.kind === 'bridge') return bridgePosAt(o, t);
  const th = (Number(o.omega) || 0) * (Number(t) || 0);
  const c = Math.cos(th), s = Math.sin(th);
  return [
    o.center[0] + o.par[0] + o.perp[0] * c + o.w[0] * s,
    o.center[1] + o.par[1] + o.perp[1] * c + o.w[1] * s,
    o.center[2] + o.par[2] + o.perp[2] * c + o.w[2] * s
  ];
}

/**
 * 建宇宙。
 *
 * @param {object} input
 * @param {string} input.centerId   中心 = 机器人自己（占位符）
 * @param {Array<{scope:string, kind:string, messages:number}>} input.scopes  会话清单
 * @param {Array<{id:string, cooc:number, inter:number, byScope:object}>} input.spokes
 *        中心 ↔ 每个人的边（**未剪枝**：它是全图的骨架，剪枝会让"只共现的人"整个消失）
 * @param {Array<{a:string, b:string, cooc:number, inter:number, byScope:object}>} input.chords
 *        人 ↔ 人的边（已剪枝，即"看得懂的那部分"）
 * @param {object} [input.opts]
 * @returns {object} `{center, galaxies, stars, chords, stats}`
 */
export function buildUniverse(input = {}) {
  const centerId = String(input.centerId || '');
  const scopes = (input.scopes || []).filter((s) => s && s.scope);
  const spokes = (input.spokes || []).filter((s) => s && s.id && s.id !== centerId);
  const chordsIn = (input.chords || []).filter((e) => e && e.a && e.b);

  // ── ① 星系（= 群）：方向 + **球**（ADR-0017）─────────────────────────────
  // 私聊**不占方位**（ADR-0012 §1：它是贴中心的内环），所以只把群铺在球面上。
  // 球的三件套：`dir`（方向，斐波那契铺开）/ `coreR`（球心距离 = 群亲疏排名）/ `ballR`（∝ ∛成员数）。
  const groups = scopes.filter((s) => s.kind === 'group')
    .slice()
    .sort((a, b) => (Number(b.messages) || 0) - (Number(a.messages) || 0) || (a.scope < b.scope ? -1 : 1));
  const totalW = groups.reduce((n, g) => n + Math.pow(Math.max(1, Number(g.messages) || 0), SECTOR_SOFTEN), 0) || 1;
  // 球心距离的排名刻度：按消息量的**百分位**（与别处的 strictRanks 同一纪律 ——
  // 并列给并列名次，不许把 20 个同规模群挤成 20 个不同的距离）。
  const coreRank = strictRanks(groups.map((g) => ({ id: g.scope, v: Math.max(1, Number(g.messages) || 0) })));
  const galaxies = groups.map((g, i) => {
    const w = Math.pow(Math.max(1, Number(g.messages) || 0), SECTOR_SOFTEN);
    const share = w / totalW;
    const dir = fibonacciDirection(i, groups.length);
    const rank01 = coreRank.get(g.scope) ?? 0;              // 1 = 消息量最大的群
    const coreR = CORE_R_MIN + (1 - rank01) * (CORE_R_MAX - CORE_R_MIN);
    // 球半径 ∝ ∛**成员数**（该群里说过的不同人数，`edges.mjs` 的 `speakers`）。
    // 没带 members（旧图数据）⇒ 回退用消息量的立方根当代理 —— 不准，但保住"大群大球"的方向。
    const rawMembers = Number(g.members);
    const members = rawMembers > 0 ? rawMembers : Math.max(1, Math.cbrt(Number(g.messages) || 1));
    const ballR = BALL_K * Math.cbrt(members);
    return {
      scope: g.scope,
      kind: 'group',
      messages: Number(g.messages) || 0,
      share,
      dir,                                                  // 方向保留（聚焦/标签仍用它）
      coreR,                                                // 球心距离
      ballR,                                                // 球半径
      core: [dir[0] * coreR, dir[1] * coreR, dir[2] * coreR],
      shape: galaxyShape(g.scope),                          // 形态帧（ADR-0022：压扁盘 + 子团 + 自转轴）
      colorIndex: i
    };
  });
  const galaxyByScope = new Map(galaxies.map((g) => [g.scope, g]));
  const privateScopes = scopes.filter((s) => s.kind !== 'group').map((s) => s.scope);
  const privateSet = new Set(privateScopes);

  /** 群权重：他在群 k 里与她的共现。私聊不计入（方向不来自私聊）。
   *  ADR-0017：混合的不再是**方向**而是**球心** —— 返回的就是一个空间点。 */
  const galaxyWeights = (byScope) => {
    const acc = [0, 0, 0];
    let total = 0;
    let domBallR = 0;
    let domCoreR = 0;
    const perGalaxy = [];
    for (const [scope, v] of Object.entries(byScope || {})) {
      const g = galaxyByScope.get(scope);
      if (!g) continue;
      const w = Number(v?.cooccurrence?.normalized) || 0;
      if (!(w > 0)) continue;
      acc[0] += w * g.core[0]; acc[1] += w * g.core[1]; acc[2] += w * g.core[2];
      total += w;
      perGalaxy.push({ scope, weight: w });
    }
    if (!(total > 0)) return { center: null, perGalaxy: [], total: 0, dominant: null, domBallR: 0 };
    perGalaxy.sort((x, y) => (y.weight - x.weight) || (x.scope < y.scope ? -1 : 1));
    const dom = galaxyByScope.get(perGalaxy[0].scope);
    return {
      center: [acc[0] / total, acc[1] / total, acc[2] / total],   // 加权平均**点**（不是方向）
      perGalaxy, total,
      dominant: perGalaxy[0].scope,
      domBallR: dom ? dom.ballR : 0
    };
  };

  /**
   * 球内落点（ADR-0022，改写 ADR-0017 的"各向同性球"）。
   *
   * 位置 = 混合球心 + **各向异性、带子团、带径向抖动**的偏移：
   *   · 偏移长度 = domBallR × ratio × radial(depth) × (1 ± RADIAL_JITTER)
   *       - `radial(depth) = IN_BALL_R_MIN + (1 − depth)·(1 − IN_BALL_R_MIN)`
   *         ⇒ **球内径向 = 亲疏**（越熟越靠球心；ADR-0017 的原意，原样保留）
   *       - `× ratio`（主场占比）：五五开的桥偏移只有一半 ⇒ 落在两球心连线**之间**
   *       - `× 抖动`：`radial` 只依赖深度 ⇒ 同深度的人全落在同一个半径上 = **同心壳**；
   *         抖动把壳打散（用户："分布应该更凌乱一点"）
   *   · 偏移方向 = `shapeOffset()`（盘内长短轴 + 自转轴压扁 + 子团）
   *       —— **不再是**单位球面均匀方向：那正是"简单的球"的来源
   *   · 上限硬夹在 `domBallR`：形态只允许改**形状**，不允许把成员推出球外
   *
   * @returns {{core:number[], shape:object, off:number[], radius:number}|null} 无球可归 ⇒ null
   */
  const memberOffset = (gw, depth, ratio, id, opts = {}) => {
    if (!gw.center) return null;
    const gal = galaxyByScope.get(gw.dominant);
    const shape = gal ? gal.shape : galaxyShape(String(gw.dominant || ''));
    const radial = opts.mid ? 0.5 : (IN_BALL_R_MIN + (1 - Math.max(0, Math.min(1, depth))) * (1 - IN_BALL_R_MIN));
    const jit = 1 + RADIAL_JITTER * 2 * (hash01(id, 'radial-jit') - 0.5);
    const r = Math.min(gw.domBallR, gw.domBallR * Math.max(0, Math.min(1, ratio)) * radial * jit);
    const d = shapeOffset(shape, id);
    return {
      core: gal ? gal.core : gw.center,
      shape,
      off: [d[0] * r, d[1] * r, d[2] * r],
      radius: r
    };
  };

  /** 每颗星的自转轴 = 星系轴 + 扰动（见 `AXIS_JITTER`：不加扰动 ⇒ 几分钟后形态被公转磨成规则环）。 */
  const galaxyAxisJit = (id, baseAxis) => normalize3([
    baseAxis[0] + AXIS_JITTER * (hash01(id, 'axis-x') * 2 - 1),
    baseAxis[1] + AXIS_JITTER * (hash01(id, 'axis-y') * 2 - 1),
    baseAxis[2] + AXIS_JITTER * (hash01(id, 'axis-z') * 2 - 1)
  ]);

  /** 无群属者的慢转：绕宇宙中心，轨道面过它自己（不假装它属于哪个群）。 */
  const driftOrbit = (pos, id) => {
    const mag = Math.hypot(pos[0], pos[1], pos[2]) || 1e-9;
    const axis = perpAxis([pos[0] / mag, pos[1] / mag, pos[2] / mag], id);
    const sign = hash01(id, 'drift-dir') < 0.5 ? 1 : -1;
    return circularOrbit([0, 0, 0], axis, pos, sign * (DRIFT_OMEGA + DRIFT_OMEGA_SPAN * hash01(id, 'drift-omega')), 'drift');
  };

  /**
   * **跨群环**（用户："以宇宙中心为圆心,依次经过所有自己参与过的群聊做不规则环形运动"）。
   *
   * 三步：① 取一张过**原点**、且尽量含住所有相关球心的平面（最张开的那对方向叉乘）；
   * ② 每个球心投影成极坐标 `(θ_i, r_i)` 当**结点**；③ 环半径写成
   * **以结点为核的有理核加权** `R(θ)` ⇒ 扫到 `θ_i` 时半径≈`r_i`
   * ⇒ **依次经过每一个自己参与过的群**，而不是随便画个圆。
   *
   * ⚠️ 起点必须**精确**：结点里额外塞进"加权平均球心"这一项，并把整条曲线按
   *    `r0 / R(θ0)` 缩放 ⇒ `t = 0` 时位置**逐位等于** ADR-0012 §2 那个加权平均点。
   *    否则"暂停"那一帧的布局就与旧版不同了（截图/测试看的就是那一帧）。
   */
  const bridgeOrbit = (gw, id) => {
    const cores = gw.perGalaxy.map((p) => galaxyByScope.get(p.scope)).filter(Boolean);
    const ref = cores.length ? cores : [{ core: gw.center }];
    const n = bestFitNormal(ref);          // 过原点、最贴合这组球心的平面（见 bestFitNormal 的教训）
    const e1 = normalize3(ref[0].core);
    const e2 = normalize3(cross3(n, e1));
    const avg = gw.center;
    const nAvg = dot3(avg, n);
    const outPlane = [n[0] * nAvg, n[1] * nAvg, n[2] * nAvg];   // 均值的出平面分量（k=2 时恒为 0）
    const inPlane = [avg[0] - outPlane[0], avg[1] - outPlane[1], avg[2] - outPlane[2]];
    const theta0 = Math.atan2(dot3(inPlane, e2), dot3(inPlane, e1));
    const r0 = Math.hypot(inPlane[0], inPlane[1], inPlane[2]);
    const knots = [{ theta: theta0, r: r0 }];
    for (const g of ref) {
      const x = dot3(g.core, e1), y = dot3(g.core, e2);
      knots.push({ theta: Math.atan2(y, x), r: Math.hypot(x, y) });
    }
    const raw0 = ringRadiusRaw(knots, theta0, BRIDGE_KNOT_SIGMA);
    return {
      kind: 'bridge', e1, e2, n, outPlane, knots, sigma: BRIDGE_KNOT_SIGMA,
      scale: raw0 > 1e-9 ? r0 / raw0 : 1, theta0,
      omega: (BRIDGE_OMEGA + BRIDGE_OMEGA_SPAN * hash01(id, 'bridge-omega'))
        * (hash01(id, 'bridge-dir') < 0.5 ? 1 : -1),
      wobR: BRIDGE_WOBBLE_R * (0.4 + hash01(id, 'wob-r')),
      wobM: 2 + Math.round(hash01(id, 'wob-m')),
      wobOut: BRIDGE_WOBBLE_OUT * (0.4 + hash01(id, 'wob-o')),
      wobMo: 1 + Math.round(hash01(id, 'wob-mo'))
    };
  };

  /** 一颗星的落点 + 轨道：单群**自转** / 跨群**公转** / 无群**慢转**。 */
  const placementFor = (id, gw, depth, ratio, opts = {}) => {
    if (!gw.center) {
      const d = unitDir(id, 'fb');
      const pos = [d[0] * FALLBACK_R, d[1] * FALLBACK_R, d[2] * FALLBACK_R];
      return { pos, orbit: driftOrbit(pos, id) };
    }
    if (gw.perGalaxy.length >= 2) {
      const orbit = bridgeOrbit(gw, id);
      return { pos: bridgePosAt(orbit, 0), orbit };      // t=0 = 加权平均球心（ADR-0012 §2 同口径）
    }
    const m = memberOffset(gw, depth, ratio, id, opts);
    const pos = [gw.center[0] + m.off[0], gw.center[1] + m.off[1], gw.center[2] + m.off[2]];
    const axis = galaxyAxisJit(id, m.shape.axis);
    const rho = gw.domBallR > 0 ? m.radius / gw.domBallR : 0;
    const orbit = circularOrbit(m.core, axis, m.off, orbitOmega(rho) * (m.shape.sign || 1), 'galaxy');
    return { pos, orbit };
  };

  // ── ② 每个人的深度（与她的关系深度）→ **球内**径向（ADR-0017）───────────
  // 0.26.0（ADR-0040）：输入从百分位换成**绝对量的对数饱和**（见 saturate 处的论证）。
  // raw 缺失时退化为 0 —— 不假装（后端 edges.mjs 恒带 raw；缺了是载荷坏了，宁可全浅）。
  const spokeCoocSat = spokes.map((s) => saturate(s.coocRaw, DEPTH_SAT_COO));
  const spokeInterSat = spokes.map((s) => saturate(s.interRaw, DEPTH_SAT_INTER));

  /** @type {Map<string, object>} */
  const stars = new Map();
  spokes.forEach((s, i) => {
    const depth = intimacyScore(spokeInterSat[i], spokeCoocSat[i]);
    const gw = galaxyWeights(s.byScope);
    const ratio = gw.total > 0 ? gw.perGalaxy[0].weight / gw.total : 0;
    const onlyPrivate = !gw.perGalaxy.length && Object.keys(s.byScope || {}).some((k) => privateSet.has(k));
    let placed;
    if (onlyPrivate) {
      // 内环：只有私聊 ⇒ 贴中心的一段带（ADR-0012 §1 不变）
      const d = unitDir(s.id, 'fb');
      const r = R_INNER_MIN + (1 - Math.max(0, Math.min(1, depth))) * (R_INNER_MAX - R_INNER_MIN);
      const pos = [d[0] * r, d[1] * r, d[2] * r];
      placed = { pos, orbit: driftOrbit(pos, s.id) };
    } else {
      placed = placementFor(s.id, gw, depth, ratio);
    }
    const pos = placed.pos;
    const mag = Math.hypot(pos[0], pos[1], pos[2]) || 1e-9;
    stars.set(s.id, {
      id: s.id,
      dir: [pos[0] / mag, pos[1] / mag, pos[2] / mag],
      radius: mag,
      orbit: placed.orbit,
      depth,
      degree: 0,
      coocSelf: Number(s.cooc) || 0,
      interSelf: Number(s.inter) || 0,
      selfCoocSat: spokeCoocSat[i],
      selfInterSat: spokeInterSat[i],
      galaxies: gw.perGalaxy,
      dominant: gw.dominant,
      inner: onlyPrivate,   // 只有私聊 ⇒ 内环
      touchedCenter: true
    });
  });

  // ── ③ 弦：人 ↔ 人（已剪枝的那份）────────────────────────────────────
  const chordCoocSat = chordsIn.map((e) => saturate(e.coocRaw, DEPTH_SAT_COO));
  const chordInterSat = chordsIn.map((e) => saturate(e.interRaw, DEPTH_SAT_INTER));
  const chords = chordsIn.map((e, i) => {
    const score = intimacyScore(chordInterSat[i], chordCoocSat[i]);
    return {
      a: e.a, b: e.b,
      cooc: Number(e.cooc) || 0,
      inter: Number(e.inter) || 0,
      score,
      tier: tierOf(score),
      width: widthOf(score),
      alpha: alphaOf(score),
      dashed: !(Number(e.inter) > 0),   // 虚实表**性质**，不表强度（ADR-0012 §8）
      byScope: e.byScope || {}
    };
  });

  // 弦拉进来的、没跟中心直接同框过的人：仍然要有一颗星（否则弦会指向虚空）。
  // ⚠️ 两趟：先把**这个人全部弦**的 per-scope 合起来，再定方向。
  //    第一版是"碰上第一条弦就用它的 by_scope"，那等于让边的遍历顺序决定一颗星站哪 ——
  //    看起来正常，实际上位置是随机的（正是本项目最怕的那类"看起来在工作"）。
  const orphans = new Map();
  for (const e of chords) {
    for (const id of [e.a, e.b]) {
      const known = stars.get(id);
      if (known) { known.degree++; continue; }   // 与中心有边的人：弦数照常累计
      if (id === centerId) continue;
      let o = orphans.get(id);
      if (!o) { o = { byScope: {}, degree: 0 }; orphans.set(id, o); }
      o.degree++;
      for (const [scope, v] of Object.entries(e.byScope || {})) {
        const cur = o.byScope[scope] || { cooccurrence: { normalized: 0 }, interaction: { normalized: 0 } };
        cur.cooccurrence.normalized += Number(v?.cooccurrence?.normalized) || 0;
        cur.interaction.normalized += Number(v?.interaction?.normalized) || 0;
        o.byScope[scope] = cur;
      }
    }
  }
  for (const [id, o] of orphans) {
    const gw = galaxyWeights(o.byScope);
    const ratio = gw.total > 0 ? gw.perGalaxy[0].weight / gw.total : 0;
    // 孤儿：与她的深度**未知**（从未和她在同一时间桶里出现）⇒ `mid`：不假装深浅，偏移取中带。
    const placed = placementFor(id, gw, 0, ratio, { mid: true });
    const pos = placed.pos;
    const mag = Math.hypot(pos[0], pos[1], pos[2]) || 1e-9;
    stars.set(id, {
      id,
      dir: [pos[0] / mag, pos[1] / mag, pos[2] / mag],
      radius: mag,
      orbit: placed.orbit,
      // 与她的深度**未知** ⇒ 标 `depthUnknown`。不猜、也不假装他们"关系远"（"没同框" ≠ "不熟"）。
      depth: 0,
      depthUnknown: true,
      degree: o.degree,
      coocSelf: 0,
      interSelf: 0,
      selfCoocSat: 0,
      selfInterSat: 0,
      galaxies: gw.perGalaxy,
      dominant: gw.dominant,
      inner: false,
      touchedCenter: false
    });
  }

  const starList = [...stars.values()].sort((x, y) => (y.depth - x.depth) || (x.id < y.id ? -1 : 1));
  // 世界空间最近邻间距中位 —— 「可分辨度」的那个分子（ADR-0014）。**建宇宙时算一次**，
  // 绘制层每帧只需乘当前屏幕比例，不必每帧 O(n²)。
  const nnSep = worldNNSep(starList.map((s) => [s.dir[0] * s.radius, s.dir[1] * s.radius, s.dir[2] * s.radius]));
  // 世界直径（含中心到最远星）：屏幕尺寸通道（ADR-0018 的 chordFloor）的锚 ——
  // 建宇宙时算一次，绘制层乘屏幕比例即得"宇宙在屏幕上多少像素"。
  const worldRadius = starList.reduce((m, s) => Math.max(m, s.radius), 0);
  return {
    center: { id: centerId, dir: [0, 0, 1] },
    galaxies,
    stars: starList,
    chords,
    stats: {
      galaxies: galaxies.length,
      privateScopes: privateScopes.length,
      stars: starList.length,
      chords: chords.length,
      innerStars: starList.filter((s) => s.inner).length,
      orphanStars: starList.filter((s) => !s.touchedCenter).length,
      worldNNSep: nnSep,
      worldSpan: 2 * worldRadius
    }
  };
}

/** 没进任何已知群的人：给一个确定性的方向（不与任何星系重叠优先，但仍可能落在边缘）。 */
function fallbackDirection(id) {
  const a = hash01(id, 'fb-a') * Math.PI * 2;
  const z = hash01(id, 'fb-z') * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

// ── 相机与投影（ADR-0012 §5：Canvas 2D + 自写投影矩阵）────────────────────

/**
 * 世界 → 相机：先绕 Y 轴转 yaw，再绕 X 轴转 pitch。
 * @returns {number[]} 3×3 行主序矩阵
 */
export function rotationMatrix(yaw, pitch) {
  const cy = Math.cos(yaw); const sy = Math.sin(yaw);
  const cp = Math.cos(pitch); const sp = Math.sin(pitch);
  return [
    cy, 0, sy,
    sp * sy, cp, -sp * cy,
    -cp * sy, sp, cp * cy
  ];
}

export function applyRotation(p, m) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2]
  ];
}

/**
 * 透视投影。
 * @param {number[]} p  相机空间点
 * @param {{width:number,height:number,zoom:number,camDist?:number}} view
 * @returns {{x:number,y:number,z:number,scale:number,visible:boolean}}
 */
export function project(p, view) {
  const camDist = Number(view.camDist) > 1 ? Number(view.camDist) : 3.2;
  const zc = camDist - p[2];
  const focal = Math.min(view.width, view.height) * 0.5 * (Number(view.zoom) || 1);
  if (zc <= 0.05) return { x: 0, y: 0, z: p[2], scale: 0, visible: false };
  const s = focal / zc;
  return {
    x: view.width / 2 + p[0] * s,
    y: view.height / 2 - p[1] * s,
    z: p[2],
    scale: s,
    visible: true
  };
}

/**
 * 命中测试：屏幕上离指针最近、且在手感半径内的星。
 * @param {Array<{star:object, screen:object}>} projected
 * @param {number} x @param {number} y @param {number} [pad]
 */
export function hitTest(projected, x, y, pad = 6) {
  let best = null;
  let bestD = Infinity;
  for (const item of projected) {
    if (!item?.screen?.visible) continue;
    const r = Math.max(4, (item.radiusPx || 3) + pad);
    const d = Math.hypot(item.screen.x - x, item.screen.y - y);
    if (d <= r && d < bestD) { bestD = d; best = item; }
  }
  return best;
}

// ── 标签避让（纯函数，ADR-0012 §9.6）────────────────────────────────────────
//
// 为什么在这里、而不是在画布那层：星图的世界半径上限只有 1，投影后中心密集区里
// 几十颗星挤在几十像素内 —— **不避让的话名字必然糊成一团**，而那正是用户最初的
// 原话（"都看不出来谁是谁"）。避让是纯粹的几何判定（矩形相交），跟 Canvas 毫无关系，
// 所以放在纯函数层：既能被测试证明，也能被静态预览复用（两边不会各写一套）。
//
// 规则（贪心，确定性）：
//   ① 顺序 = 钉住的优先（选中/悬停/星系核地标）→ 深度降序 → 原下标（保证稳定）
//   ② 放不下就跳过；**钉住的无条件画**（用户明确指出要看的人，重叠也要让他看见）
//   ③ `max` 只截断"非钉住"的那批（钉住的不计入上限）
//   ④ `occupied` 是调用方给的**已占位**（星系核的名字先占），只挡、不画

/**
 * @param {Array<{x:number,y:number,width:number,pinned?:boolean,depth?:number,[k:string]:any}>} items
 * @param {{max?:number,height?:number,occupied?:Array<{x0:number,x1:number,y0:number,y1:number}>}} [opts]
 * @returns {Array<object>} 保序（按 ① 的顺序）的、已避让的一批；每个元素多一个 `box`
 */
export function placeLabels(items, opts = {}) {
  const max = Number.isFinite(opts.max) ? Number(opts.max) : 28;
  const h = Number.isFinite(opts.height) ? Number(opts.height) : 14;
  const boxes = (opts.occupied || []).map((b) => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }));
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) =>
      (Number(!!b.it.pinned) - Number(!!a.it.pinned))
      || ((Number(b.it.depth) || 0) - (Number(a.it.depth) || 0))
      || (a.i - b.i));
  const out = [];
  let loose = 0;
  for (const { it } of order) {
    const pinned = !!it.pinned;
    if (!pinned && loose >= max) continue;
    const w = Number(it.width) || 0;
    const box = { x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - h, y1: it.y };
    const clash = boxes.some((r) => box.x1 > r.x0 && box.x0 < r.x1 && box.y1 > r.y0 && box.y0 < r.y1);
    if (clash && !pinned) continue;
    boxes.push(box);
    if (!pinned) loose++;
    out.push({ ...it, box });
  }
  return out;
}

// ── 尺度法则与可分辨度（ADR-0014）──────────────────────────────────────────
//
// 用户的两句话是这一节的立项理由：
//   ①「比例尺越大，那些都看起来相应的更细才对」—— 旧式半径 ∝ zoom，与间距同比例，
//      于是半径/间距是**不变量**：滚轮放大时重叠比一秒都没变（实测恒为 2.93）。
//   ②「要做好这种超大型千人群聊下的准备，防止因此就全部糊作一团」。
//
// 病根不在"点太大"，而在**没有任何一个量在表达"现在能不能分辨个体"**。所以引入一个：
//
//     可分辨度 `res = 屏幕最近邻间距 ÷ 星点半径`
//
// 半径与缩放脱钩之后 `res ∝ zoom ÷ √人数` ⇒ **人数翻四倍，云自动提前一半倍率出现**，
// 不需要为千人群手调任何阈值。它同时驱动三件事（个体显隐 / 弦分档渐显 / 整体压淡），
// **一个旋钮、三处同步**，不会互相打架。

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 经典 smoothstep：`x ≤ a` ⇒ 0，`x ≥ b` ⇒ 1，中间是 C¹ 连续的 S 曲线。 */
export function smoothstep(x, a, b) {
  const t = clamp01((Number(x) - a) / ((b - a) || 1e-9));
  return t * t * (3 - 2 * t);
}

function medianOf(values) {
  const n = values.length;
  if (!n) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = n >> 1;
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 星点屏幕半径 —— **只由深度决定，与缩放无关**（ADR-0014 §1）。
 * 这一条就是用户那句"比例尺越大越细"的可证形式：zoom 不再出现在这个函数里。
 */
export function starRadiusPx(depth) {
  return STAR_R_MIN + (STAR_R_MAX - STAR_R_MIN) * Math.pow(clamp01(depth), STAR_R_POW);
}

/**
 * 世界空间**最近邻间距的中位数**（网格加速，O(n·环)）。
 *
 * 为什么用中位数而不是平均/最小：平均会被几条离群大间距抬走；最小反映的是"最挤的那一对"，
 * 会让整幅图按最坏点降级。中位数才是"典型间距"——正是可分辨度该用的量。
 * ⚠️ 它是个**代表值**：中心区比它挤、外圈比它疏。阈值因此是标定值，不是推导出来的。
 *
 * @param {Array<number[]>} points 世界坐标
 * @param {{cell?:number}} [opts]  网格边长（默认按点数自适应）
 */
export function worldNNSep(points, opts = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));
  const n = pts.length;
  if (n < 2) return 0;
  const h = Number(opts.cell) > 0 ? Number(opts.cell) : Math.max(0.04, 2.4 / Math.max(2, Math.cbrt(n) * 3));
  const grid = new Map();
  const key = (i, j, k) => `${i}|${j}|${k}`;
  const cellOf = (p) => [Math.floor(p[0] / h), Math.floor(p[1] / h), Math.floor(p[2] / h)];
  for (let idx = 0; idx < n; idx++) {
    const [i, j, k] = cellOf(pts[idx]);
    const kk = key(i, j, k);
    let a = grid.get(kk);
    if (!a) { a = []; grid.set(kk, a); }
    a.push(idx);
  }
  const nn = new Array(n).fill(Infinity);
  for (let idx = 0; idx < n; idx++) {
    const p = pts[idx];
    const [i0, j0, k0] = cellOf(p);
    let best = Infinity;
    for (let ring = 0; ring <= 6; ring++) {
      for (let i = i0 - ring; i <= i0 + ring; i++) {
        for (let j = j0 - ring; j <= j0 + ring; j++) {
          for (let k = k0 - ring; k <= k0 + ring; k++) {
            if (ring > 0 && Math.max(Math.abs(i - i0), Math.abs(j - j0), Math.abs(k - k0)) !== ring) continue;
            const a = grid.get(key(i, j, k));
            if (!a) continue;
            for (const t of a) {
              if (t === idx) continue;
              const d = Math.hypot(pts[t][0] - p[0], pts[t][1] - p[1], pts[t][2] - p[2]);
              if (d < best) best = d;
            }
          }
        }
      }
      if (best < ring * h) break;   // 已找到比"再往外一环的最小可能距离"更近的 ⇒ 不可能更近
    }
    nn[idx] = best === Infinity ? h : best;
  }
  return medianOf(nn);
}

/**
 * 可分辨度 = 屏幕最近邻间距 ÷ 星点半径。
 * @param {number} sepWorld   世界空间最近邻间距中位（`universe.stats.worldNNSep`）
 * @param {number} screenScale 当前屏幕比例（≈ min(W,H)·0.5·zoom / camDist）
 * @param {number} radiusPx   当前星点半径
 */
export function resolvability(sepWorld, screenScale, radiusPx) {
  const r = Math.max(1e-6, Number(radiusPx) || 0);
  return Math.max(0, (Number(sepWorld) || 0) * (Number(screenScale) || 0)) / r;
}

/**
 * 个体化策略：把**一个**可分辨度摊成整套视觉参数（ADR-0014 §2）。
 *
 * 关键纪律：**全部是三处连续的**（`t` 是 smoothstep，其余都是它的线性/多项式组合），
 * 所以没有 LOD 跳变 —— 放大时云是**涨潮一样散开**，不会"啊地一下"冒出星星。
 *
 * @param {number} res 可分辨度
 * @param {{merged?:number, separated?:number, spacingPx?:number}} [opts]
 *        `spacingPx` = 屏幕上典型的邻居间距（`worldNNSep × screenScale`）；给了它，
 *        远景光晕就按"相邻光晕相接"来定大小（人数变多 ⇒ 自动收细，云的手感不变）。
 * @returns {{res:number,t:number,individuation:number,nebulaInk:number,
 *            cloudAlpha:(d:number)=>number, brightAlpha:(d:number)=>number,
 *            starAlpha:(d:number)=>number, glowMul:(a:number,rPx?:number)=>number,
 *            chordAlphaFactor:(tier:number)=>number, gates:number[]}}
 */
export function individuationPolicy(res, opts = {}) {
  const r0 = Number.isFinite(opts.merged) ? opts.merged : RES_MERGED;
  const r1 = Math.max(r0 + 1e-6, Number.isFinite(opts.separated) ? opts.separated : RES_SEPARATED);
  const t = smoothstep(Number(res) || 0, r0, r1);

  // 远景（t=0）：尘埃基底 + 长尾剖面 ⇒ 叠起来就是星云；最深那批自己浮在上面。
  const cloudAlpha = (depth) => CLOUD_ALPHA_MIN + CLOUD_ALPHA_SPAN * Math.pow(clamp01(depth), CLOUD_ALPHA_POW);
  // 近景（t=1）：每颗都看得见，但浅星仍比深星淡（否则一片纯白，深度读不出来）。
  const brightAlpha = (depth) => BRIGHT_ALPHA_MIN + (1 - BRIGHT_ALPHA_MIN) * clamp01(depth);
  const starAlpha = (depth) => {
    const c = cloudAlpha(depth); const b = brightAlpha(depth);
    return c + (b - c) * t;
  };
  // 光晕倍数跟着**亮度**走，且**远景大、近景紧**（由同一个 t 插值）——
  // 远景的光晕就是那片云的材质，近景的光晕会糊掉个体，两者要求正好相反。
  // 远景大小：优先按"邻居间距 × K"（自适应），拿不到间距才退回固定倍数。
  const spacingPx = Number(opts.spacingPx);
  const glowMul = (alpha, radiusPx) => {
    const a = clamp01(alpha);
    const near = GLOW_NEAR_MIN + GLOW_NEAR_SPAN * a;
    let far;
    if (spacingPx > 0) {
      const rPx = Math.max(0.35, Number(radiusPx) || starRadiusPx(0.5));
      far = (spacingPx * GLOW_FAR_SPACING_K * (GLOW_FAR_ALPHA_LO + GLOW_FAR_ALPHA_SPAN * a)) / rPx;
    } else {
      far = GLOW_FAR_FALLBACK + GLOW_FAR_FALLBACK_SPAN * a;
    }
    return far + (near - far) * t;
  };

  // 弦的三档渐显：浅档最后出现；深档永远留骨架（CHORD_DEEP_KEEP）。
  const gates = [
    CHORD_TIER_CEIL[0] * smoothstep(t, 0.55, 0.95),
    CHORD_TIER_CEIL[1] * smoothstep(t, 0.30, 0.70),
    CHORD_DEEP_KEEP + (CHORD_TIER_CEIL[2] - CHORD_DEEP_KEEP) * smoothstep(t, 0.0, 0.45)
  ];
  const dim = CHORD_DIM_MIN + (1 - CHORD_DIM_MIN) * t;
  const chordAlphaFactor = (tier) => {
    const i = Math.max(0, Math.min(gates.length - 1, Math.round(Number(tier) || 0)));
    return gates[i] * dim;
  };

  // 弦的**屏幕尺寸通道**（ADR-0018 —— 用户 #8："缩到一定程度浅的应该几乎看不见"）。
  // 锚是**宇宙包围盒的像素直径**（spanPx）对**画布高**的比值 —— res 通道在 0.4×~3.4× 恒 t=0
  // （间距 ÷ 星点半径在小倍率下不变），只有屏幕绝对尺寸在这段倍率里真的在变。
  //   · spanPx ≥ H/4：档位照旧（res 通道管）
  //   · H/8 ≤ spanPx < H/4：只留深档（浅/中退场）
  //   · spanPx < H/8：弦**全退**，只剩星云（星系核 + 雾）—— 最远观感就是一张星团照片
  const spanPx = Number(opts.spanPx) || 0;
  const canvasH = Number(opts.canvasH) || 0;
  let chordFloor = 0;
  if (spanPx > 0 && canvasH > 0) {
    if (spanPx < canvasH / 8) chordFloor = gates.length;
    else if (spanPx < canvasH / 4) chordFloor = gates.length - 1;
  }

  return { res: Number(res) || 0, t, individuation: t, nebulaInk: 1 - t, cloudAlpha, brightAlpha, starAlpha, glowMul, chordAlphaFactor, gates, chordFloor };
}

/**
 * 点是否在视口矩形内（含外扩）。星点、星系核、标签、以及**线的端点**都先过这一关。
 *
 * 为什么线的端点也要过：高倍率下大部分星在画布之外。Canvas / SVG 只把图形裁到视口，
 * 于是**两端都在画布外、只是"路过"画面的弦照样会在视口里留下一条长痕** ——
 * 实测 8× 时这些"过路弦"把画面糊成一片，看着像布局坏了，其实布局是对的。
 * 规则：**两端都看不见 ⇒ 不画**（一条没有可见端点的线，读不出是谁跟谁）。
 */
export function pointInRect(x, y, r) {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/**
 * 辐条的可见度 —— 由**那个人自己的亮度**决定（ADR-0014 §2 的第四处同步）。
 *
 * 与弦不同，辐条没有"深厚档"可分级（她与每个人只有**一条**边，强就是强），
 * 所以它不能按档渐显。可用作旋钮的只有"那个人此刻显不显眼"：
 * 远景 ⇒ 只有浮出尘埃的那几十人有辐条，其余并入云；近景 ⇒ 人人都有，深星更实。
 * 这同时解决了"上千人时辐条全汇于一点"这个**唯一会随人数线性恶化**的糊源
 * （其余量都已随人数自适应）。
 *
 * @param {number} starAlpha 该星当前的绘制亮度（`policy.starAlpha(depth)`）
 * @param {{max?:number, lo?:number, hi?:number}} [opts]
 */
export function spokeAlpha(starAlpha, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : SPOKE_ALPHA_MAX;
  const lo = Number.isFinite(opts.lo) ? opts.lo : SPOKE_STAR_LO;
  const hi = Number.isFinite(opts.hi) ? opts.hi : SPOKE_STAR_HI;
  return max * smoothstep(Number(starAlpha) || 0, lo, Math.max(lo + 1e-6, hi));
}

// ── 线的墨量守恒（ADR-0014 §5）─────────────────────────────────────────────
// 星点脱钩之后线的问题**正好相反**：线宽恒定、而线长 ∝ 倍率 ⇒
//   局部墨量 ∝ 线长/面积 × 线宽 × 透明度 ∝ 倍率
// 实测（1280×860，真数据）：2.5× 局部覆盖中位 0.11 → 8× 0.77，p90 从 2.4 涨到 25.7
// ⇒ **放大反而更像一团**，与"比例尺越大越细"正好相反。
// 守恒条件：`线宽 × 透明度 ∝ 1/倍率`。两边各分一半（各 ∝ 1/√倍率），于是：
//   · 线宽随放大收细 —— 这就是用户那句"比例尺越大，那些都看起来相应的更细"的直接落实
//   · 局部墨量与倍率无关 ⇒ 放大只让结构**散开**，不会让画面越看越糊
// 基准倍率取默认视角（2.5×）：在那里线宽/透明度就是深厚分给出的原值。
export const LINE_ZOOM_REF = 2.5;
// ⚠️ 下限很低（0.10）：**缩小也要能变细**（ADR-0018 —— 用户拍板"分两层退 + 继续变细"）。
//    0.4× 时 zoom/REF = 0.16，0.10 的下限不挡它；它的职责只是兜住极端数值。
export const LINE_SCALE_MIN = 0.10;
// ⚠️ 上限**恒为 1**：线**绝不随缩小变粗**。
//    曾经的 1.6 是个自相矛盾的设置 —— 缩小六倍时把线加粗 1.6 倍，整个骨架被压进几十像素里，
//    实测 0.4× 的局部墨量 p90 冲到 **66**（比默认视角高 26 倍），糊成一块实心。
//    （后来查明 MAX=1.0 还把"缩小时变细"也一并关掉了 —— 一个上限同时管住了方向相反的两种需求；
//      ADR-0018 把"变细"从公式里接回来，MAX 仍然只负责挡"变粗"。）
export const LINE_SCALE_MAX = 1.00;
// 指数 **1.0 = 真正的墨量守恒**：`线宽 × 透明度 ∝ 1/倍率` ⇒ 局部墨量与倍率**无关**，
// 于是"放大只让结构散开、不会越看越糊"，而且线确实随比例尺**变细**（用户那句原话）。
// （曾取 0.75 想压 4~8× 的峰值 —— 后来查明那个峰的真因是**档位渐显把浅档提前放进来了**
//   加上渲染层一条 `max(0.04, alpha)` 钳位把渐显废掉，不是守恒本身的问题。见 CHORD_ALPHA_FLOOR。）
export const LINE_SCALE_POW = 1.0;

/**
 * 缩放补偿（ADR-0014 §5 勘误后的真实行为 + ADR-0018 的缩小半边）：
 *   · 放大（z ≥ REF）：`REF/z` —— 墨量守恒的那一半（放大持续变淡变细）。
 *   · 缩小（z < REF）：`z/REF` —— **跟着变细**（0.4× ⇒ 0.16）。
 *     旧律在这里给出 `REF/z > 1`，被 MAX=1 钳成恒 1 ⇒ 0.4×~2.5× 线宽一动不动
 *     （单根 p90 线 2.68px 打在 52px 宽的宇宙上 = 画面宽的 5.2% —— 用户 #7 的直接原因）。
 *   · 两条半边在 z=REF 处连续（都 = 1），基准倍率处线宽就是深厚分给出的原值。
 */
export function lineScaleForZoom(zoom) {
  const z = Math.max(1e-6, Number(zoom) || LINE_ZOOM_REF);
  const raw = z >= LINE_ZOOM_REF
    ? Math.pow(LINE_ZOOM_REF / z, LINE_SCALE_POW)
    : Math.pow(z / LINE_ZOOM_REF, LINE_SCALE_POW);
  return Math.max(LINE_SCALE_MIN, Math.min(LINE_SCALE_MAX, raw));
}
