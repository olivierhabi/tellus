// ---------------------------------------------------------------------------
// ObjectSet compiler — reduces the verified 14-node ObjectSet union
// into the smallest valid collection of per-object-type execution
// plans (Phase 4).
//
// Design rules (Palantir-style):
//   * Every node compiles to plans of { objectType, where }.
//   * Same-type set algebra folds into ONE plan via and/or/not.
//   * Cross-type algebra produces multiple typed plans; the executor
//     merges them deterministically (never a boolean hack).
//   * `reference` resolution is injected (saved + temporary stores)
//     with cycle detection.
//   * `searchAround` / `interfaceLinkSearchAround` compile to a hop
//     marker the executor fulfils via searchAroundService.
//   * `nearestNeighbors` is a NODE annotation on the plan, never a
//     filter (verified contract).
//   * `relativeDateRange` bounds compile to ABSOLUTE dates here —
//     page tokens must never re-evaluate "now".
// ---------------------------------------------------------------------------

import type {
  ObjectSet,
  SearchJsonQueryV2,
} from "./objectSetDefinition";
import { objectSetFingerprint } from "./objectSetDefinition";

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export interface KnnPlan {
  field: string;
  query: { type: "vector"; value: number[] } | { type: "text"; value: string };
  numNeighbors: number;
  similarityThreshold?: number;
}

export interface SearchAroundHop {
  link: string;
  /** Source object type the hop starts from. */
  fromObjectType: string;
  interfaceLink?: boolean;
}

export interface CompiledPlan {
  objectType: string;
  /** Internal where-DSL (queryTranslator input). */
  where: unknown;
  /** Pending search-around hop to fulfil before querying. */
  searchAround?: SearchAroundHop;
  /** Complete inner-to-outer traversal chain for nested Search Around sets. */
  searchAroundChain?: SearchAroundHop[];
  /** Filter applied to the ANCHOR set before traversal. */
  searchAroundSourceWhere?: unknown;
  /** Nearest-neighbors node annotation (knn query). */
  knn?: KnnPlan;
  /** Derived properties to compute on returned objects. */
  derivedProperties?: Record<string, unknown>;
  /** Static rid membership (resolved to PKs by the executor). */
  staticRids?: string[];
  /** Origin interface, for property mapping + __apiName handling. */
  interfaceApiName?: string;
}

export interface CompiledObjectSet {
  plans: CompiledPlan[];
  crossType: boolean;
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Injected dependencies — infra-agnostic, fully unit-testable
// ---------------------------------------------------------------------------

export interface CompilerDeps {
  /** Fail-closed existence check for concrete object types. */
  resolveObjectType?: (objectTypeApiName: string) => Promise<boolean>;
  /** Resolve a saved or temporary object set rid to its definition. */
  resolveReference?: (rid: string) => Promise<ObjectSet | null>;
  /** Interface apiName → implementing object type apiNames. */
  resolveInterfaceImplementations?: (interfaceApiName: string) => Promise<string[]>;
  /** Translate an interface-typed where clause for an implementing type. */
  translateInterfaceWhere?: (
    interfaceApiName: string,
    objectTypeApiName: string,
    where: unknown,
  ) => Promise<unknown>;
  /** Bound set for `methodInput` nodes (function execution context). */
  methodInputSet?: ObjectSet;
  /** Now provider — deterministic in tests. */
  now?: () => Date;
}

export class ObjectSetCompileError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ObjectSetCompileError";
  }
}

// ---------------------------------------------------------------------------
// Where-DSL algebra helpers
// ---------------------------------------------------------------------------

function andWhere(...clauses: unknown[]): unknown {
  const flat = clauses.filter(Boolean);
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return { type: "and", value: flat };
}

function orWhere(...clauses: unknown[]): unknown {
  const flat = clauses.filter(Boolean);
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return { type: "or", value: flat };
}

function notWhere(clause: unknown): unknown {
  if (!clause) return null;
  return { type: "not", value: [clause] };
}

// ---------------------------------------------------------------------------
// SearchJsonQueryV2 → internal where-DSL
// ---------------------------------------------------------------------------

