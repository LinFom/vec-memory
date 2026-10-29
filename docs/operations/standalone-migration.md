# 独立服务离线迁移

## 初始化独立实例

```powershell
node tools/standalone-server.mjs init --root E:\new-service
node tools/standalone-server.mjs serve --root E:\new-service --port 8091 --host 127.0.0.1
```

初始化仅输出一次管理员 token。打开 `/standalone.html` 管理页并使用该凭据，或通过 Bearer 认证调用管理接口：`POST /api/v1/admin/projects` 提交 `{projectId:"qq-project"}` 获取项目 token；`POST /api/v1/admin/spaces` 提交 `{spaceId:"qq-a",owner:"qq-project"}` 创建空间。共享授权使用 `PUT /api/v1/admin/spaces/qq-a/readers` 和 `{projectIds:["other-project"]}`；空数组撤销读取授权。管理员凭据不提供给接入项目。

对于历史迁移，先初始化服务根并创建项目，暂停服务后执行迁移。迁移目标空间必须为空；已创建空间并写入状态时请改用新的空间 ID，禁止覆盖。迁移后再登记对应空间所有者并启动服务。空库项目可直接创建空间后运行下方示例。

## 离线复制与核对

工具不自动修改生产配置、不启动服务、不调用模型。先停止旧实例的记忆写入和后台整理，再执行；从生产导出前也必须暂停写入。目标必须使用新的旁置目录。

```powershell
node tools/standalone-migrate.mjs migrate --from E:\old\data --to E:\new-service --space qq-a --source-root E:\qq\data
node tools/standalone-migrate.mjs verify --space-root E:\new-service\spaces\qq-a
```

`--from` 是包含 `memory-vec` 的旧数据根。全部文件复制到 `spaces/qq-a/legacy/data`，保留事实键、事件、身份映射、人工覆盖、向量代和编码元数据。需要携带外接宿主原料时显式增加 `--source-root E:\qq\data`，原料完整复制到 `imported-source`，不会自动启用旧目录采集。快照可能包含私密聊天和密钥，报告只包含路径、大小与哈希。

工具拒绝路径交叠、已有目标内容和符号链接，复制后复核源与目标文件清单和哈希。`migration-manifest.json` 的 `byteIntegrity` 仅证明逐字节一致，`semanticRecovery: not-verified` 明确表示尚未通过真实加载及检索验收，不能据此切换。

切换前必须在副本执行现有离线恢复验收，再核对事实数量、身份、人工覆盖、来源引用以及代表性查询。服务配置应明确指向新空间。补齐暂停期间新增消息时使用原稳定消息 ID，禁止同一空间并行启用旧文件采集与协议采集。历史快照的消息与身份转换使用下述显式离线导入；暂停期间新增消息再由 QQ 适配层补投。


## 将快照转换为通用原料

核对复制完整性后，保持独立服务停止，执行：

```powershell
node tools/standalone-import.mjs --space-root E:\new-service\spaces\qq-a
```

导入工具只读该空间的 `imported-source` 快照，不连接 QQ 或模型。优先读取原始证据账本并保留原消息 ID；快照没有证据账本时才读取热、冷消息存档。缺少稳定 ID、发言人或时间的记录会明确拒绝，不生成替代证据。重复执行按相同消息 ID 去重，冲突内容拒绝。

身份词表转换为 `input/entities.json`，原小时块转换为 `input/corpus.json`，消息持久化到 `input/messages.jsonl`。既有 normalizer 密钥和标签、事实键、人工覆盖与向量数据仍由迁移副本保留；裸数字 QQ 身份作为已有 `qq:` 身份的别名。运行期只读规范原料，无需旧宿主路径和 QQ 文件布局，`imported-source` 只作备份。

`import-result.json` 记录转换结果，仍为 `activated:false`。转换不是切换验收：启动后还需核对代表人物、人工修订、事件、文档与来源引用。没有精确来源的旧事实保持原状，不补造消息引用。合成验收入口：`node --test test/standalone-import.mjs`，涵盖移走旧宿主及快照后仍能读取旧事实、文档和身份。

回退前停止新服务写入，导出整个空间（含 `input/` 中原料和写入操作日志、`state.json` 任务与完整旧核心资产）：

```powershell
node tools/standalone-migrate.mjs export --space-root E:\new-service\spaces\qq-a --to E:\rollback-export
```

导出不包含服务根的 `access.json`。不要直接用新空间覆盖旧生产目录：先保留导出，将新增原料和写入记录按稳定 ID 回灌到对应版本能识别的入口，核对后再恢复旧插件配置。导出本身不代表旧版本可读取新协议状态。

跨语言接入示例见 `examples/standalone/client.mjs` 与 `client.py`。设置 `VEC_BASE_URL`、`VEC_TOKEN`、`VEC_SPACE` 后运行。默认只提交消息与读取记忆；整理需 `VEC_RUN_CONSOLIDATE=1`，采用确认需在真正使用内容后设置 `VEC_CONFIRM_ADOPTION=1`。

示例会等待整理任务到 `completed` 后再检索；`failed` 直接报告失败，五分钟未完成则保留任务 ID 供后续查询。采用确认始终使用项目凭据，且只传实际纳入模型上下文的条目 ID。
