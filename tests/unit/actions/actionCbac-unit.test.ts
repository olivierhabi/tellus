// ---------------------------------------------------------------------------
// Unit tests for src/actions/actionCbac.ts — Phase 6.1 dispatch gate.
//
// Mocks the three CBAC service modules so each test can drive a Policy
// through `runActionCbacGate` and assert the structured CbacGateResult
// without touching PG. The pure `cbacPolicy.evaluate` is exercised AGAIN
// here (it has its own dedicated suite at cbacPolicy-unit.test.ts) — the
// emphasis is on the gate's loader-fail / Evaluator-fail / log-fail
// behaviours, the backward-compat ALLOW when subjectKind is undefined,
// and the user-readable message factory.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/services/security/cbacPolicyLoader", () => ({
  loadActionTypePolicy: vi.fn(),
}));
vi.mock("../../../src/services/security/cbacDecisionLog", () => ({
  logCbacDecision: vi.fn(),
}));

// Re-import after mocks — Vitest hoists mocks, so this is safe.
import { runActionCbacGate, cbacDenyMessage, subjectFromSecurity } from "../../../src/actions/actionCbac";
import { loadActionTypePolicy } from "../../../src/services/security/cbacPolicyLoader";
import { logCbacDecision } from "../../../src/services/security/cbacDecisionLog";

const mockedLoad = loadActionTypePolicy as unknown as ReturnType<typeof vi.fn>;
const mockedLog = logCbacDecision as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  resourceKind: "action_type",
  resourceId: "testAction",
  ontologyId: "ont-1",
  sourceIp: null,
  requestId: "exec-1",
};

beforeEach(() => {
  mockedLoad.mockReset();
  mockedLog.mockReset();
  mockedLog.mockResolvedValue(undefined);
});

describe("runActionCbacGate — backward-compat", () => {
  it("returns ALLOW without touching the loader when subjectKind is undefined", async () => {
    const r = await runActionCbacGate("ont-1", "testAction", { subjectKind: undefined }, ctx);
    expect(r.decision).toBe("allow");
    expect(r.internalError).toBeNull();
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("returns ALLOW without touching the loader when security is absent entirely", async () => {
    const r = await runActionCbacGate("ont-1", "testAction", {}, ctx);
    expect(r.decision).toBe("allow");
    expect(mockedLoad).not.toHaveBeenCalled();
  });
});

describe("runActionCbacGate — backward-compat default-row policy (NULL columns)", () => {
  it("allowlist=null + requiredMarkings=[] + authenticated user → ALLOW", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: [],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
      roles: [],
      groups: [],
      subjectMarkings: [],
    }, ctx);
    expect(r.decision).toBe("allow");
    expect(r.reason).toBe("allow");
    expect(mockedLog).toHaveBeenCalledTimes(1);
  });

  it("allows anonymous only when the row's allowlist contains {type:any}", async () => {
    mockedLoad.mockResolvedValue({ allowedPrincipals: null, deniedPrincipals: null, requiredMarkings: [] });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "anonymous",
      subjectIdentifier: "anonymous",
    }, ctx);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("anonymous_denied");
  });
});

describe("runActionCbacGate — denylist", () => {
  it("deniedPrincipals match → DENY (denylist_match)", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: null,
      deniedPrincipals: [{ type: "user", username: "alice" }],
      requiredMarkings: [],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
    }, ctx);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("denylist_match");
  });
});

