// test/inject-exposure.mjs —— 票 03 收尾：注入级曝光的**真实路由端到端**证据
// [by:WorkBuddy] 2026-11-07
//
// 为什么需要这个文件：test/recall-policy.mjs 验的是纯函数，证明「因子算得对」，
// 但证明不了「/inject 真的把因子接上了、曝光状态真的跨轮累积」。
// 这里直接 createRouter + router.handle('/inject')，跑多轮真实请求。
//
// ⚠️ 归一化器是进程级单例（normalize.mjs:1264），同一进程只能建一个 dataRoot，
// 所以本文件只测 enabled 一条链。off 态「响应逐字不变」由三处共同覆盖：
//   ① npm test 其余默认 off 的服务级测试全绿；
//   ② tools/evaluate-memory.mjs 与 docs/recall-evaluation-20261101.json 对拍；
//   ③ test/recall-policy.mjs 的 off/shadow 纯函数断言。
//
// ⚠️ 一个**如实标注的设计边界**：当「候选数 == 配额数」时，每轮所有候选都被同等
// 曝光，共同因子不改变相对顺序 ⇒ 看不出让位。曝光让位只在「候选 > 配额」时有意义
// （被截断的行没被曝光，下一轮相对占优）。所以本用例刻意用 6 候选 / 3 配额。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/index.mjs';
import { getRuntime, disposeMemoryVec } from '../src/core/backend.mjs';

test('/inject 注入级曝光：跨轮累积、候选>配额时让位、dry 不写状态、deferred 走收据', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-inject-exposure-'));
  const router = createRouter({
    dataRoot: root,
    settings: {
      getSkillConfig: (_, defaults) => ({
        ...defaults,
        embedBaseURL: '', embedModel: '',
        consolidateEnabled: false, autoIndexEnabled: false,
        recallPolicyMode: 'enabled',
        recallExposureWindow: 3,
        recallExposureDecay: 0.3
      })
    }
  });
  const rt = await getRuntime();
  t.after(() => {
    disposeMemoryVec();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let n = 0; !rt.lastIdentityCheck && n < 200; n++) await new Promise((r) => setTimeout(r, 10));
  rt.normalizer.setVocabulary([
    { id: 'qq:11111', kind: 'person', surface: ['甲同学'] },
    { id: 'group:42', kind: 'group', surface: ['测试群'] }
  ]);

  const post = (p, body) => router.handle({ path: p, method: 'POST', body });

  // 六种 fact_kind ⇒ 六个不同槽（槽身份含 fact_kind），避开 trait（它走档案段）。
  // 若都写成同一个 kind，会落进同一槽互相覆盖 —— 只有最后一条生效，测不出让位。
  for (const [kind, text] of [
    ['preference', '喜欢绿茶'], ['topic', '常聊插件'], ['event', '昨天搬家'],
    ['joke', '爱讲冷笑话'], ['promise', '答应帮修电脑'], ['grudge', '讨厌排队']
  ]) {
    const saved = await post('/remember', { chatKey: 'group:42', userId: '11111', kind, text });
    assert.equal(saved.status, 200, `remember ${kind}: ${JSON.stringify(saved.body).slice(0, 160)}`);
  }

  // topic 留空 ⇒ sims=null ⇒ 所有行都不 hot，排序只看 credibility × 曝光因子，
  // 让「让位」不话题被相关性加成（1000）掩盖；这测的是曝光，不是嵌入。
  const req = { chatKey: 'group:42', people: [{ id: '11111' }], topic: '', perPerson: 6, total: 3 };
  const rounds = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await post('/inject', req);
    assert.equal(r.status, 200);
    const p = r.body?.policy;
    assert.ok(p, 'enabled 态必须回报 policy 诊断');
    assert.equal(p.channel, 'inject');
    assert.equal(p.applied, true);
    assert.equal(p.mode, 'enabled');
    assert.equal(r.body.candidates, 6, '候选必须多于配额，否则共同因子不会改变相对顺序');
    assert.equal(r.body.lines.length, 3);
    assert.equal(p.recorded, 3, '只记真正进了 lines 的 3 条，不是 6 条候选');
    rounds.push({ lines: r.body.lines.map((l) => l.line), demoted: p.demoted });
  }

  assert.equal(rounds[0].demoted, 0, '第一轮无任何曝光');
  assert.ok(rounds[1].demoted > 0, '第二轮必须查到第一轮的曝光');
  assert.ok(rounds[3].demoted >= rounds[1].demoted, '曝光随轮次累积');
  const distinctSets = new Set(rounds.map((r) => [...r.lines].sort().join('|')));
  assert.equal(distinctSets.size, 4,
    '连续四轮不应反复占满同一批注入位 —— 票 03「注入位不重复」的端到端判据');
  for (const r of rounds) assert.ok(r.lines.every((x) => typeof x === 'string' && x.length));

  // dry 轮：算得出诊断，但绝不写曝光状态（宿主要「预览」，不该污染跨轮计数）。
  const dry = await post('/inject', { ...req, dry: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.policy.recorded, 0);
  assert.equal(dry.body.policy.deferred, false);

  // deferred 轮：曝光要等 inject/ack 确认，不能提前落账。
  const deferred = await post('/inject', { ...req, rehearsal: 'deferred' });
  assert.equal(deferred.status, 200);
  assert.equal(deferred.body.policy.recorded, 0);
  assert.equal(deferred.body.policy.deferred, true);
  assert.ok(deferred.body.receipt, '必须签发收据，ack 才有得确认');
  const ack = await post('/inject/ack', { receipt: deferred.body.receipt, chatKey: 'group:42' });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.accepted, true);
});
