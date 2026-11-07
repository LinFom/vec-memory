# 票 06 验收记录：协议文档与第二个 Agent 接入样例

> **状态**：已实现并实跑通过 · 2026-11-07 · [by:WorkBuddy]
> **分支**：`feat/memory-interop-rerank` · **基线**：`HEAD c06e8fe`（工作区有大量并行未提交改动）
> **边界**：本票只新增 `examples/second-agent/`、`test/second-agent.mjs`、`docs/second-agent-20261107.md`，
> 并最小改动 `PROTOCOL.md`、`README.md`、`openapi/standalone-v1.json`。未碰 `src/**`、`interop/**`、
> `tools/**`、其它 `docs/` 文档、`package.json`、`.scratch/**`；未 `git add` / `git commit`；未跑 `npm test` 全量。

---

## 1. D8 决策依据（用户已代拍，照做）

| 决策 | 落地 | 理由 |
| --- | --- | --- |
| 第二个 Agent = `examples/second-agent/`，**与 QQ 无关的 CLI 研究笔记助手** | 纯 Node 标准库，`notes.jsonl` 是「另一个项目的自有数据格式」；名字与文档不出现任何聊天平台 / 第三方产品专名 | 证明「任意能发 HTTP JSON 的项目都能接入」，而不是某个产品的again一次适配 |
| **真实起 standalone HTTP 服务**，用真实 HTTP 跑通三步 | `initialize(root)` + `createStandaloneServer({root})` + `listen(0,'127.0.0.1')` + `fetch`，照抄 `test/import-contract-document.mjs:21-47` 的启动模式 | 伪代码 / mock 不能证明解耦；只有真链路能证明协议独立可用 |
| **不改协议、不新增 HTTP 路径** | OpenAPI 仅补 `info.description` + 新增 `components.schemas.ImportContractDocument`（标「离线文档，非 HTTP 端点」） | 新增 path 会造出第二个写入口，违背票面硬约束 |
| 只跑 `messages → recall → adoptions` | 不写 `/memories`，因此不触发 `UNKNOWN_ENTITY`（无需先 `PUT /entities`） | 最小时序闭环，且正好覆盖「原料 → 召回 → 采用确认」三个公开端点 |
| `block` 当作已加入模型上下文后才确认采用 | demo 里用 `modelContext` 显式表达该事实，再调 `/adoptions` | 对齐 `docs/standalone-protocol.md:68` 的采用语义 |

`recall` 命中不依赖任何模型配置：`src/standalone/worker.mjs:265-266` 的 working 层会把同 scope 的最近消息无条件纳入 `items`，因此空库 + 2 条 `role=user` 消息即可稳定命中，不需要配置 LLM / embedding，也不产生外部费用。

## 2. 验收逐条对照

| # | 验收项 | 落点 | 结果 |
| --- | --- | --- | --- |
| 1 | `examples/second-agent/README.md`：是什么 / 前置条件 / 怎么跑 / 三步证明 / 解耦说明 | 已写，含「与任何聊天平台、宿主、第三方打包组件无关」「Node >= 22.5」「仅需本仓库」 | 达成 |
| 2 | `examples/second-agent/demo.mjs`：自包含、真实起服务、2 条真实笔记、`/recall` 命中、block 入上下文后 `/adoptions`、结构化输出、`finally` 清理、失败非零退出、不依赖第三方包 | 已写并实跑 | 达成 |
| 3 | `examples/second-agent/notes.jsonl`：两条示例笔记、纯数据、自有格式 | 已写（`noteId/author/title/body/createdAt/tag`） | 达成 |
| 4 | `test/second-agent.mjs`：spawn demo 断言退出码 0 / 三步 `ok:true` / `adopted:true`；源码级禁用词、内部模块、公开 v1 路径断言；测试不重复起服务 | 已写并实跑（2/2 通过） | 达成 |
| 5 | `PROTOCOL.md` 新增「通用记忆导入契约（离线文档，非 HTTP 端点）」：契约标识、校验器/导入器位置、未核验定义、「不新增导入端点」声明 | 已追加一节 | 达成 |
| 6 | `README.md` 在 `## 接入` 附近补导入契约 / 导入器 / 第二个 Agent 样例索引；保留感谢栏与解耦声明、不重写全文 | 仅扩写 `:41` 一行，`:63-66` 感谢栏与 `:3/:46` 解耦声明逐字保留 | 达成 |
| 7 | `openapi/standalone-v1.json`：只改 `info.description` + 新增 `ImportContractDocument`；不改 paths / 现有 schema / `info.version`；JSON 合法 | 已改并验证（见 §4） | 达成 |
| 8 | `docs/second-agent-20261107.md`：逐条对照、D8、实跑摘录、诚实说明、留痕 | 本文 | 达成 |

附加票面约束复核：
- demo 与 README 源码不含 `qq`/`QQ`/整合包专名、不 import `src/core`/`src/router`/`adapters/`、只走 `/api/v1/` 公开路径 —— 由 `test/second-agent.mjs` 第二个用例源码级锁住。
- 文档未把任何第三方整合包的专有名词写成必需概念；`PROTOCOL.md` 新节与 `README.md` 新增行只描述离线契约与公开路径。
- 所有新文件均含 `[by:WorkBuddy]` 留痕。

