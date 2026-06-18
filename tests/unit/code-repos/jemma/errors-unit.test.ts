// ---------------------------------------------------------------------------
// B6 — Jemma error catalog unit tests.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  JEMMA_ERROR_NAMES,
  isJemmaErrorName,
  jemmaError,
  type JemmaErrorName,
} from "../../../../src/services/jemma/errors";
import {
  ERROR_NAME_REGEX,
  isExactEnvelope,
} from "../../../../src/services/codeRepos/contracts/errors";

describe("Jemma error catalog", () => {
  it("enumerates exactly 5 error names per spec §B6", () => {
    expect(JEMMA_ERROR_NAMES.length).toBe(5);
    expect(new Set(JEMMA_ERROR_NAMES).size).toBe(5);
  });

  it.each(JEMMA_ERROR_NAMES)("error name %s conforms to §1.6 ERROR_NAME_REGEX", (n) => {
    expect(ERROR_NAME_REGEX.test(n)).toBe(true);
  });

  it("status mapping matches spec §B6", () => {
    expect(jemmaError("Jemma:RunNotFound").status).toBe(404);
    expect(jemmaError("Jemma:RunAlreadyTerminal").status).toBe(409);
    expect(jemmaError("Jemma:CapacityExceeded").status).toBe(429);
    expect(jemmaError("Jemma:WorkerImageUnavailable").status).toBe(503);
    expect(jemmaError("Jemma:StageFailed").status).toBe(500);
  });

  it("envelope is exactly the §1.3 4-key shape", () => {
    const { envelope } = jemmaError("Jemma:RunNotFound", { rid: "ri.jemma.main.run.x" });
    expect(isExactEnvelope(envelope)).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual([
      "errorCode",
      "errorInstanceId",
      "errorName",
      "parameters",
    ]);
  });

  it("parameters are propagated and sanitised (no auth tokens)", () => {
    const { envelope } = jemmaError("Jemma:CapacityExceeded", {
      repoRid: "ri.codeRepos.main.repository.x",
      authorization: "Bearer secret-token",
      capacityRemaining: 0,
    });
    expect(envelope.parameters.repoRid).toBe("ri.codeRepos.main.repository.x");
    expect(envelope.parameters.capacityRemaining).toBe(0);
    expect("authorization" in envelope.parameters).toBe(false);
  });

  it("custom errorInstanceId is preserved", () => {
    const { envelope } = jemmaError("Jemma:RunNotFound", {}, "instance-abc");
    expect(envelope.errorInstanceId).toBe("instance-abc");
  });

  it("status determinism: same name → same status across calls", () => {
    const a = jemmaError("Jemma:WorkerImageUnavailable").status;
    const b = jemmaError("Jemma:WorkerImageUnavailable").status;
    expect(a).toBe(b);
  });

  it("isJemmaErrorName: positive + negative", () => {
    expect(isJemmaErrorName("Jemma:RunNotFound")).toBe(true);
    expect(isJemmaErrorName("Stemma:RefUpdateRejected")).toBe(false);
    expect(isJemmaErrorName("Jemma:Bogus")).toBe(false);
  });

  it("envelope.errorName always begins with Jemma:", () => {
    for (const n of JEMMA_ERROR_NAMES) {
      const { envelope } = jemmaError(n as JemmaErrorName);
      expect(envelope.errorName.startsWith("Jemma:")).toBe(true);
    }
  });
});
