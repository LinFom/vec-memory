// tools/instances.mjs — 多实例清单的命令行工具（`ADR-0029`）。
//
// ── 子命令 ───────────────────────────────────────────────────────────────
//   list               列出清单 + 探活（只读）
//   check [名字]       自检：服务在不在、**宿主侧三件事**齐不齐（只读）
//   start-all          把没在跑的实例逐个起起来（已在跑的不重起）—— 开**可见窗口**
//   start-silent       同上，但**不开窗口**、日志落 `<仓>/models/vec-autostart.log`
//                      （宿主插件自动拉起时用：用户不想每次开宿主都弹黑窗）
//                      可选 `--port <n>` 只处理那个端口、`--parent-pid <n>` 透传给
//                      server.mjs ⇒ 宿主退出/崩溃后服务自己退（见 server.mjs watchParent）
//
// ── 它读的是哪份清单 ─────────────────────────────────────────────────────
// **仓根 `instances.json`**，而且**复用 `src/core/instances.mjs` 这一个读口** ——
// 与服务端点 `/api/vec/instances` 同源 ⇒ "启动器认为有哪些实例"与"总览页显示哪些实例"
// 永远是同一份答案，不会各自扫出一套。这里只额外做一次 `bindHost`，把仓根告诉它。
//
// ── 为什么不用 node_modules ──────────────────────────────────────────────
// 它要在"整包拷走"的机器上跑，而那里不做 `npm install`。所以只用 `node:*`。
//
// ── start-all 的判据是**运行期事实** ─────────────────────────────────────
// 起之前先探活：端口上已经有 vec-memory 在答 ⇒ **跳过**（不重起）。这正是
// `启动-向量记忆库服务.bat` 那句「port already serving? print that instance's /health
// and STOP」在多实例上的延续 —— 重复双击不该起出第二个进程去抢同一个库根。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindHost } from '../src/core/host.mjs';
import { readManifest, probeAll } from '../src/core/instances.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'src', 'server.mjs');

// 把仓根告诉清单模块（`repoRoot()` = DATA_DIR 的父目录）。
bindHost({ config: { DATA_DIR: path.join(REPO, 'data') }, fallbackRoot: REPO });

// ── 等宽对齐（中文按 2 列算，否则表格会歪）────────────────────────────────
const dw = (s) => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dw(s)));

const C = process.stdout.isTTY ? {
  ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m'
} : { ok: '', bad: '', warn: '', dim: '', off: '' };

/** 端点等价：都指回环、端口相同 —— `localhost` 与 `127.0.0.1` 不该算"不一致"。 */
function sameEndpoint(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    const loop = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    return (ua.port || '80') === (ub.port || '80') && loop(ua.hostname) && loop(ub.hostname);
  } catch { return false; }
}

/** 库根 config.json 里的 sourceRoot（清单没写时的兜底，与 server.mjs 的口径一致）。 */
function sourceRootFromLibRecipe(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'));
    const s = String(raw?.skills?.['memory-vec']?.sourceRoot || '').trim();
    return s ? path.resolve(s) : '';
  } catch { return ''; }
}

/** 读宿主配置（＝源根里的 config.json）。读不到回 null（不是 {} —— "没有"和"空"要分开）。 */
function readHostConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadOrDie() {
  const man = readManifest();
  if (!man.exists) {
    console.error(`${C.bad}❌ 清单不在：${man.path}${C.off}`);
    console.error('   加一个号 = 在仓根建 instances.json（见 docs/multi-instance.md）。');
    process.exit(1);
  }
  if (man.error) {
    console.error(`${C.bad}❌ ${man.error}${C.off}`);
    process.exit(1);
  }
  for (const p of man.problems) console.error(`${C.warn}⚠️  ${p}${C.off}`);
  return man;
}

// ── list ─────────────────────────────────────────────────────────────────
async function cmdList() {
  const man = loadOrDie();
  const probed = await probeAll(man.instances);
  console.log(`\n清单：${man.path}`);
  console.log(`仓根：${man.repoRoot}\n`);
  console.log(`${C.dim}${pad('名字', 18)}${pad('端口', 8)}${pad('状态', 16)}库根${C.off}`);
  for (const it of probed) {
    const state = it.alive
      ? `${C.ok}运行中${it.self ? '·本站' : ''}${C.off}`
      : `${C.bad}未运行${C.off}`;
    console.log(`${pad(it.name, 18)}${pad(it.port ?? '—', 8)}${pad(state, 16 + (it.alive ? C.ok.length + C.off.length : C.bad.length + C.off.length))}${it.dataRoot}`);
  }
  const up = probed.filter((i) => i.alive).length;
  console.log(`\n${up} / ${probed.length} 在运行。`);
  console.log(`查看总览页：任一起着的实例的 /instances.html（或直接双击 启动-全部实例.bat）。`);
}

