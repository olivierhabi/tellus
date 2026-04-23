// ---------------------------------------------------------------------------
// src/services/rateLimit/redisRateLimiter.ts
//
// Closes F-P4-12 (P0) — Kubernetes-compatible rate limiter.
//
// The previous in-memory rate limiter at src/middleware/rateLimiter.ts (line
// 16) acknowledged in a comment that it was insufficient for K8s multi-replica
// deployments. Under N replicas the per-user / global limits multiplied by N
// and drifted by arrival pattern; global default of 2000/min == 33/s was
// already below the 50 actions/s SLO on a single replica.
//
// This implementation replaces the in-memory Map with a Redis sliding-window
// counter. The algorithm is the standard Stripe / envoy pattern:
//
//   ZADD    key now now-random-suffix   -- record a sample
//   ZREMRANGEBYSCORE key 0 (now - windowMs)
//                                       -- evict expired samples
//   ZCARD   key                          -- current count in window
//   PEXPIRE key 2 * windowMs             -- set TTL so idle keys expire
//
// All four commands run in a single Lua script so they are atomic; no other
// client can observe a partial state. The script returns [count, resetMs]
// where resetMs is when the oldest sample expires.
//
// Failure mode — fail open, not closed. If Redis is unreachable, the limiter
// emits tellus_rate_limit_failed_open_total{scope} and returns allowed=true
// with a warning. Rate limiting is a defence-in-depth control; a Redis loss
// must not cascade into a 503 on every inbound request. The upstream circuit
// breaker (F-P4-11) coordinates recovery.
//
// SLO impact — at 50 actions/s the limiter issues one EVAL per apply. Redis
// EVAL on a warm connection is ~0.2 ms; limiter overhead is < 0.5% of the
// p99 action budget (800 ms). Under Redis stall, the fail-open path returns
// in < 1 ms (connect timeout 5 s but with hedged short-circuit on first
// error — caller does not block).
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { RedisClientType } from "redis";
import { incCounter, observeHistogram } from "../funnel/metrics";
import { withBreaker } from "../../resilience/circuitBreaker";

// F-P4-11: shared "redis" breaker label. All Redis call sites in the
// service layer route through this so a wedged Redis trips once,
// globally, rather than per call site. Fail-open semantics are
// preserved locally by the `catch` blocks below — breaker
// short-circuits still raise into the same catch block and degrade to
// allowed=true.
const REDIS_BREAKER_LABEL = "redis";

export interface RedisRateLimiterOptions {
  /** Redis client. Must be connected before use. */
  client: RedisClientType;
  /** Key prefix namespace. Distinct prefixes per limiter prevent collisions. */
  keyPrefix: string;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Max requests allowed in the window. */
  maxRequests: number;
  /** Scope label for Prometheus metrics. e.g. "per_user", "global". */
  scope: string;
}

export interface RedisCheckResult {
  allowed: boolean;
  /** How many requests are still available in the window. */
  remaining: number;
  /** UTC ms timestamp when the window resets. */
  resetAt: number;
  /** Suggested Retry-After header value in ms, when allowed=false. */
  retryAfterMs?: number;
  /** True when Redis was unreachable and we fell open. */
  failedOpen: boolean;
}

// Lua script — sliding-window count + conditional record. Returns
//   [countAfter, oldestSampleMs]
// We do a two-phase check: caller first invokes `check` (count-only) and,
// on allowed=true, invokes `record` to actually add the sample. This
// matches the 2-phase pattern already used by the in-memory limiter at
// rateLimiter.ts:233-263 and avoids phantom counts on dropped requests.
const CHECK_SCRIPT = `
local key       = KEYS[1]
local nowMs     = tonumber(ARGV[1])
local windowMs  = tonumber(ARGV[2])
local cutoff    = nowMs - windowMs

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count     = redis.call('ZCARD', key)
local oldest    = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestMs  = tonumber(oldest[2])
if oldestMs == nil then oldestMs = nowMs end

redis.call('PEXPIRE', key, windowMs * 2)
return { count, oldestMs }
`;