describe("runActionCbacGate — allowlist", () => {
  it("allowlist miss → DENY (no_allowlist_match)", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: [{ type: "role", role: "approver" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
      roles: ["viewer"],
      subjectMarkings: [],
    }, ctx);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("no_allowlist_match");
  });

  it("allowlist hit + required_markings missing → DENY (markings_insufficient with missing list)", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: ["CONFIDENTIAL", "RESTRICTED"],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
      roles: [],
      subjectMarkings: ["CONFIDENTIAL"],
    }, ctx);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("markings_insufficient");
    const matched = r.matchedRule as { kind: string; required: string[]; missing: string[] };
    expect(matched.missing).toEqual(["RESTRICTED"]);
  });

  it("allowlist hit + markings cover → ALLOW", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: ["CONFIDENTIAL"],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
      subjectMarkings: ["CONFIDENTIAL", "EXTRA"],
    }, ctx);
    expect(r.decision).toBe("allow");
  });

  it("markBypass short-circuits the markings-cover even when required is huge", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: ["TOP_SECRET", "ORCON", "TK"],
    });
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "super-admin",
      subjectMarkings: [],
      markBypass: true,
    }, ctx);
    expect(r.decision).toBe("allow");
  });
});

describe("runActionCbacGate — internal errors fail-closed", () => {
  it("loader throws → internalError with AUTHORIZATION_UNAVAILABLE", async () => {
    mockedLoad.mockRejectedValue(new Error("PG down"));
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
    }, ctx);
    expect(r.decision).toBe("deny");
    expect(r.internalError).not.toBeNull();
    expect(r.internalError?.code).toBe("AUTHORIZATION_UNAVAILABLE");
    expect(r.internalError?.detail).toContain("PG down");
    // Forensic log: best-effort — loader-failure path skips logging.
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it("forensic log failure does NOT flip an allow into a deny", async () => {
    mockedLoad.mockResolvedValue({
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: [],
    });
    mockedLog.mockRejectedValue(new Error("cbac_decision_log table gone"));
    const r = await runActionCbacGate("ont-1", "testAction", {
      subjectKind: "user",
      subjectIdentifier: "alice",
      subjectMarkings: [],
    }, ctx);
    expect(r.decision).toBe("allow");
    expect(r.internalError).toBeNull();
  });
});

describe("cbacDenyMessage", () => {
  it("markings_insufficient with missing list joins them with commas", () => {
    const r = {
      decision: "deny", reason: "markings_insufficient" as const,
      matchedRule: { kind: "markings", required: ["A", "B"], missing: ["B"] },
      internalError: null,
    };
    expect(cbacDenyMessage(r)).toBe("Missing required markings: B");
  });

  it("anonymous_denied → tracker message", () => {
    const r = { decision: "deny", reason: "anonymous_denied" as const, matchedRule: null, internalError: null };
    expect(cbacDenyMessage(r)).toContain("Anonymous access");
  });

  it("denylist_match → explicit-deny message", () => {
    const r = { decision: "deny", reason: "denylist_match" as const, matchedRule: null, internalError: null };
    expect(cbacDenyMessage(r)).toContain("explicitly denied");
  });

  it("no_allowlist_match → allowlist message", () => {
    const r = { decision: "deny", reason: "no_allowlist_match" as const, matchedRule: null, internalError: null };
    expect(cbacDenyMessage(r)).toContain("allowlist");
  });

  it("missing_policy_default_deny → fail-closed message", () => {
    const r = { decision: "deny", reason: "missing_policy_default_deny" as const, matchedRule: null, internalError: null };
    expect(cbacDenyMessage(r)).toContain("fail-closed");
  });
});

describe("subjectFromSecurity", () => {
  it("markBypass true → subject carries the provided markings (bypass is applied OUTSIDE the evaluator)", () => {
    const s = subjectFromSecurity({
      subjectKind: "user",
      subjectIdentifier: "super-admin",
      roles: ["tellus-superadmin"],
      groups: [],
      subjectMarkings: [],
      markBypass: true,
    });
    expect(s.markings).toEqual([]);
  });

  it("markBypass false → subject carries the provided markings verbatim", () => {
    const s = subjectFromSecurity({
      subjectKind: "user",
      subjectIdentifier: "alice",
      subjectMarkings: ["CONFIDENTIAL", "RESTRICTED"],
      markBypass: false,
    });
    expect(s.markings).toEqual(["CONFIDENTIAL", "RESTRICTED"]);
  });
});
