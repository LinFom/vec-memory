// 读核心已有的小时块，构建"向量化文本"。
//
// ── 为什么对象是它，而不是自己抽三元组 ───────────────────────────────────
// 宿主核心 `src/conversation-memory/` 已经把消息压成了小时块
// （data/memory-v2/chunks/hour_<chatKey>_<YYYY-MM-DD><HH>.json，实测 468 份）。
// 直接向量化这些块 = 当天就能用的语义检索：零 LLM 抽取成本、零新表。
// 三元组事实抽取是一条独立的重链（prompt、event_id 引用校验、矛盾处理），
// 和向量层一起上线 = 两个未验证的东西同时引入，出问题分不清是谁的错。
//
// ⚠️ 但注意 ADR-0005：**块不是存档的子集，是加权抽样**（只留 11.4% 的消息）。
// 所以它能被向量化（"这段时光值不值得被想起"），却不能当事实层的输入。
//
// ── 这个文件在 ADR-0002 之后改了职责 ─────────────────────────────────────
// 实测小时块的 `title` 里**直接写着 QQ 号**（`private:100000001 @ 2026-10-07 16:00`），
// `summary` 里写着群名片。所以老版本的"把 title + keywords + summary 拼起来送出去"
// 等于**把通讯录发给云端**。
//
// 现在分成两个函数，界限就是**出境 / 不出境**：
//
//   buildSourceText()  → 本机原始文本。**不出境**，只给面板做对照显示。
//   buildEmbedText()   → 出境文本。**强制**经过共享归一化器（不传就抛），
//                        返回文本 + 一份"这次动了什么"的边界报告。
//
// 纪律：把边界钉在接口上，而不是靠调用方自觉 —— 所以 `buildEmbedText` 没有
// "不传归一化器也能跑"的降级路径。降级就是名字出境。
//
// ── 截断的顺序很容易写反 ─────────────────────────────────────────────────
// 必须先归一化、再截断。反过来会在截断点上**切断一个名字**
// （"林寒枫" 少了 "霜"），那是漏报，而漏报的代价正是名字出境。
import fs from 'node:fs';
import path from 'node:path';

import { NormalizerError } from './normalize.mjs';
import { filterCoreKeywords, extractKeywords, DEFAULT_KEYWORDS_SOURCE } from './keywords.mjs';

/** 块文件名 → 结构化描述。不匹配则返回 null（不是抛错：目录里可能混着别的东西）。 */
export function parseChunkFileName(name) {
  const base = String(name).replace(/\.json$/i, '');
  // hour_group_100000001_2026-09-2500   /  day_group_100000001_2026-09-10
  const m = /^(hour|day|ep)_(.+?)_(\d{4})-(\d{2})-(\d{2})(\d{2})?$/.exec(base);
  if (!m) return null;
  const [, kind, chatRaw, y, mo, d, hh] = m;
  const chatKey = chatRaw.startsWith('group_') ? `group:${chatRaw.slice(6)}`
    : chatRaw.startsWith('private_') ? `private:${chatRaw.slice(8)}`
      : chatRaw.replace(/_/g, ':');
  return {
    id: base,
    kind,
    chatKey,
    dayKey: `${y}-${mo}-${d}`,
    hourKey: hh ? `${y}-${mo}-${d} ${hh}` : `${y}-${mo}-${d}`,
    file: name
  };
}

