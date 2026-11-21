# 独立项目公开源码发布说明

本清单用于从开发目录生成 `E:\WorkSpace\vec-memory-public` 干净源码副本。本次检查未创建仓库、未上传，也未读取或复制生产配置与记忆库内容。

## 发布文件

| 包含 | 内容与用途 |
|---|---|
| `src/` | 全部核心实现、独立 worker、HTTP 与进程内入口；独立 worker 仍复用旧核心，因此不能只复制 `src/standalone` |
| `web/` | 页面源码；独立服务当前实际只端出 `standalone.html`，旧管理页不是独立服务已支持的入口 |
| `tools/standalone-server.mjs` | 初始化与启动，默认 `127.0.0.1:8091` |
| `tools/standalone-migrate.mjs` | 离线旁置迁移、哈希核对与回退导出 |
| `test/standalone-{service,engine,migration}.mjs` | 独立服务、真实 worker、迁移测试，均使用合成临时数据 |
| `examples/standalone/` | Node.js/Python 标准协议接入示例 |
| `openapi/standalone-v1.json` | OpenAPI 3.1 契约 |
| 当前 QQ 适配源码 | 从当前 `plugins/memory-vec` 选择实际入口、清单、所引用模块与对应新测试；不要复制旧文档编年史、临时队列或宿主配置 |
| 新发布说明文件 | 在副本新建精简 README、package.json、.gitignore，按实际依赖生成 lock；许可按用户授权选择 |

不要整体复制原项目根目录。排除 `data*`、`models`、`node_modules`、`_scratch`、`.scratch`、`_rollback`、旧 docs 历史、日志、缓存、生产 `instances.json`/`config.json`、`access.json`、所有导出包与备份。空库配置应由 init 命令生成，示例只使用合成 ID 与空模型配置。

公开副本的 package scripts 应只引用实际携带的工具和测试：`init` 调用 `tools/standalone-server.mjs init`，`start` 调用其 serve，`test` 为 `node --test "test/standalone-*.mjs"`。不要直接复制原 scripts 中依赖未发布 spike、旧测试或其他 tools 的命令。

## README 建议正文

标题：`vec-memory — 独立混合记忆库`。

开头说明：接入项目通过 HTTP JSON 提交消息；库自行保存原料、工作记忆、事件、人物事实与向量，提供关键词/向量检索和采用确认。每项目独立空间，默认隔离，可授权读取指定空间。无需 QQ-Agent；QQ 是一个可选适配器。

快速启动使用 Node.js 22.5+：安装依赖，执行 `node tools/standalone-server.mjs init --root <绝对目录>`，保存仅输出一次的管理员 token，再执行 `node tools/standalone-server.mjs serve --root <同一目录>`。管理页为 `http://127.0.0.1:8091/standalone.html`。

最短接入步骤：管理员创建项目拿到项目 token、登记空间所有者；项目发送带稳定 ID 的消息；需要人物别名时登记 entities；配置模型后触发并等待 consolidate/index 任务；recall 返回分层条目与收据，真正加入上下文后才 adoptions。链接只指向副本实际携带的 OpenAPI、示例和新文档，不指向旧历史路径。

明确模型配置：原料持久化和工作记忆不要求模型；自动整理需要独立 LLM，向量检索需要 embedding；不可用时明确失败或按接口实际行为降级。公开仓库不携带模型权重与作者个人数据。

验证命令使用独立测试；不要将开发树全部测试的数量直接写成公开仓库验收成绩。迁移工具仅提供离线复制完整性，不把哈希一致说成语义恢复成功；公开副本未携带旧 offline 工具时，不引用不存在的验收命令。

## 当前实现与文档核对

`src/standalone/worker.mjs` 现已具有每分钟检查的后台计时器，使用独立 worker 的同一串行链执行工作。`configuredSettings()` 读取空间设置；`settings()` 关闭的是旧核心的全局定时器，以免双调度。不能因后一处 false 就说独立自动任务没有实现。

协议文档中“当前版本通过显式 jobs 执行模型工作，不开启后台自动模型调用”已过时。发布副本应替换为：“默认自动调用关闭；显式启用 consolidateEnabled 或 autoIndexEnabled 后，空间 worker 每分钟检查对应间隔并串行执行。interval 由 consolidateIntervalMin/autoIndexIntervalMin 控制，最小一分钟；最近执行时间与错误可从 status.background 读取。显式 jobs 则提供持久任务 ID 与完成状态。”

后台运行记录当前在 worker 内存中，不是 jobs 列表中的持久任务；重启后按配置重新计时，不能宣称每次定时执行都有持久 jobId 或完整历史。worker 是空间首次调用时惰性建立；后台计时从该 worker 建立后开始，不能宣称仅登记空间就必定立即启动自动整理。显式 queued/running jobs 的恢复由 service 状态负责，二者要分开说明。

v1 业务与管理端点按凭据判定权限；静态入口不要求凭据。**本机回环地址上未携带凭据的请求自 0.32.2 起按管理员处理**（发行版默认如此），携带无效凭据仍返回 401，非回环来源一律要求 Bearer；要强制鉴权用 `--require-auth` 启动。owner 的 `/api/v1/spaces/{spaceId}/readers` 与管理员的 admin readers 入口均已实现。共享仍要求请求显式列出 sharedSpaceIds，并遵守同场合过滤；不自动合并跨空间身份。

当前独立管理页提供设置、空间授权、记忆检索及任务操作；完整旧记忆管理页和人工修订界面不能仅因 web 目录被复制就宣传为独立端口可用。

## 只读源码扫描结果

2026-10-29 扫描 src、web、standalone 工具/测试、示例、OpenAPI 与当前 QQ 适配源码，共 79 个文件。检测项目为 key/token/secret/password 等赋值给非空长字符串、常见 provider token 形态、私钥 PEM 头，以及个人机器绝对路径；本轮均无命中。该结论是明确规则扫描结果，不等于任意形式的秘密不存在。

相对导入检查未发现指向仓外的执行依赖。唯一表面缺失引用位于 `src/core/host.mjs:4`，属于解释历史耦合的注释示例，不是运行 import。独立 server 的页面相对依赖要求保留 `web/standalone.html`。核心代码的旧宿主文件读法作为兼容模式仍存在；独立模式走 canonical input，不依赖作者机器的外部绝对路径。

另有历史 QQ 数字案例存在于源码注释或示例说明中，发布副本应审查脱敏。以下只列位置，不输出原数字：`src/router.mjs:3160,3202`；`src/core/chunkread.mjs:14,39`；`src/core/corpus.mjs:72`；`src/core/crosschat.mjs:127`；`src/core/edges.mjs:188`；`src/core/facts.mjs:23,149`；`src/core/factstore.mjs:147,184`；`src/core/judge.mjs:56,96,131,137,143,157,170,259`；`src/core/normalize.mjs:5,268,421,487,584,589,757`；`src/core/vocab.mjs:20,29,55`。先确认是注释还是运行样例，再替换为合成标识，不批量改动正则规则或运行常量。

本文件未批准任何生产切换，也未替代公开副本生成后的测试与最终源码检查。
