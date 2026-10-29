// 在场实体词表 —— 给归一化器喂"哪些串是实体"。
//
// ── 为什么不需要 NER ─────────────────────────────────────────────────────
// ADR-0002 已经指出：宿主自己能拿到群成员列表（`get_group_member_list`），
// 每条消息也带 `senderId` / `senderName`。所以**在场实体是可枚举的**，
// 不需要任何模型。这个文件就是把这些数据读成本地词表。
//
// ── 四个数据源，都要读，缺一不可 ─────────────────────────────────────────
//   ① data/memory/people/*.json        宿主积累的"人物卡"，带 userId + name
//   ② data/messages*/**.json           原始存档，带 senderId → senderName 的**全部**群名片
//   ③ data/config.json                 机器人自己的名字（`persona.botName`）—— **不联网**
//   ④ 存档里的"名字 ↔ QQ 号"硬锚点      见下（这是 2.1 那处漏替的修复）
//
// 只读 ① 会漏掉没建卡的群友；只读 ② 会漏掉改过名的人（旧名片不再出现在近期消息里）；
// **不读 ③ 会让机器人自己的名字出境**（实测：`Single Samara` 曾原样留在送云端的文本里）。
//
// ── ④ 锚点挖掘：这是"零词表也能认出实体"的那条路 ─────────────────────────
// 存档里同时存在**显示名**和**QQ 号**，而且紧挨着：
//     @Single Samara（大肥鱼形态）[CQ:at,qq=100000001]
//     [引用 Single Samara（大肥鱼形态）(QQ:100000001)：觅食回来了…]
//     [引用 #1401 Single Samara（大肥鱼形态）：大白饭 还能吃啥]
// 这三条形态里的名字**天然对齐到一个硬 ID**（CQ 码 / `(QQ:)` / `#n` 反查），
// 所以可枚举、可验证、不需要猜。这解决了两类词表漏项：
//   · 带称号的显示名（`安晴（中转站：我这里白饭管够）`）—— 与 `senderName` 不完全相同
//   · 半角/全角括号混用（`Single Samara(林枫中转)`）
//
// ── 为什么"机器人自己"要特殊处理（2.1 的根因）────────────────────────────
// 机器人的消息在存档里是 `senderId: 'self'`，**它的 QQ 号从不作为 senderId 出现**，
// 所以只按 ①② 建表，`qq:100000001` 与 `Single Samara` 都进不来 → 名字原样出境。
// 现在两条**纯本地**路线互证：
//   · 配置：`config.json` 的 `persona.botName` == 挖到的名字（去括号）→ 那个 ID 就是自己
//   · 存档证明：`(QQ:N)` 的**引文**能在 `senderId: 'self'` 的消息里找到（实测 16/17，
//     其余四个 QQ 全是 0 命中）→ N 就是自己
// 两条都对上才敢合并；只有一条命中时记 `selfIdSource` 说明来源，便于事后审计。
//
// ── 兜底层为什么用"分布集中度"而不是频率（ADR-0003）─────────────────────
// 群里天天喊的人名是高频词，"哈哈""这个"也是高频词 —— 频率区分不了它们。
// 能区分的是**分布形态**：真名集中在少数 chatKey，普通词在所有 chatKey 里近似均匀。
// 判据因此是 `命中的 chatKey 数 ÷ 总 chatKey 数`（分散度）：低分散 + 够频繁 = 疑似专名。
import fs from 'node:fs';
import path from 'node:path';

