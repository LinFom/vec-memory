import { memoryCoreOf, profileSummary, policyImpact, subjectSection } from './core/memory-core.mjs';
import { evaluateVisibility, resolveProfilePolicy, scopeType } from './core/visibility.mjs';
import { MemoryError, requireText } from './core/durable-log.mjs';
import { hostSettings, hostConfig } from './core/host.mjs';
import { settingsView } from './core/settings-editor.mjs';
import { encodingIdentity, readRebuildJob } from './core/vector-generation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
// router.mjs — HTTP 分发层（**与传输无关**）
//
// 本文件是从 QQ-Agent 的 `plugins/memory-vec/backend.mjs` **原样切出的 933~1601 行**，
// 逻辑一行未改。切分依据：该区间零核心逻辑痕迹，只做 req/res 收发。
//
// 传输适配层（src/transport/inproc.mjs 与 src/server.mjs）**调用同一个 handleMemoryVec**，
// 所以"两种传输行为一致"是同源保证，不是靠对齐维持的。
//
// 本文件不认识宿主：宿主相关的读取全在 core/backend.mjs 的 bindHost() 注入点里。
import { embedQueries, checkEndpoint, DEFAULT_QUERY_INSTRUCTION } from './core/embed.mjs';
import { buildSourceText, buildEmbedText } from './core/chunkread.mjs';
// 语料入口（老块 + 派生块）。路由层原本直接调 `listChunks(cdir)`，
// 那样会把派生块漏在门外 —— 而且不报错，只是"搜不到最近的内容"。
import { listCorpus, readCorpusItem, readCorpusById, corpusStats } from './core/corpus.mjs';
import { scanSuspects, archiveFingerprint } from './core/vocab.mjs';
import { SLOT_CALIBER, slotCredibility } from './core/factstore.mjs';
import { topicOverlap } from './core/tokens.mjs';
import { FACT_KIND_GROUPS, FACT_KINDS } from './core/facts.mjs';
import { readNotes, writeNote, NOTE_MAX_CHARS } from './core/notes.mjs';
import { readLineage, foldNotes, canonicalLabel, relatedLabels } from './core/lineage.mjs';
import { groupNamesFor, forceRefreshGroupNames, readGroupNameCache } from './core/groupnames.mjs';
// 跨会话近况（`ADR-0043`）：短期历史按 chatKey 隔离 ⇒ 群里刚说的话私聊里没有。
// 这一层**只读**宿主 `messages/` 存档，把别的会话最近几分钟的原话摘一节出来。
import { collectCrossChatRecent, renderCrossChatLines, readChatArchive } from './core/crosschat.mjs';
import {
  buildInjectCandidates, buildProfileCandidates, selectInjectLines,
  renderInjectBlock, renderCombinedBlock, resolveMinScore, cosine,
  normalizeTraitKey, isMultiValueTrait, mergeMultiValue, DEFAULT_PROFILE_TOTAL,
  upsertSlotItem, LEGACY_ITEM_KEY, itemKeyOf, isMultiItemKind, MULTI_ITEM_KINDS,
  PROFILE_SCOPE_ALL, countProfileBlockedByScope, renderAttributeLine, renderProfileLine,
  DEFAULT_TOKEN_MIN_SCORE, tokenOverlapSims,
  scopeCensus, SCOPE_DOWNGRADE_FACTOR
} from './core/inject.mjs';
import { embedDocuments } from './core/embed.mjs';
import { distribution, judge, summarize } from './core/stats.mjs';
import { RANK_VERSION } from './core/rank.mjs';
import {
  chunksDir,
  DEFAULT_SETTINGS,
  dataDir,
  dataRoot,
  endpointOf,
  ensureIdentity,
  getRuntime,
  indexingProgress,
  identityScan,
  presetEndpoint,
  rankChecks,
  rankShadowHistory,
  refreshSettings,
  runGraphScan,
  runIndex,
  runJudgeScan,
  runRankScan,
  runConsolidateNow,
  consolidatePipelineStatus,
  storeDistribution,
  factStoreOf,
  mergeEntities,
  unmergeEntity,
  suggestMerges
} from './core/backend.mjs';
import { loadInstances } from './core/instances.mjs';
import {
  readEventLedger, readEventRows, readRecentEvents, renderEventSection, readEventsById, readHitLog, bumpEventHits,
  readPendingWindows, readEvidenceRows, eventIdOf,
  workingLayerOverview, workingLayerItems, PROMOTE_HITS, RETIRE_DAYS, RETIRE_HALFLIFE_GAIN, RETIRE_MIN_RECALL, RETIRE_HARD_RATIO
} from './core/consolidate.mjs';
import { getEventIndex, searchEvents, DEFAULT_EVENT_MIN_SCORE } from './core/event-index.mjs';
// 证据视图（`contracts` B）：`evidenceView` 只做**结构**判断，"引用到底存不存在"
// 由调用方拿真实账本核对 —— 这两个职责不能混在一个函数里，否则"没核对"会看起来像"核对过"。
import { evidenceView } from './core/provenance.mjs';

// ── HTTP 入口（由 src/app.js 的 routes 缝调用）────────────────────────────
const injectionReceipts = new Map();
const RECEIPT_TTL_MS = 60_000;
function issueReceipt(dir, chatKey, ids) {
  const now = Date.now();
  for (const [key, receipt] of injectionReceipts) if (receipt.expires <= now) injectionReceipts.delete(key);
  if (injectionReceipts.size >= 2048) injectionReceipts.delete(injectionReceipts.keys().next().value);
  const token = randomUUID();
  injectionReceipts.set(token, { dir, chatKey, ids: [...new Set(ids)], expires: now + RECEIPT_TTL_MS });
  return token;
}
const MAX_BODY = 1024 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error(`请求体超过 ${MAX_BODY} 字节`);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

// ── 主动检索的嵌入预算（`contracts` E）· [by:DS] 2026-10-29 ────────────────
// 三处预算**各按各的用途定，不许拉平**：
//   · `/search`、`/recall` 的 `auto` 路：共享 **1500ms**、`retries=0`
//     —— 它们是**人在等**的主动查询，卡住比查不到更糟；网络错误立刻走关键词，
//        慢连接耗尽预算再降级，两条路的 `degraded.reason.code` 分别可辨。
//   · `/inject`：**1800ms**（热路径，宿主每轮都调，改它会动到每轮延迟）—— 保持原值。
//   · 后台 `/index`：**不动**它的重试策略。批量索引要的是"最终写进去"，
//     把重试改成 0 只会让一次抖动留下一批永久缺口。
const QUERY_EMBED_BUDGET_MS = 1500;
const INJECT_EMBED_BUDGET_MS = 1800;

/**
 * 造一份"主动查询用"的嵌入端点：一条总预算 + 不重试。
 *
 * `signal` 同时接**客户端断开**与**总预算**：客户端走了以后再算 1.5 秒既没意义、
 * 又会在服务端留一个孤儿请求。
 */
function queryEndpoint(settings, extraSignal = null) {
  const budget = AbortSignal.timeout(QUERY_EMBED_BUDGET_MS);
  return {
    ...endpointOf(settings),
    retries: 0,
    timeoutMs: QUERY_EMBED_BUDGET_MS,
    signal: extraSignal ? AbortSignal.any([extraSignal, budget]) : budget
  };
}

/** 把嵌入失败折成**稳定**的降级原因（不是自然语言猜测）。 */
function embedFailureOf(err) {
  const code = String(err?.code || '');
  const cause = String(err?.cause || '');
  if (code === 'CANCELLED' || cause === 'CANCELLED') {
    return { code: 'budget-exhausted', budgetMs: QUERY_EMBED_BUDGET_MS,
      detail: `嵌入预算 ${QUERY_EMBED_BUDGET_MS}ms 用尽（可能是慢连接）` };
  }
  if (cause === 'TIMEOUT' || code === 'TIMEOUT') {
    return { code: 'budget-exhausted', budgetMs: QUERY_EMBED_BUDGET_MS,
      detail: `嵌入预算 ${QUERY_EMBED_BUDGET_MS}ms 用尽（单次请求超时）` };
  }
  return { code: 'network-error', budgetMs: QUERY_EMBED_BUDGET_MS,
    detail: `嵌入调用失败：${String(err?.message || err).slice(0, 160)}` };
}

/** 请求断开信号（客户端走了就别再算）。没有 `req` 时就给 null —— 不假装有。 */
function disconnectSignal(req) {
  const ctrl = new AbortController();
  if (typeof req?.once === 'function') req.once('close', () => ctrl.abort());
  return ctrl.signal;
}

// ── 事件层检索（事件账本 + 关键词 IDF，**不进向量库**）· [by:DS] 2026-10-29 ──
// 口径：分数是**查询覆盖率**（0~1 上不封顶），与块层的余弦 / 话题重合度**都不可比**。
// 所以事件永远放在自己的容器里回报，绝不与 `hits` 混排 ——
// 混排后"为什么这条排第一"就没有任何人能解释，而这正是要避免的静默失败。
function searchEventLayer(rt, { text = '', chatKey = '', limit = 8, minScore = DEFAULT_EVENT_MIN_SCORE, exclude = null } = {}) {
  const index = getEventIndex({ libDir: rt.dir });
  const hits = searchEvents(index, String(text || ''), { chatKey, limit, minScore, exclude });
  if (!hits.length) return { scanned: Number(index.N) || 0, hits: [] };
  const rows = readEventsById({ libDir: rt.dir, chatKey, ids: hits.map((h) => h.id), maxChars: 600 });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  // ⚠️ 检索命中但账本里读不出这一行（同时被回收 / 被 superseded）⇒ **丢掉**，
  //    不要用检索结果自己凑一个只有 id 的空壳冒充"事件还在"。
  return {
    scanned: Number(index.N) || 0,
    hits: hits.filter((h) => byId.has(String(h.id))).map((h) => ({
      ...eventItemOf(byId.get(String(h.id))),
      score: h.score,
      matched: h.matched,
      maxIdf: h.maxIdf ?? null,
      why: 'related'
    }))
  };
}

/** 事件账本一行 → 对外条目（`GET /memory/events` 与检索共用同一个形状）。 */
function eventItemOf(row) {
  return {
    source: 'event',
    id: String(row?.id || ''),
    windowId: String(row?.windowId || ''),
    chatKey: String(row?.chatKey || ''),
    title: String(row?.title || ''),
    summary: String(row?.summary || ''),
    fromTs: Number(row?.fromTs) || 0,
    toTs: Number(row?.toTs) || 0,
    state: eventStateOf(row),
    hits: Number(row?.hits) || 0
  };
}

/**
 * 向量库文档的 `source` 标签 —— **按 `meta.kind` 判，不按调用路径猜**。
 *
 * 为什么必须这么判：升长期（`embedEventRow`）会把事件也写进**同一个向量库**、
 * `kind:'event'`。所以"块层的检索结果"里本来就可能混着事件向量，
 * 一律标成 `chunk` 等于对调用方说谎 —— 它会影响"这段是原文还是摘要"的判断。
 */
function docSourceOf(meta) {
  return String(meta?.kind || '') === 'event' ? 'event' : 'chunk';
}

/**
 * 事件状态 —— **从账本字段派生，不新增状态列**（派生规则写在一处，读写两侧不会各说一套）。
 *
 * 顺序是有意的：`retiredAt` 是终点（回收了就不该再显示"已升长期"），
 * `dimmedAt` 是回收前的压暗，`promotedAt` 才是升长期。
 */
function eventStateOf(row) {
  if (row?.retiredAt) return 'retired';
  if (row?.dimmedAt) return 'dimmed';
  if (row?.promotedAt) return 'promoted';
  return 'working';
}

// ── 分页游标（`contracts` G）· [by:DS] 2026-10-29 ──────────────────────────
// 无状态游标：服务端不存分页快照，游标里自带"这页属于哪个筛选集 + 哪个账本快照"。
// 代价是账本一变就得从头翻；收益是没有陈旧快照要回收，也不会悄悄拼错页。
function digestOf(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 32);
}
function encodeCursor(o) {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}
function decodeCursor(raw) {
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!o || typeof o.f !== 'string' || typeof o.s !== 'string'
      || !Number.isFinite(Number(o.t)) || typeof o.i !== 'string') throw new Error('shape');
    return { f: o.f, s: o.s, t: Number(o.t), i: o.i };
  } catch {
    // 游标不是本服务发的（或被截断）⇒ 400：把坏游标当"第一页"会静默跳过内容
    throw new MemoryError('INVALID_CURSOR', '游标不是本服务发出的形式（base64url JSON）', 400);
  }
}

// ── 场合 ↔ chatKey 反查（`contracts` B 的 scopes[]）· [by:DS] 2026-10-29 ────
// `scopeLabel(chatKey)` 是 **HMAC 单向**的（`normalize.mjs`：`hmac32(secret,'scope\0'+k) % 空间`）
// ⇒ **没有逆函数**，只能"拿已知 chatKey 正算一遍、按值归拢"。
// 所以这个映射天然是**能力受限**的：不知道的场合只能报 unknown，绝不能拼一个"看起来像"的键。
// 这里唯一要做对的事是：**多个 chatKey 撞到同一 scope 时必须报 ambiguous，不能挑一个**。
function chatKeysByScope(rt, wantScopes = null) {
  const label = (ck) => {
    try { return rt.normalizer.scopeLabel(ck); } catch { return ''; }
  };
  const map = new Map();     // scope → Set(chatKey)
  const add = (ck) => {
    const k = String(ck || '').trim();
    if (!k) return;
    const s = label(k);
    if (!s) return;
    let set = map.get(s);
    if (!set) { set = new Set(); map.set(s, set); }
    set.add(k);
  };
  // ① 向量库里的会话（最权威：这些会话**真的有东西被记下来**）
  try { for (const c of rt.store.chats?.() || []) add(c.chatKey); } catch { /* 库没起来 ⇒ 只靠后面两处 */ }
  // ② 还没提交的窗口
  for (const w of readPendingWindows({ libDir: rt.dir }).windows) add(w.chatKey);
  // Human input is also a persisted, explicit source mapping (never infer a raw id from a scope).
  const manual=memoryCoreOf(rt,factStoreOf(rt)).manual;
  manual.log.assertReadable();
  for(const {data:d} of manual.log.rows) if(d.type==='addition') add(d.sourceChatKey);
  const missing = () => (wantScopes ? wantScopes.some((s) => !map.has(s)) : true);
  // ③ 只有前两处还认不全时才翻事件账本 —— 它是全量文件，能省就省
  if (missing()) {
    try {
      for (const row of readEventRows({ libDir: rt.dir }).rows) add(row?.chatKey);
    } catch { /* 账本读不动 = 少几个可解析项，不影响其它字段 */ }
  }
  return map;
}

/** 场合的显示名：群名缓存里有就用它，私聊给「私聊 号码」，都没有就照抄 scope（不编名字）。 */
function displayNameOf(rt, scope, chatKey) {
  const named = String(readGroupNameCache(rt.dir)?.names?.[scope] || '');
  if (named) return named;
  if (chatKey && String(chatKey).startsWith('private:')) return `私聊 ${String(chatKey).slice('private:'.length)}`;
  if (chatKey && String(chatKey).startsWith('group:')) return `群 ${String(chatKey).slice('group:'.length)}`;
  // 认不出是谁 ⇒ 用 scope 本身（它是占位符，不含明文）而不是编一个「未知群聊」
  return scope;
}

/**
 * 处理 /api/memory-vec/*。返回 true 表示已消费（调用方直接 return）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {{authorize:Function, json:Function, say?:Function}} helpers
 */
