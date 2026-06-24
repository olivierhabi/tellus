import { describe, expect, it } from "vitest";
import { OssService } from "../../../src/services/oss/ossService";

const svc = new OssService();

describe("B10.08 — loadByPk", () => {
  it("returns the matching document", async () => {
    const r = await svc.loadByPk({
      ontologyRid: 'x', objectType: 'employee', primaryKey: 'employeeId', primaryKeyValue: 'E-1',
      executeFn: async (_idx, body) => {
        expect((body as any).query).toEqual({ term: { employeeId: 'E-1' } });
        expect((body as any).size).toBe(1);
        return { hits: [{ _id: 'E-1', _source: { name: 'Alice' } }] };
      },
    });
    expect(r).toEqual({ id: 'E-1', name: 'Alice' });
  });

  it("returns null on no match", async () => {
    const r = await svc.loadByPk({
      ontologyRid: 'x', objectType: 'y', primaryKey: 'id', primaryKeyValue: 'ghost',
      executeFn: async () => ({ hits: [] }),
    });
    expect(r).toBeNull();
  });

  it("works with numeric PK", async () => {
    let body: any;
    await svc.loadByPk({
      ontologyRid: 'x', objectType: 'y', primaryKey: 'id', primaryKeyValue: 42,
      executeFn: async (_i, b) => { body = b; return { hits: [] }; },
    });
    expect(body.query).toEqual({ term: { id: 42 } });
  });
});
