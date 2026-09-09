// ---------------------------------------------------------------------------
// effectiveObjects.ts — the single canonical concept of EFFECTIVE object
// state for serving reads.
//
// Consistency model (local/single-node topology):
//
//   object_instances      — authoritative committed state (write-path commits)
//   ontology_edit (WAL)   — durable edit log; drained into the OpenSearch
//                           serving indexes by the serving projector
//   writeback overlay     — short-TTL read-your-writes bridge for commits
//                           that have not reached the serving index yet
//   OpenSearch indexes    — the serving/read path (search + aggregate)
//
// An Object Set filter or aggregation evaluated against the serving index
// alone is evaluated against a LAGGING projection of ontology state. Between
// a commit and the projector's drain (~seconds), and whenever a write path
// failed to enqueue its edit into the WAL, the index can disagree with the
// authoritative store in BOTH directions:
//
//   • a row whose EDITED properties no longer match the query's where clause
//     is still returned by the index (stale match), and
//   • an edited row that newly matches is missing (stale miss).
//
// The read paths therefore reconcile:
//
//   effectiveObject = baseIndexedDocument + latestCommittedEdits
//
// by (a) merging overlay/hydrated property values into returned rows (done by
// mergeWithOverlay / hydrateStaleIndexedRows) and (b) RE-EVALUATING the
// query's property predicates against the merged rows (this module), and, for
// aggregations, recomputing bounded aggregates over the authoritative store
// whenever the type has serving-pending edits (this module).
//
// The predicate evaluator intentionally mirrors the OpenSearch query
// translator's operator matrix for property leaves. Linked (search-around)
// predicates are already resolved server-side before this point and are not
// re-evaluated here.
// ---------------------------------------------------------------------------

import { query } from "../db";

export type WherePredicate = (doc: Record<string, unknown>) => boolean;

/**
 * Compile the property-predicate leaves of an ontology-search `where` clause
 * into a JS row predicate. Returns undefined when the clause contains shapes
 * that cannot be evaluated client-side (callers then keep index semantics
 * for those rows — the overlay replacement path already upgraded their
 * displayed values).
 *
 * Supported: eq / in / gt / gte / lt / lte / contains / startsWith / isNull /
 * isNotNull + and / or / not (+ null where → match-all).
 */
export function buildEffectiveRowPredicate(where: unknown): WherePredicate | undefined {
  if (where == null) return () => true;
  if (typeof where !== "object") return undefined;
  const w = where as Record<string, unknown>;
  const field = typeof w.field === "string" ? w.field : null;

  const coerceCompare = (docValue: unknown, filterValue: unknown): number | null => {
    const nA = typeof docValue === "number" ? docValue : Number(docValue);
    const nB = typeof filterValue === "number" ? filterValue : Number(filterValue);
    if (Number.isFinite(nA) && Number.isFinite(nB)) return nA - nB;
    const dA = Date.parse(String(docValue));
    const dB = Date.parse(String(filterValue));
    if (Number.isFinite(dA) && Number.isFinite(dB)) return dA - dB;
    if (docValue == null || filterValue == null) return null;
    const sA = String(docValue);
    const sB = String(filterValue);
    return sA < sB ? -1 : sA > sB ? 1 : 0;
  };

  if (field) {
    const value = w.value;
    switch (w.type) {
      case "eq":
        return (doc) => doc[field] === value || String(doc[field]) === String(value);
      case "neq":
        return (doc) => !(doc[field] === value || String(doc[field]) === String(value));
      case "in": {
        if (!Array.isArray(value)) return undefined;
        return (doc) => value.some((v) => doc[field] === v || String(doc[field]) === String(v));
      }
      case "gt":
        return (doc) => { const c = coerceCompare(doc[field], value); return c !== null && c > 0; };
      case "gte":
        return (doc) => { const c = coerceCompare(doc[field], value); return c !== null && c >= 0; };
      case "lt":
        return (doc) => { const c = coerceCompare(doc[field], value); return c !== null && c < 0; };
      case "lte":
        return (doc) => { const c = coerceCompare(doc[field], value); return c !== null && c <= 0; };
      case "contains":
        return (doc) =>
          doc[field] != null &&
          String(doc[field]).toLowerCase().includes(String(value ?? "").toLowerCase());
      case "startsWith":
        return (doc) =>
          doc[field] != null &&
          String(doc[field]).toLowerCase().startsWith(String(value ?? "").toLowerCase());
      case "isNull":
        return (doc) => doc[field] == null;
      case "isNotNull":
        return (doc) => doc[field] != null;
      default:
        break;
    }
  }
  if (w.type === "and" && Array.isArray(w.filters)) {
    const sub = w.filters.map(buildEffectiveRowPredicate);
    if (sub.some((f) => f === undefined)) return undefined;
    const fns = sub as WherePredicate[];
    if (fns.length === 0) return () => true;
    return (doc) => fns.every((f) => f(doc));
  }
  if (w.type === "or" && Array.isArray(w.filters)) {
    const sub = w.filters.map(buildEffectiveRowPredicate);
    if (sub.some((f) => f === undefined)) return undefined;
    const fns = sub as WherePredicate[];
    if (fns.length === 0) return () => true;
    return (doc) => fns.some((f) => f(doc));
  }
  if (w.type === "not") {
    const sub = buildEffectiveRowPredicate(w.filter ?? w.value);
    return sub ? (doc) => !sub(doc) : undefined;
  }
  return undefined;
}

