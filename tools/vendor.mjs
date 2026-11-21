// tools/vendor.mjs — 生成式 vendoring
//
// ── 0.9.3 起的现状 ───────────────────────────────────────────────────────
// QQ-Agent 宿主已转**外接模式**（服务只从本仓跑，适配层零向量库代码），
// 本工具不再被它使用 —— 保留给**未来的其他消费者**：谁想把服务嵌进自己的包，
// 谁就重新接上这条生成物 + 哈希校验链（配 adapters/ 时代的 index.js 校验器）。
//
// ── 它解决什么 ───────────────────────────────────────────────────────────
// 宿主是**便携整合包**（要能整包拷走）⇒ 不能用绝对路径 import 本仓；
// 但也不能手抄一份进宿主（**必分叉**，而且分叉不报错，只会在几个月后表现为"改了没生效"）。
//
// 所以：本仓是唯一真源，宿主里那份是**生成物**，用哈希把它钉住。
//
// ── 校验器为什么不在 vendored 目录里 ─────────────────────────────────────
// 拿被篡改的东西去校验自己，等于没校验。所以校验逻辑属于**适配层**
// （`adapters/qq-agent/index.js`），它读 `VENDORED.json` 再重算树哈希。
// 本文件里的 `verifyVendor()` 是给**开发和 CI** 用的同一套算法。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const VENDOR_REL = path.join('plugins', 'memory-vec', 'vendor', 'vec-memory');
export const MANIFEST = 'VENDORED.json';

/**
 * 目录树的**确定性哈希**：按相对路径排序，逐文件 `rel\0sha256(content)\n` 拼接后再 sha256。
 * 排序是必需的 —— 文件系统的 readdir 顺序不保证稳定，不排序会得到"随机变的哈希"。
 *
 * ⚠️ `filter` 不是可选项式的方便开关：**校验时把 manifest 自身排除掉是必需的**，
 *    否则"改 manifest 里的哈希值"就能同时骗过校验（自指）。所以两处必须用同一口径。
 */
export function hashTree(rootDir, filter = null) {
  const files = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const rel = path.relative(rootDir, p).split(path.sep).join('/');
      if (filter && !filter(rel)) continue;
      files.push({
        path: rel,
        size: st.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      });
    }
  })(rootDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blob = files.map((f) => `${f.path}\0${f.sha256}\n`).join('');
  return { files, sha256: crypto.createHash('sha256').update(blob).digest('hex') };
}

/** 参与哈希的只有"产物内容"：manifest 与说明文件不参与（见 hashTree 的警告）。 */
export const isContent = (rel) => rel !== MANIFEST && rel !== 'DO-NOT-EDIT.txt';

/** 只把 `src/` 收进产物（spike/test/tools 不进宿主）。 */
function sourceRoot() { return path.join(REPO, 'src'); }

/**
 * 手工递归拷贝，**不用 `fs.cpSync`**。
 * 为什么：2026-10-09 实测，`cpSync` 指向宿主 vendor 目录时在本机原生层段错误
 * （crash 前无任何输出；同源拷到 %TEMP% 正常、逐文件 copyFileSync 正常）——
 * 判据照旧是运行期事实：换掉崩的那个原语，而不是猜环境哪里不对。
 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const a = path.join(src, name);
    const b = path.join(dst, name);
    if (fs.lstatSync(a).isDirectory()) copyTree(a, b);
    else fs.copyFileSync(a, b);
  }
}

/**
 * 生成 vendor 目录。
 * @param {{targetRoot:string}} opts targetRoot = QQ-Agent 根目录
 * @returns {{outDir:string, manifest:object}}
 */
