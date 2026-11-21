// 记忆检查点（0.25.0，#102 写侧触发）：宿主侧实现的用例。
//
// 被测对象是**宿主** `plugins/memory-vec/index.js`（实现与仓内 adapters 手抄副本分离，
// 见 `_rollback/20261017-before-remember-checkpoint/README.md`）；宿主不存在时整组跳过
//（登记在案的边界，不是遗漏）。每个用例独立子进程 + 临时数据目录 —— 宿主 config.js
// 的 getConfig() 有进程内缓存，同进程改配置不生效。
//
// harness 内嵌在本文件底部（HARNESS_SRC），每个用例写到自己的临时目录里执行：
// 不放成 test/ 下的独立文件，否则它会被 node --test 当测试文件收走，且 helpers-guard
// 的「归属完备」断言会把它当漏网。
//
// 失败形态全是静默的：检查点不出现 = 提醒静默缺席；反过来「每轮都出现」同样是 bug
//（群里刷系统消息 + 提示词预算）。断言必须双向。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

// ── 宿主解析（票 14，2026-10-28 · [by:DS]）──────────────────────────────────
//
// 旧版把 `HOST_INDEX` 写死成 **旧树** `QQ-Agent-整合版-20260922`。而那个路径在本机
// **确实存在** ⇒ `hostAvailable` 恒真、用例从不跳过、**回归一直在测已经没人用的实现**，
// 新树 `纯新树-20261017` 的差异（receipt+ack 排练、检查点落盘键）一条都没被覆盖。
// 「不跳过」在这里比「跳过」更危险：报告全绿，覆盖率是 0。
//
// 现在的口径（复审二轮，2026-10-28 · [by:DS]）：
//   ① `MV_HOST_INDEX` 显式指定 ⇒ **只认它**。它不存在 ⇒ 显式跳过，**绝不回退**到候选 ——
//      回退的后果是"我明明指定了一个不存在的路径，报告却说测过了"，比不测更危险。
//   ② 未指定 ⇒ 只解析**当前消费者**（`CURRENT_HOST`）。不在本机 ⇒ 显式 banner + skip。
//   ③ **旧树不参与默认解析**。上一版把 `[CURRENT, LEGACY]` 当候选列表「取第一个存在的」，
//      只要当前消费者缺失就会静默落到旧树上 —— 正是 F14 那个形态换了个触发条件。
//      旧树现在只出现在跳过文案里，作用是说明"它存在也不算数"。
const CURRENT_HOST = 'E:/Tools/Agents/linfun-agent/plugins/memory-vec/index.js';
const LEGACY_HOST = 'E:/Tools/QQ-Agent-整合版-20260922/plugins/memory-vec/index.js';

function resolveHostIndex() {
  const explicit = String(process.env.MV_HOST_INDEX || '').trim();
  if (explicit) return explicit;          // 显式指定：只认它，存在性由 hostAvailable 判
  return CURRENT_HOST;
}

const HOST_INDEX = resolveHostIndex();
const hostAvailable = Boolean(HOST_INDEX) && fs.existsSync(HOST_INDEX);

// 「找过哪些路径」= 显式指定（若有）+ 当前消费者 + 旧树对照。旧树那行只是为了让跳过
// 文案能回答"我机器上明明有这个插件" ⇒ 标注它**不参与默认解析**。
const SEARCHED = (() => {
  const explicit = String(process.env.MV_HOST_INDEX || '').trim();
  const list = explicit ? [explicit] : [];
  for (const p of [CURRENT_HOST, LEGACY_HOST]) if (!list.includes(p)) list.push(p);
  return list;
})();

const SKIP = hostAvailable
  ? false
  : '宿主插件不在本机（本组用例跳过，**不是通过**）。解析结果：'
    + `${HOST_INDEX || '(空)'}${HOST_INDEX && !fs.existsSync(HOST_INDEX) ? '（不存在）' : ''}`
    + '。可选路径：'
    + SEARCHED.map((p) => `${p}${fs.existsSync(p) ? '（存在）' : '（缺失）'}`).join(' · ')
    + '。用 MV_HOST_INDEX=<plugins/memory-vec/index.js 绝对路径> 指定（显式路径不存在时本组照样跳过，不会回退）。';

if (!hostAvailable) {
  console.error('\n[adapter-checkpoint] ⚠ 找不到宿主插件 —— 本组用例全部跳过，不要把"跳过"读成"通过"。');
  for (const p of SEARCHED) console.error(`   ${fs.existsSync(p) ? '存在' : '缺失'}：${p}`);
  console.error('   指定：$env:MV_HOST_INDEX="<...>/plugins/memory-vec/index.js"\n');
}

/**
 * 子进程入口（见文件底 HARNESS_SRC）：
 *   node <harness> <scenarioJson>
 * scenario = { config, steps }；输出最后一行 `RESULT:[...]`。
 */
