# 通用记忆导入契约 v1（票 01）

> **状态**：已实现（离线契约 + 校验器 + 样例 + 测试）· 2026-11-07 · [by:WorkBuddy]
> **分支**：`feat/memory-interop-rerank` · **基线**：`main @ c05e79f`
> **边界**：本文定义**一份离线 JSON 文档**的形状与语义。它不是新的 HTTP 接口，不改 `src/core/`，不改落盘数据，不写 `vector-active.json`，不生成向量，不触发重建。

---

## 1. 解决什么问题

任意第三方 Agent 的记忆产物要进本服务，过去只有两条路：照着某一种旧格式写专用转换器，或直接手写库文件。两者都把「数据形状」和「某个产品的实现」绑死。

本契约把这一步切成两段：

```
第三方原始数据包
   │  （票 02：某个具体的离线转换器，不进服务）
   ▼
通用导入文档  ← 本契约定义，与产品无关
   │  interop/validate-import.mjs 离线校验
   ▼
服务既有写入口（/messages、/memories 等，本协议 v1）
```

- **契约只描述数据**，不描述谁生产的、也不要求调用方部署任何第三方组件。
- **字段只使用 `CONTEXT.md` 已有词汇**：空间、场合、场景、主体、来源、采用；不新增服务内部状态枚举，不改 `FACT_KINDS`。
- 校验器零外部依赖、不 import 任何服务内部模块，因此可以整目录拷到别的项目里当独立工具用。

## 2. 单一真值源与防漂移

| 东西 | 位置 | 职责 |
| --- | --- | --- |
| 形状**唯一真值源** | `interop/import-contract.schema.json` | 字段、必填、类型、枚举、长度、附加字段策略 |
| 解释执行器 | `interop/validate-import.mjs` | 按 schema 校验 + 跨字段证据检查 + 可读错误 |
| 语义说明 | 本文 | 为什么这么定、边界、未决事项；**不复述字段取值** |
| 样例 | `interop/examples/*.json` | 最小合法 + 六类非法，供 CLI / CI 直接跑 |

- schema 采用**受限子集**（白名单：`type/const/enum/pattern/minLength/maxLength/minItems/maxItems/minimum/required/properties/additionalProperties/items`）。遇到白名单外关键字（例如 `$ref`、`oneOf`、`format`）**直接抛 `UNSUPPORTED_SCHEMA_KEYWORD`**，不静默跳过 —— 静默漏校验比报错危险得多。
- `assertSupportedSchema()` 在校验前**全量扫描**整棵 schema，不依赖文档是否命中那个分支。
- `test/import-contract.mjs` 锁住三件事：本文 §4 字段清单与 schema 对齐（双向）、两处重复的 `scope` 规则与两处 `origin` 规则逐字一致、schema 描述里不含任何具体 Agent 项目名。
- `entries[].kind` **不复制服务枚举**：只约束为小写标识符，合法性由写入端按服务已有分类校验。在契约里抄一份枚举 = 两份真值源，改动必然漂移。

## 3. 「历史导入 / 未核验」的确切定义

这是本契约最容易被误用的一处，写死五条：

1. 顶层 `origin` 与每条 `entries[].origin` 都是 `{kind:"historical-import", verified:false, source:{locator,...}}`。`verified` 用 `const:false` 锁住，**调用方不能自行声明已核验**；校验器会拒绝 `true` 并给出条目定位。
2. `verified:false` 是**来源属性**，不是条目状态、不是可信度分数、不参与召回打分。与 `CONTEXT.md:16`「采用次数不是真实性评分」同一条纪律。
3. 自动整理**不得**把它提升为已确认事实。若确需确认，走服务既有人工写入口（`/memories` 的 `source:"manual"` 或人工修订），**不写回导入契约**。本契约没有「确认」动作，也就没有误升级路径。
4. 与既有先例同义：`tools/import-group-memory.mjs:12-13` 的 `legacy:true / confirm:false / unverified:true`；`docs/upgrades-20261101.md:193`「导入后要人工核对；不要把'导入成功'当'内容正确'」。
5. 未来若要导入**已核验**数据，另开 v2 契约并单独设计验证凭据；不在 v1 里开后门。

> 与 `docs/TODO-human-review-page-20261107.md` 的关系：这批未核验条目正是「待核对」队列的输入之一。该页面尚未实现、由用户侧前端负责；**本契约不依赖它存在**。

## 4. 字段清单（机器可读；以 schema 为准）

<!-- FIELDS:START -->
contract
spaceId
notes
origin
origin.kind
origin.verified
origin.source
origin.source.locator
origin.source.file
origin.source.line
origin.source.recordId
origin.note
messages
messages[]
messages[].messageId
messages[].conversationId
messages[].actorId
messages[].role
messages[].timestamp
messages[].text
messages[].scope
messages[].scope.kind
messages[].scope.id
entries
entries[]
entries[].id
entries[].kind
entries[].text
entries[].scope
entries[].scope.kind
entries[].scope.id
entries[].actorId
entries[].subject
entries[].subject.id
entries[].subject.displayName
entries[].subject.kind
entries[].evidenceIds
entries[].evidenceIds[]
entries[].origin
entries[].origin.kind
entries[].origin.verified
entries[].origin.source
entries[].origin.source.locator
entries[].origin.source.file
entries[].origin.source.line
entries[].origin.source.recordId
entries[].origin.note
<!-- FIELDS:END -->

关键语义：