// ── check ────────────────────────────────────────────────────────────────
async function cmdCheck(only) {
  const man = loadOrDie();
  let probed = await probeAll(man.instances);
  if (only) {
    probed = probed.filter((i) => i.name === only);
    if (!probed.length) {
      console.error(`${C.bad}❌ 清单里没有叫「${only}」的实例。${C.off} 现有：${man.instances.map((i) => i.name).join(' / ')}`);
      process.exit(1);
    }
  }

  let issues = 0;
  /** 附加说明按行缩进 —— 多行建议不缩进会顶到行首，读起来像"另一条断言"。 */
  const indent = (s) => String(s).split('\n').map((l) => '      ' + l).join('\n');
  const say = (good, label, extra = '') => {
    if (!good) issues++;
    console.log(`   ${good ? `${C.ok}✅${C.off}` : `${C.bad}❌${C.off}`} ${label}${extra ? `\n${C.dim}${indent(extra)}${C.off}` : ''}`);
  };
  const warn = (label, extra = '') =>
    console.log(`   ${C.warn}⚠️${C.off}  ${label}${extra ? `\n${C.dim}${indent(extra)}${C.off}` : ''}`);

  for (const it of probed) {
    console.log(`\n${C.dim}──${C.off} ${it.name}  ${C.dim}（端口 ${it.port ?? '—'}）${C.off}`);

    // ① 服务在不在
    if (it.alive) {
      const okRoots = it.dataRootMatch === true && it.sourceRootMatch !== false;
      say(okRoots, `服务在跑，连的库根与清单一致`,
        `库根 ${it.health?.dataRoot}\n源根 ${it.health?.sourceRoot}`);
      if (it.dataRootMatch === false) warn('服务在跑，但**库根与清单不一致** —— 端口上跑的是别的实例？');
    } else {
      say(false, `服务没在跑（${it.reason}）`, `双击 启动-全部实例.bat，或：\n  node "${SERVER}" --data-root "${it.dataRoot}" --port ${it.port}`);
    }

    // ② 库根
    const libOk = fs.existsSync(it.dataRoot);
    if (it.alive) {
      // 服务活着 ⇒ 库根必然可用（它自己在用），不再重复判。
    } else {
      say(libOk, `库根${libOk ? '' : '不存在'}：${it.dataRoot}`,
        libOk ? '' : '服务会在首次索引时自己建。若这是笔误，现在改清单比跑起来再查便宜。');
    }

    // ③ 源根 —— 宿主侧那三件事都挂在它上面
    const srcRoot = it.sourceRoot || sourceRootFromLibRecipe(it.dataRoot);
    if (!srcRoot) {
      warn('源根没解析出来（清单 sourceRoot 留空、库根 config.json 里也没有）',
        '索引源 / 身份 / 存档都会落空 ⇒ 这个实例跑起来是**空库**。见 docs/multi-instance.md。');
    } else if (!fs.existsSync(srcRoot)) {
      say(false, `源根不存在：${srcRoot}`, '路径写错，或那个号还没起过一次（宿主 data 目录尚未生成）。');
    } else {
      say(true, `源根：${srcRoot}`);
      const cfgFile = path.join(srcRoot, 'config.json');
      const cfg = readHostConfig(cfgFile);
      if (!cfg) {
        say(false, `源根里没有可读的 config.json：${cfgFile}`,
          '宿主侧这一步没做：这个号还没有任何技能配置。');
      } else {
        // ③-1 记忆插件配置（没有它 ⇒ 面板连不上服务）
        const mv = cfg?.skills?.['memory-vec'];
        if (!mv) {
          say(false, '宿主配置里**没有 `skills.memory-vec`**',
            '这是"配了一半还以为好了"最容易漏的一步：光起服务、光有清单，这个号也连不上。\n'
            + '在宿主面板里给这个号开一次「向量记忆库」并填好 serviceBaseURL，或照 docs/multi-instance.md 走写入口。');
        } else {
          say(mv.enabled === true, `skills.memory-vec.enabled = ${mv.enabled === true}`,
            mv.enabled === true ? '' : '插件没启用 ⇒ 不会注入、也没有记账/搜旧事的工具。');
          if (it.baseURL && mv.serviceBaseURL) {
            const same = sameEndpoint(mv.serviceBaseURL, it.baseURL);
            say(same, `serviceBaseURL = ${mv.serviceBaseURL}${same ? '' : `（应为 ${it.baseURL}）`}`,
              same ? '' : '指向别的端口 ⇒ 这个号会**读写别的号的库**（全程无提示）。');
          } else if (!mv.serviceBaseURL) {
            warn('skills.memory-vec 没写 serviceBaseURL',
              `会用默认值 http://127.0.0.1:8088 —— 这个号应当指向 ${it.baseURL}。`);
          }
        }
        // ③-2 粮仓（唯一索引数据源，`backend.mjs:193`）
        const cm = cfg?.skills?.['conversation-memory'];
        if (!cm) {
          say(false, '宿主配置里**没有 `skills.conversation-memory`**',
            '它是向量库索引的**唯一数据源**（小时块由它产出）。没有它 ⇒ 永远没有块可索引。');
        } else {
          say(cm.enabled === true, `skills.conversation-memory.enabled = ${cm.enabled === true}`,
            cm.enabled === true ? '' : '粮仓没开 ⇒ 索引永远是空的（这是 0 块的最常见原因）。');
        }
      }
    }
  }

  console.log(issues
    ? `\n${C.bad}${issues} 项没过。${C.off} 见 docs/multi-instance.md。`
    : `\n${C.ok}全部通过。${C.off}`);
  if (issues) process.exitCode = 1;
}

