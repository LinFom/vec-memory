// 事件向量的**来源身份**判定 —— 这一层存在的唯一理由，是防止自证。
//
// 2026-10-29 主审（`batch-followup-acceptance.md`）驳回了上一版的证据：
// 搬运时把旧行的 `model/dim` 解构掉、用 `settings.embedModel` 与当前 `encoding`
// 重写标签，于是"目标行标签 == 目标 index 身份"必真 —— 这是用结论证明结论。
//
// 所以本文件锁三件事：
//   ① 6 项身份**逐字段**判定，`match`/`mismatch`/`unknown` 三态不许合并；
//   ② "同维度"不能掩盖"换模型"。"同模型"也不能掩盖换 endpoint/revision/normalizer；
//   ③ 搬运入口对 `unknown` 默认 fail-closed，且**写盘时不替来源背书**（不改 index.encoding）。
//
// 这些失败形态的共同点：**它们全都不会报错**。搬进去的向量照样能检索、分数照样有，
// 只是语义悄悄偏了 —— 所以判据只能落在"判定结果"和"落盘字段"上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareSourceIdentity, planEventCarry, encodingIdentity, parseEncoding
} from '../src/core/vector-generation.mjs';
import { VecStore } from '../src/core/vecstore.mjs';

const V = [1, 0.5, 0.25, 1];

const FULL = {
  version: 1, model: 'text-embedding-v3',
  endpoint: 'https://api.example.com/v1', dimensions: 1024,
  revision: '', normalizer: 2, documentFraming: 1
};
const encOf = (patch = {}) => JSON.stringify({ ...FULL, ...patch });
const target = (patch = {}) => ({ model: FULL.model, dim: 1024, encoding: encOf(patch) });

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-carry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── ① 三态判定 ────────────────────────────────────────────────────────────

test('完整 6 项身份一致 ⇒ compatible', () => {
  const r = compareSourceIdentity(
    { model: FULL.model, dim: 1024, encoding: encOf() },
    target()
  );
  assert.equal(r.verdict, 'compatible');
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual(r.unknowns, []);
  for (const k of ['model', 'dimensions', 'endpoint', 'revision', 'normalizer', 'documentFraming']) {
    assert.equal(r.fields[k].result, 'match', `${k} 应为 match`);
  }
});

test('同维度换模型 ⇒ incompatible（维度相同不能掩盖模型不同）', () => {
  const r = compareSourceIdentity(
    { model: 'other-model', dim: 1024, encoding: encOf({ model: 'other-model' }) },
    target()
  );
  assert.equal(r.verdict, 'incompatible');
  assert.equal(r.fields.model.result, 'mismatch');
  assert.equal(r.fields.dimensions.result, 'match', '维度确实相同 —— 所以维度通过不能当作兼容');
  assert.deepEqual(r.mismatches, ['model']);
});

test('同模型换 endpoint ⇒ incompatible', () => {
  const r = compareSourceIdentity(
    { model: FULL.model, dim: 1024, encoding: encOf({ endpoint: 'https://other.example.com/v1' }) },
    target()
  );
  assert.equal(r.verdict, 'incompatible');
  assert.deepEqual(r.mismatches, ['endpoint']);
});

test('同模型换 revision ⇒ incompatible', () => {
  const r = compareSourceIdentity(
    { model: FULL.model, dim: 1024, encoding: encOf({ revision: '2026-10-01' }) },
    target()
  );
  assert.equal(r.verdict, 'incompatible');
  assert.deepEqual(r.mismatches, ['revision']);
});

test('同模型换 normalizer ⇒ incompatible', () => {
  const r = compareSourceIdentity(
    { model: FULL.model, dim: 1024, encoding: encOf({ normalizer: 1 }) },
    target()
  );
  assert.equal(r.verdict, 'incompatible');
  assert.deepEqual(r.mismatches, ['normalizer']);
});

test('同模型换 documentFraming ⇒ incompatible', () => {
  const r = compareSourceIdentity(
    { model: FULL.model, dim: 1024, encoding: encOf({ documentFraming: 2 }) },
    target()
  );
  assert.equal(r.verdict, 'incompatible');
  assert.deepEqual(r.mismatches, ['documentFraming']);
});

