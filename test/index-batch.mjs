// test/index-batch.mjs —— 建索引的**分批游标**：端点嫌批太大而自动改小时，
// 游标必须仍然"一条不漏、一条不重"。
//
// ── 为什么必须端到端（不能只测 embedTexts）────────────────────────────────
// `embedTexts` 的单测只能证明"这一片被救回来了"。真正的风险在**上层循环**：
// 它拿到 `batchLimit` 之后会把 batchSize 改小，而这一改动发生在**那一片已经成功
// 嵌完之后** —— 于是 `i += batchSize` 这种写法会让游标**倒退**，把刚嵌过的一段
// **再嵌一遍**。而且它**不报错**：库条数对、覆盖率 100%、面板全绿，只有计费在涨。
// 所以这里的主判据是 `embedded`（次数）而不是 `alive`（条数）—— 突变验证过：
// 把游标改回 `i += batchSize`，只有 `embedded` 与请求序列会红，`alive`/`coverage` 仍绿。
//
// ── 现场对照（2026-10-14）────────────────────────────────────────────────
// 号B（`data-2`）配的是默认 16、端点是阿里云 `text-embedding-v3`（上限 10）⇒
// 建索引第一发就 400，`lastError.where='index'`，整个作业停在 2/16 块上。
// 本用例把那一幕原样搭出来（配置里**故意写 16**），断言它现在能自己跑完。
//
// 跑：node test/index-batch.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { start } from '../src/server.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const N = 16;          // 块数：故意跨过 10 这条线，逼出"16 → 10 → 6"三段
const CAP = 10;        // 假端点的单批上限（= 阿里云 text-embedding-v3 的实测值）

// ── 假嵌入端点：按条数拒收 ──────────────────────────────────────────────
// 报错正文**逐字抄现场**，因为被测的正是"能不能读懂这句话"。
const ALIYUN_400 = JSON.stringify({
  error: {
    message: '<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, '
      + 'it should not be larger than 10.: input.contents',
    type: 'InvalidParameter',
    code: 'InvalidParameter'
  }
});
const sizes = [];      // 每次请求实际发了几条
let rejected = 0;
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const p = JSON.parse(raw || '{}');
    const input = Array.isArray(p.input) ? p.input : [p.input];
    sizes.push(input.length);
    if (input.length > CAP) {
      rejected++;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(ALIYUN_400);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: input.map((_, i) => ({ index: i, embedding: [input.length, 1, 0, 0] }))
    }));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const epPort = endpoint.address().port;

// ── 两个根：库根（服务自持）+ 源根（只读，放块）────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-idx-'));
const libRoot = path.join(tmp, 'lib');
const srcRoot = path.join(tmp, 'host-data');
const chunksDir = path.join(srcRoot, 'memory-v2', 'chunks');
fs.mkdirSync(chunksDir, { recursive: true });
fs.mkdirSync(libRoot, { recursive: true });

// ⚠️ `embedBatchSize: 16` 是**故意的**：默认值现在是 10，但**盘上存过的值压过默认**
// （宿主记忆 §一.9：裸浅合并）。所以"改默认值"救不了已经存过 16 的实例 ——
// 这一段测的正是那种实例。
//
// ⚠️ **两个 config.json 分工不同**（`src/server.mjs:178` 是唯一出处）：
//   · `<库根>/config.json`       = 找得到**源根**（`skills.memory-vec.sourceRoot`）
//   · `<源根>/config.json`       = **真正的设置**（`readSkillConfig(srcRoot, …)`）
// 真实部署里两者分别对应"仓里那本"与"宿主 data 那本" —— 把设置写进库根
// 会静默落到 `DEFAULT_SETTINGS`（本次第一版就踩了，`/status` 显示 10 而不是 16）。
fs.writeFileSync(path.join(libRoot, 'config.json'),
  JSON.stringify({ skills: { 'memory-vec': { sourceRoot: srcRoot } } }), 'utf8');
fs.writeFileSync(path.join(srcRoot, 'config.json'), JSON.stringify({
  skills: {
    'memory-vec': {
      embedBaseURL: `http://127.0.0.1:${epPort}`,
      embedModel: 'fake-embed',
      embedBatchSize: 16,
      embedTimeoutMs: 5000,
      keywordsSource: 'filtered',
      maxChars: 1200,
      withKeywords: true,
      withSummary: true
    }
  }
}), 'utf8');

