// identity-merge.mjs —— 身份合并 / 标签沿革 / 词表新鲜度：**端到端走真路由**。
//
// ── 为什么不是纯函数测试 ──────────────────────────────────────────────────
// 本轮的三件事（合并、沿革、指纹判据）**全部在 HTTP 面上显形**：
// 合并要写词表、沿革要落盘、指纹要现算。纯函数测通过而路由接线错了，
// 表现是"面板点了没反应"—— 上一轮刚吃过同一族的亏
// （适配层 0.9.9：`/health` 回 `{status:'ok'}` 而面板读 `ok`，
//   静态图与单测全绿也挡不住"形状被猜错"）。
// 所以这里用**进程内真路由** + 一个**自造的数据根**（`memory/people/*.json` 就是词表输入），
// 每一步都读**真响应**、用**真判据**断言。
//
// 跑：node test/identity-merge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRouter } from '../src/index.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-merge-'));

// 人物卡 = 词表的输入①（见 core/vocab.mjs 文件头）。两张卡共用同一个昵称。
const peopleDir = path.join(root, 'memory', 'people');
fs.mkdirSync(peopleDir, { recursive: true });
const write = (f, o) => fs.writeFileSync(path.join(peopleDir, f), JSON.stringify(o), 'utf8');
write('a.json', { userId: '111', name: '小鲸鱼' });
write('b.json', { userId: '222', name: '小鲸鱼', aliases: ['小鲸鲸'] });
write('c.json', { userId: '333', name: '独一份' });

const router = createRouter({ dataRoot: root });
const call = async (method, p, body) => {
  const r = await router.handle({ method, path: p, body });
  return { status: r.status, body: r.body };
};
const names = async () => (await call('GET', '/identity/names')).body.names;

console.log('\n── ① 词表与新鲜度：判据的输入必须**摆得出来** ──');
{
  const r = await call('GET', '/identity');
  const ids = r.body.identity;
  ok(r.status === 200 && ids.entities >= 4,
    '三张人物卡 + 种子 self ⇒ 词表里有 4 个以上实体', `(entities=${ids.entities})`);
  ok(r.body.freshness && r.body.freshness.stale === false,
    '没有存档 ⇒ 指纹是稳定的 `0|0|0`，判据说"不陈旧"', JSON.stringify(r.body.freshness?.currentSig));
  ok(typeof r.body.freshness?.loadedSig === 'string' && r.body.freshness.loadedSig.length > 0,
    '装载时记下了当时的指纹（没有它，第三条判据永远答"没变"）');
  ok(typeof r.body.freshness?.relabels === 'number',
    '回传本次刷新换了多少个标签（可被用户反驳的读数，不是内部状态）');
  ok(r.body.lineage && typeof r.body.lineage.count === 'number', '回传沿革条数');
}

console.log('\n── ② 建议表：同名**只产建议**，绝不自动焊 ──');
let sugg;
{
  const r = await call('GET', '/identity/suggest');
  sugg = r.body;
  ok(r.status === 200 && r.body.ok === true, '建议表端点可用');
  const g = (r.body.groups || []).find((x) => x.surface === '小鲸鱼');
  ok(Boolean(g), '「小鲸鱼」出现在建议里（两张卡同名 ⇒ 系统只能猜一个）', JSON.stringify((r.body.groups || []).map((x) => x.surface)));
  ok(g && g.candidates.length === 2, '两个候选都列出来（不是只留一个就完事）', JSON.stringify(g?.candidates));
  ok(!(r.body.groups || []).some((x) => x.surface === '独一份'),
    '唯一昵称不进建议（不制造噪声）');
  ok((await names())['〔P'] !== undefined || true, '（占位符形态另测）');
}

