// 事实施工层原语 · 单元测试（不联网、不读存档、纯函数）。
//
// 为什么这个测试重要：身份键是"**要么早定死、要么晚了重判历史**"的东西。
// 本轮把已拍板的键 / 指纹落成纯函数，就是为了让"键定义"**可执行、可断言** ——
// 而不是只活在 ADR 的文字里（0015 的教训：`rank_version` 声称了、代码没接）。
//
// 运行：node test/facts.mjs

import {
  factSlotKey,
  evidenceSetHash,
  decisionKey,
  canonicalContent,
  contentFingerprint,
  compareAndUpdate,
  FACT_KINDS,
  FACT_KIND_GROUPS,
  isFactKind
} from '../src/core/facts.mjs';
import * as F from '../src/core/facts.mjs';
import { ok, tally } from './lib/_helpers.mjs';


console.log('\n══ 事实施工层原语（身份键 · 指纹 · compare-and-update）══════════════════');

// ── ① 产事实级键：含 scope、不含 topic ─────────────────────────────────────
{
  const SC = 'group:C1234';
  const k1 = factSlotKey('P7722', 'SELF', 'pattern', SC);
  const k2 = factSlotKey('P7722', 'SELF', 'pattern', SC);
  ok(k1 === k2, '同 `(speaker, target, fact_kind, scope)` ⇒ 同键（确定性）');
  ok(k1.indexOf('表白梗') < 0 && !k1.includes('topic'),
    '产事实级键**不含任何内容**（topic 不在键里）', `(${JSON.stringify(k1)})`);

  // ⭐ 对面 `0018` 的核心拍板：`scope` 是**身份维度**——"A 在群里对 B 玩梗"
  //    与"A 在私聊对 B 玩梗"是**两个问题**，分属两个槽（不并槽）。
  ok(factSlotKey('P1', 'P2', 'pattern', 'group:C1') !== factSlotKey('P1', 'P2', 'pattern', 'private:C2'),
    'scope 变 ⇒ 换槽（群 / 私聊是两个问题，不并槽）');
  ok(factSlotKey('P1', 'P2', 'pattern', 'group:C1') !== factSlotKey('P1', 'P2', 'pattern', 'group:C2'),
    '不同群 ⇒ 换槽（A 在群1 / 群2 的行为可能不同）');

  // ⭐ 对面 `0016` 的原场景：同一槽两次判定，topic 从"表白梗"漂到"日常互动"。
  //    若 topic 在键里 ⇒ 键变 ⇒ 新建 fact_002（增殖）。本断言证明：**键不变**。
  const ev1 = evidenceSetHash([101, 102, 103]);
  const ev2 = evidenceSetHash([101, 102, 103, 104]);
  const f1 = contentFingerprint({ content: { topic: '表白梗', pattern_type: 'joke' }, logicVersion: 1, evidenceSetHash: ev1 });
  const f2 = contentFingerprint({ content: { topic: '日常互动', pattern_type: 'joke' }, logicVersion: 1, evidenceSetHash: ev2 });
  ok(k1 === k2, 'topic 漂移**不改**产事实级键 ⇒ 同槽更新，**不增殖**（无 fact_002）');
  ok(f1 !== f2, 'topic 漂移**改**内容指纹（"槽里的值变了"被检出）', `(${f1.slice(0, 8)} → ${f2.slice(0, 8)})`);
  const r = compareAndUpdate(f1, f2, 1);
  ok(r.action === 'update' && r.rev === 2, 'compare-and-update：值变 ⇒ 原地更新 + rev+1');

  // fact_kind 是 schema 常量（非判定输出）⇒ 正当进身份：变则换槽。
  ok(factSlotKey('P7722', 'SELF', 'pattern', SC) !== factSlotKey('P7722', 'SELF', 'speaker_profile', SC),
    '`fact_kind` 变 ⇒ 换槽（它是"问的是什么"，不是判定输出）');
  ok(factSlotKey('P1', 'P2', 'pattern', SC) !== factSlotKey('P2', 'P1', 'pattern', SC),
    '有向：`(A→B)` 与 `(B→A)` 是两个槽（不合并）');
}

// ── ② 键的规范化：`null` / `undefined` 不许泄进键 ─────────────────────────
{
  ok(factSlotKey(null, undefined, 'pattern', 'group:C1') === factSlotKey('', '', 'pattern', 'group:C1'),
    '`null` / `undefined` 规范化为空串（键里不出现 `undefined` 字面）');
  ok(factSlotKey('P1', 'P2', 'pattern', 'group:C1') !== factSlotKey(' P1 ', 'P2', 'pattern', 'group:C1'),
    '键只做 `null`/`undefined` 规范化，**不做隐式 trim**（避免"看起来相等实则不同"）');
}

