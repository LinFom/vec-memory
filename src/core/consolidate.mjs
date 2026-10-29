import { isCanonicalSource, canonicalEvidence } from './input-source.mjs';
import { openSubjectStore } from './subjects.mjs';
import { windowReferences } from './provenance.mjs';
import { encodingIdentity } from './vector-generation.mjs';
// 事件整理（M5）—— 把「上次整理结束 → 现在」这段对话整理成**两样东西**：
//   ① 事件记忆：这期间发生了哪些事（append-only 落 `consolidate/events.jsonl`）
//   ② 人物印象：这期间对谁形成了什么印象（写 factstore 的槽）
//
// ── 为什么需要它（2026-10-22 用户口径）─────────────────────────────────────
// 上一版把「记人」完全押在模型自觉调 `remember` 上：实测号B 5 天**5 次**调用，
// 改提示词后升到 ~27 次/天，但 160 轮模型调用里也只有 6 次 ⇒ 转化率 3.75%。
// 群聊 90% 是玩梗打闹，模型面对「该记」和「四处不要记」同时出现时永远选安全的那条。
// 而**整理管道不需要模型"想起来"** —— 它按窗口必然跑。老系统的印象就是整理产出的，
// 质量（「惯用排队收费的玩笑接粗口起哄」）明显高于直写（「咖啡不耐受」这种硬事实）。
// ⇒ 认人这件事改由整理承担，直写（remember）退成"顺手补记"的旁路。
//
// ── 输入为什么是 evidence 而不是 memory-v2 块 ─────────────────────────────
// `derive.mjs` 的唯一样本 `memory-v2/chunks/hour_*.json` **停更在 10-17**
// （新宿主 refactor/ 不产它）。而 `<sourceRoot>/memory/evidence.jsonl` 是**活的**
// （实测号B 29232 行 / 末条与当前同步）：append-only、一行一消息、
// 带 `chatKey` / `speakerId` / `speakerName` / `text` ⇒ 天然可做游标。
//
// ── 三条纪律 ─────────────────────────────────────────────────────────────
// ① **窗口只在"沉淀够"时切**：正在聊的那几分钟留给下一轮，否则一个话题被切成
//    两半，两边都读不出完整事件。
// ② **游标只在窗口成功处理后推进**：LLM 挂了/JSON 烂了就停在那儿重试 ——
//    跳过会**永久丢**这一段（用户只会看到"她记性有洞"，看不到任何报错）。
// ③ **出境文本一律过归一化器**：事件摘要会被渲染进 prompt、也会被嵌进向量库，
//    两条路都算出境。摘要里出现 QQ 号 = 把通讯录发给云端。
//
// ── 这个文件不碰宿主 ─────────────────────────────────────────────────────
// 只读 `<sourceRoot>/memory/evidence.jsonl`，写自己库根的 `consolidate/`。
// 宿主一行不改。
import fs from 'node:fs';
import path from 'node:path';

import { buildEmbedText, chunkMeta, sourceHash } from './chunkread.mjs';
import { chatRawOf } from './derive.mjs';
import { FACT_KIND_GROUPS } from './facts.mjs';
import { upsertSlotItem, itemKeyOf } from './inject.mjs';

export const CONSOLIDATE_VERSION = 1;

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** 时间戳一律按北京时间切（宿主所有时间戳都是"北京时间语义"，与 derive.mjs 同口径）。 */
const TZ_OFFSET_MS = 8 * HOUR_MS;

/** 单条消息在提示词里的字符上限。刷屏长文一条就能吃光整个窗口预算。 */
const PER_MSG_CHARS = 160;
/** 一个窗口送去模型的记录上限（字符）。超了**均匀抽样**，不是截尾。 */
const TRANSCRIPT_MAX_CHARS = 6000;

/** 允许模型写进事实槽的 kind。`pattern` 不在内：它是成簇判定的产物，不是"看一段对话就能下结论"的东西。 */
export const CONSOLIDATE_KINDS = Object.freeze([...FACT_KIND_GROUPS.semantic, 'speaker_profile', 'trait']);

const MEDIA_LABEL = {
  image: '图片', pic: '图片', voice: '语音', video: '视频',
  face: '表情', mface: '表情', file: '文件', record: '语音'
};

const LINE_BREAK_RE = /[\t\n\r\u2028\u2029]/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\ufeff]/g;

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * 与 `numOr` 相同，但 **0 是合法值**。
 *
 * 有些参数为 0 时语义完全不同、而且完全合法：
 *   · `consolidateSettleMin = 0` ⇒ 不等沉淀，游标之后立刻成窗（**排障/回放**时要的就是这个）；
 *   · `retireHalfLifeGain = 0` ⇒ 不因排练延长半衰期（"只想按时间衰减"）。
 * 用 `numOr` 读它们会把 0 折成默认值 —— 也就是"我明确关掉了"变成"我用了默认的开启"。
 * 这类静默改写比报错难查得多：配置读起来对、行为是默认。
 */
function numOr0(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** `evidence.jsonl` 一行 → 毫秒时间戳（三种字段名都认，老行只有 `at`）。 */
export function tsOfRow(row) {
  if (!row || typeof row !== 'object') return 0;
  for (const k of ['at', 't', 'ts', 'time']) {
    const raw = row[k];
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n > 1e12 ? n : n * 1000;   // 秒 → 毫秒
  }
  return 0;
}

/** 纯文本化：控制字符清理 + 折叠空白 + 单条截断。 */
export function cleanText(raw) {
  let s = String(raw ?? '');
  if (!s) return '';
  s = s.replace(LINE_BREAK_RE, ' ').replace(CTRL_RE, '');
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ');      // CQ 码是结构，留在这里只会污染语义
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > PER_MSG_CHARS) s = `${s.slice(0, PER_MSG_CHARS)}…`;
  return s;
}

/** 北京时间 `HH:MM`（窗口标题用；不写日期 —— 事件列表按时间倒序，日期在分组上）。 */
export function clockOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const iso = new Date(n + TZ_OFFSET_MS).toISOString();
  return `${iso.slice(11, 16)}`;
}

/** 北京时间 `MM-DD HH:MM`（跨天窗口需要日期，否则"23:50–00:20"看不懂）。 */
export function stampOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const iso = new Date(n + TZ_OFFSET_MS).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

// ── 输入：evidence 账本 ───────────────────────────────────────────────────

/**
 * 读 `<sourceRoot>/memory/evidence.jsonl`。
 *
 * 坏行**只计数不抛**：账本是 append-only 的，崩过一次就可能留半行；
 * 为半行拒绝整段记忆，等于让一次断电永久堵死整理管道。
 */
export function readEvidenceRows({ sourceRoot, limitLines = 0 } = {}) {
  if (sourceRoot && isCanonicalSource(sourceRoot)) { const rows=canonicalEvidence(sourceRoot); return {rows:limitLines>0?rows.slice(-limitLines):rows,badLines:0,missing:false,file:path.join(sourceRoot,'messages.jsonl')}; }
  const file = path.join(path.resolve(String(sourceRoot || '')), 'memory', 'evidence.jsonl');
  const out = { rows: [], badLines: 0, missing: false, file };
  if (!sourceRoot) { out.missing = true; return out; }
  let text = '';
  try {
    if (!fs.existsSync(file)) { out.missing = true; return out; }
    text = fs.readFileSync(file, 'utf8');
  } catch { out.missing = true; return out; }
  const lines = text.split('\n');
  const from = limitLines > 0 && lines.length > limitLines ? lines.length - limitLines : 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { out.badLines++; continue; }
    if (!row || typeof row !== 'object') { out.badLines++; continue; }
    out.rows.push(row);
  }
  return out;
}

// ── 游标 ─────────────────────────────────────────────────────────────────

export function consolidatePaths(libDir) {
  const base = path.join(path.resolve(String(libDir || '')), 'consolidate');
  return {
    base,
    state: path.join(base, 'state.json'),
    events: path.join(base, 'events.jsonl'),
    hits: path.join(base, 'hits.jsonl')
  };
}

export function loadConsolidateState({ libDir }) {
  const p = consolidatePaths(libDir);
  const empty = { version: CONSOLIDATE_VERSION, chats: {}, updatedAt: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    if (!raw || typeof raw !== 'object') return empty;
    return {
      version: CONSOLIDATE_VERSION,
      chats: (raw.chats && typeof raw.chats === 'object') ? raw.chats : {},
      updatedAt: Number(raw.updatedAt) || 0
    };
  } catch { return empty; }
}

