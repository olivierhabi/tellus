// =============================================================================
// B07 — Workshop Filter Compiler
//
// Compiles the Workshop UI filter document (the eleven `uiKind`s from spec
// §B07 acceptance) into an OSS-style predicate tree. CPU-bound, pure, no I/O.
// Per-keystroke pre-flight target: P95 ≤ 20 ms (B07 SLO).
//
// Eleven uiKinds (per spec §B07):
//   1.  string-eq         — Item Name multi-select
//   2.  string-multi      — Assignee multi-select
//   3.  string-in         — Consolidated Customer ID
//   4.  string-default    — Customer Name "default"
//   5.  number-histogram  — Days Until Due histogram
//   6.  number-multi      — Customer ID multi-select numeric
//   7.  date-timeline     — Order Due Date timeline
//   8.  id-multi          — Order ID multi-select
//   9.  number-default    — Quantity histogram default
//   10. enum-multi        — Status multi-select
//   11. number-range      — Unit Price default histogram (range)
//
// Spec §E flags filter type×property compatibility as a top-five risk:
//   "missing one combination breaks a widget silently". The COMPAT matrix is
//   the single-source-of-truth fixture; both the compiler and unit tests
//   read from it.
// =============================================================================

import { workshopError } from "./errors.js";
import { histFilterCompile } from "./metrics.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type PropertyType =
  | "string"
  | "integer"
  | "long"
  | "double"
  | "boolean"
  | "date"
  | "timestamp"
  | "id";

export type FilterUiKind =
  | "string-eq"
  | "string-multi"
  | "string-in"
  | "string-default"
  | "number-histogram"
  | "number-multi"
  | "number-default"
  | "number-range"
  | "date-timeline"
  | "id-multi"
  | "enum-multi";

/** All eleven uiKinds, in stable declaration order. */
export const ALL_UI_KINDS: readonly FilterUiKind[] = Object.freeze([
  "string-eq",
  "string-multi",
  "string-in",
  "string-default",
  "number-histogram",
  "number-multi",
  "number-default",
  "number-range",
  "date-timeline",
  "id-multi",
  "enum-multi",
] as const);

/**
 * Compatibility matrix between `uiKind` and property type.
 *
 * Per spec §B07: "missing one combination breaks a widget silently."
 * This object is the single source of truth — both `compileFilter` and
 * the unit tests load from it.
 */
export const COMPAT: Readonly<Record<FilterUiKind, readonly PropertyType[]>> =
  Object.freeze({
    "string-eq": Object.freeze(["string", "id"] as const),
    "string-multi": Object.freeze(["string", "id"] as const),
    "string-in": Object.freeze(["string", "id"] as const),
    "string-default": Object.freeze(["string"] as const),
    "number-histogram": Object.freeze(["integer", "long", "double"] as const),
    "number-multi": Object.freeze(["integer", "long", "double"] as const),
    "number-default": Object.freeze(["integer", "long", "double"] as const),
    "number-range": Object.freeze(["integer", "long", "double"] as const),
    "date-timeline": Object.freeze(["date", "timestamp"] as const),
    "id-multi": Object.freeze(["id", "string"] as const),
    "enum-multi": Object.freeze(["string"] as const),
  });

export interface FilterValueIn {
  uiKind: FilterUiKind;
  property: string;
  /** Per the eleven uiKinds, value shapes vary; declared per-kind. */
  value: unknown;
}

export type Predicate =
  | { type: "and"; clauses: Predicate[] }
  | { type: "or"; clauses: Predicate[] }
  | { type: "not"; clause: Predicate }
  | { type: "term"; field: string; value: string | number | boolean }
  | { type: "terms"; field: string; values: ReadonlyArray<string | number> }
  | { type: "wildcard"; field: string; value: string }
  | {
      type: "range";
      field: string;
      gte?: string | number;
      lte?: string | number;
      gt?: string | number;
      lt?: string | number;
    }
  | { type: "matchAll" };

export interface PropertySchema {
  name: string;
  type: PropertyType;
}

export interface CompileContext {
  /** Property name → type. */
  properties: Readonly<Record<string, PropertyType>>;
}

// -----------------------------------------------------------------------------
// Compatibility check
// -----------------------------------------------------------------------------

/**
 * Asserts that uiKind × propertyType is a permitted combination. Throws
 * `Tellus:Workshop:UnsupportedFilterPropertyType` per §B07 if not.
 */
