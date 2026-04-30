// ---------------------------------------------------------------------------
// indexRetentionSweep.ts — delete old -v{N-1} indices after 24h
// ---------------------------------------------------------------------------
// Spec §Task 13:
//   "Keep old index for 24h after migration."
//
// After a schema migration atomically swaps the alias from
// `objects-flight-v{N-1}` → `objects-flight-v{N}`, we leave the old
// index in place for rollback. This sweeper is invoked on an interval
// (60s) to reap any old-version index whose alias swap is older than
// 24h. Retention metadata is persisted on the `export_job` row created
// by the migration endpoint under `query_json.retainPreviousUntil`.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { client as osClient } from "../services/opensearch/client";

const RETENTION_MS = 24 * 60 * 60 * 1000;

export async function sweepStaleIndices(): Promise<{
  deleted: string[];
  kept: string[];
  errors: string[];
}> {
  const deleted: string[] = [];
  const kept: string[] = [];
  const errors: string[] = [];

  // Find all migration jobs whose retention window has elapsed but whose
  // previousIndex hasn't been marked deleted yet.
  const result = await query(
    `SELECT job_id, query_json
       FROM export_job
      WHERE (query_json->>'migration')::boolean = true
        AND query_json->>'previousIndex' IS NOT NULL
        AND (query_json->>'deleted')::boolean IS NOT true
        AND (query_json->>'retainPreviousUntil')::timestamptz < now()`
  );

  for (const row of result.rows) {
    const cfg = row.query_json as {
      previousIndex?: string;
      retainPreviousUntil?: string;
    };
    if (!cfg.previousIndex) continue;
    try {
      // Idempotent delete — ignore index_not_found.
      await osClient.indices.delete({
        index: cfg.previousIndex,
        ignore_unavailable: true,
      });
      deleted.push(cfg.previousIndex);
      await query(
        `UPDATE export_job
            SET query_json = query_json || '{"deleted": true}'::jsonb,
                updated_at = now()
          WHERE job_id = $1`,
        [row.job_id]
      );
    } catch (err) {
      errors.push(
        `${cfg.previousIndex}: ${err instanceof Error ? err.message : String(err)}`
      );
      kept.push(cfg.previousIndex);
    }
  }

  return { deleted, kept, errors };
}

/**
 * Wire the sweep into a setInterval. Call once from server.ts on startup.
 * Returns the interval handle so tests can clear it.
 */
export function startRetentionSweep(intervalMs: number = 60_000): NodeJS.Timeout {
  const tick = () => {
    sweepStaleIndices().catch((err) => {
      console.error("[indexRetentionSweep] sweep failed:", err);
    });
  };
  return setInterval(tick, intervalMs);
}