export function saveConsolidateState({ libDir, state }) {
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const body = JSON.stringify({ ...state, version: CONSOLIDATE_VERSION, updatedAt: Date.now() }, null, 2);
  const tmp = `${p.state}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, p.state);   // 原子替换：半份 state 比没有 state 更危险
  return p.state;
}

// ── 窗口切分（纯函数）───────────────────────────────────────────────────

/**
 * 从 evidence 行里切出**可以整理**的窗口。
 *
 * @param {object} o
 * @param {Array<object>} o.rows        evidence 行
 * @param {object} [o.state]            `loadConsolidateState()` 的结果（读 `chats[chatKey].lastTs`）
 * @param {number} [o.maxMsgs=120]      一个窗口最多几条消息
 * @param {number} [o.maxSpanMs]        一个窗口最长时间跨度（默认 2h）
 * @param {number} [o.settleMs]         窗口末端必须早于 `now - settleMs`（默认 3min）
 * @param {number} [o.limit=3]          这次最多处理几个窗口（成本闸门）
 * @param {number} [o.now]              当前时间（单测注入）
 * @param {string} [o.chatKey]          只处理某个会话
 * @returns {Array<{chatKey:string, fromTs:number, toTs:number, rows:object[], msgCount:number}>}
 *   已按 `fromTs` 升序（老的先整理，时间线不会倒着长）。
 */
export function pickWindows({
  rows, state = null, maxMsgs = 120, maxSpanMs = 2 * HOUR_MS, settleMs = 3 * MIN_MS,
  limit = 3, now = Date.now(), chatKey = ''
} = {}) {
  const chatOnly = String(chatKey || '').trim();
  const byChat = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const ck = String(row?.chatKey || '').trim();
    if (!ck) continue;
    if (chatOnly && ck !== chatOnly) continue;
    const ts = tsOfRow(row);
    if (!ts) continue;
    let list = byChat.get(ck);
    if (!list) { list = []; byChat.set(ck, list); }
    list.push({ ts, row });
  }

  const settleCut = Number(now) - Math.max(0, Number(settleMs) || 0);
  const wins = [];
  for (const [ck, list] of byChat) {
    list.sort((a, b) => a.ts - b.ts);
    const lastTs = Number(state?.chats?.[ck]?.lastTs) || 0;
    // 只吃游标之后的；`<=` 判据与"游标=已处理到的最后一条时间"对齐
    const ready = [];
    for (const it of list) {
      if (it.ts <= lastTs) continue;
      if (it.ts > settleCut) break;      // 已排序 ⇒ 后面都还没沉淀
      ready.push(it);
    }
    if (!ready.length) continue;

    let i = 0;
    let built = 0;
    while (i < ready.length && built < Math.max(1, Number(limit) || 1)) {
      const start = ready[i].ts;
      let j = i;
      while (j < ready.length
        && (j - i + 1) <= Math.max(1, Number(maxMsgs) || 1)
        && (ready[j].ts - start) <= Math.max(MIN_MS, Number(maxSpanMs) || MIN_MS)) {
        j++;
      }
      const slice = ready.slice(i, j);
      if (!slice.length) break;
      wins.push({
        chatKey: ck,
        fromTs: slice[0].ts,
        toTs: slice[slice.length - 1].ts,
        msgCount: slice.length,
        rows: slice.map((x) => x.row)
      });
      built++;
      i = j;
    }
  }
  wins.sort((a, b) => a.fromTs - b.fromTs);
  return wins.slice(0, Math.max(1, Number(limit) || 1));
}

// ── 提示词 ───────────────────────────────────────────────────────────────

/**
 * 一段记录 → 提示词里的对话正文。
 *
 * 每行 `[HH:MM] 名字(QQ号): 文本` —— **必须带 QQ 号**：
 * 模型要回填 `qq`，而昵称会变、会撞车（同一个"小鱼"在三个群里是三个人）。
 */
export function renderTranscript(rows, { fromTs = 0, maxChars = TRANSCRIPT_MAX_CHARS } = {}) {
  const lines = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const ts = tsOfRow(row) || Number(fromTs) || 0;
    const text = cleanText(row?.text);
    const media = row?.media?.type || row?.mediaType || (row?.kind && MEDIA_LABEL[row.kind] ? row.kind : '');
    const body = text || (media ? `[${MEDIA_LABEL[media] || '附件'}]` : '');
    if (!body) continue;                       // 纯空行（贴纸/撤回）不占预算
    const name = cleanText(row?.speakerName) || '某人';
    const qq = String(row?.speakerId ?? '').replace(/^qq:/, '').trim();
    const isSelf = row?.self === true || qq === 'self';
    const head = isSelf ? `我(${name})` : (qq ? `${name}(${qq})` : name);
    lines.push({ ts, text: `[${clockOf(ts)}] ${head}: ${body}` });
  }
  const budget = Math.max(400, Number(maxChars) || TRANSCRIPT_MAX_CHARS);
  const joined = () => lines.map((l) => l.text).join('\n');
  if (joined().length <= budget) return joined();

  // 超预算 ⇒ **均匀抽样**（保留首尾）。截尾会把最新的聊天切掉，而最新的最该被记住。
  const keep = Math.max(8, Math.floor(lines.length * (budget / joined().length)));
  const step = lines.length / keep;
  const picked = [];
  for (let k = 0; k < keep; k++) picked.push(lines[Math.min(lines.length - 1, Math.floor(k * step))]);
  if (picked[picked.length - 1] !== lines[lines.length - 1]) picked.push(lines[lines.length - 1]);
  return picked.map((l) => l.text).join('\n');
}

const SYSTEM_PROMPT = [
  '你是社群聊天的记忆整理员。你会读到一段群聊记录，任务是从中提炼**两样东西**：',
  '① 事件：这期间发生了什么值得记住的事；',
  '② 人物印象：这期间对某些人形成了什么稳定印象。',
  '',
  '只输出一个 JSON 对象，不要解释、不要客套、不要 Markdown 代码块。',
  '格式：{"events":[{"title":"","detail":"","at":"","who":[]}],"people":[{"qq":"","kind":"","aspect":"","attr":"","text":""}]}',
  '',
  '【事件】title ≤ 20 字，一句话说清"发生了什么"；detail 1-3 句补充关键信息（谁跟谁、结果如何）。',
  'at 填记录的 HH:MM，看不出就填空串。who 填相关人的 QQ 号数组（从记录里的括号抄）。',
  '该记：讨论出结论/分歧争执/约定约定/分享作品/公布变化/集体活动/反复出现的梗。',
  '不该记：寒暄问候、单纯发表情、刷屏、没有信息量的接话。',
  '一段记录通常 0-5 件事。没有值得记的就给空数组，不要硬凑。',
  '',
  '【人物印象】每条只针对**一个人**，qq 必须是记录里出现过的号码。',
  'kind 只能取：speaker_profile（说话风格/性格/脾气）、trait（固定档案：年龄/职业/所在地/爱好/忌口）、',
  'preference（喜好口味）、grudge（雷点禁忌）、joke（他反复玩的梗）、topic（他常聊的话题）、',
  'promise（约定）、event（关于他的具体事件）。',
  'text 写成**一句可以直接读给人听的话**，主语用"他/她"：',
  '好例子：「爱接梗卖乖，说话短，和 Nyan 斗嘴常绕"验货、加钱"打转」「对群内粗口较敏感，会直接出声制止」。',
  '坏例子：「性格好」「聊了游戏」（太虚，等于没记）。',
  'kind=trait 时 attr 必填（职业/年龄/所在地/爱好…），text 只填该属性的值。',
  'kind=speaker_profile 时 aspect 用短词说明"这是他的哪一面"——'
    + '「说话风格 / 性格脾气 / 与人相处 / 对某个人的态度 / 在群里的角色」。'
    + '不同 aspect 会并存（一个人可以既有"说话风格"又有"对某人的态度"），同一个 aspect 覆盖旧值。',
  'kind=preference 或 grudge 时 aspect 填**这个喜好/雷点属于哪个方面**'
    + '（吃 / 喝 / 玩 / 音乐 / 作息 / 称呼 / 玩笑 / 话题 …）。'
    + '不同方面会并存 —— 一个人"爱吃辣"和"爱玩明日方舟"是两条，不要合成一句。',
  '其余 kind（event/topic/promise/joke）一句话一个槽：同一个人写第二条会顶掉第一条，'
    + '所以只在该 kind 还没有内容时才写；已经有的事不要重复写。',
  '',
  '判断标准是**这人下次出现时你还认不认得出**。一次性情绪、当天的琐事不算印象。',
  '同一件事不要既写进 events 又写进 people —— events 记"事"，people 记"人"。'
].join('\n');

/**
 * 窗口 → 提示词。
 * 时间范围与条数写进 user：模型需要知道"这段有多长"，否则会把 20 分钟的闲聊写成一天的总结。
 */
export function buildConsolidatePrompt({ chatKey, chatLabel = '', fromTs, toTs, msgCount = 0, transcript }) {
  const label = String(chatLabel || '').trim() || String(chatKey || '');
  const span = `${stampOf(fromTs)} → ${stampOf(toTs)}`;
  const user = [
    `会话：${label}（${chatKey}）`,
    `时间：${span}，共 ${Number(msgCount) || 0} 条消息`,
    '',
    '记录：',
    String(transcript || '').trim() || '（空）',
    '',
    '按上面的 JSON 格式输出。'
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

// ── 模型输出解析 ─────────────────────────────────────────────────────────

/** 从模型回复里抠出第一个完整的 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function extractJsonObject(text) {
  const s = String(text ?? '').replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 从**被截断**的模型回复里抢救 `"key":[...]` 中**已完整**的元素。
 *
 * ── 为什么需要它（实测，2026-10-23，主号 30 个窗口全量 dryRun）──────────────
 * 模型输出撞上 `maxTokens` 时，最后一个 `}` 永远等不到 ⇒ `extractJsonObject` 判死 ⇒
 * 整段作废 + **游标不推进** ⇒ 这一窗把后面所有窗口永久堵死（每轮都重试同一个窗）。
 * 但截断之前那几个事件的结构是完整的：丢掉 = 白花一次调用 + 堵死管道。
 *
 * ⚠️ 只收**能 `JSON.parse` 通**的元素：半截对象一律丢 —— 宁可少记，不能记脏。
 *
 * @param {string} text 模型原文
 * @param {string} key  `events` / `people`
 * @returns {Array<object>} 已完整的元素（可能为空数组）
 */
export function salvageJsonObjects(text, key) {
  const s = String(text ?? '');
  const k = s.indexOf(`"${key}"`);
  if (k < 0) return [];
  const open = s.indexOf('[', k);
  if (open < 0) return [];
  const out = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* 半截 ⇒ 丢 */ }
        start = -1;
      }
      continue;
    }
    if (ch === ']' && depth === 0) break;        // 数组正常闭合（没截断）
  }
  return out;
}

/**
 * 模型回复 → `{ events, people }`（字段裁剪 + 类型兜底）。
 *
 * 这里**只做结构校验，不做语义判断**：模型说"某事值得记"就记，
 * 我们的门槛放在提示词里。代码再判一次语义，等于两套标准互相打架。
 *
 * `text` 被截断时先走 `salvageJsonObjects()` 抢救 —— 见它头上的实测说明。
 * 抢救成功的返回带 `salvaged: true`（面板与日志据此区分"完整解析"与"截断抢救"）。
 */
export function parseConsolidateJson(text, { genericIds = false } = {}) {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') {
    const sEvents = salvageJsonObjects(text, 'events');
    const sPeople = salvageJsonObjects(text, 'people');
    if (!sEvents.length && !sPeople.length) {
      return { ok: false, error: '模型回复里没有可解析的 JSON', events: [], people: [] };
    }
    // 抢救来的元素走**同一套**校验：结构不合规的照样丢，不因为"抢救"就放松标准。
    const sal = normalizeConsolidateJson({ events: sEvents, people: sPeople }, genericIds);
    if (!sal.events.length && !sal.people.length) {
      return { ok: false, error: '模型回复被截断，且抢救出的内容全部不合规', events: [], people: [] };
    }
    return { ...sal, salvaged: true };
  }
  return normalizeConsolidateJson(obj, genericIds);
}

/** 字段裁剪 + 类型兜底（`parseConsolidateJson` 的两条路共用）。 */
function normalizeConsolidateJson(obj, genericIds = false) {
  const events = [];
  for (const raw of (Array.isArray(obj.events) ? obj.events : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title ?? '').trim();
    const detail = String(raw.detail ?? '').trim();
    if (!title && !detail) continue;
    events.push({
      title: title || detail.slice(0, 20),
      detail: detail || '',
      at: String(raw.at ?? '').trim(),
      who: (Array.isArray(raw.who) ? raw.who : [])
        .map((x) => String(x ?? '').replace(/^qq:/, '').trim())
        .filter((x) => genericIds ? !!x && x.length <= 200 : /^\d{5,15}$/.test(x))
    });
  }
  const people = [];
  for (const raw of (Array.isArray(obj.people) ? obj.people : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const rawActorId = String(raw.actorId ?? raw.qq ?? raw.QQ ?? raw.userId ?? '').trim();
    const qq = genericIds ? rawActorId : rawActorId.replace(/^qq:/, '');
    const kind = String(raw.kind ?? '').trim();
    const text = String(raw.text ?? '').trim();
    if (!(genericIds ? !!qq && qq.length <= 200 : /^\d{5,15}$/.test(qq)) || !text) continue;
    if (!CONSOLIDATE_KINDS.includes(kind)) continue;    // 封闭枚举：拼错就是新槽，宁可不写
    const attr = String(raw.attr ?? '').trim();
    // `trait` 没有属性名就只能整槽覆盖 —— 会把这个人的其它属性挤掉 ⇒ 结构上就不可用
    if (kind === 'trait' && !attr) continue;
    // `speaker_profile` 的**方面**（2026-10-22）：不给 = `整体`（见 `inject.mjs` 的
    // `LEGACY_ITEM_KEY`）。给了不同方面 ⇒ 同一个人的多面并存，不再互相顶掉。
    const aspect = String(raw.aspect ?? '').trim();
    people.push({
      qq,
      kind,
      attr,
      aspect,
      text
    });
  }
  if (Object.hasOwn(obj,'observations') && !Array.isArray(obj.observations)) return {ok:false,error:'observations must be an array',events:[],people:[]};
  return { ok: true, events, people, ...(Array.isArray(obj.observations) ? {observations:obj.observations} : {}) };
}

// ── 落库：事件 ───────────────────────────────────────────────────────────

/** 事件 id **必须确定性**（同一窗口重跑得同一个 id）—— 否则重试就重复计。 */
export function eventIdOf({ chatKey, fromTs, toTs }) {
  const raw = chatRawOf(chatKey);
  if (!raw) return '';
  return `evt_${raw}_${Math.floor(Number(fromTs) || 0)}_${Math.floor(Number(toTs) || 0)}`;
}

/**
 * 窗口里第 `idx` 件事的行 id（`ADR-0048` 一事一行）。
 *
 * ⚠️ **序位后缀是 1-based**：`_1` / `_2` …。它必须确定 —— 重跑同窗口要得同一批 id，
 * 否则幂等失效、账本翻倍。也因为它是"序号"而不是"内容 hash"：同窗口内两件事
 * 标题相同时不会撞 id（hash 会撞），代价是模型把事件顺序改了会被当成新行（可接受：
 * 重跑用的是同一份 transcript，顺序不会变）。
 */
export function eventRowId(windowId, idx) {
  const w = String(windowId || '').trim();
  if (!w) return '';
  return `${w}_${Math.max(1, Math.floor(Number(idx) || 0) + 1)}`;
}

/**
 * 给**一条事件**建向量（升长期时调用，`ADR-0048` ⑧）。
 *
 * 失败即抛：调用方决定是"整条晋升失败、下次重试"还是"容忍"。
 * 不再由窗口整理自动调用 —— 见 `applyWindow` 的注释。
 */
export async function embedEventRow(rec, { store, settings = {}, normalizer = null } = {}) {
  const id = String(rec?.id || '').trim();
  if (!id) throw new Error('embedEventRow: 缺 id');
  if (!store) throw new Error('embedEventRow: 缺 store');
  if (!settings.embedBaseURL || !settings.embedModel) {
    throw new Error('embedEventRow: 未配置嵌入端点（embedBaseURL / embedModel）');
  }
  const toTs = Number(rec.toTs) || 0;
  const fromTs = Number(rec.fromTs) || 0;
  const parsedId = {
    id, kind: 'event', chatKey: rec.chatKey,
    dayKey: stampOf(toTs).slice(0, 5), hourKey: `${clockOf(fromTs)}–${clockOf(toTs)}`,
    source: 'consolidate'
  };
  const chunk = {
    id, chatKey: rec.chatKey, when: toTs,
    hourKey: `${stampOf(fromTs)}–${stampOf(toTs)}`,
    title: rec.title || id,
    summary: rec.summary
  };
  const info = buildEmbedText(chunk, {
    normalizer, maxChars: Number(settings.maxChars) || 1200,
    withKeywords: settings.withKeywords !== false, keywordsSource: settings.keywordsSource,
    withSummary: true, register: false
  });
  const hash = sourceHash(chunk, info.text);
  store.assertQueryCompatibility?.({ model: settings.embedModel, encoding: encodingIdentity(settings) });
  const prev = store.get(id);
  if (prev && prev.meta?.sourceHash === hash) return { skipped: true, id };
  const { embedDocuments } = await import('./embed.mjs');
  const { vectors, dim } = await embedDocuments([info.text], {
    baseURL: settings.embedBaseURL, apiKey: settings.embedApiKey, model: settings.embedModel,
    timeoutMs: settings.embedTimeoutMs, dimensions: settings.embedDimensions,
    batchSize: 1, normalizer
  });
  store.put({
    id,
    vector: vectors[0],
    model: settings.embedModel,
    encoding: encodingIdentity(settings),
    meta: { ...chunkMeta(parsedId, chunk, info), sourceHash: hash, embedDim: dim }
  });
  return { skipped: false, id, dim };
}

/** 事件正文（落盘与出境共用一份）。 */
export function eventTextOf(events) {
  const rows = (Array.isArray(events) ? events : []).map((e, i) => {
    const detail = String(e?.detail || '').trim();
    return `${i + 1}. ${String(e?.title || '').trim()}${detail ? `：${detail}` : ''}`;
  }).filter(Boolean);
  return rows.join(' ');
}

export function readEventRows({ libDir, limitLines = 0, strict = false } = {}) {
  const p = consolidatePaths(libDir);
  const out = { rows: [], badLines: 0, missing: false, file: p.events };
  try {
    if (!fs.existsSync(p.events)) { out.missing = true; return out; }
    const lines = fs.readFileSync(p.events, 'utf8').split('\n');
    const from = limitLines > 0 && lines.length > limitLines ? lines.length - limitLines : 0;
    for (let i = from; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.rows.push(row);
        else out.badLines++;
      } catch { out.badLines++; }
    }
  } catch (error) {
    if (strict) throw error;
    out.missing = true;
    out.error = String(error?.message || error);
  }
  if (strict && out.badLines) throw new Error(`Event ledger has ${out.badLines} corrupt rows; refusing mutation`);
  return out;
}

/**
 * 事件账本（面板/排障用）：按 `toTs` 倒序，可选按会话过滤。
 * 与 `readRecentEvents` 的区别：这条**不裁剪**字段，排查时看得见 items / msgCount / summary 全长。
 */
export function readEventLedger({ libDir, chatKey = '', limit = 20 } = {}) {
  const { rows } = readEventRows({ libDir });
  const ck = String(chatKey || '').trim();
  const list = ck ? rows.filter((r) => r.chatKey === ck) : rows.slice();
  list.sort((a, b) => (Number(b.toTs) || 0) - (Number(a.toTs) || 0));
  return list.slice(0, Math.max(1, Math.min(500, Number(limit) || 20)));
}

/**
 * 本会话最近的 N 条**事件**（按 `toTs` 倒序）。注入用。
 *
 * 🆕 `ADR-0048`：一行 = **一件事**（不再是"一个窗口"）。同一窗口内的多条
 * `toTs` 相同 ⇒ 次级按 `idx` 倒序（后发生的事排在前面）。
 * 返回里带上短期层的运行时字段（`hits` / `promotedAt` / `retiredAt`），
 * 排练计数与回收判断都读它 —— 不额外开接口，避免两份口径。
 */
export function readRecentEvents({ libDir, chatKey, limit = 3, maxChars = 200, includeRetired = false, hitCounts = null } = {}) {
  const { rows } = readEventRows({ libDir });
  const ck = String(chatKey || '').trim();
  const list = rows.filter((r) => (!ck || r.chatKey === ck) && r.summary
    && (includeRetired || !r.retiredAt)
    // `supersededBy` = 旧「窗口行」已被拆成一事一行（`ADR-0048` 迁移）
    // ⇒ 读侧跳过，否则同一批事会被念两遍
    && !r.supersededBy);
  list.sort((a, b) => (Number(b.toTs) || 0) - (Number(a.toTs) || 0)
    || (Number(b.idx) || 0) - (Number(a.idx) || 0));
  return list.slice(0, Math.max(1, Number(limit) || 1)).map((r) => {
    const h = hitCounts instanceof Map ? hitCounts.get(String(r.id || '')) : null;
    return {
      id: r.id,
      windowId: r.windowId || '',
      idx: Number(r.idx) || 0,
      chatKey: r.chatKey,
      fromTs: Number(r.fromTs) || 0,
      toTs: Number(r.toTs) || 0,
      msgCount: Number(r.msgCount) || 0,
      at: String(r.at || ''),
      title: String(r.title || '').slice(0, 40),
      summary: String(r.summary || '').slice(0, Math.max(40, Number(maxChars) || 200)),
      // 排练次数 = 账本里固化的（历史/迁移）+ 增量日志聚合
      hits: (Number(r.hits) || 0) + (Number(h?.n) || 0),
      lastHitAt: Math.max(Number(r.lastHitAt) || 0, Number(h?.lastAt) || 0),
      promotedAt: String(r.promotedAt || ''),
      retiredAt: String(r.retiredAt || '')
    };
  });
}

/**
 * 按 id 批量取事件行（相关事件段用：先检索出 id，再回来读正文）。
 *
 * 只返回**该会话**的行：检索侧已经按 chatKey 过滤过，这里是第二道闸门 ——
 * 短期层跨会话漏一条就是社死级事故，宁可重复校验。
 */
export function readEventsById({ libDir, chatKey = '', ids = [], maxChars = 200, hitCounts = null } = {}) {
  const want = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter(Boolean));
  if (!want.size) return [];
  const ck = String(chatKey || '').trim();
  const { rows } = readEventRows({ libDir });
  const out = [];
  for (const r of rows) {
    const id = String(r?.id || '');
    if (!want.has(id)) continue;
    if (ck && r.chatKey !== ck) continue;
    if (r.retiredAt || r.supersededBy) continue;
    const h = hitCounts instanceof Map ? hitCounts.get(id) : null;
    out.push({
      id,
      windowId: r.windowId || '',
      idx: Number(r.idx) || 0,
      chatKey: r.chatKey,
      fromTs: Number(r.fromTs) || 0,
      toTs: Number(r.toTs) || 0,
      msgCount: Number(r.msgCount) || 0,
      at: String(r.at || ''),
      title: String(r.title || '').slice(0, 40),
      summary: String(r.summary || '').slice(0, Math.max(40, Number(maxChars) || 200)),
      hits: (Number(r.hits) || 0) + (Number(h?.n) || 0)
    });
  }
  // 保持调用方给的顺序（检索分数序），而不是账本行序
  out.sort((a, b) => (Array.isArray(ids) ? ids.indexOf(a.id) : 0) - (Array.isArray(ids) ? ids.indexOf(b.id) : 0));
  return out;
}

/**
 * 事件段（注入用）。
 *
 * ⚠️ 这一段是**短期记忆的正主**：它按 `chatKey` 取、按时间倒序、不走向量相似度 ——
 * "刚才这个群发生过什么"必须**确定性地**在场，不能取决于话题与摘要的余弦值。
 *
 * `ADR-0048` 起一行 = 一件事，所以不再打印"时间跨度（N 条消息）"那套**窗口**抬头
 * （同一窗口的多条会把它重复 N 遍）。改用事件自己的 `at`；没有就退回 `toTs` 的时刻。
 *
 * @param {object} [o]
 * @param {string} [o.title] 段标题（"最近事件" / "相关事件"两段共用这一个渲染器）
 */
export function renderEventSection(events, { maxChars = 200, title = '' } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && e.summary) : [];
  if (!list.length) return '';
  const body = list.map((e) => {
    const when = String(e.at || '').trim() || clockOf(e.toTs);
    const text = String(e.summary).slice(0, Math.max(40, Number(maxChars) || 200));
    return `- ${when ? `${when} ` : ''}${text}`;
  }).join('\n');
  const head = String(title || '').trim() || '最近事件（本会话，时间倒序，悄悄参考，不要主动提及）';
  return `【${head}】\n${body}`;
}

// ── 短期层概览（面板「短期记忆」页，ADR-0048 ⑨）────────────────────────

/** 单条事件 → 面板行（含遗忘曲线字段）。overview 与 items 端点共用，口径必须一致。 */
function shapeWorkingRow(r, {
  hitCounts = null, now = Date.now(), retireDays = RETIRE_DAYS,
  gain = RETIRE_HALFLIFE_GAIN, rMin = RETIRE_MIN_RECALL, hardRatio = RETIRE_HARD_RATIO
} = {}) {
  const h = hitCounts instanceof Map ? hitCounts.get(String(r.id || '')) : null;
  const hits = (Number(r.hits) || 0) + (Number(h?.n) || 0);
  const lastHitAt = Math.max(Number(r.lastHitAt) || 0, Number(h?.lastAt) || 0);
  const born = Number(r.createdAt ? Date.parse(r.createdAt) : 0) || Number(r.toTs) || 0;
  // 惰性 = 距**最后一次被想起**（没被想起过就按出生算）
  const idleFrom = Math.max(lastHitAt, born) || born;
  const idleDays = idleFrom ? Math.max(0, ((Number(now) || Date.now()) - idleFrom) / 86400000) : 0;
  const curve = eventRetention({ idleDays, hits, days: retireDays, gain, rMin, hardRatio });
  const isRetired = Boolean(r.retiredAt);
  const isPromoted = Boolean(r.promotedAt);
  // `ADR-0048 ⑪`：三态由保持率**派生**，不额外持久化一个"当前状态"字段 ——
  // 派生的好处是排练一发生（lastHitAt 前移）它当轮就亮回来，不用等整理写盘。
  const state = isRetired ? 'retired' : isPromoted ? 'promoted' : curve.retention < rMin ? 'dimmed' : 'live';
  return {
    id: String(r.id || ''),
    chatKey: String(r.chatKey || ''),
    at: String(r.at || ''),
    toTs: Number(r.toTs) || 0,
    title: String(r.title || ''),
    summary: String(r.summary || '').slice(0, 160),
    hits,
    lastHitAt,
    idleDays: Math.round(idleDays),
    // 遗忘曲线（`ADR-0048` ⑩）：这条现在还记得多少 / 半衰期多长 / 额度多少天 / 还剩几天
    retention: Number(curve.retention.toFixed(3)),
    halfLifeDays: Number(curve.halfLifeDays.toFixed(1)),
    retireAfterDays: Number(curve.retireAfterDays.toFixed(1)),
    retireInDays: Math.round(curve.retireAfterDays - idleDays),
    // `ADR-0048 ⑪` 软回收：跌破 `rMin` 只是变暗，跌破 `rMin×hardRatio` 才彻底出索引
    retireHardAfterDays: Number(curve.retireHardAfterDays.toFixed(1)),
    retireHardInDays: Math.round(curve.retireHardAfterDays - idleDays),
    state,
    dimWeight: Number(eventDimWeight({ retention: curve.retention, rMin }).toFixed(3)),
    dimmedAt: String(r.dimmedAt || ''),
    // ── 可提取性 ≠ 事实可信度（从对方 `retention-model.js` 学来的分层）──────────
    // `accessibility` 只回答"现在还能不能想起来"，**随时间衰减**；
    // "当初说得对不对"（`factualConfidence`）只由来源与未解决冲突决定，**与时间无关**。
    // 两者混成一个数是最常见的误读：一条三周前的事 accessibility 很低，但它照样是真的。
    // ⚠️ 我们**没有**来源置信度与冲突检测数据 ⇒ 后者**不编造**，只声明未建模。
    accessibility: Number(curve.retention.toFixed(3)),
    confidenceBasis: 'not-modeled',
    promotedAt: String(r.promotedAt || ''),
    retiredAt: String(r.retiredAt || '')
  };
}

/** 事件 → 会话汇总（浏览页左侧列表用）：每个会话几条事、最近一条是什么。 */
function groupByChat(all) {
  const byChat = new Map();
  for (const r of all) {
    const key = String(r.chatKey || '');
    const cur = byChat.get(key) || { chatKey: key, count: 0, latestToTs: 0, latestTitle: '' };
    cur.count++;
    if ((Number(r.toTs) || 0) > cur.latestToTs) {
      cur.latestToTs = Number(r.toTs) || 0;
      cur.latestTitle = String(r.title || '');
    }
    byChat.set(key, cur);
  }
  return [...byChat.values()].sort((a, b) => b.latestToTs - a.latestToTs);
}

/**
 * 短期层的**体检报告** —— 回答三个问题：现在有多少事在短期里、哪些快升长期了、哪些被回收了。
 *
 * ⚠️ 这是**只读**接口：面板不该有"一键升级"这种手气按钮 —— 升降的判据只有排练次数，
 * 手点的那条没被真正想起过，塞进长期层就是污染（与 `ADR-0047` 的"门槛是行为不是配置"一致）。
 *
 * @param {object} o
 * @param {string} o.libDir
 * @param {number} [o.promoteHits=9]   升长期门槛（读配置，不在这里定死）
 * @param {number} [o.retireDays=30]   回收门槛
 * @param {number} [o.limit=8]         每个队列最多给几条
 * @param {string} [o.chatKey]         只看某个会话
 * @returns {object}
 */
export function workingLayerOverview({
  libDir, now = Date.now(), promoteHits = PROMOTE_HITS, retireDays = RETIRE_DAYS,
  limit = 8, chatKey = '', hitCounts = null,
  gain = RETIRE_HALFLIFE_GAIN, rMin = RETIRE_MIN_RECALL, hardRatio = RETIRE_HARD_RATIO
} = {}) {
  const gate = Math.max(1, Number(promoteHits) || PROMOTE_HITS);
  const ck = String(chatKey || '').trim();
  const { rows } = readEventRows({ libDir });

  const all = rows
    .filter((r) => !r.supersededBy && (!ck || String(r.chatKey || '') === ck))
    .map((r) => shapeWorkingRow(r, { hitCounts, now, retireDays, gain, rMin, hardRatio }));
  const live = all.filter((r) => !r.retiredAt);
  const retired = all.filter((r) => r.retiredAt);
  const promoted = live.filter((r) => r.promotedAt);
  const working = live.filter((r) => !r.promotedAt);
  // `ADR-0048 ⑪`：变暗 = 还没出索引，但已经被降权。单独成队，否则它混在"短期记忆里"
  // 的计数中，看不出"有多少条正在半死不活"。
  const dimmed = live.filter((r) => r.state === 'dimmed');

  const near = working
    .filter((r) => r.hits >= Math.ceil(gate * 0.6))
    .sort((a, b) => b.hits - a.hits || b.toTs - a.toTs);
  // 「快被回收」是**相对各自额度**的（额度随排练次数变长，不能再用统一的 0.7×retireDays）：
  // 剩不到额度 30% 的进队。`hits=0` 时额度就是 `retireDays` ⇒ 与旧口径（idleDays ≥ 0.7×30）等价。
  const idleSoon = working
    .filter((r) => r.retireInDays <= Math.max(1, Math.round(r.retireAfterDays * 0.3)))
    .sort((a, b) => a.retireInDays - b.retireInDays);
  const fresh = working.filter((r) => r.hits === 0).sort((a, b) => b.toTs - a.toTs);

  const cap = Math.max(1, Math.min(50, Number(limit) || 8));
  const hitsDist = {};
  for (const r of working) hitsDist[r.hits] = (hitsDist[r.hits] || 0) + 1;

  return {
    thresholds: {
      promoteHits: gate,
      retireDays: Number(retireDays) || RETIRE_DAYS,
      retireHalfLifeGain: Number(gain) || 0,
      retireMinRecall: Number(rMin) || RETIRE_MIN_RECALL,
      retireHardRatio: Number(hardRatio) || RETIRE_HARD_RATIO,
      retireDimWeight: RETIRE_DIM_WEIGHT
    },
    counts: {
      total: all.length,
      working: working.length,
      dimmed: dimmed.length,
      promoted: promoted.length,
      retired: retired.length,
      fresh: fresh.length
    },
    hitsDist,
    // 会话汇总（浏览页左侧列表）：每个会话几条事、最近一条是什么
    chats: groupByChat(all),
    queues: {
      nearPromote: near.slice(0, cap),
      idleSoon: idleSoon.slice(0, cap),
      fresh: fresh.slice(0, cap),
      dimmed: dimmed.sort((a, b) => a.retireHardInDays - b.retireHardInDays).slice(0, cap),
      promoted: promoted.sort((a, b) => b.toTs - a.toTs).slice(0, cap),
      retired: retired.sort((a, b) => b.toTs - a.toTs).slice(0, cap)
    }
  };
}

/**
 * 短期层的**全量浏览**（宿主记忆页复用，`ADR-0048` ⑨ 的分页版）。
 *
 * overview 每队列只给 top `limit`（体检够了，浏览不够）—— 这里按队列 / 会话 / 关键词
 * 过滤后分页给全量，口径（队列划分、曲线字段）与 overview **必须一致**，共用 `shapeWorkingRow`。
 *
 * @param {object} o
 * @param {string} [o.queue='all']  all / working / dimmed / promoted / retired / fresh / nearPromote / idleSoon
 * @param {string} [o.q='']         标题+摘要的子串过滤（大小写不敏感）
 * @param {number} [o.offset=0] [o.limit=50]  分页（limit 上限 200）
 * @returns {{total:number, items:object[]}}
 */
export function workingLayerItems({
  libDir, now = Date.now(), promoteHits = PROMOTE_HITS, retireDays = RETIRE_DAYS,
  chatKey = '', queue = 'all', q = '', offset = 0, limit = 50, hitCounts = null,
  gain = RETIRE_HALFLIFE_GAIN, rMin = RETIRE_MIN_RECALL, hardRatio = RETIRE_HARD_RATIO
} = {}) {
  const gate = Math.max(1, Number(promoteHits) || PROMOTE_HITS);
  const ck = String(chatKey || '').trim();
  const want = String(queue || 'all').trim();
  const needle = String(q || '').trim().toLowerCase();
  const { rows } = readEventRows({ libDir });
  let all = rows
    .filter((r) => !r.supersededBy && (!ck || String(r.chatKey || '') === ck))
    .map((r) => shapeWorkingRow(r, { hitCounts, now, retireDays, gain, rMin, hardRatio }));

  if (want === 'working') all = all.filter((r) => !r.retiredAt && !r.promotedAt);
  else if (want === 'promoted') all = all.filter((r) => !r.retiredAt && r.promotedAt);
  else if (want === 'retired') all = all.filter((r) => r.retiredAt);
  else if (want === 'dimmed') all = all.filter((r) => r.state === 'dimmed');
  else if (want === 'fresh') all = all.filter((r) => !r.retiredAt && !r.promotedAt && r.hits === 0);
  // 「快 xx」的口径与 overview 同一条（改一处必须改两处 —— 所以抽了 shapeWorkingRow 也别忘了这里）
  else if (want === 'nearPromote') all = all.filter((r) => !r.retiredAt && !r.promotedAt && r.hits >= Math.ceil(gate * 0.6));
  else if (want === 'idleSoon') all = all.filter((r) => !r.retiredAt && !r.promotedAt && r.retireInDays <= Math.max(1, Math.round(r.retireAfterDays * 0.3)));

  if (needle) all = all.filter((r) => `${r.title} ${r.summary}`.toLowerCase().includes(needle));
  all.sort((a, b) => b.toTs - a.toTs);

  const total = all.length;
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  return { total, items: all.slice(off, off + lim) };
}

// ── 排练计数（`ADR-0048` ⑥）─────────────────────────────────────────────
//
// 「排练」= 这条事件**真的进了 `/inject` 的最终 lines** 一次。只算这一种：
// `/search` 的返回、候选池里的命中都不算 —— 那只是"被索引扫到"，不是"被想起"。
// 这个区分是整套机制的承重点：算宽了，高频词会给一堆无关事件加分，9 次门槛形同虚设。
//
// ── 为什么单独一个 `hits.jsonl`（而不是原地改 events.jsonl）────
// `events.jsonl` 是 **append-only** 账本（断电/并发下只追加最安全，且历史可回溯）。
// 原地改行要重写整个文件：几千行 × 每轮注入都做一次 = 自找麻烦，还可能在写一半时断电
// 把账本写坏。所以增量单独记，读时聚合。
//
// 行格式两种（都认，省一次迁移）：
//   `{i:'evt_…', t:1712…}`             ← 一次排练（增量）
//   `{i:'evt_…', n:7, t:1712…}`        ← compact 之后的聚合行（n = 桶内累计）
/** 同一条事件在多少毫秒内**重复注入不重复计数**。 */
export const REHEARSAL_COOLDOWN_MS = 30 * 60_000;

/** 读排练日志 → `Map<id, {n, lastAt}>`。坏行只跳过（一次断电不能废掉整个统计）。 */
export function readHitLog({ libDir } = {}) {
  const p = consolidatePaths(libDir);
  const out = new Map();
  let badLines = 0;
  let lines = 0;
  try {
    if (!fs.existsSync(p.hits)) return { counts: out, lines, badLines, missing: true, file: p.hits };
    const all = fs.readFileSync(p.hits, 'utf8').split('\n');
    for (const line of all) {
      const s = line.trim();
      if (!s) continue;
      lines++;
      let row;
      try { row = JSON.parse(s); } catch { badLines++; continue; }
      const id = String(row?.i ?? row?.id ?? '').trim();
      if (!id) { badLines++; continue; }
      const n = Math.max(1, Math.floor(Number(row?.n) || 1));
      const t = Number(row?.t ?? row?.at) || 0;
      const cur = out.get(id) || { n: 0, lastAt: 0 };
      cur.n += n;
      if (t > cur.lastAt) cur.lastAt = t;
      out.set(id, cur);
    }
  } catch { return { counts: out, lines, badLines, missing: true, file: p.hits }; }
  return { counts: out, lines, badLines, missing: false, file: p.hits };
}

/**
 * 给这一轮真正注入了的事件各 +1（带冷却去重）。
 *
 * @param {object} o
 * @param {string[]} o.ids        本轮进了最终 lines 的事件 id
 * @param {number} [o.now]
 * @param {number} [o.cooldownMs] 默认 `REHEARSAL_COOLDOWN_MS`
 * @returns {{bumped:string[], skipped:number, reason?:string}}
 */
export function bumpEventHits({ libDir, ids = [], now = Date.now(), cooldownMs = REHEARSAL_COOLDOWN_MS } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!list.length) return { bumped: [], skipped: 0 };
  let p;
  try { p = consolidatePaths(libDir); } catch { return { bumped: [], skipped: list.length, reason: 'bad-libdir' }; }
  const { counts } = readHitLog({ libDir });
  const ts = Number(now) || Date.now();
  const cd = Math.max(0, Number(cooldownMs) || 0);
  const bumped = [];
  let skipped = 0;
  const rows = [];
  for (const id of list) {
    const prev = counts.get(id);
    // 冷却窗口内重复注入**不再计数**：连续几轮聊同一件事时，不该几十秒就攒满 9 次。
    if (prev && cd > 0 && ts - prev.lastAt < cd) { skipped++; continue; }
    rows.push(JSON.stringify({ i: id, t: ts }));
    bumped.push(id);
  }
  if (!rows.length) return { bumped, skipped };
  try {
    fs.mkdirSync(p.base, { recursive: true });
    fs.appendFileSync(p.hits, `${rows.join('\n')}\n`, 'utf8');
  } catch (err) {
    // 计不上排练次数只会让"升长期"慢一点，不该让整轮注入失败
    return { bumped: [], skipped: skipped + rows.length, reason: `append-failed: ${String(err?.message ?? err)}` };
  }
  return { bumped, skipped };
}

// ── 短期层的层维护：升长期（⑧）+ 惰性回收（⑦）───────────────────────────
//
// 两条判据都必须**先读完全量再判**（事件账本小，几千行，读一次几十毫秒），
// 因为"该不该升/该不该回收"取决于聚合后的 hits，逐行边读边写会拿到半截计数。

/** 排练多少次算"这个短期记忆已经变成长期记忆"（`ADR-0047` 的 9 次闸门）。 */
export const PROMOTE_HITS = 9;
/** 多少天没被排练就回收。**注意：这是 `hits===0` 的锚点**，不是一刀切（见 `eventRetention`）。 */
export const RETIRE_DAYS = 30;
/** 保持率低于这个值就算"忘了"。 */
export const RETIRE_MIN_RECALL = 0.1;
/** 每多一次排练，半衰期增长的倍率。**未校准** —— 库里还没有跨天排练的样本。 */
export const RETIRE_HALFLIFE_GAIN = 0.4;

// ── 软回收（`ADR-0048 ⑪`：从仿生记忆模块 v1.6.8 学到的 `forget(mode:'soft')` 闭环）──
//
// 旧行为是**二值**的：保持率一跌破 `rMin` 就打 `retiredAt` ⇒ `buildEventIndex` 直接
// `dropped++` ⇒ 检索永远看不到它。磁盘上的行还在（"只标记不删"），但**可检索性**被
// 一起删掉了 —— 于是"记过却想不起来"这个核心抱怨，有一半是我们自己造成的：
// 一条真的被问到、本该捞回来的事，只因为 30 天没人提就被判了死刑。
//
// 改成**三态**：
//   live    （保持率 ≥ rMin）                  ⇒ 权重 1
//   dimmed  （rMin > 保持率 ≥ rMin×hardRatio） ⇒ 权重 `RETIRE_DIM_WEIGHT`，**仍在索引里**
//   retired （保持率 < rMin×hardRatio）        ⇒ 出索引（旧行为）
// 并且 dimmed 一旦**真的被想起来**（排练使保持率回升过 rMin）就在下次整理时复活。
// 这才让"遗忘"成为一个**可逆的深浅问题**，而不是一个删除开关。

/** 变暗之后在关键词索引里的权重倍率（对标对方 `forget(soft)` 的 factor=0.3）。 */
export const RETIRE_DIM_WEIGHT = 0.3;
/** 保持率跌到 `rMin` 的这个比例才彻底出索引。`0.3` ⇒ hits=0 时约在变暗后再过 15.7 天。 */
export const RETIRE_HARD_RATIO = 0.3;

/**
 * 变暗行的检索权重。
 *
 * ⚠️ 不用"跌破就固定 ×0.3"，而是**按保持率连续取值**：刚跌破一点点的事物不该
 * 立刻被重罚（它只是"有点久没提"），而快降到硬阈值的才该接近消失。
 * 这条同时让"变暗"在面板上是一条可见的下坡，而不是一个突然的开关。
 *
 * @returns {number} `1`（没暗）… `RETIRE_DIM_WEIGHT`（跌破即封顶到这个值）
 */
export function eventDimWeight({ retention = 1, rMin = RETIRE_MIN_RECALL, floor = RETIRE_DIM_WEIGHT } = {}) {
  const r = Number(retention);
  if (!Number.isFinite(r) || r <= 0) return Math.max(0.01, Number(floor) || RETIRE_DIM_WEIGHT);
  const gate = Math.min(0.99, Math.max(0.01, Number(rMin) || RETIRE_MIN_RECALL));
  if (r >= gate) return 1;
  const f = Math.max(0.01, Math.min(1, Number(floor) || RETIRE_DIM_WEIGHT));
  return Math.max(f, r / gate);
}

/**
 * 遗忘曲线：距最后一次被想起 `idleDays` 天之后，这条事件还"记得"多少。
 *
 *     R(Δ) = exp(-Δ / H)，H = H₀ · (1 + gain · hits)，H₀ = days / ln(1 / rMin)
 *
 * **锚点**（向后兼容的全部依据）：`hits === 0` 且 `Δ = days` 时 `R = rMin` —— 也就是
 * "一次都没被想起过的事，正好在第 `days` 天被回收"，与改造前的固定阈值**逐位等价**。
 *
 * ⚠️ 必须知道的代数事实：在这个参数化下，解 `R = rMin` 得到
 * `Δ = days · (1 + gain · hits)` —— `rMin` 被约掉了。也就是说**判据本身等价于
 * "每多一次排练，额度多 `gain × days` 天"**，指数形状在"该不该回收"上不产生额外行为。
 * 曲线真正独立的作用只有一个：**给出连续的强度值**（管理页显示、将来的排序权重）。
 * 想吃到真正的间隔效应（spacing effect），得让 H 依赖**排练间隔**而不是次数 ⇒
 * 需要完整的排练时间序列（当前 `compactHitLog` 会丢掉中间时刻），属后续层。
 *
 * @param {object} o
 * @param {number} [o.idleDays=0]  距最后一次被想起的天数（没被想起过 = 距出生）
 * @param {number} [o.hits=0]      排练次数
 * @param {number} [o.days=30]     锚点天数（`hits=0` 的回收天数）
 * @param {number} [o.gain=0.4]    每次排练的半衰期增益
 * @param {number} [o.rMin=0.1]    回收阈值（跌破 ⇒ **变暗**，不再直接出索引）
 * @param {number} [o.hardRatio=0.3] 硬回收阈值 = `rMin × hardRatio`
 * @returns {{retention:number, halfLifeDays:number, retireAfterDays:number, retireHardAfterDays:number}}
 */
export function eventRetention({
  idleDays = 0, hits = 0,
  days = RETIRE_DAYS, gain = RETIRE_HALFLIFE_GAIN, rMin = RETIRE_MIN_RECALL,
  hardRatio = RETIRE_HARD_RATIO
} = {}) {
  const base = Math.max(1, Number(days) || RETIRE_DAYS);
  const r = Math.min(0.99, Math.max(0.01, Number(rMin) || RETIRE_MIN_RECALL));
  const g = Math.max(0, Number(gain) || 0);
  const n = Math.max(0, Math.floor(Number(hits) || 0));
  const lnInv = Math.log(1 / r);                    // rMin=0.1 ⇒ 2.3026
  const halfLife = (base / lnInv) * (1 + g * n);    // 锚点：n=0 时 H = base / lnInv
  // 硬回收：解 R = rMin·hardRatio ⇒ Δ = H·ln(1/(rMin·hardRatio))。
  // 与 `retireAfterDays` 只差一个 ln 因子 ⇒ 两者之间的天数就是"变暗后的观察期"。
  const hard = Math.min(0.99, Math.max(0.001, r * Math.max(0.01, Math.min(1, Number(hardRatio) || RETIRE_HARD_RATIO))));
  return {
    retention: Math.exp(-(Math.max(0, Number(idleDays) || 0)) / halfLife),
    halfLifeDays: halfLife,
    retireAfterDays: halfLife * lnInv,               // = base · (1 + gain·hits)
    retireHardAfterDays: halfLife * Math.log(1 / hard)
  };
}

/** 原子重写事件账本（`tmp` + `rename`；断电时要么旧的要么新的，不会半截）。 */
function writeEventRows({ libDir, rows }) {
  const p = consolidatePaths(libDir);
  fs.mkdirSync(p.base, { recursive: true });
  const tmp = `${p.events}.tmp`;
  fs.writeFileSync(tmp, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, p.events);
}

/**
 * 升长期（`ADR-0048` ⑧）：排练满 `threshold` 次的事件 ⇒ 建向量。
 *
 * **"巩固"的含义只到这里**（`ADR-0047`）：获得向量 + 打 `promotedAt` 停止回收倒计时。
 * 不做第二次 LLM 抽象（窗口整理已经产过印象，再提炼一次是重复劳动且两次结果会打架），
 * 也**不写 `fact_kind='event'` 的事实槽** —— 那个槽是"关于某人的一件事"，与短期层
 * 这条事件没有对应关系，硬塞会把它的单值内容顶掉。
 *
 * @returns {{promoted:number, failed:number, ids:string[], reason?:string}}
 */
export async function promoteEvents({ libDir, store, settings = {}, normalizer = null, now = Date.now(), threshold = PROMOTE_HITS, say = null } = {}) {
  const out = { promoted: 0, failed: 0, ids: [], reason: '' };
  if (!store) { out.reason = 'no-store'; return out; }
  if (!settings.embedBaseURL || !settings.embedModel) { out.reason = 'embed-unconfigured'; return out; }
  // 归一化器是**出境闸门**，不是可选项：`buildEmbedText` 会拒绝空 normalizer
  // （"把带 QQ 号与群名片的块直接送云端"）。缺了就明确说，别逐条失败刷日志。
  if (!normalizer) { out.reason = 'no-normalizer'; return out; }
  const { counts } = readHitLog({ libDir });
  const { rows } = readEventRows({ libDir, strict: true });
  const patch = new Map();
  for (const r of rows) {
    if (r.promotedAt || r.retiredAt || r.supersededBy) continue;
    const h = counts.get(String(r.id || ''));
    const n = (Number(r.hits) || 0) + (Number(h?.n) || 0);
    if (n < Math.max(1, Number(threshold) || PROMOTE_HITS)) continue;
    try {
      await embedEventRow(r, { store, settings, normalizer });
      patch.set(String(r.id), new Date(now).toISOString());
      out.promoted++; out.ids.push(String(r.id));
    } catch (err) {
      out.failed++;
      // 一条失败不该连累其它条：下次整理会再试（`promotedAt` 没写上）
      if (typeof say === 'function') say('warn', `事件升长期失败（${r.id}）：${String(err?.message ?? err)}`);
    }
  }
  if (patch.size) {
    // Embedding awaits external IO: merge into the latest complete ledger, never the old snapshot.
    const latest = readEventRows({ libDir, strict: true }).rows;
    writeEventRows({ libDir, rows: latest.map((r) => (patch.has(String(r.id)) && !r.retiredAt && !r.supersededBy ? { ...r, promotedAt: patch.get(String(r.id)) } : r)) });
  }
  return out;
}

/**
 * 惰性回收（`ADR-0048` ⑦ + ⑩ 遗忘曲线；`ADR-0048 ⑪` 改为**软回收三态**）。
 *
 * 判据从"固定 `days` 天"改成走 `eventRetention`：**`hits` 越多，半衰期越长，活得越久**。
 *
 * `ADR-0048 ⑪` 起分两刀（常量说明见 `RETIRE_DIM_WEIGHT`）：
 *   保持率 < `rMin`                 ⇒ 打 `dimmedAt`（**变暗**，仍在索引里，权重下降）
 *   保持率 < `rMin × hardRatio`     ⇒ 打 `retiredAt`（出索引，= 旧的回收）
 *   已经 `dimmedAt` 但保持率回升过 `rMin`（被真的想起来了）⇒ **复活**（清掉 `dimmedAt`）
 *
 * ⚠️ 复活是这套机制的另一半：没有它，"变暗"就只是把死刑推迟几天执行。
 * 有了它，一条被重新提起的旧事会自己亮回来 —— 这才是"遗忘应该是可逆的深浅问题"。
 *
 * **只打标记，不删数据**：删了不可逆，而标记能回答"这条为什么没了"。
 * 已升长期（`promotedAt`）的不回收 —— 升长期的定义就是"停止回收倒计时"。
 *
 * @param {object} o
 * @param {number} [o.gain]      每次排练的半衰期增益（未校准）
 * @param {number} [o.rMin]      变暗阈值
 * @param {number} [o.hardRatio] 硬回收阈值 = `rMin × hardRatio`
 * @returns {{dimmed:number, revived:number, retired:number, ids:string[], dimmedIds:string[], revivedIds:string[]}}
 */
export function retireStaleEvents({
  libDir, days = RETIRE_DAYS, now = Date.now(), hitCounts = null,
  gain = RETIRE_HALFLIFE_GAIN, rMin = RETIRE_MIN_RECALL, hardRatio = RETIRE_HARD_RATIO
} = {}) {
  const counts = hitCounts instanceof Map ? hitCounts : readHitLog({ libDir }).counts;
  // ⚠️ 别把这个叫 `r`：下面 `rows.map((r) => …)` 里的 `r` 是事件行，同名会把
  // `retention >= r` 变成"跟对象比大小"（恒 false ⇒ 全部误回收）。
  const minRecall = Math.min(0.99, Math.max(0.01, Number(rMin) || RETIRE_MIN_RECALL));
  const hardRecall = Math.min(minRecall, minRecall * Math.max(0.01, Math.min(1, Number(hardRatio) || RETIRE_HARD_RATIO)));
  const { rows } = readEventRows({ libDir, strict: true });
  const ids = [];
  const dimmedIds = [];
  const revivedIds = [];
  let changed = false;
  const next = rows.map((r) => {
    if (r.retiredAt || r.supersededBy || r.promotedAt) return r;
    const h = counts.get(String(r.id || ''));
    const born = Date.parse(String(r.createdAt || '')) || 0;
    const last = Math.max(
      Number(r.lastHitAt) || 0, Number(h?.lastAt) || 0,
      born, Number(r.toTs) || 0
    );
    const hits = (Number(r.hits) || 0) + (Number(h?.n) || 0);
    // 时钟回拨 / `toTs` 在未来 ⇒ idleDays 为负 ⇒ retention > 1 ⇒ 不回收（安全侧）
    const idleDays = (Number(now) - last) / 86_400_000;
    const { retention } = eventRetention({ idleDays, hits, days, gain, rMin: minRecall, hardRatio });

    if (retention >= minRecall) {
      // 复活：曾经变暗，但这一轮之前被真的想起过（lastHitAt 前移 ⇒ idleDays 变小）
      if (r.dimmedAt) {
        const { dimmedAt, ...rest } = r;
        revivedIds.push(String(r.id));
        changed = true;
        return rest;
      }
      return r;
    }
    if (retention < hardRecall) {
      ids.push(String(r.id));
      changed = true;
      return { ...r, retiredAt: new Date(now).toISOString() };
    }
    if (r.dimmedAt) return r;                       // 已经记过暗，不重复写盘
    dimmedIds.push(String(r.id));
    changed = true;
    return { ...r, dimmedAt: new Date(now).toISOString() };
  });
  if (changed) writeEventRows({ libDir, rows: next });
  return {
    dimmed: dimmedIds.length, revived: revivedIds.length, retired: ids.length,
    ids, dimmedIds, revivedIds
  };
}

/** 把增量日志压成"每条事件一行"（`{i,n,t}`）。太大时才调，见 `hitLogLines()`。 */
export function compactHitLog({ libDir } = {}) {
  const p = consolidatePaths(libDir);
  const { counts, lines } = readHitLog({ libDir });
  if (!lines) return { compacted: 0, before: 0 };
  const rows = [...counts.entries()]
    .sort((a, b) => a[1].lastAt - b[1].lastAt)
    .map(([i, v]) => JSON.stringify({ i, n: v.n, t: v.lastAt }));
  const tmp = `${p.hits}.tmp`;
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(tmp, rows.length ? `${rows.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, p.hits);
  return { compacted: rows.length, before: lines };
}

