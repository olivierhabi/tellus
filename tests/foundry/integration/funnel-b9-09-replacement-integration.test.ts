import { describe, expect, it } from "vitest";
import { B9Replacement } from "../../../src/services/funnel/b9Replacement";

const svc = new B9Replacement();

describe("B9.09 — Replacement pipeline", () => {
  it("creates new index, full-loads, swaps alias, drops old", async () => {
    const created: string[] = [];
    const dropped: string[] = [];
    const swaps: Array<{ alias: string; old: string; nw: string }> = [];
    const r = await svc.run({
      objectTypeRid: 'ri.ontology.main.object-type.x',
      ontologyRid: 'ri.ontology.main.ontology.default',
      oldIndexName: 'objects-v1',
      newIndexName: 'objects-v2',
      aliasName: 'objects',
      loadAll: async () => [
        { primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { x: 1 } },
        { primaryKey: 'b', operation: 'UPSERT', version: 2 },
      ],
      createIndex: async (n) => { created.push(n); },
      bulkFn: async (a) => ({ took: 1, errors: false, itemCount: a.length }),
      swapAlias: async (alias, o, n) => { swaps.push({ alias, old: o, nw: n }); },
      deleteIndex: async (n) => { dropped.push(n); },
    });
    expect(created).toEqual(['objects-v2']);
    expect(dropped).toEqual(['objects-v1']);
    expect(swaps).toEqual([{ alias: 'objects', old: 'objects-v1', nw: 'objects-v2' }]);
    expect(r.loaded).toBe(2);
    expect(r.swapped).toBe(true);
  });

  it("empty source: still swaps alias", async () => {
    const swaps: any[] = [];
    const r = await svc.run({
      objectTypeRid: 'x', ontologyRid: 'y',
      oldIndexName: 'old', newIndexName: 'new', aliasName: 'objects',
      loadAll: async () => [],
      createIndex: async () => {},
      bulkFn: async () => ({ took: 0, errors: false, itemCount: 0 }),
      swapAlias: async (alias, o, n) => { swaps.push([alias, o, n]); },
      deleteIndex: async () => {},
    });
    expect(r.loaded).toBe(0);
    expect(swaps).toEqual([['objects', 'old', 'new']]);
  });
});
