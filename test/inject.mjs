// test/inject.mjs — M2 注入选择器（ADR-0009）：纯函数层，不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInjectCandidates, selectInjectLines, renderInjectBlock,
  renderAttributeLine, cosine, PATTERN_LABELS,
  resolveMinScore, DEFAULT_MIN_SCORE
} from '../src/core/inject.mjs';
import { LEGACY_CREDIBILITY_FACTOR } from '../src/core/factstore.mjs';

/** 最小 normalizer 桩：只实现 inject.mjs 用到的两个口。 */
function stubNormalizer(map = {}) {
  return {
    resolveKnown(id) { return map[String(id)] ?? map[`qq:${String(id).replace(/^qq:/, '')}`] ?? null; },
    _resolveTerm(surface) { return map[String(surface)] ?? { known: false }; }
  };
}

const N = stubNormalizer({
  '123456': { id: 'qq:123456', label: 'P7', kind: 'person' },
  '阿七': { label: 'P7', kind: 'person', known: true },
  '路人': { label: 'X99', kind: 'person', known: false }
});

function patternRow(over = {}) {
  return {
    key: 'P7␀␀pattern␀group:C1',
    speaker: 'P7', target: '', fact_kind: 'pattern', scope: 'group:C1',
    content: {
      pattern_type: 'sincere', reason: 'OK', confidence_note: '',
      exemplar: '收到B站链接，我去下载一下，稍等哦～', cluster_size: 20,
      self_n: 0, span_ms: 1, verbatim: false, degraded: null
    },
    evidence_n: 20, rev: 1, caliber: null, // null caliber = legacy ⇒ ×0.5
    ...over
  };
}

test('renderAttributeLine：pattern 渲染成属性句 + 例句截断；坏行返回 null', () => {
  const r = patternRow();
  const line = renderAttributeLine(r);
  assert.ok(line.startsWith(PATTERN_LABELS.sincere), '以 pattern_type 的中文面开头');
  assert.ok(line.includes('收到B站链接'), '带 exemplar 例句');
  const long = renderAttributeLine(patternRow({ content: { ...r.content, exemplar: 'x'.repeat(200) } }));
  assert.ok(long.length < 120, 'exemplar 被截断');
  assert.equal(renderAttributeLine({ ...r, content: '[object Object]' }), null, '字符串 content = 坏行');
  assert.equal(renderAttributeLine({ ...r, content: { pattern_type: '' } }), null, '无 pattern_type = 不渲染');
});

test('buildInjectCandidates：QQ 号与名字都能匹配到占位符；未知人不匹配；SELF 参与', () => {
  const selfRow = patternRow({ key: 'SELF␀␀pattern␀g', speaker: 'SELF', content: { pattern_type: 'joke', exemplar: '哈哈' } });
  const cands = buildInjectCandidates({
    winners: [patternRow(), selfRow],
    people: [{ id: '123456', name: '阿七' }, { id: '999999', name: '路人' }],
    normalizer: N
  });
  assert.equal(cands.length, 2, '阿七 1 条 + SELF 1 条（路人匹配不上）');
  assert.ok(cands.every((c) => c.who === '阿七' || c.who === '你自己'), 'who 用请求方的真名');
});

test('legacy 可信度 ×0.5 进入排序权重（ADR-0007 贯通到注入）', () => {
  const cands = buildInjectCandidates({
    winners: [patternRow()], people: [{ id: '123456', name: '阿七' }], normalizer: N
  });
  assert.equal(cands[0].credibility, 20 * LEGACY_CREDIBILITY_FACTOR);
});

test('selectInjectLines：boost 模式 hot 行排最前；hard 模式过滤并计数', () => {
  const mk = (cred, who) => ({ line: 'L', who, credibility: cred });
  const cands = [mk(10, 'A'), mk(20, 'B'), mk(30, 'C')];
  // sims：C hot(0.9)，A/B 不 hot
  const boost = selectInjectLines({ candidates: cands, sims: [0.1, 0.2, 0.9], minScore: 0.85, mode: 'boost', perPerson: 2, total: 8 });
  assert.equal(boost.lines[0].who, 'C', 'hot 行虽然可信度最低但排最前');
  assert.equal(boost.lines.filter((l) => l.hot).length, 1);

  const hard = selectInjectLines({ candidates: cands, sims: [0.1, 0.2, 0.9], minScore: 0.85, mode: 'hard', perPerson: 2, total: 8 });
  assert.equal(hard.lines.length, 1, 'hard 只留 hot');
  assert.equal(hard.droppedByThreshold, 2, '被阈值丢弃的行有计数');

  // 嵌入缺席（sims=null）：hard 降级 boost —— 不允许"缺依赖=什么都不注入"
  const degraded = selectInjectLines({ candidates: cands, sims: null, minScore: 0.85, mode: 'hard', perPerson: 2, total: 8 });
  assert.equal(degraded.lines.length, 3, 'hard 缺 sims 时全部保留（降级 boost）');
});