// ── 落库：人物印象 ───────────────────────────────────────────────────────
/**
 * QQ 号 → 占位符。**认不出就返回 null**，绝不退回昵称：
 * 昵称会变、会撞车，写进去的槽会挂在一个谁也认不出的人身上。
 */
export function resolveSpeaker(normalizer, qq) {
  const rawId = String(qq ?? '').trim();
  const id = rawId.replace(/^qq:/, '');
  if (!rawId || rawId.length > 200) return null;
  try {
    const hit = normalizer?.resolveKnown?.(rawId) || normalizer?.resolveKnown?.(id) || normalizer?.resolveKnown?.(`qq:${id}`);
    if (hit?.label) return { label: hit.label, qq: id, kind: hit.kind || '' };
  } catch { /* 词表异常按"认不出"处理 */ }
  return null;
}

// ⚠️ 2026-10-22：本地曾有一份 `normalizeTraitKey`（`trim().toLowerCase()`），注释写着
// "与 router 的 remember 同口径" —— **它不是**。router/inject 那份还做全角冒号折算与
// 别名归并（"工作"→职业），本地这份没有 ⇒ 整理写"工作"、直写写"职业"，两条并存。
// 已删除，统一从 `inject.mjs` 取（同一份实现，别再抄第二份）。

// ── 主流程 ───────────────────────────────────────────────────────────────

