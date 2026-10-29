// 事实施工层原语（M4 语用/事实层）—— 身份键 · 证据集指纹 · 内容指纹 · compare-and-update。
//
// 为什么**现在**就落地（M4 还没开工）：
//   本项目最危险的错不是"漏了一个常数"，是**"ADR 写了、代码没接"**
//   —— `ADR-0010` 决定 6 写了 `gstamp` 装 `rank_version`，`extractEdges` 却从没传过它
//   （`0015` 才查出）。它比漏扫更危险，因为**它让人以为已经做了**。
//   身份键尤其如此：**键要么早定死，要么晚了就重判历史**（键定义变更 ⇒ 全量重判，ADR-0013/0014）。
//   ⇒ 把**已拍板**的身份 / 指纹一律先落成**纯函数 + 断言**；M4 只负责接线，不再"重新发明键"。
//
// 分层：本文件属**语用 / 事实层**（`pragmatic`）。该层的戳是
//   `layerStamp('pragmatic', PRAGMATIC_VERSION, base)`（ADR-0013 决定 1）。
//   本文件**不引入任何戳**：`contentFingerprint` 的 `logicVersion` 由调用方传入
//   （= `PRAGMATIC_VERSION`）—— 免得这里再写一份版本号，制造"两处各写一套"的漂移。
//
// 引用面：**零活跃路径**，只被 `test/facts.mjs` 引用（与 `lib/edges.mjs` 同型：先落地、后接线）。
//   ⇒ 不改任何既有行为，插件版本**不动**（仍 0.4.0）。

import crypto from 'node:crypto';

/** 键分隔符：`\u0000` 在实体占位符（`P7722`）与事实类型（`pattern`）中都不可能出现。 */
const SEP = '\u0000';

/** 明文 id 形态的 scope（`group:1098345913` / `private:1353446252`）—— 命中即红线，**抛**。 */
const RAW_SCOPE = /^[A-Za-z]+:[0-9]+$/;

// ────────────────────────────────────────────────────────────────────────────
// 零、`fact_kind` 枚举（身份键的第三个分量）—— **冻结的 schema 常量**（ADR-0017）
// ────────────────────────────────────────────────────────────────────────────

/**
 * **产事实级身份键的 `fact_kind` 取值** —— 封闭集合，`Object.freeze` 冻结。
 *
 * ## 为什么必须是"枚举"而不是"任意字符串"
 * `fact_kind` **进身份键**（ADR-0014 决定 1）。键的每个分量都必须来自**封闭集合**，
 * 否则一个拼写错误（`speaker-profile` / `speaker_profile` / `SpeakerProfile`）
 * 就是**一个新的槽** —— 静默分裂，且事后**无法从键里看出哪个是笔误**。
 * 这与 `scope` 走**占位符**而不是自由文本是同一条纪律：**键的分量不许自由发挥**。
 * （形状同 `ADR-0011` 的常数分类：键分量属于"进身份"那一类，必须**早定死**。）
 *
 * ## 为什么分两段（且两段**不是同一类东西**）
 * 它们**共用同一个槽键**，但产出物落在**不同的表**（`ADR-0010` 决定 1）：
 *
 * | 段 | 值 | 层 | 写哪 | 依据 |
 * |---|---|---|---|---|
 * | **语用** | `pattern` | L1 | **独立模式表** | `CONTEXT`：模式不是事实 |
 * | **语用** | `speaker_profile` | L2 | **独立画像表** | `ADR-0010` 决定 4/5 |
 * | **语用** | `trait` | L2 | **独立画像表** | `ADR-0031`（说话人级**档案**，target 恒空） |
 * | **语义** | `event` / `topic` / `promise` / `joke` / `grudge` / `preference` | L0 | **事实表** | 与内核 `EVENT_KINDS` **逐字对齐** |
 *
 * ⚠️ **语义段逐字复用内核 `EVENT_KINDS`**（`['event','topic','promise','joke','grudge','preference']`），
 * **不新造词表** —— `CONTEXT`「`joke` 已在内核枚举里，不新造类别」的同一条纪律。
 * 内核版本：`KERNEL_VERSION = '6d-kernel-1.1'`（`memory_plugin/src/memory6d-kernel.js:24-27`）。
 *
 * ⚠️ **`fact_kind` 不进 `content_fingerprint`**：它是身份，不是内容。
 * 判定结果（`topic` / `pattern_type` / 分数）才是内容（ADR-0014 决定 5）。
 */
