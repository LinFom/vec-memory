// [by:WorkBuddy] 票 01：通用记忆导入契约的端到端验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  SCHEMA, SUPPORTED_KEYWORDS, ContractSchemaError,
  validateImportDocument, formatIssues
} from '../interop/validate-import.mjs';

const read = name => fs.readFileSync(new URL(`../interop/examples/${name}.json`, import.meta.url), 'utf8');
const doc = name => JSON.parse(read(name));
const at = name => fileURLToPath(new URL(`../interop/${name}`, import.meta.url));
const contractDoc = fs.readFileSync(new URL('../docs/memory-import-contract-20261107.md', import.meta.url), 'utf8');
const validatorSource = fs.readFileSync(at('validate-import.mjs'), 'utf8');

function collectPaths(schema) {
  const out = new Set();
  const walk = (rule, prefix) => {
    for (const [key, sub] of Object.entries(rule.properties || {})) {
      const p = prefix ? `${prefix}.${key}` : key;
      out.add(p);
      walk(sub, p);
    }
    if (rule.items) { const p = `${prefix}[]`; out.add(p); walk(rule.items, p); }
  };
  walk(schema, '');
  return out;
}

function collectRequired(schema) {
  const out = new Set();
  const walk = (rule, prefix) => {
    for (const key of rule.required || []) out.add(prefix ? `${prefix}.${key}` : key);
    for (const [key, sub] of Object.entries(rule.properties || {})) walk(sub, prefix ? `${prefix}.${key}` : key);
    if (rule.items) walk(rule.items, `${prefix}[]`);
  };
  walk(schema, '');
  return out;
}

/** 比较约束时剥掉纯说明文字：description 不同不代表两处规则漂移。 */
function constraintsOnly(rule) {
  if (Array.isArray(rule)) return rule.map(constraintsOnly);
  if (!rule || typeof rule !== 'object') return rule;
  const out = {};
  for (const [key, value] of Object.entries(rule)) {
    if (key === 'title' || key === 'description' || key === '$comment') continue;
    out[key] = constraintsOnly(value);
  }
  return out;
}

function docFields() {
  const block = /<!-- FIELDS:START -->([\s\S]*?)<!-- FIELDS:END -->/.exec(contractDoc);
  assert.ok(block, '契约文档必须含机器可读字段清单');
  return new Set(block[1].split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')));
}

test('最小合法样例通过，且未核验与来源追溯逐条可数', () => {
  const result = validateImportDocument(doc('minimal-valid'));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.contract, 'vec-memory/import@1');
  assert.deepEqual(result.summary, {spaceId: 'demo', entries: 2, messages: 1, unverified: 2, traced: 2});
  assert.ok(result.warnings.some(w => w.code === 'NO_EVIDENCE_REF' && w.index === 1), '第二条无原话引用，必须给警告而不是假装已确认');
});

test('六个非法样例都给出可读错误并定位到具体条目', () => {
  const cases = [
    ['invalid-bad-evidence', 'UNRESOLVED_EVIDENCE', 'entries[0].evidenceIds[0]', 0],
    ['invalid-embedding', 'FORBIDDEN_VECTOR_FIELD', 'entries[0].embedding', 0],
    ['invalid-verified', 'INVALID_FIELD', 'entries[1].origin.verified', 1],
    ['invalid-missing-origin', 'MISSING_FIELD', 'entries[0].origin.source.locator', 0],
    ['invalid-machine-evidence', 'INVALID_EVIDENCE_ROLE', 'entries[0].evidenceIds[0]', 0],
    ['invalid-extra-field', 'FORBIDDEN_FIELD', 'entries[0].confidence', 0]
  ];
  for (const [name, code, path, index] of cases) {
    const result = validateImportDocument(doc(name));
    assert.equal(result.ok, false, `${name} 必须被拒`);
    const hit = result.errors.find(e => e.code === code && e.path === path);
    assert.ok(hit, `${name} 缺 ${code} @ ${path}；实际 ${JSON.stringify(result.errors)}`);
    assert.equal(hit.index, index, `${name} 错误必须带条目下标`);
    assert.ok(hit.message.length > 0, '错误信息不能为空');
    assert.ok(formatIssues(result).some(line => line.includes(`条目 #${index}`) && line.includes(path)), '可读输出需含路径与条目号');
  }
});

test('CLI 离线可跑：合法退出 0，非法退出 1 且 stderr 可读', () => {
  const cli = at('validate-import.mjs');
  const good = spawnSync(process.execPath, [cli, at('examples/minimal-valid.json')], {encoding: 'utf8'});
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).ok, true);
  const bad = spawnSync(process.execPath, [cli, at('examples/invalid-embedding.json')], {encoding: 'utf8'});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FORBIDDEN_VECTOR_FIELD/);
  assert.match(bad.stderr, /entries\[0\]\.embedding/);
  assert.match(bad.stderr, /条目 #0/);
  const broken = spawnSync(process.execPath, [cli, at('examples/does-not-exist.json')], {encoding: 'utf8'});
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /READ_FAILED/);
});

