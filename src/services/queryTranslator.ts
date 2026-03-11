// ---------------------------------------------------------------------------
// Query Translator — Filter DSL → OpenSearch Query DSL
//
// Translates our query DSL (the `where` clause) into OpenSearch Query DSL.
// Covers all 13 filter types:
//   Leaf:     eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in
//   Compound: and, or, not
//
// Tasks 3, 4, 5 combined into one file.
// ---------------------------------------------------------------------------

import {
  resolveProperty,
  getOpenSearchFieldForFilter,
  type PropertyMeta,
} from "./propertyResolver";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OsQuery = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_TYPES = new Set(["date", "timestamp"]);

function getEffective(baseType: string): string {
  return baseType.endsWith("_array") ? baseType.replace("_array", "") : baseType;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Translate a filter clause from our query DSL into an OpenSearch query clause.
 */
export async function translateFilter(
  filter: any,
  objectTypeApiName: string
): Promise<OsQuery> {
  if (!filter || !filter.type) {
    return { match_all: {} };
  }

  switch (filter.type) {
    case "eq":
      return translateEq(filter, objectTypeApiName);
    case "gt":
      return translateRange(filter, objectTypeApiName, "gt");
    case "gte":
      return translateRange(filter, objectTypeApiName, "gte");
    case "lt":
      return translateRange(filter, objectTypeApiName, "lt");
    case "lte":
      return translateRange(filter, objectTypeApiName, "lte");
    case "and":
      return translateAnd(filter, objectTypeApiName);
    case "or":
      return translateOr(filter, objectTypeApiName);
    case "not":
      return translateNot(filter, objectTypeApiName);
    case "contains":
      return translateContains(filter, objectTypeApiName);
    case "startsWith":
      return translateStartsWith(filter, objectTypeApiName);
    case "isNull":
      return translateIsNull(filter, objectTypeApiName);
    case "isNotNull":
      return translateIsNotNull(filter, objectTypeApiName);
    case "in":
      return translateIn(filter, objectTypeApiName);
    default:
      throw appError("UNSUPPORTED_FILTER", `Unsupported filter type: ${filter.type}`);
  }
}

// ---------------------------------------------------------------------------
// Task 3: Equality and inequality operators
// ---------------------------------------------------------------------------

async function translateEq(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  // null value → isNull
  if (filter.value === null) {
    return translateIsNull({ ...filter, type: "isNull" }, objectTypeApiName);
  }

  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "eq");
  return { term: { [fieldName]: filter.value } };
}

async function translateRange(
  filter: any,
  objectTypeApiName: string,
  rangeOp: "gt" | "gte" | "lt" | "lte"
): Promise<OsQuery> {
  const meta = await resolveProperty(objectTypeApiName, filter.field);
  const effective = getEffective(meta.baseType);

  if (effective === "boolean") {
    throw appError(
      "INCOMPATIBLE_FILTER",
      "Range filters (gt, gte, lt, lte) are not supported on boolean properties. Use 'eq' instead."
    );
  }

  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, rangeOp);

  const rangeClause: Record<string, unknown> = { [rangeOp]: filter.value };

  // Add format hint for date types
  if (effective === "date") {
    rangeClause.format = "yyyy-MM-dd";
  }

  return { range: { [fieldName]: rangeClause } };
}

// ---------------------------------------------------------------------------
// Task 4: Compound operators (and, or, not)
// ---------------------------------------------------------------------------

async function translateAnd(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const subs = filter.value as any[];
  if (!subs || subs.length === 0) return { match_all: {} };

  // Single element — no wrapping needed
  if (subs.length === 1) {
    return translateFilter(subs[0], objectTypeApiName);
  }

  // Translate all sub-filters in parallel
  const translated = await Promise.all(
    subs.map((s: any) => translateFilter(s, objectTypeApiName))
  );

  // Flatten nested ands
  const filterClauses: OsQuery[] = [];
  for (const t of translated) {
    if (t.bool && (t.bool as any).filter && Object.keys(t.bool as any).length === 1) {
      // Flatten inner and's filter clauses
      filterClauses.push(...(t.bool as any).filter);
    } else {
      filterClauses.push(t);
    }
  }

  return { bool: { filter: filterClauses } };
}

async function translateOr(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const subs = filter.value as any[];
  if (!subs || subs.length === 0) return { match_none: {} };

  if (subs.length === 1) {
    return translateFilter(subs[0], objectTypeApiName);
  }

  const translated = await Promise.all(
    subs.map((s: any) => translateFilter(s, objectTypeApiName))
  );

  // Flatten nested ors
  const shouldClauses: OsQuery[] = [];
  for (const t of translated) {
    if (
      t.bool &&
      (t.bool as any).should &&
      (t.bool as any).minimum_should_match === 1 &&
      Object.keys(t.bool as any).length === 2
    ) {
      shouldClauses.push(...(t.bool as any).should);
    } else {
      shouldClauses.push(t);
    }
  }

  return { bool: { should: shouldClauses, minimum_should_match: 1 } };
}

async function translateNot(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const subs = filter.value as any[];
  if (!subs || subs.length === 0) return { match_all: {} };

  const translated = await translateFilter(subs[0], objectTypeApiName);
  return { bool: { must_not: [translated] } };
}

// ---------------------------------------------------------------------------
// Task 5: contains, startsWith, isNull, isNotNull, in
// ---------------------------------------------------------------------------

async function translateContains(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "contains");
  return {
    match: {
      [fieldName]: {
        query: filter.value,
        operator: "and",
      },
    },
  };
}