/**
 * Translate the verified v2 filter tree into the internal where-DSL
 * (queryTranslator input). v2-only operators map 1:1 onto the Phase 6
 * internal types; `relativeDateRange` compiles to absolute bounds.
 */
export function searchJsonToWhere(
  query: SearchJsonQueryV2,
  now: Date,
): unknown {
  const q = query as Record<string, unknown>;
  switch (q.type) {
    case "and":
    case "or":
      return {
        type: q.type,
        value: (q.value as SearchJsonQueryV2[]).map((c) =>
          searchJsonToWhere(c, now),
        ),
      };
    // v2 `not` is unary; the internal DSL takes a 1-element array.
    case "not":
      return { type: "not", value: [searchJsonToWhere(q.value as SearchJsonQueryV2, now)] };
    // v2 `contains` = array membership → internal eq (term query
    // matches any array element).
    case "contains":
      return { type: "eq", field: q.field, value: q.value };
    // v2 isNull carries {value: boolean}.
    case "isNull":
      return q.value === false
        ? { type: "isNotNull", field: q.field }
        : { type: "isNull", field: q.field };
    case "relativeDateRange": {
      const bounds = compileRelativeDateRange(q, now);
      const clauses: unknown[] = [];
      if (bounds.gte) clauses.push({ type: "gte", field: q.field, value: bounds.gte });
      if (bounds.lt) clauses.push({ type: "lt", field: q.field, value: bounds.lt });
      return andWhere(...clauses) ?? { type: "and", value: [] };
    }
    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "in":
    case "startsWith":
      return { type: q.type, field: q.field, value: q.value };
    case "containsAllTerms":
    case "containsAnyTerm":
    case "containsAllTermsInOrder":
    case "containsAllTermsInOrderPrefixLastTerm":
    case "wildcard":
    case "regex":
      return { type: q.type, field: q.field, value: q.value, ...(q.fuzzy !== undefined ? { fuzzy: q.fuzzy } : {}) };
    case "interval":
      return { type: "interval", field: q.field, rule: q.rule };
    case "withinBoundingBox":
    case "withinDistanceOf":
    case "withinPolygon":
    case "intersectsBoundingBox":
    case "intersectsPolygon":
    case "doesNotIntersectBoundingBox":
    case "doesNotIntersectPolygon":
      return { type: q.type, field: q.field, value: q.value };
    case "geoShapeV2": {
      const propertyIdentifier = q.propertyIdentifier as
        | Record<string, unknown>
        | undefined;
      const unwrap = (
        identifier: Record<string, unknown> | undefined,
      ): string | null => {
        if (!identifier) return null;
        if (identifier.type === "property") {
          return typeof identifier.apiName === "string"
            ? identifier.apiName
            : null;
        }
        if (identifier.type === "propertyWithLoadLevel") {
          return unwrap(
            identifier.propertyIdentifier as Record<string, unknown>,
          );
        }
        return null;
      };
      const selectedField =
        typeof q.field === "string" ? q.field : unwrap(propertyIdentifier);
      if (!selectedField) {
        throw new ObjectSetCompileError(
          "UnsupportedFilter",
          "geoShapeV2 currently requires field or a property PropertyIdentifier.",
          { filterType: q.type },
        );
      }
      let shape: unknown;
      const geometry = q.geometry as Record<string, unknown>;
      if (geometry.type === "envelope") {
        const topLeft = geometry.topLeft as { lat: number; lon: number };
        const bottomRight = geometry.bottomRight as {
          lat: number;
          lon: number;
        };
        shape = {
          type: "envelope",
          coordinates: [
            [topLeft.lon, topLeft.lat],
            [bottomRight.lon, bottomRight.lat],
          ],
        };
      } else {
        try {
          shape = JSON.parse(String(geometry.geoJson));
        } catch {
          throw new ObjectSetCompileError(
            "UnsupportedFilter",
            "geoShapeV2 geometry.geoJson must contain valid GeoJSON.",
            { filterType: q.type },
          );
        }
      }
      return {
        type: "geoShapeV2",
        field: selectedField,
        shape,
        spatialFilterMode: q.spatialFilterMode,
      };
    }
    default:
      throw new ObjectSetCompileError(
        "UnsupportedFilter",
        `Unsupported SearchJsonQueryV2 type: ${String(q.type)}`,
        { filterType: q.type },
      );
  }
}

