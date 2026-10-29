import { normalizeReferences } from './provenance.mjs';
// 事实层存储（M4 落键的**存储面**）—— 零依赖，只做"键的落地"，不做 LLM 抽取。
//
// ── 这个文件只做一件被拍板过的事 ──────────────────────────────────────────
// 把 `ADR-0012`→`0014`→`0015` 定死的**产事实级身份键**真正接上盘：
//
//     槽 = factSlotKey(speaker, target, fact_kind, scope)      [四元组, ADR-0015 决定 1]
//     scope = normalizer.scopeLabel(chatKey)   ← **占位符 token**，不是明文会话键
//
// `lib/facts.mjs` 已经把**键**落成纯函数（先落地、后接线）。本文件是它的**接线**：
// 键 → 盘 → 可查。**不做**抽取、**不做**判定、**不调** LLM。
//
// ── 三个文件（与 vecstore.mjs 同型：真值先落、派生量后落）─────────────────
//   slots.jsonl   每行 = 某槽的**一个版本**快照。append-only（同 key 新行 = 更新）。
//                 这是**真值**。它一行都不删（墓碑另说，见下）。
//   index.json    派生量：{ version, count, by_scope, by_kind, stamp, updatedAt }
//                 启动时由 slots.jsonl **重数一遍**即重建 ⇒ 崩在它上游=自愈。
//   （无第三文件：事实槽不含大二进制，不像 vecstore 需要 vectors.bin。）
//
// ── 一致性纪律（同 vecstore）─────────────────────────────────────────────
// 写入顺序固定「**先 jsonl 后 index**」。崩在 index = 自愈（派生量），
// 崩在 jsonl = `verify()` **检出**并报错，绝不静默截断、绝不"聪明地修复"。
//
// ── 为什么每条更新是**新行**而不是原地改 ─────────────────────────────────
// 与「**身份键 append-only，内容指纹 compare-and-update**」一致（ADR-0013 决定 6）：
//   · 身份键（speaker/target/kind/scope）**写出即不变**；
//   · 值变了 ⇒ `rev + 1` ⇒ **追加一行新版本**，旧版本留痕（可审计"这条被改过几次"）。
// 崩溃只可能丢"最后一行的写"，不会把已确认的旧版本写坏。
import fs from 'node:fs';
import path from 'node:path';

import { factSlotKey, evidenceSetHash, uniqueEvidenceIds, contentFingerprint, compareAndUpdate, FACT_KINDS, isFactKind } from './facts.mjs';
import { PRAGMATIC_VERSION, baseParams, layerStamp } from './edges.mjs';

export const FACT_STORE_VERSION = 1;

/**
 * 槽内**聚合口径**（2026-10-09 拍板，`ADR-0007`）：同一槽（append-only）有多个版本时，
 * **给消费方看哪一条**的规则。
 *
 *   赢家 = `evidence_n` 最大者（证据最多的判断最有代表性 —— `cluster_size` 的落盘形态）；
 *   平票 = `rev` 最大者（最新判断，同证据量时信息更新）。
 *
 * 确定性、与遍历顺序无关 —— 旧口径（"每 key 留最后一行"）的赢家只取决于写入顺序，
 * 与哪条更有代表性无关（实测 63 行 / 11 槽 / 碰撞率 100% / 4 槽 pattern_type 冲突）。
 *
 * 其余版本**不删**：`versionsOf(key)` 可取全量历史（"查找更多证据"），落库真值仍是
 * slots.jsonl 的一行不删。
 */
export const SLOT_CALIBER = 'evidence-max';

/**
 * 单行的**可信度**（数值化，`ADR-0007`）：`evidence_n × legacy 折减`。
 *
 * 没有模型给出的数值可信度字段（judge 只产 `confidence_note` 文本），证据条数
 * 就是最硬的可信度代理。**legacy 折减**（2026-10-09 拍板）：口径实施**之前**写入的行
 * （无 `caliber` 字段）来自"未聚合时代"，证据链不如新口径完整 ⇒ 信任度打 **0.5** 折。
 * 只影响消费侧的排序权重，**不回写、不改真值**。
 */
export const LEGACY_CREDIBILITY_FACTOR = 0.5;

/**
 * **多值槽**（`content.items[]`，即 `trait` 档案与 `speaker_profile` 画像）里，
 * 一个"方面/属性"折算成多少条证据。
 *
 * ── 为什么多值槽不能直接拿 `evidence_n` 当可信度（2026-10-22）───────────────
 * `items` 是**累积型**内容（多方面并存），若让它带真实证据条数，聚合
 * （`resolveSlotRows` = evidence-max，平票才看 rev）就会挑"证据更多的**旧**版本"
 * ⇒ 新写的方面被静默丢掉。所以多值槽的 `evidence_n` **恒为 1**（`ADR-0044`）。
 *
 * 代价是：`evidence_n` 在这类槽上**已经不代表真实证据量**了，它是个哨兵值。
 * 再拿它当排序权重（`ADR-0007`）就等于**双重惩罚** —— 既压掉了它的真实证据，
 * 又用被压掉后的数字去排序。实测（2026-10-22）：号A 的 `speaker_profile` 全是 1，
 * 而整理产出的语义槽最高 40 ⇒ 画像在同分/低分组里排不进 `perPerson` 名额。
 *
 * ⇒ 多值槽改用**承载的信息量**计可信度：`items.length × 本常量`。
 * 取 6 的依据（两号实测）：直写槽（`remember`）恒 1、`pattern` 反复出现的是 3~21、
 * 整理产出的语义槽封顶 40 ⇒ 一个方面落在"比单条直写更硬、比反复出现更软"这一档，
 * 1 个方面 = 6、3 个方面 = 18，既压得住单条直写，也不会把真正反复出现的事实挤掉。
 * 它是个经验值，可调；**不要**为了"让画像一定出场"往上抬 —— 那会变成硬塞。
 */
