// 零依赖向量库 —— memory-vec 的存储底座。
//
// ── 为什么自己写 ─────────────────────────────────────────────────────────
// 宿主是 Electron 33 = Node 20 运行时 ⇒ `node:sqlite` 不存在（那是 22.5+ 的）；
// better-sqlite3 在便携整合包里必然炸（要按 Electron ABI 重编译）。所以：
// 定长 float32 平铺 + 追加写元数据 + 一个小状态文件。检索用暴力余弦（预存 norm）。
// 459 条 × 1024 维 ≈ 1.9MB；768 维 × 5 万条 ≈ 30–60ms —— QQ 群场景完全够。
// **不要在这个阶段引入 HNSW**，那是给百万级的，加进来只会让你没法调试。
//
// ── 三个文件 ─────────────────────────────────────────────────────────────
//   vectors.bin   定长 float32 平铺。slot i 占字节 [i*D*4, (i+1)*D*4)
//   meta.jsonl    每行一条元数据，**行号 = slot 号**。删除写成 tombstone 行
//   index.json    只存小状态：{ version, dim, model, slots, alive, ... }
//
// ── 为什么不把 id→slot 映射塞进 index.json ───────────────────────────────
// 那会让 index.json 随库线性膨胀（5 万条 ≈ 2.5MB 的 JSON），而它本该是个
// 常量大小的小文件。映射在启动时由 meta.jsonl 在内存里重建，启动更快、文件更稳。
//
// ── 一致性纪律（这是本文件唯一真正重要的部分）───────────────────────────
// 写入顺序固定为「先 bin 后 meta 再 index」。任何一步崩掉，下一位启动时的
// `verify()` 都能**检出**并**明确报错**，绝不静默截断、绝不自作聪明地"修复"。
// 理由来自前几轮验证过的结论：这类故障不抛异常，只让值悄悄变成常量或 undefined，
// 而常量是类型正确的。所以这里宁可进入只读模式让人来看，也不猜。
import fs from 'node:fs';
import path from 'node:path';

import { tokenize, docIndex, topicOverlap, tokenCoverage } from './tokens.mjs';

export const STORE_VERSION = 1;

/** 文本检索的**查询串**上限（安全网）。正常问句远短于此；超了**如实回报** `qTruncated`。 */
export const QUERY_MAX_CHARS = 400;

/** 带 code 的错误：调用方据此决定"明确拒绝"还是"降级"。 */
export class VecStoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'VecStoreError';
    this.code = code;
    Object.assign(this, detail);
  }
}

const FLOAT_BYTES = 4;

/**
 * 攒到多少条待处理墓碑就自己落一次盘。
 * 选 256 的理由：一次整表重写 ≈ 库里槽数 × 单行 JSON，1500 条时约 300KB；
 * 每 256 次更新重写一次 = 摊到每条的开销可忽略，而断电最多丢 255 条墓碑
 * （那 255 条会以"旧版本"身份复活，也就是旧库那个病，但规模可控、可再修）。
 */
const TOMBSTONE_FLUSH_EVERY = 256;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：先写同目录临时文件再 rename，避免读到半截文件。 */
function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

/** 向量合法性：必须是有限数、非全零（全零向量是"静默失败"的典型长相）。 */
export function validateVector(vector) {
  if (!vector || typeof vector.length !== 'number') {
    throw new VecStoreError('BAD_VECTOR', '向量不是数组');
  }
  if (!vector.length) throw new VecStoreError('BAD_VECTOR', '向量长度为 0');
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new VecStoreError('BAD_VECTOR', `向量第 ${i} 维不是有限数：${v}`);
    }
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0)) {
    // 全零向量能通过类型检查、能算出 0 分、不会抛错 —— 正是最该拦下的一类。
    throw new VecStoreError('BAD_VECTOR', '向量模长为 0（全零向量）—— 拒绝写入，不允许用 0 伪装');
  }
  return norm;
}

function toFloat32(vector) {
  return vector instanceof Float32Array ? vector : Float32Array.from(vector);
}

