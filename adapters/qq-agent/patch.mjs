// 向量记忆库（memory-vec）：核心补丁的「打 / 摘 / 查」。
//
// 为什么一个插件要改核心文件：向量库的列表 / 检索 / 最近邻需要一个 HTTP 面
// （/api/memory-vec/*），而插件体系没有注册 HTTP 路由的契约 —— 所以核心要留一个
// 薄调用点。补丁引擎移植自 murmur-graph 的 v6/v7 引擎（标记块 / 原子写 / 冲突即
// 放弃 / 作用域锚 / needs 自检 / 落地前语法体检），三个原则不变：
//   1. **标记块**：每段都被 [[memory-vec:<id>]] 包起来，幂等、可检测、可精确摘除。
//   2. **原子**：任一锚点找不到/不唯一 → 一个文件都不写，报 conflict 交给人处理。
//   3. **不吞升级**：文件被外部改过时不拿旧备份覆盖，只报冲突。
// 块与核心之间是**软引用**：插件目录被删 → 动态 import 失败 → 缝跳过，行为与未安装一致。
// 摘补丁：node plugins/memory-vec/patch.mjs remove。
//
// 补丁代码本体在 patches/<文件>__<id>.js（原样文本），本文件只负责『放哪儿、怎么放、怎么撤』。

// 补丁表。places 按顺序试：文件在、锚点唯一、块没打过。needs 列核心自己提供的符号。
//
// ⚠️ 只打两块，**刻意不打 plugin-loader 的 .no-watch 豁免**：
//   ① 本插件运行期只写 data/memory-vec/，从不写插件目录，因此不触发
//      "写文件 → 全量重扫 → 新实例又写" 那种自我维持的风暴；
//   ② 那个豁免块声明了一个 `const noWatchDirs`。整合版里 murmur 已经打过同一处锚点，
//      我再打一遍就是**同名变量重复声明** → 落地前语法体检直接拒绝整批。
//   少即是稳：不需要的能力就不要缝。
export const PATCHES = [
  // 路由缝：handleHttp 里、/api/ 分流之前。负责 /api/memory-vec/* 的全部读写。
  // 插件停用（isActive=false）或目录被删时整段跳过，行为与未安装一致。
  { id: 'routes', key: 'src__app.js', places: [
    { file: 'src/app.js', mode: 'before',
      anchor: "    if (pathname.startsWith('/api/')) {",
      needs: ['skillManager', 'authorize', 'json'] }
  ] },
  // 退出缝：随主程序退出释放记忆库句柄（落盘 + 停定时器）。本插件没有子进程，
  // 这块纯粹是"生命周期闭环"纪律 —— 有运行期资源就要有对应的收拾地方。
  // 不列 needs：块里只用 globalThis 上的句柄（见 patches/src__app.js__stop.js），
  // 不引用核心作用域里的任何名字，所以没有"核心符号缺失"的风险面。
  { id: 'stop', key: 'src__app.js', places: [
    { file: 'src/app.js', mode: 'after',
      anchor: '    try { snowlumaProc?.kill(); } catch { /* ignore */ }' }
  ] }
];
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认对"插件所在项目的根目录"动手；MEMORY_VEC_PATCH_ROOT 只是给测试/演练用的覆盖开关
// （测试要在一个临时目录里跑完整的打/摘流程，不能碰开发者自己的工作区）。
export const DEFAULT_ROOT = process.env.MEMORY_VEC_PATCH_ROOT
  ? path.resolve(process.env.MEMORY_VEC_PATCH_ROOT)
  : path.resolve(HERE, '..', '..');
const PATCH_DIR = path.join(HERE, 'patches');
const DEFAULT_BACKUP_DIR = path.join(HERE, 'backup');

/**
 * 备份放哪，按优先级：
 *   1. MEMORY_VEC_BACKUP_DIR —— 插件**运行期**自动打缝时由 index.js 指到 data/ 下。
 *      这一条是必需的：plugins/ 被 fs.watch 全量监听，往插件目录写备份 = 触发一次全量重扫
 *      = 插件被 deactivate 再重载。放到 data/ 里就绕开了监听面。
 *   2. 演练根（MEMORY_VEC_PATCH_ROOT）下的 __mv-backup —— 测试不能往真实插件目录塞东西。
 *   3. 插件目录下的 backup/（跟着插件走，停用也不删）。
 */
