// memory-vec 自检 —— 零依赖、不联网、跑完 exit 0。
//
// 纪律：每条断言都在**复现一个真实的坑**，而不是"函数写对了没"。具体地：
//   · 维度不匹配必须**明确拒绝**（这是本插件最容易静默失败的地方）
//   · 全零向量必须被拒（能用 0 伪装 = 病灶）
//   · 半截写入的库必须被**检出**，不许静默截断成"能跑"
//   · 165 条同分必须判"不健康"（这是别人用真数据摔出来的教训，必须写死成测试）
//
// 运行：node test/selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { VecStore, VecStoreError, validateVector } from '../src/core/vecstore.mjs';
import { checkEndpoint, embedTexts, embedDocuments, embedQueries, formatQuery, EmbedError,
  clampBatchSize, parseBatchLimit, DEFAULT_BATCH_SIZE } from '../src/core/embed.mjs';
import { endpointOf, vocabularyNeeded, parseSelfAliases, aliasSignature, selfAliasSurfaces } from '../src/core/backend.mjs';
import { archiveFingerprint } from '../src/core/vocab.mjs';
import { parseChunkFileName, buildSourceText, buildEmbedText, sourceHash, listChunks, readChunk } from '../src/core/chunkread.mjs';
import { Normalizer } from '../src/core/normalize.mjs';
import { distribution, judge, summarize } from '../src/core/stats.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let section = '';