export const MULTI_ITEM_CRED = 6;

/** 单行可信度（见 `LEGACY_CREDIBILITY_FACTOR` / `MULTI_ITEM_CRED` 两段注释）。 */
export function slotCredibility(rec) {
  const n = Number(rec?.evidence_n) || 0;
  const factor = rec?.caliber ? 1 : LEGACY_CREDIBILITY_FACTOR;
  const base = n * factor;
  // 多值槽：按"承载几个方面/属性"计价（见 MULTI_ITEM_CRED 的推导）。
  // `items` 为空/非数组 ⇒ 走原口径，存量单值槽的行为**逐字不变**。
  const items = Array.isArray(rec?.content?.items) ? rec.content.items.length : 0;
  if (!items) return base;
  return Math.max(base, items * MULTI_ITEM_CRED * factor);
}

/**
 * **直写标记**（`ADR-0024` 决定把它在 `content.source` 上标死）。
 * 带这个值的槽由 `POST /remember` 写入 —— 内容是人/模型当场写下的一句话，
 * **不经过** `backend.mjs` 候选构造 → `extract.mjs` 判定这条链。
 */
export const DIRECT_WRITE_SOURCE = 'assistant-remember';

/**
 * 这条槽是不是**语用层口径管辖**的对象（= 判定产物）。
 *
 * ⚠️ 为什么需要这个判据（2026-10-16）：
 *   `logic_version` 是个**全局戳**，但**只有判定路径受它管辖**。直写路径的
 *   `target` 是**硬编码 `''`**（`router.mjs` 的 remember 分支）、`content` 是当次
 *   写下的话 ⇒ 口径变更**不会**让它产出新 key，也**没有**任何来源可重建它。
 *
 *   把直写槽算进"待重建"，后果**不是"多报几条"**：
 *   `staleKeys()` 同时是 `retire-stale` 的处方 —— 它会**盲杀**这些槽，而重判
 *   **补不回来**（直写 key 的 `target` 恒为 `''`，判定产出的 key 带 `target`
 *   ⇒ 两者 key 空间不相交）。实测 A 号：354 条被报陈旧，其中 **336 条是直写**
 *   （一次 10-12 的 `people/*.json` 迁移产物），真 stale 只有 **18 条**。
 *   ⇒ 真问题被噪音淹没，且一键退役 = 336 条事实蒸发。
 *
 * 判据只认 `content.source`：`derived_from.pstamp` 之类**区分不开**（两条路都写它）。
 */
export function isCaliberGoverned(rec) {
  return String(rec?.content?.source ?? '') !== DIRECT_WRITE_SOURCE;
}

/** 纯函数：从同槽的多行里按 `SLOT_CALIBER` 选出赢家（空数组返回 null）。 */
export function resolveSlotRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = rows[0];
  for (const r of rows) {
    const en = Number(r.evidence_n) || 0;
    const bn = Number(best.evidence_n) || 0;
    if (en > bn || (en === bn && (Number(r.rev) || 0) > (Number(best.rev) || 0))) best = r;
  }
  return best;
}

/** 带 code 的错误：调用方据此决定"明确拒绝"还是"降级"（与 VecStoreError 同型）。 */
export class FactStoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'FactStoreError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/**
 * 明文 id 形态：`qq:123` / 纯数字 / `group:100000001`。命中即红线。
 *
 * ⚠️ **单一来源**（`ADR-0019` 决定 1）：`lib/judge.mjs` 的出境断言**引用这里导出的同一正则**，
 * 不另抄一份 —— "明文 id 长什么样"只有一个定义，改一处全场生效。
 */
export const RAW_ID = /^(?:qq:)?[0-9]{5,}$|^[A-Za-z]+:[0-9]{5,}$/;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：tmp + rename，避免读到半截 index。 */
function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

/** 断言一个字段是**占位符**而不是明文 id —— 出境红线（ADR-0002）。 */
function assertPlaceholder(label, v, allowEmpty = true) {
  const s = v === null || v === undefined ? '' : String(v);
  if (!s) {
    if (allowEmpty) return s;
    throw new FactStoreError('RAW_ID_IN_KEY', `${label} 不能为空`);
  }
  // `SELF` / `P7722` / `group:C1234` / `private:C5678` 都过；
  // `qq:123` / `100000001` / `group:100000001` 命中。
  if (RAW_ID.test(s)) {
    throw new FactStoreError(
      'RAW_ID_IN_KEY',
      `${label} 必须是占位符，收到明文 id：${s} —— 事实层要出境/进 read-model（ADR-0002）`
    );
  }
  return s;
}

/**
 * 事实槽存储。**线程不安全**（宿主单进程单实例，够用）。
 */
