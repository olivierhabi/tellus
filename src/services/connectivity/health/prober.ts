// ---------------------------------------------------------------------------
// Background connection health prober (B3).
//
// The on-demand probe (`POST /connections/:rid/test`) only updates a
// connection's status when a user clicks "Test". Without a background sweep a
// connection that silently goes UNREACHABLE (server down, credential revoked,
// egress drift) keeps reporting its last user-triggered state until someone
// notices. This prober periodically opens each active connection's pool, runs
// a cheap liveness query, and records the outcome via the shared recordStatus
// path — the same status surface the on-demand probe writes.
//
// Lifecycle mirrors the credential rotation worker: a guarded setInterval that
// unrefs (so it never holds the event loop open), an opt-out env var, and a
// first sweep on boot. Probes are best-effort: a failure records a status and
// is otherwise swallowed so one bad connection can't abort the sweep.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";
import { getPool } from "../connectors/postgresql/pool";
import { TellusError } from "../../../lib/errors/envelope";
import { recordStatus, stateForTellusError } from "./recordStatus";

let timer: NodeJS.Timeout | null = null;

/** Default poll interval — 5 minutes. */
const POLL_MS = Number(process.env.TELLUS_HEALTH_PROBE_POLL_MS ?? 5 * 60_000);

/** Per-probe liveness-query timeout. */
const PROBE_TIMEOUT_MS = Number(
  process.env.TELLUS_HEALTH_PROBE_TIMEOUT_MS ?? 5_000,
);

/** Max connections probed per sweep — bounds load across many tenants. */
const PROBE_BATCH = Number(process.env.TELLUS_HEALTH_PROBE_BATCH ?? 100);

export function startHealthProber(): void {
  if (process.env.TELLUS_DISABLE_HEALTH_PROBER === "1") return;
  if (timer) return;
  timer = setInterval(() => {
    void probeAll().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[connectivity.health.prober] tick failed", err);
    });
  }, POLL_MS);
  // setInterval keeps the loop alive otherwise; the prober is background-only.
  timer.unref?.();
  // First sweep on boot so a freshly-restarted process refreshes status.
  void probeAll().catch(() => undefined);
}

export function stopHealthProber(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms);
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

/** Classify a non-Tellus probe error into a status state. */
function stateForProbeError(err: unknown): "AUTH_FAILED" | "TLS_FAILED" | "UNREACHABLE" {
  const e = err as { code?: string; message?: string } | undefined;
  if (e?.code === "28P01" || e?.code === "28000") return "AUTH_FAILED";
  if (/tls|ssl|certificate|self-signed/i.test(e?.message ?? "")) return "TLS_FAILED";
  return "UNREACHABLE";
}

/**
 * Probe every active PostgreSQL connection once. Exported for tests.
 * Returns a tally of probe outcomes.
 */
export async function probeAll(): Promise<{ healthy: number; unhealthy: number }> {
  const active = await pool.query<{ rid: string }>(
    `SELECT rid FROM connectivity_connections
      WHERE deleted_at IS NULL
        AND connector_type = 'postgresql'
      ORDER BY updated_at ASC
      LIMIT $1`,
    [PROBE_BATCH],
  );

  let healthy = 0;
  let unhealthy = 0;
  for (const { rid } of active.rows) {
    try {
      const pg = await getPool(rid);
      await withTimeout(pg.query("SELECT 1"), PROBE_TIMEOUT_MS);
      await recordStatus(rid, "HEALTHY", { probedBy: "system:health-prober" });
      healthy += 1;
    } catch (err) {
      const state =
        err instanceof TellusError
          ? stateForTellusError(err.definition.errorName)
          : stateForProbeError(err);
      await recordStatus(rid, state, {
        probedBy: "system:health-prober",
        reason:
          err instanceof TellusError
            ? err.definition.errorName
            : err instanceof Error
              ? err.message
              : String(err),
      });
      unhealthy += 1;
    }
  }
  return { healthy, unhealthy };
}