const backupDirFor = (root) => (process.env.MEMORY_VEC_BACKUP_DIR
  ? path.resolve(process.env.MEMORY_VEC_BACKUP_DIR)
  : process.env.MEMORY_VEC_PATCH_ROOT
    ? path.join(root, '__mv-backup')
    : DEFAULT_BACKUP_DIR);

/**
 * 补丁版本：锚点或块内容变了就 +1，状态里会显示它。
 *
 * v1（memory-vec 0.1.0）：引擎从 murmur-graph 的 v7 照搬。那块引擎已经过真实事故检验，
 *   三件事值得继承：**作用域锚**（解决"锚点文本被上游顺手改掉/同一行在别处也出现"的失联）、
 *   **needs 自检**（拦下"块装上了但它引用的核心符号已不存在"→ 表现为每条消息抛错却被自己吞掉）、
 *   **落地前语法体检**（拦下"少个逗号 → 前端整片白屏"）。
 *   本插件只保留两块（routes / stop），刻意去掉 .no-watch 豁免 —— 理由见 PATCHES 上方注释。
 */
export const PATCH_VERSION = 1;

const MARK = 'memory-vec';
const openMarker = (id) => `[[${MARK}:${id}]]`;
const closeMarker = (id) => `[[/${MARK}:${id}]]`;

/**
 * 补丁表。每个块给一组候选位置（places），按顺序试：
 *   · `file` 文件得在；
 *   · `anchor` 在那个文件里必须**只出现一次**（改一行就会不唯一，这是故意的：宁可不打）；
 *   · `mode` 决定插在锚点前面还是后面。
 *   · `scope`（可选）：先唯一命中这段结构标记，再只在这个作用域内找 anchor；
 *     `window`（可选）限定往后找多少行，默认 200。用于"同一段代码在文件里出现多次"的场景。
 *   · `needs`（可选）：块引用到的**核心自己提供**的符号名；缺任何一个就拒绝打补丁。
 * 插进去的文本（含紧邻空行）原样存在 patches/<key>__<id>.js，摘除时按同样的文本删 ——
 * 这样"打 → 摘"能逐字节还原（有测试盯着）。
 */


/** 兼容旧写法（单个 file/mode/anchor）—— 别的插件抄过去的那份引擎可能还是老表。 */
const placesOf = (entry) => (Array.isArray(entry.places) && entry.places.length
  ? entry.places
  : [{ file: entry.file, mode: entry.mode, anchor: entry.anchor }]);

// ── 基础工具 ─────────────────────────────────────────────────────────────

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function codeOf(entry) {
  return fs.readFileSync(path.join(PATCH_DIR, `${entry.key}__${entry.id}.js`), 'utf8');
}

/**
 * `mode: 'after'` 的插入点：锚点所在行的**行尾之后**。
 *
 * ⚠️ 这里刻意保持与早期引擎**逐字节等价**：锚点后面紧跟换行时插到下一行行首；
 * 锚点后面还有别的内容（历史遗留的"行尾块"、或锚点只是行的一部分）时，
 * 插在锚点紧跟处 —— 与老逻辑的 `at + anchor.length + 1` 完全一致。
 *
 * 为什么不改成"一路找到行尾"：仓库里存在旧引擎留下的"行尾块"（块首挤在上一行末尾），
 * 那种文件摘掉补丁后会把相邻两行并成一行；此时若按"行尾"定位，会把块插到
 * 合并行里别的字段之后，直接语法错误（踩过）。保持等价 = 历史文件照样能升级。
 */
function afterPos(text, at, anchor) {
  const after = at + anchor.length;
  if (text[after] === '\n') return after + 1;
  if (text[after] === '\r' && text[after + 1] === '\n') return after + 2;
  return Math.min(after + 1, text.length);
}

function readFile(root, rel) {
  const p = path.join(root, rel);
  const raw = fs.readFileSync(p, 'utf8');
  return { p, text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
}

/** 原子写：同目录临时文件 + rename，避免写到一半断电留下半截文件。 */
function writeFileAtomic({ p, text, crlf }) {
  const out = crlf ? text.replace(/\n/g, '\r\n') : text;
  const tmp = `${p}.memory-vec-patch.tmp`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, p);
}

function hasBlock(text, id) {
  return text.includes(openMarker(id)) && text.includes(closeMarker(id));
}

