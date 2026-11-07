# vec-memory

独立、自托管的混合记忆库。任何项目通过 HTTP JSON 提交消息，即可使用工作记忆、事件记忆、人物事实、新梗与概念条目、关键词与向量检索，以及采用后排练和长期记忆提升。无需安装 QQ-Agent。

每个项目使用独立记忆空间。空间所有者可以授权其他项目读取；接入方必须显式选择共享空间。身份、原料、缓存、后台整理和采用记录均按空间隔离。

0.32.1 将自动人物印象收紧为合计最多两条关键词线索，补齐“A 谈 B、B 未发言”的识别与建档；更多信息由记忆工具主动查询。见[补丁说明与验证范围](docs/third-person-recall-0.32.1.md)。

## 启动

需要 Node.js 22.5 或更新版本。

发行包的逐步操作见[安装与接入手册](docs/安装与接入手册.md)。Windows 解压后可依次双击 `install.cmd`、`init.cmd`（仅新库）、`start.cmd`；默认数据保存在程序目录旁的 `vec-memory-data`，升级时继续使用原数据目录。包内不捆绑 Node.js 或依赖，首次安装依赖需要联网。

```sh
npm ci
npm run init -- --root /absolute/path/to/memory-data
npm start -- --root /absolute/path/to/memory-data
```

Windows 可将路径换成 `E:\vec-memory-data`。保存初始化时仅显示一次的管理员凭据，然后打开 [管理页](http://127.0.0.1:8091/standalone.html)。通过管理页创建项目、获取项目凭据、登记空间所有者。项目凭据用于业务调用，管理员凭据用于配置和空间管理。

原料持久化和工作记忆无需模型。自动整理需配置 LLM，向量检索需配置 embedding；未配置时明确报告任务失败或使用关键词降级。模型由使用者自行配置，自动模型任务默认关闭。

## 接入

1. 使用项目凭据提交带稳定 ID 的消息，并登记可选的主体名称和别名。
2. 配置模型后，提交整理或索引任务，查询任务直至完成。
3. 调用 `recall` 获取分层记忆与来源引用。
4. 条目实际加入模型上下文后，再调用 `adoptions` 确认采用。

全部业务接口使用 `Authorization: Bearer <project-token>`。远程部署请通过 HTTPS 反向代理。

- [接口协议](docs/standalone-protocol.md) · [OpenAPI 3.1](openapi/standalone-v1.json)
- [Node.js 示例](examples/standalone/client.mjs) · [Python 示例](examples/standalone/client.py)
- [历史数据迁移与回退](docs/operations/standalone-migration.md)
- [QQ-Agent 适配](adapters/qq-agent/README.md)
- [新事物自动发现、候选与人工纠正](docs/thing-memory.md)
- [完整设计](docs/完整设计文档.md) · [本次改进与评估对照](docs/项目客观评估.md) · [验收记录](docs/acceptance-20261101.md)
- [备份、导入与回退](docs/operations/backup-restore.md)
- [通用记忆导入契约 v1](docs/memory-import-contract-20261107.md) · [离线校验器](interop/validate-import.mjs)
- [TODO（未实现）：人工核对页面](docs/TODO-human-review-page-20261107.md) — 设计一直有、实现一直没做；前端由用户侧负责

0.32 新增通用场景档案、逐条跨渠道授权、关联纠正、人工确认的跨平台账号绑定，以及人物档案前置展示。完整备份密码加密，导入支持旁置验证与回退副本；不需要更换存储引擎。旧群记忆通过 `tools/import-group-memory.mjs` 显式导入为未核验候选。

本仓库仅提供源码、空库初始化和合成测试，不包含作者记忆、生产配置、凭据或模型权重。旧宿主格式的读取只用于兼容与显式导入；独立实例正常运行使用自己的规范原料。

## 验证

```sh
npm test
npm run test:adapter
```

测试使用临时库和模拟模型，不产生外部模型费用，覆盖隔离、共享撤销、持久化重启、整理、索引、采用确认与旁置迁移。

维护者可在干净、已提交的检出中执行 `python tools/build-release.py --output <新输出目录>`，生成服务源码包、QQ 适配器包、独立手册和 SHA-256 清单；`*-share.zip` 将发行包、接入手册和完整设计资料放在一起，便于分享。构建仅使用 Git 跟踪的发行目录，不包含本机数据、凭据、依赖或 DSH 执行记录。

### 0.33.0 三维关系星图

新增人物与渠道的真正三维星海、分层互动及明确关系、来源侧栏和关系修订、按需记忆展开、显式多空间联合投影，以及可暂停续跑的手动历史关系回填。保留现有控制台与本机免凭据模式。见 [使用、设计和验收](docs/relationship-galaxy-0.33.0.md)。

## 感谢

感谢 **二鸟** 及其分享的「溟月的心」整合包。本仓库在通用记忆导入契约、检索重排和「更像人」的记忆组织方式上，参考了该项目分享的设计思路与数据格式；该项目没有公开的源代码仓库，因此这里不附链接。借鉴仅限于思路与格式映射：vec-memory 与该整合包在代码、运行依赖和部署上完全解耦，仓库内也不包含它的实现或数据。