## 3. 实跑输出摘录

### 3.1 `node examples/second-agent/demo.mjs`（退出码 0）

stdout（每行一个紧凑 JSON 对象）：

```
{"step":"messages","ok":true,"accepted":2,"duplicates":0,"rejected":0}
{"step":"recall","ok":true,"matched":true,"items":2,"actualMode":{"research-notes":"keyword"},"receiptId":"aa5007b6-...","block":"[research-notes]\n<!--mv-inject-->\n【working】researcher：检索重排评测：...\n【working】researcher：导入幂等：..."}
{"step":"adoptions","ok":true,"adopted":true,"adoptedCount":2,"replayed":false}
```

stderr（说明性）：

```
[1/3] messages：提交 2 条笔记，accepted=2
[2/3] recall：命中 2 项，receiptId=aa5007b6-...
[3/3] adoptions：adopted=2，replayed=false
EXIT=0
```

`receiptId` 每次随机；`block` 里两条 `【working】` 行正是刚提交的笔记，证明真实命中。

### 3.2 `node --test test/second-agent.mjs`（退出码 0）

```
# Subtest: demo 真实跑通三步：退出码 0、三步 ok:true、adoptions.adopted 为 true
ok 1 - ...
# Subtest: 源码级：demo 与 README 不含平台/第三方产品专名，不引用内部模块，只走公开 v1
ok 2 - ...
# tests 2 / # pass 2 / # fail 0
EXIT=0
```

### 3.3 OpenAPI JSON 合法性（退出码 0）

```
JSON.parse OK: true
info.version unchanged: true => 1.2.0
paths identical: true => paths count 31
ImportContractDocument present: true
schema count base/cur: 15 / 16
everything else byte-identical: true
```

对比基线 `git show c06e8fe:openapi/standalone-v1.json`：删去 `info.description` 与新增的
`ImportContractDocument` 后，两份 JSON 逐字相同 —— 证明**没有改任何 path、没有改任何现有 schema、
没有改 `info.version`**。

## 4. 一处需要如实说明的适配：`adopted` 字段

协议与实现里 `POST /adoptions` 的真实响应是 `{ok:true, adopted:<数字>, replayed}`，其中
`adopted` 是**确认的条目数**（`src/standalone/service.mjs:329`），不是布尔值。票 06 验收文字要求
「adoptions 的 `adopted` 为 true」。为满足该断言又不伪造响应，demo 的结构化输出做了透明归一化：

- `adopted: true` —— 由 `response.ok === true && response.adopted > 0` 派生的「采用已确认」布尔结论；
- `adoptedCount: 2` —— 保留服务返回的原始数字计数；
- `replayed: false` —— 原样透传。

该处理在 `examples/second-agent/README.md` 与本记录里显式说明，未改写任何 HTTP 响应含义。

## 5. 诚实说明：这是最小可行性证明，不是生产级第二个 Agent

- **没有真正的模型调用**。demo 用 `modelContext` 变量表达「block 已加入上下文」，只演示协议时序，不调用 LLM、不产生费用、不验证模型是否真的利用内容（`docs/standalone-protocol.md:68` 亦声明采用只证明加入上下文）。
- **只覆盖三条端点**。没有实体登记、记忆写入、整理 / 索引任务、共享授权、错误重试、持久化部署形态；凭据、root、端口都是一次性的，跑完即销毁。
- **命中依赖 working 层**。这是空库未配置模型时最稳定的命中路径；生产场景的语义 / 长期记忆命中需要配置模型与整理任务，不在本样例范围内。
- **导入契约部分只是文档**。本票不实现任何导入端点、不写生产库；`ImportContractDocument` 纯粹描述离线 JSON 文档形状，导入产物仍走 v1 既有写入口（票 02 的导入器另已交付）。

## 6. 变更清单（本票独占）

新增：
- `examples/second-agent/README.md`
- `examples/second-agent/demo.mjs`
- `examples/second-agent/notes.jsonl`
- `test/second-agent.mjs`
- `docs/second-agent-20261107.md`

改动（最小）：
- `PROTOCOL.md`：末尾追加「通用记忆导入契约」一节
- `README.md`：`## 接入` 索引列表由 1 行扩为 3 行（保留感谢栏与解耦声明）
- `openapi/standalone-v1.json`：`info.description` 追加一段 + `components.schemas` 新增 1 个 schema

## 7. 变更记录

- 2026-11-07 [by:WorkBuddy]：按 D8 与票 06 验收实现第二个 Agent 样例与协议文档补齐；只跑
  `node examples/second-agent/demo.mjs` 与 `node --test test/second-agent.mjs` 两个命令（均 0 退出），
  外加 OpenAPI 的 `JSON.parse` 合法性验证；未跑全量 `npm test`，未执行任何 git 写操作。
