# 诚实代价：量化、主流解法与本轮落地（2026-11-06）[by:WorkBuddy]

> 状态：用户已批准 6 张票的 A 粒度，本文件是该粒度下票 03 的详设与开工记录。
> 分支 `feat/memory-interop-rerank`，基线 `c05e79f`。方法出处见 §8，**按可信度分层**。
> 本文不含本机绝对路径、真实身份信息，也不把任何第三方整合包的专有名词写成必需概念，可随分支公开。

---

## 0. 先修正：代价不止 5 条，且有两条当时说轻了

原设计（`design-hybrid-20261106`）§6 列了 6 条。逐行复核 `vec-memory-public` 之后重新盘点：

| # | 代价 | 复核后的变化 |
| --- | --- | --- |
| C1 | 服务从无状态变成有可丢弃派生状态 | 原方案要落 `policy-state.json` ⇒ **本轮改纯内存有界，代价大幅下降** |
| C2 | 多信号权重必须用真库校准 | **说轻了**：现有评测指标与顺序无关，且根本不覆盖 `/search`，**测不出重排好坏** |
| C3 | 配额 / 闸门改变号B 每轮看到的记忆 | 需补「kill switch 可测」与「自动回退」，否则回滚窗口以分钟计 |
| C4 | gist 不能存第二份原文 | 07 已于 2026-11-06 批准新增 ⇒ 本轮仍只锁约束，实现由 07 承载 |
| C5 | `off`/`shadow` 期看不到效果、跳不过对拍 | **说轻了**：6 条标注查询远达不到显著性所需样本量 |
| C6 | `policy-state.json` 误入备份 / `encodingIdentity` | **被 C1 的纯内存方案直接消解** |
| C7 | **（新）全路径一致性** | `/search` 实有**四条**召回路径；只挂一处 ⇒ 其余静默不重排。2026-11-07 复核发现首版自称「三条都接了」的断言本身就是假的 |

一句话：**C1/C6 被消解，C2/C5 被低估，新增 C7**。下面每条按「代价到底多大 → 主流/专业方法 → 本项目落点 → 还剩什么 → 验收」展开。

---

## 1. C1 — 可丢弃派生状态

**代价量化**（原落盘方案）：

- 每轮一次写 `<space>/state/policy-state.json`。按窗口 3 轮 × 每轮最多 8 条 id × 约 60 B ≈ 1.5 KB/会话；一天千轮就是**千次小文件写**，且是每次查询路径上的同步写。
- 一旦被纳入完整备份，恢复出来的曝光状态与事实层不同步（备份里的 `slots.jsonl` 是 T 时刻，曝光计数是 T+Δ），行为不可复现。
- **最贵的一种**：若误进 `encodingIdentity()`（`src/core/vector-generation.mjs` 的 6 字段），改一次权重就触发**整库重嵌**。这不是理论风险——本项目此前就是为了控制嵌入额度才做分批重嵌与可续跑作业。
- 原设计还要额外定作用域、TTL、重建方式、备份排除清单，是一整块运维面。

**主流方法**：CQRS 的 projection / materialized view 纪律 —— 「read model 是缓存，不是真值；坏了就从事件重放重建」「projection 必须幂等，用 UPSERT 而非 INSERT」「每个 read model 独立、可丢弃」。配合有界 TTL 缓存与 `event_id` 幂等键。多个来源对这套口径一致（§8-A）。

**本项目落点（本轮实做）**：`src/core/exposure.mjs` 改为**纯内存、有界、无 fs 引用**：

- 作用域 `spaceId + chatKey`；`MAX_SESSIONS=256`、`MAX_TURNS=8`、`MAX_IDS_PER_TURN=32`、TTL 10 分钟；内存上界约 256×8×32×96 B ≈ 6 MB 量级。
- 无写盘 ⇒ **0 备份面、0 `encodingIdentity` 耦合、0 写放大**，服务在事实层仍然无状态。
- 幂等：同一轮重复 `recordExposure` 只覆盖不累加；LRU 淘汰最久未用会话。
- 若将来确需跨进程，按 §8-A 的投影规则另开：独立 state 文件 + 版本号 + 可从 `injectionReceipts` 重放 + 显式排除出完整备份，**不进本轮**。