export async function handleMemoryVec(req, res, pathname, helpers) {
  const { authorize, json } = helpers;
  const say = typeof helpers.say === 'function' ? helpers.say : (m) => console.warn(m);
  if (!authorize(req)) {
    json(res, 401, { error: '未授权' });
    return true;
  }

  const method = req.method || 'GET';
  const sub = pathname.slice('/api/memory-vec/'.length);
  let responseInstanceId;

  try {
    if(sub==='memory/settings' && ['GET','POST'].includes(method)) {
      const rt=await getRuntime(),core=memoryCoreOf(rt,factStoreOf(rt)),adapter=hostSettings();
      responseInstanceId=core.instanceId;
      let result;
      if(method==='GET') result=adapter?.getMemorySettings ? adapter.getMemorySettings(DEFAULT_SETTINGS) :
        {ok:true,writable:false,reason:'当前宿主未提供配置写入适配器，请使用宿主设置页',...settingsView(rt.settings,DEFAULT_SETTINGS)};
      else {
        let body;try {body=await readJsonBody(req);} catch {throw new MemoryError('INVALID_ARGUMENT','请求必须是有效 JSON');}
        if(body?.expectedInstanceId!==core.instanceId) throw new MemoryError('INSTANCE_MISMATCH','请重新读取当前实例设置',409);
        if(!adapter?.updateMemorySettings) throw new MemoryError('SETTINGS_READ_ONLY','当前宿主未提供配置写入适配器',501);
        result=adapter.updateMemorySettings(body,DEFAULT_SETTINGS);
        await refreshSettings(rt);
      }
      json(res,200,{...result,instanceId:core.instanceId,contractVersion:1,
        dataRoot:hostConfig()?.DATA_DIR??null,sourceRoot:hostConfig()?.SOURCE_DIR??null});return true;
    }
    // Core-owned writes and read-model seam. Other management adapters may reuse memoryCoreOf.
    if (sub === 'memory/person' || sub === 'memory/entries' || sub === 'memory/policy-impact' || sub === 'memory/revisions' || sub === 'memory/diagnostics' || sub === 'memory/events' || sub === 'subjects' || sub.startsWith('subjects/')) {
      const rt = await getRuntime(); await ensureIdentity(rt); await refreshSettings(rt);
      const core = memoryCoreOf(rt,factStoreOf(rt));
      responseInstanceId = core.instanceId;
      if(req.headers?.['x-memory-instance-id'] && req.headers['x-memory-instance-id']!==core.instanceId) throw new MemoryError('INSTANCE_MISMATCH','Selected library instance does not match this service',409);
      const readCoreBody = async () => {
        let body;
        try { body=await readJsonBody(req); } catch(e) { throw new MemoryError('INVALID_ARGUMENT',e.message); }
        if(body?.expectedInstanceId && body.expectedInstanceId!==core.instanceId) throw new MemoryError('INSTANCE_MISMATCH','Selected library instance does not match this service',409);
        return body;
      };
      const u = new URL(req.url,'http://x');
      const finish = result => { json(res,200,{...result,instanceId:core.instanceId,contractVersion:1}); return true; };
      if (sub === 'memory/revisions' && method === 'POST') return finish(core.manual.commit(await readCoreBody()));
      if (sub === 'memory/entries' && method === 'POST') {
        const body=await readCoreBody();
        if(body.expectedInstanceId!==core.instanceId) throw new MemoryError('INSTANCE_MISMATCH','请重新加载目标记忆库后提交',409);
        const rawWho=requireText(body.who,'who',200);
        if(core.subjects.has(rawWho)) throw new MemoryError('NOT_A_PERSON','Use the subject endpoint');
        const n=rt.normalizer, entityId=n.byLabel?.get(rawWho);
        const hit=n.resolveKnown(rawWho)||n.resolveKnown(`qq:${rawWho}`)||(entityId?n.resolveKnown(entityId):null);
        // A stable person id selects its current identity; historical aliases are for reads.
        const direct=hit?.label || (n.byLabel?.has(rawWho)?rawWho:null);
        const labels=direct?[direct]:resolveWhoLabels(rt,rawWho);
        if(labels.length!==1) throw new MemoryError('INVALID_ARGUMENT','请使用唯一人物标识，不能用有歧义的昵称');
        const face=personFace(rt,labels[0]);
        if(face?.kind!=='person' && labels[0]!=='SELF') throw new MemoryError('INVALID_ARGUMENT','只能为已识别的人物新增记忆');
        const chatKey=requireText(body.chatKey,'chatKey',200);
        if(!/^(group|private):\d{5,15}$/.test(chatKey)) throw new MemoryError('INVALID_ARGUMENT','请填写实际场合，例如 group:群号 或 private:QQ号');
        const value=rt.normalizer.normalize(requireText(body.value,'value',4000),{register:false}).text;
        const itemKey=rt.normalizer.normalize(requireText(body.itemKey,'itemKey',100),{register:false}).text;
        const reason=body.reason ? rt.normalizer.normalize(requireText(body.reason,'reason',1000),{register:false}).text : undefined;
        return finish(core.manual.create({operationId:body.operationId,expectedInstanceId:body.expectedInstanceId,
          speaker:labels[0],scope:rt.normalizer.scopeLabel(chatKey),chatKey,kind:body.kind,itemKey,value,...(reason?{reason}:{})}));
      }
      if (sub === 'memory/person' && method === 'GET') {
        const who = u.searchParams.get('who');
        if (!who) throw new MemoryError('INVALID_ARGUMENT','who is required');
        if (core.subjects.has(who)) throw new MemoryError('NOT_A_PERSON','Use the subject endpoint');
        const labels = new Set(resolveWhoLabels(rt,who));
        const records = core.manual.records().filter(r=>labels.has(r.speaker)||labels.has(r.target));
        const items = core.manual.items(records);
        const scopeList = [...new Set(records.map(r=>r.scope))];
        const byScope = chatKeysByScope(rt, scopeList);
        return finish({ok:true,person:{query:who,labels:[...labels],...(personFace(rt,[...labels][0])||{})},items,
          scopes:scopeList.map(scope=>{
            const cands = [...(byScope.get(scope) || [])];
            // **只有唯一命中才算解析出来**：两个 chatKey 撞进同一 scope 时挑一个 = 把另一个人的场合
            // 挂到这个人物名下，比给 null 更糟（而且看起来一切正常）。
            const chatKey = cands.length === 1 ? cands[0] : null;
            const mappingStatus = cands.length === 1 ? 'resolved' : (cands.length ? 'ambiguous' : 'unknown');
            return { scope, chatKey, displayName: displayNameOf(rt, scope, chatKey), mappingStatus,
              ...(cands.length > 1 ? { candidateCount: cands.length } : {}),
              ...(mappingStatus === 'unknown' ? { reason: '没有已知 chatKey 能正算出这个 scope（scope 是单向 HMAC）' } : {}) };
          })});
      }
      if (sub === 'memory/policy-impact' && method === 'GET') {
        const who=u.searchParams.get('who'),chatKey=u.searchParams.get('chatKey');
        if(!who||!chatKey||!/^((group|private):).+/.test(chatKey)) throw new MemoryError('INVALID_ARGUMENT','who and a real chatKey are required');
        const labels=new Set(resolveWhoLabels(rt,who)),lineage=readLineage(rt.dir);
        if(!lineage.ok) throw new MemoryError('STORAGE_UNAVAILABLE',lineage.error,503);
        const winners=core.manual.project().filter(r=>labels.has(r.speaker)||labels.has(r.target));
        const people=[...labels].map(label=>({id:label,name:label}));
        const normalizer={resolveKnown:id=>labels.has(id)?{label:id}:null};
        return finish(policyImpact({winners,people,normalizer,lineage:lineage.entries,nowScope:rt.normalizer.scopeLabel(chatKey)}));
      }
      if(sub==='memory/diagnostics' && method==='GET') return finish({ok:true,
        capabilities:['memory.person','memory.entries.create','memory.settings.read',...(hostSettings()?.updateMemorySettings?['memory.settings.write']:[]),'memory.policy-impact','memory.revisions','memory.events','facts.evidence','subjects.read','subjects.create','subjects.aliases','subjects.merge','subjects.unmerge'],
        service:{version:'memory-core-v1'},vectors:{mode:null,generation:rt.store.generation??null,readOnly:!!rt.store.readOnlyReason,reason:rt.store.readOnlyReason??null},
        storage:{readOnly:!!(factStoreOf(rt).readOnlyReason||core.manual.log.readOnlyReason||core.subjects.log.readOnlyReason),reason:factStoreOf(rt).readOnlyReason||core.manual.log.readOnlyReason||core.subjects.log.readOnlyReason||null},
        pending:{windows:null,outbox:null},lastValidation:null});
      // GET /memory/events?chatKey=&state=&from=&to=&cursor=&limit=  · [by:DS] 2026-10-29
      // 分页语义（`contracts` B/G），三条都要能验证：
      //   ① 排序键 `(toTs, id)` **降序**，两个键都进游标 ⇒ 同毫秒的两条不会互换位置；
      //   ② 游标**绑定过滤条件**：换了 chatKey/state/时间窗还拿旧游标 ⇒ 400 INVALID_CURSOR
      //      （否则两个筛选集的页被拼在一起：看起来连贯，实际有重有漏）；
      //   ③ 账本在翻页途中变了 ⇒ 409 SNAPSHOT_CHANGED，**明确失败**。
      //      不承诺持久历史快照 —— 宁可让前端清空重载，也不给一份拼错的数据。
      if (sub === 'memory/events' && method === 'GET') {
        // ⚠️ 显式的 `limit=0` **不能**被 `|| 50` 静默改成 50（`0` 是 falsy）——
        //    调用方明确说了 0，服务端悄悄换一个数就是"参数被吃掉"，而返回 50 条看起来完全正常。
        const limitRaw = u.searchParams.get('limit');
        const limitNum = limitRaw === null || limitRaw === '' ? 50 : Number(limitRaw);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
          throw new MemoryError('INVALID_ARGUMENT', 'limit 必须是 1..100 的整数（不传 = 50）');
        }
        const limit = limitNum;
        const chatKey = String(u.searchParams.get('chatKey') || '').trim();
        const stateFilter = String(u.searchParams.get('state') || '').trim();
        const fromRaw = u.searchParams.get('from');
        const toRaw = u.searchParams.get('to');
        const fromTs = fromRaw === null || fromRaw === '' ? null : Number(fromRaw);
        const toTs = toRaw === null || toRaw === '' ? null : Number(toRaw);
        if (stateFilter && !['working', 'promoted', 'dimmed', 'retired'].includes(stateFilter)) {
          throw new MemoryError('INVALID_ARGUMENT', 'state 只能是 working / promoted / dimmed / retired（不是事实标签）');
        }
        for (const [name, v] of [['from', fromTs], ['to', toTs]]) {
          if (v !== null && (!Number.isFinite(v) || v < 0)) throw new MemoryError('INVALID_ARGUMENT', `${name} 必须是毫秒时间戳`);
        }
        if (fromTs !== null && toTs !== null && fromTs > toTs) throw new MemoryError('INVALID_ARGUMENT', 'from 不能晚于 to');
        const filters = { chatKey: chatKey || null, state: stateFilter || null, from: fromTs, to: toTs };
        const filtersDigest = digestOf(filters);

        const ledger = readEventRows({ libDir: rt.dir });
        const scoped = ledger.rows
          // `supersededBy` = 旧「窗口行」已被拆成一事一行 ⇒ 读侧跳过，否则同一批事出两遍
          .filter((r) => !r.supersededBy)
          .filter((r) => !chatKey || r.chatKey === chatKey)
          .filter((r) => fromTs === null || (Number(r.toTs) || 0) >= fromTs)
          .filter((r) => toTs === null || (Number(r.fromTs) || 0) <= toTs)
          .map((r) => ({ row: r, to: Number(r.toTs) || 0, id: String(r.id || '') }))
          .filter((k) => k.id);
        // `stateCounts` 按**没被 state 过滤**的那一批算：它是给界面画"各状态有多少条"用的，
        // 若按 state 过滤后再统计，选中任一状态时分页标签全是 0（看起来像数据没了）。
        const stateCounts = { working: 0, promoted: 0, dimmed: 0, retired: 0 };
        for (const k of scoped) stateCounts[eventStateOf(k.row)] += 1;
        const keyed = stateFilter ? scoped.filter((k) => eventStateOf(k.row) === stateFilter) : scoped;
        keyed.sort((a, b) => (b.to - a.to) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        // 快照 = 这一次筛选集的**内容指纹**（id + 时间 + 状态）。追加、回收、复活都会改它。
        const snapshotId = digestOf({ f: filtersDigest, rows: keyed.map((k) => [k.id, k.to, eventStateOf(k.row)]) });

        let start = 0;
        const cursorRaw = u.searchParams.get('cursor');
        if (cursorRaw) {
          const c = decodeCursor(cursorRaw);
          if (c.f !== filtersDigest) {
            throw new MemoryError('INVALID_CURSOR', '游标与当前过滤条件不匹配（换了 chatKey / state / 时间窗就得从头翻）', 400);
          }
          if (c.s !== snapshotId) {
            throw new MemoryError('SNAPSHOT_CHANGED', '账本在翻页途中变了：旧页不能和新页拼接，请清空后重载', 409);
          }
          start = keyed.findIndex((k) => k.to < c.t || (k.to === c.t && k.id < c.i));
          if (start < 0) start = keyed.length;
        }
        const page = keyed.slice(start, start + limit);
        const more = start + page.length < keyed.length;
        const nextCursor = more && page.length
          ? encodeCursor({ f: filtersDigest, s: snapshotId, t: page[page.length - 1].to, i: page[page.length - 1].id })
          : null;

        return finish({
          ok: true,
          items: page.map((k) => ({
            ...eventItemOf(k.row),
            // `sourceAvailable` 需要按 windowId 反查原文，本服务没有稳定入口
            // ⇒ 给 null（未知），**不**猜。前端按"未提供"处理，别渲染成可点。
            sourceAvailable: null,
            sourceAvailableReason: 'not-verified: 没有按 windowId 反查原文的稳定入口'
          })),
          nextCursor,
          snapshotId,
          filters,
          limit,
          total: keyed.length,
          stateCounts,
          // 账本坏行**不能**静默变成"少了几条"：坏了几行要说出来
          degraded: ledger.badLines || ledger.missing
            ? { code: ledger.missing ? 'LEDGER_MISSING' : 'LEDGER_CORRUPT', badLines: ledger.badLines || 0 }
            : null,
          note: '排序 (toTs, id) 降序；游标绑定过滤条件与账本快照，'
            + '换过滤条件 ⇒ 400 INVALID_CURSOR，账本变了 ⇒ 409 SNAPSHOT_CHANGED（不拼页）。'
            + 'state 由账本字段派生：retiredAt > dimmedAt > promotedAt > working。'
        });
      }
      // 观察写入**仍然未开放**：来源校验适配还没做完（每个引用要真在账本里、chatKey 派生
      // 的 scope 必须等于 sourceScope、reporterId 若给必须在证据里）。开放之后才加
      // `subjects.observations.write` 能力名 —— 现在加就是"声称能做但不能"。
      if (/^subjects\/[^/]+\/observations$/.test(sub)) {
        throw new MemoryError('FEATURE_UNAVAILABLE',
          '观察写入未开放：来源校验适配未完成（引用必须在账本中、chatKey 派生的 scope 必须等于 sourceScope、reporterId 必须在证据里）', 501);
      }
      if(sub==='subjects' && method==='GET') {
        if(u.searchParams.has('cursor')) throw new MemoryError('FEATURE_UNAVAILABLE','Subject pagination is not implemented',501);
        return finish({ok:true,items:core.subjects.list({kind:u.searchParams.get('kind')||undefined,q:u.searchParams.get('q')||''}),nextCursor:null});
      }
      if(sub==='subjects' && method==='POST') return finish(core.subjects.create(await readCoreBody()));
      const match=/^subjects\/([^/]+)(?:\/(aliases|merge|unmerge))?$/.exec(sub);
      if(match && method==='GET' && !match[2]) return finish(core.subjects.get(decodeURIComponent(match[1])));
      if(match && method==='POST' && match[2]) {
        const body=await readCoreBody(),id=decodeURIComponent(match[1]);
        return finish(match[2]==='aliases'?core.subjects.aliases({...body,subjectId:id}):match[2]==='merge'?core.subjects.merge({...body,fromId:id}):core.subjects.unmerge({...body,subjectId:id}));
      }
      throw new MemoryError('FEATURE_UNAVAILABLE','This subject operation has no verified-source adapter yet',501);
    }
    // GET /status
    if (sub === 'status' && method === 'GET') {
      const rt = await getRuntime();
      const status = rt.store.status();
      const cdir = await chunksDir();
      const chunks = listCorpus(await dataRoot(), { maxChars: rt.settings.maxChars });
      json(res, 200, {
        ok: true,
        store: status,
        core: {
          chunksDir: cdir,
          chunkCount: chunks.length,
          chats: [...new Set(chunks.map((c) => c.chatKey))].length,
          // 分源计数。**这一块是给"停更"留的可观测面**：
          // 老块哪天不再增长时，派生件数就是唯一的读数；如果派生件也变 0
          // 而宿主 `messages/` 里还有新消息，说明派生链路断了 —— 不报错，只是不涨。
          corpus: corpusStats()
        },
        embedded: rt.store.count,
        coverage: chunks.length ? Number((rt.store.count / chunks.length).toFixed(4)) : 0,
        // ── 事实层（`ADR-0032`）────────────────────────────────────────────
        // ⚠️ `store` 是**向量块**（`vecstore`），**不是**事实槽 —— 两者数量相近时
        //    尤其容易看错（实测某实例 `store.slots=18`，而事实槽只有 1 条）。
        //    这一块是"另一层"的计数，面板要能分开读到，不能拿 `store` 冒充。
        facts: (() => {
          const fs2 = factStoreOf(rt);
          const idx = fs2.index || {};
          const merged = fs2.stats().merged;
          return {
            slots: fs2.count,
            scopes: Object.keys(idx.by_scope || {}).length,
            people: Object.keys(idx.by_speaker || {}).length,
            by_kind: idx.by_kind || {},
            // ⚠️ `rebuildRequired` 是**运行期算出**的（`recount()` → `_checkRebuildRequired`），
            //    而上面几项都是从盘上 `index.json` 读的 —— 这正是它此前**看不见**的原因：
            //    库自己知道"代码已 v7、数据还是 v4/v6"，但那个结论没有出口，面板只能看到一个
            //    正常的槽数（`shadowMode` 同款病：信息在，只是没出口）。这一行就是它的出口。
            rebuildRequired: fs2.rebuildRequired || null,
            // 软删旁路（`ADR-0034`）：`applied` 是本次实际滤掉的槽数，`error` 非空 = 旁路读不动
            // （此时**故意**不滤：真值没问题，只是不知道滤哪些 ⇒ 服务照常，但要报出来）。
            merged,
            readOnly: Boolean(fs2.readOnlyReason),
            readOnlyReason: fs2.readOnlyReason || null
          };
        })(),
        indexJob: indexingProgress(),
        lastIndex: rt.lastIndex,
        // 上一轮判定的日志（**无内容**：只有字段名与簇的内部下标）——
        // 露出来是为了让面板"进页面先看上次跑成什么样"，不必为了看一眼日志再跑一次真判。
        // 真判会出境 + 花 LLM 调用，"为了看结果而重跑"本身就是一种浪费与风险。
        lastJudge: rt.lastJudge,
        lastError: rt.lastError,
        identity: identitySummary(rt),
        horizon: rt.horizon,
        settings: redact(rt.settings),
        preset: await presetEndpoint(),
        uptimeMs: Date.now() - rt.startedAt
      });
      return true;
    }

    // GET /instances —— 多实例总览（`ADR-0029`）：读**仓根** `instances.json` + 并发探活。
    // 只读、无副作用；清单缺席 / 坏 JSON / 单条非法一律回 **200**（让总览页说明原因）——
    // "总览页打不开"比"总览页告诉你哪一条错了"差得多。探活是唯一出网点（`GET /health`，只读）。
    // 每个实例的 `dataRootMatch` / `sourceRootMatch` = 清单写的 vs 运行期实际的**对账**：
    // 这是"哪些实例真连着自己那份库"的唯一判据，不靠"按理应该对"。
    if (sub === 'instances' && method === 'GET') {
      const man = await loadInstances();
      json(res, 200, {
        ok: true,
        repoRoot: man.repoRoot,
        manifestPath: man.path,
        manifestExists: !!man.exists,
        manifestError: man.error ?? null,
        version: man.version,
        problems: man.problems,
        self: man.self,
        instances: man.instances
      });
      return true;
    }

    // GET /items?offset&limit&chatKey&kind&q
    if (sub.startsWith('items') && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const page = rt.store.list({
        offset: Number(u.searchParams.get('offset')) || 0,
        limit: Number(u.searchParams.get('limit')) || 50,
        chatKey: u.searchParams.get('chatKey') || '',
        kind: u.searchParams.get('kind') || '',
        q: u.searchParams.get('q') || ''
      });
      json(res, 200, { ok: true, ...page, chats: rt.store.chats() });
      return true;
    }

    // GET /person?who=…&scope=… —— 人物卡（`ADR-0032`）：按人聚合的**只读视图**
    //
    // ── 为什么是"视图"而不是新一层存储 ──────────────────────────────────────
    // 宿主那套「人物印象」(`src/memory.js` 的 `impressions[]`) 已经在 `ADR-0024/0025`
    // 被退役过一次，理由就是它成了**第二套数据源**：同一个人的事同时躺在事实槽和
    // `people/<QQ>.json` 里，两边必然漂移，而漂移的表现是"搜到的和刚写的对不上"。
    // 所以这里**一条数据都不新增** —— 卡上每一行都来自现有事实槽，只是换个视角聚合。
    //
    // ── 为什么按 scope 分栏而不是合并成一张卡 ────────────────────────────────
    // 与 `ADR-0031 §3.8` 的场合隔离同源：把私聊里听到的和群里听到的**并成一段**，
    // 就等于在**面板这一侧**又把刚堵上的泄漏路径打开了（人看得见不等于可以让 bot 看见，
    // 但"合并展示"会诱导下一步真的去合并注入）。分栏是**保持可分辨**，不是洁癖。
    //
    // ⚠️ 只读端点：绝不写、绝不调 LLM、绝不触嵌入。查询走占位符，不落明文。
    if (sub === 'person' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const who = String(u.searchParams.get('who') || '').trim();
      const q = String(u.searchParams.get('q') || '').trim();
      // `kinds` 只在**带 who**（出卡）时生效；列人模式下它是无意义的（那人根本没有 kind 维度）。
      // 但不报错也不静默忽略 —— 见下面的响应回显 `kinds`，让调用方看见"我没被采纳"。
      const kp = parseKindsParam(u.searchParams.get('kinds'));
      if (kp.unknown.length) {
        json(res, 400, {
          ok: false,
          error: `未知标签：${kp.unknown.join(', ')} —— 标签是封闭枚举，拼错会静默搜出空结果。`,
          allowed: [...FACT_KINDS],
          groups: FACT_KIND_GROUPS
        });
        return true;
      }
      const store = memoryCoreOf(rt, factStoreOf(rt)).manual.readStore();

      // ── 不带 who ⇒ 列人（面板左栏）──────────────────────────────────────
      // 有槽的排在前面；`q` 还会**搜词表**，把"词表里有、记忆里没有"的人也列出来
      // —— 那个"slots=0"本身就是测试时最需要看见的信号。
      if (!who) {
        const listed = store.speakers().map((s) => ({
          ...s,
          ...(personFace(rt, s.speaker) || {})
        }));
        let people = listed;
        if (q) {
          // ── 两条命中路（`ADR-0033`）────────────────────────────────────────
          //   ① **词表**：占位符 label / 明文 id / 任一 surface 的**子串**命中。
          //      它回答"有没有这么个人"，与记忆内容无关。
          //   ② **事实文本**：拿查询与每条事实行算**话题重合度**（与 `/search` 同一口径）。
          //      它回答"谁身上记过跟这个词有关的事" —— 这是原来缺的那一半
          //      （`ADR-0032` §8 登记的"卡里无关键词搜索"）。
          // ⚠️ 两条路的结果**分开标**（`matchedIn`）：合起来显示会让人分不清
          //    "这人是名字对上了"还是"这人的记忆跟这事有关"，而这两种情况的下一步动作完全不同。
          const factHit = new Map();     // speaker label → { best, count, samples[] }
          for (const rec of store.slots.values()) {
            const line = String(rec.fact_kind) === 'trait'
              ? renderProfileLine(rec)
              : renderAttributeLine(rec);
            if (!line) continue;
            // 方向：**查询当 content、事实行当 topic**（与 `/search` 同向；行都短，取哪边都行，
            // 但必须与 `/search` 一致，否则同一个词在两处排名不同会变成查不出的怪事）。
            const score = topicOverlap(q, [line]);
            if (score < DEFAULT_TOKEN_MIN_SCORE) continue;   // 至少一个真词命中，单字巧合不算
            const sp = String(rec.speaker || '');
            if (!sp) continue;
            let h = factHit.get(sp);
            if (!h) { h = { best: 0, count: 0, samples: [] }; factHit.set(sp, h); }
            h.count += 1;
            if (score > h.best) h.best = score;
            if (h.samples.length < 3) h.samples.push({ kind: String(rec.fact_kind), line, score });
          }

          const vocabHit = (p) => {
            const names = [...(p.names || [])];
            return [p.speaker, p.id || '', ...names].join(' ').includes(q);
          };
          const decorate = (p) => {
            const fh = factHit.get(p.speaker);
            const matchedIn = [];
            if (vocabHit(p)) matchedIn.push('vocab');
            if (fh) matchedIn.push('facts');
            return fh
              ? { ...p, matchedIn, factBest: fh.best, factCount: fh.count, factSamples: fh.samples }
              : { ...p, matchedIn };
          };

          const seen = new Set(listed.map((p) => p.speaker));
          const vocab = [];
          for (const [id, e] of (rt.normalizer?.entities || new Map())) {
            if (e.kind === 'self') continue;
            const label = rt.normalizer.labelById?.get(id);
            if (!label || seen.has(label)) continue;
            const names = [...(e.surface || [])];
            const hay = [label, id, ...names].join(' ');
            if (!hay.includes(q)) continue;
            vocab.push({ speaker: label, slots: 0, id, kind: e.kind, names });
          }
          // 有事实命中的 speaker **一定**已在 `listed` 里（`speakers()` 就是全部有槽的人）
          // ⇒ 事实路只**标注**、不新增，不会出现"同一人两条"。
          people = [...listed.map(decorate), ...vocab.map((p) => ({ ...p, matchedIn: ['vocab'] }))]
            .filter((p) => p.matchedIn.length > 0)
            .sort((a, b) => b.slots - a.slots || a.speaker.localeCompare(b.speaker));
        }
        json(res, 200, {
          ok: true,
          count: people.length,
          q: q || null,
          // 说明这次用的是哪条路 —— 面板不再需要"猜为什么这个人出现了"
          qMode: q ? 'vocab+facts' : null,
          people: people.slice(0, 500)
        });
        return true;
      }

      // ── 带 who ⇒ 出卡 ───────────────────────────────────────────────────
      const labels = resolveWhoLabels(rt, who);
      if (!labels.length) {
        // ⚠️ 认不出必须**明说**（`ok:true` + 空卡 + reason），不能给一张空卡让人以为"这人没被记过"
        json(res, 200, {
          ok: true, found: false, who: { query: who, labels: [] }, totalSlots: 0, scopes: [],
          reason: `认不出「${who}」—— 它不在词表里（可能是新朋友，或者名字抄错了）。`
            + '名字会变，词表里认的是 QQ 号或占位符标签。'
        });
        return true;
      }

      const rowsAll = [];
      for (const label of labels) rowsAll.push(...store.slotsOfSpeaker(label));
      // 这个人的**全部**标签计数 —— 面板要拿它画筛选芯片。
      // 必须在过滤**之前**算：过滤后再数，没用过的标签会从选项里消失，
      // 于是就"再也点不回全部"（一次筛选把菜单自己吃掉了）。
      const allKinds = {};
      for (const r of rowsAll) {
        const fk = String(r.fact_kind || '');
        allKinds[fk] = (allKinds[fk] || 0) + 1;
      }
      const rows = kp.requested.length ? rowsAll.filter((r) => kp.set.has(String(r.fact_kind || ''))) : rowsAll;

      if (!rowsAll.length) {
        const face = personFace(rt, labels[0]);
        json(res, 200, {
          ok: true, found: true, who: { query: who, labels, ...(face || {}) }, totalSlots: 0, scopes: [],
          allKinds: {}, kinds: { requested: kp.requested, applied: [...kp.set] },
          reason: '这个人在词表里，但**一条事实都没有** —— 不是被挡了，是从来没记过。'
        });
        return true;
      }
      if (!rows.length) {
        // ⚠️ 必须与"从来没记过"分开说：筛空了看起来一模一样，但下一步动作完全不同
        //   （一个是"去聊出来"，一个是"换个标签"）。
        json(res, 200, {
          ok: true, found: true, who: { query: who, labels, ...(personFace(rt, labels[0]) || {}) },
          totalSlots: 0, allSlots: rowsAll.length, scopes: [], allKinds,
          kinds: { requested: kp.requested, applied: [...kp.set] },
          reason: `这个人有 ${rowsAll.length} 条事实，但**没有一条**属于你筛的标签（${kp.requested.join(' / ')}）。`
            + `TA 现有的标签：${Object.keys(allKinds).join(' / ')}。`
        });
        return true;
      }

      // 按 scope 分栏（场合可分辨）
      const cols = new Map();
      for (const r of rows) {
        const sc = String(r.scope || '');
        let col = cols.get(sc);
        if (!col) {
          col = { scope: sc, kind: sc.startsWith('group:') ? 'group' : (sc.startsWith('private:') ? 'private' : 'other'),
                  profile: [], facets: [], facts: [], _kinds: {} };
          cols.set(sc, col);
        }
        if (String(r.fact_kind) === 'trait') {
          for (const it of (Array.isArray(r.content?.items) ? r.content.items : [])) {
            const k = normalizeTraitKey(it?.k);
            const v = String(it?.v ?? '').trim();
            if (k && v) col.profile.push({ k, v });
          }
          continue;
        }
        const line = renderAttributeLine(r);
        if (!line) continue;   // 渲染不出正文的槽（坏行/空行）不出卡，与注入侧同口径
        const row = {
          kind: String(r.fact_kind),
          line,
          speaker: String(r.speaker),
          target: String(r.target || '') || null,
          evidence_n: Number(r.evidence_n) || 0,
          rev: Number(r.rev) || 0,
          credibility: slotCredibility(r),
          // ⚠️ 时间戳在 `derived_from.at`（`factstore.put` 落的就是这个位置）——
          //    写 `r.updatedAt` 会恒 `undefined`，而卡片上"什么时候记的"就永远空着，
          //    属于"看起来只是没显示"的静默缺字段。
          updatedAt: r.derived_from?.at || null
        };
        if (FACT_KIND_GROUPS.pragmatic.includes(row.kind)) col.facets.push(row);
        else col.facts.push(row);
      }

      // 组内排序：可信度高在前（与 `/inject` 的主键一致），平票按最新
      const byScore = (a, b) => (b.credibility - a.credibility) || (b.rev - a.rev);
      const scopes = [...cols.values()].map((c) => {
        c.facets.sort(byScore);
        c.facts.sort(byScore);
        const factsByKind = {};
        for (const f of c.facts) (factsByKind[f.kind] ||= []).push(f);
        const { _kinds, ...rest } = c;
        return { ...rest, factsByKind, counts: { profile: c.profile.length, facets: c.facets.length, facts: c.facts.length } };
      }).sort((a, b) => (b.counts.profile + b.counts.facets + b.counts.facts) - (a.counts.profile + a.counts.facets + a.counts.facts));

      // 卡上出现过的**其他人**（`target`）：面板要把 `P1234` 显示成人话。
      // 只带这些人，不带全词表 —— 卡是"一个人"的视图，附带一张几百人的表没有意义。
      const related = {};
      for (const r of rowsAll) {
        for (const lb of [String(r.speaker), String(r.target || '')]) {
          if (!lb || related[lb]) continue;
          const f = personFace(rt, lb);
          related[lb] = { label: lb, ...(f || {}) };
        }
      }

      const face = personFace(rt, labels[0]);
      json(res, 200, {
        ok: true,
        found: true,
        who: { query: who, labels, ...(face || {}) },
        totalSlots: rows.length,
        allSlots: rowsAll.length,
        allKinds,
        kinds: { requested: kp.requested, applied: [...kp.set] },
        scopeCount: scopes.length,
        scopes,
        related,
        note: '同一场合学到的才归在一栏（`ADR-0031 §3.8`）。分栏是故意的：私聊那栏的内容'
          + '**不会**出现在群里，面板上也不该并成一段 —— 合并展示会诱导下一步真的去合并注入。'
      });
      return true;
    }

    // GET /recall?who=&kinds=&q=&chatKey=&k=  —— **统一检索**：长期 + 近期一次给齐
    //
    // ── 为什么不是把两段塞进 `/search` ─────────────────────────────────────
    //   `/search` 是**纯向量检索**，它只认识向量库里的「小时块」（近期/中期）；
    //   长期记忆在 `slots.jsonl`（结构化事实），**从来没进过向量空间**。
    //   两套存储、两种匹配方式 ⇒ 硬塞进同一个 `hits` 会让「分数可比」这个错觉落地，
    //   而它们的 score 根本不是一回事（余弦 vs 话题重合度）。
    //   ⇒ 分两段返回，各带 `source` / `mode`，**不混排序**。
    //
    // ── `kinds` 是多值标签 ────────────────────────────────────────────────
    //   接受单标签（`trait`）、组名（`pragmatic` / `semantic`）、`all`，逗号分隔可多选。
    //   ⚠️ 未知标签**直接 400**：标签是封闭枚举，拼错会静默搜出空结果 ——
    //      那正是本仓最不能接受的失败形态（与 `/remember` 的 `BAD_FACT_KIND` 同口径）。
    if (sub === 'recall' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const who = String(u.searchParams.get('who') || '').trim();
      const qRaw = String(u.searchParams.get('q') || '').trim();
      const chatKey = String(u.searchParams.get('chatKey') || '').trim();
      const kLimit = Math.max(1, Math.min(50, Number(u.searchParams.get('k')) || 20));

      const kp = parseKindsParam(u.searchParams.get('kinds'));
      if (kp.unknown.length) {
        json(res, 400, {
          ok: false,
          error: `未知标签：${kp.unknown.join(', ')} —— 标签是封闭枚举，拼错会静默搜出空结果，所以这里直接拒绝。`,
          allowed: [...FACT_KINDS],
          groups: FACT_KIND_GROUPS
        });
        return true;
      }

      const visibility=u.searchParams.get('visibility') || 'same-scope';
      if(!['same-scope','policy'].includes(visibility)) throw new MemoryError('INVALID_POLICY','Invalid visibility');
      if(visibility==='policy' && !chatKey) throw new MemoryError('INVALID_ARGUMENT','policy visibility requires chatKey');
      const recallPolicy=resolveProfilePolicy({request:Object.fromEntries([...u.searchParams].filter(([k])=>['profilePolicy','profileCrossScope'].includes(k))),settings:rt.settings,existing:rt.policyBaseline?.existing !== false});
      const subjectId=u.searchParams.get('subjectId');
      if(subjectId) {
        if(who || !chatKey) throw new MemoryError('INVALID_ARGUMENT','subjectId requires chatKey and cannot be combined with who');
        const items=memoryCoreOf(rt,factStoreOf(rt)).subjects.select({scope:rt.normalizer.scopeLabel(chatKey),subjectId,limit:Math.min(100,Number(u.searchParams.get('k'))||8)});
        // `events` 给空壳而不是缺字段（`contracts` F：形状固定）—— 主体查询本来就不查短期层，
        // 缺字段会让调用方把"没查"当成"没数据"。
        json(res,200,{ok:true,subjects:{items,total:items.length},longTerm:{total:0,items:[]},recent:{mode:'none',total:0,items:[]},events:{mode:'none',applied:false,reason:'subject-query',items:[]}}); return true;
      }
      let labels = null;
      if (who) {
        labels = resolveWhoLabels(rt, who);
        if (!labels.length) {
          json(res, 200, {
            ok: true, found: false, query: { who, q: qRaw || null, kinds: kp.requested, chatKey: chatKey || null },
            reason: `认不出「${who}」—— 它不在词表里（可能是新朋友，或者名字抄错了）。名字会变，词表里认的是 QQ 号或占位符标签。`,
            longTerm: { total: 0, entries: 0, scanned: 0, byKind: {}, items: [] },
            recent: { mode: 'none', scanned: 0, total: 0, items: [], degraded: null }
          });
          return true;
        }
      }
      const labelSet = labels ? new Set(labels) : null;
      const wantScope = chatKey ? rt.normalizer.scopeLabel(chatKey) : '';

      // ── 长期段：结构化事实（不走向量，嵌入端点挂了也能用）──────────────────
      const store = memoryCoreOf(rt, factStoreOf(rt)).manual.readStore();
      const longItems = [];
      const byKind = {};
      let factScanned = 0;
      let longEntries = 0;   // 展开后的**键值条数**（`trait` 一个槽装多个键值 ⇒ 槽数会小于"看到几行"）
      for (const rec of store.slots.values()) {
        factScanned += 1;
        const fk = String(rec.fact_kind || '');
        if (!kp.set.has(fk)) continue;
        if (labelSet && !labelSet.has(String(rec.speaker || ''))) continue;
        if (wantScope && (visibility==='same-scope' ? String(rec.scope||'')!==wantScope : !evaluateVisibility({sourceScope:rec.scope,targetScope:wantScope,section:fk==='trait'?'profile':'attribute',policy:recallPolicy.id,isSelf:rec.speaker==='SELF'}).allowed)) continue;
        const line = fk === 'trait' ? renderProfileLine(rec) : renderAttributeLine(rec);
        if (!line) continue;
        let score = null;
        if (qRaw) {
          // 与 `/person?q=`、`/search` 关键词路**同一口径**（`topicOverlap`）；
          // 三处若各写一套，同一个词在不同页面排名不同，就会变成"查不出的怪事"。
          score = topicOverlap(qRaw, [line]);
          if (score < DEFAULT_TOKEN_MIN_SCORE) continue;
        }
        byKind[fk] = (byKind[fk] || 0) + 1;
        // ⚠️ 槽数 ≠ 看到几行：**多值槽**（`trait` 按属性、`speaker_profile` 按方面）是
        //    `{items:[{k,v}]}` —— "职业+爱好+所在地"或"风格+态度"可能只占 1 个槽。
        //    只报槽数会让人觉得"少记了"（2026-10-22 起 speaker_profile 也是多值槽）。
        const items = Array.isArray(rec.content?.items) ? rec.content.items : [];
        longEntries += items.length ? items.length : 1;
        longItems.push({
          source: 'facts',
          kind: fk,
          line,
          speaker: String(rec.speaker || ''),
          target: String(rec.target || '') || null,
          scope: String(rec.scope || ''),
          evidence_n: Number(rec.evidence_n) || 0,
          rev: Number(rec.rev) || 0,
          credibility: slotCredibility(rec),
          updatedAt: rec.derived_from?.at || null,
          ...(items.length
            ? { items: items.map((it) => ({ k: normalizeTraitKey(it?.k), v: String(it?.v ?? '') })) }
            : {}),
          score
        });
      }
      longItems.sort((a, b) => (qRaw
        ? (b.score - a.score) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        : String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))));

      // ── 近期段：向量库的小时块 ────────────────────────────────────────────
      // 按人筛的口径：块文本里出现 `〔P2358〕` —— 即"他在这个小时里说过话"。
      // 它不是"这段话是关于他的"（块内没有归属关系），note 里必须说清。
      const mentionHit = (text) => (labelSet ? [...labelSet].some((lb) => String(text || '').includes(`〔${lb}〕`)) : true);
      const mapChunk = (m) => ({
        // `source` 按文档类型给（事件向量也在同一个库里，见 `docSourceOf`）。
        // ⚠️ 这里**保持 `chunks`（复数）**：`/recall` 的 recent 容器早就是这个标签，
        //    改单数是破坏性变更，而 `/search` 的契约（`contracts` E）用的是 `chunk`（单数）——
        //    两个端点各按自己的既有口径，别为了"看着一致"去改调用方认识的值。
        source: docSourceOf(m) === 'event' ? 'event' : 'chunks',
        id: m.id, chatKey: m.chatKey, when: m.when || null,
        hourKey: m.hourKey || null, title: m.title || '', text: m.text || ''
      });

      const recent = { mode: 'list', degraded: null, scanned: 0, total: 0, items: [], reason: null };
      // ── 票 08 · [by:DS] 2026-10-28：按人筛**必须下推到候选阶段** ──────────────
      // 改前是 `wantRecent = kLimit * 6`（有 q）与 `limit: 500`（无 q），两者都是启发式：
      // 先取一批、再在内存里 filter，目标人的块只要排在候选之外就是**假空** ——
      // 评审 F09 实测：7 条他人高排名记录挡在前面，`recall(who=目标, k=1)` 返回 0 条，
      // 而底层同一索引先按人筛能返回那条。多取 6 倍只降低概率、**不能保证**；
      // 无 q 那条更糟：`list` 的 limit 被夹在 500，而调用方只取第一页，翻页没人接。
      // 现在把同一个谓词交给 `list` / `search` / `searchText` 三个入口，在**取前 k 条之前**生效。
      // 没有 `who` 时 `labelSet` 为 null ⇒ `mentionHit` 恒真 ⇒ 行为与改前逐字节一致。
      const acceptPerson = (m) => mentionHit(m?.text);

      if (!qRaw) {
        // `list` 内部全扫 metas：chatKey 与人物筛选都在循环里判，再取前 kLimit
        // ⇒ `raw.total` 是"这个会话里提到他的块总数"，不再是"扫了多少条"
        const raw = rt.store.list({ offset: 0, limit: kLimit, chatKey, filter: acceptPerson });
        recent.scanned = raw.total;
        recent.total = raw.total;
        recent.items = raw.items.map(mapChunk);
      } else {
        await ensureIdentity(rt);
        let qNormalized = qRaw;
        try {
          qNormalized = rt.normalizer.normalize(qRaw, { context: 'query', register: false }).text;
        } catch (e) {
          recent.reason = `normalize-failed: ${String(e?.message || e).slice(0, 120)}`;
          recent.mode = 'none';
        }
        if (!recent.reason) {
          const health = checkEndpoint(endpointOf(rt.settings));
          const takeExact = () => {
            // k 直接给 kLimit（不再是 6 倍）：筛选已在候选阶段生效，超取没有意义
            const r = rt.store.searchText({ text: qNormalized, k: kLimit, chatKey, kind: '', filter: acceptPerson });
            recent.mode = 'exact';
            recent.scanned = r.scanned;
            recent.items = r.hits.map((h) => ({
              ...mapChunk(h.meta), score: Number(h.score.toFixed ? h.score.toFixed(4) : h.score), matched: h.matched
            }));
          };
          if (!health.ok) {
            takeExact();
            recent.degraded = { from: 'vector', code: 'EMBED_UNCONFIGURED', reason: `嵌入端点不可用：${health.problems.join('；')}` };
          } else {
            try {
              const queryIdentity = { model: rt.settings.embedModel, encoding: encodingIdentity(rt.settings) };
              rt.store.assertQueryCompatibility(queryIdentity);
              const { vectors } = await embedQueries([qNormalized], {
                // 与 `/search` 同一份主动查询预算：1500ms、retries=0、接客户端断开。
                ...queryEndpoint(rt.settings, disconnectSignal(req)),
                normalizer: rt.normalizer,
                instruction: rt.settings.queryInstruction || DEFAULT_QUERY_INSTRUCTION
              });
              // 同上：`filter` 在打分循环内生效（vecstore.mjs `search` 第 590 行），
              // 所以拿到的是"按人筛完之后的前 kLimit 条"，不是"前 6k 条里恰好有他的"
              const r = rt.store.search({ ...queryIdentity, vector: vectors[0], k: kLimit, chatKey, filter: acceptPerson });
              recent.mode = 'vector';
              recent.scanned = r.scanned;
              recent.items = r.hits.map((h) => ({
                ...mapChunk(h.meta), score: Number(h.score.toFixed(6))
              }));
            } catch (e) {
              // `auto` 口径：探活通过但真发失败（端点半死不活）也要降级，不能直接 500。
              // `/recall` 是管理读面，没有"显式只许向量"的入口 ⇒ 一律降级并把码说清。
              const fail = embedFailureOf(e);
              takeExact();
              recent.degraded = { from: 'vector', ...fail, reason: fail.detail };
            }
          }
        }
      }
      recent.total = Math.max(recent.total, recent.items.length);

      // ── 事件段：短期层（一件事一行）· [by:DS] 2026-10-29 ────────────────────
      // 与 `recent`（小时块）**并列**，不是它的替代：块是"那一小时的原文"，事件是
      // "从原文里抽出来的一件事"。两者的分数也不同源（event-idf vs 余弦/话题重合度）
      // ⇒ 分两个容器给，谁都别想拿其中一个的分数去和另一个比。
      // 去重按**稳定 eventId**：同一件事在"最近"与"相关"两路命中只留一条，
      // 丢掉的条数记进 `deduped`（少了几条要能解释，不能凭感觉）。
      const events = {
        mode: 'list', applied: false, reason: null, itemSource: 'event',
        recentCount: 0, relatedCount: 0, deduped: 0, minScore: null, items: []
      };
      try {
        if (!chatKey) events.reason = 'no-chat-key';
        if (!events.reason) {
          const hitCounts = readHitLog({ libDir: rt.dir }).counts;
          const evCount = Math.max(1, Math.min(20,
            Number(u.searchParams.get('events')) || Number(rt.settings.consolidateInjectCount) || 6));
          const relMin = Math.max(0.01, Math.min(1,
            Number(rt.settings.consolidateEventMinScore) || DEFAULT_EVENT_MIN_SCORE));
          events.minScore = relMin;
          const recentRows = readRecentEvents({ libDir: rt.dir, chatKey, limit: evCount, maxChars: 600, hitCounts });
          // 跨容器去重：向量库里**已经给过**的事件（`recent.items` 里 `source==='event'` 的）
          // 不再在事件段重复一遍。去重键是稳定 `eventId` —— 同一件事念两遍比念不到更糟。
          const seen = new Set((recent.items || []).filter((i) => i.source === 'event').map((i) => String(i.id)));
          const items = [];
          for (const r of recentRows) {
            const id = String(r.id || '');
            if (!id) continue;
            if (seen.has(id)) { events.deduped += 1; continue; }
            seen.add(id);
            items.push({ ...eventItemOf(r), why: 'recent', score: null });
          }
          events.recentCount = items.length;
          if (qRaw) {
            // 归一化失败**不**静默改成搜原文：事件检索本来不出境，但"没归一化"必须写进
            // 响应（否则用户会以为它按占位符对上了）。
            let qEvent = qRaw;
            let normalized = true;
            try {
              qEvent = rt.normalizer.normalize(qRaw, { context: 'query', register: false }).text || qRaw;
            } catch { normalized = false; }
            events.queryNormalized = normalized;
            const ev = searchEventLayer(rt, { text: qEvent, chatKey, limit: kLimit, minScore: relMin, exclude: seen });
            // 二次去重：`exclude` 已经滤掉"最近"段给过的，这里再按 id 收一次，
            // 防的是同一次检索里同一 id 出现两行（账本迁移期的重复行）。
            for (const h of ev.hits) {
              if (seen.has(h.id)) { events.deduped += 1; continue; }
              seen.add(h.id);
              items.push(h);
            }
            events.relatedCount = ev.hits.length;
            events.scanned = ev.scanned;
          }
          events.items = items;
          events.applied = items.length > 0;
          if (!items.length) events.reason = qRaw ? 'no-match' : 'no-events-yet';
        }
      } catch (e) {
        events.reason = `read-failed: ${String(e?.message || e).slice(0, 120)}`;
        events.applied = false;
      }

      json(res, 200, {
        ok: true,
        found: true,
        query: { who: who || null, q: qRaw || null, kinds: kp.requested, chatKey: chatKey || null, k: kLimit },
        who: labels ? { query: who, labels, ...(personFace(rt, labels[0]) || {}) } : null,
        kinds: { requested: kp.requested, groups: kp.groups, applied: [...kp.set] },
        longTerm: { total: longItems.length, entries: longEntries, scanned: factScanned, byKind, items: longItems.slice(0, 200) },
        recent,
        events,
        note: '长期段来自 slots.jsonl（结构化事实，**不经过向量**）；近期段来自向量库的小时块；'
          + '事件段来自短期层账本（一件事一行，按稳定 eventId 去重）。'
          + '三段的分数**互不可比**：长期段是关键词重合度（无 q 时为 null），近期段是余弦或话题重合度，'
          + '事件段是 IDF 覆盖率（event-idf）；任何两段的分数都不许放在一张表里排序。'
          + '按人筛近期段的口径是「这个人在这个小时块里出现过」，不是「这段内容是写他的」——'
          + '块内没有归属关系，只能这样判。'
      });
      return true;
    }

    // GET /facts/versions?key=… —— 一个事实槽的全部历史版本（"查找更多证据"，ADR-0007）
    if (sub.startsWith('facts/') && method === 'GET') {
      const kind = sub.slice('facts/'.length);
      const u2 = new URL(req.url, 'http://x');
      const key = String(u2.searchParams.get('key') || '').trim();
      const rt = await getRuntime();
      const store = factStoreOf(rt);
      if (kind === 'versions') {
        if (!key) {
          json(res, 400, { ok: false, error: '缺少 key（槽的四元组键）' });
          return true;
        }
        const versions = store.versionsOf(key) || [];
        const core=memoryCoreOf(rt,store);
        core.manual.log.assertReadable();
        const manualHistory=core.manual.log.rows.filter(r=>r.data.key===key).map(r=>r.data);
        if (!versions.length && !manualHistory.length) {
          json(res, 404, { ok: false, error: `库里没有槽 ${key}` });
          return true;
        }
        json(res, 200, {
          ok: true,
          key,
          caliber: SLOT_CALIBER,
          count: versions.length,
          versions, manualHistory
        });
        return true;
      }
      if (kind === 'merged') {
        const stale = store.staleKeys();
        json(res, 200, {
          ok: true,
          ...store.mergedStats(),
          entries: store.mergedEntries(),
          // 口径陈旧的**活动**槽 —— 重判前置要退役的就是这批（spec §七.5）
          stale: { current: stale.current, count: stale.keys.length, directSkipped: stale.directKept },
          note: 'entries = 软删旁路记载（回滚 = 删一条）。'
            + 'stale.count = 口径过时、重判后会变成重复的活动槽数（**只含判定产物**）。'
            + 'stale.directSkipped = 版本号更早但属直写、**不退役**的槽数（它们无可重建来源）。'
        });
        return true;
      }
      // GET /facts/evidence?key=…&itemKey=… —— 这条事实到底从哪儿来的（`contracts` B）
      // · `provenance.evidenceView` 只做**结构**判断（level / state / references）；
      //   "引用到底存不存在"由这里拿真账本核对 —— 两件事混在一个函数里，
      //   就会出现"结构上像 exact"被当成"已确认精确来源"。
      // · 默认只回引用/时间/标题，**不**一次返回整段聊天，也**不**凭 hash 造原会话链接。
      if (kind === 'evidence') {
        if (!key) {
          json(res, 400, { ok: false, code: 'INVALID_ARGUMENT', retryable: false, error: '缺少 key（槽的四元组键）' });
          return true;
        }
        const itemKeyRaw = u2.searchParams.get('itemKey');
        const itemKey = itemKeyRaw === null ? null : String(itemKeyRaw);
        const core = memoryCoreOf(rt, store);
        // 走**人工修订投影后**的读模型：隐藏/替换要体现在视图里；
        // 但来源引用本身不改（人工修订不覆写证据，`contracts` C）。
        let rec = null;
        try {
          rec = core.manual.readStore().slots.get(key) || core.manual.records().find(r=>r.key===key) || null;
        } catch (e) {
          json(res, 503, {
            ok: false, code: e?.code === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'READ_FAILED',
            retryable: true, error: String(e?.message || e)
          });
          return true;
        }
        if (!rec) {
          json(res, 404, { ok: false, code: 'NOT_FOUND', retryable: false, error: `库里没有槽 ${key}` });
          return true;
        }

        // ① 先按结构取一遍引用（`exists` 恒 false）—— 只为了知道**要读哪几本账**
        const probe = evidenceView(rec, itemKey, () => false);
        const types = new Set(probe.references.map((r) => r.type));

        // ② 只读**确实需要**的那几本账。读不到就记 unreadable，
        //    让引用保持"没核对上" —— 不能因为账本读不动就把状态升级成 exact。
        const ledgers = { pending: null, events: null, messages: null, manual: null };
        const windowIds = new Set();
        const messageChat = new Map();
        const manualIds = new Set();

        if (types.has('window')) {
          const pw = readPendingWindows({ libDir: rt.dir });
          ledgers.pending = pw.ok ? 'ok' : `unreadable: ${pw.error}`;
          for (const w of pw.windows) {
            const id = eventIdOf(w);
            if (id) windowIds.add(id);
          }
          const ev = readEventRows({ libDir: rt.dir });
          ledgers.events = ev.missing ? 'missing' : (ev.badLines ? `corrupt-rows: ${ev.badLines}` : 'ok');
          for (const row of ev.rows) {
            if (row.supersededBy) continue;
            if (row.windowId) windowIds.add(String(row.windowId));
            if (row.id) windowIds.add(String(row.id));
          }
        }
        if (types.has('message')) {
          const ev = readEvidenceRows({ sourceRoot: await dataRoot() });
          ledgers.messages = ev.missing ? 'missing' : (ev.badLines ? `corrupt-rows: ${ev.badLines}` : 'ok');
          for (const row of ev.rows) {
            const id = String(row?.id ?? row?.mid ?? '');
            if (!id) continue;
            // 同一 id 出现在两个会话里是异常的 ⇒ 记成空串（既不等于任何 chatKey，也不会被当成可用）
            const ck = String(row?.chatKey || '');
            messageChat.set(id, messageChat.has(id) && messageChat.get(id) !== ck ? '' : ck);
          }
        }
        if (types.has('manual')) {
          try {
            core.manual.log.assertReadable();
            for (const row of core.manual.log.rows) {
              if (row?.data?.operationId) manualIds.add(String(row.data.operationId));
            }
            ledgers.manual = 'ok';
          } catch (e) {
            ledgers.manual = `unreadable: ${String(e?.message || e).slice(0, 120)}`;
          }
        }

        const exists = (r) => {
          const id = String(r?.id || '');
          if (!id) return false;
          if (r.type === 'window') return windowIds.has(id);
          if (r.type === 'message') {
            if (!messageChat.has(id)) return false;
            return !r.chatKey || messageChat.get(id) === r.chatKey;
          }
          if (r.type === 'manual') return manualIds.has(id);
          return false;
        };

        const view = evidenceView(rec, itemKey, exists);
        // ③ 窗口级引用**不许**冒充消息级精确出处（`contracts` B 第一条）。
        //    窗口提交后原文不留档，能证明的只有"这条事实出自那个窗口"。
        if (view.state === 'exact' && view.references.some((r) => r.type === 'window')) {
          view.state = 'window-match';
          view.reason = '窗口级来源：只证明这条事实是从那个窗口里抽出来的，不是消息级精确出处'
            + '（窗口提交后原文不留档，别把它当原文链接）';
        }
        if (!view.references.length) {
          view.reason = '没有任何持久来源引用；旧 hash 不可反查 ⇒ 不可用';
        } else if (itemKey !== null && view.level === 'slot') {
          // 请求了 itemKey 但这条槽没有项级来源 ⇒ 明说"整槽来源，不能证明此项"
          view.reason = `整槽来源（这条槽没有项级来源），不能证明「${itemKey}」这一项`
            + (view.reason ? `；${view.reason}` : '');
        } else if (!view.reason && view.state === 'ambiguous') {
          view.reason = '部分来源引用在账本里找不到（见 unresolved），只按"部分可解析"处理';
        }

        // ④ 取回原话（`withSource=1`）· [by:DS] 2026-10-29 ────────────────────
        // 为什么必须**再传一次 chatKey**：引用自己带着会话键，但那意味着"谁拿到一条事实
        // key 就能把任意会话的原话读出来"。这里要求调用方显式声明会话并逐个引用核对 ——
        // 不一致就整单拒绝（不返回任何原话），跨会话反查在这条路上不可能发生。
        let sourceLookup = null;
        const withSourceRaw = String(u2.searchParams.get('withSource') || '').toLowerCase();
        if (['1', 'true', 'yes'].includes(withSourceRaw)) {
          const asked = String(u2.searchParams.get('chatKey') || '').trim();
          if (!asked) {
            json(res, 400, {
              ok: false, code: 'INVALID_ARGUMENT', retryable: false,
              error: 'withSource=1 必须同时给 chatKey —— 取原话是跨会话的读操作，不能只凭一条事实 key 就放行'
            });
            return true;
          }
          // 只有 window / message 两类引用有原话可读；manual 是修订日志，本来就没有原话。
          const contentRefs = view.references.filter((r) => r.type === 'window' || r.type === 'message');
          const offChat = contentRefs.filter((r) => r.chatKey !== asked);
          if (offChat.length) {
            json(res, 400, {
              ok: false, code: 'CHATKEY_MISMATCH', retryable: false,
              error: `有 ${offChat.length} 条引用的会话与请求的 chatKey 不一致（或没有会话标注），拒绝跨会话取原话`,
              mismatched: offChat.map((r) => ({ type: r.type, id: r.id, chatKey: r.chatKey }))
            });
            return true;
          }
          const archiveRoot = await dataRoot();
          const sources = [];
          for (const r of view.references) {
            if (r.type === 'manual') {
              sources.push({ type: r.type, id: r.id, resolved: exists(r), status: 'not-applicable',
                reason: '人工修订是独立日志，没有原话可读' });
              continue;
            }
            const got = r.type === 'message'
              ? readChatArchive({ dataDir: archiveRoot, chatKey: asked, ids: [String(r.id)] })
              : (r.fromTs === null || r.toTs === null
                ? { status: 'unavailable', messages: [], matched: 0, scanned: 0, truncated: false, file: null,
                  reason: 'window-without-interval' }
                : readChatArchive({ dataDir: archiveRoot, chatKey: asked, fromTs: r.fromTs, toTs: r.toTs }));
            sources.push({
              type: r.type, id: r.id, resolved: exists(r),
              status: got.status, file: got.file ?? null,
              // `matchedBy` 要透出去：`inner-chat-key` 是内部元数据验证，
              // `legacy-filename` 只是旧存档的兼容推断，两者可信度不同（[by:DS] 2026-10-29 复审）
              matchedBy: got.matchedBy ?? null,
              scanned: got.scanned ?? 0, matched: got.matched ?? 0, truncated: got.truncated ?? false,
              reason: got.reason ?? null, candidates: got.candidates ?? undefined,
              messages: got.messages || []
            });
          }
          sourceLookup = {
            requested: true, chatKey: asked, sources,
            totalMessages: sources.reduce((n, s) => n + s.messages.length, 0),
            note: '原话按时间区间在会话存档里**重新取回**，不保证等同于当时送进模型的那一批；'
              + 'status=expired 表示存档在但区间内没有消息（多半已被清理），此时只剩摘要，别把摘要当原话。'
          };
        }

        json(res, 200, {
          ...view,
          key,                       // 显式回一次：调用方拿的是不透明 key，别让它去猜
          requestedItemKey: itemKey,
          references: view.references.map((r) => ({ ...r, resolved: exists(r) })),
          unresolved: view.references.filter((r) => !exists(r)).map((r) => ({ type: r.type, id: r.id })),
          ledgers,
          sourceLookup,
          note: 'exact 只在"显式持久引用 + 目标真在账本里"时给；窗口级来源只能到 window-match；'
            + '人工修订是独立日志，不改这里的原始来源。'
        });
        return true;
      }

      json(res, 400, { ok: false, error: `未知 facts 动作：${kind}`, allowed: ['versions', 'merged', 'evidence'] });
      return true;
    }

    // POST /facts/merged —— **软删旁路**的写入口（`ADR-0034`）
    // body: { action:'mark'|'clear'|'retire-stale', keys?:[…], into?:string|null, by?:string, confirm? }
    // ⚠️ 这是**唯一**能改 merged.json 的业务入口；`slots.jsonl` 一行不改 ⇒ 全部可回滚。
    if (sub === 'facts/merged' && method === 'POST') {
      const rt = await getRuntime();
      const store = factStoreOf(rt);
      if (store.readOnlyReason) {
        json(res, 409, { ok: false, error: `事实层只读：${store.readOnlyReason}` });
        return true;
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const action = String(body.action || '');

      if (action === 'mark') {
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (!keys.length) { json(res, 400, { ok: false, error: 'mark 需要 keys:[…]' }); return true; }
        const r = store.markMerged(keys, { into: body.into ?? null, by: body.by || 'api' });
        // ⚠️ `missing` 非空**不算失败**（批量里有些 key 本来就不存在是常态），但**必须回报** ——
        //    悄悄标了个不存在的 key，表现是"标了却没用"，没有任何别的症状。
        json(res, 200, { ok: true, action, ...r });
        return true;
      }

      if (action === 'clear') {
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (!keys.length) { json(res, 400, { ok: false, error: 'clear 需要 keys:[…]' }); return true; }
        const r = store.clearMerged(keys);
        json(res, 200, { ok: true, action, ...r });
        return true;
      }

      // 退役**全部口径陈旧的活动槽**（`into:null` 只落"退休标记"）——
      // 这是重判能安全跑起来的**前置**：重判产出新 key，老 key 不退役 ⇒ `/inject` 里同一件事出两遍。
      if (action === 'retire-stale') {
        // 批量写盘是有意为之的**不可逆动作**（虽可回滚但会动一批）⇒ 要求显式确认词（同 /maintenance 先例）
        if (String(body.confirm || '') !== 'retire-stale') {
          const stale = store.staleKeys();
          json(res, 400, {
            ok: false,
            error: 'retire-stale 要显式确认：body.confirm 必须等于 "retire-stale"',
            willRetire: stale.keys.length,
            directSkipped: stale.directKept,
            current: stale.current
          });
          return true;
        }
        const stale = store.staleKeys();
        const r = store.markMerged(stale.keys, { into: null, by: 'retire-stale' });
        // ⚠️ `directSkipped` **必须回报**：退役数远小于面板上"陈旧槽"总数是**正常**的
        //    （直写槽版本号更早但不受口径管辖、退役后无重建路径）。不报 ⇒ 看起来像没生效。
        json(res, 200, {
          ok: true, action, current: stale.current,
          retired: r.marked.length, directSkipped: stale.directKept, ...r
        });
        return true;
      }

      json(res, 400, { ok: false, error: `未知动作：${action || '(空)'}`, allowed: ['mark', 'clear', 'retire-stale'] });
      return true;
    }

    // GET /item/:id  （:id 里可能有 : 和 _，整体取）
    if (sub.startsWith('item/') && method === 'GET') {
      const rt = await getRuntime();
      const id = decodeURIComponent(sub.slice('item/'.length));
      const rec = rt.store.get(id);
      if (!rec) {
        json(res, 404, { ok: false, error: `库里没有 ${id}`, hint: '可能这个块还没被索引过' });
        return true;
      }
      // 附上核心原始块，方便对照"**出境文本**"和"原文"的差别
      // 这里按 id 查而不是按目录读：派生块不在磁盘上，只有语料层知道它在哪。
      const { chunk, error } = readCorpusById(await dataRoot(), id, { maxChars: rt.settings.maxChars });
      let info = null;
      let rawSource = null;
      if (chunk) {
        try {
          info = buildEmbedText(chunk, {
            normalizer: rt.normalizer,
            maxChars: rt.settings.maxChars,
            withKeywords: rt.settings.withKeywords !== false,
            keywordsSource: rt.settings.keywordsSource,
            withSummary: rt.settings.withSummary !== false,
            // 面板上的对照是"看"不是"学"，不要污染注册表
            register: false
          });
          rawSource = info.source;
        } catch (err) {
          info = null;
          rawSource = buildSourceText(chunk, {
            maxChars: rt.settings.maxChars,
            withKeywords: rt.settings.withKeywords !== false,
            keywordsSource: rt.settings.keywordsSource,
            withSummary: rt.settings.withSummary !== false
          }).text;
        }
      }
      json(res, 200, {
        ok: true,
        meta: rec.meta,
        vectorPreview: vecPreview(rec.vector),
        // 出境文本（送进嵌入端点的就是这一串）
        usedText: info?.text || '',
        usedChars: info?.usedChars || 0,
        fullChars: info?.fullChars || 0,
        truncated: Boolean(info?.truncated),
        // 本机原文（不出境）—— 两个并排放，用户自己看名字有没有被替干净
        sourceText: rawSource || '',
        redaction: info?.redaction || null,
        coreChunk: chunk ? { id: chunk.id, title: chunk.title, summary: String(chunk.summary || '').slice(0, 4000), keywords: chunk.keywords || [], when: chunk.when } : null,
        coreError: error || null
      });
      return true;
    }

    // POST /search  { q, k?, chatKey?, kind?, mode? } 或 { text, ... }
    //
    // ── `mode` 与降级（`ADR-0033`）──────────────────────────────────────────
    //   · `auto`（缺省）：先试**向量**；嵌入端点缺席/失败 ⇒ 自动走**关键词**，
    //     并在响应里 `degraded` 里**说清为什么**。**绝不静默换语义。**
    //   · `vector`：只要向量。端点不可用 ⇒ **400**（用户明确要向量，就给明确失败）。
    //   · `exact`：只要关键词。零嵌入调用 ⇒ **不再出现"没配端点就 400"**。
    //
    // 修复前的形态：没有 `mode`，端点没配就**直接 400**，而这曾经是唯一的读路 ——
    // 即"没配嵌入 = 完全查不了"。关键词路（宿主侧早就有一层字面重合排序）在本服务里
    // 一直是缺的，这一版把它补上（`ADR-0033`）。
    if (sub === 'search' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req);
      const text = String(body.q ?? body.text ?? '').trim();
      if (!text) {
        json(res, 400, { ok: false, error: '缺少查询文本（q）' });
        return true;
      }
      const k = Number(body.k) || Number(rt.settings.topK) || 8;
      const chatKey = body.chatKey || '';
      const kind = body.kind || '';
      // ⚠️ 这里的 `kind` 是**文档类型**（块文件名里的 `hour` / `day` / `ep`，以及 `event`），
      //    **不是**事实标签。传 `trait` 这类标签会命中 0 条、却照常回 `ok:true` ——
      //    与"这个人没被记过"在这个接口上完全无法区分，是典型的静默失败。
      //    要按标签查事实，走 `GET /recall?kinds=`（那是另一个存储）。
      const CHUNK_KINDS = ['hour', 'day', 'ep'];
      // `event` 是第四种文档类型（旧票 13）：**不是**把事件伪装成事实 kind。
      const SEARCH_KINDS = [...CHUNK_KINDS, 'event'];
      if (kind && !SEARCH_KINDS.includes(String(kind))) {
        json(res, 400, {
          ok: false,
          error: `kind=${kind} 不是文档类型 —— 这个参数指 hour / day / ep / event（块与事件的粒度），`
            + '不是事实标签。按标签（trait / preference / …）查长期记忆请用 GET /recall?kinds=…',
          allowedChunkKinds: CHUNK_KINDS,
          allowedSearchKinds: SEARCH_KINDS
        });
        return true;
      }
      const reqMode = ['auto', 'vector', 'exact'].includes(String(body.mode)) ? String(body.mode) : 'auto';

      const health = checkEndpoint(endpointOf(rt.settings));

      // ── kind=event：事件层 · [by:DS] 2026-10-29 ──────────────────────────
      // 事实比"计划"复杂，所以两条路**都给，并且各自说清自己覆盖什么**：
      //   · 向量路：升长期（`embedEventRow`）会把事件写进**同一个向量库**、`kind:'event'`。
      //     但只有"升过长期 + 配了嵌入端点"的事件才有向量 ⇒ 库里可能一条都没有。
      //   · 关键词路：事件账本 + IDF 覆盖率，覆盖**全部**未回收事件。
      // 所以这里永远同时返回 `events`（关键词层），`hits` 只反映本次 `mode` 实际走的那一路；
      // 零命中时分清 `no-event-vectors`（库里没有事件向量）与 `no-match`（有向量但没匹配）。
      if (String(kind) === 'event') {
        const eventVectors = (rt.store.metas || []).filter((m) => String(m?.kind || '') === 'event').length;
        const relMin = Math.max(0.01, Math.min(1,
          Number(body.minScore) || Number(rt.settings.consolidateEventMinScore) || DEFAULT_EVENT_MIN_SCORE));
        let qEvent = text;
        let normalized = true;
        try {
          await ensureIdentity(rt);
          qEvent = rt.normalizer.normalize(text, { context: 'query', register: false }).text || text;
        } catch {
          // 事件检索本来不出境 ⇒ 用原文照查，但**必须**在响应里说明这次没归一化过。
          normalized = false;
        }
        const keyword = searchEventLayer(rt, { text: qEvent, chatKey, limit: k, minScore: relMin });
        const base = {
          ok: true, q: text, qNormalized: normalized ? qEvent : null,
          requested: reqMode, kind: 'event', k,
          eventVectors: {
            inStore: eventVectors,
            note: '只有升过长期（promotedAt）且配了嵌入端点的事件才有向量；其余事件只在事件层（关键词路）。'
              + '所以向量路零命中**不等于**没有这件事。'
          },
          chatScope: chatKey || null,
          // 零命中时**必须**说清"没搜到 ≠ 没记住" —— [by:DS] 2026-10-29
          // 事件摘要只有被反复提起（升长期）、且配了嵌入端点，才会进语义库；
          // 其余只在这一层的关键词检索里。不给这句话，用户会以为"这件事她压根没记"。
          zeroHitHint: keyword.hits.length ? null
            : '这条检索没命中，不等于没记过这件事：事件摘要只有被反复提起（升过长期）才会进语义库，'
              + '更冷的事件只在这层的关键词检索里。换个说法（同义词 / 人名去掉）再试一次；'
              + '仍要确认"有没有记"，去翻事件列表而不是看这里的零命中。',
          events: {
            scoredBy: 'event-idf', minScore: relMin, scanned: keyword.scanned,
            count: keyword.hits.length, hits: keyword.hits
          }
        };
        const keywordAnswer = (extra) => json(res, 200, {
          ...base, ...extra, mode: 'exact', scoredBy: 'event-idf',
          scanned: keyword.scanned, count: keyword.hits.length, hits: keyword.hits,
          note: '事件层：score = 查询覆盖率（IDF 加权，0~1 上不封顶），与块层的余弦 / 话题重合度**都不可比**。'
            + '按稳定 eventId 去重；分数并列看命中的最罕见词（maxIdf）。'
            + (chatKey ? '' : '这次没给 chatKey ⇒ 结果是**跨会话**的，只适合管理/排障，别直接念给用户。')
            + (normalized ? '' : '归一化失败，本次用原文检索（未替换真名）。')
        });

        if (reqMode === 'vector' && !health.ok) {
          json(res, 400, {
            ok: false, requested: reqMode, mode: 'vector', kind: 'event',
            code: 'EMBED_UNCONFIGURED', retryable: false,
            error: `嵌入端点未配置：${health.problems.join('；')}`, problems: health.problems
          });
          return true;
        }
        if (reqMode === 'exact') { keywordAnswer({ degraded: null }); return true; }
        if (reqMode === 'auto' && !health.ok) {
          keywordAnswer({ degraded: { from: 'vector', code: 'EMBED_UNCONFIGURED',
            reason: `嵌入端点不可用：${health.problems.join('；')}` } });
          return true;
        }

        let vectors = null;
        try {
          const queryIdentity = { model: rt.settings.embedModel, encoding: encodingIdentity(rt.settings) };
          rt.store.assertQueryCompatibility(queryIdentity);
          ({ vectors } = await embedQueries([qEvent], {
            ...queryEndpoint(rt.settings, disconnectSignal(req)),
            normalizer: rt.normalizer,
            instruction: rt.settings.queryInstruction || DEFAULT_QUERY_INSTRUCTION
          }));
          const r = rt.store.search({ ...queryIdentity, vector: vectors[0], k, chatKey, kind: 'event' });
          json(res, 200, {
            ...base, mode: 'vector', scoredBy: 'cosine', degraded: null,
            scanned: r.scanned,
            // 零命中要说清是哪一种空：库里没有事件向量 vs 有向量但没匹配上
            reason: r.hits.length ? null : (eventVectors ? 'no-match' : 'no-event-vectors'),
            hits: r.hits.map((h) => ({
              source: 'event',
              id: h.id,
              score: Number(h.score.toFixed(6)),
              chatKey: h.meta.chatKey,
              title: h.meta.title,
              when: h.meta.when,
              text: h.meta.text
            })),
            note: '向量路：只有升过长期的事件在库里，余弦与块层可比（同一空间）；'
              + '但覆盖率不如事件层 —— 完整的事件候选看 events 容器。'
          });
          return true;
        } catch (e) {
          const fail = embedFailureOf(e);
          if (reqMode === 'auto') {
            keywordAnswer({ degraded: { from: 'vector', ...fail, reason: fail.detail } });
            return true;
          }
          // 显式 vector **不**静默换模式：给稳定错误码，由调用方决定重试还是换路。
          json(res, 502, {
            ok: false, requested: reqMode, mode: 'vector',
            code: fail.code === 'budget-exhausted' ? 'EMBED_BUDGET_EXHAUSTED' : 'EMBED_FAILED',
            retryable: true, error: fail.detail
          });
          return true;
        }
      }

      // 明确要向量、而端点根本没配 ⇒ 维持**旧契约**（400 + problems）。
      // 这是"配置没填"（客户端错），不是"网关挂了" —— 与下面 502 那条区分开。
      // 补 `code`/`retryable`（`contracts` F）：自然语言文案会漂，调用方要能按码分支。
      if (reqMode === 'vector' && !health.ok) {
        json(res, 400, {
          ok: false, requested: reqMode, mode: 'vector',
          code: 'EMBED_UNCONFIGURED', retryable: false,
          error: `嵌入端点未配置：${health.problems.join('；')}`, problems: health.problems
        });
        return true;
      }

      // ── 事件侧车（无 kind 时）· [by:DS] ──────────────────────────────────
      // `contracts` E：无 kind 的查询**可以**含事件。但绝**不**与 `hits` 混排：
      // 事件是关键词覆盖率（event-idf），块是余弦或话题重合度 —— 三种分数不可比，
      // 混进一个数组排序之后，"为什么这条排第一"没有任何人能解释。
      // 所以事件永远走**独立的** `events` 容器，每一条自带 `source:'event'`。
      const withEvents = body.includeEvents !== false;
      const eventSidecar = (qNorm) => {
        if (!withEvents) return { applied: false, reason: 'disabled-by-request' };
        if (!qNorm) return { applied: false, reason: 'no-normalized-query' };
        const relMin = Math.max(0.01, Math.min(1,
          Number(body.minScore) || Number(rt.settings.consolidateEventMinScore) || DEFAULT_EVENT_MIN_SCORE));
        try {
          const ev = searchEventLayer(rt, { text: qNorm, chatKey, limit: k, minScore: relMin });
          return { applied: true, scoredBy: 'event-idf', minScore: relMin, scanned: ev.scanned,
            count: ev.hits.length, hits: ev.hits };
        } catch (e) {
          // 事件层读不动**不能**拖垮块层结果：块已经查到了，这里只如实记原因
          return { applied: false, reason: `event-read-failed: ${String(e?.message || e).slice(0, 120)}` };
        }
      };

      // ── 关键词路（`exact`；或 `auto` 且端点不可用时的降级目标）──────────────
      // 归一化**仍然要做**：查询里的真名要先变成占位符，才能与库里的 `〔P1234〕` 对上
      // （库里从不存明文名 —— 这是 `ADR-0002` 的方向性）。它只依赖本地词表，不需要网络。
      if (reqMode === 'exact' || (reqMode === 'auto' && !health.ok)) {
        let qNormalized = text;
        try {
          await ensureIdentity(rt);
          qNormalized = rt.normalizer.normalize(text, { context: 'query', register: false }).text;
        } catch (e) {
          // 归一化失败**不能**降级成"搜原文" —— 那等于把出口闸门拆了（与 `ADR-0002` 同一条线上）。
          // 关键词路本来就不出境，所以这里返回"空结果 + 明说原因"，比搜出一堆名字强。
          json(res, 200, {
            ok: true, q: text, qNormalized: null, requested: reqMode, mode: 'exact',
            scoredBy: 'token-overlap', degraded: null, k, hits: [], scanned: 0,
            events: { applied: false, reason: 'normalize-failed' },
            reason: `normalize-failed: ${String(e?.message || e).slice(0, 120)}`,
            note: '归一化失败 ⇒ 拒绝检索（不降级成搜原文：那会把明文名字带出来的方向反过来）'
          });
          return true;
        }
        const r = rt.store.searchText({ text: qNormalized, k, chatKey, kind });
        json(res, 200, {
          ok: true,
          q: text,
          qNormalized,
          requested: reqMode,
          mode: 'exact',
          scoredBy: 'token-overlap',
          degraded: reqMode === 'auto'
            ? { from: 'vector', code: 'EMBED_UNCONFIGURED', reason: `嵌入端点不可用：${health.problems.join('；')}` }
            : null,
          k,
          scanned: r.scanned,
          candidates: r.candidates,
          indexBuilt: r.built,
          qTruncated: r.qTruncated,
          reason: r.reason,
          // ⚠️ `score` 是**话题重合度**（0~2，封顶），**不是**余弦相似度；
          //    两个数不可比、不可混进同一张分布图。所以这里**不给** `distribution`/`judgment`
          //    （那两个是按余弦分布校准的），改给一句口径说明。
          note: '关键词路：score = 话题重合度（0~2，含跳字 bigram），不是语义相似度；'
            + '并列按命中词数、再按时间新近排序。换个说法可能搜不到 —— 这就是要向量路的理由。'
            + '事件在独立的 events 容器里（分数不可比，不混排）。',
          events: eventSidecar(qNormalized),
          hits: r.hits.map((h) => ({
            source: docSourceOf(h.meta),
            id: h.id,
            score: h.score,
            matched: h.matched,
            chatKey: h.meta.chatKey,
            title: h.meta.title,
            when: h.meta.when,
            text: h.meta.text
          }))
        });
        return true;
      }

      await ensureIdentity(rt);
      // ★ 查询侧必须与文档侧**对称**地归一化（ADR-0002 第 4 条）。
      //   只归一化文档侧，问句里的真名就会落进另一个向量空间 ——
      //   静默降分、不报错，和"两侧编码写反"是同一个病。
      const qNormalized = rt.normalizer.normalize(text, { context: 'query', register: false }).text;
      let vectors, dim, framed, result;
      const queryIdentity = { model: rt.settings.embedModel, encoding: encodingIdentity(rt.settings) };
      try {
        rt.store.assertQueryCompatibility(queryIdentity);
        ({ vectors, dim, framed } = await embedQueries([qNormalized], {
          // 主动查询的端点：1500ms 总预算 + `retries=0` + 接客户端断开（`contracts` E）。
          // ⚠️ 只换这一处，`/inject`（1800ms）与后台 `/index`（各自的批量重试）都不动。
          ...queryEndpoint(rt.settings, disconnectSignal(req)),
          normalizer: rt.normalizer,
          instruction: rt.settings.queryInstruction || DEFAULT_QUERY_INSTRUCTION
        }));
        result = rt.store.search({ ...queryIdentity, vector: vectors[0], k, chatKey, kind });
      } catch (e) {
        // `auto` 下"刚才探活通过、真发时失败"必须**也**降级 —— 只按探活判断会漏掉
        // 端点半死不活（探活是浅检查）的情形，那时用户看到的是 500，而关键词路本来是能用的。
        const fail = embedFailureOf(e);
        if (reqMode === 'auto') {
          const r = rt.store.searchText({ text: qNormalized, k, chatKey, kind });
          json(res, 200, {
            ok: true, q: text, qNormalized, requested: reqMode, mode: 'exact',
            scoredBy: 'token-overlap',
            // `code` 是稳定判别：`network-error`（立刻失败）与 `budget-exhausted`（慢连接耗尽）
            // 在运维上是两件事，靠文案区分会被改写吃掉。
            degraded: { from: 'vector', ...fail, reason: fail.detail },
            k, scanned: r.scanned, candidates: r.candidates, indexBuilt: r.built,
            qTruncated: r.qTruncated, reason: r.reason,
            note: '关键词路：score = 话题重合度（0~2，含跳字 bigram），不是语义相似度。'
              + '事件在独立的 events 容器里（分数不可比，不混排）。',
            events: eventSidecar(qNormalized),
            hits: r.hits.map((h) => ({
              source: docSourceOf(h.meta),
              id: h.id, score: h.score, matched: h.matched,
              chatKey: h.meta.chatKey, title: h.meta.title, when: h.meta.when, text: h.meta.text
            }))
          });
          return true;
        }
        // 显式 `vector` **不**静默换模式：给稳定错误码，让调用方自己决定重试还是换路。
        json(res, 502, {
          ok: false, requested: reqMode, mode: 'vector',
          code: fail.code === 'budget-exhausted' ? 'EMBED_BUDGET_EXHAUSTED' : 'EMBED_FAILED',
          retryable: true,
          error: fail.detail
        });
        return true;
      }
      const scores = result.hits.map((h) => h.score);
      const dist = distribution(scores, { topK: Math.min(5, k) });
      json(res, 200, {
        ok: true,
        q: text,
        qNormalized,
        framed: framed?.[0] || '',
        dim,
        k,
        requested: reqMode,
        mode: 'vector',
        scoredBy: 'cosine',
        degraded: null,
        scanned: result.scanned,
        distribution: { ...dist, sorted: undefined, buckets: undefined },
        judgment: judge(dist, { topK: Math.min(5, k) }),
        events: eventSidecar(qNormalized),
        hits: result.hits.map((h) => ({
          source: docSourceOf(h.meta),
          id: h.id,
          score: Number(h.score.toFixed(6)),
          chatKey: h.meta.chatKey,
          title: h.meta.title,
          when: h.meta.when,
          text: h.meta.text
        }))
      });
      return true;
    }

    // POST /inject  —— M2 注入（ADR-0009）：把事实槽渲染成"人格属性句"给宿主钩子。
    // body: { chatKey, topic?, people?: [{id,name}], perPerson?, minScore?, total?, mode?, dry? }
    // 纪律：这是**宿主每轮都调**的热路径 —— 任何失败都必须"空结果 + ok:false"，绝不抛 500。
    if (sub === 'inject/ack' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req);
      const token = String(body.receipt || '');
      const receipt = injectionReceipts.get(token);
      if (!receipt || receipt.expires <= Date.now()) {
        injectionReceipts.delete(token);
        json(res, 200, { ok: true, accepted: false, reason: 'unknown-or-expired' });
        return true;
      }
      if (receipt.dir !== rt.dir || receipt.chatKey !== String(body.chatKey || '')) {
        json(res, 400, { ok: false, error: 'receipt-context-mismatch' });
        return true;
      }
      const rehearsal = bumpEventHits({ libDir: rt.dir, ids: receipt.ids, now: Date.now() });
      injectionReceipts.delete(token);
      json(res, 200, { ok: true, accepted: true, rehearsal });
      return true;
    }

    if (sub === 'inject' && method === 'POST') {
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      req.once?.('aborted', abort);
      res.once?.('close', abort);
      // 热路径预算：**1800ms**，与主动检索的 1500ms 分开定（改这里会动到每一轮注入的延迟）。
      const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(INJECT_EMBED_BUDGET_MS)]);
      const rt = await getRuntime();
      const body = await readJsonBody(req);
      const s = rt.settings;
      const lineageRead = readLineage(rt.dir);
      if (!lineageRead.ok) throw new Error(lineageRead.error);
      const lineage = lineageRead.entries;
      const enabled = body.dry ? true : (s.injectEnabled !== false);
      if (!enabled) { json(res, 200, { ok: true, injected: false, reason: 'injectEnabled=false', lines: [], block: '' }); return true; }

      const store = memoryCoreOf(rt, factStoreOf(rt)).manual.readStore();
      if (store.readOnlyReason) { json(res, 200, { ok: true, injected: false, reason: `store read-only: ${store.readOnlyReason}`, lines: [], block: '' }); return true; }

      const people = Array.isArray(body.people) ? body.people : [];
      const perPerson = Math.max(1, Math.min(6, Number(body.perPerson) || Number(s.injectPerPerson) || 2));
      const total = Math.max(1, Math.min(24, Number(body.total) || Number(s.injectTotal) || 8));
      // 阈值收敛收进纯函数（`resolveMinScore`，两条坑的说明见 `core/inject.mjs`）。
      // 修复前写作 `Number(body.minScore) ?? Number(s.injectThreshold) ?? 0.85` ⇒ `Number(undefined)`
      // 是 **NaN**，而 `NaN ?? x` 不回退 ⇒ minScore 恒 NaN ⇒ `sim >= NaN` 恒 false ⇒ `hot` 恒 false
      // ⇒「话题相关性加成」永久失效（ROADMAP 4.3 / ADR-0028）。实测活服务返回 `minScore: null`（NaN 的 JSON 化）。
      const minScore = resolveMinScore(body.minScore, s.injectThreshold);
      const mode = body.mode === 'hard' || (!body.mode && s.injectMode === 'hard') ? 'hard' : 'boost';

      // 当前场合（`ADR-0037`）：属性段与档案段**共用同一个值**，且必须在取候选之前算出来
      // —— 属性段的场合策略要它（`blocked` 的槽连候选都不进）。
      // ⚠️ `scopeLabel('')` 会把空串当**私聊**（kind 只看 `group:` 前缀）⇒ 必须先判空
      //    再派生，否则"没传 chatKey"会被当成一个合法场合 ⇒ 隔离**静默失效**。
      const chatKey = String(body.chatKey ?? '').trim();
      const nowScope = chatKey ? rt.normalizer.scopeLabel(chatKey) : '';

      // 档案段要不要服从场合隔离（2026-10-18 用户拍板，沿革见 `core/inject.mjs`
      // `profileScopeAllowed` 的第 ③ 条）。
      // ⚠️ 用 `'profileCrossScope' in body` 而不是 `body.profileCrossScope ?? s…`：
      //    面板传 `false` 必须能**盖掉**服务端的 `true`（否则关不掉，且关的动作无声失效）。
      const profilePolicy = resolveProfilePolicy({ request: body, settings: s, existing: rt.policyBaseline?.existing !== false });
      const profileCrossScope = profilePolicy.id !== 'same-scope';

      const candidates = buildInjectCandidates({
        winners: store.slots.values(),
        people,
        normalizer: rt.normalizer, lineage,
        perPerson,
        nowScope
      });
      // 「被场合挡掉 / 降权几条」—— 与 `profileBlockedByScope` 同一个理由：
      // 隔离的失败形态是**静默的**（注入变少、无报错），必须留可观测计数。
      const scopeStats = scopeCensus({
        winners: store.slots.values(), people, normalizer: rt.normalizer, lineage, nowScope
      });

      // 相似度：topic ↔ 每条候选的属性行。嵌入缺席/失败 ⇒ sims 缺省（hard 在 selectInjectLines
      // 里降级 boost——通过"没有 sims 就没有 hot"，由调用方把 mode 收敛成 boost）。
      let sims = null;
      // ⚠️ 初值必须是「还没试」，**不能**是 `'embed-unavailable'`（2026-10-22 修）。
      //    修复前初值是 `embed-unavailable`，而它只在下面 `if (candidates.length && topic)`
      //    里才会被覆盖 ⇒ **没传 topic / 没候选时根本没试过嵌入**，也照样报"端点不可用"。
      //    实测代价：按这个字段去查端点，查到的却是"端点 200 正常、带 topic 就 ok"。
      //    可观测字段报错归因，比没有字段更糟 —— 它会把人引向错误的方向。
      let simNote = 'not-attempted';
      // 用了哪条**度量**。⚠️ 必须显式回报：正余弦（0~1，按 1024 维模型校准）与
      // 话题重合度（0~2，按字面重合）**量纲不同、分布不同**，混进同一张图就是假的。
      let simMetric = null;
      let usedMinScore = minScore;
      let minScoreCaliber = null;      // 实际用的门槛属于哪个量纲：'cosine' | 'token' | null(没信号)
      const topic = String(body.topic || '').trim();
      // 没进入下面那段的两条路，各自留一个**能区分**的结论（而不是笼统的"不可用"）。
      if (!candidates.length) simNote = 'no-candidates';
      else if (!topic) simNote = 'no-topic';
      if (candidates.length && topic) {
        // 归一化只做一次、两条路共用（与 `/search` 同一条纪律：查询侧必须与文档侧对称）。
        let topicNorm = topic;
        try {
          topicNorm = rt.normalizer.normalize(topic, { context: 'query', register: false }).text;
        } catch (e) {
          simNote = `normalize-failed: ${String(e?.message || e).slice(0, 60)}`;
        }
        try {
          const ep = { ...endpointOf(s), signal, retries: 0 };
          const health = checkEndpoint(ep);
          if (health.ok) {
            const qv = (await embedQueries([topicNorm], { ...ep, normalizer: rt.normalizer, lineage, instruction: s.queryInstruction || DEFAULT_QUERY_INSTRUCTION })).vectors[0];
            // 属性行本来就是归一化后的文本（exemplar 出自归一化簇）—— 走文档侧编码。
            const dv = (await embedDocuments(candidates.map((c) => c.line), { ...ep, normalizer: rt.normalizer })).vectors;
            sims = dv.map((v) => cosine(qv, v));
            simNote = 'ok';
            simMetric = 'cosine';
            minScoreCaliber = 'cosine';
          } else {
            // 端点**真的**没配齐（空 baseURL / 空模型 / URL 非法）—— 这时才是"不可用"。
            // 把 `problems` 带出来：只写一句"不可用"等于让人自己去猜缺哪个字段。
            simNote = `embed-unavailable: ${health.problems.join('；')}`;
          }
        } catch (e) {
          simNote = `embed-failed: ${String(e?.message || e).slice(0, 80)}`;
        }

        // ── 关键词路（`ADR-0033`）：嵌入拿不到相似度时，用**字面重合**顶上 ──────
        // 修复前的形态：`sims` 保持 null ⇒ `selectInjectLines` 里没有 hot 概念 ⇒
        // **整段退化成"按可信度排"**（主题相关性完全消失），而这件事**只体现在
        // `simNote` 这一个字段里** —— 宿主适配层不看它，于是
        // 模型那边"注入的内容跟当下话题无关"完全无从察觉。现在改为有信号就排。
        if (sims === null && candidates.length) {
          try {
            sims = tokenOverlapSims(candidates.map((c) => c.line), topicNorm);
            simMetric = 'token-overlap';
            // ⚠️ **不复用** `minScore`：那是按**余弦**分布校准的（0.5 = "明显相关才排最前"），
            //    而重合度的刻度是"1 = 一次真词命中、0.2 = 只有单字巧合"。换个量纲还用同一个
            //    数字，等于用尺子量温度。这里用重合度自己的门槛（默认 1）。
            usedMinScore = DEFAULT_TOKEN_MIN_SCORE;
            minScoreCaliber = 'token';
            simNote = simNote === 'not-attempted' ? 'token-overlap' : `${simNote} → token-overlap`;
          } catch (e) {
            sims = null;
            simNote = `token-failed: ${String(e?.message || e).slice(0, 60)}`;
          }
        }
      }
      // 有信号就按请求的 mode 走（`hard` 不再无条件降级）；真的一条信号都没有才降 boost。
      const effMode = sims ? mode : 'boost';

      const { lines, droppedByThreshold } = selectInjectLines({
        candidates, sims, minScore: usedMinScore, mode: effMode, perPerson, total
      });

      // ── 档案段（`ADR-0031`）：`trait` 槽 → **常驻**档案行 ──────────────────
      //   · **不算相似度**（`sims: null`）：固定特征的价值与话题无关 —— "她是程序员"
      //     在聊做菜时一样要用。给它排 `hot` 只会让"相关才注入"的语义失真，
      //     顺带省掉一次嵌入往返。
      //   · **不占属性配额**：`perPerson` 是属性段的（默认 2），档案走独立的 `profileTotal`
      //     —— 否则"重复多次、证据更多"的 pattern 槽会把档案挤掉（档案 evidence_n 恒 1，
      //     可信度恒垫底，抢不过）。
      //   · **场合隔离**（`ADR-0031` §3.8）：只注入"在这个场合学到的"档案 ——
      //     私聊听来的住址/性取向不会出现在群里（硬闸，与属性段的降权策略**不同一套**，
      //     理由见 `ADR-0037`：属性段若也硬闸，现网 352/367 条私聊槽会让群聊注入归零）。
      //     `chatKey` / `nowScope` 已在属性段之前算好（两段共用同一个值）。
      const profileCandidates = buildProfileCandidates({
        winners: store.slots.values(), people, normalizer: rt.normalizer, lineage, nowScope,
        allowCrossScope: profileCrossScope, profilePolicy: profilePolicy.id
      });
      // 「被场合挡掉几条」—— 隔离的失败形态是**静默的**（档案没了、没有任何提示），
      // 留一个可观测的计数，排查时不用去猜"是没记过还是被挡了"。
      // ⚠️ `0.28.0` 起改为**按槽数**（`countProfileBlockedByScope`），不再用
      //    `profileAll.length - profileCandidates.length`：候选已按人合并，
      //    两边计量单位不同，相减得到的是"合并差"而不是"被挡条数"（会把 1 报成 0）。
      const profileBlockedByScope = countProfileBlockedByScope({
        winners: store.slots.values(), people, normalizer: rt.normalizer, lineage, nowScope,
        allowCrossScope: profileCrossScope, profilePolicy: profilePolicy.id
      });
      const profileTotal = Math.max(1, Math.min(24,
        Number(body.profileTotal) || Number(s.profileTotal) || DEFAULT_PROFILE_TOTAL));
      const { lines: profileLines } = selectInjectLines({
        candidates: profileCandidates,
        sims: null,          // 常驻信息不需要话题相关性 ⇒ 也不触发 hard→boost 降级判断
        mode: 'boost',
        perPerson: 1,        // 一个人的档案**合并成一行**（`k=v / k=v`），故每人至多 1 行
        total: profileTotal
      });

      const profileExplanation = profileSummary({winners:store.slots.values(),people,normalizer:rt.normalizer,lineage,nowScope,policy:profilePolicy,profileTotal});
      const subjectData = subjectSection(memoryCoreOf(rt,factStoreOf(rt)).subjects,nowScope,String(body.topic || ''),Math.min(4,Math.max(0,total-lines.length)));
      // ── 跨会话近况（`ADR-0043`）──────────────────────────────────────────────
      // 宿主短期历史按 `chatKey` **物理隔离**（`compose.js:1009` 只读本会话、
      // `:1366` 再 `filter(chatKey === 当前)`）⇒ 群里刚说的话，私聊提示词里**一行都没有**。
      // 宿主原有的 `api.architecture.crossChatAwareness` 那组键在新树里**没有任何消费方**
      // （实现随旧插件 conversation-memory 在 2026-10-18 移除），打开既不生效也不报错。
      // 这一段是它的替代：只读 `<源根>/messages/*.json`，零宿改。
      //
      // ⚠️ 两道闸**必须分开**（不合并的理由写在 `crossChatEnabled` 上面）：
      //    · 来源侧 `crossChatIncludePrivate`：私聊内容能不能被别人听见（默认不能）；
      //    · 目标侧 `crossChatInPrivate`：私聊要不要收别处动静（默认能，2026-10-19 拍板）。
      //    合并成一个键 ⇒ "想在私聊里知道群里的事"必然连带"群里能听见私聊的事"。
      const boolFrom = (k, dflt) => (Object.prototype.hasOwnProperty.call(body, k)
        ? (body[k] === true || body[k] === 'true')
        : dflt);
      const crossChatEnabled = boolFrom('crossChatEnabled', s.crossChatEnabled === true);
      const crossChatInPrivate = boolFrom('crossChatInPrivate', s.crossChatInPrivate !== false);
      // 目标侧（群）：默认开 —— 宿主 2026-09-23 的旧口径是"跨群只该在群与群之间发生"。
      // 单独一个键的理由与上面相同：只想要"私聊里知道群里的事"、又不想群里串味时，
      // 必须能只关群侧而不牺牲私聊（否则用户只能在"全开"和"全关"之间二选一）。
      const crossChatInGroup = boolFrom('crossChatInGroup', s.crossChatInGroup !== false);
      const crossChatIncludePrivate = boolFrom('crossChatIncludePrivate', s.crossChatIncludePrivate === true);
      const crossChatMinutes = Math.max(1, Math.min(240, Number(body.crossChatMinutes) || Number(s.crossChatMinutes) || 10));
      const crossChatMaxChats = Math.max(1, Math.min(8, Number(body.crossChatMaxChats) || Number(s.crossChatMaxChats) || 2));
      const crossChatMaxChars = Math.max(40, Math.min(600, Number(body.crossChatMaxChars) || Number(s.crossChatMaxChars) || 120));
      const chatKind = !chatKey ? '' : (chatKey.startsWith('group:') ? 'group' : 'private');
      const crossChat = {
        enabled: crossChatEnabled, inPrivate: crossChatInPrivate, inGroup: crossChatInGroup,
        includePrivate: crossChatIncludePrivate,
        minutes: crossChatMinutes, maxChats: crossChatMaxChats, maxChars: crossChatMaxChars,
        applied: false, sources: [], reason: null
      };
      // **空的结果也必须有理由**：跨会话段为空是常态（群里没人说话），
      // 与"读不到存档 / 被开关挡住"在提示词里长得一模一样 ⇒ 不回报就查不出。
      if (!crossChatEnabled) crossChat.reason = 'disabled';
      else if (!chatKey) crossChat.reason = 'no-chat-key';
      else if (chatKind === 'private' && !crossChatInPrivate) crossChat.reason = 'private-target-off';
      else if (chatKind === 'group' && !crossChatInGroup) crossChat.reason = 'group-target-off';
      if (!crossChat.reason) {
        try {
          const names = readGroupNameCache(rt.dir)?.names || {};
          const scopeOf = (key) => {
            try { return rt.normalizer.scopeLabel(key); } catch { return key; }
          };
          const want = collectCrossChatRecent({
            dataDir: await dataRoot(),
            excludeChatKey: chatKey,       // ⚠️ 必须排除自己，否则会把"当前会话"再念一遍
            minutes: crossChatMinutes,
            maxChats: crossChatMaxChats,
            maxChars: crossChatMaxChars,
            includePrivate: crossChatIncludePrivate,
            nameOf: (key) => names[scopeOf(key)]
          });
          crossChat.sources = want.sources;
          crossChat.reason = want.reason;
        } catch (e) {
          crossChat.reason = `read-failed: ${String(e?.message || e).slice(0, 80)}`;
        }
      }
      const crossChatLines = renderCrossChatLines(crossChat.sources, crossChatMinutes);
      crossChat.applied = crossChatLines.length > 0;

      // ── 事件段（M5，2026-10-22；`ADR-0048` 改为**两段并存**）──────────────
      // 本会话"最近发生过什么"。**按 chatKey 取值**，不走向量相似度。
      //   ① 【最近事件】：时间倒序 top N —— "刚才"必须**确定性**在场，
      //      不能取决于话题与摘要的余弦值。这是短期层的地基。
      //   ② 【相关事件】：关键词索引（倒排 + IDF）在**整个短期层**里找与当前话题
      //      相关、但不在 ① 里的事件 —— 三天前"决定周末去露营"在周末当天最该出现，
      //      而它永远进不了"最近 6 条"。两段**并列给**、不融合排序（2026-10-22 实测：
      //      两路 top8 交集 0~1 条，融合只会把两边的判断互相冲淡）。
      const eventLines = [];
      const events = {
        count: 0, applied: false, reason: null,
        relatedCount: 0, relatedApplied: false, relatedReason: null, relatedScores: []
      };
      const eventIdsForHit = [];        // 真正进了 lines 的事件 id（排练计数用）
      try {
        const evCount = Math.max(0, Math.min(20, Number(body.eventCount) || Number(s.consolidateInjectCount) || 6));
        const evChars = Math.max(40, Math.min(600, Number(s.consolidateInjectMaxChars) || 200));
        // 检索段的条数与门槛都可调：门槛是 0~1 的**覆盖率**（口径见 event-index.mjs）
        const relCount = Math.max(0, Math.min(12, Number(body.eventRelatedCount) || Number(s.consolidateEventRelatedCount) || 3));
        const relMin = Math.max(0.01, Math.min(1, Number(s.consolidateEventMinScore) || DEFAULT_EVENT_MIN_SCORE));
        const hitCounts = readHitLog({ libDir: rt.dir }).counts;

        if (!evCount) events.reason = 'count-zero';
        else if (!chatKey) events.reason = 'no-chat-key';
        if (!events.reason) {
          const recent = readRecentEvents({ libDir: rt.dir, chatKey, limit: evCount, maxChars: evChars, hitCounts });
          events.count = recent.length;
          const section = renderEventSection(recent, { maxChars: evChars });
          if (section) { eventLines.push(section); events.applied = true; eventIdsForHit.push(...recent.map((r) => r.id)); }
          else events.reason = 'no-events-yet';
        }

        // ② 相关段：只在**有话题**时才有意义（没有话题就没有"相关"可言）
        if (!relCount) events.relatedReason = 'count-zero';
        else if (!chatKey) events.relatedReason = 'no-chat-key';
        else if (!topic) events.relatedReason = 'no-topic';
        if (!events.relatedReason) {
          let q = topic;
          try { q = rt.normalizer.normalize(topic, { context: 'query', register: false }).text || topic; } catch { /* 用原文 */ }
          const index = getEventIndex({ libDir: rt.dir });
          const hits = searchEvents(index, q, {
            chatKey, limit: relCount, minScore: relMin,
            // 已经由最近段给过的不再重复给（同一件事念两遍比念不到更糟）
            exclude: new Set(eventIdsForHit)
          });
          // `matched` 一起回报：只给分数的话，"为什么是这几条"永远查不出来
          // （与 `simNote` 同一纪律：让失败/命中都**可解释**）。
          // `maxIdf` = 它命中的**最罕见**的词有多罕见 —— 分数并列时靠这个定先后
          // （口径见 `event-index.mjs` 的 `SCORE_TIE_EPS`）。只给分数的话，
          // "为什么是这几条"永远查不出来（与 `simNote` 同一纪律：命中也要**可解释**）。
          events.relatedScores = hits.map((h) => ({
            id: h.id, score: h.score, matched: h.matched,
            maxIdf: h.maxIdf ?? null
          }));
          if (hits.length) {
            const rows = readEventsById({ libDir: rt.dir, chatKey, ids: hits.map((h) => h.id), maxChars: evChars, hitCounts });
            events.relatedCount = rows.length;
            const section = renderEventSection(rows, {
              maxChars: evChars,
              title: '相关事件（本会话较早，与当前话题沾边，悄悄参考，不要主动提及）'
            });
            if (section) {
              eventLines.push(section);
              events.relatedApplied = true;
              eventIdsForHit.push(...rows.filter(r => r.summary).map((r) => r.id));
            } else events.relatedReason = 'render-empty';
          } else events.relatedReason = 'no-match';
        }
      } catch (e) {
        if (!events.reason) events.reason = `read-failed: ${String(e?.message || e).slice(0, 80)}`;
        events.relatedReason = events.relatedReason || `read-failed: ${String(e?.message || e).slice(0, 80)}`;
      }

      // ── 排练计数（`ADR-0048` ⑥）────────────────────────────────────────
      // **只对真正进了最终 lines 的事件 +1**：`eventIdsForHit` 只在 `eventLines.push`
      // 成功之后才收 id，所以"检索命中但没渲染出来"的不算排练（那只是被索引扫到）。
      // 失败不抛：计不上次数只会让升长期慢一点，不该让这一轮注入失败。
      let rehearsal = { bumped: [], skipped: 0 };
      try {
        if (!body.dry && body.rehearsal !== 'deferred' && !signal.aborted) rehearsal = bumpEventHits({ libDir: rt.dir, ids: eventIdsForHit, now: Date.now() });
      } catch (e) {
        rehearsal = { bumped: [], skipped: 0, reason: String(e?.message || e).slice(0, 80) };
      }
      events.rehearsed = rehearsal.bumped.length;
      events.rehearsalSkipped = rehearsal.skipped;
      if (rehearsal.reason) events.rehearsalReason = rehearsal.reason;

      const receipt = !body.dry && body.rehearsal === 'deferred' && !disconnected.signal.aborted && eventIdsForHit.length
        ? issueReceipt(rt.dir, chatKey, eventIdsForHit) : null;
      json(res, 200, {
        ok: true,
        receipt,
        rehearsalMode: body.dry ? 'dry' : body.rehearsal === 'deferred' ? 'adopted' : 'legacy-rendered',
        injected: lines.length > 0 || profileLines.length > 0 || crossChatLines.length > 0 || eventLines.length > 0 || subjectData.subjectLines.length > 0,
        mode: effMode,
        minScore: usedMinScore,        // **实际生效**的门槛（可能来自余弦，也可能来自重合度）
        candidates: candidates.length,
        // 场合策略的可观测出口（`ADR-0037`）：`blocked` = 私密上浮到公开被挡、
        // `downgrade` = 同级跨场合降权补位。没有这两个数，"注入变少了"就查不出原因。
        scopePolicy: {
          scope: nowScope || null,
          same: scopeStats.same,
          downgrade: scopeStats.downgrade,
          blocked: scopeStats.blocked,
          downgradeFactor: SCOPE_DOWNGRADE_FACTOR
        },
        profileDetails: profileExplanation.details,
        policySummary: profileExplanation.summary,
        ...subjectData,
        profileCandidates: profileCandidates.length,
        profileBlockedByScope,
        profileScope: nowScope || null,   // 场合不明 ⇒ null（此时档案段必为空）
        // 档案段是否服从场合隔离（`false` = 跨场合已放开）。**必须回报**：
        // 开关打开后 `profileBlockedByScope` 恒 0，不再能当作"有没有被挡"的判据 ——
        // 不回报就只剩"档案没了"这一个现象，查不出是没记过还是被放开了。
        profileCrossScope,
        droppedByThreshold,
        simNote,
        // 用了哪条度量 + 实际生效的门槛 + **用户配的那个余弦门槛**（原样回报，
        // 免得"我明明设了 0.85"变成一个查不出来的问题）。
        simMetric,
        minScoreCaliber,
        configuredMinScore: minScore,
        lines,
        profileLines,
        // 跨会话段（`ADR-0043`）：`applied` 才是"这一轮提示词里到底有没有这一段"。
        // `sources` 空 + `reason` 有值 = 有开关但没内容/被挡住，两者必须能分辨。
        crossChat,
        // 事件段（M5）：`applied` 才是"这一轮提示词里到底有没有这一段"，
        // `reason` 说明为什么没有（没整理过 / 条数被关到 0 / 读失败）。
        events,
        block: (renderCombinedBlock({ profileLines, lines, crossChatLines, eventLines }) || (subjectData.subjectLines.length ? '<!--mv-inject-->' : '')) + (subjectData.subjectLines.length ? `\n【主体观察（保留不同意见，仅本场合）】\n${subjectData.subjectLines.map(l=>'- '+l).join('\n')}` : '')
      });
      return true;
    }

    // POST /remember —— **写侧**：模型在对话中直写一条事实（M5「记事实」）
    //
    // ── 为什么落点在事实槽，而不是向量库 ───────────────────────────────────
    // 它要"取代"宿主原版的 `memory_append`（写 `data/memory/people/*.json`，由宿主
    // 核心注入进 prompt 的【对群友的印象】段）。要真的取代，写入的东西就必须落在
    // **能被读回来的那条路径**上 —— 而本服务读事实的路径就是 factstore：
    //   · `/inject` 每轮从 `store.slots` 挑候选（`buildInjectCandidates`）⇒ 写完即刻生效；
    //   · 与 M4 判定产的槽**同型**（`content.text` 由 `renderAttributeLine` 渲染）⇒
    //     面板既有的事实浏览页、可信度口径、版本留痕全部直接复用；
    //   · 单一真值源：不额外写一份 vecstore 条目（那会引入双写与 coverage 口径失真）。
    // "向量化"发生在这条链路的读取侧：`/inject` 对候选行**现算** embed 再算余弦
    // （见下面 inject 端点），所以直写的事实天然参与语义排序，不需要额外落一份向量。
    //
    // ── 三条硬规矩 ─────────────────────────────────────────────────────────
    //   ① **不肯写明文**：文本过归一化器（真名→占位符），speaker 走 `resolveKnown`
    //      （解析不出就拒绝，不猜——猜出来的槽会挂在一个不存在的人身上，且静默）。
    //   ② **不伪造证据**：`evidence_n` 只由调用方给的 evidence 决定（空 = 0）。
    //      模型自己写的事实本就"只有一次观察"，credibility 低是**事实**，不是 bug。
    //   ③ **失败必须说出来**：读路径可以静默降级，写路径不能 —— 静默的写失败 =
    //      模型以为记住了、实际没有，且没有任何地方会再提起这件事。
    if (sub === 'remember' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req).catch(() => ({}));
      const s = rt.settings;

      if (s.rememberEnabled === false) {
        json(res, 200, { ok: false, saved: false, reason: 'rememberEnabled=false（面板已关掉直写）' });
        return true;
      }

      const store = factStoreOf(rt);
      if (store.readOnlyReason) {
        json(res, 503, { ok: false, saved: false, error: `事实库处于只读状态，拒绝写入：${store.readOnlyReason}` });
        return true;
      }

      const deliveryId = String(body.deliveryId || '').trim();
      if (deliveryId && !/^[a-zA-Z0-9_-]{1,128}$/.test(deliveryId)) {
        json(res, 400, { ok: false, error: 'invalid-delivery-id' }); return true;
      }
      const delivery = deliveryId ? { id: deliveryId, fingerprint: createHash('sha256').update(JSON.stringify({
        chatKey: body.chatKey, userId: body.userId, kind: body.kind, text: body.text,
        attr: body.attr, aspect: body.aspect, evidence: body.evidence
      })).digest('hex') } : null;
      const delivered = delivery ? store.deliveryOf(delivery.id) : null;
      if (delivered) {
        if (delivered.delivery.fingerprint !== delivery.fingerprint) {
          json(res, 409, { ok: false, error: 'delivery-id-content-mismatch' }); return true;
        }
        json(res, 200, { ok: true, saved: false, action: 'noop', replayed: true, rev: delivered.rev });
        return true;
      }

      // ① chatKey：scope 是身份的一部分，缺了就是把"在哪儿说的"并进同一个槽。
      const chatKey = String(body.chatKey ?? '').trim();
      if (!chatKey) {
        json(res, 400, { ok: false, saved: false, error: 'chatKey 必填 —— 事实的 scope 由它派生（"在哪儿说的"是身份的一部分）' });
        return true;
      }

      // ② 人：QQ 号 → 占位符（两形态都试，与 /inject 同一口径）。
      const uid = String(body.userId ?? '').replace(/^qq:/, '').trim();
      if (!/^\d{5,15}$/.test(uid)) {
        json(res, 400, { ok: false, saved: false, error: `userId 必须是 QQ 号（收到 ${JSON.stringify(String(body.userId ?? ''))}）` });
        return true;
      }
      const hit = rt.normalizer.resolveKnown(uid) || rt.normalizer.resolveKnown(`qq:${uid}`);
      if (!hit?.label) {
        json(res, 400, {
          ok: false,
          saved: false,
          error: `认不出这个 QQ 号：${uid} —— 它不在词表里（可能是新朋友，或号码抄错了）。`
            + '别改用昵称：昵称会变，写进去的槽会挂在一个谁也认不出的人身上。'
        });
        return true;
      }

      // ③ kind：只许**语义段** + speaker_profile（pattern 是成簇判定产的，不接受直写）。
      //    `ADR-0031` 起再加 `trait`：固定档案的**唯一**来源是直写 —— 抽取管道产不出它
      //    （"重复措辞"信号与"说一次就成立"的档案信息不匹配，实测见 `_scratch/verify-trait-extract.mjs`）。
      const allowed = [...FACT_KIND_GROUPS.semantic, 'speaker_profile', 'trait'];
      const kind = String(body.kind ?? '').trim() || 'preference';
      if (!allowed.includes(kind)) {
        json(res, 400, {
          ok: false, saved: false,
          error: `kind 不在允许集合里：${kind}（合法：${allowed.join(' / ')}）`
        });
        return true;
      }

      // ④ 文本：**归一化后再落盘**（出境红线——事实槽会被渲染进 prompt）。
      const rawText = String(body.text ?? '').trim();
      if (!rawText) {
        json(res, 400, { ok: false, saved: false, error: 'text 必填' });
        return true;
      }
      const norm = rt.normalizer.normalize(rawText, { register: false });
      const text = String(norm.text || '').trim();
      if (!text) {
        json(res, 400, { ok: false, saved: false, error: '归一化后文本为空，没东西可写' });
        return true;
      }

      // ⚠️ scope 必须**自己算**，不能指望 `store.scopeOf(chatKey)` ——
      // `factStoreOf(rt)` 建实例时**没注入 normalizer**（`openFactStore(dir)` 无 opts），
      // 所以 `this.normalizer` 是 null、`scopeOf()` 一律抛 `NO_SCOPE_LABEL`。
      // 这不是本端点的特例：M4 判定路径也是"调用方在 put 里自带 scope"（backend.mjs:1274）。
      // `/inject` 之所以没暴露它，是因为它只读 `store.slots`、从不调 scopeOf。
      const scope = rt.normalizer.scopeLabel(chatKey);
      const previous = store.getSlot({ speaker: hit.label, target: '', fact_kind: kind, scope });

      // ⑤ 证据集：模型给了消息 id 就用它；没给 ⇒ 记一条**来源标记** `self-report`。
      //
      // ⚠️ 这不是"伪造证据"，是一个必须显式做出的取舍，代价两边都是真的：
      //   · 用空数组：`evidence_n = 0` ⇒ `slotCredibility = 0` ⇒ 在 `/inject` 的候选
      //     排序里**恒定垫底**（排序主键就是可信度，见 inject.mjs 头注释）。
      //     后果不是"排后面"，而是**永远轮不到注入** —— 记了却想不起来，功能等于没接。
      //   · 用常量标记：credibility = 1（最低档但**有值**），且**确定性**
      //     —— 同内容重复记仍然是 noop，不会因为缺证据就把台账写膨胀。
      //   为什么会话里没有真实的证据 id：宿主工具 `ctx` 只有 {chatKey, kind, store,
      //   memory, onebot, session…}，**不含 messages**（src/orchestrator.js:2168），
      //   插件拿不到"本轮看过哪些消息"，只能由模型从 prompt 的 `#数字` 里抄。
      //   出处由 `content.source = 'assistant-remember'` 与这条标记共同标死，
      //   任何消费方都看得出"这是模型自述的一条，不是从消息簇判定出来的"。
      // ⑤ 多值槽：`trait` 按**属性名**、`speaker_profile` 按**方面**做项级 upsert。
      //
      // ⚠️ 为什么必须按项写而不是整槽覆盖：其余 kind 的 `content.text` 是**一句话**
      //    ⇒ 同一个人的「职业」与「爱好」会**互相覆盖**（实测 `_scratch/verify-trait-collision.mjs`
      //    ①：连记三条只剩最后一条）。档案是**清单** ⇒ content 放 `items[]`、按属性名定位替换。
      //    这正是 `facts.mjs`「同槽多个并存值是**内容里的集合**，不是多行」那条既有哲学的直接用。
      //
      // ⚠️ `speaker_profile` 于 2026-10-22 并入同一条机制：槽键是 `(speaker,target,kind,scope)`
      //    ⇒ 一个 kind 一个槽；若内容是一句话，"说话风格"与"对某人的态度"就互相顶掉。
      //    旧系统 `people/*.json` 的 `impressions[]` 是**数组**（一人可躺 4 条）—— 这是
      //    "印象比旧版少"的**结构性**原因之一，不只是调用频次（号B 实测：35 槽里
      //    speaker_profile 占 17 条，全靠覆盖维持）。项名 = 方面（`body.aspect`，缺省 `整体`）。
      //    实现见 `inject.mjs` 的 `upsertSlotItem` / `slotItems`。
      //
      // 🆕 2026-10-23（`ADR-0048`）：`preference` / `grudge` 也并入这条机制 ——
      //    它们的项名 = **方面**（`body.aspect`）。清单本身在 `inject.mjs` 的
      //    `MULTI_ITEM_KINDS`，这里**只查表、不自己列**（两处各列一份必然分叉）。
      let content = { text, source: 'assistant-remember' };
      let previousText = previous ? String(previous.content?.text || '') : '';
      const itemKey = itemKeyOf(kind, { attr: body.attr, aspect: body.aspect });
      if (kind === 'trait' && !itemKey) {
        json(res, 400, {
          ok: false, saved: false,
          error: 'kind=trait 时 attr 必填 —— 档案按属性名定位（职业/年龄/爱好…）；'
            + '没有属性名就只能整槽覆盖，那会把这个人的其它属性挤掉'
        });
        return true;
      }
      if (itemKey) {
        const up = upsertSlotItem(previous, itemKey, text, {
          // 多值属性（爱好/忌口/技能…）：**累加去重**，不是替换 ——
          // "爱好=画画" 再写 "爱好=打游戏" ⇒ "画画、打游戏"，覆盖就是丢东西。
          mergeMulti: kind === 'trait' && isMultiValueTrait(itemKey)
        });
        previousText = up.previousValue;
        content = { items: up.items, source: 'assistant-remember' };
      }

      // ⚠️ **多值槽恒用 `self-report`**（`itemKey` 非空即多值槽）：`items` 是**累积型**内容，
      //    每次只增/改一项 ⇒ 若允许真实证据条数，聚合（`resolveSlotRows` 的 evidence-max，
      //    平票才看 rev）会挑"证据更多"的**旧**版本，把这次新写的方面整个丢掉 —— 静默丢数据。
      //    evidence_n 恒 1 ⇒ 恒平票 ⇒ latest-wins，正是累积型内容需要的口径。
      const isMultiItem = !!itemKey;
      const evidence = isMultiItem
        ? ['self-report']
        // ⚠️ `trait` **恒用** `self-report`：evidence_n 必须恒为 1，否则聚合会挑错赢家 ——
        //    `resolveSlotRows` 是 evidence-max（**平票才看 rev**），而档案会**过期**（换工作/改称呼），
        //    正确口径是 **latest-wins**。evidence_n 恒 1 ⇒ 恒平票 ⇒ 取 rev 最大 ⇒ **天然最新赢**，
        //    **不必改 `SLOT_CALIBER`**（实测 `_scratch/verify-trait-collision.mjs` ③）。
        : (Array.isArray(body.evidence) && body.evidence.length
          ? body.evidence.map((x) => String(x)).filter(Boolean)
          : ['self-report']);

      let r;
      try {
        r = store.put({
          speaker: hit.label,
          target: '',
          fact_kind: kind,
          scope,
          // ⚠️ `content` 必须是**确定性**的 —— 它进 `contentFingerprint`（facts.mjs），
          // 而同内容 ⇒ 同指纹 ⇒ `compareAndUpdate` 才回 noop。第一版在这里塞了
          // `at: new Date().toISOString()`，于是每次调用的指纹都不同 ⇒ **noop 永不生效**：
          // 同一条事实重复记会每次都 +1 rev（实测 rev 1→2），台账无界膨胀。
          // 时间戳改走 `put({at})` —— 它只落进 `derived_from.at`，**不进指纹**，
          // "什么时候记的"照样留痕。
          content,
          evidenceIds: evidence,
          delivery,
          at: new Date().toISOString()
        });
      } catch (e) {
        // 写失败必须报出来（三条硬规矩 ③）
        json(res, String(e?.code || '').startsWith('BAD_') ? 400 : 503, { ok: false, saved: false, error: `写入失败：${String(e?.message || e)}`, code: e?.code || '' });
        return true;
      }

      json(res, 200, {
        ok: true,
        saved: r.action === 'update',
        action: r.action,               // 'update' = 记账了；'noop' = 同内容已存在，没重复写
        rev: r.rev,
        kind,
        // 多值槽的项名：trait=属性名、其余（speaker_profile/preference/grudge）=方面名。
        // 回执用它组织"哪个属性/方面被更新了"的措辞（`itemKey` 是统一字段，另两个为兼容保留）。
        itemKey: itemKey || undefined,
        attr: kind === 'trait' ? (itemKey || undefined) : undefined,
        aspect: isMultiItemKind(kind) ? itemKey : undefined,
        speaker: hit.label,
        text,
        // 归一化动了什么：动了就说明文里出现过真实身份 —— 模型不该在回复里把原话念出来
        identityRewritten: norm.text !== rawText,
        evidenceN: evidence.length,
        previous: previousText
          ? { text: previousText, rev: previous?.rev ?? 0, source: String(previous?.content?.source || 'judge') }
          : null
      });
      return true;
    }

    // GET /neighbors/:id?k=
    if (sub.startsWith('neighbors/') && method === 'GET') {
      const rt = await getRuntime();
      const id = decodeURIComponent(sub.slice('neighbors/'.length));
      const u = new URL(req.url, 'http://127.0.0.1');
      const k = Number(u.searchParams.get('k')) || 10;
      const nb = rt.store.neighbors(id, k);
      if (!nb) {
        json(res, 404, { ok: false, error: `库里没有 ${id}` });
        return true;
      }
      json(res, 200, {
        ok: true,
        id,
        k,
        hits: nb.hits.map((h) => ({
          id: h.id,
          score: Number(h.score.toFixed(6)),
          chatKey: h.meta.chatKey,
          title: h.meta.title,
          when: h.meta.when,
          text: h.meta.text
        }))
      });
      return true;
    }

    // POST /index  { limit?, chatKey?, force?, maxEmbed? }  —— 手动跑一轮索引
    if (sub === 'index' && method === 'POST') {
      // getRuntime() 内部已把设置刷新成盘上最新值（端点/别称改完不用重启）
      const rt = await getRuntime();
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await runIndex({
        reason: 'manual',
        limit: body.limit,
        chatKey: body.chatKey,
        force: Boolean(body.force),
        // 本轮最多嵌多少条：不传 = 跑到底。用于"先跑一小段看看/余额不多时分批跑"。
        maxEmbed: body.maxEmbed,
        // 只扫不嵌：全量重建前先看"要发多少条、多少条出不去"，一个字节都不出境。
        dryRun: Boolean(body.dryRun),
        // 构建完先不切代（留给新旧代同查询比对）
        noPublish: Boolean(body.noPublish),
        // 事件向量来源身份判定为 unknown 时是否仍允许原样搬运。
        // 默认 false = fail-closed：来源身份证不了就不搬、不切代（旧代继续服务）。
        // 这是一个**必须显式写出来**的开关，不能靠"看起来一样"默认放行。
        allowUnknownCarry: body.allowUnknownCarry === true
      });
      json(res, 200, result);
      return true;
    }

    // GET /rebuild —— 新代构建作业的只读状态（不触发任何动作）
    // 为什么单独一个口：额度中断后，"到底跑到哪、还剩多少、是不是在续跑"
    // 必须是**不花一分钱**就能查到的，否则用户只能靠重跑一次来确认。
    if (sub === 'rebuild' && method === 'GET') {
      const rt = await getRuntime();
      const job = readRebuildJob(rt.dir);
      const active = fs.existsSync(path.join(rt.dir, 'vector-active.json'))
        ? JSON.parse(fs.readFileSync(path.join(rt.dir, 'vector-active.json'), 'utf8'))
        : null;
      json(res, 200, {
        ok: true,
        activeGeneration: active?.generation ?? null,
        activeEncoding: active?.encoding ?? null,
        currentEncoding: encodingIdentity(rt.settings),
        job
      });
      return true;
    }

    // ── M5 事件整理（2026-10-22）────────────────────────────────────────────
    // GET /consolidate —— 只读状态：能不能跑、积压多少、上次跑成什么样。
    //   不调模型、不推进游标 ⇒ 面板敢每 10 秒刷一次。
    if (sub === 'consolidate' && method === 'GET') {
      const st = await consolidatePipelineStatus();
      json(res, 200, { ok: true, ...st });
      return true;
    }

    // POST /consolidate { dryRun?, limit?, chatKey?, force? }
    //   `dryRun` 只调模型、不落盘、不推进游标 —— 用来先看它到底会记什么，
    //   再决定要不要真的写进库（这是"自动整理"最需要的可解释性）。
    //   `force` 允许在 `consolidateEnabled=false` 时手动跑一次（排障/首次回填）。
    if (sub === 'consolidate' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      try {
        const result = await runConsolidateNow({
          dryRun: body.dryRun === true,
          limit: body.limit,
          chatKey: body.chatKey,
          force: body.force === true,
          reason: 'api'
        });
        json(res, 200, result);
      } catch (err) {
        // 缺模型 / 读不到账本 ⇒ 400 带原文，不吞成 500（"能看懂为什么没跑"比"跑失败"重要）
        json(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      return true;
    }

    // GET /events?chatKey=&limit= —— 事件账本（面板与排障用）
    if (sub === 'events' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const chatKey = String(u.searchParams.get('chatKey') || '').trim();
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 20));
      const rows = readEventLedger({ libDir: rt.dir, chatKey, limit });
      json(res, 200, { ok: true, chatKey, count: rows.length, rows });
      return true;
    }

    // GET /working?chatKey=&limit= —— 短期层体检（`ADR-0048` ⑨：面板「短期记忆」页）
    //
    // ⚠️ **只读，没有写操作**：升降的判据只有排练次数，手点的那条没被真正想起过，
    // 塞进长期层就是污染。所以本端点只回答"现在什么状态"，不给"一键升级"这种按钮。
    if (sub === 'working' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const chatKey = String(u.searchParams.get('chatKey') || '').trim();
      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit')) || 8));
      const s = rt.settings || {};
      const labelOf = (k) => {
        const gname = readGroupNameCache(rt.dir)?.names || {};
        const scope = (() => { try { return rt.normalizer.scopeLabel(k); } catch { return k; } })();
        return String(gname[scope] || (String(k).startsWith('private:') ? `私聊 ${String(k).slice(8)}` : ''));
      };
      try {
        const overview = workingLayerOverview({
          libDir: rt.dir,
          chatKey,
          limit,
          promoteHits: Number(s.promoteHits) || PROMOTE_HITS,
          retireDays: Number(s.retireDays) || RETIRE_DAYS,
          gain: Number(s.retireHalfLifeGain) || RETIRE_HALFLIFE_GAIN,
          rMin: Number(s.retireMinRecall) || RETIRE_MIN_RECALL,
          hardRatio: Number(s.retireHardRatio) || RETIRE_HARD_RATIO,
          hitCounts: readHitLog({ libDir: rt.dir }).counts
        });
        // 会话汇总带上显示名（群名缓存；私聊回退「私聊 号码」），浏览页左侧直接显示
        const chats = (overview.chats || []).map((c) => ({ ...c, chatLabel: labelOf(c.chatKey) }));
        json(res, 200, { ok: true, chatKey, ...overview, chats });
      } catch (err) {
        json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
      return true;
    }

    // GET /working/items?chatKey=&queue=&q=&offset=&limit= —— 短期层全量浏览
    // （宿主记忆页改造 2026-10-23：overview 每队列只给 top N，体检够了浏览不够。
    //   `chatLabel` 是群名缓存里的显示名，取不到就空着，前端回退显示 chatKey。）
    if (sub === 'working/items' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const s = rt.settings || {};
      const labelOf = (k) => {
        const gname = readGroupNameCache(rt.dir)?.names || {};
        const scope = (() => { try { return rt.normalizer.scopeLabel(k); } catch { return k; } })();
        return String(gname[scope] || (String(k).startsWith('private:') ? `私聊 ${String(k).slice(8)}` : ''));
      };
      try {
        const result = workingLayerItems({
          libDir: rt.dir,
          chatKey: u.searchParams.get('chatKey') || '',
          queue: u.searchParams.get('queue') || 'all',
          q: u.searchParams.get('q') || '',
          offset: Number(u.searchParams.get('offset')) || 0,
          limit: Number(u.searchParams.get('limit')) || 50,
          promoteHits: Number(s.promoteHits) || PROMOTE_HITS,
          retireDays: Number(s.retireDays) || RETIRE_DAYS,
          gain: Number(s.retireHalfLifeGain) || RETIRE_HALFLIFE_GAIN,
          rMin: Number(s.retireMinRecall) || RETIRE_MIN_RECALL,
          hardRatio: Number(s.retireHardRatio) || RETIRE_HARD_RATIO,
          hitCounts: readHitLog({ libDir: rt.dir }).counts
        });
        const items = result.items.map((r) => ({ ...r, chatLabel: labelOf(r.chatKey) }));
        json(res, 200, { ok: true, total: result.total, offset: Math.max(0, Math.floor(Number(u.searchParams.get('offset')) || 0)), items });
      } catch (err) {
        json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
      return true;
    }

    // POST /maintenance  { action: 'compact' | 'verify' | 'reset' }
    if (sub === 'maintenance' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req).catch(() => ({}));
      const action = String(body.action || '');
      if (action === 'verify') {
        json(res, 200, { ok: true, action, result: rt.store.verify() });
        return true;
      }
      if (action === 'compact') {
        const r = rt.store.compact();
        json(res, 200, { ok: true, action, result: r, status: rt.store.status() });
        return true;
      }
      if (action === 'reset') {
        if (body.confirm !== 'RESET') {
          json(res, 400, { ok: false, error: '清空是破坏性操作，需要 confirm: "RESET"' });
          return true;
        }
        const s = rt.store.reset({ model: rt.settings.embedModel || null });
        rt.lastIndex = null;
        json(res, 200, { ok: true, action, status: s });
        return true;
      }
      json(res, 400, { ok: false, error: `未知维护动作：${action || '(空)'}`, allowed: ['verify', 'compact', 'reset'] });
      return true;
    }

    // POST /delete  { id }  —— 删除单条（tombstone；空间靠 maintenance/compact 回收）
    if (sub === 'delete' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req).catch(() => ({}));
      const id = String(body.id || '').trim();
      if (!id) {
        json(res, 400, { ok: false, error: '缺少 id' });
        return true;
      }
      const r = rt.store.del(id);
      if (!r.deleted) {
        json(res, 404, { ok: false, error: `库里没有 ${id}` });
        return true;
      }
      // 提醒一句：删的是向量，不是核心的记忆。下次索引还会把它加回来。
      json(res, 200, {
        ok: true, id, slot: r.slot, store: rt.store.status(),
        note: '只删了向量副本。核心的小时块没动 —— 下一次索引会把它重新加回来。要永久排除得改索引条件。'
      });
      return true;
    }

    // GET /identity —— 身份边界（词表 / 待审池 / 观察窗）
    if (sub === 'identity' && method === 'GET') {
      const rt = await getRuntime();
      await ensureIdentity(rt);
      const st = rt.normalizer.stats();
      // 现算一次存档指纹 ⇒ 回答"词表落后于存档没有"。
      // 不现算就只能显示"上次刷新时间"，而那**答不了"现在新了没有"**（老判据的老毛病）。
      const fp = archiveFingerprint(await dataRoot());
      const lin = readLineage(await dataDir());
      json(res, 200, {
        ok: true,
        identity: identitySummary(rt),
        // 词表新鲜度：判据用到的三个量 + 结论，一起摆出来（可被面板直接引用、被用户反驳）
        freshness: {
          // `stale` = **装载之后**还陈不陈（正常恒 false：本次调用已把它补上）
          stale: Boolean(rt.vocabularyArchiveSig && rt.vocabularyArchiveSig !== fp.sig),
          // `reloaded` / `reason` = **本次调用**凭什么刷新了（'archive' 就是"存档长了新人"）
          reloaded: Boolean(rt.lastIdentityCheck?.reloaded),
          reason: rt.lastIdentityCheck?.reason || null,
          staleBefore: Boolean(rt.lastIdentityCheck?.staleBefore),
          loadedAt: rt.identityStats?.loadedAt || null,
          loadedSig: rt.vocabularyArchiveSig || null,
          currentSig: fp.sig,
          files: fp.files,
          bytes: fp.bytes,
          newest: fp.newest ? new Date(fp.newest).toISOString() : null,
          newestName: fp.newestName,
          relabels: rt.identityStats?.relabels ?? 0,
          note: 'reason=archive ⇒ 这次是因**存档变了**（有新的人说话）而自动重装词表；' +
            'relabels = 本次有多少人换了标签（那些写在他们旧标签上的备注会沿沿革表继续显示）。'
        },
        lineage: { count: Object.keys(lin.entries).length, ok: lin.ok !== false, ...(lin.error ? { error: lin.error } : {}) },
        pending: [...rt.normalizer.pending.entries()]
          .map(([term, v]) => ({ term, ...v }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 200),
        ambiguous: (rt.normalizer.ambiguous || []).slice(0, 50),
        horizon: rt.horizon,
        files: rt.normalizer.files,
        note: '本页展示的全部内容都是**本机数据**。占位符映射表是这里最敏感的资产 —— 它不随索引出境，也不该被导出。',
        stats: st
      });
      return true;
    }

    // POST /identity  { action, ... }
    if (sub === 'identity' && method === 'POST') {
      const rt = await getRuntime();
      const body = await readJsonBody(req).catch(() => ({}));
      const action = String(body.action || '');

      // 重建词表（全量扫存档；几秒）
      if (action === 'rebuild-vocab') {
        if (identityScan.busy) { json(res, 409, { ok: false, error: '上一次扫描还在跑' }); return true; }
        const t0 = Date.now();
        identityScan.busy = true;
        try {
          // 别称是词表的输入之一：先刷新配置，别拿启动时那份旧值重建
          await refreshSettings(rt);
          const v = await ensureIdentity(rt, { force: true });
          json(res, 200, { ok: true, action, ms: Date.now() - t0, identity: identitySummary(rt), stats: v });
        } finally {
          identityScan.busy = null;
        }
        return true;
      }

      // 合并 / 取消合并（`ADR-0019`）—— 唯一写入身份的入口，且必须**显式点名**
      if (action === 'merge') {
        if (identityScan.busy) { json(res, 409, { ok: false, error: '上一次扫描还在跑' }); return true; }
        identityScan.busy = true;
        try {
          const r = await mergeEntities(rt, String(body.from ?? ''), String(body.into ?? ''));
          json(res, r.ok ? 200 : 400, r);
        } finally {
          identityScan.busy = null;
        }
        return true;
      }
      if (action === 'unmerge') {
        if (identityScan.busy) { json(res, 409, { ok: false, error: '上一次扫描还在跑' }); return true; }
        identityScan.busy = true;
        try {
          const r = await unmergeEntity(rt, String(body.from ?? body.id ?? ''));
          json(res, r.ok ? 200 : 400, r);
        } finally {
          identityScan.busy = null;
        }
        return true;
      }

      // 兜底层扫描（分布集中度；全量扫一遍）
      if (action === 'scan-suspects') {
        if (identityScan.busy) { json(res, 409, { ok: false, error: '上一次扫描还在跑' }); return true; }
        identityScan.busy = true;
        try {
          const root = await dataRoot();
          const r = scanSuspects({
            dataDir: root,
            minCount: Number(rt.settings.suspectMinCount) || 8,
            maxSpread: Number.isFinite(Number(rt.settings.suspectMaxSpread))
              ? Number(rt.settings.suspectMaxSpread) : 0.35
          });
          rt.normalizer.setSuspects(r.suspects);
          rt.normalizer.save();
          rt.identityStats = null;   // 强制下次重算概览
          json(res, 200, { ok: true, action, suspects: r.suspects.length, stats: r.stats });
        } finally {
          identityScan.busy = null;
        }
        return true;
      }

      // 人工确认某条待审词（提升为永久注册）
      if (action === 'confirm') {
        const term = String(body.term || '').trim();
        if (!term) { json(res, 400, { ok: false, error: '缺少 term' }); return true; }
        const r = rt.normalizer.confirm(term);
        rt.normalizer.save();
        json(res, 200, { ok: true, action, ...r });
        return true;
      }

      // 干跑：拿一段文本过一遍归一化，看结果与命中来源。**不联网、不落库。**
      if (action === 'check') {
        const text = String(body.text || '');
        if (!text) { json(res, 400, { ok: false, error: '缺少 text' }); return true; }
        try {
          const r = rt.normalizer.normalize(text, { context: 'panel-check', register: false });
          json(res, 200, {
            ok: true, action,
            input: text,
            output: r.text,
            hits: r.hits,
            stats: r.stats,
            leak: rt.normalizer.findLeak(r.text)
          });
        } catch (err) {
          json(res, 200, {
            ok: false, action, code: err?.code || 'ERROR',
            error: String(err?.message ?? err),
            input: text
          });
        }
        return true;
      }

      // 出境自检：**不联网**，把全部小时块过一遍，看有没有漏网的实体串。
      // 这是归一化器那条"独立于网络的自检"，也是本插件唯一能在花钱之前跑的检查。
      if (action === 'dryrun-all') {
        await ensureIdentity(rt);
        const chunks = listCorpus(await dataRoot(), { maxChars: rt.settings.maxChars });
        let checked = 0;
        let blocked = 0;
        let bodies = 0;
        let total = 0;
        let identity = 0;
        const byLayer = {};
        const failures = [];
        for (const parsed of chunks) {
          const { chunk, error } = readCorpusItem(parsed);
          if (error || !chunk) continue;
          checked++;
          try {
            const info = buildEmbedText(chunk, {
              normalizer: rt.normalizer,
              maxChars: rt.settings.maxChars,
              withKeywords: rt.settings.withKeywords !== false,
              keywordsSource: rt.settings.keywordsSource,
              withSummary: rt.settings.withSummary !== false,
              register: false
            });
            if (info.redaction?.total) bodies++;
            total += info.redaction?.total || 0;
            identity += info.redaction?.identity || 0;
            for (const [k, n] of Object.entries(info.redaction?.byLayer || {})) byLayer[k] = (byLayer[k] || 0) + n;
          } catch (err) {
            blocked++;
            if (failures.length < 20) failures.push({ id: parsed.id, code: err?.code || '', error: String(err?.message ?? err) });
          }
        }
        json(res, 200, {
          ok: blocked === 0,
          action,
          chunks: checked,
          blocked,
          bodiesTouched: bodies,
          // 两个数分开报，定义写在字段名里（2.2 的教训）
          replacedTotal: total,
          replacedIdentity: identity,
          byLayer,
          failures,
          verdict: blocked === 0
            ? `全部 ${checked} 个块都能干净出境。${bodies} 个块里有东西被替换：` +
              `总替换点 ${total} 处，其中换成身份占位符 ${identity} 处（余 ${total - identity} 处是语篇标记，如 CQ 码/日期/时刻/引用锚点）。`
            : `有 ${blocked} 个块被拒绝出境 —— 这**不会**降级成发原文，它们会被跳过并报错。`
        });
        return true;
      }

      json(res, 400, {
        ok: false,
        error: `未知动作：${action || '(空)'}`,
        allowed: ['rebuild-vocab', 'scan-suspects', 'confirm', 'check', 'dryrun-all']
      });
      return true;
    }

    // GET /identity/suggest —— 合并**建议表**（`ADR-0019`）。
    //
    // 只产建议、绝不自动焊：同名 9 组 / 29 颗星的实测里，很可能混着"不同人撞同一个昵称"
    // （中文短昵称在 QQ 群里撞车很正常），系统自己也只能猜一个。
    // 建议与执行之间隔着用户的一次点名（面板上点「A 就是 B」）。
    if (sub === 'identity/suggest' && method === 'GET') {
      const rt = await getRuntime();
      const r = await suggestMerges(rt);
      json(res, 200, r);
      return true;
    }

    // GET /identity/names —— 占位符 → **本机真名** 映射（星图渲染期用，`ADR-0010`）
    //
    // 为什么不把这些名字直接写进 /graph：**隐私边界画在出境处，不画在界面**。
    // 星图数据（占位符）保持可离境；真名只在**同一个本机进程**里，渲染时贴上去。
    // 这里刻意**不回传实体 id**（`qq:…` 就是明文号码）—— 页面只需要"叫什么"和"是什么"。
    if (sub === 'identity/names' && method === 'GET') {
      const rt = await getRuntime();
      await ensureIdentity(rt);
      // 群名（星系标签的真名）：**只有宿主知道**（它经 OneBot 拿到 `group_name`）。
      // 取不到就退回占位符，但把真因一起带出去 —— 不许让"拉不到"长得像"本来就没有"。
      const gn = await groupNamesFor(rt, { sourceRoot: await dataRoot() });
      json(res, 200, {
        ok: true,
        ...identityNames(rt, gn.names),
        groups: {
          count: Object.keys(gn.names).length,
          at: gn.at || null,
          stale: Boolean(gn.stale),
          refreshing: Boolean(gn.refreshing),
          base: gn.base || '',
          source: gn.source || '',
          error: gn.error || null
        },
        note: '本机映射，用于把星图上的占位符渲染成昵称。不含 QQ 号/群号；不随索引出境。'
      });
      return true;
    }

    // POST /identity/groupnames/refresh —— 强制重拉宿主的群列表（用户改名后手点一次）。
    // 与 /identity/names 的区别：这条**等结果**（要能立刻告诉用户成没成），所以单独一条。
    if (sub === 'identity/groupnames/refresh' && method === 'POST') {
      const rt = await getRuntime();
      const root = await dataRoot();
      const r = await forceRefreshGroupNames(rt, { sourceRoot: root });
      json(res, r.ok ? 200 : 502, {
        ok: Boolean(r.ok),
        count: r.count || 0,
        at: r.at || null,
        base: r.base || '',
        source: r.source || '',
        ...(r.error ? { error: r.error } : {}),
        note: '从宿主的 /api/onebot/groups 重拉了一次。群名只有宿主知道 —— 存档里没有。'
      });
      return true;
    }

    // GET /notes · POST /notes —— 备注（显示名）读写（`ADR-0012`）
    // 键 = 星图上的标识（占位符 / scope 标签），值 = 你写的短名。
    // **只是显示名**：不进词表、不参与归一化、不改任何出境文本（见 core/notes.mjs 头注释）。
    if (sub === 'notes' && method === 'GET') {
      const root = await dataDir();
      const r = readNotes(root);
      // ── 沿标签沿革表折叠（ADR-0019）──────────────────────────────────────
      // `notes.json` 的键是**占位符**，而占位符会变（重建词表 / 身份合并）。
      // 文件里的旧键不作废、也不改写，读取时沿沿革折到当前标签 ——
      // 否则那些备注**还在文件里、界面上再也显示不出来**（静默失联）。
      const lin = readLineage(root);
      const folded = r.ok ? foldNotes(r.notes, lin.entries) : { notes: r.notes, shadowed: [] };
      json(res, 200, {
        ok: r.ok,
        count: Object.keys(folded.notes).length,
        notes: folded.notes,
        maxChars: NOTE_MAX_CHARS,
        // 换过号还救回来的、以及被压掉的，都摆出来 —— 不静默
        migrated: Object.values(folded.notes).filter((v) => v.migratedFrom).length,
        shadowed: folded.shadowed,
        lineageCount: Object.keys(lin.entries).length,
        ...(r.error ? { error: r.error } : {}),
        ...(lin.ok === false ? { lineageError: lin.error } : {})
      });
      return true;
    }
    if (sub === 'notes' && method === 'POST') {
      const root = await dataDir();
      const body = await readJsonBody(req).catch(() => ({}));
      // 键先折叠到**当前**标签再写：否则你给一颗显示为 `P5726` 的星写备注，
      // 而前端手里攥的是旧的 `X277`，就会写出一个**谁也读不到**的键。
      const lin = readLineage(root);
      const rawKey = String(body.key ?? '');
      const key = lin.ok ? canonicalLabel(lin.entries, rawKey) : rawKey;
      const r = writeNote(root, key, String(body.text ?? ''));
      json(res, r.ok ? 200 : 400, {
        ok: r.ok,
        ...r,
        ...(key !== rawKey ? { foldedFrom: rawKey } : {}),
        maxChars: NOTE_MAX_CHARS
      });
      return true;
    }

    // GET /rank —— 六维分布（M1 的仪表）。?force=1 强制重算、?snapshot=0 不记快照
    if (sub === 'rank' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const dist = await runRankScan(rt, {
        force: u.searchParams.get('force') === '1',
        snapshot: u.searchParams.get('snapshot') !== '0'
      });
      json(res, 200, {
        ok: true,
        version: RANK_VERSION,
        mode: 'shadow',      // 只算不注入 —— 面板要明说，否则用户以为它已经在起作用
        dist,
        checks: rankChecks(dist),
        shadow: rankShadowHistory(rt)
      });
      return true;
    }

    // GET /graph —— 星图（G1 · 只读派生）。?scope= 单会话 · ?k= top-K 邻居 · ?force=1 重算
    if (sub === 'graph' && method === 'GET') {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const k = Math.max(1, Math.min(50, Number(u.searchParams.get('k')) || 6));
      const scope = u.searchParams.get('scope') || '';
      const g = await runGraphScan(rt, { force: u.searchParams.get('force') === '1', k, scope });
      json(res, 200, { ok: true, mode: 'shadow', ...g });
      return true;
    }

    // GET /judge —— M4 第二段手动触发（`ADR-0019`）。?dryRun=1/0 覆盖设置 · ?limit= 窗口条数
    // dryRun=true：全链路 + 固定桩，**不调 LLM、不落库**，回传完整 outbound（看清会送什么出去）。
    if (sub === 'judge' && (method === 'GET' || method === 'POST')) {
      const rt = await getRuntime();
      const u = new URL(req.url, 'http://127.0.0.1');
      const dryRun = u.searchParams.has('dryRun') ? u.searchParams.get('dryRun') === '1' : undefined;
      const limit = Math.max(500, Math.min(60_000, Number(u.searchParams.get('limit')) || 15_000));
      const r = await runJudgeScan(rt, { limit, dryRun });
      json(res, 200, {
        ok: r.ok,
        dryRun: r.dryRun,
        skipped: r.skipped || false,
        reason: r.reason || null,
        results: r.results || null,
        applied: r.applied,
        corpus: r.corpus,
        log: r.log,
        // dryRun 的核心产物：完整出境内容（本机面板对照用，同 /item 的 rawSource 先例）
        outbound: r.outbound || null
      });
      return true;
    }

    // POST /selfcheck —— 面板一键自检（端点连通性 + 库一致性 + 分布判据 + 身份边界）
    if (sub === 'selfcheck' && method === 'POST') {
      const rt = await getRuntime();
      const checks = [];
      const health = checkEndpoint(endpointOf(rt.settings));
      checks.push({ id: 'endpoint', label: '嵌入端点配置齐备', pass: health.ok, detail: health.ok ? '齐备' : health.problems.join('；') });
      const v = rt.store.verify();
      checks.push({ id: 'store', label: '向量库落盘一致', pass: v.ok, detail: v.ok ? '一致' : v.problems.join('；') });
      checks.push({ id: 'writable', label: '向量库可写', pass: !rt.store.status().readOnly, detail: rt.store.status().readOnlyReason || '可写' });

      // ── 事实层（`ADR-0033` 补出口 / `ADR-0034` 旁路）───────────────────────
      // 这两条此前**在面板上完全看不见**：`rebuildRequired` 是运行期算的、没有任何出口，
      // `merged.json` 读不动也只是"静默不滤"。自检是"一键看全"的地方，信息必须落在这里。
      const fstats = factStoreOf(rt).stats();
      checks.push({
        id: 'fact-caliber',
        label: '事实槽口径与代码一致（无待重判数据）',
        // `pass: null` = 不可判定/不是错误却也不健康 —— 同 `distribution` 的先例：
        // 这是"等你拍板"的状态，不是故障，标红会把真故障淹掉。
        pass: fstats.rebuildRequired ? null : true,
        detail: fstats.rebuildRequired
          ? `⚠️ 代码已 v${fstats.rebuildRequired.current}，但现有 ${fstats.count} 条里有 ` +
            `${Object.entries(fstats.rebuildRequired.stale).map(([k, n]) => `v${k}×${n}`).join(' + ')} 条**判定产物**是旧版本产出` +
            (() => {
              const dv = Object.values(fstats.rebuildRequired.directVersions || {}).reduce((a, b) => a + b, 0);
              return dv ? `（另有 ${dv} 条直写槽版本号更早，不经判定逻辑、无重建来源 ⇒ 不计入）` : '';
            })() +
            ' —— 重判会产出新 key ⇒ **先退役旧槽**（`POST /facts/merged {action:"retire-stale"}`）再重判，否则 `/inject` 里同一件事出两遍'
          : '一致'
      });
      checks.push({
        id: 'fact-merged',
        label: '软删旁路可读且生效',
        pass: fstats.merged.error ? false : true,
        detail: fstats.merged.error
          ? `❌ ${fstats.merged.error} —— 本次**没有滤任何槽**（真值没坏，只是"不知道滤哪些"）。修好或删掉 merged.json。`
          : `${fstats.merged.count} 条记载 · 本次滤掉 ${fstats.merged.applied} 个活动槽` +
            (fstats.merged.autoReleased ? ` · 自动解除 ${fstats.merged.autoReleased} 次（被合并的槽又拿到新证据）` : '')
      });

      const dist = storeDistribution(rt);
      const jd = judge(dist, { topK: 5 });
      checks.push({
        id: 'distribution',
        label: '分布有分辨力（档数≥3 且极差>0.01）',
        pass: dist.n === 0 ? null : jd.ok,
        detail: dist.n === 0 ? '库里还没有数据，无从判断（这不算通过）' : summarize(dist)
      });

      // 身份边界：这几条是"出境前必须过"的闸门，所以放在自检里最显眼的位置
      const idsum = identitySummary(rt);
      checks.push({
        id: 'vocab',
        label: '归一化词表已装载',
        pass: Boolean(idsum && idsum.entities > 0),
        detail: idsum?.entities
          ? `${idsum.entities} 个实体 · ${idsum.surfaces} 个名字 · ${idsum.ephemeral} 个临时占位符`
          : '词表是空的 —— 没有词表就去索引，等于放行（点「重建词表」）'
      });
      checks.push({
        id: 'horizon',
        label: '观察窗足够长（≥30 天）',
        pass: rt.horizon ? rt.horizon.days >= 30 : null,
        detail: rt.horizon
          ? `${rt.horizon.days} 天（${rt.horizon.start} → ${rt.horizon.end}）` +
            (rt.horizon.days < 30 ? ' —— 关系边与星图必须明说"建立在这么短的观察窗上"' : '')
          : '还没算过（重建词表时会一并算出）'
      });
      // 干跑：不联网，把全部小时的"出境文本"生成一遍，看有没有拒发的
      let dry = null;
      try {
        const chunks = listCorpus(await dataRoot(), { maxChars: rt.settings.maxChars });
        let blocked = 0;
        let identity = 0;
        for (const parsed of chunks.slice(0, 500)) {
          const { chunk, error } = readCorpusItem(parsed);
          if (error || !chunk) continue;
          try {
            const info = buildEmbedText(chunk, {
              normalizer: rt.normalizer,
              maxChars: rt.settings.maxChars,
              withKeywords: rt.settings.withKeywords !== false,
              keywordsSource: rt.settings.keywordsSource,
              withSummary: rt.settings.withSummary !== false,
              register: false
            });
            identity += info.redaction?.identity || 0;
          } catch { blocked++; }
        }
        dry = { scanned: Math.min(chunks.length, 500), blocked, identity };
      } catch { dry = null; }
      checks.push({
        id: 'dryrun',
        label: '样本块可干净出境（不联网）',
        pass: dry ? dry.blocked === 0 : null,
        detail: dry
          ? `抽查 ${dry.scanned} 个块，拒发 ${dry.blocked} 个，共把 ${dry.identity} 处身份换成占位符`
          : '没读到小时块，无从抽查'
      });
      // 机器人自己的身份 —— 2.1 那处漏替就是因为这条没被看见：
      // 名字不在词表里时，`findLeak` 无从拦（它只认已知串）。
      const me = idsum?.identity;
      checks.push({
        id: 'self',
        label: '机器人自身身份已入词表（名字与号码）',
        pass: me ? Boolean(me.selfId && me.selfSurface?.length) : null,
        detail: me
          ? (me.selfId
            ? `selfId=${me.selfId}（来源：${me.selfIdSource}）；已收录 ${me.selfSurface.length} 个自称：${me.selfSurface.slice(0, 5).join('、')}${me.selfSurface.length > 5 ? '…' : ''}`
            : '**没判定出自己的 QQ 号** —— 名字若不在词表里会原样出境（点「重建词表」重试）')
          : '还没算过（重建词表时会一并算出）'
      });

      // 六维打分（M1 影子）—— 逐维报"能不能进排序"。它和上面那条"分布有分辨力"
      // 是两件事：那条看的是向量相似度（检索相不相信自己），这条看的是打分本身。
      let rankDist = null;
      try {
        rankDist = await runRankScan(rt, { snapshot: false });
        for (const c of rankChecks(rankDist)) checks.push(c);
      } catch (err) {
        checks.push({
          id: 'rank-scan', label: '六维分布算得出来', pass: false,
          detail: String(err?.message ?? err)
        });
      }

      json(res, 200, {
        ok: true, checks, identity: idsum, horizon: rt.horizon,
        distribution: { ...dist, sorted: undefined, buckets: undefined },
        rank: rankDist
      });
      return true;
    }

    json(res, 404, { ok: false, error: `未知端点：/api/memory-vec/${sub}`, hint: '见插件 README 的路由清单' });
    return true;
  } catch (err) {
    // 统一出口：把"哪一种失败"原样告诉界面，不吞
    const code = err?.code || 'INTERNAL';
    const status = err?.status || (code === 'BAD_ENDPOINT' ? 400
      : code === 'DIM_MISMATCH' || code === 'MODEL_MISMATCH' ? 409
        : code === 'READ_ONLY' ? 503
          : 500);
    json(res, status, {
      ok: false,
      error: String(err?.message ?? err),
      ...(responseInstanceId ? {instanceId:responseInstanceId,contractVersion:1} : {}),
      code,
      retryable: (err?.status || status) === 503,
      ...(err?.currentEtag ? { currentEtag: err.currentEtag } : {}),
      ...(err?.currentRev ? { currentRev: err.currentRev } : {}),
      detail: err?.problems || err?.body || undefined
    });
    return true;
  }
}

