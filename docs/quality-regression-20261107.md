# 票 05 — 导入与重排后的检索质量回归 [by:WorkBuddy]

日期：2026-11-07 · 分支 `feat/memory-interop-rerank` · 工具 [`tools/evaluate-quality-regression.mjs`](../tools/evaluate-quality-regression.mjs)

## 0. 这份报告证明什么、不证明什么

**证明**：把第三方数据按票 02 的契约导入、以及打开票 03 的策略层，都没有弄坏原有 6 条合成标注查询的检索结果；新特性全关时与 2026-11-01 的历史基线逐字可比；三个 suite 全程零外部模型请求；精排端点不可用时 `/search` 会保持票 03 的顺序并返回稳定降级码。

**不证明**：生产库上的真实检索质量、LLM 抽取质量、任何「重排更好」的结论。标注集是 6 条人工合成查询（`test/fixtures/recall-labelled.json` 自述 "tests keyword behavior and visibility, not LLM extraction quality"），样本量小到无法支撑显著性判断；CI 这类统计工具在这里没有意义。

## 1. 实测结论（数值）

复现命令：`node tools/evaluate-quality-regression.mjs --out-dir docs`

| 指标 | before（全关） | after（策略层 enabled） | 导入回归 | 历史基线 20261101 |
| --- | --- | --- | --- | --- |
| `precisionAt8` | 1 | 1 | 1 | 1 |
| `recallAt8` | 1 | 1 | 1 | 1 |
| `falseInjectionRate` | 0 | 0 | 0 | 0 |
| `latencyMs`（6 条合计） | 35 | 37 | 38 | 21（本次实跑值；每次重跑会变，以快照 JSON 为准，不参与判定） |
| `externalModelRequests` | **0** | **0** | **0** | 0 |
| `queries` | 6 | 6 | 6 | 6 |

- `offMatchesBaseline = true`：`comparable(before)` 与 `comparable(docs/recall-evaluation-20261101.json)` **逐字相等**（只忽略机器相关的 `latencyMs`）。延迟数值不参与判定，它是本机瞬时抖动，不是质量指标。
- 导入回归把票 02 的 4 条条目与 2 条原话写进**同一个库**的 `private:chat-a`；标注查询都在 `group:*`，场合隔离生效，6 条指标一条没变。
- 精排 `rerankEnabled` 默认 `false`，三个 suite 都没开，所以「策略层 enabled」这一列**没有**外部请求，也不代表精排效果。

快照文件：[before](quality-regression-before-20261107.json) · [after](quality-regression-after-20261107.json) · 历史基线 [recall-evaluation-20261101.json](recall-evaluation-20261101.json)（原文件保留未改）。

### 1.1 补测：精排降级原序（票 04 遗留项）

票 04 的 `test/rerank-backend.mjs` 只做了源码级结构断言，明确把顺序回退交给本票。为此把 `src/router.mjs` 的 `applyRecallPolicy()` 改成命名导出（**只加 `export`，逻辑零改动**），`test/quality-regression.mjs` 直接喂同类候选并真正执行降级分支：

| 步骤 | 配置 | 结果 |
| --- | --- | --- |
| ① 基准 | `recallPolicyMode=enabled`, `rerankEnabled=false` | 得到票 03 的原序、截回请求 k=4；`policy` **无** `rerank` 字段 |
| ② 降级 | 同上 + `rerankEnabled=true`、端点指向不可达地址 | 不抛异常，`hits` 顺序与 ① **逐字一致**、条数仍为 4、`policy.rerank.degraded` 为 `RERANK_*` 稳定码、`applied:false` |
| ③ kill switch | `recallPolicyMode=off` | `policy === null`，返回原数组本身（未放大召回） |

两次调用刻意用不同 `chatKey`，否则第一次的曝光记录会改变第二次的票 03 顺序，把曝光效应误判成精排问题。这一步真正跑通了「失败回落 03 的顺序」，不再是源码猜读；但它**不是 HTTP `/search` 全链路**（没起服务、没真实召回），见 §3。

