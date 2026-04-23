// ---------------------------------------------------------------------------
// tests/unit/security/cbacPolicy-unit.test.ts
//
// F-P3-18 negative test matrix for the CBAC policy evaluator.
//
// Pre-fix behaviour: routes/actions.ts, routes/search.ts, routes/audit.ts,
// routes/branches.ts had 0 references to req.security. Any authenticated
// user could POST any Action regardless of role, markings, or denylist.
//
// Post-fix behaviour: every data-plane route composes a Policy from the
// resource row, evaluates it against the Subject, and fails closed on
// miss. The evaluator below is the pure function that powers every one
// of those routes.
//
// This suite covers the full 5-reason deny matrix + allow paths + the
// default-deny invariant for missing policy.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
  observeHistogram: vi.fn(),
}));

import {
  evaluate,
  evaluateAndObserve,
  subjectFromRequest,
  type Subject,
  type Policy,
  type PolicyContext,
} from "../../../src/services/security/cbacPolicy";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    resourceKind: "action_type",
    resourceId: "testAction",
    ontologyId: "o1",
    sourceIp: null,
    requestId: null,
    ...overrides,
  };
}

function alice(overrides: Partial<Subject> = {}): Subject {
  return {
    kind: "user",
    identifier: "alice",
    roles: ["rra-tax-auditor"],
    groups: ["rra-officers"],
    markings: ["UNCLASSIFIED"],
    ...overrides,
  };
}

const anonymous: Subject = {
  kind: "anonymous",
  identifier: "anonymous",
  roles: [],
  groups: [],
  markings: [],
};

describe("F-P3-18: evaluate() — default-deny invariant", () => {
  it("missing policy → decision=deny reason=missing_policy_default_deny", () => {
    const d = evaluate(alice(), null, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("missing_policy_default_deny");
  });

  it("F-P3-18 negative: pre-fix behaviour ('no policy means open') is REJECTED — policy=null must DENY", () => {
    // Against a hypothetical pre-fix evaluator that treats null policy as
    // "no restrictions", this same call would have returned allow. The
    // post-fix evaluator fails closed.
    expect(evaluate(alice(), null, ctx()).decision).toBe("deny");
    expect(evaluate(anonymous, null, ctx()).decision).toBe("deny");
  });
});

describe("F-P3-18: evaluate() — anonymous denial", () => {
  it("anonymous + allowlist with no {type:any} → deny/anonymous_denied", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    const d = evaluate(anonymous, policy, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("anonymous_denied");
  });

  it("anonymous + allowlist containing {type:any} → allow (explicit anonymous opt-in)", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "any" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    const d = evaluate(anonymous, policy, ctx());
    expect(d.decision).toBe("allow");
  });

  it("any_authenticated does NOT match anonymous", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(anonymous, policy, ctx()).decision).toBe("deny");
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });
});

describe("F-P3-18: evaluate() — denylist precedence", () => {
  it("denylist match beats allowlist match", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "user", username: "alice" }],
      deniedPrincipals: [{ type: "user", username: "alice" }],
      requiredMarkings: [],
    };
    const d = evaluate(alice(), policy, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("denylist_match");
    expect(d.matchedRule).toEqual({ type: "user", username: "alice" });
  });

  it("denylist by role denies even if user is in allowlist by group", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "group", group: "rra-officers" }],
      deniedPrincipals: [{ type: "role", role: "rra-tax-auditor" }],
      requiredMarkings: [],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("deny");
  });
});

describe("F-P3-18: evaluate() — allowlist gate", () => {
  it("non-matching subject denied with reason=no_allowlist_match", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "user", username: "bob" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    const d = evaluate(alice(), policy, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("no_allowlist_match");
  });

  it("matching user selector → allow", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "user", username: "alice" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });

  it("matching role selector → allow", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "role", role: "rra-tax-auditor" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });

  it("matching group selector → allow", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "group", group: "rra-officers" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });

  it("null allowlist + no denylist + no markings → allow (open-auth)", () => {
    const policy: Policy = {
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });
});

