# 票 04 · 可选 cross-encoder 精排后端（设计决策与验收）

[by:WorkBuddy] 2026-11-07 · 分支 `feat/memory-interop-rerank` · HEAD `c06e8fe`

> 范围：本票只在**读侧**给「票 03 多信号重排后的同类候选」加一层可选的外部
> cross-encoder 精排。vec-memory 只做 HTTP 客户端：不内嵌模型、不引入第三方
> embedding、不写任何真值层、不进 `encodingIdentity` / `sourceHash`。
> 实现主体：`src/core/rerank-backend.mjs`；接入点：`src/router.mjs` 的
> `applyRecallPolicy()`（票 04 起改为 `async`）。

---

## 1. 决策 D1–D4

### D1 · 端点形状与协议

单一端点、请求/响应都只传必要字段：

```text
POST {baseURL}/rerank
Content-Type: application/json
Accept: application/json
Authorization: Bearer {rerankApiKey}        # 仅当 apiKey 非空

body: { model, query, documents: [string], top_n }
成功: { results: [ { index, relevance_score }, ... ] }
```

- 兼容三种返回形状（按此顺序探测）：`{ data: [...] }`、顶层数组、`{ results: [...] }`；
  行内分数字段同时接受 `relevance_score` 与 `score`（TEI 形态）。
- `index` 是**原始文档下标** `0..documents.length-1`，用来把外部分数映回 `hits`；
  分数按降序、平局按 `index` 升序稳定排序（`b.score - a.score || a.index - b.index`）。
- 只重排、不增不删：`order` 长度恒等于送入的 `hits` 长度；`topN>0` 时没送去打分的
  尾部候选按原下标原序拼接在 `order` 末尾，其 `scores` 为 `null`。
- 载荷校验严格：返回条数、`index` 越界/重复、`relevance_score` 非有限数一律判失败，
  且 `order===null` —— 调用方据此**保持票 03 的原序**，而不是拿半截结果去排。

### D2 · 独立外部服务，进程内只做客户端

- 精排模型是一个**独立部署**的服务，`vec-memory` 不内嵌、不加载权重、不引入第三方
  embedding 依赖。默认关闭（`rerankEnabled=false`）时零外部请求、零新增响应字段。
- I/O（`fetch`）刻意放在 `rerank-backend.mjs`，与纯函数层 `recall-policy.mjs` 物理分开：
  后者永远不出现 `fetch(`（有源码级断言锁住），层次不倒挂。
- `rerank-backend.mjs` 不 `import` 任何真值层模块（`factstore` / `vecstore` /
  `vector-generation` / `embed`），代码体不出现 `writeFileSync` / `encodingIdentity` /
  `sourceHash`（源码守卫，见 §5）。

### D3 · 超时、预算与内存熔断

- `rerankTimeoutMs` 默认 **400ms**，硬上限 **800ms**（`RERANK_TIMEOUT_HARD_CAP_MS`）；
  任何超过上限的取值都被夹到 800，非正数显式报错。
- 在线热路径 **retries=0**（不重试）：一次 `AbortController` + `setTimeout` 超时，
  `finally` 里 `clearTimeout`；有外部取消信号时用 `AbortSignal.any` 合并。
- **连续 3 次 degraded ⇒ 进程内内存熔断**（`RERANK_DEGRADE_LIMIT=3`）：置
  `autoDisabled=true`，本进程余下请求直接跳过精排（零请求、带 `RERANK_DISABLED`），
  避免对一个明显不健康的服务反复烧预算。状态只在内存里、不落盘、不改配置、
  重启归零；一次成功会打断「连续失败计数」，但**已跳闸的 `autoDisabled` 不自愈**
  （只有进程重启或测试用的 `resetRerankState()` 归零）。`rerankState()` 是只读快照。

### D4 · 接入条件与 shadow 语义

- 精排接在 `rerankHits()` **之后**、`trim()` **之前**（`src/router.mjs`）。
- 仅当 `recallPolicyMode ∈ {shadow, enabled}`（即 `cfg.mode !== 'off'`）**且**
  `rerankEnabled=true` **且** 候选 `>=2` 时才发请求；`off` 连精排配置都不解析、
  连精排函数都不调用（与票 03 基线逐字可比）。
- **shadow**：`finalHits` 保持 `out.hits` 的**同一引用**、顺序不动，只把
  `proposedOrder` 写进 `diagnostics.rerank`（`applied:false`）。
- **enabled**：精排成功后 `finalHits = ordered`，并把曝光记账改成「精排后」前 k 条 id。
- 降级时 `finalHits` 保持 `out.hits`（票 03 产物，**不是** store 原始 hits），只重算
  `diagnostics`：回落的是「同一批同类候选的票 03 顺序」。

---

