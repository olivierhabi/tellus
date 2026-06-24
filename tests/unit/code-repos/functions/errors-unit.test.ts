// ---------------------------------------------------------------------------
// B8 — Functions Registry error catalog unit tests.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  FUNCTIONS_ERROR_NAMES,
  functionsError,
  isFunctionsErrorName,
  type FunctionsErrorName,
} from "../../../../src/services/functionsRegistry/errors";
import {
  ERROR_NAME_REGEX,
  isExactEnvelope,
} from "../../../../src/services/codeRepos/contracts/errors";

describe("Functions Registry error catalog", () => {
  it("enumerates the 5 spec-mandated names plus cross-cutting names; all unique", () => {
    // Spec §B8 mandates 5 names. Wave 15 adds cross-cutting names (InvalidArgument,
    // Unauthenticated, PermissionDenied, Internal) needed by the HTTP route layer
    // for input validation, auth, and 5xx — same pattern as B2's CodeRepos catalog.
    const SPEC_MANDATED = [
      "Functions:VersionImmutable",
      "Functions:VersionNotFound",
      "Functions:VersionTargetUnsatisfied",
      "Functions:RepositoryNotPublishable",
      "Functions:ArtifactCorrupt",
    ];
    for (const n of SPEC_MANDATED) {
      expect(FUNCTIONS_ERROR_NAMES).toContain(n);
    }
    // Uniqueness invariant must hold regardless of count.
    expect(new Set(FUNCTIONS_ERROR_NAMES).size).toBe(FUNCTIONS_ERROR_NAMES.length);
  });

  it.each(FUNCTIONS_ERROR_NAMES)("error name %s conforms to §1.6 ERROR_NAME_REGEX", (n) => {
    expect(ERROR_NAME_REGEX.test(n)).toBe(true);
  });

  it("status mapping matches spec §B8", () => {
    expect(functionsError("Functions:VersionImmutable").status).toBe(409);
    expect(functionsError("Functions:VersionNotFound").status).toBe(404);
    expect(functionsError("Functions:VersionTargetUnsatisfied").status).toBe(404);
    expect(functionsError("Functions:RepositoryNotPublishable").status).toBe(412);
    expect(functionsError("Functions:ArtifactCorrupt").status).toBe(400);
  });

  it("envelope is exactly the §1.3 4-key shape", () => {
    const { envelope } = functionsError("Functions:VersionNotFound", {
      semver: "1.2.3",
    });
    expect(isExactEnvelope(envelope)).toBe(true);
    expect(envelope.errorName).toBe("Functions:VersionNotFound");
  });

  it("parameters propagate; auth fields stripped", () => {
    const { envelope } = functionsError("Functions:VersionImmutable", {
      semver: "1.0.0",
      authorization: "secret",
    });
    expect(envelope.parameters.semver).toBe("1.0.0");
    expect("authorization" in envelope.parameters).toBe(false);
  });

  it("custom errorInstanceId preserved", () => {
    const { envelope } = functionsError(
      "Functions:VersionImmutable",
      {},
      "instance-42",
    );
    expect(envelope.errorInstanceId).toBe("instance-42");
  });

  it("isFunctionsErrorName: positive + negative", () => {
    expect(isFunctionsErrorName("Functions:VersionImmutable")).toBe(true);
    expect(isFunctionsErrorName("Stemma:RefUpdateRejected")).toBe(false);
    expect(isFunctionsErrorName("Functions:Bogus")).toBe(false);
  });

  it("envelope.errorName always begins with Functions:", () => {
    for (const n of FUNCTIONS_ERROR_NAMES) {
      const { envelope } = functionsError(n as FunctionsErrorName);
      expect(envelope.errorName.startsWith("Functions:")).toBe(true);
    }
  });
});
