#!/usr/bin/env node
// tools/offline-restore-drill.mjs —— 备份/恢复**验收矩阵**（新票 01 / 旧票 16 · [by:DS] 2026-10-29）
//
// ══ 这个文件是什么 ═════════════════════════════════════════════════════════
// 不是"演示一下能跑通"，而是**把复审提出的每一条错法都变成一条必须失败的用例**。
// 上一版只演了 3 条反例（改一字节 / 缺文件 / 跨实例），而复审实际打穿它的是：
//   「清单与损坏内容**哈希一致**、活槽 0 条、缺活动代」—— 一条都没在里面。
//
// 所以每一条反例都按**同一种手法**构造：先做一份**真实备份**，再只改一个地方，
// 需要时**重算清单哈希**（模拟"清单跟着内容一起坏"，也就是复审的原始反例形态），
// 然后要求 `offline-verify` **非零退出**，并且输出里必须点名**那个**原因 ——
// 只判退出码不够：拿"哈希不符"去拒绝一个"schema 坏"的副本也算拒绝，
// 但那是靠运气过的，不是判据在工作。
//
// ══ 纪律 ═══════════════════════════════════════════════════════════════════
//   · 只在 `os.tmpdir()` 下建东西，任何路径越界立即中止；
//   · 合成数据走**生产写入路径**（`/remember` + `store.put`），不手搓 slots.jsonl
//     —— 手搓的 JSON 可能恰好长成"我的校验器能读、生产 loader 读不动"的样子；
//   · 每个失败用例跑完都要复核**备份与源库的字节没被改动**（工具不许"边验边改"）；
//   · 不读生产库、不发任何聊天消息、不连嵌入端点。
//
// 用法：node tools/offline-restore-drill.mjs [--keep] [--json=<文件>]
//
// `--json=<文件>` 把矩阵落成机器可读的一行（供 `test/offline-restore.mjs` 断言"用例没被
// 静默跳过"）。**测试不能只看退出码 0** —— 用例被删掉、被 try/catch 吞掉，退出码一样是 0。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createRouter } from '../src/index.mjs';
import { getRuntime, factStoreOf } from '../src/core/backend.mjs';
import { encodingIdentity } from '../src/core/vector-generation.mjs';
import { openFactStore } from '../src/core/factstore.mjs';
import { readLineage } from '../src/core/lineage.mjs';
import { memoryCoreOf } from '../src/core/memory-core.mjs';
import { ManualRevisions } from '../src/core/manual-revisions.mjs';
import { SubjectStore } from '../src/core/subjects.mjs';
import { digest } from '../src/core/durable-log.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const KEEP = process.argv.includes('--keep');
const JSON_OUT = (process.argv.find((a) => a.startsWith('--json=')) || '').slice('--json='.length);

const TMPROOT = path.join(os.tmpdir(), 'vmm-offline-drill-');
const guard = (p) => {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(os.tmpdir()))) throw new Error(`演练只允许在 tmpdir 下操作，拒绝 ${r}`);
  return r;
};

