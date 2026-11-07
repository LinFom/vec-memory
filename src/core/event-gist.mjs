// [by:WorkBuddy] 票 07「更像人的记忆组织」——事件 gist 的纯函数模块。
//
// 纪律（与票 01 导入校验器、票 03 策略层一致）：
//   · 零 import、零 fs、零 I/O、零网络、不写盘、不碰向量/编码身份。
//   · 原话唯一真值源是 input/messages.jsonl；本模块只搬运 **消息 id / 引用形状**，
//     绝不复制正文、不新建 jsonl 事实文件、不新增实体类型。
//   · 衰减三态（eventRetention / retireStaleEvents / promoteEvents）是既有实现
//     （consolidate.mjs），本模块不重写算法、不改任何常数。
//
// 本模块提供的四类能力：
//   ① deriveEvidenceIds  —— 从窗口 rows 派生「同一条记录内的」消息 id 列表；
//   ② eventRefsOf        —— 有 evidenceIds 产 message 级引用，否则退回 window 级形状；
//   ③ verifyQuotation    —— 回查三重校验（来源 id / 时间窗 / 引文前缀或包含）；
//   ④ unattributedSummary—— D11 说话人兜底的纯口径（校验器离线镜像，见 validate-import.mjs）。
// 另附 auditEventQuotation：把 ③ 批量套到「带 evidenceIds 的注入项」上的纯闸门，
// 供 standalone/worker.mjs 的注入侧直接调用，便于在不启动 worker 线程的情况下单测。

/** 一个窗口最多回指多少条原话：与 consolidate.mjs 事实槽 :1829 的上限一致。 */
export const MAX_EVIDENCE_IDS = 40;

/**
 * 从窗口 rows 取消息 id：去重、限 40、全字符串、**不复制正文**。
 * 只读 row.id（兼容 messageId / mid 别名），不读 row.text、不落盘。
 *
 * @param {{rows?:Array<object>}|Array<object>} win
 * @returns {string[]}
 */
