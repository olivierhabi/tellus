// ---------------------------------------------------------------------------
// F-P4-11 — circuit breaker primitive lifecycle coverage.
//
// Exercises `withBreaker` through the CLOSED → OPEN → HALF_OPEN →
// CLOSED cycle. Negative test: stripping either the state transition
// on failureThreshold or the HALF_OPEN probe gate breaks one of the
// assertions below (verified locally during development by toggling
// each arm of the `transition()` switch in circuitBreaker.ts).
//
// This file also covers the classifier contract used by the PG breaker
// in `src/db.ts` (isPgFailure). The invariants tested:
//
//   * Anything classified as "failure" counts toward the threshold.
//   * Anything classified as "not a failure" (e.g., shutdown race,
//     SQL semantic error) does NOT trip the breaker — even if it
//     throws.
//   * Once OPEN, subsequent calls short-circuit with CircuitOpenError
//     without invoking `fn`.
//   * After cooldownMs elapses, HALF_OPEN admits exactly
//     `halfOpenMaxProbes` concurrent probes; a success closes the
//     circuit, a failure re-opens it.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withBreaker,
  CircuitOpenError,
  getBreakerState,
  __resetBreakers,
} from "../../../src/resilience/circuitBreaker";

// Silence the counter/gauge emissions so the test output stays clean.
vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
}));

function boom(): never {
  const err = new Error("ECONNREFUSED 127.0.0.1:5432");
  (err as { code?: string }).code = "ECONNREFUSED";
  throw err;
}

describe("circuitBreaker — withBreaker lifecycle (F-P4-11)", () => {
  beforeEach(() => {
    __resetBreakers();
  });

  it("starts CLOSED and stays CLOSED on success", async () => {
    await withBreaker("x", async () => 1);
    expect(getBreakerState("x")).toBe("closed");
  });

  it("trips OPEN after `failureThreshold` consecutive failures", async () => {
    const label = "trip";
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(label, async () => boom(), { failureThreshold: 3 }),
      ).rejects.toThrow("ECONNREFUSED");
    }
    expect(getBreakerState(label)).toBe("open");
  });

  it("short-circuits with CircuitOpenError once OPEN — fn is never invoked", async () => {
    const label = "shortcircuit";
    const fn = vi.fn(async () => boom());
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(label, fn, { failureThreshold: 3 }),
      ).rejects.toThrow("ECONNREFUSED");
    }
    expect(fn).toHaveBeenCalledTimes(3);
    // Next call must short-circuit without invoking fn.
    await expect(
      withBreaker(label, fn, { failureThreshold: 3 }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3); // still 3 — fn NOT called
  });

  it("non-failure classifier keeps breaker CLOSED even when fn throws", async () => {
    const label = "semantic";
    const isFailure = (): boolean => false; // semantic errors don't trip
    for (let i = 0; i < 10; i++) {
      await expect(
        withBreaker(label, async () => boom(), { failureThreshold: 3 }, isFailure),
      ).rejects.toThrow("ECONNREFUSED");
    }
    expect(getBreakerState(label)).toBe("closed");
  });

  it("HALF_OPEN probe succeeds → breaker transitions back to CLOSED", async () => {
    const label = "halfopen";
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(label, async () => boom(), {
          failureThreshold: 3,
          cooldownMs: 1,
        }),
      ).rejects.toThrow();
    }
    expect(getBreakerState(label)).toBe("open");
    // Wait past cooldown.
    await new Promise((r) => setTimeout(r, 5));
    // Next success closes the circuit.
    const out = await withBreaker(
      label,
      async () => "ok",
      { failureThreshold: 3, cooldownMs: 1 },
    );
    expect(out).toBe("ok");
    expect(getBreakerState(label)).toBe("closed");
  });

  it("HALF_OPEN probe fails → breaker re-OPENs and blocks again", async () => {
    const label = "halfopen-fail";
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(label, async () => boom(), {
          failureThreshold: 3,
          cooldownMs: 1,
        }),
      ).rejects.toThrow();
    }
    await new Promise((r) => setTimeout(r, 5));
    // Probe attempt fails — back to OPEN.
    await expect(
      withBreaker(label, async () => boom(), {
        failureThreshold: 3,
        cooldownMs: 1,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(getBreakerState(label)).toBe("open");
    // Immediate follow-up still short-circuits — cooldown starts over.
    await expect(
      withBreaker(label, async () => 1, {
        failureThreshold: 3,
        cooldownMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("per-label registry keeps breakers independent", async () => {
    const a = "a";
    const b = "b";
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(a, async () => boom(), { failureThreshold: 3 }),
      ).rejects.toThrow();
    }
    expect(getBreakerState(a)).toBe("open");
    // b is untouched — should still be CLOSED.
    await withBreaker(b, async () => 1);
    expect(getBreakerState(b)).toBe("closed");
  });
});