**还剩什么（诚实）**：代价从「备份 / 重建 / 误重建」换成「**进程重启后前 8 轮没有曝光记忆**」，且多进程不共享。对一个「让同一条记忆别连续刷屏」的软策略，这是可接受且可解释的退化——重启本来就打断会话连续性。

**验收**：源码级断言 `exposure.mjs` 不含 `fs` / `writeFile` / `backup` / `vector-active` / `encodingIdentity`；仓库里不存在 `policy-state.json`；重启语义写进模块注释与 README。

---

## 2. C2 — 权重校准（被低估最严重的一条）

**代价量化**：

- 5 个信号量纲不同：余弦约 `[-1,1]`，`src/core/tokens.mjs` 的话题重合度是 `[0,2]` 且封顶。直接照抄 `0.45/0.20/0.15/0.10/0.10` 做加权和而不先归一化，量纲大的那一路会**单独主导**最终结果，权重数字形同虚设。§8-A 的 Weighted Sum Fusion 明确把「normalization prerequisite」列为首要失败点。
- `tokens.mjs:16` 原文：「改这些常数 = 换口径，必须另开 ADR 并用真库数据校准」。
- **更硬的一条**：`tools/evaluate-memory.mjs:17` 的三个指标 —— `precisionAt8 = relevant/returned`、`recallAt8 = relevant/expected`、`falseInjectionRate` —— 全是**集合指标，与顺序完全无关**。重排前后这三个数必然一样。
- 而且 `worker.mjs:214` 的 `layer:'semantic'` 来自 `selectInjectLines()` 的注入属性层，`evaluate-memory.mjs:12` 只 filter 这一层；策略层挂在 `/search`（`worker.mjs:234` → `router.mjs`）。**这份历史基线压根不经过被测代码**。⇒ 拿它跑「通过了」是假通过。

**主流方法**：

- **Fusion Weight Tuning**（§8-A/§8-B）：把权重当超参，用网格搜索或贝叶斯优化，在**标注集**上最大化 NDCG@10 / MRR；三分割 train / validation / held-out test + k-fold 防过拟合；权重向保守默认做正则。
- **先归一化再融合**：min-max 或 z-score，否则加权和无意义（§8-B）。
- **RRF（Reciprocal Rank Fusion）是免调权的替代**：只用名次、不用分数、无超参，天然免疫量纲与分数饱和（§8-B）。
- 进阶：把各信号当特征交给 LTR（LambdaMART）（§8-B）；多目标 LTR 论文同时给出「离线 NDCG + 在线 A/B + p 值」的完整范式（§8-A, arXiv:2407.07181）。

**本项目落点（本轮实做）**：

1. **默认不加权和，改用 RRF 名次融合** —— 零超参、绕开量纲问题，也绕开「手抄数字」。第三方那组 `0.45/0.20/…` 只作为**可调权重的形状参考**，不作为默认值。
2. 加权和作为显式可选 `weighted` 策略，**强制先做 min-max 归一化**；权重外置为 `recallPolicyWeights`（JSON 字符串），解析失败 / 字段缺失 / 非有限数 → 回退 RRF 并返回 `degraded.code='POLICY_CONFIG_INVALID'`，**不静默**。
3. 每条命中输出各信号分量与最终名次来源（`policyDiagnostics`），满足「为什么这条排第一可解释」。
4. 新增 `tools/evaluate-recall-policy.mjs`：**位置敏感**指标 MRR / NDCG@8 + 原三项作 guardrail + 三态快照 + paired bootstrap；`--grid` 只用于验证「权重搜索工具链能跑」，输出**必须**标注合成集、不构成质量证明。

**还剩什么（诚实）**：真库标注集目前**不存在**。本轮**不产出任何生产权重**，也不宣称重排更优；生产权重必须等 05 的真库标注集 + 另开 ADR（对齐 `tokens.mjs:16`）。谁拿合成集结论去配生产，就是把 §0 说的假通过又造一遍。