describe("F-P3-18: evaluate() — markings cover", () => {
  it("subject holds all required markings → allow", () => {
    const policy: Policy = {
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: ["UNCLASSIFIED"],
    };
    expect(evaluate(alice(), policy, ctx()).decision).toBe("allow");
  });

  it("subject missing a required marking → deny/markings_insufficient with missing list", () => {
    const policy: Policy = {
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: ["UNCLASSIFIED", "TAXPAYER-PII"],
    };
    const d = evaluate(alice(), policy, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("markings_insufficient");
    expect(d.matchedRule).toEqual({
      kind: "markings",
      required: ["UNCLASSIFIED", "TAXPAYER-PII"],
      missing: ["TAXPAYER-PII"],
    });
  });

  it("empty requiredMarkings → never denied on markings", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "any_authenticated" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    expect(evaluate(alice({ markings: [] }), policy, ctx()).decision).toBe("allow");
  });

  it("subject with no markings denied when required is non-empty", () => {
    const policy: Policy = {
      allowedPrincipals: null,
      deniedPrincipals: null,
      requiredMarkings: ["TAXPAYER-PII"],
    };
    const d = evaluate(alice({ markings: [] }), policy, ctx());
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("markings_insufficient");
  });
});

describe("F-P3-18: evaluateAndObserve emits Prometheus counters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits tellus_cbac_allow_total on allow", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "user", username: "alice" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    evaluateAndObserve(alice(), policy, ctx());
    expect(incMock).toHaveBeenCalledWith(
      "tellus_cbac_allow_total",
      expect.objectContaining({ resource_kind: "action_type", reason: "allow" }),
    );
  });

  it("emits tellus_cbac_deny_total on deny with reason label", () => {
    const policy: Policy = {
      allowedPrincipals: [{ type: "user", username: "bob" }],
      deniedPrincipals: null,
      requiredMarkings: [],
    };
    evaluateAndObserve(alice(), policy, ctx());
    expect(incMock).toHaveBeenCalledWith(
      "tellus_cbac_deny_total",
      expect.objectContaining({
        resource_kind: "action_type",
        reason: "no_allowlist_match",
        subject_kind: "user",
      }),
    );
  });

  it("emits missing_policy_default_deny counter on null policy", () => {
    evaluateAndObserve(alice(), null, ctx());
    expect(incMock).toHaveBeenCalledWith(
      "tellus_cbac_deny_total",
      expect.objectContaining({ reason: "missing_policy_default_deny" }),
    );
  });
});

describe("F-P3-18: subjectFromRequest", () => {
  it("empty req → anonymous", () => {
    const s = subjectFromRequest({});
    expect(s.kind).toBe("anonymous");
    expect(s.identifier).toBe("anonymous");
    expect(s.roles).toEqual([]);
  });

  it("req.auth with preferred_username → user kind", () => {
    const s = subjectFromRequest({
      auth: {
        preferred_username: "alice",
        realm_access: { roles: ["rra-tax-auditor"] },
        groups: ["rra-officers"],
        markings: ["UNCLASSIFIED"],
      },
    });
    expect(s.kind).toBe("user");
    expect(s.identifier).toBe("alice");
    expect(s.roles).toContain("rra-tax-auditor");
    expect(s.groups).toContain("rra-officers");
    expect(s.markings).toContain("UNCLASSIFIED");
  });

  it("req.auth.azp starts with svc- → service kind", () => {
    const s = subjectFromRequest({
      auth: { sub: "svc-1", azp: "svc-indexer" },
    });
    expect(s.kind).toBe("service");
  });

  it("req.auth.token_type='pat' → token kind", () => {
    const s = subjectFromRequest({
      auth: { sub: "pat-abc", token_type: "pat" },
    });
    expect(s.kind).toBe("token");
  });

  it("req.security overrides req.auth for markings", () => {
    const s = subjectFromRequest({
      auth: { preferred_username: "alice", markings: ["UNCLASSIFIED"] },
      security: { subject: "alice", markings: ["TAXPAYER-PII"] },
    });
    expect(s.markings).toEqual(["TAXPAYER-PII"]);
  });
});
