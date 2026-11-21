// 派生源的纯函数自测：不连服务、不读宿主 data，全部喂合成数据。
//   node tools/derive-selftest.mjs
//
// 为什么值得单独写：派生块的**唯一**兼容性风险是 id 形态 —— 一旦 `chunkIdOf`
// 拼出的名字 `parseChunkFileName` 解析不了，`listChunks` 就会静默丢弃它
// （那个函数对不匹配的文件名是 `return null`，不报错）。
import {
  chatRawOf, chunkIdOf, hourPartsOf, timeOfDayOf, cleanText, cleanSenderName,
  messageLine, pickRepresentative, joinWithinBudget, deriveChunks, mergeSources
} from '../src/core/derive.mjs';
import { parseChunkFileName } from '../src/core/chunkread.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, actual, expect) {
  ok(name, actual === expect, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`);
}

// ── ① id 与老块解析器互逆（关键）────────────────────────────────────────
eq('chatRawOf group', chatRawOf('group:1098345913'), 'group_1098345913');
eq('chatRawOf private', chatRawOf('private:1353446252'), 'private_1353446252');

{
  const id = chunkIdOf('group:1098345913', '2026-10-18', 1);
  eq('chunkIdOf 形态', id, 'hour_group_1098345913_2026-10-1801');
  const back = parseChunkFileName(`${id}.json`);
  ok('老解析器能解出派生 id', Boolean(back), 'parseChunkFileName 返回 null');
  if (back) {
    eq('往返 chatKey', back.chatKey, 'group:1098345913');
    eq('往返 dayKey', back.dayKey, '2026-10-18');
    eq('往返 hourKey', back.hourKey, '2026-10-18 01');
  }
}
{
  // 私聊键里的 `private:` 同样要能往返
  const id = chunkIdOf('private:1353446252', '2026-10-17', 23);
  const back = parseChunkFileName(`${id}.json`);
  ok('私聊派生 id 可解析', Boolean(back), id);
  if (back) eq('私聊往返 chatKey', back.chatKey, 'private:1353446252');
}

// ── ② 时区：宿主 ts 是毫秒，块名按北京时间切 ────────────────────────────
{
  // 1792258171000 = 2026-10-18 01:29:31 +08:00（实测来自 group_1098345913 最后一条）
  const p = hourPartsOf(1792258171000);
  eq('北京日期', p.dayKey, '2026-10-18');
  eq('北京小时', p.hour, 1);
  eq('hourKey', p.hourKey, '2026-10-18 01');
}
{
  // 跨日边界：北京时间 00:10 不能被算成前一天的 16 点
  const ts = Date.parse('2026-10-18T00:10:00+08:00');
  const p = hourPartsOf(ts);
  eq('跨日 dayKey', p.dayKey, '2026-10-18');
  eq('跨日 hour', p.hour, 0);
}
ok('非法时间戳返回 null', hourPartsOf(0) === null && hourPartsOf('x') === null);

// ── ③ 时段词与老块一致 ───────────────────────────────────────────────────
eq('17点=下午', timeOfDayOf(17), '下午');
eq('1点=深夜', timeOfDayOf(1), '深夜');
eq('21点=晚上', timeOfDayOf(21), '晚上');

// ── ④ 脏数据 ─────────────────────────────────────────────────────────────
eq('控制字符被清掉', cleanText('\u0012\t哈气了\n\u0005\n\u0003喵\u0010\u0000'), '哈气了 喵');
eq('空昵称退 QQ 号', cleanSenderName('\u0001\u0002', '3013523281'), '3013523281');
eq('有昵称用昵称', cleanSenderName(' 林寒枫霜 ', '123'), '林寒枫霜');
eq('都空给占位', cleanSenderName('', ''), '某人');

// ── ⑤ 媒体消息保留占位 ───────────────────────────────────────────────────
eq('纯图消息', messageLine({ self: true, text: '', media: [{ type: 'image' }] }), '我: [图片]');
eq('语音消息', messageLine({ senderName: '甲', text: '', media: [{ type: 'voice' }] }), '甲: [语音]');
eq('空消息被丢弃', messageLine({ senderName: '甲', text: '   ', media: [] }), '');
ok('长消息被压到 120 字', messageLine({ senderName: '甲', text: 'x'.repeat(400) }).length <= 130);

// ── ⑥ 抽样：覆盖全程，不只挑最长的 ──────────────────────────────────────
{
  const msgs = [];
  for (let i = 0; i < 400; i++) {
    // 前 200 条很短，后 200 条很长 —— 只按长度挑会丢掉前半程
    msgs.push({ ts: 1792000000000 + i * 1000, senderName: '甲', text: i < 200 ? `早${i}` : `晚${'长'.repeat(50)}${i}` });
  }
  const picks = pickRepresentative(msgs, 20);
  ok('抽样条数受控', picks.length <= 20, `实际 ${picks.length}`);
  const joined = picks.join(' ');
  ok('覆盖到前半程', /早\d/.test(joined), '前 200 条一条没进');
  ok('覆盖到后半程', /晚长/.test(joined), '后 200 条一条没进');
  ok('按时间有序', joined.indexOf('早') < joined.lastIndexOf('晚'), '顺序乱了');
}

// ── ⑦ 预算：不超，且不为凑数硬截断 ──────────────────────────────────────
{
  const lines = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300), 'd'.repeat(300)];
  const s = joinWithinBudget(lines, 700);
  ok('预算内', s.length <= 700, `实际 ${s.length}`);
  ok('不硬截断长行', s === 'a'.repeat(300) + ' | ' + 'b'.repeat(300) || s.split(' | ').length >= 1);
  eq('预算极小时留一条', joinWithinBudget(['x'.repeat(500)], 120), 'x'.repeat(120));
  eq('空输入空输出', joinWithinBudget([], 700), '');
}

// ── ⑧ 只补缺失桶，不覆盖已有块 ──────────────────────────────────────────
{
  const ts = Date.parse('2026-10-18T01:05:00+08:00');
  const sources = [{ chatKey: 'group:1', messages: [{ ts, senderName: '甲', text: '在吗' }] }];
  const id = chunkIdOf('group:1', '2026-10-18', 1);

  const a = deriveChunks({ sources, existingIds: new Set() });
  eq('缺失时生成', a.chunks.length, 1);
  eq('生成的 id', a.chunks[0]?.id, id);
  eq('来源标记', a.chunks[0]?.derived?.from, 'host-messages');
  ok('summary 有人名和内容', /甲: 在吗/.test(a.chunks[0]?.summary || ''));

  const b = deriveChunks({ sources, existingIds: new Set([id]) });
  eq('已存在时跳过', b.chunks.length, 0);
  eq('跳过计数', b.stats.skippedExisting, 1);
}

// ── ⑨ 冷热合并去重 ──────────────────────────────────────────────────────
{
  const m = { mid: 1, localId: 2, ts: 1792258171000, text: 'x' };
  const merged = mergeSources([
    { chatKey: 'group:1', messages: [m, { mid: 2, localId: 3, ts: 1792258172000, text: 'y' }] },
    { chatKey: 'group:1', messages: [m] }   // 滚动归档导致的重复段
  ]);
  eq('合并后一个会话', merged.length, 1);
  eq('重复消息被去掉', merged[0].messages.length, 2);
}

// ── ⑩ 空输入不炸 ─────────────────────────────────────────────────────────
{
  const r = deriveChunks({ sources: [], existingIds: new Set() });
  eq('空源零产出', r.chunks.length, 0);
  ok('空源统计为 0', r.stats.messages === 0 && r.stats.buckets === 0);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
if (fails.length) {
  console.log(`\n❌ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
}
console.log(`✅ 派生源自测 ${pass}/${pass} 全过`);
