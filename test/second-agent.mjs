// [by:WorkBuddy] 票 06：第二个 Agent 接入样例的自动验证。
// 测试本身不重复起服务：只 spawn demo.mjs（它会自己起一个 standalone 服务），
// 再对 demo 与 README 做源码级断言，锁住「解耦」这一票面意图。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'examples/second-agent/demo.mjs');
const README = path.join(ROOT, 'examples/second-agent/README.md');
const read = file => fs.readFileSync(file, 'utf8');

test('demo 真实跑通三步：退出码 0、三步 ok:true、adoptions.adopted 为 true', () => {
  const run = spawnSync(process.execPath, [DEMO], {encoding: 'utf8', cwd: ROOT, timeout: 60000});
  assert.equal(run.error, undefined, `spawn 不应出错：${run.error}`);
  assert.equal(run.status, 0, `demo 应以 0 退出：stderr=${run.stderr}`);
  const stdout = run.stdout || '';

  // 字面检查：三步都有 ok:true。
  assert.ok((stdout.match(/"ok":true/g) || []).length >= 3,
    `stdout 三步都应含 ok:true：${stdout}`);

  // 结构化解析：stdout 每行一个紧凑 JSON 对象。
  const steps = stdout.split('\n').map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line));
  const byStep = Object.fromEntries(steps.map(step => [step.step, step]));
  for (const name of ['messages', 'recall', 'adoptions']) {
    assert.equal(byStep[name]?.ok, true, `${name} 应 ok:true`);
  }
  assert.equal(byStep.recall.matched, true, 'recall 应命中刚提交的笔记');
  assert.equal(byStep.adoptions.adopted, true, 'adoptions.adopted 应为 true');
  assert.ok(byStep.adoptions.adoptedCount > 0, 'adoptedCount 应保留真实正计数');
});

test('源码级：demo 与 README 不含平台/第三方产品专名，不引用内部模块，只走公开 v1', () => {
  const sources = [['demo.mjs', read(DEMO)], ['README.md', read(README)]];
  const banned = /qq|溟月|二鸟|整合包/i;
  for (const [name, src] of sources) {
    assert.doesNotMatch(src, banned, `${name} 不得出现平台或第三方产品专名`);
    assert.doesNotMatch(src, /src\/core|src\/router|adapters\//,
      `${name} 不得引用服务内部模块 / 适配器目录`);
    assert.doesNotMatch(src, /\/api\/(?!v1\/)/,
      `${name} 不得出现任何非 v1 的 API 路径`);
  }

  const demo = sources[0][1];
  // demo 只依赖标准库 + standalone 启动入口，不依赖任何第三方包。
  const specs = [...demo.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specs.length >= 4, `demo 应有若干 import，实际 ${specs.length}`);
  for (const spec of specs) {
    assert.ok(spec.startsWith('node:') || spec.startsWith('../../src/standalone/'),
      `只允许标准库与 standalone 启动入口：${spec}`);
  }

  // 三个公开端点确实都出现，且所有 /api/v1 路径都落在公开前缀下。
  for (const endpoint of ['/messages', '/recall', '/adoptions']) {
    assert.ok(demo.includes(endpoint), `demo 应调用 ${endpoint}`);
  }
  const apiPaths = [...demo.matchAll(/\/api\/v1\/[A-Za-z0-9/_$.{}-]*/g)].map(match => match[0]);
  assert.ok(apiPaths.length >= 3, `demo 应至少出现 3 处公开 v1 路径，实际 ${apiPaths.length}`);
  for (const route of apiPaths) {
    assert.ok(route.startsWith('/api/v1/'), `路径必须落在公开 v1 前缀：${route}`);
  }
});
