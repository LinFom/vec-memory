// 备注（notes）—— 用户给星图上的星/星系起的**显示名**。
//
// ── 它是什么、不是什么 ──────────────────────────────────────────────────
// 是：一张 `占位符 → 你写的短名` 的对照表，**纯本机资产**，跟着库一起备份。
//     星图渲染时优先显示备注，其次显示从词表反查到的昵称，最后才退回占位符。
// 不是：**别名**（`CONTEXT.md` 的 _Avoid_ 已钉死）。别名进词表、参与归一化，
//     会改变出境文本与 `sourceHash`；备注只在渲染期用，**永不进词表**（`ADR-0010`）。
//
// ── 为什么键是占位符 ────────────────────────────────────────────────────
// 键跟星图数据同一套身份（占位符），所以这张表即使被导出，也不含明文 QQ / 群号。
// 值才是真名 —— 而真名本来就在你的本机词表里。
//
// ── 口径（写在代码里，不留给读者猜）────────────────────────────────────
// · 一个键一条备注，重复写 **覆盖**（不是 append）—— 这是"改名字"，不是"记流水"。
// · 空字符串 = **删除**该备注。
// · 原子写：先写 `.tmp` 再 `rename`，半截文件不会覆盖旧的好文件。
import fs from 'node:fs';
import path from 'node:path';

/** 备注文件固定落在**库根**（= `dataDir()`），跟库一起备份、一起搬。 */
export const NOTES_FILE = 'notes.json';

/** 备注长度上限：它是**显示名**，不是小作文。超长会让星图上盖满字。 */
export const NOTE_MAX_CHARS = 40;

/** 键长度上限（占位符形如 `〔P1234〕` / `group:C1234`，正常远小于此）。 */
const KEY_MAX_CHARS = 120;

export function notesPath(root) {
  return path.join(path.resolve(root), NOTES_FILE);
}

/** 键合法性：非空、长度合理、无控制字符。非法键**拒绝**，不静默截断。 */
export function isValidNoteKey(key) {
  const k = String(key ?? '');
  if (!k || k.length > KEY_MAX_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(k)) return false;
  return true;
}

/** 读全部备注。文件不存在 / 读坏 ⇒ 返回空表（**不抛**：读不到备注不该让星图挂掉）。 */
export function readNotes(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesPath(root), 'utf8'));
    const src = raw && typeof raw === 'object' ? raw : {};
    /** @type {Record<string, {text:string, updatedAt:string}>} */
    const notes = {};
    for (const [k, v] of Object.entries(src)) {
      if (!isValidNoteKey(k)) continue;
      const text = typeof v === 'string' ? v : String(v?.text ?? '');
      if (!text) continue;
      notes[k] = { text, updatedAt: v?.updatedAt ? String(v.updatedAt) : '' };
    }
    return { ok: true, notes };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, notes: {} };
    return { ok: false, notes: {}, error: String(err?.message ?? err) };
  }
}

/**
 * 写一条备注。
 * @param {string} root 库根
 * @param {string} key  占位符（或任何稳定键）
 * @param {string} text 新显示名；空串 = 删除
 * @param {string} [at] 时间戳（测试注入口）
 */
export function writeNote(root, key, text, at = '') {
  if (!isValidNoteKey(key)) return { ok: false, error: '备注键非法（空 / 过长 / 含控制字符）' };
  const t = String(text ?? '').trim();
  if (t.length > NOTE_MAX_CHARS) return { ok: false, error: `备注最多 ${NOTE_MAX_CHARS} 字（它是显示名，不是小作文）` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return { ok: false, error: '备注不能含控制字符（换行也不行）' };

  const dir = path.resolve(root);
  const { ok, notes, error } = readNotes(dir);
  if (!ok) return { ok: false, error: `读旧备注失败，为免覆盖已放弃本次写入：${error}` };

  if (t) notes[key] = { text: t, updatedAt: at || new Date().toISOString() };
  else delete notes[key];

  const target = notesPath(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    // 排序写盘 ⇒ 文件 diff 稳定（每次写不会因为键顺序乱跳）
    const ordered = {};
    for (const k of Object.keys(notes).sort()) ordered[k] = notes[k];
    fs.writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);   // 原子替换：半截文件不会覆盖旧的好文件
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true, key, text: t, removed: !t, count: Object.keys(notes).length };
}
