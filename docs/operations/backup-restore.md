# 备份与恢复操作说明

- 适用：vec-memory 独立服务，目标版本 0.32.0
- 文档日期：2026-11-01
- 默认地址：`http://127.0.0.1:8091`（以 `tools/standalone-server.mjs` 为准）
- 原则：在线备份优先用管理页；离线 `create` 必须先停库；恢复失败不切换；回退前先导出新写入

> 本文只描述当前源码实际支持的动作。没有“自动切换启动根”“自动合并空间”“无限流式备份”这些能力。

## 1. 先分清两种备份

| 类型 | 命令/入口 | 包含 | 不包含 | 密码 |
|---|---|---|---|---|
| 完整服务备份 `kind:"service"` | 管理页“完整服务备份”；CLI `create <root> <file>` 不传 spaceId | 服务根下的 `access.json`（凭据哈希、空间 owner/readers）、所有空间、`settings.json`（含模型配置/密钥）、消息与操作日志、场景/账号绑定、向量、`normalizer/secret.key` | `.service.lock`、`backups/`、`*.tmp` | **必须 ≥8 位** |
| 空间备份 `kind:"space"` | 管理页“导出当前空间”；CLI `create <root> <file> <spaceId>` | 单个 `spaces/<spaceId>`：消息、操作日志、场景/账号绑定、事实/向量、`normalizer/secret.key` | `access.json`、共享 readers、服务级项目凭据；`settings.json` 中名字含 key/token/secret/password 的字段；`state.json` 的 jobs/receipts | 可选；**强烈建议设置**，否则是未加密 envelope |

要点：

- 完整备份保存的是**凭据哈希状态**，不是明文 token。恢复后原有 token 仍然有效，但备份本身不会显示 token；管理员 token 丢了，不能靠备份“找回明文”。
- 空间备份仍包含 `legacy/data/memory-vec/normalizer/secret.key`。它决定占位符和旧向量文本，丢失会导致编号不可反推/旧数据不可用；所以空间备份也不能随意公开。
- 完整备份包含模型 API key 等配置；空间备份会把 settings 里的 key/token/secret/password 字段删掉，并把 `autoIndexEnabled`/`consolidateEnabled` 设为 `false`。
- 空间备份把 `state.json` 写成 `{jobs:{},receipts:{}}`；恢复后不保留旧任务和旧采用收据。
- 备份不是数据库快照：未压缩内容上限 **512 MiB**，构建/校验在内存中完成；服务上传额外有 **1 GiB** 上限。大库请用文件系统快照/分区方案，并自行验证。

## 2. 准备

### 2.1 停写还是在线

- **在线备份**：通过管理页或管理 API。服务会进入 maintenance，短暂拒绝新请求（返回 503 `MAINTENANCE`），等待当前请求/队列结束，quiesce 并关闭引擎，再读文件；完成后重开引擎并重新调度 queued 任务。
  - 这不是“完全零停机”：备份窗口内新请求会失败；普通客户端要重试。
  - QQ 适配层有持久消息队列/补发 outbox，服务短暂不可用时可暂存待投递内容；它不是通用服务端消息队列。
- **离线备份**：必须先停服务。`tools/standalone-backup.mjs create` 会检查 `.service.lock` 里的 pid；如果服务还活着，会报 `Service is running; use the online backup API or stop it first`。
  - 正常停止：前台服务按 `Ctrl+C`，或向进程发 SIGTERM；等进程退出、锁释放。
  - 不要在服务还活着时手工删除 `.service.lock`。锁里 pid 仍存活，服务会拒绝第二个写者；强删只会制造并发写风险。

### 2.2 密码只放环境变量

CLI 只读 `VEC_MEMORY_BACKUP_PASSWORD`，**没有** `--password` 参数。不要把密码写进命令行、脚本参数、shell history 或文档。

PowerShell：

```powershell
$env:VEC_MEMORY_BACKUP_PASSWORD = Read-Host -Prompt '备份密码'
# 执行备份命令
Remove-Item Env:VEC_MEMORY_BACKUP_PASSWORD
```

bash/zsh：