/**
 * Re-apply a search's where clause to merged (overlay/hydrated) result rows.
 * Rows whose EFFECTIVE properties no longer match are dropped — a stale
 * index match must not survive into an Object Set. When the clause contains
 * shapes that cannot be re-evaluated (e.g. full-text), the merged rows pass
 * through unchanged.
 */
export function refilterMergedRows(
  rows: Array<Record<string, unknown>>,
  where: unknown,
): Array<Record<string, unknown>> {
  if (where == null) return rows;
  const predicate = buildEffectiveRowPredicate(where);
  if (!predicate) return rows;
  return rows.filter((row) => predicate(row));
}

/**
 * True when the type has committed edits not yet drained into the serving
 * index (the serving projector's backlog). Aggregates computed from the
 * index while this is non-zero may be stale; callers switch to the
 * authoritative recompute path. Cheap existence probe.
 */
export async function hasServingPendingEdits(
  objectTypeApiName: string,
): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM ontology_edit
      WHERE object_type_api_name = $1 AND applied_to_index_at IS NULL
      LIMIT 1`,
    [objectTypeApiName],
  );
  return res.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Bounded authoritative aggregate recompute
// ---------------------------------------------------------------------------

/** Cap on the candidate set the authoritative recompute will materialize.
 * Beyond this the index answer is returned (the projector converges it
 * within seconds) — the recompute path exists for correctness inside the
 * convergence window, not as a second query engine. */
/** Cap on the candidate set the authoritative recompute will materialize.
 * Beyond this the index answer is returned (the projector converges it
 * within seconds) — the recompute path exists for correctness inside the
 * convergence window, not as a second query engine. Kept below the
 * OpenSearch default `index.max_result_window` (10,000) since the search
 * executor fetches `$pageSize + 1` hits. */
export const RECONCILE_MAX_CANDIDATES = 9_000;

interface AggregateDefinition {
  name: string;
  type: string;
  field?: string;
  size?: number;
  interval?: string;
  ranges?: Array<{ key?: string; from?: unknown; to?: unknown }>;
  metric?: { type: string; field?: string };
  groupBy?: { field: string; size?: number };
}

function numeric(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function monthBucketKey(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function yearBucketKey(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}`;
}

