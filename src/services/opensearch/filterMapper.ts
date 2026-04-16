// ---------------------------------------------------------------------------
// filterMapper.ts — {property, operator, value} → ES bool query
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 23:
//   "Filter model → ES query: {property, operator, value} →
//    {term|range|match|prefix|exists|terms}. Compound filters combined
//    with bool.must. Multi-select: renders as terms query with array.
//    Null filter: exists query wrapped in must_not."
// ---------------------------------------------------------------------------

import { OntologyError } from "../../utils/queryErrors";

export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn"
  | "exists"
  | "notExists"
  | "between";

export interface Filter {
  property: string;
  operator: FilterOperator;
  value?: unknown;
  values?: unknown[];
  /** `or` | `and` — how children are combined when this is a compound. */
  mode?: "and" | "or";
  children?: Filter[];
}

export interface CompiledQuery {
  bool: {
    must?: Record<string, unknown>[];
    must_not?: Record<string, unknown>[];
    should?: Record<string, unknown>[];
    filter?: Record<string, unknown>[];
    minimum_should_match?: number;
  };
}

const ALLOWED_OPERATORS: FilterOperator[] = [
  "eq", "ne", "gt", "gte", "lt", "lte",
  "contains", "startsWith", "endsWith",
  "in", "notIn", "exists", "notExists", "between",
];

function assertOperator(op: string): asserts op is FilterOperator {
  if (!ALLOWED_OPERATORS.includes(op as FilterOperator)) {
    throw new OntologyError(
      `Unknown filter operator '${op}'`,
      "INVALID_PARAMETER",
      400,
      { operator: op, allowed: ALLOWED_OPERATORS }
    );
  }
}

/** Map a single atomic filter to an ES clause. */
function mapAtomic(filter: Filter): Record<string, unknown> {
  assertOperator(filter.operator);
  const field = filter.property;
  if (!field || typeof field !== "string") {
    throw new OntologyError(
      "Filter property is required",
      "INVALID_PARAMETER",
      400,
      { filter }
    );
  }

  switch (filter.operator) {
    case "eq":
      return { term: { [field]: filter.value } };
    case "ne":
      return {
        bool: { must_not: [{ term: { [field]: filter.value } }] },
      };
    case "gt":
      return { range: { [field]: { gt: filter.value } } };
    case "gte":
      return { range: { [field]: { gte: filter.value } } };
    case "lt":
      return { range: { [field]: { lt: filter.value } } };
    case "lte":
      return { range: { [field]: { lte: filter.value } } };
    case "between": {
      if (!Array.isArray(filter.values) || filter.values.length !== 2) {
        throw new OntologyError(
          "Operator 'between' requires a 2-element `values` array.",
          "INVALID_PARAMETER",
          400,
          { filter }
        );
      }
      return {
        range: {
          [field]: { gte: filter.values[0], lte: filter.values[1] },
        },
      };
    }
    case "contains":
      return { match: { [field]: filter.value } };
    case "startsWith":
      return { prefix: { [field]: String(filter.value) } };
    case "endsWith":
      // ES doesn't have a native suffix operator; approximate with wildcard.
      return { wildcard: { [field]: `*${String(filter.value)}` } };
    case "in": {
      const values = filter.values ?? (filter.value as unknown[]);
      if (!Array.isArray(values)) {
        throw new OntologyError(
          "Operator 'in' requires an array value.",
          "INVALID_PARAMETER",
          400,
          { filter }
        );
      }
      return { terms: { [field]: values } };
    }
    case "notIn": {
      const values = filter.values ?? (filter.value as unknown[]);
      if (!Array.isArray(values)) {
        throw new OntologyError(
          "Operator 'notIn' requires an array value.",
          "INVALID_PARAMETER",
          400,
          { filter }
        );
      }
      return { bool: { must_not: [{ terms: { [field]: values } }] } };
    }
    case "exists":
      return { exists: { field } };
    case "notExists":
      return { bool: { must_not: [{ exists: { field } }] } };
    default:
      throw new OntologyError(
        `Unhandled operator: ${filter.operator}`,
        "INVALID_PARAMETER",
        400,
        { filter }
      );
  }
}

/**
 * Map a list of filters to a bool.must query. Nested compound filters are
 * recursively expanded. Null/undefined entries are dropped.
 */
export function mapFilters(filters: Filter[]): CompiledQuery {
  const must: Record<string, unknown>[] = [];
  for (const f of filters) {
    if (!f) continue;
    if (f.children && f.children.length > 0) {
      const child = mapFilters(f.children);
      if (f.mode === "or") {
        must.push({
          bool: {
            should: child.bool.must || [],
            minimum_should_match: 1,
          },
        });
      } else {
        must.push({ bool: { must: child.bool.must || [] } });
      }
      continue;
    }
    must.push(mapAtomic(f));
  }
  return { bool: { must } };
}
