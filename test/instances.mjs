// test/instances.mjs —— 多实例清单 `instances.json` 与总览端点 `/instances`（`ADR-0029`）。
//
// ── 为什么值得一个测试文件 ───────────────────────────────────────────────────
// 清单是"**有哪些实例、各自连哪个库**"的唯一事实源：总启动器按它起进程、总览页按它画卡片。
// 它一旦坏掉，**两个消费者会同时沉默** —— 启动器说"没有实例"、总览页一片空白，都不报错。
// 所以这里钉三件事：
//   ① 读侧**永不抛**（缺席 / 坏 JSON / 单条非法都回结构化结果，让界面说出"哪一条错了"）；
//   ② 路径与 `self` 的解析口径（相对按仓根解析；哪一条是"我自己"）；
//   ③ 端点做的是**对账**而不是复述 —— `dataRootMatch` 必须拿运行期 `/health` 比，
//      把清单里的值原样回吐就等于没查（同 `server.mjs` 里"dataRoot 必须出现在 /health 里"那条教训）。
//
// 一律用**临时仓根**（`os.tmpdir()` 下自造 `instances.json` + `data/`）⇒ 一个字节都不碰真仓。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRouter, bindHost } from '../src/index.mjs';
import { readManifest } from '../src/core/instances.mjs';
import { start } from '../src/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'tools', 'instances.mjs');

/** 造一个临时"仓根"：其下 `data/` 是库根；`instances.json` 按需写（字符串 = 原样写，用于坏 JSON）。 */
function mkRepo(manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-inst-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(root, 'instances.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2), 'utf8');
  }
  return root;
}

/** 把 host 绑到某个临时仓根（`readManifest` 靠它算 `repoRoot()`）。 */
function bind(root) {
  bindHost({ config: { DATA_DIR: path.join(root, 'data') }, fallbackRoot: root });
}

test('清单缺席 ⇒ exists:false + error，且**不抛**', () => {
  const root = mkRepo(undefined);
  bind(root);
  const man = readManifest();
  assert.equal(man.exists, false);
  assert.deepEqual(man.instances, []);
  assert.equal(man.path, path.join(root, 'instances.json'), '报的是它找的那个路径');
  assert.equal(man.repoRoot, root, '仓根 = 库根的父目录');
  assert.match(String(man.error), /instances\.json/);
});

test('坏 JSON ⇒ exists:true + error，且**不抛**', () => {
  const root = mkRepo('{ 这不是 JSON');
  bind(root);
  const man = readManifest();
  assert.equal(man.exists, true);
  assert.deepEqual(man.instances, []);
  assert.match(String(man.error), /JSON/);
});

test('路径解析：相对按仓根、绝对原样；self = 与库根同一条', () => {
  const root = mkRepo(undefined);
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
    version: 1,
    instances: [
      { name: '主号', port: 8088, dataRoot: 'data' },
      { name: '小号', port: 8089, dataRoot: 'data-2', sourceRoot: path.join(root, 'host', 'data-2') }
    ]
  }, null, 2), 'utf8');
  bind(root);
  const man = readManifest();
  assert.equal(man.instances.length, 2);
  assert.equal(man.instances[0].dataRoot, path.join(root, 'data'), '相对路径按仓根解析');
  assert.equal(man.instances[0].self, true, 'dataRoot 与库根同一条 ⇒ self');
  assert.equal(man.instances[1].self, false);
  assert.equal(man.instances[1].dataRoot, path.join(root, 'data-2'));
  assert.equal(man.instances[1].sourceRoot, path.join(root, 'host', 'data-2'), '绝对路径原样');
  assert.equal(man.instances[0].sourceRoot, '', 'sourceRoot 留空 ⇒ 空串（"没写"≠"写了空"）');
  assert.equal(man.instances[0].baseURL, 'http://127.0.0.1:8088');
  assert.deepEqual(man.problems, []);
});

