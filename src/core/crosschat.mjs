/**
 * 跨会话近况（`cross-chat recent`）—— 把**别的会话**最近几分钟的原话摘出来，
 * 供当前会话的提示词使用。
 *
 * ── 为什么需要它（2026-10-19 用户裁定）─────────────────────────────────────
 * 宿主把短期历史按 `chatKey` **物理隔离**（`compose.js:1009 readPastChatRows({chatKey})`
 * + `:1366 sameChatRows`）：群里说的话，私聊的提示词里**一行都没有**。
 * 用户在群里说完话转头私聊，她的回答等于失忆。
 *
 * 宿主本来有 `api.architecture.crossChatAwareness` 这一组键，但**没有任何消费方** ——
 * 唯一实现是旧插件 `plugins/conversation-memory/lib/arch.js`，该插件 2026-10-18 已移除。
 * 也就是说那几个键在新树里是**死键**：打开不生效、也不报错。本模块是它的替代实现，
 * 挂在 memory-vec 的读侧（零宿改）。
 *
 * ── 三条纪律（按重要程度）────────────────────────────────────────────────
 *  ① **只读**。只 `stat` + 读 `<dataRoot>/messages/*.json`，绝不写、绝不改宿主存档。
 *  ② **方向单向**。私聊内容默认**永不**进群（`includePrivate=false`）——
 *     这是 2026-09-23 的裁定：改造前 4.0%（101/2500）的私聊提示词带着别群话题，
 *     机器人会在群里顺口说出私聊里的事。脚本这里用**两道闸**，不是一道：
 *       · 来源侧 `includePrivate` 决定私聊能不能当来源；
 *       · 目标侧由调用方决定私聊要不要收（`crossChatInPrivate`）。
 *  ③ **失败方向是"没有"，不是"乱给"**。窗口内没有消息、文件读不动、解析失败 ⇒
 *     返回空 + 一个 `reason`，让调用方能回报"为什么空"，而不是静默返回一段空气。
 *
 * ── 性能 ──────────────────────────────────────────────────────────────────
 * 群存档动辄 1.5MB / 3500 行，每轮注入都全量 `JSON.parse` 会拖慢主链。
 * 这里按 `(mtimeMs,size)` 做进程内缓存：文件没变就直接用上次解析的 rows。
 * 群再热闹，每轮最多重解析"刚变过的那一两个文件"。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单条原话的硬上限（字符）。超过就截断 —— 摘要段不是转录。 */
const PER_MESSAGE_CHARS = 60;
/** 进程内缓存上限（宿主会话数一般 < 20） */
const CACHE_MAX = 32;

/** file → { mtimeMs, size, chatKey, rows } */
const CACHE = new Map();

/**
 * 读一个会话存档；失败返回 null（解析炸了不能连累注入）。
 *
 * `fresh` 只有来源反查会用：缓存判据是 `(mtimeMs, size)`，而 Windows 的 mtime 分辨率
 * 只有毫秒级 —— "同一毫秒内追加、字节数又恰好相同"会命中旧缓存，于是**给人核对的答案
 * 比磁盘旧几条**。注入那一路要性能，用缓存；反查那一路要"和磁盘一致"，宁可多解析一次。
 */