test('来源 encoding 缺失（旧扁平布局）⇒ unknown，且点明缺哪几项', () => {
  // 旧库只有行内 model/dim，index.json 不记 encoding
  const r = compareSourceIdentity({ model: FULL.model, dim: 1024, encoding: null }, target());
  assert.equal(r.verdict, 'unknown', '不知道 ≠ 已知不同：只能判 unknown');
  assert.equal(r.fields.model.result, 'match');
  assert.equal(r.fields.dimensions.result, 'match');
  assert.deepEqual(r.unknowns, ['endpoint', 'revision', 'normalizer', 'documentFraming']);
  assert.deepEqual(r.mismatches, []);
});

test('来源什么都缺 ⇒ 6 项全 unknown（不许拿目标值反填）', () => {
  const r = compareSourceIdentity({}, target());
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.unknowns.length, 6);
  for (const k of Object.keys(r.fields)) assert.equal(r.fields[k].source, null, `${k} 的 source 必须是 null`);
});

test('encoding 是坏 JSON ⇒ 退化成行内字段，其余 unknown，不抛错', () => {
  const r = compareSourceIdentity({ model: FULL.model, dim: 1024, encoding: '{不是 json' }, target());
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.fields.model.result, 'match');
  assert.equal(parseEncoding('{不是 json'), null);
});

test('revision 空串是"有记录"，不是"缺记录"', () => {
  const r = compareSourceIdentity({ model: FULL.model, dim: 1024, encoding: encOf({ revision: '' }) }, target());
  assert.equal(r.fields.revision.result, 'match', '两边都是空串 ⇒ 一致，不能算 unknown');
  assert.equal(r.verdict, 'compatible');
});

// ── ② 搬运入口的判定（纯函数，不落盘）──────────────────────────────────────

const ev = (id, patch = {}) => ({ id, kind: 'event', model: FULL.model, dim: 1024, text: `t-${id}`, ...patch });

test('旧扁平布局 + 默认参数 ⇒ 全部 blocked（fail-closed），一条都不搬', () => {
  const plan = planEventCarry({
    sourceMetas: [ev('e1'), ev('e2'), { id: 'blk', kind: 'block' }],
    sourceEncoding: null,
    targetIdentity: target()
  });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.accepted.length, 0, 'unknown 默认不搬');
  assert.equal(plan.blocked.length, 2, '非 event 行不该被计入');
  assert.equal(plan.byVerdict.unknown, 2);
  assert.match(plan.blocked[0].reason, /endpoint/);
});

test('显式 allowUnknown ⇒ unknown 放行，状态记 unknown-accepted（不是 compatible）', () => {
  const plan = planEventCarry({
    sourceMetas: [ev('e1'), ev('e2')],
    sourceEncoding: null,
    targetIdentity: target(),
    allowUnknown: true
  });
  assert.equal(plan.status, 'unknown-accepted');
  assert.equal(plan.accepted.length, 2);
  assert.equal(plan.blocked.length, 0);
  // 关键：放行不等于改判。逐条判定仍然是 unknown。
  assert.ok(plan.accepted.every((a) => a.verdict.verdict === 'unknown'));
});

test('来源明确不一致 ⇒ 即使 allowUnknown 也 blocked', () => {
  const plan = planEventCarry({
    sourceMetas: [ev('e1', { model: 'other-model' })],
    sourceEncoding: null,
    targetIdentity: target(),
    allowUnknown: true
  });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.blocked[0].verdict, 'incompatible');
});

test('完整身份一致 ⇒ compatible，全部搬', () => {
  const plan = planEventCarry({
    sourceMetas: [ev('e1'), ev('e2')],
    sourceEncoding: encOf(),
    targetIdentity: target()
  });
  assert.equal(plan.status, 'compatible');
  assert.equal(plan.accepted.length, 2);
  assert.equal(plan.blocked.length, 0);
});

test('目标代已有同 id ⇒ 跳过（续跑幂等，不重复计 blocking）', () => {
  const plan = planEventCarry({
    sourceMetas: [ev('e1'), ev('e2')],
    sourceEncoding: null,
    targetIdentity: target(),
    hasTarget: (id) => id === 'e1'
  });
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].id, 'e2');
});

// ── ③ 落盘语义：搬运不得替来源背书 ─────────────────────────────────────────