export class FactStore {
  /**
   * @param {string} dir  事实层数据目录（例如 `<DATA_DIR>/memory-vec/facts`）
   * @param {object} [opts]
   * @param {import('./normalize.mjs').Normalizer} opts.normalizer
   *        必须有 `scopeLabel(chatKey)` —— scope 只能由占位符派生（缺则抛，不退回明文）。
   */
  constructor(dir, opts = {}) {
    this.dir = path.resolve(dir);
    this.slotsFile = path.join(this.dir, 'slots.jsonl');
    this.indexFile = path.join(this.dir, 'index.json');
    /**
     * **软删旁路**（`ADR-0034`）：被合并/退役的槽 key → `{ into, at, by }`。
     *
     * 为什么不写进 `slots.jsonl` 的墓碑行：那要和 `rev` 序列纠缠（墓碑之后的新写入
     * 算不算复活？），且动了**真值文件**的结构语义。旁路是**只读侧过滤** ——
     * `slots.jsonl` 一行不改，回滚 = 删掉这条记载。
     *
     * ⚠️ 两种用途（同一机制）：
     *   ① **合并**：`into` 指向目标槽（`merge-console` spec §4.4）；
     *   ② **退役旧口径**：`into: null` —— 重判产出**新 key**（`target` 进身份键），
     *      老槽不会自己消失 ⇒ 不先退役 ⇒ `/inject` 里同一件事出现两遍（spec §七.5）。
     */
    this.mergedFile = path.join(this.dir, 'merged.json');
    /** @type {Map<string, {into:string|null, at:string, by:string}>} key → 记载 */
    this.merged = new Map();
    /** 读 `merged.json` 时出的错（非 null ⇒ 面板/自检要报，但**不**拦服务） */
    this.mergedReadError = null;
    /** 自动解除合并标记的**累计**次数（新证据写回被合并的槽 ⇒ 标记作废，spec §4.4）。
     *  刻意**不**逐条打日志：一次全量重判会命中上千条，日志会被淹成不可读。 */
    this.mergedAutoReleased = 0;
    this.normalizer = opts.normalizer || null;

    /** @type {Map<string, object>} key → 槽的**当前**快照（按 `SLOT_CALIBER` 从全版本里选） */
    this.slots = new Map();
    /** @type {Map<string, object[]>} key → 全部历史版本（append-only 真值的内存镜像；"查找更多证据"） */
    this.versions = new Map();
    /**
     * **按人的派生索引**（`ADR-0032` 人物卡）：speaker 占位符 → 该人的槽记录。
     *
     * ⚠️ 这是**纯派生量**，只活在内存里、不落盘（`index.json` 里只存条数）——
     *    与 `slots` 同生共死：`recount()` 里从真值重数一遍。理由同 `by_scope`：
     *    派生量和真值分两个文件落盘，就会有一份是旧的。
     * @type {Map<string, object[]>}
     */
    this.bySpeaker = new Map();
    /** @type {object|null} 只读原因；非 null ⇒ 拒绝一切写 */
    this.readOnlyReason = null;
    /** @type {object|null} 语用层版本陈旧探测（对面 `0030` 建议 B）；非 null ⇒ 有 read-model 是旧版本产出 */
    this.rebuildRequired = null;

    this.index = {
      version: FACT_STORE_VERSION,
      count: 0,
      by_scope: {},
      by_kind: {},
      updatedAt: null
    };
  }

  /** scope 一律走 `normalizer.scopeLabel`；没有归一化器就**抛**（不退回明文 chatKey）。 */
  scopeOf(chatKey) {
    if (typeof this.normalizer?.scopeLabel !== 'function') {
      throw new FactStoreError(
        'NO_SCOPE_LABEL',
        'FactStore 需要 normalizer.scopeLabel —— scope 必须由占位符派生，否则事实键里会带明文 QQ/群号'
      );
    }
    // ⚠️ 空 chatKey **不许**悄悄落成 `private:C…`：`scopeLabel('')` 会把 `undefined` 当私聊，
    //    于是"忘了传 scope"变成"这些事实都在同一个私聊里" —— 正是要防的**静默并槽**。
    if (chatKey === undefined || chatKey === null || String(chatKey) === '') {
      throw new FactStoreError(
        'NO_SCOPE_SOURCE',
        '既没有 scope 也没有 chatKey —— scope 是身份的一部分（"在哪儿说的"），必须显式给出'
      );
    }
    return this.normalizer.scopeLabel(chatKey);
  }

