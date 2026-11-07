# CLI 研究笔记助手 —— 第二个 Agent 接入样例

[by:WorkBuddy] 票 06 · 与任何聊天平台、即时通讯宿主或特定产品无关的独立小项目。

## 这是什么

一个**命令行研究笔记助手**：它把研究员自己的笔记（[notes.jsonl](notes.jsonl)）当作记忆原料，
借助 vec-memory standalone 服务的公开 v1 协议存取记忆。它是「第二个接入方」的样例 ——
除了本仓库的 standalone 启动入口，它不依赖任何宿主、平台组件或第三方打包代码。

- 纯 Node 标准库实现，没有运行时依赖、没有模型配置、没有外部网络调用。
- 有自己的数据格式：`notes.jsonl` 每行一条笔记，字段是 `noteId/author/title/body/createdAt/tag`
  （外加一个 `_by` 来源标记）。服务不需要认识这些字段，接入方只需把它们适配成公开协议的消息形状。
- 名字、文档、源码里都不出现任何具体聊天平台或第三方产品的专有名词。

## 前置条件

- Node.js **>= 22.5**（用到全局 `fetch`、`AbortSignal`）。
- **仅需本仓库**：仓库依赖已安装即可（`npm ci` 后用 `node_modules`）。不需要额外安装包。
- 不需要预先初始化数据目录、不需要管理员凭据文件、不需要配置 LLM / embedding。
  脚本自己在系统临时目录里造一个全新 root 并启动一次独立服务。

## 怎么跑

在仓库根目录执行：

```sh
node examples/second-agent/demo.mjs
```

自动验证（会自行 spawn 上面的脚本，不会重复起服务）：

```sh
node --test test/second-agent.mjs
```

`demo.mjs` 会：

1. 在临时目录 `initialize` 出 adminToken，`createStandaloneServer` 起在 `127.0.0.1` 的随机端口；
2. 用真实 HTTP（含 `Authorization: Bearer` 与 `content-type: application/json`）跑完三步；
3. 把三步结果以**每行一个紧凑 JSON 对象**打印到 stdout，说明性文字走 stderr；
4. 在 `finally` 里关闭服务（`closeAllConnections` + `close`）并删除临时目录；
5. 任一步失败以非零退出码结束。

## 三步分别证明什么

| 步骤 | 端点 | 证明 |
| --- | --- | --- |
| 1 | `POST /api/v1/spaces/{sid}/messages` | 自有 `notes.jsonl` 格式经公开写入口落地，`accepted === 2`。服务不认识、也不需要认识笔记格式。 |
| 2 | `POST /api/v1/spaces/{sid}/recall` | 公开读路径可用：刚提交的笔记被命中（working 层），拿到 `items`、`block` 与 `receiptId`。命中不依赖任何模型配置。 |
| 3 | `POST /api/v1/spaces/{sid}/adoptions` | 采用确认这一公开写路径可用：在 `block` **当作已加入模型上下文**之后调用，返回 `ok:true` 且确认了条目。 |

stdout 的第三步里 `adopted: true` 是对服务真实响应 `{ok:true, adopted:N}` 的归一化结论
（「采用已确认」），原始计数保留在 `adoptedCount`，不改写响应含义。

## 为什么这证明了解耦

- **不依赖宿主**：脚本自己起 standalone 服务，不假设任何外部进程、目录约定或存档布局。
- **不依赖第三方打包组件**：全程只用 Node 标准库 + 本仓库的 standalone 启动入口；
  没有引用任何服务内部实现模块，也不触碰适配器目录。
- **只用公开 v1 协议**：所有请求都走 `/api/v1/` 前缀的三个公开端点
  （外加建项目 / 建空间两个管理端点），不碰任何私有路径，也不新增任何 HTTP 路径。
- 换句话说：换任何一个能发 HTTP JSON 的语言 / 框架，照样能复现这三步。

## 边界（诚实说明）

这是**最小可行性证明，不是生产级第二个 Agent**：

- 它没有真正的 LLM 调用；「把 `block` 加入模型上下文」用一个显式变量表达，只演示协议时序。
- 它只覆盖 `messages → recall → adoptions`，没有实体登记、记忆写入、整理任务或错误重试策略。
- 它用临时目录、随机端口、一次性凭据，跑完即销毁，不是长期部署形态。

完整逐条验收与实跑输出见 [票 06 验收记录](../../docs/second-agent-20261107.md)。