/**
 * Relative bounds → absolute ISO dates, rounded to midnight in the
 * requested IANA timezone (verified spec semantics: "rounded to
 * midnight in the specified timezone"). Compiled ONCE at compile
 * time so page tokens are deterministic.
 */
export function compileRelativeDateRange(
  q: Record<string, unknown>,
  now: Date,
): { gte?: string; lt?: string } {
  const tz = (q.timeZoneId as string) || "UTC";
  const resolve = (b: unknown): Date | null => {
    if (!b || typeof b !== "object") return null;
    const bound = b as { value: number; timeUnit: string };
    const d = new Date(now.getTime());
    const v = bound.value;
    switch (bound.timeUnit) {
      case "DAY": d.setUTCDate(d.getUTCDate() + v); break;
      case "WEEK": d.setUTCDate(d.getUTCDate() + 7 * v); break;
      case "MONTH": d.setUTCMonth(d.getUTCMonth() + v); break;
      case "YEAR": d.setUTCFullYear(d.getUTCFullYear() + v); break;
      default:
        throw new ObjectSetCompileError(
          "InvalidRelativeTimeUnit",
          `Unknown relative time unit: ${bound.timeUnit}`,
        );
    }
    return midnightInZone(d, tz);
  };
  const start = resolve(q.relativeStartTime);
  const end = resolve(q.relativeEndTime);
  return {
    gte: start ? start.toISOString() : undefined,
    lt: end ? end.toISOString() : undefined,
  };
}