async function runScenario(config, steps, dataDir) {
  const own = !dataDir;
  const tmp = own ? fs.mkdtempSync(path.join(os.tmpdir(), 'mv-checkpoint-')) : dataDir;
  try {
    const harness = path.join(tmp, 'checkpoint-harness.mjs');
    fs.writeFileSync(harness, HARNESS_SRC);
    const { stdout } = await run(NODE, [harness, JSON.stringify({ config, steps })], {
      env: { ...process.env, QQ_AGENT_DATA_DIR: tmp, MV_HOST_INDEX: HOST_INDEX },
      maxBuffer: 4 * 1024 * 1024
    });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
    assert.ok(line, `harness 没输出 RESULT（stdout=${stdout.slice(0, 300)}）`);
    return JSON.parse(line.slice('RESULT:'.length));
  } finally {
    if (own) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 本地桩服务：给「错误信封 / 工具结果」用例用，父进程起、子进程 fetch（真实网络往返，不走 mock）。
 * `hits` 记录每条请求的 `METHOD path`，用来证明**某些请求没有发生**（例如矛盾信封不得发
 * `/inject/ack`）。只断言"消息没变"是不够的：采用确认是**另一个副作用**，它不发日志、
 * 不影响回复文本，漏发/错发在消息数组里完全看不出来。
 */
async function startStub(reply) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      let r;
      try { r = reply(req, body); } catch (e) { r = { status: 500, json: { ok: false, error: String(e && e.message || e) } }; }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((ok) => server.close(ok)) };
}

/** 期望的「记人」节前缀。生产文案会改，所以只认哨兵 —— 见 `stripGuide`。 */
const GUIDE_SENTINEL = '<!--mv-guide-->';
const INJECT_SENTINEL = '<!--mv-inject-->';
/** 去掉「记人」常驻节之后的文本 = 这条消息的**真实内容**（哨兵之后全是该节的正文）。 */
const stripGuide = (s) => String(s ?? '').split(GUIDE_SENTINEL)[0].replace(/\s+$/, '');

// ── 票 14：先证明「测的是当前消费者」────────────────────────────────────────
// 这条必须排在最前面。旧版把路径写死成旧树，而旧树在本机存在 ⇒ 永远不跳过、
// 也永远测不到新树。断言方向是**「解析结果必须是当前消费者」**，不是「只要有文件就行」。
test('宿主解析：跑的是当前消费者，不是旧树副本（票 14）', { skip: SKIP }, () => {
  assert.equal(fs.existsSync(HOST_INDEX), true, `解析到的宿主不存在：${HOST_INDEX}`);
  const resolved = path.resolve(HOST_INDEX);
  const explicit = String(process.env.MV_HOST_INDEX || '').trim();
  const isCurrent = resolved === path.resolve(CURRENT_HOST);
  if (!isCurrent) {
    // 允许显式指定（例如验证旧树兼容性），但**必须**来自 env —— 必须是人的决定，不是默认值漂移。
    assert.ok(
      explicit,
      `默认解析到了非当前消费者：${resolved}。当前消费者是 ${CURRENT_HOST}`
        + '（旧树副本存在时不得被默认选中 —— 否则回归测的是已经没人用的实现，而且全绿）'
    );
    console.log(`[adapter-checkpoint] 按 MV_HOST_INDEX 显式指定非当前消费者：${resolved}`);
  } else {
    console.log(`[adapter-checkpoint] 宿主 = 当前消费者 ${resolved}`);
  }
  // 反向对照：**旧树在不在本机都不能进默认路径**。上一版正是把旧树放进候选列表才出的事，
  // 所以这里除了"解析对了"，还要钉住"没走那条路"。
  if (!explicit && fs.existsSync(LEGACY_HOST)) {
    assert.notEqual(resolved, path.resolve(LEGACY_HOST),
      '旧树存在于本机时**也不得**被默认选中（上一版就是这么把 9 条用例全测到旧实现上的）');
  }
});

test('检查点节律：every=N 时第 N 轮首触发，且带哨兵与工具名；触发后重新计数', { skip: SKIP }, async () => {
  const r = await runScenario(
    { rememberCheckpointEvery: 3 },
    [
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },   // ← 触发
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' }    // ← 再触发（重新计数）
    ]
  );
  // 双向：没到点的不出现（防"每轮都注入"），到点的必须出现（防"永远不注入"）
  assert.equal(r[0].added, false, '轮1 不应触发');
  assert.equal(r[1].added, false, '轮2 不应触发');
  assert.equal(r[2].added, true, '轮3 应触发');
  assert.equal(r[3].added, false, '触发后重新计数，轮4 不应触发');
  assert.equal(r[5].added, true, '重新计满 3 轮后应再次触发');
  // 触发形态：user 角色（近因位置）+ 哨兵（复用读侧幂等）+ 是独立追加的消息
  assert.equal(r[2].lastRole, 'user');
  assert.equal(r[2].sentinel, true, '检查点必须带 INJECT_SENTINEL（否则下一 round 的 /inject dup-skip 失效 → 重复注入）');
  assert.equal(r[2].msgCount, 3, '检查点应作为末尾新消息追加（sys+user+检查点）');
});

