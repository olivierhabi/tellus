import { describe, expect, it } from "vitest";
import { B9MergeChanges } from "../../../src/services/funnel/b9MergeChanges";

const svc = new B9MergeChanges();

describe("B9.04 — MergeChanges phase", () => {
  it("dedupes by primary_key, keeping latest version", () => {
    const out = svc.merge([
      { primaryKey: 'a', operation: 'UPSERT', version: 1 },
      { primaryKey: 'a', operation: 'UPSERT', version: 5, payload: { v: 5 } },
      { primaryKey: 'b', operation: 'UPSERT', version: 3 },
    ]);
    expect(out.length).toBe(2);
    const a = out.find((c) => c.primaryKey === 'a')!;
    expect(a.version).toBe(5);
    expect(a.payload).toEqual({ v: 5 });
  });

  it("DELETE wins over UPSERT at equal version", () => {
    const out = svc.merge([
      { primaryKey: 'a', operation: 'UPSERT', version: 5 },
      { primaryKey: 'a', operation: 'DELETE', version: 5 },
    ]);
    const a = out.find((c) => c.primaryKey === 'a')!;
    expect(a.operation).toBe('DELETE');
  });

  it("UPSERT at higher version wins over DELETE at lower", () => {
    const out = svc.merge([
      { primaryKey: 'a', operation: 'DELETE', version: 3 },
      { primaryKey: 'a', operation: 'UPSERT', version: 7 },
    ]);
    expect(out[0].operation).toBe('UPSERT');
    expect(out[0].version).toBe(7);
  });

  it("empty input returns []", () => {
    expect(svc.merge([])).toEqual([]);
  });
});
