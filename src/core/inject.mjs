import { evaluateVisibility } from './visibility.mjs';
import { relatedLabels } from './lineage.mjs';
// src/core/inject.mjs — M2 注入：把事实槽渲染成"人格属性句"（ADR-0009）
//
// ── 形态（用户拍板 ①）─────────────────────────────────────────────────────
// 注入的不是"记忆卡片"（"你们上次聊过 X"），而是**人格属性**句——像"她怕打雷"那样，
// 只影响语气与判断，**不主动提起**。v1 的属性来源 = 事实槽（factstore 胜出行）：
//   · pattern 槽  → "KID1411 说话真诚（例："收到B站链接，我去下载一下，稍等哦～"）"
//   · 其余 kind   → content.text 原句（event/promise/preference… 本就是一句属性）
//
// ── 名额与门槛（用户拍板 ②③）────────────────────────────────────────────
// · 条数对齐宿主"群友印象"机制：**每人 maxEach = 2 条**（src/memory.js:1621）；
//   另设总上限（默认 8 行）兜住 prompt 预算。
// · 阈值 0.5（可配置，见下方 `DEFAULT_MIN_SCORE`）= **向量相似度门槛**，两种用法（`mode`）：
//     - `boost`（默认）：≥minScore 的行排最前（"现在就用得上"），其余照常注入 ——
//       与印象机制同构（印象的话题重合度也只是排序加成，不是闸门）；
//     - `hard`：只有 ≥minScore 的行才注入（严格按字面理解阈值）。
//   嵌入服务缺席时 hard **降级为 boost**（缺依赖不能变成"什么都不注入"）。
// · 排序主键 = 可信度（`slotCredibility`：evidence_n × legacy 0.5，ADR-0007）。
//
// ── 隐私纪律 ─────────────────────────────────────────────────────────────
// 槽里的 speaker/target 是**占位符**（P1669）。注入前必须反解成真名 —— 这条链路
// 恰好是"占位符 → 真名"，与归一化方向相反，**只发生在出服务、进宿主 prompt 的
// 最后一跳**，且反解用的名字来自请求方（宿主本来就知道是谁）——服务不落明文、
// 日志不打明文。

import { slotCredibility, SLOT_CALIBER } from './factstore.mjs';
import { topicOverlap } from './tokens.mjs';

/** pattern_type → 人格属性措辞（`PATTERN_TYPES` 封闭枚举的中文面）。 */
export const PATTERN_LABELS = Object.freeze({
  sincere: '表达真诚、说到做到',
  joke: '爱开玩笑、玩梗',
  ambiguous: '表达意图不太好猜'
});

/** 单条属性 allowed 的内容字段（white-list 出境：exemplar 截断，其余不出去）。 */
const EXEMPLAR_MAX = 48;

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** 属性段一行里最多列几个「方面」（`speaker_profile` 的 items）。 */
const ATTRIBUTE_ITEM_MAX = 3;

/**
 * 把一行槽记录渲染成**属性句正文**（不含人名前缀）。
 * `content` 是结构化对象（judge 落库形态）；坏行/空行返回 null。
 *
 * 三种形态：
 *   ① `pattern`：`pattern_type` 的中文面 + exemplar；
 *   ② **多值槽**（`content.items`）：`方面1：… ；方面2：…` —— `speaker_profile` 走这条
 *      （不同方面并存，见 `upsertSlotItem` 的注释）；方面=`整体` 时不带前缀（等价于旧的一句话）；
 *   ③ 其余：`content.text` 原句。
 */
export function renderAttributeLine(rec) {
  const c = rec?.content;
  if (!c || typeof c !== 'object') return null;
  if (rec.fact_kind === 'pattern') {
    const label = PATTERN_LABELS[c.pattern_type] || String(c.pattern_type || '').trim();
    if (!label) return null;
    const ex = c.exemplar ? `（例："${clip(c.exemplar, EXEMPLAR_MAX)}"）` : '';
    return `${label}${ex}`;
  }
  if (Array.isArray(c.items)) {
    const parts = [];
    for (const it of c.items) {
      const k = normalizeTraitKey(it?.k);
      const v = String(it?.v ?? '').trim();
      if (!v) continue;
      parts.push(!k || k === LEGACY_ITEM_KEY ? clip(v, 60) : `${k}：${clip(v, 60)}`);
      if (parts.length >= ATTRIBUTE_ITEM_MAX) break;
    }
    return parts.length ? parts.join('；') : null;
  }
  const text = String(c.text || '').trim();
  return text ? clip(text, 90) : null;
}

/**
 * 人 → 占位符集合（QQ 号走 `resolveKnown`（别名链最准），名字走词表 surface）。
 *
 * 抽成独立函数是因为**人格属性**与**档案（trait）**两条路径要共用同一套
 * "谁在场"的解析 —— 各写一份就会出现"属性认得出这个人、档案认不出"的静默分叉。
 */
function resolvePersons({ people, normalizer, lineage = {}, includeSelf = true }) {
  const persons = [];
  for (const p of Array.isArray(people) ? people : []) {
    const rawId = String(p?.id || '').trim();
    const id = rawId.replace(/^qq:/, '');
    const name = String(p?.name || '').trim();
    const labels = new Set();
    if (id && typeof normalizer?.resolveKnown === 'function') {
      const hit = normalizer.resolveKnown(rawId) || normalizer.resolveKnown(id) || normalizer.resolveKnown(`qq:${id}`);
      if (hit?.label) labels.add(hit.label);
    }
    if (name && typeof normalizer?._resolveTerm === 'function') {
      const r = normalizer._resolveTerm(name);
      if (r?.known && r.label) labels.add(r.label);
    }
    if (labels.size) persons.push({ who: name || `QQ${id}`, labels: relatedLabels(lineage, labels) });
  }
  if (includeSelf) persons.push({ who: '你自己', labels: new Set(['SELF']) });
  return persons;
}

/**
 * 把槽分配给在场的人（speaker 或 target 命中即归属，一行只归第一个命中者）。
 *
 * @param {Function} [decorate] 可选装饰器 `(cand, rec) => cand` —— 属性段用它挂
 *   场合策略（`scopeRank` + 降权折扣），档案段不用（它已在候选阶段硬过滤）。
 */