/** 名字里带称号时，去掉尾部的 `（…）` / `(…)` —— 用来跟 botName 对齐。 */
export function nameBase(name) {
  return String(name ?? '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}

/**
 * 存档**指纹** —— 回答"存档变过没有"。
 *
 * ── 为什么需要它（2026-10-11 实测）────────────────────────────────────────
 * `vocabularyNeeded()` 原本只问"`selfAliases` 变了没有"，
 * **"存档里长出新人了"根本不在判据里**。代价是真机可量的：
 *   服务进程 12:47 装载词表（`entities.json` = 986 个实体），存档**一直在写**
 *   （`group_100000001.json` 的 mtime = 19:05）。这 6 小时里新说话的 **164 人**
 *   没被登记 ⇒ 星图上全部落成 `X####` **临时标签**，身份页里查不到，
 *   给他们写的备注会在下一次重建词表时**静默失联**。
 *   拿新鲜词表去对那个过期快照，会把 164 个活人误读成"161 颗哑巴星"。
 *
 * ── 口径为什么是这三个数，而不是内容 hash ────────────────────────────────
 * 全量 hash 要读完 140MB 存档（几秒），而判据本身是**每次用到身份时**都要跑的。
 * `文件数 + 总字节 + 最新 mtime` 只需 stat 35 个文件（<2ms），
 * 而它要回答的问题只是"**要不要重扫**"—— 漏判（改了但指纹没变）的唯一可能是
 * "文件数、总字节、最新 mtime 三者全不变而内容变了"，追加写的存档里不可能。
 * **宁可多扫一次，不可装作没变**（`ADR-0014`：别相信看起来在工作的判据）。
 *
 * @param {string} dataDir 源根（存档所在）
 * @returns {{files:number, bytes:number, newest:number, newestName:string, sig:string}}
 */
export function archiveFingerprint(dataDir) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  let newestName = '';
  for (const { file } of listArchiveFiles(dataDir)) {
    try {
      const st = fs.statSync(file);
      files++;
      bytes += st.size;
      const m = Math.round(st.mtimeMs);
      if (m > newest) { newest = m; newestName = path.basename(file); }
    } catch { /* 刚被轮转掉的文件：下一次 stat 就不在了，跳过不算漏 */ }
  }
  return { files, bytes, newest, newestName, sig: `${files}|${bytes}|${newest}` };
}

/** 存档文件枚举（热 + 冷）。目录不存在就当空，不抛。 */
export function listArchiveFiles(dataDir) {
  const dirs = ['messages', 'messages-cold'];
  const out = [];
  for (const d of dirs) {
    const abs = path.join(dataDir, d);
    let names = [];
    try {
      names = fs.readdirSync(abs).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of names) out.push({ file: path.join(abs, n), hot: d === 'messages' });
  }
  return out;
}

/** 读一个存档文件 → { chatKey, messages }。坏文件返回 { error }，不抛。 */
export function readArchive(file) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    const j = JSON.parse(t);
    const messages = Array.isArray(j) ? j : (Array.isArray(j?.messages) ? j.messages : []);
    const chatKey = String(j?.chatKey || '');
    return { chatKey, messages };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * 全部存档 → 每条消息一条迭代（带 chatKey）。
 * 生成器：119,000+ 条一次全读进内存没必要（冷片是 5000 条一片，逐片处理即可）。
 */
export function* iterateArchive(dataDir) {
  for (const { file } of listArchiveFiles(dataDir)) {
    const r = readArchive(file);
    if (r.error) continue;
    for (const m of r.messages) if (m && typeof m === 'object') yield { chatKey: r.chatKey, message: m, file };
  }
}

/** 从 `(QQ:123)` 这类锚点取出的引文前缀长度（用于"引文比对"证明自己是谁）。 */
const PROOF_PREFIX = 12;

/**
 * 读宿主配置里"机器人自己叫什么"。**纯本地读文件，不联网。**
 *
 * 实测 `config.json` 里 `persona.botName = "Single Samara"`、
 * `customPersonas[].name` 是各套人设的名字。这些名字**不在存档的任何 senderName 里**
 * （机器人发言的 senderName 是 `我`），所以必须单独读出来。
 *
 * @returns {{names:string[], source:string, present:boolean}}
 */
export function readHostIdentity(dataDir) {
  const out = { names: [], source: '', present: false };
  const files = [path.join(dataDir, 'config.json'), path.join(dataDir, 'per-chat-persona', 'personas.json')];
  for (const file of files) {
    let cfg;
    try {
      let t = fs.readFileSync(file, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      cfg = JSON.parse(t);
    } catch {
      continue;
    }
    const push = (v) => {
      const s = String(v ?? '').trim();
      if (s && !out.names.includes(s)) out.names.push(s);
    };
    push(cfg?.persona?.botName);
    push(cfg?.persona?.selfNickname);
    for (const p of (cfg?.customPersonas || [])) push(p?.name);
    if (out.names.length) {
      out.present = true;
      out.source = out.source ? `${out.source}, ${path.basename(file)}` : path.basename(file);
    }
  }
  return out;
}

/**
 * 构建在场实体词表。
 *
 * @param {object} opts
 * @param {string} opts.dataDir         宿主的 data 目录
 * @param {string[]} [opts.botNames]    额外追加的机器人名字（不给则自动读 config.json）
 * @param {boolean} [opts.mineAlignments=true]  是否从存档挖"名字↔QQ号"锚点
 * @returns {{entities:Array<object>, horizon:object, identity:object, stats:object}}
 */
export function buildVocabulary(opts = {}) {
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error('buildVocabulary 需要 dataDir（写清对着哪个数据源查，是本项目纪律）');
  const mine = opts.mineAlignments !== false;

  /** @type {Map<string, {id:string, kind:string, surface:Set<string>, aliases:Set<string>}>} */
  const map = new Map();
  const touch = (id, kind, surface, aliasOf = '') => {
    if (!id) return;
    let e = map.get(id);
    if (!e) { e = { id, kind, surface: new Set(), aliases: new Set() }; map.set(id, e); }
    if (surface) {
      const s = String(surface).trim();
      // 太短的串（1 字）保留，靠归一化器的"整词判定"才生效。
      // 长度上限：普通名片 24 字；**锚点挖出来的名字放宽到 40** —— 它带 CQ 码/QQ 号背书，
      // 不存在"把一句话当名字"的风险，而带称号的显示名经常超过 24。
      const cap = aliasOf ? 40 : 24;
      // ⚠️ 纯标点/无字母数字的 surface **永不收录**（2026-10-09，实测教训）：
      //    有群友的昵称就叫 `...`。它进了词表 ⇒ 任何含省略号的正文都触发
      //    NORMALIZE_LEAK（findLeak 认得它），而替换层又因边界判定换不掉它 ⇒
      //    整个索引 fail-closed 卡死。判据：至少含一个字母/汉字/数字才配当名字。
      if (s && s.length <= cap && /[\p{L}\p{N}]/u.test(s)) e.surface.add(s);
    }
    if (aliasOf && !e.aliases.has(aliasOf)) e.aliases.add(aliasOf);
  };

  // ── ③ 机器人自己的名字（先读，后面判定"挖到的是不是自己"要用）──────────
  const host = readHostIdentity(dataDir);
  const botNames = new Set(host.names);
  for (const n of (opts.botNames || [])) {
    const s = String(n ?? '').trim();
    if (s) botNames.add(s);
  }

  // ── ① 人物卡 ─────────────────────────────────────────────────────────
  let peopleFiles = 0;
  const peopleDir = path.join(dataDir, 'memory', 'people');
  try {
    for (const name of fs.readdirSync(peopleDir)) {
      if (!name.endsWith('.json')) continue;
      let p;
      try {
        p = JSON.parse(fs.readFileSync(path.join(peopleDir, name), 'utf8'));
      } catch { continue; }
      if (!p?.userId) continue;
      peopleFiles++;
      touch(`qq:${p.userId}`, 'person', p.name);
      for (const alias of (p.aliases || [])) touch(`qq:${p.userId}`, 'person', alias);
    }
  } catch { /* 没有人物卡目录也能跑（只靠存档） */ }

  // ── ②④ 存档：senderName 全量 + 锚点挖掘 + 观察窗（**一趟读完**）─────────
  const seenChats = new Set();
  const seenNames = new Map();     // entityId → Set<senderName>
  let messages = 0;
  let missingSender = 0;
  let minTs = 0;
  let maxTs = 0;
  let selfMessages = 0;
  /** @type {Map<string, {name:string, id:string, kind:string, quote:string}>} */
  const anchors = [];
  // 注：这里**不要**建"chatKey → 全局 id 索引"。`#n` 确实是宿主的会话级递增 id
  // （`store.msgRef` = `#${m.id}`），但被引用的消息几乎总与引用方在**同一个存档分片**内：
  // 实测（119,533 条存档）19,488 个带 `#n` 的引用块里，**19,435 个（99.73%）同片可解析**。
  // 剩下的 53 个（0.27%）是被引用消息落在别的分片 —— 相比 36,919 个锚点，收益可忽略，
  // 故**不做跨片合并**（见 ADR-0010 决定 7 的"已知边界"）。
  // ⚠️ 曾经这里有个只写不读的 `chatLocalIndex`，名字看着像"会话级索引"，
  //    实际是每片覆盖一次的 write-only 变量，把复核者带偏过 —— 已删。
  /** @type {Map<string, Set<string>>} chatKey → self 说过的话的前 N 字（引文比对的证据） */
  const selfProofSet = new Map();
  /** @type {Map<string, {claims:number, proved:number, names:Set<string>}>} */
  const idEvidence = new Map();

  const RE_AT_CQ = /@([^@\[\]{}\n]{1,40}?)\[CQ:at,qq=(\d+)\]/g;
  const RE_QUOTE_QQ = /\[\s*引用\s+([^\[\]：:\n]{1,40}?)\(QQ:(\d+)\)\s*[：:]/g;
  const RE_QUOTE_LOCAL = /\[\s*引用\s+#(\d+)\s+([^\[\]：:\n]{1,40}?)\s*[：:]([^\]]*)/g;

  const noteEvidence = (id, proved) => {
    if (!id) return;
    let r = idEvidence.get(id);
    if (!r) { r = { claims: 0, proved: 0, names: new Set() }; idEvidence.set(id, r); }
    r.claims++;
    if (proved) r.proved++;
  };

  for (const { file } of listArchiveFiles(dataDir)) {
    const r = readArchive(file);
    if (r.error) continue;
    const chatKey = r.chatKey || path.basename(file).replace(/\.json$/, '');
    if (chatKey && !seenChats.has(chatKey)) seenChats.add(chatKey);

    // 本片内先建 id → senderId：`[引用 #n]` 的 n 要反查被引用者（n = 宿主的会话级递增 id）。
    // 只索引本片 —— 被引用的消息与本条几乎总在同片（实测同片可解析率 99.73%，见上面的注）。
    // 存档条目里**没有** `localId` 字段，`id` 就是 `store.msgRef` 用的那个数。
    const localIndex = new Map();
    for (const m of r.messages) {
      const lid = m?.id;
      if (lid !== undefined && lid !== null && m?.senderId) localIndex.set(String(lid), String(m.senderId));
    }
    let proof = selfProofSet.get(chatKey);
    if (!proof) { proof = new Set(); selfProofSet.set(chatKey, proof); }

    for (const m of r.messages) {
      if (!m || typeof m !== 'object') continue;
      messages++;
      const ts = Number(m.ts) || 0;
      if (ts > 0) {
        if (!minTs || ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      const sid = m.senderId ? String(m.senderId) : '';
      const sname = m.senderName ? String(m.senderName) : '';
      if (!sid) { missingSender++; }
      else {
        const id = sid === 'self' ? 'self' : `qq:${sid}`;
        touch(id, sid === 'self' ? 'self' : 'person', sname);
        if (sname) {
          if (!seenNames.has(id)) seenNames.set(id, new Set());
          seenNames.get(id).add(sname);
        }
        if (sid === 'self') {
          selfMessages++;
          if (m.text) proof.add(String(m.text).replace(/\s+/g, '').slice(0, PROOF_PREFIX));
        }
      }

      if (!mine) continue;
      const text = String(m.text || '');
      if (!text || text.indexOf('@') < 0 && text.indexOf('引用') < 0) continue;

      // 形态 A：@显示名[CQ:at,qq=ID]
      RE_AT_CQ.lastIndex = 0;
      let mm;
      while ((mm = RE_AT_CQ.exec(text)) !== null) {
        anchors.push({ name: mm[1].trim(), id: `qq:${mm[2]}`, kind: 'person', via: 'at-cq', chatKey, quote: '' });
      }
      // 形态 B：[引用 显示名(QQ:ID)：引文
      RE_QUOTE_QQ.lastIndex = 0;
      while ((mm = RE_QUOTE_QQ.exec(text)) !== null) {
        anchors.push({ name: mm[1].trim(), id: `qq:${mm[2]}`, kind: 'person', via: 'quote-qq', chatKey, quote: '' });
      }
      // 形态 C：`[引用 #n 显示名：引文` —— n 是宿主的**会话级递增 id**，在本片索引里反查
      // senderId。这是本机**最主要**的锚点形态（实测 19,488/20,228 个引用块是这种），
      // 而且它**不依赖任何网络调用**（`toSelf` 的引用路径要 `onebot.getMsg`，见 ADR-0010 决定 7）。
      RE_QUOTE_LOCAL.lastIndex = 0;
      while ((mm = RE_QUOTE_LOCAL.exec(text)) !== null) {
        const sid2 = localIndex.get(String(mm[1]));
        if (!sid2) continue;
        anchors.push({
          name: mm[2].trim(),
          id: sid2 === 'self' ? 'self' : `qq:${sid2}`,
          kind: 'person',
          via: 'ref-local',
          chatKey,
          quote: String(mm[3] || '').replace(/\s+/g, '').slice(0, PROOF_PREFIX)
        });
      }
    }
  }

  // ── 锚点落地：补 surface + 给带 QQ 号的形态留一条"引文比对"的证据 ──────
  const alignedNames = new Set();
  for (const a of anchors) {
    if (!a.name) continue;
    // 这里**不写 alias**：普通实体自己的 id 就是 `qq:N`，别名没有意义。
    // 只有"合并进 self"时才需要别名（`self` 的 id 不是号码），见下面的合并段。
    touch(a.id, a.id === 'self' ? 'self' : 'person', a.name);
    alignedNames.add(a.name);
    // 只有"带 QQ 号 + 带引文"的形态能当证据（比对 self 说过的话）
    if (a.via === 'quote-qq') {
      const proof = selfProofSet.get(a.chatKey);
      const proved = Boolean(a.quote && proof && proof.has(a.quote));
      noteEvidence(a.id, proved);
    }
  }

  // ── 判定"哪个 QQ 号是自己"：两条本地路线 ───────────────────────────────
  let selfId = '';
  let selfIdSource = '';
  // 路线 1：挖到的名字（去括号）与配置里的 botName 相同
  if (botNames.size) {
    for (const a of anchors) {
      if (nameBase(a.name) && botNames.has(nameBase(a.name))) { selfId = a.id; break; }
    }
    if (selfId) selfIdSource = `botName 对齐（${host.source || 'opts.botNames'}）`;
  }
  // 路线 2：引文比对 —— 只有自己的话能被引用到，别的 QQ 全 0 命中（实测）
  if (!selfId) {
    let best = null;
    for (const [id, ev] of idEvidence) {
      if (ev.proved > 0 && (!best || ev.proved > best.ev.proved)) best = { id, ev };
    }
    if (best) { selfId = best.id; selfIdSource = `引文比对（${best.ev.proved}/${best.ev.claims}）`; }
  }
  // 合并：把 selfId 这个实体整体并进 self。
  // 为什么不能在挖掘时直接写：路线 2（引文比对）要等整趟读完才有证据，
  // 所以统一放在这里做一次归并。别名 `qq:N` 挂到 self 上 ——
  // 这样归一化器遇到 `[CQ:at,qq=N]` 能直接判成 `SELF`，而不是一个陌生人。
  if (selfId) {
    const other = map.get(selfId);
    if (other && selfId !== 'self') {
      for (const s of other.surface) touch('self', 'self', s, selfId);
      map.delete(selfId);
    }
    touch('self', 'self', selfId.replace(/^qq:/, ''), selfId);
    touch('self', 'self', selfId, selfId);
  }

  // ── ③ 机器人自己（收尾：`我` 与全部已知名字）────────────────────────────
  touch('self', 'self', '我');
  for (const n of botNames) touch('self', 'self', n);

  // 私有 会话键 → 身份：`private:<N>` 里的数字是**对方**的 QQ 号，
  // 它同时是会话键和一个人的身份。放在 self 合并**之后**，
  // 否则自己的号码会被建成一个"陌生人"（这正是 2.1 的另一半根因）。
  for (const chatKey of seenChats) {
    const g = /^group:(\d+)$/.exec(chatKey);
    if (g) touch(`group:${g[1]}`, 'group', '');
    const p = /^private:(\d+)$/.exec(chatKey);
    if (p) {
      const id = `qq:${p[1]}`;
      if (id === selfId) touch('self', 'self', p[1], id);
      else touch(id, 'person', '');
    }
  }

  const entities = [...map.values()].map((e) => ({
    id: e.id, kind: e.kind, surface: [...e.surface], aliases: [...e.aliases]
  }));
  const byKind = {};
  for (const e of entities) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const surfaceCount = entities.reduce((n, e) => n + e.surface.length, 0);
  const self = entities.find((e) => e.id === 'self');

  // 观察窗（horizon）：关系边的统计边界。
  // **不是插件的安装日** —— 存档不限量（`maxMessagesPerChat = 0`），所以这个窗口
  // 就是 bot 的年龄，会随时间自然增长。窗口太短时界面必须明说，
  // 否则用户会把"装完之后活跃的人"误读成"本来关系近的人"（ADR-0004）。
  const days = minTs && maxTs ? Math.max(0, (maxTs - minTs) / 86400000) : 0;
  const horizon = {
    start: minTs ? new Date(minTs).toISOString() : null,
    end: maxTs ? new Date(maxTs).toISOString() : null,
    days: Number(days.toFixed(2)),
    messages
  };

  const identity = {
    botNames: [...botNames],
    botNamesSource: host.source,
    selfId,
    selfIdSource,
    selfSurface: self ? self.surface : [],
    selfProof: selfId && idEvidence.has(selfId) ? idEvidence.get(selfId).proved : 0,
    proofClaims: idEvidence.size,
    // 为了让面板能说清"为什么它不是别人"：把其他 QQ 的引文命中数也报出来
    otherCandidates: [...idEvidence.entries()]
      .filter(([id]) => id !== selfId)
      .map(([id, ev]) => ({ id, proved: ev.proved, claims: ev.claims }))
      .sort((a, b) => b.proved - a.proved)
      .slice(0, 8)
  };

  return {
    entities,
    horizon,
    identity,
    stats: {
      dataDir,
      peopleCards: peopleFiles,
      chats: seenChats.size,
      messages,
      missingSender,
      selfMessages,
      entities: entities.length,
      byKind,
      surfaces: surfaceCount,
      // 同一实体多个名字（改过群名片）—— 这些都要进词表，否则旧名片会漏
      multiNameEntities: [...seenNames.entries()].filter(([, s]) => s.size > 1).length,
      // 锚点挖掘的产出（2.1 那处漏替的修复量）
      anchorCount: anchors.length,
      alignedNames: alignedNames.size,
      selfId: selfId || null,
      selfIdSource: selfIdSource || null,
      horizon
    }
  };
}

/** 只取会话键？（已不需要单独一趟 —— 会话键在主循环里就收集了） */

// ── 兜底层：分布集中度扫描 ─────────────────────────────────────────────────

/**
 * 从一段文本里抽候选词条。
 *
 * 中文没有词边界，所以不能"按空格切词" —— 这里取**连续 CJK 片段的 2~4 元组**。
 * 二元组是召回的抓手（`沫钤`），三/四元组用来救"名字被当成句子一部分"的情况
 * （`沫钤说` 本身不会重复出现，但它包含的 `沫钤` 会）。
 * ASCII 侧取 3~24 字符的词，纯数字不取（那是数字层的活）。
 */
export function extractTerms(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]{2,6}/g)) {
    const run = m[0];
    for (let n = 2; n <= Math.min(4, run.length); n++) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    }
  }
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,23}/g)) out.push(m[0]);
  return out;
}