**验收**：默认配置下 `enabled` 态只用 RRF；加权策略单测覆盖量纲归一化；评测工具能输出 MRR/NDCG@8；文档明写「合成集不作质量依据」。

---

## 3. C3 — 灰度与一键回滚

**代价量化**：改的是「每轮给模型看哪几条记忆」，属于体感级变化；一旦发现策略有 bug，可能连续多轮注入错内容且无报错。本项目 `src/` 改动需要完全退出 Electron 重启（跨 65 s 节流），**靠改代码回滚，故障窗口以分钟计**。

**主流方法**：feature flag + progressive delivery（§8-A）—— flag schema（key / type / default / owner / expiry）、**默认 fail-closed**、确定性 sticky 分桶、canary 1%→5%→25%→50%→100%、预定义阈值的**自动回滚**（「人凌晨三点发现不是回滚策略」）、dark launch 零副作用（「shadow 里的 bug 只该产生一行日志，不该产生一次事故」）、**kill switch 必须被演练过**（「没被用过的 kill switch 是负债」）。

**本项目落点（本轮实做）**：

- `recallPolicyMode` 就是 flag，默认 `off`（fail-closed）。`off` 时**连策略函数都不调用**，响应不新增任何字段 ⇒ 与历史基线逐字可比。
- `shadow`：算全部分量写进 `policyDiagnostics`，**hits 顺序原样不动**，零副作用。
- `enabled`：分量参与定序。`POST /spaces/{id}/settings` 改一个键即时切态 = **不需要重启的 kill switch**。
- 自动回退：策略层抛错 / 返回条数不符 / 出现非有限分数 ⇒ 本轮原顺序 + `degraded.code='POLICY_FAILED'`；连续 N 次 degraded 自动把本次运行置回 `off`（内存计数，不写配置）。
- **按空间灰度**替代百分比灰度：先测试空间 → 再号B 空间。本服务单实例、无用户级流量切分，按空间是与架构匹配的等价物；**不做** sticky hash 分桶，因为没有那个需求（写清楚，不假装做了）。

**还剩什么（诚实）**：没有真正的在线 A/B 与自动指标回滚；按空间粒度较粗。这两项归 05 的在线部分，本轮不做也不宣称做了。

**验收**：三态各一份快照；单测覆盖「kill switch 从 enabled 切回 off 后顺序立即复原」与「连续 degraded 自动回退」。

---

## 4. C4 — gist 不能存第二份原文

**代价量化**：若淘汰时把原文复制成「摘要文件」，N 条事件就多 N 份文本；更正一条事实要同步两处，漂移后无法裁决哪份是真值 —— 正好退化成第三方那种 append-only 影子库。淘汰语义也会二义：是「删原文留摘要」还是「两份都留」。

**主流方法**：CQRS projection（只存派生、幂等、可丢弃、可从事件重放）+ **指针/外键回指而非复制**；事件侧用 tombstone + compaction 的语义（淘汰只留元数据，原文由唯一真值层持有）（§8-A）。

**本项目落点（只锁约束，本轮不实现）**：gist 只能是**同一条记录的派生字段**，附 `evidenceIds` 回指原消息 id；不新建文件、不新增实体类型、不复制原文；需要重建摘要时按回指重放。07 号票已于 2026-11-06 由用户「按照建议」批准新增（被 01、03 阻塞），本轮**仍不写实现代码**，约束由该票的验收项 + 一条 CI 断言占位（标 `pending-07`）承载。

**还剩什么**：07 已 publish 但被 01、03 阻塞，事件衰减/gist/锚点回查/说话人兜底**有票无实现**；实现前不得放宽「不复制原文」这条红线。

---

## 5. C5 — 影子期看不到效果，且「对拍」不能自证

**代价量化**：

- matched-pair 的经验样本量 `n_pairs ≈ 16σ²/MDE²`（§8-A，dev.to）：σ≈0.18、MDE=0.04 ⇒ **≈324 对**；简单 rubric 至少 100 对，高方差 300–400+。现有 fixture 是 **6 条查询**，CI 必然极宽。
- 叠加 C2：现有指标连顺序 delta 都算不出来，所以「跳不过 05」不只是流程要求，是**当前根本没有可用的度量**。

