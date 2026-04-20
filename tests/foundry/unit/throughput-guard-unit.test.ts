// ---------------------------------------------------------------------------
// PB-B5 — ThroughputGuard (unit).
//
// Pins acceptance (f): per-subject 2 MB/s default, bursts rejected when
// they exceed the bucket capacity, hard ceiling (50 MB/s) enforced on
// operator overrides, parallelism ceiling (16) enforced on pipeline
// configuration. Uses an injected clock so the token-bucket refill
// math is deterministic.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  ThroughputGuard,
  DEFAULT_RATE_BYTES_PER_SEC,
  DEFAULT_BURST_BYTES,
  DEFAULT_HARD_CEILING_BYTES_PER_SEC,
  DEFAULT_MAX_PARALLELISM,
  getGuard,
  resetGuardsForTests,
} from "../../../src/services/throughputGuard";

describe("ThroughputGuard defaults", () => {
  it("exports the spec-mandated 2 MB/s default + 50 MB/s ceiling", () => {
    expect(DEFAULT_RATE_BYTES_PER_SEC).toBe(2 * 1024 * 1024);
    expect(DEFAULT_HARD_CEILING_BYTES_PER_SEC).toBe(50 * 1024 * 1024);
    expect(DEFAULT_MAX_PARALLELISM).toBe(16);
  });
});

describe("ThroughputGuard.admit", () => {
  let clock = 0;
  const now = () => clock;
  let g: ThroughputGuard;

  beforeEach(() => {
    clock = 10_000;
    g = new ThroughputGuard({ now });
  });

  it("admits small bursts up to the bucket capacity immediately", () => {
    const r = g.admit(100_000);
    expect(r.ok).toBe(true);
    expect(r.waitMs).toBe(0);
  });

  it("rejects a single input bigger than the burst capacity", () => {
    const r = g.admit(DEFAULT_BURST_BYTES + 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("BYTES_EXCEED_BURST");
  });

  it("admits-with-wait when tokens are depleted", () => {
    // Drain the bucket.
    g.admit(DEFAULT_BURST_BYTES);
    // Next byte consumes MORE than available → caller must wait.
    const r = g.admit(DEFAULT_RATE_BYTES_PER_SEC); // 1s of rate
    expect(r.ok).toBe(true);
    expect(r.waitMs).toBeGreaterThan(0);
  });

  it("refills tokens over time", () => {
    g.admit(DEFAULT_BURST_BYTES); // drain
    clock += 1000; // 1 second → full refill
    const r = g.admit(DEFAULT_RATE_BYTES_PER_SEC);
    expect(r.ok).toBe(true);
    // With a full second of refill, 1 second of rate fits exactly; no wait.
    expect(r.waitMs).toBe(0);
  });

  it("validateParallelism rejects > ceiling and <= 0", () => {
    expect(g.validateParallelism(17).ok).toBe(false);
    expect(g.validateParallelism(0).ok).toBe(false);
    expect(g.validateParallelism(16).ok).toBe(true);
  });

  it("validateRateRequest rejects requests above the hard ceiling", () => {
    expect(g.validateRateRequest(DEFAULT_HARD_CEILING_BYTES_PER_SEC + 1).ok).toBe(false);
    expect(g.validateRateRequest(DEFAULT_HARD_CEILING_BYTES_PER_SEC).ok).toBe(true);
  });

  it("constructor rejects rate > hard ceiling", () => {
    expect(() => new ThroughputGuard({
      rateBytesPerSec: DEFAULT_HARD_CEILING_BYTES_PER_SEC + 1,
    })).toThrow(/exceeds hardCeilingBytesPerSec/);
  });
});

describe("ThroughputGuard registry", () => {
  beforeEach(() => resetGuardsForTests());

  it("returns the same guard instance for the same subject", () => {
    const a = getGuard("ot:orders");
    const b = getGuard("ot:orders");
    expect(a).toBe(b);
  });

  it("keeps guards isolated across subjects (per-OT / per-pipeline cap)", () => {
    const funnel = getGuard("ot:orders");
    const pipeline = getGuard("pipeline:abc");
    expect(funnel).not.toBe(pipeline);
  });
});