/** 列出块目录里的全部块（按文件名倒序 = 新的在前）。目录不存在时返回空数组。 */
export function listChunks(chunksDir) {
  let names = [];
  try {
    names = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const parsed = parseChunkFileName(n);
    if (parsed) out.push({ ...parsed, mtime: safeMtime(path.join(chunksDir, n)) });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 读一个块。文件坏了返回 {error}，不抛 —— 调用方要把"哪几个块坏了"报给用户。 */
export function readChunk(chunksDir, id) {
  const file = path.join(chunksDir, `${String(id).replace(/\.json$/i, '')}.json`);
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return { id, chunk: JSON.parse(t), file };
  } catch (err) {
    return { id, error: err?.message || String(err), file };
  }
}

// ── ① 本机原始文本（不出境）───────────────────────────────────────────────

/**
 * 组装"等会儿要被归一化"的原始文本。**它的返回值绝不能直接送云端。**
 *
 * 权重取舍：summary 是原始消息拼接，塞进去会把「引用 #274」这类元信息也变成语义信号；
 * keywords 是核心已经提炼好的词。所以顺序是
 *   会话与时段 > 关键词 > 摘要前段
 *
 * @returns {{ text:string, usedChars:number, fullChars:number }}
 */
export function buildSourceText(chunk, opts = {}) {
  const maxChars = Math.max(120, Number(opts.maxChars) || 1200);
  const withKeywords = opts.withKeywords !== false;
  const withSummary = opts.withSummary !== false;

  const parts = [];
  // 会话键 + 时段：它们**带身份**（`group:123` / `private:456`），
  // 但归一化器会把它们变成占位符而不是删掉 —— 保留"在哪个群/跟谁"的语义。
  // 老块可能没有 chatKey/hourKey 字段，退回用 title（它里面同样带会话键）。
  const chatKey = String(chunk?.chatKey || '').trim();
  const tod = String(chunk?.timeOfDay || '').trim();
  const hourKey = String(chunk?.hourKey || '').trim();
  const head = [chatKey, hourKey].filter(Boolean).join(' @ ') || String(chunk?.title || '').trim();
  if (head) parts.push(tod ? `${head}（${tod}）` : head);

  // ⚠️ 关键词的来源是可配的（`ROADMAP #5`，默认见 `DEFAULT_KEYWORDS_SOURCE`）：
  //    `core` = 核心 tokenize 的分词（**会带碎片出境**）；`filtered` / `redacted`
  //    两种脱敏来源都在**归一化之后**才产生（见 `buildKeywordLine`），
  //    所以这里要**跳过**核心关键词，免得把要修的东西又拼进原文。
  const keywordsSource = String(opts.keywordsSource || DEFAULT_KEYWORDS_SOURCE);
  if (keywordsSource === 'core' && withKeywords && Array.isArray(chunk?.keywords) && chunk.keywords.length) {
    parts.push(`关键词：${chunk.keywords.slice(0, 24).join(' ')}`);
  }
  if (withSummary) {
    const summary = String(chunk?.summary || '').replace(/\s+/g, ' ').trim();
    if (summary) parts.push(`内容：${summary}`);
  }

  const full = parts.join('\n').trim();
  // 这里**不截断**：截断必须发生在归一化之后（见文件头的说明）。
  // maxChars 只作为"归一化后要留多长"的预算传下去。
  return { text: full, fullChars: full.length, budgetChars: maxChars };
}

// ── ② 出境文本（必须经过归一化器）─────────────────────────────────────────

/**
 * 构建真正送进嵌入端点的文本。
 *
 * **强制要求 `opts.normalizer` 是共享实例**（`normalize.mjs` 的 `getSharedNormalizer()`）。
 * 不传就抛 —— 这个函数没有"裸奔也能跑"的分支，因为那正是要防的事。
 *
 * @param {object} chunk
 * @param {object} opts
 * @param {import('./normalize.mjs').Normalizer} opts.normalizer
 * @param {number} [opts.maxChars=1200]
 * @param {boolean} [opts.register=true]   本次命中是否写进实体注册表
 * @returns {{text:string, usedChars:number, fullChars:number, truncated:boolean,
 *            source:string, redaction:object}}
 */
export function buildEmbedText(chunk, opts = {}) {
  const normalizer = opts.normalizer;
  if (!normalizer || typeof normalizer.normalize !== 'function') {
    throw new NormalizerError(
      'NORMALIZER_REQUIRED',
      '构建出境文本必须传入共享归一化器（getSharedNormalizer()）—— ' +
        '少这一步就是"把带 QQ 号与群名片的块直接送云端"，实测 title 里就有 QQ 号。',
      { chunkId: chunk?.id || '' }
    );
  }
  const src = buildSourceText(chunk, opts);
  const maxChars = Math.max(120, Number(opts.maxChars) || 1200);

  // 先归一化（全文），再截断
  const norm = normalizer.normalize(src.text, {
    context: `chunk:${chunk?.id || ''}`,
    register: opts.register !== false
  });

  // ── 出境前的第二道闸门（2.1 的修复配套）────────────────────────────────
  // `normalize()` 内部已经跑过 `findLeak`（拦"已知实体串"）。
  // 但那道闸门**只认词表里已有的串** —— 词表漏一个实体，它完全看不见。
  // 形态闸门不依赖词表：它看的是"引用/提及的语法结构还在不在"，
  // 所以词表再怎么漏，也兜得住。
  // 全量实测：468 个真实块跑下来残留 0 处，所以这里可以直接硬断言，不必降级。
  normalizer.assertNoEntityForm(norm.text);

  // ── 关键词（可配来源，`ROADMAP #5`）──────────────────────────────────────
  // 核心 keywords 的问题：它是**未脱敏文本**上的分词 ⇒ `single`/`samara`（机器人名被拆开）、
  // `cq`/`qq`（CQ 码碎片）、`kid1411`（人名小写残片）原样出境。
  // 两种脱敏来源都**在归一化之后**产生：`filtered` 按词表剔碎片、`redacted` 从脱敏文本重抽。
  // ⚠️ 放在截断之前、内容之前（与旧布局一致：关键词是"提纲"，被截断时最后才轮到它）。
  const kw = buildKeywordLine(chunk, { ...opts, normalizer, redactedText: norm.text });
  const assembled = kw.text ? `${kw.text}\n${norm.text}` : norm.text;

  const clamped = clampOnPlaceholderBoundary(assembled, maxChars);

  return {
    text: clamped.text,
    usedChars: clamped.text.length,
    fullChars: src.fullChars,
    normalizedChars: assembled.length,
    truncated: clamped.text.length < assembled.length,
    source: src.text,
    redaction: {
      // 三个计数**就地写明定义** —— 2.2 那次"328 与 497 对不上"就是因为口径没写。
      total: norm.stats.hits,          // 总替换点 = 各层之和
      identity: norm.stats.identity,   // 换成身份占位符的（人 / 群 / 自己）
      structural: norm.stats.structural, // 剥掉的语篇标记（CQ 码 / 日期 / 时刻 / #N / 裸 @）
      byLayer: norm.stats.byLayer,     // 按"谁判出来的"分
      byLayerIdentity: norm.stats.byLayerIdentity, // 按层分的身份类
      byKind: norm.stats.byKind,
      entities: norm.stats.entities,   // 旧字段名，= identity（**口径变了**：现在含 self）
      clean: norm.clean,
      shapeClean: true,
      // 关键词来源与丢弃计数（排障要看得出"哪些词被剔了、为什么"）
      keywords: kw.report,
      // 摘要被砍掉多少（归一化后长度超过预算）
      droppedChars: Math.max(0, assembled.length - clamped.text.length)
    }
  };
}

/**
 * 构建出境文本里的关键词行（`ROADMAP #5`）。返回 `{ text, report }`。
 *
 * `keywordsSource`：
 *   · `core`（默认）—— 返回空行：核心关键词已由 `buildSourceText` 放进正文（**现状不变**）
 *   · `filtered`      —— 保留核心分词，按词表剔掉"实体串碎片"与结构碎片（`cq`/`qq`）
 *   · `redacted`      —— 从**已脱敏文本**重抽（宽口径 = 逐条 snippets + summary）
 *
 * ⚠️ 用**当前**词表（不是进轮快照）判碎片：这里要的是"最严格地剔"，多剔一个词只是少一个信号；
 *    而少剔一个碎片 = 身份出境。方向与"出口自检不许用本轮产物"不冲突 —— 那条管的是**判罪**，
 *    这条管的是**过滤**，两者对误差的容忍方向刚好相反。
 */
export function buildKeywordLine(chunk, opts = {}) {
  const source = String(opts.keywordsSource || DEFAULT_KEYWORDS_SOURCE);
  const report = { source, count: 0, skippedSnippets: 0, caliber: '' };
  if (source === 'core') return { text: '', report };

  const limit = 24;
  let words = [];
  if (source === 'filtered') {
    const surfaces = typeof opts.normalizer?.knownSurfaces === 'function'
      ? opts.normalizer.knownSurfaces()
      : [];
    const raw = Array.isArray(chunk?.keywords) ? chunk.keywords : [];
    // ── 关键词行自己不过归一化，所以必须**逐词**再过一遍泄漏判据 ──────────────
    // 这一行是拼在归一化**之后**的（见 `buildEmbedText`），词表过滤只判"这个词是不是
    // 某个 surface 的碎片"，判不了反方向 —— "这个词**里面**有没有夹着 surface"。
    // 实测（2026-10-29 盘点）：小号 5 个块被拒在这一行上 ——
    //   `16g`（夹着昵称 `16`）、`deepseek-v4-pro`（夹着昵称 `deepseek`）。
    //   正文已经干净，是**提纲**把名字带出去了。
    // 处理：丢词而不是丢块。关键词是可选的检索提纲，少一个词只是少一点信号；
    // 而一条块进不了库 = 那段记忆永久搜不到。丢掉的词进 `report`，排障看得见。
    const candidates = filterCoreKeywords(raw, { surfaces, limit: limit * 2 });
    const kept = [];
    const dropped = [];
    let droppedCount = 0;
    for (const w of candidates) {
      const leak = typeof opts.normalizer?.findLeak === 'function' ? opts.normalizer.findLeak(w) : null;
      if (leak) {
        droppedCount += 1;
        if (dropped.length < 20) dropped.push({ word: w, term: leak.term });
        continue;
      }
      kept.push(w);
      if (kept.length >= limit) break;
    }
    words = kept;
    report.inputCount = raw.length;
    report.droppedLeaky = droppedCount;
    report.droppedLeakyList = dropped;
  } else if (source === 'redacted') {
    const caliber = String(opts.keywordsCaliber || 'snippets+summary');
    report.caliber = caliber;
    const material = [String(opts.redactedText || '')];
    if (caliber !== 'summary') {
      const sn = normalizedSnippetsText(chunk, opts);
      report.skippedSnippets = sn.skipped;
      report.snippetChars = sn.text.length;
      if (sn.text) material.push(sn.text);
    }
    words = extractKeywords(material.join('\n'), { limit });
  } else {
    // 未知取值的**显式**拒绝：静默回落到 core 会让人以为设置生效了
    throw new NormalizerError('BAD_KEYWORDS_SOURCE', `未知的 keywordsSource：${source}`, { source });
  }
  report.count = words.length;
  return { text: words.length ? `关键词：${words.join(' ')}` : '', report };
}

/**
 * 归一化每个 snippet 的正文（宽口径关键词的素材）。
 * 单条归一化失败 ⇒ **跳过它并计数**（不让一条坏数据拖垮整块的向量化），
 * 但计数必须回传：静默跳过 = 关键词变少而没人知道为什么。
 */
function normalizedSnippetsText(chunk, opts) {
  const n = opts.normalizer;
  const list = Array.isArray(chunk?.snippets) ? chunk.snippets : [];
  const parts = [];
  let skipped = 0;
  let budget = 6000;
  for (const s of list.slice(0, 60)) {
    const t = String(s?.text ?? '').trim();
    if (!t) continue;
    let red = '';
    try {
      red = n.normalize(t, { context: 'keywords', register: false }).text;
    } catch {
      skipped += 1;
      continue;
    }
    parts.push(red);
    budget -= red.length;
    if (budget <= 0) break;
  }
  return { text: parts.join('\n'), skipped };
}

/** 在占位符边界上截断：不许把 `〔P123〕` 切成 `〔P12`。 */
export function clampOnPlaceholderBoundary(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, cut: false };
  let cut = s.slice(0, maxChars);
  const open = cut.lastIndexOf('〔');
  const close = cut.lastIndexOf('〕');
  if (open > close) cut = cut.slice(0, open);      // 末尾有半截占位符 → 整个丢掉
  return { text: cut.trimEnd(), cut: true };
}

