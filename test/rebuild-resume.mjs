// test/rebuild-resume.mjs —— 新代重建：**能中断、能续跑、不重复花钱**。
//
// ── 这个用例存在的唯一理由 ────────────────────────────────────────────────
// 用户的原话（2026-10-29）："我不确定我的余额够不够全量重跑，如果跑一半没余额了
// 打标记，以免我重新充值后把已经跑过的也跑了。"
//
// 所以主判据**不是**"最后库里有多少条"，而是：
//   ① 额度中断后**不留切换指针**（旧库继续服务，不能半成品上线）；
//   ② 中断点**落在盘上**（`rebuild-job.json` 能查到跑到哪、为什么停）；
//   ③ 续跑时**已写入的条目一条都不再发**（看假端点收到的文本，不看库条数 ——
//      重复嵌不会改变库条数，只会让计费翻倍，这正是最容易被漏掉的一类）。
//
// 另外顺带钉住两件与"重建"强耦合的事实：
//   ④ 新代从**空目录**开始（不再拿被截到 400 字的 `meta.text` 复制旧向量）；
//   ⑤ 单条被出境闸门拒绝**不再拖垮整轮**（P1）：它既不进库，也不阻止切代。
//
// 跑：node test/rebuild-resume.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { start } from '../src/server.mjs';
import { VecStore } from '../src/core/vecstore.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const N = 12;      // 块总数
const BATCH = 10;  // 单批条数：12 条 ⇒ 两批（10 + 2），第二批发 402 正好落在"跑了一半"
const DIM = 4;

// ── 假嵌入端点 ────────────────────────────────────────────────────────────
// `mode` 由用例切换：'ok' 正常；'quota' 第 2 次请求返回 402（余额不足的现场长相）。
// `calls` 记录**每次请求实际发出去的文本**，续跑断言全靠它。
let mode = 'ok';
let calls = [];
let quotaHit = 0;
/** 端点**成功返回**过的文本。续跑断言只比这个集合 —— 402 那批虽然"发出去过"，
 *  但没有写入库里，续跑当然要重发；把它算成"重复"是断言写错了，不是代码错了。 */
const okSent = new Set();
const QUOTA_BODY = JSON.stringify({
  error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' }
});
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
    const input = Array.isArray(p.input) ? p.input : [p.input];
    calls.push(input.map(String));
    if (mode === 'quota' && calls.length >= 2) {
      quotaHit++;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(QUOTA_BODY);
      return;
    }
    for (const t of input) okSent.add(String(t));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: input.map((_, i) => ({ index: i, embedding: [1 + i / 100, 0.5, 0.25, 1] }))
    }));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const epPort = endpoint.address().port;

// ── 两个根（同 test/index-batch.mjs：库根放 sourceRoot，源根放真正的设置）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-rb-'));
const libRoot = path.join(tmp, 'lib');
const srcRoot = path.join(tmp, 'host-data');
const chunksDir = path.join(srcRoot, 'memory-v2', 'chunks');
fs.mkdirSync(chunksDir, { recursive: true });
fs.mkdirSync(path.join(libRoot, 'memory-vec'), { recursive: true });

fs.writeFileSync(path.join(libRoot, 'config.json'),
  JSON.stringify({ skills: { 'memory-vec': { sourceRoot: srcRoot } } }), 'utf8');
fs.writeFileSync(path.join(srcRoot, 'config.json'), JSON.stringify({
  skills: {
    'memory-vec': {
      embedBaseURL: `http://127.0.0.1:${epPort}`,
      embedModel: 'fake-embed',
      embedDimensions: String(DIM),
      embedBatchSize: BATCH,
      embedTimeoutMs: 5000,
      keywordsSource: 'filtered',
      maxChars: 1200,
      withKeywords: true,
      withSummary: true
    }
  }
}), 'utf8');

// 块：内容全部是"可出境"的普通文本（这个用例要验的是续跑，不是闸门）。
// 闸门那条单独用 `partitionBySafety` 单测钉住 —— 造一条"必定被拒"的真实样本
// 需要一套词表/对齐层的现场，造出来的东西比被测逻辑还复杂，反而不可信。
const IDS = [];
for (let i = 0; i < N; i++) {
  const day = String(i + 1).padStart(2, '0');
  const id = `day_group_10000_2026-01-${day}`;
  IDS.push(id);
  fs.writeFileSync(path.join(chunksDir, `${id}.json`), JSON.stringify({
    id,
    chatKey: 'group:10000',
    title: `第 ${i + 1} 天的群聊`,
    summary: `今天群里在聊第 ${i + 1} 件事，说了些有的没的。`
  }), 'utf8');
}

