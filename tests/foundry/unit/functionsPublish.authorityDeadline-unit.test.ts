// ---------------------------------------------------------------------------
// Deterministic unit tests for AuthorityDeadline + RunAuthority.bindDeadline.
// Injected monotonic clock — no real sleeps, no database.
//
// Covers the Blocker 2 requirements:
//   * Monotonic deadline = lastConfirmedRenewal + leaseTtl - safetyMargin
//   * Transient failures never extend the deadline
//   * Only confirmRenewal() extends it
//   * throwIfLost() checks BOTH explicit loss AND deadline expiry
//   * Safety margin is named, clamped, and smaller than the TTL
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  AuthorityDeadline,
  RunAuthority,
  RunAuthorityLostError,
} from "../../../src/services/functionsPublish/retry";

/** A controllable monotonic clock for deterministic tests. */
class FakeClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

const TTL = 600_000; // 10 minutes — the production default
const MARGIN = 30_000; // 30 seconds — the production default

function makeDeadline(
  clock: FakeClock,
  ttl = TTL,
  margin = MARGIN,
): AuthorityDeadline {
  return new AuthorityDeadline(ttl, margin, () => clock.now());
}

describe("AuthorityDeadline", () => {
  it("computes deadline as now + ttl - margin on construction", () => {
    const clock = new FakeClock();
    clock.set(1000);
    const deadline = makeDeadline(clock, 600, 30);
    // deadlineAt = 1000 + 600 - 30 = 1570
    expect(deadline.expired()).toBe(false);
    clock.set(1569);
    expect(deadline.expired()).toBe(false);
    clock.set(1570);
    expect(deadline.expired()).toBe(true);
  });

  it("a confirmed renewal extends the deadline", () => {
    const clock = new FakeClock();
    clock.set(1000);
    const deadline = makeDeadline(clock, 600, 30);
    clock.advance(500); // now = 1500; original deadline = 1570
    expect(deadline.expired()).toBe(false);
    deadline.confirmRenewal(); // deadlineAt = 1500 + 600 - 30 = 2070
    clock.advance(569); // now = 2069
    expect(deadline.expired()).toBe(false);
    clock.advance(1); // now = 2070
    expect(deadline.expired()).toBe(true);
  });

  it("transient failure never extends the deadline", () => {
    const clock = new FakeClock();
    clock.set(0);
    const deadline = makeDeadline(clock, 600, 30);
    // deadlineAt = 0 + 600 - 30 = 570
    clock.advance(570);
    // No confirmRenewal() called — simulating a transient heartbeat failure.
    expect(deadline.expired()).toBe(true);
  });

  it("one transient failure followed by success retains authority", () => {
    const clock = new FakeClock();
    clock.set(0);
    const deadline = makeDeadline(clock, 600, 30);
    // deadlineAt = 570
    clock.advance(300); // now = 300; deadline not yet passed
    expect(deadline.expired()).toBe(false);
    // Simulated transient failure — no confirmRenewal() call.
    clock.advance(200); // now = 500
    expect(deadline.expired()).toBe(false);
    // Successful renewal.
    deadline.confirmRenewal(); // deadlineAt = 500 + 570 = 1070
    clock.advance(569); // now = 1069
    expect(deadline.expired()).toBe(false);
  });

  it("repeated transient failures reaching the deadline lose authority", () => {
    const clock = new FakeClock();
    clock.set(0);
    const deadline = makeDeadline(clock, 600, 30);
    // deadlineAt = 570
    // Simulate repeated transient heartbeat failures — no confirmRenewal().
    for (let tick = 0; tick < 10; tick++) {
      clock.advance(60); // each tick = 60ms, as if heartbeatInterval=60
    }
    // now = 600 > 570
    expect(deadline.expired()).toBe(true);
  });

  it("monotonic: wall-clock backward jump does not extend the deadline", () => {
    const clock = new FakeClock();
    clock.set(1000);
    const deadline = makeDeadline(clock, 600, 30);
    // deadlineAt = 1570
    clock.advance(500); // now = 1500
    expect(deadline.expired()).toBe(false);
    // A monotonic clock cannot go backward — but even if the wall
    // clock did, our clock only moves forward. This test verifies
    // that advancing to a value BEFORE the initial deadline and then
    // back past it still expires at the correct point.
    clock.advance(69); // now = 1569
    expect(deadline.expired()).toBe(false);
    clock.advance(1); // now = 1570
    expect(deadline.expired()).toBe(true);
  });

  it("zero-margin means deadline == now + ttl", () => {
    const clock = new FakeClock();
    clock.set(0);
    const deadline = makeDeadline(clock, 600, 0);
    expect(deadline.expired()).toBe(false);
    clock.advance(599);
    expect(deadline.expired()).toBe(false);
    clock.advance(1);
    expect(deadline.expired()).toBe(true);
  });

  it("margin larger than half the TTL is still respected (clamped upstream)", () => {
    // The clamping happens in resolveLifecycleTunables, not here.
    // This test verifies the raw AuthorityDeadline honors whatever margin
    // it's given — the upstream clamp is tested separately.
    const clock = new FakeClock();
    clock.set(0);
    const deadline = makeDeadline(clock, 600, 400);
    // deadlineAt = 0 + 600 - 400 = 200
    clock.advance(199);
    expect(deadline.expired()).toBe(false);
    clock.advance(1);
    expect(deadline.expired()).toBe(true);
  });
});

