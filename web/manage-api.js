export class ApiError extends Error {
  constructor(status, body) {
    super(body.error || body.message || `请求失败 (${status})`);
    this.status = status;
    this.body = body;
  }
}
export class MemoryApi {
  constructor({
    origin = location.origin,
    fetcher = (...args) => globalThis.fetch(...args),
  } = {}) {
    this.origin = origin;
    this.fetcher = fetcher;
    this.pending = new Map();
  }
  cancel() {
    for (const c of this.pending.values()) c.abort();
    this.pending.clear();
  }
  async get(path, slot = path) {
    this.pending.get(slot)?.abort();
    const c = new AbortController();
    this.pending.set(slot, c);
    try {
      const result = await this.request(path, { signal: c.signal });
      if (this.pending.get(slot) !== c)
        throw new DOMException("过期响应", "AbortError");
      return result;
    } finally {
      if (this.pending.get(slot) === c) this.pending.delete(slot);
    }
  }
  async request(path, options = {}) {
    const r = await this.fetcher(
      new URL("/api/vec/" + path, this.origin),
      options,
    );
    let body;
    try {
      body = await r.json();
    } catch {
      throw new ApiError(r.status, { error: "服务返回了无法解析的响应" });
    }
    if (!r.ok || body.ok === false) throw new ApiError(r.status, body);
    return body;
  }
  write(path, body) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
export function operationId() {
  return crypto.randomUUID();
}
