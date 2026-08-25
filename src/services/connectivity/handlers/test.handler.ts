// ---------------------------------------------------------------------------
// B3 — testConnection handler (spec §B3 line 141, acceptance criterion 1).
//
// POST /api/v1/connectivity/connections/:rid/test
// Auth: scope `connectivity:read`.
// Behaviour: opens a pooled connection, runs `SELECT version()`, returns
//   { ok: true, serverVersion, latencyMs } in <2s on a healthy PG 16.
// Errors:
//   - Tellus:Connectivity:JdbcAuthFailed (401) — invalid credentials
//   - Tellus:Connectivity:JdbcConnectFailed (502) — network/TLS failure
//   - Tellus:Connectivity:DriverMismatch (400) — non-PG connection type
//   - Tellus:Connectivity:ConnectionNotFound (404)
// No plaintext from upstream is forwarded; messages are sanitized to a
// curated whitelist to defend criterion 2 (no plaintext in response or logs).
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { z } from "zod";
import { getPool, evict } from "../connectors/postgresql/pool";
import { assemblePgPoolOptions } from "../connectors/postgresql/config";
import { assertEgressResolved } from "../connectors/postgresql/egress";
import { PostgresConfig, TlsMode } from "../contracts";
import {
  TellusError,
  sanitizeForLog,
} from "../../../lib/errors/envelope";
import {
  EgressRateLimited,
  InvalidConfiguration,
  JdbcAuthFailed,
  JdbcConnectFailed,
} from "../../../lib/errors/connectivity.errors";
import { extractUser, requireScope } from "./connections.handler";
import { recordStatus, stateForTellusError } from "../health/recordStatus";
import { observeProbe } from "../metrics";
import { limiter } from "../../../middleware/rateLimiter";

// Probe budget for the liveness query. This must exceed the pool's
// connectionTimeoutMillis (config.ts: cfg.connectTimeoutMs ?? 10_000), or the
// handler gives up while the driver is still legitimately dialing and reports a
// misleading "timeout after 2000ms" for what is really a slow — but reachable —
// server. Budget = connect allowance + query allowance.
const QUERY_BUDGET_MS = Number(process.env.CONNECTIVITY_PROBE_QUERY_BUDGET_MS ?? 5_000);

/** Total probe deadline for a config whose connect timeout is `connectMs`. */
function probeBudgetMs(connectMs: number | undefined): number {
  return (connectMs ?? 10_000) + QUERY_BUDGET_MS;
}

// Connection-probe abuse guard. Both probe endpoints (`/test`, `/test-config`)
// open real outbound sockets, so they are the natural lever for SSRF sweeps and
// credential-stuffing. Cap each principal to a small burst per minute; the
// scope gate (`connectivity:test`/`read`) is the coarse guard, this is the rate
// guard. Reuses the shared in-memory token-bucket so it degrades gracefully
// without Redis.
const TEST_WINDOW_MS = 60_000;
const TEST_MAX_PER_WINDOW = 6;

export function testRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Authenticated principals are EXEMPT from the connection-test rate limit.
  // These endpoints already sit behind globalAuth + the connectivity:test/read
  // scope, and the reserved-range SSRF guard (assertEgressForConfig /
  // assertEgressResolved) is what actually bounds where a probe may be aimed —
  // the token bucket here is only a secondary velocity cap. Throttling
  // legitimate authenticated users (who routinely re-test while configuring a
  // source) produced 429 EgressRateLimited friction for no real security gain.
  // The bucket is retained for the unauthenticated fallback as defense in depth
  // (globalAuth normally makes that path unreachable). Set
  // CONNECTIVITY_TEST_RATE_LIMIT_ALL=0 to exempt authenticated callers.
  let principalId: string | null = null;
  try {
    principalId = extractUser(req).id;
  } catch {
    principalId = null;
  }

  if (principalId && process.env.CONNECTIVITY_TEST_RATE_LIMIT_ALL === "0") {
    next();
    return;
  }

  const principal =
    principalId ??
    ((req.ip ?? (req.socket && req.socket.remoteAddress) ?? "anonymous") as string);
  const key = `connectivity:test:${principal}`;
  const check = limiter.tryCheck(key, TEST_MAX_PER_WINDOW, TEST_WINDOW_MS);
  if (!check.allowed) {
    const retryAfterSec = Math.ceil((check.retryAfterMs || TEST_WINDOW_MS) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    new TellusError(EgressRateLimited, { retryAfterSec }).send(res);
    return;
  }
  limiter.record(key, TEST_WINDOW_MS);
  next();
}

