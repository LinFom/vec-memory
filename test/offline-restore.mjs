// test/offline-restore.mjs —— 离线备份/恢复**验收矩阵**（新票 01 / 旧票 16 · [by:DS] 2026-10-29）
//
// ══ 为什么这个测试长成"跑另一个进程"的样子 ════════════════════════════════════
// 被验收的工具（`tools/offline-verify.mjs` / `offline-backup.mjs`）**本身就是 CLI**：
// 它们的判据是「退出码 + 报告里点名了哪个原因」，而这两样只有在独立进程里才成立
// （同进程 import 进去就没有"进程退出码"这回事，而退出码正是自动化恢复唯一会看的东西）。
//
// 所以这里用 `execFile` 跑 `tools/offline-restore-drill.mjs` —— 矩阵本体留在工具里，
// 因为它也是**人**要跑的东西（恢复现场没有人会 `node --test`）。本文件只负责三件事：
//   ① 把"矩阵必须全绿"钉进 `npm test`，从此假通过不能只靠人去跑一次；
//   ② 钉住**用例清单**（`EXPECTED_IDS`）：矩阵全绿但用例被删光，退出码照样是 0；
//   ③ 钉住复审点名的**具体失败形态**都有对应用例（`REVIEW_FORMS`）—— 修好了却没人再试，
//      等于把"已修"变成一个传说。
//
// ══ 判据为什么不是"退出码 0 就行" ═══════════════════════════════════════════
// 退出码 0 只说明"矩阵自己认为全过"。矩阵自己的 `record()` 也可能被改成恒真
// （这不是假想：上一版 `offline-verify` 的结论就是"没抛异常"）。所以这里**同时**要求：
//   · `rows` 的 id 集合与 `EXPECTED_IDS` **完全相等**（多一条少一条都红）；
//   · 每条反例的 `want` 里必须有 `exit=1` **且**点名了原因（只判退出码不算判据）；
//   · 每条护栏的 `want` 里必须是 `exit=2`（用法错误不能和"副本坏"混成同一个码）。
//
// 运行：node --test test/offline-restore.mjs（或 npm test）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DRILL = path.join(ROOT, 'tools', 'offline-restore-drill.mjs');

// ── 用例清单：**钉死**。改矩阵必须同时改这里（红是故意的，不是麻烦）───────────
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const EXPECTED_IDS = [...ids('P', 11), ...ids('N', 34), ...ids('G', 7)];
const EXPECTED_COUNTS = { total: 52, pass: 52, fail: 0, positive: 11, negative: 34, guard: 7 };

/**
 * 复审（round2-review）点名的失败形态 → 必须存在的用例。
 * 上一版的矩阵只有 3 条反例，而复审实际打穿它的是「哈希全对、内容全坏、缺活动代」——
 * 那三条里一条都没有。第二轮的集成缺口（新资产归 unclassified、只复制不验证）
 * 也在这张表里各有一条：**没有用例的"已修"只是一个传说**。
 */
const REVIEW_FORMS = [
  ['哈希全部一致、事实/事件内容坏 ⇒ 必须非零退出', ['N1']],
  ['哈希全部一致、沿革/备注坏 ⇒ 必须非零退出', ['N3', 'N4']],
  ['活动代不存在（缺活动代）⇒ 必须非零退出', ['N11']],
  ['事件行缺字段（不只是"数非空行"）⇒ 必须非零退出', ['N6']],
  ['outbox 有坏行（不只是"计数"）⇒ 必须非零退出', ['N8']],
  ['游标 / 待补窗口形状坏 ⇒ 必须非零退出', ['N5', 'N7']],
  ['向量尺寸、alive、编码、代指针 ⇒ 必须非零退出', ['N9', 'N10', 'N12', 'N13']],
  ['未完成 journal 必须被回放，且重复打开幂等', ['P7', 'P8', 'P9']],
  ['清单路径越界（../ 盘符 绝对路径 junction）⇒ 拒绝', ['N18', 'N24']],
  ['空的新库合法（不强制必须已有事实行）', ['P1']],
  ['恢复后要比**具体值**，不是比零计数', ['P6']],
  ['工具失败不得改动源库与备份', ['G6']],
  // ── R2：核心 v1 新资产的集成缺口 ──────────────────────────────────────
  ['人工修订日志：截断 / 链断 / 未知 op / 重复 operationId ⇒ 必须非零退出', ['N25', 'N26', 'N27', 'N28']],
  ['主体事务：观察悬空 / 合并悬空 / 未知版本 ⇒ 必须非零退出', ['N29', 'N30', 'N31']],
  ['可见性基线被改成别的策略 ⇒ 必须非零退出', ['N32']],
  ['冻结观察请求：缺必填字段 / 指向未登记主体 ⇒ 必须非零退出', ['N33', 'N34']],
  ['省略目标实例根 ⇒ 未验收（identity 未知不得记为通过）', ['G7']],
  ['恢复后新资产**真的可用**（隐藏/替换/恢复、合并解析、冻结请求）', ['P11']]
];

let cached = null;
/** 跑一次矩阵（同一文件内多个用例共用，避免重复 40 条用例的开销）。 */
function drill() {
  if (!cached) {
    cached = (async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-restore-test-'));
      const jsonPath = path.join(tmp, 'drill.json');
      let code = 0;
      let out = '';
      try {
        const r = await run(process.execPath, [DRILL, `--json=${jsonPath}`], {
          cwd: ROOT, maxBuffer: 64 * 1024 * 1024
        });
        out = `${r.stdout}${r.stderr}`;
      } catch (e) {
        code = e.code ?? -1;
        out = `${e.stdout || ''}${e.stderr || ''}`;
      }
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* 下面断言会点名 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 交给系统 */ }
      return { code, out, payload, jsonPath };
    })();
  }
  return cached;
}