test('工具循环的后续 round（末条 tool）既不计数也不注入', { skip: SKIP }, async () => {
  const r = await runScenario(
    { rememberCheckpointEvery: 2 },
    [
      { hook: 'before-llm-messages', chatKey: 'g:1', lastRole: 'tool' },
      { hook: 'before-llm-messages', chatKey: 'g:1', lastRole: 'tool' },
      { hook: 'before-llm-messages', chatKey: 'g:1', lastRole: 'tool' }
    ]
  );
  for (const [i, step] of r.entries()) {
    assert.equal(step.added, false, `tool-round 第${i + 1}步不应触发`);
    assert.equal(step.msgCount, 3, '不应往 messages 里加东西');
  }
});

test('after-tool：模型真调了 remember ⇒ 计数清零；其它工具不清', { skip: SKIP }, async () => {
  // every=3：走 2 轮 → remember 调用清零 → 再 2 轮不该触发（若没清零，第 3 轮就到点）
  const r = await runScenario(
    { rememberCheckpointEvery: 3 },
    [
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'after-tool', chatKey: 'g:1', toolName: 'memory-vec__remember' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' }
    ]
  );
  assert.equal(r[1].added, false);
  assert.equal(r[3].added, false, 'remember 调用后应清零（第4步相当于新一轮第1步）');
  assert.equal(r[4].added, false, '清零后第2轮也不该触发');
  // 对照：同样走 2 轮但调的是**别的**工具 → 计数保留，第 3 轮触发
  const r2 = await runScenario(
    { rememberCheckpointEvery: 3 },
    [
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'before-llm-messages', chatKey: 'g:1' },
      { hook: 'after-tool', chatKey: 'g:1', toolName: 'web_search' },
      { hook: 'before-llm-messages', chatKey: 'g:1' }
    ]
  );
  assert.equal(r2[3].added, true, '非 remember 工具不应清零（第3轮应触发）');
});

test('开关：rememberCheckpointEnabled=false ⇒ 永不触发；缺省 ⇒ 开且节律稳定', { skip: SKIP }, async () => {
  const off = await runScenario(
    { rememberCheckpointEnabled: false, rememberCheckpointEvery: 2 },
    Array.from({ length: 5 }, () => ({ hook: 'before-llm-messages', chatKey: 'g:1' }))
  );
  for (const step of off) assert.equal(step.added, false, '开关关了还注入 = 灾难');

  // 缺省 every：**不断言具体数字**（票 14，2026-10-28 · [by:DS]）。
  // 旧树默认 10、新树 `CHECKPOINT_EVERY_DEFAULT` 改成了 4（`index.js:1034`，0.28.0 实测
  // 10 轮太稀）。写死 10 就是又一份"只在旧世代成立"的断言 —— 正是 F14 的成因。
  // 改为断言**节律性质**：12 轮内必须触发、间隔恒定、且不是每轮都触发。
  // 三条一起才排得掉「永不触发」和「每轮注入」这两个反向故障。
  const ROUNDS = 12;
  const dflt = await runScenario(
    {},
    Array.from({ length: ROUNDS }, () => ({ hook: 'before-llm-messages', chatKey: 'g:2' }))
  );
  const hits = dflt.map((s, i) => (s.added ? i + 1 : 0)).filter(Boolean);
  assert.ok(hits.length >= 2, `缺省节律在 ${ROUNDS} 轮内至少触发 2 次（实际 ${hits.length}）；0 次 = 检查点彻底失效`);
  const gaps = hits.slice(1).map((v, i) => v - hits[i]);
  assert.equal(new Set(gaps).size, 1, `节律必须恒定，实测触发于第 ${hits.join(',')} 轮`);
  assert.ok(gaps[0] >= 2, `不得每轮都注入（实测间隔 ${gaps[0]}）`);
  assert.equal(hits[0], gaps[0], `首次触发应正好在第 N 轮（N=间隔），实测第 ${hits[0]} 轮`);
});