test('selectInjectLines：每人 perPerson 条 + 总量 total 条', () => {
  const cands = ['A', 'B', 'C'].flatMap((who) => [
    { line: 'x', who, credibility: 10 }, { line: 'y', who, credibility: 9 }, { line: 'z', who, credibility: 8 }
  ]);
  const r = selectInjectLines({ candidates: cands, perPerson: 2, total: 4 });
  assert.equal(r.lines.length, 4, '总量截断');
  const countA = r.lines.filter((l) => l.who === 'A').length;
  assert.ok(countA <= 2, '每人不超过 perPerson');
});

// ── 平局的判定（2026-10-22）─────────────────────────────────────────────────
//
// 为什么必须钉死：号A 实测 367 个活槽里 **341 条 `evidence_n=1`** ⇒ "同分"不是边角
// 情况而是主路径。旧的排序只比 `scopeRank` 与 `score`，全平局时靠 V8 稳定排序保留
// 落库顺序 ⇒ **刚记的那条会被很久以前记的挤出 `perPerson` 名额**，且不报错。
test('selectInjectLines：同分时新的先（不再由写入顺序决定谁被截断）', () => {
  const mk = (at, line) => ({
    line, who: 'A', credibility: 1, scopeRank: 0,
    rec: { derived_from: { at }, rev: 1 }
  });
  const cands = [
    mk('2026-01-01T00:00:00.000Z', '很久以前记的'),
    mk('2026-10-22T00:00:00.000Z', '刚记的')
  ];
  const r = selectInjectLines({ candidates: cands, sims: null, perPerson: 1, total: 8 });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].line, '刚记的', '同分 ⇒ 新的留下；否则记忆越更正越容易消失');
});

test('selectInjectLines：没有 rec（纯候选）时平局行为不变，且不抛错', () => {
  const cands = [
    { line: 'L1', who: 'A', credibility: 1 },
    { line: 'L2', who: 'A', credibility: 1 }
  ];
  const r = selectInjectLines({ candidates: cands, sims: null, perPerson: 2, total: 8 });
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines.map((l) => l.line), ['L1', 'L2'], '缺 rec ⇒ 保持既有（稳定）顺序');
});

test('resolveMinScore：不返回 NaN；0/负/非数值 = 未设；越界收敛（ROADMAP 4.3 回归）', () => {
  // ⚠️ 这一条是**回归断言**：`Number(undefined) ?? 0.85` 得到的是 NaN（`??` 只挡 null/undefined），
  // 而 `sim >= NaN` 恒 false ⇒ hot 恒 false ⇒「话题相关性加成」永久失效。
  assert.ok(Number.isFinite(resolveMinScore(undefined, undefined)), '三级全空也不许返回 NaN');
  assert.equal(resolveMinScore(undefined, undefined), DEFAULT_MIN_SCORE);

  // 三级优先级：请求参数 > 落盘设置 > 默认
  assert.equal(resolveMinScore(0.7, 0.9), 0.7, '请求参数优先');
  assert.equal(resolveMinScore(undefined, 0.9), 0.9, '落盘设置次之');
  assert.equal(resolveMinScore(NaN, 0.9), 0.9, 'NaN 该被跳过、不许把后面的一起毒死');

  // 0 = 未设：面板 collect() 把空输入写成 0（settings-ui.js:731-734）
  assert.equal(resolveMinScore(undefined, 0), DEFAULT_MIN_SCORE, '0 = 未设 ⇒ 回落默认');
  assert.equal(resolveMinScore(0, 0.9), 0.9, '0 不占位，继续往下落');
  assert.equal(resolveMinScore(undefined, -1), DEFAULT_MIN_SCORE, '负数 = 未设');
  assert.equal(resolveMinScore(undefined, 'abc'), DEFAULT_MIN_SCORE, '非数值 = 未设');
  assert.equal(resolveMinScore(null, ''), DEFAULT_MIN_SCORE, 'null / 空串 = 未设');

  // 越界收敛
  assert.equal(resolveMinScore(5), 1, '上界 1');
  assert.equal(resolveMinScore(0.001), 0.001, '极小正数合法（想"几乎不过滤"就用它，别用 0）');

  // 与 selectInjectLines 的默认参数同源：不传 minScore 时行为一致
  const cands = [{ line: 'L', who: 'A', credibility: 1 }];
  const noArg = selectInjectLines({ candidates: cands, sims: [0.86] });
  const explicit = selectInjectLines({ candidates: cands, sims: [0.86], minScore: DEFAULT_MIN_SCORE });
  assert.deepEqual(noArg, explicit, '默认值与常量同源（否则两处会各自漂移）');
});

test('renderInjectBlock：带哨兵注释（宿主幂等判据）与"不要主动提及"指令', () => {
  const block = renderInjectBlock([{ who: '阿七', line: '表达真诚' }]);
  assert.ok(block.includes('<!--mv-inject-->'), '哨兵在场');
  assert.ok(block.includes('不要主动提及'), '人格属性的使用方式写进块头');
  assert.equal(renderInjectBlock([]), '', '空清单 = 空块（宿主无需追加任何东西）');
});

test('cosine：同向 1 / 正交 0 / 维度不齐 0', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([], []), 0);
});