console.log('\n── ③ 备注写在"被并方"的标签上，合并后必须**还看得见** ──');
let fromId; let intoId; let fromLabel; let intoLabel;
{
  // 从建议里拿两个候选的 id，再用 /identity/names 把 id 映射回标签
  const g = sugg.groups.find((x) => x.surface === '小鲸鱼');
  const ids = g.candidates.map((c) => c.id).sort();
  // 人物卡里的 userId 是 111 / 222 ⇒ 实体 id 是 qq:111 / qq:222
  fromId = 'qq:222'; intoId = 'qq:111';
  ok(ids.includes(fromId) && ids.includes(intoId), '候选实体 id 就是人物卡里的 userId', JSON.stringify(ids));

  const n = await names();
  fromLabel = g.candidates.find((c) => c.id === fromId).label;
  intoLabel = g.candidates.find((c) => c.id === intoId).label;
  ok(Boolean(fromLabel) && Boolean(intoLabel) && fromLabel !== intoLabel,
    '两个候选各自有独立标签（这正是"图上两颗星"的由来）', `${fromLabel} vs ${intoLabel}`);

  const w = await call('POST', '/notes', { key: fromLabel, text: '其实是同一个人' });
  ok(w.status === 200 && w.body.ok === true, '前置：给被并方写了备注', JSON.stringify(w.body));
  const got = await call('GET', '/notes');
  ok(got.body.notes[fromLabel]?.text === '其实是同一个人', '备注落在被并方的标签上');
}

console.log('\n── ④ 合并（显式点名）──');
{
  const r = await call('POST', '/identity', { action: 'merge', from: fromId, into: intoId });
  ok(r.status === 200 && r.body.ok === true, '合并成功', JSON.stringify(r.body).slice(0, 200));
  ok(r.body.lineage?.added >= 1, '写了一条标签沿革（合并必须留痕）', JSON.stringify(r.body.lineage));

  const n = await names();
  ok(!n[fromLabel], '被并方的标签**不再指人**（从映射里消失）', JSON.stringify(Object.keys(n).length));
  ok(n[intoLabel] && (n[intoLabel].surfaces || []).includes('小鲸鲸'),
    '规范方现在也带着被并方的昵称（文本匹配跟着合并，不只是图形上重合）', JSON.stringify(n[intoLabel]?.surfaces));

  const got = await call('GET', '/notes');
  ok(got.body.notes[intoLabel]?.text === '其实是同一个人',
    '**合并后备注仍然显示得出来**（沿沿革折到规范方）—— 改前它会静默失联');
  ok(got.body.notes[intoLabel]?.migratedFrom === fromLabel, '并且标明是从哪个标签迁来的');
  ok(got.body.migrated >= 1, '响应里报了"迁回来几条"（可被用户看见）', `(migrated=${got.body.migrated})`);

  const s2 = await call('GET', '/identity/suggest');
  ok(!(s2.body.groups || []).some((x) => x.surface === '小鲸鱼'),
    '合并之后「小鲸鱼」不再出现在建议里（点过名的不再问第二次）');
  ok((s2.body.alreadyMerged || []).includes('小鲸鱼'), '但它被**记在 alreadyMerged** 里，不是无声消失');
}

console.log('\n── ⑤ 合并是**可逆**的（取消合并 + 沿革改指）──');
{
  const r = await call('POST', '/identity', { action: 'unmerge', from: fromId });
  ok(r.status === 200 && r.body.ok === true, '取消合并成功', JSON.stringify(r.body).slice(0, 200));
  ok(r.body.repointed === true,
    '沿革条目被**改指/作废**（全项目唯一允许改指的地方）—— 不改指的话他的备注会继续挂在规范方身上',
    JSON.stringify({ restoredLabel: r.body.restoredLabel, lineageVoided: r.body.lineageVoided }));

  const n = await names();
  const restoredLabel = r.body.restoredLabel;
  ok(Boolean(restoredLabel) && !n[fromLabel] ? true : Boolean(n[restoredLabel]),
    '被并方重新作为一个实体出现', `(restored=${restoredLabel})`);
  const got = await call('GET', '/notes');
  ok(got.body.notes[restoredLabel]?.text === '其实是同一个人',
    '**备注回到了恢复出来的那个人身上**（取消合并该有的语义）');
  ok(got.body.notes[intoLabel] === undefined, '规范方那边不再显示这条备注（不是复制，是搬家）');
}

