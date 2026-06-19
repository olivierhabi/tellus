// B9.09 — Replacement pipeline: when an object_type's schema changes
// (a "replacement" event from OMS), we cannot incrementally re-index;
// instead we create a fresh OS index, full-load it, then atomically
// swap the alias to point at the new index and drop the old one.
//
// Design parallels the orchestrator: two injection points (`createIndex`
// and `swapAlias`) keep the pipeline testable without a live cluster.
import type { Change } from "./b9Changelog";
import type { BulkFn } from "./b9Indexer";

export interface ReplacementOpts {
  objectTypeRid: string;
  ontologyRid: string;
  oldIndexName: string;
  newIndexName: string;
  aliasName: string;
  loadAll: () => Promise<Change[]>;
  createIndex: (name: string) => Promise<void>;
  bulkFn: BulkFn;
  swapAlias: (alias: string, oldIndex: string, newIndex: string) => Promise<void>;
  deleteIndex: (name: string) => Promise<void>;
}

export class B9Replacement {
  async run(opts: ReplacementOpts): Promise<{ created: string; loaded: number; swapped: boolean; dropped: string }> {
    await opts.createIndex(opts.newIndexName);
    const all = await opts.loadAll();
    if (all.length > 0) {
      await opts.bulkFn(
        all.map((c) => ({
          action: c.operation === 'DELETE' ? 'delete' : 'index',
          _index: opts.newIndexName,
          _id: c.primaryKey,
          doc: c.operation === 'DELETE' ? undefined : (c.payload ?? {}),
        })),
      );
    }
    await opts.swapAlias(opts.aliasName, opts.oldIndexName, opts.newIndexName);
    await opts.deleteIndex(opts.oldIndexName);
    return { created: opts.newIndexName, loaded: all.length, swapped: true, dropped: opts.oldIndexName };
  }
}
export const b9Replacement = new B9Replacement();
