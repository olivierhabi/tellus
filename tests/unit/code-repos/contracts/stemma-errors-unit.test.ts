// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/stemma-errors-unit.test.ts
//
// Covers contract IDs:
//   B1-C-26 Stemma:RepositoryNotFound (404)
//   B1-C-27 Stemma:RefNotFound (404)
//   B1-C-28 Stemma:RefUpdateRejected (409)
//   B1-C-29 Stemma:ProtectedBranchViolation (403)
//   B1-C-30 Stemma:RepositorySizeExceeded (413)
//   B1-C-31 Stemma:PushBodyTooLarge (413)
//   B1-C-32 Stemma:InvalidPackfile (400)
//   B1-C-33 Stemma:GcInProgress (503)
//   B1-C-34 Stemma:HookTimeout (504)
//
// G-C-15 enforced as part of mapping verification.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  STEMMA_ERROR_NAMES,
  STEMMA_ERROR_CODE_MAP,
  stemmaError,
} from "../../../../src/services/stemma/errors";
import { isExactEnvelope } from "../../../../src/services/codeRepos/contracts/errors";

describe("Stemma error name → (errorCode, status) map", () => {
  type Case = readonly [keyof typeof STEMMA_ERROR_NAMES, string, number];

  const cases: readonly Case[] = [
    ["RepositoryNotFound", "Stemma:RepositoryNotFound", 404],
    ["RefNotFound", "Stemma:RefNotFound", 404],
    ["RefUpdateRejected", "Stemma:RefUpdateRejected", 409],
    ["ProtectedBranchViolation", "Stemma:ProtectedBranchViolation", 403],
    ["RepositorySizeExceeded", "Stemma:RepositorySizeExceeded", 413],
    ["PushBodyTooLarge", "Stemma:PushBodyTooLarge", 413],
    ["InvalidPackfile", "Stemma:InvalidPackfile", 400],
    ["GcInProgress", "Stemma:GcInProgress", 503],
    ["HookTimeout", "Stemma:HookTimeout", 504],
  ];

  for (const [key, errorName, expectedStatus] of cases) {
    it(`${key} → ${errorName} (${expectedStatus})`, () => {
      const { envelope, status } = stemmaError(key);
      expect(envelope.errorName).toBe(errorName);
      expect(status).toBe(expectedStatus);
      expect(isExactEnvelope(envelope)).toBe(true);
    });
  }

  it("STEMMA_ERROR_NAMES contains every B1-C-26..34 symbol", () => {
    expect(Object.keys(STEMMA_ERROR_NAMES).sort()).toEqual(
      [
        "GcInProgress",
        "HookTimeout",
        "IdempotencyConflict",
        "InvalidPackfile",
        "ProtectedBranchViolation",
        "PushBodyTooLarge",
        "RefNotFound",
        "RefUpdateRejected",
        "RepositoryNotFound",
        "RepositorySizeExceeded",
        "StaleEtag",
      ].sort()
    );
  });

  it("every name in the symbol map has a status mapping", () => {
    for (const errorName of Object.values(STEMMA_ERROR_NAMES)) {
      expect(STEMMA_ERROR_CODE_MAP[errorName]).toBeDefined();
    }
  });
});

describe("RefUpdateRejected carries newTip in parameters (B1-C-28, B1-C-50)", () => {
  it("propagates newTip safely", () => {
    const { envelope, status } = stemmaError("RefUpdateRejected", {
      ref: "refs/heads/main",
      newTip: "abc1234567890",
    });
    expect(status).toBe(409);
    expect(envelope.parameters).toEqual({
      ref: "refs/heads/main",
      newTip: "abc1234567890",
    });
  });

  it("strips secrets from parameters even on Stemma errors", () => {
    const { envelope } = stemmaError("RefUpdateRejected", {
      newTip: "abc",
      password: "leak",
      authorization: "Bearer leak",
    });
    expect("password" in envelope.parameters).toBe(false);
    expect("authorization" in envelope.parameters).toBe(false);
    expect((envelope.parameters as Record<string, unknown>).newTip).toBe("abc");
  });
});
