# 新事物记忆

记忆可以围绕新梗、术语、作品、项目或物件建立条目，无需先登记成某个人的属性。条目仍受空间授权和场合隔离约束，同名不表示跨空间或跨场合的同一事物。

## 两条记录路径

- 后台整理：规范消息源默认在原有整理请求中一起提取 `discoveries`，不额外发起一次模型请求。必须配置整理模型，再显式提交 `consolidate` 任务，或开启 `consolidateEnabled`。自动模型任务仍默认关闭。`thingDiscoveryEnabled:false` 可关闭整理中的新事物发现。
- 主动记录：客户端调用 `POST /discoveries`；QQ 适配开启独立协议后提供 `remember_thing`。服务不为这次写入调用模型，只核对证据、记录条目；解释是否忠于原意仍由调用方负责。

只有名称、没有解释时记录 `mention` 候选，召回显示“待确认”，不会从出现次数猜测含义。有用户明确解释或用法时记录带引用的 `definition` 或 `usage`。`observed` 表示存在来源观察，不表示已验证为客观真理。服务核对用户消息、场合、名称及逐字摘录，不能靠字符串核对证明语义正确。

别名须有包含两个名称的原话。按同场合的精确名称或已有别名匹配；多个主体同名或类型冲突时保留独立候选，不做相似度合并。后续解释会保留并撤下旧的“待解释”记录。不同说法保留来源，召回标记冲突。人工纠正优先，后续自动输出仅作为待确认候选。

## 协议示例

先向同一空间提交原话：

```json
{"messages":[{"messageId":"m1","conversationId":"team","actorId":"alice","role":"user","timestamp":"2026-10-30T08:00:00Z","text":"冰箱战术就是先把暂时解决不了的问题放一边。","scope":{"kind":"group","id":"team"}}]}
```

再向 `/api/v1/spaces/demo/discoveries` 提交：

```json
{"operationId":"thing-m1","name":"冰箱战术","kind":"meme","interpretation":"definition","statement":"先把暂时解决不了的问题放一边","evidenceIds":["m1"],"scope":{"kind":"group","id":"team"}}
```

省略 `statement` 和 `interpretation` 即记录候选。`quote` 可给逐字摘录，省略时服务寻找包含名称和全部别名的完整证据消息。接口返回 `discoveries:[{subjectId,observationId,knowledgeStatus,...}]`。检索时使用相同场合和名称或别名，结果层为 `subject`，带来源和候选/人工/冲突标记。

`GET /api/v1/spaces/demo/subjects?scopeKind=group&scopeId=team` 列出条目；在 `subjects/{subjectId}` 上使用相同查询参数读取包含历史记录的详情。管理员或空间所有者可在管理页选择场合、查看条目，纠正或撤回观察。

向 `/api/v1/spaces/demo/subjects/{subjectId}/revisions` 提交：

```json
{"operationId":"fix-1","action":"correct","observationId":"返回的观察ID","expectedRev":1,"statement":"先暂缓处理，并约定复查时间","reason":"补充遗漏条件","scope":{"kind":"group","id":"team"}}
```

`action:retract` 不需要 statement。修改保留原版本、原证据及人工说明，不删除历史。版本过期返回 `STALE_REVISION`；相同 operationId 和请求可安全重试，不同请求返回冲突。共享读取方可以查看有授权场合的条目，不能修改。

## QQ 工具可用性

工具说明改用具体日常触发条件：明确喜好一次即可记，想查旧事即可搜，新梗解释使用 `remember_thing`。适配器补齐空间、操作 ID 和本轮已核对的用户消息引用；没有原话时明确失败。开启独立协议后需重载插件以注册新工具，旧协议不注册无法使用的工具。

如果模型一直不调用，先核对最终工具表：宿主的工具总开关、memory 分类、单工具覆盖、插件启用状态和运行时限制都会影响暴露。描述修正与接口测试不等于已经证明调用率提升；本仓库测试不调用外部付费模型。