function dateHistogramKey(v: unknown, interval: string | undefined): string | null {
  switch (interval) {
    case "1M":
    case "month":
      return monthBucketKey(v);
    case "1d":
    case "day":
    case "1w":
    case "week": {
      if (v == null) return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    default:
      return yearBucketKey(v);
  }
}

function leafMetric(
  rows: Array<Record<string, unknown>>,
  type: string,
  field: string,
): number | null {
  switch (type) {
    case "count":
      return rows.length;
    case "cardinality": {
      const seen = new Set<string>();
      for (const r of rows) {
        const v = r[field];
        if (v != null) seen.add(String(v));
      }
      return seen.size;
    }
    case "sum": {
      let acc = 0;
      let any = false;
      for (const r of rows) {
        const n = numeric(r[field]);
        if (n !== null) { acc += n; any = true; }
      }
      return any ? acc : null;
    }
    case "avg": {
      let acc = 0;
      let count = 0;
      for (const r of rows) {
        const n = numeric(r[field]);
        if (n !== null) { acc += n; count += 1; }
      }
      return count > 0 ? acc / count : null;
    }
    case "min": {
      let best: number | null = null;
      for (const r of rows) {
        const n = numeric(r[field]);
        if (n !== null && (best === null || n < best)) best = n;
      }
      return best;
    }
    case "max": {
      let best: number | null = null;
      for (const r of rows) {
        const n = numeric(r[field]);
        if (n !== null && (best === null || n > best)) best = n;
      }
      return best;
    }
    default:
      return rows.length;
  }
}

/**
 * Recompute the aggregate response over the authoritative store
 * (`object_instances`) for the given candidate rows, mirroring
 * `formatAggregationResponse`'s output contract:
 *   { data: { totalCount, <name>: scalar | buckets[] } }
 */
export function recomputeAggregationsOverRows(
  rows: Array<Record<string, unknown>>,
  aggregations: readonly AggregateDefinition[],
): { data: Record<string, unknown> } {
  const result: Record<string, unknown> = { totalCount: rows.length };
  for (const def of aggregations) {
    switch (def.type) {
      case "count":
      case "cardinality":
        result[def.name] =
          def.type === "count"
            ? rows.length
            : leafMetric(rows, "cardinality", def.field ?? "__pk");
        break;
      case "avg":
      case "sum":
      case "min":
      case "max":
        result[def.name] = leafMetric(rows, def.type, def.field ?? "");
        break;
      case "terms": {
        const field = def.field ?? "";
        const byKey = new Map<string, Array<Record<string, unknown>>>();
        for (const row of rows) {
          const key = row[field] == null ? null : String(row[field]);
          const k = key ?? "__null__";
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k)!.push(row);
        }
        const size = def.size ?? 100;
        const metricType = def.metric?.type ?? "count";
        const metricField = def.metric?.field ?? "__pk";
        const buckets = [...byKey.entries()]
          .map(([key, bucketRows]) => {
            const bucket: Record<string, unknown> = {
              key: key === "__null__" ? null : key,
              count: bucketRows.length,
              value: leafMetric(bucketRows, metricType, metricField) ?? bucketRows.length,
            };
            if (def.groupBy?.field) {
              const bySeries = new Map<string, Array<Record<string, unknown>>>();
              for (const row of bucketRows) {
                const sk = row[def.groupBy.field] == null ? "__null__" : String(row[def.groupBy.field]);
                if (!bySeries.has(sk)) bySeries.set(sk, []);
                bySeries.get(sk)!.push(row);
              }
              bucket.series = [...bySeries.entries()]
                .slice(0, def.groupBy.size ?? 50)
                .map(([sk, srows]) => ({
                  key: sk === "__null__" ? null : sk,
                  count: srows.length,
                  value: leafMetric(srows, metricType, metricField) ?? srows.length,
                }));
            }
            return bucket;
          })
          .sort((a, b) => (b.count as number) - (a.count as number))
          .slice(0, size);
        result[def.name] = buckets;
        break;
      }
      case "date_histogram": {
        const field = def.field ?? "";
        const byKey = new Map<string, number>();
        for (const row of rows) {
          const key = dateHistogramKey(row[field], def.interval);
          if (key == null) continue;
          byKey.set(key, (byKey.get(key) ?? 0) + 1);
        }
        result[def.name] = [...byKey.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, count]) => ({ key, count }));
        break;
      }
      case "range": {
        const field = def.field ?? "";
        result[def.name] = (def.ranges ?? []).map((range) => {
          const from = range.from != null ? numeric(range.from) ?? Date.parse(String(range.from)) : null;
          const to = range.to != null ? numeric(range.to) ?? Date.parse(String(range.to)) : null;
          const count = rows.filter((row) => {
            const v = numeric(row[field]) ?? Date.parse(String(row[field]));
            if (Number.isNaN(v)) return false;
            if (from != null && v < from) return false;
            if (to != null && v >= to) return false;
            return true;
          }).length;
          return { key: range.key ?? `${from ?? ""}-${to ?? ""}`, from: range.from ?? undefined, to: range.to ?? undefined, count };
        });
        break;
      }
      default:
        result[def.name] = null;
    }
  }
  return { data: result };
}

/**
 * Load the authoritative (committed) property documents for a set of
 * primary keys from `object_instances`, batched. Returns rows shaped like
 * search hits (`__pk`, `__objectType`, `__version`, `__overlay_source` plus
 * the full property map) so the same predicate/aggregation helpers apply to
 * index rows and authoritative rows interchangeably.
 */
export async function loadAuthoritativeRows(
  objectTypeApiName: string,
  primaryKeys: readonly string[],
  branchId?: string | null,
): Promise<Array<Record<string, unknown>>> {
  if (primaryKeys.length === 0) return [];
  const res = await query(
    `SELECT primary_key, properties, version, branch_id
       FROM object_instances
      WHERE object_type_api_name = $1
        AND primary_key = ANY($2::text[])
        ${branchId ? "AND branch_id = $3::uuid" : ""}`,
    branchId
      ? [objectTypeApiName, [...primaryKeys], branchId]
      : [objectTypeApiName, [...primaryKeys]],
  );
  return res.rows.map((row) => ({
    __pk: row.primary_key,
    __primaryKey: row.primary_key,
    __objectType: objectTypeApiName,
    __version: Number(row.version),
    __overlay_source: "object_instances",
    ...(row.properties as Record<string, unknown>),
  }));
}
