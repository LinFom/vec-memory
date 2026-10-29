// 归一化器 —— 全项目**唯一**一个把"文本里的真实实体"换成占位符的组件。
//
// ── 它存在的理由（就一条）────────────────────────────────────────────────
// ADR-0002 决定：只有「归一化文本」出境。
// 而实测小时块的 `title` 里**直接写着 QQ 号**（`private:100000001 @ 2026-10-07 16:00`），
// `summary` 里写着昵称。所以「把标题拼一拼就送云端」= 身份出境。
// 这个文件就是那道闸门。
//
// ── 四条纪律（每一条都对应文档里一个已定的决定）───────────────────────────
// 1. **只有一个实例**（ADR-0003）：索引侧与查询侧**共用同一个对象**，
//    不是"同一套代码"。各 new 一个会加载出不同版本的注册表 → 静默漂移。
//    所以对外的主入口是 `getSharedNormalizer()`，构造函数也可以直接用但考试会盯你。
// 2. **不漏优先于不误**（ADR-0003）：误报只是轻微语义损失，且**两侧对称**，
//    检索一致性不受影响；漏报是**名字出境**，不可撤回。
//    因此低 `hit_count` 的条目**照样替换**，只是同时进待审池。
// 3. **占位符由 HMAC 派生，不用自增计数器**（ADR-0002）：
//    自增编号在重建索引时会漂移，同一个人的向量会分裂到不同空间。
//    这里用 `HMAC(本机密钥, 种类|实体ID)` 派生，**与插入顺序无关**。
// 4. **纯本机件**：不参与任何网络调用，因此可以有一个独立于网络的自检 ——
//    `assertClean()` 直接断言"输出里不含任何原始实体串"。这比任何单元测试都直接。
//
// ── 四层判定，一个出口（ADR-0003）────────────────────────────────────────
//   对齐层   `@名[CQ:at,qq=ID]` / `[引用 名(QQ:ID)：` / `[引用 #n 名：`
//            —— **不依赖词表**：形态自己带着硬 ID，所以词表漏了也能替换
//   规则层   姓氏+称谓、老/小+姓
//   注册表层 已知 surface（词表 + 累积注册的串），越用越准
//   数字层   5~12 位纯数字（QQ 号形态，零误报）
//   兜底层   分布集中度可疑的短串（需要一次全库扫描喂进来）
// 各层**输出同一个形状** `{ start, end, label, kind, layer, term }`，
// 后面的替换逻辑不关心它是谁判出来的。
//
// ── 对齐层为什么必须存在（2.1 那处漏替的修复）────────────────────────────
// `findLeak` 只能拦**词表里已有的串**。词表漏掉一个实体，它就完全看不见 ——
// 实测就是这样漏掉了机器人自己的名字（`Single Samara`）。
// 所以除了"把词表做全"（vocab.mjs 的锚点挖掘），还要有一条**不依赖词表**的兜底：
// 只要形态长得像"名字 紧挨着 一个硬 ID"，就直接用那个 ID 定身份。
// 两条一起上，才是"闸门"而不是"祈祷词表够全"。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NORMALIZER_VERSION = 2;

/**
 * **低权重词条**：不超过三位的纯 ASCII 字母/数字（`16` / `17` / `abc` / `3`）。
 *
 * 用户口径（2026-10-29）：这类串**允许**被登记成实体，但**权重降低**。把"降权"拆成
 * 三条可执行的语义，写在这里而不是散在各处 —— 三条是一起成立才叫降权的：
 *   ① **占位顺序排最后**：强词条（任何人名、地名、长串）先占位置，它只能吃剩下的；
 *   ② **必须整词**：`100000001` 里的 `11`、`16g` 里的 `16` 都不算它出现过；
 *   ③ **不单独构成泄漏**：`findLeak` 跳过它。
 *
 * ③ 是知情下的交换，代价要写明：真有人昵称就叫 `16`，而正文里那处 `16` 又恰好没被替换时，
 * 这个串会出境。换来的是"三位以内的字母数字串不再一票否决整块记忆" ——
 * 拿它拦下来的信息量（一个 `< 4` 字符的公共 token）远小于拦错的代价
 * （一条块永久进不了库）。**结构性证据不受影响**：`@名`、`(QQ:数字)`、`[引用 名(QQ:)]`
 * 这些形态闸门照样一律拦，它们不靠词表。
 */
const WEAK_TERM_RE = /^[A-Za-z0-9]{1,3}$/;

/** 是不是低权重词条（≤3 位纯 ASCII 字母数字）。给词表/关键词/测试共用一份判据。 */
export function isWeakTerm(term) {
  return WEAK_TERM_RE.test(String(term ?? ''));
}

const OPEN = '〔';
const CLOSE = '〕';

/**
 * 占位符 token 的**规范形态**（正文里长这样：`〔P7722〕` / `〔SELF〕` / `〔MENTION〕`）。
 *
 * 全项目**只此一份来源**。以前这个形态在 `findLeak` / `findEntityForm` 里各写了一遍
 * （两处 `/〔[^〕]*〕/g`）；`lib/extract.mjs` 数"有效字符"时又要用它 ——
 * 再写第三份就是"口径分叉"，而本项目已经吃过一次同型的亏
 * （`cjkCount` 与 `extractTerms` 的字符类必须**逐字一致**才不走样）。
 */
export const PLACEHOLDER_PATTERN = '〔[^〕]*〕';

/**
 * 宿主拍平后残留的**媒体标记**清单（不含方括号）—— **单一来源**（`ADR-0018` 决定 6）。
 *
 * 本模块用它把 `[image]` 这类标记替换成 `〔MEDIA〕`；
 * `lib/extract.mjs` 的脚手架白名单**引用同一个清单**（再加中文标记），
 * ⇒ 这里新增一种标记，抽取侧自动跟上，不存在"改了一处忘了另一处"。
 * ⚠️ 中文标记（`[图片]` 等）**只**出现在抽取侧白名单：本模块刻意不认它们
 * （认了就要进 `NORMALIZER_VERSION` 的账），归一化输出里仍保留原样、由抽取侧剥。
 */
export const MEDIA_MARKER_LABELS =
  'image|face|reply|at|voice|video|file|sticker|emoji|animation|record|json|xml|share|music';

/** 同一形态的全局 regex（内部 `replace` 用；`replace` 会自行重置 `lastIndex`）。 */
const PLACEHOLDER_RE_G = new RegExp(PLACEHOLDER_PATTERN, 'g');

/**
 * 剥掉文本里的占位符 token（`〔P7722〕` → ``）。
 *
 * 用途：数"这句话说了什么"之前，要先去掉"这句话在说谁" —— 占位符不是内容。
 * （`lib/extract.mjs` 的句长下限就靠它：不然 `〔P7722〕` 会被算成 6 个有效字符。）
 */
export function stripPlaceholders(text) {
  return String(text ?? '').replace(PLACEHOLDER_RE_G, '');
}

/** 占位符前缀：种类 → 字母。`self` 是固定的 `〔SELF〕`，不带编号。 */
const KIND_PREFIX = { person: 'P', group: 'G', self: 'SELF', qq: 'Q', other: 'X' };
/** 派生的编号空间。9999 够用，且短 —— 占位符是嵌入模型的罕见 token，越短越好。 */
const LABEL_SPACE = 9999;
/** 规则层的称谓后缀。判定条件是"前一个字是已知人名的首字或常见姓氏"，见 normalize 的 ⑧。 */
const 称谓_SUFFIX = '老师|老哥|大佬|姐|哥|叔|姨|总|兄|弟|妹|佬';
/**
 * 常见姓氏（约 60 个）。
 *
 * 为什么需要它：规则层 ⑧ 的**高置信**判据是"首字是词表里某个人的名字首字"
 * —— 那能把 `沫老师` 认到 `沫钤` 身上。但"老王/小王"这类称呼里的姓氏常常
 * 不在我们已有的词表里（那个人还没说过话），只靠词表会漏。
 * ADR-0003 说的「不漏优先于不误」在这里就体现为：再加一份保守的姓氏表兜底。
 *
 * 刻意**很短**且**排除 时 / 大 / 小 / 老 / 少**：短名单只会漏，不会误伤
 * 「小时」「大家」「老实」这些高频词 —— 后者会把整段文本啃掉。
 */
const COMMON_SURNAMES = new Set(
  ('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙').split('')
);

/**
 * 「老/小 + 姓」形态（`老王` `小王` `小张`）。
 * 第二字必须是常见姓氏 —— 这一条把 `小时` `老大` 之类挡在外面。
 */