export function assertCompatible(
  uiKind: FilterUiKind,
  propertyType: PropertyType,
  property: string,
): void {
  const compatible = COMPAT[uiKind];
  if (!compatible) {
    throw workshopError({
      errorName: "Tellus:Workshop:UnsupportedFilterUiKind",
      status: 400,
      message: `Unsupported filter uiKind '${uiKind}'`,
      parameters: { uiKind, property },
    });
  }
  if (!compatible.includes(propertyType)) {
    throw workshopError({
      errorName: "Tellus:Workshop:UnsupportedFilterPropertyType",
      status: 400,
      message:
        `Filter uiKind '${uiKind}' is not compatible with property '${property}' of type '${propertyType}'. ` +
        `Compatible types: ${compatible.join(", ")}`,
      parameters: { uiKind, property, propertyType, compatible: [...compatible] },
    });
  }
}

// -----------------------------------------------------------------------------
// Compile a single filter
// -----------------------------------------------------------------------------

function asStringArray(v: unknown, field: string, kind: string): string[] {
  if (!Array.isArray(v))
    throw workshopError({
      errorName: "Tellus:Workshop:InvalidFilterValue",
      status: 400,
      message: `Filter '${kind}' for property '${field}' requires an array of strings`,
      parameters: { field, kind },
    });
  for (const x of v) {
    if (typeof x !== "string")
      throw workshopError({
        errorName: "Tellus:Workshop:InvalidFilterValue",
        status: 400,
        message: `Filter '${kind}' for property '${field}' contains non-string value`,
        parameters: { field, kind },
      });
  }
  return v as string[];
}

function asNumberArray(v: unknown, field: string, kind: string): number[] {
  if (!Array.isArray(v))
    throw workshopError({
      errorName: "Tellus:Workshop:InvalidFilterValue",
      status: 400,
      message: `Filter '${kind}' for property '${field}' requires an array of numbers`,
      parameters: { field, kind },
    });
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x))
      throw workshopError({
        errorName: "Tellus:Workshop:InvalidFilterValue",
        status: 400,
        message: `Filter '${kind}' for property '${field}' contains non-finite number`,
        parameters: { field, kind },
      });
  }
  return v as number[];
}

interface RangeValue {
  gte?: number | string;
  lte?: number | string;
  gt?: number | string;
  lt?: number | string;
}
function asRange(v: unknown, field: string, kind: string): RangeValue {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw workshopError({
      errorName: "Tellus:Workshop:InvalidFilterValue",
      status: 400,
      message: `Filter '${kind}' for property '${field}' requires an object with gte/lte/gt/lt`,
      parameters: { field, kind },
    });
  const o = v as Record<string, unknown>;
  const out: RangeValue = {};
  (["gte", "lte", "gt", "lt"] as const).forEach((k) => {
    const x = o[k];
    if (x === undefined) return;
    if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
    else if (typeof x === "string" && x.length > 0) out[k] = x;
    else
      throw workshopError({
        errorName: "Tellus:Workshop:InvalidFilterValue",
        status: 400,
        message: `Filter '${kind}' for property '${field}' has invalid bound '${k}'`,
        parameters: { field, kind, bound: k },
      });
  });
  if (Object.keys(out).length === 0)
    throw workshopError({
      errorName: "Tellus:Workshop:InvalidFilterValue",
      status: 400,
      message: `Filter '${kind}' for property '${field}' requires at least one of gte/lte/gt/lt`,
      parameters: { field, kind },
    });
  return out;
}

/**
 * Compiles a single filter to its OSS predicate tree. Pure: no I/O.
 *
 * Throws:
 *   - Tellus:Workshop:UnknownFilterProperty  (property not in objectType)
 *   - Tellus:Workshop:UnsupportedFilterPropertyType  (type×kind mismatch)
 *   - Tellus:Workshop:InvalidFilterValue  (value shape wrong for the kind)
 */
