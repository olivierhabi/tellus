import { describe, expect, it } from "vitest";

import { FunctionsPublishError } from "../../../src/services/functionsPublish/service";
import {
  classifyError,
  computeBackoffMs,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_TRANSIENT_RETRIES,
  resolveLifecycleTunables,
  RunAuthorityLostError,
  TransientStageError,
} from "../../../src/services/functionsPublish/retry";

describe("classifyError", () => {
  it("classifies authority loss", () => {
    expect(classifyError(new RunAuthorityLostError("cancelled"))).toBe("authority");
    expect(classifyError(new RunAuthorityLostError("lease-lost"))).toBe("authority");
  });

  it("classifies explicit transient boundary errors", () => {
    expect(classifyError(new TransientStageError("stemma transient"))).toBe("transient");
  });

  it("classifies the retryable SQLSTATE allowlist", () => {
    for (const code of ["40001", "40P01", "53300", "53400", "57P01", "57P02", "57P03"]) {
      expect(classifyError(Object.assign(new Error("x"), { code }))).toBe("transient");
    }
    // Whole connection-exception class 08.
    for (const code of ["08000", "08003", "08006", "08P01"]) {
      expect(classifyError(Object.assign(new Error("x"), { code }))).toBe("transient");
    }
  });

  it("classifies node net codes from the pg driver", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
      expect(classifyError(Object.assign(new Error("x"), { code }))).toBe("transient");
    }
  });

  it("keeps deterministic failures final", () => {
    // Constraint violations are semantic, not transient.
    expect(classifyError(Object.assign(new Error("x"), { code: "23505" }))).toBe("deterministic");
    // 57014 query_canceled is NOT a retryable shutdown.
    expect(classifyError(Object.assign(new Error("x"), { code: "57014" }))).toBe("deterministic");
    expect(classifyError(new FunctionsPublishError("VERSION_CONFLICT", "nope"))).toBe("deterministic");
    expect(classifyError(new Error("tests failed: 1 of 3"))).toBe("deterministic");
    // Unknown errors default to deterministic — defects fail loudly.
    expect(classifyError(new TypeError("undefined is not a function"))).toBe("deterministic");
    expect(classifyError("a string error")).toBe("deterministic");
    expect(classifyError(null)).toBe("deterministic");
  });
});

describe("computeBackoffMs", () => {
  const tunables = { retryBaseDelayMs: 1_000, retryMaxDelayMs: 30_000 };

  it("is full-jitter within [0, base * 2^(n-1)) capped at max", () => {
    expect(computeBackoffMs(1, { ...tunables, random: () => 0 })).toBe(0);
    expect(computeBackoffMs(1, { ...tunables, random: () => 0.999 })).toBe(999);
    expect(computeBackoffMs(2, { ...tunables, random: () => 0.999 })).toBe(1_998);
    expect(computeBackoffMs(3, { ...tunables, random: () => 0.999 })).toBe(3_996);
    // Cap binds beyond the exponential growth.
    expect(computeBackoffMs(10, { ...tunables, random: () => 0.999 })).toBe(29_970);
  });

  it("uses the injected random source (deterministic in tests)", () => {
    expect(computeBackoffMs(1, { ...tunables, random: () => 0.5 })).toBe(500);
  });
});

describe("resolveLifecycleTunables", () => {
  it("uses named defaults; heartbeat stays strictly below the lease TTL", () => {
    const tunables = resolveLifecycleTunables({});
    expect(tunables.leaseTtlMs).toBe(DEFAULT_LEASE_TTL_MS);
    expect(tunables.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(tunables.maxTransientRetries).toBe(DEFAULT_MAX_TRANSIENT_RETRIES);
    expect(tunables.heartbeatIntervalMs).toBeLessThan(tunables.leaseTtlMs);
  });

  it("clamps an oversized heartbeat to a third of the lease TTL", () => {
    const tunables = resolveLifecycleTunables({
      FUNCTIONS_PUBLISH_LEASE_TTL_MS: "3000",
      FUNCTIONS_PUBLISH_HEARTBEAT_INTERVAL_MS: "600000",
    });
    expect(tunables.heartbeatIntervalMs).toBe(1_000);
  });

  it("clamps retry budget and delays", () => {
    const tunables = resolveLifecycleTunables({
      FUNCTIONS_PUBLISH_MAX_TRANSIENT_RETRIES: "999",
      FUNCTIONS_PUBLISH_RETRY_BASE_DELAY_MS: "1",
      FUNCTIONS_PUBLISH_RETRY_MAX_DELAY_MS: "not-a-number",
    });
    expect(tunables.maxTransientRetries).toBe(10);
    expect(tunables.retryBaseDelayMs).toBe(10);
    expect(tunables.retryMaxDelayMs).toBe(30_000);
  });
});