function head(name) {
  section = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`);
}
function throwsWith(code, fn, label) {
  try {
    fn();
    ok(false, label, `（预期抛 ${code}，实际没抛）`);
  } catch (err) {
    ok(err instanceof VecStoreError || err instanceof EmbedError ? err.code === code : false, label,
      `（得到 ${err?.code || err?.name}: ${String(err?.message || err).slice(0, 80)}）`);
  }
}
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-selftest-'));
  return { dir, store: new VecStore(dir) };
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════
head('向量库 · 基本读写');
{
  const { dir, store } = makeStore();
  const v1 = [1, 0, 0, 0];
  const v2 = [0, 1, 0, 0];
  const r1 = store.put({ id: 'a', vector: v1, model: 'm1', meta: { title: '甲', chatKey: 'group:1', sourceHash: 'h1' } });
  ok(r1.created && !r1.updated, '第一条写入 = created');
  store.put({ id: 'b', vector: v2, model: 'm1', meta: { title: '乙', chatKey: 'group:1', sourceHash: 'hb' } });
  ok(store.count === 2, 'count = 2', `(${store.count})`);
  ok(store.dim === 4, '维度锁定为 4', `(${store.dim})`);

  const got = store.get('a');
  ok(got && Array.from(got.vector).join(',') === '1,0,0,0', '按 id 取回向量原样');
  ok(store.get('不存在') === null, '取不存在的 id 返回 null（不抛）');

  // 幂等：同 sourceHash 不重复占槽
  const r2 = store.put({ id: 'a', vector: v1, model: 'm1', meta: { title: '甲', chatKey: 'group:1', sourceHash: 'h1' } });
  ok(r2.skipped === true, '同 sourceHash → 幂等跳过（skipped=true）');
  ok(store.count === 2 && store.status().slots === 2, '幂等跳过不占新槽', `(slots=${store.status().slots})`);

  // 变化时走新槽 + 老槽 tombstone
  store.put({ id: 'a', vector: [1, 0, 0, 0], model: 'm1', meta: { title: '甲改', chatKey: 'group:1', sourceHash: 'h2' } });
  ok(store.count === 2 && store.status().slots === 3, '内容变了 → 新槽 + 老槽 tombstone', `(slots=${store.status().slots})`);
  ok(store.get('a').meta.title === '甲改', 'id 指向最新那条');

  const st = store.status();
  ok(st.deleted === 1, 'status 报告 1 条待回收', `(deleted=${st.deleted})`);
  cleanup(dir);
}

// ═══════════════════════════════════════════════════════════════════════
head('向量库 · 明确拒绝（本插件最要紧的一类）');
{
  const { dir, store } = makeStore();
  store.put({ id: 'a', vector: [1, 0, 0, 0], model: 'm1' });

  throwsWith('DIM_MISMATCH', () => store.put({ id: 'c', vector: [1, 0, 0], model: 'm1' }), '写入维度不符 → 拒绝');
  throwsWith('MODEL_MISMATCH', () => store.put({ id: 'c', vector: [1, 0, 0, 0], model: 'm2' }), '写入模型不符 → 拒绝');
  throwsWith('DIM_MISMATCH', () => store.search({ vector: [1, 0, 0] }), '检索维度不符 → 拒绝');
  throwsWith('BAD_VECTOR', () => store.put({ id: 'z', vector: [0, 0, 0, 0], model: 'm1' }), '全零向量 → 拒绝（不许用 0 伪装）');
  throwsWith('BAD_VECTOR', () => store.put({ id: 'n', vector: [1, NaN, 0, 0], model: 'm1' }), 'NaN 分量 → 拒绝');
  throwsWith('BAD_ID', () => store.put({ id: '  ', vector: [1, 0, 0, 0], model: 'm1' }), '空 id → 拒绝');

  // 拒绝之后库必须完好
  ok(store.count === 1 && !store.status().readOnly, '连续拒绝后库仍完好且可写', `(count=${store.count})`);
  cleanup(dir);
}

// ═══════════════════════════════════════════════════════════════════════
head('向量库 · 检出半截写入（不静默修复）');
{
  const { dir, store } = makeStore();
  store.put({ id: 'a', vector: [1, 0, 0, 0], model: 'm1' });
  store.put({ id: 'b', vector: [0, 1, 0, 0], model: 'm1' });
  // 模拟 bin 被截断（写 bin 成功、写 meta 前进程死掉的镜像）
  fs.appendFileSync(path.join(dir, 'vectors.bin'), Buffer.alloc(7)); // 多出 7 字节，不是 16 的整数倍

  const reopened = new VecStore(dir);
  ok(reopened.status().readOnly === true, '重新打开时进入只读并给出原因');
  ok(/大小与 meta 不符/.test(reopened.status().readOnlyReason), '原因说得具体（不是"库损坏"四个字）',
    `(${reopened.status().readOnlyReason})`);
  ok(reopened.count === 0, '只读时 count 为 0（不拿半个库冒充可用）');
  throwsWith('READ_ONLY', () => reopened.put({ id: 'c', vector: [1, 1, 0, 0], model: 'm1' }), '只读状态下写入 → 拒绝');

  // meta.jsonl 中间空行
  const { dir: d2, store: s2 } = makeStore();
  s2.put({ id: 'a', vector: [1, 0, 0, 0], model: 'm1' });
  s2.put({ id: 'b', vector: [0, 1, 0, 0], model: 'm1' });
  const mf = path.join(d2, 'meta.jsonl');
  const lines = fs.readFileSync(mf, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(mf, `${lines[0]}\n\n${lines[1]}\n`, 'utf8');
  const reopened2 = new VecStore(d2);
  ok(reopened2.status().readOnly === true, 'meta.jsonl 中间空行 → 检出为损坏');
  cleanup(dir); cleanup(d2);
}

// ═══════════════════════════════════════════════════════════════════════
head('向量库 · 检索与 tombstone');
{
  const { dir, store } = makeStore();
  // 三维单位向量，查询 [1,0,0] 时 a 应排第一
  store.put({ id: 'a', vector: [1, 0, 0], model: 'm1', meta: { chatKey: 'g1' } });
  store.put({ id: 'b', vector: [0.8, 0.6, 0], model: 'm1', meta: { chatKey: 'g1' } });
  store.put({ id: 'c', vector: [0, 1, 0], model: 'm1', meta: { chatKey: 'g2' } });

  const r = store.search({ vector: [1, 0, 0], k: 3 });
  ok(r.hits.length === 3, '检索返回 3 条');
  ok(r.hits[0].id === 'a', '余弦排序正确（a 第一）', `(顺序 ${r.hits.map((h) => h.id).join('>')})`);
  ok(Math.abs(r.hits[0].score - 1) < 1e-6, 'a 的分数 ≈ 1', `(${r.hits[0].score.toFixed(6)})`);

  const g2 = store.search({ vector: [1, 0, 0], k: 3, chatKey: 'g2' });
  ok(g2.hits.length === 1 && g2.hits[0].id === 'c', 'chatKey 过滤生效');

  // 删掉 a：检索里必须消失
  store.del('a');
  const r2 = store.search({ vector: [1, 0, 0], k: 3 });
  ok(!r2.hits.some((h) => h.id === 'a'), '删除后 tombstone 不参与检索');
  ok(store.count === 2, 'count 同步为 2', `(${store.count})`);

  // 最近邻自身排除
  const nb = store.neighbors('b', 3);
  ok(nb && !nb.hits.some((h) => h.id === 'b'), '最近邻排除自身');

  // compact
  const cp = store.compact();
  ok(cp.removed === 1 && store.status().slots === 2, 'compact 回收 1 个 tombstone 槽', `(${JSON.stringify(cp)})`);
  const r3 = store.search({ vector: [1, 0, 0], k: 3 });
  ok(r3.hits.length === 2 && store.get('b').meta.chatKey === 'g1', 'compact 后数据仍正确');
  cleanup(dir);
}

// ═══════════════════════════════════════════════════════════════════════
head('向量库 · 落盘复查');
{
  const { dir, store } = makeStore();
  for (let i = 0; i < 20; i++) {
    store.put({ id: `r${i}`, vector: [i + 1, 1, 0], model: 'm1', meta: { chatKey: 'g1' } });
  }
  store.del('r5');
  store.del('r7');
  const v = store.verify();
  ok(v.ok, 'verify() 报告一致', v.ok ? '' : `(${v.problems.join('；')})`);

  const reopened = new VecStore(dir);
  ok(reopened.count === 18, '重新打开后存活数 18', `(${reopened.count})`);
  ok(reopened.status().slots === 20, '槽数 20（tombstone 仍在）', `(${reopened.status().slots})`);
  ok(reopened.get('r3') !== null && reopened.get('r5') === null, '删除的取不回、未删的取得到');
  ok(!reopened.status().readOnly, '正常库重新打开不进只读');
  cleanup(dir);
}

// ═══════════════════════════════════════════════════════════════════════
head('块读取 · 文件名解析与文本构建');
{
  const p = parseChunkFileName('hour_group_1098345913_2026-09-2500.json');
  ok(p && p.kind === 'hour' && p.chatKey === 'group:1098345913' && p.hourKey === '2026-09-25 00',
    '小时块文件名解析正确', `(${p ? `${p.chatKey} / ${p.hourKey}` : 'null'})`);
  const d = parseChunkFileName('day_group_100000000_2026-09-10.json');
  ok(d && d.kind === 'day' && d.dayKey === '2026-09-10', '日块文件名解析正确');
  ok(parseChunkFileName('随便一个.json') === null, '不匹配的文件名返回 null（不抛错）');

  const chunk = {
    id: 'hour_group_1098345913_2026-09-2500',
    title: 'group:1098345913 @ 2026-09-25 00:00',
    timeOfDay: '夜',
    keywords: ['模型', '插件', '记忆'],
    summary: '这'.repeat(3000),
    when: 1790269194000
  };
  // 出境文本必须经过归一化器（ADR-0002）—— 不传就直接抛 NORMALIZER_REQUIRED
  const norm = new Normalizer({ secret: 's'.repeat(40) });
  norm.setVocabulary([{ id: 'group:1098345913', kind: 'group', surface: [] }]);
  const t = buildEmbedText(chunk, { maxChars: 500, normalizer: norm });
  ok(t.truncated === true && t.usedChars === 500, '超长摘要被截断到 500 字', `(原 ${t.fullChars} → 用 ${t.usedChars})`);
  ok(t.text.includes('关键词：模型 插件 记忆'), '关键词进入向量化文本');
  ok(t.text.includes('（夜）'), '时段进入向量化文本');
  ok(!t.text.includes('1098345913'), '群体 QQ 号在出境文本里被占位符替换（本插件存在的理由之一）');
  ok(t.redaction.entities >= 1, '边界报告记下了替换处数', `(${t.redaction.entities} 处)`);

  const t2 = buildEmbedText({ title: 'x', summary: '短' }, { maxChars: 500, normalizer: norm });
  ok(t2.truncated === false, '短文本不标截断');

  const h1 = sourceHash(chunk, t.text);
  const h2 = sourceHash(chunk, t.text);
  const h3 = sourceHash({ ...chunk, when: 1 }, t.text);
  ok(h1 === h2, '同输入 → 同 sourceHash（幂等的依据）');
  ok(h1 !== h3, 'when 变了 → sourceHash 变（会重新索引）');
}

// ═══════════════════════════════════════════════════════════════════════
head('块读取 · 真实目录（缺目录要能优雅退化）');
{
  const missing = path.join(os.tmpdir(), 'mv-not-exist-' + Date.now());
  ok(Array.isArray(listChunks(missing)) && listChunks(missing).length === 0, '目录不存在 → 返回空数组（不抛）');
  const r = readChunk(missing, 'x');
  ok(r.error, '读不存在的块 → 返回 {error}（不抛）');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-chunks-'));
  fs.writeFileSync(path.join(tmp, 'hour_group_1_2026-01-0100.json'), JSON.stringify({ id: 'hour_group_1_2026-01-0100', title: 't', summary: 's' }), 'utf8');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'ignore me', 'utf8');
  const listed = listChunks(tmp);
  ok(listed.length === 1, '只列 .json 块（忽略其它文件）', `(${listed.length})`);
  const read = readChunk(tmp, 'hour_group_1_2026-01-0100');
  ok(read.chunk && read.chunk.title === 't', '真实文件读得回来');
  cleanup(tmp);
}

// ═══════════════════════════════════════════════════════════════════════
head('分布观测 · 必须抓住"165 条全一样"');
{
  const bad = Array.from({ length: 165 }, () => 0.8421);
  const db = distribution(bad);
  ok(db.tiers === 1 && db.range === 0, '165 条同分 → 档数 1、极差 0');
  ok(db.maxTie === 165, '报告最大并列 165', `(${db.maxTie})`);
  const jb = judge(db);
  ok(jb.ok === false, '判据 → 不健康（拒绝上线）');
  ok(jb.checks.find((c) => c.id === 'tiers').pass === false, '逐条给出"档数不足"的结论');
  console.log(`        ${summarize(db)}`);

  const good = Array.from({ length: 100 }, (_, i) => 1 - i * 0.006);
  const dg = distribution(good);
  const jg = judge(dg);
  ok(jg.ok === true, '正常分布 → 判据通过', `(${summarize(dg)})`);

  // topTiers 的意义：全局健康但 top-5 全一样
  const sneaky = [1.5, 1.5, 1.5, 1.5, 1.5, ...Array.from({ length: 50 }, (_, i) => 0.5 - i * 0.005)];
  const ds = distribution(sneaky);
  const js = judge(ds);
  ok(ds.tiers >= 3 && ds.range > 0.01, '全局看着"健康"（档数够、极差够）', `(档数=${ds.tiers} 极差=${ds.range.toFixed(3)})`);
  ok(js.checks.find((c) => c.id === 'topTiers').pass === false, '但 top-5 只有 1 档 → 单独被抓出来');
  ok(js.ok === false, '整体判据仍然拒绝（只看全局会误判成健康）');

  ok(distribution([]).n === 0, '空样本 → n=0（不许拿 0 当分数）');
  ok(distribution([1, NaN, 2, undefined]).n === 2, '非法值被过滤，只数有限数', `(${distribution([1, NaN, 2, undefined]).n})`);
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 端点体检与失败说话');
{
  ok(checkEndpoint({ baseURL: '', model: 'm', apiKey: 'k' }).ok === false, '空 baseURL → 不通过');
  ok(checkEndpoint({ baseURL: 'https://x.com', model: '', apiKey: 'k' }).ok === false, '空模型名 → 不通过');
  ok(checkEndpoint({ baseURL: 'https://x.com', model: 'm', apiKey: '' }).ok === true, '空 Key → **通过**（本机端点不校验 Key；不再把它判成"没配齐"）');
  ok(checkEndpoint({ baseURL: 'not a url', model: 'm', apiKey: 'k' }).ok === false, '非法 URL → 不通过');
  ok(checkEndpoint({ baseURL: 'https://api.deepseek.com', model: 'text-embedding', apiKey: 'k' }).ok === true, '齐备 → 通过');

  // ── 设置形状 → 端点形状：这条桥曾经缺一段（2026-10-08 宿主首次真跑时才红）。
  //    三处把 rt.settings 直接喂给 checkEndpoint，键名对不上 ⇒ 无论怎么配都报
  //    「baseURL 为空」。上面五条只用端点形状测过，所以一路绿。这里补的是**形状本身**：
  const SETTINGS = { embedBaseURL: 'https://api.deepseek.com', embedModel: 'text-embedding', embedApiKey: 'k' };
  ok(checkEndpoint(SETTINGS).ok === false, '设置形状**不能**直接过 checkEndpoint（键名不同：embedBaseURL ≠ baseURL）');
  ok(checkEndpoint(endpointOf(SETTINGS)).ok === true, '经 endpointOf 映射后 → 通过（这是唯一的搬运点）');
  ok(endpointOf(SETTINGS).baseURL === SETTINGS.embedBaseURL
    && endpointOf(SETTINGS).model === SETTINGS.embedModel
    && endpointOf(SETTINGS).apiKey === SETTINGS.embedApiKey, 'endpointOf 三个必填项逐个搬对');
  ok(checkEndpoint(endpointOf({})).problems.length === 3, '空设置经映射 → 空 baseURL / 空模型 / 非法 URL 三项全报，不静默通过');
  ok(checkEndpoint(endpointOf({ ...SETTINGS, embedApiKey: '' })).ok === true, '本机端点（无 Key）经映射 → 通过：本地路线不被 Key 卡住');

  // ── 词表装载判据：这条也曾在真机上红过，且是**静默**的那一种（2026-10-08 首次部署）。────
  //    旧判据 `entities.size > 0` 问的是"文件里有没有东西"，而 `entities.json` 里
  //    **永远至少有一个 `self` 种子** ⇒ 重启后恒真 ⇒ 全量词表（本机 944 个实体）
  //    一次都没装过。冷启动时 `林寒枫霜: …` 认不出来原样留下，直到对齐层凭硬 ID
  //    把它认出来，才在**下一批**被 findLeak 报成泄漏（报的是「层：align」）。
  //    下面第一条是**对撞断言**：证明旧判据确实会短路（否则后面几条测的是空气）。
  const seedOnly = new Normalizer({ secret: 'v'.repeat(40) });
  seedOnly.setVocabulary([{ id: 'self', kind: 'self', surface: ['我'] }]);
  ok(seedOnly.entities.size > 0,
    '只有种子（self）时旧判据 `entities.size > 0` 也为真 —— 这正是它短路的原因（对撞）',
    `(entities=${seedOnly.entities.size})`);
  const SIG = '35|147000000|1791694065005';
  const LOADED = { identityLoaded: true, vocabularySelfAliases: '', vocabularyArchiveSig: SIG };
  const fp = (sig) => ({ archiveSig: sig });

  ok(vocabularyNeeded({ identityLoaded: false }) === true, '运行期没装载过 → 必须装词表');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: '', vocabularyArchiveSig: SIG }, fp(SIG)) === false,
    '装载过 + 别称没变 + 存档没变 → 不重扫（省掉那几秒）');
  ok(vocabularyNeeded({ identityLoaded: true }, { force: true }) === true, 'force（面板「重建词表」）→ 一定重扫');
  ok(vocabularyNeeded({}, fp(SIG)) === true, 'rt 缺字段（旧形状/半初始化）→ 当作没装：缺省**不降级**成"已装载"');

  // ── 别称是词表的**输入**之一：它变了，词表就过期了 ──────────────────────
  // 反例（改前）：`identityLoaded` 是唯一判据 ⇒ 在面板里补了别称、点「重建词表」
  // 之外的一切路径都还拿旧词表，表现是"改了别称没生效、且不报错"。
  ok(parseSelfAliases('samara')?.length === 1, '别称解析：单个');
  ok(parseSelfAliases(' samara , 小萨 、Single Samara ').join('|') === 'samara|小萨|Single Samara',
    '别称解析：逗号/顿号/空白都当分隔符，并去空白', `(${JSON.stringify(parseSelfAliases(' samara , 小萨 、Single Samara '))})`);
  ok(parseSelfAliases('a\nb；c').join('|') === 'a|b|c', '别称解析：换行与中文分号也是分隔符');
  ok(parseSelfAliases('').length === 0 && parseSelfAliases(undefined).length === 0,
    '别称解析：空串/undefined → 空数组（**缺省不声明，也不猜**）');
  ok(aliasSignature('samara,小萨') === aliasSignature('小萨 , samara'),
    '别称签名**顺序无关** —— 只是改了书写顺序不该触发重扫');
  ok(vocabularyNeeded({ identityLoaded: true, settings: { selfAliases: 'samara' }, vocabularyArchiveSig: SIG }, fp(SIG)) === true,
    '声明了别称但没装载记录 → 必须重装（缺字段不降级成"已装载"）');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: 'samara', vocabularyArchiveSig: SIG, settings: { selfAliases: 'samara' } }, fp(SIG)) === false,
    '别称没变 + 存档没变 → 不重扫');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: 'samara', vocabularyArchiveSig: SIG, settings: { selfAliases: 'samara,小萨' } }, fp(SIG)) === true,
    '别称**加了**一项 → 词表过期，重装');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: 'samara', vocabularyArchiveSig: SIG, settings: { selfAliases: '' } }, fp(SIG)) === true,
    '别称**删空**同样是一次"输入变了" → 重装（不比空签名就会一直留着那条不想要的别称）');
  ok(vocabularyNeeded({ identityLoaded: true, settings: {}, vocabularyArchiveSig: SIG }, fp(SIG)) === false,
    '没声明别称、也没记录别称 → 保持既有契约（空签名是"没声明"的规范形态）');

  // ── 第三个输入：**存档长没长**（2026-10-11 补）────────────────────────────
  // 反例（改前）：前两个判据都答对了自己的问题，却都没回答"有没有新的人说话了"。
  // 真机代价：12:47 装载的词表（986 实体）到 19:05 已落后存档 164 个人，
  // 他们全部落成 `X####` 临时标签 —— 身份页查不到、备注会在下次重建时静默失联。
  ok(vocabularyNeeded(LOADED, fp('35|148000000|1791710000000')) === true,
    '存档**变了**（指纹不同）→ 词表过期，重装（新说话的人必须拿到正式标签）');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: '' }, fp(SIG)) === true,
    '有装载记录但**没记过指纹**（老形状）→ 重扫一次补上');
  ok(vocabularyNeeded({ identityLoaded: true, vocabularySelfAliases: '', vocabularyArchiveSig: SIG }) === true,
    '调用方**没给指纹** → 重扫（宁可多扫一次，也不装作"没变" —— 静默落后才是真故障）');
  ok(vocabularyNeeded(LOADED, { force: true }) === true, 'force 优先于一切指纹比较');
  ok(vocabularyNeeded(LOADED, fp(SIG)) === false, '指纹一致 → 不重扫（这条与上一条成对，否则"永远重扫"也会全绿）');

  // `archiveFingerprint` 本身：没有存档时也必须给一个**稳定**的指纹（不能变成随机/NaN）
  const fpEmpty = archiveFingerprint('E:/__no_such_dir_for_fingerprint__');
  ok(fpEmpty.files === 0 && fpEmpty.bytes === 0 && fpEmpty.sig === '0|0|0',
    '空目录/不存在 ⇒ 指纹是稳定的 `0|0|0`（不许 NaN / 随机 —— 那会让判据恒真或恒假）',
    `(${JSON.stringify(fpEmpty)})`);

  // 词表匹配是**逐字面**的（`Samara` ≠ `samara`），所以 ASCII 别称必须展开大小写变体。
  // 范围**只限显式别称** —— 对全词表折叠会把人名 `May` 变成替换掉任何文本里的 `may`。
  ok(selfAliasSurfaces('samara').slice().sort().join('|') === 'SAMARA|Samara|samara',
    'ASCII 别称展开三种大小写形态', `(${JSON.stringify(selfAliasSurfaces('samara'))})`);
  ok(selfAliasSurfaces('小萨').join('|') === '小萨', '非 ASCII 别称不展开（无从展开，也不该乱造）');
  ok(selfAliasSurfaces('').length === 0, '空 ⇒ 不产出任何 surface');
  ok(selfAliasSurfaces('samara, samara').filter((x) => x === 'samara').length === 1,
    '重复声明去重（同一个 surface 进两次没意义）');

  let threw = null;
  try {
    await embedTexts(['x'], { baseURL: '', model: 'm', apiKey: 'k' });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof EmbedError && threw.code === 'BAD_ENDPOINT', '端点不齐备时抛 EmbedError（不静默返回空）');

  // 空输入不该联网
  const empty = await embedTexts([], { baseURL: 'https://x', model: 'm', apiKey: 'k' });
  ok(empty.vectors.length === 0 && empty.dim === 0, '空输入直接返回，不发请求');
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 正路径（第一次跑真请求）');
{
  // 这一段的来历值得记下来：第一版 embedTexts 里写的是 `Number(ep.retries) ?? 2`，
  // 而 `Number(undefined)` 是 NaN、`??` 只管 null/undefined —— 于是 NaN 一路穿过
  // Math.min/Math.max，`attempt <= NaN` 恒为 false，循环体一次都不执行，
  // 最后抛出"第 1 批没有拿到结果"。上面那批用例**完全没抓到**，因为它们只覆盖了
  // 「端点不齐备」和「空输入」两条失败路径 —— 正常路径一次都没走过。
  // 教训：自检必须至少走通一次 happy path，只测失败路径等于没测。
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
      const input = Array.isArray(p.input) ? p.input : [p.input];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: [1, 0, 0, 0] })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ep = { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' };
  try {
    const r = await embedTexts(['甲', '乙', '丙'], ep);
    ok(r.vectors.length === 3, '正路径：批量嵌入返回 3 条（retries 缺省时也必须能跑通）', `(batches=${r.batches})`);
    ok(r.dim === 4 && r.vectors[0].length === 4, '正路径：维度正确', `(dim=${r.dim})`);
    // 分批
    const r2 = await embedTexts(Array.from({ length: 5 }, (_, i) => `t${i}`), { ...ep, batchSize: 2 });
    ok(r2.vectors.length === 5 && r2.batches === 3, '分批调用条数与批次数正确', `(batches=${r2.batches})`);
    // 显式 retries:0 也必须能跑（0 是合法值，不能被"默认值"顶掉）
    const r3 = await embedTexts(['x'], { ...ep, retries: 0 });
    ok(r3.vectors.length === 1, 'retries 显式传 0 时不被默认值顶掉（0 是合法值）');
  } catch (e) {
    ok(false, '正路径：批量嵌入能跑通', `（抛错：${e?.code || ''} ${e?.message}）`);
  }
  server.close();
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 错误必须说话');
{
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let threw = null;
  try {
    await embedTexts(['x'], { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', retries: 1 });
  } catch (e) {
    threw = e;
  }
  server.close();
  ok(threw instanceof EmbedError && threw.code === 'BATCH_FAILED', '端点 429 时抛 EmbedError（不静默返回空）');
  ok(/429/.test(String(threw?.message || '')), '错误信息里带上了状态码', `(${String(threw?.message).slice(0, 70)}…)`);
  ok(/rate limited/.test(String(threw?.message || '')) || /429/.test(String(threw?.message || '')),
    '错误信息里带上了端点返回的正文（排查全靠它）');

  // 认证类错误不该重试：把 Key 填错不会因为多试两次就变对。
  const s401 = http.createServer((req, res) => { res.writeHead(401); res.end('bad key'); });
  await new Promise((r) => s401.listen(0, '127.0.0.1', r));
  const p401 = s401.address().port;
  const t0 = Date.now();
  let e401 = null;
  try {
    await embedTexts(['x'], { baseURL: `http://127.0.0.1:${p401}`, apiKey: 'k', model: 'm', retries: 3 });
  } catch (e) { e401 = e; }
  const dt = Date.now() - t0;
  s401.close();
  ok(e401?.code === 'HTTP_ERROR' && /401/.test(String(e401?.message || '')),
    '401 原样抛出（保留具体错误码，不被包装成 BATCH_FAILED）', `(${e401?.code})`);
  ok(dt < 1000, '401 不重试（立即失败，不空等 3 次）', `(${dt}ms)`);
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 条数不符必须拦下');
{
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // 故意少返回一条：有些网关在超长输入时会悄悄丢掉
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let threw = null;
  try {
    await embedTexts(['a', 'b'], { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', retries: 0 });
  } catch (e) {
    threw = e;
  }
  server.close();
  ok(threw instanceof EmbedError && threw.code === 'COUNT_MISMATCH',
    '端点少返回一条时被拦下（否则会静默错位：b 的向量配到 a 上）', `(${threw?.code})`);
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 端点嫌批量太大时自己改小重发（2026-10-14 截图事故）');
{
  // ── 这一段的来历：**默认值 16 撞上阿里云 text-embedding-v3 的上限 10** ──────
  // 现场：面板"建索引" ⇒ 第一片 16 条直接 400 ⇒ 整轮索引停住（`data-2` 实测只嵌入 2/16 块）。
  // 报错原文：`batch size is invalid, it should not be larger than 10: input.contents`
  //
  // 为什么必须用**真 HTTP + 真 400** 而不是纯函数：
  //   · 纯函数层永远测不出"调用方把 16 传了进来"（同 `ADR-0028` 的教训）。
  //   · 要测的是"**换参数重发**"这个行为 —— 只有数得清请求次数才证明得了
  //     "没死循环 / 没漏条 / 没重复发"。
  //
  // 断言里的向量按文本编码（`[序号, 1]`）⇒ **顺序错了会当场显形**：重切之后
  // 如果游标算错，最典型的表现就是"条数对得上、但向量配错了人"——那是最坏的一种静默失败。
  const ALIYUN_400 = JSON.stringify({
    error: {
      message: '<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, '
        + 'it should not be larger than 10.: input.contents',
      type: 'InvalidParameter',
      code: 'InvalidParameter'
    }
  });
  const seen = [];
  const cap = 10;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      const input = Array.isArray(p.input) ? p.input : [p.input];
      seen.push(input.length);
      if (input.length > cap) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ALIYUN_400);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: input.map((t, i) => ({ index: i, embedding: [Number(String(t).replace(/\D/g, '')), 1] }))
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ep = { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', retries: 0 };

  // ① 开箱路径（什么都不配）+ 16 条 ⇒ **第一发就是 10，一次都不被拒**。
  //    这条才是本次事故的修复点：默认值 16 时这里会是 `16(400) → 10 → 6`。
  seen.length = 0;
  try {
    const r = await embedTexts(Array.from({ length: 16 }, (_, i) => `t${i}`), ep);
    ok(seen.join(',') === '10,6' && r.batches === 2 && r.batchLimit === 0,
      '默认值(10) 下 16 条**一发就过**，没有任何试错请求（开箱即通＝默认值的职责）',
      `(${seen.join(' → ')})`);
  } catch (e) {
    ok(false, '默认值下一发就过', `（抛错：${e?.message?.slice(0, 80)}）`);
  }

  // ② 模拟"旧配置 / 用户手填 16"（事故现场的真实参数）⇒ 必须自己降批把这一片救回来
  seen.length = 0;
  const logs = [];
  try {
    const r = await embedTexts(Array.from({ length: 16 }, (_, i) => `t${i}`),
      { ...ep, batchSize: 16, log: (m) => logs.push(m) });
    ok(r.vectors.length === 16, '端点拒收 16 条时**全部 16 条仍然拿到向量**（不是抛错收场）', `(得 ${r.vectors.length})`);
    ok(seen[0] === 16 && seen.slice(1).join(',') === '10,6',
      '请求序列 = 撞一次 16 ⇒ 改小后 10 / 6（**换参数重发同一片**，不是同参数重试）', `(${seen.join(' → ')})`);
    ok(r.batches === 2, '批次数只数**成功**的那些（被拒的那发不算批）', `(batches=${r.batches})`);
    ok(r.batchLimit === 10, '把端点探到的上限回报给调用方（调用方据此不再逐片试错）', `(batchLimit=${r.batchLimit})`);
    ok(logs.some((m) => /最多收 10 条/.test(m)), '降批这件事必须**说出来**（日志里点名上限，用户能据此去改设置）',
      `(${logs.filter((m) => /最多收/.test(m)).length} 条日志)`);
    // 顺序 / 对齐：重切之后最容易错的就是这个
    const aligned = r.vectors.every((v, i) => v[0] === i && v[1] === 1);
    ok(aligned, '重切后向量与文本**一一对齐**（游标算错会表现为"条数对、配错人"）',
      `(前 3 条 = ${r.vectors.slice(0, 3).map((v) => v[0]).join(',')}…)`);
    ok(r.dim === 2, '维度仍然校验并带回', `(dim=${r.dim})`);
  } catch (e) {
    ok(false, '端点拒收 16 条时能自己降批跑通', `（抛错：${e?.code || ''} ${e?.message?.slice(0, 80)}）`);
  }

  // ③ 显式设成 10 ⇒ 与默认同形（面板里手填的值必须**被尊重**，而不是被"默认值"顶掉）
  seen.length = 0;
  try {
    const r = await embedTexts(Array.from({ length: 16 }, (_, i) => `t${i}`), { ...ep, batchSize: 10 });
    ok(seen.join(',') === '10,6' && r.batches === 2 && r.batchLimit === 0,
      '显式 10 与默认 10 同形（手填的值不被默认值顶掉）', `(${seen.join(' → ')})`);
  } catch (e) {
    ok(false, '显式 10 条一批能直接跑通', `（抛错：${e?.message?.slice(0, 80)}）`);
  }

  // ④ 端点上限 ≥ 实际片长 ⇒ **不许瞎降批**：那不是"这批太大"，降了也救不了
  //    （真病因是别的：Key / 配额 / 模型名），还会多打两发把真错误淹掉。
  //    判据必须是**这一片实际发了几条**，不是配置里的 batchSize —— 末片常比 batchSize 短。
  seen.length = 0;
  let notBatch = null;
  const srvSmall = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push((JSON.parse(body || '{}').input || []).length);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(ALIYUN_400);   // 它说上限 10，而我们只发了 3 条
    });
  });
  await new Promise((r) => srvSmall.listen(0, '127.0.0.1', r));
  try {
    await embedTexts(['a', 'b', 'c'], { baseURL: `http://127.0.0.1:${srvSmall.address().port}`, model: 'm', retries: 2 });
  } catch (e) { notBatch = e; }
  srvSmall.close();
  ok(notBatch?.code === 'HTTP_ERROR' && seen.length === 1,
    '端点上限(10) ≥ 实际片长(3) 时**不降批**（降了也白降，还掩盖真病因）', `(请求 ${seen.length} 次, ${notBatch?.code})`);

  // ⑤ 降到底还被拒 ⇒ 必须抛出，**不能死循环**（上限 1 而端点连 1 条也拒）
  seen.length = 0;
  let stuck = null;
  const srv1 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push((JSON.parse(body || '{}').input || []).length);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'input.contents: it should not be larger than 1.' } }));
    });
  });
  await new Promise((r) => srv1.listen(0, '127.0.0.1', r));
  try {
    await embedTexts(Array.from({ length: 8 }, (_, i) => `t${i}`), { baseURL: `http://127.0.0.1:${srv1.address().port}`, model: 'm', retries: 0 });
  } catch (e) { stuck = e; }
  srv1.close();
  ok(stuck?.code === 'HTTP_ERROR' && seen.join(',') === '8,1',
    '降到端点说的 1 条仍被拒 ⇒ 抛出，不死循环（终止性：批大小严格递减 + 下界闸门）',
    `(${seen.join(' → ')} ⇒ ${stuck?.code})`);

  srv.close();

  // ⑥ 纯函数层：措辞识别与"0 = 未设"
  ok(parseBatchLimit(ALIYUN_400) === 10, '识别阿里云措辞「should not be larger than 10」', '');
  ok(parseBatchLimit('no more than 32 inputs') === 32, '识别「no more than N」', '');
  ok(parseBatchLimit('Range of input length should be [1, 10]') === 10, '识别区间式「[1, 10]」', '');
  ok(parseBatchLimit('最多 10 条') === 10, '识别中文「最多 N 条」', '');
  ok(parseBatchLimit('invalid api key') === 0, '无关报错**不许瞎认**（返回 0 = 没有可用的判据）', '');
  ok(clampBatchSize(0) === DEFAULT_BATCH_SIZE && clampBatchSize(undefined) === DEFAULT_BATCH_SIZE,
    '`0` / 缺省 = **未设** ⇒ 落默认值（面板 collect() 会把空输入刷成 0，判成"1 条一批"是同一个坑的第三个实例）',
    `(0→${clampBatchSize(0)})`);
  ok(clampBatchSize(999) === 64, '上限夹在代码护栏 64（端点说自己能收更多也不越过）', `(${clampBatchSize(999)})`);
  ok(DEFAULT_BATCH_SIZE === 10, '默认单批 = 10（与面板提示、plugin.json 声明**同一个数字**）', `(${DEFAULT_BATCH_SIZE})`);
}

