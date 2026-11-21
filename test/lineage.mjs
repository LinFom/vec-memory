// lineage.mjs —— 标签沿革表：**身份一变，备注不再静默失联**。
//
// ── 这条判据为什么必须存在 ────────────────────────────────────────────────
// `notes.json` 的键是**占位符**（`〔P1234〕` / `X277`），而占位符会变：
//   · 重建词表（新增成员 ⇒ 编号重排；实测 `986 → 1151` 那次挪了一批人的号）
//   · 身份合并（被并方的标签从此不再指人）
// 两种情况下旧键的备注**还在文件里、界面上再也显示不出来**，不报错。
// 这个文件证明"沿革表能把它们救回来"，并钉住几条容易被改坏的规则。
//
// 跑：node test/lineage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendLineage, readLineage, canonicalLabel, foldNotes, lineagePairs, repointLineage, lineagePath
} from '../src/core/lineage.mjs';
import { readNotes, writeNote } from '../src/core/notes.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-lineage-'));

// ── ① 差量：按**实体 id** 对齐，不按标签 ─────────────────────────────────
// 标签正是那个会变的东西，拿它当对齐键就是循环论证。
{
  const before = new Map([['qq:1', 'P100'], ['qq:2', 'X277'], ['qq:3', 'P300']]);
  const after = new Map([['qq:1', 'P100'], ['qq:2', 'P5726'], ['qq:3', 'P301']]);
  const pairs = lineagePairs(before, after);
  ok(pairs.length === 2, '只对**标签变了**的那些产出沿革（没变的不产出噪声）', JSON.stringify(pairs));
  ok(pairs.some((p) => p.from === 'X277' && p.to === 'P5726'),
    '临时标签 → 正式标签 是最该被救的那一类（本次真机故障就是它）', JSON.stringify(pairs));
  ok(lineagePairs(before, new Map([['qq:1', 'P100']])).length === 0,
    '装载后**不见了**的东西不产出沿革（没有落点可指，不猜）');
  ok(lineagePairs(new Map(), after).length === 0, '装载前什么都没有 ⇒ 无从比较，不产出');
}

// ── ② 追加写：同键只记第一条；读回来必须一字不差 ────────────────────────
{
  const r1 = appendLineage(root, [{ from: 'X277', to: 'P5726' }], 'rebuild', '2026-10-11T00:00:00.000Z');
  ok(r1.ok && r1.added === 1, '首次追加写入成功', JSON.stringify(r1));
  // 同键再追加（模拟"又并了一次"）⇒ 必须保留第一条，靠 `to` 接上链
  const r2 = appendLineage(root, [{ from: 'X277', to: 'P9999' }], 'merge', '2026-10-11T01:00:00.000Z');
  ok(r2.ok && r2.added === 0, '同键不覆盖（只记第一条）—— 否则链前面的那节会丢', JSON.stringify(r2));
  const back = readLineage(root);
  ok(back.entries.X277?.to === 'P5726', '读回来是第一条的落点', JSON.stringify(back.entries.X277));
  ok(back.entries.X277?.why === 'rebuild' && back.entries.X277?.at === '2026-10-11T00:00:00.000Z',
    '沿革条目带着"为什么 / 什么时候"（事后可审计）');
  ok(fs.existsSync(lineagePath(root)), '沿革文件落在库根（跟库一起备份）');
  ok(!fs.readdirSync(root).some((f) => f.includes('.tmp-')), '原子写不留下半截文件');
}

// ── ③ 链折叠 + 防环 ──────────────────────────────────────────────────────
{
  appendLineage(root, [{ from: 'P5726', to: 'P1234' }], 'merge');
  const { entries } = readLineage(root);
  ok(canonicalLabel(entries, 'X277') === 'P1234', '沿链折叠到当前标签（X277 → P5726 → P1234）');
  ok(canonicalLabel(entries, 'P1234') === 'P1234', '当前标签折叠到自己（幂等）');
  ok(canonicalLabel(entries, 'P0000') === 'P0000', '查不到的键原样返回（不猜）');
  // 写坏成环：表是磁盘文件，人手工改坏了不能让渲染进死循环
  const cyc = { A: { to: 'B' }, B: { to: 'C' }, C: { to: 'A' } };
  const got = canonicalLabel(cyc, 'A');
  ok(['A', 'B', 'C'].includes(got), '环被 MAX_HOPS 截断（不挂死，也不抛）', got);
  // 自指
  ok(canonicalLabel({ A: { to: 'A' } }, 'A') === 'A', '自指条目不动');
}