export class VecStore {
  /**
   * @param {string} dir      数据目录（例如 <DATA_DIR>/memory-vec）
   * @param {object} [opts]
   * @param {number} [opts.dim]    期望维度；首次写入时为 null，写第一条时锁定
   * @param {string} [opts.model]  期望的嵌入模型名；用于检出"换了模型但没重建"
   */
  constructor(dir, opts = {}) {
    this.dir = path.resolve(dir);
    this.binFile = path.join(this.dir, 'vectors.bin');
    this.metaFile = path.join(this.dir, 'meta.jsonl');
    this.indexFile = path.join(this.dir, 'index.json');
    this.putJournal = path.join(this.dir, 'put-pending.json');
    this.expectedDim = Number.isInteger(opts.dim) && opts.dim > 0 ? opts.dim : null;
    this.expectedModel = opts.model ? String(opts.model) : null;

    /** @type {Map<string, number>} id → slot */
    this.idToSlot = new Map();
    /** @type {Array<object|null>} slot → meta（tombstone 为 null） */
    this.metas = [];
    /** @type {Float32Array|null} 全部 slot 的向量，平铺 */
    this.vectors = null;
    // 已从读模型隐藏、但盘上还写着 `alive` 的旧槽位（见 `flushTombstones`）。
    // **不能省**：旧实现里 `_put` 只把 `metas[slot]` 置 null，`meta.jsonl` 那行不动。
    // ⚠️ 后果要说准（2026-10-29 主审复核后纠正过两次）：`_load()` 有一步隐式去重
    //    （同 id 后者覆盖前者 ⇒ `metas[旧]=null`），所以**检索不会返回重复 id**；
    //    真正的代价是槽位永久白占（bin 按槽数线性长、`_load` 要多读这些行），
    //    只有 `compact()` 能回收。别再把"双向量同进 Top-K"当成这里的因果。
    /** @type {Set<number>} */
    this.pendingTombstones = new Set();
    // 上一次墓碑落盘失败的原因。**与"向量没写进去"是两件事**：`_put` 的顺序是
    // bin 追加 → meta 追加 → index 落盘（这些都成功），只有"把旧行改写成 deleted"
    // 这步可能失败。留着它，是为了让"已经提交、只是墓碑欠着"这件事可查，
    // 而不是把一次维护失败伪装成一整笔写入失败。
    this.lastTombstoneError = null;

    this.index = {
      version: STORE_VERSION,
      dim: null,
      model: null,
      slots: 0,
      alive: 0,
      createdAt: null,
      updatedAt: null
    };

    /** 只读原因：非空时任何写操作都会被拒绝 */
    this.readOnlyReason = '';
    this.lastError = null;

    // ── 关键词倒排索引（`ADR-0033`）：**纯派生量**，只在内存 ────────────────
    //
    // 源 = 已有元数据里的 `title + text`（`text` 是**已脱敏**的出境文本，含"关键词："行）
    // ⇒ **不加任何存储、不落盘**：`meta.jsonl` 已经是真值，这里只是换个形状摆一遍。
    //
    //   `_kw`  Map<token, Set<slot>>  —— 查"哪些文档含这个词"（唯一驻留的那张表）
    //
    // 三条纪律（与 `factstore.bySpeaker` 同源）：
    //   ① **与 `metas` 同生共死**：任何整表替换（`_load`/`reset`/`compact`/`del`/
    //      `_rewriteMeta`/`_corrupt`）一律置空 ⇒ 下次查询**从真值重建**。
    //      不做精细增量删除 —— "忘了某个调用点"会让索引**静默**偏掉，而重建是常数级代价。
    //   ② **惰性构建**：首次文本检索才建。库大时启动不受影响。
    //   ③ **null 表示"没建"**，不是"空库"。空 Map 才是"建了但什么都没有"。
    this._kw = null;

    ensureDir(this.dir);
    try { this._recoverPut(); } catch (error) {
      this._corrupt('RECOVERY_FAILED', String(error?.message || error));
      return;
    }
    this._load();
  }

  /** 丢掉关键词索引（下次查询重建）。任何**整表替换 metas** 的地方都要调。 */
  _invalidateKw() {
    this._kw = null;
  }

  /** 一条元数据参与检索的文本。`title` 也进去：块标题里常带群名/日期。 */
  static _kwSource(meta) {
    return `${meta?.title || ''} ${meta?.text || ''}`;
  }