/**
 * 一档**维护步骤**：先升长期、再回收过期事件（`ADR-0048` ⑦⑧）。
 *
 * ── 为什么要单独抽出来 ────────────────────────────────────────────────────
 * 上一版把它写在 `runConsolidate` 的**函数尾部**，于是它只在"这一轮真的整理了窗口"
 * 之后才跑。后果不是"少跑几次"，而是**方向性的错**：
 *   · 一个几小时没人说话的库 ⇒ 没有新窗口 ⇒ 永远不升长期、永远不回收；
 *   · 而遗忘曲线的全部意义正是"没人说话的时候它也在变淡"。
 * 换句话说：越冷清的会话越不会被回收，越热闹的越会被维护 —— 与设计意图相反。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────
 * ① **不新建定时器**：跟着整理一起跑（都是"每小时一次、几秒钟"的事）。
 * ② **不调模型**：升长期要的是**嵌入端点**（`promoteEvents` 自己会说 `embed-unconfigured`），
 *    回收是纯时间函数。所以"没配 LLM"不该连维护一起停。
 * ③ **顺序固定 先升再回收** —— 反过来会把这一轮刚攒满门槛的条先回收掉。
 * ④ **异常留在结果里**：抛错记成 `reason: 'threw: …'`，不吞成 `0 条` 的成功计数
 *    （`0 条` 是"跑过了、没有该处理的"，`threw` 是"根本没跑成" —— 两者意义相反）。
 * ⑤ **`dryRun` 一律不跑**：这两个步骤都会写账本，dry 的承诺是"一个字节都不改"。
 *
 * @param {object} o
 * @param {string} o.libDir
 * @param {object} [o.store]        向量库（升长期要写向量；缺了只记 `no-store`）
 * @param {object} [o.settings]
 * @param {object} [o.normalizer]
 * @param {number} [o.now]          固定时钟（测试用；生产不传）
 * @param {boolean} [o.dryRun]
 * @param {(level:string,msg:string)=>void} [o.say]
 * @returns {Promise<{promotion:object, retirement:object}|null>} `null` = 这一轮不该跑维护
 */
