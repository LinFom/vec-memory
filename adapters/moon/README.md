# 溟月对接模块

`createMoonMemoryAdapter` 接收 vec-memory 的地址、空间 ID、角色 ID 和凭据。由宿主从收到的消息事件提取真实会话，传给 `forConversation({kind, id})`，再把返回的方法交给角色调用。会话和角色来自宿主上下文，不能由模型指定。空间凭据由宿主管理。

`recall` 提供主动查询，`temporalQuery` 区分现状与历史，`notes` 和 `tasks` 读取当前会话的开放事项。写入方法沿用服务的操作 ID 与修订规则。请求超时或失败会抛错，宿主可在该轮略过记忆材料。避免把第二套聊天记忆作为失败回退。

当前 QQ-Agent 宿主已完成实际联调：`inner-life` 1.1.0 注册 `inner-life__memory`，目标空间、角色和会话由宿主配置及运行上下文绑定。工具可查询、创建、结束或纠正念想、心事、一天、待办及人物状态。证据从当前会话的用户原话取回，兼容提示词中的 `#id`，写入前确认服务已接收原话。接口失败返回明确错误，不声称已保存。两个实例均已部署并确认工具注册；真实聊天由用户触发，验收使用隔离 HTTP 服务。

下文保留其他 inner-life 版本与洛版门面的接入方式；这些入口使用各自的宿主 API。

## inner-life 1.54.0

会话适配器通过 `notes({kind: 'concern'})` 读取心事，通过 `notes()` 读取念想。写入使用 `writeNote`，生活时间线使用 `day` 和 `writeDay`。内心层沿原有的私聊首轮恢复入口读取这些记录。首版在恢复时显示当前时间前后各 24 小时内按事件时间排序的最后一条生活记录，并标注计划、已发生或虚构。写入由可信宿主显式调用。

宿主启动时用同一个对接实例调用 `installInnerLifeMemory(adapter)`，并在卸载时执行返回的清理函数。它使用 v3.0.62 交付包中 inner-life 实际调用的 `recallFor` / `restoreFor` 门面。

隔离实例启用 inner-life 的 `membusInjectEnabled`，关闭 `eventMemEnabled`，停用原 `moon-membus`、`moon-memory`、`moon-memlib` / `local-memory` 和离线抽取。首次验证可把 `membusGroupEnabled` 设为 false。已有旧门面时安装会失败。保持宿主的通用消息摄入开启。

相关记忆只消费当前会话可追溯到原消息的候选，使用自动召回策略。未完事项仅从收到的私聊会话恢复。请求失败返回空命中，不启用旧记忆库。当前模块由启动层显式安装。

### 洛版加载

将本目录复制到洛版的插件目录，插件 ID 为 moon-vec-memory。按洛版既有流程信任并启用该本地插件，设置 vec-memory URL、空间 ID 和角色 ID。以启动进程的 MOON_VEC_MEMORY_TOKEN 环境变量提供该空间的项目凭据。启用时安装门面，停用时释放门面。
