// test/inject-scope.mjs — 属性段的**场合策略**（ADR-0037）：单向闸门 + 同级降权
//
// 为什么必须单独一个文件、而不是并进 test/inject.mjs：
// 这一层的失败形态**全是静默的**，纯函数层的旧用例一条都拦不住：
//   · 私密内容上浮到群里 —— 注入照样成功、条数照样对，**只是内容社死**；
//   · 跨场合候选挤掉同场合候选 —— 注入条数不变，"该出现的那条"被换成了别处的弱证据；
//   · `nowScope` 传空串却仍然放行 —— 等于场合隔离整个失效，且没有任何报错。
// 所以这里的断言必须**双向**：既要证明"该挡的挡住了"，也要证明"该留的留下来了"。
// 只验前一半 ⇒ 把整段注入真空化也能全绿（本仓栽过两次的"假通过"形态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInjectCandidates, selectInjectLines, scopePolicyFor, scopeCensus,
  SCOPE_DOWNGRADE_FACTOR, SCOPE_DOWNGRADE_FACTOR as F
} from '../src/core/inject.mjs';

const SAME = 'group:C1';          // 当前所在群
const OTHER_GROUP = 'group:C9';   // 另一个群（公开场合，同级）
const PRIVATE = 'private:C2';     // 私聊（私密级别，更低）

function stubNormalizer(map = {}) {
  return {
    resolveKnown(id) { return map[String(id)] ?? null; },
    _resolveTerm(surface) { return map[String(surface)] ?? { known: false }; }
  };
}

const N = stubNormalizer({
  '123456': { id: 'qq:123456', label: 'P7', kind: 'person' },
  '阿七': { label: 'P7', kind: 'person', known: true }
});

const PEOPLE = [{ id: '123456', name: '阿七' }];

let seq = 0;
/** 造一条**能通过渲染**的槽（`text` 走通用分支；`caliber` 非空 ⇒ 不折半，数字好算）。 */
function row(scope, text, over = {}) {
  seq += 1;
  return {
    key: `k${seq}␀P7␀topic␀${scope}`,
    speaker: 'P7',
    target: '',
    fact_kind: 'topic',
    scope,
    content: { text },
    evidence_n: 1,
    rev: 1,
    caliber: 'evidence-max',
    ...over
  };
}

// ── ① 策略矩阵：判据本身 ─────────────────────────────────────────────────────

test('scopePolicyFor：同场合 / 同级跨场合 / 私密上浮 / 公开下沉 四象限', () => {
  // 同场合 ⇒ same
  assert.equal(scopePolicyFor({ slotScope: SAME, nowScope: SAME }), 'same');

  // 同级跨场合（群↔群）⇒ 降权
  assert.equal(scopePolicyFor({ slotScope: OTHER_GROUP, nowScope: SAME }), 'downgrade');

  // 🔒 私密上浮到公开 ⇒ **挡**（这是社死的那一侧，唯一硬闸）
  assert.equal(scopePolicyFor({ slotScope: PRIVATE, nowScope: SAME }), 'blocked');

  // 公开下沉到私密 ⇒ **允许**（群里说过的话，私聊里提不社死）——单向性
  assert.equal(scopePolicyFor({ slotScope: OTHER_GROUP, nowScope: PRIVATE }), 'downgrade');
  assert.equal(scopePolicyFor({ slotScope: SAME, nowScope: PRIVATE }), 'downgrade');

  // 私↔私 属同级
  assert.equal(scopePolicyFor({ slotScope: 'private:C3', nowScope: PRIVATE }), 'downgrade');
});

test('scopePolicyFor：SELF 不受限；场合不明/槽无场合 ⇒ fail-closed', () => {
  // bot 自己的槽 —— 隐私边界保护的是**他人**（与 profileScopeAllowed 同一理由）
  assert.equal(scopePolicyFor({ slotScope: PRIVATE, nowScope: SAME, isSelf: true }), 'same');

  // 传了 nowScope 但为空 ⇒ 场合不明 ⇒ 挡（不能证明在场的人没变）
  assert.equal(scopePolicyFor({ slotScope: SAME, nowScope: '' }), 'blocked');
  assert.equal(scopePolicyFor({ slotScope: PRIVATE, nowScope: '' }), 'blocked');

  // 槽没记场合 ⇒ 不猜
  assert.equal(scopePolicyFor({ slotScope: '', nowScope: SAME }), 'blocked');
  assert.equal(scopePolicyFor({ slotScope: null, nowScope: SAME }), 'blocked');

  // 认不出级别 ⇒ 保守挡
  assert.equal(scopePolicyFor({ slotScope: 'weird:X1', nowScope: SAME }), 'blocked');

  // **策略未启用**（undefined/null）= 纯函数单测口子，向后兼容
  assert.equal(scopePolicyFor({ slotScope: PRIVATE }), 'same');
  assert.equal(scopePolicyFor({ slotScope: PRIVATE, nowScope: null }), 'same');
});

// ── ② 真数据形态：私密内容不得上浮 ───────────────────────────────────────────
//
// 样本取自 A 号实测（P5539 的槽），逐字复刻 —— 造"能出现但不该出现"的东西，
// 而不是造一条无害文本然后断言"它没出现"（那样的用例恒真，测不出东西）。

const SENSITIVE = '反复给我生成软色情图（自称三张）并数着数，还想给我加「爱分享自己软色情图」的设定，属试探型，得软着拒。';