const tail = (s, n = 1200) => (s.length > n ? `…${s.slice(-n)}` : s);

test('离线恢复验收矩阵', async (t) => {
  const { code, out, payload } = await drill();

  await t.test('矩阵退出 0', () => {
    assert.equal(code, 0, `矩阵未全绿（exit=${code}）—— 任一条反例被放行都会走到这里：\n${tail(out)}`);
    assert.match(out, /矩阵全通过/, '缺少"矩阵全通过"汇总行');
  });

  await t.test('--json 结果确实落盘（判定不能只靠 stdout 里的自述）', () => {
    assert.ok(payload, '没写到 --json 指定的文件 —— 测试将无法核对用例清单');
    assert.equal(payload.crashed, null, `演练自身崩溃：${payload.crashed}`);
  });

  await t.test('用例清单完整：没有被静默删掉的一条', () => {
    const got = payload.rows.map((r) => r.id).sort();
    const want = [...EXPECTED_IDS].sort();
    assert.deepEqual(got, want, `用例集合与清单不一致（退出码 0 也可能是"用例被删光了"）`);
  });

  await t.test('每条用例都 ok，且分类计数与清单一致', () => {
    const bad = payload.rows.filter((r) => !r.ok);
    assert.deepEqual(bad.map((r) => `${r.id} ${r.what} 期望 ${r.want} / 实测 ${r.got}`), [],
      '有用例未通过');
    assert.deepEqual(payload.counts, EXPECTED_COUNTS, '分类计数漂了（正例/反例/护栏条数变了要同步更新清单）');
  });

  await t.test('反例都"点名了原因"，不是只靠退出码蒙过', () => {
    // 一个例外，登记在案：N20 = **清单本身不在**。此时工具连"要核什么"都不知道，
    // 属于"拒绝执行"（exit 2）而不是"副本被判坏"（exit 1）。两者对自动化的意义不同：
    // exit 1 = 这份副本不能用；exit 2 = 你指错了目录/参数。**只许这一个例外**。
    const EXIT2_ALLOWED = new Map([['N20', '清单缺失 ⇒ 拒绝执行（exit 2），不是"验收失败"']]);
    const weak = payload.rows.filter((r) => /^N/.test(r.id) && !EXIT2_ALLOWED.has(r.id) && !/exit=1/.test(String(r.want)));
    assert.deepEqual(weak.map((r) => [r.id, String(r.want)]), [], '反例必须期望 exit=1');
    const stray = [...EXIT2_ALLOWED.keys()].filter((id) => payload.rows.find((r) => r.id === id && /exit=2/.test(String(r.want))) === undefined);
    assert.deepEqual(stray, [], `登记为 exit=2 的用例必须真的是 exit=2：${EXIT2_ALLOWED.get('N20')}`);
    // `want` 形如 `exit=1 + 格式校验 + facts/slots.jsonl`；只有 `exit=1` 一段说明只判了码
    const noReason = payload.rows.filter((r) => /^N/.test(r.id) && !EXIT2_ALLOWED.has(r.id) && String(r.want).split('+').length < 2);
    assert.deepEqual(noReason.map((r) => r.id), [], '反例必须**点名原因**（拿"哈希不符"去拒绝"schema 坏"也算拒绝，但那是运气）');
    // 护栏分两种，不能混成一条规则：
    //   ① CLI 用法错误 ⇒ exit 2（G1–G5）；
    //   ② **跨用例不变量** ⇒ 不是一次 CLI 调用，没有退出码可比（G6 = 整场演练没改动源库）。
    //      这种最容易被写成"只要没抛异常就算过"，所以这里钉住它的 `want` 必须是指纹比对。
    const INVARIANT_GUARDS = new Map([['G6', '指纹一致']]);
    const weakGuard = payload.rows.filter((r) => /^G/.test(r.id)
      && !INVARIANT_GUARDS.has(r.id) && !/exit=[12]/.test(String(r.want)));
    assert.deepEqual(weakGuard.map((r) => [r.id, String(r.want)]), [], '护栏必须期望 exit=1 或 2（用法错误不能算"通过"）');
    for (const [id, want] of INVARIANT_GUARDS) {
      const row = payload.rows.find((r) => r.id === id);
      assert.equal(row?.want, want, `${id} 是不变量护栏，必须比指纹（或它的口径被改了 ⇒ 同步改这里）`);
    }
  });

  await t.test('复审点名的每种失败形态都还有用例守着', () => {
    const byId = new Map(payload.rows.map((r) => [r.id, r]));
    const missing = [];
    for (const [form, need] of REVIEW_FORMS) {
      for (const id of need) {
        const row = byId.get(id);
        if (!row) missing.push(`${form} ⇒ 缺用例 ${id}`);
        else if (!row.ok) missing.push(`${form} ⇒ ${id} 未通过（${row.got}）`);
      }
    }
    assert.deepEqual(missing, [], '复审的失败形态失去了守卫 —— 修好之后没人再试，就等于没修');
  });

  await t.test('正例都真的通过了（不是"跳过即通过"）', () => {
    const pos = payload.rows.filter((r) => /^P/.test(r.id));
    assert.equal(pos.length, EXPECTED_COUNTS.positive);
    assert.deepEqual(pos.filter((r) => !r.ok).map((r) => r.id), []);
    // P1 是"合法空库"：它证明工具**不会**因为"没有事实行"就拒绝一个正常的新库
    assert.match(pos.find((r) => r.id === 'P1').what, /空库/, 'P1 必须是空库用例');
  });
});