// ── ③ 哈希与元数据 ────────────────────────────────────────────────────────

/**
 * 源哈希：内容变了才重新向量化。
 *
 * 入参是**归一化后**的文本 —— 这是个刻意的选择：
 * 词表长大（新群友进群、有人改名）会让同一段的占位符变化，
 * 于是哈希变化、该块被重新嵌入。这样**索引始终和当前归一化器一致**，
 * 而不会出现"库里的向量是旧词表算的，查询用新词表算的"这种静默错配。
 */
export function sourceHash(chunk, normalizedText) {
  const h = `${chunk?.id || ''}|${chunk?.when || 0}|${String(normalizedText || '').length}|${String(normalizedText || '').slice(0, 200)}`;
  let acc = 2166136261;
  for (let i = 0; i < h.length; i++) {
    acc ^= h.charCodeAt(i);
    acc = Math.imul(acc, 16777619);
  }
  return (acc >>> 0).toString(16).padStart(8, '0');
}

/** 块 → 落库元数据。 */
export function chunkMeta(parsed, chunk, textInfo) {
  return {
    kind: parsed.kind,
    chatKey: chunk?.chatKey || parsed.chatKey,
    dayKey: chunk?.dayKey || parsed.dayKey,
    hourKey: chunk?.hourKey || parsed.hourKey,
    when: Number(chunk?.when) || 0,
    title: String(chunk?.title || parsed.id),
    // 存的是**归一化后**的片段：它是本机面板的展示文本，
    // 原文随时能从核心块里重新读，没必要在向量库副本里再存一份带身份的。
    text: String(textInfo.text || '').slice(0, 400),
    fullChars: textInfo.fullChars,
    usedChars: textInfo.usedChars,
    truncated: Boolean(textInfo.truncated),
    redaction: textInfo.redaction || null,
    // 来源标记：老块是 `core-chunk`，从宿主消息存档派生的是 `derived-messages`。
    // 面板上看不出"这条是原件还是派生件"的话，排查停更时会白跑一趟。
    source: String(parsed?.source || 'core-chunk'),
    pipeline: 'normalized-v1'
  };
}
