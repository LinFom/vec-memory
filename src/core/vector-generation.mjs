// Encoding identity and recoverable generation publication share one commit boundary.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NORMALIZER_VERSION } from './normalize.mjs';
import { VecStore } from './vecstore.mjs';

export function encodingIdentity(settings = {}) {
  // Document text/options are tracked by each sourceHash. Query instruction changes do
  // not change document vectors. A provider alias revision must change embedRevision.
  return JSON.stringify({ version: 1, model: String(settings.embedModel || '').trim(),
    endpoint: String(settings.embedBaseURL || '').trim().replace(/\/+$/, ''),
    dimensions: Number(settings.embedDimensions) || null,
    revision: String(settings.embedRevision || ''), normalizer: NORMALIZER_VERSION,
    documentFraming: 1 });
}
// ── 来源身份比对：搬来的向量到底是谁嵌的 ─────────────────────────────────
//
// 【为什么需要这层】`encodingIdentity()` 有 6 项。原来搬运事件向量时把旧行的
// `model/dim` 解构掉、用**当前** `settings.embedModel` 和当前 `encoding` 重写标签，
// 于是"目标行的标签 == 目标 index 的身份"必然成立 —— 这是自证，不是证据
// （2026-10-29 主审 `batch-followup-acceptance.md` 指出的正是这一条）。
//
// 判据分三类，**不能合并成"看起来都对"一个布尔**：
//   · match      —— 来源侧有明确记录且与当前一致
//   · mismatch   —— 来源侧有明确记录且不一致（这种要拦住，别静默搬）
//   · unknown    —— 来源侧**没有记录**。旧扁平布局的 `index.json` 只有 model/dim，
//                   根本没有 `encoding` 字段（这也是 `assertQueryCompatibility`
//                   对空 encoding 直接跳过比对的由来）⇒ endpoint / revision /
//                   normalizer / documentFraming 四项在旧库上**无法证实**。
// unknown 不等于 incompatible：不知道 ≠ 已知不同。上层默认按 fail-closed 拦，
// 但必须把原因写成 unknown，不能伪装成"不兼容"。
export const IDENTITY_FIELDS = ['model', 'dimensions', 'endpoint', 'revision', 'normalizer', 'documentFraming'];

const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