  /**
   * 读**软删旁路** `merged.json`（`ADR-0034`）。**故意 fail-open**，与 `slots.jsonl` 的
   * "半截 JSON ⇒ 只读"**不同**，因为两者的性质不同：
   *
   *   · `slots.jsonl` 是**真值** ⇒ 读不动就**不知道真相** ⇒ 必须停下来（fail-closed）。
   *   · `merged.json` 是**旁路/覆写**，真值仍在 `slots.jsonl` ⇒ 读不动只是"不知道滤哪些"
   *     ⇒ 退化成"全都不滤"=**服务照常、看到的比该看到的多**，不是"看到错的"。
   *
   * 但**必须喊出来**（`mergedReadError` → `stats()` → `/status` → 面板 + 自检）——
   * 否则用户"合并了却还在"会变成一句**静默无解释**的抱怨。这跟 `/instances` 对坏清单的
   * 处置同源：**坏 JSON 让页面说明原因，不让整站停摆**。
   */
  _loadMerged() {
    this.merged.clear();
    this.mergedReadError = null;
    if (!fs.existsSync(this.mergedFile)) return this;   // 没有 = 什么都没合并（正常态）
    let raw;
    try {
      raw = fs.readFileSync(this.mergedFile, 'utf8');
    } catch (err) {
      this.mergedReadError = `读不到 merged.json：${err?.message || err}`;
      console.warn(`[memory-vec/factstore] ${this.mergedReadError} —— 本次**不滤任何槽**（旁路读不动不等于真值有问题）`);
      return this;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      this.mergedReadError = `merged.json 不是合法 JSON：${err?.message || err}`;
      console.warn(`[memory-vec/factstore] ${this.mergedReadError} —— 本次**不滤任何槽**。修好或删掉该文件即可恢复过滤。`);
      return this;
    }
    // 形状校验：只认 `{ "<key>": { into, at, by } }`。非对象的条目**逐条丢**并记账，
    // 不做"猜一个形状"——猜错的代价是**静默滤错槽**，那是数据事故不是显示问题。
    const bad = [];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, v] of Object.entries(obj)) {
        if (!key || !v || typeof v !== 'object' || Array.isArray(v)) { bad.push(key); continue; }
        this.merged.set(key, {
          into: v.into == null ? null : String(v.into),
          at: v.at ? String(v.at) : '',
          by: v.by ? String(v.by) : ''
        });
      }
    } else {
      this.mergedReadError = 'merged.json 顶层不是对象（应是 { "<槽key>": {…} }）';
      console.warn(`[memory-vec/factstore] ${this.mergedReadError} —— 本次**不滤任何槽**`);
      this.merged.clear();
      return this;
    }
    if (bad.length) {
      this.mergedReadError = `merged.json 有 ${bad.length} 条形状不对（已跳过）：${bad.slice(0, 3).join(' / ')}`;
      console.warn(`[memory-vec/factstore] ${this.mergedReadError}`);
    }
    return this;
  }

  /** 把 `merged` 落盘（原子写）。**唯一**写旁路的出口 —— 调用方只管改内存，落盘不必各自实现。 */
  _persistMerged() {
    const obj = {};
    for (const [key, v] of this.merged) obj[key] = v;
    atomicWrite(this.mergedFile, JSON.stringify(obj, null, 2));
  }

  /**
   * 打开（或初始化）存储：读 slots.jsonl → 每 key 留最后一行 → 重数 index。
   * 任何损坏 ⇒ 进只读模式并**报错**，不猜。
   */
  open() {
    ensureDir(this.dir);
    this.slots.clear();
    this.versions.clear();
    this.readOnlyReason = null;
    // 旁路先读：下面解析快照时就要按它过滤（顺序反了 = 滤了个空）
    this._loadMerged();

    if (fs.existsSync(this.slotsFile)) {
      let raw;
      try {
        raw = fs.readFileSync(this.slotsFile, 'utf8');
      } catch (err) {
        this.readOnlyReason = `读不到 slots.jsonl：${err?.message || err}`;
        return this;
      }
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (err) {
          // 半截 JSON = 崩溃残留。**检出并只读**，不跳过（跳过 = 静默丢版本）。
          this.readOnlyReason = `slots.jsonl 第 ${i + 1} 行不是合法 JSON（疑似崩溃残留）：${err?.message || err}`;
          return this;
        }
        if (!rec || typeof rec.key !== 'string' || !rec.key) {
          this.readOnlyReason = `slots.jsonl 第 ${i + 1} 行缺少 key`;
          return this;
        }
        // 全版本先留档（"查找更多证据"的依据），再按口径选当前快照。
        // 旧口径是"后写覆盖先写"—— 赢家只取决于遍历顺序，已由 `SLOT_CALIBER` 取代。
        const list = this.versions.get(rec.key);
        if (list) list.push(rec);
        else this.versions.set(rec.key, [rec]);
      }
    }

    // 按口径解析当前快照（open 的"每 key 留一行"步骤，判据见 SLOT_CALIBER）
    // ⚠️ 软删旁路（`ADR-0034`）在**这里**生效：命中的 key 不进 `slots`，
    //    但 `versions` **全留**（可审计、可回滚 —— 删掉记载槽就回来）。
    //    挡在 `slots` 这一层（而不是在各个读口各挡一次）⇒ 下游 `recount`/`stats`/
    //    `/inject`/`/person` **自动**一致，不会有人忘了滤。
    for (const [key, rows] of this.versions) {
      if (this.merged.has(key)) continue;
      const winner = resolveSlotRows(rows);
      if (winner) this.slots.set(key, winner);
    }

    this.recount();
    // 可观测探针（对面 `0030` 建议 B）：启动时若有**旧版本产出的非空 read-model**，
    // 必须**喊出来**，不能只靠"版本数字改了"这个静默事实。
    if (this.rebuildRequired) {
      const parts = Object.entries(this.rebuildRequired.stale).map(([v, n]) => `v${v}×${n}`);
      const dv = Object.entries(this.rebuildRequired.directVersions || {})
        .map(([v, n]) => `v${v}×${n}`).join(' + ');
      console.warn(
        `[memory-vec/factstore] rebuild_required: 语用层判定逻辑现为 ` +
        `v${this.rebuildRequired.current}，但现有 read-model 里 ${parts.join(' + ')} 条是旧版本产出 —— ` +
        `层版本变更 ⇒ 语用层 read-model 应重建（ADR-0018 决定 5）。` +
        `在重判/重写或 reset() 之前，请把它们当作过期数据对待。`
        + (dv ? `（另有 ${dv} 条**直写**槽版本号更早，但它们不经过判定逻辑、无可重建来源 ⇒ 不计入待重建，也不会被 retire-stale 退役。）` : '')
      );
    }
    return this;
  }

  /**
   * 语用层版本陈旧探测（对面 `0030` 建议 B，`ADR-0018` 决定 5 的可观测落点）：
   * 统计各槽记录的 `logic_version`；**存在非空的旧版本 read-model** ⇒ 置 `rebuildRequired`
   * （进 `stats()` / `verify()`，启动时由 `open()` 打日志）。
   *
   * 为什么用显式字段而不是反解 `pstamp`：`layerStamp` 是 hash，**不可逆** ——
   * 想知道"这是哪个版本产的"就只能**写下来**（与 `derived_from.params` 存原始参数同一道理）。
   */
  _checkRebuildRequired() {
    const current = String(PRAGMATIC_VERSION);
    const stale = {};
    // ⚠️ **只统计受口径管辖的槽**（`isCaliberGoverned`，判据与后果见该函数注释）。
    //    直写槽的 `logic_version` 是"写入时代的代码版本"，不是"应按新口径重算"的证据。
    //    不加这一层 ⇒ 336 条直写事实把 18 条真 stale 淹掉，且 `retire-stale` 会盲杀它们。
    const direct = {};
    for (const rec of this.slots.values()) {
      const lv = String(rec.logic_version ?? 'unknown');
      if (!isCaliberGoverned(rec)) { direct[lv] = (direct[lv] || 0) + 1; continue; }
      if (lv !== current) stale[lv] = (stale[lv] || 0) + 1;
    }
    this.rebuildRequired = Object.keys(stale).length
      ? { current, stale, directVersions: direct }
      : null;
    return this.rebuildRequired;
  }

  /** 由 `slots` 重算派生 index（启动时与每次写后都调）。 */
  recount() {
    const byScope = {};
    const byKind = {};
    const byLogic = {};
    const bySpeaker = {};
    this.bySpeaker.clear();
    for (const rec of this.slots.values()) {
      byScope[rec.scope] = (byScope[rec.scope] || 0) + 1;
      byKind[rec.fact_kind] = (byKind[rec.fact_kind] || 0) + 1;
      const lv = String(rec.logic_version ?? 'unknown');
      byLogic[lv] = (byLogic[lv] || 0) + 1;
      // 按人：`speaker` 是身份键的第一维，天然就是"这是谁的事"（`ADR-0032`）。
      // ⚠️ 只索引 **speaker**，不索引 `target` —— `target` 是"对谁说的"，
      //    同一个人的事实不该因为他跟不同人说话而散成多份。
      const sp = String(rec.speaker || '');
      if (sp) {
        bySpeaker[sp] = (bySpeaker[sp] || 0) + 1;
        let arr = this.bySpeaker.get(sp);
        if (!arr) { arr = []; this.bySpeaker.set(sp, arr); }
        arr.push(rec);
      }
    }
    this.index = {
      version: FACT_STORE_VERSION,
      count: this.slots.size,
      by_scope: byScope,
      by_kind: byKind,
      by_speaker: bySpeaker,
      by_logic_version: byLogic,
      updatedAt: new Date().toISOString()
    };
    return this._checkRebuildRequired();
  }

  /**
   * 某人（speaker 占位符）的**全部槽**。返回的是**内部对象的引用**（只读用，别改）。
   * 索引缺失时退回全扫 —— 人物卡是查阅功能，**宁可慢一点也不能给空结果**
   * （空结果和"这个人真没记过什么"在本功能里无法区分，那才是静默失败）。
   */
  slotsOfSpeaker(speaker) {
    const sp = String(speaker || '');
    if (!sp) return [];
    const hit = this.bySpeaker.get(sp);
    if (hit) return hit;
    return [...this.slots.values()].filter((r) => String(r.speaker || '') === sp);
  }

  /** 全部有事实的人（speaker 占位符 + 条数），按条数降序。供面板列表用。 */
  speakers() {
    return [...this.bySpeaker.entries()]
      .map(([speaker, rows]) => ({ speaker, slots: rows.length }))
      .sort((a, b) => b.slots - a.slots || a.speaker.localeCompare(b.speaker));
  }

  /**
   * **标记**若干槽为「已合并 / 已退役」（软删旁路，`ADR-0034`）。
   *
   * 这是**唯一**改 `merged.json` 的业务入口（`put()` 里的自动解除是唯一另一处）。
   * 与 `reset()` 同一纪律：只能通过这里，不许调用方自己拼文件。
   *
   * ⚠️ **key 必须已存在**（`versions` 里查得到），否则**点名报 missing** ——
   *    拼错一个 key 就"标了个寂寞"，而 `merged` 里多一条不存在的键**没有任何症状**：
   *    既不滤掉什么，也不报错。这就是典型的**静默失败**，所以在这里拦住。
   *
   * @param {string[]} keys   要标记的槽 key（四元组键）
   * @param {{into?: string|null, by?: string}} [opts]
   *        `into` = 合并去向（目标槽 key）；**退役旧口径** 时传 `null`（spec §七.5）。
   * @returns {{marked:string[], missing:string[], missingInto:string|null, count:number}}
   */
  markMerged(keys, { into = null, by = 'merge-console' } = {}) {
    if (this.readOnlyReason) {
      throw new FactStoreError('READ_ONLY', `只读模式，拒绝写入：${this.readOnlyReason}`, { readOnlyReason: this.readOnlyReason });
    }
    const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k ?? '')).filter(Boolean);
    const missing = list.filter((k) => !this.versions.has(k));
    const marked = list.filter((k) => this.versions.has(k));
    const intoKey = into == null || into === '' ? null : String(into);
    const missingInto = intoKey && !this.versions.has(intoKey) ? intoKey : null;

    const at = new Date().toISOString();
    for (const key of marked) {
      this.merged.set(key, { into: intoKey, at, by: String(by || 'merge-console') });
      // 从**活动视图**里摘掉（`versions` 保留 ⇒ 可审计、可回滚）
      this.slots.delete(key);
    }
    if (marked.length) {
      this._persistMerged();
      this.recount();
      this.flushIndex();
    }
    return { marked, missing, missingInto, count: this.merged.size };
  }

  /**
   * **解除**标记（回滚）—— 删掉记载，槽**立刻**回来（`versions` 一直都在）。
   *
   * @param {string[]} keys
   * @returns {{cleared:string[], missing:string[], count:number}}
   */
  clearMerged(keys) {
    if (this.readOnlyReason) {
      throw new FactStoreError('READ_ONLY', `只读模式，拒绝写入：${this.readOnlyReason}`, { readOnlyReason: this.readOnlyReason });
    }
    const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k ?? '')).filter(Boolean);
    const cleared = [];
    const missing = [];
    for (const key of list) {
      if (!this.merged.has(key)) { missing.push(key); continue; }
      this.merged.delete(key);
      cleared.push(key);
      // 放回活动视图：从真值（versions）重选赢家，不是"记得的那条"
      const winner = resolveSlotRows(this.versions.get(key));
      if (winner) this.slots.set(key, winner);
    }
    if (cleared.length) {
      this._persistMerged();
      this.recount();
      this.flushIndex();
    }
    return { cleared, missing, count: this.merged.size };
  }

  /**
   * **活动**槽里口径陈旧的 key（`logic_version !== PRAGMATIC_VERSION`）**且受口径管辖**。
   * 供"重判前置"用：这些就是重判会产出**新 key** 之后**留下来会变成重复**的那批
   * （spec §七.5 的硬顺序：先退役 → 再真判）。
   *
   * ⚠️ 本方法的另一个身份是 **`retire-stale` 的处方** —— 它返回什么，就会被退役什么。
   *    所以"受管辖"过滤必须在这里，不能只在 `_checkRebuildRequired` 里做：
   *    直写槽退役后**没有重建路径**（见 `isCaliberGoverned`）⇒ 漏滤 = 静默删数据。
   *    `directKept` 回报口径陈旧但**故意留下**的直写槽数 —— 不报出来的话，
   *    "354 报陈旧、只退役 29"看起来像退役没生效。
   */
  staleKeys() {
    const current = String(PRAGMATIC_VERSION);
    const out = [];
    let directKept = 0;
    for (const [key, rec] of this.slots) {
      if (String(rec?.logic_version ?? '') === current) continue;
      if (!isCaliberGoverned(rec)) { directKept += 1; continue; }
      out.push(key);
    }
    return { current, keys: out, directKept };
  }

  /** 软删旁路的全部记载（只读快照，供 `/facts/merged` 与面板列表用）。 */
  mergedEntries() {
    return [...this.merged.entries()]
      .map(([key, v]) => ({ key, into: v.into, at: v.at, by: v.by }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
  }

  /**
   * 软删旁路的**汇总**（`ADR-0034`）。
   *
   * ⚠️ `applied` 是**现算**的派生量（`merged ∩ versions`），不是累加计数器 ——
   *    累加计数器会漂移：`open()` 加一次、运行时 `markMerged` 再加一次、`clearMerged`
   *    忘了减 ⇒ 面板上的数字开始说谎，而它看起来**完全正常**。同 `recount()` 的理由。
   */
  mergedStats() {
    let applied = 0;
    for (const key of this.merged.keys()) if (this.versions.has(key)) applied += 1;
    return {
      count: this.merged.size,          // 记载条数
      applied,                          // 其中**真滤掉了活动槽**的条数（指向不存在 key 的不算）
      autoReleased: this.mergedAutoReleased,
      error: this.mergedReadError
    };
  }

  /** 只写派生 index（真值已在 jsonl 上）。崩在这里 = 自愈。 */
  flushIndex() {
    atomicWrite(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  get count() {
    return this.slots.size;
  }

  /** 由四元组取槽（`chatKey` 给出时走 scopeLabel；也可直接给已派生的 `scope`）。 */
  getSlot({ speaker, target, fact_kind: factKind, chatKey, scope } = {}) {
    const sc = scope || this.scopeOf(chatKey);
    return this.slots.get(factSlotKey(speaker, target, factKind, sc)) || null;
  }

  get(key) {
    return this.slots.get(key) || null;
  }

  /**
   * 一个槽的**全部历史版本**（"查找更多证据"，`ADR-0007`）：按 rev 升序，
   * 每行附 `credibility`（见 `slotCredibility`）。槽不存在返回 null。
   */
  deliveryOf(id) {
    for (const rows of this.versions.values()) {
      const row = rows.find(rec => rec.delivery?.id === id);
      if (row) return row;
    }
    return null;
  }

  versionsOf(key) {
    const rows = this.versions.get(key);
    if (!rows || rows.length === 0) return null;
    const winner = this.slots.get(key);
    return rows
      .slice()
      .sort((a, b) => (Number(a.rev) || 0) - (Number(b.rev) || 0))
      .map((r) => ({
        ...r,
        credibility: slotCredibility(r),
        legacy: !r.caliber,
        isWinner: winner ? r.content_fingerprint === winner.content_fingerprint && r.rev === winner.rev : false
      }));
  }

  /**
   * **写入一个槽版本**。走 compare-and-update：
   *   同内容 ⇒ `noop`（不写盘、rev 不变）；变了 / 首见 ⇒ `update`（rev+1，追加一行）。
   *
   * @returns {{action:'noop'|'update', rev:number, key:string, keyed:boolean}}
   */
  put({
    speaker, target, fact_kind: factKind,
    chatKey, scope,
    content = null,
    evidenceIds = [],
    delivery = null,
    provenance = [], itemProvenance = {},
    logicVersion = PRAGMATIC_VERSION,
    vocabVersion, vocabHash, horizon,
    at
  } = {}) {
    if (this.readOnlyReason) {
      throw new FactStoreError('READ_ONLY', `只读模式，拒绝写入：${this.readOnlyReason}`, { readOnlyReason: this.readOnlyReason });
    }

    // ① 身份：四条都在 put 处断言，键由事实原语拼（红线守卫在 factSlotKey 内）。
    const sp = assertPlaceholder('speaker', speaker);
    const tg = assertPlaceholder('target', target, /* allowEmpty */ true); // target 可为空（说话人级）
    // ⚠️ `fact_kind` **进身份键** ⇒ 只查"非空"不够：一个拼写错误（`speaker-profile`）
    //    会静默变成一个**新槽**。必须是 `FACT_KINDS` 里的封闭取值（ADR-0017）。
    //    且**无默认值** —— 缺省即抛（身份键分量不许静默降级，同 scope 的 NO_SCOPE_SOURCE）。
    const fk = String(factKind ?? '');
    if (!fk) throw new FactStoreError('BAD_FACT_KIND', 'fact_kind 必填（schema 常量，进身份键）');
    if (!isFactKind(fk)) {
      throw new FactStoreError(
        'BAD_FACT_KIND',
        `fact_kind 必须是 FACT_KINDS 之一（封闭枚举，进身份键），收到：${fk} —— ` +
        `合法值：${FACT_KINDS.join(' / ')}`
      );
    }
    const sc = scope ? assertPlaceholder('scope', scope) : this.scopeOf(chatKey); // scopeLabel 已产占位符
    const key = factSlotKey(sp, tg, fk, sc);  // ← 会再校验一次 scope（缺/明文都抛）

    // ② 内容：证据集指纹（精确）+ 内容指纹（顺序无关）。都**不进键**。
    const refs = normalizeReferences(provenance);
    const itemRefs = Object.fromEntries(Object.entries(itemProvenance).map(([k,v]) => [k,normalizeReferences(v)]));
    const esh = evidenceSetHash(evidenceIds);
    const fp = contentFingerprint({ content, logicVersion, evidenceSetHash: esh });

    // ③ 分层戳：语用层自己的戳（**不塞进边层 gstamp**，ADR-0013）。
    const base = baseParams({ vocabVersion, vocabHash, horizon });
    const pstamp = layerStamp('pragmatic', logicVersion, base);

    // ── 软删旁路的**自动解除**（`ADR-0034` · spec §4.4 最后一条）──────────────
    // 被合并/退役的槽，之后又被**新证据** `put()` ⇒ 说明这个 kind 仍活跃 ⇒ 解除标记。
    // ⚠️ 必须**先把历史赢家放回 `slots`**：`prev` 若因为旁路被滤成 null，下面
    //    `compareAndUpdate` 会把这次写入当"首见" ⇒ `rev` 从 1 重来，而 `versionsOf()`
    //    里还留着 rev 5/6 的旧行 ⇒ 表现成"历史倒流 + 老版本忽然变成非赢家"。一行恢复即可接上。
    if (this.merged.has(key)) {
      this.merged.delete(key);
      this.mergedAutoReleased += 1;
      this._persistMerged();
      const restored = resolveSlotRows(this.versions.get(key));
      if (restored) this.slots.set(key, restored);
    }
    const prev = this.slots.get(key) || null;
    const { action, rev } = compareAndUpdate(prev?.content_fingerprint || null, fp, prev?.rev || 0);

    if (action === 'noop') {
      if (delivery?.id) {
        // Receipt and fact share one append-only truth. No new logical revision.
        const receipt = { ...prev, delivery };
        ensureDir(this.dir);
        fs.appendFileSync(this.slotsFile, JSON.stringify(receipt) + '\n', 'utf8');
        this.versions.get(key).push(receipt);
      }
      return { action: 'noop', rev, key, keyed: true };
    }

    // Preserve references only for unchanged accumulated items. A changed item must not
    // inherit an older item's source merely because its slot still has that metadata.
    const retainedItemRefs = {};
    for (const item of content?.items || []) {
      const old = prev?.content?.items?.find(i => i.k === item.k && i.v === item.v);
      if (old && prev?.itemProvenance?.[item.k]) retainedItemRefs[item.k] = prev.itemProvenance[item.k];
      if (itemRefs[item.k]) retainedItemRefs[item.k] = itemRefs[item.k];
    }
    const rec = {
      key,
      speaker: sp,
      target: tg,
      fact_kind: fk,
      scope: sc,
      content,
      ...(refs.length ? { provenance: refs } : {}),
      ...(Object.keys(retainedItemRefs).length ? { itemProvenance: retainedItemRefs } : {}),
      // ⚠️ 判定逻辑版本**显式落盘**（不可从 `pstamp` hash 反解）——
      //    它是 `rebuild_required` 探针的输入（对面 `0030` 建议 B）。
      logic_version: String(logicVersion),
      // 聚合口径标记（`SLOT_CALIBER`）：有它 = 口径时代的行；没有 = legacy（可信度折减，ADR-0007）
      caliber: SLOT_CALIBER,
      content_fingerprint: fp,
      evidence_set_hash: esh,
      ...(delivery?.id ? { delivery } : {}),
      // ⚠️ **必须与 `evidence_set_hash` 同一个集合口径**（评审 F07，2026-10-28 · [by:DS]）：
      //    改前这里按**数组长度**算 ⇒ 同一条证据重复上报三次就等于"三份独立支持"，
      //    能压过真有两份独立证据的版本（`resolveSlotRows` 按 `evidence_n` 取赢家）。
      //    现在两处都读 `uniqueEvidenceIds` —— 分叉在构造上不可能再出现。
      evidence_n: uniqueEvidenceIds(evidenceIds).length,
      rev,
      derived_from: { pstamp, params: base, rev, at: at || new Date().toISOString() }
    };

    // ④ 真值先落：追加一行。**先落盘再改内存** —— 落盘失败就不算写入成功。
    ensureDir(this.dir);
    fs.appendFileSync(this.slotsFile, JSON.stringify(rec) + '\n', 'utf8');
    const list = this.versions.get(key);
    if (list) list.push(rec);
    else this.versions.set(key, [rec]);
    // 新行未必赢（legacy 行可能证据更多）—— 按口径重选，而不是"后写覆盖先写"
    this.slots.set(key, resolveSlotRows(this.versions.get(key)));

    // ⑤ 派生量后落。
    this.recount();
    this.flushIndex();
    return { action: 'update', rev, key, keyed: true };
  }

  /** 列表（按 scope / fact_kind / speaker 过滤）。 */
  list({ scope, factKind, speaker, offset = 0, limit = 100 } = {}) {
    let all = [...this.slots.values()];
    if (scope) all = all.filter((r) => r.scope === scope);
    if (factKind) all = all.filter((r) => r.fact_kind === factKind);
    if (speaker) all = all.filter((r) => r.speaker === speaker);
    // 稳定序：key 字典序（键 append-only ⇒ 序稳定）
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const total = all.length;
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(0, Number(limit) || 0);
    return { total, offset: off, limit: lim, items: all.slice(off, lim ? off + lim : undefined) };
  }

  /** 全部 scope（含每 scope 槽数）。 */
  scopes() {
    return Object.entries(this.index.by_scope)
      .map(([scope, n]) => ({ scope, count: n }))
      .sort((a, b) => b.count - a.count);
  }

  stats() {
    return {
      dir: this.dir,
      version: FACT_STORE_VERSION,
      count: this.count,
      readOnly: this.readOnlyReason,
      rebuildRequired: this.rebuildRequired,
      // 软删旁路（`ADR-0034`）。`applied` 与 `count` 的差 = "记载了但那个 key 不存在"
      // —— 不显式给出，就分不清"没合并过"与"合并了但没生效"（后者是**静默**的）。
      merged: this.mergedStats(),
      index: this.index
    };
  }

  /**
   * 只读自检：实测槽数与 index.count 是否一致；键是否都能被原语重拼出来；
   * 出境红线：记录里**不许有明文 id**。
   * 原理由：`slots`/`index`/`by_scope` 全是**派生量**，真值只有 slots.jsonl。
   */
  verify() {
    const problems = [];
    // 1) 键可重拼 + 无明文
    for (const rec of this.slots.values()) {
      const rebuilt = factSlotKey(rec.speaker, rec.target, rec.fact_kind, rec.scope); // 缺/明文 scope 会抛
      if (rebuilt !== rec.key) problems.push(`键重拼不一致：${rec.key}`);
      if (!isFactKind(rec.fact_kind)) problems.push(`fact_kind 不在 FACT_KINDS：${rec.fact_kind}`);
      for (const f of ['speaker', 'target', 'scope']) {
        if (RAW_ID.test(String(rec[f] ?? ''))) problems.push(`明文 id 泄漏在 ${f}：${rec[f]}`);
      }
    }
    // 2) 派生 index 与实测一致（不一致 ⇒ index 是陈旧的，可从 jsonl 重建，不算损坏）
    const staleIndex = this.index.count !== this.slots.size;
    return {
      ok: problems.length === 0,
      problems,
      count: this.slots.size,
      indexCount: this.index.count,
      indexStale: staleIndex,
      rebuildRequired: this.rebuildRequired,
      readOnlyReason: this.readOnlyReason
    };
  }

  /** 清空（唯一能清 `readOnlyReason` 的动作 —— 与 vecstore.reset 同纪律）。 */
  reset() {
    if (fs.existsSync(this.slotsFile)) fs.rmSync(this.slotsFile);
    if (fs.existsSync(this.indexFile)) fs.rmSync(this.indexFile);
    this.slots.clear();
    this.versions.clear();
    this.readOnlyReason = null;
    // ⚠️ **不删** `merged.json`：那是用户的合并/退役决定，不是本库的派生量。
    //    重读一次只是为了刷新 `mergedReadError`（文件坏了会再次被喊出来，不会因 reset 而变干净）。
    this._loadMerged();
    this.recount();
    return this;
  }
}

/**
 * **唯一装配入口**：建实例并**立即 `open()`**（载入既有台账）。
 *
 * 为什么必须收敛成一条路：`open()` 是**独立方法**，`new FactStore()` 只建空 map。
 * 生产端曾只 `new` 不 `open`（`backend.mjs` 的 `factStoreOf`）⇒ `this.slots` 永远为空：
 *   ① `rev` 跨进程归零（注释承诺的"这条被改过几次"断裂）；
 *   ② `compareAndUpdate` 的 **noop 跨进程失效** ⇒ 重跑同语料全量重写（台账无界膨胀）；
 *   ③ `open()` 里的**损坏检测**（半截 JSON ⇒ 只读报错）根本没机会跑 —— "崩在 jsonl 只读"的自愈设计等于没接。
 *
 * ⚠️ 而测试里**每一处都手写了 `.open()`**，于是 33 条断言全绿却盖不住这个洞：
 * 测试覆盖的是"**用对了**"，不是"**接线对**"。修法不是补一句 `.open()`，而是**去掉另一条路** ——
 * 想拿到可用实例只能走这里，测试也走这里（同一条路径才谈得上覆盖）。
 *
 * `open()` 不抛：读不动 / 半截 JSON ⇒ 置 `readOnlyReason` 并原样返回，由调用方 fail-closed。
 * 幂等：重复 `open()` 是"清空 + 从 jsonl 重放"，与盘上真值一致。
 *
 * @param {string} dir
 * @param {{normalizer?:object}} [opts]
 * @returns {FactStore}
 */
export function openFactStore(dir, opts = {}) {
  return new FactStore(dir, opts).open();
}