/**
 * 身份边界概览。**不给占位符映射表内容** —— 面板上只需要知道"有多少"，不需要看到对照。
 * 想看对照得走 /identity 的 stats，而那份数据本来就该留在本机。
 */
/**
 * 占位符 → **本机真名**（星图渲染用）。
 *
 * ⚠️ 刻意**只回显示名**，不回实体 id：`qq:1234567` 就是明文号码，
 * 而星图这一层需要的只是"这颗星叫什么、它是不是我"（`ADR-0010`）。
 * 没名字的实体（群、临时占位符）**不出现在表里** —— 页面自己退回显示占位符，
 * 而不是由这里编一个假名（编名字 = 静默伪造身份）。
 *
 * 显示名取法：surface 里**最长**的那个（带称号的群名片比纯名字信息多），
 * 并列按字典序 ⇒ 渲染确定（同一份词表每次给同一个名字）。
 *
 * @param {object} rt 运行期
 * @param {Record<string,string>} [groupNames] 星系标签 → 群名（宿主的群列表，
 *        见 `core/groupnames.mjs`）。**键是占位符**（`group:C1234`），不是群号。
 *        群不是词表实体（没有 surface）⇒ 不走上面那条路，单独并进来。
 */
function identityNames(rt, groupNames = null) {
  const nm = rt?.normalizer;
  /** @type {Record<string, {kind:string, display:string, surfaces:string[]}>} */
  const names = {};
  if (nm && nm.entities) {
    for (const [id, ent] of nm.entities) {
      const label = nm.labelById?.get(id);
      if (!label) continue;
      const surfaces = [...(ent.surface || [])].map((s) => String(s)).filter(Boolean);
      if (!surfaces.length) continue;   // 群 / 无名字的实体：不编名
      surfaces.sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1));
      names[label] = { kind: ent.kind || 'person', display: surfaces[0], surfaces: surfaces.slice(0, 8) };
    }
  }
  // 星系标签的真名（群）。**只补空缺**：实体名已经占了同一个键时不覆盖 ——
  // 词表里的名字是"谁在这颗星上说过话"，比群名更贴这颗星。
  let groupAdded = 0;
  for (const [scope, display] of Object.entries(groupNames || {})) {
    if (!scope || !display || names[scope]) continue;
    names[scope] = { kind: 'group', display: String(display), surfaces: [String(display)] };
    groupAdded++;
  }
  return { count: Object.keys(names).length, names, groupNames: groupAdded };
}

