// B9.11 — Scheduled re-run job. Every 6 hours, scan funnel_b9_state for
// rows whose last_run_at is older than the threshold (default 6h) and
// trigger a fresh funnel run. Built around an injected `triggerFn` so
// it's testable without a live worker.
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";

export type TriggerFn = (objectTypeRid: string, ontologyRid: string, branchRid: string | null) => Promise<void>;

export class B9ScheduledRerun {
  constructor(private readonly pool: Pool = defaultPool) {}

  async runOnce(triggerFn: TriggerFn, opts: { staleHours?: number } = {}): Promise<{ scanned: number; triggered: number }> {
    const stale = opts.staleHours ?? 6;
    const { rows } = await this.pool.query<{ object_type_rid: string; ontology_rid: string; branch_rid: string | null }>(
      `SELECT object_type_rid, ontology_rid, branch_rid FROM funnel_b9_state
       WHERE last_run_at IS NULL OR last_run_at < now() - ($1 || ' hours')::interval`,
      [String(stale)],
    );
    let triggered = 0;
    for (const r of rows) {
      try {
        await triggerFn(r.object_type_rid, r.ontology_rid, r.branch_rid);
        triggered++;
      } catch (err) {
        // Log error but continue processing remaining rows
        console.error(`Failed to trigger funnel for object_type_rid=${r.object_type_rid}:`, err);
      }
    }
    return { scanned: rows.length, triggered };
  }
}
export const b9ScheduledRerun = new B9ScheduledRerun();
