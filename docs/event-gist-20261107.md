# 票 07「更像人的记忆组织」实现说明 [by:WorkBuddy] 2026-11-07

基线：分支 `feat/memory-interop-rerank`，HEAD `c06e8fe`，工作区干净起步。
本票是**写代码**，不是调研。改动范围严格遵守文件所有权边界：`src/router.mjs`
（另一个代理独占，要把 `applyRecallPolicy` 改 async）及清单中其它既有文件一律未碰。

---

## 1. 一句话结论：衰减已存在，本票只补三件东西

`src/core/consolidate.mjs` 本来就有完整的**三态衰减**（`ADR-0048`）：

| 既有实现 | 位置 | 作用 |
| --- | --- | --- |
| `eventRetention()` | `:1082` | 遗忘曲线 `R(Δ)=exp(-Δ/H)`，`H=H₀·(1+gain·hits)` |
| `retireStaleEvents()` | `:1178` | live → dimmed → retired 三态 + 复活，`只打标记不删数据` |
| `promoteEvents()` | `:1123` | 排练满 `PROMOTE_HITS=9` 升长期 |
| 常数 | `:1013`~`:1038` | `RETIRE_DAYS=30` / `PROMOTE_HITS=9` / `RETIRE_DIM_WEIGHT=0.3` / `RETIRE_MIN_RECALL=0.1` / `RETIRE_HARD_RATIO=0.3` / `RETIRE_HALFLIFE_GAIN=0.4` |

**本票不重写算法、不改 `tokens.mjs` 常数、不新造/不照抄第三方衰减常数。**
只补：

1. **`evidenceIds` 回指** —— 事件 `record` 落盘时把窗口内消息 id 记进**同一条记录**，
   让「事实槽只落 `evidence_set_hash`/`evidence_n`/`provenance`（`factstore.mjs:739-763`），
   无法逐条回查消息 id」这件事有了可逆的回指。id 在 `consolidate.mjs:1829` 其实已为事实槽
   算过一次（`win.rows.slice(0,40).map(r=>String(r.id))`），本票用纯函数独立派生给事件行，
   **不改事实槽写入语义、不改事件账本文件名、不复制正文、不新建 jsonl 事实文件、不新增实体类型**。
2. **引文前缀/包含（第三重校验）** —— 回查三重校验里，来源 id（`router.mjs:1230-1289`
   的账本 + `crosschat.mjs:328-335`）与时间窗（`provenance.mjs:6-11`、`router.mjs:1345-1348`）
   **已实现**，缺的第三重由本票以纯函数 `verifyQuotation()` 补齐，语义范例是
   `worker.mjs:284` 的 `m.text.includes(entry.text)`。
3. **D11 说话人兜底** —— 按票 07 Notes 落在「01 的导入契约校验」

原话唯一真值源始终是 `input/messages.jsonl`（`input-source.mjs:8-34`）；派生块不落盘
（`corpus.mjs:5-8`）。本票全程只搬运 **id / 引用形状**，绝不复制原文。

---

## 2. 回查三重校验口径

`src/core/event-gist.mjs` 的 `verifyQuotation({message, quote, chatKey, fromTs, toTs, expectedId})`
是零 I/O 纯函数，返回 `{ok, code}`，稳定码：

| 重 | 校验 | 失败码 | 依据 |
| --- | --- | --- | --- |
| ① | 来源 id 一致：消息存在、`messageId === expectedId`、scope 落在同一 `chatKey` | `QUOTE_ID_MISMATCH` | 账本 `messageChat` / `idSet` |
| ② | 时间窗内：`timestamp ∈ [fromTs, toTs]`，窗口缺失按 fail-closed 拒绝 | `QUOTE_OUT_OF_WINDOW` | `fromTs`/`toTs` 区间 |
| ③ | 引文前缀或包含：`message.text` **以 `quote` 起首** 或 **包含 `quote`**；空引文也拒绝 | `QUOTE_TEXT_MISMATCH` | `m.text.includes(entry.text)` |
| ✅ | 三重全过 | `QUOTE_OK` | — |

`eventRefsOf(event)`：有 `evidenceIds` ⇒ 产 message 级引用
`{type:'message',id,chatKey,fromTs,toTs,matchMethod:'persisted-window'}`；
没有（老事件行）⇒ **原样退回**既有 window 级形状，保证老账本兼容。

`auditEventQuotation(event,{lookupMessage,quote})`（本票额外加的纯闸门，便于单测）
把 ③ 批量套到 `event.evidenceIds`：**任一条失败即整项不放行**（fail-closed），
无 `evidenceIds` 直接 `NO_EVIDENCE_IDS` 放行（老事件行兼容）。

### 接入点：为什么「校验失败不注入」在不碰 router.mjs 下真正生效

