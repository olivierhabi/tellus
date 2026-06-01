// ---------------------------------------------------------------------------
// B2 — Credential rotation worker (spec acceptance criterion 3).
//
// Polls credentials whose `rotate_at` is in the past (or whose age exceeds
// the configured max), invokes the secret's rotation procedure (driver-
// specific), re-wraps the new material, and emits an audit row.
//
// Spec demands rotation within 24h of expiry; we poll every 5 minutes and
// trigger rotation when (now - created_at) > rotate_after_days - ROTATION_LEEWAY_DAYS.
// Column names match the connectivity_credentials schema (076 + 087):
// `created_at` is the issue time and `superseded_at IS NULL` marks the live row.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";
import { rewrap, ROTATION_LEEWAY_DAYS } from "./vault";
import * as audit from "./audit.repo";

let timer: NodeJS.Timeout | null = null;

/** Default poll interval — 5 minutes. */
const POLL_MS = Number(process.env.TELLUS_CRED_ROTATION_POLL_MS ?? 5 * 60_000);

export function startRotationWorker(): void {
  if (process.env.TELLUS_DISABLE_CRED_ROTATION === "1") return;
  if (timer) return;
  timer = setInterval(() => {
    void rotateDue().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[connectivity.credentials.rotation] tick failed", err);
    });
  }, POLL_MS);
  // First sweep on boot so a freshly-restarted process catches up.
  void rotateDue().catch(() => undefined);
}

export function stopRotationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Process all credentials whose rotation is due. Exported for tests. */
export async function rotateDue(): Promise<{ rotated: number; failed: number }> {
  const client = await pool.connect();
  let rotated = 0;
  let failed = 0;
  try {
    const due = await client.query<{
      connection_rid: string;
      tenant: string;
      field: string;
      version: number;
      rotate_after_days: number | null;
    }>(
      `SELECT connection_rid, tenant, field, version, rotate_after_days
         FROM connectivity_credentials
        WHERE superseded_at IS NULL
          AND rotate_after_days IS NOT NULL
          AND created_at < now() - (rotate_after_days * INTERVAL '1 day')
                          + ($1::int * INTERVAL '1 day')
        ORDER BY created_at ASC
        LIMIT 50`,
      [ROTATION_LEEWAY_DAYS],
    );
    for (const row of due.rows) {
      try {
        await rewrap(client, row.connection_rid, row.field);
        await audit.write({
          connectionRid: row.connection_rid,
          tenant: row.tenant,
          field: row.field,
          version: row.version,
          operation: "rotate",
          actor: "system:rotation-worker",
          outcome: "success",
        });
        rotated += 1;
      } catch (err) {
        failed += 1;
        await audit
          .write({
            connectionRid: row.connection_rid,
            tenant: row.tenant,
            field: row.field,
            version: row.version,
            operation: "rotate",
            actor: "system:rotation-worker",
            outcome: "failure",
            reason: err instanceof Error ? err.message : String(err),
          })
          .catch(() => undefined);
      }
    }
  } finally {
    client.release();
  }
  return { rotated, failed };
}