- `spaceId`：与 `docs/standalone-protocol.md:30` 同规则（1–80 位，首位字母或数字）。
- `scope.kind`：`private | group | game | channel`，对齐 `CONTEXT.md:7`「场合」与既有离线迁移工具。写入 v1 `/messages` 时以服务端实际接受的场合为准。
- `messages`：可选的原话原料，形状与 `POST /messages` 一致。缺省时证据引用被视为**外部引用**，只给警告、不假装验证过。
- `entries[].id`：调用方生成的稳定 ID，供票 02 做导入幂等；推荐 `sha256(来源标识 + 原始定位 + 归一化文本)`，契约不强制算法。
- `entries[].actorId`：说话人稳定标识。认不出**留空**，不得猜人（对齐既有 `quarantineUnattributedEvidence` 语义）。
- `entries[].evidenceIds`：引用本批 `messages[].messageId`；`role` 必须是 `user`，机器输出不能当事实证据（`docs/standalone-protocol.md:80`）。

## 5. 可追溯性

每条条目必须自带 `origin.source.locator`（原始文件 + 行号，或原始记录的稳定 ID），可选 `file` / `line` / `recordId` 补精确位置。校验结果 `summary.traced` 给出带定位的条目数；**缺失即 `MISSING_FIELD` 并定位到具体条目**，不允许「整批一个来源」覆盖逐条来源。

顶层 `origin` 描述整批来源，`entries[].origin` 描述逐条来源，两者同形状但**互不替代**。

## 6. 禁止事项（fail-closed）

| 禁止 | 拒绝方式 | 理由 |
| --- | --- | --- |
| `embedding` / `vector` / 维度字段 | `FORBIDDEN_VECTOR_FIELD` | 第三方向量无编码身份、维度不符会静默跳过；向量只能由服务按当前编码身份生成 |
| 评分、可信度、置信度等自造字段 | `FORBIDDEN_FIELD`（`additionalProperties:false`） | 不建第二套评分口径 |
| 人格 / 情绪 / 睡眠 / 念想 / 守则等运行态 | 无字段可放 ⇒ 被拒 | 属 Agent 侧，不进记忆服务 |
| 未列字段、拼错字段 | `FORBIDDEN_FIELD` | 防止 `verfied` 这类笔误静默变成「没标未核验」 |
| 引用不存在的证据 | `UNRESOLVED_EVIDENCE`（带 `entries[i]` 定位） | 证据链不能靠字符串猜测 |
| 引用机器输出当事实证据 | `INVALID_EVIDENCE_ROLE` | 与协议一致 |

## 7. 错误与警告

| code | 级别 | 含义 |
| --- | --- | --- |
| `INVALID_JSON` / `READ_FAILED` | error | CLI 读文件 / 解析失败 |
| `UNSUPPORTED_SCHEMA_KEYWORD` | error（抛） | schema 出现白名单外关键字，拒绝执行 |
| `INVALID_FIELD` | error | 类型 / 格式 / 枚举 / `const` / 长度 / 数值下限不符 |
| `MISSING_FIELD` | error | 必填字段缺失（含 `origin.source.locator`） |
| `FORBIDDEN_FIELD` | error | 未知字段 |
| `FORBIDDEN_VECTOR_FIELD` | error | 向量字段 |
| `UNRESOLVED_EVIDENCE` | error | 证据引用未命中本批 `messages` |
| `INVALID_EVIDENCE_ROLE` | error | 证据不是 `user` 原话 |
| `NO_EVIDENCE_BATCH` | warning | 未提供原话原料，证据无法自证 |
| `EXTERNAL_EVIDENCE_REF` | warning | 证据指向本批之外 |
| `NO_EVIDENCE_REF` | warning | 条目未引用原话，只有来源定位 |

每个错误带 `path`（如 `entries[1].origin.verified`）、`index`（条目下标）与中文 `message`。**警告不改成错误，也不静默丢弃**：`missing ≠ 0` 是本项目一贯纪律。

## 8. 使用

```bash
node interop/validate-import.mjs interop/examples/minimal-valid.json
node --test test/import-contract.mjs
```

CLI 输出 `{ok, contract, errors, warnings, summary}`，可读错误逐行打到 stderr；校验不通过退出码 1。`validateImportDocument(document, schema?)` 可被票 02 的转换器直接调用，**不需要启动服务、不需要凭据、不连任何端口**。

## 9. 验收对照（票 01）

| 验收项 | 落点 |
| --- | --- |
| 契约文档 + schema，字段名/类型/错误码无具体产品名 | 本文 + `interop/import-contract.schema.json` + 源码级禁用词测试 |
| 「历史导入 / 未核验」有定义且不会被自动整理当已确认 | §3 五条 + `const:false` + 非法样例 `invalid-verified.json` |
| 最小合法样例通过、非法样例可读错误且定位到条目 | §8 + `test/import-contract.mjs`（六个非法样例逐一断言 `code/path/index`） |
| 结果可追溯到原始条目 | §5 + `summary.traced` + `invalid-missing-origin.json` |
| 不要求部署第三方组件、不依赖服务内部模块 | 校验器只用 Node 内置模块，源码级断言 |
| `npm test` / `test:adapter` 全绿 + 新增契约校验测试 | `test/import-contract.mjs` |

## 10. 明确未做（留给后续切片）

- **导入器**（把某份数据包转成契约文档并写进空间）：票 02，不在本票。
- **「未核验」是否参与评分权重**：仍未定，本契约明确不参与；要改须另开 ADR 并用真库校准。
- **矛盾陈述裁决**：服务只并列保留 + 来源引用，不裁决。
- **人工核对页面**：`docs/TODO-human-review-page-20261107.md`，前端外部负责。
- **已核验数据导入**：需 v2 契约，见 §3 第 5 条。

## 11. 变更记录

- 2026-11-07 [by:WorkBuddy]：用户「其他的你继续吧」⇒ 按 tracker Frontier 认领票 01，新增契约 schema、离线校验器、七个样例（一合法六非法）、专项测试与本文。**未改 `src/core/`、未改协议、未改 `web/`、未推送远端。**
