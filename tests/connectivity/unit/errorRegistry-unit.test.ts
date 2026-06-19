// ---------------------------------------------------------------------------
// Unit tests for src/lib/errors/{registry,envelope,connectivity.errors}.ts.
// Verifies:
//   - every connectivity error in the registry has Tellus:Service:PascalCase
//     name (the registry's load-time guard already enforces; double-checked
//     here to surface in test reports).
//   - buildEnvelope returns the spec'd 4-field shape with sanitized parameters.
//   - sanitizeParameters redacts password / secret / token / kek / ciphertext keys.
//   - TellusError.send writes the envelope on the response with HTTP status.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import * as connectivityErrors from "../../../src/lib/errors/connectivity.errors";
import {
  buildEnvelope,
  sendEnvelope,
  TellusError,
} from "../../../src/lib/errors/envelope";
import { all, get } from "../../../src/lib/errors/registry";

describe("error registry — connectivity", () => {
  it("registers all exported connectivity errors", () => {
    for (const def of Object.values(connectivityErrors)) {
      expect(get(def.errorName)).toBe(def);
    }
  });
  it("all errorNames follow Tellus:Service:PascalCase", () => {
    const re = /^Tellus:[A-Z][A-Za-z0-9]+:[A-Z][A-Za-z0-9]+$/;
    for (const def of all()) {
      expect(def.errorName).toMatch(re);
    }
  });
  it("connectivity errors map to sane HTTP statuses", () => {
    expect(connectivityErrors.ConnectionNotFound.httpStatus).toBe(404);
    expect(connectivityErrors.ResourceVersionMismatch.httpStatus).toBe(409);
    expect(connectivityErrors.IfMatchRequired.httpStatus).toBe(412);
    expect(connectivityErrors.ScopeRequired.httpStatus).toBe(403);
    expect(connectivityErrors.JdbcAuthFailed.httpStatus).toBe(401);
  });
});

describe("envelope.buildEnvelope", () => {
  it("returns the 4-field shape", () => {
    const env = buildEnvelope(connectivityErrors.ConnectionNotFound, {
      rid: "ri.magritte.main.source.00000000-0000-0000-0000-000000000000",
    });
    expect(env.errorCode).toBe("NOT_FOUND");
    expect(env.errorName).toBe("Tellus:Connectivity:ConnectionNotFound");
    expect(typeof env.errorInstanceId).toBe("string");
    expect(env.errorInstanceId.length).toBeGreaterThan(0);
    expect(env.parameters).toEqual({
      rid: "ri.magritte.main.source.00000000-0000-0000-0000-000000000000",
    });
  });

  it("sanitizes credential-shaped parameter keys", () => {
    const env = buildEnvelope(connectivityErrors.CredentialDecryptionFailed, {
      ciphertext: "abcdef",
      api_key: "k",
      password: "p",
      apiToken: "t",
      kek: "k",
      benign: "ok",
    });
    expect(env.parameters.ciphertext).toBe("[redacted]");
    expect(env.parameters.api_key).toBe("[redacted]");
    expect(env.parameters.password).toBe("[redacted]");
    expect(env.parameters.apiToken).toBe("[redacted]");
    expect(env.parameters.kek).toBe("[redacted]");
    expect(env.parameters.benign).toBe("ok");
  });
});

describe("envelope.TellusError", () => {
  it("toEnvelope reuses its errorInstanceId", () => {
    const err = new TellusError(connectivityErrors.ConnectionNotFound, {
      rid: "x",
    });
    const e1 = err.toEnvelope();
    const e2 = err.toEnvelope();
    expect(e1.errorInstanceId).toBe(e2.errorInstanceId);
  });

  it("send writes status + envelope JSON", () => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(n: number) {
        captured.status = n;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as any;
    new TellusError(connectivityErrors.ConnectionNameAlreadyExists, {
      name: "x",
    }).send(res);
    expect(captured.status).toBe(409);
    expect((captured.body as Record<string, unknown>).errorName).toBe(
      "Tellus:Connectivity:ConnectionNameAlreadyExists",
    );
  });
});

describe("envelope.sendEnvelope", () => {
  it("writes status + envelope JSON from a bare ErrorDefinition", () => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(n: number) {
        captured.status = n;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as any;
    sendEnvelope(res, connectivityErrors.HasActiveDependencies, { rid: "x" });
    expect(captured.status).toBe(412);
    const body = captured.body as Record<string, unknown>;
    expect(body.errorName).toBe("Tellus:Connectivity:HasActiveDependencies");
    expect(body.errorCode).toBe("FAILED_PRECONDITION");
  });
});
