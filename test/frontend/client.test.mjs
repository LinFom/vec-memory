import test from "node:test";
import assert from "node:assert/strict";
import { MemoryApi, ApiError } from "../../web/manage-api.js";
import { createDemoApi } from "../../web/manage-demo.js";
test("late responses are rejected after replacing or cancelling request, even if transport ignores abort", async () => {
  const pending = [];
  const api = new MemoryApi({
    origin: "http://127.0.0.1:1234",
    fetcher: (url, options) =>
      new Promise((resolve) => pending.push({ url, options, resolve })),
  });
  const old = api.get("memory/person?who=old", "person").catch((e) => e);
  const latest = api.get("memory/person?who=new", "person");
  pending[1].resolve({ ok: true, json: async () => ({ who: "new" }) });
  assert.equal((await latest).who, "new");
  pending[0].resolve({ ok: true, json: async () => ({ who: "old" }) });
  assert.equal((await old).name, "AbortError");
  const cancelled = api.get("person", "person").catch((e) => e);
  api.cancel();
  pending[2].resolve({ ok: true, json: async () => ({}) });
  assert.equal((await cancelled).name, "AbortError");
});
test("writes keep originating instance address and exact retry body; service errors carry status", async () => {
  const seen = [];
  const api = new MemoryApi({
    origin: "http://127.0.0.1:2222",
    fetcher: async (url, options) => {
      seen.push({ url: String(url), options });
      return {
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          error: "offline",
          code: "STORAGE_UNAVAILABLE",
        }),
      };
    },
  });
  const body = {
    operationId: "stable-op",
    expectedInstanceId: "library-A",
    expectedEtag: "v1",
  };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      api.write("memory/revisions", body),
      (e) => e instanceof ApiError && e.status === 503,
    );
  assert.equal(seen[0].url, "http://127.0.0.1:2222/api/vec/memory/revisions");
  assert.equal(seen[0].options.body, seen[1].options.body);
});
test("synthetic adapter retains hidden items, restores machine content and rejects wrong instances", async () => {
  const a = createDemoApi(),
    p = await a.get("memory/person?who=demo-person"),
    item = p.items[0];
  await assert.rejects(
    a.write("memory/revisions", { expectedInstanceId: "wrong" }),
    (e) => e.status === 409,
  );
  await a.write("memory/revisions", {
    operationId: "hide",
    expectedInstanceId: p.instanceId,
    target: { key: item.key },
    expectedEtag: item.etag,
    op: "hide",
  });
  const hidden = (await a.get("memory/person?who=demo-person")).items[0];
  assert.equal(hidden.hidden, true);
  await a.write("memory/revisions", {
    operationId: "restore",
    expectedInstanceId: p.instanceId,
    target: { key: hidden.key },
    expectedEtag: hidden.etag,
    op: "restore",
  });
  assert.equal(
    (await a.get("memory/person?who=demo-person")).items[0].hidden,
    false,
  );
});
