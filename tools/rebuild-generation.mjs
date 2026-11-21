#!/usr/bin/env node
// tools/rebuild-generation.mjs —— 记忆向量库的**离线操作台**（不经过宿主、不动宿主进程）
//
// 三件事：新代重建（--build/--publish）、分批补索引（--index）、压缩槽位（--compact）。
// 用法：
//   node tools/rebuild-generation.mjs --name=主号 --status
//   node tools/rebuild-generation.mjs --name=主号 --dry-run          # 只报数，不调模型
//   node tools/rebuild-generation.mjs --name=主号 --build            # 构建到底，先不切代
//   node tools/rebuild-generation.mjs --name=主号 --build --max=300  # 分批：跑 300 条就停
//   node tools/rebuild-generation.mjs --name=主号 --verify           # 切前比对（新旧代同查询）
//   node tools/rebuild-generation.mjs --name=主号 --publish          # 比对满意后切代
//   node tools/rebuild-generation.mjs --name=主号 --index --max=200   # 分批跑增量索引（每轮最多嵌 200 条）
//   node tools/rebuild-generation.mjs --name=主号 --compact           # 压缩槽位（重嵌后 bin 会膨胀）
//   node tools/rebuild-generation.mjs --name=主号 --reset-job --yes   # 放弃旧进度（旧代仍保留）
//
// 为什么要有它（2026-10-29）：
//   · 服务是**停着**的（盘点时两实例都没进程、端口无监听），要把重建做成一件可以
//     随时中断、随时继续的事，就不能依赖"面板上那个按钮"。
//   · 用户的原话是"跑一半没余额了打标记，以免充值后把已经跑过的也跑了"。
//     所以这里把"分批（--max）"和"额度暂停（自动）"都做完，续跑不需要任何参数。
//
// 三条纪律：
//   1. `--build` 默认**不切代**（`noPublish`）。切不切是人的决定，不是脚本的默认行为。
//   2. 任何模式都不打印、不落盘密钥。端点与 Key 从源根 `config.json` 读，只用于本次进程。
//   3. `--status` 完全不启动服务、不碰库 —— 查进度是不花钱的事，必须永远可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv);
const asJson = Boolean(args.json);
// 事件向量来源身份判定为 unknown（旧扁平布局不记 encoding）时，是否仍允许原样搬运。
// 默认不开：来源身份证不了就不搬、不切代。要开必须显式 `--allow-unknown-carry`。
const allowUnknownCarry = args['allow-unknown-carry'] === true;

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** 实例：优先 --data-root；否则从 instances.json 按 --name / --port 解析。 */
function resolveInstance() {
  if (args['data-root']) {
    return {
      name: String(args.name || path.basename(path.resolve(args['data-root']))),
      dataRoot: path.resolve(args['data-root']),
      sourceRoot: args['source-root'] ? path.resolve(args['source-root']) : ''
    };
  }
  const file = args.instances ? path.resolve(args.instances) : path.join(REPO, 'instances.json');
  if (!fs.existsSync(file)) fail(`找不到实例清单：${file}（用 --data-root 直接指定库的父目录）`);
  const list = JSON.parse(fs.readFileSync(file, 'utf8')).instances || [];
  const hit = list.find((i) => (args.name && i.name === args.name) || (args.port && Number(i.port) === Number(args.port)))
    || (list.length === 1 ? list[0] : null);
  if (!hit) fail(`实例清单里找不到 ${args.name || args.port ? `name=${args.name} port=${args.port}` : '目标实例'}；可用：${list.map((i) => i.name).join(' / ')}`);
  return {
    name: hit.name,
    port: hit.port,
    dataRoot: path.resolve(REPO, hit.dataRoot),
    sourceRoot: hit.sourceRoot ? path.resolve(hit.sourceRoot) : ''
  };
}

/** 库根 = <dataRoot>/memory-vec（服务自己也是这么定的）。 */
const libDirOf = (dataRoot) => path.join(dataRoot, 'memory-vec');