硬边界要求 `src/router.mjs` 由另一个代理独占。router 只服务 `POST /search` 的命中与
其自身的 `evidenceView`，**不负责注入装配**；注入 items 是在
`src/standalone/worker.mjs` 的 `recall()` 里逐条 `items.push(...)` 拼出来的。
所以本票把闸门放在 **worker 的注入装配点**：

- `eventRefs()` 删除，两个调用点（事件注入项 `:233` / 文档注入项 `:237`）改用 `eventRefsOf()`；
- `recall()` 里一次读出完整事件行（含 `evidenceIds`）、按 `messageId` 建原话查表
  （数据来自 `canonicalMessages(input)` 这唯一真值源，不落盘）；
- 每个带 `evidenceIds` 的注入项，在 `items.push` **之前**跑 `auditEventQuotation`；
  返回 `ok:false` 就 `continue`（`if(!g)continue;`），该项根本不进 `items` → 不进
  `unique` / `block` / `receipt`，**不静默放行**；
- 被拦下的项仍登记进 `eventIds`，防止它换个 `document:` 外壳从文档支路绕进来；
  文档支路本身也过同一道闸门；
- 结果里留可观测诊断 `quoteAudit:{checked,blocked,failures}`；**仅在真的回查过或拦下过**
  才附加该字段，老事件行 / 空注入时响应形状逐字不变，不给既有调用方塞新字段。

即：校验失败 ⇒ 注入项在装配阶段被丢弃，而不是先注入再记录。全程不改 `router.mjs`。

> 口径说明（刻意保守）：带 `evidenceIds` 的新事件，只有当其 gist 能在被引原话中
> **逐字前缀/包含命中**、且 id 与时间窗都核对上时才注入；核不上的一律拦下并计数。
> 这是「回查」的 fail-closed 语义，不是打分阈值。见 §4 未校准清单。

---

## 3. D10 / D11 决策（已代表用户拍板，照做）

### D10 衰减常数：不新造、不照抄、不重写实现

- `eventRetention` / `retireStaleEvents` / `promoteEvents` 与全部常数**既有即真值**，
  本票一行不动；`src/core/tokens.mjs` 零改动。
- 本票只写**可复现的多时间点测试**锁住它：`test/event-gist.mjs` ① 用
  `eventRetention` 在 `idleDays=0 / 35 / 50` 三个时间点复现 live → dimmed → retired，
  并断言 `hits=0` 时 `retireAfterDays === RETIRE_DAYS` 的锚点、排练延长半衰期；
  再用 `retireStaleEvents` 在临时账本上推进 `now` 走完三态，断言「只打标记不删行」、
  `evidenceIds` 不被淘汰流程改写。
- **未校准**：库里没有跨天排练的标注样本。改值须**真库标注集 + 另开 ADR**，
  本票不碰。

### D9 矛盾陈述

服务不裁决，保留并列 + 来源引用 —— 既有行为，**本票不改**。

### D11 说话人兜底：落在 01 的导入契约校验

- 落点 `interop/validate-import.mjs`；**不改运行时 `message()` 的 `actorId` 必填协议、
  不改 openapi、不改导出签名、不改 CLI 退出码语义**。
- 缺 `actorId` 的 entry：标 `unattributed`、warning 码 `UNATTRIBUTED_ENTRY`
  （带 `usableAsEvidence:false`）、并入 `summary.unattributed`（id 列表）。
- 若该 entry 还带 `subject.kind:'person'`（想挂人物档案）：失败码 `UNATTRIBUTED_PERSON`
  ⇒ `ok:false`。
- 合法样例 `interop/examples/minimal-valid.json` 的 `entry-002` 无 actorId、无 person
  subject ⇒ 仍 `ok:true`，只多一条 warning + `summary.unattributed:['entry-002']`。
- `interop/import-contract.schema.json` **不动**：`entries[].actorId` 本就是可选字段，
  `subject.kind` 是自由字符串，跨字段约束属于校验器职责，不需要改 schema。
- 校验器按票 01 纪律必须保持**零 `src/` 依赖**（`test/import-contract.mjs` 有源码守卫
  `校验器不得 import 服务内部模块`），故 `unattributedSummary()`（纯函数，放在
  `src/core/event-gist.mjs`）在校验器里有一份**离线镜像** `collectUnattributed()`；
  `test/event-gist.mjs` 断言两者口径一致。这是本票唯一一处刻意的「同口径双实现」，
  原因是零依赖契约边界，不是漂移。

---

## 4. 未校准常数 / 口径清单（改值须真库标注集 + 另开 ADR）