// ── start-all ────────────────────────────────────────────────────────────
function spawnInstance(it) {
  const parts = [process.execPath, SERVER, '--data-root', it.dataRoot, '--port', String(it.port)];
  if (it.sourceRoot) parts.push('--source-root', it.sourceRoot);
  if (process.platform !== 'win32') {
    console.log(`   ${C.dim}（非 Windows：请手动起）node "${SERVER}" --data-root "${it.dataRoot}" --port ${it.port}` +
      (it.sourceRoot ? ` --source-root "${it.sourceRoot}"` : '') + C.off);
    return false;
  }
  // 开**独立窗口**（与 `启动-向量记忆库服务.bat` 同形）：看得到输出、关窗口就是关服务。
  // 引号交给 Node 自己加 —— 手工加会与它的转义规则叠成两层引号。
  const child = spawn('cmd.exe',
    ['/c', 'start', `vec-memory ${it.name}`, '/D', REPO, 'cmd', '/k', ...parts],
    { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return true;
}

async function cmdStartAll() {
  const man = loadOrDie();
  const probed = await probeAll(man.instances);
  console.log(`\n清单：${man.path}（${probed.length} 条）\n`);

  let started = 0, skipped = 0, failed = 0;
  for (const it of probed) {
    if (it.port == null) {
      console.log(`${C.bad}✗${C.off} ${it.name}：清单里没有合法端口，跳过`);
      failed++; continue;
    }
    // 判据是运行期事实：端口上已经有 vec-memory 在答 ⇒ 不重起。
    if (it.alive) {
      const hint = it.dataRootMatch === false ? `${C.warn}（⚠️ 它连的库根与清单不一致）${C.off}` : '';
      console.log(`${C.dim}•${C.off} ${it.name}：已在 ${it.baseURL} 运行${hint} ⇒ 跳过`);
      skipped++; continue;
    }
    if (!fs.existsSync(it.dataRoot)) {
      console.log(`${C.warn}•${C.off} ${it.name}：库根还不存在（${it.dataRoot}）—— 服务会自建，照常启动`);
    }
    const srcRoot = it.sourceRoot || sourceRootFromLibRecipe(it.dataRoot);
    if (!srcRoot) {
      console.log(`${C.warn}•${C.off} ${it.name}：没解析出源根 ⇒ 起来也是空库（先看 docs/multi-instance.md）`);
    }
    if (spawnInstance(it)) {
      console.log(`${C.ok}▶${C.off} ${it.name}：已在新窗口启动 ${it.baseURL}  (data-root: ${it.dataRoot})`);
      started++;
    } else failed++;
  }

  console.log(`\n启动 ${started} · 跳过 ${skipped}${failed ? ` · 失败 ${failed}` : ''}`);
  if (started) {
    console.log('稍等几秒再跑 `node tools/instances.mjs list` 确认都起来了；总览页见任一实例的 /instances.html。');
  }
  if (failed) process.exitCode = 1;
}

// ── start-silent（宿主插件自动拉起用）─────────────────────────────────────
//
// 与 start-all 的**唯一差别是"看得见 vs 看不见"**：同一份清单、同一条探活判据
//（端口上真有 vec-memory 在答 ⇒ 跳过）、同一个 `server.mjs` 入口。变的是三处：
//   · 不 `cmd /k` 开窗，`windowsHide: true`，stdout/stderr 追加到仓内日志文件；
//   · 不打印（宿主在钩子里调它，宿主的标准输出不该被我们灌）；
//   · 多两个可选参数：`--port <n>` 只处理匹配实例、`--parent-pid <n>` 透传守护。
//
// ⚠️ 为什么不是"让插件自己读 instances.json 再起服务"：那会造出**第二个清单解析器**，
//    仓侧加字段时两处口径必然漂移（`ADR-0029` 的单一事实源正是为此立的）。
const AUTOSTART_LOG = path.join(REPO, 'models', 'vec-autostart.log');
const LOG_MAX_BYTES = 512 * 1024;

/** 打开追加用的日志句柄；超限就先清空（这是"静默模式的输出"，不是审计日志）。 */
function openLogFile() {
  try {
    fs.mkdirSync(path.dirname(AUTOSTART_LOG), { recursive: true });
    if (fs.statSync(AUTOSTART_LOG).size > LOG_MAX_BYTES) fs.writeFileSync(AUTOSTART_LOG, '');
  } catch { /* 不存在/删不掉都无妨，下面照常 append */ }
  return fs.openSync(AUTOSTART_LOG, 'a');
}

function spawnInstanceSilent(it, { parentPid }) {
  const parts = [SERVER, '--data-root', it.dataRoot, '--port', String(it.port)];
  if (it.sourceRoot) parts.push('--source-root', it.sourceRoot);
  if (parentPid) parts.push('--parent-pid', String(parentPid));

  let out = 'ignore';
  try { out = openLogFile(); } catch { out = 'ignore'; }

  // ⚠️ `detached: true` **不能省**：本工具起完就退出，而 `detached: false` 时
  //    父进程一退子进程就跟着没了（实测：服务一个字节都没写进日志就消失）。
  //    `start-all` 那边同理（那边靠 detached 开独立窗口）。
  //    父进程守望交给 `--parent-pid`（服务自己看住宿主），不依赖进程组关系。
  //
  //    `process.execPath` 本身可能是 electron.exe（宿主用 ELECTRON_RUN_AS_NODE=1 调本工具）
  //    —— 那个变量在 env 里继承下去，子进程照样以 node 模式跑，不需要特判。
  const child = spawn(process.execPath, parts, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    cwd: REPO,
    env: { ...process.env }
  });
  child.on('error', () => { /* 起不来也不吵：下次探活自然发现它不在 */ });
  child.unref();
  if (typeof out === 'number') { try { fs.closeSync(out); } catch { /* 已交给子进程 */ } }
  return true;
}

/** @returns {Promise<number>} 进程退出码：静默模式下**永远 0**（成败都由探活说话）。 */
async function cmdStartSilent(argv) {
  const want = { port: null, parentPid: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') want.port = Number(argv[++i]);
    else if (argv[i] === '--parent-pid') want.parentPid = Number(argv[++i]);
  }

  const man = readManifest();
  if (!man.exists || man.error) return 0;
  const list = Number.isInteger(want.port)
    ? (man.instances || []).filter((it) => it.port === want.port)
    : (man.instances || []);
  if (!list.length) return 0;

  const probed = await probeAll(list);
  for (const it of probed) {
    if (it.port == null || it.alive) continue;
    spawnInstanceSilent(it, { parentPid: Number.isInteger(want.parentPid) ? want.parentPid : null });
  }
  return 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────────
const SUB = (process.argv[2] || 'list').toLowerCase();
try {
  if (SUB === 'list') await cmdList();
  else if (SUB === 'check') await cmdCheck(process.argv[3] || '');
  else if (SUB === 'start-all' || SUB === 'start') await cmdStartAll();
  else if (SUB === 'start-silent') process.exitCode = await cmdStartSilent(process.argv.slice(3));
  else {
    console.error(`未知子命令：${SUB}`);
    console.error('用法：node tools/instances.mjs [list | check [名字] | start-all | start-silent [--port n] [--parent-pid n]]');
    process.exit(2);
  }
} catch (e) {
  console.error(`\n${C.bad}✗ ${e?.stack || e}${C.off}`);
  process.exit(1);
}
