// ---------------------------------------------------------------------------
// branchInactivityCloser — auto-close cron (B7.10).
//
// Closes branches whose last `branch_overlays.created_at` is older than
// the inactivity threshold (default 30 days). Closing means flipping
// status from 'OPEN' → 'ABANDONED' and stamping closed_at = now().
// Branches with no overlays are eligible after `branches.created_at`
// passes the same threshold.
//
// Returns the count of branches closed. Idempotent — re-running on a
// quiet population is a no-op.
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";

export interface CloseResult {
  scanned: number;
  closed: number;
  cutoff: string;
}

export class BranchInactivityCloser {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Close every OPEN branch whose latest activity is older than
   * `inactivityDays` (default 30). Activity = MAX(overlay.created_at,
   * branch.created_at).
   */
  async runOnce(inactivityDays = 30): Promise<CloseResult> {
    const cutoffSql = `now() - ($1 || ' days')::interval`;

    // Count scan candidates first so the result reports something
    // meaningful even when nothing is closed.
    const { rows: scannedRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM branches WHERE status = 'OPEN'`,
    );
    const scanned = Number(scannedRows[0].count);

    const { rows: closedRows } = await this.pool.query<{ id: string }>(
      `WITH last_activity AS (
         SELECT b.id,
                COALESCE(MAX(bo.created_at), b.created_at) AS ts
         FROM branches b
         LEFT JOIN branch_overlays bo ON bo.branch_id = b.id
         WHERE b.status = 'OPEN'
         GROUP BY b.id, b.created_at
       )
       UPDATE branches SET
         status = 'ABANDONED',
         updated_at = now()
       FROM last_activity la
       WHERE branches.id = la.id
         AND la.ts < ${cutoffSql}
       RETURNING branches.id`,
      [String(inactivityDays)],
    );
    const closed = closedRows.length;
    const { rows: cutoffRows } = await this.pool.query<{ cutoff: string }>(
      `SELECT (now() - ($1 || ' days')::interval)::text AS cutoff`,
      [String(inactivityDays)],
    );
    return { scanned, closed, cutoff: cutoffRows[0].cutoff };
  }
}

export const branchInactivityCloser = new BranchInactivityCloser();
