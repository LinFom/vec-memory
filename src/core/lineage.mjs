// 标签沿革表（label lineage）—— 回答"这个旧占位符现在是谁"。
//
// ── 它解决的那个真问题（2026-10-11 实测）──────────────────────────────────
// 星图上的"星"、备注（`notes.json`）的键、库里向量里的占位符，**全都挂在标签上**
// （`〔P1234〕` / `X277` / `group:C8938`），而不是挂在实体 id 上。而标签会变：
//
//   ① **重建词表**：实体 id 不变、标签重新分配 ⇒ 词表里从 `986` 涨到 `1151` 那次，
//      164 个新人让一批人的编号整体挪了位（`X277 → P5726`）。
//   ② **身份合并**：把 B 并入 A ⇒ B 的标签从此不再指人。
//
// 两种情况下 `notes.json` 里的旧键都**还在文件里**，而界面上再也显示不出来
// —— 不报错、不警告，是**静默失联**。本项目对这类故障的立场一贯是：
// 要么检出、要么明确降级，**绝不装作没事**（`vecstore.mjs` 的一致性纪律原话）。
//
// ── 为什么映射是**可算**的，不是猜的 ──────────────────────────────────────
// `entities.json` 同时存着 `entities[]` 与 `ephemeral[]`，两处都是 `(实体 id, 标签)` 对。
// 重建前后按**同一个实体 id** 一比，"旧标签 → 新标签"就是现成的差量。
// 所以这张表只记事实，不含任何推断。
//
// ── 键为什么是标签、不是实体 id ───────────────────────────────────────────
// 因为要救的东西（备注的键）本来就是标签。用实体 id 当键还得先做一次反查，
// 而反查恰恰是漂移之后做不到的那一步。
//
// ── 纪律 ─────────────────────────────────────────────────────────────────
// · 追加写、**永不删**：一条沿革是"这发生过"的事实，不是当前状态。
// · 一个旧标签只记**第一条**沿革（`X277` 先变 `P5726` 再被并进 `P1234` 时，
//   `X277 → P5726` 保留，链路由 `P5726 → P1234` 接上）⇒ 读取时**沿链折叠**。
// · 解析必须**防环**：写坏了表不能把渲染拖进死循环。
import fs from 'node:fs';
import path from 'node:path';

export const LINEAGE_FILE = 'labels.json';
export const LINEAGE_VERSION = 1;

/** 链长上限：防"表被写坏成环"（正常链长 ≤3：临时标签 → 正式标签 → 并入口）。 */


export function lineagePath(root) {
  return path.join(path.resolve(root), LINEAGE_FILE);
}

/**
 * 读沿革表。文件不存在 / 读坏 ⇒ 返回空表（**不抛**：读不到沿革不该让备注挂掉，
 * 只是退化成"旧键显示不出来"这个既有行为）。
 */
export function readLineage(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(lineagePath(root), 'utf8'));
    const src = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    /** @type {Record<string, {to:string, at:string, why:string, removed?:object}>} */
    const entries = {};
    for (const [k, v] of Object.entries(src)) {
      const to = String(v?.to ?? '');
      if (!k || !to || k === to) continue;
      entries[k] = {
        to,
        at: String(v?.at ?? ''),
        why: String(v?.why ?? ''),
        ...(v?.removed ? { removed: v.removed } : {})
      };
    }
    return { ok: true, entries };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, entries: {} };
    return { ok: false, entries: {}, error: String(err?.message ?? err) };
  }
}

/**
 * 追加若干条沿革（**同键只记第一条**）。原子写：先 `.tmp` 再 `rename`。
 *
 * @param {string} root
 * @param {Array<{from:string,to:string,removed?:object}>} pairs
 * @param {string} why   'rebuild' | 'merge' | …（写进表里，便于事后审计）
 * @param {string} [at]  时间戳（测试注入口）
 */
export function appendLineage(root, pairs, why, at = '') {
  const dir = path.resolve(root);
  const { ok, entries, error } = readLineage(dir);
  if (!ok) return { ok: false, error: `读旧沿革失败，为免覆盖已放弃本次写入：${error}` };

  const stamp = at || new Date().toISOString();
  let added = 0;
  for (const p of pairs || []) {
    const from = String(p?.from ?? '');
    const to = String(p?.to ?? '');
    if (!from || !to || from === to) continue;
    if (entries[from]) continue;             // 已经记过 ⇒ 保留第一条（链路靠 to 接上）
    entries[from] = { to, at: stamp, why: String(why || ''), ...(p.removed ? { removed: p.removed } : {}) };
    added++;
  }
  if (!added) return { ok: true, added: 0, total: Object.keys(entries).length };

  const target = lineagePath(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    const ordered = {};
    for (const k of Object.keys(entries).sort()) ordered[k] = entries[k];
    const body = {
      version: LINEAGE_VERSION,
      note: '标签沿革：旧占位符 → 现占位符。只增不删。备注（notes.json）的键不变，读取时沿这张表折叠。',
      entries: ordered
    };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true, added, total: Object.keys(entries).length };
}