| 项 | 当前值 | 性质 |
| --- | --- | --- |
| `RETIRE_DAYS` | 30 | 锚点，`hits=0` 回收天数；未校准 |
| `RETIRE_HALFLIFE_GAIN` | 0.4 | 每次排练半衰期增益；源码自注「未校准 —— 库里还没有跨天排练的样本」 |
| `RETIRE_MIN_RECALL` | 0.1 | 变暗阈值 |
| `RETIRE_DIM_WEIGHT` | 0.3 | 变暗权重（对标第三方 `forget(soft)` factor=0.3） |
| `RETIRE_HARD_RATIO` | 0.3 | 硬回收阈值 = `rMin × 0.3` |
| `PROMOTE_HITS` | 9 | 升长期排练门槛（`ADR-0047`） |
| 引文匹配口径 | 逐字前缀/包含 | 本票新增的保守 fail-closed 口径；gist 为宽松改写时会拦下注入，需标注集校准后才可放宽 |

---

## 5. `src/core/*` 改动清单

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/core/event-gist.mjs` | **新增**，纯函数模块，零 import / 零 fs / 零 I/O | `deriveEvidenceIds` / `eventRefsOf` / `verifyQuotation` / `unattributedSummary` + 可测闸门 `auditEventQuotation` |
| `src/core/consolidate.mjs` | import `deriveEvidenceIds`；`applyWindow` 内 `const evidenceIds = deriveEvidenceIds(win)`；event `record` 加 `evidenceIds` 字段 | 唯一真值源派生，**不改账本文件名/写入语义/事实槽** |

**明确零改动**：`factstore.mjs`、`vecstore.mjs`、`vector-generation.mjs`、`embed.mjs`、
`tokens.mjs`、`durable-log.mjs`、`input-source.mjs`、`scene-memory.mjs`、`recall-policy.mjs`、
`rerank-backend.mjs`、`backend.mjs`、`settings-editor.mjs`；`vector-active.json` 未被写；
`web/**`、`README.md`、`PROTOCOL.md`、`openapi/**`、`package.json`、docs 下其它既有文档均未碰。

`src/standalone/worker.mjs`、`src/standalone/service.mjs`（后者未碰）、
`interop/validate-import.mjs`、`test/import-contract.mjs`、`test/event-gist.mjs`（新增）、
`docs/event-gist-20261107.md`（本文件，新增）为其余改动点。

---

## 6. 验收与守卫

- 专项测试：`node --test test/event-gist.mjs test/import-contract.mjs` → **16 pass / 0 fail**
  （`event-gist.mjs` 6 项 + `import-contract.mjs` 10 项）。按要求**不跑 `npm test` 全量**。
- `test/event-gist.mjs` 的四道源码守卫（风格参照 `test/recall-policy.mjs:144-201`）：
  ① `git diff c06e8fe` 断言事实层/向量代/令牌/真值源文件零改动；
  ② 整库扫描 `vector-active.json` 未被写；
  ③ `event-gist.mjs` 零 I/O、`deriveEvidenceIds` 限 40 / 去重 / 全字符串 / 只产 id、
     淘汰后原文串只出现在唯一真值源一个文件、不新建 jsonl 事实文件、事件 record 不复制 `text`；
  ④ 三重校验接线在 worker 注入侧、`if(!g)continue;` 在 `items.push` 前拦下、
     `router.mjs` 不含回查闸门代码。
- 数据级 + 源码级双重断言「淘汰后原消息正文在库里只存在一份」。

留痕：`[by:WorkBuddy]` 见所有新增/修改代码注释与本文件标题。

---

## 附：全量回归打脸后的一处语义修正（2026-11-07，[by:WorkBuddy]）

首版把 `e.summary`（派生摘要）当作「逐字引文」传给第三重校验，专项测试自己构造的原话恰好包含摘要，于是 16/16 全绿；但 `npm test` 全量跑到 `test/standalone-engine.mjs:49` 时暴露真回归：**所有 `episodic` 事件项被 fail-closed 拦下**，断言 `recall.items.some(i=>i.layer==='episodic')` 失败。

根因不是「太严格」，是把两类东西混了：事件 gist 是 `title：detail` 拼出来的**派生摘要**，本来就不要求原话逐字包含；第三重「引文前缀/包含」只该对**显式声明了 quote 的条目**生效。

修法（收紧语义，不是放宽校验）：

- `src/core/event-gist.mjs` `verifyQuotation()`：`quote === undefined/null` ⇒ 跳过第三重并标 `quoteSkipped:true`，但 ①来源 id + ②时间窗 **照常执行**；显式声明了 quote 但为空串或不匹配仍 `QUOTE_TEXT_MISMATCH`。
- `src/standalone/worker.mjs` 注入闸门：改传 `full?.quote ?? e.quote`，不再传 `e.summary`。
- `test/event-gist.mjs` 补 5 条断言：跳过第三重时时间窗 / 来源 id 校验仍生效、前两重失败不放行、正常事件行不被误拦。

**教训与票 03 的 C7 同型**：专项测试若只用自己构造的、恰好满足假设的数据，全绿毫无意义；必须让「既有行为」的测试也跑一遍。本轮最终 `npm test` **111/111 全绿**，`test:adapter` 12 pass / 4 skip / 0 fail。