```bash
read -rs -p '备份密码: ' VEC_MEMORY_BACKUP_PASSWORD; echo
export VEC_MEMORY_BACKUP_PASSWORD
# 执行备份命令
unset VEC_MEMORY_BACKUP_PASSWORD
```

密码建议使用长随机串；完整备份最低 8 位只是门槛，不是强度保证。

## 3. 在线备份（推荐管理页）

### 3.1 启动服务

```powershell
node tools/standalone-server.mjs serve --root E:\vec-memory-data
```

默认监听 `127.0.0.1:8091`。需要显式指定时：

```powershell
node tools/standalone-server.mjs serve --root E:\vec-memory-data --host 127.0.0.1 --port 8091
```

打开：

```text
http://127.0.0.1:8091/standalone.html
```

### 3.2 管理页步骤

1. 在“管理员凭据”输入初始化时保存的 admin token，点“连接并刷新”。token 只保存在页面内存，连接后会清空输入框。
2. 在“项目与空间”确认目标空间 ID；备份区使用这个空间 ID。
3. 在“备份与导入”输入备份密码（完整备份至少 8 位）。
4. 点“完整服务备份”或“导出当前空间”。
5. 备份生成后，页面会把 `backupId` 填入“备份 ID”；点“下载备份”，得到 `<backupId>.vmb`。
6. 把 `.vmb` 另存到**其他磁盘/其他机器**，不要只放在服务数据盘上；完整备份含密钥，按敏感文件保管。

在线备份的 503 处理：

- 备份窗口内调用 `/api/v1` 可能收到 `503 MAINTENANCE`。这是预期，不是数据损坏。
- 客户端应退避重试；QQ 适配层的队列会保留待投递消息。
- 不要在 maintenance 期间强杀服务；等待备份完成或失败返回。

### 3.3 在线 API（等价入口）

管理员 Bearer：

```http
POST /api/v1/admin/backups
Content-Type: application/json

{"password":"<至少8位>","spaceId":"qq-a"}
```

- 不传 `spaceId`：完整服务备份；必须带密码。
- 传 `spaceId`：空间备份；密码可省略，但建议带。
- 返回 `{ok,backupId,download}`。
- 下载：`GET /api/v1/admin/backups/{backupId}`（管理员）。
- 上传已有备份：`POST /api/v1/admin/backups`，`Content-Type: application/octet-stream`，密码放在 `X-Backup-Password`（base64 后的 UTF-8），正文是 `.vmb` 字节；上传会先 `inspectBackup` 校验。
- 预览：`POST /api/v1/admin/backups/{backupId}/preview`，正文 `{password}`；返回 `kind/files/totalBytes/checksum/sourceSpaceId/automaticTasksSuspendedOnRestore`。
- 恢复：`POST /api/v1/admin/backups/{backupId}/restore`，正文 `{password,expectedChecksum,...}`；必须先预览并传 checksum，否则 `BACKUP_CHANGED`。

## 4. 离线备份（必须先停库）

### 4.1 PowerShell

```powershell
# 1. 先正常停止服务；确认 .service.lock 已消失或对应进程已退出
$env:VEC_MEMORY_BACKUP_PASSWORD = Read-Host -Prompt '备份密码'
node tools/standalone-backup.mjs create `
  E:\vec-memory-data `
  E:\backups\vec-memory-20261101-full.vmb
Remove-Item Env:VEC_MEMORY_BACKUP_PASSWORD
```

空间备份：

```powershell
$env:VEC_MEMORY_BACKUP_PASSWORD = Read-Host -Prompt '备份密码'
node tools/standalone-backup.mjs create `
  E:\vec-memory-data `
  E:\backups\vec-memory-20261101-qq-a.vmb `
  qq-a
Remove-Item Env:VEC_MEMORY_BACKUP_PASSWORD
```

### 4.2 跨平台 CLI

```bash
read -rs -p '备份密码: ' VEC_MEMORY_BACKUP_PASSWORD; echo
export VEC_MEMORY_BACKUP_PASSWORD
node tools/standalone-backup.mjs create \
  /srv/vec-memory-data \
  /srv/backups/vec-memory-20261101-full.vmb
