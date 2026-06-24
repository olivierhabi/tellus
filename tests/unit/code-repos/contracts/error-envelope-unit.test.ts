// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/error-envelope-unit.test.ts
//
// Covers contract IDs:
//   G-C-12 envelope shape exactly {errorCode, errorName, errorInstanceId, parameters}
//   G-C-13 errorCode enumeration
//   G-C-14 namespaced errorName: <Service>:<Symbol>
//   G-C-15 HTTP status mapping
//   G-C-16 parameters denylist (no secrets)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildEnvelope,
  isExactEnvelope,
  ERROR_CODES,
  ERROR_CODE_TO_HTTP_STATUS,
  envelopeStatusCode,
  sanitizeParameters,
  ERROR_NAME_REGEX,
} from "../../../../src/services/codeRepos/contracts/errors";

describe("G-C-12 envelope shape", () => {
  it("buildEnvelope returns exactly the four contract keys", () => {
    const env = buildEnvelope({
      errorCode: ERROR_CODES.NOT_FOUND,
      errorName: "Stemma:RepositoryNotFound",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["errorCode", "errorInstanceId", "errorName", "parameters"]
    );
  });

  it("isExactEnvelope rejects an envelope with extra top-level keys", () => {
    const bad = {
      errorCode: "NOT_FOUND",
      errorName: "Stemma:RepositoryNotFound",
      errorInstanceId: "x",
      parameters: {},
      message: "leak",
    } as const;
    expect(isExactEnvelope(bad)).toBe(false);
  });

  it("isExactEnvelope accepts a well-formed envelope", () => {
    const env = buildEnvelope({
      errorCode: ERROR_CODES.CONFLICT,
      errorName: "Stemma:RefUpdateRejected",
      parameters: { newTip: "abc123" },
    });
    expect(isExactEnvelope(env)).toBe(true);
  });
});

describe("G-C-13 errorCode enumeration", () => {
  it("contains the 10 codes from spec §1.3 plus UNAUTHENTICATED (D-2026-05-01-002)", () => {
    // The spec enumerates 10 codes but G-C-08 mandates a 401 with
    // `Stemma:Unauthenticated`. Per the Decision Protocol we add
    // UNAUTHENTICATED as the 11th code (mapped to 401). See
    // decisions/code-repository/D-2026-05-01-002-unauthenticated-error-code.md.
    expect(Object.values(ERROR_CODES).sort()).toEqual([
      "CONFLICT",
      "DEADLINE_EXCEEDED",
      "FAILED_PRECONDITION",
      "INTERNAL",
      "INVALID_ARGUMENT",
      "NOT_FOUND",
      "PERMISSION_DENIED",
      "QOS_THROTTLE",
      "RESOURCE_EXHAUSTED",
      "UNAUTHENTICATED",
      "UNAVAILABLE",
    ]);
  });

  it("D-2026-05-01-002: UNAUTHENTICATED maps to HTTP 401", async () => {
    const { ERROR_CODE_TO_HTTP_STATUS } = await import(
      "../../../../src/services/codeRepos/contracts/errors"
    );
    expect(ERROR_CODE_TO_HTTP_STATUS.UNAUTHENTICATED).toBe(401);
  });

  it("isExactEnvelope rejects an unknown errorCode", () => {
    const bad = {
      errorCode: "BANANA",
      errorName: "Stemma:RepositoryNotFound",
      errorInstanceId: "x",
      parameters: {},
    } as const;
    expect(isExactEnvelope(bad)).toBe(false);
  });
});

describe("G-C-14 errorName namespacing", () => {
  it("regex matches PascalNamespace:PascalSymbol", () => {
    expect(ERROR_NAME_REGEX.test("Stemma:RefUpdateRejected")).toBe(true);
    expect(ERROR_NAME_REGEX.test("CodeRepos:NameConflict")).toBe(true);
    expect(ERROR_NAME_REGEX.test("Functions:VersionImmutable")).toBe(true);
  });

  it("regex rejects unnamespaced or wrongly cased names", () => {
    expect(ERROR_NAME_REGEX.test("RefUpdateRejected")).toBe(false);
    expect(ERROR_NAME_REGEX.test("stemma:RefUpdateRejected")).toBe(false);
    expect(ERROR_NAME_REGEX.test("Stemma:refUpdateRejected")).toBe(false);
    expect(ERROR_NAME_REGEX.test("Stemma::Foo")).toBe(false);
  });

  it("buildEnvelope throws when errorName violates the regex", () => {
    expect(() =>
      buildEnvelope({
        errorCode: ERROR_CODES.NOT_FOUND,
        errorName: "not-namespaced",
      })
    ).toThrow(/PascalNamespace/);
  });
});

describe("G-C-15 HTTP status mapping", () => {
  it("maps every errorCode to the spec's HTTP status", () => {
    expect(ERROR_CODE_TO_HTTP_STATUS.INVALID_ARGUMENT).toBe(400);
    expect(ERROR_CODE_TO_HTTP_STATUS.PERMISSION_DENIED).toBe(403);
    expect(ERROR_CODE_TO_HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_CODE_TO_HTTP_STATUS.CONFLICT).toBe(409);
    expect(ERROR_CODE_TO_HTTP_STATUS.FAILED_PRECONDITION).toBe(412);
    expect(ERROR_CODE_TO_HTTP_STATUS.RESOURCE_EXHAUSTED).toBe(429);
    expect(ERROR_CODE_TO_HTTP_STATUS.QOS_THROTTLE).toBe(429);
    expect(ERROR_CODE_TO_HTTP_STATUS.INTERNAL).toBe(500);
    expect(ERROR_CODE_TO_HTTP_STATUS.UNAVAILABLE).toBe(503);
    expect(ERROR_CODE_TO_HTTP_STATUS.DEADLINE_EXCEEDED).toBe(504);
  });

  it("envelopeStatusCode roundtrips for every code", () => {
    for (const code of Object.values(ERROR_CODES)) {
      const env = buildEnvelope({ errorCode: code, errorName: "Stemma:Test" });
      expect(envelopeStatusCode(env)).toBe(ERROR_CODE_TO_HTTP_STATUS[code]);
    }
  });
});

describe("G-C-16 parameters denylist (no secrets)", () => {
  it("strips classic secret keys (case-insensitive)", () => {
    const out = sanitizeParameters({
      newTip: "abc",
      password: "shh",
      Token: "t",
      AUTHORIZATION: "Bearer xxx",
      secret: "s",
      api_key: "k",
      client_secret: "cs",
    });
    expect(out).toEqual({ newTip: "abc" });
  });

  it("does NOT strip safe diagnostic keys", () => {
    const out = sanitizeParameters({
      newTip: "abc",
      ref: "refs/heads/main",
      repositoryRid: "ri.stemma.main.repository.x",
    });
    expect(Object.keys(out).sort()).toEqual(["newTip", "ref", "repositoryRid"]);
  });

  it("strips function values defensively", () => {
    const out = sanitizeParameters({ ok: 1, evil: () => "leak" });
    expect("evil" in out).toBe(false);
    expect(out.ok).toBe(1);
  });

  it("buildEnvelope freezes parameters (cannot be mutated by attacker post-construct)", () => {
    const env = buildEnvelope({
      errorCode: ERROR_CODES.CONFLICT,
      errorName: "Stemma:RefUpdateRejected",
      parameters: { newTip: "abc" },
    });
    expect(() => {
      (env.parameters as Record<string, unknown>).injected = "x";
    }).toThrow();
  });
});
