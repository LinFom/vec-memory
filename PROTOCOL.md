# 对接协议

正式对接契约为 [独立协议 v1](docs/standalone-protocol.md)，机器可读版本见 [OpenAPI](openapi/standalone-v1.json)。

业务前缀 `/api/v1`；业务与管理请求按凭据判定权限。本机回环地址上**未携带**凭据的请求自 0.32.2 起按管理员处理（默认免凭据，便于本机单人使用），携带了无效凭据仍返回 401；非回环来源一律要求 Bearer。要强制鉴权，用 `--require-auth` 启动服务（见 [0.32.2 说明](docs/console-embedding-0.32.2.md)）。接入者无需提供 QQ-Agent 目录、配置或存档格式。

场合 `scope.kind` 支持 `group/private/game/channel`，`scope.id` 是渠道稳定标识，可包含冒号。迁移保留原 `game:...` 等渠道键；内部既有不透明场合标签保持兼容，不改写历史事实键。原料、来源引用和场景绑定仍按完整渠道键隔离。

旧 `/api/vec` 路由仅作为内部兼容实现保留，不是新项目的接入接口。

## 0.32.1：自动线索与主动查询

`recall` 可传 `purpose:"automatic"` 或 `purpose:"query"`。自动模式在整个响应（包括显式共享空间）中合计最多返回两条关键词命中的人物印象或档案字段，空查询或无匹配不填充人物档案；每条带 `matchMethod:"keyword"`。其他记忆层沿用原规则。主动查询保留完整检索路径，省略 purpose 保持兼容行为。

查询文本可按已登记、无歧义的姓名或别名定位未发言的人；也可明确传 `actorIds`。不得靠昵称片段合并身份。新空间跨渠道人物档案默认不开放，仅管理员显式配置 `profileCrossScope` 后按既有可见性规则读取，其他渠道的原始来源引用不会随档案返回；空间授权仍需同时满足。

人物证据引用可新增 `reporterId/aboutActorId/attribution`：分别表示表达者、被描述者，以及 `self-report/third-party/window-context`。A介绍B时可以为B建档，保留A的来源；提问或猜测不能据此写成肯定事实。
# 0.32 扩展：场景、人物纠正与备份

`POST /api/v1/spaces/{spaceId}/workspace` 使用 `action` 选择业务操作：`scenes/query` 读取可见场景，`ensureScene` 登记当前场合，`entry` 新增观察或候选，`support` 以目标场景明确原话支持候选。管理员还可使用 `state/scene/link/preview/retract`，以及带 `entryId/expectedRev/previewToken` 的 `entry` 修订。禁止依赖调用方传入的 `admin`，服务始终由凭据决定管理权限。

`entry` 使用 `operationId/sceneId/scope/kind/text/evidenceIds`。项目写入需已接收的用户原话；跨渠道提交不自动成为原场景共识。`confirm/shareable` 及已有条目的修订只允许管理员。`derivedFrom` 指向明确的场景条目或人物条目 ID；纠正预览区分 `proven` 与 `suspected`。撤回保留墓碑，同内容重投不会复活；恢复必须显式修订已有 ID。查询共享条目不返回外部原话、历史或旧导入原记录。

`POST /api/v1/spaces/{spaceId}/people` 以 `actorId/scope` 读取人物。`profiles` 是档案，`impressions` 是动态印象。管理员 `action:preview` 提供 `target:{key,itemKey}`，然后 `action:revision` 提供 `operationId/expectedEtag/previewToken/op`（`replace/hide/restore`，仅 replace 接收 value）。有明确场景依赖时必须预览；事务决定持久化后在重启时补齐关联撤回。

账号绑定使用 workspace `action:link`，管理员提供已登记的 `a/b/confirmed:true`；解绑另传 `active:false/expectedRev`。稳定 ID 保留，昵称不作自动绑定证据，绑定不扩大空间或场合权限。`recall` 省略 `sceneId` 时只自动注入当前场景；显式指定其他场景时仍按 shareable 过滤。

管理员备份接口：`POST /api/v1/admin/backups`（完整服务需至少 8 位 password，指定 spaceId 为可携带空间备份），`GET .../backups/{backupId}` 下载；二进制上传到集合入口用 `application/octet-stream`，`X-Backup-Password` 为密码 UTF-8 的 base64，最大 1 GiB；普通 JSON 仍限 4 MiB。`POST .../{backupId}/preview` 验证密码/版本/校验和，`POST .../{backupId}/restore` 必须带预览的 `expectedChecksum`。完整恢复生成新旁置目录；空间恢复提供 spaceId、owner，替换必须 replace:true 并保留旧目录。备份期间新请求返回 `503 MAINTENANCE`，客户端保留原 operationId/messageId 后重试。恢复清空收据并暂停自动任务，导入不自动继承共享授权。

## 0.33：关系星图扩展

新增 graph、graph-evidence、graph-memories、relationships、graph-identity、relation-backfill。它们复用 v1 凭据、空间权限与统一错误。项目图查询必须给 scope，显式 sharedSpaceIds 联合读取并在返回前复核授权；维护与全场合展开只开放管理端。本机回环免凭据模式沿用现有选择，项目凭据不因此获得管理权。详见 [关系星图说明](docs/relationship-galaxy-0.33.0.md) 和 [OpenAPI](openapi/standalone-v1.json)。

### 渠道显示名同步（0.33.2）

`ensureScene` 支持可选的 `name`、`nameSource: "adapter"` 和 `previousName`。适配器名称来自平台元数据；服务保留手工命名，适配器改名时按上一次已确认的名称比较更新。响应包含 `nameSyncSupported: true`、实际保存的 `name`、`nameSource`、`updated`、`manualPreserved`，并可含 `staleName`。客户端应记录回执中的名称作为下一轮的 `previousName`。名称不参与空间、账号或渠道身份匹配。