**主流方法**：offline regression gate + trajectory replay + shadow / canary / A-B 三段（「offline catches regressions, online catches reality」「不要只凭离线分数上线」）（§8-A）；**matched-pair**：同一批输入跑 A/B、取 per-example delta、bootstrap 10 000 次给 95% CI、要求下界 > 0；**A/A 自对照**扣掉系统自身噪声（GitHub `dshakes/distil` 的 EVALUATION.md）；CI gate 应是「一篮子阈值」而非单一数字；distribution-free 上界可作为小样本的诚实表述。

**本项目落点（本轮实做）**：`tools/evaluate-recall-policy.mjs`

- 三态快照 + 逐查询 paired delta（MRR / NDCG@8 / precision / falseInjection / latency）+ bootstrap 95% CI；
- guardrail：`externalModelRequests = 0`、`degraded = 0`、latency 不劣化、`off` 与基线逐字一致；
- 报告**强制**写明：「6 条查询只作回归 tripwire；CI 覆盖 0 表示**未发现劣化**，不等于证明等价，更不等于证明更优」；
- 门禁判据只做回归，不放行任何质量结论。

**还剩什么（诚实）**：真库标注集与在线 shadow 仍不可跳，归入 05。本轮把「跳不过去」的成本降到「一条命令 + 一份如实标注局限的 JSON」，**没有**把它变没。

---

## 6. C6 — 被 C1 消解

原第 6 条（policy-state 误入备份 / 编码身份触发误重建）随「不落盘」消失。保留这一条记录，是为了让以后有人想把曝光状态改成文件时，能立刻看到它为什么当初被否决。

---

## 7. C7 — 全路径一致性（新增，2026-11-07 修正）

**代价量化**：`/search` 命中路径不止两条。首版写了「三条都接了」，但静态复核 `router.mjs` 后实际是**四条**：关键词主路、`auto` 降级路、向量路、以及 `kind=event` 的向量支路（`router.mjs:1613`）。最后一条同样是「同类 hits 内部重排」，却从未接策略层；而 C7 测试只数了块层三个调用点就宣布全绿 —— **断言恰好只覆盖自己写过的代码，全绿毫无意义**。这类「自证式通过」比单纯的漏接更危险：它还会给出一个假的信心。

**主流方法**：单一纯函数 + 在每条召回路径的同一抽象层调用；contract test 覆盖全部分支（§8-A 的 flag/分支测试纪律）。补充一条本项目自己的纪律：**分支数要从路由表/调用点反向盘点，不能从已实现的调用数正推**。

**本项目落点（已实做）**：`rerankHits()` 与分数来源无关，四条路径各插一次，`cfg` 只解析一次并透传；测试断言 `const pol = applyRecallPolicy(rt,` 恰好 4 次、`k: storeK` 恰好 4 次。事件**侧车** / 档案层**有意不参与**（守 `router.mjs:1633`「三种分数不可比」）—— 注意「事件侧车（IDF 容器）」与「`kind=event` 的向量文档路」是两回事，别混。

**还剩什么**：关键词路的 `matched` 字段与向量路不同，可解释分量里要标 `source` 以免误读。

---

## 8. 方法出处（按可信度分层，不把博客当论文）

**A. 同行评议 / 一手工程文档**

- arXiv:2407.07181《Multi-objective Learning to Rank by Model Distillation》—— 离线 NDCG + 3 周在线 A/B（+0.37% CVR, p=0.02）、权重网格搜索、服务延迟对比。<https://arxiv.org/html/2407.07181v1>
- PLOS ONE（MMR / xQuAD / popularity discount / NDCG@K 公式与 ILD 指标）。<https://journals.plos.org/plosone/article/file?id=10.1371%2Fjournal.pone.0344537&type=manuscript>
- Learning to rank 词条 —— NDCG / MRR 定义、离线评估须固定候选集与未触碰 test set、**paired comparison 的抽样单位是 query/user/session 而非单条文档**。<https://aiwiki.page/en/learning-to-rank>
- GitHub `dshakes/distil` `docs/EVALUATION.md` —— live shadow 的 A/B + **A/A 自对照**、trajectory-risk 免分布上界、drift monitor。<https://github.com/dshakes/distil/blob/main/docs/EVALUATION.md>
- CQRS projection 规范 —— read model 可丢弃 / 可重放 / 幂等 / 一个 projection 只服务一种查询目的。<https://fco.github.io/Sourcing-2/concepts/projections.html>