export function buildVendor({ targetRoot }) {
  if (!targetRoot) throw new Error('buildVendor 需要 targetRoot（QQ-Agent 根目录）');
  const src = sourceRoot();
  if (!fs.existsSync(src)) throw new Error(`找不到 ${src}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const outDir = path.join(path.resolve(targetRoot), VENDOR_REL);

  // 整目录重建：**不留增量**。留下上一次的残留文件会让"哈希对得上但跑的是旧文件"成为可能。
  fs.rmSync(outDir, { recursive: true, force: true });
  copyTree(src, outDir);

  const tree = hashTree(outDir, isContent);
  const manifest = {
    note: '本目录是**生成物**。改这里不会生效，而且会被启动期校验拦下。真源见 from。',
    from: REPO.split(path.sep).join('/'),
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    fileCount: tree.files.length,
    sha256: tree.sha256,
    files: tree.files.map((f) => ({ path: f.path, sha256: f.sha256 }))
  };

  fs.writeFileSync(path.join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'DO-NOT-EDIT.txt'),
    '本目录由 vec-memory 仓的 `npm run vendor` 生成，请勿手改。\n' +
    '手改会被启动期哈希校验拦下（fail-closed），但改了什么都不会生效 —— 因为下次 vendor 会整目录重写。\n' +
    `真源：${manifest.from}\n`, 'utf8');

  return { outDir, manifest };
}

/**
 * 校验 vendor 目录。
 * ⚠️ 只校验 `src` 内容（manifest 自身不参与 —— 否则改 manifest 就能同时骗过校验）。
 */
export function verifyVendor(vendorDir) {
  const mf = path.join(vendorDir, MANIFEST);
  if (!fs.existsSync(mf)) return { ok: false, reason: 'missing-manifest', detail: `找不到 ${mf}` };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); }
  catch (e) { return { ok: false, reason: 'bad-manifest', detail: String(e.message) }; }

  const expected = new Map((manifest.files || []).map((f) => [f.path, f.sha256]));
  const tree = hashTree(vendorDir, isContent);
  const actual = new Map(tree.files.map((f) => [f.path, f.sha256]));

  const missing = [...expected.keys()].filter((p) => !actual.has(p));
  const added = [...actual.keys()].filter((p) => !expected.has(p));
  const changed = [...expected.keys()].filter((p) => actual.has(p) && expected.get(p) !== actual.get(p));

  if (missing.length || added.length || changed.length) {
    return { ok: false, reason: 'content-mismatch', detail: { missing, added, changed }, version: manifest.version };
  }
  if (manifest.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.version) {
      return { ok: false, reason: 'version-drift', detail: `manifest ${manifest.version} vs repo ${pkg.version}`, version: manifest.version };
    }
  }
  return { ok: true, version: manifest.version, fileCount: actual.size, sha256: tree.sha256 };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { target: '', verify: '', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') out.target = argv[++i] || '';
    else if (argv[i] === '--verify') out.verify = argv[++i] || '';
    else if (argv[i] === '--quiet') out.quiet = true;
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.verify) {
    const r = verifyVendor(path.resolve(a.verify));
    if (r.ok) {
      console.log(`✅ VENDORED 校验通过  version=${r.version} files=${r.fileCount} sha256=${r.sha256.slice(0, 12)}`);
      process.exit(0);
    }
    console.error(`❌ VENDORED 校验失败：${r.reason}`);
    console.error('   ' + JSON.stringify(r.detail).slice(0, 600));
    process.exit(1);
  }
  if (!a.target) {
    console.error('用法：');
    console.error('  node tools/vendor.mjs --target "<QQ-Agent 根目录>"     # 生成');
    console.error('  node tools/vendor.mjs --verify "<vendor/vec-memory>"  # 校验');
    process.exit(2);
  }
  const { outDir, manifest } = buildVendor({ targetRoot: a.target });
  if (!a.quiet) {
    console.log(`✅ 已生成 ${outDir}`);
    console.log(`   version=${manifest.version}  files=${manifest.fileCount}  sha256=${manifest.sha256.slice(0, 12)}`);
    console.log(`   真源：${manifest.from}`);
  }
  const back = verifyVendor(outDir);
  if (!back.ok) { console.error('❌ 自校验未通过（刚写完就不一致，说明生成过程有问题）：', back.reason); process.exit(1); }
  if (!a.quiet) console.log('   自校验：通过');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error('vendor 失败：', e); process.exit(1); });