/**
 * 全库扫描：找出"疑似专名"（分布集中 + 够频繁）。
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {number} [opts.minCount=8]     总出现次数下限
 * @param {number} [opts.maxSpread=0.35] 分散度上限（命中 chatKey 数 ÷ 总 chatKey 数）
 * @param {number} [opts.maxTerms=4000]  最多返回多少条
 * @returns {{suspects:string[], stats:object}}
 */
export function scanSuspects(opts = {}) {
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error('scanSuspects 需要 dataDir');
  const minCount = Math.max(2, Number(opts.minCount) || 8);
  const maxSpread = Number.isFinite(Number(opts.maxSpread)) ? Number(opts.maxSpread) : 0.35;
  const maxTerms = Math.max(10, Number(opts.maxTerms) || 4000);

  const chats = new Set();
  /** @type {Map<string, {count:number, chats:Set<string>}>} */
  const terms = new Map();

  for (const { chatKey, message } of iterateArchive(dataDir)) {
    chats.add(chatKey || '(unknown)');
    const text = [message.text, message.senderName].filter(Boolean).join(' ');
    for (const t of extractTerms(text)) {
      let rec = terms.get(t);
      if (!rec) { rec = { count: 0, chats: new Set() }; terms.set(t, rec); }
      rec.count++;
      rec.chats.add(chatKey || '(unknown)');
    }
  }

  const totalChats = Math.max(1, chats.size);
  const scored = [];
  for (const [term, rec] of terms) {
    if (rec.count < minCount) continue;
    const spread = rec.chats.size / totalChats;
    if (spread > maxSpread) continue;          // 分散度高 = 普通词
    scored.push({ term, count: rec.count, chats: rec.chats.size, spread: Number(spread.toFixed(4)) });
  }
  scored.sort((a, b) => (a.spread - b.spread) || (b.count - a.count));

  return {
    suspects: scored.slice(0, maxTerms).map((s) => s.term),
    stats: {
      dataDir,
      chats: totalChats,
      candidates: terms.size,
      kept: scored.length,
      returned: Math.min(scored.length, maxTerms),
      minCount,
      maxSpread,
      top: scored.slice(0, 25)
    }
  };
}