unset VEC_MEMORY_BACKUP_PASSWORD
```

空间备份在末尾加 space ID：

```bash
node tools/standalone-backup.mjs create \
  /srv/vec-memory-data \
  /srv/backups/vec-memory-20261101-qq-a.vmb \
  qq-a
```

### 4.3 参数与行为

```text
node tools/standalone-backup.mjs create <stopped-root> <new-file> [spaceId]
node tools/standalone-backup.mjs inspect <file>
node tools/standalone-backup.mjs restore <file> <new-directory> [expected-checksum]
```

- `create` 用 `flag:'wx'` 写目标文件；目标已存在会失败，不会覆盖。
- 文件权限为 `0600`。
- 完整备份不传密码 → `PASSWORD_REQUIRED`。
- 空间备份不传密码 → 生成 `encrypted:false` 的 envelope；能读文件的人就能读内容。
- 备份跳过 `.service.lock`、`backups/`、`*.tmp`；拒绝符号链接、路径穿越和 Windows 保留名。
- 未压缩总大小超过 512 MiB → `BACKUP_TOO_LARGE`。

## 5. 检查与预览

```powershell
$env:VEC_MEMORY_BACKUP_PASSWORD = Read-Host -Prompt '备份密码'
node tools/standalone-backup.mjs inspect E:\backups\vec-memory-20261101-full.vmb
Remove-Item Env:VEC_MEMORY_BACKUP_PASSWORD
```

输出包含：

```json
{
  "kind": "service",
  "spaceId": null,
  "files": 123,
  "totalBytes": 4567890,
  "checksum": "..."
}
```

检查会验证：

- envelope 格式、密码、AES-GCM tag；
- gzip 后的归档格式、kind、文件列表；
- 路径安全、文件大小、逐文件 sha256；
- JSON 可解析；JSONL 末尾完整；
- DurableLog 行的 seq/previous/hash 链；
- 完整服务备份必须含 `access.json` 且有 `adminHash`。

**检查通过不等于恢复成功**：还要在旁置目录做恢复和 `audit`。检查/预览的 `checksum` 要记录，恢复时用于确认“预览的就是恢复的”。管理 API 强制传 expectedChecksum；CLI 可将 checksum 作为恢复命令第四个位置参数，省略时仍校验归档完整性，但不绑定之前的预览。

## 6. 完整服务恢复（旁置目录，人工切换）

### 6.1 目标

完整恢复永远恢复到**新目录**，不覆盖现有生产根；验证通过后由人停止旧服务、用新根启动。服务 API 的完整恢复会生成 `E:\vec-memory-data.restore-<uuid>` 这样的旁置目录；CLI 由你指定新目录。

### 6.2 CLI 步骤

```powershell
$env:VEC_MEMORY_BACKUP_PASSWORD = Read-Host -Prompt '备份密码'
$review = node tools/standalone-backup.mjs inspect E:\backups\vec-memory-20261101-full.vmb | ConvertFrom-Json
$review
# 核对 kind、files、totalBytes 和 checksum 后恢复同一份归档
node tools/standalone-backup.mjs restore `
  E:\backups\vec-memory-20261101-full.vmb `
  E:\vec-memory-restored-20261101 $review.checksum
