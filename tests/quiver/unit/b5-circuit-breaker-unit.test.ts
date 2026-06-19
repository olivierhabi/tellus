/**
 * B5 — CircuitBreaker unit tests.
 *
 * Contract covered:
 *   B5 C-14 — opens at >= 50% failure rate over 50-call window;
 *             half-open after 30 s; on first half-open success → closed;
 *             on first half-open failure → re-open.
 */

import { describe, it, expect } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../../src/services/quiver/compute/circuitBreaker";

describe("B5 C-14: CircuitBreaker state machine", () => {
  it("starts closed", () => {
    const cb = new CircuitBreaker("OSS");
    expect(cb.getState()).toBe("closed");
  });

  it("does not trip below minCallsToTrip", () => {
    const cb = new CircuitBreaker("OSS", { minCallsToTrip: 10 });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getState()).toBe("closed");
  });

  it("opens at >= 50% failure rate over 50-call window", () => {
    const cb = new CircuitBreaker("OSS", { windowSize: 50, thresholdRatio: 0.5, minCallsToTrip: 10 });
    // 5 failures + 5 successes = 50% → trips
    for (let i = 0; i < 5; i++) cb.recordSuccess();
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });

  it("guard() throws CircuitOpenError when open and still cooling", () => {
    let nowVal = 0;
    const cb = new CircuitBreaker("OSS", { cooldownMs: 30_000, minCallsToTrip: 1 }, () => nowVal);
    cb.recordFailure();
    nowVal = 1000;
    expect(() => cb.guard()).toThrow(CircuitOpenError);
  });

  it("transitions to half_open after cooldown", () => {
    let nowVal = 0;
    const cb = new CircuitBreaker("OSS", { cooldownMs: 30_000, minCallsToTrip: 1 }, () => nowVal);
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    nowVal = 30_001;
    cb.guard();
    expect(cb.getState()).toBe("half_open");
  });

  it("half_open + success → closed", () => {
    let nowVal = 0;
    const cb = new CircuitBreaker("OSS", { cooldownMs: 1, minCallsToTrip: 1 }, () => nowVal);
    cb.recordFailure();
    nowVal = 100;
    cb.guard(); // → half_open
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  it("half_open + failure → open with reset cooldown", () => {
    let nowVal = 0;
    const cb = new CircuitBreaker("OSS", { cooldownMs: 100, minCallsToTrip: 1 }, () => nowVal);
    cb.recordFailure();
    nowVal = 200;
    cb.guard();
    expect(cb.getState()).toBe("half_open");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    // Still cooling immediately after re-open
    nowVal = 250;
    expect(() => cb.guard()).toThrow(CircuitOpenError);
  });
});
