import { describe, expect, it } from "vitest";
import { OssService } from "../../../src/services/oss/ossService";

const svc = new OssService();

describe("B10.04 — load endpoint", () => {
  it("returns hits from executeFn", async () => {
    const r = await svc.load({
      ontologyRid: 'ri.ontology.main.ontology.default', objectType: 'employee', pageSize: 50,
    } as any, async (idx, body) => {
      expect(idx).toBe('oms-ri_ontology_main_ontology_default-main-employee');
      expect((body as any).query).toEqual({ match_all: {} });
      return { hits: [{ _id: 'a', _source: { name: 'Alice' } }, { _id: 'b', _source: { name: 'Bob' } }], total: 2 };
    });
    expect(r.hits).toEqual([{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }]);
    expect(r.total).toBe(2);
  });

  it("emits nextCursor when page is full and last hit has sort", async () => {
    const r = await svc.load({
      ontologyRid: 'x', objectType: 'y', pageSize: 2, sort: [{ field: 'name', direction: 'asc' }],
    } as any, async () => ({
      hits: [{ _id: 'a', _source: {}, sort: ['Alice'] }, { _id: 'b', _source: {}, sort: ['Bob'] }],
    }));
    expect(r.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(r.nextCursor!, 'base64').toString());
    expect(decoded).toEqual(['Bob']);
  });

  it("no nextCursor when page is partial", async () => {
    const r = await svc.load({
      ontologyRid: 'x', objectType: 'y', pageSize: 50,
    } as any, async () => ({ hits: [{ _id: 'a', _source: {} }] }));
    expect(r.nextCursor).toBeUndefined();
  });

  it("empty result", async () => {
    const r = await svc.load({ ontologyRid: 'x', objectType: 'y', pageSize: 50 } as any, async () => ({ hits: [] }));
    expect(r.hits).toEqual([]);
  });
});