Remove-Item Env:VEC_MEMORY_BACKUP_PASSWORD
```

- 目标目录必须不存在；已存在 → `DESTINATION_EXISTS`。
- CLI 恢复后会为每个空间启动 maintenance worker 跑 `audit`；全部通过才输出 `validated:true`。
- 如果 `audit` 失败，命令非零退出；目标目录/暂存目录保留。**不要**把失败目录接到生产启动命令。

### 6.3 管理页/管理 API 步骤

1. 管理页“备份与导入”选择 `.vmb` 上传，输入密码，点“上传备份”。
2. 点“检查并预览”，核对 `kind`、`files`、`totalBytes`、`checksum`、`sourceSpaceId`。
3. 点“按预览导入到旁置目录或目标空间”。完整备份会返回一个新目录（`root.restore-<uuid>`），不会替换当前根。
4. 注意：页面上的“导入的新空间 ID”“所属项目 ID”“显式替换”只对空间归档有意义；完整服务恢复分支不使用这些字段，直接返回旁置目录。
5. 在旁置目录验证：启动一个**不同端口**的临时实例，或按第 10 节检查；不要直接停生产再试错。
6. 验证通过后，停止旧服务，用旁置目录作为 `--root` 启动。
7. 旧根保留，直到新根稳定运行并完成回退演练。

API 等价的恢复请求要求 `expectedChecksum` 与预览一致；服务会 `inspectBackup` → `restoreBackup` 到旁置目录 → `validateRestored`（每个空间 `audit`）。验证失败不会切换，也不会自动删旁置目录。

### 6.4 完整恢复会改变什么

- `settings.json` 的 `autoIndexEnabled`/`consolidateEnabled` 被强制设为 `false`；恢复不会自动开始模型调用。
- 所有空间 `state.json` 的 `receipts` 清空。
- `queued`/`running` 任务改成 `failed`，错误 `RESTORED_REVIEW_REQUIRED`；需要人工复核后重建。
- `access.json` 随完整备份恢复：原有管理员/项目 token 哈希、owner/readers 保留（前提是备份时就有）。
- 备份之后新建的项目/空间不在归档里；恢复旧完整备份会回到备份时点，必须提前确认。
- 消息、事实、场景、账号绑定、向量、`normalizer/secret.key` 都随空间恢复。
- 已完成任务保留旧状态，不代表在新环境可继续；需要重新提交。

### 6.5 验证通过后的检查

```text
GET /health                          → {status:"ok"}
GET /api/v1/version                  → implementationVersion 0.32.0（以实际代码为准）
管理页连接                            → 能看到 spaces/projects
抽查空间 status/recall                → 消息、事实、场景可读
```

再检查：

- 空间 owner/readers 是否符合预期；
- 账号绑定是否还在（应在 `workspace.jsonl` 中随空间恢复）；
- 收据是否为空（应为空）；
- 任务是否有 `RESTORED_REVIEW_REQUIRED`；
- 自动任务开关是否为 false；
- 模型配置是否是你需要的（完整备份会带回旧配置/密钥）。

## 7. 空间导入/替换（不自动合并）

### 7.1 什么时候用

- 把单个空间从旧实例搬到新实例；
- 复制一个空间做演练/归档；
- 用已验证的空间备份显式替换同名空间。

### 7.2 管理页步骤

1. 上传空间 `.vmb`（可带密码）。
2. “检查并预览”核对 `kind:"space"`、`sourceSpaceId`、`checksum`。
3. 填“导入的新空间 ID”和“所属项目 ID”（owner 必须是已存在项目）。
4. 新空间：不要勾“显式替换同名空间”。目标已存在会 `ALREADY_EXISTS`。
5. 替换：勾选“显式替换同名空间并保留回退目录”；目标存在时才会走替换。
6. 点“按预览导入到旁置目录或目标空间”。

### 7.3 服务端实际行为

- 先把归档恢复到 `spaces/<id>.import-<uuid>` 暂存目录；
- 用 maintenance worker 对暂存空间跑 `audit`；
- 写 `import-intent.json`（destination/staging/rollback）；
- 如果目标存在且 `replace:true`：先把旧目录 rename 成 `spaces/<id>.rollback-<uuid>`，再把暂存目录 rename 到目标；
- 更新 `access.spaces[id] = {owner, readers: []}`；
- 成功后删除 intent；失败时保留 staging/rollback/intent，启动时按 intent 补齐。

替换后的状态：

| 项目 | 结果 |
|---|---|
| 共享 readers | **重置为空**；需要 owner/管理员重新授权 |
| owner | 设为请求里的 `owner`（必须是已知项目） |
| 账号绑定 | 随空间 `workspace.jsonl` 保留 |
| 采用收据 | 清空（`state.receipts = {}`） |
| 后台任务 | 空间备份的 jobs 已清空；完整恢复的 queued/running 会 failed；都需要人工复核/重建 |
| 场景历史 | 随 `workspace.jsonl` 保留 |
| 旧目录 | 保留在 `.rollback-<uuid>`，不自动删除 |

**不做自动合并。** 替换是“整空间换掉”，不会把旧空间新增消息合并进新空间。需要合并时，只能按稳定消息 ID/操作日志人工回灌并核对。

### 7.4 CLI 的边界

`node tools/standalone-backup.mjs restore <file> <new-directory> [expected-checksum]` 对空间归档只把内容恢复到指定目录并跑 audit；它**不会**更新服务根的 `access.json`，也不会自动注册成 `spaces/<id>`。要把空间导入一个正在运行的服务，请用管理页/管理 API；CLI 更适合离线检查或手动搭建目录。

## 8. 恢复失败怎么办

### 8.1 保留现场

可能出现这些目录：

- `E:\target.staging-<uuid>`：`restoreBackup` 写入时的暂存；
- `E:\target.import-<uuid>`：服务空间导入的暂存；
- `E:\target.rollback-<uuid>`：替换前的旧空间；
- `E:\vec-memory-data.restore-<uuid>`：服务完整恢复的旁置目录；
- `import-intent.json`：未完成的空间导入意图。

**验证失败不能切换。** 不要：

- 把失败目录直接改成生产根；
- 删除 staging/rollback 后再试；
- 手工编辑 `access.json` 让失败目录“看起来能用”；
- 用旧密码/旧 checksum 反复重试同一个损坏归档。

应该：

1. 保留目录和日志；
2. 用 `inspect` 再看归档 checksum/密码；
3. 恢复到**另一个新目录**重试；
4. 如果 `audit` 报具体空间/文件，先只读检查该文件，不要写入；
5. 确认是归档问题还是环境问题（磁盘空间、权限、路径、密码）。

### 8.2 常见错误

| 错误 | 含义 | 处理 |
|---|---|---|
| `PASSWORD_REQUIRED` | 完整备份没密码或 <8 位 | 设置 `VEC_MEMORY_BACKUP_PASSWORD` |
| `INVALID_BACKUP` | 格式/路径/JSON/JSONL/链/密码错误 | 用 `inspect` 核对；不要修改归档 |
| `BACKUP_CHANGED` | 恢复 checksum 与预览不一致 | 重新预览，确认文件未被替换 |
| `DESTINATION_EXISTS` | 恢复目标已存在 | 换新目录；空间替换走管理页 `replace` |
| `BACKUP_TOO_LARGE` | 未压缩 >512 MiB | 分空间/文件系统快照 |
| `ALREADY_EXISTS` | 空间已存在但没显式替换 | 换新空间 ID 或勾选替换 |
| `INVALID_OWNER` | owner 不是已知项目 | 先创建项目 |
| `RESTORE_FAILED` | 写入/校验失败 | 保留 staging，按错误修环境后换目录重试 |
| `MAINTENANCE` | 在线备份/导入窗口 | 退避重试，不要强杀 |
| `UNAUTHENTICATED`/`FORBIDDEN` | token/权限不对 | 用管理员 token；检查空间权限 |

## 9. 回退：先导出切换后的新增写入

### 9.1 为什么不能只切旧目录

切回旧目录会丢掉切换后新增的：

- 消息（`input/messages.jsonl`）；
- 显式记忆/发现/主体修订（`input/memory-operations.jsonl`）；
- 人物修订意图（`input/correction-intents.jsonl`）；
- 人工修订（`legacy/data/memory-vec/manual/revisions.jsonl`）；
- 场景/账号绑定（`input/workspace.jsonl`）；
- 任务/收据状态（`state.json`）；
- 向量/事件等库文件。

只把启动根指回旧目录，这些新写入不会自动出现在旧版本里，等于静默丢数据。

### 9.2 导出整个空间

先停止新服务写入（或至少停止所有会写该空间的任务/请求），再执行：

```powershell
node tools/standalone-migrate.mjs export `
  --space-root E:\vec-memory-data\spaces\qq-a `
  --to E:\rollback-export-20261101