## 2. 配置键表

六个键已纳入 `src/core/recall-policy.mjs` 的 `POLICY_SETTINGS_KEYS`，并同步到四处白名单
（`src/core/backend.mjs`、`src/core/settings-editor.mjs`、`src/standalone/service.mjs`、
`adapters/qq-agent/plugin.json`）。默认值由 `RERANK_DEFAULTS` 单一持有，不在别处重复定义。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `rerankEnabled` | boolean | `false` | 总开关；非 boolean 即 `RERANK_CONFIG_INVALID`。默认 fail-closed。 |
| `rerankBaseURL` | string | `''` | 服务根地址；**开启时必填**，且必须是合法 `http(s)` URL。 |
| `rerankApiKey` | string | `''` | 可选；非空时加 `Authorization: Bearer`。 |
| `rerankModel` | string | `''` | 模型名；**开启时必填**。 |
| `rerankTimeoutMs` | number | `400` | 正数有限数；被硬上限 800 夹住。 |
| `rerankTopN` | integer | `0` | `0`=不设上限；`1..200`，只送前 N 条去打分，尾部原序保留。 |

配置解析严格（`parseRerankConfig`）：任何非法值都显式返回 `ok:false` +
`RERANK_CONFIG_INVALID` + 稳定 `detail`，绝不「差不多就用」。关闭态缺端点/模型不算错，
旧配置照常启动。

---

## 3. 降级码表

`RERANK_DEGRADED` 是稳定码（文案可漂、码不漂），调用方按码分支，不按字符串文案分支。
所有降级分支都 `order===null`、`requestMade` 如实反映是否发过请求，并带熔断快照。

| 码 | 触发 | 是否计入连续 degraded |
| --- | --- | --- |
| `RERANK_TIMEOUT` | `AbortController` 在 `timeoutMs` 内没回应 | 是 |
| `RERANK_COUNT_MISMATCH` | 返回条数 ≠ 送去打分的 `documents.length` | 是 |
| `RERANK_BAD_JSON` | 响应非合法 JSON / 找不到 `results`/`data`/数组 / `res.text()` 失败 | 是 |
| `RERANK_HTTP_ERROR` | 端点 `res.ok` 为假 | 是 |
| `RERANK_FAILED` | 载荷非法（index 越界/重复、分数非有限数）、fetch 抛普通错、配置非法、候选不足 | 视分支：服务端/响应失败计入；配置/关闭/熔断跳过不计入 |
| `RERANK_DISABLED` | 默认关闭、配置关闭、或连续 3 次 degraded 后的内存熔断 | 否 |

> 注：默认关闭 / 配置非法 / 熔断跳过都是「零请求」分支（`requestMade:false`、
> `skipped:true`），不产生外部调用，也不推进连续失败计数。

---

## 4. 与 `/search` 1500ms 预算的关系

- `/search` 的主动查询嵌入走 `queryEndpoint()`，是 **1500ms 总预算 + `retries=0` +
  接客户端断开**（`embed.mjs`）。精排是**串行加在召回之后**的又一次网络调用，若失控会
  直接吃掉 `/search` 的响应预算。
- 因此精排默认 400ms、硬上限 800ms，留足余量给「失败 → 回落 `out.hits` → `trim()` →
  序列化」这段回退路径；`retries=0` 避免慢服务被反复重试放大延迟。
- 默认关闭时**零新增延迟**：不解析配置、不发请求、响应不多一个字段。
- 连续 3 次降级熔断后，后续请求连这 400ms 都不再花，是对预算的二次保护。

---

## 5. 为何不写 `encodingIdentity`（也不写 `sourceHash`）

- `encodingIdentity` 描述的是「文档/查询**如何被编码成向量**」的写入侧口径，用来做
  查询-存储兼容性断言（`assertQueryCompatibility`）。精排是**读后**对已召回的同类
  hits 重排序，不产生新的库内数据、不改向量空间、不影响两侧编码对称性。
- 把它写进身份会让所有历史索引看起来「编码口径变了」，触发无意义的兼容性重建；
  而精排是可选、默认关闭、纯内存派生的增强，开关切换不应改变任何真值层身份。
- 同源纪律：不写 `writeFileSync`、不落盘熔断状态、不碰四个真值层文件
  （`factstore.mjs` / `vecstore.mjs` / `vector-generation.mjs` / `embed.mjs` 相对
  `c06e8fe` 的 `git diff --name-only` 为空，有专项断言锁住）。

---

## 6. 失败为何不退回关键词支路

- 关键词支路（`exact` / token-overlap）与向量支路（cosine）是**两套不同召回语义与
  不可比分数**；`embed.mjs` 的 `auto` 降级是「向量端点挂了 → 换一种召回方式」，
  发生在召回之前。
