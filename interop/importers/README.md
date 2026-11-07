# 第一个导入器样例：四类 JSONL → 通用导入契约 [by:WorkBuddy]

> 票 02 的源侧转换器。**这里没有整合包专名**：`facts / people / events / anchors` 是任何 Agent 导出记忆时都长得像的四类数据。要接别的项目，只需把你自己的导出物整理成同样形状，或改 `interop/import-mapping.json` 的 `sourceFiles`。

## 一条命令

```bash
# ① 源 JSONL → 契约文档（纯离线，零服务依赖）
node interop/importers/jsonl-to-contract.mjs \
  --dir interop/examples/legacy-jsonl --space demo --out /tmp/import.json

# ② 契约文档 → 离线导入计划（不发任何请求）
node tools/import-contract-document.mjs --doc /tmp/import.json --out /tmp/plan.json

# ③ 确认计划无误后再提交
node tools/import-contract-document.mjs --doc /tmp/import.json \
  --submit --base-url http://127.0.0.1:8091 --token '<adminToken>'
```

②与③生成的是**同一份确定性计划**（不含时间戳 / 随机 ID），因此可以先 diff、先审，再发请求。

## 字段映射表（逐项可核）

形状唯一真值源：[`../import-mapping.json`](../import-mapping.json)。下表是该文件的自然语言说明，两者冲突时以 JSON 为准。

| 源字段 / 文件 | 契约字段 | 服务落点 | 说明 |
| --- | --- | --- | --- |
| 每行 `id` | `entries[].id` | `operationId = import:sha256(spaceId,id,locator)` | 稳定 ID 就是幂等键；缺省时用 `文件名:行号` 兜底 |
| `text` / `content` / `summary` / `statement` | `entries[].text` | `POST /memories.text` | 上限 12000 字符，超长在**生成计划阶段**报错，不发请求 |
| `scope{kind,id}` / `scopeKind` / `conversationId` | `entries[].scope` | `POST /memories.scope` | 契约 `game`/`channel` 显式收窄成服务 `group`，`id` 原样保留 |
| `actorId` | `entries[].actorId` | `PUT /entities/{id}` → `POST /memories.actorId` | 缺 `actorId` ⇒ **不登记实体、不写事实记忆**，只进隔离清单 |
| `evidenceIds[]` | `entries[].evidenceIds` | `POST /memories.evidenceIds` | 必须指向本批 `messages.jsonl` 里的 `role=user` 消息，校验器会拒绝悬空引用 |
| `name` / `subject{}` | `entries[].subject` | 仅留在来源追溯 | `subject` 不写服务实体；人物事实走 `speaker_profile` |
| `facts.jsonl` | `kind` 缺省 `preference` | `POST /memories.kind` | 行内 `kind` 优先，见 `factKinds` |
| `people.jsonl` | `speaker_profile` | 同上 | |
| `events.jsonl` | `event` | 同上 | |
| `anchors.jsonl` | `topic` | 同上 | 锚点**不新增实体类型**，落到既有事实分类 |
| `messages.jsonl` 每行 | `messages[]` | `POST /messages` | `messageId` 天然幂等；`role=user` 才能当事实证据 |
| 每行所在 `file:line` | `origin.source.locator` | `legacyRecord.origin` | 逐条可追溯到原始行 |
| 整批 | `origin.verified: false` | 台账 `legacy:true, confirm:false, shareable:false` | **契约里没有「确认」动作**，人工确认只能走服务既有写入口 |

### 明确不导入

`persona / emotion / mood / sleep / innerThought / association` 等运行态归 Agent 侧；`embedding / vector / score / confidence` 等派生量由服务生成。转换器发现这些字段会在输出的 `excludedRuntimeFields` 里列出（供审计），但**不会**把它们写进契约。

### 未核验标记的三重证据

服务没有条目级 `verified` 字段，所以不伪造字段、不往正文塞标签，而用三处既有语义互相印证：

1. 契约 `origin.verified` 由 schema 的 `const:false` 锁死；
2. 台账 `POST /workspace action:'entry'` 带 `legacy:true / confirm:false`，服务端落 `status:'candidate'`；
3. 导入结果逐条 `unverified:true`，隔离条目另带 `unattributed:true, usableAsEvidence:false`。

台账的 `text` 是**不含原文的占位描述**（`[historical-import] <id> — see legacyRecord.locator`），避免把原话复制成第二份事实；完整来源用 `origin.source.locator` 回查。这也正好是「人工核对页面」TODO（`docs/TODO-human-review-page-20261107.md`）里队列的数据源。

## 失败与重入

- 校验不通过 / 正文超长 ⇒ 在生成计划阶段 `exit 1`，**零请求**。
- 提交中途失败 ⇒ 抛 `ImportSubmitError`，带 `code`、失败步骤、`completed` 列表。每一步都幂等（稳定 `operationId` / `messageId` / scene signature），**不回滚、不写本地游标**；修正后重跑同一文档即可续上。
- 计划与结果都是普通 JSON，不含时间戳，可直接 diff 与复查。
