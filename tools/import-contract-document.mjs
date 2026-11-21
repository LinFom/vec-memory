// [by:WorkBuddy] 票 02：通用导入契约文档 → 可重入导入计划 / HTTP 提交。
//
// 设计口径（专业通用做法，已在 docs/importer-20261107.md 存档）：
//   · 转换器与计划生成器都是**离线**的：零 src/ 依赖、零模型调用、零生产库指针写入。
//   · 不新增 HTTP 端点：只用服务 v1 已公开的 /entities、/messages、/memories、/workspace。
//   · 不伪造服务字段：服务没有条目级 verified 字段，因此「历史导入 / 未核验」由三重
//     证据保证 —— 契约 origin.verified=false、/workspace 的 legacy:true+confirm:false、
//     导入结果文件逐条 unverified:true。recall 返回的正文保持原文，不塞标签。
//   · 幂等与可重入：每一步都带稳定 operationId / messageId；失败不回滚、不写本地游标，
//     重跑同一文档即可续上，绝不留下「一半导入 + 无法恢复」的状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateImportDocument, formatIssues} from '../interop/validate-import.mjs';

const MAPPING = JSON.parse(fs.readFileSync(new URL('../interop/import-mapping.json', import.meta.url), 'utf8'));

export const PLAN_VERSION = 1;
const MEMORY_TEXT_MAX = 12000;   // worker.mjs remember(): requireText(text, 12000)
const LEDGER_TEXT_MAX = 4000;    // scene-memory.mjs entry(): requireText(text, 4000)

export class ImportSubmitError extends Error {
  constructor(code, step, detail, completed) {
    super(`${code} @ ${step.kind}${step.id ? `(${step.id})` : ''}: ${detail}`);
    this.name = 'ImportSubmitError';
    this.code = code;
    this.step = step;
    this.completed = completed;
  }
}

const hashOf = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
const opId = (spaceId, entryId, locator) => `import:${hashOf(spaceId, entryId, locator).slice(0, 40)}`;
const scopeOf = (s) => ({kind: MAPPING.scopeKind[s?.kind] || 'private', id: String(s?.id || '')});

/**
 * 校验契约文档并生成**确定性**导入计划。纯函数，不发请求、不写盘。
 * 同一份文档两次调用得到逐字相同的计划（不含时间戳 / 随机 ID），因此可 diff、可审计。
 * @returns {{ok:boolean, plan:object|null, errors:Array, warnings:Array, summary:object}}
 */