/**
 * 单独看两个标记在不在。只认"一对都在"会漏掉一种情况：用户/上游把闭合标记那行删了，
 * 于是文件里留着一个孤立的开始标记 —— 那既不是干净的、也不是完整的补丁，必须报出来。
 */
function hasTrace(text, id) {
  return { open: text.includes(openMarker(id)), close: text.includes(closeMarker(id)) };
}
const anyTrace = (text, id) => {
  const t = hasTrace(text, id);
  return t.open || t.close;
};

/** 按"打进文件时那一整段文本"删除；返回 null 表示那段文本不在文件里了。 */
function removeExact(text, entry) {
  const code = codeOf(entry);
  const at = text.indexOf(code);
  if (at < 0) return null;
  return text.slice(0, at) + text.slice(at + code.length);
}

/** 兜底：按标记行区间删除（用户手改过块内容时用）。 */
function removeByMarkers(text, id) {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => l.includes(openMarker(id)));
  if (open < 0) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].includes(closeMarker(id))) { close = i; break; }
  }
  if (close < 0) return null;
  return [...lines.slice(0, open), ...lines.slice(close + 1)].join('\n');
}

/**
 * 按"块插入时的精确字节跨度"删除：吃掉前导 \n（块代码的第一个字符）与
 * close 行后的那个空行 \n（块代码的收尾）。所有块都遵守这个书写约定
 * （补丁文件以 \n 开头、以空行收尾），所以对旧版本块也能删得一个字节不差 ——
 * 原位升级后重插当前内容，结果与全新打一份逐字节相同（有测试盯着）。
 *
 * ⚠️ 2026-09-23 修正：**不是所有块都以 \n 开头**。sidebar-menu 是直接贴在两行
 * 代码之间的（插在 `];` 与渲染语句之间，不带空行）。早期实现无条件吃掉前一个换行，
 * 于是摘除时把 `];` 和下一行并成一行 —— 落点检查（要求锚点在行首）挡住了，
 * 结果报"旧块升级失败、找不到可落点的锚点"（真事故，设置页因此空白）。
 * 现在改成**看数据**：只有标记行上方那一行确实是空行时，才认为那个空行属于块的前导约定。
 */
function removeBlockSpan(text, id) {
  const openAt = text.indexOf(openMarker(id));
  if (openAt < 0) return null;
  const closeAt = text.indexOf(closeMarker(id));
  if (closeAt < 0 || closeAt < openAt) return null;
  const openLineStart = text.lastIndexOf('\n', openAt) + 1;
  // 标记行上方那一行是不是空行？（只有空白 = 它是块的前导空行）
  const prevEnd = openLineStart - 1;                  // 上一行末尾的 \n 的位置
  const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
  const prevBlank = prevEnd > 0 && text.slice(prevStart, prevEnd).trim() === '';
  const start = prevBlank ? prevStart : openLineStart;
  const closeLineEnd = text.indexOf('\n', closeAt) + 1;
  const end = closeLineEnd + (text[closeLineEnd] === '\n' ? 1 : 0);   // 收尾空行 \n
  return text.slice(0, start) + text.slice(Math.max(end, closeLineEnd));
}

/** 读文件；不存在返回 null（缺文件本身不算错误，换个候选位置就是）。 */
function readFileText(root, rel) {
  try { return readFile(root, rel); } catch { return null; }
}

/**
 * 这个块现在在哪个候选文件里（有标记就算，哪怕是半个标记，好让人看得见"半打状态"）。
 * 返回 { place, p, text, crlf } 或 null。
 */
function locateBlock(root, entry) {
  for (const place of placesOf(entry)) {
    const f = readFileText(root, place.file);
    if (f && anyTrace(f.text, entry.id)) return { place, ...f };
  }
  return null;
}

/**
 * 锚点是否落在**行首**（前面只有空白）。
 *
 * 为什么必须有这道检查：文件被合并过行时（例如 `  ];  sidebar.innerHTML = \``），
 * 不带缩进的那条兜底锚点会在**行中间**命中，插进去就产出一个语法错误的文件
 * （真实事故：菜单数组的收尾与渲染语句被并到一行，块被塞回数组里 → 界面白屏）。
 * 行首检查让这种文件直接报 conflict（宁可不打），而不是把文件改坏。
 */
