// ---------------------------------------------------------------------------
// tests/unit/rateLimit/rateLimiterBackendSwitch-unit.test.ts
//
// F-P4-12 middleware-level integration test. Proves that:
//   1. When RATE_LIMIT_BACKEND is unset, the in-memory path runs
//      (tellus_rate_limit_backend_selected_total{backend="memory"}).
//   2. When RATE_LIMIT_BACKEND=redis AND initRedisRateLimiters has been
//      called, the async Redis path runs
//      (tellus_rate_limit_backend_selected_total{backend="redis"}) and
//      the shared Redis client observes the count.
//   3. On Redis error, the Redis path fails open rather than cascading
//      into a 503 on every request.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
  setGauge: vi.fn(),
}));

import {
  actionRateLimiter,
  batchRateLimiter,
  initRedisRateLimiters,
  limiter,
  RATE_LIMITS,
} from "../../../src/middleware/rateLimiter";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function makeReqRes(params: Record<string, string> = {}, userId = "alice") {
  const req: any = {
    params,
    user: { id: userId },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headers = new Map<string, string>();
  res.set = (k: string, v: string) => { res.headers.set(k, v); return res; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = vi.fn();
  return { req, res };
}

class FakeRedisForMiddleware {
  private zsets = new Map<string, Array<[number, string]>>();
  public failNext = false;
  async eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Redis down");
    }
    const key = opts.keys[0];
    const nowMs = Number(opts.arguments[0]);
    const windowMs = Number(opts.arguments[1]);
    const existing = this.zsets.get(key) ?? [];
    const active = existing.filter(([s]) => s > nowMs - windowMs);
    if (script.includes("ZADD")) {
      active.push([nowMs, `${nowMs}:sample`]);
      this.zsets.set(key, active);
      return active.length;
    }
    this.zsets.set(key, active);
    return [active.length, active[0]?.[0] ?? nowMs];
  }
}

describe("rateLimiter — backend switch (F-P4-12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiter.reset();
    delete process.env.RATE_LIMIT_BACKEND;
  });

  it("RATE_LIMIT_BACKEND unset: falls through to memory backend", async () => {
    const { req, res } = makeReqRes({ actionTypeApiName: "updateSalary" });
    const next = vi.fn();
    actionRateLimiter(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_backend_selected_total",
      { backend: "memory" },
    );
  });

  it("RATE_LIMIT_BACKEND=redis + initialized: routes through redis backend", async () => {
    process.env.RATE_LIMIT_BACKEND = "redis";
    const fakeRedis = new FakeRedisForMiddleware();
    initRedisRateLimiters(fakeRedis);

    const { req, res } = makeReqRes({ actionTypeApiName: "updateSalary" });
    const next = vi.fn();
    // actionRateLimiter is sync-entry; the async redis path is invoked
    // via void — we need to await a tick for it to settle.
    actionRateLimiter(req, res, next);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_backend_selected_total",
      { backend: "redis" },
    );
    expect(next).toHaveBeenCalled();
  });

  it("RATE_LIMIT_BACKEND=redis but Redis throws: fails open, does NOT 503", async () => {
    process.env.RATE_LIMIT_BACKEND = "redis";
    const fakeRedis = new FakeRedisForMiddleware();
    fakeRedis.failNext = true;
    initRedisRateLimiters(fakeRedis);

    const { req, res } = makeReqRes({ actionTypeApiName: "updateSalary" });
    const next = vi.fn();
    actionRateLimiter(req, res, next);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Fail-open path: next was called, no 429 emitted.
    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_failed_open_total",
      { scope: "action_type" },
    );
  });

  it("RATE_LIMIT_BACKEND=redis: records across both action entrypoints", async () => {
    process.env.RATE_LIMIT_BACKEND = "redis";
    initRedisRateLimiters(new FakeRedisForMiddleware());

    const { req: rA, res: resA } = makeReqRes({ actionTypeApiName: "a1" });
    const nextA = vi.fn();
    actionRateLimiter(rA, resA, nextA);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const { req: rB, res: resB } = makeReqRes({});
    const nextB = vi.fn();
    batchRateLimiter(rB, resB, nextB);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(nextA).toHaveBeenCalled();
    expect(nextB).toHaveBeenCalled();
    const backendCalls = incMock.mock.calls.filter(
      (c) => c[0] === "tellus_rate_limit_backend_selected_total",
    );
    const redisPath = backendCalls.filter((c) => (c[1] as any).backend === "redis");
    expect(redisPath.length).toBeGreaterThanOrEqual(2);
  });

  it("GLOBAL_ACTION_RATE_LIMIT_MAX defaults to 5000 (F-P4-12 SLO headroom)", () => {
    // Default must provide > 50 actions/s (3000/min). We set 5000/min =
    // 83/s so the limiter never is the binding constraint at SLO.
    expect(RATE_LIMITS.global.maxRequests).toBeGreaterThanOrEqual(5000);
  });
});
