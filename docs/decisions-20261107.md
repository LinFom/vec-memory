# 2026-11-07 未定项决策记录 [by:WorkBuddy]

> 用户指令：「完成剩余的票吧，有问题的话按照专业通用的思想来决定决策」。
> 本文把 `map.md` 的 7 项 **Not yet specified** 与开工前必须先定的 cross-encoder 部署位置逐条定成明确口径。
> 原则：**不造第二个真值源、不新增写入口、默认关闭可降级、诚实标注代价**。所有决策都可被测试或文档反查，不靠口头约定。

## 决策表

| # | 原未定项 | 决策 | 落地位置 | 代价 / 边界 |
| --- | --- | --- | --- | --- |
| D1 | cross-encoder 端点形状 | 外部 HTTP `POST {baseURL}/rerank`，body `{model, query, documents:[string], top_n}`，响应 `{results:[{index, relevance_score}]}`；兼容 `{data:[...]}` / 顶层数组 / 行内 `score` | `src/core/rerank-backend.mjs`、`docs/rerank-backend-20261107.md` | 这是 Cohere / Jina / TEI / Xinference 通用形状，不是自定义协议；不兼容的服务要写一层薄适配 |
| D2 | 模型选型与部署位置 | **独立外部服务**，vec-memory 只做 HTTP 客户端；不内嵌模型、不引入第三方 embedding、不写进 `encodingIdentity` | 同上 | 多一个运维组件；但避免 rerank 模型版本变化误触发整库向量代重建 |
| D3 | 超时预算怎么分 | 默认 400ms、硬上限 800ms、`retries=0`（在线热路径不重试）；`/search` 总预算 1500ms 里给 embedding 与回退留 >700ms；连续 3 次 degraded ⇒ 进程内内存熔断自动跳过精排 | 同上 | 熔断是进程级内存状态，重启归零、不落盘；故意不写配置，避免「悄悄改了用户的设置」 |
| D4 | 精排作用域 | 只在 `recallPolicyMode ∈ {shadow, enabled}` 且 `rerankEnabled=true` 时跑；`off` 连函数都不调用、响应零新增字段；`shadow` 只把 `proposedOrder` 写 diagnostics、hits 保持同一数组引用 | `src/router.mjs` `applyRecallPolicy()` | 默认 `false`，`externalModelRequests` 保持 0 |
| D5 | 曝光降权作用域 | 沿用既有 `channelKey(spaceKey, channel, chatKey)`：按空间 + 通道 + 会话隔离，跨空间不统一排序口径 | `src/core/exposure.mjs`（票 03 已实现，本轮不改） | 跨空间一致性没有；这是与「空间隔离」架构一致的取舍 |
| D6 | 导入数据是否参与评分权重 | **不参与**。`origin.verified=false` 只是来源属性，不进召回打分、不冒充可信度分数 | `interop/import-contract.schema.json` + `docs/importer-20261107.md` | 要改须另开 ADR + 真库标注集校准；自动整理没有「升级为已确认」的路径，确认只能走服务既有人工写入口 |
| D7 | 曝光信息是否对外提供 | **不外露**。曝光是纯内存有界派生量，不进备份、不进 `encodingIdentity`、不进协议 | `src/core/exposure.mjs`、`docs/cost-and-mitigations-20261106.md` | 外部无法审计历史曝光；这是为防止派生状态变成第二真值源 |
| D8 | 第二个 Agent 样例选哪个项目 | `examples/second-agent/`：一个与 QQ 无关的 **CLI 研究笔记助手**，纯 Node 标准库，真实起 standalone 服务跑 `messages → recall → adoptions` | `examples/second-agent/`、`docs/second-agent-20261107.md` | 最小可行性证明，不是生产级 Agent；无真实 LLM 调用，`block` 入上下文用 `modelContext` 表达 |
| D9 | 矛盾陈述是否由服务裁决 | **不裁决**，保留并列 + 各自来源引用 | 既有场合并存行为；`docs/importer-20261107.md` §3 | 用户可能以为「系统会自动合并」，实际不会；已在文档写明 |
| D10 | 07 的事件衰减常数 | **不新造、不照抄第三方**。复用既有 `RETIRE_DAYS=30 / PROMOTE_HITS=9 / RETIRE_DIM_WEIGHT=0.3` 三态实现，只补可复现的多时间点测试 | `src/core/consolidate.mjs`（未改常数）、`test/event-gist.mjs`、`docs/event-gist-20261107.md` | 常数仍**未用真库校准**（原代码已注明 `RETIRE_HALFLIFE_GAIN` 未校准）；改值须真库标注集 + 另开 ADR，且遵守 `tokens.mjs:13-16` 的常数纪律 |
| D11 | 说话人认不出时怎么办 | 落在**导入契约校验器**：缺 `actorId` ⇒ 标 `unattributed`、`usableAsEvidence:false`、不写事实记忆；若同时想挂 `subject.kind=person` ⇒ `UNATTRIBUTED_PERSON` 拒绝 | `interop/validate-import.mjs`、`src/core/event-gist.mjs`、`test/event-gist.mjs` | 不改运行时 `message()` 的 `actorId` 必填协议，避免动 openapi；离线镜像一份纯函数是刻意的（契约层零 `src/` 依赖），两处口径由测试对齐 |
| D12 | 08 人工核对页面怎么办 | **不认领、不实现前端**（用户已明确划界）。本轮只把「现有 API 能否枚举未核验候选」核清：票 02 的 `/workspace` 台账提供了数据源，但**没有聚合队列接口/页面**；若前端需要只读聚合接口，另开后端票，不在前端本地维护第二份「已核对」状态 | `docs/TODO-human-review-page-20261107.md`、tracker 08 | 08 仍是唯一未 resolve 的票；两套 `web/` 不同步的发布缺口由前端负责人先定基线 |

## 附：本轮统一的工程纪律

- **失败降级不换语义**：精排超时回落票 03 的顺序，**绝不退回关键词支路**（两者语义不同，别照抄 embed 的 `auto` 降级）。
- **源码守卫要能被打脸**：票 03 的 C7 教训（断言只覆盖自己写过的代码 ⇒ 全绿无意义）在本轮继续生效；新增 async 化后 C7 断言同步改成「恰好 4 处 `await`」，没有放宽。
- **诚实标注未实跑**：真实 cross-encoder 成功往返、HTTP `/search` 全链路、真库标注集、在线 canary、统计显著性 —— 全部在 `docs/quality-regression-20261107.md` §3 逐条列出，不写成「已验证」。
- **留痕**：所有新增/修改的代码注释、文档、工单统一标 `[by:WorkBuddy]`；判「谁改的」只认标注，不认 mtime。

## 变更记录

- 2026-11-07 [by:WorkBuddy]：用户授权自主决策 ⇒ 定 D1–D12，覆盖 `map.md` 的 7 项 Not yet specified + cross-encoder 部署/超时。逐项对应到实现与测试文件。