export const FACT_KINDS = Object.freeze([
  // ── 语用段（读 E 证据层；写独立表，不进事实表）──────────────
  'pattern',          // L1：A 对 B 的一批相似表达的整体性质（content = 并存 pattern 集合）
  'speaker_profile',  // L2：A 自身的风格 / 玩梗历史（target 恒为空，说话人级）
  'trait',            // L2：A 的**固定档案**（年龄/职业/性取向/爱好…；target 恒为空，说话人级）
                      //     `ADR-0031`；content = { items: [{k, v, at}] } **多值列表**
  // ── 语义段（主体—谓词—客体；与内核 EVENT_KINDS 逐字对齐）────
  'event',
  'topic',
  'promise',
  'joke',
  'grudge',
  'preference'
]);

/**
 * 分段视图：调用方按需取一段（例：写事实表时只许语义段）。
 *
 * ⚠️ **`trait` 归 `pragmatic` 而不归 `semantic`，是刻意的**：
 * 语义段的纪律是「**逐字复用内核 `EVENT_KINDS`**，不新造词表」（见上）。
 * `trait` 是新造的 ⇒ 塞进语义段会**破坏那条对齐**（事后看不出哪个是内核的、哪个是本仓加的）。
 * 而它在形态上与 `speaker_profile` **完全同型** —— **说话人级、`target` 恒空、
 * 写独立画像表** ⇒ 归 `pragmatic` 既不破纪律，也落在该去的表里。
 */
export const FACT_KIND_GROUPS = Object.freeze({
  pragmatic: Object.freeze(['pattern', 'speaker_profile', 'trait']),
  semantic: Object.freeze(['event', 'topic', 'promise', 'joke', 'grudge', 'preference'])
});

const FACT_KIND_SET = new Set(FACT_KINDS);

/**
 * `fact_kind` 是否是合法取值。
 * ⚠️ **没有"默认值"** —— 内核有 `DEFAULT_KIND = 'event'`，插件**故意不采用**：
 * 身份键的分量**不许静默降级**（`CONTEXT` 纪律；同 `scope` 的 `NO_SCOPE_SOURCE`）。
 * 缺省 = 抛，不猜。
 */
export function isFactKind(k) {
  return FACT_KIND_SET.has(canon(k));
}

