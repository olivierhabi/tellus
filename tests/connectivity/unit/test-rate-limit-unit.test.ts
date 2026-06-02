// Unit tests for the connection-test rate limiter (testRateLimit).
//
// Pins the policy change: AUTHENTICATED principals are exempt (they were
// hitting 429 EgressRateLimited while legitimately re-testing a source);
// the token bucket only throttles the unauthenticated fallback. The
// CONNECTIVITY_TEST_RATE_LIMIT_ALL=1 escape hatch restores throttling for
// authenticated callers too.
import { afterEach, describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { testRateLimit } from "../../../src/services/connectivity/handlers/test.handler";

const WINDOW_MAX = 6; // mirrors TEST_MAX_PER_WINDOW

function invoke(opts: { userId?: string; ip?: string }): {
  code: number;
  nexted: boolean;
} {
  const req = {
    headers: {},
    ip: opts.ip ?? "203.0.113.7",
    socket: { remoteAddress: opts.ip ?? "203.0.113.7" },
    ...(opts.userId ? { user: { id: opts.userId } } : {}),
  } as unknown as Request;

  let code = 200;
  let nexted = false;
  const res = {
    set() {
      return res;
    },
    status(c: number) {
      code = c;
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;

  testRateLimit(req, res, () => {
    nexted = true;
  });
  return { code, nexted };
}

describe("connectivity testRateLimit", () => {
  afterEach(() => {
    delete process.env.CONNECTIVITY_TEST_RATE_LIMIT_ALL;
  });

  it("never throttles an authenticated principal (well past the bucket size)", () => {
    const userId = `user-auth-${Math.floor(performance.now())}`;
    for (let i = 0; i < WINDOW_MAX * 3; i++) {
      const r = invoke({ userId });
      expect(r.nexted, `call ${i + 1} should pass through`).toBe(true);
      expect(r.code).not.toBe(429);
    }
  });

  it("throttles the unauthenticated fallback after the burst", () => {
    const ip = "198.51.100.42"; // unique per test to avoid bucket bleed
    for (let i = 0; i < WINDOW_MAX; i++) {
      expect(invoke({ ip }).nexted, `burst call ${i + 1}`).toBe(true);
    }
    const blocked = invoke({ ip });
    expect(blocked.nexted).toBe(false);
    expect(blocked.code).toBe(429);
  });

  it("re-enables throttling for authenticated users when CONNECTIVITY_TEST_RATE_LIMIT_ALL=1", () => {
    process.env.CONNECTIVITY_TEST_RATE_LIMIT_ALL = "1";
    const userId = `user-enforced-${Math.floor(performance.now())}`;
    for (let i = 0; i < WINDOW_MAX; i++) {
      expect(invoke({ userId }).nexted, `burst call ${i + 1}`).toBe(true);
    }
    const blocked = invoke({ userId });
    expect(blocked.nexted).toBe(false);
    expect(blocked.code).toBe(429);
  });
});
