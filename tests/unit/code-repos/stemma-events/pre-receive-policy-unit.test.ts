// ---------------------------------------------------------------------------
// tests/unit/code-repos/stemma-events/pre-receive-policy-unit.test.ts
//
// Pure-logic tests for B10 pre-receive decision. No I/O.
//
// Spec contracts asserted (one or more tests fail if any is violated):
//   B10-C-04  Checks run IN ORDER, fail-fast: regex → protected → tag → Compass
//   B10-C-05  Step 1 — branch/tag name regex; failure → BranchProtection:RegexViolation
//   B10-C-06  Step 2 — protected branch + isDelete → DeleteProtected
//   B10-C-07  Step 2 — protected branch + isForce → ForcePushProtected
//   B10-C-08  Step 2 — protected branch + requirePullRequest + direct → RequiresPullRequest
//   B10-C-09  Step 3 — tag delete or update → TagImmutable unless principal is OWNER
//   B10-C-10  Step 4 — Compass.canAct DENY → Compass:PermissionDenied
//   B10-C-21  repoSettings change in same push uses OLD settings
//             (the function only reads the snapshot we hand it; verified
//             by passing pre-push settings and asserting decisions).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { preReceiveDecision } from "../../../../src/services/stemmaEvents/policy/preReceive";
import type {
  PushContext,
  RefUpdate,
} from "../../../../src/services/stemmaEvents/policy/types";

const SHA = (h: string) => h.padStart(40, "0").slice(-40);

const baseSettings = {
  branchNameValidation: "[a-zA-Z0-9._/-]{1,255}",
  tagNameValidation: "v[0-9]+(\\.[0-9]+){0,2}",
  protectedBranches: ["main", "release/*"] as const,
  requirePullRequest: true,
};

function ctx(overrides: Partial<PushContext> = {}): PushContext {
  return {
    repositoryRid: "ri.stemma.main.repository.test",
    principal: { userId: "u1", roles: ["EDITOR"] },
    settings: baseSettings,
    viaPullRequest: false,
    ...overrides,
  };
}

function refUpdate(over: Partial<RefUpdate> = {}): RefUpdate {
  return {
    ref: "refs/heads/feature",
    oldSha: SHA("a1"),
    newSha: SHA("b2"),
    isCreate: false,
    isDelete: false,
    isForce: false,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// B10-C-04 ordering
// -----------------------------------------------------------------------------
describe("B10-C-04 fail-fast ordering", () => {
  it("a regex failure blocks ALL later checks (Compass not consulted)", async () => {
    let compassCalled = false;
    const out = await preReceiveDecision(
      [
        refUpdate({
          ref: "refs/heads/has spaces",
        }),
      ],
      ctx({
        canActAsEditor: () => {
          compassCalled = true;
          return false;
        },
      }),
    );
    expect(out[0].kind).toBe("deny");
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RegexViolation");
    expect(compassCalled).toBe(false);
  });

  it("a protected-delete failure blocks Compass (Compass not consulted)", async () => {
    let compassCalled = false;
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main", isDelete: true })],
      ctx({
        canActAsEditor: () => {
          compassCalled = true;
          return true;
        },
      }),
    );
    expect(out[0].kind).toBe("deny");
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:DeleteProtected");
    expect(compassCalled).toBe(false);
  });

  it("ordered: regex check happens BEFORE protected-branch check", async () => {
    // Bad regex AND protected delete — the regex denial should win.
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main with space", isDelete: true })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RegexViolation");
  });
});

// -----------------------------------------------------------------------------
// B10-C-05 regex
// -----------------------------------------------------------------------------
describe("B10-C-05 regex validation", () => {
  it("ALLOWS a branch matching the regex when not protected and PR not required", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/feature/clean-name" })],
      ctx({
        settings: { ...baseSettings, requirePullRequest: false },
      }),
    );
    expect(out[0].kind).toBe("allow");
  });

  it("DENIES a branch with chars outside the regex character class", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/has spaces" })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RegexViolation");
    expect(out[0].httpStatus).toBe(400);
    expect(out[0].parameters.regex).toBe(baseSettings.branchNameValidation);
  });

  it("DENIES a tag with chars outside the tag regex", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/not-a-version", isCreate: true })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RegexViolation");
  });

  it("ALLOWS a tag matching v<semver>", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/v1.2.3", isCreate: true })],
      ctx(),
    );
    expect(out[0].kind).toBe("allow");
  });

  it("malformed regex from settings → DENIES (fail-closed)", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/anything" })],
      ctx({
        settings: {
          ...baseSettings,
          branchNameValidation: "[unterminated",
        },
      }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RegexViolation");
  });
});

