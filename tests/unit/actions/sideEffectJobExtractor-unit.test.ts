// ---------------------------------------------------------------------------
// Unit tests for src/actions/sideEffectJobExtractor.ts — Phase 5.
// Pure (no IO) — easy to test + verify the canonical extraction rules.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  extractSideEffectJobs,
} from "../../../src/actions/sideEffectJobExtractor";

const CTX = {
  executionId: "exec-1",
  actionTypeApiName: "at1",
  actionTypeId: "at1",
  actionTypeVersion: 1,
  ontologyId: "ont-1",
  executedBy: "tester",
  result: "success",
  affectedObjects: [],
  firedAt: "2026-07-25T00:00:00Z",
};

describe("sideEffectJobExtractor", () => {
  it("returns [] for null/empty/[] side effects", () => {
    expect(extractSideEffectJobs(null, CTX)).toEqual([]);
    expect(extractSideEffectJobs(undefined, CTX)).toEqual([]);
    expect(extractSideEffectJobs({}, CTX)).toEqual([]);
    expect(extractSideEffectJobs([], CTX)).toEqual([]);
  });

  it("returns [] when webhooks/notifications are absent or wrong type", () => {
    expect(extractSideEffectJobs({ webhooks: null }, CTX)).toEqual([]);
    expect(extractSideEffectJobs({ webhooks: "not-an-array" }, CTX)).toEqual([]);
    expect(extractSideEffectJobs({ notifications: {} }, CTX)).toEqual([]);
  });

  it("emits one webhook row per webhook spec entry", () => {
    const jobs = extractSideEffectJobs({
      webhooks: [
        { url: "https://example.com/a", method: "POST" },
        { url: "https://example.com/b" },
      ],
    }, CTX);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.kind === "webhook")).toBe(true);
    expect((jobs[0].payload as any).spec.url).toBe("https://example.com/a");
    expect((jobs[1].payload as any).spec.url).toBe("https://example.com/b");
    expect((jobs[0].payload as any).context.executionId).toBe("exec-1");
    expect(jobs[0].idempotencySeed).toBe("wb:0");
    expect(jobs[1].idempotencySeed).toBe("wb:1");
  });

  it("skips malformed webhook entries (non-object / null)", () => {
    const jobs = extractSideEffectJobs({
      webhooks: [
        null,
        "not-an-object",
        { url: "https://example.com/ok" },
        123,
      ],
    }, CTX);
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as any).spec.url).toBe("https://example.com/ok");
  });

  it("emits one notification row per (spec, recipient) — two recipients ⇒ two jobs", () => {
    const jobs = extractSideEffectJobs({
      notifications: [
        { templateId: "t1", recipients: [{ principal: "alice" }, { principal: "bob" }] },
        { templateId: "t2", recipients: [{ principal: "carol" }] },
      ],
    }, CTX);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.kind === "notification")).toBe(true);
    // 0..1 from t1; 2 from t2.
    const allPrincipals = jobs.map((j) => (j.payload as any).recipient.principal);
    expect(allPrincipals.sort()).toEqual(["alice", "bob", "carol"]);
    expect((jobs[0].payload as any).spec.templateId).toBe("t1");
    expect((jobs[0].payload as any).recipientIndex).toBe(0);
    expect(jobs[0].idempotencySeed).toBe("notif:0:0");
    expect(jobs[2].idempotencySeed).toBe("notif:1:0");
  });

  it("drops a notification spec with empty recipients — no rows generated", () => {
    const jobs = extractSideEffectJobs({
      notifications: [{ templateId: "t1", recipients: [] }],
    }, CTX);
    expect(jobs).toHaveLength(0);
  });

  it("drops malformed notification entries", () => {
    const jobs = extractSideEffectJobs({
      notifications: [
        null,
        "broken",
        { templateId: "t1", recipients: [{ principal: "alice" }] },
        { recipients: [{ principal: "x" }] }, // missing templateId — still emitted (providers reject)
      ],
    }, CTX);
    expect(jobs).toHaveLength(2);
  });

  it("emits mixed webhook + notifications — ordering = webhooks first, then notifications", () => {
    const jobs = extractSideEffectJobs({
      webhooks: [{ url: "https://example.com" }],
      notifications: [{ templateId: "t", recipients: [{ principal: "alice" }] }],
    }, CTX);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].kind).toBe("webhook");
    expect(jobs[1].kind).toBe("notification");
  });

  it("context is propagated verbatim into every job payload", () => {
    const ctx = { ...CTX, firedAt: "2026-01-01T12:00:00Z" };
    const jobs = extractSideEffectJobs({
      webhooks: [{ url: "https://example.com" }],
      notifications: [{ templateId: "t", recipients: [{ principal: "a" }] }],
    }, ctx);
    expect(jobs.every((j) => (j.payload as any).context === ctx)).toBe(true);
  });
});
