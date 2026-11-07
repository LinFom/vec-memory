// [by:WorkBuddy] 通用记忆导入契约校验器：零外部依赖、零服务内部模块、离线只读。
// 形状的唯一真值源是同目录的 import-contract.schema.json；本文件只是它的解释执行器。
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const CONTRACT_ID = 'vec-memory/import@1';
export const SCHEMA = JSON.parse(fs.readFileSync(new URL('./import-contract.schema.json', import.meta.url), 'utf8'));

/** 受限子集：出现白名单外关键字一律 fail-closed，绝不静默跳过校验。 */
export const SUPPORTED_KEYWORDS = Object.freeze([
  'title', 'description', 'type', 'const', 'enum', 'pattern',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum',
  'required', 'properties', 'additionalProperties', 'items'
]);
const SUPPORTED = new Set(SUPPORTED_KEYWORDS);

export class ContractSchemaError extends Error {
  constructor(code, at, message) {
    super(message);
    this.name = 'ContractSchemaError';
    this.code = code;
    this.path = at;
  }
}

function join(at, key) { return at ? `${at}.${key}` : key; }

/** 全量扫描 schema，不依赖文档是否命中该分支 —— 防止「没走到就漏校验」。 */
function assertSupportedSchema(schema) {
  const walk = (rule, at) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new ContractSchemaError('UNSUPPORTED_SCHEMA_KEYWORD', at, `规则节点必须是对象（${at || '<root>'}）`);
    }
    for (const key of Object.keys(rule)) {
      if (!SUPPORTED.has(key)) {
        throw new ContractSchemaError('UNSUPPORTED_SCHEMA_KEYWORD', join(at, key), `schema 关键字 ${key} 不在支持白名单内：拒绝执行，避免静默漏校验`);
      }
    }
    if (rule.properties) {
      if (typeof rule.properties !== 'object' || Array.isArray(rule.properties)) {
        throw new ContractSchemaError('UNSUPPORTED_SCHEMA_KEYWORD', join(at, 'properties'), 'properties 必须是对象');
      }
      for (const [key, sub] of Object.entries(rule.properties)) walk(sub, join(at, key));
    }
    if (rule.items) walk(rule.items, `${at}[]`);
  };
  walk(schema, '');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function push(errors, code, at, message) { errors.push({code, path: at, message}); }