/**
 * 「人」的三种写法 → 占位符标签（`ADR-0032`）。
 *
 * 为什么三种都试：调用方给的东西**形态不定** —— 面板给标签（`P2358`）、
 * 工具给 QQ 号（`100000001`）、手动查给昵称（`翅果喵`）。只认一种，
 * 另外两种就落成"认不出这个人" ⇒ 与"这人真没记过什么"**看起来一模一样**。
 * 这正是不肯只认一种的理由：**失败必须与空结果可区分**。
 *
 * ⚠️ `_resolveTerm` 是内部方法（下划线）。这里用它是因为**没有公开的反查入口**——
 *    重新实现一份"名字 → 标签"就会与归一化器的口径漂移（词表带别名链、注册表、
 *    临时标签，抄一份必漏）。宁可依赖内部方法，也不要第二套口径。
 */
function resolveWhoLabels(rt, who) {
  const n = rt.normalizer;
  const out = new Set();
  const lineage = readLineage(rt.dir);
  if (!lineage.ok) throw new Error(lineage.error);
  const raw = String(who || '').trim();
  if (memoryCoreOf(rt,factStoreOf(rt)).subjects.has(raw)) throw new MemoryError('NOT_A_PERSON','Use subjectId for non-person memories');
  if (!raw || !n) return [];
  // ① 占位符标签本身就是答案（面板/其它端点用的就是它）
  if (n.byLabel?.has(raw) || lineage.entries[raw]) out.add(raw);
  // ② QQ 号 / group:id 形态（两形态都试，与 `/remember`、`/inject` 同一口径）
  for (const form of [raw, `qq:${raw}`, `group:${raw}`]) {
    const hit = n.resolveKnown(form);
    if (hit?.label) out.add(hit.label);
  }
  // ③ 昵称（走词表 surface）
  if (typeof n._resolveTerm === 'function') {
    const r = n._resolveTerm(raw);
    if (r?.known && r.label) out.add(r.label);
  }
  return [...relatedLabels(lineage.entries, out)];
}

