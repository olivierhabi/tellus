import { describe, expect, it } from "vitest";
import { OssService } from "../../../src/services/oss/ossService";

const svc = new OssService();

describe("B10.06 — searchAround", () => {
  it("M:1 — primary IDs map to a single counterparty per source", async () => {
    const calls: Array<{ index: string; body: any }> = [];
    const r = await svc.searchAround({
      primary: { ontologyRid: 'x', objectType: 'employee', pageSize: 50 } as any,
      linkType: 'employee_works_for_dept',
      direction: 'A_TO_B',
      counterpartyObjectType: 'department',
      executeFn: async (idx, body) => {
        calls.push({ index: idx, body });
        if (idx.endsWith('-employee')) return { hits: [{ _id: 'emp-1', _source: { name: 'Alice' } }, { _id: 'emp-2', _source: { name: 'Bob' } }] };
        return { hits: [{ _id: 'dept-1', _source: { displayName: 'Engineering' } }] };
      },
      linkLookupFn: async (lt, ids, dir) => {
        expect(lt).toBe('employee_works_for_dept');
        expect(ids).toEqual(['emp-1', 'emp-2']);
        expect(dir).toBe('A_TO_B');
        return ['dept-1'];
      },
    });
    expect(r.primaryHits.length).toBe(2);
    expect(r.counterpartyHits).toEqual([{ id: 'dept-1', displayName: 'Engineering' }]);
    expect(calls.length).toBe(2);
  });

  it("1:M — primary maps to many counterparties", async () => {
    let counterCallBody: any;
    const r = await svc.searchAround({
      primary: { ontologyRid: 'x', objectType: 'department', pageSize: 50 } as any,
      linkType: 'dept_has_employees',
      direction: 'B_TO_A',
      counterpartyObjectType: 'employee',
      executeFn: async (idx, body) => {
        if (idx.endsWith('-department')) return { hits: [{ _id: 'dept-1', _source: {} }] };
        counterCallBody = body;
        return { hits: [
          { _id: 'emp-1', _source: { n: 1 } },
          { _id: 'emp-2', _source: { n: 2 } },
          { _id: 'emp-3', _source: { n: 3 } },
        ]};
      },
      linkLookupFn: async () => ['emp-1', 'emp-2', 'emp-3'],
    });
    expect(r.counterpartyHits.length).toBe(3);
    // Counter request should be a 'terms' filter on _id
    expect(counterCallBody.query.terms._id).toEqual(['emp-1', 'emp-2', 'emp-3']);
  });

  it("primary returns 0 hits → counterparty empty", async () => {
    const r = await svc.searchAround({
      primary: { ontologyRid: 'x', objectType: 'y', pageSize: 50 } as any,
      linkType: 'lt', direction: 'A_TO_B', counterpartyObjectType: 'z',
      executeFn: async () => ({ hits: [] }),
      linkLookupFn: async () => { throw new Error('should not be called'); },
    });
    expect(r.primaryHits).toEqual([]);
    expect(r.counterpartyHits).toEqual([]);
  });

  it("link lookup returns empty → counterparty empty", async () => {
    const r = await svc.searchAround({
      primary: { ontologyRid: 'x', objectType: 'y', pageSize: 50 } as any,
      linkType: 'lt', direction: 'A_TO_B', counterpartyObjectType: 'z',
      executeFn: async () => ({ hits: [{ _id: 'a', _source: {} }] }),
      linkLookupFn: async () => [],
    });
    expect(r.counterpartyHits).toEqual([]);
  });
});