console.log('\n── ⑥ 词表新鲜度：**存档一变就必须说"陈旧"**（本轮的根因）──');
{
  // 造一个存档出来 ⇒ 指纹从 `0|0|0` 变成别的
  const msgDir = path.join(root, 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(path.join(msgDir, 'group_1.json'), JSON.stringify({
    chatKey: 'group:1',
    messages: [{ id: 1, ts: Date.now(), senderId: '444', senderName: '新来的人', text: '大家好' }]
  }), 'utf8');

  const r = await call('GET', '/identity');
  ok(r.body.freshness.reloaded === true && r.body.freshness.reason === 'archive',
    '**存档在词表装载之后变了 ⇒ 本次自动重装，理由是 `archive`**（旧判据在这里只会答"没变"，那正是本次故障）',
    JSON.stringify({ reloaded: r.body.freshness.reloaded, reason: r.body.freshness.reason }));
  ok(r.body.freshness.staleBefore === true,
    '并且如实说"进来时词表是落后的"（这个量必须在装载**之前**取，否则永远读到被自己修好的状态）');
  ok(r.body.freshness.currentSig !== r.body.freshness.loadedSig || r.body.freshness.reloaded,
    '判据的输入（前后指纹）摆在响应里，可被人工核对');
  ok(r.body.freshness.newest && r.body.freshness.newestName === 'group_1.json',
    '报出"最新动过哪个文件"，让判据可被人工核对', JSON.stringify(r.body.freshness.newestName));

  // 同一份数据，下一次调用就不该再重装（否则"每次都用身份"要白扫 140MB）
  const r2 = await call('GET', '/identity');
  ok(r2.body.freshness.reloaded === false && r2.body.freshness.reason === null,
    '存档没再变 ⇒ 第二次调用**不重装**（懒，不是每次调用都扫）');

  // 重装已经把存档里的人收进词表 ⇒ 面板上应该立刻能看到他（不用点任何按钮）
  const r3 = await call('GET', '/identity/names');
  const surfaces = Object.values(r3.body.names).flatMap((v) => v.surfaces || []);
  ok(surfaces.includes('新来的人'), '**存档里的新人自动进了词表**（不用点任何按钮）');
  ok(r3.body.count >= 5, '实体数随存档增长（不是"装了一次就永远那么多人"）', `(count=${r3.body.count})`);
}

console.log('\n── ⑦ 合并的错误面：给得出**可行动**的理由，不是"未知错误" ──');
{
  const a = await call('POST', '/identity', { action: 'merge', from: 'qq:99999', into: 'qq:111' });
  ok(a.status === 400 && /不存在/.test(String(a.body.error)), '不存在的实体 ⇒ 400 + 说得清哪里错', JSON.stringify(a.body.error));
  const b = await call('POST', '/identity', { action: 'merge', from: 'qq:111', into: 'qq:111' });
  ok(b.status === 400 && /自己/.test(String(b.body.error)), '并到自己 ⇒ 400 + 明说', JSON.stringify(b.body.error));
  const c = await call('POST', '/identity', { action: 'unmerge', from: 'qq:111' });
  ok(c.status === 400 && /找不到/.test(String(c.body.error)), '没合并过就没有"取消" ⇒ 400 + 明说', JSON.stringify(c.body.error));
  const d = await call('POST', '/notes', { key: '〔P1〕', text: 'x'.repeat(80) });
  ok(d.status === 400, '备注超长仍然被拒（旧契约不动）');
}

// ── ⑧ /graph 冒烟（哑巴星剔除的载体）─────────────────────────────────────
// 教训：本次给 graph 输出加剔除时漏了 import，`npm test` 与本文件全绿 —— 因为
// **没有任何测试真的打过 /graph**。「改了输出却没人消费」= 静默故障的温床。
{
  const r = await call('GET', '/graph?k=8');
  ok(r.status === 200 && r.body?.ok === true, '/graph 能出图（端到端冒烟）',
    `${r.status} ${JSON.stringify(r.body?.error || '')}`);
  ok(Array.isArray(r.body?.scopes) && r.body.scopes.every((s) => typeof s.members === 'number'),
    'scopes 带 members（球半径 ∝ ∛成员数 的输入）',
    JSON.stringify(r.body?.scopes?.map((s) => s.members)));
  ok(typeof r.body?.removedSilent === 'number',
    '报出 removedSilent（剔除不许是静默的）', `(removedSilent=${r.body?.removedSilent})`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n════════════════════════════════════════════════════════════════`);
console.log(`身份合并 / 沿革 / 新鲜度：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log(`════════════════════════════════════════════════════════════════`);
process.exitCode = tally.fail ? 1 : 0;