// -----------------------------------------------------------------------------
// B10-C-06..08 protected branch
// -----------------------------------------------------------------------------
describe("B10-C-06..08 protected-branch policy", () => {
  it("B10-C-06: delete on protected `main` → DeleteProtected", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main", isDelete: true })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:DeleteProtected");
    expect(out[0].httpStatus).toBe(403);
  });

  it("B10-C-07: force-push to protected `main` → ForcePushProtected", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main", isForce: true })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:ForcePushProtected");
  });

  it("B10-C-08: direct push to protected `main` when PR required → RequiresPullRequest", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main" })],
      ctx({ viaPullRequest: false }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:RequiresPullRequest");
  });

  it("B10-C-08: PR-merge push to protected `main` is ALLOWED", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/main" })],
      ctx({ viaPullRequest: true }),
    );
    expect(out[0].kind).toBe("allow");
  });

  it("glob `release/*` matches `release/2026-05`", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/release/2026-05", isDelete: true })],
      ctx(),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:DeleteProtected");
  });

  it("glob `release/*` does NOT match `release/2026/special` (single-segment)", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/release/2026/special", isDelete: true })],
      ctx({ settings: { ...baseSettings, requirePullRequest: false } }),
    );
    expect(out[0].kind).toBe("allow");
  });
});

// -----------------------------------------------------------------------------
// B10-C-09 tag immutability
// -----------------------------------------------------------------------------
describe("B10-C-09 tag immutability", () => {
  it("non-OWNER cannot delete a tag → TagImmutable", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/v1.0.0", isDelete: true, isCreate: false })],
      ctx({ principal: { userId: "u1", roles: ["EDITOR"] } }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:TagImmutable");
    expect(out[0].parameters.reason).toBe("delete");
  });

  it("non-OWNER cannot update a tag → TagImmutable", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/v1.0.0", isCreate: false })],
      ctx({ principal: { userId: "u1", roles: ["EDITOR"] } }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("BranchProtection:TagImmutable");
    expect(out[0].parameters.reason).toBe("update");
  });

  it("OWNER can delete a tag (override)", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/v1.0.0", isDelete: true })],
      ctx({ principal: { userId: "u1", roles: ["OWNER"] } }),
    );
    expect(out[0].kind).toBe("allow");
  });

  it("anyone can create a fresh tag (no immutability for new tags)", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/tags/v2.0.0", isCreate: true })],
      ctx({ principal: { userId: "u1", roles: ["EDITOR"] } }),
    );
    expect(out[0].kind).toBe("allow");
  });
});

// -----------------------------------------------------------------------------
// B10-C-10 Compass
// -----------------------------------------------------------------------------
describe("B10-C-10 Compass.canAct(EDITOR)", () => {
  it("DENIES with Compass:PermissionDenied when canActAsEditor returns false", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/feature" })],
      ctx({
        settings: { ...baseSettings, requirePullRequest: false },
        canActAsEditor: () => false,
      }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("Compass:PermissionDenied");
    expect(out[0].httpStatus).toBe(403);
    expect(out[0].parameters.operation).toBe("EDITOR");
  });

  it("ALLOWS when Compass returns true", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/feature" })],
      ctx({
        settings: { ...baseSettings, requirePullRequest: false },
        canActAsEditor: () => true,
      }),
    );
    expect(out[0].kind).toBe("allow");
  });

  it("supports async Compass callbacks", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/feature" })],
      ctx({
        settings: { ...baseSettings, requirePullRequest: false },
        canActAsEditor: async () =>
          new Promise((res) => setImmediate(() => res(false))),
      }),
    );
    if (out[0].kind !== "deny") throw new Error("narrow");
    expect(out[0].errorName).toBe("Compass:PermissionDenied");
  });

  it("when no Compass callback supplied, treats as ALLOW (caller responsibility)", async () => {
    const out = await preReceiveDecision(
      [refUpdate({ ref: "refs/heads/feature" })],
      ctx({
        settings: { ...baseSettings, requirePullRequest: false },
        // canActAsEditor omitted
      }),
    );
    expect(out[0].kind).toBe("allow");
  });
});

// -----------------------------------------------------------------------------
// Multiple ref updates in one call (per-ref decisions)
// -----------------------------------------------------------------------------
describe("multi-ref pushes", () => {
  it("returns one Decision per ref in input order; one ref's deny does NOT affect others", async () => {
    const out = await preReceiveDecision(
      [
        refUpdate({ ref: "refs/heads/feature" }), // ALLOW
        refUpdate({ ref: "refs/heads/main", isDelete: true }), // DENY
        refUpdate({ ref: "refs/heads/another-feature", isCreate: true }), // ALLOW
      ],
      ctx({ settings: { ...baseSettings, requirePullRequest: false } }),
    );
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe("allow");
    expect(out[1].kind).toBe("deny");
    expect(out[2].kind).toBe("allow");
  });
});
