import { describe, expect, it } from "vitest";
import { parseSearchRequest, parseAggregateRequest } from "../../../src/services/oss/irSchema";

describe("B10.01 — IR schema validation", () => {
  it("happy path: minimal SearchRequest parses", () => {
    const r = parseSearchRequest({ ontologyRid: 'ri.ontology.main.ontology.default', objectType: 'employee' });
    expect(r.objectType).toBe('employee');
    expect(r.pageSize).toBe(50);
  });

  it("term filter parses with operator", () => {
    const r = parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'term', field: 'name', operator: 'eq', value: 'Alice' },
    });
    expect((r.filter as any).operator).toBe('eq');
  });

  it("range filter parses", () => {
    const r = parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'range', field: 'age', gte: 18, lt: 65 },
    });
    expect((r.filter as any).gte).toBe(18);
  });

  it("nested and/or/not parses", () => {
    const r = parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: {
        kind: 'and',
        filters: [
          { kind: 'term', field: 'status', operator: 'eq', value: 'ACTIVE' },
          { kind: 'or', filters: [
            { kind: 'term', field: 'role', operator: 'in', value: ['admin', 'user'] },
            { kind: 'not', filter: { kind: 'term', field: 'archived', operator: 'eq', value: true } },
          ] },
        ],
      },
    });
    expect((r.filter as any).kind).toBe('and');
  });

  it("geoDistance + knn filters parse", () => {
    parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'geoDistance', field: 'loc', lat: 37, lon: -122, distanceMeters: 5000 },
    });
    parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'knn', field: 'embedding', vector: [0.1, 0.2, 0.3], k: 10 },
    });
  });

  it("invalid: missing ontologyRid throws INVALID_ARGUMENT", () => {
    expect(() => parseSearchRequest({ objectType: 'y' } as any)).toThrowError(/INVALID_ARGUMENT/);
  });

  it("invalid: bad operator throws INVALID_ARGUMENT", () => {
    expect(() => parseSearchRequest({
      ontologyRid: 'x', objectType: 'y',
      filter: { kind: 'term', field: 'name', operator: 'bogus', value: 'x' } as any,
    })).toThrowError(/INVALID_ARGUMENT/);
  });

  it("aggregate request parses with multiple aggregations", () => {
    const r = parseAggregateRequest({
      ontologyRid: 'x', objectType: 'y',
      aggregations: [
        { kind: 'count', name: 'total' },
        { kind: 'avg', name: 'avgAge', field: 'age' },
        { kind: 'terms', name: 'byStatus', field: 'status' },
      ],
    });
    expect(r.aggregations.length).toBe(3);
  });

  it("aggregate request requires non-empty aggregations array", () => {
    expect(() => parseAggregateRequest({ ontologyRid: 'x', objectType: 'y', aggregations: [] } as any)).toThrowError(/INVALID_ARGUMENT/);
  });

  it("pageSize > 10000 fails", () => {
    expect(() => parseSearchRequest({ ontologyRid: 'x', objectType: 'y', pageSize: 50000 })).toThrowError(/INVALID_ARGUMENT/);
  });
});
