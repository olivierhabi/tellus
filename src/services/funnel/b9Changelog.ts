// B9.03 — Changelog phase: scan recent dataset rows since last_offset
// and emit a normalized stream of upserts/deletes.
//
// Design: this is a Foundry-faithful "tail the source" stage. We use a
// monotonic dataset-version watermark (`last_offset` on funnel_b9_state)
// to remember where we left off, and emit one Change record per row
// modified since that watermark. The source is abstracted via a
// `loadChanges(since: number)` injection so unit tests don't need a
// dataset.
import { pool as defaultPool } from "../../db";
import type { Pool } from "pg";

export interface Change {
  primaryKey: string;
  operation: 'UPSERT' | 'DELETE';
  payload?: Record<string, unknown>;
  version: number;
}

export interface ChangelogPhaseOpts {
  objectTypeRid: string;
  ontologyRid: string;
  branchRid?: string | null;
  loadChanges: (since: number) => Promise<Change[]>;
}

export class B9Changelog {
  constructor(private readonly pool: Pool = defaultPool) {}

  async readState(objectTypeRid: string, branchRid: string | null = null): Promise<{ phase: string; lastOffset: number }> {
    const { rows } = await this.pool.query<{ phase: string; last_offset: string }>(
      `SELECT phase, last_offset FROM funnel_b9_state
       WHERE object_type_rid = $1
         AND COALESCE(branch_rid, '__main__') = COALESCE($2, '__main__')`,
      [objectTypeRid, branchRid],
    );
    if (rows.length === 0) return { phase: 'IDLE', lastOffset: 0 };
    return { phase: rows[0].phase, lastOffset: Number(rows[0].last_offset) };
  }

  async run(opts: ChangelogPhaseOpts): Promise<{ changes: Change[]; advancedTo: number }> {
    const branchRid = opts.branchRid ?? null;
    const state = await this.readState(opts.objectTypeRid, branchRid);
    await this.pool.query(
      `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, branch_rid, phase)
       VALUES ($1, $2, $3, 'CHANGELOG')
       ON CONFLICT (object_type_rid, COALESCE(branch_rid, '__main__'))
       DO UPDATE SET phase = 'CHANGELOG', updated_at = now()`,
      [opts.objectTypeRid, opts.ontologyRid, branchRid],
    );
    const changes = await opts.loadChanges(state.lastOffset);
    const advancedTo = changes.length === 0
      ? state.lastOffset
      : Math.max(state.lastOffset, ...changes.map((c) => c.version));
    if (advancedTo > state.lastOffset) {
      await this.pool.query(
        `UPDATE funnel_b9_state SET last_offset = $3, last_run_at = now(), updated_at = now()
         WHERE object_type_rid = $1
           AND COALESCE(branch_rid, '__main__') = COALESCE($2, '__main__')`,
        [opts.objectTypeRid, branchRid, advancedTo],
      );
    }
    return { changes, advancedTo };
  }
}
export const b9Changelog = new B9Changelog();