function aliveStats(dir) {
  const out = { rows: 0, unique: 0, at400: 0, chars: 0 };
  try {
    const seen = new Set();
    for (const line of fs.readFileSync(path.join(dir, 'meta.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || m.state !== 'alive') continue;
      out.rows++;
      seen.add(m.id);
      if (String(m.text || '').length === 400) out.at400++;
      out.chars += String(m.text || '').length;
    }
    out.unique = seen.size;
  } catch { /* 没有就是没有 */ }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── --status：纯只读，不起服务 ───────────────────────────────────────────
function cmdStatus(inst) {
  const lib = libDirOf(inst.dataRoot);
  if (!fs.existsSync(lib)) fail(`库根不存在：${lib}`);
  const job = readJson(path.join(lib, 'rebuild-job.json'));
  const active = readJson(path.join(lib, 'vector-active.json'));
  const legacy = aliveStats(lib);
  const genDir = active?.generation ? path.join(lib, 'vector-generations', active.generation) : null;
  const genStats = genDir && fs.existsSync(genDir) ? aliveStats(genDir) : null;
  const jobGenDir = job?.generation ? path.join(lib, 'vector-generations', job.generation) : null;
  const jobGenStats = jobGenDir && fs.existsSync(jobGenDir) ? aliveStats(jobGenDir) : null;

  const view = {
    instance: inst.name,
    libDir: lib,
    active: { generation: active?.generation ?? null, encoding: active?.encoding ?? null, ...(genStats || {}) },
    legacyLayout: { ...legacy },
    job: job ? {
      status: job.status, generation: job.generation, total: job.total, done: job.done,
      embedded: job.embedded, skippedResume: job.skippedResume, rejected: job.rejected,
      unreadable: job.unreadable, alive: job.alive,
      startedAt: job.startedAt, updatedAt: job.updatedAt, pauseReason: job.pauseReason,
      written: jobGenStats?.unique ?? null
    } : null
  };

  if (asJson) { console.log(JSON.stringify(view, null, 2)); return; }

  const ts = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
  console.log(`\n实例：${inst.name}    库根：${lib}`);
  console.log(`当前活代：${view.active.generation ? `${view.active.generation}（${view.active.unique} 条）` : '（还没切过代，仍是旧布局）'}`);
  console.log(`旧布局：  ${legacy.unique} 条唯一 id / ${legacy.rows} 行 alive`
    + (legacy.rows > legacy.unique ? `（其中 ${legacy.rows - legacy.unique} 行是同 id 的旧版本）` : ''));
  if (!job) {
    console.log('重建作业：没有（还没跑过新代）\n');
    return;
  }
  const pct = job.total ? Math.round(((job.done || 0) / job.total) * 100) : 0;
  console.log(`\n重建作业：${job.status}   代：${job.generation}`);
  console.log(`  进度：${job.done || 0}/${job.total || '?'}（${pct}%）  新代已写：${view.job.written ?? 0} 条`);
  console.log(`  本次调用：${job.embedded || 0} 条    续跑跳过：${job.skippedResume || 0} 条`);
  console.log(`  被闸门拒：${job.rejected || 0} 条    不可读：${job.unreadable || 0} 条`);
  console.log(`  开始：${ts(job.startedAt)}    最后更新：${ts(job.updatedAt)}`);
  if (job.pauseReason) console.log(`  原因：${job.pauseReason}`);
  if (job.status === 'paused-quota') console.log('  ⇒ 充值后直接再跑 `--build`，从断点继续，不会重嵌已完成的条目。');
  if (job.status === 'ready') console.log('  ⇒ 构建已完成但**未切代**；比对满意后跑 `--publish`。');
  console.log('');
}

// ── 起服务（build / dry-run 需要）────────────────────────────────────────
async function withService(inst, fn) {
  const { start } = await import('../src/server.mjs');
  const s = await start({ dataRoot: inst.dataRoot, sourceRoot: inst.sourceRoot || undefined, port: 0 });
  try {
    const { getRuntime } = await import('../src/core/backend.mjs');
    const rt = await getRuntime();
    // runtime 构造时会 fire-and-forget 一次 ensureIdentity（扫源根重建词表），等它落地
    const deadline = Date.now() + 60_000;
    while (!rt.lastIdentityCheck && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return await fn(rt, s);
  } finally {
    try { s.server.close(); } catch { /* 忽略 */ }
  }
}

// ── --dry-run：只扫不嵌 ──────────────────────────────────────────────────
async function cmdDryRun(inst) {
  const { runIndex, indexingProgress } = await import('../src/core/backend.mjs');
  const res = await withService(inst, async () => runIndex({ reason: 'rebuild-dry-run', dryRun: true }));
  if (asJson) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`\n实例：${inst.name}`);
  console.log(`语料：${res.scanned} 条    需要嵌入：${res.todo} 条    已在盘上跳过：${res.skipped} 条`);
  console.log(`出境闸门拒绝：${res.rejected} 条    不可读：${res.unreadable} 条`);
  console.log(`待嵌入文本合计：${res.pendingChars} 字   按每批 ${res.batchSize} 条 ≈ ${res.estBatches} 次请求`);
  console.log(`库现状：${res.aliveBefore} 条    是否在重建：${res.rebuilding ? `是（代 ${res.generation}${res.resumed ? '，续跑' : '，新建'}）` : '否（编码兼容，无需新代）'}`);
  if (res.brokenList?.length) {
    console.log('\n被拒/不可读样例（前 20）：');
    for (const b of res.brokenList) console.log(`  · ${b.id}  ${b.code || ''}  ${String(b.error || '').slice(0, 110)}`);
  }
  console.log('\n⚠️ 这是预览：没有调用端点、没有写库、没有切代。\n');
}

// ── --index：分批跑增量索引 ──────────────────────────────────────────────
// 什么时候用它：归一化规则一改，`sourceHash` 就变，下一次索引会把变了的块全部重嵌。
// 2026-10-29 这次是主号 965 + 小号 1181 块，加上此前进不去的 7 + 88 条 ≈ 2240 条 ——
// 量级接近一次全量重建。用户口径是"分批花"，所以"一轮花多少"必须是显式参数，
// 不能让"点一下"自己决定花多少钱。
//
// ⚠️ **不能用 `POST /index {"limit":N}` 分批**：`limit` 切的是**语料块**（按 id 取前 N 个），
//    切片之后才和盘上比对，那 N 个绝大多数已经是最新的 ⇒ 一轮既不花钱也不推进，
//    看起来"跑完了"，其实剩下的一次都没做。真正控制钱的是 `maxEmbed`。
async function cmdIndex(inst) {
  const { runIndex } = await import('../src/core/backend.mjs');
  const max = Number(args.max) > 0 ? Math.trunc(Number(args.max)) : 0;
  const maxRounds = Number(args.rounds) > 0 ? Math.trunc(Number(args.rounds)) : 0;
  if (!max && !args.all) {
    fail('要么 --max=N（每轮最多嵌 N 条），要么 --all（一轮跑到底）。不给参数就不替你决定花多少钱。');
  }

  const t0 = Date.now();
  let rounds = 0, embeddedTotal = 0, skipped = 0, rejected = 0, paused = '';
  let slots = 0, alive = 0;

  console.log(`\n实例：${inst.name}    每轮上限：${max || '一次跑完'}\n`);
  await withService(inst, async (rt) => {
    for (;;) {
      rounds++;
      let r;
      try {
        r = await runIndex({ reason: 'manual-batch', maxEmbed: max || undefined, allowUnknownCarry });
      } catch (err) {
        if (err?.code === 'EMBED_QUOTA_EXHAUSTED' || err?.code === 'EMBED_REBUILD_PAUSED') {
          paused = 'quota';
          console.log(`\n⏸  额度中断：${err.message}`);
          console.log('   已写入的条目不会再发。充值后重跑同一条命令，从断点继续。');
          break;
        }
        throw err;
      }
      embeddedTotal += r.embedded;
      skipped = r.skipped;
      rejected = r.rejected;
      const rate = r.ms > 0 ? (r.embedded / (r.ms / 1000)).toFixed(1) : '—';
      console.log(`  第 ${rounds} 轮：嵌入 ${String(r.embedded).padStart(4)} 条（${rate} 条/秒）`
        + `｜盘上已最新 ${r.skipped}｜闸门拒绝 ${r.rejected}｜库 ${r.alive} 条｜${(r.ms / 1000).toFixed(1)}s`);
      if (!r.paused) break;                        // 跑完了
      paused = r.paused;
      if (maxRounds && rounds >= maxRounds) {
        console.log(`\n⏸  已达 --rounds=${maxRounds}，停在这里（下次重跑接着做）。`);
        break;
      }
    }
    // 从**当前代**的 store 上取，不要读库根 meta.jsonl ——
    // 切代之后库根那份是旧库，行数/槽数都对不上（第一次跑就显示成旧库的 1721 行）。
    slots = rt.store.index.slots;
    alive = rt.store.count;
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n合计：${rounds} 轮，嵌入 ${embeddedTotal} 条，用时 ${secs}s。`);
  if (embeddedTotal > 0) {
    // 每次更新都 append 一个新槽（旧槽只标墓碑，空间要 compact 才回来）
    console.log(`槽位：${slots} 个槽 / ${alive} 条活 —— 更新过的块各占一个新槽，回收空间用 --compact。`);
    console.log('要继续：重跑同一条命令（已嵌入的不会再发）。');
  } else {
    console.log('这一轮没有需要嵌入的条目（全部与盘上一致）。');
  }
  if (paused === 'quota') process.exitCode = 2;
  console.log('');
}

// ── --compact：压缩槽位 ──────────────────────────────────────────────────
// 重嵌 = 同一 id 换新向量 = append 新槽 + 旧槽留墓碑，`alive` 不变但 `slots` 涨。
// 不压缩的代价是实的：bin 按槽数线性增长，`_load` 要读全部行（含墓碑）才能重建。
// 旧库主号 5553 槽只服务 1425 条，就是这么攒出来的。
//
// ⚠️ **统计对象必须是"被压缩的那个文件"**（[by:DS] 2026-10-29 主审 P2 修）：
//    切过代之后 `openActiveVectors()` 返回的是 `vector-generations/<sha8>/` 里的 store，
//    `compact()` 改的也是那里的 bin/meta；库根的 `vectors.bin` 是**旧库**，一个字节都不会动。
//    旧实现按 `path.join(libDir,'vectors.bin')` 量大小 ⇒ 报的是旧库的体积变化（通常 0），
//    看起来"压缩没省空间"，而真正被压缩的文件从未被展示过。
//    所以这里一律从 store 上取路径（`store.binFile` / `store.dir`），并把它打出来。
async function cmdCompact(inst) {
  const { openActiveVectors } = await import('../src/core/vector-generation.mjs');
  const dir = libDirOf(inst.dataRoot);
  const pointer = readJson(path.join(dir, 'vector-active.json'));
  const store = openActiveVectors(dir);
  if (!store || typeof store.compact !== 'function') fail('没打开到当前向量代（先看看 --status）');

  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const rel = (p) => path.relative(dir, p).replace(/\\/g, '/') || '.';
  // 压缩目标就是 store 自己的文件，不是库根那份
  const targetBin = store.binFile;
  if (path.resolve(store.dir) !== path.resolve(dir)) {
    const rootBin = path.join(dir, 'vectors.bin');
    if (fs.existsSync(rootBin)) {
      // 只报告，不删：旧库是回退路径，切代后它就该原样躺着
      console.log(`\n（库根还有一份旧库 vectors.bin：${(sizeOf(rootBin) / 1048576).toFixed(1)}MB —— 本次不动它）`);
    }
  }

  const before = { slots: store.index.slots, alive: store.count, bin: sizeOf(targetBin) };
  const res = store.compact();
  const after = { slots: store.index.slots, alive: store.count, bin: sizeOf(targetBin) };
  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  console.log(`\n实例：${inst.name}`);
  console.log(`压缩目标：${pointer?.generation ? `代 ${pointer.generation}` : '无指针 ⇒ 旧扁平布局（库根）'}`);
  console.log(`实际文件：${rel(targetBin)}`);
  console.log(`槽位：${before.slots} → ${after.slots}（丢掉 ${res.removed} 个墓碑槽）`);
  console.log(`活条数：${before.alive} → ${after.alive}（必须相等 —— 不等就是压缩把数据弄丢了）`);
  // 字节数与 MB 都打：MB 保留一位时 8KB→512B 这种变化会显示成 0.0MB → 0.0MB，
  // 看着像"压缩没效果"。真值是字节数，MB 只是给人眼看量级。
  console.log(`${path.basename(targetBin)}：${mb(before.bin)} → ${mb(after.bin)}（${before.bin.toLocaleString('en-US')} → ${after.bin.toLocaleString('en-US')} 字节）`);
  if (after.alive !== before.alive) fail('压缩前后活条数不一致，请立即检查（此时代里已有数据被移动）');
  console.log('');
}

// ── --build：构建（默认不切代）───────────────────────────────────────────
async function cmdBuild(inst) {
  const { runIndex, indexingProgress } = await import('../src/core/backend.mjs');
  const max = Number(args.max) > 0 ? Math.trunc(Number(args.max)) : 0;
  const batch = Number(args.batch) > 0 ? Math.trunc(Number(args.batch)) : 0;
  const publish = Boolean(args.publish);

  // 长跑时每 10 秒打一行进度：没有反馈的话，"是不是卡住了"只能靠猜。
  let lastLine = '';
  const timer = setInterval(() => {
    const p = indexingProgress();
    if (!p.running) return;
    const line = `  … ${p.phase || ''} ${p.done ?? 0}/${p.total ?? '?'}${p.embedded !== undefined ? `（已嵌 ${p.embedded}）` : ''}`;
    if (line !== lastLine) { console.log(line); lastLine = line; }
  }, 10_000);
  timer.unref?.();

  let res;
  try {
    res = await withService(inst, async (rt) => {
      // 只影响**本次进程**：不写宿主配置（写配置必须走宿主 `POST /api/config`，见项目纪律）。
      if (batch) rt.settings.embedBatchSize = batch;
      return runIndex({ reason: 'rebuild-tool', maxEmbed: max || undefined, noPublish: !publish, allowUnknownCarry });
    });
  } finally {
    clearInterval(timer);
  }

  if (asJson) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`\n实例：${inst.name}`);
  console.log(`扫描 ${res.scanned} · 本次嵌入 ${res.embedded} · 续跑跳过 ${res.skippedResume} · 写入新代 ${res.written ?? '—'}`);
  console.log(`被闸门拒 ${res.rejected} · 不可读 ${res.unreadable} · 合计 broken ${res.broken}`);
  if (res.rebuilding) {
    console.log(`新代：${res.generation}${res.resumed ? '（续跑）' : '（新建）'}   作业文件：${res.jobFile}`);
  }
  if (res.paused) {
    console.log(`\n⏸ 已暂停（${res.paused}）：新代已写 ${res.written} 条，**没有切代**。`);
    console.log('   直接再跑同一条 `--build` 就会从断点继续；已写入的条目不会重嵌。');
  } else if (res.rebuilding) {
    console.log('\n✓ 构建完成' + (publish ? '并已切代。' : '，**未切代**（旧库仍在服务）。比对满意后跑 `--publish`。'));
  } else {
    console.log('\n✓ 编码兼容，走的是普通增量索引（没有新建代）。');
  }
  console.log('');
}

// ── --verify：切代前的新旧代同查询比对 ────────────────────────────────────
// 为什么必须做（计划第二阶段 §5）：新代是**从语料重建**的，条数对了不等于检索对了。
// 这里用"新代自己的内容当查询"（自检索）比较两个库：
//   · 同一条内容在两个库里都该被自己检索到（top1/top5 命中率）
//   · Top-K 里出现重复 id 的**计数**：新代与旧代**各算一遍**。
//     ⚠️ 这一项**不是**在验证"旧行复活导致检索重复"（[by:DS] 2026-10-29 主审纠正）：
//        `_load()` 会按 id 隐式去重（同 id 后者覆盖前者），所以旧库也**不会**返回重复 id。
//        实测：旧库 5553 槽位 / 唯一 id 1425 / Top20 无重复。墓碑欠账的真实代价是**槽位白占**
//        （bin 与启动读取按槽数付费），不是"同一 id 进两次结果"。
//        留着这一项是因为"检索输出无重复 id"本身是个应当成立的不变量，两边都该是 0；
//        如果哪天真出现非 0，那是另一类 bug，需要单独查，而不是拿它当新旧代的差异指标。
//   · 同一条的分数差（新−旧）：**只在两个库用同一个模型时才有意义**。模型不同 ⇒ 向量空间
//     不同 ⇒ 分数不可比，这里直接不计算、不打印，而不是打一个看起来很像结论的数字。
async function cmdVerify(inst) {
  const lib = libDirOf(inst.dataRoot);
  const job = readJson(path.join(lib, 'rebuild-job.json'));
  if (!job) fail('没有重建作业（先跑 --build）');
  const genDir = path.join(lib, 'vector-generations', job.generation);
  if (!fs.existsSync(path.join(genDir, 'index.json'))) fail(`代目录不完整：${genDir}`);

  const { VecStore } = await import('../src/core/vecstore.mjs');
  const { embedQueries } = await import('../src/core/embed.mjs');
  const { endpointOf } = await import('../src/core/backend.mjs');
  const newStore = new VecStore(genDir);
  const K = 5;
  const N = Number(args.samples) > 0 ? Math.trunc(Number(args.samples)) : 20;
  // 离线：不调模型，用新代自己的向量当查询（隔离副本可反复跑）
  const offline = args.offline === true;

  const res = await withService(inst, async (rt) => {
    if (path.resolve(rt.store.dir) === path.resolve(newStore.dir)) return { skip: 'already-active' };
    const rows = newStore.metas.filter((m) => m && m.kind !== 'event' && String(m.text || m.title || '').trim());
    const step = Math.max(1, Math.floor(rows.length / N));
    const samples = [];
    for (let i = 0; i < rows.length && samples.length < N; i += step) samples.push(rows[i]);

    // 跨模型时分数不可比：先判，再决定要不要算 deltas
    const newModel = newStore.index.model ? String(newStore.index.model) : null;
    const oldModel = rt.store.index.model ? String(rt.store.index.model) : null;
    const comparable = Boolean(newModel && oldModel && newModel === oldModel);

    const ep = { ...endpointOf(rt.settings), normalizer: rt.normalizer };
    const st = {
      n: 0, newTop1: 0, newTop5: 0, oldTop1: 0, oldTop5: 0,
      newDup: 0, oldDup: 0, deltas: [],
      newModel, oldModel, comparable,
      newSlots: newStore.index.slots, newAlive: newStore.count,
      oldSlots: rt.store.index.slots, oldAlive: rt.store.count
    };
    for (const s of samples) {
      const q = String(s.text || s.title || '').slice(0, 120);
      if (!q.trim()) continue;
      let v;
      try {
        if (offline) {
          // 离线模式：直接拿**新代里这条自己的向量**当查询。
          // 零模型调用 ⇒ 可以在隔离副本上反复跑；代价是它只验"工具行为 + 两库集合对照"，
          // **不评估查询侧编码**（真实查询质量必须带真嵌入另跑一次）。
          v = Array.from(newStore.get(s.id).vector);
        } else {
          ({ vectors: [v] } = await embedQueries([q], ep));
        }
      } catch (e) {
        return { error: `查询侧向量取不到：${e?.message || e}` };
      }
      const hNew = newStore.search({ vector: v, k: K }).hits;
      // 查旧库时用旧库自己的 model：跨模型库拿新模型的向量去查，会直接被
      // `assertQueryCompatibility` 拒掉（这是对的，但会让"对照"根本跑不起来）
      const hOld = rt.store.search({ vector: v, k: K, model: rt.store.index.model || rt.settings.embedModel }).hits;
      st.n++;
      const ni = hNew.findIndex((h) => h.id === s.id);
      const oi = hOld.findIndex((h) => h.id === s.id);
      if (ni === 0) st.newTop1++;
      if (ni >= 0) st.newTop5++;
      if (oi === 0) st.oldTop1++;
      if (oi >= 0) st.oldTop5++;
      // 两边的去重计数各算一次（不是只统计旧代然后宣称新代"必须为 0"）
      if (new Set(hNew.map((h) => h.id)).size < hNew.length) st.newDup++;
      if (new Set(hOld.map((h) => h.id)).size < hOld.length) st.oldDup++;
      if (comparable) {
        const a = hNew.find((h) => h.id === s.id)?.score;
        const b = hOld.find((h) => h.id === s.id)?.score;
        if (typeof a === 'number' && typeof b === 'number') st.deltas.push(a - b);
      }
    }
    return st;
  });

  // ⚠️ 这两种情况都是"**没有做验收**"，不是"验收通过"：
  //   · 已切代 ⇒ 没有"旧代"可比，这一步要重做只能回到切代前；
  //   · 抽样 0 条 ⇒ 什么都没测。
  // 以前它们都 return（退出码 0），于是"跑了 --verify"和"验过了"被混为一谈。
  // 2026-10-29 主审点名要求：零样本不能通过；不能因为活代已发布就 skip 后算验收成功。
  if (res.skip) fail('当前活代就是这个代 —— 已经没有"旧代"可比（说明已经切过了）。这一步**不算验收通过**；'
    + '要真验必须在切代前跑，或在隔离副本上把指针指回旧代再跑。');
  if (res.error) fail(res.error);
  if (!res.n) fail('抽样 0 条 —— 什么都没测，不能作为验收结论（检查语料是否有可用文本，或用 --samples 指定更大样本）');
  if (asJson) { console.log(JSON.stringify(res, null, 2)); return; }
  const pct = (n) => (res.n ? `${Math.round((n / res.n) * 100)}%` : '—');
  const d = res.deltas;
  const avg = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
  console.log(`\n实例：${inst.name}   抽样 ${res.n} 条（新代自己的内容当查询）`);
  console.log(`  新代：top1 ${res.newTop1}/${res.n}（${pct(res.newTop1)}）  top5 ${res.newTop5}/${res.n}（${pct(res.newTop5)}）`
    + `   槽位 ${res.newSlots} / 活 ${res.newAlive}`);
  console.log(`  旧代：top1 ${res.oldTop1}/${res.n}（${pct(res.oldTop1)}）  top5 ${res.oldTop5}/${res.n}（${pct(res.oldTop5)}）`
    + `   槽位 ${res.oldSlots} / 活 ${res.oldAlive}`);
  console.log(`  Top-${K} 里出现重复 id 的查询：新代 ${res.newDup}/${res.n} · 旧代 ${res.oldDup}/${res.n}`);
  console.log('    （两边都该是 0；它不是新旧差异指标 —— `_load` 按 id 去重，遗留槽位只占空间不产生重复结果）');
  if (!res.comparable) {
    console.log(`  分数差：**不计算** —— 新代模型 ${res.newModel || '（未记）'} / 旧代 ${res.oldModel || '（未记）'}`
      + ' 不同，向量空间不同，分数不可比（换模型重建只看命中率）。');
  } else {
    console.log(`  同一条的分数差（新−旧）：均值 ${avg.toFixed(4)}，最小 ${d.length ? Math.min(...d).toFixed(4) : '—'}，最大 ${d.length ? Math.max(...d).toFixed(4) : '—'}（同模型 ${res.newModel}）`);
  }
  console.log('');
}

// ── --publish：切代（不重扫语料、不调端点）───────────────────────────────
async function cmdPublish(inst) {
  const lib = libDirOf(inst.dataRoot);
  const job = readJson(path.join(lib, 'rebuild-job.json'));
  if (!job) fail('没有重建作业可切（先跑 --build）');
  if (job.status === 'published') {
    console.log(`\n已经是 published（代 ${job.generation}），无需重复切。\n`);
    return;
  }
  if (job.status !== 'ready') {
    fail(`作业状态是 ${job.status}，不是 ready —— 说明还没构建完（或上次中断了）。先跑 --build 把它跑完再切。`);
  }
  const genDir = path.join(lib, 'vector-generations', job.generation);
  const st = aliveStats(genDir);
  if (!st.unique) fail(`代目录里没有可用条目：${genDir}`);

  const { openActiveVectors, prepareVectorGeneration } = await import('../src/core/vector-generation.mjs');
  await withService(inst, async (rt) => {
    // 不重扫：直接复用**已经构建好的那个代**，写指针 + 作业标记 published。
    // `prepareVectorGeneration` 在"作业 ready 且编码一致"时会复用同一个代目录，
    // 不会新建、也不会重嵌（它的 store 是打开的同一个目录）。
    const g = await prepareVectorGeneration({ dir: rt.dir, oldStore: rt.store, settings: rt.settings });
    try {
      if (g.store !== rt.store) {
        const written = g.store.count;
        if (!written) throw new Error('新代里没有条目，拒绝切换');
        g.publish();
        console.log(`\n✓ 已切代：${g.generation}（${written} 条）`);
        console.log('  旧库保留在原处，回退只需把 vector-active.json 删掉（或指回旧代）。\n');
      } else {
        console.log('\n当前编码已兼容，不需要切代。\n');
      }
    } finally { g.close?.(); }
  });
}

// ── --reset-job：放弃进度 ────────────────────────────────────────────────
function cmdResetJob(inst) {
  const lib = libDirOf(inst.dataRoot);
  const file = path.join(lib, 'rebuild-job.json');
  if (!fs.existsSync(file)) { console.log('\n没有作业文件，无需重置。\n'); return; }
  if (!args.yes) {
    fail('这是**放弃已跑进度**的操作（已嵌入的向量还在代目录里，但下次会另建一个代）。确认请加 --yes');
  }
  fs.unlinkSync(file);
  console.log('\n✓ 已删除 rebuild-job.json。旧代目录与旧库都没动。\n');
}

// ── 主入口 ───────────────────────────────────────────────────────────────
// `--help` 与"没给任何模式"要在**解析实例之前**返回：否则没带 --name 时会先报
// "实例清单里找不到目标实例"，连用法都看不到（查用法不该依赖实例清单）。
const NO_MODE = !args.status && !args['dry-run'] && !args.build && !args.verify && !args.publish
  && !args.index && !args.compact && !args['reset-job'];
if (args.help || NO_MODE) {
  // 从文件头注释块取用法，不用 `slice(1,21)` 这种魔法数字 —— 加一条命令就截没了
  const head = [];
  for (const l of fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')) {
    if (!l.startsWith('//')) break;
    head.push(l.replace(/^\/\/ ?/, ''));
  }
  console.log(head.join('\n'));
  process.exit(args.help ? 0 : 1);
}
const inst = resolveInstance();
if (args.status) cmdStatus(inst);
else if (args['dry-run']) await cmdDryRun(inst);
else if (args.build) await cmdBuild(inst);
else if (args.verify) await cmdVerify(inst);
else if (args.index) await cmdIndex(inst);
else if (args.compact) await cmdCompact(inst);
else if (args.publish) await cmdPublish(inst);
else if (args['reset-job']) cmdResetJob(inst);
process.exit(0);
