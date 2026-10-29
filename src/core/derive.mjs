// 派生块：把宿主的**原始消息**补成小时块，接上老树停更的那一节。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────
// 本库的语料源只有一个：`<sourceRoot>/memory-v2/chunks/hour_*.json`（ADR-0025:184）。
// 那份块由老宿主 `src/conversation-memory/` 产出；新宿主 `refactor/` **不产**它
// （实测：`refactor/` 全仓对 `memory-v2` 只有 3 处注释，零读写）。
// 于是 2026-10-17 22 点之后索引就不再有新语料 —— 不是配置错，是上游断了。
//
// 补法有两条：让宿主恢复写出器（侵入宿主，且与 ADR-0036 冲突），或在**本库内部**
// 从宿主已有的存档派生。后者不改宿主一行、不新增数据契约，所以选它。
//
// ── 数据从哪来（全部是宿主已经在写的，只读）──────────────────────────────
//   `<dataDir>/messages/<chatKey>.json`        热消息，单会话一个文件
//   `<dataDir>/messages-cold/<chatKey>.<seq>.json`  冷分片，每片 5000 条
// 两份合起来实测 248,007 条 / 10 会话 / 2026-09-15 22:41 → 2026-10-18 01:33，
// 小时桶 836 个 —— 与老树的 828 个块几乎一一对应。这说明老块的粒度就是"每小时一块"，
// ADR-0005 说的 11.4% 是**块内对消息的抽样**，不是块本身的抽样。
//
// ── 三条纪律 ─────────────────────────────────────────────────────────────
// ① **只补缺失的桶，绝不覆盖已有块。** 老块是宿主原生产物（带 keywords、
//    consolidatedAt、snippets 权重），派生块是可替代品。反过来盖 = 用二手货
//    替换原件，且不可逆。判据是 id 存在与否。
// ② **id 与老块同构**（`hour_<chatRaw>_<YYYY-MM-DD><HH>`），这样 `parseChunkFileName`、
//    检索去重、面板展示全都不用改 —— 加新 id 前缀会让"同一小时两份内容"同时进库。
// ③ **桶内必须抽样。** 实测中位 232 条/小时、峰值 1531 条；全拼会撞 `maxChars=1200`
//    的出境预算，被截断的永远是尾部 —— 也就是最近的消息，正好最该被记住。
//
// ── 这里只做纯计算 ───────────────────────────────────────────────────────
// 不读盘、不看配置、不取当前时间（全部由调用方传入），所以能被单测直接喂数据。

/** 一小时 = 3600000ms。派生粒度固定为小时，与老块一致。 */
const HOUR_MS = 3600_000;
/** 时区：宿主所有时间戳都是"北京时间语义"，块名也按北京切。 */
const TZ_OFFSET_MS = 8 * HOUR_MS;

/**
 * 实测 senderName 里混进过 `\u0012\t哈气了\n\u0005\n\u0003喵\u0010\u0000` 这种整串控制字符。
 *
 * 分两类处理，不能一把梭：
 *   · **换行/制表/行分隔符 → 空格**。它们是词边界，直接删会把 `哈气了\n喵` 粘成
 *     `哈气了喵`（自测第一版就是这么挂的），在检索里变成一个不存在的词。
 *   · **其余控制字符（\u0000-\u0008 等）→ 直接删**。它们不是词边界，留下来只会污染向量。
 *   · 零宽字符（\u200b-\u200f、\ufeff）也删 —— 它们在渲染上不可见，在分词里是噪声。
 */
const LINE_BREAK_RE = /[\t\n\r\u2028\u2029]/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\ufeff]/g;

/** 纯表情/纯标点的消息对语义检索没有贡献，但也不能全丢（表情本身是回应）。 */
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?，。！？、；：""''（）【】…—]+$/u;

/** 单条消息在摘要里的字符上限。刷屏长文一条就能吃光整桶预算，必须压。 */
const PER_MSG_CHARS = 120;

/** 媒体占位：老块的 summary 里就是 `[图片:xxx 1/1]` 这种形态，跟着来。 */
const MEDIA_LABEL = {
  image: '图片', pic: '图片', voice: '语音', video: '视频',
  face: '表情', mface: '表情', file: '文件', record: '语音'
};

/** 把 `group:123` / `private:456` 还原成老块文件名里的 `group_123` / `private_456`。 */
export function chatRawOf(chatKey) {
  const s = String(chatKey || '').trim();
  if (!s) return '';
  return s.replace(/^group:/, 'group_').replace(/^private:/, 'private_').replace(/:/g, '_');
}

/** `parseChunkFileName` 的反函数：决定派生块的 id，必须与老块同构（纪律②）。 */
export function chunkIdOf(chatKey, dayKey, hour) {
  const raw = chatRawOf(chatKey);
  if (!raw) return '';
  return `hour_${raw}_${dayKey}${String(hour).padStart(2, '0')}`;
}