function validateNode(value, rule, at, errors) {
  if (rule.type && !matchesType(value, rule.type)) {
    push(errors, 'INVALID_FIELD', at, `类型不符：期望 ${rule.type}，实际 ${typeOf(value)}`);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(rule, 'const') && !Object.is(value, rule.const)) {
    push(errors, 'INVALID_FIELD', at, `取值必须为 ${JSON.stringify(rule.const)}${rule.const === false ? '（本契约只接未核验的历史导入，不接受调用方自行声明已确认）' : ''}`);
  }
  if (rule.enum && !rule.enum.includes(value)) {
    push(errors, 'INVALID_FIELD', at, `取值不在允许枚举内：${JSON.stringify(rule.enum)}`);
  }
  if (typeof value === 'string') {
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
      push(errors, 'INVALID_FIELD', at, `格式不匹配：${rule.pattern}`);
    }
    if (rule.minLength != null && value.length < rule.minLength) {
      push(errors, 'INVALID_FIELD', at, `长度不得小于 ${rule.minLength}`);
    }
    if (rule.maxLength != null && value.length > rule.maxLength) {
      push(errors, 'INVALID_FIELD', at, `长度不得大于 ${rule.maxLength}`);
    }
  }
  if (typeof value === 'number' && rule.minimum != null && value < rule.minimum) {
    push(errors, 'INVALID_FIELD', at, `数值不得小于 ${rule.minimum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems != null && value.length < rule.minItems) {
      push(errors, 'INVALID_FIELD', at, `数组至少 ${rule.minItems} 项`);
    }
    if (rule.maxItems != null && value.length > rule.maxItems) {
      push(errors, 'INVALID_FIELD', at, `数组至多 ${rule.maxItems} 项`);
    }
    if (rule.items) value.forEach((item, i) => validateNode(item, rule.items, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of rule.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        push(errors, 'MISSING_FIELD', join(at, key), `必填字段缺失：${key}`);
      }
    }
    const props = rule.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateNode(value[key], sub, join(at, key), errors);
    }
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          const vector = /embedding|vector|vec[-_]?dims?/i.test(key);
          push(errors, vector ? 'FORBIDDEN_VECTOR_FIELD' : 'FORBIDDEN_FIELD', join(at, key),
            vector ? `禁止携带向量字段 ${key}：向量只能由服务按当前编码身份生成，导入第三方向量会静默失配` : `不允许的字段：${key}`);
        }
      }
    }
  }
}

/** 跨字段检查：schema 表达能力之外的证据引用约束，单独列出来而不是藏在规则里。 */
function checkEvidence(document, errors, warnings) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  const entries = Array.isArray(document.entries) ? document.entries : [];
  if (!Array.isArray(document.messages)) {
    warnings.push({code: 'NO_EVIDENCE_BATCH', path: 'messages', message: '本批未提供原话原料；证据引用无法由契约自证，导入器须自行核实'});
    for (let i = 0; i < entries.length; i++) {
      if (Array.isArray(entries[i]?.evidenceIds) && entries[i].evidenceIds.length) {
        warnings.push({code: 'EXTERNAL_EVIDENCE_REF', path: `entries[${i}].evidenceIds`, index: i, message: '证据引用指向本批之外，契约不验证其存在性'});
      }
    }
    return;
  }
  const roles = new Map();
  for (const m of document.messages) {
    if (m && typeof m === 'object' && typeof m.messageId === 'string' && !roles.has(m.messageId)) roles.set(m.messageId, m.role);
  }
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    if (!Array.isArray(entry.evidenceIds) || !entry.evidenceIds.length) {
      warnings.push({code: 'NO_EVIDENCE_REF', path: `entries[${i}].evidenceIds`, index: i, message: '该条目未引用原话；只有来源定位，不能视为已确认事实'});
      return;
    }
    entry.evidenceIds.forEach((id, j) => {
      if (typeof id !== 'string') return;
      const at = `entries[${i}].evidenceIds[${j}]`;
      if (!roles.has(id)) push(errors, 'UNRESOLVED_EVIDENCE', at, `证据引用 ${id} 未在本批 messages 中找到`);
      else if (roles.get(id) !== 'user') push(errors, 'INVALID_EVIDENCE_ROLE', at, `证据 ${id} 的 role=${roles.get(id)}：事实证据只能引用 user 原话`);
    });
  });
}

/**
 * [by:WorkBuddy] 票 07 / D11：说话人识别兜底（离线镜像）。
 * 口径与 src/core/event-gist.mjs 的 unattributedSummary 完全一致；校验器按票 01 纪律
 * 必须保持零 src/ 依赖、零服务内部模块，故在此离线镜像一份，不 import 服务代码。
 *
 *  · 缺 actorId 的 entry ⇒ 标 unattributed、usableAsEvidence:false（warning，不影响 ok）；
 *  · 若同时带 subject.kind==='person'（想挂人物档案）⇒ UNATTRIBUTED_PERSON（error ⇒ ok:false）。
 */
function collectUnattributed(document) {
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const unattributed = [], warnings = [], violations = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const actorId = typeof entry.actorId === 'string' ? entry.actorId.trim() : '';
    if (actorId) return;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `entries[${index}]`;
    const at = `entries[${index}]`;
    unattributed.push(id);
    warnings.push({
      code: 'UNATTRIBUTED_ENTRY', path: at, index, id, usableAsEvidence: false,
      message: '该条目无 actorId：标为 unattributed、不可作为事实证据，认不出说话人时不得猜人'
    });
    if (entry.subject && typeof entry.subject === 'object' && entry.subject.kind === 'person') {
      violations.push({
        code: 'UNATTRIBUTED_PERSON', path: `${at}.actorId`, index, id,
        message: '无说话人却想挂人物档案（subject.kind=person）：拒绝导入，避免把未署名的话记到某个人头上'
      });
    }
  });
  return { unattributed, warnings, violations };
}

function decorate(errors) {
  for (const error of errors) {
    const found = /^(?:entries|messages)\[(\d+)\]/.exec(error.path);
    if (found) error.index = Number(found[1]);
  }
  return errors;
}

/** @returns {{ok:boolean,contract:string|null,errors:Array,warnings:Array,summary:object}} */
export function validateImportDocument(document, schema = SCHEMA) {
  assertSupportedSchema(schema);
  const errors = [], warnings = [];
  validateNode(document, schema, '', errors);
  checkEvidence(document, errors, warnings);
  // [by:WorkBuddy] 票 07 / D11：说话人兜底（只加 summary 字段 / warning / error，不改导出签名、不改 CLI 退出码语义）。
  const ua = collectUnattributed(document);
  warnings.push(...ua.warnings);
  errors.push(...ua.violations);
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const summary = {
    spaceId: typeof document?.spaceId === 'string' ? document.spaceId : null,
    entries: entries.length,
    messages: Array.isArray(document?.messages) ? document.messages.length : 0,
    unverified: entries.filter(e => e?.origin?.verified === false).length,
    traced: entries.filter(e => typeof e?.origin?.source?.locator === 'string' && e.origin.source.locator.length > 0).length,
    unattributed: ua.unattributed
  };
  return {ok: errors.length === 0, contract: document?.contract ?? null, errors: decorate(errors), warnings: decorate(warnings), summary};
}

export function formatIssues(result) {
  const lines = [];
  for (const e of result.errors) lines.push(`ERROR  ${e.code} · ${e.path || '<root>'}${e.index != null ? ` · 条目 #${e.index}` : ''} · ${e.message}`);
  for (const w of result.warnings) lines.push(`WARN   ${w.code} · ${w.path || '<root>'} · ${w.message}`);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node interop/validate-import.mjs <document.json>');
    process.exitCode = 2;
  } else {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      let document;
      try { document = JSON.parse(raw); }
      catch (error) { throw new ContractSchemaError('INVALID_JSON', '', `JSON 解析失败：${error.message}`); }
      const result = validateImportDocument(document);
      console.log(JSON.stringify(result, null, 2));
      for (const line of formatIssues(result)) console.error(line);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      const code = error instanceof ContractSchemaError ? error.code : 'READ_FAILED';
      console.error(JSON.stringify({ok: false, errors: [{code, path: error.path || '', message: error.message}]}, null, 2));
      process.exitCode = 1;
    }
  }
}