export async function runLayerMaintenance({
  libDir, store, settings = {}, normalizer = null, now = Date.now(), dryRun = false, say = null
} = {}) {
  if (dryRun) return null;                        // 纪律 ⑤
  if (settings.layerMaintenance === false) return null;
  const out = {};
  try {
    out.promotion = await promoteEvents({
      libDir, store, settings, normalizer, now, threshold: settings.promoteHits, say
    });
  } catch (err) {
    out.promotion = { promoted: 0, failed: 0, ids: [], reason: `threw: ${String(err?.message ?? err)}` };
  }
  try {
    out.retirement = retireStaleEvents({
      libDir, now, days: settings.retireDays,
      // ⚠️ `0` 是**合法值**（"不因排练延长半衰期"）。用 `||` 折成默认值会让
      //    "我明确关掉了延长" 静默变成 "我用了默认的延长" —— 配置读起来还对。
      gain: numOr0(settings.retireHalfLifeGain, RETIRE_HALFLIFE_GAIN),
      rMin: numOr(settings.retireMinRecall, RETIRE_MIN_RECALL),
      hardRatio: numOr(settings.retireHardRatio, RETIRE_HARD_RATIO)
    });
  } catch (err) {
    out.retirement = { dimmed: 0, revived: 0, retired: 0, ids: [], dimmedIds: [], revivedIds: [], reason: `threw: ${String(err?.message ?? err)}` };
  }
  return out;
}

