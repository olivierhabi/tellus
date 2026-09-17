// Workload-JWT hardening: HS256-only verification + strong-secret boot guard.
// Hermetic — no DB, no network.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";

const RID = "ri.magritte.main.source.11111111-1111-1111-1111-111111111111";

let savedSecret: string | undefined;

async function loadTokens() {
  return import("../../../src/services/multipass/tokens");
}

beforeEach(async () => {
  savedSecret = process.env.TELLUS_WORKLOAD_JWT_SECRET;
  const { _resetSecretForTest } = await loadTokens();
  _resetSecretForTest();
});

afterEach(async () => {
  if (savedSecret === undefined) delete process.env.TELLUS_WORKLOAD_JWT_SECRET;
  else process.env.TELLUS_WORKLOAD_JWT_SECRET = savedSecret;
  const { _resetSecretForTest } = await loadTokens();
  _resetSecretForTest();
});

function useSecret(value: string | undefined) {
  if (value === undefined) delete process.env.TELLUS_WORKLOAD_JWT_SECRET;
  else process.env.TELLUS_WORKLOAD_JWT_SECRET = value;
}

describe("verifyWorkloadToken algorithm honesty", () => {
  it("round-trips a legitimately issued HS256 token", async () => {
    useSecret("a-strong-workload-secret-that-is-long-enough-32");
    const { _resetSecretForTest, issueWorkloadToken, verifyWorkloadToken } =
      await loadTokens();
    _resetSecretForTest();
    const token = issueWorkloadToken({
      subject: "tellus-foundry-worker",
      connectionRid: RID,
      tenant: "tenant-a",
    });
    const result = verifyWorkloadToken(token, {
      connectionRid: RID,
      scope: "connectivity:credential-unwrap",
    });
    expect(result.ok).toBe(true);
    expect(result.claims?.tenant).toBe("tenant-a");
  });

  it("rejects an RS256-signed token (no asymmetric issuance path exists)", async () => {
    useSecret("a-strong-workload-secret-that-is-long-enough-32");
    const { _resetSecretForTest, verifyWorkloadToken } = await loadTokens();
    _resetSecretForTest();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = jwt.sign(
      {
        sub: "tellus-foundry-worker",
        scopes: ["connectivity:credential-unwrap"],
        connection_rid: RID,
        tenant: "tenant-a",
      },
      privateKey,
      {
        algorithm: "RS256",
        expiresIn: 300,
        issuer: "tellus:multipass:workload",
        audience: "tellus:connectivity",
      },
    );
    const result = verifyWorkloadToken(forged, {
      connectionRid: RID,
      scope: "connectivity:credential-unwrap",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects alg=none tokens", async () => {
    useSecret("a-strong-workload-secret-that-is-long-enough-32");
    const { _resetSecretForTest, verifyWorkloadToken } = await loadTokens();
    _resetSecretForTest();
    const noneToken = jwt.sign(
      {
        sub: "tellus-foundry-worker",
        scopes: ["connectivity:credential-unwrap"],
        connection_rid: RID,
        tenant: "tenant-a",
      },
      "",
      {
        algorithm: "none",
        expiresIn: 300,
        issuer: "tellus:multipass:workload",
        audience: "tellus:connectivity",
      },
    );
    const result = verifyWorkloadToken(noneToken, {
      connectionRid: RID,
      scope: "connectivity:credential-unwrap",
    });
    expect(result.ok).toBe(false);
  });
});

describe("assertStrongWorkloadSecret", () => {
  it.each([
    "dev-tellus-workload-jwt-secret-please-rotate-32b",
    "changeme",
    "test",
    "secret",
    "  SECRET  ",
    "ChangeMe",
  ])("throws for known-weak value %j", async (weak) => {
    useSecret(weak);
    const { assertStrongWorkloadSecret } = await loadTokens();
    expect(() => assertStrongWorkloadSecret()).toThrow();
  });

  it("throws for an explicitly set short (<32 char) secret", async () => {
    useSecret("short-secret-123");
    const { assertStrongWorkloadSecret } = await loadTokens();
    expect(() => assertStrongWorkloadSecret()).toThrow();
  });

  it("passes when unset (single-process dev shape: random per-process secret)", async () => {
    useSecret(undefined);
    const { assertStrongWorkloadSecret } = await loadTokens();
    expect(() => assertStrongWorkloadSecret()).not.toThrow();
  });

  it("passes for a strong random value ≥32 chars", async () => {
    useSecret("a-strong-workload-secret-that-is-long-enough-32");
    const { assertStrongWorkloadSecret } = await loadTokens();
    expect(() => assertStrongWorkloadSecret()).not.toThrow();
  });
});
