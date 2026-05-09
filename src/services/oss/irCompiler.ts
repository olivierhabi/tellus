// B10.02 — IR → OpenSearch DSL compiler.
//
// Compiles the IR Filter shape into the OpenSearch query DSL. The
// compiler is a pure function over the parsed IR (so it's trivial to
// unit-test) and returns the `query`, `sort`, `size`, and `from`
// portions of an OS request body. The final HTTP shape is assembled by
// the load endpoint in B10.04.
import type { SearchRequest, AggregateRequest } from "./irSchema";

export interface OsQuery { [k: string]: unknown }

export function compileFilter(f: any): OsQuery {
  switch (f.kind) {
    case "term": {
      const { field, operator, value } = f;
      switch (operator) {
        case "eq": return { term: { [field]: value } };
        case "neq": return { bool: { must_not: [{ term: { [field]: value } }] } };
        case "in": return { terms: { [field]: Array.isArray(value) ? value : [value] } };
        case "notIn": return { bool: { must_not: [{ terms: { [field]: Array.isArray(value) ? value : [value] } }] } };
        case "lt": return { range: { [field]: { lt: value } } };
        case "lte": return { range: { [field]: { lte: value } } };
        case "gt": return { range: { [field]: { gt: value } } };
        case "gte": return { range: { [field]: { gte: value } } };
        case "contains": return { wildcard: { [field]: `*${String(value)}*` } };
        case "startsWith": return { prefix: { [field]: String(value) } };
        case "endsWith": return { wildcard: { [field]: `*${String(value)}` } };
        case "exists": return { exists: { field } };
        case "missing": return { bool: { must_not: [{ exists: { field } }] } };
        case "between": {
          if (!Array.isArray(value) || value.length !== 2) {
            throw new Error(`INVALID_ARGUMENT: 'between' requires [min, max] array`);
          }
          return { range: { [field]: { gte: value[0], lte: value[1] } } };
        }
        default: throw new Error(`INVALID_ARGUMENT: unsupported operator ${operator}`);
      }
    }
    case "range": {
      const r: Record<string, unknown> = {};
      for (const k of ["gte", "lte", "gt", "lt"] as const) if (f[k] !== undefined) r[k] = f[k];
      return { range: { [f.field]: r } };
    }
    case "and": return { bool: { must: f.filters.map(compileFilter) } };
    case "or": return { bool: { should: f.filters.map(compileFilter), minimum_should_match: 1 } };
    case "not": return { bool: { must_not: [compileFilter(f.filter)] } };
    case "geoDistance":
      return { geo_distance: { distance: `${f.distanceMeters}m`, [f.field]: { lat: f.lat, lon: f.lon } } };
    case "knn":
      return { knn: { [f.field]: { vector: f.vector, k: f.k } } };
    default: throw new Error(`INVALID_ARGUMENT: unknown filter kind ${(f as any).kind}`);
  }
}

export interface CompiledSearch {
  query: OsQuery;
  size: number;
  sort?: Array<Record<string, { order: string }>>;
  search_after?: unknown;
}

export function compileSearch(req: SearchRequest): CompiledSearch {
  const out: CompiledSearch = {
    query: req.filter ? compileFilter(req.filter) : { match_all: {} },
    size: req.pageSize,
  };
  if (req.sort && req.sort.length > 0) {
    out.sort = req.sort.map((s) => ({ [s.field]: { order: s.direction } }));
  }
  if (req.cursor) {
    try { out.search_after = JSON.parse(Buffer.from(req.cursor, "base64").toString()); } catch { /* invalid cursor: ignore */ }
  }
  return out;
}

export interface CompiledAggregate { query: OsQuery; size: 0; aggs: Record<string, OsQuery> }

export function compileAggregate(req: AggregateRequest): CompiledAggregate {
  const aggs: Record<string, OsQuery> = {};
  for (const a of req.aggregations) {
    switch (a.kind) {
      case "count": aggs[a.name] = { value_count: { field: "_id" } }; break;
      case "sum": aggs[a.name] = { sum: { field: a.field } }; break;
      case "avg": aggs[a.name] = { avg: { field: a.field } }; break;
      case "min": aggs[a.name] = { min: { field: a.field } }; break;
      case "max": aggs[a.name] = { max: { field: a.field } }; break;
      case "terms": aggs[a.name] = { terms: { field: a.field, size: a.size } }; break;
    }
  }
  return { query: req.filter ? compileFilter(req.filter) : { match_all: {} }, size: 0, aggs };
}