test('非法条目进 problems（点名第几条），合法的照常返回', () => {
  const root = mkRepo({
    instances: [
      { name: '', port: 8088, dataRoot: 'data' },           // 缺 name
      { name: '没有端口', dataRoot: 'data-9' },              // port 非法
      { name: '没库根', port: 8091 },                        // 缺 dataRoot
      { name: '重端口 A', port: 8090, dataRoot: 'data-a' },
      { name: '重端口 B', port: 8090, dataRoot: 'data-b' }   // 端口重复
    ]
  });
  bind(root);
  const man = readManifest();
  const p = man.problems.join(' | ');
  assert.match(p, /缺 name/);
  assert.match(p, /port 非法/);
  assert.match(p, /缺 dataRoot/);
  assert.match(p, /端口 8090 被多条实例共用/, '端口重复必须点名 —— 两号共端口会静默连同一个库');
  assert.equal(man.instances[0].name, '#1', '无名条目退回序号名（不丢条）');
  assert.equal(man.instances.length, 5, '非法条目仍在数组里 —— 界面要能显示"这一条坏在哪"');
});

test('/instances：清单缺席 ⇒ 200 + manifestExists:false（不吞成 500）', async () => {
  const root = mkRepo(undefined);
  const router = createRouter({ dataRoot: path.join(root, 'data') });
  const r = await router.handle({ method: 'GET', path: '/instances' });
  assert.equal(r.status, 200, '总览页打不开是最差的失败：宁可回 200 让页面说明原因');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.manifestExists, false);
  assert.deepEqual(r.body.instances, []);
  assert.match(String(r.body.manifestError), /instances\.json/);
});

test('/instances：探活是**真查**（起一个真实例 ⇒ alive:true + dataRootMatch:true）', async () => {
  const root = mkRepo(undefined);
  const lib = path.join(root, 'data');
  const s = await start({ dataRoot: lib, port: 0 });
  try {
    fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
      instances: [
        { name: '本实例', port: s.port, dataRoot: 'data' },
        { name: '没起的', port: 59999, dataRoot: 'data-x' }
      ]
    }), 'utf8');
    const router = createRouter({ dataRoot: lib });   // 与 start 同一个库根 ⇒ self 判定基准一致
    const r = await router.handle({ method: 'GET', path: '/instances' });
    assert.equal(r.status, 200);
    assert.equal(r.body.manifestExists, true);
    assert.equal(r.body.instances.length, 2);

    const me = r.body.instances[0];
    assert.equal(me.alive, true, '真实例必须探到（探活打的是运行期 /health）');
    assert.equal(me.dataRootMatch, true, '清单写的库根 == 运行期回报的库根');
    assert.equal(me.self, true, 'dataRoot 与本站库根相同 ⇒ self');
    assert.ok(Number.isFinite(me.ms), '回填耗时，便于看出"慢"');

    const dead = r.body.instances[1];
    assert.equal(dead.alive, false);
    assert.equal(dead.dataRootMatch, null, '没起 ⇒ 对账**不适用**（null），不是 false');
    assert.match(String(dead.reason), /连不上|超时/);
  } finally {
    s.server.close();
  }
});

test('默认实例示例可解析为本机服务', () => {
  const root = mkRepo({ version: 1, instances: [{ name: '本机记忆库', port: 8088, dataRoot: './data' }] });
  try {
    bind(root);
    const man = readManifest();
    assert.equal(man.exists, true);
    assert.deepEqual(man.problems, []);
    const main = man.instances.find(i => i.self);
    assert.equal(main?.port, 8088);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start-silent：端口对不上 ⇒ **静默退出**（码 0、零输出、不起任何服务）', () => {
  // 静默模式的契约有两条，都在这里钉住：
  //   ① 宿主钩子调它时，它**不该往宿主的标准输出里灌任何东西**（那是宿主自己的 stdout）；
  //   ② 无事可做就正常退出，别用非 0 退出码去惊动调用方 —— "起没起来"由下一次探活回答。
  // 用一个绝不会出现在清单里的端口触发早退路径 ⇒ **不会起任何服务**，对在跑的实例零干扰。
  const r = spawnSync(process.execPath, [TOOL, 'start-silent', '--port', '59999'], { encoding: 'utf8' });
  assert.equal(r.status, 0, '静默模式：无匹配也必须正常退出');
  assert.equal(r.stdout, '', 'stdout 必须是空的（宿主的标准输出不该被灌）');
  assert.equal(r.stderr, '', 'stderr 必须是空的（静默 = 连抱怨都不往外喊）');
});