export async function testConnection(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rid = req.params.rid;
  const started = process.hrtime.bigint();
  try {
    const pool = await getPool(rid);
    // Check out a single client rather than using pool.query so a timeout can
    // destroy THAT connection (release(true)) instead of abandoning a query
    // that keeps running while its client stays checked out. The pool is shared
    // and cached per source, so it must never be torn down by one probe.
    const client = await pool.connect();
    let released = false;
    let result;
    try {
      result = await withTimeout(
        client.query<{ version: string }>("SELECT version() AS version"),
        // The pool was built by assemblePgPoolOptions, so its own
        // connectionTimeoutMillis is this connection's real connect allowance —
        // read it back rather than re-deriving the default.
        probeBudgetMs(
          (pool as unknown as { options?: { connectionTimeoutMillis?: number } })
            .options?.connectionTimeoutMillis,
        ),
        () => {
          released = true;
          client.release(true);
        },
      );
    } finally {
      // Track the release explicitly rather than inferring it from `result`:
      // every non-timeout rejection (auth failure being the common one) leaves
      // `result` undefined with the client still checked out, so inferring
      // leaked one connection per failed probe.
      if (!released) client.release();
    }
    const latencyMs = Number(
      (process.hrtime.bigint() - started) / 1_000_000n,
    );
    observeProbe("postgresql", "HEALTHY", latencyMs);
    await recordStatus(rid, "HEALTHY", {
      serverVersion: result.rows[0].version,
      latencyMs,
    });
    res.status(200).json({
      ok: true,
      serverVersion: result.rows[0].version,
      latencyMs,
    });
  } catch (err) {
    if (err instanceof TellusError) {
      // Already a normalised Tellus error (from getPool, vault, egress, etc.).
      // eslint-disable-next-line no-console
      console.warn(
        "[connectivity.test] failed",
        sanitizeForLog({ rid, errorName: err.definition.errorName }),
      );
      const state = stateForTellusError(err.definition.errorName);
      observeProbe("postgresql", state, elapsedMsSince(started));
      await recordStatus(rid, state, {
        errorName: err.definition.errorName,
      });
      err.send(res);
      return;
    }
    const mapped = mapPgError(err);
    if (mapped.kind === "auth") {
      // Eagerly evict the pool — credential may have rotated server-side.
      await evict(rid).catch(() => undefined);
    }
    const probeState = probeStateForMapped(mapped);
    observeProbe("postgresql", probeState, elapsedMsSince(started));
    await recordStatus(rid, probeState, { reason: mapped.reason });
    // eslint-disable-next-line no-console
    console.warn(
      "[connectivity.test] failed",
      sanitizeForLog({
        rid,
        kind: mapped.kind,
        reason: mapped.reason,
      }),
    );
    if (mapped.kind === "auth") {
      new TellusError(JdbcAuthFailed, { connectionRid: rid }).send(res);
      return;
    }
    if (mapped.kind === "connect") {
      new TellusError(JdbcConnectFailed, {
        connectionRid: rid,
        reason: mapped.reason,
      }).send(res);
      return;
    }
    next(err);
  }
}

// ---------------------------------------------------------------------------
// testConfig — transient, NON-persisted connection probe.
//
// POST /api/v1/connectivity/connections/test-config
// Auth: scope `connectivity:test`.
//
// Drives the "Test connection" button in the new-source wizard BEFORE the
// connection is created. Builds a one-off pg.Pool from the supplied config +
// password (never written to the vault or DB), runs `SELECT version()`, and
// always tears the pool down. Same error taxonomy as testConnection so the
// FE renders identical auth/connect failures.
//
// The scope gate (`connectivity:test`) prevents an arbitrary authenticated
// principal from using the server as an SSRF probe of internal hosts.
// ---------------------------------------------------------------------------

const TestConfigBody = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
  password: z.string().max(4096).default(""),
  tlsMode: TlsMode.default("disable"),
});

