// ---------------------------------------------------------------------------
// B3 — testConnection handler (spec §B3 line 141, acceptance criterion 1).
//
// POST /api/v2/connectivity/connections/:rid/test
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
import { assertEgressForConfig } from "../connectors/postgresql/egress";
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
import { limiter } from "../../../middleware/rateLimiter";

const TIMEOUT_MS = 2_000;

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
  let principal = "anonymous";
  try {
    principal = extractUser(req).id;
  } catch {
    principal =
      (req.ip ?? (req.socket && req.socket.remoteAddress) ?? "anonymous") as string;
  }
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
    const result = await withTimeout(
      pool.query<{ version: string }>("SELECT version() AS version"),
      TIMEOUT_MS,
    );
    const latencyMs = Number(
      (process.hrtime.bigint() - started) / 1_000_000n,
    );
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
      await recordStatus(rid, stateForTellusError(err.definition.errorName), {
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
    const probeState =
      mapped.kind === "auth"
        ? "AUTH_FAILED"
        : /tls|ssl|certificate|self-signed/i.test(mapped.reason)
          ? "TLS_FAILED"
          : "UNREACHABLE";
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
// POST /api/v2/connectivity/connections/test-config
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
    assertEgressForConfig(body.host, body.port);

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
    // One connection is enough for a probe; cap the pool to avoid leaks.
    pool = new Pool({ ...opts, max: 1 });

    const result = await withTimeout(
      pool.query<{ version: string }>("SELECT version() AS version"),
      TIMEOUT_MS,
    );
    const latencyMs = Number(
      (process.hrtime.bigint() - started) / 1_000_000n,
    );
    res.status(200).json({
      ok: true,
      serverVersion: result.rows[0].version,
      latencyMs,
    });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    const mapped = mapPgError(err);
    // eslint-disable-next-line no-console
    console.warn(
      "[connectivity.testConfig] failed",
      sanitizeForLog({ kind: mapped.kind, reason: mapped.reason }),
    );
    if (mapped.kind === "auth") {
      new TellusError(JdbcAuthFailed, {}).send(res);
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new TellusError(JdbcConnectFailed, {
            reason: `timeout after ${ms}ms`,
          }),
        ),
      ms,
    );
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

function mapPgError(err: unknown): MappedPgError {
  const e = err as { code?: string; message?: string; errno?: string } | undefined;
  if (
    e?.code === "28P01" /* invalid_password */ ||
    e?.code === "28000" /* invalid_authorization_specification */
  ) {
    return { kind: "auth", reason: "credentials rejected" };
  }
  if (
    e?.errno === "ENOTFOUND" ||
    e?.errno === "ECONNREFUSED" ||
    e?.errno === "EHOSTUNREACH" ||
    e?.errno === "ETIMEDOUT" ||
    /tls|ssl|self-signed|certificate/i.test(e?.message ?? "")
  ) {
    return { kind: "connect", reason: classifyConnectFailure(e) };
  }
  return { kind: "other", reason: "unknown" };
}

function classifyConnectFailure(
  e: { code?: string; message?: string; errno?: string } | undefined,
): string {
  const m = e?.message ?? "";
  if (/self-signed/i.test(m)) return "tls self-signed";
  if (/certificate/i.test(m)) return "tls certificate invalid";
  if (e?.errno === "ETIMEDOUT") return "connect timeout";
  if (e?.errno === "ECONNREFUSED") return "connection refused";
  if (e?.errno === "ENOTFOUND") return "host not resolvable";
  return "network unreachable";
}
