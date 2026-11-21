// test/lib/_helpers.mjs —— 断言 helper 的**唯一实现**（C 收敛，2026-10-11）
//
// **为什么放在 `lib/` 子目录**：`npm test` 的 glob 是 `test/*.mjs`（不递归），
// 放在 `test/` 根下会被 `node --test` 当成一个"没有任何子测试的测试文件"收进
// 结果计数（实测：多出一条 `ok - test\\_helpers.mjs`，总数虚高一条）。
// 放进子目录即天然排除，不必改 glob、也不必加白名单。
//
// 来历：`ok()` 曾在 **15 个测试文件**里各自手抄（9 份箭头 + 3 份 `function` 声明，
// 参数名 `c`/`cond` 不一，行为一致）。副本数涨到 15 触发了 `test/README.md`
// 纪律 2 登记在案的 **C 到期探针**（≥15 ⇒ "收敛收益开始超过成本"）⇒ 收敛成本文件。
//
// 为什么收敛：手抄副本的风险是**静默分叉** —— 有人改了某一份的行为，其他份不知道，
// 15 个文件全绿但测的不是同一个东西。收敛后"行为一致"由**构造**保证，不再靠守卫比对。
//
// ## 契约（`helpers-guard.mjs` 按这几条断言）
//
// 1. 测试文件**不得**再定义自己的 `ok`（既不许 `const ok = …`，也不许 `function ok`）；
// 2. 需要断言的测试文件必须 `import { ok, tally } from './lib/_helpers.mjs'`；
// 3. 计数读 `tally.pass` / `tally.fail`，不再各自 `let pass = 0`；
// 4. 用 `node:test` + `node:assert` 的文件**不在**此契约内（它们没有 ok helper），
//    名单在守卫里显式枚举 —— 新增这类文件要同步登名单，否则守卫会把它当"漏 import"报红。
//
// ⚠️ 一个进程只会跑一个测试文件（`node --test` 每个文件一个子进程，
//    直接 `node test/x.mjs` 也是单文件）⇒ 模块级计数不会互相污染。
//    **若将来把两个测试文件合进同一进程**，这里必须改成工厂
//    （`createReporter()` 每份实例一套计数器）—— 守卫的
//    "全部 import 同一模块" 断言仍成立，但要顺带改成"每份实例拿到独立 tally"。
//
// 运行：被各测试文件 import，不单独运行。

/** 全进程共享的断言计数。收尾时读它（`tally.pass` / `tally.fail`）。 */
export const tally = { pass: 0, fail: 0 };

/**
 * 一条断言。
 * @param {unknown} cond 真值 ⇒ 通过；falsy（含 0 / ''）⇒ 失败
 * @param {string} label 断言名（输出里不换行）
 * @param {string} [extra] 附加信息（成功/失败都追加，无则不追加空格）
 */
export function ok(cond, label, extra = '') {
  if (cond) { tally.pass++; console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`); }
  else { tally.fail++; console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`); }
}
