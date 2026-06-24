// ---------------------------------------------------------------------------
// tests/unit/code-repos/stemma-events/branch-protection-errors-unit.test.ts
//
// Spec contracts:
//   B10-C-16  BranchProtection:DeleteProtected (403)
//   B10-C-17  BranchProtection:ForcePushProtected (403)
//   B10-C-18  BranchProtection:RequiresPullRequest (403)
//   B10-C-19  BranchProtection:InsufficientApprovals (403)
//   B10-C-20  BranchProtection:RegexViolation (400)
//   plus     BranchProtection:TagImmutable (403) — D-2026-05-01-004
//
// Each name is mapped to its HTTP status; the envelope is the §1.3
// shape (errorCode + errorName + errorInstanceId + parameters).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  branchProtectionError,
  BRANCH_PROTECTION_STATUS,
  type BranchProtectionErrorName,
} from "../../../../src/services/stemmaEvents/errors";
import { isExactEnvelope } from "../../../../src/services/codeRepos/contracts/errors";

const NAMES: BranchProtectionErrorName[] = [
  "BranchProtection:DeleteProtected",
  "BranchProtection:ForcePushProtected",
  "BranchProtection:RequiresPullRequest",
  "BranchProtection:InsufficientApprovals",
  "BranchProtection:RegexViolation",
  "BranchProtection:TagImmutable",
];

describe("B10-C-16..20 BranchProtection error names", () => {
  it("status table is exhaustive — every name has a status + errorCode", () => {
    for (const name of NAMES) {
      expect(BRANCH_PROTECTION_STATUS[name]).toBeDefined();
      expect([400, 403]).toContain(BRANCH_PROTECTION_STATUS[name].httpStatus);
      expect(typeof BRANCH_PROTECTION_STATUS[name].errorCode).toBe("string");
    }
  });

  it("status mapping per spec", () => {
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:DeleteProtected"].httpStatus).toBe(403);
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:ForcePushProtected"].httpStatus).toBe(403);
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:RequiresPullRequest"].httpStatus).toBe(403);
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:InsufficientApprovals"].httpStatus).toBe(403);
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:RegexViolation"].httpStatus).toBe(400);
    expect(BRANCH_PROTECTION_STATUS["BranchProtection:TagImmutable"].httpStatus).toBe(403);
  });

  it("each name produces a valid §1.3 envelope", () => {
    for (const name of NAMES) {
      const out = branchProtectionError(name, { ref: "refs/heads/main" });
      expect(isExactEnvelope(out.envelope)).toBe(true);
      expect(out.envelope.errorName).toBe(name);
      expect(out.envelope.parameters.ref).toBe("refs/heads/main");
    }
  });

  it("403 envelopes use PERMISSION_DENIED errorCode", () => {
    const out = branchProtectionError("BranchProtection:DeleteProtected", {});
    expect(out.envelope.errorCode).toBe("PERMISSION_DENIED");
  });

  it("400 envelopes use INVALID_ARGUMENT errorCode", () => {
    const out = branchProtectionError("BranchProtection:RegexViolation", {});
    expect(out.envelope.errorCode).toBe("INVALID_ARGUMENT");
  });

  it("rejects an unknown name", () => {
    expect(() =>
      branchProtectionError(
        "BranchProtection:Bogus" as BranchProtectionErrorName,
        {},
      ),
    ).toThrow(/Unknown BranchProtection error name/);
  });
});