/** 解析 `encoding` 串；空串/坏 JSON 一律当"没有记录"，不抛错。 */
export function parseEncoding(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/**
 * 比对"来源侧能证的身份"与"当前身份"。
 * @param {{model?:string, dim?:number, encoding?:string|object|null}} source
 *        来源侧：库 index 的 encoding（新布局有）/ 行内 model、dim（旧布局只有这些）
 * @param {{model?:string, dim?:number, encoding?:string|object|null}} target
 *        当前 identity
 * @returns {{verdict:'compatible'|'incompatible'|'unknown', fields:object, mismatches:string[], unknowns:string[], reason:string}}
 */
export function compareSourceIdentity(source = {}, target = {}) {
  const s = parseEncoding(source.encoding);
  const t = parseEncoding(target.encoding);
  const fields = {};

  // 取值优先级：encoding 里的显式记录 > 行内字段 > 无记录（null）
  // ⚠️ 行内 `model`/`dim` 是**嵌入当时写进去的**（promote/索引路径写 rec.model），
  //    不是我们事后贴的 —— 所以它算来源证据，只是覆盖面窄（只有这两项）。
  const take = (k, srcInline, dstInline) => {
    const src = hasOwn(s, k) ? s[k] : (srcInline === null || srcInline === undefined || srcInline === '' ? null : srcInline);
    const dst = hasOwn(t, k) ? t[k] : (dstInline === null || dstInline === undefined || dstInline === '' ? null : dstInline);
    // revision 的合法值可以是空串（provider alias 未使用）—— 只要 encoding 里**有**这个键就算有记录
    const srcKnown = hasOwn(s, k) || (srcInline !== null && srcInline !== undefined && srcInline !== '');
    const dstKnown = hasOwn(t, k) || (dstInline !== null && dstInline !== undefined && dstInline !== '');
    let result;
    if (!srcKnown) result = 'unknown';
    else if (!dstKnown) result = 'unknown';
    else if (String(src) === String(dst)) result = 'match';
    else result = 'mismatch';
    fields[k] = { source: srcKnown ? src : null, target: dstKnown ? dst : null, result };
  };

  take('model', source.model, target.model);
  take('dimensions', source.dim ?? source.dimensions, target.dim ?? target.dimensions);
  // 这四项旧扁平布局根本没有记录 ⇒ 恒 unknown（这是本次要承认的事实，不是缺陷掩盖）
  take('endpoint');
  take('revision');
  take('normalizer');
  take('documentFraming');

  const mismatches = IDENTITY_FIELDS.filter((k) => fields[k].result === 'mismatch');
  const unknowns = IDENTITY_FIELDS.filter((k) => fields[k].result === 'unknown');
  let verdict = 'compatible';
  let reason = '全部 6 项均有来源记录且一致';
  if (mismatches.length) {
    verdict = 'incompatible';
    reason = `来源身份与当前不一致：${mismatches.join(' / ')}`;
  } else if (unknowns.length) {
    verdict = 'unknown';
    reason = `来源侧无记录，无法证实：${unknowns.join(' / ')}（不知道 ≠ 已知不同）`;
  }
  return { verdict, fields, mismatches, unknowns, reason };
}

/**
 * 规划事件向量的搬运：**只判定，不落盘**。
 *
 * 拆出来的理由是可测性：`runIndex` 里那段逻辑一旦和 `put()`、`generation`、
 * 端点健康检查缠在一起，就只能靠"跑一遍真重建"来验证，而那是要花钱的。
 * 这里所有输入都是纯数据（来源行 + 来源代 encoding + 目标身份），
 * 于是"同维度换模型""同模型换 endpoint""来源身份缺失"都能在内存里断言。
 *
 * @param {object} o
 * @param {object[]} o.sourceMetas 来源库的 meta 行
 * @param {string|null} o.sourceEncoding 来源代 index.encoding（旧扁平布局为 null）
 * @param {{model?:string, dim?:number|null, encoding?:string}} o.targetIdentity 当前身份
 * @param {(id:string)=>boolean} [o.hasTarget] 目标代里是否已有该 id（续跑去重）
 * @param {boolean} [o.allowUnknown] unknown 是否放行（默认 false = fail-closed）
 * @param {number} [o.sampleLimit]
 */
export function planEventCarry({
  sourceMetas = [], sourceEncoding = null, targetIdentity = {},
  hasTarget = () => false, allowUnknown = false, sampleLimit = 5
} = {}) {
  const accepted = [];
  const blocked = [];
  const byVerdict = { compatible: 0, unknown: 0, incompatible: 0 };

  for (const meta of sourceMetas) {
    if (!meta || meta.kind !== 'event') continue;
    if (hasTarget(meta.id)) continue;
    // 来源身份**只取旧行自己写的** model/dim 与旧代 index 的 encoding。
    // 绝不拿 settings.embedModel 再写一遍 —— 那是上一轮被驳回的自证。
    const sourceIdentity = {
      model: meta.model ?? null,
      dim: meta.dim ?? meta.embedDim ?? null,
      encoding: sourceEncoding
    };
    const verdict = compareSourceIdentity(sourceIdentity, targetIdentity);
    byVerdict[verdict.verdict] = (byVerdict[verdict.verdict] || 0) + 1;

    if (verdict.verdict === 'incompatible' || (verdict.verdict === 'unknown' && !allowUnknown)) {
      blocked.push({ id: meta.id, verdict: verdict.verdict, reason: verdict.reason });
      continue;
    }
    accepted.push({ meta, sourceIdentity, verdict });
  }

  const status = blocked.length ? 'blocked'
    : (byVerdict.unknown ? 'unknown-accepted' : 'compatible');
  return { accepted, blocked, byVerdict, status, sample: blocked.slice(0, sampleLimit) };
}

export function openActiveVectors(dir) {
  const pointer = path.join(dir, 'vector-active.json');
  if (!fs.existsSync(pointer)) return new VecStore(dir);
  const { generation } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (!/^[a-f0-9]{32}$/.test(generation || '')) throw new Error('Invalid vector generation pointer');
  const target = path.join(dir, 'vector-generations', generation);
  for (const file of ['index.json', 'meta.jsonl', 'vectors.bin']) {
    if (!fs.existsSync(path.join(target, file))) throw new Error(`Active vector generation is incomplete: ${file}`);
  }
  return new VecStore(target);
}

// ── 重建作业（可续跑）─────────────────────────────────────────────────────
//
// 【为什么要有作业文件】重建一次要几千次嵌入调用、几分钟到几十分钟。中断的原因
// 绝大多数**不是代码 bug**，而是"端点额度用完了""网断了""用户按了停止"。这类中断
// 之后重新跑，最不能接受的是**把已经嵌过的再嵌一遍** —— 那是纯粹的白花钱。
//
// 续跑的天然账本本来就在代目录里：`VecStore.put()` 逐条即时落盘（bin 追加 + meta
// 追加 + put-pending journal + index 重写），所以"已完成的条目"在磁盘上是可读的，
// 重开一次 `new VecStore(genDir)` 就能全部读回来。
//
// 但代目录名是 `sha256(encoding + oldStore.dir + oldStore.index.updatedAt)`——
// 只要旧代被写过一次（服务重启后 `writeBarrier` 不再存在，自动索引跑一轮就会写），
// `updatedAt` 变、目录名变，前一次的进度就**整体失联**了。所以要把"这一次重建用
// 哪个代目录"钉在一个**不随旧代变化**的地方：库根的 `rebuild-job.json`。
// 有未完成作业且编码身份没变 ⇒ 复用它的 generation；否则才新建。
export const JOB_VERSION = 1;
export const REBUILD_JOB_FILE = 'rebuild-job.json';

/** 未完成（可续跑）的作业状态。`published` 不在其中：已切换的代不该再被续。 */
const RESUMABLE = new Set(['running', 'paused-quota', 'paused-limit', 'ready', 'failed']);

export function rebuildJobPath(dir) { return path.join(dir, REBUILD_JOB_FILE); }

export function readRebuildJob(dir) {
  try {
    const job = JSON.parse(fs.readFileSync(rebuildJobPath(dir), 'utf8'));
    return job && typeof job === 'object' ? job : null;
  } catch { return null; }
}

/** 原子写：临时文件 + rename。作业文件被 `runIndex` 每批更新一次，读方永远看到完整 JSON。 */
export function writeRebuildJob(dir, job) {
  const file = rebuildJobPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return job;
}

export function generationDirOf(dir, generation) {
  return path.join(dir, 'vector-generations', generation);
}

/**
 * 建（或复用）一个可续跑的新向量代。**不复制旧向量**。
 *
 * ⚠️ 2026-10-29 之前的版本会遍历 `oldStore.metas` 用 `meta.text` 把每条重嵌一遍。
 * 三条实测理由让它必须废掉：
 *   ① `chunkMeta()` 把入库的 `meta.text` **截到 400 字符**（主号 483/1425 条、小号
 *      971/1399 条正好是 400）⇒ 拿它重嵌 = 34% / 69% 的条目**丢掉尾部内容**，
 *      新代看起来"条数一样"，检索质量却退化了。
 *   ② 两套 `sourceHash` 算法不同：旧重建用 `sha256(encoding + text)`，语料索引用
 *      `FNV(id|when|len|前200字)`。重建写完紧接着的语料索引会把**每一条**都判成
 *      陈旧再嵌一遍 ⇒ 双倍花费，且同一个 id 留两行 `alive`（P2 那个"旧向量复活"
 *      的坑会在新代里原样复制）。
 *   ③ 完整的重建本来就要从语料重新算文本，旧向量唯一的价值是"切换前旧代还能读"，
 *      而那由"不 publish"保证，不需要把旧向量搬进新代。
 *
 * 所以这里的职责收窄成：**定代目录 + 建空 store + 写作业 + 给 publish 边界**。
 * 真正的写入由 `runIndex` 的语料循环完成 —— 它本来就有分批、`sourceHash` 幂等跳过
 * 与"已存在则跳过"的判定，天然就是续跑器。
 */
export async function prepareVectorGeneration({ dir, oldStore, settings }) {
  const encoding = encodingIdentity(settings);
  try {
    oldStore.assertQueryCompatibility({ model: settings.embedModel, encoding });
    // 兼容 ⇒ 不需要新代。返回旧 store，publish 是空操作（调用方无感）。
    return { store: oldStore, generation: null, genDir: null, encoding, resumed: false,
      job: null, publishing: false, publish() {}, pause() {}, progress() {}, close() {} };
  } catch (e) {
    if (!['MODEL_MISMATCH', 'ENCODING_MISMATCH'].includes(e.code)) throw e;
  }
  if (oldStore.readOnlyReason) throw new Error(`Cannot rebuild unreadable vectors: ${oldStore.readOnlyReason}`);

  const previous = readRebuildJob(dir);
  const reusable = previous
    && previous.version === JOB_VERSION
    && previous.encoding === encoding
    && /^[a-f0-9]{32}$/.test(String(previous.generation || ''))
    && RESUMABLE.has(String(previous.status))
    && fs.existsSync(path.join(generationDirOf(dir, previous.generation), 'index.json'));

  // 代目录名：优先复用未完成作业里的那个。**不要**在这里"顺手换个更聪明的名字"——
  // 名字一变，前一次已经花掉的调用就整体失联了。
  const generation = reusable
    ? String(previous.generation)
    : createHash('sha256').update(`${encoding}\0${oldStore.dir}\0${oldStore.index.updatedAt}`).digest('hex').slice(0, 32);
  const genDir = generationDirOf(dir, generation);
  fs.mkdirSync(genDir, { recursive: true });

  const store = new VecStore(genDir, { model: settings.embedModel });
  // 旧代在整个重建期间**只读**：任何写入都会让它的 `updatedAt` 变，成为下一次的干扰源。
  oldStore.writeBarrier = true;

  const now = Date.now();
  // ⚠️ 复用作业时必须**继承计数器**：`publish()` 会再走一遍本函数，如果这里从 0 开始，
  //    刚发布完的作业就会显示"嵌入了 0 条、被拒 0 条"—— 进度还在，账却没了。
  //    （2026-10-29 首次真机切代就踩了这个：主号 `embedded:0/rejected:0`，小号同。
  //      数字本身没丢，代文件里都在，但作业文件是给人看的那一份，它不该说谎。）
  const inherit = reusable ? previous : null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const job = {
    version: JOB_VERSION,
    generation,
    encoding,
    dir: genDir,
    status: 'running',
    // 复用时保留原始开始时间，这样"这次到底跑了多久"不会被续跑冲掉
    startedAt: inherit ? num(inherit.startedAt) || now : now,
    resumedAt: reusable ? now : null,
    updatedAt: now,
    pauseReason: null,
    lastError: null,
    // 进度口径：total 由 runIndex 填（它才知道语料有多少条）
    total: inherit ? num(inherit.total) : 0,
    done: inherit ? num(inherit.done) : 0,                 // 处理过的条数（含续跑跳过）
    embedded: inherit ? num(inherit.embedded) : 0,          // **累计**实际调用端点的条数（计费口径）
    skippedResume: inherit ? num(inherit.skippedResume) : 0,// 续跑时磁盘上已有、本次没调的条数
    rejected: inherit ? num(inherit.rejected) : 0,          // 出境闸门拒绝（不算损坏）
    unreadable: inherit ? num(inherit.unreadable) : 0,      // 块文件读不出来（真损坏，会阻止 publish）
    carried: inherit ? num(inherit.carried) : 0,            // 事件向量原样搬运
    alive: store.count,
    rejectedList: inherit && Array.isArray(inherit.rejectedList) ? inherit.rejectedList : [],
    // 被拒条目的 id 清单：续跑会**重新扫到同一批**被拒的块，没有它就会重复计数
    // （2026-10-29 实测：主号跑了 3 轮，rejected 从 7 涨到 21，而实际只有 7 个块出不去）。
    rejectedIds: inherit && Array.isArray(inherit.rejectedIds) ? inherit.rejectedIds : []
  };
  writeRebuildJob(dir, job);

  const write = () => { job.updatedAt = Date.now(); job.alive = store.count; writeRebuildJob(dir, job); };

  return {
    store, generation, genDir, encoding,
    resumed: reusable,
    job,
    /** 把进度刷到作业文件。`runIndex` 每嵌完一批调一次。 */
    progress(patch) {
      if (patch && typeof patch === 'object') Object.assign(job, patch);
      write();
    },
    /** 记一条被闸门拒的条目（只留前 200 条，免得作业文件被几千条撑爆）。 */
    reject(item) {
      const id = String(item?.id || '');
      if (!id) return;
      if (!Array.isArray(job.rejectedIds)) job.rejectedIds = [];
      // 同一个块只记一次：续跑的每一轮都会重新扫到它，重复计数会让"多少条出不去"变成谎话
      if (job.rejectedIds.includes(id)) return;
      job.rejectedIds.push(id);
      job.rejected = job.rejectedIds.length;
      if (job.rejectedList.length < 200) {
        job.rejectedList.push({ id, code: String(item?.code || ''), message: String(item?.message || '').slice(0, 240) });
      }
    },
    /** 暂停（额度不足 / 达到本轮上限）。**不** publish，旧代继续服务。 */
    pause(status, reason) {
      job.status = String(status || 'paused-quota');
      job.pauseReason = String(reason || '');
      write();
    },
    /** 切代：写指针 + 作业标记为已发布。幂等（重复调只是重写同一个指针）。 */
    publish() {
      if (!store.count && !fs.existsSync(store.indexFile)) store.reset({ model: settings.embedModel });
      const pointer = path.join(dir, 'vector-active.json');
      fs.writeFileSync(`${pointer}.tmp`, JSON.stringify({ version: 1, generation, encoding }));
      fs.renameSync(`${pointer}.tmp`, pointer);
      job.status = 'published';
      job.publishedAt = Date.now();
      job.alive = store.count;
      write();
    },
    /**
     * 只撤回"本次 dry-run 新建的空壳"（作业文件 + 空代目录）。
     * ⚠️ 复用了已有作业时**什么都不做** —— 预览一个跑了一半的重建，不能把进度删掉。
     */
    abandonPreview() {
      if (reusable) return;
      try { fs.unlinkSync(rebuildJobPath(dir)); } catch { /* 本来就没有 */ }
      try { fs.rmdirSync(genDir); } catch { /* 只删得掉空目录；非空说明有东西，留着 */ }
    },
    close() { oldStore.writeBarrier = false; }
  };
}