/** Offset of IANA zone `tz` at instant `d`, in ms (tz − UTC). */
function tzOffsetMs(d: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d);
  } catch {
    throw new ObjectSetCompileError(
      "InvalidTimeZone",
      `Unknown timeZoneId: ${tz}`,
      { timeZoneId: tz },
    );
  }
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  const wallAsUtc = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}Z`,
  );
  const floored = Math.floor(d.getTime() / 1000) * 1000;
  return wallAsUtc - floored;
}

/** Midnight of `d`'s calendar day in IANA zone `tz`, as a UTC Date. */
export function midnightInZone(d: Date, tz: string): Date {
  // YMD of `d` in tz (validates tz as a side effect).
  const offsetNow = tzOffsetMs(d, tz);
  const wall = new Date(d.getTime() + offsetNow);
  const ymd = wall.toISOString().slice(0, 10);
  const approx = Date.parse(`${ymd}T00:00:00Z`);
  // UTC instant of local midnight: subtract the offset in effect
  // AT that midnight (DST-safe: recompute once).
  let t = approx - tzOffsetMs(new Date(approx), tz);
  const second = tzOffsetMs(new Date(t), tz);
  if (approx - second !== t) t = approx - second;
  return new Date(t);
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export async function compileObjectSet(
  objectSet: ObjectSet,
  deps: CompilerDeps = {},
): Promise<CompiledObjectSet> {
  const now = deps.now?.() ?? new Date();
  const plans = await compileNode(objectSet, deps, now, new Set<string>(), 0);
  const types = new Set(plans.map((p) => p.objectType));
  return {
    plans,
    crossType: types.size > 1,
    fingerprint: objectSetFingerprint(objectSet),
  };
}

const MAX_COMPILE_DEPTH = 20;

async function compileNode(
  node: ObjectSet,
  deps: CompilerDeps,
  now: Date,
  refStack: Set<string>,
  depth: number,
): Promise<CompiledPlan[]> {
  if (depth > MAX_COMPILE_DEPTH) {
    throw new ObjectSetCompileError(
      "ObjectSetTooDeep",
      `ObjectSet compilation exceeded ${MAX_COMPILE_DEPTH} levels.`,
    );
  }
  const n = node as Record<string, unknown>;

  switch (n.type) {
    case "base":
      if (
        deps.resolveObjectType &&
        !(await deps.resolveObjectType(n.objectType as string))
      ) {
        throw new ObjectSetCompileError(
          "ObjectTypeNotFound",
          `Object type not found: ${String(n.objectType)}`,
          { objectType: n.objectType },
        );
      }
      return [{ objectType: n.objectType as string, where: null }];

    case "filter": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      const where = searchJsonToWhere(n.where as SearchJsonQueryV2, now);
      const out: CompiledPlan[] = [];
      for (const child of children) {
        let w = where;
        if (child.interfaceApiName && deps.translateInterfaceWhere) {
          // Filters authored against interface property names must be
          // re-mapped per implementing type.
          w = (await deps.translateInterfaceWhere(
            child.interfaceApiName, child.objectType, where,
          )) as typeof where;
        }
        out.push({ ...child, where: andWhere(child.where, w) });
      }
      return out;
    }

    case "reference": {
      const rid = n.reference as string;
      if (refStack.has(rid)) {
        throw new ObjectSetCompileError(
          "CircularObjectSetReference",
          `Circular object set reference detected: ${rid}`,
          { reference: rid },
        );
      }
      if (!deps.resolveReference) {
        throw new ObjectSetCompileError(
          "ObjectSetReferenceUnsupported",
          "No reference resolver configured.",
        );
      }
      const resolved = await deps.resolveReference(rid);
      if (!resolved) {
        throw new ObjectSetCompileError(
          "ObjectSetNotFound",
          `Referenced object set not found: ${rid}`,
          { reference: rid },
        );
      }
      refStack.add(rid);
      try {
        return await compileNode(resolved, deps, now, refStack, depth + 1);
      } finally {
        refStack.delete(rid);
      }
    }

    case "union":
      return combineSetOp(
        await compileChildren(n.objectSets as ObjectSet[], deps, now, refStack, depth),
        "union",
      );

    case "intersect":
      return combineSetOp(
        await compileChildren(n.objectSets as ObjectSet[], deps, now, refStack, depth),
        "intersect",
      );

    case "subtract": {
      const sets = n.objectSets as ObjectSet[];
      const [head, ...rest] = await compileChildren(sets, deps, now, refStack, depth);
      return subtractPlans(head!, rest);
    }

    case "searchAround": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      // The hop's target type is resolved at execution time via the
      // link registry; we attach the hop to every source plan.
      return children.map((c) => {
        const existingChain =
          c.searchAroundChain ?? (c.searchAround ? [c.searchAround] : []);
        const nextHop = {
          link: n.link as string,
          fromObjectType: c.objectType,
        };
        const chain = [...existingChain, nextHop];
        return {
          objectType: c.objectType,
          where: null,
          searchAround: chain[0],
          searchAroundChain: chain,
          // Preserve the source filter: the first hop filters the SOURCE set
          // before the remaining hops traverse its resolved primary keys.
          searchAroundSourceWhere: c.searchAround
            ? c.searchAroundSourceWhere
            : c.where,
        };
      });
    }

    case "interfaceLinkSearchAround": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      return children.map((c) => ({
        objectType: c.objectType,
        where: null,
        searchAround: {
          link: n.interfaceLink as string,
          fromObjectType: c.objectType,
          interfaceLink: true,
        },
        searchAroundChain: [
          {
            link: n.interfaceLink as string,
            fromObjectType: c.objectType,
            interfaceLink: true,
          },
        ],
        searchAroundSourceWhere: c.where,
      }));
    }

    case "interfaceBase": {
      const apiName = n.interfaceType as string;
      if (!deps.resolveInterfaceImplementations) {
        throw new ObjectSetCompileError(
          "InterfaceResolutionUnsupported",
          "No interface resolver configured.",
        );
      }
      const impls = await deps.resolveInterfaceImplementations(apiName);
      if (impls.length === 0) {
        throw new ObjectSetCompileError(
          "InterfaceTypeNotFound",
          `Interface type not found or has no implementations: ${apiName}`,
          { interfaceType: apiName },
        );
      }
      return impls.map((objectType) => ({
        objectType,
        where: null,
        interfaceApiName: apiName,
      }));
    }

    case "asBaseObjectTypes":
      // Interface set → per-implementing-type plans. For
      // non-interface children this is a verified no-op.
      return compileNode(n.objectSet as ObjectSet, deps, now, refStack, depth + 1);

    case "asType": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      const entityType = n.entityType as string;
      // Verified spec: drop any object whose type does not match the
      // provided type (or implement it, when entityType is an
      // interface name).
      const impls = deps.resolveInterfaceImplementations
        ? await deps.resolveInterfaceImplementations(entityType).catch(() => [] as string[])
        : [];
      const allowed = new Set([entityType, ...impls]);
      return children.filter((c) => allowed.has(c.objectType));
    }

    case "nearestNeighbors": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      const pid = n.propertyIdentifier as { apiName: string };
      return children.map((c) => ({
        ...c,
        knn: {
          field: pid.apiName,
          query: n.query as KnnPlan["query"],
          numNeighbors: n.numNeighbors as number,
          similarityThreshold: n.similarityThreshold as number | undefined,
        },
      }));
    }

    case "withProperties": {
      const children = await compileNode(
        n.objectSet as ObjectSet, deps, now, refStack, depth + 1,
      );
      const derived = n.derivedProperties as Record<string, unknown>;
      return children.map((c) => ({
        ...c,
        derivedProperties: { ...c.derivedProperties, ...derived },
      }));
    }

    case "static":
      return [{
        objectType: "__static__",
        where: null,
        staticRids: n.objects as string[],
      }];

    case "methodInput": {
      if (!deps.methodInputSet) {
        throw new ObjectSetCompileError(
          "MethodInputUnbound",
          "methodInput object set requires a function-execution binding.",
        );
      }
      return compileNode(deps.methodInputSet, deps, now, refStack, depth + 1);
    }

    default:
      throw new ObjectSetCompileError(
        "InvalidObjectSet",
        `Unknown ObjectSet node type: ${String(n.type)}`,
      );
  }
}

async function compileChildren(
  sets: ObjectSet[],
  deps: CompilerDeps,
  now: Date,
  refStack: Set<string>,
  depth: number,
): Promise<CompiledPlan[][]> {
  const out: CompiledPlan[][] = [];
  for (const s of sets) {
    out.push(await compileNode(s, deps, now, refStack, depth + 1));
  }
  return out;
}

/**
 * Set algebra over plan lists, grouped by object type.
 *   union:     per type → or(children wheres); types union.
 *   intersect: per SHARED type → and(children wheres); types
 *              intersection (objects of type A ∩ type B = ∅).
 */
function combineSetOp(
  children: CompiledPlan[][],
  op: "union" | "intersect",
): CompiledPlan[] {
  if (children.length === 0) return [];
  if (children.length === 1) return children[0]!;

  const types = new Set<string>();
  for (const child of children) for (const p of child) types.add(p.objectType);

  const out: CompiledPlan[] = [];
  for (const objectType of types) {
    const perChild = children.map((child) =>
      child.find((p) => p.objectType === objectType),
    );
    if (op === "intersect" && perChild.some((p) => !p)) {
      continue; // type absent from ≥1 child → no objects of this type
    }
    const present = perChild.filter((p): p is CompiledPlan => !!p);
    const merged: CompiledPlan = {
      objectType,
      where:
        op === "union"
          ? orWhere(...present.map((p) => p.where))
          : andWhere(...present.map((p) => p.where)),
    };
    // Carry annotations (knn/searchAround/derived/static/interface)
    // when exactly one plan contributes this type.
    const allForType = children.flat().filter((p) => p.objectType === objectType);
    if (allForType.length === 1) {
      Object.assign(merged, allForType[0], { where: merged.where });
    }
    out.push(merged);
  }
  return out;
}

/** head − rest: per head type, subtract same-type rest wheres. */
function subtractPlans(
  head: CompiledPlan[],
  rest: CompiledPlan[][],
): CompiledPlan[] {
  const restByType = new Map<string, unknown[]>();
  for (const child of rest) {
    for (const plan of child) {
      const list = restByType.get(plan.objectType) ?? [];
      list.push(plan.where);
      restByType.set(plan.objectType, list);
    }
  }
  return head.map((plan) => {
    const subtrahends = restByType.get(plan.objectType) ?? [];
    if (subtrahends.length === 0) return plan;
    return {
      ...plan,
      where: andWhere(plan.where, notWhere(orWhere(...subtrahends))),
    };
  });
}