test('状态跨进程持久化：触发落盘后，新进程从文件恢复计数而不是从零起', { skip: SKIP }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-checkpoint-persist-'));
  const steps = (n) => Array.from({ length: n }, () => ({ hook: 'before-llm-messages', chatKey: 'g:1' }));
  try {
    // 进程 A：every=2，跑 2 轮 → 第 2 轮触发（turns=0 落盘）
    await runScenario({ rememberCheckpointEvery: 2 }, steps(2), tmp);
    const stateFile = path.join(tmp, 'memory-vec-checkpoint-state.json');
    assert.ok(fs.existsSync(stateFile), '触发后应落盘状态文件');
    // 进程 B：同一数据目录，跑 1 轮 → 不触发（计数从 0 重新起，还没到 2）
    const r = await runScenario({ rememberCheckpointEvery: 2 }, steps(1), tmp);
    assert.equal(r[0].added, false, '新进程的第 1 轮不应触发（触发点已在上个进程消耗）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('未触发也要落盘：热重载（模块级 Map 被清空）后进度不丢，到点仍触发', { skip: SKIP }, async () => {
  // 真实事故（0.26.2）：宿主 `watchPlugins` 对 plugins/ 递归监听，任何文件变动都全量
  // `loadPlugins()` + `import(?t=)` 重新求值 ⇒ 模块级 `checkpointTurns` 清零。旧实现只在
  // **触发时**落盘 ⇒ 计数活不过一次热重载 ⇒ 真实会话永远攒不到 N 轮（实测 138 次
  // checkpoint 全是测试键、两号状态文件根本不存在）。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-checkpoint-persist-mid-'));
  const step = () => ({ hook: 'before-llm-messages', chatKey: 'g:1' });
  try {
    // 进程 A：every=3，只跑 2 轮（未触发）
    const a = await runScenario({ rememberCheckpointEvery: 3 }, [step(), step()], tmp);
    for (const s of a) assert.equal(s.added, false, '第 1-2 轮不该触发');
    const stateFile = path.join(tmp, 'memory-vec-checkpoint-state.json');
    assert.ok(fs.existsSync(stateFile), '未触发也必须落盘计数（否则热重载后从零起，永远到不了 N）');

    // 进程 B（= 热重载后的新模块实例）：同目录再跑 1 轮 ⇒ 累计 3 轮，应触发
    const b = await runScenario({ rememberCheckpointEvery: 3 }, [step()], tmp);
    assert.equal(b[0].added, true, '热重载后应接着数到第 3 轮并触发，而不是从零重新数');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 票 14 复审（2026-10-28 · [by:DS]）：断言对象从「条数」换成「内容」────────────
// 上一版断言 `msgCount === 2` + `sentinelAny === false`。这两条在**改写了最后一条 user
// 内容**时照样绿 —— 而"改写 user 内容"正是注入半截块、或把块塞错位置的形态。
// 复审指出的第二件事：「记人」节（`<!--mv-guide-->`，每轮常驻、独立开关）会让 messages
// 内容**必然**变化，所以"失败 = messages 零变化"是错口径，不能那么写。
//
// 现在的口径：**剥掉「记人」节之后逐字比对**。
//   · 记人节是独立功能 ⇒ 它出现是正常的、被允许的（并要求最多一次）；
//   · 剥掉它之后必须与原始内容**完全相等** ⇒ 任何注入残留都会被抓到。
const roleText = (s, role) => (s.texts || []).filter((m) => m.role === role).map((m) => m.text).join('\n');
const countOf = (s, token) => (String(s).split(token).length - 1);

test('错误信封：500 / ok:false / 空块 ⇒ 内容逐字不变、不发采用确认（票 14 复审）', { skip: SKIP }, async () => {
  const cases = [
    ['http-500', () => ({ status: 500, json: { ok: false, error: 'boom', hint: '服务内部错误' } })],
    ['ok-false', () => ({ status: 200, json: { ok: false, error: 'boom' } })],
    ['ok-true-but-empty', () => ({ status: 200, json: { ok: true, injected: false, block: '', lines: [] } })]
  ];
  for (const [name, reply] of cases) {
    const stub = await startStub(reply);
    try {
      const r = await runScenario(
        { injectEnabled: true, serviceBaseURL: stub.base },
        [{ hook: 'before-llm-messages', chatKey: 'group:1' }]
      );
      const s = r[0];
      const user = roleText(s, 'user');
      assert.equal(stripGuide(user), 'u', `${name}：剥掉记人节后 user 必须逐字等于原文（任何残留 = 注入了半截块）`);
      assert.equal(roleText(s, 'system'), 'sys', `${name}：system 不得被改写`);
      assert.equal(countOf(user, INJECT_SENTINEL), 0, `${name}：不得出现 mv-inject 哨兵`);
      assert.equal(s.msgCount, 2, `${name}：不得追加消息`);
      assert.equal(s.added, false, `${name}：不得出现检查点`);
      // 「记人」节是独立功能，允许出现，但不许重复叠加。
      assert.ok(countOf(user, GUIDE_SENTINEL) <= 1, `${name}：记人节最多一次（重复 = 幂等判据坏了）`);
      // 采用确认是**另一个副作用**：它不发日志、不改消息，只在服务端记账。
      assert.equal(stub.hits.filter((h) => h.includes('/inject/ack')).length, 0, `${name}：错误信封不得发采用确认`);
    } finally {
      await stub.close();
    }
  }
});

test('矛盾信封：ok:false + injected:true + 非空 block ⇒ 不注入、不发采用确认（票 14 复审）', { skip: SKIP }, async () => {
  // 这个组合是真实故障形态：服务端内部已经判失败（ok:false），但残留的 block 是上一轮的
  // 非空值（或某个分支提前写了 block 又回滚了 ok）。只认 `injected` 的实现会把这段
  // **伪造的属性段**塞进 user 消息，并向服务端确认"已采用" —— 后者的后果是排练计数
  // 被凭空 +1，短期层的升长期判据被污染，而现场只表现为"这轮回复有点怪"。
  const envelope = (ok) => () => ({
    status: 200,
    json: {
      ok,
      injected: true,
      block: '<!--mv-inject-->\n伪造属性段',
      lines: ['伪造属性段'],
      receipt: 'r-contradiction',
      error: ok ? undefined : '内部错误'
    }
  });

  const bad = await startStub(envelope(false));
  let badHits;
  try {
    const r = await runScenario(
      { injectEnabled: true, serviceBaseURL: bad.base },
      [{ hook: 'before-llm-messages', chatKey: 'group:1' }, { wait: 400 }]
    );
    const s = r[0];
    const user = roleText(s, 'user');
    assert.equal(stripGuide(user), 'u', '★ 矛盾信封：user 内容必须逐字不变（ok:false 就是失败，block 作废）');
    assert.equal(countOf(user, INJECT_SENTINEL), 0, '★ 矛盾信封：不得出现 mv-inject 哨兵');
    assert.equal(s.msgCount, 2);
    assert.ok(!user.includes('伪造属性段'), '★ 矛盾信封：伪块文本一个字节都不许进 messages');
    badHits = bad.hits;
    assert.equal(badHits.filter((h) => h.includes('/inject/ack')).length, 0,
      '★ 矛盾信封：不得发采用确认（发了 = 排练计数凭空 +1，升长期判据被污染）');
  } finally {
    await bad.close();
  }

  // ── 突变对照（不改成产代码也能证明这条测试有牙）──────────────────────────
  // 同一个信封、**只把 ok 翻成 true**：其余字段逐字相同。
  //   · 若实现只看 `injected`/`block`，上面那条会红；
  //   · 若实现看 `ok`，下面这条必须注入并确认 ⇒ 两条一起才排得掉"恒不注入"的哑实现。
  const good = await startStub(envelope(true));
  try {
    const r = await runScenario(
      { injectEnabled: true, serviceBaseURL: good.base },
      [{ hook: 'before-llm-messages', chatKey: 'group:1' }, { wait: 400 }]
    );
    const s = r[0];
    const user = roleText(s, 'user');
    assert.equal(s.msgCount, 2, '对照：成功信封同样是「改写」，不是「追加」');
    assert.equal(countOf(user, INJECT_SENTINEL), 1, '对照：ok:true 时块必须进去（否则上面那条是哑断言）');
    assert.ok(user.includes('伪造属性段'), '对照：ok:true 时块正文必须在');
    assert.equal(good.hits.filter((h) => h.includes('/inject/ack')).length, 1,
      '对照：成功信封**必须**发采用确认 —— 否则上面"不得发"那条在"永远不会发"的实现上也绿');
  } finally {
    await good.close();
  }
});

test('注入位置：成功信封 ⇒ 追加到最后一条 user，不新增消息（票 14）', { skip: SKIP }, async () => {
  const stub = await startStub(() => ({
    status: 200,
    json: { ok: true, injected: true, block: '<!--mv-inject-->\n测试属性段', lines: ['测试属性段'] }
  }));
  try {
    const r = await runScenario(
      { injectEnabled: true, serviceBaseURL: stub.base },
      [{ hook: 'before-llm-messages', chatKey: 'group:1' }]
    );
    const s = r[0];
    const user = roleText(s, 'user');
    // ⚠️ 落点是**最后一条 user**，不是 system —— 函数名 `appendToLastSystem`
    // （`index.js:943`）是历史命名，实现是 `lastUserIndex(...) ?? lastSystemIndex(...)`，
    // 而 `index.js:1131` 的注释写的也是"追加进最后一个 user"。按名字断言就会测错。
    // 这条断言的价值就在这里：把"名字说的是 A、做的是 B"钉住，改实现时先看这句话。
    assert.equal(s.msgCount, 2, '注入是「改写已有消息」，不是「追加一条新消息」');
    assert.equal(s.sentinelUser, true, '块必须落在最后一条 user 上（近因位置，与检查点同一套设计）');
    assert.equal(s.sentinelSys, false, 'system 不得被改写（改写 system 会污染本轮全部 round 的指令层）');
    assert.equal(s.lastRole, 'user');
    // 内容级：块是**拼在原有文本之后**的，原文一个字都不能被吃掉。
    // 顺序是「注入先、记人节后」（钩子里 `injectMemories` 先跑、`maybeCheckpoint` 后跑）
    // ⇒ 剥掉记人节之后剩下的必须**正好**是「原文 + 空行 + 服务端块」。
    assert.equal(stripGuide(user), 'u\n\n<!--mv-inject-->\n测试属性段',
      '剥掉记人节后必须是原文 + 块，一字不多一字不少');

  } finally {
    await stub.close();
  }
});

// ── 票 14 复审 · A3：两个注册工具的**结果语义**────────────────────────────────
// 复审原话：「验证 remember/search 注册工具的成功、错误结果语义；现有新树插件 selftest
// 可以引用和运行，避免重复证明。」
// ⇒ 分工：`plugins/memory-vec/selftest.mjs`（宿主侧 70 项）负责**文案细节与 outbox 队列**，
//   这里只钉**消费者看得见的三件事**：注册面（模型能看到两个工具）、成功与失败在结果里
//   **可区分**（`isError` + 文案不许自相矛盾）、以及"服务不可达"与"确实没有"不许同形。
//   重复证明没有价值，但"两处都不断言"有价值差 —— 这三件正是模型读得到、错了就会编的那部分。
test('工具注册面：模型能看到 remember / search 两个工具（票 14 · A3）', { skip: SKIP }, async () => {
  const r = await runScenario({}, [{ hook: 'before-llm-messages', chatKey: 'group:1' }]);
  assert.deepEqual(r[0].tools.slice().sort(), ['page', 'remember', 'search'],
    '注册面变了 ⇒ 提示词里点名的 memory-vec__remember / memory-vec__search 会失配（静默）');
});

test('remember 结果语义：成功/去重/语义拒绝/服务故障四种必须可区分（票 14 · A3）', { skip: SKIP }, async () => {
  const toolStep = (args) => ({ tool: 'remember', args, chatKey: 'group:1' });

  // ① 成功：ok:true + text ⇒ 无 isError，文案说明记下了
  {
    const stub = await startStub(() => ({
      status: 200, json: { ok: true, kind: 'preference', text: '喜欢买断制单机', action: 'append' }
    }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep({ userId: '1353446252', text: '喜欢买断制单机' })]);
      const res = r[0].result;
      assert.equal(res.isError, undefined, '① 成功不得带 isError（带 = 模型会重试同一条）');
      assert.match(res.content, /记下了/, '① 成功文案必须说明已记下');
      assert.equal(r[0].outboxLines, 0, '① 成功不得入补发队列');
    } finally { await stub.close(); }
  }

  // ② 去重：ok:true + action:noop ⇒ **不是错误**，但文案必须与"新记一条"不同
  {
    const stub = await startStub(() => ({ status: 200, json: { ok: true, action: 'noop', kind: 'preference' } }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep({ userId: '1353446252', text: '喜欢买断制单机' })]);
      const res = r[0].result;
      assert.equal(res.isError, undefined, '② 去重是正常结果，不是失败');
      assert.match(res.content, /已经记过/, '② 文案必须与"记下了"可区分（否则模型以为写了两条）');
    } finally { await stub.close(); }
  }

  // ③ 4xx 语义拒绝：明确失败 + **不入队**（入了就是队头阻塞，重试多少次都一样）
  {
    const stub = await startStub(() => ({ status: 400, json: { ok: false, error: '认不出这个 QQ 号' } }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep({ userId: '1353446252', text: 'x' })]);
      const res = r[0].result;
      assert.equal(res.isError, true, '③ 4xx 必须 isError（写路径不许静默）');
      assert.match(res.content, /没记住/);
      assert.match(res.content, /认不出这个 QQ 号/, '③ 原因必须回给模型，否则它会原样重试');
      assert.equal(r[0].outboxLines, 0, '③ 语义拒绝不得入队（会堵住后面的补发）');
    } finally { await stub.close(); }
  }

  // ④ 5xx：明确失败 + **入队暂存**（这是 ③ 与 ④ 唯一的分界，也是最容易写反的地方）
  {
    const stub = await startStub(() => ({ status: 500, json: { ok: false, error: 'db is locked' } }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep({ userId: '1353446252', text: '喜欢买断制单机' })]);
      const res = r[0].result;
      assert.equal(res.isError, true, '④ 5xx 必须 isError');
      assert.match(res.content, /暂存/, '④ 必须告诉模型"已暂存、不必重记"（否则它会连写三条）');
      assert.equal(r[0].outboxLines, 1, '④ 5xx 必须落进补发队列（服务恢复后自动补记）');
    } finally { await stub.close(); }
  }
});

