// ---------------------------------------------------------------------------
// tests/unit/rateLimit/redisRateLimiter-unit.test.ts
//
// F-P4-12 negative test — K8s-incompatible in-memory rate limiter replaced
// by a Redis-backed sliding window.
//
// Pre-fix behaviour (src/middleware/rateLimiter.ts line 16-17 comment):
//   "In production, this would be backed by Redis for multi-instance
//    deployments. The in-memory implementation is sufficient for
//    single-instance deployments."
// Under N replicas the per-user limit multiplied by N; this is the P0
// K8s incompatibility the forcing prompt flagged.
//
// Post-fix behaviour: RedisRateLimiter uses ZADD/ZREMRANGEBYSCORE/ZCARD
// under a Lua script so all replicas share one counter. Negative test:
// simulate two "replicas" sharing one Redis instance and assert the
// shared counter increments across both — which a Map-based limiter
// could never achieve.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
  setGauge: vi.fn(),
}));

import { RedisRateLimiter } from "../../../src/services/rateLimit/redisRateLimiter";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

/** In-memory Lua-script simulator that mimics ZADD/ZCARD/ZRANGE semantics. */
class FakeRedis {
  private zsets = new Map<string, Array<[number, string]>>();
  public failNext = false;

  async eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Redis unreachable");
    }
    const key = opts.keys[0];
    const nowMs = Number(opts.arguments[0]);
    const windowMs = Number(opts.arguments[1]);
    const sampleId = opts.arguments[2];
    const cutoff = nowMs - windowMs;
    const existing = this.zsets.get(key) ?? [];
    const active = existing.filter(([score]) => score > cutoff);
    if (script.includes("ZADD")) {
      active.push([nowMs, `${nowMs}:${sampleId}`]);
      this.zsets.set(key, active);
      return active.length;
    }
    // CHECK_SCRIPT branch — count-only.
    this.zsets.set(key, active);
    const oldest = active.length > 0 ? active[0][0] : nowMs;
    return [active.length, oldest];
  }
}

function makeLimiter(maxRequests: number, shared: FakeRedis) {
  return new RedisRateLimiter({
    client: shared as any,
    keyPrefix: "test",
    windowMs: 60_000,
    maxRequests,
    scope: "test_scope",
  });
}

describe("RedisRateLimiter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows first request within limit", async () => {
    const limiter = makeLimiter(5, new FakeRedis());
    const res = await limiter.check("user-1");
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(5);
    expect(res.failedOpen).toBe(false);
  });

  it("denies when count reaches maxRequests", async () => {
    const redis = new FakeRedis();
    const limiter = makeLimiter(3, redis);
    await limiter.record("user-1");
    await limiter.record("user-1");
    await limiter.record("user-1");
    const res = await limiter.check("user-1");
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });

  it("F-P4-12 negative: two replicas sharing Redis observe one counter", async () => {
    // Two limiter instances simulate two K8s replicas. Both point at the same
    // FakeRedis instance. An in-memory Map-based limiter would give each
    // replica its own counter — under N replicas the effective limit
    // multiplies. Redis-backed limiter shares state.
    const sharedRedis = new FakeRedis();
    const replicaA = makeLimiter(5, sharedRedis);
    const replicaB = makeLimiter(5, sharedRedis);

    // Replica A records 3 hits.
    await replicaA.record("user-global");
    await replicaA.record("user-global");
    await replicaA.record("user-global");

    // Replica B records 2 hits — total 5 across the shared counter.
    await replicaB.record("user-global");
    await replicaB.record("user-global");

    // A 6th request on either replica must be denied — this is the property
    // an in-memory limiter cannot provide.
    const denied = await replicaA.check("user-global");
    expect(denied.allowed).toBe(false);
    const deniedOnB = await replicaB.check("user-global");
    expect(deniedOnB.allowed).toBe(false);
  });

  it("fails open on Redis error with tellus_rate_limit_failed_open_total counter", async () => {
    const redis = new FakeRedis();
    redis.failNext = true;
    const limiter = makeLimiter(5, redis);
    const res = await limiter.check("user-1");
    expect(res.allowed).toBe(true);
    expect(res.failedOpen).toBe(true);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_failed_open_total",
      { scope: "test_scope" },
    );
  });

  it("checkAndRecord emits tellus_rate_limit_exceeded_total when denied", async () => {
    const redis = new FakeRedis();
    const limiter = makeLimiter(1, redis);
    await limiter.checkAndRecord("user-1");
    await limiter.checkAndRecord("user-1"); // should be denied
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_exceeded_total",
      { scope: "test_scope" },
    );
  });

  it("checkAndRecord increments tellus_rate_limit_recorded_total on allow", async () => {
    const limiter = makeLimiter(5, new FakeRedis());
    await limiter.checkAndRecord("user-1");
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_recorded_total",
      { scope: "test_scope" },
    );
  });

  it("distinct buckets do not share counters", async () => {
    const redis = new FakeRedis();
    const limiter = makeLimiter(1, redis);
    await limiter.record("user-a");
    const resA = await limiter.check("user-a");
    const resB = await limiter.check("user-b");
    expect(resA.allowed).toBe(false);
    expect(resB.allowed).toBe(true);
  });

  it("record() emits tellus_rate_limit_record_failed_total and returns -1 on Redis error", async () => {
    // F-P4-12 write-path degraded: record should not propagate the error
    // up to the caller — it returns -1 and emits the failure counter.
    const redis = new FakeRedis();
    redis.failNext = true;
    const limiter = makeLimiter(5, redis);
    const count = await limiter.record("user-1");
    expect(count).toBe(-1);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_rate_limit_record_failed_total",
      { scope: "test_scope" },
    );
  });

  it("record() surfaces non-Error thrown values in warn log path", async () => {
    // Redis client may throw a non-Error. Code path uses String(err) —
    // cover the `err instanceof Error ? err.message : String(err)` branch.
    const redis = {
      async eval() {
        throw "plain-string-failure";
      },
    };
    const limiter = makeLimiter(5, redis as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const count = await limiter.record("user-1");
      expect(count).toBe(-1);
      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls[0][0] as string;
      expect(logged).toContain("plain-string-failure");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("check() surfaces non-Error thrown values in warn log path", async () => {
    const redis = {
      async eval() {
        throw "another-plain-error";
      },
    };
    const limiter = makeLimiter(5, redis as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await limiter.check("user-1");
      expect(res.failedOpen).toBe(true);
      expect(res.allowed).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("checkAndRecord reduces remaining by 1 on allow path", async () => {
    const redis = new FakeRedis();
    const limiter = makeLimiter(5, redis);
    const res = await limiter.checkAndRecord("user-1");
    expect(res.allowed).toBe(true);
    // precheck.remaining = 5, after recording we advertise 4.
    expect(res.remaining).toBe(4);
  });

  it("retryAfterMs is at least 1 ms (Math.max clamp)", async () => {
    // Force oldestMs to equal nowMs so retry window calculation would
    // otherwise be 0 — clamp to >= 1.
    const redis: any = {
      async eval() {
        // return count >= maxRequests so precheck denies
        return [3, Date.now() - 60_000]; // oldest is the cutoff edge
      },
    };
    const limiter = makeLimiter(1, redis);
    const res = await limiter.check("user-1");
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThanOrEqual(1);
  });
});