export function buildImportPlan(document) {
  const checked = validateImportDocument(document);
  if (!checked.ok) return {ok: false, plan: null, errors: checked.errors, warnings: checked.warnings, summary: checked.summary};

  const spaceId = document.spaceId;
  const documentHash = hashOf(JSON.stringify(document));
  const root = `/api/v1/spaces/${encodeURIComponent(spaceId)}`;
  const steps = [];
  const records = [];
  const quarantine = [];
  const actors = new Set();

  for (const m of document.messages || []) if (m.actorId) actors.add(m.actorId);
  for (const e of document.entries) if (e.actorId) actors.add(e.actorId);

  // ① 登记说话人：/memories 要求 actorId 已登记，否则 UNKNOWN_ENTITY。
  for (const actorId of [...actors].sort()) {
    steps.push({kind: 'entity', method: 'PUT', route: `${root}/entities/${encodeURIComponent(actorId)}`,
      id: actorId, body: {kind: 'person', displayName: actorId}});
  }
  // ② 原话原料：messageId 就是幂等键，重复提交由服务判 duplicate。
  if (document.messages?.length) {
    steps.push({kind: 'messages', method: 'POST', route: `${root}/messages`,
      body: {messages: document.messages.map(m => ({
        messageId: m.messageId, conversationId: m.conversationId, actorId: m.actorId,
        role: m.role, timestamp: m.timestamp, text: m.text, scope: scopeOf(m.scope),
        ...(m.mentions ? {mentions: m.mentions} : {}), ...(m.replyTo ? {replyTo: m.replyTo} : {})
      }))}});
  }

  const scenarios = new Map();
  for (const e of document.entries) {
    const locator = e.origin.source.locator;
    const operationId = opId(spaceId, e.id, locator);
    const rawKind = String(e.kind || '');
    const targetKind = MAPPING.factKinds[rawKind] || MAPPING.defaultFactKind;
    const fallback = !rawKind || !MAPPING.factKinds[rawKind];
    const scope = scopeOf(e.scope);
    const record = {
      id: e.id, operationId, sourceKind: rawKind || null, targetKind, mappingFallback: fallback,
      scope, evidenceIds: e.evidenceIds || [], actorId: e.actorId || null,
      origin: e.origin, unverified: true, usableAsEvidence: !!e.actorId,
      writtenToMemory: false, ledger: false
    };

    // ③ 认不出说话人 ⇒ 不挂人物档案、不写事实记忆，只进隔离清单（票 07 / D11）。
    if (!e.actorId) {
      record.unattributed = true;
      record.reason = 'MISSING_ACTOR';
      quarantine.push(record);
    } else {
      if (e.text.length > MEMORY_TEXT_MAX) {
        return {ok: false, plan: null,
          errors: [{code: 'MEMORY_TEXT_TOO_LONG', path: `entries[${document.entries.indexOf(e)}].text`,
            message: `条目 ${e.id} 正文 ${e.text.length} 字符，超过 /memories 上限 ${MEMORY_TEXT_MAX}；请在源侧切分后重跑`}],
          warnings: checked.warnings, summary: checked.summary};
      }
      steps.push({kind: 'memory', method: 'POST', route: `${root}/memories`, id: e.id, operationId,
        body: {
          operationId, actorId: e.actorId, text: e.text, scope, kind: targetKind,
          source: 'manual', ...(e.evidenceIds?.length ? {evidenceIds: e.evidenceIds} : {})
        }});
      record.writtenToMemory = true;
    }

    // ④ 未核验台账：走服务既有 scene-memory 的 legacy 语义。**刻意不复制正文** ——
    //    text 只放可唯一定位的占位描述，完整来源在 legacyRecord.origin.source.locator。
    const sceneKey = `${scope.kind}:${scope.id}`;
    if (!scenarios.has(sceneKey)) {
      scenarios.set(sceneKey, scope);
      steps.push({kind: 'ensureScene', method: 'POST', route: `${root}/workspace`,
        id: sceneKey, body: {action: 'ensureScene', scope}});
    }
    const placeholder = `[historical-import] ${e.id} / ${targetKind} — see legacyRecord.locator`;
    steps.push({kind: 'ledger', method: 'POST', route: `${root}/workspace`, id: e.id,
      sceneKey, operationId: `${operationId}:ledger`,
      body: {
        action: 'entry', operationId: `${operationId}:ledger`, sceneId: null,
        scope, kind: targetKind,
        text: placeholder.slice(0, LEDGER_TEXT_MAX),
        legacy: true, confirm: false, shareable: false,
        legacyRecord: {id: e.id, contract: 'vec-memory/import@1', origin: e.origin,
          evidenceIds: e.evidenceIds || [], actorId: e.actorId || null,
          targetKind, mappingFallback: fallback, unverified: true}
      }});
    record.ledger = true;
    records.push(record);
  }

  return {
    ok: true,
    plan: {
      planVersion: PLAN_VERSION, contract: document.contract, spaceId, documentHash,
      generatedBy: 'tools/import-contract-document.mjs [by:WorkBuddy]',
      counts: {entities: actors.size, messages: document.messages?.length || 0,
        memories: steps.filter(s => s.kind === 'memory').length,
        ledger: steps.filter(s => s.kind === 'ledger').length, quarantine: quarantine.length},
      steps, records, quarantine, unverified: true
    },
    errors: [], warnings: checked.warnings, summary: checked.summary
  };
}

