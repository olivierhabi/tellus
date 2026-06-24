// B9.07 — Funnel orchestrator: run all 4 phases in sequence and update
// funnel_b9_state.phase between each step. On any error the phase is
// flipped to ERROR and last_error is recorded. Successful completion
// flips back to IDLE.
import { pool as defaultPool } from "../../db";
import type { Pool } from "pg";
import { B9Changelog, type Change } from "./b9Changelog";
import { B9MergeChanges } from "./b9MergeChanges";
import { B9Indexer, type BulkFn } from "./b9Indexer";
import { B9Hydrator, type ApplyFn } from "./b9Hydrator";

export interface FunnelRunOpts {
  objectTypeRid: string;
  ontologyRid: string;
  branchRid?: string | null;
  indexName: string;
  loadChanges: (since: number) => Promise<Change[]>;
  bulkFn: BulkFn;
  applyFn: ApplyFn;
}

export class FunnelOrchestrator {
  private readonly changelog: B9Changelog;
  private readonly merger: B9MergeChanges;
  private readonly indexer: B9Indexer;
  private readonly hydrator: B9Hydrator;
  constructor(private readonly pool: Pool = defaultPool) {
    this.changelog = new B9Changelog(pool);
    this.merger = new B9MergeChanges();
    this.indexer = new B9Indexer();
    this.hydrator = new B9Hydrator();
  }

  private async setPhase(objectTypeRid: string, branchRid: string | null, phase: string, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE funnel_b9_state SET phase = $3, last_error = $4, updated_at = now()
       WHERE object_type_rid = $1
         AND COALESCE(branch_rid, '__main__') = COALESCE($2, '__main__')`,
      [objectTypeRid, branchRid, phase, error ?? null],
    );
  }

  async run(opts: FunnelRunOpts): Promise<{
    phase: 'IDLE' | 'ERROR';
    advancedTo: number;
    indexed: number;
    hydrated: { upserts: number; deletes: number };
    error?: string;
  }> {
    const branchRid = opts.branchRid ?? null;
    try {
      // Phase 1: Changelog
      const cl = await this.changelog.run({ objectTypeRid: opts.objectTypeRid, ontologyRid: opts.ontologyRid, branchRid, loadChanges: opts.loadChanges });

      // Phase 2: MergeChanges
      await this.setPhase(opts.objectTypeRid, branchRid, 'MERGE_CHANGES');
      const merged = this.merger.merge(cl.changes);

      // Phase 3: Indexer
      await this.setPhase(opts.objectTypeRid, branchRid, 'INDEXER');
      const idx = await this.indexer.run({ indexName: opts.indexName, changes: merged, bulkFn: opts.bulkFn });

      // Phase 4: Hydrator
      await this.setPhase(opts.objectTypeRid, branchRid, 'HYDRATOR');
      const hyd = await this.hydrator.run({ changes: merged, applyFn: opts.applyFn });

      // Done → IDLE.
      await this.setPhase(opts.objectTypeRid, branchRid, 'IDLE');
      return { phase: 'IDLE', advancedTo: cl.advancedTo, indexed: idx.actionCount, hydrated: hyd };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await this.setPhase(opts.objectTypeRid, branchRid, 'ERROR', msg);
      return { phase: 'ERROR', advancedTo: 0, indexed: 0, hydrated: { upserts: 0, deletes: 0 }, error: msg };
    }
  }
}
export const funnelOrchestrator = new FunnelOrchestrator();