```

行为：

- `--to` 必须为空/不存在，且与 `--space-root` 不相交；
- 复制整个空间到 `E:\rollback-export-20261101\space`；
- 复制前后比较资产清单；如果空间在导出期间变化，报错并要求暂停写入重试；
- 生成 `export-manifest.json`，记录 `byteIntegrity:true`、`sourceStable:true`；
- 不包含服务根 `access.json`；共享授权/项目凭据不在这个导出里。

### 9.3 回退步骤

1. 停止新服务；确认没有写入。
2. 导出上述空间；把导出目录复制到另一块盘。
3. 在旧版本/旧根上，用稳定消息 ID 回灌新增消息；不要改 ID。
4. 人工操作日志（memory-operations/correction-intents/manual revisions/workspace）逐条核对；能重放的按原 operationId 重放，不能重放的记录为人工处理。
5. 旧版本不能读新协议状态时，不要强行覆盖；保留导出作为证据，按旧版本入口重新录入。
6. 核对消息数、事实、人工修订、场景、账号绑定、来源引用后，再切回旧根。
7. 保留新根/导出目录，直到确认没有遗漏。

**没有自动合并/自动回灌工具。** 这是有意的：跨版本状态合并很容易制造“看起来成功、实际错位”的数据。

## 10. 恢复后的检查清单

### 10.1 完整服务恢复

- [ ] 用新根启动，`/health` 返回 ok；
- [ ] `/api/v1/version` 正常，管理员 token 能登录；
- [ ] `GET /api/v1/admin/spaces` 的项目/空间/readers 符合备份时点；
- [ ] 每个空间 `status`、代表性 `recall` 有结果；
- [ ] 人物人工修订/场景/账号绑定仍在；
- [ ] 收据为空；
- [ ] 任务若有 `RESTORED_REVIEW_REQUIRED`，已人工复核；
- [ ] `autoIndexEnabled`/`consolidateEnabled` 仍为 false，确认后再开；
- [ ] 旧根保留，回退路径可走。

### 10.2 空间导入/替换

- [ ] 目标空间 owner 正确；
- [ ] readers 已重新授权（替换会清空）；
- [ ] 账号绑定在；
- [ ] 场景/历史在；
- [ ] receipts 为空；
- [ ] jobs 为空或已重建；
- [ ] 旧 `.rollback-*` 目录保留到验收结束；
- [ ] 没有把旧空间消息与新空间做“自动合并”。

## 11. 限额与安全

- 未压缩 512 MiB；上传 envelope 1 GiB；全内存，不适合超大库。
- 归档拒绝符号链接、路径穿越、Windows 保留名、重复/父子路径冲突。
- 有密码：scrypt + AES-256-GCM；错误密码/被篡改会失败，不会“解出半个归档”。
- 完整备份包含 `access.json` 哈希、模型密钥、`normalizer/secret.key`；空间备份包含 `normalizer/secret.key`，但不含模型密钥/服务授权。
- 备份文件权限 `0600`；请放其他磁盘/加密卷，不要提交到 git，不要发给不可信的人。
- 密码用环境变量；用完 `Remove-Item Env:` / `unset`。
- 不要把备份密码写进 URL；服务上传用 header，管理页把密码放在请求体/header 中。

## 12. 最小演练（建议每次升级前做）

1. 临时根 `init`，创建项目/空间，写入一条消息/事实/场景。
2. 管理页做一次完整备份并下载。
3. 用错密码 `inspect`，确认失败。
4. `restore` 到新目录，确认 `validated:true`。
5. 用新目录启动另一个端口，登录、recall、检查空间。
6. 做一次空间备份，导入到新空间 ID，确认 readers 为空、账号绑定/场景在、receipts 空。
7. 做一次显式替换，确认 `.rollback-*` 存在、readers 重置。
8. 人为损坏一个归档字节，确认 `inspect`/恢复拒绝。
9. 记录 checksum、目录、时间、操作者；不要只记录“成功”。

## 13. 相关文件与命令索引

- `src/standalone/backup.mjs`：归档/校验/恢复实现。
- `src/standalone/service.mjs`：管理 API、exclusive、空间导入、旁置恢复。
- `tools/standalone-backup.mjs`：离线 `create/inspect/restore`。
- `tools/standalone-server.mjs`：`init|serve --root`，默认 8091。
- `tools/standalone-migrate.mjs`：`export --space-root ... --to ...`，回退前导出。
- `test/standalone-upgrade.mjs`：加密完整/空间备份、错密码/损坏、不覆盖、service 导入。
- `docs/standalone-protocol.md`：管理接口字段。
