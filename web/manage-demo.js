import { ApiError } from "./manage-api.js";
export function createDemoApi({ modern = false } = {}) {
  const instanceId = "demo-library-01",
    caps = [
      "memory.person",
      "memory.policy-impact",
      "memory.revisions",
      "subjects.read",
      "subjects.create",
      "subjects.aliases",
      "subjects.merge",
      "subjects.unmerge",
    ];
  if (modern) caps.push("facts.evidence", "memory.events");
  const items = [
    {
      key: "demo-1",
      rev: 1,
      etag: "demo-etag-1",
      kind: "trait",
      scope: "group:C100",
      itemKey: null,
      value: "喜欢修理旧收音机，每周参加社区志愿活动。",
      originalValue: "喜欢修理旧收音机。",
      editable: true,
      origin: "machine",
      sourceState: "current",
      hidden: false,
    },
    {
      key: "demo-2",
      rev: 1,
      etag: "demo-etag-2",
      kind: "trait",
      scope: "private:P200",
      itemKey: null,
      value:
        "最近正在学习木工。" +
        "这是一段用于检查换行和布局的合成长文本。".repeat(12),
      originalValue: "最近正在学习木工。",
      editable: true,
      origin: "manual",
      sourceState: "source_changed",
      hidden: false,
    },
    {
      key: "demo-3",
      rev: 1,
      etag: "demo-etag-3",
      kind: "pattern",
      scope: "group:C100",
      itemKey: "p1",
      value: "经常协助其他成员排查设备问题",
      editable: false,
      origin: "machine",
      sourceState: "current",
      hidden: false,
    },
  ];
  const subjects = [
    {
      id: "demo-subject-1",
      kind: "project",
      label: "社区花园计划",
      aliases: ["花园计划"],
      scopeBinding: null,
      status: "active",
      mergedInto: null,
      rev: 1,
    },
    {
      id: "demo-subject-2",
      kind: "project",
      label: "同名花园计划",
      aliases: [],
      scopeBinding: null,
      status: "active",
      mergedInto: null,
      rev: 1,
    },
  ];
  const observations = [
    {
      id: "obs-1",
      aspect: "进度",
      claimType: "opinion",
      statement: "一位参与者认为项目进展顺利。",
      sourceScope: "group:C100",
      reporterLabel: "合成甲",
      observedAt: "2026-10-28",
      provenance: [],
    },
    {
      id: "obs-2",
      aspect: "进度",
      claimType: "opinion",
      statement: "另一位参与者认为项目进度落后，需要调整安排。",
      sourceScope: "private:P200",
      reporterLabel: "合成乙",
      observedAt: "2026-10-29",
      provenance: [],
    },
  ];
  const replay = new Map();
  const wrap = (x) => ({
    ok: true,
    instanceId,
    contractVersion: 1,
    ...structuredClone(x),
  });
  return {
    cancel() {},
    async get(path) {
      if (modern && path.startsWith("facts/evidence")) {
        const q = new URLSearchParams(path.split("?")[1]);
        return {
          ok: true,
          level: "slot",
          state: "window-match",
          reason: "合成窗口级来源",
          references: [
            {
              type: "window",
              id: "demo-window",
              chatKey: "group:100",
              resolved: true,
            },
          ],
          unresolved: [],
          sourceLookup: q.has("withSource")
            ? {
                note: "按时间区间重新取回，不保证当时批次",
                sources: [
                  {
                    status: "found",
                    truncated: false,
                    messages: [{ text: "明确标记的合成原话" }],
                  },
                ],
              }
            : null,
        };
      }
      if (modern && path.startsWith("memory/events")) {
        const q = new URLSearchParams(path.split("?")[1]),
          limit = Number(q.get("limit") || 30),
          start = Number(q.get("cursor") || 0),
          rows = ["A", "B", "C"].map((id) => ({
            id: "demo-" + id,
            title: "合成事件 " + id,
            state: "working",
            fromTs: 1000,
            toTs: 2000,
          }));
        return {
          ok: true,
          items: rows.slice(start, start + limit),
          total: 3,
          stateCounts: { working: 3 },
          snapshotId: "demo-snapshot",
          nextCursor: start + limit < 3 ? String(start + limit) : null,
        };
      }
      if (modern && path === "consolidate")
        return {
          ok: true,
          enabled: true,
          running: false,
          llmConfigured: false,
          lastConsolidate: {
            ok: true,
            degraded: { code: "EVIDENCE_MISSING", message: "合成账本缺失" },
            maintenance: { ran: true },
          },
        };

      const [p, search] = path.split("?"),
        q = new URLSearchParams(search);
      if (p === "memory/diagnostics")
        return wrap({
          capabilities: caps,
          service: { version: "合成演示" },
          vectors: { mode: null, generation: null },
          storage: { readOnly: false, reason: null },
          pending: { windows: null, outbox: null },
          lastValidation: null,
        });
      if (p === "person")
        return {
          people: [
            { speaker: "demo-person", names: ["林小舟（合成人物）"], slots: 3 },
            { speaker: "demo-empty", names: ["空记录人物"], slots: 0 },
          ],
        };
      if (p === "memory/person")
        return wrap({
          person: {
            query: q.get("who"),
            labels: [
              q.get("who") === "demo-empty"
                ? "空记录人物"
                : "林小舟（合成人物）",
            ],
          },
          scopes: [...new Set(items.map((i) => i.scope))].map((scope) => ({
            scope,
            chatKey: null,
            displayName: scope,
            mappingStatus: "unknown",
          })),
          items: q.get("who") === "demo-empty" ? [] : items,
        });
      if (p === "memory/policy-impact")
        return wrap({
          policies: ["same-scope", "group-peers", "all"].map((id, n) => ({
            id,
            origin: "comparison",
            eligibleSlots: 3,
            allowedSlots: n + 1,
            blockedSlots: 2 - n,
            selectedSourceSlots: n + 1,
            renderedLines: 1,
            reasons: { scope_blocked: 2 - n },
            details: [
              {
                text: "这是服务器合成返回的策略预览。",
                mixedScopes: n > 0,
                sourceSlots: items
                  .slice(0, n + 1)
                  .map((i) => ({ key: i.key, scope: i.scope })),
              },
            ],
          })),
        });
      if (p === "subjects") return wrap({ items: subjects, nextCursor: null });
      if (p.startsWith("subjects/")) {
        const s = subjects.find((s) => s.id === p.split("/")[1]);
        return wrap({
          subject: s,
          resolvedSubjectId: s.id,
          observations,
          groups: [
            {
              aspect: "进度",
              relation: "unknown",
              observationIds: ["obs-1", "obs-2"],
            },
          ],
        });
      }
      if (p === "working")
        return {
          ok: true,
          counts: { pending: 2, promoted: 1 },
          chats: [
            { chatKey: "group:100", chatLabel: "合成测试场合", count: 2 },
          ],
        };
      if (p === "working/items")
        return {
          ok: true,
          items: [
            {
              id: "demo-event",
              title: "合成工作记录",
              summary: "用于页面验证的事件摘要",
              state: "pending",
              toTs: "2026-10-29",
            },
          ],
        };
      if (p === "instances") return { ok: true, instances: [], problems: [] };
      throw new ApiError(501, { error: "演示未实现此接口" });
    },
    async write(path, body) {
      if (replay.has(body.operationId)) return replay.get(body.operationId);
      if (body.expectedInstanceId !== instanceId)
        throw new ApiError(409, {
          error: "实例不匹配",
          code: "INSTANCE_MISMATCH",
        });
      if (path === "memory/revisions") {
        if (body.value?.includes("[503]"))
          throw new ApiError(503, { error: "演示：存储暂不可用" });
        if (body.value?.includes("[409]"))
          throw new ApiError(409, {
            error: "演示：版本冲突",
            currentEtag: "demo-new-etag",
          });
        const i = items.find((i) => i.key === body.target.key);
        if (body.expectedEtag !== i.etag)
          throw new ApiError(409, { error: "版本冲突" });
        if (body.op === "replace") {
          i.value = body.value;
          i.origin = "manual";
        }
        i.hidden = body.op === "hide";
        if (body.op === "restore") i.value = i.originalValue;
        i.etag = "demo-" + crypto.randomUUID();
        const r = wrap({ item: i, etag: i.etag });
        replay.set(body.operationId, r);
        return r;
      }
      let s = subjects.find((s) => s.id === path.split("/")[1]);
      if (path === "subjects") {
        s = {
          ...body,
          id: crypto.randomUUID(),
          aliases: [],
          status: "active",
          rev: 1,
        };
        subjects.push(s);
      } else if (path.endsWith("/aliases")) {
        s.aliases = body.aliases;
        s.rev++;
      } else if (path.endsWith("/merge")) {
        s.status = "merged";
        s.mergedInto = body.intoId;
        s.rev++;
      } else if (path.endsWith("/unmerge")) {
        s.status = "active";
        s.mergedInto = null;
        s.rev++;
      }
      const r = wrap({ subject: s, affectedObservationIds: [] });
      replay.set(body.operationId, r);
      return r;
    },
  };
}