function assignToPersons(list, persons, render, decorate = null) {
  const out = [];
  for (const rec of list) {
    const line = render(rec);
    if (!line) continue;
    for (const person of persons) {
      if (person.labels.has(String(rec.speaker)) || person.labels.has(String(rec.target || ''))) {
        const base = { line, who: person.who, credibility: slotCredibility(rec), rec };
        out.push(decorate ? decorate(base, rec) : base);
        break; // 一行只归属第一个命中的人
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 属性段的 **场合策略**（ADR-0037）—— 与档案段的 `profileScopeAllowed` 是**两套**判据
// ────────────────────────────────────────────────────────────────────────────
//
// 档案段（`trait`，ADR-0031 §3.8）用**硬闸**：只认"学到它的那个场合"。
// 属性段**不能**照抄 —— 现网实测（2026-10-17）A 号 367 活槽里 **352 条来自
// `private:`、只有 29 条来自 `group:`**，一律硬闸 = 把群聊注入**关掉 96%**。
//
// 但也不能维持原状（全量放行）：同一个人的 `private` 槽在群里被注入，实测内容为
// 「反复给我生成软色情图…」「会直白坦露性压抑/对角色有性幻想」⇒ 一次就社死。
//
// ⇒ 取**单向闸门 + 同级降权**：
//   · **私密 → 公开** = 上浮 ⇒ `blocked`（唯一硬闸；这是社死的那一侧）
//   · **公开 → 私密** = 下沉 ⇒ `downgrade`（群里说过的话，私聊里提不社死）
//   · **同级跨场合**（群↔群 / 私↔私）⇒ `downgrade`（"他在别的群也这样"，可信度打折）
//   · 同场合 ⇒ `same`
//
// ⚠️ **判据只用 `scope`，不看 `fact_kind`** —— 实测 `fact_kind` 语义不可信：
//    「说话偏技术向，常聊插件开发」被判成 `grudge`（怨恨）、「说话带点粗俗」被判成
//    `speaker_profile`。拿一个已被证伪的字段做隐私决策 = 把闸门建在沙上。
//
// ⚠️ **`downgrade` 不占配额、只补位**（见 `selectInjectLines`）：否则"跨群的弱证据"
//    会把"同群的强证据"挤出 `perPerson`，等于用降权换掉了正确的那条。

/** 跨场合候选的可信度折扣（`downgrade` 时乘上去）。 */
export const SCOPE_DOWNGRADE_FACTOR = 0.6;

/** 隐私级别：`private`(1，一人可见) < `group`(2，N 人可见)；未知 ⇒ 0。 */
function privacyTier(scope) {
  const s = String(scope || '');
  if (s.startsWith('private:')) return 1;
  if (s.startsWith('group:')) return 2;
  return 0;
}

/**
 * 一条槽能不能出现在**当前场合**：`'same'` | `'downgrade'` | `'blocked'`。
 *
 * @param {object} o
 * @param {string} [o.slotScope] 槽的 scope（`group:C1` / `private:C2`）
 * @param {string} [o.nowScope]  当前场合（`scopeLabel(chatKey)`）
 * @param {boolean} [o.isSelf]   bot 自己的槽 ⇒ 不受限（隐私边界保护的是**他人**，
 *   与 `profileScopeAllowed` 的 `isSelf` 放行同一条理由）
 *
 * `nowScope === undefined | null` ⇒ **策略未启用**（`'same'`）。
 * 这是纯函数层的**单测口子**，生产调用方必须显式传（`router` 恒传）。
 * ⚠️ 传了但为空串 = **场合不明** ⇒ `'blocked'`（fail-closed：不能证明在场的人没变）。
 */
export function scopePolicyFor({ slotScope, nowScope, isSelf = false } = {}) {
  if (nowScope === undefined || nowScope === null) return 'same'; // legacy pure-test seam
  const result = evaluateVisibility({ sourceScope: slotScope, targetScope: nowScope, section: 'attribute', isSelf });
  return !result.allowed ? 'blocked' : result.rank === 0 ? 'same' : 'downgrade';
}

/**
 * 纯函数：从胜出槽集合里挑出候选属性行。
 *
 * @param {object} opts
 * @param {Iterable<object>} opts.winners      factstore 的胜出行（`store.slots.values()`）
 * @param {Array<{id?:string,name?:string}>} opts.people  本轮参与者（宿主传入；id=QQ 号）
 * @param {object} opts.normalizer             resolveKnown(id) / _resolveTerm(surface)
 * @param {number} [opts.perPerson=2]
 * @param {boolean} [opts.includeSelf=true]    speaker=SELF 的槽也注入（bot 自己的属性）
 * @param {string} [opts.nowScope]             当前场合 —— **生产调用方必须显式传**
 *   （`rt.normalizer.scopeLabel(chatKey)`；缺省表示"不施加场合策略"，仅供纯函数单测）。
 *   语义见 `scopePolicyFor`：私密上浮到公开被挡、同级跨场合降权补位。
 * @returns {Array<{line:string, who:string, credibility:number, rec:object, scopeRank:number}>}
 *   未排序、未截断的候选（每行带匹配到的人）。`scopeRank`：0=同场合、1=跨场合降权候选。
 */
export function buildInjectCandidates({ winners, people, normalizer, lineage = {}, perPerson = 2, includeSelf = true, nowScope = undefined }) {
  const list = Array.isArray(winners) ? [...winners] : [...(winners || [])];
  if (!list.length) return [];

  const persons = resolvePersons({ people, normalizer, lineage, includeSelf });
  if (!persons.length) return [];

  // ② 槽 → 候选：speaker 或 target 命中某人的占位符。
  // ⚠️ `trait` 槽**不走这条路** —— 它归「档案」段（`ADR-0031`）：固定特征
  //  与话题无关，不该参与相似度排序，也不该占 `perPerson` 的属性配额
  //  （否则会被"重复多次、证据更多"的 pattern 槽挤掉，正是档案最怕的失效形态）。
  //
  // ③ 场合策略（`ADR-0037`）：`blocked` 的槽在这里**直接丢掉**（它们连候选都不进，
  //   免得 `candidates` 计数虚高、让"注入了几条"对不上）；`downgrade` 打上 `scopeRank:1`
  //   并按 `SCOPE_DOWNGRADE_FACTOR` 折可信度 —— 折在这里而不是 `selectInjectLines`，
  //   是为了让**排序用的权重**和**回报给宿主的 credibility** 是同一个数。
  const kept = [];
  // ⚠️ 判据**只算一次、两处共用**（过滤 + 打分）。分两处各算一遍 = 两处判据漂移的经典形态：
  //    "过滤用的口径"和"打分用的口径"一旦分叉，就会出现"放行了但按降权打分"这种
  //    查不出来的中间态（同 `ADR-0036` 里 `_checkRebuildRequired` 与 `staleKeys` 的教训）。
  const policyOf = new Map();
  for (const rec of list) {
    if (String(rec?.fact_kind) === 'trait') continue;
    const policy = scopePolicyFor({
      slotScope: rec?.scope,
      nowScope,
      isSelf: String(rec?.speaker) === 'SELF'
    });
    if (policy === 'blocked') continue;
    policyOf.set(rec, policy);
    kept.push(rec);
  }

  return assignToPersons(
    kept,
    persons,
    renderAttributeLine,
    (cand, rec) => {
      const policy = policyOf.get(rec) || 'same';
      if (policy !== 'downgrade') return { ...cand, scopeRank: 0 };
      return {
        ...cand,
        scopeRank: 1,
        credibility: cand.credibility * SCOPE_DOWNGRADE_FACTOR
      };
    }
  );
}

/**
 * 场合策略的**普查**（只读，不产生候选）：回报"被挡几条 / 降权几条"。
 *
 * 存在的理由：场合隔离的失败形态是**静默的** —— 注入变少、没有任何报错，
 * 排查时无法区分"没记过"与"被挡了"。这个计数给 `/inject` 一个可观测出口
 * （同 `profileBlockedByScope` 的先例）。
 *
 * @returns {{same:number, downgrade:number, blocked:number}}
 */
export function scopeCensus({ winners, people, normalizer, lineage = {}, includeSelf = true, nowScope = undefined }) {
  const list = Array.isArray(winners) ? [...winners] : [...(winners || [])];
  const out = { same: 0, downgrade: 0, blocked: 0 };
  if (!list.length) return out;
  const persons = resolvePersons({ people, normalizer, lineage, includeSelf });
  const labels = new Set();
  for (const p of persons) for (const l of p.labels) labels.add(l);
  for (const rec of list) {
    if (String(rec?.fact_kind) === 'trait') continue;
    const speaker = String(rec?.speaker);
    const target = String(rec?.target || '');
    if (!labels.has(speaker) && !labels.has(target)) continue;   // 不归属任何人 ⇒ 不计
    const policy = scopePolicyFor({
      slotScope: rec?.scope,
      nowScope,
      isSelf: speaker === 'SELF'
    });
    out[policy] = (out[policy] || 0) + 1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 档案段（`fact_kind:'trait'`，ADR-0031）—— 固定特征：**常驻**，与话题无关
// ────────────────────────────────────────────────────────────────────────────

/** 一个人的档案**一行**里最多列几条（`k=v` 的个数）。 */
export const TRAIT_PER_PERSON = 6;

/** 档案段的总行数上限（与属性段的 `total` **互不挤占**）。 */
export const DEFAULT_PROFILE_TOTAL = 8;

// ── 属性名软词表（`ADR-0031` §6 拍板：软词表引导，**不是**封闭枚举）──────────
//
// 为什么不设封闭枚举：枚举外的特征就记不进去 —— 拒了是**丢信息**，兜底又等于变回自由文本。
// 软词表 = **引导**模型优先用这些名字（写在工具描述里），但不强制 ⇒ 既少分裂，又留逃生舱。
//
// ⚠️ `single` / `multi` 的区别是**语义级**的，不是显示级：
//   · **单值（覆盖）**：换工作是"替换"，留着旧职业就是错的（档案会过期）；
//   · **多值（累加）**：再添一个爱好是"追加"，覆盖掉前面的就是**丢东西**。
//   这两类混用一套写入语义，必然有一边错 —— 这是实施时实测撞到的（"爱好=画画" 再写
//   "爱好=打游戏" ⇒ 只剩打游戏）。

/** **单值**属性（同名写入 = 覆盖）。 */
export const TRAIT_KEYS_SINGLE = Object.freeze([
  '年龄', '职业', '性取向', '所在地', '生日', '学历', '身高', '婚恋', '星座'
]);

/** **多值**属性（同名写入 = 累加去重）。 */
export const TRAIT_KEYS_MULTI = Object.freeze([
  '爱好', '忌口', '语言', '技能', '宠物', '常玩游戏'
]);

/**
 * 别名 → 规范名。软词表只"引导"，**挡不住**模型换个说法（"工作"/"岁数"/"兴趣"）。
 * 不归并 ⇒ 同一个人的「职业」与「工作」并存两条，档案越记越胖。
 *
 * ⚠️ 归并错了比不归并更隐蔽（看不出"工作"被并进了"职业"）⇒ 只收**同义到没歧义**的。
 */
export const TRAIT_ALIASES = Object.freeze({
  工作: '职业', 干的活: '职业', 做什么的: '职业', 行业: '职业', job: '职业',
  岁数: '年龄', 年纪: '年龄', 多大: '年龄', 几几年的: '年龄',
  兴趣: '爱好', 喜好: '爱好', 喜欢做的事: '爱好', 特长: '技能',
  不吃: '忌口', 过敏: '忌口', 讨厌吃: '忌口', 忌讳: '忌口',
  城市: '所在地', 在哪: '所在地', 住哪: '所在地', 老家: '所在地',
  性别取向: '性取向', 取向: '性取向'
});

/** 属性名归一化：**折空白 + 全角冒号转半角 + 别名归并** ⇒ "职业 " / "工作" 都落到 "职业"。 */
export function normalizeTraitKey(k) {
  const s = String(k ?? '').replace(/\s+/g, '').replace(/：/g, ':').trim();
  return TRAIT_ALIASES[s] || s;
}

/** 这个属性是不是**多值**（累加而非覆盖）。 */
export function isMultiValueTrait(attr) {
  return TRAIT_KEYS_MULTI.includes(normalizeTraitKey(attr));
}

/** 多值属性写在一句话里的分隔符（模型常用顿号 / 逗号 / 斜杠 / "和"）。 */
const MULTI_SPLIT_RE = /\s*[、,，/;；]\s*|\s+和\s+/;

/**
 * 多值属性的**合并**：旧值 + 新值 ⇒ 拆开去重再拼回，顺序按出现先后。
 *
 * ⚠️ 为什么是"合并成一条"而不是"同 k 多条 item"：渲染出来是 `爱好=画画、打游戏`
 *    而不是 `爱好=画画 / 爱好=打游戏` —— 后者在 prompt 里既占字数又难读。
 */
export function mergeMultiValue(oldV, newV) {
  const parts = [
    ...String(oldV ?? '').split(MULTI_SPLIT_RE),
    ...String(newV ?? '').split(MULTI_SPLIT_RE)
  ].map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].join('、');
}

// ────────────────────────────────────────────────────────────────────────────
// 多值槽的**项级 upsert**（`trait` 按属性名、`speaker_profile` 按方面名）
// ────────────────────────────────────────────────────────────────────────────
//
// 问题的形状（2026-10-22）：槽键是 `(speaker, target, kind, scope)` ⇒ **一个 kind 一个槽**。
// 一句话进 `content.text` 的话，同一个人的「说话风格」与「对某人的态度」会互相顶掉 ——
// 旧系统 `people/*.json` 的 `impressions[]` 是**数组**（一人可躺 4 条），新系统只装得下 1 条。
// 实测（号B 2026-10-22）：35 槽里 `speaker_profile` 占 17 条，全靠覆盖维持，越聊越只剩一句。
//
// 解法**不碰身份键**：`facts.mjs` 的既有哲学就是「同槽多个并存值是**内容里的集合**，不是多行」
// （`ADR-0031` 用它做 trait）。这里把同一条机制推广到 `speaker_profile`：
//   `content = { items: [{k: 方面, v: 那句话}] }` —— 不同方面并存，同一方面覆盖。
//
// ⚠️ **旧槽迁移**：存量 `speaker_profile` 的 content 是 `{text}`。它在项级视角下就是
//    「方面=`整体`」的一条（见 `LEGACY_ITEM_KEY`）—— 不迁移就要求"第一次改结构时把旧的一句话丢掉"，
//    那是最不该丢的那条（它是这个人目前的全部画像）。
// ⚠️ 这里的 `source` 必须**确定性**（进 `contentFingerprint`）：同内容 ⇒ 同指纹 ⇒ `noop`。

/** 旧 `{text}` 槽迁进项级结构时，落到哪个方面名下。 */
export const LEGACY_ITEM_KEY = '整体';

/** 把一个槽的 content 读成规整的 `[{k,v}]`（**不**过滤空值 —— 那是渲染层的事）。 */
export function slotItems(previous) {
  const c = previous?.content;
  if (Array.isArray(c?.items)) {
    return c.items.map((it) => ({ k: String(it?.k ?? ''), v: String(it?.v ?? '') }));
  }
  const t = String(c?.text ?? '').trim();
  return t ? [{ k: LEGACY_ITEM_KEY, v: t }] : [];
}

/**
 * 项级 upsert：写入 `itemKey` 这一项，**其它项原样保留**。
 *
 * @param {object|null} previous 当前赢家槽（content 可为旧的 `{text}` 形态）
 * @param {string} itemKey       项名（trait 的属性名 / speaker_profile 的方面名）
 * @param {string} value         这一项的新值
 * @param {object} [o]
 * @param {boolean} [o.mergeMulti] 同项**累加**而不是覆盖（trait 的 爱好/忌口 那类）
 * @returns {{items:Array<{k:string,v:string}>, previousValue:string, created:boolean, key:string}}
 *   `previousValue` 供回执文案说清"替换掉了什么"；`created=false` 表示这是接在旧值后面累加。
 */
export function upsertSlotItem(previous, itemKey, value, { mergeMulti = false } = {}) {
  const k = normalizeTraitKey(itemKey) || LEGACY_ITEM_KEY;
  const items = slotItems(previous);
  const idx = items.findIndex((x) => normalizeTraitKey(x?.k) === k);
  const previousValue = idx >= 0 ? String(items[idx]?.v ?? '') : '';
  const v = mergeMulti && idx >= 0 ? mergeMultiValue(previousValue, value) : String(value ?? '');
  if (idx >= 0) items[idx] = { k, v };
  else items.push({ k, v });
  return { items, previousValue, created: idx < 0, key: k };
}

// ────────────────────────────────────────────────────────────────────────────
// 哪些 kind 是**多值槽**（按项 upsert，不同项并存）
// ────────────────────────────────────────────────────────────────────────────
//
// 判据不是"这个 kind 重要不重要"，而是**"它的内容天然是清单还是句子"**：
//   · `trait`            —— 档案是清单（职业/年龄/爱好并存）⇒ 项名 = **属性名**（必填）
//   · `speaker_profile`  —— 一个人有多面（说话风格 / 对某人的态度）⇒ 项名 = **方面**（可缺省 `整体`）
//   · `preference`       —— 喜好天然分对象（吃 / 玩 / 音乐…）⇒ 项名 = **方面**
//   · `grudge`           —— 雷点天然分领域（吃 / 称呼 / 玩笑…）⇒ 项名 = **方面**
//
// 其余 kind（`event`/`topic`/`promise`/`joke`/`pattern`）仍是"一句话一个槽"。
//
// ⚠️ `preference` / `grudge` 是 2026-10-23 才并进来的（`ADR-0048`）：在此之前它们
//    `content` 是一句话 ⇒ **同一个人的第二条喜好会顶掉第一条**。实测号A 的
//    `preference` 槽平均只活 1 条内容，而语料里同一个人明显有 3~4 条独立偏好
//    ⇒ 这不是"模型没记"，是**结构上装不下**。
export const MULTI_ITEM_KINDS = Object.freeze(['speaker_profile', 'preference', 'grudge']);

/** 这个 kind 是不是多值槽（内容按项存）。 */
export function isMultiItemKind(kind) {
  return MULTI_ITEM_KINDS.includes(String(kind ?? '').trim());
}

/**
 * 多值槽的**项名**（`trait` 的属性名 / 其余多值 kind 的方面名）。
 *
 * 抽成函数是因为 `router.mjs`（直写）与 `consolidate.mjs`（整理）**必须得到同一个项名**
 * —— 两处各写一份，就会出现"整理记的「对某人态度」与直写记的「态度」并存成两项"，
 * 而两边都以为自己只在维护一项（下次合并时才发现档案胖了一倍）。
 *
 * @returns {string} 非多值 kind 返回 `''`（调用方据此决定"整槽覆盖"还是"按项写"）
 */
export function itemKeyOf(kind, { attr = '', aspect = '' } = {}) {
  const k = String(kind ?? '').trim();
  if (k === 'trait') return normalizeTraitKey(attr);                       // 没有属性名 ⇒ 空串，调用方拒写
  if (isMultiItemKind(k)) {
    return normalizeTraitKey(String(aspect ?? '').slice(0, 30)) || LEGACY_ITEM_KEY;
  }
  return '';
}

/**
 * 把一个 trait 槽渲染成**档案行正文**（不含人名前缀）：`职业=程序员 / 年龄=25`。
 *
 * `content` 是 `{ items: [{k, v, at}] }` —— **多值列表**，这是 `trait` 与其余 kind
 * 的根本区别（其余 kind 的 `content.text` 是一句话 ⇒ 同槽只能存一条，见 `ADR-0031` §2）。
 */
export function renderProfileLine(rec) {
  const items = Array.isArray(rec?.content?.items) ? rec.content.items : [];
  const parts = [];
  for (const it of items) {
    const k = normalizeTraitKey(it?.k);
    const v = String(it?.v ?? '').trim();
    if (!k || !v) continue;
    parts.push(`${k}=${clip(v, 40)}`);
    if (parts.length >= TRAIT_PER_PERSON) break;
  }
  return parts.length ? parts.join(' / ') : null;
}

/**
 * 档案段的 **场合隔离**（`ADR-0031` §3.8）：一条档案能不能出现在**当前场合**的 prompt 里。
 *
 * 判据不是"这个属性敏不敏感"（敏感词表永远列不全 —— 真名、病情、学校、工资…），
 * 而是 **"读到它的人 ⊆ 当时在场的人"**：档案只在**学到它的那个场合**复用。
 *   · 群 A 听来的 ⇒ 只在群 A 出现；换群 / 进私聊 ⇒ 没有。
 *   · 私聊听来的 ⇒ 只在这个私聊出现；**绝不**带进群（最要命的一条：
 *     群里坐着当时根本不在场的人，而住址/性取向/婚恋这类正是**一次就社死**）。
 *
 * ⚠️ **只管档案段**。属性段（`buildInjectCandidates`）走的是**另一套**场合策略 ——
 *    不是"照抄这套硬闸"，而是 `scopePolicyFor` 的**单向闸门 + 同级降权**（`ADR-0037`）。
 *    为什么不照抄：现网 A 号 367 活槽里 **352 条来自 `private:`**、只有 29 条来自 `group:`
 *    ⇒ 属性段落硬闸 = **把群聊注入关掉 96%**（这正是本条注释早年警告过的结局）。
 *    但"全量放行"也不行：实测跨场合注入的内容是「反复给我生成软色情图」「会直白坦露性压抑」
 *    ⇒ 一次就社死。两难的正解 = 按**隐私级别**单向判（私密不上浮、公开可下沉）。
 *
 * @param {object} o
 * @param {string} [o.slotScope]  槽的 scope（`group:C1` / `private:C2`）
 * @param {string} [o.nowScope]   当前会话的 scope（由 `chatKey` 派生）
 * @param {boolean} [o.isSelf]    是不是 **bot 自己**的档案（`speaker === 'SELF'`）
 * @param {boolean} [o.allowCrossScope] 跨场合放行（面板「档案跨场合」；见下方沿革）
 * @returns {boolean}
 *
 * 三处"放行"必须有理由：
 *  ① `isSelf` —— 隐私边界保护的是**他人**；bot 自己的档案不存在扩散，且宿主既有的
 *     `## 自我印象` 通路本来就是全局可见的 ⇒ 与既有口径一致，不是新开的口子。
 *  ② `nowScope === PROFILE_SCOPE_ALL` —— **只给诊断用**（数"被场合挡掉几条"），调用方不得传。
 *  ③ `allowCrossScope === true` —— **2026-10-18 用户显式拍板**（沿革见下）。
 *
 * ── 沿革：为什么会多出第 ③ 条 ────────────────────────────────────────────────
 * 原设计（`ADR-0031 §3.8`）是**硬闸**：档案只认"学到它的那个场合"，理由是防社死
 * （私聊听来的住址/性取向不该出现在群里）。
 *
 * 但它的失败形态在真实使用中先暴露了：**私聊告诉对方"我 21 岁"，群里问就答不出**
 * （实测 `scopePolicy.blocked=4`、`profileLines:[]`）—— 因为"在哪说的"被当成了
 * "能不能复用"的唯一判据，而人对自己的年龄显然没有场合预期。
 *
 * 用户的原话（`refactor/core/persona-context.js` 文件头，2026-10 早期）：
 *   「每次切换任意人设都可以隔离，隔离短期记忆就行了，**长期不用隔离**」
 * ⇒ `allowCrossScope` 就是这句话的开关（服务端默认 **true**，面板可关）。
 *
 * ⚠️ 打开后的**真实代价**（写在这里，别指望人记得）：`trait` 槽里的
 *    「住址 / 真名 / 性取向 / 病情 / 单位」这类也会随档案进入**任何**会话，
 *    包括当时不在场的人所在的群。判据从"场合"退化成"用户是否记得关"。
 * ⇒ 因此响应里必须回报 `scopePolicy.profileCrossScope`（可观测），
 *    `profileBlockedByScope` 在开关打开后恒为 0，不能再用它判断"有没有被挡"。
 *
 * ⚠️ `nowScope` 为空 ⇒ **仍 fail-closed**（即使开了跨场合）。这一侧的失败方向是
 *    **漏出信息**；"场合不明"意味着连"这条槽属于哪"都无法证明，放行等于盲发。
 *    宿主钩子恒定传 `chatKey`，正常路径不会走到这里。
 */
export function profileScopeAllowed({ slotScope, nowScope, isSelf = false, allowCrossScope = false, profilePolicy }) {
  if (nowScope === PROFILE_SCOPE_ALL) return true; // internal management census only
  return evaluateVisibility({ sourceScope: slotScope, targetScope: nowScope, isSelf,
    policy: profilePolicy || (allowCrossScope ? 'all' : 'same-scope') }).allowed;
}

/** 场合隔离的**诊断旁路**（`profileScopeAllowed` 认它 ⇒ 不过滤）。端点用它数"被挡掉几条"。 */
export const PROFILE_SCOPE_ALL = '*';

/**
 * 数"这个场合下有**几条 trait 槽**被场合闸挡掉"（`0.28.0`）。
 *
 * ⚠️ 必须按**槽**数，不能再用 `profileAll.length - profileCandidates.length` 这个差集：
 *    `buildProfileCandidates` 现在会按人合并（同一人 N 个槽 ⇒ 1 行），两边的"行"已经不是
 *    同一个计量单位 —— 相减得到的是"合并造成的差"，不是"被场合挡掉的条数"。
 *    实测后果：strict 模式下明明挡掉了一条（`所在地=成都`），这个数却报 **0**，
 *    于是"档案没了"唯一的线索也断了（隔离的失败形态本来就是静默的）。
 */
export function countProfileBlockedByScope({
  winners, people, normalizer, lineage = {}, includeSelf = true, nowScope = '', allowCrossScope = false, profilePolicy
}) {
  const list = Array.isArray(winners) ? [...winners] : [...(winners || [])];
  if (!list.length) return 0;
  const persons = resolvePersons({ people, normalizer, lineage, includeSelf });
  if (!persons.length) return 0;
  let n = 0;
  for (const rec of list) {
    if (String(rec?.fact_kind) !== 'trait') continue;
    const owned = persons.some((p) => p.labels.has(String(rec.speaker))
      || p.labels.has(String(rec.target || '')));
    if (!owned) continue;
    const ok = profileScopeAllowed({
      slotScope: rec?.scope,
      nowScope,
      isSelf: String(rec?.speaker) === 'SELF',
      allowCrossScope, profilePolicy
    });
    if (!ok) n += 1;
  }
  return n;
}

/**
 * 把一个 trait 槽的 items 取成**规整后的** `{k,v,at}` 列表（k 已归一化、空值丢弃）。
 * 合并与渲染共用同一口径 —— 否则"合并时按 职业 去重、渲染时按 工作 显示"会出两条。
 */
function traitItemsOf(rec) {
  const items = Array.isArray(rec?.content?.items) ? rec.content.items : [];
  return items
    .map((it) => ({ k: normalizeTraitKey(it?.k), v: String(it?.v ?? '').trim(), at: it?.at }))
    .filter((it) => it.k && it.v);
}

/**
 * 两个人的 trait 槽合并时的**属性级**合并：同 key 只留一条。
 *   · 单值属性（职业/年龄/所在地…）⇒ **后到的覆盖**（`ADR-0031` latest-wins 的口径）；
 *   · 多值属性（爱好/忌口/技能…）⇒ `mergeMultiValue` 累加去重（"画画、打游戏"）。
 */
function mergeTraitItems(base, extra) {
  const out = base.map((x) => ({ ...x }));
  for (const it of extra) {
    const i = out.findIndex((x) => x.k === it.k);
    if (i < 0) { out.push({ ...it }); continue; }
    out[i] = isMultiValueTrait(it.k)
      ? { ...out[i], v: mergeMultiValue(out[i].v, it.v), at: it.at || out[i].at }
      : { ...it };
  }
  return out;
}

/**
 * 纯函数：挑出候选**档案行**（只看 `fact_kind==='trait'` 的槽，且通过场合隔离）。
 * 与 `buildInjectCandidates` 同源解析"谁在场"（`resolvePersons`）。
 *
 * @param {string}  [opts.nowScope='']        当前场合（缺省 = 不放行任何他人档案）
 * @param {boolean} [opts.allowCrossScope=false] 跨场合放行（透传 `profileScopeAllowed` 的第 ③ 条）
 *
 * ── 为什么这里要按人**先合并**再渲染（2026-10-18）────────────────────────────
 * `selectInjectLines` 对档案段用的是 `perPerson: 1`（注释写的是"一个人的档案**合并成一行**"），
 * 但 `assignToPersons` 是"一个槽一行"。旧行为下这两者不冲突 —— 场合硬闸保证同一个人在一个
 * 场合至多命中一个 trait 槽（key 里带 scope）。**跨场合一开就冲突了**：
 * 私聊记的「所在地」与群 A 记的「职业/年龄」变成同一个人的两行候选，`perPerson: 1`
 * 按 credibility 截断（同分 ⇒ 顺序决定），于是**一条会静默顶掉另一条**。
 * 实测：群 B 里 `所在地=成都` 就这样凭空消失，而响应看起来一切正常（`profileLines` 有 1 行）。
 * ⇒ 在候选阶段就按人合并成一个合成槽，让"合并成一行"这件事真的发生，而不是靠截断碰运气。
 */
export function buildProfileCandidates({ winners, people, normalizer, lineage = {}, includeSelf = true, nowScope = '', allowCrossScope = false, profilePolicy }) {
  const list = Array.isArray(winners) ? [...winners] : [...(winners || [])];
  if (!list.length) return [];
  const persons = resolvePersons({ people, normalizer, lineage, includeSelf });
  if (!persons.length) return [];

  const passed = list.filter((rec) => String(rec?.fact_kind) === 'trait'
    && profileScopeAllowed({
      slotScope: rec?.scope,
      nowScope,
      isSelf: String(rec?.speaker) === 'SELF',
      allowCrossScope, profilePolicy
    }));

  // 按归属人合并（归属判据与 `assignToPersons` 完全一致：speaker 或 target 命中）
  const merged = [];
  const byOwner = new Map();
  for (const rec of passed) {
    const owner = persons.find((p) => p.labels.has(String(rec.speaker))
      || p.labels.has(String(rec.target || '')));
    if (!owner) continue;               // 不属于在场任何人 ⇒ 渲染出来也会被丢掉
    const items = traitItemsOf(rec);
    if (!items.length) continue;
    const cur = byOwner.get(owner.who);
    if (!cur) {
      const clone = { ...rec, sourceRecords: [rec], content: { ...(rec.content || {}), items }, identityConflicts: [], identitySpeakers: [String(rec.speaker)] };
      byOwner.set(owner.who, clone);
      merged.push(clone);
    } else {
      cur.sourceRecords.push(rec);
      if (!cur.identitySpeakers.includes(String(rec.speaker)) || cur.scope !== rec.scope) {
        for (const item of items) {
          const prior = cur.content.items.find(x => x.k === item.k);
          if (prior && prior.v !== item.v && !isMultiValueTrait(item.k)) {
            cur.identityConflicts.push(`${item.k}：${prior.v} / ${item.v}`);
          }
        }
        cur.identitySpeakers.push(String(rec.speaker));
      }
      cur.content.items = mergeTraitItems(cur.content.items, items);
    }
  }
  return assignToPersons(merged, persons, rec => {
    const line = renderProfileLine(rec);
    return line && rec.identityConflicts.length
      ? `${line}（合并前记录有分歧，待确认：${[...new Set(rec.identityConflicts)].join('；')}）` : line;
  }, (candidate,rec) => ({ ...candidate, sourceSlots: rec.sourceRecords.map(r => ({ key:r.key,rev:r.rev,scope:r.scope,
    itemKeys:traitItemsOf(r).map(i=>i.k), relation:evaluateVisibility({sourceScope:r.scope,targetScope:nowScope,isSelf:r.speaker==='SELF',policy:profilePolicy || (allowCrossScope?'all':'same-scope')}).relation })),
    mixedScopes:new Set(rec.sourceRecords.map(r=>r.scope)).size>1,
    conflicts:rec.identityConflicts, scopeRank:rec.sourceRecords.every(r=>r.scope===nowScope||r.speaker==='SELF')?0:1 }));
}

/** 余弦相似度（维度不一致/零向量 ⇒ 0）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 注入相似度阈值的默认值 —— **口径的唯一来源**：
 * 本常量 ⟷ `adapters/qq-agent/plugin.json` 的 `injectThreshold.default` ⟷ 面板数值框为空时的含义（"未设"）
 * ⟷ `core/backend.mjs` 的 `DEFAULT_SETTINGS.injectThreshold`。
 *
 * 沿革：**0.85（2026-10-10 拍板）→ 0.5（2026-10-13 按实测校准）**。
 * 下调依据 = 真库实测（`ADR-0028 §3.3` / `ROADMAP` #13）：3 个话题一致，`hot`（话题相关性加成）
 * 首次出现的阈值是 **0.45~0.5**，而 **0.85 下恒 0** ⇒ 阈值虽已"活"（`minScore` 的 `NaN` 已修），
 * 该加成仍一次都不发生。0.5 下实测：3 个话题里 **2 个各有 2/8 行 hot**（「表情包」「插件报错」），
 * 「画图 本子 题材」要 **0.45** 才生效 —— 即真正的分界落在 0.45~0.5 之间。
 * 取 **0.5 = 守边界值**：让加成真的发生，同时保住"只有明显相关才排最前"的语义（0.45 会更宽）。
 * **它仍是可配置项**（面板「回复时注入什么 → 话题相关度阈值」）：换嵌入模型后分布会变，需重新校准。
 */
export const DEFAULT_MIN_SCORE = 0.5;

/**
 * **关键词路**的 hot 门槛（`ADR-0033`）—— 与 `DEFAULT_MIN_SCORE` **不是同一个量**。
 *
 * ⚠️ 这两个数字属于不同的尺子，**不可互换**：
 *   · `DEFAULT_MIN_SCORE = 0.5` 量的是**余弦相似度**（0~1，按 1024 维模型的真库分布校准）；
 *   · 本值是**话题重合度**的刻度（`topicOverlap`，0~2）：`1.0` = 一次**真词**命中，
 *     `0.2` = 只有单字巧合（这是它自己的**上限**）。
 *
 * 为什么取 `1`：宿主侧用真数据调出来的结论可以直接搬 —— 单字被压到 0.2 之后，
 * "只有单字巧合的候选同分 ⇒ 顺序不变（等于没插手），只有真词命中（≥1）才换人"。
 * 也就是说 **1 这个门槛的语义是"至少一个真词命中"，不是"相似度够高"**。
 *
 * ⚠️ 刻意**不做成配置项**：面板上那个阈值框的语义是余弦，同一栏填两个量纲的数
 * 只会让人填错。真要用别的值，得先设计"按度量分栏"的 UI —— 那是另一件事。
 * 生效值一律在 `/inject` 响应里回报（`minScore` + `minScoreCaliber`），不藏在代码里。
 */
export const DEFAULT_TOKEN_MIN_SCORE = 1;

/**
 * 关键词路的相似度数组（`ADR-0033`）——给 `/inject` 在嵌入缺席时顶上。
 *
 * ⚠️ 方向与 `topicOverlap` 的默认用法一致：**候选属性行当 `content`、当前话题当 `topicSets`**
 *    （话题句短、候选行也短，这里是宿主原本的用法，不是检索那一侧的用法）。
 * ⚠️ 传进来的 `topic` 必须**已归一化**（真名已变占位符），否则它与槽里的行永远对不上。
 */
export function tokenOverlapSims(lines, topic) {
  const t = String(topic || '').trim();
  if (!t) return null;
  return (Array.isArray(lines) ? lines : []).map((line) => topicOverlap(line, [t]));
}

/**
 * 把「请求参数 → 落盘设置 → 代码默认」三级来源收敛成一个**有限、且落在 (0,1]** 的阈值。
 *
 * ⚠️ 不收敛会踩两个**叠在一起**的坑，任一个单独出现都是**静默失效**（不报错、不抛错，
 * 只是功能悄悄不工作）：
 *
 * ① **`??` 挡不住 `NaN`**：`Number(undefined) ?? 0.85` 得到的是 **`NaN`** 而不是 `0.85`
 *    （`??` 只对 null/undefined 生效，`NaN` 原样通过）⇒ `sim >= NaN` 恒 false ⇒ `hot` 恒 false
 *    ⇒「话题相关性加成」永久失效。仓里同款坑踩过一次：`embed.mjs:88`（retries）。
 *    ⇒ 必须用 `Number.isFinite` 挡一道，**别指望 `??`**。
 *
 * ② **面板无法表达"未设"，只能写 `0`**：`settings-ui.js:731-734` 的 `collect()` 会把
 *    **每个** `[data-key]` 数值字段做 `Number(el.value)`，空输入 ⇒ `0`；且它遍历的是
 *    **所有渲染出来的字段**（不只改动过的）⇒ **每点一次保存都会把空着的字段写回 0**。
 *    所以读侧必须把 `0`（以及负数 / 非有限值）当作"未设"继续往下落；否则用户清空一次
 *    输入框、或任何一次 `saveSettings()`，都会把这个阈值静默改成 0。
 *    （同族口径一致：`injectPerPerson` / `injectTotal` / `topK` / `maxChars` / `judgePerMinute`
 *      在 `router.mjs` 里都是 `Number(x) || 默认` 这一套。）
 *
 * @param {...any} sources 按优先级排列的候选（如：请求参数 → 落盘设置）
 * @returns {number} 落在 (0,1] 的有限数；全部无效时回落 `DEFAULT_MIN_SCORE`
 */
export function resolveMinScore(...sources) {
  for (const v of sources) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    return Math.min(1, Math.max(0, n));
  }
  return DEFAULT_MIN_SCORE;
}

/**
 * 把候选排成最终注入清单。
 *
 * @param {object} opts
 * @param {Array<{line,who,credibility}>} opts.candidates  buildInjectCandidates 的产物
 * @param {number[]} [opts.sims]   与 candidates 平行的"属性 ↔ 当前话题"相似度（缺省视为 0）
 * @param {number} [opts.minScore] 缺省 `DEFAULT_MIN_SCORE`；**由 `resolveMinScore()` 收敛后传入**
 * @param {'boost'|'hard'} [opts.mode='boost']
 * @param {number} [opts.perPerson=2]
 * @param {number} [opts.total=8]
 * @returns {{ lines: Array<{who,line,credibility,score,hot}>, droppedByThreshold: number }}
 */
export function selectInjectLines({ candidates, sims = null, minScore = DEFAULT_MIN_SCORE, mode = 'boost', perPerson = 2, total = 8 }) {
  // ⚠️ hard 的降级契约：**没有相似度信息**（sims=null，嵌入缺席）时 hard 必须降级为 boost ——
  // "缺依赖"不能变成"什么都不注入"，那等于服务缺席比服务在跑更吵（静默性反转）。
  // 注意区分 sims=[0,0,…]（有信息，全都不过阈值）与 sims=null（没有信息）。
  const effMode = mode === 'hard' && sims === null ? 'boost' : mode;
  const scored = candidates.map((c, i) => {
    const sim = Number(sims?.[i]) || 0;
    const hot = sim >= minScore;
    // `scopeRank` 缺省 0（同场合）—— 旧调用方/档案段不带这个字段，行为不变。
    const scopeRank = Number(c.scopeRank) || 0;
    return { ...c, hot, scopeRank, score: (hot ? 1000 : 0) + c.credibility };
  });
  let pool = scored;
  let droppedByThreshold = 0;
  if (effMode === 'hard') {
    pool = scored.filter((x) => x.hot);
    droppedByThreshold = scored.length - pool.length;
  }
  // 排序主键 = 场合（同场合必先于跨场合），次键 = hot/可信度。
  //
  // ⚠️ "同场合优先"**只靠这一个主键**实现，不要再套一层两轮取数 ——
  //    首版就是两轮（先取 same 再补位），而变异验证证明它是**死代码**：
  //    主键已经 rank 优先，两轮跑出来的序列与单轮逐条相同（把第二轮拆掉行为不变）。
  //    冗余分支的代价不是多跑几行，而是"看起来有两道保险、实际只有一道"，
  //    将来主键被改动时没人会去动那个"保险"，它只会让人以为还有退路。
  //
  // ── 第三键：记录的新旧（新的先），2026-10-22 ───────────────────────────────
  // 前两键全平局时，V8 的稳定排序会保留 `winners` 的迭代序（= 落库顺序），
  // 于是**"谁被 `perPerson` 截断"退化成写入先后** —— 刚记的那条反而被很久以前的
  // 挤出名额，且全程无报错（本文件档案段的注释里早写着"同分 ⇒ 顺序决定，
  // 一条会静默顶掉另一条"，只是属性段一直没修）。
  // 实测（2026-10-22 号A）：367 个活槽里 **341 条 `evidence_n=1`** ⇒ 绝大多数候选同分，
  // 这个"顺序"不是边角情况而是**主路径**。
  // ⇒ 把平局固定成"新的先"：至少是可解释的，且与"记忆是会被更正的"这个前提一致。
  const recAt = (x) => {
    const t = Date.parse(String(x.rec?.derived_from?.at ?? ''));
    return Number.isFinite(t) ? t : 0;
  };
  const recRev = (x) => Number(x.rec?.rev) || 0;
  pool = [...pool].sort((a, b) => (a.scopeRank - b.scopeRank)
    || (b.score - a.score)
    || (recAt(b) - recAt(a))
    || (recRev(b) - recRev(a)));

  // 每人 perPerson 条 → 总量 total 条。行的人 = who（同一人名聚合）。
  const cap = Math.max(1, total);
  const perCap = Math.max(1, perPerson);
  const perCount = new Map();
  const lines = [];
  for (const x of pool) {
    if (lines.length >= cap) break;
    const n = perCount.get(x.who) || 0;
    if (n >= perCap) continue;
    perCount.set(x.who, n + 1);
    lines.push({
      who: x.who,
      line: x.line,
      credibility: Math.round(x.credibility * 10) / 10,
      hot: x.hot,
      scopeRank: x.scopeRank
    });
  }
  return { lines, droppedByThreshold };
}

/** 渲染成追加进 system 的文本块（含哨兵注释，宿主幂等用）。 */
export function renderInjectBlock(lines) {
  if (!lines.length) return '';
  const body = lines.map((l) => `- ${l.who}：${l.line}`).join('\n');
  return `<!--mv-inject-->\n【人格属性（来自长期记忆，悄悄参考，不要主动提及）】\n${body}`;
}

/** 档案段单独成块（只有档案、没有属性行时用；哨兵同样只在最前面出现一次）。 */
export function renderProfileBlock(lines) {
  if (!lines.length) return '';
  const body = lines.map((l) => `- ${l.who}：${l.line}`).join('\n');
  return `<!--mv-inject-->\n【档案（长期固定特征，悄悄参考，不要主动提及）】\n${body}`;
}

/**
 * 档案段 + 属性段**合成一个块**（`ADR-0031`）。
 *
 * ⚠️ 哨兵 `<!--mv-inject-->` **只出现一次、且必须在最前面** —— 宿主适配层靠它判重
 * （`adapters/qq-agent/index.js:375/514`），两段各带一个会让"第二次注入"的判重逻辑
 * 只挡住第一段。⇒ 合并渲染，而不是拼两个块。
 *
 * **档案在前**：先交代"这个人是谁"，再给"最近相关的属性"。
 */
export function renderCombinedBlock({ profileLines = null, lines = null, crossChatLines = null, eventLines = null } = {}) {
  const p = Array.isArray(profileLines) ? profileLines.filter(Boolean) : [];
  const a = Array.isArray(lines) ? lines.filter(Boolean) : [];
  // 跨会话段（`ADR-0043`）已经是**渲染好的整节文本**（含自己的小标题），不是 `{who,line}`，
  // 所以单独一路，不参与上面两条的 `- who：line` 拼装。
  const c = Array.isArray(crossChatLines) ? crossChatLines.filter(Boolean) : [];
  // 事件段（M5，2026-10-22）同理：整节文本、自带小标题。
  const ev = Array.isArray(eventLines) ? eventLines.filter(Boolean) : [];
  if (!c.length && !ev.length) {
    // 老路径**逐字保留**：没有跨会话段/事件段时，输出必须与 0.29.0 完全一致（有测试钉着）。
    if (!p.length) return renderInjectBlock(a);
    if (!a.length) return renderProfileBlock(p);
    const pBody = p.map((l) => `- ${l.who}：${l.line}`).join('\n');
    const aBody = a.map((l) => `- ${l.who}：${l.line}`).join('\n');
    return `<!--mv-inject-->\n`
      + `【档案（长期固定特征，悄悄参考，不要主动提及）】\n${pBody}\n\n`
      + `【人格属性（来自长期记忆，悄悄参考，不要主动提及）】\n${aBody}`;
  }
  // 哨兵只在最前面出现一次（宿主靠它判重），所有段共用。
  const sections = [];
  if (p.length) {
    sections.push(`【档案（长期固定特征，悄悄参考，不要主动提及）】\n${p.map((l) => `- ${l.who}：${l.line}`).join('\n')}`);
  }
  if (a.length) {
    sections.push(`【人格属性（来自长期记忆，悄悄参考，不要主动提及）】\n${a.map((l) => `- ${l.who}：${l.line}`).join('\n')}`);
  }
  sections.push(...ev);
  sections.push(...c);
  return `<!--mv-inject-->\n${sections.join('\n\n')}`;
}

export { SLOT_CALIBER };