  /** 建（或重建）倒排索引。O(全部存活文档 × 平均 token 数)，只在下述时机发生。 */
  _buildKw() {
    const kw = new Map();
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (!m) continue;                                   // tombstone 不进索引
      // ⚠️ 词集取自 `docIndex`（**文档口径**），与 `searchText` 打分时用的是同一个函数
      //    ⇒ 索引里的词条与打分用的 `set` 逐字相等，不会出现"进了候选却算 0 分"。
      const info = docIndex(VecStore._kwSource(m));
      if (!info || !info.set.size) continue;
      for (const t of info.set) {
        let s = kw.get(t);
        if (!s) { s = new Set(); kw.set(t, s); }
        s.add(i);
      }
    }
    this._kw = kw;
  }

  /** 确保索引可用（惰性构建）。 */
  _ensureKw() {
    if (this._kw === null) this._buildKw();
  }

  // ── 加载 ────────────────────────────────────────────────────────────────
  _load() {
    const idx = readJson(this.indexFile, null);
    if (idx && typeof idx === 'object') {
      this.index = { ...this.index, ...idx };
      if (Number.isInteger(idx.dim) && idx.dim > 0) this.expectedDim = idx.dim;
      if (idx.model) this.expectedModel = String(idx.model);
    }

    // meta.jsonl：行号即 slot
    const metas = [];
    const map = new Map();
    let raw = '';
    try {
      raw = fs.readFileSync(this.metaFile, 'utf8');
    } catch {
      raw = '';
    }
    if (raw.length) {
      const lines = raw.split('\n');
      // 末尾换行会产生一个空串，属正常；中间的空行才是损坏
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
          if (i !== lines.length - 1) {
            this._corrupt('CORRUPT_META', `meta.jsonl 第 ${i + 1} 行为空（中间出现空行）`);
            return;
          }
          continue;
        }
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          this._corrupt('CORRUPT_META', `meta.jsonl 第 ${i + 1} 行不是合法 JSON`);
          return;
        }
        if (rec.state === 'deleted') {
          metas.push(null);
          continue;
        }
        // A completed append supersedes the prior slot without rewriting its bytes.
        if (rec.id && map.has(String(rec.id))) metas[map.get(String(rec.id))] = null;
        metas.push(rec);
        if (rec.id) map.set(String(rec.id), metas.length - 1);
      }
    }

    const dim = this.expectedDim;
    const slotCount = metas.length;

    // bin 大小必须正好等于 slotCount 个定长行 —— 不等就是半截写
    if (slotCount > 0) {
      if (!dim) {
        this._corrupt('CORRUPT_BIN', '存在 meta 记录但 index.json 没写维度 —— 无法定位向量');
        return;
      }
      let size = 0;
      try {
        size = fs.statSync(this.binFile).size;
      } catch {
        size = -1;
      }
      const expect = slotCount * dim * FLOAT_BYTES;
      if (size !== expect) {
        this._corrupt(
          'CORRUPT_BIN',
          `vectors.bin 大小与 meta 不符：期望 ${expect} 字节（${slotCount} 槽 × ${dim} 维），实际 ${size}`
        );
        return;
      }
      const buf = fs.readFileSync(this.binFile);
      // Buffer 与 Float32Array 共享内存，注意对齐：复制一份避免 byteOffset 错位
      const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      this.vectors = f32;
    } else {
      this.vectors = dim ? new Float32Array(0) : null;
    }

    this.metas = metas;
    this.idToSlot = map;
    this.index.slots = slotCount;
    this.index.alive = map.size;
    // 整表换了 ⇒ 派生索引作废（下一处读取会重建）
    this._invalidateKw();
  }

  _corrupt(code, message) {
    this.readOnlyReason = message;
    this.lastError = { code, message, at: Date.now() };
    // 保持空状态，调用方读到 readOnlyReason 就知道该拒绝写
    this.metas = [];
    this.idToSlot = new Map();
    this.vectors = null;
    this.index.slots = 0;
    this.index.alive = 0;
    this._invalidateKw();
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  status() {
    let bytes = { bin: 0, meta: 0, index: 0 };
    for (const [k, f] of Object.entries({ bin: this.binFile, meta: this.metaFile, index: this.indexFile })) {
      try {
        bytes[k] = fs.statSync(f).size;
      } catch { /* 文件不存在记 0 */ }
    }
    return {
      dir: this.dir,
      dim: this.index.dim,
      model: this.index.model,
      encoding: this.index.encoding || null,
      slots: this.index.slots,
      alive: this.index.alive,
      deleted: this.index.slots - this.index.alive,
      createdAt: this.index.createdAt,
      updatedAt: this.index.updatedAt,
      bytes,
      bytesTotal: bytes.bin + bytes.meta + bytes.index,
      readOnly: Boolean(this.readOnlyReason),
      readOnlyReason: this.readOnlyReason,
      lastError: this.lastError
    };
  }

  get count() {
    return this.index.alive;
  }

  get dim() {
    return this.index.dim;
  }

  _assertWritable(dim, model) {
    if (this.writeBarrier) throw new VecStoreError('REBUILD_BUSY', '向量代际重建中，请稍后重试写入');
    if (this.readOnlyReason) {
      throw new VecStoreError('READ_ONLY', `向量库处于只读状态：${this.readOnlyReason}`);
    }
    if (this.index.dim && dim && dim !== this.index.dim) {
      throw new VecStoreError(
        'DIM_MISMATCH',
        `维度不匹配：库是 ${this.index.dim} 维，本次是 ${dim} 维。换嵌入模型必须显式重建（rebuild），` +
          '不能让两种维度的向量混在同一个文件里 —— 那样算出来的分数是垃圾而且不报错。',
        { storeDim: this.index.dim, incomingDim: dim }
      );
    }
    if (this.index.model && model && String(model) !== this.index.model) {
      throw new VecStoreError(
        'MODEL_MISMATCH',
        `嵌入模型不匹配：库由 ${this.index.model} 生成，本次是 ${model}。` +
          '同一库里混两个模型的向量，相似度不可比。要换模型请走 rebuild。',
        { storeModel: this.index.model, incomingModel: model }
      );
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  /**
   * 写入或更新一条记录。
   * @param {object} rec
   * @param {string} rec.id             稳定 id（同一对象重复索引必须同 id）
   * @param {ArrayLike<number>} rec.vector
   * @param {object} [rec.meta]         附带的元数据（title/chatKey/when/sourceHash…）
   * @returns {{slot:number, created:boolean, updated:boolean, skipped:boolean}}
   */
  _recoverPut() {
    if (!fs.existsSync(this.putJournal)) return;
    const tx = JSON.parse(fs.readFileSync(this.putJournal, 'utf8'));
    if (tx.version !== 1 || !tx.index || !Number.isSafeInteger(tx.binBytes) || tx.binBytes < 0
      || !Number.isSafeInteger(tx.metaBytes) || tx.metaBytes < 0) throw new Error('Invalid vector commit journal');
    for (const [file, bytes] of [[this.binFile, tx.binBytes], [this.metaFile, tx.metaBytes]]) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size < bytes) throw new Error('Vector commit recovery refuses to invent missing bytes');
      if (fs.existsSync(file)) fs.truncateSync(file, bytes);
    }
    atomicWrite(this.indexFile, JSON.stringify(tx.index));
    this.index = tx.index;
    this.expectedDim = tx.index.dim;
    this.expectedModel = tx.index.model;
    fs.unlinkSync(this.putJournal);
  }

  put(rec) {
    this._assertWritable(rec?.vector?.length, rec?.model);
    validateVector(rec?.vector);
    this.assertQueryCompatibility({ model: rec?.model, encoding: rec?.encoding, dim: rec?.vector?.length });
    if (!String(rec?.id ?? '').trim()) throw new VecStoreError('BAD_ID', 'Record needs id');
    const old = this.get(rec.id);
    if (old && rec.meta?.sourceHash && old.meta.sourceHash === rec.meta.sourceHash) {
      return { slot: this.idToSlot.get(String(rec.id)), created: false, updated: false, skipped: true };
    }
    const bytes = f => fs.existsSync(f) ? fs.statSync(f).size : 0;
    const tx = { version: 1, binBytes: bytes(this.binFile), metaBytes: bytes(this.metaFile), index: { ...this.index } };
    atomicWrite(this.putJournal, JSON.stringify(tx));
    try {
      const result = this._put(rec);
      // Journal removal commits the new version. Until then a restart restores old offsets.
      fs.unlinkSync(this.putJournal);
      // 兜底：别处（事件写入、promote）也可能连续更新同一批 id，它们不知道要 flush。
      // 攒到一定量就自己落一次墓碑，免得 pending 无上限增长、崩一次就是一片幽灵行。
      //
      // ⚠️ **必须吞掉这里的失败**（[by:DS] 2026-10-29 按主审复核修）：走到这一行时
      //    bin/meta 的追加与 index 落盘**都已经完成**，journal 也已 unlink —— 向量是
      //    **已提交**的。若让墓碑维护的异常逃出去，`put()` 的 catch 会走 `_recoverPut()`
      //    把库回滚到写前偏移，调用方看到"写失败"却已经花了这一次嵌入的额度，
      //    重试还得再嵌一遍。所以这里吞掉、只记原因，pending 会在下一批/下一次阈值重试。
      if (this.pendingTombstones.size >= TOMBSTONE_FLUSH_EVERY) {
        try { this.flushTombstones(); } catch { /* 见 flushTombstones 里 lastTombstoneError */ }
      }
      return result;
    } catch (error) {
      try { this._recoverPut(); this._load(); }
      catch (recoveryError) { this._corrupt('RECOVERY_FAILED', String(recoveryError?.message || recoveryError)); }
      throw error;
    }
  }

  _put(rec) {
    const id = String(rec?.id ?? '').trim();
    if (!id) throw new VecStoreError('BAD_ID', '记录必须有非空 id');
    const vector = rec.vector;
    const norm = validateVector(vector);
    const dim = vector.length;
    this._assertWritable(dim, rec.model);

    const existing = this.idToSlot.get(id);
    if (existing !== undefined) {
      const prev = this.metas[existing];
      // 幂等：同一对象、同一源哈希 → 跳过，不重复占槽
      if (prev && rec.meta?.sourceHash && prev.sourceHash === rec.meta.sourceHash) {
        return { slot: existing, created: false, updated: false, skipped: true };
      }
      // 有变化 → 追加新槽；旧槽先只从当前读模型隐藏（`metas[existing] = null` 在下面）。
      // Keep the confirmed bytes until the replacement append commits —— 所以**不在这里**
      // 改写 `meta.jsonl`：新行还没落稳就把旧行改成墓碑，崩溃时两边都没了。
      // 真正落墓碑交给 `flushTombstones()`：调用方（索引循环按批、`put` 按阈值）择机整表重写。
      this.pendingTombstones.add(existing);
    }

    const slot = this.index.slots;
    const f32 = toFloat32(vector);

    // ① bin 追加
    fs.appendFileSync(this.binFile, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
    // ② 内存向量扩容（不用 growBy 之类花活，直接重建；5 万条也只是几次 memcpy）
    const prevVec = this.vectors || new Float32Array(0);
    const nextVec = new Float32Array(prevVec.length + f32.length);
    nextVec.set(prevVec, 0);
    nextVec.set(f32, prevVec.length);
    this.vectors = nextVec;
    // ③ meta 追加
    const meta = {
      slot,
      id,
      state: 'alive',
      dim,
      norm,
      model: rec.model ?? null,
      indexedAt: Date.now(),
      ...(rec.meta && typeof rec.meta === 'object' ? rec.meta : {})
    };
    fs.appendFileSync(this.metaFile, `${JSON.stringify(meta)}\n`, 'utf8');
    // ④ 内存索引
    if (existing !== undefined) { this.metas[existing] = null; this._invalidateKw(); }
    this.metas.push(meta);
    // 派生索引：只做**追加**增量。
    // 更新路径已经由 `_tombstone → _rewriteMeta` 整体作废（`_kw` 变 null）⇒ 这里
    // 绝不会遇到"该槽号已有旧词条"的情形 —— 这正是我不写精细删除的原因：
    // 精细删除少写一处就是**静默**偏掉，而重建是常数级代价。
    if (this._kw) {
      const info = docIndex(VecStore._kwSource(meta));
      if (info && info.set.size) {
        for (const t of info.set) {
          let s = this._kw.get(t);
          if (!s) { s = new Set(); this._kw.set(t, s); }
          s.add(slot);
        }
      }
    }
    this.idToSlot.set(id, slot);
    this.index.slots = slot + 1;
    this.index.alive = this.idToSlot.size;
    this.index.dim = dim;
    if (rec.model) this.index.model = String(rec.model);
    if (rec.encoding) this.index.encoding = rec.encoding;
    if (!this.index.createdAt) this.index.createdAt = Date.now();
    this.index.updatedAt = Date.now();

    this._saveIndex();
    return { slot, created: true, updated: Boolean(existing !== undefined), skipped: false };
  }

  _tombstone(slot) {
    const prev = this.metas[slot];
    if (!prev) return;
    // 追加一行 tombstone（行号必须仍等于 slot，所以只能在原位重写 —— 用整文件重写）
    // meta.jsonl 是"行号=slot"的定长语义，删中间一行会错位，所以这里重写整个文件。
    this.metas[slot] = null;
    if (prev.id) this.idToSlot.delete(String(prev.id));
    this._rewriteMeta();
  }

  /**
   * 把"已从读模型隐藏、盘上仍写着 `alive`"的旧槽位落成墓碑。**返回落掉的条数。**
   *
   * 为什么必须有这一入口：`_put` 的更新路径为了崩溃安全**只动内存**（新行 append 成功后
   * 才允许作废旧行）。可旧实现没有第二步 —— `_rewriteMeta` 只被 `del()` 调，于是
   * "更新"永远不落盘墓碑。后果不是理论问题：2026-10-29 盘点实测旧库 296/1721（主号）、
   * 358/1757（小号）条可检索槽位是**同一个 id 的旧版本**，面板按 `index.alive` 报数 ⇒
   * 低报 17~20%，而检索会同时返回新旧两条。
   *
   * 代价是整表重写（`meta.jsonl` 行号=slot，删中间一行会错位），所以按批调、不是按条。
   * `_rewriteMeta` 内部会清空 pending —— 它重写的就是全表，pending 里那些自然已经落掉。
   */
  flushTombstones() {
    if (!this.pendingTombstones || !this.pendingTombstones.size) return 0;
    const n = this.pendingTombstones.size;
    try {
      this._rewriteMeta();
    } catch (error) {
      // **失败必须留住 pending**（`_rewriteMeta` 只在原子写成功后才 clear）：
      // 否则待处理记账就地蒸发，盘上那行仍是 `alive`，而内存再没有任何"还欠着"的
      // 线索 —— 之后既不重试、也不会被下一批带走。主审用临时库注入 rename 失败复现过：
      // pending 清空 / 重试 0 次 / 盘上 2 行 alive。
      this.lastTombstoneError = {
        message: String(error?.message || error),
        at: Date.now(),
        pending: this.pendingTombstones.size
      };
      throw error;
    }
    return n;
  }

  _rewriteMeta() {
    // 槽号语义变了？这里是"原位改写"：行号仍是 slot，只是把已经隐藏的旧槽写成 deleted。
    // 派生索引一概作废（下次查询从真值重建）—— 这是纯推导量，作废零成本。
    this._invalidateKw();
    const lines = [];
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      lines.push(m ? JSON.stringify(m) : JSON.stringify({ slot: i, state: 'deleted' }));
    }
    // ⚠️ **先写盘、成功了才清 pending**（[by:DS] 2026-10-29 主审 P2）。
    //    顺序反过来（旧实现）的问题是：`atomicWrite` 抛错（rename 被占用/权限/磁盘满）
    //    时 pending 已经被 clear ⇒ 调用方虽拿到了异常，但重试时 `flushTombstones()`
    //    看到空集合直接返回 0，**永远补不上那几条墓碑**。
    //    `atomicWrite` 是"写临时文件 + rename"：任何一步失败，`meta.jsonl` 都还是旧内容，
    //    所以留在 pending 里与磁盘状态是一致的，重试就是幂等的整表重写。
    atomicWrite(this.metaFile, lines.length ? `${lines.join('\n')}\n` : '');
    if (this.pendingTombstones) this.pendingTombstones.clear();
    this.lastTombstoneError = null;
  }

  /** 删除一条（tombstone，不回收空间；回收走 compact）。 */
  del(id) {
    const key = String(id);
    const slot = this.idToSlot.get(key);
    if (slot === undefined) return { deleted: false, reason: 'not-found' };
    this._tombstone(slot);
    this.index.alive = this.idToSlot.size;
    this.index.updatedAt = Date.now();
    this._saveIndex();
    return { deleted: true, slot };
  }

  _saveIndex() {
    atomicWrite(this.indexFile, `${JSON.stringify(this.index, null, 2)}\n`);
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  get(id) {
    const slot = this.idToSlot.get(String(id));
    if (slot === undefined) return null;
    const meta = this.metas[slot];
    if (!meta) return null;
    return { meta, vector: this._vectorAt(slot) };
  }

  _vectorAt(slot) {
    const d = this.index.dim;
    if (!this.vectors || !d) return null;
    const start = slot * d;
    return this.vectors.subarray(start, start + d);
  }

  /**
   * 列表（含分页与过滤）。按 slot 倒序 = 最近写入优先。
   *
   * ⚠️ `filter` **在"取前 N 条"之前**生效（票 08 · [by:DS] 2026-10-28）：调用方若在
   * 返回之后才筛，就变成"先 Top-K 后筛" —— 目标项排在 K 之外就**假空**（评审 F09）。
   * 这里的循环本来就是全扫 `metas`，加谓词零额外成本，只是把筛选挪进循环内。
   * `total` 仍是**筛完之后**的总数（与 `search`/`searchText` 的 `filter` 同口径）。
   *
   * @param {{offset?:number, limit?:number, chatKey?:string, kind?:string, q?:string,
   *          filter?:(meta:object)=>boolean}} [q]
   */
  list(q = {}) {
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
    const chatKey = q.chatKey ? String(q.chatKey) : '';
    const kind = q.kind ? String(q.kind) : '';
    const needle = q.q ? String(q.q).toLowerCase() : '';

    const hits = [];
    for (let i = this.metas.length - 1; i >= 0; i--) {
      const m = this.metas[i];
      if (!m) continue;
      if (chatKey && m.chatKey !== chatKey) continue;
      if (kind && m.kind !== kind) continue;
      if (typeof q.filter === 'function' && !q.filter(m)) continue;
      if (needle) {
        const hay = `${m.title || ''} ${m.text || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      hits.push(m);
    }
    return {
      total: hits.length,
      offset,
      limit,
      items: hits.slice(offset, offset + limit).map((m) => ({ ...m, vector: undefined }))
    };
  }

  /** 全部存活的会话键与计数（给面板做过滤器）。 */
  chats() {
    const map = new Map();
    for (const m of this.metas) {
      if (!m) continue;
      const k = m.chatKey || '(未知)';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].map(([chatKey, count]) => ({ chatKey, count })).sort((a, b) => b.count - a.count);
  }

  /**
   * 暴力余弦 Top-K。
   * @param {object} q
   * @param {ArrayLike<number>} q.vector 查询向量
   * @param {number} [q.k=10]
   * @param {string} [q.chatKey]  只在这个会话里找
   * @param {string} [q.kind]
   * @param {(meta:object)=>boolean} [q.filter]
   * @param {string} [q.excludeId]
   */
  assertQueryCompatibility({ model, encoding, dim } = {}) {
    if (this.index.model && model && this.index.model !== String(model))
      throw new VecStoreError('MODEL_MISMATCH', `向量库模型 ${this.index.model} 与当前 ${model} 不兼容；请重建索引`);
    if (this.count && encoding && this.index.encoding !== encoding)
      throw new VecStoreError('ENCODING_MISMATCH', '编码身份不同或旧库未记录编码身份；请重建索引，旧数据保留');
    if (this.index.dim && dim && this.index.dim !== Number(dim))
      throw new VecStoreError('DIM_MISMATCH', '查询维度与向量库不兼容');
  }

  search(q) {
    this.assertQueryCompatibility({ model: q.model || this.expectedModel, encoding: q.encoding, dim: q.vector?.length });
    const qv = q.vector;
    const qn = validateVector(qv);
    if (this.index.dim && qv.length !== this.index.dim) {
      throw new VecStoreError(
        'DIM_MISMATCH',
        `查询向量是 ${qv.length} 维，库是 ${this.index.dim} 维 —— 拒绝检索（否则算出来的分数无意义且不会报错）`,
        { storeDim: this.index.dim, incomingDim: qv.length }
      );
    }
    const k = Math.max(1, Math.min(200, Number(q.k) || 10));
    const d = this.index.dim;
    const vecs = this.vectors;
    if (!vecs || !d) return { k, scanned: 0, hits: [] };

    const out = [];
    let scanned = 0;
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (!m) continue;                                   // tombstone 永不参与检索
      if (q.chatKey && m.chatKey !== q.chatKey) continue;
      if (q.kind && m.kind !== q.kind) continue;
      if (q.excludeId && String(m.id) === String(q.excludeId)) continue;
      if (typeof q.filter === 'function' && !q.filter(m)) continue;
      const off = i * d;
      let dot = 0;
      for (let j = 0; j < d; j++) dot += vecs[off + j] * qv[j];
      const rn = typeof m.norm === 'number' && m.norm > 0 ? m.norm : 0;
      scanned++;
      if (!rn) continue;                                  // 没有 norm 的记录跳过，别拿 0 当分数
      out.push({ id: m.id, score: dot / (qn * rn), meta: m });
    }
    out.sort((a, b) => b.score - a.score);
    return { k, scanned, hits: out.slice(0, k) };
  }

  /**
   * **关键词检索**（`ADR-0033`）—— 不依赖嵌入端点的第二条检索路。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────
   * 向量检索的盲区是**精确 token**（人名/缩写/黑话/专有名词在语义空间里彼此很近）；
   * 而且嵌入端点缺席时它**整条路走不通**（`/search` 直接 400）。这条路回答的是
   * "这条查询的**字面**能在哪几篇里落地"，零网络、零模型、任何时候都可用。
   *
   * ── 排序（三个键，各司其职；**没有单一"相关性分数"**）────────────────────
   *   ① `score`   = `topicOverlap(查询, 文档)` —— 与宿主印象系统**同一口径**的重合度。
   *                 它是主键：能认出"跳字"（`推歌` ↔ `推首歌`）。⚠️ **封顶 2**，
   *                 所以长文档里必然大量并列 —— 见 ②。
   *   ② `matched` = `tokenCoverage(查询, 文档).count` —— 查询的实词命中了几个。
   *                 `topicOverlap` 看不见"命中了几个不同的词"（封顶后全一样），
   *                 而并列时"命中更多词的那篇"更该排前面。这是**次序**，不是门槛。
   *   ③ `when`    = 时间新近（并列的最后一道，与面板列表口径一致）。
   *
   * ⇒ 三个键都**原样返回**给调用方，别在响应里只留一个 `score` 假装它是相关性。
   *
   * ── 候选集从哪来 ────────────────────────────────────────────────────────
   * 倒排索引直接给出"含任一查询 token"的槽位 —— 不必全扫。
   * ⚠️ 一个**已知且有意**的性质：跳字命中（`推歌` ↔ `推首歌`）**不一定**共享 token
   *    （`推首歌` 的 token 是 `推首`/`首歌`，不含 `推歌`）⇒ 光靠倒排会漏掉这类。
   *    所以当查询里存在两字词时，**额外并入单字 token 的候选集**（`推`/`歌` 各自都在
   *    索引里）—— 索引本来就是单字 + bigram 双份，这一步零成本，只是多查几次 Map。
   *
   * @param {object} q
   * @param {string} q.text        查询文本（**必须已归一化**：真名要先变成占位符）
   * @param {number} [q.k=10]
   * @param {string} [q.chatKey]
   * @param {string} [q.kind]
   * @param {(meta:object)=>boolean} [q.filter]
   * @returns {{k:number, scanned:number, candidates:number, built:boolean,
   *            hits:Array<{id:string,score:number,matched:string[],meta:object}>}}
   */
  searchText(q = {}) {
    const k = Math.max(1, Math.min(200, Number(q.k) || 10));
    // 查询串的兜底长度（正常问句远短于此）。截断**如实回报**，不静默：
    // 静默截断会让"为什么后半句没起过滤作用"变成一个查不出来的问题。
    const rawText = String(q.text ?? '');
    const text = rawText.slice(0, QUERY_MAX_CHARS);
    const qTruncated = rawText.length > QUERY_MAX_CHARS;
    if (!text.trim()) return { k, scanned: 0, candidates: 0, built: false, qTruncated, reason: 'empty-query', hits: [] };

    let built = false;
    try {
      this._ensureKw();
      built = true;
    } catch {
      // 建表失败（理论上不该发生）⇒ **全扫兜底**：宁可慢，也不能给"没搜到"。
      // 空结果与"索引坏了"在调用方看来一模一样 —— 那是静默失败，这里不接受。
      this._invalidateKw();
    }

    // ⚠️ 查询侧与文档侧**都用 `tokenize`**（同一个函数）⇒ 词集同口径。
    //    这里**不能**用 `tokensForLine`：它带 >8 字过滤，会让长查询词永远匹配不上
    //    文档里同样长的词 —— 又是"两套词集"的那个坑。
    const qTokens = tokenize(text);
    if (!qTokens.length) return { k, scanned: 0, candidates: 0, built, qTruncated, reason: 'no-tokens', hits: [] };

    // 候选集：命中任一查询 token 的槽位；另并入两字词的**单字**（补跳字那类不共享 token 的）
    let cand = null;
    if (this._kw) {
      cand = new Set();
      const probe = new Set(qTokens);
      for (const t of qTokens) if (t.length === 2) for (const c of t) probe.add(c);
      for (const t of probe) {
        const slots = this._kw.get(t);
        if (slots) for (const s of slots) cand.add(s);
      }
    } else {
      // 兜底：全扫（索引不可用）—— 宁可慢，也不能给"没搜到"
      cand = new Set();
      for (let i = 0; i < this.metas.length; i++) if (this.metas[i]) cand.add(i);
    }

    const out = [];
    let scanned = 0;
    for (const slot of cand) {
      const m = this.metas[slot];
      // ⚠️ 这一行是**纵深防御**，不是可观测行为 —— 变异验证实测：把它删掉测试**全绿**。
      //    理由：索引**从不引用墓碑**（`_rewriteMeta`/`_load`/`del`/`compact`/`reset`
      //    共 7 处整表替换一律作废索引 ⇒ 下次查询从真值重建，而 `_buildKw` 本身就跳墓碑）。
      //    那为什么还留着？因为"索引不引用墓碑"是**别人**（那 7 个调用点）维持的不变量，
      //    一旦哪天被改坏，有这一行是"安静地少读一条"，没有它是**读 null 的字段时抛**——
      //    而抛发生在检索里，会被上层看成"服务坏了"。留着的代价是一次判空。
      if (!m) continue;
      if (q.chatKey && m.chatKey !== q.chatKey) continue;
      if (q.kind && m.kind !== q.kind) continue;
      if (typeof q.filter === 'function' && !q.filter(m)) continue;
      scanned++;
      // ⚠️ **方向**：查询当 `content`、文档当 `topicSets`（长的一侧当 topic）
      //    —— 反了会丢掉"跳字"命中，见 `tokens.mjs` 头注释里的实测数字。
      // ⚠️ 文档侧的 `{set,pos}` **现场重算**（`docIndex`），不额外驻留：`pos` 是
      //    每个文档一张字符位置表，627 篇就要多几 MB 常驻内存，而这里只在**候选**上算。
      // ⚠️ **必须用 `docIndex` 而不是 `tokensForLine`**：后者是话题句口径（160 字截断 +
      //    剔 >8 字词），套到文档上会让正文大半不进索引，而且它与倒排的词集不一致
      //    ⇒ "倒排说命中、打分说 0 分"的自相矛盾漏检（实施时踩过，见 `ADR-0033` §7）。
      const docInfo = docIndex(VecStore._kwSource(m));
      if (!docInfo || !docInfo.set.size) continue;
      const score = topicOverlap(text, [docInfo]);
      if (score <= 0) continue;                            // 一个字都没沾上 ⇒ 不进结果
      const cov = tokenCoverage(qTokens, docInfo.set);
      out.push({ id: m.id, score, matched: cov.matched, meta: m });
    }

    out.sort((a, b) => b.score - a.score
      || b.matched.length - a.matched.length
      || (Number(b.meta?.when) || 0) - (Number(a.meta?.when) || 0));
    return { k, scanned, candidates: cand.size, built, qTruncated, reason: 'ok', hits: out.slice(0, k) };
  }

  /** 最近邻：以库里某条的向量为查询（自身排除）。 */
  neighbors(id, k = 10) {
    const rec = this.get(id);
    if (!rec) return null;
    const r = this.search({ vector: rec.vector, k: k + 1, excludeId: id });
    return { id, k, hits: r.hits.slice(0, k) };
  }

  // ── 维护 ────────────────────────────────────────────────────────────────
  /**
   * 压缩：丢掉 tombstone 槽，重写 bin 与 meta。
   * compact 之后 slot 号会变 —— 但 id 稳定，所以外部只需要认 id。
   */
  compact() {
    if (this.writeBarrier) throw new VecStoreError('REBUILD_BUSY', '重建期间不能压缩旧向量代');
    if (this.readOnlyReason) throw new VecStoreError('READ_ONLY', `只读状态不能压缩：${this.readOnlyReason}`);
    const d = this.index.dim;
    const alive = [];
    for (let i = 0; i < this.metas.length; i++) if (this.metas[i]) alive.push(i);
    if (!d || alive.length === 0) {
      // 空库：直接把文件清零
      atomicWrite(this.binFile, Buffer.alloc(0));
      atomicWrite(this.metaFile, '');
      this.metas = [];
      this.idToSlot = new Map();
      this.vectors = new Float32Array(0);
      this.index.slots = 0;
      this.index.alive = 0;
      this.index.updatedAt = Date.now();
      this._saveIndex();
      this._invalidateKw();
      return { before: this.index.slots, after: 0, removed: 0 };
    }

    const before = this.metas.length;
    const nextVec = new Float32Array(alive.length * d);
    const nextMeta = [];
    for (let n = 0; n < alive.length; n++) {
      const oldSlot = alive[n];
      const m = this.metas[oldSlot];
      nextVec.set(this._vectorAt(oldSlot), n * d);
      nextMeta.push({ ...m, slot: n });
    }
    atomicWrite(this.binFile, Buffer.from(nextVec.buffer, nextVec.byteOffset, nextVec.byteLength));
    const lines = nextMeta.map((m) => JSON.stringify(m));
    atomicWrite(this.metaFile, `${lines.join('\n')}\n`);

    this.metas = nextMeta;
    this.vectors = nextVec;
    this.idToSlot = new Map();
    nextMeta.forEach((m, i) => this.idToSlot.set(String(m.id), i));
    this.index.slots = nextMeta.length;
    this.index.alive = nextMeta.length;
    this.index.updatedAt = Date.now();
    this._saveIndex();
    this._invalidateKw();     // 槽号全变了 ⇒ 派生索引必须重建
    // 槽号重排 ⇒ pending 里的旧槽号已经指向别的记录，作废（tombstone 已被本次压缩丢掉）
    this.pendingTombstones.clear();
    this.lastTombstoneError = null;
    return { before, after: nextMeta.length, removed: before - nextMeta.length };
  }

  /** 清空（重建的第一步）。 */
  reset({ dim = null, model = null } = {}) {
    if (this.writeBarrier) throw new VecStoreError('REBUILD_BUSY', '重建期间不能清空旧向量代');
    atomicWrite(this.binFile, Buffer.alloc(0));
    atomicWrite(this.metaFile, '');
    this.metas = [];
    this.idToSlot = new Map();
    this.pendingTombstones.clear();   // 库都空了，没有"欠着的墓碑"
    this.lastTombstoneError = null;
    this.vectors = dim ? new Float32Array(0) : null;
    this.index = {
      version: STORE_VERSION,
      dim,
      model,
      slots: 0,
      alive: 0,
      createdAt: null,
      updatedAt: null
    };
    this.expectedDim = dim;
    this.expectedModel = model;
    this.readOnlyReason = '';
    this.lastError = null;
    this._saveIndex();
    this._invalidateKw();
    return this.status();
  }

  /** 落盘一致性自查（不修复，只报告）。 */
  verify() {
    const problems = [];
    const d = this.index.dim;
    let binSize = 0;
    try {
      binSize = fs.statSync(this.binFile).size;
    } catch {
      binSize = -1;
    }
    if (this.metas.length > 0 && !d) problems.push('有记录但 index.json 缺 dim');
    if (d) {
      const expect = this.metas.length * d * FLOAT_BYTES;
      if (binSize !== expect) problems.push(`vectors.bin 期望 ${expect} 字节，实际 ${binSize}`);
    }
    let metaLines = 0;
    try {
      const raw = fs.readFileSync(this.metaFile, 'utf8');
      metaLines = raw ? raw.split('\n').filter(Boolean).length : 0;
    } catch {
      metaLines = 0;
    }
    if (metaLines !== this.metas.length) problems.push(`meta 行数 ${metaLines} 与内存槽数 ${this.metas.length} 不等`);
    if (this.idToSlot.size !== this.metas.filter(Boolean).length) {
      problems.push(`id 映射数 ${this.idToSlot.size} 与存活槽数 ${this.metas.filter(Boolean).length} 不等`);
    }
    return { ok: problems.length === 0, problems, readOnlyReason: this.readOnlyReason };
  }
}
