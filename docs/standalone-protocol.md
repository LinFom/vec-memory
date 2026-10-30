# vec-memory 独立协议 v1

本契约对应 `tools/standalone-server.mjs`，默认 `http://127.0.0.1:8091`。机器可读接口见 [OpenAPI](../openapi/standalone-v1.json)。旧 `/api/vec` 服务与宿主目录约定继续保留兼容，不是本协议的启动方式。

## 初始化与认证

```powershell
npm run init:standalone -- --root E:\vec-standalone-data
npm run serve:standalone -- --root E:\vec-standalone-data
```

保存初始化仅输出一次的 `adminToken`。浏览器打开 `/standalone.html`。`GET /health` 无需凭据，仅返回进程存活 `{status:"ok",service:"vec-memory",protocolVersion:1}`；它不证明模型配置或后台任务成功。

所有 `/api/v1` 路由，包括版本发现，都要求 `Authorization: Bearer <token>`。管理接口仅接受管理员凭据；项目凭据由管理员创建，默认只读写所属空间。部署远程服务时通过 HTTPS 反向代理传输凭据，不向接入项目分发管理员 token。

写请求必须使用 `Content-Type: application/json`，正文是 JSON 对象，最大 4 MiB。有 Origin 的浏览器请求必须同源；服务端客户端可省略 Origin。成功业务响应含 `ok:true`，错误为 `{ok:false,code,error}`，失败状态使用对应的 HTTP 状态码。批量消息接收中的逐条失败例外见下文。

## 管理空间

| 方法与路径 | 正文与结果 |
|---|---|
| `GET /api/v1/version` | `{ok,protocolVersion:1,implementationVersion,capabilities}` |
| `POST /api/v1/admin/projects` | `{projectId}` → `{ok,projectId,token}`；token 仅返回一次 |
| `GET /api/v1/admin/spaces` | `{ok,spaces:{[spaceId]:{owner,readers}},projects:[projectId]}` |
| `POST /api/v1/admin/spaces` | `{spaceId,owner}` → `{ok,spaceId}`；owner 必须是已有项目 |
| `PUT /api/v1/admin/spaces/{spaceId}/readers` | `{projectIds:[]}` 替换完整读取授权名单，空数组撤销全部共享读取 |
| `GET /api/v1/admin/spaces/{spaceId}/settings` | `{ok,values,secrets}`；密钥仅返回是否已配置 |
| `PUT /api/v1/admin/spaces/{spaceId}/settings` | `{patch:{...}}` → `{ok,changed:true}`；null 删除设置，API key 空字符串保留旧值 |

项目 ID 与空间 ID 为 1–80 位英文字母、数字、下划线或短横线，首位为字母或数字。管理端负责配置嵌入与整理模型。创建空间不会自动开始花费模型调用。

空间所有者也可使用自己的项目凭据调用 `PUT /api/v1/spaces/{spaceId}/readers`，正文同为 `{projectIds:[...]}`，响应 `{ok,spaceId}`。只有所有者或管理员可以替换名单，已有只读授权不能转授权限。

## 消息、身份与记忆

以下路径前缀统一为 `/api/v1/spaces/{spaceId}`。

`POST /messages` 提交 `{messages:[...]}`，每批最多 500 条。每条消息包含：

```json
{"messageId":"m-001","conversationId":"chat-a","actorId":"user-a","role":"user","timestamp":"2026-10-29T08:00:00Z","text":"我喜欢不加糖的茶。","scope":{"kind":"private","id":"chat-a"}}
```

`role` 为 user/assistant/system/tool；时间接受可解析时间字符串或大于零的毫秒数。`text` 可为空，最多 100000 字符。可选 `mentions` 是 actorId 字符串数组或 `{actorId}` 对象数组，最多 100 项；`replyTo` 是原消息 ID。场合为 `{kind:"private"|"group",id}`。所有 ID 都是调用方稳定标识，不需要 QQ 号或 CQ 码。

响应为 `{ok,accepted,duplicates,rejected,results}`。每条结果含 `messageId` 与 `status:accepted|duplicate|conflict|invalid`，失败附 code/error。批量中某条失败不会撤销其他已接收消息，HTTP 200 不代表所有条目成功。同一消息 ID 同内容重复提交计 duplicate；不同内容计 conflict，不重复增加证据。接收成功仅表示原料持久化，尚未整理。

`PUT /entities/{entityId}` 登记 `{kind?,displayName?,surfaces?,aliases?}`。kind 可为 person/group/self/other，默认 person；别名与表面名称为字符串数组。响应 `{ok,entityId,label?}`。同名实体不会跨空间自动合并。

`POST /memories` 提交 `{operationId?,actorId,text,scope,kind?,source?,evidenceIds?,attr?,itemKey?,aspect?}`。actorId 必须已登记；kind 默认 preference，支持现有事实分类但拒绝 pattern；trait 必须带 attr 或 itemKey。source 为 manual/assistant/evidence，默认 assistant：manual 是人工声明，可不附聊天证据；其他来源必须引用已接收、同场合的 evidenceIds。建议始终提供稳定 operationId；同 ID 不同请求冲突。结果包含 `{ok,saved,action?,rev,kind,itemKey?,speaker?,replayed?}`。