/**
 * 解析 `kinds` 查询参数 —— **多值标签**。
 *
 * 接受三种写法（可混用，逗号 / 分号 / 空格分隔）：
 *   · 单标签：`trait,preference`
 *   · 组名：`pragmatic`（= pattern/speaker_profile/trait）、`semantic`
 *   · `all` / `*`：全部
 *
 * ⚠️ 未知值**不回退成"全部"也不回退成"空"** —— 交给调用方报 400。
 * 回退成"全部"会让人以为筛过了（结果偏多，看不出错）；回退成"空"更像"没记过"。
 * 两种静默都比报错贵。
 */
function parseKindsParam(raw) {
  const text = String(raw || '').trim();
  const out = { requested: [], set: new Set(), unknown: [], groups: { ...FACT_KIND_GROUPS } };
  if (!text) {
    out.set = new Set(FACT_KINDS);
    return out;
  }
  for (const part of text.split(/[,;、\s]+/)) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (!out.requested.includes(t)) out.requested.push(t);
    if (t === 'all' || t === '*') { for (const k of FACT_KINDS) out.set.add(k); continue; }
    if (FACT_KIND_GROUPS[t]) { for (const k of FACT_KIND_GROUPS[t]) out.set.add(k); continue; }
    if (FACT_KINDS.includes(t)) { out.set.add(t); continue; }
    if (!out.unknown.includes(t)) out.unknown.push(t);
  }
  return out;
}

