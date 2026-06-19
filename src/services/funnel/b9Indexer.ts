// B9.05 — Indexer phase: take the merged Change set, group by op, and
// emit a single OpenSearch bulk request body. The actual `_bulk` POST
// is delegated to the injected `bulkFn` so this stage is testable
// without a live OS cluster.
import type { MergedChange } from "./b9MergeChanges";

export interface BulkAction {
  action: 'index' | 'delete';
  _index: string;
  _id: string;
  doc?: Record<string, unknown>;
}

export interface BulkResponse {
  took: number;
  errors: boolean;
  itemCount: number;
}

export type BulkFn = (actions: BulkAction[]) => Promise<BulkResponse>;

export class B9Indexer {
  /**
   * Convert merged changes into bulk actions and call the injected
   * `bulkFn`.  Returns the bulk response plus the action count so
   * callers can advance throughput counters.
   */
  async run(opts: {
    indexName: string;
    changes: MergedChange[];
    bulkFn: BulkFn;
  }): Promise<{ resp: BulkResponse; actionCount: number }> {
    const actions: BulkAction[] = opts.changes.map((c) => ({
      action: c.operation === 'DELETE' ? 'delete' : 'index',
      _index: opts.indexName,
      _id: c.primaryKey,
      doc: c.operation === 'DELETE' ? undefined : (c.payload ?? {}),
    }));
    const resp = await opts.bulkFn(actions);
    return { resp, actionCount: actions.length };
  }
}

export const b9Indexer = new B9Indexer();