export async function testConfig(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let pool: Pool | undefined;
  const started = process.hrtime.bigint();
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:test");

    const parsed = TestConfigBody.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    // SSRF guard: this probe runs before a connection (and its egress
    // allowlist) exists, so deny reserved/internal targets (loopback,
    // link-local cloud metadata, RFC-1918) before any socket is opened.
    // Resolves the host and validates every resolved IP, returning a vetted
    // address to pin the connection to (closes the DNS-rebinding TOCTOU window).
    const pinnedHost = await assertEgressResolved(body.host, body.port);

    // Normalize through the canonical PostgresConfig so defaults/timeouts
    // (and the TLS assembly) match a real connection exactly.
    const cfg = PostgresConfig.parse({
      host: body.host,
      port: body.port,
      database: body.database,
      user: body.user,
      tlsMode: body.tlsMode,
    });
    const opts = assemblePgPoolOptions(cfg, {
      user: body.user,
      password: body.password,
    });
    // Connect to the validated, pinned IP rather than re-resolving the host
    // (closes the DNS-rebinding TOCTOU window). Keep the original hostname as
    // the TLS servername so verify-full certificate identity checks still
    // validate against the real host, not the pinned address.
    const pinnedOpts =
      opts.ssl && typeof opts.ssl === "object"
        ? { ...opts, host: pinnedHost, ssl: { ...opts.ssl, servername: body.host } }
        : { ...opts, host: pinnedHost };
    // One connection is enough for a probe; cap the pool to avoid leaks.
    pool = new Pool({ ...pinnedOpts, max: 1 });

    // This pool is single-use and torn down in `finally`, so ending it is the
    // cancellation mechanism — no need to isolate an individual client.
    const probePool = pool;
    const result = await withTimeout(
      probePool.query<{ version: string }>("SELECT version() AS version"),
      probeBudgetMs(cfg.connectTimeoutMs),
      () => void probePool.end().catch(() => undefined),
    );
    const latencyMs = elapsedMsSince(started);
    observeProbe("postgresql", "HEALTHY", latencyMs);
    res.status(200).json({
      ok: true,
      serverVersion: result.rows[0].version,
      latencyMs,
    });
  } catch (err) {
    if (err instanceof TellusError) {
      // Only real probe outcomes belong in the latency histogram. A rejected
      // scope or a malformed body never opened a socket, and folding them in as
      // UNREACHABLE would make the wizard's own validation noise look like
      // target-database failures.
      if (isProbeOutcome(err.definition.errorName)) {
        observeProbe(
          "postgresql",
          stateForTellusError(err.definition.errorName),
          elapsedMsSince(started),
        );
      }
      err.send(res);
      return;
    }
    const mapped = mapPgError(err);
    // eslint-disable-next-line no-console
    console.warn(
      "[connectivity.testConfig] failed",
      sanitizeForLog({ kind: mapped.kind, reason: mapped.reason }),
    );
    observeProbe("postgresql", probeStateForMapped(mapped), elapsedMsSince(started));
    if (mapped.kind === "auth") {
      // Uniform response envelope: never disclose to the caller whether the
      // failure was refused-connection, auth, timeout, or protocol mismatch —
      // that distinction is an internal service fingerprint. The internal
      // classification above stays for metrics/logging only.
      new TellusError(JdbcConnectFailed, {}).send(res);
      return;
    }
    if (mapped.kind === "connect") {
      new TellusError(JdbcConnectFailed, { reason: mapped.reason }).send(res);
      return;
    }
    next(err);
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

/** Milliseconds elapsed since an hrtime mark. */
function elapsedMsSince(started: bigint): number {
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}

/**
 * True when a TellusError describes the outcome of an actual connection attempt
 * (or a refusal to make one) rather than a caller-side rejection. Scope denials
 * and body-validation failures are excluded so they never appear as probe
 * latency samples.
 */
function isProbeOutcome(errorName: string): boolean {
  return !/InvalidConfiguration|ScopeRequired|RateLimit/.test(errorName);
}

/** Probe state for a driver error already classified by mapPgError. */
function probeStateForMapped(mapped: {
  kind: string;
  reason: string;
}): "AUTH_FAILED" | "TLS_FAILED" | "UNREACHABLE" {
  if (mapped.kind === "auth") return "AUTH_FAILED";
  if (/tls|ssl|certificate|self-signed/i.test(mapped.reason)) return "TLS_FAILED";
  return "UNREACHABLE";
}

/**
 * Reject after `ms`, running `onTimeout` first. Without that hook a timed-out
 * probe abandons the promise while the query keeps running on the server and the
 * connection stays checked out — under repeated timeouts that exhausts the pool.
 * Callers pass a destroyer so the socket is torn down, which is what actually
 * cancels the backend query.
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* best effort — we're already failing this probe */
      }
      reject(
        new TellusError(JdbcConnectFailed, {
          reason: `timeout after ${ms}ms`,
        }),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface MappedPgError {
  kind: "auth" | "connect" | "other";
  reason: string;
}

// Node syscall errors carry the string identifier ("ECONNREFUSED") in `code`;
// `errno` is the NUMERIC constant (-61). Matching on `errno === "ECONNREFUSED"`
// never fires, which routed every network failure to the generic 500 handler.
const CONNECT_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);

/** Exported for unit tests (see tests/connectivity/unit/pg-error-mapping-unit.test.ts). */
export function mapPgError(err: unknown): MappedPgError {
  const e = err as { code?: string; message?: string } | undefined;
  if (
    e?.code === "28P01" /* invalid_password */ ||
    e?.code === "28000" /* invalid_authorization_specification */
  ) {
    return { kind: "auth", reason: "credentials rejected" };
  }
  if (
    (e?.code && CONNECT_ERROR_CODES.has(e.code)) ||
    /tls|ssl|self-signed|certificate/i.test(e?.message ?? "")
  ) {
    return { kind: "connect", reason: classifyConnectFailure(e) };
  }
  return { kind: "other", reason: "unknown" };
}

function classifyConnectFailure(
  e: { code?: string; message?: string } | undefined,
): string {
  const m = e?.message ?? "";
  if (/self-signed/i.test(m)) return "tls self-signed";
  if (/certificate/i.test(m)) return "tls certificate invalid";
  if (e?.code === "ETIMEDOUT") return "connect timeout";
  if (e?.code === "ECONNREFUSED") return "connection refused";
  if (e?.code === "ENOTFOUND") return "host not resolvable";
  return "network unreachable";
}