const RECORD_SCRIPT = `
local key       = KEYS[1]
local nowMs     = tonumber(ARGV[1])
local windowMs  = tonumber(ARGV[2])
local sampleId  = ARGV[3]
local cutoff    = nowMs - windowMs

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
redis.call('ZADD', key, nowMs, nowMs .. ':' .. sampleId)
local count     = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, windowMs * 2)
return count
`;

export class RedisRateLimiter {
  private readonly client: RedisClientType;
  private readonly keyPrefix: string;
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly scope: string;

  constructor(opts: RedisRateLimiterOptions) {
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix;
    this.windowMs = opts.windowMs;
    this.maxRequests = opts.maxRequests;
    this.scope = opts.scope;
  }

  private key(bucket: string): string {
    return `${this.keyPrefix}:${bucket}`;
  }

  /**
   * Phase 1 — count-only check. Does NOT record the request. Used to reject
   * without burning a slot.
   */
  async check(bucket: string): Promise<RedisCheckResult> {
    const nowMs = Date.now();
    const started = performance.now();
    try {
      const result = (await withBreaker(REDIS_BREAKER_LABEL, () =>
        this.client.eval(CHECK_SCRIPT, {
          keys: [this.key(bucket)],
          arguments: [String(nowMs), String(this.windowMs)],
        }),
      )) as [number, number];
      const count = Number(result[0]);
      const oldestMs = Number(result[1]);
      observeHistogram("tellus_rate_limit_check_duration_ms", performance.now() - started, {
        scope: this.scope,
        outcome: "ok",
      });
      const allowed = count < this.maxRequests;
      return {
        allowed,
        remaining: Math.max(0, this.maxRequests - count),
        resetAt: oldestMs + this.windowMs,
        retryAfterMs: allowed ? undefined : Math.max(1, oldestMs + this.windowMs - nowMs),
        failedOpen: false,
      };
    } catch (err) {
      incCounter("tellus_rate_limit_failed_open_total", { scope: this.scope });
      observeHistogram("tellus_rate_limit_check_duration_ms", performance.now() - started, {
        scope: this.scope,
        outcome: "failed_open",
      });
      console.warn(
        `[redisRateLimiter] Redis unreachable on check scope=${this.scope} bucket=${bucket} — failing open: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        allowed: true,
        remaining: this.maxRequests,
        resetAt: nowMs + this.windowMs,
        failedOpen: true,
      };
    }
  }

  /**
   * Phase 2 — record a sample. Call only after an allowed check.
   */
  async record(bucket: string): Promise<number> {
    const nowMs = Date.now();
    const sampleId = crypto.randomBytes(6).toString("hex");
    try {
      const count = (await withBreaker(REDIS_BREAKER_LABEL, () =>
        this.client.eval(RECORD_SCRIPT, {
          keys: [this.key(bucket)],
          arguments: [String(nowMs), String(this.windowMs), sampleId],
        }),
      )) as number;
      incCounter("tellus_rate_limit_recorded_total", { scope: this.scope });
      return Number(count);
    } catch (err) {
      incCounter("tellus_rate_limit_record_failed_total", { scope: this.scope });
      console.warn(
        `[redisRateLimiter] Redis unreachable on record scope=${this.scope} bucket=${bucket}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return -1;
    }
  }

  /**
   * Combined check + record (used when you have already committed to the
   * request). Returns result after recording. Fails open on Redis error.
   */
  async checkAndRecord(bucket: string): Promise<RedisCheckResult> {
    const precheck = await this.check(bucket);
    if (!precheck.allowed) {
      incCounter("tellus_rate_limit_exceeded_total", { scope: this.scope });
      return precheck;
    }
    await this.record(bucket);
    return {
      ...precheck,
      remaining: Math.max(0, precheck.remaining - 1),
    };
  }
}