## 2. 口径与纪律

- **集合指标**（`precisionAt8` / `recallAt8` / `falseInjectionRate`）与 `tools/evaluate-memory.mjs` 完全同口径：6 条标注查询、只取 `layer==='semantic'`。正因如此才能与历史基线逐字对拍。
- **不经过 `/search`**：`engine.call('recall')` 走的是独立工作进程的召回，不经过挂策略层的 `/search`。所以 before/after 的 `ndcgAt8` / `mrr` 相同是**预期**，不是「重排无效」的证据；位置敏感的重排评测另见 `tools/evaluate-recall-policy.mjs` 与 `docs/cost-and-mitigations-20261106.md`（合成集 CI95 覆盖 0，只报未发现劣化）。
- **隔离副本**：每个 suite 跑在独立子进程 + 独立临时 root，用完 `fs.rmSync` 删除。归一化器是进程级单例，同进程建多个 dataRoot 会串库 —— 这是必须分进程的原因，不是风格选择。
- **生产库只读**：评测不接触 `data/`、`data-2/` 或任何运行中的服务端口。

## 3. 未端到端实跑 / 未做的部分（诚实清单）

1. **真库标注集**：没有。6 条合成标注不能替代真实会话标注，无法给出生产权重；`--grid` 搜出来的权重在 `evaluate-recall-policy.mjs` 里已明确标注 "must NOT be copied into production config"。
2. **在线 shadow / canary / 自动指标回滚**：没有。当前是离线三态快照 + 按空间灰度的设计，没有线上流量切分与自动回滚。
3. **真实 cross-encoder 服务**：没有。只覆盖了「端点不可用 ⇒ 降级」，**没有**跑过「端点正常 ⇒ 逐对精排改变顺序」的真实模型往返；正常路径由 `test/rerank-backend.mjs` 的 stub 覆盖。
3b. **HTTP `/search` 全链路**：没有。降级验证是直接调用导出的 `applyRecallPolicy()`，没有起服务、没有走真实向量/关键词召回；四条召回路径的接线仍由 `test/recall-policy.mjs` 的 C7 源码断言锁住。
4. **生产环境下的延迟 / 吞吐**：没有。`latencyMs` 是本机临时目录里的耗时，仅供回归对比，不作 SLA 依据。
5. **统计显著性**：没有。样本 6 条，不跑 bootstrap、不报 CI、不宣称更优。
6. **票 07 开/关两态的位置敏感评测**：`test/event-gist.mjs` 覆盖了事件派生与回查，`evaluate-recall-policy.mjs` 的位置敏感评测在 07 开关两态未单独重跑；07 的验收项里这一条仍标为未完成，见 tracker。

## 4. 验收对照

| 票 05 验收 | 状态 | 证据 |
| --- | --- | --- |
| 保留历史基线快照，新增 before / after 两份 | ✅ | 原 JSON 未改；新增两份快照 |
| precision@8、recall@8、误注入率、延迟、外部模型请求数都有数值 | ✅ | §1 表格 + 快照 JSON |
| 关闭新特性时 `externalModelRequests`=0 且与历史基线逐字可比 | ✅ | `offMatchesBaseline=true`，测试 `comparable()` 深比对 |
| `npm test` 与 `npm run test:adapter` 全绿 | ✅ | 由最终全量回归验证（见分支提交说明） |
| 结论区分「实测结论」与「未实跑」 | ✅ | §1 / §3 分节，§3 六条 |
| （附加）票 04 降级原序的真实执行验证 | ✅ | §1.1 + `test/quality-regression.mjs`；HTTP 全链路未跑，见 §3 |

## 5. 变更记录

- 2026-11-07 [by:WorkBuddy]：新增评测工具、两份快照、本报告、`test/quality-regression.mjs`。未改 `src/core/` 真值层、未改协议、未改 `web/`、未改生产库。