// 块文件名必须匹配 `parseChunkFileName`（`day_group_<id>_YYYY-MM-DD`），否则 listChunks 不认。
for (let i = 0; i < N; i++) {
  const day = String(i + 1).padStart(2, '0');
  const id = `day_group_10000_2026-01-${day}`;
  fs.writeFileSync(path.join(chunksDir, `${id}.json`), JSON.stringify({
    id,
    chatKey: 'group:10000',
    title: `第 ${i + 1} 天的群聊`,
    summary: `今天群里在聊第 ${i + 1} 件事，说了些有的没的。`
  }), 'utf8');
}

const s = await start({ dataRoot: libRoot, port: 0 });
const post = async (p, body) => {
  const r = await fetch(s.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: r.status, body: await r.json() };
};

try {
  // runtime 构造时会 fire-and-forget 一次 `ensureIdentity`（扫源根重建词表）——
  // 等它结束，免得异步写与断言交错（同 `test/remember.mjs` / `test/inject-endpoint.mjs`）。
  const { getRuntime } = await import('../src/core/backend.mjs');
  const rt = await getRuntime();
  const deadline = Date.now() + 20_000;
  while (!rt.lastIdentityCheck && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('\n── ① 配置里写着 16，端点上限 10 ⇒ 必须自己跑完（不抛 400）──');
  const r1 = await post('/api/vec/index', {});
  ok(r1.status === 200 && r1.body.ok === true,
    '建索引整体成功（修复前：这里直接 400 抛错，作业停在第一片）',
    `(status=${r1.status}, embedded=${r1.body.embedded})`);
  ok(r1.body.scanned === N && r1.body.embedded === N,
    `**既不漏也不重**：${N} 个块恰好嵌 ${N} 次（游标算错 ⇒ 重复 ⇒ 22；**而库条数与覆盖率都看不出来**，突变验证过）`,
    `(scanned=${r1.body.scanned}, embedded=${r1.body.embedded})`);
  ok(sizes[0] === 16 && sizes.slice(1).join(',') === '10,6',
    '请求序列 = 撞一次 16 ⇒ 学到上限后 10 / 6（**只试错一次**，不是每片都撞）',
    `(${sizes.join(' → ')})`);
  ok(rejected === 1,
    '端点一共只拒了 1 次（降批后不再撞 —— 每片都试错说明"学到的东西没被用上"）',
    `(被拒 ${rejected} 次)`);
  ok(r1.body.broken === 0 && r1.body.skipped === 0,
    '没有块被判 broken / skipped（它们是"悄悄不算数"的两个出口）',
    `(broken=${r1.body.broken}, skipped=${r1.body.skipped})`);
  ok(r1.body.alive === N,
    `库里就是 ${N} 条向量（覆盖写 ⇒ "重复嵌"**不会**体现在这里，所以上面那条 embedded 断言才是主判据）`,
    `(alive=${r1.body.alive})`);

  console.log('\n── ② 运行期事实：覆盖满了，且上次错误被清掉 ──');
  const st = await (await fetch(s.url + '/api/vec/status')).json();
  ok(st.embedded === N && st.coverage === 1,
    '覆盖率 100%（这一条是"索引真的成了"的唯一全局判据）',
    `(embedded=${st.embedded}, coverage=${st.coverage})`);
  ok(st.lastError === null, 'lastError 为空（修复前它就挂着那条 400）',
    st.lastError ? String(st.lastError.message).slice(0, 60) : '');
  ok(st.settings?.embedBatchSize === 16,
    '⚠️ 运行期存值仍是 16 —— 服务**不改用户配置**，只在本作业内学会（见下）',
    `(settings.embedBatchSize=${st.settings?.embedBatchSize})`);

  console.log('\n── ③ 学到的上限是**每作业**的，不落盘（如实登记，别假装它会记住）──');
  sizes.length = 0;
  const r2 = await post('/api/vec/index', { force: true });
  ok(r2.body.embedded === N && sizes[0] === 16,
    '重跑会**再撞一次** 16（每作业一次试错的成本，明确接受；落盘需要写宿主配置，不在服务职权内）',
    `(${sizes.join(' → ')})`);
  ok(r2.body.alive === N, '强制重索引后库里仍恰好是 N 条（覆盖写，不累加）', `(alive=${r2.body.alive})`);
} catch (e) {
  ok(false, '端到端跑通（未预期异常）', `（${e?.message}）`);
} finally {
  s.server.close();
  endpoint.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`建索引分批：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