/** 标量规范化：`null` / `undefined` → 空串；其余 `String()`。键里绝不许出现 `undefined` 字面。 */
function canon(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** 内容元素的**稳定比较**：按 JSON 文本排序，且**类型先分档**，避免 `1` 与 `'1'` 误判同名。 */
function cmpJson(a, b) {
  const ta = Array.isArray(a) ? 'a' : typeof a;
  const tb = Array.isArray(b) ? 'a' : typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 一、身份键（append-only，只装"问的是什么"）
// ────────────────────────────────────────────────────────────────────────────

/**
 * **产事实级身份键**（ADR-0012 决定 2，经 **ADR-0014 决定 1**、**ADR-0015 决定 1** 修正）。
 *
 * = `(speaker, target, fact_kind, scope)` —— **只装"问的是什么"**。
 *
 * ⚠️ **不含 `topic`**。`topic` 是判定**输出**（"答的是什么"），进 `contentFingerprint`。
 * 把 `topic` 放进键 ⇒ 同一槽的判定结果一变（"表白梗" → "日常互动"）键就变
 * ⇒ 系统**新建 fact_002 而非更新 fact_001** ⇒ **事实增殖**，
 * 与"新证据 = 更新推断，不是再加一条"直接矛盾。
 * 这与 `horizon` 进键（移窗即重复产事实）是**同型**：**把派生量当身份**。
 *
 * ✅ **含 `scope`**（`ADR-0015`，本轮新增）。`scope` **不是**派生量 ——
 * 它是"**在哪儿说的**"（观测本身的属性），不依赖任何窗口 / 阈值 / 判定逻辑
 * ⇒ 与 `horizon`（看了多少）、`topic`（答了什么）**不同类**，**可以**进身份。
 * 判据：**"A 在群里对 B 玩梗"与"A 在私聊对 B 玩梗"是两个问题** ——
 * `scope` 定义"哪一类场景"，是**问的一部分**。
 * 反面判据（更一般）：**读这个槽必须先加限定词"在哪个 scope"才读得出值** ⇒
 * 那个限定词就是**身份维度**，塞进内容只会把身份走私进内容。
 *
 * **`slotId` 是代理键 / 句柄，其锚点就是前三个字段** —— 它不引入额外信息，
 * 也**不能**用"内容相似度"去找槽（那等于把派生量放回身份，循环）。
 * ⇒ 一个 `(speaker, target, fact_kind, scope)` = **一个槽**；
 *   同槽**多个并存的 pattern** 是 **多值内容**（内容里放集合），**不是**多行。
 *   需要"按 topic 分行 / 跨 scope 汇总"时，那是**投影视图**（派生），不是身份。
 *
 * 键 **append-only**：写出来就不再变（`topic` / 分数 / 相似度簇怎么变都不改它）。
 *
 * ⚠️ **两条红线（命中即抛，不静默降级）**：
 *   1. `scope` **不许省略**。省略 ⇒ 群 / 私聊事实并进**同一个槽** ——
 *      正是本决定要防的"塌槽"，且**事后无法从键里看出来**。
 *   2. `scope` **必须是占位符 token**（`group:C1234` / `private:C5678`），
 *      **不许是明文 id**（`private:100000001` = 对方的明文 QQ）。
 *      键要出境 / 进 read-model ⇒ 明文 id 入键 = 从键里泄通讯录（`ADR-0002`）。
 *
 * @param {string} speaker   说话人占位符（如 `P7722` / `SELF`）
 * @param {string} target    对象占位符
 * @param {string} factKind  事实类型（**schema 常量**，如 `'pattern'` / `'speaker_profile'`）——
 *                           它不是判定输出，故可进身份
 * @param {string} scope     **会话占位符 token**（`normalizer.scopeLabel(chatKey)` 派生）
 * @returns {string} 身份键
 */
export function factSlotKey(speaker, target, factKind, scope) {
  const sc = canon(scope);
  if (!sc) {
    throw new TypeError(
      'factSlotKey 需要 scope —— 它是身份的一部分（"问的是哪一类场景"）；省略会把群/私聊事实并进同一个槽'
    );
  }
  if (RAW_SCOPE.test(sc)) {
    throw new TypeError(
      `factSlotKey 的 scope 必须是占位符 token（如 group:C1234），收到明文 id：${sc} —— ` +
      '星图数据不得带明文 QQ/群号（ADR-0002）'
    );
  }
  return [canon(speaker), canon(target), canon(factKind), sc].join(SEP);
}

/**
 * 证据 id 的**规范化集合** —— 指纹与支持数共用的唯一口径（2026-10-28，评审 F07）· [by:DS]
 *
 * 为什么必须单独一个函数：同一批证据在 `FactStore.put()` 里要算两样东西 ——
 * 指纹（`evidenceSetHash`）与支持数（`evidence_n`）。改前指纹走 `Set` 去重、
 * 支持数走**数组长度** ⇒ **一条证据重复三次就算三份独立支持**，能压过真正有两份
 * 独立证据的版本（`resolveSlotRows` 正是按 `evidence_n` 取赢家）。
 * 两处从此都读这一个集合，分叉在构造上不可能再出现。
 *
 * 空项口径：`null` / `undefined` / `''` ⇒ 空串 ⇒ **丢弃**。空串不是证据。
 */
export function uniqueEvidenceIds(ids = []) {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.map(canon))].filter(Boolean).sort();
}

/**
 * **精确**证据集指纹（ADR-0013 决定 7）。
 *
 * `sha1(sorted(unique(ids)))` —— **精确**（集合任何变化 ⇒ hash 变）、定长、**只装原语**。
 *
 * ⚠️ 与"措辞簇 hash"**不是一回事**（免得被当成同一条禁令）：
 *   - `hash(消息 id)`：id 是**原语**，不依赖任何阈值 ⇒ **可进身份键**（正当）；
 *   - `措辞簇 hash`：依赖 `Jaccard` 阈值，是**派生量** ⇒ **不得进身份键**（ADR-0012 决定 1）。
 *
 * 天然覆盖**中间项增删 / 撤回**：集合一变 ⇒ hash 变 ⇒ 重判。
 * **不需要**"检测中间变化"这个专门机制（全量重算 hash 就是那个机制；周期全量重扫兜底）。
 *
 * 🆕 2026-10-28：集合口径收进 `uniqueEvidenceIds`，与 `evidence_n` 同源（评审 F07）· [by:DS]
 *
 * @param {Array<string|number>} ids 候选窗口内**全部参与消息**的 id
 * @returns {string} `e` 前缀的证据集指纹
 */
