// ---------------------------------------------------------------------------
// Property marking guard — Rwanda QA plan §3.3 enforcement.
//
// Column-level visibility markings (`property.marking_required`, migration
// 045) are enforced here for every query-shaped read path:
//
//   1. PREDICATE REJECTION (§3.3.3): a caller may not filter, sort,
//      aggregate, or export on a property whose required markings are not a
//      subset of the caller's granted markings. Violations raise
//      MARKING_ACCESS_DENIED (403) before the query reaches the index.
//   2. PROJECTION STRIPPING (§3.3.2): on result materialization (search,
//      list, aggregate rows), properties the caller cannot read are OMITTED
//      from the payload entirely — never nulled or masked client-side.
//
// Direct read-by-primary-key already strips in src/routes/objects.ts; this
// module reuses the exact same semantics for the set-based paths.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { appError } from "../../utils/appError";

export type SecurityLike = {
  markings?: string[];
  markingBypass?: boolean;
} | null | undefined;

export type RestrictedMarking = {
  api_name: string;
  column_name?: string | null;
  marking_required: string[] | string | null;
};

function requiredMarkings(row: RestrictedMarking): string[] {
  if (Array.isArray(row.marking_required)) return row.marking_required;
  if (typeof row.marking_required === "string" && row.marking_required) {
    return [row.marking_required];
  }
  return [];
}

/**
 * Load the set of properties on `objectTypeApiName` that carry a required
 * marking, keyed by property apiName. Properties with NULL or empty
 * `marking_required` are unrestricted and excluded.
 */
export async function loadRestrictedProperties(
  objectTypeApiName: string,
  ontologyId?: string,
): Promise<Map<string, string[]>> {
  try {
    const result = await query(
      `SELECT p.api_name, p.marking_required
         FROM property p
         JOIN object_type ot ON ot.object_type_id = p.object_type_id
        WHERE ot.api_name = $1
          ${ontologyId ? "AND ot.ontology_id = $2" : ""}
          AND p.marking_required IS NOT NULL`,
      ontologyId ? [objectTypeApiName, ontologyId] : [objectTypeApiName],
    );
    const map = new Map<string, string[]>();
    for (const row of result.rows as RestrictedMarking[]) {
      const required = requiredMarkings(row);
      if (required.length > 0) map.set(row.api_name, required);
    }
    return map;
  } catch (err: any) {
    // property.marking_required may not exist on a pre-045 schema — fail open
    // there rather than breaking pre-migration deployments.
    if (err?.code === "42703") return new Map();
    throw err;
  }
}

/** True when every marking required by `required` is granted to the caller. */
export function markingsGranted(
  required: readonly string[],
  granted: ReadonlySet<string>,
): boolean {
  return required.every((marking) => granted.has(marking));
}

/**
 * §3.3.3 — reject a query that references restricted properties the caller
 * cannot read. `fields` are property apiNames appearing in where filters,
 * order-by clauses, aggregations, or export projections.
 */
export function assertFieldsPermitted(
  objectTypeApiName: string,
  fields: Iterable<string>,
  security: SecurityLike,
  restricted: Map<string, string[]>,
): void {
  if (security?.markingBypass === true) return;
  const granted = new Set(security?.markings ?? []);
  for (const field of fields) {
    const required = restricted.get(field);
    if (!required) continue;
    if (markingsGranted(required, granted)) continue;
    throw appError(
      "MARKING_ACCESS_DENIED",
      `Property '${field}' on '${objectTypeApiName}' requires marking(s) [${required.join(", ")}] which the caller does not hold; filtering, sorting, aggregating or exporting on it is not permitted.`,
      { property: field, objectType: objectTypeApiName, requiredMarkings: required },
    );
  }
}

/**
 * §3.3.2 — omit restricted properties from result rows before serialization.
 * Mutates and returns the same rows; safe on any record keyed by property
 * apiName.
 */
export function stripRestrictedRows<T extends Record<string, unknown>>(
  rows: T[],
  security: SecurityLike,
  restricted: Map<string, string[]>,
): T[] {
  if (security?.markingBypass === true || restricted.size === 0) return rows;
  const granted = new Set(security?.markings ?? []);
  const denied: string[] = [];
  for (const [apiName, required] of restricted) {
    if (!markingsGranted(required, granted)) denied.push(apiName);
  }
  if (denied.length === 0) return rows;
  for (const row of rows) {
    for (const apiName of denied) delete row[apiName];
  }
  return rows;
}

/**
 * Collect every property apiName referenced by a where-filter tree. Handles
 * the historical `{type, field, value}` leaf shape plus the boolean
 * combinators (`and`/`or` with `filters`, `value`, or `filter` children) and
 * the `not` wrapper. Unknown shapes are ignored — schema validation is
 * performed separately by queryValidator.
 */
export function collectWhereFields(where: unknown, out = new Set<string>()): Set<string> {
  if (!where || typeof where !== "object" || Array.isArray(where)) return out;
  const node = where as Record<string, unknown>;
  if (typeof node.field === "string" && node.field.length > 0) out.add(node.field);
  for (const key of ["filters", "value", "filter"] as const) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const entry of child) collectWhereFields(entry, out);
    } else if (child && typeof child === "object") {
      collectWhereFields(child, out);
    }
  }
  return out;
}

/** Collect property apiNames from an orderBy array (`{field}` or string). */
export function collectOrderByFields(orderBy: unknown, out = new Set<string>()): Set<string> {
  if (!Array.isArray(orderBy)) return out;
  for (const entry of orderBy) {
    if (typeof entry === "string") out.add(entry);
    else if (entry && typeof entry === "object") {
      const field = (entry as Record<string, unknown>).field;
      if (typeof field === "string" && field.length > 0) out.add(field);
    }
  }
  return out;
}

/** Collect property apiNames from an aggregations array (incl. nested metric). */
export function collectAggregationFields(aggregations: unknown, out = new Set<string>()): Set<string> {
  if (!Array.isArray(aggregations)) return out;
  for (const agg of aggregations) {
    if (!agg || typeof agg !== "object") continue;
    const record = agg as Record<string, unknown>;
    if (typeof record.field === "string" && record.field.length > 0) out.add(record.field);
    const metric = record.metric;
    if (metric && typeof metric === "object") {
      const mf = (metric as Record<string, unknown>).field;
      if (typeof mf === "string" && mf.length > 0) out.add(mf);
    }
    const groupBy = record.groupBy;
    if (groupBy && typeof groupBy === "object") {
      const gf = (groupBy as Record<string, unknown>).field;
      if (typeof gf === "string" && gf.length > 0) out.add(gf);
    }
  }
  return out;
}

/**
 * One-call enforcement for a query-shaped request: rejects predicates on
 * restricted properties and returns the restricted map so callers can strip
 * result rows.
 */
export async function enforceQueryMarkings(options: {
  objectTypeApiName: string;
  ontologyId?: string;
  where?: unknown;
  orderBy?: unknown;
  aggregations?: unknown;
  security: SecurityLike;
}): Promise<Map<string, string[]>> {
  const restricted = await loadRestrictedProperties(
    options.objectTypeApiName,
    options.ontologyId,
  );
  if (restricted.size === 0) return restricted;
  const fields = new Set<string>();
  collectWhereFields(options.where, fields);
  collectOrderByFields(options.orderBy, fields);
  collectAggregationFields(options.aggregations, fields);
  assertFieldsPermitted(options.objectTypeApiName, fields, options.security, restricted);
  return restricted;
}
