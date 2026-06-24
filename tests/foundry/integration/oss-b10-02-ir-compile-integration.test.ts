import { describe, expect, it } from "vitest";
import { compileFilter, compileSearch, compileAggregate } from "../../../src/services/oss/irCompiler";

describe("B10.02 — IR → OS DSL (filters)", () => {
  it("term eq -> term", () => {
    expect(compileFilter({ kind: 'term', field: 'name', operator: 'eq', value: 'A' })).toEqual({ term: { name: 'A' } });
  });
  it("term neq -> bool must_not term", () => {
    expect(compileFilter({ kind: 'term', field: 'x', operator: 'neq', value: 1 })).toEqual({ bool: { must_not: [{ term: { x: 1 } }] } });
  });
  it("term in -> terms", () => {
    expect(compileFilter({ kind: 'term', field: 'role', operator: 'in', value: ['a', 'b'] })).toEqual({ terms: { role: ['a', 'b'] } });
  });
  it("term lt/lte/gt/gte -> range", () => {
    expect(compileFilter({ kind: 'term', field: 'age', operator: 'lt', value: 18 })).toEqual({ range: { age: { lt: 18 } } });
    expect(compileFilter({ kind: 'term', field: 'age', operator: 'gte', value: 18 })).toEqual({ range: { age: { gte: 18 } } });
  });
  it("term contains/startsWith/endsWith map to wildcard/prefix", () => {
    expect(compileFilter({ kind: 'term', field: 'n', operator: 'contains', value: 'x' })).toEqual({ wildcard: { n: '*x*' } });
    expect(compileFilter({ kind: 'term', field: 'n', operator: 'startsWith', value: 'x' })).toEqual({ prefix: { n: 'x' } });
    expect(compileFilter({ kind: 'term', field: 'n', operator: 'endsWith', value: 'x' })).toEqual({ wildcard: { n: '*x' } });
  });
  it("term exists/missing", () => {
    expect(compileFilter({ kind: 'term', field: 'n', operator: 'exists' })).toEqual({ exists: { field: 'n' } });
    expect(compileFilter({ kind: 'term', field: 'n', operator: 'missing' })).toEqual({ bool: { must_not: [{ exists: { field: 'n' } }] } });
  });
  it("term between -> range", () => {
    expect(compileFilter({ kind: 'term', field: 'age', operator: 'between', value: [18, 65] })).toEqual({ range: { age: { gte: 18, lte: 65 } } });
  });
  it("range filter combines bounds", () => {
    expect(compileFilter({ kind: 'range', field: 'age', gte: 18, lt: 65 })).toEqual({ range: { age: { gte: 18, lt: 65 } } });
  });
  it("and -> bool must", () => {
    const r = compileFilter({ kind: 'and', filters: [
      { kind: 'term', field: 'a', operator: 'eq', value: 1 },
      { kind: 'term', field: 'b', operator: 'eq', value: 2 },
    ]}) as any;
    expect(r.bool.must.length).toBe(2);
  });
  it("or -> bool should + minimum_should_match", () => {
    const r = compileFilter({ kind: 'or', filters: [
      { kind: 'term', field: 'a', operator: 'eq', value: 1 },
      { kind: 'term', field: 'b', operator: 'eq', value: 2 },
    ]}) as any;
    expect(r.bool.should.length).toBe(2);
    expect(r.bool.minimum_should_match).toBe(1);
  });
  it("not -> bool must_not", () => {
    const r = compileFilter({ kind: 'not', filter: { kind: 'term', field: 'a', operator: 'eq', value: 1 } }) as any;
    expect(r.bool.must_not.length).toBe(1);
  });
  it("compileSearch returns size + match_all when no filter", () => {
    const r = compileSearch({ ontologyRid: 'x', objectType: 'y', pageSize: 100 } as any);
    expect(r.size).toBe(100);
    expect(r.query).toEqual({ match_all: {} });
  });
  it("compileSearch respects sort", () => {
    const r = compileSearch({ ontologyRid: 'x', objectType: 'y', pageSize: 50, sort: [{ field: 'name', direction: 'desc' }] } as any);
    expect(r.sort).toEqual([{ name: { order: 'desc' } }]);
  });
  it("compileAggregate emits aggs", () => {
    const r = compileAggregate({ ontologyRid: 'x', objectType: 'y', aggregations: [
      { kind: 'count', name: 'total' },
      { kind: 'avg', name: 'avgAge', field: 'age' },
    ]} as any);
    expect(r.size).toBe(0);
    expect(Object.keys(r.aggs)).toEqual(['total', 'avgAge']);
  });
});
