import { describe, expect, it } from "vitest";
import { OssService } from "../../../src/services/oss/ossService";

const svc = new OssService();

describe("B10.05 — aggregate endpoint", () => {
  it("returns aggregations from executeFn", async () => {
    const r = await svc.aggregate({
      ontologyRid: 'x', objectType: 'y',
      aggregations: [{ kind: 'count', name: 'total' }],
    } as any, async (_idx, body) => {
      expect((body as any).size).toBe(0);
      expect(((body as any).aggs as any).total).toEqual({ value_count: { field: '_id' } });
      return { aggregations: { total: { value: 42 } } };
    });
    expect(r.aggregations).toEqual({ total: { value: 42 } });
  });

  it("compiles avg, min, max, sum, terms aggs", async () => {
    let body: any;
    await svc.aggregate({
      ontologyRid: 'x', objectType: 'y',
      aggregations: [
        { kind: 'avg', name: 'a', field: 'age' },
        { kind: 'sum', name: 's', field: 'salary' },
        { kind: 'min', name: 'mn', field: 'age' },
        { kind: 'max', name: 'mx', field: 'age' },
        { kind: 'terms', name: 'byRole', field: 'role', size: 5 },
      ],
    } as any, async (_idx, b) => { body = b; return { aggregations: {} }; });
    expect(body.aggs.a).toEqual({ avg: { field: 'age' } });
    expect(body.aggs.s).toEqual({ sum: { field: 'salary' } });
    expect(body.aggs.mn).toEqual({ min: { field: 'age' } });
    expect(body.aggs.mx).toEqual({ max: { field: 'age' } });
    expect(body.aggs.byRole).toEqual({ terms: { field: 'role', size: 5 } });
  });

  it("applies filter to aggregate query", async () => {
    let body: any;
    await svc.aggregate({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'term', field: 'status', operator: 'eq', value: 'ACTIVE' },
      aggregations: [{ kind: 'count', name: 'total' }],
    } as any, async (_idx, b) => { body = b; return { aggregations: {} }; });
    expect(body.query).toEqual({ term: { status: 'ACTIVE' } });
  });

  it("empty aggregations result", async () => {
    const r = await svc.aggregate({
      ontologyRid: 'x', objectType: 'y',
      aggregations: [{ kind: 'count', name: 't' }],
    } as any, async () => ({}));
    expect(r.aggregations).toEqual({});
  });
});