// ── ④ 折叠备注：救回来、标记来源、冲突不静默丢 ───────────────────────────
{
  const entries = { X277: { to: 'P1234' } };
  const folded = foldNotes({ X277: { text: '小鲸鱼', updatedAt: 't1' }, P500: { text: '别人', updatedAt: 't2' } }, entries);
  ok(folded.notes.P1234?.text === '小鲸鱼', '换了号的备注**折到当前标签上**（这就是"不再失联"）');
  ok(folded.notes.P1234?.migratedFrom === 'X277', '标明它是从哪个旧键迁来的（可追溯，不假装本来就在）');
  ok(folded.notes.P500?.text === '别人' && !folded.notes.P500.migratedFrom, '没换号的备注原样保留');

  // 冲突：当前标签**已有**备注 ⇒ 它赢，被压掉的那条如实报出来
  const conflict = foldNotes({ X277: { text: '旧的' }, P1234: { text: '新的' } }, entries);
  ok(conflict.notes.P1234.text === '新的', '冲突时当前标签的备注赢（那是最新一次写入的落点）');
  ok(conflict.shadowed.length === 1 && conflict.shadowed[0].from === 'X277',
    '被压掉的那条**如实报出来**，不静默丢弃', JSON.stringify(conflict.shadowed));
}

// ── ⑤ 端到端：这就是本次要修的那个静默故障 ──────────────────────────────
// 场景照抄真机：某人在词表里还不存在 ⇒ 渲染成临时标签 `X277`，你给他写了备注；
// 之后词表重建，他拿到正式标签 `P5726`。**改前：那条备注消失；改后：还在。**
{
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-lineage-e2e-'));
  writeNote(k, 'X277', '大肥鱼');
  const beforeNotes = readNotes(k);
  ok(beforeNotes.notes.X277?.text === '大肥鱼', '前置：备注写在临时标签上');

  // 重建词表 ⇒ 差值进沿革
  appendLineage(k, lineagePairs(new Map([['qq:2', 'X277']]), new Map([['qq:2', 'P5726']])), 'rebuild');

  const lin = readLineage(k);
  const folded = foldNotes(readNotes(k).notes, lin.entries);
  ok(folded.notes.P5726?.text === '大肥鱼',
    '**词表重建后，原来写在临时标签上的备注仍然显示得出来**（改前它会静默消失）');
  ok(readNotes(k).notes.X277?.text === '大肥鱼',
    '原文件**一字未改**（沿革是读取期折叠，不搬键 —— 搬键要先写盘，且冲突时必须打断你）');
  fs.rmSync(k, { recursive: true, force: true });
}

// ── ⑥ 取消合并：沿革**改指**（全项目唯一允许改指的地方）──────────────────
{
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-lineage-un-'));
  appendLineage(k, [{ from: 'P111', to: 'P222' }], 'merge');
  writeNote(k, 'P111', '其实是两个人');
  ok(foldNotes(readNotes(k).notes, readLineage(k).entries).notes.P222?.text === '其实是两个人',
    '前置：合并后备注显示在规范方身上');
  const rep = repointLineage(k, 'P111', 'P333', 'unmerge');
  ok(rep.ok, '取消合并 ⇒ 改指成功', JSON.stringify(rep));
  ok(foldNotes(readNotes(k).notes, readLineage(k).entries).notes.P333?.text === '其实是两个人',
    '改指之后备注**回到恢复出来的那个人身上**（这正是取消合并该有的语义）');
  const miss = repointLineage(k, 'P999', 'P333', 'unmerge');
  ok(miss.ok === false, '改指**只对已存在的条目**开放（不能凭空造沿革）', JSON.stringify(miss));
  fs.rmSync(k, { recursive: true, force: true });
}

// ── ⑦ 真数据（可选）：确认"换过号的人"确实存在，沿革不是空谈 ─────────────
{
  const normDir = process.env.NORM_DIR || path.resolve('data/memory-vec/normalizer');
  const f = path.join(normDir, 'entities.json');
  if (!fs.existsSync(f)) {
    console.log('   （跳）真机 entities.json 不在，跳过真数据一节');
  } else {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ents = Array.isArray(j.entities) ? j.entities : [];
    const eph = Array.isArray(j.ephemeral) ? j.ephemeral : [];
    ok(ents.length > 1, `真机词表有 ${ents.length} 个实体（不是那个"只有种子"的空表）`);
    ok(eph.length > 0,
      `真机有 ${eph.length} 条临时标签 —— 即"当时不在词表里的人确实存在"，沿革要有东西可救`);
    const labeled = ents.filter((e) => e.id && e.label).length;
    ok(labeled > 0, `可算出「实体 id → 标签」对的实体 ${labeled} 个（沿革差量的对齐键在这里）`);
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n════════════════════════════════════════════════════════════════`);
console.log(`标签沿革：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log(`════════════════════════════════════════════════════════════════`);
process.exitCode = tally.fail ? 1 : 0;