async function requestJSON({baseURL, token, step, fetchImpl}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}${step.route}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: step.method,
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      ...(step.body === undefined ? {} : {body: JSON.stringify(step.body)})
    });
  } catch (e) {
    throw new ImportSubmitError('IMPORT_NETWORK', step, String(e?.message || e), []);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new ImportSubmitError('IMPORT_BAD_JSON', step, `响应不是 JSON：${text.slice(0, 160)}`, []); }
  if (!res.ok || data.ok === false) {
    throw new ImportSubmitError('IMPORT_REJECTED', step,
      `${res.status} ${data.code || ''} ${data.error || ''}`.trim().slice(0, 300), []);
  }
  return data;
}

/**
 * 按计划顺序提交。所有步骤幂等 ⇒ 中途失败不回滚，重跑同一计划即可续上。
 * @param {object} plan buildImportPlan 的产物
 * @param {object} p
 * @param {string} p.baseURL  如 http://127.0.0.1:8091
 * @param {string} p.token    管理员或空间写凭据
 * @param {Function} [p.fetchImpl] 注入便于测试；默认 globalThis.fetch
 * @returns {Promise<{ok:boolean,completed:Array,sceneIds:object,records:Array,quarantine:Array}>}
 */
export async function submitImportPlan(plan, {baseURL, token, fetchImpl = globalThis.fetch} = {}) {
  if (!plan || plan.planVersion !== PLAN_VERSION) throw new Error('无效的导入计划');
  if (!baseURL || !token) throw new Error('需要 --base-url 与 --token');
  const completed = [];
  const sceneIds = {};
  for (const step of plan.steps) {
    // ensureScene 的 sceneId 由服务按 occasion 规范化后返回；用它覆盖计划里的占位 null。
    const body = step.kind === 'ledger'
      ? {...step.body, sceneId: sceneIds[step.sceneKey] || step.body.sceneId}
      : step.body;
    let data;
    try { data = await requestJSON({baseURL, token, step: {...step, body}, fetchImpl}); }
    catch (e) {
      if (e instanceof ImportSubmitError) { e.completed = completed; throw e; }
      throw e;
    }
    if (step.kind === 'ensureScene' && data.sceneId) sceneIds[step.id] = data.sceneId;
    completed.push({kind: step.kind, id: step.id || null, operationId: step.operationId || null,
      ...(data.duplicate ? {duplicate: true} : {}), ...(data.replayed ? {replayed: true} : {})});
  }
  return {ok: true, completed, sceneIds, records: plan.records, quarantine: plan.quarantine,
    unverified: true, documentHash: plan.documentHash};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  (async () => {
    const file = flag('--doc');
    if (!file) { console.error('用法：node tools/import-contract-document.mjs --doc <file> [--out plan.json] [--submit --base-url URL --token TOKEN]'); process.exitCode = 2; return; }
    let document;
    try { document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { console.error(JSON.stringify({ok: false, code: 'READ_FAILED', error: e.message})); process.exitCode = 1; return; }
    const built = buildImportPlan(document);
    for (const line of formatIssues({errors: built.errors, warnings: built.warnings})) console.error(line);
    if (!built.ok) { process.exitCode = 1; return; }
    const out = flag('--out');
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), {recursive: true});
      fs.writeFileSync(path.resolve(out), JSON.stringify(built.plan, null, 2));
      console.error(`已写出导入计划：${out}`);
    }
    if (argv.includes('--submit')) {
      try {
        const result = await submitImportPlan(built.plan, {baseURL: flag('--base-url'), token: flag('--token')});
        console.log(JSON.stringify({ok: true, counts: built.plan.counts, completed: result.completed.length,
          unverified: result.unverified, sceneIds: result.sceneIds}, null, 2));
      } catch (e) {
        console.error(JSON.stringify({ok: false, code: e.code || 'SUBMIT_FAILED', error: e.message,
          completed: e.completed || [], hint: '每一步都幂等，修正后重跑同一文档即可续上，无需回滚'}, null, 2));
        process.exitCode = 1;
      }
    } else {
      console.log(JSON.stringify({ok: true, plan: out ? path.resolve(out) : '(stdout)',
        counts: built.plan.counts, steps: built.plan.steps.length,
        note: '离线计划；加 --submit --base-url --token 才会发请求'}, null, 2));
    }
  })();
}