/** 时间戳 → 北京时间的 {dayKey:'2026-10-18', hour:1, hourKey:'2026-10-18 01'}。 */
export function hourPartsOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const iso = new Date(n + TZ_OFFSET_MS).toISOString();
  const dayKey = iso.slice(0, 10);
  const hour = Number(iso.slice(11, 13));
  return { dayKey, hour, hourKey: `${dayKey} ${String(hour).padStart(2, '0')}` };
}

/** 时段词。与老块一致（实测 17 点 → "下午"）。 */
export function timeOfDayOf(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return '';
  if (h <= 5) return '深夜';
  if (h <= 8) return '早上';
  if (h <= 11) return '上午';
  if (h <= 13) return '中午';
  if (h <= 17) return '下午';
  if (h <= 19) return '傍晚';
  return '晚上';
}

/** 清掉控制字符、压空白。不做实体归一化 —— 那是 `normalize.mjs` 的活，这里不能抢。 */
export function cleanText(v) {
  return String(v ?? '')
    .replace(LINE_BREAK_RE, ' ')
    .replace(CTRL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 昵称清洗。实测有整串控制字符的脏值；空了就退 QQ 号，别让摘要里出现空白发言人。 */
export function cleanSenderName(name, senderId) {
  const n = cleanText(name);
  if (n) return n;
  const id = cleanText(senderId);
  return id || '某人';
}

/** 一条消息 → 摘要里的一行。媒体消息没有 text，用占位符保住"这里发生过什么"。 */
export function messageLine(msg) {
  const who = msg?.self ? '我' : cleanSenderName(msg?.senderName, msg?.senderId);
  let text = cleanText(msg?.text);
  if (!text) {
    const media = Array.isArray(msg?.media) ? msg.media : [];
    if (media.length) {
      const kind = String(media[0]?.type || media[0]?.kind || 'image').toLowerCase();
      text = `[${MEDIA_LABEL[kind] || '媒体'}]`;
    } else {
      return '';
    }
  }
  if (text.length > PER_MSG_CHARS) text = `${text.slice(0, PER_MSG_CHARS)}…`;
  return `${who}: ${text}`;
}

/**
 * 桶内抽样：把 ns 条压成"覆盖全程、信息量高"的若干行。
 *
 * 为什么不是"取最长的 N 条"：那会把整小时的样本压在同一段刷屏里，
 * 前半夜谁说了什么全丢。所以先**按时间切段**保证覆盖面，再在每段里挑一条。
 *
 * @param {Array} msgs       同一 (chatKey, hour) 的消息，未排序也可
 * @param {number} maxPicks  最多挑几条
 * @returns {string[]}       按时间顺序的摘要行
 */
export function pickRepresentative(msgs, maxPicks = 60) {
  const rows = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const ts = Number(m?.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;       // 没有时间戳就无法归桶，丢掉而不是猜
    const line = messageLine(m);
    if (!line) continue;
    rows.push({ ts, line, len: line.length });
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (!rows.length) return [];

  const picks = Math.max(1, Math.min(Number(maxPicks) || 60, rows.length));
  if (rows.length <= picks) return rows.map((r) => r.line);

  // 时间均匀切段；段内取最长那条（长度是"说了实质内容"的粗代理，比随机稳）
  const out = [];
  const segSize = rows.length / picks;
  for (let i = 0; i < picks; i++) {
    const from = Math.floor(i * segSize);
    const to = Math.max(from + 1, Math.floor((i + 1) * segSize));
    let best = rows[from];
    for (let j = from + 1; j < to && j < rows.length; j++) {
      if (rows[j].len > best.len) best = rows[j];
    }
    // 纯表情行不进摘要，除非这一段全是表情
    if (!EMOJI_ONLY_RE.test(best.line)) out.push(best.line);
    else if (i === 0 || i === picks - 1) out.push(best.line);
  }
  return out;
}

/** 把挑好的行拼成 summary，按字符预算收敛（超预算就**跳过**长行继续试短行，而不是直接截断）。 */
export function joinWithinBudget(lines, budgetChars = 900) {
  const budget = Math.max(120, Number(budgetChars) || 900);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const add = (kept.length ? 3 : 0) + line.length;      // ' | ' 三个字符
    if (used + add > budget) continue;
    kept.push(line);
    used += add;
  }
  // 预算小到一条都放不下时，至少留第一条的前半段 —— 空 summary 等于这个小时不存在
  if (!kept.length && lines.length) {
    kept.push(lines[0].slice(0, budget));
  }
  return kept.join(' | ');
}

/**
 * 从宿主存档派生"缺失的"小时块。
 *
 * @param {object} opts
 * @param {Array<{chatKey:string, messages:Array}>} opts.sources   宿主存档（热+冷已合并）
 * @param {Set<string>} opts.existingIds                           已存在的老块 id
 * @param {number} [opts.budgetChars=900]                          单块 summary 预算（**归一化前**）
 * @param {number} [opts.maxPicks=60]                              单桶最多挑几条
 * @returns {{chunks:Array, stats:object}}
 */
export function deriveChunks(opts = {}) {
  const sources = Array.isArray(opts.sources) ? opts.sources : [];
  const existingIds = opts.existingIds instanceof Set ? opts.existingIds : new Set();
  const budgetChars = Math.max(120, Number(opts.budgetChars) || 900);
  const maxPicks = Math.max(1, Number(opts.maxPicks) || 60);

  const stats = { buckets: 0, generated: 0, skippedExisting: 0, skippedEmpty: 0, messages: 0 };
  /** @type {Map<string, Array>} key = `${chatKey}|${hourKey}` */
  const buckets = new Map();

  for (const src of sources) {
    const chatKey = cleanText(src?.chatKey);
    if (!chatKey) continue;
    for (const msg of Array.isArray(src?.messages) ? src.messages : []) {
      const parts = hourPartsOf(msg?.ts);
      if (!parts) continue;
      stats.messages++;
      const key = `${chatKey}|${parts.hourKey}`;
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push(msg);
    }
  }
  stats.buckets = buckets.size;

  const chunks = [];
  for (const [key, msgs] of buckets) {
    const sep = key.lastIndexOf('|');
    const chatKey = key.slice(0, sep);
    const hourKey = key.slice(sep + 1);
    const parts = hourPartsOf(Number(msgs[0]?.ts));
    if (!parts) continue;
    const id = chunkIdOf(chatKey, parts.dayKey, parts.hour);

    // 纪律①：老块在就跳过。判据只看 id，不看内容 —— 内容比较会引入"哪个更全"的判断，
    // 而派生块永远不可能比原件更权威。
    if (existingIds.has(id)) { stats.skippedExisting++; continue; }

    const lines = pickRepresentative(msgs, maxPicks);
    const summary = joinWithinBudget(lines, budgetChars);
    if (!summary) { stats.skippedEmpty++; continue; }

    const firstTs = msgs.reduce((min, m) => {
      const t = Number(m?.ts) || 0;
      return t && (!min || t < min) ? t : min;
    }, 0);

    chunks.push({
      id,
      kind: 'hour',
      chatKey,
      dayKey: parts.dayKey,
      hourKey,
      timeOfDay: timeOfDayOf(parts.hour),
      when: firstTs || Number(msgs[0]?.ts) || 0,
      title: `${chatKey} @ ${parts.dayKey} ${String(parts.hour).padStart(2, '0')}:00`,
      summary,
      // keywords 留空是**故意**的：库侧默认 `keywordsSource='filtered'`，
      // 会跳过块内关键词、改用归一化后重新生成（chunkread.mjs 的 buildKeywordLine）。
      // 这里塞一份未归一化的词反而会被忽略 —— 而且会让人误以为它生效了。
      keywords: [],
      snippets: lines.slice(0, 8).map((line) => {
        const at = line.indexOf(': ');
        return { who: at > 0 ? line.slice(0, at) : '', text: at > 0 ? line.slice(at + 2) : line };
      }),
      msgCount: msgs.length,
      pickedCount: lines.length,
      consolidatedAt: 0,
      derived: { from: 'host-messages', version: 1 }
    });
    stats.generated++;
  }

  // 新的在前，与 `listChunks` 的排序口径一致（id 字典序倒序）
  chunks.sort((a, b) => (a.id < b.id ? 1 : -1));
  return { chunks, stats };
}

/** 拼冷热消息文件：同一个 chatKey 的多个分片合并成一个 source（分片内部按 ts 去重）。 */
export function mergeSources(parts = []) {
  /** @type {Map<string, {chatKey:string, messages:Array, seen:Set}>} */
  const byChat = new Map();
  for (const part of parts) {
    const chatKey = cleanText(part?.chatKey);
    if (!chatKey) continue;
    let slot = byChat.get(chatKey);
    if (!slot) { slot = { chatKey, messages: [], seen: new Set() }; byChat.set(chatKey, slot); }
    for (const msg of Array.isArray(part?.messages) ? part.messages : []) {
      // 冷分片与热文件会有重叠段（滚动归档），按 mid/localId/ts 三元组去重
      const sig = `${msg?.mid ?? ''}|${msg?.localId ?? ''}|${msg?.ts ?? ''}`;
      if (sig !== '||' && slot.seen.has(sig)) continue;
      if (sig !== '||') slot.seen.add(sig);
      slot.messages.push(msg);
    }
  }
  return [...byChat.values()].map(({ chatKey, messages }) => ({ chatKey, messages }));
}