## 新事物条目

`POST /discoveries` 接受 `{operationId?,name,scope,evidenceIds,statement?,kind?,aliases?,interpretation?,aspect?,claimType?,quote?}`。kind 为 meme/concept/work/project/object/case，默认 concept；interpretation 为 mention/definition/usage，默认按有无 statement 选择 definition/mention；claimType 为 fact/opinion/pattern，默认 fact。name 最多 200 字符，statement 最多 2000 字符，aspect 最多 100 字符；evidenceIds 与 aliases 为字符串数组，最多 30 项，证据不能为空。所有引用必须是同场合已接收的 user 消息。名称必须出现在证据中，解释与用法必须附逐字原话，原话包含名称；quote 省略时尝试使用完整原消息。别名须在同一原话中明确出现。结果 `{ok,saved,discoveries:[{subjectId,observationId,knowledgeStatus?,ambiguous?,duplicate?}],replayed?}`。

`GET /subjects` 和 `GET /subjects/{subjectId}` 都必须提供 `scopeKind` 与 `scopeId` 查询参数。列表另支持 q，返回 `{ok,subjects}`；详情含 subject、observations（包括撤回历史）与 groups。读取需空间读权限，范围不匹配返回 404。

`POST /subjects/{subjectId}/revisions` 接受 `{operationId,scope,action,observationId,expectedRev,statement?,reason}`。action 为 correct/retract；correct 必须提供 statement。只允许有写权限者修改。成功返回 `{ok,subject,observation,retracted,replayed}`，retract 的 observation 为 null。保留原观察及证据，修正后为人工来源；expectedRev 过期返回 409/STALE_REVISION，相同操作可幂等重试。

新事物默认在规范原料的整理请求中一起发现；thingDiscoveryEnabled:false 可关闭此功能。它不启用自动整理，也不增加一次独立模型调用。候选与来源观察不等于已核验知识；[完整行为和示例](thing-memory.md)。

## 召回与采用

`POST /recall` 接受 `{scope,query?,conversationId?,actorIds?,sharedSpaceIds?,mode?,limit?}`。scope 必填；conversationId 限制工作记忆会话；actorIds 限制人物候选。共享空间只在 sharedSpaceIds 显式请求且有授权时读取，全部请求空间都须通过权限检查。当前 v1 记忆按同一明确场合读取；跨空间授权不扩大场合可见性。

响应 `{ok,items,block,receiptId,actualMode,sources}`。每项包含 `id,localId,spaceId,text,layer,sourceRefs`，可附 score。层包括 working、episodic、long-term、semantic、profile、subject。`actualMode` 按来源空间报告实际检索路径；block 是可纳入模型上下文的文本。来源保留空间与原证据关系，检索本身不增加排练。

内容真正加入模型请求后调用 `POST /adoptions`，正文 `{receiptId,itemIds?}`。省略 itemIds 表示确认收据内全部内容。收据有效期 60 秒，绑定调用项目；确认时重新校验共享授权，重复确认不重复累计。响应 `{ok,adopted,replayed}`。采用只证明加入上下文，不证明模型真正利用或事实正确；工作进程重启可能少计采用，不通过补造采用次数恢复。

## 后台任务与故障

`POST /jobs` 接受 `{type:"consolidate"|"index",operationId?}`，返回 `{ok,jobId,job}`。推荐提供 operationId 以安全重试；同 ID 不同正文返回冲突。`GET /jobs/{jobId}` 返回 `{ok,job}`；`GET /jobs` 返回 `{ok,jobs}`。状态依次 queued/running/completed，失败为 failed 并附 `{code,message}`。提交任务成功不代表任务完成。没有配置模型时整理失败，原料仍保留。

排队与执行状态持久化；服务重启重新调度 queued/running 任务，核心写入去重保护重复执行。failed 任务不会自动重试，修好配置后创建新任务。默认自动调用关闭；显式启用 consolidateEnabled 或 autoIndexEnabled 后，空间 worker 每分钟检查对应间隔并串行执行。status.background 返回最近执行时间和错误；后台记录在内存中，显式 jobs 则有持久任务 ID。空间 worker 首次调用时启动。`GET /status` 返回消息数、实体数、模型是否配置与实际根目录。

常见错误包括 UNAUTHENTICATED、FORBIDDEN、NOT_FOUND、INVALID_ARGUMENT、INVALID_RECEIPT、OPERATION_CONFLICT 与模型/存储失败码。跨空间撤销授权后后续读取和采用都会重新校验。接入方必须检查 HTTP 状态、ok、逐条接收结果和任务最终状态，允许响应增加新字段。

Node.js 与 Python 完整示例位于 [examples/standalone](../examples/standalone)。历史库迁移、语义验收及回退导出见 [迁移操作说明](operations/standalone-migration.md)。

非人工事实的 evidenceIds 必须指向已接收、同场合的 user 消息；assistant/system/tool 机器输出不能作为非人工事实证据。自动整理与派生语料也仅消费 user 消息，原始上下文仍保留全部角色。