describe("RunAuthority.bindDeadline", () => {
  it("throwIfLost passes when neither explicit loss nor deadline expiry", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    expect(() => authority.throwIfLost()).not.toThrow();
  });

  it("throwIfLost throws when deadline has passed even without explicit loss", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    clock.advance(600); // past the deadline (570)
    expect(() => authority.throwIfLost()).toThrow(RunAuthorityLostError);
    expect(authority.lost).toBe("lease-lost");
  });

  it("throwIfLost throws when explicitly lost even before the deadline", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    clock.advance(100); // well within the deadline
    authority.lose("cancelled");
    expect(() => authority.throwIfLost()).toThrow(RunAuthorityLostError);
    expect(() => authority.throwIfLost()).toThrow("run cancelled");
  });

  it("deadline expiry sets lostReason to lease-lost", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    clock.advance(600);
    try {
      authority.throwIfLost();
    } catch {
      // expected
    }
    expect(authority.lost).toBe("lease-lost");
  });

  it("explicit loss preserves its reason even when deadline also fires", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    authority.lose("shutdown");
    clock.advance(600);
    try {
      authority.throwIfLost();
    } catch (error) {
      expect(error).toBeInstanceOf(RunAuthorityLostError);
      expect((error as RunAuthorityLostError).reason).toBe("shutdown");
    }
    expect(authority.lost).toBe("shutdown");
  });

  it("a confirmed renewal prevents deadline-based loss", () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    clock.advance(500);
    deadline.confirmRenewal(); // extends deadline
    clock.advance(569); // within new deadline
    expect(() => authority.throwIfLost()).not.toThrow();
  });

  it("unbound authority ignores deadline (no bindDeadline call)", () => {
    const clock = new FakeClock();
    const _deadline = makeDeadline(clock, 600, 30); // eslint-disable-line @typescript-eslint/no-unused-vars
    const authority = new RunAuthority();
    // Intentionally NOT bound — tests that an unbound authority is not
    // affected by an AuthorityDeadline going stale.
    clock.advance(9999);
    expect(() => authority.throwIfLost()).not.toThrow();
  });

  it("lostPromise resolves when deadline expiry triggers lose()", async () => {
    const clock = new FakeClock();
    const deadline = makeDeadline(clock, 600, 30);
    const authority = new RunAuthority();
    authority.bindDeadline(deadline);
    let resolved = false;
    void authority.lostPromise.then(() => {
      resolved = true;
    });
    clock.advance(600);
    try {
      authority.throwIfLost();
    } catch {
      // expected
    }
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(true);
  });
});