async function translateStartsWith(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "startsWith");
  return {
    prefix: {
      [fieldName]: {
        value: filter.value,
        case_insensitive: true,
      },
    },
  };
}

async function translateIsNull(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "isNull");
  return {
    bool: {
      must_not: [{ exists: { field: fieldName } }],
    },
  };
}

async function translateIsNotNull(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "isNotNull");
  return { exists: { field: fieldName } };
}

async function translateIn(filter: any, objectTypeApiName: string): Promise<OsQuery> {
  const fieldName = await getOpenSearchFieldForFilter(objectTypeApiName, filter.field, "in");

  // Log warning for large in clauses
  if (Array.isArray(filter.value) && filter.value.length > 100) {
    console.warn(
      `[QUERY_WARN] Large 'in' clause with ${filter.value.length} values on field '${filter.field}'. ` +
        "Consider using link traversal for better performance."
    );
  }

  return { terms: { [fieldName]: filter.value } };
}

// ---------------------------------------------------------------------------
// Sort clause builder
// ---------------------------------------------------------------------------

export async function buildSortClause(
  orderBy: Array<{ field: string; direction: string }> | undefined,
  objectTypeApiName: string
): Promise<Array<Record<string, unknown>>> {
  const sorts: Array<Record<string, unknown>> = [];

  if (orderBy && orderBy.length > 0) {
    for (const item of orderBy) {
      const meta = await resolveProperty(objectTypeApiName, item.field);
      const effective = getEffective(meta.baseType);
      // String fields sort on .keyword sub-field
      const sortField = effective === "string" ? meta.opensearchKeywordField : meta.opensearchField;
      sorts.push({ [sortField]: { order: item.direction } });
    }
  }

  // Always append __pk as tiebreaker if not already present
  const hasPk = sorts.some((s) => "__pk" in s);
  if (!hasPk) {
    sorts.push({ __pk: { order: "asc" } });
  }

  return sorts;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string) {
      if (condition) { passed++; console.log(`  PASS  ${label}`); }
      else { failed++; console.log(`  FAIL  ${label}`); }
    }

    console.log("=== QueryTranslator self-test ===");

    // Test with system fields (no DB needed)
    const eqPk = await translateFilter(
      { type: "eq", field: "__pk", value: "EMP-001" },
      "Any"
    );
    assert(
      JSON.stringify(eqPk) === JSON.stringify({ term: { __pk: "EMP-001" } }),
      "eq on __pk → term query"
    );

    const gtVersion = await translateFilter(
      { type: "gt", field: "__version", value: 5 },
      "Any"
    );
    assert(
      JSON.stringify(gtVersion) === JSON.stringify({ range: { __version: { gt: 5 } } }),
      "gt on __version → range query"
    );

    // isNull
    const isNullPk = await translateFilter(
      { type: "isNull", field: "__pk" },
      "Any"
    );
    assert(
      JSON.stringify(isNullPk) === JSON.stringify({ bool: { must_not: [{ exists: { field: "__pk" } }] } }),
      "isNull → must_not exists"
    );

    // isNotNull
    const isNotNullPk = await translateFilter(
      { type: "isNotNull", field: "__pk" },
      "Any"
    );
    assert(
      JSON.stringify(isNotNullPk) === JSON.stringify({ exists: { field: "__pk" } }),
      "isNotNull → exists"
    );

    // in
    const inPk = await translateFilter(
      { type: "in", field: "__pk", value: ["A", "B", "C"] },
      "Any"
    );
    assert(
      JSON.stringify(inPk) === JSON.stringify({ terms: { __pk: ["A", "B", "C"] } }),
      "in on __pk → terms query"
    );

    // and (compound)
    const andFilter = await translateFilter(
      {
        type: "and",
        value: [
          { type: "eq", field: "__pk", value: "EMP-001" },
          { type: "gt", field: "__version", value: 1 },
        ],
      },
      "Any"
    );
    assert(
      (andFilter as any).bool?.filter?.length === 2,
      "and → bool.filter with 2 clauses"
    );

    // or (compound)
    const orFilter = await translateFilter(
      {
        type: "or",
        value: [
          { type: "eq", field: "__pk", value: "A" },
          { type: "eq", field: "__pk", value: "B" },
        ],
      },
      "Any"
    );
    assert(
      (orFilter as any).bool?.should?.length === 2,
      "or → bool.should with 2 clauses"
    );
    assert(
      (orFilter as any).bool?.minimum_should_match === 1,
      "or → minimum_should_match = 1"
    );

    // not (compound)
    const notFilter = await translateFilter(
      {
        type: "not",
        value: [{ type: "eq", field: "__pk", value: "DEL" }],
      },
      "Any"
    );
    assert(
      (notFilter as any).bool?.must_not?.length === 1,
      "not → bool.must_not with 1 clause"
    );

    // Single-element and — no wrapping
    const singleAnd = await translateFilter(
      { type: "and", value: [{ type: "eq", field: "__pk", value: "X" }] },
      "Any"
    );
    assert(
      JSON.stringify(singleAnd) === JSON.stringify({ term: { __pk: "X" } }),
      "Single-element and returns unwrapped"
    );

    // null match_all
    const empty = await translateFilter(null, "Any");
    assert(
      JSON.stringify(empty) === JSON.stringify({ match_all: {} }),
      "null filter → match_all"
    );

    // Sort clause
    const sorts = await buildSortClause(undefined, "Any");
    assert(sorts.length === 1, "Default sort has 1 field");
    assert("__pk" in sorts[0], "Default sort is __pk");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}