function anchorAtLineStart(text, at) {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return text.slice(lineStart, at).trim() === '';
}

/** 找**唯一且落在行首**的锚点；找不到 / 不唯一 / 不在行首都返回 -1。 */
function findSoleAnchor(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return -1;
  if (text.indexOf(anchor, at + anchor.length) >= 0) return -1;
  return anchorAtLineStart(text, at) ? at : -1;
}

/** 作用域锚往后找多少行（默认值）。够覆盖新核心的 ingestMessage（scope 到存档调用 47 行）。 */
const DEFAULT_SCOPE_WINDOW = 200;

/**
 * 找**唯一且落在行首**的作用域标记（例如一行函数声明）。
 * 与 findSoleAnchor 同一套严格度：宁可不打，也不要在半个文件里瞎猜。
 */
function findScopeStart(text, scope) {
  const at = text.indexOf(scope);
  if (at < 0) return -1;
  if (text.indexOf(scope, at + scope.length) >= 0) return -1;
  return anchorAtLineStart(text, at) ? at : -1;
}

/** 从 from 起数 lines 行之后的偏移（超出文件末尾就取末尾）。 */
function offsetAfterLines(text, from, lines) {
  let at = from;
  for (let i = 0; i < lines; i++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/**
 * 作用域内找锚点：**窗口内必须唯一且落在行首**。
 *
 * 为什么是"窗口内唯一"而不是"作用域内唯一"：精确判断作用域到哪儿结束得做括号配对
 * （要跳过字符串、注释、模板字面量……），成本高，而且它自己会成为新的出错点。
 * 而"函数声明之后 N 行内唯一"对我们要落的这几处完全够用（实测 dispatch 47 行、
 * reload-shortcut 29 行），并且**失败方向是安全的**：找不到就报冲突，不猜。
 */
function findAnchorInScope(text, place) {
  const from = findScopeStart(text, String(place.scope));
  if (from < 0) return -1;
  const end = offsetAfterLines(text, from, Number(place.window) || DEFAULT_SCOPE_WINDOW);
  const seg = text.slice(from, end);
  const at = seg.indexOf(place.anchor);
  if (at < 0) return -1;
  if (seg.indexOf(place.anchor, at + place.anchor.length) >= 0) return -1;
  const abs = from + at;
  return anchorAtLineStart(text, abs) ? abs : -1;
}

/** 锚点解析：给了 scope 走"作用域 + 窗口内唯一"，否则走全文唯一。 */
function findAnchor(text, place) {
  return place.scope ? findAnchorInScope(text, place) : findSoleAnchor(text, place.anchor);
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 依赖自检：块点名要用的核心符号，在目标文件里必须存在（按"独立单词"匹配）。
 *
 * 缺了就是 `incompatible`：**拒绝打补丁**，而不是打上去等运行时抛错。
 * 真实事故：0.4 的块里有 `reminders`，京玉版把整个 reminders 模块删了 ——
 * 补丁照打，于是每条消息在拼 host 对象时抛 ReferenceError，被块自己的 try/catch 吞掉，
 * 表现为"插件装了、启用了，指令毫无反应，日志里刷分发失败"。
 *
 * ⚠️ 只列核心自己提供的名字：本插件**别的块**引入的名字（如 plugin-loader.js 的 DATA_DIR
 * 由 loader-import 块引入）不能列进来，否则干净核心上会被误判成缺依赖。
 */
function missingNeeds(text, entry, place = null) {
  const needs = Array.isArray(place?.needs) ? place.needs : (Array.isArray(entry?.needs) ? entry.needs : []);
  if (!needs.length) return [];
  return needs.filter((name) => !new RegExp(`(^|[^\\w$.])${escapeRe(name)}([^\\w$]|$)`).test(text));
}

/**
 * 语法体检：把**成品文本**解析一遍，不执行。
 *
 *   · ESM（文件里有顶层 import/export）→ `node --check --input-type=module`，文本走 stdin，
 *     不落临时文件；普通脚本（京玉版的前端 ui/app.js 就是）→ vm.Script 解析。
 *   · ⚠️ Electron 里 process.execPath 是 electron.exe，必须带 ELECTRON_RUN_AS_NODE=1，
 *     否则它会去开窗口而不是当 node 用（两条路径都实测过）。
 *   · 起不了子进程时**不拦**：体检是加一道网，不是闸门 —— 它不该把正常打补丁变成不可能。
 *     真正的兜底仍然是"锚点失败即原子放弃"与"逐字节往返一致"。
 */
function syntaxOk(text, rel = '') {
  // 语法体检只对 JS 有意义；html/css 直接放行（它们的"语法错"是另一套问题，标记块摘除即可还原）
  if (!/\.[cm]?js$/i.test(rel)) return { ok: true, detail: '' };
  if (!text) return { ok: true, detail: '' };
  if (/^\s*(import|export)\s/m.test(text)) {
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: text, encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      if (r.error || r.status === null) return { ok: true, detail: '' };
      if (r.status === 0) return { ok: true, detail: '' };
      const line = String(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || '';
      return { ok: false, detail: line.trim() };
    } catch {
      return { ok: true, detail: '' };
    }
  }
  try {
    new vm.Script(text);
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

/**
 * 挑一个能用的落点：文件在、这个块还没打过、锚点在文件里**唯一且位于行首**。
 * 找不到返回 null —— 调用方据此报冲突（宁可不打，也不猜）。
 */
function pickPlace(root, entry, provider = null) {
  for (const place of placesOf(entry)) {
    const f = provider ? provider(place.file) : readFileText(root, place.file);
    if (!f) continue;
    if (anyTrace(f.text, entry.id)) continue;
    if (findAnchor(f.text, place) < 0) continue;
    return { place, ...f };
  }
  return null;
}

// ── 备份 ─────────────────────────────────────────────────────────────────

function manifestPath(backupDir) {
  return path.join(backupDir, 'manifest.json');
}

export function readManifest(backupDir = DEFAULT_BACKUP_DIR) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(backupDir), 'utf8'));
  } catch {
    return { patchVersion: PATCH_VERSION, files: {} };
  }
}

function writeManifest(backupDir, manifest) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(manifestPath(backupDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * 首次打补丁前把原文件留一份；**已经备过的不覆盖**（否则第二次备份到的会是"打过补丁的版本"，
 * 之后就再也回不到原样了）。
 */
function ensureBackup(root, backupDir, manifest, rel, key, nowIso) {
  manifest.patchVersion = PATCH_VERSION;
  manifest.files = manifest.files || {};
  if (!manifest.files[rel]) {
    fs.mkdirSync(backupDir, { recursive: true });
    // 原样字节拷贝：备份要能在需要时一比一还原（含行尾），不做任何转换
    fs.copyFileSync(path.join(root, rel), path.join(backupDir, `${key}__${path.basename(rel)}`));
    manifest.files[rel] = {
      backup: `${key}__${path.basename(rel)}`,
      originalSha256: sha256(fs.readFileSync(path.join(root, rel), 'utf8')),
      firstBackedUpAt: nowIso
    };
  }
  return manifest;
}

// ── 状态 ─────────────────────────────────────────────────────────────────

/**
 * **每个补丁块**一个状态（不是每个文件 —— 一个块可能有多个候选文件）：
 *   patched  这个块在某个候选文件里 ✓
 *   clean    不在，但至少有一个候选位置可用（随时能打）
 *   conflict 半打状态，或所有候选位置都用不了（文件不在 / 锚点找不到或不唯一）
 */
export function status({ root = DEFAULT_ROOT } = {}) {
  const files = [];
  for (const entry of PATCHES) {
    const places = placesOf(entry);
    const where = locateBlock(root, entry);
    if (where) {
      if (hasBlock(where.text, entry.id)) {
        if (where.text.includes(codeOf(entry))) {
          files.push({ file: where.place.file, id: entry.id, state: 'patched' });
        } else {
          // 标记还在、内容是旧版本：插件升级后块内容变了，apply() 会原位升级
          files.push({
            file: where.place.file, id: entry.id, state: 'stale',
            detail: `块内容是旧版本（${entry.id}）—— 下次启用/启动时会自动升级，升级后需要重启`
          });
        }
      } else {
        files.push({
          file: where.place.file, id: entry.id, state: 'conflict',
          detail: `标记区不完整（${entry.id}）—— 像是只打了一半，或有人手改过这几行`
        });
      }
      continue;
    }
    const usable = pickPlace(root, entry);
    if (usable) {
      // 锚点落得下，但块引用的核心符号在新核心里没了 → 报 incompatible（拒绝写入）。
      // 这一条把"装上了却每条消息静默报错"变成启动就看得见的一句话。
      const miss = missingNeeds(usable.text, entry, usable.place);
      if (miss.length) {
        files.push({
          file: usable.place.file, id: entry.id, state: 'incompatible',
          detail: `块引用的核心符号在这版核心里不存在：${miss.join('、')} —— 需要先适配这个块`
        });
        continue;
      }
      files.push({ file: usable.place.file, id: entry.id, state: 'clean' });
      continue;
    }
    // 所有候选位置都不行：说清楚是文件没了，还是锚点对不上
    const missing = places.filter((pl) => !readFileText(root, pl.file));
    files.push({
      file: (places.find((pl) => readFileText(root, pl.file)) || places[0]).file,
      id: entry.id,
      state: missing.length === places.length ? 'missing' : 'conflict',
      detail: missing.length === places.length
        ? '文件不存在'
        : `找不到唯一锚点（${entry.id}）：这段代码大概被上游改过`
    });
  }
  const states = new Set(files.map((f) => f.state));
  let state = 'partial';
  if (states.size === 1 && states.has('patched')) state = 'patched';
  else if (states.size === 1 && states.has('clean')) state = 'clean';
  else if (states.size === 1 && states.has('stale')) state = 'stale';
  else if (states.size === 1 && states.has('incompatible')) state = 'incompatible';
  else if (states.has('conflict') || states.has('missing')) state = 'conflict';
  // conflict/missing 优先于 incompatible：文件都没了就别拿"块过期"来混淆视听
  else if (states.has('incompatible')) state = 'incompatible';
  return { state, version: PATCH_VERSION, files };
}

// ── 打补丁 ───────────────────────────────────────────────────────────────

/**
 * 启用时调用：把缺的补丁打上。
 * 返回 { ok, state, changed, conflicts, needsRestart }。
 */
export function apply({ root = DEFAULT_ROOT, backupDir = backupDirFor(root), now = new Date() } = {}) {
  const st = status({ root });
  if (st.state === 'patched') {
    return { ok: true, state: 'patched', changed: [], conflicts: [], needsRestart: false };
  }
  const blocking = st.files.filter((f) => f.state !== 'clean' && f.state !== 'patched' && f.state !== 'stale');
  if (blocking.length) {
    return {
      ok: false,
      state: blocking.some((f) => f.state === 'incompatible') ? 'incompatible' : 'conflict',
      changed: [], conflicts: blocking, needsRestart: false
    };
  }

  // 一个文件可能落好几个块（0.4 的 06-settings-render.js 就落 5 个）：
  // 先把要写的内容按文件攒起来，最后一次性原子写。
  const edits = new Map();   // rel → { p, text（攒改动）, crlf, key（备份用哪个块的 key 都行，key 与文件同名） }
  const upgradeConflicts = [];   // 旧块升级失败（摘掉后锚点对不上等）：按约定一个文件都不写
  /** 取"这个文件当前该被当作基准的文本"：edits 里已有改动就用它，否则读盘。 */
  const textProvider = (rel) => {
    const e = edits.get(rel);
    return e ? { p: e.p, text: e.text, crlf: e.crlf } : readFileText(root, rel);
  };
  for (const entry of PATCHES) {
    const where = locateBlock(root, entry);
    let upgraded = false;
    if (where && hasBlock(where.text, entry.id)) {
      if (where.text.includes(codeOf(entry))) continue;   // 当前版本，已打过
      // 旧版本的块：**先摘掉，再按当前候选锚点重新落点**。
      //
      // 不能只做"原位替换"：块内容可能换了语法形态（数组项 → 语句、表达式 → 声明……），
      // 塞在旧位置上会直接产出语法错误的文件（真实事故：sidebar-menu 从数组项
      // `...pluginSections()` 改成语句 `menu.push(...)`，原位替换把语句挤进了菜单数组）。
      // 标记本身没变，所以按标记定位摘除是可靠的。
      const cur = edits.get(where.place.file)
        || { ...where, place: where.place, rel: where.place.file, key: entry.key, original: where.text, text: where.text };
      let text = removeBlockSpan(cur.text, entry.id);
      if (text === null) text = removeByMarkers(cur.text, entry.id);
      if (text === null) {
        upgradeConflicts.push({
          file: cur.rel, state: 'conflict',
          detail: `旧版块（${entry.id}）升级失败：按标记也摘不掉，请手工处理`
        });
        continue;
      }
      cur.text = text;
      edits.set(cur.rel, cur);
      upgraded = true;
      // 不 continue：落到下面统一走"挑锚点 → 插入"
    } else if (where) {
      continue;                                              // 半打状态：status 已经拦成 blocking 了
    }
    const spot = pickPlace(root, entry, textProvider);
    if (!spot) {
      if (upgraded) {
        upgradeConflicts.push({
          file: '', state: 'conflict',
          detail: `旧版块（${entry.id}）升级失败：摘掉旧内容后找不到可落点的锚点，请手工处理`
        });
      }
      continue;                                              // status 已经拦住这种情况了，双保险
    }
    const cur = edits.get(spot.place.file)
      || { ...spot, rel: spot.place.file, key: entry.key, original: spot.text };
    const at = findAnchor(cur.text, spot.place);
    if (at < 0) continue;
    const pos = spot.place.mode === 'before' ? at : afterPos(cur.text, at, spot.place.anchor);
    cur.text = cur.text.slice(0, pos) + codeOf(entry) + cur.text.slice(pos);
    edits.set(spot.place.file, cur);
  }
  const writes = [...edits.values()]
    .filter((w) => w.text !== w.original)
    .map((w) => ({ rel: w.rel, entry: { key: w.key }, p: w.p, text: w.text, crlf: w.crlf, after: w.text }));
  if (upgradeConflicts.length) {
    // 宁可一个文件都不写，也不留下"一半新一半旧"的补丁状态
    return { ok: false, state: 'conflict', changed: [], conflicts: upgradeConflicts, needsRestart: false };
  }
  if (!writes.length) {
    return { ok: true, state: 'patched', changed: [], conflicts: [], needsRestart: false };
  }

  // 落地前语法体检：插进去的成品必须能被解析（真实事故：少个逗号 → 前端整片白屏）。
  // 体检不过 → 一个文件都不写，报冲突交给人看。
  const syntaxBad = [];
  for (const w of writes) {
    const check = syntaxOk(w.after, w.rel);
    if (!check.ok) {
      syntaxBad.push({ file: w.rel, state: 'conflict', detail: `插入后语法不正确，已放弃写入：${check.detail}` });
    }
  }
  if (syntaxBad.length) {
    return { ok: false, state: 'conflict', changed: [], conflicts: syntaxBad, needsRestart: false };
  }

  const nowIso = now.toISOString();
  let manifest = readManifest(backupDir);
  for (const w of writes) ensureBackup(root, backupDir, manifest, w.rel, w.entry.key, nowIso);
  for (const w of writes) {
    const rec = manifest.files[w.rel];
    if (rec) {
      rec.patchedSha256 = sha256(w.after);
      rec.appliedAt = nowIso;
    }
  }
  for (const w of writes) writeFileAtomic({ p: w.p, text: w.after, crlf: w.crlf });
  writeManifest(backupDir, manifest);
  return {
    ok: true, state: 'patched',
    changed: writes.map((w) => w.rel),
    conflicts: [],
    // 改的是进程已经加载过的核心文件：这次启动不生效，要再启动一次
    needsRestart: true
  };
}

// ── 摘补丁 ───────────────────────────────────────────────────────────────

/**
 * 停用时调用：把补丁摘掉。
 *   · 优先按标记精确摘除（删掉的正好是当初插进去的那一段）；
 *   · 摘不干净且文件哈希仍等于"打过补丁后的哈希" → 用备份整份还原；
 *     （restoreFromBackup: false 时跳过这条路 —— 停机摘缝用它，宁可报冲突
 *      也不能把备份里的旧版文件盖回去，那会把上游更新整个吞掉）
 *   · 文件被外部改过 → **不覆盖**，报冲突（对方可能就是上游的新版本）。
 */
export function revert({ root = DEFAULT_ROOT, backupDir = backupDirFor(root), restoreFromBackup = true } = {}) {
  const manifest = readManifest(backupDir);
  const writes = [];
  const restored = [];
  const conflicts = [];

  // 一个文件里可能有好几个块：先按"这个块现在落在哪个文件"分组，再一次性摘。
  const touched = new Map();   // rel → { f, entries[] }
  for (const entry of PATCHES) {
    const where = locateBlock(root, entry);
    if (!where) continue;                              // 这个块本来就不在（或已经干净）
    const group = touched.get(where.place.file) || { f: where, entries: [] };
    group.entries.push(entry);
    touched.set(where.place.file, group);
  }

  for (const [rel, { f, entries }] of touched) {
    if (!entries.some((e) => anyTrace(f.text, e.id))) continue;   // 已经是干净的
    let text = f.text;
    let exact = true;
    for (const e of entries) {
      if (!anyTrace(text, e.id)) continue;      // 这个块本来就不在文件里
      const next = removeExact(text, e);
      if (next === null) { exact = false; break; }
      text = next;
    }
    if (!exact) {
      // 块内容被手改过：退回按标记行删
      let byMarkers = f.text;
      for (const e of entries) {
        if (!anyTrace(byMarkers, e.id)) continue;
        byMarkers = removeByMarkers(byMarkers, e.id) ?? byMarkers;
      }
      text = byMarkers;
    }
    if (entries.some((e) => anyTrace(text, e.id))) {
      const rec = manifest.files?.[rel];
      if (restoreFromBackup && rec && rec.patchedSha256 === sha256(f.text) && rec.backup) {
        const backupFile = path.join(backupDir, rec.backup);
        if (fs.existsSync(backupFile)) {
          writes.push({ rel, p: f.p, crlf: f.crlf, text: fs.readFileSync(backupFile, 'utf8') });
          restored.push(rel);
          continue;
        }
      }
      conflicts.push({
        file: rel, state: 'conflict',
        detail: restoreFromBackup
          ? '补丁区不完整，且文件已经被外部改过 —— 按约定不拿旧备份覆盖它，请手工处理'
          : '只摘缝模式：按标记摘不干净 —— 不拿旧备份整文件还原（会吞掉上游改动），请手工处理'
      });
      continue;
    }
    writes.push({ rel, p: f.p, crlf: f.crlf, text });
  }

  if (conflicts.length) {
    return { ok: false, state: 'conflict', changed: [], restored: [], conflicts };
  }

  // 摘完也必须语法正确：块边界画错时会连不该删的字符一起删（少个右括号 → 界面白屏）。
  // 这里同样"发现即放弃、一个文件都不写"，把破损留在报错里而不是留在盘上。
  const syntaxBad = [];
  for (const w of writes) {
    const check = syntaxOk(w.text);
    if (!check.ok) {
      syntaxBad.push({ file: w.rel, state: 'conflict', detail: `摘掉后语法不正确，已放弃写入：${check.detail}` });
    }
  }
  if (syntaxBad.length) {
    return { ok: false, state: 'conflict', changed: [], restored: [], conflicts: syntaxBad };
  }

  for (const w of writes) writeFileAtomic(w);
  // 保留备份与清单：下次启用还用它，而且冲突时它是唯一的"原件"
  if (writes.length && manifest.files) writeManifest(backupDir, manifest);
  return { ok: true, state: 'clean', changed: writes.map((w) => w.rel), restored, conflicts: [] };
}

/**
 * 给 UI 看的一行摘要（插件会把它写回自己的配置段）。
 */
export function summarize(result, extra = {}) {
  return {
    version: PATCH_VERSION,
    state: result?.state || 'unknown',
    changed: result?.changed || [],
    conflicts: (result?.conflicts || []).map((c) => ({ file: c.file, detail: c.detail || '' })),
    needsRestart: result?.needsRestart === true,
    applyFailed: result?.ok === false,
    checkedAt: new Date().toISOString(),
    ...extra
  };
}

// ── CLI：node plugins/memory-vec/patch.mjs apply|remove|status ──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'status';
  const show = (r) => {
    console.log(r.ok ? 'ok' : 'FAILED', r.state ?? '');
    if (r.changed?.length) console.log('changed:', r.changed.join(', '));
    if (r.conflicts?.length) for (const c of r.conflicts) console.log('conflict:', c.file, '-', c.detail);
    if (r.needsRestart) console.log('⚠ 改的是核心文件，请完全重启程序生效。');
  };
  if (cmd === 'apply') show(apply());
  else if (cmd === 'remove' || cmd === 'revert') show(revert());
  else console.log(JSON.stringify(status(), null, 2));
}