/** 标签 → 这个词表实体的"脸"（明文 id + 昵称）。查不到返回 null，不编。 */
function personFace(rt, label) {
  const n = rt.normalizer;
  const id = n?.byLabel?.get(label);
  const e = id ? n?.entities?.get(id) : null;
  if (!e) return { id: null, kind: null, names: [] };
  return { id: e.id, kind: e.kind, names: [...(e.surface || [])] };
}

function identitySummary(rt) {
  if (!rt.normalizer) return null;
  const st = rt.normalizer.stats();
  const ids = rt.identityStats || {};
  return {
    entities: st.entities,
    byKind: ids.byKind || null,
    surfaces: st.surfaces,
    aliases: st.aliases,
    registry: st.registry,
    pending: st.pending,
    suspects: st.suspects,
    ephemeral: st.ephemeral,
    ambiguous: (st.ambiguous || []).length,
    loadedAt: ids.loadedAt || null,
    multiNameEntities: ids.multiNameEntities ?? null,
    // 锚点挖掘的产出 + 机器人自身身份（2.1 的修复面）
    anchors: ids.anchorCount ?? null,
    alignedNames: ids.alignedNames ?? null,
    identity: ids.identity || null,
    // 用户**显式声明**的自我别称（词表的第四个来源；前三个都是挖出来的）
    selfAliases: ids.selfAliasesDeclared || [],
    // ── 词表新鲜度（2026-10-11 补）────────────────────────────────────────
    // 判据缺了"存档变了没有"这一条，代价是新说话的人全部落成临时标签，
    // 而面板上看不出任何异常。这里把**判据用到的量**直接摆出来，让它可被反驳。
    archiveSig: ids.archiveSig || null,
    archiveFiles: ids.archiveFiles ?? null,
    archiveBytes: ids.archiveBytes ?? null,
    relabels: ids.relabels ?? 0,
    lineage: ids.lineage || null,
    dir: st.dir,
    version: st.version,
    note: '归一化器：把实体换成占位符的那一道闸门。它是纯本机件，不参与任何网络调用。'
  };
}

function vecPreview(vector, n = 12) {  if (!vector || !vector.length) return { dim: 0, head: [], norm: 0 };
  const head = [];
  for (let i = 0; i < Math.min(n, vector.length); i++) head.push(Number(vector[i].toFixed(4)));
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) sumSq += vector[i] * vector[i];
  return { dim: vector.length, head, norm: Number(Math.sqrt(sumSq).toFixed(4)) };
}

function redact(settings) {
  const { embedApiKey, llmApiKey, ...rest } = settings || {};
  return {
    ...rest,
    embedApiKey: '',
    llmApiKey: '',
    hasApiKey: Boolean(String(embedApiKey || '').trim()),
    hasLlmApiKey: Boolean(String(llmApiKey || '').trim())
  };
}
