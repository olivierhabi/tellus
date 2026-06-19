// B9.06 — Hydrator phase: project the materialized OS index back into
// the Postgres `objects` row store so transactional reads stay current.
//
// The hydrator takes a batch of merged Changes and applies them via the
// injected `applyFn`. Returns counts of upserts and deletes performed.
import type { MergedChange } from "./b9MergeChanges";

export type ApplyFn = (op: 'UPSERT' | 'DELETE', primaryKey: string, doc?: Record<string, unknown>) => Promise<void>;

export class B9Hydrator {
  async run(opts: { changes: MergedChange[]; applyFn: ApplyFn }): Promise<{ upserts: number; deletes: number }> {
    let upserts = 0, deletes = 0;
    for (const c of opts.changes) {
      await opts.applyFn(c.operation, c.primaryKey, c.payload);
      if (c.operation === 'UPSERT') upserts++;
      else deletes++;
    }
    return { upserts, deletes };
  }
}
export const b9Hydrator = new B9Hydrator();
