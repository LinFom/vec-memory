// vendor.mjs —— 生成式 vendoring 的验收
//
// 这条测试的存在理由：`MIGRATION.md §6 判据 5` 要求"哈希校验在启动路径上**必然执行**"。
// 而"必然执行"这件事只能靠"**改了就一定红**"来证明 —— 所以这里最重要的不是
// "能生成"，而是**篡改 / 增删 / 改版本号都必须被拦下**。
//
// 跑：node test/vendor.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVendor, verifyVendor, MANIFEST } from '../tools/vendor.mjs';
import { ok, tally } from './lib/_helpers.mjs';


const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-vendor-'));
const { outDir, manifest } = buildVendor({ targetRoot: target });
const rel = (p) => path.join(outDir, p);

console.log('\n── ① 生成 ──');
ok(fs.existsSync(outDir), 'vendor 目录已建', outDir.replace(target, '<target>'));
ok(fs.existsSync(rel(MANIFEST)), 'VENDORED.json 已写');
ok(fs.existsSync(rel('DO-NOT-EDIT.txt')), 'DO-NOT-EDIT.txt 已写');
ok(fs.existsSync(rel('index.mjs')) && fs.existsSync(rel('core')) && fs.existsSync(rel('transport')),
  'src 内容已平铺进 vendor 目录（index/core/transport 都在）');
ok(!fs.existsSync(rel('spike')) && !fs.existsSync(rel('test')) && !fs.existsSync(rel('tools')),
  'spike/test/tools **不**进产物');
ok(manifest.fileCount === manifest.files.length && manifest.fileCount > 15,
  `manifest 记了 ${manifest.fileCount} 个文件`);

console.log('\n── ② 校验通过（基线） ──');
const v0 = verifyVendor(outDir);
ok(v0.ok === true, '刚生成的目录校验通过', v0.ok ? `version=${v0.version}` : `${v0.reason}`);
ok(v0.sha256 === manifest.sha256, '重算的树哈希 = manifest 记的（同算法、无隐藏字段）');

console.log('\n── ③ fail-closed：改了就必须红 ──');

// 篡改**一个字节**
const victim = rel('router.mjs');
const before = fs.readFileSync(victim);
fs.writeFileSync(victim, Buffer.concat([before, Buffer.from('\n// 手改一行\n')]));
const v1 = verifyVendor(outDir);
ok(v1.ok === false && v1.reason === 'content-mismatch' && v1.detail.changed.includes('router.mjs'),
  '手改一个文件 ⇒ 校验失败且**点名是哪个文件**',
  v1.ok ? '没拦住！' : `changed=[${(v1.detail.changed || []).join(',')}]`);
fs.writeFileSync(victim, before);

// 删一个文件
const gone = rel('router.mjs');
const saved = fs.readFileSync(gone);
fs.rmSync(gone);
const v2 = verifyVendor(outDir);
ok(v2.ok === false && (v2.detail?.missing || []).includes('router.mjs'),
  '删掉一个文件 ⇒ 校验失败', v2.ok ? '没拦住！' : `missing=[${(v2.detail?.missing || []).join(',')}]`);
fs.writeFileSync(gone, saved);

// 加一个文件
fs.writeFileSync(rel('extra.mjs'), '// 偷渡\n');
const v3 = verifyVendor(outDir);
ok(v3.ok === false && (v3.detail?.added || []).includes('extra.mjs'),
  '偷加一个文件 ⇒ 校验失败', v3.ok ? '没拦住！' : `added=[${(v3.detail?.added || []).join(',')}]`);
fs.rmSync(rel('extra.mjs'));

// 改 manifest 里的版本号（比"改内容"更隐蔽：内容全对，只是版本对不上）
const mfPath = rel(MANIFEST);
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const realVersion = mf.version;
mf.version = '99.99.99';
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
const v4 = verifyVendor(outDir);
ok(v4.ok === false && v4.reason === 'version-drift',
  'manifest 版本号与仓里对不上 ⇒ 校验失败（内容全对也拦）', v4.ok ? '没拦住！' : v4.reason);
mf.version = realVersion;
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

console.log('\n── ④ 恢复后必须重新变绿（否则上一条可能是"永久红"） ──');
ok(verifyVendor(outDir).ok === true, '全部还原后校验重新通过');

console.log('\n── ⑤ hashTree 的确定性 ──');
const h1 = verifyVendor(outDir).sha256;
const h2 = verifyVendor(outDir).sha256;
ok(h1 === h2, '同一目录连续两次哈希一致（readdir 顺序不影响）');
const rebuilt = buildVendor({ targetRoot: target });
ok(rebuilt.manifest.sha256 === h1, '删掉重建 ⇒ 树哈希相同（生成是纯函数）',
  `${rebuilt.manifest.sha256.slice(0, 12)} vs ${h1.slice(0, 12)}`);

console.log('\n── ⑥ 缺 manifest / 坏 manifest ──');
fs.rmSync(rel(MANIFEST));
ok(verifyVendor(outDir).reason === 'missing-manifest', '没有 VENDORED.json ⇒ missing-manifest');
fs.writeFileSync(rel(MANIFEST), '{ 不是 json');
ok(verifyVendor(outDir).reason === 'bad-manifest', 'VENDORED.json 解析失败 ⇒ bad-manifest（不猜、不当通过）');

fs.rmSync(target, { recursive: true, force: true });

console.log(`\n════════════════════════════════════════════════════════════════`);
console.log(`vendoring：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log(`════════════════════════════════════════════════════════════════`);
process.exitCode = tally.fail ? 1 : 0;
