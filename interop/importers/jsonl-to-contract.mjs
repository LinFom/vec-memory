// [by:WorkBuddy] 票 02：四类 JSONL → 通用导入契约文档（离线，零服务内部依赖）。
// 这是「第一个导入器样例」的源侧转换器：任意第三方 Agent 只要把导出物整理成这四类
// JSONL，就能产出符合 vec-memory/import@1 的文档，再交给 tools/import-contract-document.mjs。
//
// 刻意不 import 任何 src/ 模块：契约是产品无关的，服务内部模块一进来就解耦失败。
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateImportDocument, formatIssues} from '../validate-import.mjs';

const MAPPING = JSON.parse(fs.readFileSync(new URL('../import-mapping.json', import.meta.url), 'utf8'));

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const clean = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== null && val !== '') out[k] = val;
  return out;
};

/** 逐行解析 JSONL；空行跳过，坏行带文件名 + 行号抛错，绝不吞掉半行数据。 */
function readJsonl(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push({row: JSON.parse(line), line: i + 1}); }
    catch (e) { throw new Error(`${path.basename(file)}:${i + 1} 不是合法 JSON：${e.message}`); }
  });
  return rows;
}

function scopeOf(row, fallback) {
  const s = row.scope && typeof row.scope === 'object' ? row.scope : {};
  const kind = str(s.kind) || str(row.scopeKind) || 'private';
  const id = str(s.id) || str(row.scopeId) || str(row.conversationId) || fallback;
  return {kind: MAPPING.scopeKind[kind] ? kind : 'private', id};
}

function entryOf(row, file, line, kind, defaultScope) {
  const id = str(row.id) || `${path.basename(file, '.jsonl')}-${line}`;
  const entry = {
    id,
    kind,
    text: str(row.text || row.content || row.summary || row.statement),
    scope: scopeOf(row, defaultScope),
    origin: {
      kind: 'historical-import',
      verified: false,
      source: {
        locator: `${path.basename(file)}:${line}`,
        file: path.basename(file),
        line,
        ...(str(row.sourceId) ? {recordId: str(row.sourceId)} : {})
      }
    }
  };
  if (str(row.actorId)) entry.actorId = str(row.actorId);
  if (Array.isArray(row.evidenceIds)) entry.evidenceIds = row.evidenceIds.map(String).filter(Boolean);
  if (row.subject && typeof row.subject === 'object') {
    entry.subject = clean(row.subject);
  } else if (str(row.name) && kind === 'speaker_profile') {
    entry.subject = {id: str(row.subjectId) || id, displayName: str(row.name), kind: 'person'};
  }
  return entry;
}

/**
 * 把四类 JSONL + 可选 messages.jsonl 转成契约文档。
 * @param {object} p
 * @param {string} p.dir      源目录
 * @param {string} p.spaceId  目标空间 ID
 * @param {string} [p.defaultScopeId]
 * @returns {object} 契约文档（未经校验，调用方可再喂给 validateImportDocument）
 */
export function jsonlToContract({dir, spaceId, defaultScopeId = 'import'} = {}) {
  if (!dir || !spaceId) throw new Error('需要 --dir 与 --space');
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`源目录不存在：${abs}`);
  const entries = [];
  const mapping = [];
  const excluded = [];
  for (const [file, targetKind] of Object.entries(MAPPING.sourceFiles)) {
    const full = path.join(abs, file);
    if (!fs.existsSync(full)) continue;
    for (const {row, line} of readJsonl(full)) {
      const rawKind = str(row.kind);
      const fromFile = path.basename(file, '.jsonl');
      const kind = (rawKind && MAPPING.factKinds[rawKind]) || targetKind;
      for (const field of MAPPING.excludedRuntimeFields) {
        if (Object.hasOwn(row, field)) excluded.push(`${file}:${line}.${field}`);
      }
      entries.push(entryOf(row, full, line, kind, defaultScopeId));
      // fallback 只表示「调用方显式给了 kind，但映射表不认识」；
      // 行内没给 kind 而按来源文件取默认值是设计内的正常路径，不算降级。
      mapping.push({source: `${file}:${line}`, sourceKind: rawKind || `(from ${fromFile})`, targetKind: kind,
        fallback: !!rawKind && !MAPPING.factKinds[rawKind]});
    }
  }
  const messages = [];
  const messageFile = path.join(abs, 'messages.jsonl');
  if (fs.existsSync(messageFile)) {
    for (const {row, line} of readJsonl(messageFile)) {
      messages.push(clean({
        messageId: str(row.messageId) || `m-${line}`,
        conversationId: str(row.conversationId) || defaultScopeId,
        actorId: str(row.actorId),
        role: str(row.role) || 'user',
        timestamp: row.timestamp,
        text: str(row.text),
        scope: scopeOf(row, defaultScopeId),
        ...(Array.isArray(row.mentions) ? {mentions: row.mentions} : {}),
        ...(str(row.replyTo) ? {replyTo: str(row.replyTo)} : {})
      }));
    }
  }
  return {
    contract: 'vec-memory/import@1',
    spaceId,
    notes: '由 interop/importers/jsonl-to-contract.mjs 离线生成；全部条目为历史导入 / 未核验。',
    origin: {
      kind: 'historical-import', verified: false,
      source: {locator: path.basename(abs), file: path.basename(abs)}
    },
    ...(messages.length ? {messages} : {}),
    entries,
    __mapping: mapping,
    __excludedRuntimeFields: excluded
  };
}

/** 生成可交给校验器的文档（去掉仅供审计的 __ 前缀字段），并返回校验结果。 */
export function convertAndValidate(options) {
  const built = jsonlToContract(options);
  const {__mapping, __excludedRuntimeFields, ...document} = built;
  const result = validateImportDocument(document);
  return {document, result, mapping: __mapping, excludedRuntimeFields: __excludedRuntimeFields};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const {document, result, mapping, excludedRuntimeFields} = convertAndValidate({
      dir: flag('--dir'), spaceId: flag('--space'), defaultScopeId: flag('--scope-id') || 'import'
    });
    console.log(JSON.stringify({summary: result.summary, mapping, excludedRuntimeFields}, null, 2));
    for (const line of formatIssues(result)) console.error(line);
    const out = flag('--out');
    if (out && result.ok) {
      fs.mkdirSync(path.dirname(path.resolve(out)), {recursive: true});
      fs.writeFileSync(path.resolve(out), JSON.stringify(document, null, 2));
      console.error(`已写出契约文档：${out}`);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ok: false, code: 'CONVERT_FAILED', error: e.message}));
    process.exitCode = 1;
  }
}