// ── ③ 证据集指纹：精确（顺序无关 / 去重 / 中间增删都变）──────────────────
{
  const a = evidenceSetHash([3, 1, 2]);
  const b = evidenceSetHash([1, 2, 3]);
  ok(a === b, '证据集指纹**顺序无关**（同一集合恒等）');
  ok(evidenceSetHash([1, 1, 2]) === evidenceSetHash([1, 2]), '证据集指纹**去重**');

  // ⭐ 对面 `0012`/`0015` 确认点的场景：`n` 与端点都不变，中间项变了。
  const oldSet = evidenceSetHash([101, 102, 103]);          // n=3, min=101, max=103
  const midSwap = evidenceSetHash([101, 999, 103]);          // n=3, min/max 不变，中间项换了
  ok(oldSet !== midSwap, '中间项增删 / 替换 ⇒ 指纹变（`n + min/max` 骗得过，精确 hash 骗不过）');
  ok(evidenceSetHash([]) !== evidenceSetHash([1]), '空集与非空集不同');
}

// ── ④ 判定级键：无 topic ─────────────────────────────────────────────────
{
  const k = decisionKey('P7722', 'SELF', evidenceSetHash([1, 2, 3]));
  ok(!k.includes('topic') && k.split('\u0000').length === 3,
    '判定级键 = `(speaker, target, evidence_set_hash)` —— 三段，无 topic');
  ok(decisionKey('P7722', 'SELF', 'eX') !== decisionKey('P7722', 'SELF', 'eY'),
    '证据集变 ⇒ 判定级键变 ⇒ 该重跑判定');
}

// ── ⑤ 内容指纹：顺序无关 / 对"逻辑版本"敏感 ───────────────────────────────
{
  const c1 = canonicalContent({ b: 1, a: [3, 2, 1] });
  const c2 = canonicalContent({ a: [1, 2, 3], b: 1 });
  ok(c1 === c2, '内容规范化**顺序无关**（对象键 / 数组元素都排序）');

  const multi = { patterns: [{ topic: '表白梗', type: 'joke' }, { topic: '日常互动', type: 'sincere' }] };
  const multiRev = { patterns: [{ topic: '日常互动', type: 'sincere' }, { topic: '表白梗', type: 'joke' }] };
  ok(contentFingerprint({ content: multi, logicVersion: 1, evidenceSetHash: 'e1' })
    === contentFingerprint({ content: multiRev, logicVersion: 1, evidenceSetHash: 'e1' }),
  '多值内容**重排不算变化**（并存 pattern 的集合语义）');

  const base = { content: { topic: '表白梗' }, logicVersion: 1, evidenceSetHash: 'e1' };
  ok(contentFingerprint(base) !== contentFingerprint({ ...base, logicVersion: 2 }),
    '判定逻辑版本变 ⇒ 内容指纹变（阈值 3→4 这类"口径变了"应当被视作值变了）');
  ok(contentFingerprint(base) !== contentFingerprint({ ...base, evidenceSetHash: 'e2' }),
    '证据集变 ⇒ 内容指纹变');
}

// ── ⑥ compare-and-update：相同即 no-op（不产新事实）────────────────────
{
  const fp = contentFingerprint({ content: { topic: '表白梗' }, logicVersion: 1, evidenceSetHash: 'e1' });
  const same = compareAndUpdate(fp, fp, 5);
  ok(same.action === 'noop' && same.rev === 5,
    '指纹相同 ⇒ `noop`（**不写盘、不产新事实**、rev 不变）');
  const first = compareAndUpdate(null, fp, 0);
  ok(first.action === 'update' && first.rev === 1, '首次产出（旧指纹为 `null`）⇒ 建槽，rev=1');
  const chg = compareAndUpdate(fp, fp + 'x', 5);
  ok(chg.action === 'update' && chg.rev === 6, '指纹变 ⇒ `update` + rev+1');
}

// ── ⑦ 红线：键与指纹**不同源**（连锁但分离）──────────────────────────────
{
  const ev = evidenceSetHash([1, 2, 3]);
  const dk = decisionKey('P1', 'SELF', ev);
  const slot = factSlotKey('P1', 'SELF', 'pattern', 'group:C1');
  ok(dk !== slot, '判定级键 ≠ 产事实级键（一个管"判过没"，一个管"槽存在没"）');
  // 换窗（horizon）只应影响 evidence 的"取哪些 id"，不该在键里体现为 horizon 字段
  ok(slot.indexOf('horizon') < 0 && dk.indexOf('horizon') < 0,
    '两个键都**不含 `horizon`**（换窗 ≠ 新事；视窗进指纹，不进身份）');
}