const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
/** 目录指纹：rel → sha（判"工具有没有偷偷改东西"）。 */
function fingerprint(dir) {
  const m = new Map();
  const stack = [''];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) m.set(rel, sha(path.join(dir, rel)));
    }
  }
  return m;
}
const sameFp = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function exec(tool, argv) {
  try {
    const { stdout, stderr } = await run(NODE, [path.join(HERE, tool), ...argv], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// ── 结果矩阵 ───────────────────────────────────────────────────────────────
const rows = [];
function record(id, what, want, got, ok, why = '') {
  rows.push({ id, what, want, got, ok, why });
  const tag = ok ? '✅' : '❌';
  console.log(`  ${tag} ${id.padEnd(5)} ${what}`);
  if (!ok) console.log(`        期望 ${want} / 实测 ${got}${why ? `  —— ${why}` : ''}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ① 用**生产写入路径**造一份有内容的库
// ══════════════════════════════════════════════════════════════════════════
const root = guard(fs.mkdtempSync(TMPROOT));
const dataRoot = path.join(root, 'data');
const libDir = path.join(dataRoot, 'memory-vec');

async function buildLibrary() {
  fs.mkdirSync(path.join(dataRoot, 'memory-v2', 'chunks'), { recursive: true });
  const settings = { getSkillConfig: (_id, d) => ({ ...d }) };
  const router = createRouter({ dataRoot, settings });
  const rt = await getRuntime();
  const post = (p, body) => router.handle({ method: 'POST', path: p, body });

  // ⚠️ 顺序陷阱（实测踩过）：**先让身份装载完，再 setVocabulary**。
  await router.handle({ method: 'GET', path: '/status' });
  rt.normalizer.setVocabulary([{ id: 'qq:1006837800', kind: 'person', surface: ['甲瓶'] }]);
  if (!rt.normalizer.resolveKnown('qq:1006837800')) throw new Error('前提不成立：词表里认不出演练用号码');
  const ENC = encodingIdentity({ ...rt.settings });
  for (let i = 0; i < 5; i++) {
    const v = new Array(8).fill(0); v[i % 8] = 1;
    rt.store.put({ id: `drill-${i}`, vector: v, model: 'drill-8', encoding: ENC,
      meta: { title: '', text: `演练块 ${i}`, chatKey: 'group:1', when: 1000 + i, kind: 'hour' } });
  }
  const a = await post('/remember', { chatKey: 'group:1', userId: '1006837800', kind: 'trait', attr: '职业', text: '修车师傅' });
  const b = await post('/remember', { chatKey: 'group:1', userId: '1006837800', kind: 'preference', text: '爱喝美式' });
  const c = await post('/remember', { chatKey: 'group:1', userId: '1006837800', kind: 'promise', text: '请客吃牛肉面' });
  if (!a?.body?.ok || !b?.body?.ok || !c?.body?.ok) throw new Error(`造事实失败：${JSON.stringify(a?.body)} / ${JSON.stringify(b?.body)} / ${JSON.stringify(c?.body)}`);

  // ── 核心 v1 的新资产：**用真实核心 API 产出**（不手搓 jsonl） ────────────
  // R2 的第一步缺口就是"新资产被归 unclassified，只复制不验证"。要证明校验器真的
  // 认这份格式，样本就必须由**写它的那份代码**生成 —— 手搓的 JSON 可能恰好长成
  // "我的校验器能读、真实 loader 读不动"的样子。
  const facts = factStoreOf(rt);
  const core = memoryCoreOf(rt, facts);
  const items = core.manual.items();
  const pick = (needle) => {
    const it = items.find((i) => String(i.value ?? '').includes(needle));
    if (!it) throw new Error(`找不到内容含「${needle}」的可编辑项（items=${items.length}）`);
    return it;
  };

  // 替换 → 隐藏 → （替换后）恢复：三种 op 的**最终状态**各留一条
  const itTrait = pick('修车师傅');
  const r1 = core.manual.commit({ operationId: 'drill-rev-1', op: 'replace', target: { key: itTrait.key, itemKey: itTrait.itemKey }, expectedEtag: itTrait.etag, value: '电工' });
  const itPref = pick('爱喝美式');
  core.manual.commit({ operationId: 'drill-rev-2', op: 'hide', target: { key: itPref.key, itemKey: itPref.itemKey }, expectedEtag: itPref.etag });
  const itFood = pick('牛肉面');
  const r3 = core.manual.commit({ operationId: 'drill-rev-3', op: 'replace', target: { key: itFood.key, itemKey: itFood.itemKey }, expectedEtag: itFood.etag, value: '米饭' });
  core.manual.commit({ operationId: 'drill-rev-4', op: 'restore', target: { key: itFood.key, itemKey: itFood.itemKey }, expectedEtag: r3.etag });
  // 同 operationId 同请求 ⇒ 必须原样重放（不追加第二行、不改字节）
  const replay = core.manual.commit({ operationId: 'drill-rev-1', op: 'replace', target: { key: itTrait.key, itemKey: itTrait.itemKey }, expectedEtag: itTrait.etag, value: '电工' });
  if (replay?.replayed !== true || replay?.item?.value !== '电工') throw new Error('人工修订重放语义不对');

  // 主体：群主体 + 人物主体（别名 / 观察 / 合并 → 撤销 → 再合并）
  // ⚠️ 主体场合是**规范形态** `group:C<数字>`（`SubjectStore` 只认这个），
  //    与聊天键 `group:1` 不是一回事 —— 用聊天键会直接被 `Not a group scope` 拒掉。
  const SCOPE = 'group:C1';
  const subs = core.subjects;
  const grp = subs.ensureGroup(SCOPE);
  const who = subs.create({ operationId: 'drill-subj-1', kind: 'work', label: '甲瓶' }).subject;
  const who2 = subs.aliases({ operationId: 'drill-subj-2', subjectId: who.id, expectedRev: who.rev, aliases: ['甲瓶', '瓶哥'] }).subject;
  const obs1 = subs.addObservation({
    operationId: 'drill-obs-1', subjectId: who2.id, expectedSubjectRev: who2.rev,
    aspect: '职业', statement: '在修车行工作', claimType: 'fact', sourceScope: SCOPE,
    provenance: [{ type: 'message', id: '1', chatKey: 'group:1', fromTs: 1000, toTs: 2000 }], observedAt: 2000
  }, { verifyReference: (ref, scope) => scope === SCOPE && ref.chatKey === 'group:1' && ref.id === '1' });
  const obs2 = subs.addObservation({
    operationId: 'drill-obs-2', subjectId: grp.id, expectedSubjectRev: grp.rev,
    aspect: '氛围', statement: '这个群喜欢露营', claimType: 'opinion', sourceScope: SCOPE,
    provenance: [{ type: 'window', id: 'w-1', chatKey: 'group:1', fromTs: 1000, toTs: 2000 }], observedAt: 2000
  }, { verifyReference: (ref, scope) => scope === SCOPE && ref.chatKey === 'group:1' });

  const dup = subs.create({ operationId: 'drill-subj-3', kind: 'work', label: '甲瓶（重复）' }).subject;
  const mg1 = subs.merge({ operationId: 'drill-subj-4', fromId: dup.id, intoId: obs1.subject.id, expectedFromRev: dup.rev, expectedIntoRev: obs1.subject.rev });
  const um = subs.unmerge({ operationId: 'drill-subj-5', subjectId: dup.id, expectedRev: mg1.subject.rev });
  // 再合并一次：让"当前生效的合并"=1，同时"撤销过 1 次"
  subs.merge({ operationId: 'drill-subj-6', fromId: dup.id, intoId: um.target.id, expectedFromRev: um.subject.rev, expectedIntoRev: um.target.rev });

  // 冻结的观察请求（交给 pending-windows 保存，验证"事实已写、观察待提交"这条状态可恢复）
  const win = { chatKey: 'group:1', fromTs: 3000, toTs: 4000, rows: [{ id: 11 }, { id: 12 }] };
  const prepared = subs.prepareWindow({
    win, windowId: 'w-pending', scope: SCOPE,
    candidates: [{ subjectRef: obs1.subject.id, aspect: '爱好', statement: '周末爱去露营', claimType: 'opinion', evidenceIds: [11, 12] }],
    allowedSubjectIds: new Set([obs1.subject.id]), normalize: (s) => s, resolveReporter: () => null
  });
  if (!prepared.length) throw new Error('冻结观察请求为空');

  // 整理管线：事件 2 条 + 排练 1 条 + 游标 + 待补窗口 1 个
  const cd = path.join(libDir, 'consolidate');
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(cd, 'events.jsonl'), [
    JSON.stringify({ id: 'ev-1', windowId: 'w-1', chatKey: 'group:1', title: '决定周末去露营', summary: '甲瓶提议周末去露营，大家同意', fromTs: 1000, toTs: 2000, at: [1, 2], hits: 0 }),
    JSON.stringify({ id: 'ev-2', windowId: 'w-1', chatKey: 'group:1', title: '讨论预算', summary: '预算 200 以内', fromTs: 1000, toTs: 2000, at: [1], hits: 1 })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(cd, 'hits.jsonl'), JSON.stringify({ i: 'ev-2', n: 1, t: 5000 }) + '\n');
  fs.writeFileSync(path.join(cd, 'state.json'), JSON.stringify({ version: 1, chats: { 'group:1': { lastTs: 2000 } }, updatedAt: 5000 }, null, 2));
  // 一个"已完成整理、但观察尚未提交"的窗口：`parsed.observations` 有候选，
  // `observationRequests` 是**冻结的请求**。少后者 ⇒ 恢复后重试会拒绝提交、观察永久丢失。
  fs.writeFileSync(path.join(cd, 'pending-windows.json'), JSON.stringify({
    'group:1:1000:2000': { win: { chatKey: 'group:1', fromTs: 1000, toTs: 2000 }, attempts: 1, at: 6000 },
    'group:1:3000:4000': {
      win: { chatKey: win.chatKey, fromTs: win.fromTs, toTs: win.toTs, rows: win.rows }, now: 7000, attempts: 1,
      parsed: { events: [], people: [], observations: [{ subjectRef: obs1.subject.id, aspect: '爱好', statement: '周末爱去露营', claimType: 'opinion', evidenceIds: [11, 12] }] },
      observationRequests: prepared
    }
  }, null, 2));

  // 宿主侧具名资产（沿革/备注在**宿主数据根**，不在库根 —— 上一版就是这里漏的）
  fs.writeFileSync(path.join(dataRoot, 'labels.json'), JSON.stringify({ version: 1, entries: { P9001: { to: 'P9002', at: '2026-10-01T00:00:00Z', why: 'merge' } } }, null, 2));
  fs.writeFileSync(path.join(dataRoot, 'notes.json'), JSON.stringify({ P9002: { text: '甲瓶本人', updatedAt: '2026-10-01' } }, null, 2));
  fs.writeFileSync(path.join(dataRoot, 'memory-vec-outbox.jsonl'), [
    JSON.stringify({ id: 'o1', at: '2026-10-01T00:00:00Z', why: 'drill', attempts: 0, req: { userId: '1006837800', text: 'x' } }),
    JSON.stringify({ id: 'o2', at: '2026-10-01T00:00:01Z', why: 'drill', attempts: 1, req: { userId: '1006837800', text: 'y' } })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dataRoot, 'memory-vec-checkpoint-state.json'), JSON.stringify({ 'group:1': { turns: 2, lastAt: 5000, lastEvidenceId: 'e1' } }));
  // 配置里有"令牌"—— 用来证明报告不打印内容
  fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ memoryVec: { injectEnabled: true, token: 'SECRET-SHOULD-NOT-APPEAR-123456' } }, null, 2));
  const instances = path.join(root, 'instances.json');
  fs.writeFileSync(instances, JSON.stringify({ version: 1, instances: [{ id: 'drill', dataRoot: 'data', port: 65500 }] }, null, 2));

  return { instances };
}

/** 在既有库上再叠一个**代结构**（`vector-active.json` + 代目录），验证指针路径。 */
function addGeneration(dir) {
  const gen = 'a'.repeat(32);
  const gdir = path.join(dir, 'vector-generations', gen);
  fs.mkdirSync(gdir, { recursive: true });
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  for (const f of ['index.json', 'meta.jsonl', 'vectors.bin']) fs.copyFileSync(path.join(dir, f), path.join(gdir, f));
  const enc = idx.encoding ?? null;
  fs.writeFileSync(path.join(dir, 'vector-active.json'), JSON.stringify({ version: 1, generation: gen, ...(enc ? { encoding: enc } : {}) }, null, 2));
  return { gen, gdir };
}

// ══════════════════════════════════════════════════════════════════════════
// ② 变体工厂：复制一份真备份，改一处，按需重算清单
// ══════════════════════════════════════════════════════════════════════════
function rehash(bak) {
  const mp = path.join(bak, 'OFFLINE-MANIFEST.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  for (const f of m.files) {
    const abs = path.join(bak, f.rel);
    if (!fs.existsSync(abs)) continue;
    f.sha256 = sha(abs);
    f.bytes = fs.statSync(abs).size;
  }
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return m;
}

function manifestOf(bak) {
  return JSON.parse(fs.readFileSync(path.join(bak, 'OFFLINE-MANIFEST.json'), 'utf8'));
}
function writeManifest(bak, m) {
  fs.writeFileSync(path.join(bak, 'OFFLINE-MANIFEST.json'), JSON.stringify(m, null, 2));
}

/**
 * 改一份 DurableLog 日志，并**逐行重算哈希**。
 *
 * 这是复审原始形态的精确复刻：`hash` 全对、`previous` 链也接得上，但内容坏了。
 * 如果只改内容不重算哈希，"哈希不符"会替"内容校验"顶罪 —— 那验证不了内容校验在工作。
 */
function rewriteLog(file, mutate) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const out = mutate(rows) || rows;
  const text = out.map((r) => {
    const { hash, ...payload } = r;
    return JSON.stringify({ ...payload, hash: digest(payload) });
  }).join('\n') + '\n';
  fs.writeFileSync(file, text);
  return out;
}

let caseNo = 0;
const variants = [];
/** 造一个变体目录（复制 GOOD 备份）。用完会删，除非 --keep。 */
function variant(label) {
  caseNo += 1;
  const dir = guard(path.join(root, `v${String(caseNo).padStart(2, '0')}-${label}`));
  fs.cpSync(GOOD, dir, { recursive: true });
  variants.push(dir);
  return dir;
}

async function expectVerify(id, what, dir, { args = [], code, contains = [], notContains = [], note = '' } = {}) {
  const before = fingerprint(dir);
  const r = await exec('offline-verify.mjs', [`--root=${dir}`, ...args]);
  const after = fingerprint(dir);
  const untouched = sameFp(before, after);
  const hitAll = contains.every((s) => r.out.includes(s));
  const cleanOf = notContains.every((s) => !r.out.includes(s));
  const ok = r.code === code && hitAll && cleanOf && untouched;
  const got = `exit=${r.code}${hitAll ? '' : ` 缺[${contains.filter((s) => !r.out.includes(s)).join('|')}]`}${cleanOf ? '' : ` 误含[${notContains.filter((s) => r.out.includes(s)).join('|')}]`}${untouched ? '' : ' 备份被改动'}`;
  record(id, what, `exit=${code}${contains.length ? ` + ${contains.join(' + ')}` : ''}`, got, ok, ok ? note : '');
  return r;
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 开跑
// ══════════════════════════════════════════════════════════════════════════
let GOOD = '';
let libFpBefore = null;
let crashed = null;
let jsonFailed = false;

try {
  const { instances } = await buildLibrary();

  // ⚠️ **冻结一份快照再开始验收**：生产运行时（本进程里的 router）还会自己写
  //    `facts/index.json` / 整理游标，若直接拿活库当源，"源库没被改动"这条判据永远为假
  //    —— 而且检查的是自己的定时器，不是被测工具。冻结后源就是常量字节。
  const frozen = path.join(root, 'frozen');
  fs.mkdirSync(frozen, { recursive: true });
  fs.cpSync(libDir, path.join(frozen, 'memory-vec'), { recursive: true });
  for (const f of ['labels.json', 'notes.json', 'memory-vec-outbox.jsonl', 'memory-vec-checkpoint-state.json', 'config.json']) {
    if (fs.existsSync(path.join(dataRoot, f))) fs.copyFileSync(path.join(dataRoot, f), path.join(frozen, f));
  }
  const SRC = frozen;
  const SRC_LIB = path.join(frozen, 'memory-vec');
  libFpBefore = fingerprint(SRC_LIB);

  console.log('\n【正例】');
  // ── 空库：没有事实行也合法 ──────────────────────────────────────────────
  {
    const emptyLib = path.join(root, 'empty', 'memory-vec');
    fs.mkdirSync(path.join(emptyLib, 'consolidate'), { recursive: true });
    fs.writeFileSync(path.join(emptyLib, 'consolidate', 'state.json'), JSON.stringify({ version: 1, chats: {}, updatedAt: 0 }));
    const bak = path.join(root, 'bak-empty');
    const b = await exec('offline-backup.mjs', [`--from=${emptyLib}`, `--to=${bak}`]);
    const v = await exec('offline-verify.mjs', [`--root=${bak}`, `--expect-source-root=${emptyLib}`]);
    record('P1', '合法空库：备份+验收都通过', 'backup=0 verify=0', `backup=${b.code} verify=${v.code}`,
      b.code === 0 && v.code === 0, b.code ? b.out.slice(-200) : v.code ? v.out.slice(-300) : '');
  }

  // ── 正常混合资产 ────────────────────────────────────────────────────────
  GOOD = path.join(root, 'bak-good');
  {
    const b = await exec('offline-backup.mjs', [
      `--from=${SRC_LIB}`, `--to=${GOOD}`, `--host-data=${SRC}`, `--instances=${instances}`
    ]);
    record('P2', '正常库：备份退出 0', 'exit=0', `exit=${b.code}`, b.code === 0, b.code ? b.out.slice(-300) : '');

    const m = manifestOf(GOOD);
    record('P3', '清单覆盖宿主侧沿革/备注（上一版整节漏掉）', '含 _host/labels.json + _host/notes.json',
      `host=${(m.scope.hostAssets || []).length} 项`,
      (m.scope.hostAssets || []).includes('_host/labels.json') && (m.scope.hostAssets || []).includes('_host/notes.json'));
    record('P4', '清单不打印令牌', '不含 SECRET-SHOULD-NOT-APPEAR',
      b.out.includes('SECRET-SHOULD-NOT-APPEAR') ? '出现了' : '未出现',
      !b.out.includes('SECRET-SHOULD-NOT-APPEAR') && !JSON.stringify(m).includes('SECRET-SHOULD-NOT-APPEAR'));

    const drill = path.join(root, 'drill-keep');
    const v = await exec('offline-verify.mjs', [`--root=${GOOD}`, `--expect-source-root=${SRC_LIB}`, `--drill-dir=${drill}`, '--keep-drill']);
    record('P5', '正常库：验收退出 0 且三项判定全 true',
      'exit=0 + hash/schema/recovery=true',
      `exit=${v.code}`,
      v.code === 0 && /hash_valid\s+= true/.test(v.out) && /schema_valid\s+= true/.test(v.out) && /recovery_valid\s+= true/.test(v.out),
      v.code ? v.out.slice(-400) : '');

    // ★ 业务内容比对：不只看零计数 —— 打开演练目录，核对**具体值**
    const restored = path.join(drill, 'memory-vec');
    const store = openFactStore(path.join(restored, 'facts'));
    // 按 kind 取（占位符是词典序生成的，写死 P#### 等于把测试绑在一个内部编号上）
    const traitText = JSON.stringify([...store.slots.values()]
      .filter((r) => r.fact_kind === 'trait')
      .map((r) => r.content));
    const lin = readLineage(drill);
    const evLine = fs.readFileSync(path.join(restored, 'consolidate', 'events.jsonl'), 'utf8');
    record('P6', '恢复后的业务内容对得上（值，不是行数）',
      '职业=修车师傅 + 沿革 1 条 + 事件标题在',
      `${store.slots.size} 槽 / 沿革 ${Object.keys(lin.entries || {}).length} 条`,
      /修车师傅/.test(traitText) && Object.keys(lin.entries || {}).length === 1 && evLine.includes('决定周末去露营'));

    // ★ R2 核心：新资产（人工修订 / 主体 / 基线 / 冻结观察请求）在**恢复后**是否真的能用。
    //   只核"备份里有这个文件"是不够的 —— 上一条集成缺口的原话就是"只复制不验证"。
    const rs = openFactStore(path.join(restored, 'facts'));
    const revs = new ManualRevisions(restored, rs, { identityVersion: () => digest(readLineage(drill).entries || {}) });
    const its = revs.items();
    const byVal = (v) => its.find((i) => String(i.value ?? '') === v);
    const replaced = byVal('电工');
    const hiddenIt = byVal('爱喝美式');
    const restoredIt = its.find((i) => String(i.value ?? '').includes('牛肉面'));
    const subsRestored = new SubjectStore(restored);
    const snap = subsRestored.snapshot();
    const mergedIds = [...snap.subjects.values()].filter((s) => s.status === 'merged').map((s) => s.id);
    const mergeOk = mergedIds.length === 1 && subsRestored.canonical(mergedIds[0]).status === 'active';
    const obsOwners = [...snap.observations.values()].every((o) => subsRestored.canonical(o.subjectId).status === 'active');
    const polRestored = JSON.parse(fs.readFileSync(path.join(restored, 'policy-baseline.json'), 'utf8'));
    const pendings = JSON.parse(fs.readFileSync(path.join(restored, 'consolidate', 'pending-windows.json'), 'utf8'));
    const reqCount = Object.values(pendings).reduce((a, v) => a + (Array.isArray(v.observationRequests) ? v.observationRequests.length : 0), 0);
    record('P11', '恢复后人工修订/主体/基线/冻结请求都能用（不是"文件在"）',
      '替换=manual / 隐藏生效 / 恢复=回机器值 / 合并可解析 / 基线 group-peers / 请求在',
      `替换=${replaced?.origin} 隐藏=${hiddenIt?.hidden} 恢复=${restoredIt?.origin} 合并=${mergedIds.length} 观察主人=${obsOwners} 请求=${reqCount}`,
      replaced?.origin === 'manual' && replaced?.value === '电工'
        && hiddenIt?.hidden === true
        && restoredIt?.origin === 'machine'
        && mergeOk && obsOwners
        && polRestored.profilePolicy === 'group-peers'
        && reqCount >= 1);
  }

  // ── 未完成 journal：可恢复 + 重复打开幂等 ────────────────────────────────
  {
    const libJ = path.join(root, 'lib-journal');
    fs.cpSync(SRC_LIB, libJ, { recursive: true });
    const idx = JSON.parse(fs.readFileSync(path.join(libJ, 'index.json'), 'utf8'));
    const binSize = fs.statSync(path.join(libJ, 'vectors.bin')).size;
    const metaSize = fs.statSync(path.join(libJ, 'meta.jsonl')).size;
    // 模拟"写了一半崩掉"：多出来的字节 + 多出来的半行 meta，journal 记着旧尺寸
    fs.appendFileSync(path.join(libJ, 'vectors.bin'), Buffer.alloc(idx.dim * 4, 7));
    fs.appendFileSync(path.join(libJ, 'meta.jsonl'), '{"slot":999,"state":"alive","id":"半截');
    fs.writeFileSync(path.join(libJ, 'put-pending.json'), JSON.stringify({
      version: 1, binBytes: binSize, metaBytes: metaSize, index: idx
    }));
    const bakJ = path.join(root, 'bak-journal');
    const b = await exec('offline-backup.mjs', [`--from=${libJ}`, `--to=${bakJ}`, `--host-data=${SRC}`]);
    record('P7', '待恢复 journal：备份不被"尺寸对不上"卡住', 'exit=0', `exit=${b.code}`, b.code === 0, b.code ? b.out.slice(-400) : '');

    const v = await exec('offline-verify.mjs', [`--root=${bakJ}`, `--expect-source-root=${libJ}`]);
    record('P8', '待恢复 journal：验收通过并回报回放', 'exit=0 + 允许删除 put-pending.json',
      `exit=${v.code}`, v.code === 0 && /journal 回放/.test(v.out), v.code ? v.out.slice(-500) : '');
    record('P9', '待恢复 journal：重复打开幂等', '输出含"重复打开:读数不变"',
      /重复打开:读数不变/.test(v.out) ? '有' : '缺', /重复打开:读数不变/.test(v.out));
  }

  // ══ 反例：全部要求非零退出，且**点名原因** ══════════════════════════════
  console.log('\n【反例 · 复审原始形态】');
  {
    // 复审原例：hash 全对、内容全坏、缺活动代
    const d = variant('poison');
    fs.writeFileSync(path.join(d, 'facts/slots.jsonl'), '{这不是JSON\n{"key":""}\n');
    fs.appendFileSync(path.join(d, 'consolidate/events.jsonl'), '{半截\n');
    rehash(d);
    await expectVerify('N1', '哈希全对但事实/事件坏 ⇒ 失败', d, {
      code: 1, contains: ['格式校验', 'facts/slots.jsonl', 'schema_valid   = false'],
      notContains: ['✓ 验收通过']
    });
  }
  {
    const d = variant('bad-slots-struct');
    // 合法 JSON、字段也在，但四元组拼不回 key（loader 会当新槽 ⇒ 静默多一条）
    const rows = fs.readFileSync(path.join(d, 'facts/slots.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    rows[0].speaker = 'P9999';
    fs.writeFileSync(path.join(d, 'facts/slots.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rehash(d);
    await expectVerify('N2', '事实行的键与四元组对不上 ⇒ 失败', d, { code: 1, contains: ['键与四元组不一致'] });
  }
  {
    const d = variant('bad-lineage');
    fs.writeFileSync(path.join(d, '_host/labels.json'), JSON.stringify({ version: 1, entries: { P1: { at: 'x' } } }));
    rehash(d);
    await expectVerify('N3', '沿革条目缺 to ⇒ 失败', d, { code: 1, contains: ['_host/labels.json', '缺少 to'] });
  }
  {
    const d = variant('bad-notes');
    fs.writeFileSync(path.join(d, '_host/notes.json'), JSON.stringify(['不是对象']));
    rehash(d);
    await expectVerify('N4', '备注顶层是数组 ⇒ 失败', d, { code: 1, contains: ['_host/notes.json', '顶层不是对象'] });
  }
  {
    const d = variant('bad-state');
    fs.writeFileSync(path.join(d, 'consolidate/state.json'), JSON.stringify({ version: 1, chats: [1, 2] }));
    rehash(d);
    await expectVerify('N5', '游标 chats 是数组 ⇒ 失败', d, { code: 1, contains: ['consolidate/state.json', 'chats 不是对象'] });
  }
  {
    const d = variant('bad-event-row');
    const rows = fs.readFileSync(path.join(d, 'consolidate/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    delete rows[0].chatKey;
    fs.writeFileSync(path.join(d, 'consolidate/events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rehash(d);
    await expectVerify('N6', '事件行缺 chatKey ⇒ 失败（此前只数非空行）', d, { code: 1, contains: ['consolidate/events.jsonl', '缺少 chatKey'] });
  }
  {
    const d = variant('bad-pending');
    fs.writeFileSync(path.join(d, 'consolidate/pending-windows.json'), JSON.stringify({ k: { attempts: 1 } }));
    rehash(d);
    await expectVerify('N7', '待补窗口缺 win ⇒ 失败（此前完全不校验）', d, { code: 1, contains: ['pending-windows.json', '缺少 win'] });
  }
  {
    const d = variant('bad-outbox');
    fs.appendFileSync(path.join(d, '_host/memory-vec-outbox.jsonl'), '{"id":\n');
    rehash(d);
    await expectVerify('N8', 'outbox 有坏行 ⇒ 失败（此前 bad>0 仍算过）', d, { code: 1, contains: ['_host/memory-vec-outbox.jsonl', '不是合法 JSON'] });
  }
  {
    const d = variant('bad-index-count');
    const idx = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
    idx.alive = idx.alive + 3;
    fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(idx, null, 2));
    rehash(d);
    await expectVerify('N9', 'index.alive 与实际存活不符 ⇒ 失败', d, { code: 1, contains: ['ALIVE_MISMATCH'] });
  }
  {
    const d = variant('bad-bin-size');
    fs.appendFileSync(path.join(d, 'vectors.bin'), Buffer.alloc(64, 0));
    rehash(d);
    await expectVerify('N10', '向量文件长度不等于 slots×dim×4 ⇒ 失败', d, { code: 1, contains: ['BIN_SIZE'] });
  }

  console.log('\n【反例 · 活动代与编码】');
  {
    // 先把"正常库"叠上代结构，确认它**能过**，再逐个破坏（否则反例可能只是"这条路本来就不通"）
    const libG = path.join(root, 'lib-gen');
    fs.cpSync(SRC_LIB, libG, { recursive: true });
    const { gen } = addGeneration(libG);
    const bakG = path.join(root, 'bak-gen');
    const b = await exec('offline-backup.mjs', [`--from=${libG}`, `--to=${bakG}`, `--host-data=${SRC}`]);
    const v = await exec('offline-verify.mjs', [`--root=${bakG}`, `--expect-source-root=${libG}`]);
    record('P10', '代结构库：备份+验收通过（确认这条路本身通）', 'both=0', `backup=${b.code} verify=${v.code}`,
      b.code === 0 && v.code === 0, v.code ? v.out.slice(-400) : '');

    const d1 = guard(path.join(root, 'v-missing-gen'));
    fs.cpSync(bakG, d1, { recursive: true });
    fs.rmSync(path.join(d1, 'vector-generations', gen), { recursive: true, force: true });
    rehash(d1);
    await expectVerify('N11', '指针指向的代不存在 ⇒ 失败（缺活动代）', d1, { code: 1, contains: ['MISSING_GENERATION', '缺活动代'] });

    const d2 = guard(path.join(root, 'v-bad-encoding'));
    fs.cpSync(bakG, d2, { recursive: true });
    const gp = path.join(d2, 'vector-generations', gen, 'index.json');
    const gi = JSON.parse(fs.readFileSync(gp, 'utf8'));
    gi.encoding = '{"version":1,"model":"别的模型"}';
    fs.writeFileSync(gp, JSON.stringify(gi, null, 2));
    rehash(d2);
    await expectVerify('N12', '索引里的编码身份与指针不一致 ⇒ 失败', d2, { code: 1, contains: ['ENCODING_SPLIT'] });

    const d3 = guard(path.join(root, 'v-bad-pointer'));
    fs.cpSync(bakG, d3, { recursive: true });
    fs.writeFileSync(path.join(d3, 'vector-active.json'), JSON.stringify({ version: 1, generation: 'not-a-hash' }));
    rehash(d3);
    await expectVerify('N13', '代指针格式非法 ⇒ 失败', d3, { code: 1, contains: ['BAD_POINTER'] });
  }

  console.log('\n【反例 · 核心 v1 新资产（R2 集成缺口）】');
  {
    // 上一版把这三类文件归 `unclassified`：只复制、不校验 ⇒ 内容全坏也能 verdict=ok。
    // 每一条都**重算哈希**（模拟"清单与内容一起坏"），只让内容校验承担责任。
    const d = variant('manual-tail');
    fs.appendFileSync(path.join(d, 'manual/revisions.jsonl'), '{"version":1,"seq":9');
    rehash(d);
    await expectVerify('N25', '人工修订日志末行截断 ⇒ 失败（未完成 fsync 不能算已提交）', d, {
      code: 1, contains: ['manual/revisions.jsonl', 'INCOMPLETE_TAIL']
    });
  }
  {
    const d = variant('manual-chain');
    rewriteLog(path.join(d, 'manual/revisions.jsonl'), (rows) => { rows[1].previous = 'f'.repeat(64); });
    rehash(d);
    await expectVerify('N26', '人工修订链断裂（哈希各自都对）⇒ 失败', d, {
      code: 1, contains: ['manual/revisions.jsonl', 'CHAIN_BROKEN']
    });
  }
  {
    const d = variant('manual-bad-op');
    rewriteLog(path.join(d, 'manual/revisions.jsonl'), (rows) => { rows[0].data.op = 'delete'; });
    rehash(d);
    await expectVerify('N27', '人工修订未知 op ⇒ 失败（恢复后这条改动会被静默忽略）', d, {
      code: 1, contains: ['manual/revisions.jsonl', '未知 op']
    });
  }
  {
    const d = variant('manual-dup-opid');
    rewriteLog(path.join(d, 'manual/revisions.jsonl'), (rows) => {
      rows.push({ ...structuredClone(rows[0]), seq: rows.length + 1, previous: rows.at(-1).hash });
    });
    rehash(d);
    await expectVerify('N28', '人工修订 operationId 重复 ⇒ 失败（重放判定会拿错结果）', d, {
      code: 1, contains: ['manual/revisions.jsonl', 'DUPLICATE_OPERATION']
    });
  }
  {
    const d = variant('subject-dangling-obs');
    rewriteLog(path.join(d, 'subjects/transactions.jsonl'), (rows) => {
      for (const r of rows) for (const o of r.data.observations) o.subjectId = '00000000-0000-4000-8000-000000000000';
    });
    rehash(d);
    await expectVerify('N29', '观察指向不存在的主体 ⇒ 失败（这条印象永远查不到主人）', d, {
      code: 1, contains: ['subjects/transactions.jsonl', '指向不存在的主体']
    });
  }
  {
    const d = variant('subject-dangling-merge');
    rewriteLog(path.join(d, 'subjects/transactions.jsonl'), (rows) => {
      for (const r of rows) for (const s of r.data.subjects) if (s.status === 'merged') s.mergedInto = '00000000-0000-4000-8000-000000000000';
    });
    rehash(d);
    await expectVerify('N30', '合并指向不存在的主体 ⇒ 失败（撤销/解析都会 404）', d, {
      code: 1, contains: ['subjects/transactions.jsonl', '合并指向不存在的主体']
    });
  }
  {
    const d = variant('subject-version');
    rewriteLog(path.join(d, 'subjects/transactions.jsonl'), (rows) => { rows[0].version = 2; });
    rehash(d);
    await expectVerify('N31', '主体事务未知日志版本 ⇒ 失败（不"尽力理解"）', d, {
      code: 1, contains: ['subjects/transactions.jsonl', 'UNKNOWN_VERSION']
    });
  }
  {
    const d = variant('policy-bad');
    fs.writeFileSync(path.join(d, 'policy-baseline.json'), JSON.stringify({ version: 1, profilePolicy: 'all' }) + '\n');
    rehash(d);
    await expectVerify('N32', '可见性基线被改成别的策略 ⇒ 失败（重启后可见性静默变化）', d, {
      code: 1, contains: ['policy-baseline.json', 'group-peers']
    });
  }
  {
    const d = variant('pending-missing-field');
    const p = JSON.parse(fs.readFileSync(path.join(d, 'consolidate/pending-windows.json'), 'utf8'));
    const k = Object.keys(p).find((x) => Array.isArray(p[x].observationRequests) && p[x].observationRequests.length);
    delete p[k].observationRequests[0].statement;
    fs.writeFileSync(path.join(d, 'consolidate/pending-windows.json'), JSON.stringify(p, null, 2));
    rehash(d);
    await expectVerify('N33', '冻结观察请求缺必要字段 ⇒ 失败（提交时会抛错，窗口永久阻塞）', d, {
      code: 1, contains: ['pending-windows.json', '缺少 statement']
    });
  }
  {
    const d = variant('pending-unknown-subject');
    const p = JSON.parse(fs.readFileSync(path.join(d, 'consolidate/pending-windows.json'), 'utf8'));
    const k = Object.keys(p).find((x) => Array.isArray(p[x].observationRequests) && p[x].observationRequests.length);
    p[k].observationRequests[0].subjectId = '00000000-0000-4000-8000-000000000000';
    fs.writeFileSync(path.join(d, 'consolidate/pending-windows.json'), JSON.stringify(p, null, 2));
    rehash(d);
    await expectVerify('N34', '冻结请求指向未登记主体 ⇒ 失败（跨文件引用断了）', d, {
      code: 1, contains: ['pending-windows.json', 'UNKNOWN_SUBJECT']
    });
  }

  console.log('\n【反例 · 清单与路径】');
  {
    const d = variant('hash-mismatch');
    fs.appendFileSync(path.join(d, 'facts/slots.jsonl'), ' ');
    await expectVerify('N14', '改一个字节（清单不动）⇒ 哈希不符', d, { code: 1, contains: ['哈希一致'] });
  }
  {
    const d = variant('missing-file');
    fs.rmSync(path.join(d, '_host/memory-vec-outbox.jsonl'), { force: true });
    await expectVerify('N15', '备份里少一个文件 ⇒ 失败', d, { code: 1, contains: ['文件齐备', '_host/memory-vec-outbox.jsonl'] });
  }
  {
    const d = variant('manifest-omits');
    const m = manifestOf(d);
    m.files = m.files.filter((f) => f.rel !== '_host/notes.json');
    writeManifest(d, m);
    await expectVerify('N16', '清单少列一个存在的文件 ⇒ 失败（未声明文件）', d, { code: 1, contains: ['无未声明文件', '_host/notes.json'] });
  }
  {
    const d = variant('extra-file');
    fs.writeFileSync(path.join(d, 'facts', 'slots.jsonl.bak'), 'x');
    await expectVerify('N17', '备份后又多了个文件 ⇒ 失败', d, { code: 1, contains: ['无未声明文件', 'slots.jsonl.bak'] });
  }
  {
    const d = variant('path-escape');
    const m = manifestOf(d);
    m.files.push({ section: 'facts', rel: '../escape.txt', bytes: 1, sha256: 'x'.repeat(64), secret: false });
    m.files.push({ section: 'facts', rel: 'C:/Windows/win.ini', bytes: 1, sha256: 'x'.repeat(64), secret: false });
    m.files.push({ section: 'facts', rel: '/etc/passwd', bytes: 1, sha256: 'x'.repeat(64), secret: false });
    writeManifest(d, m);
    await expectVerify('N18', '清单里出现 ../ · 盘符 · 绝对路径 ⇒ 拒绝（不读根外）', d, {
      code: 1, contains: ['路径安全', '含 ..', '含盘符', '绝对路径']
    });
  }
  {
    const d = variant('unknown-version');
    const m = manifestOf(d);
    m.version = 99;
    writeManifest(d, m);
    await expectVerify('N19', '未知清单格式版本 ⇒ 拒绝（不"尽力理解"）', d, { code: 1, contains: ['清单格式版本', '未知版本 99'] });
  }
  {
    const d = variant('no-manifest');
    fs.rmSync(path.join(d, 'OFFLINE-MANIFEST.json'), { force: true });
    const r = await exec('offline-verify.mjs', [`--root=${d}`]);
    record('N20', '没有清单 ⇒ 拒绝执行（exit 2，不是"通过"）', 'exit=2', `exit=${r.code}`, r.code === 2);
  }
  {
    // 跨实例：清单自述是 drill 库，却要按另一个库恢复。
    // ⚠️ 同时钉住"**A 失败不进 B**"：复审第 5 条点名的正是"哈希或实例对账失败后
    //    仍继续调用可能写盘的恢复构造器"。所以这条不仅要求 exit=1，还要求
    //    报告里明写阶段 B 未执行（否则"只读"只是命名，不是行为）。
    const other = path.join(root, 'data-other', 'memory-vec');
    fs.mkdirSync(other, { recursive: true });
    await expectVerify('N21', '跨实例误配 ⇒ 失败，且**不进入阶段 B**（不构造会写盘的 loader）', GOOD, {
      args: [`--expect-source-root=${other}`], code: 1, contains: ['跨实例', '阶段 B', '未执行']
    });
  }
  {
    // 空库但清单声明"全量"、实际目录里却多了东西
    const d = variant('absent-contradiction');
    const m = manifestOf(d);
    m.absent = [...(m.absent || []), { rel: 'facts/slots.jsonl', reason: '假的' }];
    writeManifest(d, m);
    await expectVerify('N22', '声明 absent 但文件确实在 ⇒ 矛盾即失败', d, { code: 1, contains: ['声明一致'] });
  }
  {
    // ★ 复审的**原始形态**：不是四处分别坏，而是**同时**坏 —— 哈希全对、内容全坏、缺活动代。
    //   分四次坏只能证明"每条判据各自会响"，证明不了"一次能把坏处报全"。
    //   只报第一个错也会 exit 1，但操作者会陷入"修一个、再跑、再发现下一个"的循环。
    const libC = path.join(root, 'lib-combined');
    fs.cpSync(SRC_LIB, libC, { recursive: true });
    const { gen: genC } = addGeneration(libC);
    const bakC = path.join(root, 'bak-combined');
    const bC = await exec('offline-backup.mjs', [`--from=${libC}`, `--to=${bakC}`, `--host-data=${SRC}`]);
    if (bC.code !== 0) throw new Error(`综合坏法用例的前提（备份）失败：${bC.out.slice(-300)}`);
    const d = guard(path.join(root, 'v-combined'));
    fs.cpSync(bakC, d, { recursive: true });
    fs.rmSync(path.join(d, 'vector-generations', genC), { recursive: true, force: true });  // 缺活动代
    fs.writeFileSync(path.join(d, 'facts/slots.jsonl'), '{这不是JSON\n');                      // 事实坏
    fs.writeFileSync(path.join(d, '_host/labels.json'), JSON.stringify({ version: 1, entries: { P1: { at: 'x' } } }));
    fs.appendFileSync(path.join(d, 'consolidate/events.jsonl'), '{半截\n');                     // 事件坏
    rehash(d);
    await expectVerify('N23', '哈希全对 + 事实/沿革/事件坏 + 缺活动代 ⇒ 一次报全（不短路）', d, {
      code: 1,
      contains: ['MISSING_GENERATION', 'facts/slots.jsonl', '_host/labels.json', 'consolidate/events.jsonl', 'schema_valid   = false'],
      notContains: ['✓ 验收通过']
    });
  }
  {
    // 目录里塞一个 junction（指向备份根之外）：词法上完全合法，只有落到磁盘才能发现。
    // 这是"越界符号链接"那条要求的**可执行**形态 —— Windows 下 junction 建目录链接不需要管理员。
    const d = variant('junction');
    const outside = path.join(root, 'outside-for-junction');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
    let made = null;
    try {
      fs.symlinkSync(outside, path.join(d, 'facts', 'linked'), 'junction');
      made = '';
    } catch (e) { made = String(e?.message || e); }
    if (made) {
      record('N24', '备份里出现 junction ⇒ 拒绝跟进', 'exit=1 + 是符号链接',
        `环境不支持创建 junction（${made}）`, false, '未验证 = 不算通过');
    } else {
      await expectVerify('N24', '备份里出现 junction ⇒ 拒绝跟进（不读根外）', d, {
        code: 1, contains: ['路径安全', '是符号链接']
      });
    }
  }

  console.log('\n【护栏 · 用法错误一律 exit 2】');
  {
    const r1 = await exec('offline-verify.mjs', []);
    record('G1', '验收缺 --root', 'exit=2', `exit=${r1.code}`, r1.code === 2);
    const r2 = await exec('offline-backup.mjs', []);
    record('G2', '备份缺 --from/--to', 'exit=2', `exit=${r2.code}`, r2.code === 2);
    const r3 = await exec('offline-backup.mjs', [`--from=${SRC_LIB}`, `--to=${GOOD}`]);
    record('G3', '目标非空（不覆盖）', 'exit=2', `exit=${r3.code}`, r3.code === 2);
    const r4 = await exec('offline-backup.mjs', [`--from=${SRC_LIB}`, `--to=${path.join(SRC_LIB, 'inside')}`]);
    record('G4', '目标在源内部', 'exit=2', `exit=${r4.code}`, r4.code === 2);
    const r5 = await exec('offline-verify.mjs', [`--root=${GOOD}`, `--stage=a`, `--expect-source-root=${SRC_LIB}`]);
    record('G5', '--stage=a ⇒ recovery_valid 未知 ⇒ 不算通过', 'exit=1 + unknown',
      `exit=${r5.code}`, r5.code === 1 && /recovery_valid = unknown/.test(r5.out));
    // 上一版的 `same !== false`：不传目标根时"没核对"被当成"没问题"。
    // 生产恢复批准必须明确核对目标实例 —— 省略参数就该是**未验收**，不是通过。
    const r6 = await exec('offline-verify.mjs', [`--root=${GOOD}`]);
    record('G7', '省略 --expect-source-root ⇒ 未验收（identity/recovery 均 unknown，exit=1）',
      'exit=1 + identity_valid = unknown + 未验收',
      `exit=${r6.code}`, r6.code === 1 && /identity_valid = unknown/.test(r6.out) && /未验收/.test(r6.out));
  }

  // ── 输入不变性：源库在整场演练里没被改 ───────────────────────────────────
  {
    const now = fingerprint(SRC_LIB);
    record('G6', '演练全程未改动源库', '指纹一致', sameFp(libFpBefore, now) ? '一致' : '被改过', sameFp(libFpBefore, now));
  }
} catch (e) {
  crashed = e;
  console.error(`\n演练自身出错：${String(e?.stack || e)}\n`);
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 汇总
// ══════════════════════════════════════════════════════════════════════════
const bad = rows.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(78)}`);
console.log(`矩阵：${rows.length} 条，${rows.length - bad.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
  console.log('失败项：');
  for (const r of bad) console.log(`  · ${r.id} ${r.what}  期望 ${r.want} / 实测 ${r.got}`);
}
const pos = rows.filter((r) => /^P/.test(r.id));
const neg = rows.filter((r) => /^N/.test(r.id));
const grd = rows.filter((r) => /^G/.test(r.id));

const cleanup = !KEEP && !crashed && bad.length === 0;
if (cleanup) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
} else {
  console.log(`现场保留：${root}${KEEP ? '（--keep）' : ''}`);
}

// ── 机器可读结果（供 test/offline-restore.mjs 用）────────────────────────────
// 有意**放在清理之后**写：`--json` 的路径习惯上就在调用方的 tmp 目录里，
// 万一它落在演练根下，先写就会被清理掉，而"文件不存在"会被读成"没有失败"。
if (JSON_OUT) {
  const payload = {
    at: new Date().toISOString(),
    crashed: crashed ? String(crashed?.message || crashed) : null,
    counts: {
      total: rows.length, pass: rows.length - bad.length, fail: bad.length,
      positive: pos.length, negative: neg.length, guard: grd.length
    },
    rows: rows.map((r) => ({ id: r.id, what: r.what, want: r.want, got: r.got, ok: r.ok, why: r.why }))
  };
  try { fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2)); }
  catch (e) { console.error(`写 --json 结果失败：${e.message}`); jsonFailed = true; }
}

console.log(bad.length || crashed
  ? `\n✗ 未通过：${bad.length} 条用例失败${crashed ? ' + 演练崩溃' : ''}\n`
  : `\n✅ 矩阵全通过：正例 ${pos.length} · 反例 ${neg.length} · 护栏 ${grd.length}\n`);
process.exit(bad.length || crashed || jsonFailed ? 1 : 0);