test('搬运写盘时：model 取来源值，且**不改** index.encoding', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir);
  // 块先落库，定下这个代的模型与编码身份（模拟新代已经嵌完块）
  s.put({ id: 'blk1', vector: V, model: FULL.model, encoding: encOf(), meta: { text: 'a', sourceHash: 'h1' } });
  const encBefore = s.index.encoding;
  assert.equal(encBefore, encOf());

  // 模拟搬运：来源 model 原样写、**不传 encoding**（这是修复的关键动作）
  s.put({
    id: 'evt1', vector: V, model: FULL.model,
    meta: { kind: 'event', text: 'e', sourceHash: 'h2', embedDim: 1024, carriedFrom: 'legacy-generation', carryVerdict: 'unknown' }
  });

  assert.equal(s.index.encoding, encBefore, '搬运不得改写 index.encoding（否则旧向量被当前身份背书）');
  assert.equal(s.get('evt1').meta.model, FULL.model);
  assert.equal(s.get('evt1').meta.corrVerdict ?? s.get('evt1').meta.carryVerdict, 'unknown', '搬运结论必须留在行里可查');
});

test('来源 model 与目标库不一致 ⇒ put 直接被库拒绝（最后一道静默防线）', (t) => {
  const dir = tmp(t);
  const s = new VecStore(dir);
  s.put({ id: 'blk1', vector: V, model: FULL.model, encoding: encOf(), meta: { text: 'a', sourceHash: 'h1' } });
  assert.throws(
    () => s.put({ id: 'evt1', vector: V, model: 'other-model', meta: { kind: 'event', text: 'e', sourceHash: 'h2' } }),
    (err) => {
      // 判据用 code，不拿中文文案当契约（文案会改，code 不会）
      assert.ok(err?.code, `拒绝时必须带稳定 code，实际：${err?.message}`);
      assert.match(String(err.code), /MODEL/);
      return true;
    },
    '同维度换模型必须被库层拦住，不能靠上层自觉'
  );
});

test('encodingIdentity 的 6 项与 IDENTITY_FIELDS 必须对得上（改一处漏一处就会判错）', async () => {
  const { IDENTITY_FIELDS } = await import('../src/core/vector-generation.mjs');
  const parsed = JSON.parse(encodingIdentity({ embedModel: 'm', embedBaseURL: 'https://x/v1', embedDimensions: 8, embedRevision: 'r' }));
  for (const k of IDENTITY_FIELDS) {
    const key = k === 'dimensions' ? 'dimensions' : k;
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, key), `encodingIdentity 缺字段 ${k}`);
  }
});

// ── ④ 源码级防回归：搬运入口不许把标签改回去 ───────────────────────────────
// 为什么必须有一层源码断言：上面那些测试证明的是"planEventCarry 判得对"和"put 语义对"，
// 但**没有**证明 `runIndex` 真的按 plan 落盘。有人把 `model: model ?? null` 改回
// `model: settings.embedModel`，18 条测试会全绿而缺陷原样复活 —— 上一轮就是这么被驳回的。
test('搬运入口源码：model 取来源值、不传 encoding、且走 planEventCarry 判定', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'backend.mjs'), 'utf8');
  const at = src.indexOf('planEventCarry({');
  assert.ok(at > 0, 'backend 里找不到 planEventCarry 调用（搬运改回自证写法了？）');
  const carryAt = src.indexOf('for (const { meta, sourceIdentity, verdict } of plan.accepted)',at);
  assert.ok(carryAt>at,'找不到经过来源判定的搬运循环');
  const block = src.slice(carryAt, carryAt + 1800);
  // ⚠️ `targetIdentity` 里出现 `settings.embedModel` 是**对的**（那是目标身份）。
  //    要禁的只是 `targetStore.put({...})` 这次写入里的重贴标签，所以单独截 put 块。
  const putAt = block.indexOf('targetStore.put({');
  assert.ok(putAt > 0, '找不到搬运的 put 调用');
  const putBlock = block.slice(putAt, putAt + 900);
  assert.doesNotMatch(putBlock, /model:\s*settings\.embedModel/, 'put 里又出现 settings.embedModel = 重贴标签');
  assert.match(putBlock, /model:\s*model \?\? null/, '必须写来源行自己的 model');
  assert.doesNotMatch(putBlock, /^\s*encoding,$/m, 'put 不得传 encoding（等于替来源背书）');
});

