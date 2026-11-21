// 备注（`src/core/notes.mjs`）单测 —— 它是星图显示名的本机资产，读写口径必须钉住。
//
// 为什么值得单测：备注是**用户手写的、唯一的"命名"入口**（群名在存档里根本没有来源）。
// 它一旦静默写坏（半截文件、键被当成正文、长度失控），表现是"我写的名字自己没了"——
// 而那时用户只会以为是自己点错。所以这里把边界全钉一遍。
//
// 运行：node test/notes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNotes, writeNote, notesPath, isValidNoteKey, NOTE_MAX_CHARS } from '../src/core/notes.mjs';
import { ok, tally } from './lib/_helpers.mjs';


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-notes-'));

console.log('\n── ① 空态与写入 ───────────────────────────────────');
{
  const r0 = readNotes(root);
  ok(r0.ok === true && Object.keys(r0.notes).length === 0, '文件不存在 ⇒ 空表且不抛');

  const w = writeNote(root, '〔P1234〕', '小鲸鱼');
  ok(w.ok === true && w.text === '小鲸鱼' && w.count === 1, '写入一条');
  const r1 = readNotes(root);
  ok(r1.notes['〔P1234〕']?.text === '小鲸鱼', '读得回来');
  ok(Boolean(r1.notes['〔P1234〕'].updatedAt), '带上了写入时间');

  writeNote(root, 'group:C6898', '主群');
  const r2 = readNotes(root);
  ok(Object.keys(r2.notes).length === 2, '群标签也能当键（群没有真名来源，备注是唯一命名入口）');

  // 排序写盘 ⇒ 文件 diff 稳定（每次写不会因为键顺序乱跳）
  // ⚠️ 这里**必须删文件**而不是写空串：写空串会让下一次读解析失败 ⇒ 写入被正确拒绝
  //    （那正是下面 ④ 要验的行为），这个用例就测不到排序了。
  fs.rmSync(notesPath(root), { force: true });
  writeNote(root, 'b', 'B');
  writeNote(root, 'a', 'A');
  const raw = fs.readFileSync(notesPath(root), 'utf8');
  ok(raw.indexOf('"a"') < raw.indexOf('"b"'), '键按字典序落盘（文件 diff 稳定）');
}

console.log('\n── ② 覆盖 / 删除 ──────────────────────────────────');
{
  writeNote(root, '〔P1234〕', '新名字');
  const r = readNotes(root);
  ok(r.notes['〔P1234〕'].text === '新名字' && Object.keys(r.notes).length === 3, '重复写 = **覆盖**（不是追加一条流水）');
  const d = writeNote(root, '〔P1234〕', '');
  ok(d.ok === true && d.removed === true, '空串 = 删除');
  ok(readNotes(root).notes['〔P1234〕'] === undefined, '删掉了');
  const d2 = writeNote(root, '从来没写过的键', '');
  ok(d2.ok === true && d2.removed === true, '删一个不存在的键 ⇒ 也算成功（幂等，不报错）');
}

console.log('\n── ③ 边界：拒绝而不是静默截断 ─────────────────────');
{
  ok(writeNote(root, '', 'x').ok === false, '空键 ⇒ 拒绝');
  ok(writeNote(root, 'a\u0000b', 'x').ok === false, '含控制字符的键 ⇒ 拒绝');
  ok(writeNote(root, 'k'.repeat(200), 'x').ok === false, '超长键 ⇒ 拒绝');
  ok(writeNote(root, 'ok-key', 'x'.repeat(NOTE_MAX_CHARS + 1)).ok === false, `超长备注 ⇒ 拒绝（上限 ${NOTE_MAX_CHARS} 字）`);
  ok(writeNote(root, 'ok-key', 'x'.repeat(NOTE_MAX_CHARS)).ok === true, '刚好到上限 ⇒ 通过');
  ok(writeNote(root, 'ok-key', '第一行\n第二行').ok === false, '备注不能含换行（它是显示名，会盖满星图）');
  ok(writeNote(root, 'ok-key', '  留白  ').ok === true, '两端空白被裁掉（不留看不见的空格）');
  ok(readNotes(root).notes['ok-key'].text === '留白', '裁掉的是真的空白');
  ok(isValidNoteKey('〔P1〕') === true && isValidNoteKey('') === false, 'isValidNoteKey 口径一致');
}

console.log('\n── ④ 坏文件不许连累读取 ───────────────────────────');
{
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-notes-bad-'));
  fs.writeFileSync(notesPath(bad), '{这不是 JSON', 'utf8');
  const r = readNotes(bad);
  ok(r.ok === false && Object.keys(r.notes).length === 0, '半截/坏 JSON ⇒ 报错但回空表（不抛）');
  // ⚠️ 关键：读不出旧内容时**必须拒绝写入**。否则一次读失败就会把用户写过的全部名字抹掉。
  const w = writeNote(bad, 'x', 'y');
  ok(w.ok === false && /读旧备注失败/.test(w.error || ''), '读不到旧内容 ⇒ **拒绝写**（宁可写不进，也不能把旧名字抹掉）');
  fs.writeFileSync(notesPath(bad), JSON.stringify({ z: { text: 12345 } }), 'utf8');
  const r2 = readNotes(bad);
  ok(r2.notes.z?.text === '12345', '值不是字符串时强转（不因为一条脏数据丢掉整张表）');
  fs.writeFileSync(notesPath(bad), JSON.stringify({ '': { text: 'x' }, good: { text: 'y' } }), 'utf8');
  ok(Object.keys(readNotes(bad).notes).join() === 'good', '非法键被过滤掉，合法键照常读');
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${'═'.repeat(64)}`);
console.log(`备注读写：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail === 0 ? 0 : 1);