**B. 行业惯例佐证（术语表 / 工程指南，非同行评议，用于互相印证口径）**

- Fusion Weight Tuning、Weighted Sum Fusion 的归一化前置与 grid/Bayesian 调权。<https://inferensys.com/glossary/semantic-search-and-entity-recognition/hybrid-search-fusion/fusion-weight-tuning> ／ <https://inferensys.com/glossary/semantic-search-and-entity-recognition/hybrid-search-fusion/weighted-sum-fusion>
- RRF 权重调优 / LTR(LambdaMART) 特征化 / 离线→在线流程。<https://www.zyxy.net/archives/30610>
- Feature flags & progressive delivery：flag schema、fail-closed 默认、sticky bucketing、canary 阶梯、**「没演练过的 kill switch 是负债」**、自动回滚。<https://blog.habsi.net/?p=2581> ／ <https://qapractices.com/documentation/testing-in-production/> ／ <https://gostellar.app/blog/test-prod>
- Shadow / dark launch 零副作用、离线 gate 不可省、paired shadow 比未配对 canary 统计效率高。<https://www.exploreagentic.ai/insights/ai-agent-evaluation-testing> ／ <https://www.omnidatatec.com/insights/canary-and-shadow-deployment-for-ai-agents>
- Matched-pair + bootstrap（10 000 resamples、`n_pairs ≈ 16σ²/MDE²`、shadow→canary→ramp）。<https://dev.to/nainikmehta/matched-pair-ab-testing-for-llm-prompts-metrics-4e0>
- CQRS read model = disposable derivative、projection 幂等、从日志重建。<https://stackpractices.com/recipes/cqrs-pattern-recipe> ／ <https://www.devcraftly.com/kafka/cqrs>
- Impression discounting（曝光降权的公式与「降权强度需调、过强会压掉后来仍相关的内容」）。<https://help.imforza.com/knowledge/what-is-impression-discounting>
- MMR 公式 `λ·Rel − (1−λ)·max Sim`，λ 常用 0.7–0.9。<https://www.wasilzafar.com/pages/series/ai-in-the-wild/ai-wild-part05-recommender-systems.html>

---

## 9. 本轮实现范围与判定标准

**做**：C1 纯内存曝光（检索级 + 注入级双通道）、C2 RRF 默认 + 权重外置 + 位置敏感评测工具、C3 三态 flag + 降级回退、C5 paired bootstrap 工具、C7 **四条**路径接入、放大召回；票 03 状态 `ready-for-agent → claimed → resolved`。

**不做**：C4 的 07 号票实现（票已批准新增，本轮不认领）、任何生产权重、在线 A/B、跨进程曝光状态、cross-encoder（票 04）、导入器（票 01/02）。

**判定「这次没白干」**（2026-11-07 收尾后逐条核对）：

- [x] `src/core/factstore.mjs` / `vecstore.mjs` / `vector-generation.mjs` / `embed.mjs` **零改动**（`git diff --name-only` 验证）
- [x] `src/router.mjs` 在**四条**召回路径后各插一次策略调用；`off` 态响应逐字不变
- [x] `npm test` **69/69**、`npm run test:adapter` **12 pass / 4 skip / 0 fail**、`test/recall-policy.mjs` **15/15**、`test/inject-exposure.mjs` **1/1**（真实 `router.handle('/inject')` 端到端）
- [x] `tools/evaluate-recall-policy.mjs` v2 产出三态快照 + MRR/NDCG@8 + bootstrap CI + `--grid` + `amplifiedRecall` 实跑小节，报告强制标注合成集局限
- [x] `externalModelRequests = 0`；默认 `recallPolicyMode='off'`
- [x] 放大召回 8 → 32 条候选，最终仍 `trimToK` 回 8 条；`distribution/judgment` 仍按请求 k 的前 k 条原始分数算
- [x] 注入级曝光 `demoted` 跨轮 0 → 3 → 4 → 6；6 候选 / 3 配额下连续 4 轮注入集合两两不同