test('契约文件不含任何具体 Agent 项目名，校验器不依赖服务内部模块', () => {
  const forbidden = /溟月|moon[-_]core|moon[-_]mem|QQ-Agent|qq-agent|Nyan|Samara|OneBot|3211|3399/i;
  const files = ['import-contract.schema.json', 'validate-import.mjs',
    ...fs.readdirSync(new URL('../interop/examples/', import.meta.url)).map(f => `examples/${f}`)];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(at(file), 'utf8'), forbidden, `${file} 含专有名词`);
  assert.doesNotMatch(contractDoc, forbidden, '契约文档含专有名词');
  assert.doesNotMatch(validatorSource, /from\s+['"][^'"]*src\//, '校验器不得 import 服务内部模块');
  assert.doesNotMatch(validatorSource, /writeFileSync|appendFileSync|fetch\(|node:http|node:https/, '校验器必须离线只读，不写盘不联网');
});

test('schema 是形状唯一真值源：文档字段清单双向对齐', () => {
  const paths = collectPaths(SCHEMA);
  const fields = docFields();
  for (const field of fields) assert.ok(paths.has(field), `文档列了 schema 中不存在的字段：${field}`);
  for (const required of collectRequired(SCHEMA)) assert.ok(fields.has(required), `文档漏列必填字段：${required}`);
  assert.deepEqual(constraintsOnly(SCHEMA.properties.messages.items.properties.scope), constraintsOnly(SCHEMA.properties.entries.items.properties.scope), '两处场合约束必须逐字一致');
  assert.deepEqual(constraintsOnly(SCHEMA.properties.origin), constraintsOnly(SCHEMA.properties.entries.items.properties.origin), '整批来源与逐条来源约束必须逐字一致');
});

test('schema 出现白名单外关键字时 fail-closed，而不是静默跳过', () => {
  assert.ok(SUPPORTED_KEYWORDS.includes('const'));
  const rootBad = {...SCHEMA, oneOf: [SCHEMA]};
  assert.throws(() => validateImportDocument(doc('minimal-valid'), rootBad),
    e => e instanceof ContractSchemaError && e.code === 'UNSUPPORTED_SCHEMA_KEYWORD');
  const childBad = structuredClone(SCHEMA);
  childBad.properties.entries.items.properties.text.$ref = '#/definitions/text';
  assert.throws(() => validateImportDocument(doc('minimal-valid'), childBad),
    e => e instanceof ContractSchemaError && e.code === 'UNSUPPORTED_SCHEMA_KEYWORD' && e.path.includes('$ref'));
});

test('契约标识、空间 ID、场合、条目数量与顶层未知字段都按规则拒绝', () => {
  const base = doc('minimal-valid');
  const variants = [
    [{...base, contract: 'vec-memory/import@2'}, 'INVALID_FIELD', 'contract'],
    [{...base, spaceId: 'bad space!'}, 'INVALID_FIELD', 'spaceId'],
    [{...base, entries: []}, 'INVALID_FIELD', 'entries'],
    [{...base, unexpected: true}, 'FORBIDDEN_FIELD', 'unexpected'],
    [{...base, origin: {...base.origin, verified: true}}, 'INVALID_FIELD', 'origin.verified'],
    [{...base, entries: [base.entries[0], {...base.entries[1], scope: {...base.entries[1].scope, kind: 'world'}}]}, 'INVALID_FIELD', 'entries[1].scope.kind']
  ];
  for (const [candidate, code, path] of variants) {
    const result = validateImportDocument(candidate);
    assert.equal(result.ok, false, `${path} 必须被拒`);
    assert.ok(result.errors.some(e => e.code === code && e.path === path), `${path}: ${JSON.stringify(result.errors)}`);
  }
});

test('未核验标记不可被调用方改写，且不存在「已确认」旁路字段', () => {
  const base = doc('minimal-valid');
  for (const candidate of [
    {...base, entries: [{...base.entries[0], origin: {...base.entries[0].origin, verified: true}}, base.entries[1]]},
    {...base, entries: [{...base.entries[0], confirmedBy: 'someone'}, base.entries[1]]},
    {...base, entries: [{...base.entries[0], origin: {...base.entries[0].origin, kind: 'verified-export'}}, base.entries[1]]}
  ]) assert.equal(validateImportDocument(candidate).ok, false);
  assert.equal(SCHEMA.properties.origin.properties.verified.const, false);
  assert.equal(SCHEMA.properties.entries.items.properties.origin.properties.verified.const, false);
});

test('三类证据警告不可被当成 0，也不冒充错误', () => {
  const base = doc('minimal-valid');
  const withoutMessages = {...base};
  delete withoutMessages.messages; // JSON 里没有 undefined；字段缺省必须真的是「没有这个键」
  const noBatch = validateImportDocument(withoutMessages);
  assert.equal(noBatch.ok, true);
  assert.ok(noBatch.warnings.some(w => w.code === 'NO_EVIDENCE_BATCH'));
  assert.ok(noBatch.warnings.some(w => w.code === 'EXTERNAL_EVIDENCE_REF' && w.index === 0), 'entry-001 的证据指向本批之外');
  const withBatch = validateImportDocument(base);
  assert.ok(withBatch.warnings.some(w => w.code === 'NO_EVIDENCE_REF' && w.index === 1));
  assert.equal(withBatch.ok, true, '警告不得冒充失败');
});

test('契约改动没有碰事实层真值源文件', () => {
  const diff = spawnSync('git', ['diff', '--name-only', 'c05e79f', '--', 'src/core/factstore.mjs', 'src/core/vecstore.mjs', 'src/core/vector-generation.mjs', 'src/core/embed.mjs'],
    {cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8'});
  // 票 03 已证明这四个文件零改动；此处守住票 01 同样不碰。git 不可用时必须显式失败，不许静默通过。
  assert.equal(diff.status, 0, `git diff 必须可执行：${diff.error?.message || diff.stderr}`);
  assert.equal(diff.stdout.trim(), '', '票 01 不得修改事实层 / 向量代文件');
});