export function compileFilter(
  filter: FilterValueIn,
  ctx: CompileContext,
): Predicate {
  const { uiKind, property, value } = filter;
  const propType = ctx.properties[property];
  if (!propType)
    throw workshopError({
      errorName: "Tellus:Workshop:UnknownFilterProperty",
      status: 400,
      message: `Filter references unknown property '${property}'`,
      parameters: { property, uiKind },
    });

  assertCompatible(uiKind, propType, property);

  switch (uiKind) {
    case "string-eq": {
      // Multi-select with single value behaves like terms; empty array → matchAll
      const arr = asStringArray(value, property, uiKind);
      if (arr.length === 0) return { type: "matchAll" };
      return { type: "terms", field: property, values: arr };
    }
    case "string-multi":
    case "string-in":
    case "id-multi":
    case "enum-multi": {
      const arr = asStringArray(value, property, uiKind);
      if (arr.length === 0) return { type: "matchAll" };
      return { type: "terms", field: property, values: arr };
    }
    case "string-default": {
      // "default" string-search uses wildcard contains
      if (typeof value !== "string")
        throw workshopError({
          errorName: "Tellus:Workshop:InvalidFilterValue",
          status: 400,
          message: `Filter 'string-default' for '${property}' requires a string`,
          parameters: { field: property, kind: uiKind },
        });
      if (value === "") return { type: "matchAll" };
      return { type: "wildcard", field: property, value: `*${value}*` };
    }
    case "number-multi": {
      const arr = asNumberArray(value, property, uiKind);
      if (arr.length === 0) return { type: "matchAll" };
      return { type: "terms", field: property, values: arr };
    }
    case "number-histogram":
    case "number-default":
    case "number-range": {
      const r = asRange(value, property, uiKind);
      return { type: "range", field: property, ...r };
    }
    case "date-timeline": {
      // Timeline filters carry { from, to } as ISO date strings
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw workshopError({
          errorName: "Tellus:Workshop:InvalidFilterValue",
          status: 400,
          message: `Filter 'date-timeline' for '${property}' requires { from, to }`,
          parameters: { field: property, kind: uiKind },
        });
      const o = value as Record<string, unknown>;
      const from = o["from"];
      const to = o["to"];
      const range: Predicate = { type: "range", field: property };
      if (typeof from === "string" && from.length > 0) (range as { gte?: string }).gte = from;
      if (typeof to === "string" && to.length > 0) (range as { lte?: string }).lte = to;
      // If neither bound provided, matchAll
      if (!("gte" in range) && !("lte" in range)) return { type: "matchAll" };
      return range;
    }
    default: {
      // Exhaustive: TypeScript will complain if a uiKind is missed
      const _exhaustive: never = uiKind;
      throw workshopError({
        errorName: "Tellus:Workshop:UnsupportedFilterUiKind",
        status: 400,
        message: `Unsupported filter uiKind '${String(_exhaustive)}'`,
        parameters: { uiKind: String(_exhaustive) },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Compile a list of filters → predicate tree
// -----------------------------------------------------------------------------

/**
 * Compiles a list of filter values into a single AND-combined predicate tree.
 * Empty list → matchAll. Filters whose values reduce to matchAll are dropped.
 */
export function compileFilters(
  filters: ReadonlyArray<FilterValueIn>,
  ctx: CompileContext,
): Predicate {
  const t0 = process.hrtime.bigint();
  try {
    if (filters.length === 0) return { type: "matchAll" };

    const compiled: Predicate[] = [];
    for (const f of filters) {
      const p = compileFilter(f, ctx);
      if (p.type === "matchAll") continue;
      compiled.push(p);
    }
    if (compiled.length === 0) return { type: "matchAll" };
    if (compiled.length === 1) return compiled[0]!;
    return { type: "and", clauses: compiled };
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histFilterCompile.observe({}, ns / 1e9);
  }
}

// -----------------------------------------------------------------------------
// Cycle detection across "filter using a variable" chains
//
// Per spec §B07 chaos: a filter variable transitively referencing its own
// consumer through chained filterByVariable constraints must surface as
// `Tellus:Workshop:CircularFilterReference` 400. This walks a directed graph
// of `objectSetVar → constraintVar → ...` edges and detects any cycle that
// contains a given root.
// -----------------------------------------------------------------------------

export interface FilterDependencyGraph {
  /** node → outgoing edges (variables this node references via filterByVariable) */
  edges: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Returns a cycle path including `root` if any reachable cycle contains it,
 * otherwise null. The returned array starts and ends with the same node.
 */
export function findFilterCycle(
  root: string,
  graph: FilterDependencyGraph,
): string[] | null {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string): string[] | null {
    if (onStack.has(node)) {
      // Cycle: slice from where the cycle begins
      const idx = stack.indexOf(node);
      if (idx >= 0) {
        return [...stack.slice(idx), node];
      }
      return null;
    }
    if (visited.has(node)) return null;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    const next = graph.edges.get(node) ?? [];
    for (const m of next) {
      const c = dfs(m);
      if (c) return c;
    }
    stack.pop();
    onStack.delete(node);
    return null;
  }
  return dfs(root);
}

/**
 * Throws `Tellus:Workshop:CircularFilterReference` if the graph contains
 * any cycle reachable from `root`.
 */
export function assertNoFilterCycle(
  root: string,
  graph: FilterDependencyGraph,
): void {
  const cycle = findFilterCycle(root, graph);
  if (cycle) {
    throw workshopError({
      errorName: "Tellus:Workshop:CircularFilterReference",
      status: 400,
      message: `Circular filter reference detected: ${cycle.join(" -> ")}`,
      parameters: { cycle },
    });
  }
}