test('search 结果语义：「服务不可达」与「确实没有」不许同形（票 14 · A3）', { skip: SKIP }, async () => {
  const toolStep = { tool: 'search', args: { q: '上周谁提过搬家' }, chatKey: 'group:1' };

  // ① 命中
  {
    const stub = await startStub(() => ({
      status: 200,
      json: { ok: true, scanned: 12, hits: [{ text: '上周三提过要搬家', when: Date.now(), chatKey: 'group:1', score: 0.82 }] }
    }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep]);
      const res = r[0].result;
      assert.equal(res.isError, undefined);
      assert.match(res.content, /语义检索命中 1 条/, '① 命中条数必须回给模型');
      assert.match(res.content, /上周三提过要搬家/, '① 片段正文必须在（模型要靠它答）');
    } finally { await stub.close(); }
  }

  // ② 真空结果：**不是错误**，但文案必须点名"别编"
  {
    const stub = await startStub(() => ({ status: 200, json: { ok: true, scanned: 12, hits: [] } }));
    try {
      const r = await runScenario({ serviceBaseURL: stub.base }, [toolStep]);
      const res = r[0].result;
      assert.equal(res.isError, undefined, '② 空结果是正常结果，不是失败');
      assert.match(res.content, /没有命中/, '② 空结果必须明说没命中');
      assert.match(res.content, /不要编/, '② 必须同时给出"别编"的指令（否则模型自己补一段）');
    } finally { await stub.close(); }
  }

  // ③ 服务不可达：**isError**，且文案里**不许出现"没有命中"** ——
  //    否则模型把"服务没起"读成"这段记忆不存在"，然后开始编。这正是 F14 那类静默失败。
  {
    const dead = await startStub(() => ({ status: 200, json: { ok: true, hits: [] } }));
    const deadBase = dead.base;
    await dead.close();      // 端口关掉 ⇒ 连接被拒（立刻失败，不会等到 8s 超时）
    const r = await runScenario({ serviceBaseURL: deadBase }, [toolStep]);
    const res = r[0].result;
    assert.equal(res.isError, true, '③ 服务不可达必须 isError');
    assert.ok(!/没有命中/.test(res.content), '★ ③ 不得把"服务没起"说成"没有命中"（那是诱导模型编造）');
    assert.match(res.content, /连不上|检索失败/, '③ 必须说清是服务的问题');
  }
});