export function evidenceSetHash(ids = []) {
  const uniq = uniqueEvidenceIds(ids);
  const h = crypto.createHash('sha1').update(`ids|${uniq.join(SEP)}`, 'utf8').digest('hex');
  return 'e' + h.slice(0, 16);
}

/**
 * **判定级身份键**（ADR-0012 决定 2，经 ADR-0013 决定 7 修正）。
 *
 * = `(speaker, target, evidence_set_hash)` —— **无 `topic`**（topic 是判定输出）。
 * 管的是"**这批证据判过没有**" ⇒ 决定要不要**重跑判定**。
 */
export function decisionKey(speaker, target, evidenceSetHashValue) {
  return [canon(speaker), canon(target), canon(evidenceSetHashValue)].join(SEP);
}

// ────────────────────────────────────────────────────────────────────────────
// 二、内容指纹（compare-and-update，**就要**依赖派生量）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把任意内容规范化成**顺序无关**的字符串：
 * 对象键排序、数组 / `Set` 元素排序、`Map` 按键排序。
 * ⇒ 多值内容（并存 pattern 的集合）**重排不算变化**。
 */
export function canonicalContent(content) {
  const norm = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(norm).sort(cmpJson);
    if (v instanceof Set) return [...v].map(norm).sort(cmpJson);
    if (v instanceof Map) {
      return [...v.entries()].map(([k, x]) => [String(k), norm(x)]).sort((a, b) => cmpJson(a[0], b[0]));
    }
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(norm(content));
}

/**
 * **内容指纹**（ADR-0013 决定 6 的落地）。
 *
 * `sha1( canonical(判定结果) + 判定逻辑版本 + 证据集指纹 )`。
 *
 * ⚠️ 它**存 fact 记录体**（与 `derived_from` 并列），**不进任何键**。
 * 取值要求与身份键**正好相反**：身份要**稳**（进不了派生量），内容指纹要**敏感**（就是要进派生量）。
 * 把内容指纹塞进键 = 把"要敏感的"和"要稳的"混成一个 ⇒ 必须分居两处。
 *
 * `logicVersion`（= `PRAGMATIC_VERSION`）进指纹是**故意的**：
 * 阈值 / 句长下限一变 ⇒ 内容可能没变但**判定口径变了** ⇒ 也应当被视作"值变了"。
 *
 * @param {object} o
 * @param {*}      o.content         判定结果（任意结构；顺序无关归一化后参与）
 * @param {string|number} o.logicVersion 判定逻辑版本（`PRAGMATIC_VERSION`）
 * @param {string} o.evidenceSetHash 证据集指纹（`evidenceSetHash()`）
 * @returns {string} `c` 前缀的内容指纹
 */
export function contentFingerprint({ content = null, logicVersion = null, evidenceSetHash: esh = null } = {}) {
  const h = crypto.createHash('sha1')
    .update(`${canonicalContent(content)}|lv:${canon(logicVersion)}|ev:${canon(esh)}`, 'utf8')
    .digest('hex');
  return 'c' + h.slice(0, 16);
}

/**
 * **compare-and-update 驱动器**（ADR-0013 决定 6）。
 *
 * 给旧指纹 + 新指纹 + 旧 `rev` ⇒ 动作：
 *   - 相同 → `noop`（不写盘、`rev` 不变、**不产新事实**）；
 *   - 不同 → `update`（原地更新 + `rev + 1`）。
 *
 * ⚠️ 它**不是**"要不要重跑判定"的判据 —— 那是判定级键（`decisionKey`）的事。
 * 两者**连锁但不同源**：新证据 ⇒ 重跑判定 ⇒ 重算指纹 ⇒ **比对** ⇒ 更新。
 * 一句话：**身份键 append-only，内容指纹 compare-and-update。**
 *
 * @param {string|null} prevFingerprint 槽上已存的内容指纹（首次产出传 `null`）
 * @param {string}      nextFingerprint 本次重算的内容指纹
 * @param {number}      [prevRev=0]      槽上已存的 `rev`
 * @returns {{action:'noop'|'update', rev:number}}
 */
export function compareAndUpdate(prevFingerprint, nextFingerprint, prevRev = 0) {
  if (prevFingerprint && prevFingerprint === nextFingerprint) {
    return { action: 'noop', rev: Number(prevRev || 0) };
  }
  return { action: 'update', rev: Number(prevRev || 0) + 1 };
}
