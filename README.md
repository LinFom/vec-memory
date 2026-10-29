# vec-memory

独立、自托管的混合记忆库。任何项目通过 HTTP JSON 提交消息，即可使用工作记忆、事件记忆、人物事实、关键词与向量检索，以及采用后排练和长期记忆提升。无需安装 QQ-Agent。

每个项目使用独立记忆空间。空间所有者可以授权其他项目读取；接入方必须显式选择共享空间。身份、原料、缓存、后台整理和采用记录均按空间隔离。

## 启动

需要 Node.js 22.5 或更新版本。

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

本仓库仅提供源码、空库初始化和合成测试，不包含作者记忆、生产配置、凭据或模型权重。旧宿主格式的读取只用于兼容与显式导入；独立实例正常运行使用自己的规范原料。

## 验证

```sh
npm test
npm run test:adapter
```

测试使用临时库和模拟模型，不产生外部模型费用，覆盖隔离、共享撤销、持久化重启、整理、索引、采用确认与旁置迁移。