// 为什么必须子进程：宿主 `src/config.js` 的 `getConfig()` 有**进程内缓存**
//（`currentConfig` 只在首次调用时读盘），同一进程里改 config.json 不会生效；
// 而检查点的开关/节律都读 config ⇒ 每个场景一个干净进程 + 一个临时数据目录。
// ⚠️ 全程不用反引号模板串 —— 这段要作为普通字符串内嵌在本文件里。
const HARNESS_SRC = [
  "// 记忆检查点测试的子进程入口（由 test/adapter-checkpoint.mjs 内嵌并写入临时目录）。",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "",
  "const scenario = JSON.parse(process.argv[2] || '{}');",
  "const dataDir = process.env.QQ_AGENT_DATA_DIR;",
  "if (!dataDir) { console.error('QQ_AGENT_DATA_DIR 未设置'); process.exit(2); }",
  "",
  "fs.mkdirSync(dataDir, { recursive: true });",
  "const scenarioCfg = scenario.config || {};",
  "fs.writeFileSync(",
  "  path.join(dataDir, 'config.json'),",
  "  JSON.stringify({ skills: { 'memory-vec': { injectEnabled: false, ...scenarioCfg } } })",
  ");",
  "",
  "// ⚠️ 被测对象是**宿主侧实现**（plugins/memory-vec/index.js，领先副本），",
  "// 不是仓内 adapters/qq-agent/index.js（旧世代手抄副本，见该目录 README 的兼容范围）。",
  "// 路径由父进程解析后经 env 传入 —— **不在这里留任何默认值**：留一个默认值就等于",
  "// 留一条\"悄悄测错对象\"的路径（票 14 的成因就是默认值指向了旧树）。",
  "const HOST_INDEX = String(process.env.MV_HOST_INDEX || '').trim();",
  "if (!HOST_INDEX) { console.error('MV_HOST_INDEX 未设置'); process.exit(4); }",
  "let mod;",
  "try {",
  "  mod = await import('file:///' + HOST_INDEX.split('\\\\').join('/'));",
  "} catch (e) {",
  "  console.error('HOST_INDEX_IMPORT_FAIL', String(e && e.message || e));",
  "  process.exit(3);",
  "}",
  "",
  "// ★ 新树差异（票 14）：新树把配置出口换成 `api.config()`（`index.js:171`），",
  "// 不再 `import '../../src/config.js'` 读盘。只写 config.json **不生效** ⇒",
  "// `mvCfg()` 恒为 `{}` ⇒ `rememberCheckpointEvery` 取默认 10 ⇒ 测试里 every=3",
  "// 一条都不触发，而报告看起来只是\"检查点没工作\"。必须走契约出口 `setup(api)`。",
  "// 旧树没有这条依赖，多调一次无害（它的 mvCfg 仍读盘）。",
  "// ★ 工具表必须**真收下来**（票 14 复审 · A3）：只回 `true` 的话，`registerTool`",
  "// 有没有被调用、注册了什么 id、execute 在不在，全都没人看得见 —— 而这些正是",
  "// 提示词里点名 `memory-vec__remember` 的前提。",
  "const toolMap = new Map();",
  "if (typeof mod.setup === 'function') {",
  "  try {",
  "    mod.setup({",
  "      registerTool: (t) => { if (t && t.id) toolMap.set(String(t.id), t); return true; },",
  "      registerView: () => true,",
  "      config: () => ({ injectEnabled: false, ...scenarioCfg })",
  "    });",
  "  } catch (e) {",
  "    console.error('HOST_SETUP_FAIL', String(e && e.message || e));",
  "    process.exit(5);",
  "  }",
  "}",
  "",
  "// 补发队列：落在 `QQ_AGENT_DATA_DIR`（= 本临时目录）。它是\"写失败但暂存了\"的唯一",
  "// 证据，也是 4xx / 5xx 分界的唯一可观测差别（前者不入队、后者入队）。",
  "const outboxFile = path.join(dataDir, 'memory-vec-outbox.jsonl');",
  "const outboxLines = () => {",
  "  try {",
  "    return fs.readFileSync(outboxFile, 'utf8').split(String.fromCharCode(10)).filter((l) => l.trim()).length;",
  "  } catch { return 0; }",
  "};",
  "",
  "const out = [];",
  "for (const step of scenario.steps || []) {",
  "  if (step.wait) { await new Promise((r) => setTimeout(r, Number(step.wait) || 0)); continue; }",
  "  if (step.tool) {",
  "    const t = toolMap.get(String(step.tool));",
  "    if (!t) { out.push({ tool: step.tool, missing: true }); continue; }",
  "    const res = await t.execute({ chatKey: step.chatKey || 'group:10000' }, step.args || {});",
  "    out.push({",
  "      tool: step.tool,",
  "      result: { content: String(res?.content ?? ''), isError: res?.isError },",
  "      outboxLines: outboxLines(),",
  "      tools: [...toolMap.keys()]",
  "    });",
  "    continue;",
  "  }",
  "  if (step.hook === 'after-tool') {",
  "    await mod.hooks['after-tool']({ toolName: step.toolName, chatKey: step.chatKey, result: { isError: Boolean(step.isError) } });",
  "    out.push({ hook: 'after-tool' });",
  "    continue;",
  "  }",
  "  const messages = [{ role: 'system', content: 'sys' }];",
  "  if (step.lastRole === 'tool') {",
  "    messages.push({ role: 'user', content: 'u' }, { role: 'tool', content: 'r' });",
  "  } else {",
  "    messages.push({ role: 'user', content: 'u' });",
  "  }",
  "  await mod.hooks['before-llm-messages']({ messages, chatKey: step.chatKey || 'group:10000' });",
  "  const last = messages[messages.length - 1];",
  "  const txt = (m) => String((m && m.content) || '');",
  "  const sysAll = messages.filter((m) => m.role === 'system').map(txt).join('\\n');",
  "  const userAll = messages.filter((m) => m.role === 'user').map(txt).join('\\n');",
  "  out.push({",
  "    added: txt(last).includes('mv-inject') && txt(last).includes('回头想想'),",
  "    sentinel: txt(last).includes('mv-inject'),",
  "    sentinelAny: messages.some((m) => txt(m).includes('mv-inject')),",
  "    sentinelSys: sysAll.includes('mv-inject'),",
  "    sentinelUser: userAll.includes('mv-inject'),",
  "    lastRole: last && last.role,",
  "    msgCount: messages.length,",
  "    // ★ 内容级断言的原料：父进程要能**逐字比对**，不能只数条数（票 14 复审）。",
  "    texts: messages.map((m) => ({ role: m && m.role, text: txt(m) })),",
  "    tools: [...toolMap.keys()]",
  "  });",
  "}",
  "",
  "process.stdout.write('\\nRESULT:' + JSON.stringify(out) + '\\n');",
  ""
].join('\n');