/**
 * **改指**某条沿革的落点。只给"取消合并"用 —— 那是唯一一种
 * "已经记过的沿革现在不成立了"的情形（那个人又独立出去了 ⇒ 他的备注该回到他身上）。
 * 单独成一个函数，是为了让这条**唯一的例外**在代码里显形：别的地方一律追加、不改。
 */
export function repointLineage(root, from, to, why, at = '') {
  const dir = path.resolve(root);
  const { ok, entries, error } = readLineage(dir);
  if (!ok) return { ok: false, error: `读旧沿革失败：${error}` };
  const k = String(from ?? '');
  const t = String(to ?? '');
  if (!k || !t) return { ok: false, error: 'from / to 不能为空' };
  if (!entries[k]) return { ok: false, error: `没有 ${k} 的沿革记录（只允许改指已存在的条目）` };
  entries[k] = { ...entries[k], to: t, at: at || new Date().toISOString(), why: String(why || '') };
  const target = lineagePath(dir);
  try {
    const tmp = `${target}.tmp-${process.pid}`;
    const ordered = {};
    for (const key of Object.keys(entries).sort()) ordered[key] = entries[key];
    fs.writeFileSync(tmp, `${JSON.stringify({ version: LINEAGE_VERSION, note: '标签沿革：旧占位符 → 现占位符。只增不删（取消合并是唯一改指的例外）。', entries: ordered }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true, from: k, to: t };
}

/**
 * 由**装载前/后**两张「实体/临时项 → 标签」快照算出沿革差量（纯函数，可离线测）。
 *
 * 为什么按"东西"（实体 id）算、而不是按标签算：标签正是那个会变的东西，
 * 拿它当对齐键就是循环论证。实体 id 才是"同一个人"的稳定锚。
 *
 * @param {Map<string,string>} before
 * @param {Map<string,string>} after
 * @returns {Array<{from:string,to:string}>}
 */
export function lineagePairs(before, after) {
  const out = [];
  for (const [thing, oldLabel] of before || []) {
    const newLabel = after?.get ? after.get(thing) : '';
    if (newLabel && newLabel !== oldLabel) out.push({ from: oldLabel, to: newLabel });
  }
  return out;
}

/**
 * 沿链折叠到一个"当前标签"。防环（出现循环返回原标签，不将两个身份误归并）。
 * @param {Record<string,{to:string}>} entries
 * @param {string} label
 */
export function canonicalLabel(entries, label) {
  const origin = String(label ?? '');
  let cur = origin;
  const seen = new Set();
  while (entries?.[cur]?.to && entries[cur].to !== cur) {
    if (seen.has(cur)) return origin; // Invalid cycles never join distinct identities.
    seen.add(cur);
    cur = String(entries[cur].to);
  }
  return cur;
}

/**
 * 把备注表折叠到"当前标签"上。
 *
 * 冲突规则：**当前标签已有备注时，它赢**（那是最新一次写入的落点），
 * 被压掉的那条如实记在 `shadowed` 里返回 —— 不静默丢弃。
 *
 * @param {Record<string,{text:string,updatedAt:string}>} notes
 * @param {Record<string,{to:string}>} entries
 */
export function foldNotes(notes, entries) {
  const out = {};
  const shadowed = [];
  const src = notes || {};
  // ⚠️ **两趟**，顺序不能反。
  //    一趟按插入顺序做的话，"精确键"能不能赢取决于它在对象里的位置 ——
  //    若被折过来的那条排在前面，它会先占住落点，然后被精确键覆盖（结果对），
  //    但**冲突这件事就没人记下来了**（`shadowed` 恒空）。这是测试抓出来的：
  //    "冲突时当前标签的备注赢" 绿着，"被压掉的那条如实报出来" 红着。
  //    胜负对、账不对，等于没记 —— 本项目对静默丢东西一贯不容。
  for (const [key, val] of Object.entries(src)) {
    if (canonicalLabel(entries, key) === key) out[key] = val;
  }
  for (const [key, val] of Object.entries(src)) {
    const to = canonicalLabel(entries, key);
    if (to === key) continue;
    if (out[to]) { shadowed.push({ from: key, to, text: val?.text ?? '' }); continue; }
    out[to] = { ...val, migratedFrom: key };
  }
  return { notes: out, shadowed };
}

/** Read-only identity closure. Historical keys and scopes remain untouched. */
export function relatedLabels(entries, labels) {
  const roots = new Set([...labels].map(label => canonicalLabel(entries, label)));
  const out = new Set(labels);
  for (const label of [...Object.keys(entries || {}), ...roots]) {
    if (roots.has(canonicalLabel(entries, label))) out.add(label);
  }
  return out;
}