- 精排失败发生在召回**之后**：候选已经是票 03 重排过的同类 hits，只是「精排这一步
  没做成」。此时正确动作是**回落 `out.hits`**（同批候选、票 03 顺序）+ 带稳定码，
  而不是换一条召回支路 —— 那会把「精排没做成」偷换成「换检索模式」，语义不同、
  顺序不可解释，还会踩中票 03 已明令禁止的「三种分数混排」。
- 纪律：降级不抛 5xx、不静默放行、不改变候选集合，只把 `degraded` 写进 diagnostics。

---

## 7. 验收逐条对照

专项：`test/rerank-backend.mjs`（14 项）、`test/recall-policy.mjs`（15 项，含票 03 基线）。
只跑 `node --test test/rerank-backend.mjs test/recall-policy.mjs`，合并 29/29 全绿、0 fail。

| 验收点 | 覆盖用例 | 结果 |
| --- | --- | --- |
| 正常精排（乱序分数→降序、平局按 index 稳定） | `正常精排：…` | pass |
| 超时（`AbortController`→`RERANK_TIMEOUT`） | `超时：…` | pass |
| 条数不符（`RERANK_COUNT_MISMATCH`） | `条数不符 → …` | pass |
| 非法 JSON（`RERANK_BAD_JSON`） | `非法 JSON → …` | pass |
| 默认关闭（0 fetch、`requestMade===false`） | `默认关闭：…` | pass |
| 兼容形状 `{data}` / 顶层数组 / 行内 `score` | `兼容形状：…` | pass |
| 配置严格性（非 boolean / 非法 URL / 夹 800 / topN 越界 / 开启缺端点） | `配置严格性：…` | pass |
| 连续 3 次 degraded ⇒ `autoDisabled`，第 4 次零请求 | `连续 3 次 degraded …` | pass |
| 一次成功打断连续计数（`resetRerankState` 隔离单例） | `一次成功打断 …` | pass |
| 载荷非法（index 越界/重复/分数非有限数）⇒ `RERANK_FAILED` 且 `order===null` | `响应载荷非法：…` | pass |
| `topN` 截断（只送前 N、尾部原序、条数不变） | `topN 截断：…` | pass |
| HTTP 非 2xx / fetch 抛错稳定降级（附加） | `HTTP 非 2xx …` | pass |
| 源码守卫：不写真值 / `recall-policy.mjs` 无 `fetch(` / router 恰好 4 处 await / 四处白名单含 6 键 / 4 真值层零 diff | `源码守卫：…` | pass |
| 降级「原序不变」结构断言（`let finalHits = out.hits;`、降级分支不写 `finalHits`） | `降级时「原序不变」…` | pass |
| 票 03 C7：4 处 `await applyRecallPolicy` 强断言、返回改成 `trim(finalHits)` 的等价强断言、await 全覆盖断言 | `test/recall-policy.mjs` C7 | pass（15/15） |

> C7 的两条旧断言因 `applyRecallPolicy` async 化而失效：调用点正则改成
> `const pol = await applyRecallPolicy(rt,`（仍强断言「恰好 4 次」），返回断言改成
> 对 `let finalHits = out.hits;` / `finalHits = ordered;` / `finalHits =` 恰好 2 处 /
> `return { hits: trim(finalHits), policy: diagnostics };` 的等价强断言，并补了
> 「所有调用点都带 await」的全覆盖断言（防止第五个调用点漏 await）。**未删减任何原有
> 断言强度**，票 03 其余断言保持原样。

---

## 8. 未端到端实跑的部分（如实留痕）

本票交付的是 **stub 级契约测试 + 源码级结构断言**，以下部分**没有在本专项里端到端实跑**，
不宣称跑过：

- `applyRecallPolicy()` 未导出，无法直接驱动四条召回路径。端到端
  「降级后顺序 == 票 03 `out.hits`」「shadow 同引用、顺序逐字不变」
  「enabled 精排成功后曝光记账与用户所见顺序一致」等，由**票 05 质量回归**覆盖。
  本专项只用源码断言锁住 `let finalHits = out.hits;` 且降级 else 分支只写
  `diagnostics`、不写 `finalHits`（结构断言，非自证式端到端）。
- 未接真实 rerank 服务做联调；所有 HTTP 行为均由注入的 `fetchImpl` stub 验证
  （超时用真实 `setTimeout` + `AbortController`，非 mock 时钟）。
- 未跑 `npm test` 全量（由主代理最后统一跑，避免并发抢临时目录）；本票只跑上述两个
  专项文件。
- 熔断状态是模块级单例，专项里每个用例都用 `resetRerankState()` 隔离，未验证跨进程/
  重启后的行为（设计上重启归零，属运行期语义）。

[by:WorkBuddy]