function readChatFile(file, { fresh = false } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = CACHE.get(file);
  if (!fresh && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const rows = Array.isArray(raw) ? raw : (raw?.messages || []);
  // `chatKeyRaw` 保留**原始类型**（`[by:DS] 2026-10-29` 复审）。
  // `String(raw?.chatKey || '')` 会把数字洗成 `'123'`、把对象洗成 `'[object Object]'`，
  // 于是"坏档"和"没有内部键"长得一样 —— 前者必须拒读，后者才允许回退到文件名。
  const chatKeyRaw = raw?.chatKey;
  const chatKey = typeof chatKeyRaw === 'string' ? chatKeyRaw : '';
  const rec = { mtimeMs: st.mtimeMs, size: st.size, chatKey, chatKeyRaw, rows: Array.isArray(rows) ? rows : [] };
  CACHE.set(file, rec);
  if (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  return rec;
}

/**
 * 存档自己声明了哪个会话 —— 三种，**不能混**（`[by:DS] 2026-10-29` 复审）：
 *   `inner`   有内部字符串键 ⇒ 它说了算，只有完全相等才可用
 *   `none`    确实没有（旧数组存档 / 空串）⇒ 才允许按严格约定文件名作**兼容推断**
 *   `invalid` 有键但不是字符串（数字 / 对象 / 布尔）⇒ 坏档，**不许**当"没有键"回退
 */
function archiveIdentity(rec) {
  const raw = rec?.chatKeyRaw;
  if (typeof raw === 'string') return raw.length ? { kind: 'inner', key: raw } : { kind: 'none' };
  if (raw === undefined || raw === null) return { kind: 'none' };
  return { kind: 'invalid', type: Array.isArray(raw) ? 'array' : typeof raw };
}

/** 行的时间戳：存档是 `ts`（毫秒），冷档可能是 `at`。两个都认，认不出就当 0。 */
function tsOf(row) {
  const n = Number(row?.ts ?? row?.at ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 平台把纯媒体写成文本占位（`[图片]` / `[视频]` / `[动画表情]` …）。整行只有这些 ⇒ 没有信息量。 */
const MEDIA_ONLY_RE = /^(?:\[(?:图片|视频|语音|表情|动画表情|文件|卡片消息|转发消息|回复消息|音乐|位置)\])+$/;

/** 整行是不是只有媒体占位符（`[图片][图片]` 也算）。 */
export function isMediaOnlyText(text) {
  return MEDIA_ONLY_RE.test(String(text ?? '').trim());
}

/**
 * 一行消息 → 一行文本：压掉换行、去掉空段。
 *
 * `mediaPlaceholder` 默认 true（纯媒体给个 `[图片]` 占位）；跨会话采集时传 **false** ——
 * 她看不到那些图，把 `[图片]` 念进提示词只会让她以为自己看见了，
 * 进而在聊天里编"我看到那张图了"。宁可少一条，也不要一条会让她幻觉的记录。
 */
export function cleanMessageText(row, cap = PER_MESSAGE_CHARS, { mediaPlaceholder = true } = {}) {
  let t = String(row?.text ?? row?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!t && mediaPlaceholder) {
    const media = Array.isArray(row?.media) ? row.media : [];
    if (media.length) {
      const kinds = media.map((m) => (m?.kind === 'image' ? '[图片]' : (m?.kind === 'record' ? '[语音]' : '[附件]')));
      t = kinds.join(' ');
    }
  }
  if (!t) return '';
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

/** 一句话里的发言人名字：`self` 用"我"，否则 `senderName`，再退"某人"。 */
function speakerOf(row) {
  if (row?.self === true || String(row?.senderId) === 'self') return '我';
  const n = String(row?.senderName || '').trim();
  if (n) return n;
  // ⚠️ 兜底**不写 QQ 号**：这段文本会进提示词，模型完全可能把它当称呼念出来。
  //    "某人"至少不会泄露号码，也不会让她对着一个号码叫名字。
  return '某人';
}

/** `group:1098345913` → `群 1098345913`（拿不到群名时的兜底）。 */
function fallbackLabel(chatKey) {
  const [kind, id] = String(chatKey).split(':');
  return `${kind === 'private' ? '私聊' : '群'} ${String(id || '').slice(-4)}`;
}

/**
 * 收集"别的会话"最近 N 分钟的原话。
 *
 * @param {object}   o
 * @param {string}   o.dataDir            宿主 data 根（含 `messages/`）
 * @param {number}   [o.now]              当前时间（毫秒，测试可注入）
 * @param {string}   [o.excludeChatKey]   当前会话 —— **必须排除**，否则会把"自己的话"再念一遍
 * @param {number}   [o.minutes=10]       时间窗
 * @param {number}   [o.maxChats=2]       最多几个会话
 * @param {number}   [o.maxChars=120]     每个会话的文本上限
 * @param {number}   [o.maxMessages=6]    每个会话取最后几条
 * @param {boolean}  [o.includePrivate=false] 私聊能不能当**来源**（默认不能）
 * @param {function} [o.nameOf]           chatKey → 显示名（拿不到就用 fallbackLabel）
 * @returns {{sources:Array<{chatKey:string,kind:string,name:string,messages:number,chars:number,lastAt:number,text:string}>,reason:string|null}}
 */
export function collectCrossChatRecent({
  dataDir, now = Date.now(), excludeChatKey = '', minutes = 10,
  maxChats = 2, maxChars = 120, maxMessages = 6, includePrivate = false, nameOf = null
} = {}) {
  const dir = path.join(String(dataDir || ''), 'messages');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { sources: [], reason: 'messages-dir-unreadable' }; }
  if (!files.length) return { sources: [], reason: 'messages-dir-empty' };

  const cutoff = Number(now) - Math.max(1, Number(minutes) || 10) * 60_000;
  const wantChats = Math.max(1, Math.min(8, Number(maxChats) || 2));
  const perChatChars = Math.max(40, Math.min(600, Number(maxChars) || 120));
  const perChatMsgs = Math.max(1, Math.min(20, Number(maxMessages) || 6));

  const candidates = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const rec = readChatFile(file);
    if (!rec) continue;
    const chatKey = rec.chatKey || f.replace(/\.json$/, '').replace('_', ':');
    if (!chatKey || chatKey === excludeChatKey) continue;
    const isPrivate = chatKey.startsWith('private:');
    if (isPrivate && !includePrivate) continue;          // 闸①：私聊默认不当来源
    if (!chatKey.startsWith('group:') && !isPrivate) continue;

    const fresh = rec.rows.filter((r) => tsOf(r) >= cutoff);
    if (!fresh.length) continue;
    fresh.sort((a, b) => tsOf(a) - tsOf(b));
    const tail = fresh.slice(-perChatMsgs);

    let text = '';
    for (const r of tail) {
      // 纯媒体行（只有 `[图片]`/`[视频]`）**不收**：她看不到那张图，
      // 把占位符念进提示词只会让她编"我看到图了"。
      const t = cleanMessageText(r, PER_MESSAGE_CHARS, { mediaPlaceholder: false });
      if (!t || isMediaOnlyText(t)) continue;
      const piece = `${speakerOf(r)}：${t}`;
      const next = text ? `${text} ｜ ${piece}` : piece;
      if (next.length > perChatChars) {
        if (!text) text = `${piece.slice(0, perChatChars)}…`;
        break;
      }
      text = next;
    }
    if (!text) continue;
    candidates.push({
      chatKey,
      kind: isPrivate ? 'private' : 'group',
      name: (typeof nameOf === 'function' ? String(nameOf(chatKey) || '') : '') || fallbackLabel(chatKey),
      messages: tail.length,
      chars: text.length,
      lastAt: tsOf(tail[tail.length - 1]),
      text
    });
  }

  if (!candidates.length) return { sources: [], reason: 'no-fresh-other-chat' };
  // 最近的会话优先；同样新就按消息多寡（热闹的那个更像"正在发生"）。
  candidates.sort((a, b) => (b.lastAt - a.lastAt) || (b.messages - a.messages));
  return { sources: candidates.slice(0, wantChats), reason: null };
}

/**
 * 渲染成一节提示词。没有来源 ⇒ 返回空串（调用方据此不拼这一段）。
 * @param {Array} sources `collectCrossChatRecent()` 的 `sources`
 * @param {number} minutes 只用于标题里的"最近 N 分钟"
 */
export function renderCrossChatLines(sources, minutes = 10) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && s.text) : [];
  if (!list.length) return [];
  const body = list.map((s) => `- ${s.kind === 'private' ? '私聊' : '群'}「${s.name}」：${s.text}`).join('\n');
  return [`【别处动静（最近 ${Math.max(1, Number(minutes) || 10)} 分钟，其它会话的原话，只用来接话，别主动复述）】\n${body}`];
}

/** 会话键白名单：**只用来拼文件名**，所以宁可窄。`group:C1` / `private:123`。 */
const CHAT_KEY_RE = /^(?:group|private):[A-Za-z0-9_-]{1,64}$/;
/** 反查原话的硬上限（一次最多回多少条）。窗口切分上限是 120，留出余量。 */
const ARCHIVE_MAX_ROWS = 500;

/**
 * 从宿主会话存档里取回"某段时间 / 某几条消息 id"的原话 —— **来源反查**用。
 * `[by:DS] 2026-10-29`
 *
 * 与 `collectCrossChatRecent` 的分工别混：
 *   · 那个是**给提示词**的：掐 60 字、纯媒体行丢掉、只要最近几分钟、只要别的会话；
 *   · 这个是**给人核对**的：拿回真话、标出说话人、允许单条长一点。
 * 两者共用同一份只读缓存（`readChatFile`），都不写宿主存档。
 *
 * 三态，**不许把"没读到"说成"没有"**：
 *   `found`       取到了（可能 `truncated`）
 *   `expired`     存档在，但这个区间里没有消息（被清理 / 还没落档 / 区间给错了）
 *   `unavailable` 读不到可用存档 —— 目录读不动、文件损坏、会话键不合法、
 *                 **或存档内部声明的会话与请求不符**（`reason:'chat-mismatch'`）
 *
 * 会话绑定：**内部键说了算**。存档里有非空 `chatKey` 时，只有与请求完全相等才可用；
 * 不等就整份丢弃，绝不按文件名放行（`group_1.json` 里完全可能装着 `private:2`）。
 * 只有**确实没有内部键**的旧数组存档，才按严格约定文件名作兼容推断 ——
 * 此时返回 `matchedBy:'legacy-filename'` 并在 `note` 里写明"这是兼容推断，不是元数据验证"。
 *
 * ⚠️ **只按时间区间取，不承诺"就是当时那一批"**：窗口是按游标 + 条数上限切的，
 * 存档里的同区间可能更宽（多出几条没进窗口的消息）。返回里的 `note` 会写明。
 *
 * @param {object} o
 * @param {string} o.dataDir   宿主 data 根（含 `messages/`）
 * @param {string} o.chatKey   会话键（调用方另需与引用核对，本函数只管存档绑定）
 * @param {number|null} [o.fromTs] 区间起点（含）
 * @param {number|null} [o.toTs]   区间终点（含）
 * @param {string[]|null} [o.ids]  给了就按消息 id 精确取（忽略区间）
 * @returns {{status:string,chatKey:string,file:string|null,matchedBy:string,scanned:number,
 *            matched:number,truncated:boolean,messages:Array,reason:string|null,note:string}}
 */
export function readChatArchive({
  dataDir, chatKey, fromTs = null, toTs = null, ids = null,
  limit = ARCHIVE_MAX_ROWS, perMessageChars = 300
} = {}) {
  const ck = String(chatKey || '');
  const base = {
    chatKey: ck, file: null, scanned: 0, matched: 0, truncated: false, messages: [],
    note: '按时间区间在会话存档里重新取回，**不保证**就是当时送进模型的那一批'
      + '（窗口按游标 + 条数上限切，同一区间可能多出几条没进窗口的消息）。'
  };
  if (!CHAT_KEY_RE.test(ck)) {
    return { ...base, status: 'unavailable', reason: 'bad-chat-key' };
  }
  const dir = path.join(String(dataDir || ''), 'messages');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { ...base, status: 'unavailable', reason: 'messages-dir-unreadable' };
  }
  // ── 选文件：**内部会话键说了算，文件名只在确实没有内部键时作兼容推断** ──────
  // 复审反例（`[by:DS] 2026-10-29`）：`group_1.json` 里装着 `private:2` 的内容
  // （改名、复用、手工搬移都会造成）。按文件名放行 = 把私聊当群聊读出来，而且
  // **看代码看不出来**。上一版先信文件名、再用 `内部键 === ck || 文件名 === ck` 兜底，
  // 于是"内部键不符"能靠文件名条件绕过 —— 这条洞就是这次要堵的。
  const want = `${ck.replace(':', '_')}.json`;
  // 约定文件名排最前（正常情况第一个就命中）；其余文件只在需要时读，且都在缓存里。
  const order = files.includes(want) ? [want, ...files.filter((f) => f !== want)] : [...files];
  let rec = null;
  let file = null;
  let matchedBy = '';
  const rejected = [];
  for (const f of order) {
    const p = path.join(dir, f);
    // `fresh`：核对类读要"与磁盘一致"，不接受毫秒级 mtime + 等长字节造成的缓存误命中
    const r = readChatFile(p, { fresh: true });
    if (!r) {
      if (f === want) rejected.push({ file: f, why: 'unreadable-or-corrupt' });
      continue;
    }
    const id = archiveIdentity(r);
    if (id.kind === 'inner') {
      if (id.key === ck) { rec = r; file = p; matchedBy = 'inner-chat-key'; break; }
      // 有内部键 ⇒ 不等就整份丢弃，**绝不**退回文件名
      if (f === want) rejected.push({ file: f, why: 'chat-mismatch', innerChatKey: id.key });
      continue;
    }
    if (id.kind === 'invalid') {
      // 有键但不是字符串 ⇒ 坏档。不能当"没有键"，否则坏档会被文件名洗成合法来源
      if (f === want) rejected.push({ file: f, why: 'invalid-inner-chat-key', innerType: id.type });
      continue;
    }
    // 确实没有内部键（旧数组存档 / 空串）⇒ 只有**严格约定文件名**才兼容
    if (f === want) { rec = r; file = p; matchedBy = 'legacy-filename'; break; }
  }
  if (!rec) {
    const mismatch = rejected.find((x) => x.why === 'chat-mismatch');
    const broken = rejected.find((x) => x.why === 'invalid-inner-chat-key');
    return {
      ...base, status: 'unavailable',
      // 稳定原因，三种可辨：
      //   `chat-mismatch`          有同名存档，但内部声明的会话不是它
      //   `invalid-inner-chat-key` 有同名存档，但内部键不是字符串（坏档，不是"没键"）
      //   `chat-archive-missing`   根本没有可用存档（含文件损坏 / 读不动）
      reason: mismatch ? 'chat-mismatch' : broken ? 'invalid-inner-chat-key' : 'chat-archive-missing',
      candidates: rejected.slice(0, 5)
    };
  }

  const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const lo = fromTs === null || fromTs === undefined ? null : Number(fromTs);
  const hi = toTs === null || toTs === undefined ? null : Number(toTs);
  let rows = rec.rows.filter((r) => {
    if (idSet) {
      const id = String(r?.id ?? r?.mid ?? r?.messageId ?? r?.msgId ?? '');
      return id ? idSet.has(id) : false;
    }
    const t = tsOf(r);
    if (lo !== null && Number.isFinite(lo) && t < lo) return false;
    if (hi !== null && Number.isFinite(hi) && t > hi) return false;
    return true;
  }).sort((a, b) => tsOf(a) - tsOf(b));

  const scanned = rec.rows.length;
  const matched = rows.length;
  const cap = Math.max(1, Math.min(ARCHIVE_MAX_ROWS, Number(limit) || ARCHIVE_MAX_ROWS));
  const truncated = rows.length > cap;
  if (truncated) rows = rows.slice(0, cap);
  const charCap = Math.max(40, Math.min(2000, Number(perMessageChars) || 300));

  const messages = rows.map((r) => {
    const raw = String(r?.text ?? r?.content ?? '').replace(/\s+/g, ' ').trim();
    const id = String(r?.id ?? r?.mid ?? r?.messageId ?? r?.msgId ?? '');
    return {
      id: id || null,
      at: tsOf(r) || null,
      self: r?.self === true || String(r?.senderId) === 'self',
      speaker: speakerOf(r),
      senderId: r?.senderId == null ? null : String(r.senderId),
      text: raw.length > charCap ? `${raw.slice(0, charCap)}…` : raw
    };
  }).filter((m) => m.text);

  return {
    ...base,
    status: messages.length ? 'found' : 'expired',
    file: path.basename(file),
    // 这一条要能被验收看见：**内部元数据验证** 与 **文件名兼容推断** 不是一回事
    matchedBy,
    scanned, matched, truncated, messages,
    note: base.note + (matchedBy === 'legacy-filename'
      ? ' 本次匹配依据是**约定文件名**（该存档没有内部会话键，属旧格式兼容推断），不是内部元数据验证。'
      : ''),
    reason: messages.length ? null : 'no-message-in-range'
  };
}