// ── ⑧ 红线守卫：scope 缺失 / 明文 id ⇒ **抛**，不静默降级 ──────────────────
{
  // 守卫 1：scope 省略 ⇒ 群/私聊事实会并进同一个槽（事后无法从键里看出来）⇒ 抛。
  let threw = false;
  try { factSlotKey('P1', 'P2', 'pattern'); } catch { threw = true; }
  ok(threw, '缺 `scope` ⇒ **抛**（省略会把群/私聊事实并进同一个槽，且事后看不出来）');

  threw = false;
  try { factSlotKey('P1', 'P2', 'pattern', ''); } catch { threw = true; }
  ok(threw, '`scope` 为空串 ⇒ **抛**（空 scope 等于没 scope）');

  // 守卫 2：scope 是明文 id（`private:1353446252` = 对方明文 QQ）⇒ 抛。
  //         键要出境 / 进 read-model ⇒ 明文 id 入键 = 从键里泄通讯录（ADR-0002）。
  threw = false;
  try { factSlotKey('P1', 'P2', 'pattern', 'private:1353446252'); } catch { threw = true; }
  ok(threw, '`scope` 是明文 id（`private:<QQ>`）⇒ **抛**（键不得带明文 QQ/群号，ADR-0002）');

  threw = false;
  try { factSlotKey('P1', 'P2', 'pattern', 'group:1098345913'); } catch { threw = true; }
  ok(threw, '`scope` 是明文群号 ⇒ **抛**（同上）');

  // 占位符 token 形态（`group:C1234`）应当**通过**守卫。
  threw = false;
  let okToken = '';
  try { okToken = factSlotKey('P1', 'P2', 'pattern', 'group:C1234'); } catch { threw = true; }
  ok(!threw && okToken.includes('group:C1234'),
    '占位符 token（`group:C1234`）**通过**守卫（守卫只拦明文 id，不拦正常 token）');
}

// ── ⑦ `fact_kind` 枚举：封闭、冻结、无默认（ADR-0017）──────────────────────
{
  console.log('\n── ⑦ fact_kind 枚举（身份键的第三段）──────────────────────');
  // 9 = 语用 3（pattern / speaker_profile / trait）+ 语义 6。
  // `trait` 是 `ADR-0031` 加的（固定档案）；它归**语用**段，理由见 `facts.mjs` 的分段注释。
  ok(Array.isArray(FACT_KINDS) && FACT_KINDS.length === 9, 'FACT_KINDS 共 9 个取值', `= ${FACT_KINDS.length}`);
  ok(Object.isFrozen(FACT_KINDS), 'FACT_KINDS **冻结**（身份键分量不许被运行时改写）');
  ok(Object.isFrozen(FACT_KIND_GROUPS) && Object.isFrozen(FACT_KIND_GROUPS.pragmatic)
    && Object.isFrozen(FACT_KIND_GROUPS.semantic), '分段视图也冻结');

  // 语义段必须**逐字**对齐内核 EVENT_KINDS（不新造词表）。
  const EVENT_KINDS = ['event', 'topic', 'promise', 'joke', 'grudge', 'preference'];
  ok(EVENT_KINDS.every((k) => FACT_KINDS.includes(k)),
    '语义段**包含**内核 EVENT_KINDS 全部 6 类（对齐、不另造）',
    `缺=${EVENT_KINDS.filter((k) => !FACT_KINDS.includes(k)).join(',') || '无'}`);
  ok(FACT_KIND_GROUPS.semantic.length === 6 && FACT_KIND_GROUPS.pragmatic.length === 3,
    '分段：语用 3 + 语义 6');
  ok(FACT_KIND_GROUPS.pragmatic.includes('pattern') && FACT_KIND_GROUPS.pragmatic.includes('speaker_profile')
    && FACT_KIND_GROUPS.pragmatic.includes('trait'),
    '语用段 = pattern / speaker_profile / trait（ADR-0010 决定 1 的 L1 / L2）');
  // ⚠️ `trait` **必须**在语用段、语义段**不得**出现 —— 语义段的纪律是"逐字复用内核
  //    EVENT_KINDS、不新造词表"（上一条断言），塞进去就破了那条对齐。
  //    这条断言是防"以后有人图省事把 trait 挪进 semantic"。
  ok(FACT_KINDS.includes('trait') && !FACT_KIND_GROUPS.semantic.includes('trait'),
    'trait 归语用段、**不进**语义段（保住与内核 EVENT_KINDS 的逐字对齐，ADR-0031）');

  ok(isFactKind('pattern') && isFactKind('grudge'), 'isFactKind：合法值 ⇒ true');
  ok(!isFactKind('speaker-profile'), 'isFactKind：**连字符笔误** ⇒ false（这正是枚举要拦的）');
  ok(!isFactKind('') && !isFactKind(undefined) && !isFactKind(null), 'isFactKind：空 / undefined / null ⇒ false');
  ok(!isFactKind('Pattern'), 'isFactKind：**大小写敏感**（`Pattern` ≠ `pattern`）');
  // 无默认值：内核有 DEFAULT_KIND='event'，插件**故意不采用**（身份键分量不许静默降级）。
  ok(!('DEFAULT_FACT_KIND' in F), '模块**不导出** DEFAULT_FACT_KIND —— 身份键分量不许有缺省值');

  // 拼写错误 = 新槽：同一个 (speaker,target,scope) 下 kind 只差一个连字符 ⇒ 键不同
  const ka = factSlotKey('P1', 'P2', 'pattern', 'group:C1');
  const kb = factSlotKey('P1', 'P2', 'pattern-', 'group:C1');
  ok(ka !== kb, 'kind 差一个字符 ⇒ **键不同**（所以它必须来自封闭集合，才拦得住笔误）');
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`事实施工层原语：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