const 老小_PATTERN = new RegExp(`[老小]([${[...COMMON_SURNAMES].join('')}])`, 'g');

/**
 * 合并转发块的开始标记（存档里被拍平后的形态：`[合并转发 共4条] - 某名: 内容 …`）。
 * 只在文本**含**这个标记时才启用转发说话人规则 —— 不做全篇扫描。
 */
const FORWARD_MARKER_RE = /\[合并转发/;

/**
 * 合并转发标记的**完整形态与剥离**（2026-10-09 拍板，`ROADMAP #9` 关闭）：
 * 标记是 QQ 客户端的 UI 文字 —— 没有任何人真的说过它，属**脚手架**。
 * 实测存档两种形态：`[合并转发 共N条]`（60+ 处）与 `[合并转发聊天记录]`（20 处）。
 * 全留原样会让所有转发块共享同一串字面量 ⇒ 相似度互相虚高（检索排序被扭曲）。
 * 剥离放在**文本重建之后**：⑦' 的说话人遮蔽需要 `src` 里的标记位置（`markerAt`），
 * 若在 span 层删它，⑦' 的判据就要改算偏移 —— 不值得；重建后正则剥最直白。
 */
const FORWARD_MARKER_STRIP_RE = /\s*\[合并转发(?:\s*共\d+条|聊天记录)\]\s*/g;

/**
 * 转发块内说话人标签的**两条高置信形态**（形态取自真实存档，不是猜的；`ROADMAP #6`）：
 *   ① `- 名字: 内容` —— 拍平时插入的 `- ` 分隔符（实测：`- KID1411: [图片]`）
 *   ② `名字: [媒体标记]` / `名字: @某人` —— 冒号后紧跟 `[` 或 `@`
 *      （实测：`…等于2 沫沫: [图片]` —— 块内最后一条没有前导破折号）
 *
 * ⚠️ 刻意**不做**"冒号前一律当名字"：转发块里同样可能是 `价格: 100` 这样的内容。
 * 而且名子里必须**至少有一个字母**（CJK 或拉丁）—— `- 3: 0` 这类比分不算说话人。
 * 判据是"宁少剥不误剥"（同 `ADR-0018` 决定 6 的脚手架白名单纪律）。
 */
const FORWARD_SPEAKER_RES = [
  /-\s*([^\s：:\[\]〔〕]{1,24})\s*[：:]/g,
  /([^\s：:\[\]〔〕]{1,24})\s*[：:]\s*(?=[[@])/g
];

export class NormalizerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'NormalizerError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// ── 派生工具 ─────────────────────────────────────────────────────────────

/** HMAC-SHA256 取前 4 字节 → 32 位无符号整数。确定性、不可逆、与顺序无关。 */
export function hmac32(secret, message) {
  const mac = crypto.createHmac('sha256', String(secret)).update(String(message), 'utf8').digest();
  return mac.readUInt32BE(0);
}

/** 占位符 → 文本。 */
export function render(label) {
  return `${OPEN}${label}${CLOSE}`;
}

/**
 * 占位符分配器。
 *
 * 关键性质：**同一组实体 → 同一组编号，与插入顺序无关。**
 * 做法是先把实体按 `HMAC(secret, kind|id)` 排序（这个顺序只取决于 id 与密钥），
 * 再顺着排。冲突时从 n=1 开始重新派生，仍然确定性。
 *
 * 另有一条工程上的让步：**已经分配过的编号优先保留**。
 * 词表是会长大的（新群友加入），若每次重排都让老实体改号，
 * 它们的向量就得重算。保留旧号 = 只给新实体找空位。
 */
export function allocateLabels(secret, entities, previous = new Map()) {
  const labels = new Map();   // entityId -> label
  const taken = new Set();    // 'P123' 形态的已占键

  const claim = (label) => {
    const owner = taken.has(label);
    if (!owner) taken.add(label);
    return !owner;
  };

  const fresh = [];
  for (const e of entities) {
    if (e.kind === 'self') {
      labels.set(e.id, 'SELF');
      continue;
    }
    const prevLabel = previous.get(e.id);
    if (prevLabel && prevLabel !== 'SELF' && claim(prevLabel)) {
      labels.set(e.id, prevLabel);
    } else {
      fresh.push(e);
    }
  }

  // 顺序无关：先按 (hash, id) 排，再逐个从 n=0 开始找空位
  const scored = fresh.map((e) => ({ e, h: hmac32(secret, `${e.kind}\u0000${e.id}`) }));
  scored.sort((a, b) => (a.h - b.h) || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));

  for (const { e } of scored) {
    const prefix = KIND_PREFIX[e.kind] || KIND_PREFIX.other;
    let placed = null;
    for (let n = 0; n < 4096; n++) {
      const num = (hmac32(secret, `${e.kind}\u0000${e.id}\u0000${n}`) % LABEL_SPACE) + 1;
      const label = `${prefix}${num}`;
      if (claim(label)) { placed = label; break; }
    }
    if (!placed) {
      throw new NormalizerError('LABEL_EXHAUSTED', `实体 ${e.id} 找不到可用占位符编号（编号空间已满或被占）`);
    }
    labels.set(e.id, placed);
  }
  return labels;
}

// ── 主类 ─────────────────────────────────────────────────────────────────

/**
 * 归一化器。
 *
 * **不要直接 new** —— 走 `getSharedNormalizer()`。直接 new 出来的第二个实例
 * 会加载出自己的一份注册表，两侧不一致时**不会报错，只会慢慢变得不对**。
 */
export class Normalizer {
  /**
   * @param {object} opts
   * @param {string} opts.secret   本机密钥（16+ 字节 hex）。缺省时按 dir 生成并落盘。
   * @param {string} [opts.dir]    本机数据目录（放映射表/注册表/待审池）。不给则纯内存。
   * @param {boolean} [opts.autoLoad=true]
   */
  constructor(opts = {}) {
    if (!opts || (opts.secret === undefined && !opts.dir && opts.autoLoad !== false)) {
      throw new NormalizerError('NO_SECRET_OR_DIR', '归一化器需要 secret 或 dir（否则占位符无法稳定）');
    }
    this.dir = opts.dir ? path.resolve(opts.dir) : null;
    this.secret = opts.secret ? String(opts.secret) : this._loadOrCreateSecret();
    if (!this.secret || this.secret.length < 16) {
      throw new NormalizerError('WEAK_SECRET', '归一化器密钥至少 16 个字符 —— 它决定占位符的不可反推性');
    }

    /** @type {Map<string, {id:string, kind:string, surface:Set<string>}>} entityId → 实体 */
    this.entities = new Map();
    /** @type {Map<string, string>} entityId → label */
    this.labelById = new Map();
    /** @type {Map<string, string>} 别名 id → 真实体 id（`qq:3869416070` → `self`） */
    this.aliasById = new Map();
    /** @type {Map<string, string>} label → entityId */
    this.byLabel = new Map();
    /** @type {Map<string, string>} surface → entityId（词表的精确匹配索引） */
    this.surfaceIndex = new Map();
    /** @type {Map<string, object>} term → { hitCount, layer, label, kind, firstSeen, lastSeen } */
    this.registry = new Map();
    /** @type {Map<string, object>} term → { layer, count, firstSeen, reason } —— 待审池 */
    this.pending = new Map();
    /** @type {Set<string>} 兜底层：分布集中度可疑的短串（由全库扫描喂进来） */
    this.suspects = new Set();
    /** @type {Map<string, {label:string, kind:string}>} 临时实体（未进词表的人名/QQ） */
    this.ephemeral = new Map();
    /** @type {Map<string, object[]>} 人名首字 → 可能的实体（规则层 ⑧ 用） */
    this.byNameHead = new Map();
    /** @type {Set<string>} 全部人名首字 */
    this.nameHeads = new Set();

    this._termCache = null;
    this.lastNormalize = null;

    if (opts.autoLoad !== false) this.load();
  }

  // ── 持久化（本机）──────────────────────────────────────────────────────
  get files() {
    return {
      secret: this.dir ? path.join(this.dir, 'secret.key') : null,
      entities: this.dir ? path.join(this.dir, 'entities.json') : null,
      registry: this.dir ? path.join(this.dir, 'registry.json') : null,
      pending: this.dir ? path.join(this.dir, 'pending.json') : null
    };
  }

  /**
   * 密钥：**丢失时不许静默重建。**
   *
   * 为什么这条是硬约束：占位符 = HMAC(secret, 实体)。密钥换了，**同一个人的编号全变**。
   * 而库里（`vectors.bin` / `meta.jsonl`）存的是旧编号算出来的向量与文本 ——
   * 于是检索会**照常返回结果，只是全是错的**。这是本项目反复防的那类静默失败：
   * 类型合法、不报错、结果看起来正常。
   *
   * 判据：只要有映射表（`entities.json`）却读不到密钥，就说明密钥被删/损坏 ——
   * 抛 `SECRET_LOST`，由面板告诉用户"索引已作废，需要重建"，而不是悄悄给一套新编号。
   * 全新安装（映射表也不存在）才允许生成。
   */
  _loadOrCreateSecret() {
    const f = this.files.secret;
    if (!f) throw new NormalizerError('NO_SECRET_OR_DIR', '归一化器需要 secret 或 dir');
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s.length >= 16) return s;
    } catch { /* 读不到，看下面 */ }
    if (fs.existsSync(this.files.entities)) {
      throw new NormalizerError(
        'SECRET_LOST',
        `密钥文件丢了（${f}），但映射表还在。**不能重新生成密钥** —— ` +
          '新密钥会让所有人的占位符编号改变，而库里存的是旧编号算出的向量，' +
          '检索会照常返回结果、只是全错。要恢复：把密钥文件找回来；' +
          '确认找不回来就走一次"重建索引"（旧的向量全部作废）。',
        { secretFile: f, entitiesFile: this.files.entities }
      );
    }
    const s = crypto.randomBytes(32).toString('hex');
    atomicWrite(f, `${s}\n`);
    return s;
  }

  load() {
    if (!this.dir) return this;
    const e = readJson(this.files.entities, null);
    if (e && Array.isArray(e.entities)) {
      const previous = new Map();
      for (const ent of e.entities) {
        if (ent?.id && ent?.label) previous.set(String(ent.id), String(ent.label));
      }
      this.setVocabulary(e.entities.map((ent) => ({
        id: String(ent.id), kind: ent.kind || 'person', surface: ent.surface || [], aliases: ent.aliases || []
      })), { keepLabels: previous });
      for (const item of (e.ephemeral || [])) {
        if (item?.term && item?.label) {
          this.ephemeral.set(String(item.term), { label: String(item.label), kind: item.kind || 'person' });
        }
      }
    }
    const r = readJson(this.files.registry, null);
    if (r && Array.isArray(r.entries)) {
      for (const item of r.entries) {
        if (!item?.term) continue;
        this.registry.set(String(item.term), {
          hitCount: Number(item.hitCount) || 0,
          layer: item.layer || 'registry',
          label: item.label || '',
          kind: item.kind || 'person',
          firstSeen: item.firstSeen || null,
          lastSeen: item.lastSeen || null
        });
      }
    }
    const p = readJson(this.files.pending, null);
    if (p && Array.isArray(p.entries)) {
      for (const item of p.entries) {
        if (!item?.term) continue;
        this.pending.set(String(item.term), {
          layer: item.layer || 'heuristic',
          count: Number(item.count) || 0,
          firstSeen: item.firstSeen || null,
          reason: item.reason || ''
        });
      }
    }
    this._termCache = null;
    return this;
  }

  save() {
    if (!this.dir) return this;
    atomicWrite(this.files.entities, `${JSON.stringify({
      version: NORMALIZER_VERSION,
      note: '占位符 ↔ 实体映射表。本机最敏感资产，等同通讯录 —— 不随索引导出、不进任何向量化文本。',
      entities: [...this.entities.values()].map((e) => ({
        id: e.id, kind: e.kind, label: this.labelById.get(e.id) || '',
        surface: [...e.surface], aliases: [...(e.aliases || [])]
      })),
      ephemeral: [...this.ephemeral.entries()].map(([term, v]) => ({ term, label: v.label, kind: v.kind }))
    }, null, 2)}\n`);

    atomicWrite(this.files.registry, `${JSON.stringify({
      version: NORMALIZER_VERSION,
      note: '实体注册表。第二份敏感资产 —— 决定"是否永久写入"，不决定"是否替换"。',
      entries: [...this.registry.entries()].map(([term, v]) => ({
        term, hitCount: v.hitCount, layer: v.layer, label: v.label, kind: v.kind,
        firstSeen: v.firstSeen, lastSeen: v.lastSeen
      }))
    }, null, 2)}\n`);

    atomicWrite(this.files.pending, `${JSON.stringify({
      version: NORMALIZER_VERSION,
      note: '待审池。低 hit_count 的命中照样替换（不漏优先），只是同时进这里等人工确认。',
      entries: [...this.pending.entries()].map(([term, v]) => ({
        term, layer: v.layer, count: v.count, firstSeen: v.firstSeen, reason: v.reason
      }))
    }, null, 2)}\n`);
    return this;
  }

  // ── 词表 ───────────────────────────────────────────────────────────────
  /**
   * 装载在场实体词表。**幂等**：重复调用同内容不会改变任何编号。
   *
   * `aliases` 是"这个实体在别处还会被叫成什么 ID"。
   * 目前唯一的用途是 `self` —— 它的实体 id 是 `self`（不是号码），
   * 所以必须显式声明 `qq:100000001` 也指向它，否则结构层遇到
   * `[CQ:at,qq=100000001]` 会把它当成一个陌生人（2.1 的另一半根因）。
   *
   * @param {Array<{id:string, kind?:string, surface:string[]|Set<string>, aliases?:string[]}>} list
   * @param {{keepLabels?:Map<string,string>}} [opts]
   */
  setVocabulary(list, opts = {}) {
    const items = (Array.isArray(list) ? list : [])
      .filter((e) => e && e.id !== undefined && e.id !== null && String(e.id).trim() !== '')
      .map((e) => ({
        id: String(e.id),
        kind: ['person', 'group', 'self', 'other'].includes(e.kind) ? e.kind : 'person',
        surface: new Set(
          (e.surface instanceof Set ? [...e.surface] : (e.surface || []))
            .map((s) => String(s ?? '').trim()).filter(Boolean)
        ),
        aliases: new Set(
          (e.aliases instanceof Set ? [...e.aliases] : (e.aliases || []))
            .map((s) => String(s ?? '').trim()).filter(Boolean)
        )
      }));

    const previous = opts.keepLabels instanceof Map ? opts.keepLabels : new Map();
    const labels = allocateLabels(this.secret, items, previous);

    this.entities = new Map(items.map((e) => [e.id, e]));
    this.labelById = labels;

    // 别名 → 同一个占位符。放在 labelById 建好之后，且**不覆盖真实体**
    // （万一别名和某个真人的 id 撞了，真人优先）。
    this.aliasById = new Map();
    for (const e of items) {
      const own = labels.get(e.id);
      if (!own || !e.aliases.size) continue;
      for (const a of e.aliases) {
        if (labels.has(a)) continue;
        labels.set(a, own);
        this.aliasById.set(a, e.id);
      }
    }

    this.byLabel = new Map();
    // ⚠️ **只收实体自己的标签，不收别名的**。`labels` 里同时有别名条目
    // （`labels.set(别名id, 那个实体的标签)`），而别名与实体**共用同一个标签** ——
    // 别名条目排在后面，会把实体自己的那条覆盖掉，于是 `byLabel.get('P9244')`
    // 返回的是 `qq:222`（被并走的那个 id）而不是 `qq:111`。
    // 后果实测：取消合并时"反查回实体"永远落空，报"落点解析不到实体"。
    // 名字叫 `byLabel` 就该回答"这个标签是谁的"，别名不是谁的标签。
    for (const [id, label] of labels) {
      if (this.entities.has(id)) this.byLabel.set(label, id);
    }

    const surfaceIndex = new Map();
    const ambiguous = [];
    for (const e of items) {
      for (const s of e.surface) {
        if (!s) continue;
        const prev = surfaceIndex.get(s);
        if (prev && prev !== e.id) {
          ambiguous.push({ surface: s, kept: prev, dropped: e.id });
          continue;   // 先到先得；歧义另记，不静默丢
        }
        surfaceIndex.set(s, e.id);
      }
    }
    // 实体自己的 id 也是可匹配的 surface（`qq:123` / `group:456`）；
    // 别名同理（`self` 的 `qq:100000001` 与裸号码 `100000001`）。
    for (const e of items) {
      for (const s of [e.id, e.id.replace(/^qq:/, ''), e.id.replace(/^group:/, '')]) {
        if (s && !surfaceIndex.has(s)) surfaceIndex.set(s, e.id);
      }
      for (const a of e.aliases) {
        for (const s of [a, a.replace(/^qq:/, ''), a.replace(/^group:/, '')]) {
          if (s && !surfaceIndex.has(s)) surfaceIndex.set(s, e.id);
        }
      }
    }
    this.surfaceIndex = surfaceIndex;
    this.ambiguous = ambiguous;

    // 人名首字索引 —— 规则层 ⑧ 靠它判「`沫老师` 是不是在叫 `沫钤`」。
    // 用真实词表当姓氏表，比内置一份"百家姓"准，也不需要维护。
    const byNameHead = new Map();
    for (const e of items) {
      if (e.kind !== 'person') continue;
      for (const s of e.surface) {
        if (!s) continue;
        const head = s[0];
        if (!byNameHead.has(head)) byNameHead.set(head, []);
        const bucket = byNameHead.get(head);
        if (!bucket.some((x) => x.id === e.id)) bucket.push(e);
      }
    }
    this.byNameHead = byNameHead;
    this.nameHeads = new Set(byNameHead.keys());

    this._termCache = null;
    return this;
  }

  setSuspects(terms) {
    this.suspects = new Set((terms || []).map((t) => String(t)).filter((t) => t.length >= 2));
    this._termCache = null;
    return this;
  }

  labelOf(entityId) {
    const id = String(entityId);
    const own = this.labelById.get(id);
    if (own) return own;
    return this._ephemeralLabel('other', id, 'X');
  }

  kindOf(entityId) {
    const id = String(entityId);
    const own = this.entities.get(id);
    if (own) return own.kind;
    const canonical = this.aliasById?.get(id);
    return (canonical && this.entities.get(canonical)?.kind) || 'other';
  }

  /**
   * 结构层用的解析：给定一个"ID 形态的串"（`qq:123` / `group:456` / `123`），
   * 问它是不是**已知实体的别名**。
   *
   * 与 `labelById.get()` 的区别：后者只认实体 id，前者还认别名。
   * `[CQ:at,qq=100000001]` 走的就是这条 —— 自己的号码必须落成 `〔SELF〕`，
   * 而不是一个陌生人的 `〔P####〕`。
   */
  resolveKnown(id) {
    const k = String(id);
    const alias = this.aliasById?.get(k);
    if (alias) return { id: alias, label: this.labelById.get(alias) || '', kind: this.kindOf(alias) };
    const own = this.labelById.get(k);
    if (own) return { id: k, label: own, kind: this.kindOf(k) };
    return null;
  }

  // ── 归一化主流程 ───────────────────────────────────────────────────────

  /**
   * **词表内容指纹**（本轮新增）：对 `[实体 id, 占位符, kind, 别名…]` 排序后取 sha1。
   *
   * ⚠️ 为什么不能只用 `vocab_version`：`NORMALIZER_VERSION` 是**代码版本号**，
   * 加人 / 改名 / 删人物卡**都不会**让它变 ⇒ 词表的漂移是**静默**的（ADR-0013 / 追问 3）。
   * 内容 hash 进边层戳（`params.vocab_hash`）⇒ 词表内容一变，read-model 立刻过期。
   *
   * **只读、无副作用**：不参与任何标签分配，因此不影响现有归一化行为
   * （所以 `NORMALIZER_VERSION` 不必 +1）。
   */
  vocabHash() {
    const rows = [...this.entities.values()].map((e) => [
      e.id,
      this.labelById.get(e.id) || '',
      e.kind || '',
      [...(e.aliases || [])].sort().join(',')
    ].join('\u0000'));
    rows.sort();
    return crypto.createHash('sha1').update(rows.join('\n'), 'utf8').digest('hex').slice(0, 16);
  }

  /**
   * **会话占位符**（本轮新增，**只读、无副作用**）：把明文会话键
   * （`group:100000001` / `private:100000001`）派生为**占位符 token**
   * （`group:C1234` / `private:C5678`）。
   *
   * ⚠️ 为什么必须有这一条：**`scope` 是一条独立的身份通道**。
   * 节点 `a` / `b` 早就走占位符，`scope` 却一直沿用明文 `chatKey` ——
   * 而私聊的 `chatKey` 就是**对方的明文 QQ**（实测存档里就有 `private:100000001`）。
   * 本轮把 `scope` 提进产事实级键（`ADR-0015`）后，它更是**键的一部分**
   * ⇒ 不落占位符 = 从键里泄 QQ（`ADR-0002` 出境红线）。
   *
   * 派生**无状态**：`HMAC(secret, 'scope\0'+chatKey)` ⇒ 不写 `ephemeral`、
   * 不进词表、**不影响 `vocabHash()` 与任何既有占位符** ——
   * 会话不是实体，不该混进实体注册表（否则 `vocab_hash` 会随"看过哪些会话"漂移）。
   *
   * 与 `edges.mjs` 的 `isGroupScope` 同口径：只有 `group:` 前缀算群，其余按私聊。
   *
   * @param {string} chatKey 明文会话键（形如 `<kind>:<raw id>`）
   * @returns {string} 占位符 token（`group:C####` / `private:C####`）
   */
  scopeLabel(chatKey) {
    const k = String(chatKey || '');
    const kind = k.startsWith('group:') ? 'group' : 'private';
    const n = (hmac32(this.secret, `scope\u0000${k}`) % LABEL_SPACE) + 1;
    return `${kind}:C${n}`;
  }

  /**
   * 把一段文本里的标识符剥离、实体替换为占位符。
   *
   * @param {string} text
   * @param {{register?:boolean, context?:string}} [opts]
   *   register: 是否把本次命中写进注册表（索引侧 true，查询侧也可 true —— 两侧对称）
   *   context:  来源说明（写进日志/待审池，不参与判定）
   * @returns {{text:string, hits:Array<object>, stats:object, clean:boolean}}
   */
  normalize(text, opts = {}) {
    const src = String(text ?? '');
    if (!src) {
      return {
        text: '', hits: [],
        stats: { input: 0, output: 0, hits: 0, identity: 0, structural: 0, byLayer: {}, byLayerIdentity: {}, byKind: {}, entities: 0 },
        clean: true
      };
    }
    const register = opts.register !== false;
    // ── 进轮快照：出口自检的判据必须来自「进轮时已知什么」──────────────────
    // 反例（ROADMAP #4，2026-10-09）：本轮的规则登记会**扩充**词表
    // （`_touch` 写注册表、`_ephemeralLabel` 写 ephemeral），拿扩充后的词表去扫本轮输出
    // = **用本轮产物否定本轮产物**：规则 ⑧ 从「三姐妹」里读出一个并不存在的「三姐」，
    // 自检再照这个词去文本里找 —— 报的 `NORMALIZE_LEAK` 是它自己造的（同族：ADR-0020 的伪泄漏）。
    // 定型后的真判在**构建遍**（`register:false`）：那时注册表进轮前就已定型，
    // 快照 == 全量 ⇒ 灵敏度不降；登记遍的产物本来就丢弃。
    // 出境前还有一道**批内批检**（`embed.mjs assertNormalized`，用现行词表）专门抓跨条时序，不受此影响。
    const termsAtEntry = this._termList().slice();
    const occupied = new Uint8Array(src.length);
    const hits = [];

    const push = (start, end, label, kind, layer, term) => {
      // `@` 是提及标记，属于**被提及的那个名字**：`@张三` 换成一个占位符，
      // 不该留下 `@〔P1〕`（身份没漏，但"@ 后面还跟着东西"会让形态闸门判泄漏）。
      // 在入口统一吞掉，比在每个层各写一遍可靠 —— 词表层、规则层、对齐层都受益。
      // 只吞**紧挨着**的 `@`：`group:1 @ 2026-10-26` 里那个 `@` 是分隔符（前面是空格），
      // 不在判据内，所以表头不会被误伤（这是 A/B 对比里最容易踩的一处）。
      if (start > 0 && src[start - 1] === '@' && !occupied[start - 1]) start -= 1;
      // 长匹配优先由调用顺序保证；这里只做重叠拒绝
      for (let i = start; i < end; i++) if (occupied[i]) return false;
      for (let i = start; i < end; i++) occupied[i] = 1;
      hits.push({ start, end, label, kind, layer, term });
      return true;
    };

    const eachMatch = (re, fn) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        fn(m, m.index, m.index + m[0].length);
      }
    };

    // 结构性标识**不进注册表**：注册表只放"实体名"。
    // 把 `#274`、`[CQ:at,qq=1]` 这类当词条存进去，会让词表被噪声撑起来，
    // 还会让 findLeak 去追一些本来就会被替换掉的字面量。
    const structural = (start, end, label, kind, layer, term) => push(start, end, label, kind, layer, term);

    // ── 第零优先级：对齐层（词表不认识也能替换 —— 形态自己带着硬 ID）──────
    // ⓪ 形态 A：`@显示名[CQ:at,qq=ID]`。存档里这两种信息**同时存在**，
    //    名字是被 @ 的人的显示名，ID 是硬锚点。整段一起吃成一个占位符：
    //    留两个占位符是错的 —— 名字与 ID 本来就是同一个实体。
    eachMatch(/@([^@\[\]{}\n]{1,40}?)(\[CQ:at,qq=(\d+)\])/g, (m, s, e) => {
      const rawName = m[1];
      const name = rawName.trim();
      if (!name) return;
      const id = `qq:${m[3]}`;
      const known = this.resolveKnown(id);
      const kind = known?.kind || 'person';
      const label = known?.label || this._ephemeralLabel(kind, id, KIND_PREFIX[kind] || 'P');
      // 起点是**整段的开头**（含那个 `@`），不是名字的开头。
      // 以前从名字开始算，`@` 就留在了输出里（`@〔P5351〕`）：身份没漏，但形态闸门
      // 看到"@ 后面跟着东西"照样判泄漏 —— 2026-10-29 实测小号 8 条 / 主号 4 条卡在这。
      // `@` 本来就是这次提及的一部分，跟着名字一起吃掉才是完整的。
      const start = s;
      if (push(start, e, label, kind, known ? 'registry' : 'align', name)) {
        this._touch(name, label, kind, known ? 'registry' : 'align', register);
      }
    });
    // 已经登记过的短形态 `@名[CQ:at,qq=ID]` 由上面这条统一处理，
    // 单独的 `[CQ:at,qq=ID]`（前面没有名字）留给下面的 ①。

    // ⓪' 形态 B：`[引用 显示名(QQ:ID)：引文` —— 同样是"名字 + 硬 ID"。
    //     整段 `名字(QQ:ID)` 一起吃掉：占位符已经带了身份，
    //     把 `(QQ:〔P1〕)` 留在文本里只是噪声（而且 `QQ:` 这个字面量本身也没意义）。
    eachMatch(/\[\s*引用\s+([^\[\]：:\n]{1,40}?)\s*(\(QQ:\d+\))(\s*[：:])/g, (m, s) => {
      const name = m[1].trim();
      if (!name) return;
      const id = `qq:${/(\d+)/.exec(m[2])[1]}`;
      const known = this.resolveKnown(id);
      const kind = known?.kind || 'person';
      const label = known?.label || this._ephemeralLabel(kind, id, KIND_PREFIX[kind] || 'P');
      const start = s + m[0].indexOf(m[1]);
      // 起点是名字，终点是 `(QQ:ID)` 的右括号（把后面的 `：` 连同它的前导空白留在原地）
      const end = s + m[0].length - m[3].length;
      if (push(start, end, label, kind, known ? 'registry' : 'align', name)) {
        this._touch(name, label, kind, known ? 'registry' : 'align', register);
      }
    });

    // ── 第一优先级：结构性标识（它们含数字，必须先于数字层拿掉）──────────
    // ① @ 提及（CQ 码）—— 已登记（含别名）的是"查表命中"，没登记的走数字层逻辑。
    //    别名这一条是 2.1 的另一半修复：`[CQ:at,qq=<自己的号>]` 必须落成 `〔SELF〕`。
    eachMatch(/\[CQ:at,qq=(\d+)\]/g, (m, s, e) => {
      const ent = `qq:${m[1]}`;
      const known = this.resolveKnown(ent);
      structural(s, e,
        known?.label || this._ephemeralLabel('person', ent, 'P'),
        known?.kind || 'person',
        known ? 'registry' : 'digit', m[0]);
    });

    // ② 其他 CQ 码（图片/表情/语音…）—— 无语义，整段剥掉
    eachMatch(/\[CQ:[^\]]*\]/g, (m, s, e) => structural(s, e, 'MEDIA', 'other', 'strip', m[0]));

    // ②' 宿主拍平后残留的媒体标记（`[image]`/`[face]`/`[reply]`…）—— 同上
    //    ⚠️ 标记清单**单一来源**：`MEDIA_MARKER_LABELS` 导出给 `lib/extract.mjs` 的
    //    脚手架白名单复用（`ADR-0018` 决定 6）—— 在这里加一种标记，
    //    抽取侧的剥离白名单**自动跟上**，不再靠人记"两处都要改"。
    eachMatch(new RegExp(`\\[(?:${MEDIA_MARKER_LABELS})\\]`, 'gi'), (m, s, e) => structural(s, e, 'MEDIA', 'other', 'strip', m[0]));

    // ③ 引用锚点 `#N` —— N 是被引用消息的 localId，不是 QQ 号，必须单独认出来
    eachMatch(/#(\d+)/g, (m, s, e) => structural(s, e, 'R', 'other', 'strip', m[0]));

    // ④ 会话键 `group:123` / `private:456` —— 私聊键里的数字是**对方**的 QQ 号
    eachMatch(/\b(group|private):(\d+)/g, (m, s, e) => {
      const isGroup = m[1] === 'group';
      const ent = isGroup ? `group:${m[2]}` : `qq:${m[2]}`;
      const known = this.resolveKnown(ent);
      structural(s, e,
        known?.label || this._ephemeralLabel(isGroup ? 'group' : 'person', ent, isGroup ? 'G' : 'P'),
        known?.kind || (isGroup ? 'group' : 'person'),
        known ? 'registry' : 'digit', m[0]);
    });

    // ⑤ 日期 → 常量占位（日期是头部噪声：不带身份，也没有检索价值）
    eachMatch(/\d{4}-\d{2}-\d{2}/g, (m, s, e) => structural(s, e, 'D', 'other', 'strip', m[0]));

    // ⑥ 时刻 → 只保留小时。丢掉分钟（精确指纹），保留"几点"（时间语义）
    eachMatch(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g, (m, s, e) => {
      const hh = String(Number(m[1])).padStart(2, '0');
      structural(s, e, `T${hh}`, 'other', 'strip', m[0]);
    });

    // ── 第三优先级：词表 / 注册表 / 兜底层（长串优先）────────────────────
    // ⚠ **它必须排在规则层之前。** 这不是风格问题，是实测出来的一个错判：
    //   存档里有 `@小小石`，而规则 ⑨（`小` + 姓）会咬住其中的 `小石`，
    //   于是这次提及被记成一个**幻影实体**（`〔P4082〕`），而不是 `qq:100000001`。
    //   判据是"已知实体名（可枚举、带 ID）强于启发式姓氏形态（在猜）"，
    //   所以词表先占位，规则层只在**没被占的位置**上生效（`push` 会拒重叠）。
    for (const item of this._termList()) {
      const { term, kind, layer } = item;
      let from = 0;
      for (;;) {
        const i = src.indexOf(term, from);
        if (i < 0) break;
        from = i + 1;
        const j = i + term.length;
        if (term.length === 1 && !this._isWholeToken(src, i, j, term)) continue;
        if (!this._isBoundaryOk(src, i, j, term)) continue;
        const resolved = this._resolveTerm(term, kind);
        if (push(i, j, resolved.label, resolved.kind, layer, term)) {
          this._touch(term, resolved.label, resolved.kind, layer, register);
        }
      }
    }

    // ── 第四优先级：规则层（显式认得两种人名形态，只在词表没认出的地方生效）
    // ⑦ 引用块里的说话人名。形态 `[引用 #274 M.A.：[face]]` —— 只吃名字那一段。
    //    注意这里看的是**原文**：`#274` 在上一步只是被标记占用，src 本身没被改写。
    eachMatch(/\[\s*引用\s+#\d+\s*([^\s：:\[\]]{1,24})\s*[：:]/g, (m, s) => {
      const t = m[1];
      const nameStart = s + m[0].indexOf(t);
      this._pushTerm(t, nameStart, nameStart + t.length, push, 'rule', register);
    });

    // ⑦' 合并转发正文里的**说话人标签**（2026-10-09，`ROADMAP #6`）
    //    转发块被拍平成 `[合并转发 共4条] - 某名: 内容 - 某名: 内容`；`某名:` 是**别人的消息**
    //    的归属标签，与引用块的说话人名同族 —— 不是"这个人说的话"。
    //    它同时是一条**出境红线**：实测 502 块里有 1 块，昵称（如 `Persici的单糖`）
    //    只出现在转发块里 ⇒ 哪个层都登记不到它（不挨硬 ID、不是常见姓）⇒ 原样出境。
    //    这里只遮蔽**标签里的名字**，换成固定占位符 `〔SPEAKER〕`
    //    —— 占位符按结构被抽取侧剥掉（`extract.mjs` 的 `PLACEHOLDER_PATTERN`），
    //    所以"剥脚手架"这条纪律在抽取侧自动跟上，不用改第二处白名单。
    //    放在 ⑧/⑨ 之前：转发标签里的名字**不该**被当成"常见姓氏 + 称谓"而造出一个幻影实体。
    if (FORWARD_MARKER_RE.test(src)) {
      const markerAt = src.indexOf('[合并转发');
      for (const re of FORWARD_SPEAKER_RES) {
        eachMatch(re, (m, s) => {
          const name = m[1];
          if (!/[\p{L}]/u.test(name)) return;              // 至少一个字母（挡掉 `- 3: 0`）
          const nameStart = s + m[0].indexOf(name);
          if (nameStart < markerAt) return;                 // 只认转发块**之后**的部分
          structural(nameStart, nameStart + name.length, 'SPEAKER', 'other', 'strip', name);
        });
      }
    }

    // ⑧ 姓/名 + 称谓。两级判据：
    //    高置信 —— 首字是**词表里某个人的名字首字**（`沫老师` → `沫钤`，映射到同一个占位符）
    //    兜底   —— 首字是常见姓氏（`王姐`），拿不到实体就用临时占位符
    const stem = 称谓_SUFFIX;
    eachMatch(new RegExp(`([\\u4e00-\\u9fa5]{1,3})(${stem})`, 'g'), (m, s) => {
      const head = m[1][0];
      if (!this.nameHeads.has(head) && !COMMON_SURNAMES.has(head)) return;
      const owners = this.byNameHead.get(head) || [];
      if (owners.length === 1 && this.nameHeads.has(head)) {
        // 唯一候选 → 用那个人的稳定编号（`沫老师` 与 `沫钤` 同一个占位符）
        const e = owners[0];
        push(s, s + m[0].length, this.labelById.get(e.id) || 'SELF', e.kind, 'rule', m[0]);
      } else {
        this._pushTerm(m[0], s, s + m[0].length, push, 'rule', register);
      }
    });

    // ⑨ 老/小 + 姓（`老王` `小王`）。ADR-0003 的规则层里就有这一条形态。
    //    ⚠ 这条**误报率最高**（`石` 是常见姓，所以 `小小石` 里的 `小石` 会中招），
    //    所以它排在词表后面 —— 已知名字已经占过位，它只能啃剩下的。
    eachMatch(老小_PATTERN, (m, s) => {
      const surname = m[1];
      const owners = this.byNameHead.get(surname) || [];
      if (owners.length === 1) {
        const e = owners[0];
        push(s, s + m[0].length, this.labelById.get(e.id) || 'SELF', e.kind, 'rule', m[0]);
      } else {
        this._pushTerm(m[0], s, s + m[0].length, push, 'rule', register);
      }
    });

    // ── 第五优先级：数字层（QQ 号形态，零误报）────────────────────────────
    // 只是"占位符化"，**不进注册表** —— 群聊里 5~12 位数字大多是一次性 mid，
    // 全部登记会把注册表撑爆，而它们本来就由这条规则稳定处理。
    eachMatch(/(?<!\d)\d{5,12}(?!\d)/g, (m, s, e) => {
      const ent = `qq:${m[0]}`;
      const known = this.resolveKnown(ent);
      structural(s, e,
        known?.label || this._ephemeralLabel('person', ent, 'P'),
        known?.kind || 'person',
        known ? 'registry' : 'digit', m[0]);
    });

    // ── 第六优先级：残留的"裸 @提及"────────────────────────────────────────
    // 走到这里还留在文本里的 `@某某`，说明词表没认出这个名字（实测有 3 处）。
    // `@` 是**确定的提及标记**，所以不能让它带着名字出境 ——
    // 整段换成 `〔MENTION〕`：丢掉具体是谁，保留"这里提到了某人"的事实。
    //
    // 为什么必须放在最后：前面几层已经占用的位置会被 `push` 拒绝（重叠判定），
    // 所以只有"没被认出来"的那些才会落到这里。
    // ⚠ 这条**不是**身份判定，是兜底遮蔽 —— 它救不回"这说的是谁"，
    //   只能保证"这个名字不出境"。真正的修复在 vocab 的锚点挖掘。
    // 字符类排掉中文标点：`@人下指令「发张表情包」，…` 这种"@"当动词用的正文，
    // 以前会一路吃到下一个空格（把后面半句话也吞掉）。昵称里不会出现 `，。「」`。
    eachMatch(/@[^\s@\[\]{}\n，。！？；：、「」『』（）()《》〈〉“”‘’\u3000]{1,40}/g, (m, s, e) => {
      structural(s, e, 'MENTION', 'other', 'strip', m[0]);
    });

    // ⑥' 落单的 `@`：`仅@，` / `@〔P1〕` / `@爱吃〔P1769〕饭的` 这类 —— 遮蔽**这个符号**就够了。
    // 判据：**两边都是空白**才算分隔符（表头 `群〔G1〕 @ 〔D〕`），其余都当提及标记。
    // 为什么不必连后面的字一起吞：⑥ 已经试过整段遮蔽，但那段里常有被词表认出来的名字
    // （`@爱吃〔P1769〕饭的`），整段 span 与它们重叠 ⇒ `push` 整段拒绝 ⇒ 只留下这个 `@`。
    // 这个 `@` 才是形态闸门报的东西，遮蔽它最省事、也最不容易误伤正文。
    eachMatch(/@/g, (m, s, e) => {
      const blank = (ch) => ch === undefined || /\s/.test(ch);
      if (blank(src[s - 1]) && blank(src[s + 1])) return;
      structural(s, e, 'MENTION', 'other', 'strip', '@');
    });

    // ── 重建文本 ─────────────────────────────────────────────────────────
    hits.sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const h of hits) {
      out += src.slice(cursor, h.start);
      out += render(h.label);
      cursor = h.end;
    }
    out += src.slice(cursor);

    // ── 剥脚手架：合并转发标记（2026-10-09 拍板，见 FORWARD_MARKER_STRIP_RE 注释）──
    // 只删标记本体；说话人标签已由 ⑦' 遮成 `〔SPEAKER〕`（占位符按结构被抽取侧剥）。
    let forwardMarkers = 0;
    out = out.replace(FORWARD_MARKER_STRIP_RE, (m) => { forwardMarkers++; return ' '; });

    const byLayer = {};
    const byKind = {};
    const byLayerIdentity = {};
    let identity = 0;
    for (const h of hits) {
      byLayer[h.layer] = (byLayer[h.layer] || 0) + 1;
      byKind[h.kind] = (byKind[h.kind] || 0) + 1;
      // "身份"= 换成了人/群/自己的占位符；其余（MEDIA/R/D/T）是**剥掉的语篇标记**。
      // 这两类必须分开数 —— 混在一起就会重演 2.2 那次"328 与 497 对不上"的口径事故。
      const isIdentity = (h.kind === 'person' || h.kind === 'group' || h.kind === 'self');
      if (isIdentity) {
        identity++;
        byLayerIdentity[h.layer] = (byLayerIdentity[h.layer] || 0) + 1;
      }
    }
    const result = {
      text: out,
      hits,
      stats: {
        input: src.length,
        output: out.length,
        // ① 总替换点 = 各层之和。报"替换了多少处"时用这个。
        hits: hits.length,
        // ② 身份替换点 = 人/群/自己。报"多少处实体被占位符化"时用这个。
        identity,
        // ③ 剥离点 = CQ 码 / 日期 / 时刻 / `#N` 引用锚点。无语义，纯去标识。
        structural: hits.length - identity,
        // ③' 脚手架剥离 = 合并转发标记（不在 span 层，故不进 hits —— 单独计数）。
        forwardMarkers,
        byLayer,
        byLayerIdentity,
        byKind,
        // 兼容旧字段名。**注意口径变了**：旧版不含 `self`，现在含（`我` → `〔SELF〕`）。
        entities: identity,
        // 自检判据规模（进轮快照）：排障时"本轮自检拿多少词条扫的"要看得见，
        // 否则"为什么这轮没报泄漏"只能靠猜。
        termsAtEntry: termsAtEntry.length
      },
      clean: true
    };
    // 出口自检：写出去的东西里不许还留着**进轮时已知**的实体串（硬约束，不是建议）。
    // ⚠️ 判据用 `termsAtEntry`，不是"当前词表" —— 理由见本轮开头（自证不许用本轮产物）。
    const leak = this.findLeakIn(result.text, termsAtEntry);
    if (leak) {
      result.clean = false;
      result.leak = leak;
      throw new NormalizerError(
        'NORMALIZE_LEAK',
        `归一化输出里仍含原始实体串「${leak.term}」—— 拒绝放行（漏报的代价是名字出境，不可撤回）`,
        { term: leak.term, layer: leak.layer, source: opts.context || '' }
      );
    }
    this.lastNormalize = { at: Date.now(), stats: result.stats };
    return result;
  }

  /** 只归一化、不要报告。查询侧与文档侧走的是**同一个函数**。 */
  normalizeText(text, opts) {
    return this.normalize(text, opts).text;
  }

  /**
   * 出口自检：这段文本里还有没有已知实体串？
   * 这是本模块**独立于网络**的那条断言 —— 比任何单元测试都直接。
   * ⚠️ 用的是**当前**词表。进轮自检请走 `findLeakIn(text, 进轮快照)` —— 见 `normalize()` 开头。
   * @returns {null | {term:string, layer:string}}
   */
  findLeak(text) {
    return this.findLeakIn(text, this._termList());
  }

  /**
   * 出口自检的实体（**给定词条表**，纯函数）。
   *
   * 为什么把"用哪张词表"提成参数（ROADMAP #4）：自证不能拿本轮产物当判据
   * （`normalize()` 内的规则层会扩充词表）。同时**必须是纯的** ——
   * 检查动作本身不许改注册表、不许分配占位符编号，否则"自检"会改变它正在自检的那份状态。
   * @param {string} text
   * @param {{term:string, layer:string}[]} terms 词条表（调用方决定快照口径）
   * @returns {null | {term:string, layer:string}}
   */
  findLeakIn(text, terms) {
    const raw = String(text ?? '');
    // 先把占位符本身遮掉：万一某个实体名恰好长得像占位符（昵称叫 `P1`），
    // 不遮的话会把 `〔P1〕` 自己当成泄漏报出来。
    const hay = raw.replace(PLACEHOLDER_RE_G, (m) => '\u0000'.repeat(m.length));
    for (const item of terms || []) {
      const { term, layer } = item;
      if (term.length < 2) continue;
      // 低权重词条不单独构成泄漏（用户口径 2026-10-29，理由见 WEAK_TERM_RE 上方）。
      // 判据直接由 term 现算，不依赖调用方传进来的 `weak` 字段 ——
      // 自检入口有好几个（`assertClean` / `assertNormalized` / 关键词过滤），
      // 漏传一个字段就变成"这里判罪、那里不判"的静默分叉。
      // 注意它只是"不判罪"：替换层照常认它，`@16` 这类**形态**也照样由形态闸门拦。
      if (isWeakTerm(term)) continue;
      const i = hay.indexOf(term);
      if (i >= 0 && this._isBoundaryOk(hay, i, i + term.length, term)) return { term, layer };
    }
    return null;
  }

  /** 泄漏即抛。给调用方一个"不用记得检查"的入口。 */
  assertClean(text) {
    const leak = this.findLeak(text);
    if (leak) {
      throw new NormalizerError('NORMALIZE_LEAK', `文本里仍有实体串「${leak.term}」（层：${leak.layer}）`, leak);
    }
    return true;
  }

  /**
   * **形态闸门**：文本里还有没有"长得像实体引用"的残留？
   *
   * 为什么要有第二条闸门：`findLeak` 只能拦**词表里已有的串**。
   * 词表漏一个实体（实测：机器人自己的 `Single Samara`），它就完全看不见 ——
   * 这是 2.1 那处漏替暴露出的**结构性盲区**，不是规则写错。
   *
   * 这条判据不依赖词表，只看**形态**：引用/提及的语法结构自己就是证据。
   * 只要还留着"名字 紧挨着 硬 ID"或"@后人名没被替换"，就说明有实体没认出来。
   *
   * @returns {null | {kind:string, sample:string}}
   */
  findEntityForm(text) {
    const s = String(text ?? '');
    if (!s) return null;
    // 先把已经替换掉的占位符遮住，免得 `〔P123〕` 里的内容干扰
    const hay = s.replace(PLACEHOLDER_RE_G, (m) => '\u0000'.repeat(m.length));
    const FORMS = [
      // 形态 A：`@名[CQ:at,qq=ID]` 没被整段吃掉 → 名字还在
      ['at-with-id', /@([^@\[\]{}\n\u0000]{1,40}?)\[CQ:at,qq=\d+\]/],
      // 形态 B：`[引用 名(QQ:ID)：` → 名字还在
      ['quote-with-id', /\[\s*引用\s+([^\[\]：:\n\u0000]{1,40}?)\s*\(QQ:\d+\)\s*[：:]/],
      // 形态 C：`[引用 #n 名：` → 名字还在
      ['quote-with-ref', /\[\s*引用\s+#\d+\s+([^\[\]：:\n\u0000]{1,40}?)\s*[：:]/],
      // 形态 D：光秃秃的 `(QQ:数字)` —— 任何形态下都不该出现在出境文本里
      ['bare-qq-tag', /\(QQ:\d{5,12}\)/],
      // 形态 E：`@` 后面跟了名字，但后面**没有** CQ 码（纯文本 @）
      ['bare-mention', /@([^\s@\[\]{}\n\u0000〔〕]{1,40})/]
    ];
    for (const [kind, re] of FORMS) {
      const m = re.exec(hay);
      if (m) return { kind, sample: m[0].slice(0, 60) };
    }
    return null;
  }

  /** 形态闸门即抛（出境前的最后一道）。 */
  assertNoEntityForm(text) {
    const hit = this.findEntityForm(text);
    if (hit) {
      throw new NormalizerError(
        'NORMALIZE_SHAPE_LEAK',
        `出境文本里残留实体引用形态（${hit.kind}：${hit.sample}）—— 说明有实体没被认出来，拒绝放行`,
        hit
      );
    }
    return true;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  _pushTerm(term, start, end, push, layer, register) {
    const resolved = this._resolveTerm(term);
    if (push(start, end, resolved.label, resolved.kind, layer, term)) {
      this._touch(term, resolved.label, resolved.kind, layer, register);
      return true;
    }
    return false;
  }

  /** 已知实体 → 用它的稳定编号；未知 → 派生一个临时编号并登记。 */
  _resolveTerm(term, kindHint) {
    const owner = this.surfaceIndex.get(term);
    if (owner) {
      return { label: this.labelById.get(owner) || 'SELF', kind: this.kindOf(owner), known: true };
    }
    const reg = this.registry.get(term);
    if (reg?.label) return { label: reg.label, kind: reg.kind || kindHint || 'person', known: true };
    const kind = kindHint || 'person';
    return { label: this._ephemeralLabel(kind, term, KIND_PREFIX[kind] || 'X'), kind, known: false };
  }

  /**
   * 临时占位符：这个词不在词表里，但已经确认它是实体，需要给它一个**跨重建稳定**的编号。
   * 落在 `ephemeral` 里，随映射表一起本机落盘 —— 否则每次重建编号都会变，
   * 同一个人的向量就会分裂到不同空间（ADR-0002 说的"编号漂移"）。
   */
  _ephemeralLabel(kind, key, prefix) {
    const k = `${kind}\u0000${key}`;
    const hit = this.ephemeral.get(k);
    if (hit) return hit.label;
    const label = kind === 'self' ? 'SELF' : `${prefix}${(hmac32(this.secret, `ephemeral\u0000${k}`) % LABEL_SPACE) + 1}`;
    this.ephemeral.set(k, { label, kind });
    this._termCache = null;
    return label;
  }

  /**
   * 命中登记。**纪律：`hitCount` 只决定"是否永久写进注册表"，不决定"是否替换"。**
   * 低 hitCount 的命中照样替换（不漏优先），只是同时进待审池。
   */
  _touch(term, label, kind, layer, register = true) {
    if (!register) return;
    // ⚠️ 纯标点/无字母数字的串**永不登记**（2026-10-09 实测教训，与 vocab.mjs 的 touch 同守卫）：
    //    有群友昵称就叫 `...`。它被兜底层登记进注册表 ⇒ 任何含省略号的正文都触发
    //    NORMALIZE_LEAK（findLeak 认得它），而替换层的边界判定又换不掉它 ⇒ 索引死锁。
    //    遮蔽照常（span 层不经过这里），只是"..."不配当"实体名"留在词表里。
    if (!/[\p{L}\p{N}]/u.test(String(term))) return;
    const now = Date.now();
    const prev = this.registry.get(term);
    if (prev) {
      prev.hitCount += 1;
      prev.lastSeen = now;
      prev.label = prev.label || label;
      return;
    }
    this.registry.set(term, { hitCount: 1, layer, label, kind, firstSeen: now, lastSeen: now });
    if (term.length >= 2) {
      const p = this.pending.get(term);
      if (p) { p.count += 1; } else {
        this.pending.set(term, { layer, count: 1, firstSeen: now, reason: '首次命中，待人工确认是否长期保留' });
      }
    }
    this._termCache = null;
  }

  /** 打补丁式调整：人工确认后把某串提升为永久注册（写进注册表并移出待审池）。 */
  confirm(term) {
    const t = String(term);
    const p = this.pending.get(t);
    const r = this.registry.get(t);
    if (r) r.hitCount = Math.max(r.hitCount, 5);
    this.pending.delete(t);
    return { term: t, confirmed: Boolean(r), wasPending: Boolean(p) };
  }

  /** 走一遍匹配用的项表（长串优先 + 词表 > 注册表 > 兜底）。缓存到下一次变更。 */
  _termList() {
    if (this._termCache) return this._termCache;
    const seen = new Set();
    const out = [];
    const add = (term, kind, layer) => {
      const t = String(term);
      if (!t || seen.has(t)) return;
      seen.add(t);
      // `weak` 只影响排序与判罪（见 WEAK_TERM_RE），不影响"能不能替换" ——
      // 低权重不等于不认，只是排在后面、且不拿它否决整块文本。
      out.push({ term: t, kind, layer, weak: isWeakTerm(t) ? 1 : 0 });
    };
    for (const e of this.entities.values()) {
      for (const s of e.surface) add(s, e.kind, 'registry');
    }
    for (const [term, v] of this.registry) add(term, v.kind || 'person', v.layer || 'registry');
    for (const term of this.suspects) add(term, 'person', 'heuristic');
    // ephemeral 里存的是 `kind\0key`；只有**字面出现在文本里**的 key 才值得当词条
    // （`person\0沫老师` 是；`person\0qq:123` 不是 —— 它由数字层负责）。
    for (const [key, v] of this.ephemeral) {
      const term = key.split('\u0000').slice(1).join('\u0000');
      if (!term || /^(?:qq|group|private):/.test(term)) continue;
      // 纯标点（如昵称 `...`）不进判据 —— 理由同 `_touch` 的守卫（2026-10-09 实测教训）。
      if (!/[\p{L}\p{N}]/u.test(term)) continue;
      add(term, v.kind, 'heuristic');
    }
    // 长串优先：`沫钤老师` 必须先于 `沫钤` 被吃掉。
    // 低权重词条（≤3 位字母数字）**整组排最后** —— 它们最容易被别的东西包含
    // （`16` ⊂ `16g`、`11` ⊂ 一串 QQ 号），让强词条先占位才不会被它们把词切开。
    out.sort((a, b) => (a.weak - b.weak)
      || (b.term.length - a.term.length)
      || (a.term < b.term ? -1 : 1));
    this._termCache = out;
    return out;
  }

  /**
   * 单字词只在"整词"位置命中。否则一个叫「！」的群友会把全篇感叹号都替掉。
   * 这是 1 字昵称防漏报与可读性之间唯一的让步。
   *
   * 而且分两种情况：**含文字/数字**的短词（`王`）认中文标点为边界；
   * **纯标点**的昵称（`！`、`~`）只认空白边界 —— 它对身份没有价值，
   * 但放任它匹配会毁掉整段文本。这条限制写在这里，不藏。
   */
  _isWholeToken(src, start, end, term) {
    const wordish = /[\p{L}\p{N}]/u.test(term);
    const bound = wordish
      ? (ch) => ch === undefined || /[\s,，。！？、：:；;（）()\[\]【】《》@#]/.test(ch)
      : (ch) => ch === undefined || /\s/.test(ch);
    return bound(src[start - 1]) && bound(src[end]);
  }

  /**
   * 边界判定。中文没有词边界，所以**默认允许内嵌**（不漏优先）；
   * 只拦两种明显的情况：
   *
   * ① `term` 含非 ASCII ⇒ 一贴 ASCII 字母/数字就是"嵌在更大的 ASCII 词里"，不动。
   * ② `term` 是**纯字母 ASCII**（`qwe` / `samara`）⇒ 它是个"英文词"，必须**整词匹配**。
   *    英文本来就靠空白/标点分词，`qwe` 出现在 `qwen` 里不是"提到 qwe"。
   *
   * ② 是**实测加的**（502 块 / 122 个纯字母 surface）：不整词匹配会替掉 30 处**别的词** ——
   * `qwen`→`qwe`、`sessions`→`sion`、`wowowo`→`owo`、`NekoboshiYuki_Style`→`Yuki`。
   * 那 30 处没有一处是"那个人被提到"，所以收紧**不新增漏报**，只是停止损坏内容。
   *
   * 注意与 ② 的分界：`qq:123` / `abc_1` 这类**带结构字符**的 term 不受 ② 约束 ——
   * 它们在原文里本来就嵌在 CQ 码、括号里出现。
   */
  _isBoundaryOk(src, start, end, term) {
    const prev = src[start - 1];
    const next = src[end];
    const isAscii = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
    if (isAscii(prev) || isAscii(next)) {
      // 只有**本身是纯 ASCII** 的 term 才可能"嵌在更大的 ASCII 词里"。
      // 含汉字的 term 挨着拉丁字母/数字**不是同一个词**（`deepseek鲸鱼娘`、`8+16随便跑`），
      // 以前这里对含汉字的 term 也返回 false ⇒ 那两处都没被替换 ⇒ 出口自检判泄漏 ⇒
      // 整块记忆进不了库（2026-10-29 盘点：`鲸鱼娘`/`随便`/`肥鱼`/`主人` 共 9 条）。
      // 判据按"这个词自己是什么"来分，不按"旁边有什么"一刀切。
      if (!/^[\x20-\x7e]+$/.test(term)) return true;
      // **纯 ASCII 字母数字：一律要求整词**（两侧都不是 ASCII 词字符）。
      // ⚠️ 这里以前只对"纯字母"要求整词，纯数字可以嵌在数字/字母里 —— 实测后果很重：
      //    注册表里被登记了 `11` / `16` / `2` 这类碎片，于是 `@100000001` 被从中间切开
      //    （`@2〔P8244〕5358013`），数字层再也认不出完整 QQ 号 ⇒ 形态闸门判它泄漏 ⇒
      //    整块记忆永久进不了库（2026-10-29 盘点：小号 79/92 条被拒是这个原因）。
      //    判据本来就该对称：数字和字母一样，只有"独立成词"才算它出现了。
      if (/^[A-Za-z0-9]+$/.test(term)) return false;
    }
    return true;
  }

  /**
   * 已知实体串的**字面形态**（词表 + 注册表 + 疑似池 + 临时占位符里含文字的 key）。
   * 给关键词过滤与离线审计用（`ROADMAP #5`）：判"这个词是不是某个实体名的碎片"。
   * 只读，不改状态。
   */
  knownSurfaces() {
    return this._termList().map((item) => item.term);
  }

  stats() {
    return {
      secretSet: Boolean(this.secret),
      dir: this.dir,
      entities: this.entities.size,
      labels: this.labelById.size,
      aliases: this.aliasById ? this.aliasById.size : 0,
      surfaces: this.surfaceIndex.size,
      registry: this.registry.size,
      pending: this.pending.size,
      suspects: this.suspects.size,
      ephemeral: this.ephemeral.size,
      ambiguous: (this.ambiguous || []).slice(0, 20),
      lastNormalize: this.lastNormalize
    };
  }
}

// ── 共享实例（纪律：全场只有一个）──────────────────────────────────────────

let shared = null;

/**
 * 取全场唯一的归一化器。
 *
 * 索引侧与查询侧**必须**引用它返回的同一个对象 —— ADR-0003：
 * 「不是同一套代码，是同一个实例」。第二次用**不同的 dir** 调用会直接抛错，
 * 因为那意味着你正在制造第二个注册表。
 */
export function getSharedNormalizer(opts = {}) {
  if (shared) {
    if (opts.dir && shared.dir && path.resolve(opts.dir) !== shared.dir) {
      throw new NormalizerError(
        'NORMALIZER_SINGLETON',
        `归一化器已经建立在 ${shared.dir}，不能再建一个在 ${opts.dir} —— ` +
          '两个实例会各自加载注册表，两侧不一致时不会报错，只会慢慢变得不对。',
        { existing: shared.dir, requested: path.resolve(opts.dir) }
      );
    }
    return shared;
  }
  shared = new Normalizer(opts);
  return shared;
}

/** 测试与热重载用：丢弃共享实例（生产代码不该调）。 */
export function resetSharedNormalizer() {
  shared = null;
}

// ── 本机小工具 ───────────────────────────────────────────────────────────

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  if (!file) return fallback;
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}