/**
 * 跑一轮整理。
 *
 * @param {object} deps
 * @param {string} deps.sourceRoot   宿主 data 根（只读，读 `memory/evidence.jsonl`）
 * @param {string} deps.libDir       本库根（`<DATA_DIR>/memory-vec`）
 * @param {object} deps.settings     运行期设置
 * @param {object} deps.normalizer   共享归一化器
 * @param {object} deps.factStore    factstore 实例（写人物印象）
 * @param {object} [deps.store]      向量库（写事件向量；缺了只影响检索，不影响落盘）
 * @param {(o:{system:string,user:string})=>Promise<string>} deps.callLlm  LLM 调用（返回文本）
 * @param {object} [opts]            `{ dryRun, limit, chatKey, now }`
 */
const consolidateRuns = new Map();
export async function runConsolidate(deps = {}, opts = {}) {
  const key = path.resolve(deps.libDir);
  const prior = consolidateRuns.get(key) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => runConsolidateOnce(deps, opts));
  consolidateRuns.set(key, run);
  try { return await run; } finally { if (consolidateRuns.get(key) === run) consolidateRuns.delete(key); }
}

function pendingPath(libDir) { return path.join(consolidatePaths(libDir).base, 'pending-windows.json'); }
function readPending(libDir) {
  const file = pendingPath(libDir);
  if (!fs.existsSync(file)) return {};
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pending || Array.isArray(pending) || typeof pending !== 'object') throw new Error('Invalid pending window journal');
  return pending;
}
function savePending(libDir, pending) {
  const file = pendingPath(libDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(pending), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

/**
 * 只读：尚未提交的窗口清单（证据核对用）。[by:DS] 2026-10-29
 *
 * 为什么要有这个只读出口：窗口提交之后**本身不留档**（内容早被抽成事实/事件），
 * 所以"这个 window 引用还找得到吗"只能看两处 —— pending 里的（还没提交）
 * 与事件账本里 `windowId` 指向它的（已提交，有摘要可查）。这里只解决前一处。
 *
 * ⚠️ **绝不写盘、绝不建目录**：`readPending` 只在文件存在时读，
 *    而 `savePending` 才会 `mkdir` —— 证据核对绝不能顺手把库"创建"出来。
 */
export function readPendingWindows({ libDir } = {}) {
  try {
    const pending = readPending(libDir);
    const windows = Object.values(pending).map((p) => p?.win).filter((w) => w && w.chatKey);
    return { ok: true, windows, error: null };
  } catch (error) {
    return { ok: false, windows: [], error: String(error?.message || error) };
  }
}

async function runConsolidateOnce(deps = {}, opts = {}) {
  const {
    sourceRoot, libDir, settings = {}, normalizer, factStore, store = null, callLlm, log = null
  } = deps;
  const say = typeof log === 'function' ? log : () => {};
  const now = Number(opts.now) || Date.now();
  const dryRun = opts.dryRun === true;
  const limit = Math.max(1, Number(opts.limit) || Number(settings.consolidateMaxWindowsPerRun) || 3);

  const result = {
    ok: false,
    at: now,
    dryRun,
    windows: 0,
    processed: 0,
    events: 0,
    slots: 0,
    skippedPeople: 0,
    failedWindows: 0,
    skippedWindows: 0,      // 连续失败达上限、被认输跳过的窗口（不是静默丢弃，见 `noteWindowFailure`）
    salvagedWindows: 0,     // 输出被截断、靠抢救解析挽回的窗口
    details: [],
    error: ''
  };

  const evidence = readEvidenceRows({ sourceRoot });
  if (evidence.missing) {
    // ── "读不到宿主的消息账本" ≠ "这一轮什么都别做" ────────────────────────
    // `[by:DS] 2026-10-29` 上一版在这里整轮 `return`：挑窗口确实依赖这本账（不知道有哪些
    // 新消息，就不该猜），但**层维护完全不用它** —— 升长期看事件账本 + 命中日志，
    // 回收看事件账本 + 时间。于是"宿主账本没配好 / 坏了"能把整条遗忘曲线一起冻住，
    // 与"没人说话就不变淡"是同一个错（见 ADR-0054）。
    //
    // 所以：**不挑窗口**（不猜），**维护照跑**（该淡的照淡），并把降级明说。
    // 不能用 `error` 报这件事 —— 那是"整轮失败"的字段，会让面板显示成一条都没做；
    // 用 `degraded` 才准确：跑完了，但少了一半活。
    result.ok = true;
    result.windows = 0;
    result.evidenceMissing = true;
    result.degraded = {
      code: 'EVIDENCE_MISSING',
      retryable: true,
      message: `读不到 evidence 账本：${evidence.file}（sourceRoot=${sourceRoot || '(空)'}）`
    };
    result.note = '宿主的消息账本读不到 ⇒ 这一轮不挑新窗口（不知道有哪些消息，不猜），但层维护照跑';
    const layer = await runLayerMaintenance({ libDir, store, settings, normalizer, now, say, dryRun });
    if (layer) { Object.assign(result, layer); result.maintenance = { ran: true, dryRun: false }; }
    else result.maintenance = { ran: false, dryRun, reason: dryRun ? 'dry-run' : 'layerMaintenance=false' };
    return result;
  }
  result.evidenceRows = evidence.rows.length;
  result.badLines = evidence.badLines;

  const state = loadConsolidateState({ libDir });
  const pending = readPending(libDir);
  const retries = Object.values(pending).filter(p => p?.win && Number(state.chats?.[p.win.chatKey]?.lastTs || 0) < p.win.toTs
    && (!opts.chatKey || opts.chatKey === p.win.chatKey));
  const retryChats = new Set(retries.map(p => p.win.chatKey));
  const windows = [...retries.map(p => p.win), ...pickWindows({
    rows: evidence.rows.filter(r => !retryChats.has(String(r.chatKey || ''))),
    state,
    maxMsgs: numOr(settings.consolidateWindowMsgs, 120),
    maxSpanMs: numOr(settings.consolidateWindowSpanMin, 120) * MIN_MS,
    settleMs: numOr0(settings.consolidateSettleMin, 3) * MIN_MS,
    limit,
    now,
    chatKey: opts.chatKey || ''
  })].slice(0, limit);
  result.windows = windows.length;
  // ── 没有新窗口 **不等于** 没有活干 ────────────────────────────────────────
  // 上一版在这里直接 return，于是"几小时没人说话"的库永远不升长期、永远不回收 ——
  // 而遗忘曲线的全部意义就是"没人说话的时候也在变淡"。维护与模型无关，必须照跑。
  if (!windows.length) {
    result.ok = true;
    result.note = '没有可整理的窗口（游标之后没有已沉淀的消息）';
    const layer = await runLayerMaintenance({ libDir, store, settings, normalizer, now, say, dryRun });
    if (layer) { Object.assign(result, layer); result.maintenance = { ran: true, dryRun: false }; }
    else result.maintenance = { ran: false, dryRun, reason: dryRun ? 'dry-run' : 'layerMaintenance=false' };
    return result;
  }
  if (typeof callLlm !== 'function' && windows.some(win => !pending[win.chatKey])) {
    result.error = '没有可用的 LLM 调用入口（callLlm 缺失）—— 整理必须调模型，不能降级成"假装整理过"';
    // 明确的机器可读标记：调用方（`runConsolidateNow`）据此把它当成"缺配置"而不是
    // "跑了但失败"（前者是 400 让你去补设置，后者是 200 + 逐窗错误）。
    result.llmMissing = true;
    // 模型没配不该连"按时间变淡"一起停：维护不调模型（升长期要嵌入端点，缺了它自己会说明）。
    const layer = await runLayerMaintenance({ libDir, store, settings, normalizer, now, say, dryRun });
    if (layer) { Object.assign(result, layer); result.maintenance = { ran: true, dryRun: false }; }
    else result.maintenance = { ran: false, dryRun, reason: dryRun ? 'dry-run' : 'layerMaintenance=false' };
    return result;
  }

  const blockedChats = new Set();
  for (const win of windows) {
    if (blockedChats.has(win.chatKey)) continue;
    const saved = pending[win.chatKey];
    const resume = saved?.win?.fromTs === win.fromTs && saved?.win?.toTs === win.toTs ? saved : null;
    const transcript = renderTranscript(win.rows, { fromTs: win.fromTs, maxChars: TRANSCRIPT_MAX_CHARS });
    if (!resume && !transcript.trim()) {
      // 全是空消息（贴纸/撤回）：**必须推进游标**，否则每一轮都在同一个空窗口上打转
      if (!dryRun) advanceCursor({ libDir, state, chatKey: win.chatKey, toTs: win.toTs });
      result.details.push({ chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, msgCount: win.msgCount, skipped: 'empty-transcript' });
      result.processed++;
      continue;
    }

    let raw = '';
    try {
      const prompt = buildConsolidatePrompt({
        chatKey: win.chatKey,
        chatLabel: opts.chatLabel || '',
        fromTs: win.fromTs,
        toTs: win.toTs,
        msgCount: win.msgCount,
        transcript
      });
      if (isCanonicalSource(sourceRoot)) {
        prompt.system = prompt.system.replaceAll('QQ 号','主体 ID').replaceAll('号码','主体 ID').replaceAll('qq 必须','actorId 必须').replaceAll('\"qq\"','\"actorId\"');
        prompt.system += '\n主体标识可以是任意字符串。people 使用 actorId，必须逐字复制下方允许的 actorId；不得猜测新身份。';
        prompt.user += '\n允许 actorId：'+JSON.stringify([...new Set(win.rows.map(r=>r.speakerId))]);
      }
      if (settings.subjectMemoryEnabled === true && !resume) {
        const subjectStore = openSubjectStore(libDir);
        const mentioned = subjectStore.matchingSubjectIds({scope:normalizer.scopeLabel(win.chatKey),text:transcript});
        const subjects = subjectStore.list().filter(s=>mentioned.has(s.id));
        prompt.system += '\n可额外输出 observations:[{subjectRef,aspect,statement,claimType,reporterId?,evidenceIds:[]}]。claimType 仅 fact/opinion/pattern；subjectRef 仅下方登记 ID 或群聊的 current-group。只记有证据的观察，不推断群体共识，不把观察挂在人身上。没有观察给空数组。';
        prompt.user += '\n允许主体：'+JSON.stringify(subjects.map(s=>({id:s.id,label:s.label,aliases:s.aliases})))+
          '\n以下引用编号只用于 observations.evidenceIds：\n'+win.rows.map(r=>'[evidenceId='+r.id+'] '+renderTranscript([r],{fromTs:win.fromTs,maxChars:1000})).join('\n');
      }
      raw = resume ? JSON.stringify(resume.parsed) : await callLlm(prompt);
    } catch (err) {
      const msg = `LLM 调用失败：${String(err?.message ?? err)}`;
      const f = dryRun ? { skipped: false, count: 0 } : noteWindowFailure({ libDir, state, chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, error: msg, now });
      if (!f.skipped) blockedChats.add(win.chatKey);
      result.failedWindows++;
      result.details.push({
        chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, error: msg,
        ...(f.skipped ? { skipped: `failed-${f.count}x` } : {})
      });
      if (f.skipped) result.skippedWindows++;
      continue;                       // 未达上限 ⇒ 游标不推进 ⇒ 下一轮重试这一段
    }

    const parsed = parseConsolidateJson(raw, {genericIds:isCanonicalSource(sourceRoot)});
    if (!parsed.ok) {
      const f = dryRun ? { skipped: false, count: 0 } : noteWindowFailure({ libDir, state, chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, error: parsed.error, now });
      if (!f.skipped) blockedChats.add(win.chatKey);
      result.failedWindows++;
      result.details.push({
        chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, error: parsed.error,
        rawHead: String(raw || '').slice(0, 200),
        ...(f.skipped ? { skipped: `failed-${f.count}x` } : {})
      });
      if (f.skipped) result.skippedWindows++;
      continue;
    }
    if (parsed.salvaged) {
      // 截断抢救不是"正常"，它意味着这一段**只记下了前面的事**，后面被 maxTokens 切掉了。
      // 说出来，别让面板以为一切顺利。
      say?.('warn', `窗口 ${win.chatKey} ${stampOf(win.fromTs)} 的输出被截断，抢救出 `
        + `${parsed.events.length} 件事 / ${parsed.people.length} 条印象（后续内容丢失）`);
      result.salvagedWindows++;
    }
    if (!dryRun) clearWindowFailure({ state, chatKey: win.chatKey, fromTs: win.fromTs });
    if (dryRun) {
      result.details.push({
        chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, msgCount: win.msgCount,
        dryRun: true, events: parsed.events, people: parsed.people, observations: parsed.observations || []
      });
      result.processed++;
      continue;
    }

    let applied;
    try {
      // Freeze the result before any partial write. A retry reuses it, even if new messages arrive.
      if (!resume) {
        if (parsed.observations?.length && settings.subjectMemoryEnabled !== true) throw new Error('Subject extraction is not enabled');
        const observationRequests = parsed.observations?.length ? openSubjectStore(libDir).prepareWindow({win,windowId:eventIdOf(win),scope:normalizer.scopeLabel(win.chatKey),candidates:parsed.observations,allowedSubjectIds:openSubjectStore(libDir).matchingSubjectIds({scope:normalizer.scopeLabel(win.chatKey),text:transcript}),
          resolveReporter:id=>resolveSpeaker(normalizer,id)?.label || null,
          normalize:text=>normalizer.normalize(String(text||''),{context:'subject-observation',register:false})?.text || String(text||'')}) : [];
        pending[win.chatKey] = { win: { ...win, rows: win.rows.map(r => ({ id: r.id })) }, parsed, observationRequests, now };
        savePending(libDir, pending);
      }
      applied = await applyWindow({ win, parsed, normalizer, factStore, store, settings, libDir, now: resume?.now || now, say });
      if (applied.errors.length) throw new Error(applied.errors.join('; '));
      const observationRequests = pending[win.chatKey]?.observationRequests || [];
      if (parsed.observations?.length && !observationRequests.length) throw new Error('Pending observations have no prepared requests');
      if (observationRequests.length) openSubjectStore(libDir).applyPrepared(observationRequests,win,normalizer.scopeLabel(win.chatKey));
      advanceCursor({ libDir, state, chatKey: win.chatKey, toTs: win.toTs });
      delete pending[win.chatKey];
      try { savePending(libDir, pending); } catch (e) { say('warn', `已提交窗口的重试记录清理失败：${e.message}`); }
    } catch (error) {
      // Storage failures are never auto-skipped: partial output must remain retryable.
      blockedChats.add(win.chatKey);
      result.failedWindows++;
      result.details.push({ chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, error: String(error?.message || error), retryable: true });
      continue;
    }
    result.events += applied.events;
    result.slots += applied.slots;
    result.skippedPeople += applied.skippedPeople;
    result.processed++;
    result.details.push({
      chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, msgCount: win.msgCount,
      events: applied.events, slots: applied.slots, skippedPeople: applied.skippedPeople,
      eventId: applied.eventId, titles: applied.titles
    });
  }

  result.ok = result.failedWindows === 0;
  if (!result.ok) result.error = `${result.failedWindows} 个窗口失败（游标未推进，下次重试）`;

  // ── 层维护（`ADR-0048` ⑦⑧）──────────────────────────────────────────────
  // 与"没有窗口"那条分支**共用同一份实现**（`runLayerMaintenance`）——
  // 上一版把这段内联在这里，于是另一条分支就"忘了"维护。
  const layer = await runLayerMaintenance({ libDir, store, settings, normalizer, now, say, dryRun });
  if (layer) { Object.assign(result, layer); result.maintenance = { ran: true, dryRun: false }; }
  else result.maintenance = { ran: false, dryRun, reason: dryRun ? 'dry-run' : 'layerMaintenance=false' };
  return result;
}

function advanceCursor({ libDir, state, chatKey, toTs }) {
  const cur = state.chats[chatKey] || {};
  const prev = Number(cur.lastTs) || 0;
  if (Number(toTs) > prev) cur.lastTs = Number(toTs);
  cur.lastRunAt = Date.now();
  state.chats[chatKey] = cur;
  saveConsolidateState({ libDir, state });
}

/**
 * 同一个窗口连续失败几次后**跳过**（推进游标）。
 *
 * ── 为什么必须有 ──────────────────────────────────────────────────────────
 * 失败的判据是"游标不推进 ⇒ 下轮重试"，那是**对偶然故障**（模型 5xx、网络抖）正确的
 * 处理。但对**必然故障**（这一段的原文里有个模型永远吐不出合法 JSON 的东西）它是
 * 灾难：每轮都重试同一个窗，**后面所有窗口永远轮不到** —— 一个坏窗堵死一整条会话。
 * 实测主号 30 窗里 2 窗（6.7%）会撞上，其中一个是截断（`salvageJsonObjects` 能救），
 * 另一个模型吐空 —— 后者只能靠"认输跳过"解开。
 *
 * ⚠️ 跳过**不是**静默丢弃：失败次数与最后一次的错误都留在 `state.chats[ck].fails`
 * 里，面板读得到、能单独重跑。
 */
export const WINDOW_FAIL_SKIP = 3;

/** 失败表最多留几个窗口（state.json 不能被失败窗口撑大）。 */
const FAIL_LOG_MAX = 20;

const failKeyOf = (fromTs) => String(Math.floor(Number(fromTs) || 0));

export function noteWindowFailure({ libDir, state, chatKey, fromTs, toTs, error = '', limit = WINDOW_FAIL_SKIP, now = Date.now() }) {
  const cur = state.chats[chatKey] || {};
  const fails = cur.fails && typeof cur.fails === 'object' ? cur.fails : {};
  const k = failKeyOf(fromTs);
  const n = (Number(fails[k]?.n) || 0) + 1;
  fails[k] = { n, at: Number(now) || Date.now(), error: String(error || '').slice(0, 160) };
  for (const key of Object.keys(fails)) {                 // 只留最近的若干个
    if (Object.keys(fails).length <= FAIL_LOG_MAX) break;
    delete fails[key];
  }
  cur.fails = fails;
  state.chats[chatKey] = cur;
  if (n >= Math.max(1, Number(limit) || WINDOW_FAIL_SKIP)) {
    advanceCursor({ libDir, state, chatKey, toTs });      // 认输：放过它，让后面能走
    return { skipped: true, count: n };
  }
  try { saveConsolidateState({ libDir, state }); } catch { /* 同上 */ }
  return { skipped: false, count: n };
}

/** 窗口成功 ⇒ 清掉它的失败记录（否则一次偶然故障会白白攒计数）。 */
export function clearWindowFailure({ state, chatKey, fromTs }) {
  const cur = state.chats?.[chatKey];
  if (!cur?.fails) return;
  delete cur.fails[failKeyOf(fromTs)];
}

/**
 * 一个窗口的模型结果 → 落库（事件 + 人物印象）。
 *
 * 两条**独立的**写路径，失败互不牵连：事件落不下不该连累印象，反之亦然。
 */
async function applyWindow({ win, parsed, normalizer, factStore, store, settings, libDir, now, say }) {
  const out = { events: 0, slots: 0, skippedPeople: 0, eventId: '', titles: [], errors: [] };

  // ── ① 事件 ──
  //
  // 🆕 2026-10-23（`ADR-0048`）：**一件事一行**。
  // 改前：一个窗口（1 小时 / 120 条消息）压成**一行**，3~5 件事被塞进 `items[]`，
  // `summary` 是它们用空格拼起来的段落 ⇒ 排版上看着像一条，检索上只能整体命中，
  // 排练计数也**只能整体计**（"这 5 件事一起被想起过一次"不是记忆该有的粒度）。
  // 改后：每件事一条 record，`id = <窗口id>_<序号>`、`windowId` 指回窗口。
  //   · 幂等仍按 id（重跑同窗口得同一批 id，不会写两遍）
  //   · `summary` = **这一件事**的正文（`title：detail`），归一化闸门照旧逐条过
  //   · `items` 保留单元素数组（面板/旧读者按 items 渲染仍能显示这一条）
  const windowId = eventIdOf(win);
  out.eventId = windowId;
  if (windowId && parsed.events.length) {
    const existing = readEventRows({ libDir, strict: true });
    const seen = new Set(existing.rows.map((r) => String(r?.id ?? '')));
    const p = consolidatePaths(libDir);
    let wrote = 0;
    parsed.events.forEach((e, i) => {
      const id = eventRowId(windowId, i);
      const title = String(e?.title || '').slice(0, 40);
      const detail = String(e?.detail || '').slice(0, 300);
      // 出境闸门：摘要会进 prompt（短期层注入）、升长期后还会被嵌进向量 ⇒ 必须先归一化
      const rawSummary = `${title}${detail ? `：${detail}` : ''}`;
      let summary = rawSummary;
      try {
        summary = String(normalizer?.normalize?.(rawSummary, { context: `event:${id}`, register: false })?.text || rawSummary).trim();
      } catch (err) {
        say('warn', `事件摘要归一化失败，改用原文（仅本地落盘）：${String(err?.message ?? err)}`);
      }
      const item = { at: String(e?.at || ''), title, detail, who: Array.isArray(e?.who) ? e.who : [] };
      const record = {
        version: CONSOLIDATE_VERSION,
        id,
        windowId,                       // 同一次整理产出的这几条共用一个窗口 id
        idx: i + 1,
        chatKey: win.chatKey,
        fromTs: win.fromTs,
        toTs: win.toTs,
        msgCount: win.msgCount,
        at: item.at,
        title,
        detail,
        who: item.who,
        summary,
        items: [item],                  // 单元素：旧读者不炸
        // 短期层的两个运行时字段（`ADR-0048`）：
        //   hits       —— 真的进了 `/inject` 最终 lines 的次数（排练次数）
        //   promotedAt —— 升长期的时间；空 = 仍在短期层
        hits: 0,
        lastHitAt: 0,
        promotedAt: '',
        retiredAt: '',
        createdAt: new Date(now).toISOString()
      };
      if (title) out.titles.push(title);
      if (seen.has(id)) return;         // 幂等：同 id 已存在就不再追加
      try {
        fs.mkdirSync(p.base, { recursive: true });
        fs.appendFileSync(p.events, `${JSON.stringify(record)}\n`, 'utf8');
        seen.add(id);
        wrote++;
      } catch (err) {
        out.errors.push(`event ${id}: ${String(err?.message || err)}`);
        say('warn', `事件落盘失败（${id}）：${String(err?.message ?? err)}`);
      }
    });
    out.events = wrote;
    out.titles = out.titles.slice(0, 5);

    // ── 向量：**不再自动建**（`ADR-0048` ③）──
    //
    // 改前：事件一落盘立刻 embed 进向量库 ⇒ 每小时的闲聊都和"长期记忆"平起平坐地
    // 参与 `/search`，短期层与长期层实际上是一层。
    // 改后：事件先只在**短期层**（关键词索引 + 排练计数）。排练满门槛（默认 9）后由
    // `promoteEvent()` 建向量并入长期层 —— 也就是"被反复想起的才配变成长期记忆"。
    // 开关 `eventAutoEmbed`（默认 **false**）保留旧行为，用于回退/对比实验。
    if (settings.eventAutoEmbed === true && store) {
      for (const rec of readEventRows({ libDir }).rows.filter((r) => r.windowId === windowId)) {
        try {
          await embedEventRow(rec, { store, settings, normalizer });
        } catch (err) {
          say('warn', `事件向量化失败（${rec.id}，不影响落盘）：${String(err?.message ?? err)}`);
        }
      }
    }
  }

  // ── ② 人物印象 ──
  if (!factStore || factStore.readOnlyReason) {
    if (parsed.people.length) out.errors.push('Fact store unavailable or read-only');
    if (parsed.people.length) say('warn', `事实库只读（${factStore?.readOnlyReason || '未装配'}），本窗口 ${parsed.people.length} 条印象丢弃`);
    return out;
  }
  let scope = '';
  try { scope = normalizer.scopeLabel(win.chatKey); } catch { scope = ''; }
  if (!scope) {
    if (parsed.people.length) out.errors.push('Missing fact scope');
    say('warn', `拿不到场合标签（${win.chatKey}）⇒ 本窗口印象不写（scope 是身份的一部分）`);
    return out;
  }

  for (const p of parsed.people) {
    const who = resolveSpeaker(normalizer, p.qq);
    if (!who) { out.skippedPeople++; continue; }     // 词表里没有 ⇒ 不猜
    let text = p.text;
    try { text = String(normalizer.normalize(text, { context: `slot:${who.label}`, register: false })?.text || text).trim(); } catch { /* 用原文 */ }
    if (!text) { out.skippedPeople++; continue; }

    // 多值槽（2026-10-22）：`trait` 按属性名、`speaker_profile`/`preference`/`grudge` 按**方面**名
    // 项级 upsert。项名单一来源 = `inject.mjs` 的 `itemKeyOf`（直写端也用它，不许各写一份）。
    // 其余 kind 仍是"一句话一个槽"（`content.text` 被整条替换）。
    // ⚠️ `aspect: p.aspect || p.attr`：早期模型会把"方面"塞进 `attr` 字段（老提示词只提过 attr）
    //    ⇒ 缺 aspect 时用 attr 兜底，与改前行为一致，不会把已有的"方面"退化成 `整体`。
    const itemKey = itemKeyOf(p.kind, { attr: p.attr, aspect: p.aspect || p.attr });
    if (p.kind === 'trait' && !itemKey) { out.skippedPeople++; continue; }   // 没有属性名 ⇒ 只能覆盖整个档案槽，丢信息

    try {
      const previous = factStore.getSlot({ speaker: who.label, target: '', fact_kind: p.kind, scope });
      let content = { text, source: 'consolidate' };
      const evidenceIds = win.rows.slice(0, 40).map((r) => String(r?.id ?? '')).filter(Boolean);
      if (!evidenceIds.length) evidenceIds.push(`window:${windowId}`);
      if (itemKey) {
        const up = upsertSlotItem(previous, itemKey, text);
        content = { items: up.items, source: 'consolidate' };
      }
      const r = factStore.put({
        speaker: who.label,
        target: '',
        fact_kind: p.kind,
        scope,
        content,
        // 证据集**不带时间戳**（进 contentFingerprint ⇒ 带时间会让同内容反复 update）。
        // **多值槽恒用窗口标记**（evidence_n=1）：`items` 是累积型内容，若按真实条数，
        // 聚合的 evidence-max 会挑"证据更多"的旧版本 ⇒ 新写的方面被静默丢掉。
        // 其余 kind 保持真实消息 id —— 它们是"整句替换"，证据多的确实更可信，信号要留住。
        evidenceIds: itemKey ? [`window:${windowId}`] : evidenceIds,
        provenance: windowReferences(win,windowId),
        itemProvenance: itemKey ? {...(previous?.itemProvenance || {}),[itemKey]:windowReferences(win,windowId)} : {},
        at: new Date(now).toISOString()
      });
      if (r && r.action === 'update') out.slots++;
      else if (r && r.action === 'noop') { /* 内容没变：不算失败，也不再计一条 */ }
    } catch (err) {
      out.skippedPeople++;
      out.errors.push(`fact ${who.label}: ${String(err?.message || err)}`);
      say('warn', `印象写入失败（${who.label}/${p.kind}）：${String(err?.message ?? err)}`);
    }
  }
  return out;
}

/**
 * 只读自检：整理管道现在能不能跑（面板/排障用）。
 * 不改任何状态、不调模型。
 */
export async function consolidateStatus({ sourceRoot, libDir, settings = {} } = {}) {
  const evidence = readEvidenceRows({ sourceRoot });
  const state = loadConsolidateState({ libDir });
  const events = readEventRows({ libDir });
  const windows = pickWindows({
    rows: evidence.rows,
    state,
    maxMsgs: numOr(settings.consolidateWindowMsgs, 120),
    maxSpanMs: numOr(settings.consolidateWindowSpanMin, 120) * MIN_MS,
    settleMs: numOr0(settings.consolidateSettleMin, 3) * MIN_MS,
    limit: 999,
    now: Date.now()
  });
  const perChat = {};
  for (const w of windows) {
    const c = perChat[w.chatKey] || (perChat[w.chatKey] = { chatKey: w.chatKey, pendingWindows: 0, pendingMsgs: 0 });
    c.pendingWindows++;
    c.pendingMsgs += w.msgCount;
  }
  return {
    ok: true,
    sourceRoot: sourceRoot || '',
    libDir: libDir || '',
    evidence: { rows: evidence.rows.length, badLines: evidence.badLines, missing: evidence.missing, file: evidence.file },
    events: { rows: events.rows.length, badLines: events.badLines, missing: events.missing },
    cursors: state.chats,
    pending: Object.values(perChat).sort((a, b) => b.pendingMsgs - a.pendingMsgs),
    settings: {
      windowMsgs: numOr(settings.consolidateWindowMsgs, 120),
      windowSpanMin: numOr(settings.consolidateWindowSpanMin, 120),
      settleMin: numOr0(settings.consolidateSettleMin, 3),
      maxWindowsPerRun: numOr(settings.consolidateMaxWindowsPerRun, 3)
    }
  };
}
