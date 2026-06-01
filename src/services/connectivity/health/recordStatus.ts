// ---------------------------------------------------------------------------
// Shared connection status writer (B3/health).
//
// Both the on-demand probe (handlers/test.handler.ts) and the background
// health prober (health/prober.ts) need to persist a probe outcome to a
// connection's status + status-log history. This module owns that single
// best-effort writer so the two callers cannot drift apart.
//
// Best-effort by contract: a logging failure must never turn a successful
// probe into an error or crash the background prober loop, so all faults are
// swallowed after a warning.
// ---------------------------------------------------------------------------

import { sanitizeForLog } from "../../../lib/errors/envelope";
import { appendStatusLog } from "../store/connections.repo";

/** Terminal probe states persisted to a connection's status. */
export type ConnectionHealthState =
  | "HEALTHY"
  | "AUTH_FAILED"
  | "TLS_FAILED"
  | "UNREACHABLE"
  | "DEGRADED";

/**
 * Persist a probe outcome to the connection's status (and the status-log
 * history surfaced by GET /connections/:rid/status). Best-effort: swallows
 * all faults after a warning so callers can treat it as fire-and-forget.
 */
export async function recordStatus(
  rid: string,
  state: ConnectionHealthState,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await appendStatusLog(rid, state, details);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[connectivity.health] status log write failed",
      sanitizeForLog({
        rid,
        state,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

/** Map a TellusError raised before/within a probe to a status state. */
export function stateForTellusError(
  errorName: string,
): "AUTH_FAILED" | "TLS_FAILED" | "UNREACHABLE" | "DEGRADED" {
  if (errorName.endsWith("JdbcAuthFailed")) return "AUTH_FAILED";
  if (errorName.endsWith("JdbcTlsHandshakeFailed")) return "TLS_FAILED";
  if (errorName.endsWith("EgressBlocked")) return "DEGRADED";
  return "UNREACHABLE";
}
