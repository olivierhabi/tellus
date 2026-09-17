// Unit tests for the connection-test rate limiter (testRateLimit).
//
// Pins the vuln-0040 policy: the token bucket applies to EVERY caller by
// default (authenticated principals were previously exempt, which let any
// connectivity:test holder sweep internal ports at full speed through the
// probe's error-class oracle). The CONNECTIVITY_TEST_RATE_LIMIT_ALL=0 escape
// hatch restores the legacy authenticated exemption for operators who accept
// that risk.
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

  it("throttles an authenticated principal after the burst (vuln-0040)", () => {
    const userId = `user-auth-${Math.floor(performance.now())}`;
    for (let i = 0; i < WINDOW_MAX; i++) {
      expect(invoke({ userId }).nexted, `burst call ${i + 1}`).toBe(true);
    }
    const blocked = invoke({ userId });
    expect(blocked.nexted).toBe(false);
    expect(blocked.code).toBe(429);
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

  it("restores the authenticated exemption when CONNECTIVITY_TEST_RATE_LIMIT_ALL=0", () => {
    process.env.CONNECTIVITY_TEST_RATE_LIMIT_ALL = "0";
    const userId = `user-exempt-${Math.floor(performance.now())}`;
    for (let i = 0; i < WINDOW_MAX * 3; i++) {
      const r = invoke({ userId });
      expect(r.nexted, `call ${i + 1} should pass through`).toBe(true);
      expect(r.code).not.toBe(429);
    }
  });
});