const libDir = path.join(libRoot, 'memory-vec');
const jobFile = path.join(libDir, 'rebuild-job.json');
const pointer = path.join(libDir, 'vector-active.json');
const readJob = () => { try { return JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { return null; } };
const genDirOf = (g) => path.join(libDir, 'vector-generations', g);
const aliveIds = (dir) => {
  const rows = fs.readFileSync(path.join(dir, 'meta.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && m.state === 'alive');
  return { rows: rows.length, unique: new Set(rows.map((m) => m.id)).size, ids: rows.map((m) => m.id) };
};

// ── 造一个"旧布局"的库：**没有 encoding 字段** ────────────────────────────
// 触发条件就是它：`assertQueryCompatibility` 见 `count > 0` 且 `index.encoding` 为空
// ⇒ `ENCODING_MISMATCH` ⇒ 走新代。这也是两个真实库当前的样子（盘点 §3.1 / §4.1）。
{
  const legacy = new VecStore(libDir, { model: 'fake-embed' });
  legacy.put({ id: IDS[0], model: 'fake-embed', vector: new Array(DIM).fill(0.5), meta: { title: '旧向量', text: '旧向量', when: 1, sourceHash: 'deadbeef' } });
  ok(!JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8')).encoding,
    '旧库确实没有 encoding 字段（这正是触发"建新代"的条件，不是我们手工设的开关）',
    `(count=${legacy.count})`);
}

const s = await start({ dataRoot: libRoot, port: 0 });
const post = async (p, body) => {
  const r = await fetch(s.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: r.status, body: parsed };
};

try {
  // runtime 构造时会 fire-and-forget 一次 ensureIdentity，等它结束再动
  const { getRuntime } = await import('../src/core/backend.mjs');
  const rt = await getRuntime();
  const deadline = Date.now() + 20_000;
  while (!rt.lastIdentityCheck && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  console.log('\n── ① 第一批成功，第二批撞 402：必须"停在原地"而不是"整轮失败" ──');
  mode = 'quota';
  calls = [];
  const r1 = await post('/api/vec/index', {});
  const job1 = readJob();
  ok(r1.body?.ok !== true, '这一轮**没有**报告成功（余额不足必须让用户看见，不能静默收尾）',
    `(status=${r1.status})`);
  ok(job1 && job1.status === 'paused-quota',
    '作业被标成 `paused-quota`（而不是 failed）——"可续跑的中断"和"代码坏了"必须分得开',
    `(status=${job1?.status})`);
  ok(job1?.embedded === BATCH && job1?.done === BATCH,
    `停在第 ${BATCH} 条：**只丢了没写的那一批**，已写入的 ${BATCH} 条不重来`,
    `(embedded=${job1?.embedded}, done=${job1?.done}, total=${job1?.total})`);
  ok(!fs.existsSync(pointer),
    '**没有** `vector-active.json`：半成品绝不切代（旧库继续对外服务）');
  ok(quotaHit === 1, '402 只被打了 1 次（额度错误不重试 —— 重试只是再打一笔注定失败的请求）',
    `(quotaHit=${quotaHit})`);

  const gen = job1?.generation;
  ok(/^[a-f0-9]{32}$/.test(String(gen || '')), '作业里钉住了代目录名（`updatedAt` 变了也不会丢进度）', `(${gen})`);
  const part1 = aliveIds(genDirOf(gen));
  ok(part1.rows === BATCH && part1.unique === BATCH,
    `新代里确实是 ${BATCH} 条、且没有重复行（每 id 一条）`,
    `(rows=${part1.rows}, unique=${part1.unique})`);

  console.log('\n── ② 充值后重跑：已写入的条目**一条都不再发** ──');
  mode = 'ok';
  const writtenFirst = new Set(okSent);   // 第一轮**成功写入**的文本
  calls = [];
  okSent.clear();
  const r2 = await post('/api/vec/index', {});
  const resent = calls.flat().filter((t) => writtenFirst.has(t));
  ok(r2.body?.ok === true, '续跑这一轮跑完了（不需要人工重置任何东西）', `(status=${r2.status})`);
  ok(calls.length > 0 && resent.length === 0,
    `续跑只发了剩下 ${N - BATCH} 条：**0 条重复**（重复不改变库条数，只让计费翻倍）`,
    `(本轮请求数=${calls.length}, 总发送=${calls.flat().length}, 重复=${resent.length})`);
  ok(r2.body.rebuilding === true,
    '返回值里带 `rebuilding=true`（前端/工具可以据此提示"这是新代，不是普通增量"）',
    `(rebuilding=${r2.body.rebuilding})`);
  ok(r2.body.resumed === true, '返回值标明这是**续跑**（resumed）而非从零开始', `(resumed=${r2.body.resumed})`);

  console.log('\n── ③ 闸门分流（P1）：拒一条 ≠ 整轮失败，且不许串位 ──');
  // 用假归一化器，因为这里要验的是**分流与下标映射**，不是词表准不准。
  // 下标映射是这一步最危险的地方：被剔掉的条目会让 `vectors[k]` 与 `slice[k]` 错位，
  // 结果是"向量写进了别人的 id"，而条数、覆盖率**全都正常**，没有一个字报错。
  const { partitionBySafety } = await import('../src/core/embed.mjs');
  const fakeNorm = { findLeak: (t) => (String(t).includes('LEAK') ? { term: 'LEAK', layer: 'test' } : null) };
  const part = partitionBySafety(['a', 'LEAK b', 'c', 'LEAK d', 'e'], fakeNorm);
  ok(part.clean.length === 3 && part.rejected.length === 2,
    '5 条里 2 条被拒 ⇒ 干净的 3 条照发、脏的 2 条单独记账（不是整批作废）',
    `(clean=${part.clean.length}, rejected=${part.rejected.length})`);
  ok(part.clean.map((c) => c.index).join(',') === '0,2,4' && part.rejected.map((r) => r.index).join(',') === '1,3',
    '**原下标**一并带回来：`clean[1]` 是原第 2 条，不是第 1 条（错位就会把向量写进别人的 id）',
    `(clean=[${part.clean.map((c) => c.index)}], rejected=[${part.rejected.map((r) => r.index)}])`);
  ok(part.rejected.every((r) => r.code === 'NORMALIZE_LEAK' && r.term === 'LEAK'),
    '被拒原因原样带出（能据此去补词表，而不是只看到"失败"）',
    `(${part.rejected[0]?.code}/${part.rejected[0]?.term})`);
  ok(r2.body.rejected === 0 && r2.body.unreadable === 0,
    '这批样本全部可出境 ⇒ `rejected=0, unreadable=0`（两个字段都在，口径可分辨）',
    `(rejected=${r2.body.rejected}, unreadable=${r2.body.unreadable})`);

  console.log('\n── ④ 切代后的账：新代干净、旧代原样保留 ──');
  const ptr = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  ok(ptr.generation === gen, '切换指针指向的就是这个作业的代（续跑前后是同一个代目录，没有换名重来）');
  const fin = aliveIds(genDirOf(gen));
  ok(fin.rows === N && fin.unique === N,
    `新代 ${N} 条、零重复行（旧库那 296/358 行"复活"的旧版本不会被搬过来）`,
    `(rows=${fin.rows}, unique=${fin.unique})`);
  const legacyIdx = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
  ok(legacyIdx.slots === 1 && fs.existsSync(path.join(libDir, 'vectors.bin')),
    '旧布局文件（`vectors.bin`/`meta.jsonl`）原样还在：回退不需要"用旧整库覆盖"',
    `(旧库 slots=${legacyIdx.slots}, alive=${legacyIdx.alive})`);
  const job2 = readJob();
  ok(job2?.status === 'published' && job2?.generation === gen,
    '作业收尾写成 `published`（下次启动不会再把它当"未完成任务"去续）',
    `(status=${job2?.status})`);
  ok(job2?.embedded === N && job2?.done === N,
    `发布后计数**不被清零**，且是累计口径（${BATCH} + ${N - BATCH} = ${N}）—— ` +
    '`publish()` 会再走一遍建代逻辑，计数器不继承就会显示"嵌入了 0 条"',
    `(embedded=${job2?.embedded}, done=${job2?.done}, total=${job2?.total})`);

  console.log('\n── ⑤ 已切换后再点索引：不再新建代，走普通增量 ──');
  calls = [];
  const r3 = await post('/api/vec/index', {});
  ok(r3.body?.ok === true && r3.body?.rebuilding === false,
    '编码身份已一致 ⇒ `prepareVectorGeneration` 返回旧 store，`rebuilding=false`',
    `(rebuilding=${r3.body?.rebuilding})`);
  ok(r3.body?.embedded === 0 && calls.length === 0,
    '没有新内容 ⇒ 0 次调用（幂等：重复点按钮不烧钱）',
    `(embedded=${r3.body?.embedded})`);
} catch (e) {
  ok(false, '端到端跑通（未预期异常）', `（${e?.message}）`);
} finally {
  s.server.close();
  endpoint.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`新代重建续跑：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