// ═══════════════════════════════════════════════════════════════════════
head('嵌入客户端 · 两侧非对称 + 出境前自检（ADR-0001 / ADR-0002）');
{
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      seen.push(...(j.input || []));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: (j.input || []).map((_, i) => ({ index: i, embedding: [1, 0, 0] })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const norm = new Normalizer({ secret: 'n'.repeat(40) });
  norm.setVocabulary([{ id: 'qq:3042786385', kind: 'person', surface: ['沫钤'] }]);
  const ep = { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', normalizer: norm };

  // 文档侧：不加前缀
  await embedDocuments([norm.normalize('沫钤：明天换模型了').text], ep);
  ok(seen[0] && !seen[0].startsWith('Instruct:'), '文档侧不加指令前缀', `("${seen[0]}")`);

  // 查询侧：自动加 Instruct（Qwen3 的用法）
  seen.length = 0;
  const q = norm.normalize('她说过换模型的事吗').text;
  await embedQueries([q], { ...ep, instruction: undefined });
  ok(/^Instruct: .*\nQuery:/.test(seen[0] || ''), '查询侧自动加 `Instruct: …\\nQuery:…`', `("${String(seen[0]).slice(0, 46)}…")`);
  ok(seen[0].endsWith(q), '前缀之外，内容本身没有被动过');
  ok(formatQuery('x', 'T') === 'Instruct: T\nQuery:x', 'formatQuery 的形态与官方一致（Query 后不空格）');

  // 出境前自检：给一段带真名的文本 → 拒绝
  let leaked = null;
  try {
    await embedDocuments(['沫钤 你好'], ep);
  } catch (e) { leaked = e; }
  ok(leaked?.code === 'NORMALIZE_LEAK', '未归一化的文本直接送 embedDocuments → 抛 NORMALIZE_LEAK（拒绝出境）', `(${leaked?.code})`);

  // 忘记传归一化器 → 也拒绝
  let noNorm = null;
  try {
    await embedDocuments(['随便什么'], { baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' });
  } catch (e) { noNorm = e; }
  ok(noNorm?.code === 'UNNORMALIZED_INPUT', '不传归一化器 → 抛 UNNORMALIZED_INPUT（没有"降级发原文"的路）', `(${noNorm?.code})`);

  server.close();
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(64)}`);
console.log(`自检结果：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
