import { describe, expect, it } from "vitest";
import { B9Hydrator } from "../../../src/services/funnel/b9Hydrator";

const svc = new B9Hydrator();

describe("B9.06 — Hydrator phase", () => {
  it("counts upserts and deletes", async () => {
    const seen: Array<{ op: string; pk: string }> = [];
    const r = await svc.run({
      changes: [
        { primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { x: 1 } },
        { primaryKey: 'b', operation: 'UPSERT', version: 2 },
        { primaryKey: 'c', operation: 'DELETE', version: 3 },
      ],
      applyFn: async (op, pk) => { seen.push({ op, pk }); },
    });
    expect(r.upserts).toBe(2);
    expect(r.deletes).toBe(1);
    expect(seen.length).toBe(3);
  });

  it("empty change set is a no-op", async () => {
    const r = await svc.run({ changes: [], applyFn: async () => {} });
    expect(r.upserts).toBe(0);
    expect(r.deletes).toBe(0);
  });

  it("payload is forwarded to applyFn for UPSERT", async () => {
    let payload: any;
    await svc.run({
      changes: [{ primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { v: 42 } }],
      applyFn: async (_op, _pk, doc) => { payload = doc; },
    });
    expect(payload).toEqual({ v: 42 });
  });
});