test('buildInjectCandidates：私聊来源的敏感内容**不进群聊候选**（真样本）', () => {
  const winners = [
    row(SAME, '在这个群常聊插件开发与知识库'),
    row(PRIVATE, SENSITIVE, { evidence_n: 50 })   // 证据量极高 ⇒ 若漏挡，它必定排第一
  ];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });

  assert.equal(cands.length, 1, '私聊那条必须整条消失（不是降权、不是排后面）');
  assert.ok(!cands.some((c) => c.line.includes('软色情')), '敏感内容不得出现在候选里');
  assert.ok(cands[0].line.includes('插件开发'), '同场合那条要留下（双向断言）');
});

test('buildInjectCandidates：跨群候选降权 + 标记 scopeRank', () => {
  const winners = [row(OTHER_GROUP, '他爱画同框图', { evidence_n: 10 })];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });

  assert.equal(cands.length, 1);
  assert.equal(cands[0].scopeRank, 1, '跨场合 ⇒ scopeRank 1');
  assert.equal(cands[0].credibility, 10 * F, `可信度按 ${F} 折`);
  assert.ok(SCOPE_DOWNGRADE_FACTOR > 0 && SCOPE_DOWNGRADE_FACTOR < 1, '折扣必须在 (0,1) 内');
});

test('buildInjectCandidates：同场合候选 scopeRank=0 且不折可信度', () => {
  const winners = [row(SAME, '常聊插件开发', { evidence_n: 10 })];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });
  assert.equal(cands[0].scopeRank, 0);
  assert.equal(cands[0].credibility, 10, '同场合不折');
});

test('buildInjectCandidates：nowScope 缺省 ⇒ 不施加策略（向后兼容旧调用方）', () => {
  const winners = [row(PRIVATE, SENSITIVE), row(OTHER_GROUP, '别处的事')];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N });
  assert.equal(cands.length, 2, 'undefined = 策略未启用');
  assert.ok(cands.every((c) => c.scopeRank === 0));
});

// ── ③ 排序主键：跨场合**不许挤掉**同场合 ─────────────────────────────────────
//
// 这是本次改动最容易"看起来对、其实错"的一处：
// 降权只是打折（0.6），而"在别的群提了 20 次"打完折仍远高于"这个群只提了 1 次"。
// 若排序只按分数，跨场合的 5 条会占满 perPerson=2 ⇒ 同场合那条**根本进不来**，
// 于是"降权补位"退化成"用降权换掉了正确的那条"。
// ⇒ 同场合优先必须由**排序主键**保证（不是配额里的巧合）。

test('selectInjectLines：同场合必排跨场合之前（排序主键 · 真 bug 捕获点）', () => {
  const winners = [
    row(SAME, '这个群里只提过一次的事', { evidence_n: 1 }),
    ...Array.from({ length: 5 }, (_, i) =>
      row(OTHER_GROUP, `别的群提过很多次的事${i}`, { evidence_n: 20 }))
  ];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });
  const { lines } = selectInjectLines({ candidates: cands, sims: null, perPerson: 2, total: 8 });

  assert.ok(lines.some((l) => l.line.includes('这个群里只提过一次的事')),
    '同场合那条必须留下 —— 只按分数排会把它挤掉（跨群 20×0.6=12 ≫ 1）');
  assert.equal(lines[0].scopeRank, 0, '第一行必须是同场合');
  // 配额：perPerson=2 ⇒ 阿七总共最多 2 行
  assert.ok(lines.filter((l) => l.who === '阿七').length <= 2, 'perPerson 配额仍生效');
});

test('selectInjectLines：同场合已填满 total 时，跨场合一条都不补', () => {
  const winners = [
    row(SAME, '同群 A', { evidence_n: 1 }),
    row(SAME, '同群 B', { evidence_n: 1 }),
    row(OTHER_GROUP, '别群 C', { evidence_n: 100 })
  ];
  const cands = buildInjectCandidates({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });
  const { lines } = selectInjectLines({ candidates: cands, sims: null, perPerson: 6, total: 2 });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.scopeRank === 0), 'total 已满 ⇒ 不补跨场合');
  assert.ok(!lines.some((l) => l.line.includes('别群 C')));
});

test('selectInjectLines：缺 scopeRank 的旧候选按同场合处理（不改变既有行为）', () => {
  const cands = [
    { line: 'L1', who: 'A', credibility: 30 },
    { line: 'L2', who: 'B', credibility: 10 }
  ];
  const { lines } = selectInjectLines({ candidates: cands, sims: null, perPerson: 2, total: 2 });
  assert.equal(lines[0].line, 'L1', '无 scopeRank ⇒ 仍按分数排');
  assert.equal(lines.length, 2);
});

// ── ④ 可观测：被挡/降权必须数得出来 ─────────────────────────────────────────

test('scopeCensus：挡住/降权/同场合 分别计数，且只数"归属在场人"的槽', () => {
  const winners = [
    row(SAME, '同群一'),
    row(SAME, '同群二'),
    row(OTHER_GROUP, '别群一'),
    row(PRIVATE, SENSITIVE),
    row(PRIVATE, SENSITIVE),
    // 不归属在场任何人 ⇒ 不计入任何一栏
    row(PRIVATE, '路人的事', { speaker: 'P999' })
  ];
  const st = scopeCensus({ winners, people: PEOPLE, normalizer: N, nowScope: SAME });
  assert.deepEqual(st, { same: 2, downgrade: 1, blocked: 2 });
});

test('scopeCensus：nowScope 为空 ⇒ 除 SELF 外全挡（fail-closed 可数）', () => {
  const winners = [row(SAME, '一'), row(PRIVATE, '二')];
  const st = scopeCensus({ winners, people: PEOPLE, normalizer: N, nowScope: '' });
  assert.equal(st.blocked, 2);
  assert.equal(st.same + st.downgrade, 0);
});
