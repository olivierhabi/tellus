import { describe, expect, it } from "vitest";
import { B9Indexer, BulkAction, BulkResponse } from "../../../src/services/funnel/b9Indexer";

const svc = new B9Indexer();

describe("B9.05 — Indexer phase", () => {
  it("converts UPSERT changes into 'index' actions", async () => {
    const seen: BulkAction[] = [];
    const r = await svc.run({
      indexName: 'objects-v1',
      changes: [
        { primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { x: 1 } },
        { primaryKey: 'b', operation: 'UPSERT', version: 2 },
      ],
      bulkFn: async (a: BulkAction[]) => {
        seen.push(...a);
        return { took: 5, errors: false, itemCount: a.length } as BulkResponse;
      },
    });
    expect(seen.length).toBe(2);
    expect(seen.every((a) => a.action === 'index')).toBe(true);
    expect(r.actionCount).toBe(2);
  });

  it("converts DELETE changes into 'delete' actions", async () => {
    const seen: BulkAction[] = [];
    await svc.run({
      indexName: 'objects-v1',
      changes: [{ primaryKey: 'a', operation: 'DELETE', version: 5 }],
      bulkFn: async (a) => { seen.push(...a); return { took: 1, errors: false, itemCount: a.length }; },
    });
    expect(seen[0].action).toBe('delete');
    expect(seen[0].doc).toBeUndefined();
  });

  it("empty change set produces empty bulk request", async () => {
    let count = 0;
    const r = await svc.run({ indexName: 'x', changes: [], bulkFn: async (a) => { count = a.length; return { took: 0, errors: false, itemCount: 0 }; } });
    expect(count).toBe(0);
    expect(r.actionCount).toBe(0);
  });

  it("propagates bulk response errors flag", async () => {
    const r = await svc.run({
      indexName: 'x',
      changes: [{ primaryKey: 'a', operation: 'UPSERT', version: 1 }],
      bulkFn: async () => ({ took: 1, errors: true, itemCount: 1 }),
    });
    expect(r.resp.errors).toBe(true);
  });
});