export function deriveEvidenceIds(win) {
  const rows = Array.isArray(win?.rows) ? win.rows : (Array.isArray(win) ? win : []);
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (ids.length >= MAX_EVIDENCE_IDS) break;
    const raw = row?.id ?? row?.messageId ?? row?.mid;
    const id = String(raw ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 事件引用形状：
 *   · 有新字段 evidenceIds ⇒ 每条产一个 message 级引用（matchMethod 仍沿用
 *     'persisted-window'，因为这批 id 来自「持久化时的窗口快照」，不是实时检索命中）；
 *   · 没有 evidenceIds（老事件行）⇒ **原样退回**既有 window 级形状，
 *     保证旧账本、旧读者、router 的 evidenceView 全部兼容。
 *
 * @param {object} event
 * @returns {Array<object>}
 */
export function eventRefsOf(event) {
  const ids = Array.isArray(event?.evidenceIds) ? event.evidenceIds : [];
  const chatKey = event?.chatKey ?? null;
  const fromTs = event?.fromTs ?? null;
  const toTs = event?.toTs ?? null;
  if (ids.length) {
    return ids.map((id) => ({
      type: 'message', id: String(id), chatKey, fromTs, toTs, matchMethod: 'persisted-window'
    }));
  }
  // 老形状，逐字对齐 worker.mjs 改前的 eventRefs(e)。
  return [{
    type: 'window', id: event?.windowId || event?.id,
    chatKey, fromTs, toTs, matchMethod: 'persisted-window'
  }];
}

/**
 * 回查三重校验（纯函数）。语义对齐既有实现：
 *   · 来源 id：router.mjs:1230-1289 的账本 + crosschat.mjs:328-335 的 idSet；
 *   · 时间窗：provenance.mjs:6-11 / router.mjs:1345-1348 的 fromTs/toTs；
 *   · 引文前缀或包含：本票补的第三重，worker.mjs:284 `m.text.includes(entry.text)` 的语义范例。
 *
 * `message` 是「按 expectedId 查回的原话对象」——由调用方（worker）从 input/messages.jsonl
 * 的单一真值源查得后传入，本模块不碰 fs。`quote` 是待注入的引文（事件 gist）。
 *
 * @returns {{ok:boolean, code:'QUOTE_ID_MISMATCH'|'QUOTE_OUT_OF_WINDOW'|'QUOTE_TEXT_MISMATCH'|'QUOTE_OK'}}
 */
export function verifyQuotation({ message, quote, chatKey, fromTs, toTs, expectedId } = {}) {
  // ① 来源 id 一致：消息得存在、id 对得上 expectedId；scope 也须落在同一会话（防跨会话串味）。
  const id = message?.messageId ?? message?.id ?? message?.mid;
  const want = String(expectedId ?? '');
  if (!message || typeof message !== 'object' || !id || !want || String(id) !== want) {
    return { ok: false, code: 'QUOTE_ID_MISMATCH' };
  }
  if (chatKey && message.chatKey && String(message.chatKey) !== String(chatKey)) {
    return { ok: false, code: 'QUOTE_ID_MISMATCH' };
  }
  // ② 时间窗内：时间戳必须是有限数且落在 [fromTs, toTs]；窗口缺失按 fail-closed 拒绝。
  const rawTs = message.timestamp ?? message.ts;
  const ts = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs);
  const lo = Number(fromTs), hi = Number(toTs);
  if (!Number.isFinite(ts) || !Number.isFinite(lo) || !Number.isFinite(hi) || ts < lo || ts > hi) {
    return { ok: false, code: 'QUOTE_OUT_OF_WINDOW' };
  }
  // ③ 引文前缀或包含：仅对**显式声明了引文**的条目适用。
  //    [by:WorkBuddy] 票 07 回归修法（test/standalone-engine.mjs 实测打脸）：事件 gist 是
  //    派生摘要（title：detail），不是逐字引文。若注入侧把 summary 当 quote 传进来，
  //    第三重必然全灭，把所有 episodic 事件项 fail-closed 拦下 —— 那不是「更严格」，是把
  //    正常记忆链改坏了。因此：
  //      · quote 未声明（undefined/null）⇒ 只做 ①来源 id + ②时间窗，标 quoteSkipped；
  //      · quote 声明了但为空串 / 不匹配 ⇒ 仍 fail-closed 拒绝，不静默放行。
  if (quote === undefined || quote === null) {
    return { ok: true, code: 'QUOTE_OK', quoteSkipped: true };
  }
  const text = typeof message.text === 'string' ? message.text : '';
  const q = typeof quote === 'string' ? quote : '';
  if (!q || !(text.startsWith(q) || text.includes(q))) {
    return { ok: false, code: 'QUOTE_TEXT_MISMATCH' };
  }
  return { ok: true, code: 'QUOTE_OK' };
}

/**
 * 注入侧闸门（纯函数，供 worker.mjs 调用、供 test/event-gist.mjs 直接单测）。
 *
 * 逐条把 ③ 套到 event.evidenceIds 上；**任一条失败即整项不放行**（fail-closed），
 * 并把失败码回传，便于调用方留可观测诊断而不是静默吞掉。
 * 没有 evidenceIds（老事件行）⇒ 直接 ok:true / NO_EVIDENCE_IDS，保持旧行为。
 *
 * @param {object} event
 * @param {{lookupMessage:(id:string)=>object|undefined, quote?:string}} ctx
 * @returns {{ok:boolean, code:string, checked:number, failures:Array<{id:string,code:string}>}}
 */
export function auditEventQuotation(event, { lookupMessage, quote } = {}) {
  const ids = Array.isArray(event?.evidenceIds) ? event.evidenceIds : [];
  if (!ids.length) return { ok: true, code: 'NO_EVIDENCE_IDS', checked: 0, failures: [] };
  if (typeof lookupMessage !== 'function') {
    return { ok: false, code: 'NO_MESSAGE_LOOKUP', checked: 0, failures: [{ id: '', code: 'NO_MESSAGE_LOOKUP' }] };
  }
  const { chatKey, fromTs, toTs } = event || {};
  const failures = [];
  for (const rawId of ids) {
    const id = String(rawId);
    const message = lookupMessage(id);
    const r = verifyQuotation({ message, quote, chatKey, fromTs, toTs, expectedId: id });
    if (!r.ok) failures.push({ id, code: r.code });
  }
  return {
    ok: failures.length === 0,
    code: failures.length ? failures[0].code : 'QUOTE_OK',
    checked: ids.length,
    failures
  };
}

/**
 * D11 说话人兜底的纯口径（「给校验器用的纯函数」）。
 *
 * 注意：interop/validate-import.mjs 按票 01 纪律必须保持零 src/ 依赖，故那里离线
 * 镜像了一份同口径实现（collectUnattributed），本函数是它的纯规范与单测载体；
 * test/event-gist.mjs 会断言两者结果一致。
 *
 * 缺 actorId 的 entry ⇒ 记入 unattributed（标 unattributed / usableAsEvidence:false）；
 * 若同时带 subject.kind==='person'（想挂人物档案）⇒ 记入 violations（对应失败码
 * UNATTRIBUTED_PERSON，由校验器转成 error 使 ok:false）。
 *
 * @returns {{unattributed:string[], violations:Array<object>}}
 */
export function unattributedSummary(document) {
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const unattributed = [];
  const violations = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const actorId = typeof entry.actorId === 'string' ? entry.actorId.trim() : '';
    if (actorId) return;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `entries[${index}]`;
    unattributed.push(id);
    if (entry.subject && typeof entry.subject === 'object' && entry.subject.kind === 'person') {
      violations.push({
        id, index, code: 'UNATTRIBUTED_PERSON',
        path: `entries[${index}].actorId`, usableAsEvidence: false
      });
    }
  });
  return { unattributed, violations };
}