### 实跑结果（如实记录，含不好看的那个数）

| 项 | 结果 |
| --- | --- |
| off 态 vs `docs/recall-evaluation-20261101.json` | `precisionAt8/recallAt8/falseInjectionRate/externalModelRequests` 全同；6 条 `rows` 除 `latencyMs` 外**逐字一致** |
| 合成集三态 | off NDCG@8 `0.581957`、shadow `0.581957`、enabled `0.632005`；MRR `0.436111 → 0.513889` |
| paired bootstrap（6 对，10 000 次） | meanDelta `+0.050048`，**CI95 `[-0.193167, 0.247048]` 覆盖 0** ⇒ 只能说「未发现劣化」，**不能说更优** |
| 端到端冒烟 | `offEqualsShadowByText` / `enabledTextsEqualOff` / `sameModeRepeatStable` / `enabledNoCrash` / `noExternalModelRequests` 全 true |
| 真值层 diff | 零（首版与收尾复核均为零）；其余为四处白名单 + 策略层模块 + 测试/评测工具 |

冒烟第一次跑出 `offEqualsShadow: false`，查清是**夹具口径错**：三态各用独立临时 root，`fact:<digest>` 含写入时间戳所以跨 root 必然不同，不是顺序变化。改为比较 item 文本并补 A/A 自对照后全绿 —— 记录在此，避免以后有人把「测试改绿」当成「把问题修掉」。

### 2026-11-07 收尾补记（票 03 → resolved）

| 补上的 | 实跑证据 |
| --- | --- |
| 放大召回 | `amplifiedRecall`: off 8 → enabled 32 候选；被埋在第 25 位的相关条目 off 时根本不在候选里、enabled 时进入；`returnedCount=8` |
| 注入级曝光 | `test/inject-exposure.mjs` 真实路由连跑 4 轮，`demoted` 0→3→4→6，四轮集合两两不同；`dry` 不写状态；`deferred` 走 60s 收据并 ack 成功 |
| 第四条召回路径 | `kind=event` 向量支路补接；C7 断言 3 → 4 |
| 配置/失败分支 | 所有分支统一 `trimToK`，配置非法或抛错也不会把 4k 条候选悄悄返回 |

**本轮查出的两个「不好看但必须写下来」的事实**：

1. **「三条路径都接了」是假断言**。漏掉的 `kind=event` 向量支路从未报错，而测试因为只数自己写过的三处而全绿。已改为从调用点反向盘点（4 处 `applyRecallPolicy` + 4 处 `k: storeK`）。
2. **曝光让位不是无条件生效**。当「候选数 == 配额数」时，每轮所有候选被同等降权，共同因子不改变相对顺序 —— 实测 3 候选 / 3 配额连跑 4 轮顺序完全一致。这是设计边界而非 bug：曝光 debiasing 本来就只在「部分候选曝光、部分没有」时改变相对次序。端到端用例因此刻意用 6 候选 / 3 配额，并在报告的 `limitations` 里写明，不拿「顺序没变」粉饰成通过。

**仍未解决、不可跳过的**：真库标注集与生产权重（C2）、在线 shadow / canary（C5）、C4 的 07 号票实现（票本身已批准，被 01 阻塞）、cross-encoder（04）、导入器（01/02）。CI95 仍覆盖 0 ⇒ 依旧**只报未发现劣化，不宣称更优**。

## Comments

- 2026-11-06 [by:WorkBuddy]：用户要求「认真设计诚实代价的代价部分 + 找主流方法解决 + 开工」。复核后发现 C2/C5 被低估、C6 可消解、新增 C7，据此重排优先级并开工票 03。
- 2026-11-07 [by:WorkBuddy]：用户「接着之前的任务清单继续做」⇒ 收尾票 03 到 `resolved`。补齐放大召回、注入级曝光双通道、第四条召回路径；修正 C7 假断言；如实记录「候选==配额时无相对让位」的设计边界。Frontier 变为 01 / 04。
