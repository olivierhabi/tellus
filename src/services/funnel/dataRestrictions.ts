// ---------------------------------------------------------------------------
// OSv2 data restrictions for batch indexing (Palantir parity).
//
// Palantir validates these during indexing; for batch datasources a
// violation fails the indexing job
// (https://www.palantir.com/docs/foundry/object-indexing/data-restrictions/):
//   * duplicate primary keys within one transaction (across transactions the
//     later one wins);
//   * primary keys may not be geopoint, geoshape, arrays, time series or real
//     numbers (decimal, double, float);
//   * no NaN / ±Infinity, no empty strings, no nested arrays, no null
//     elements inside arrays;
//   * strings ≤ 12 MB, arrays ≤ 100,000 elements.
//
// Tellus applies them per object type through `object_type.
// indexing_data_policy` (migration 197):
//   'strict'  — any violation fails the changelog before the snapshot
//               commits (non-retryable), with counts + samples;
//   'lenient' — violations are recorded in summary_json.source_quality and
//               the run continues (duplicate PKs collapse last-wins), which
//               is how every object type behaved before 197.
//
// Two checkers share the rules: `RestrictionTracker` (per row, for readers
// that hand rows to Node) and `buildCsvRestrictionChecks` (one DuckDB
// aggregate scan for the CSV fast path, which never materialises rows in JS).
// See docs/adr/2026-10-09-funnel-data-restrictions-and-incremental-indexing.md.
// ---------------------------------------------------------------------------

import { query } from "../../db";

export type IndexingDataPolicy = "lenient" | "strict";

export const OSV2_LIMITS = {
  /** 12 MB (Palantir: "String properties — 12 MB"). */
  maxStringBytes: 12 * 1024 * 1024,
  maxArrayElements: 100_000,
} as const;

/** Base types Palantir refuses as primary keys. Arrays are refused too
 *  (is_array or any `*_array` base type). */
export const FORBIDDEN_PRIMARY_KEY_BASE_TYPES: ReadonlySet<string> = new Set([
  "geopoint",
  "geoshape",
  "timeseries",
  "decimal",
  "double",
  "float",
]);

const NUMERIC_BASE_TYPES: ReadonlySet<string> = new Set([
  "integer",
  "long",
  "short",
  "byte",
  "double",
  "float",
  "decimal",
  "integer_array",
  "double_array",
]);

/** Spellings DuckDB / JS / pandas use for non-finite numbers. */
const NON_FINITE_LITERALS = [
  "nan",
  "+nan",
  "-nan",
  "inf",
  "+inf",
  "-inf",
  "infinity",
  "+infinity",
  "-infinity",
];
const NON_FINITE_SET: ReadonlySet<string> = new Set(NON_FINITE_LITERALS);

export type RestrictionCode =
  | "duplicate_primary_key"
  | "null_or_empty_primary_key"
  | "forbidden_primary_key_type"
  | "non_finite_number"
  | "empty_string"
  | "nested_array"
  | "null_array_element"
  | "string_too_large"
  | "array_too_large";

export interface RestrictionViolation {
  code: RestrictionCode;
  count: number;
  /** Up to `SAMPLE_LIMIT` human-readable samples, e.g. `pk=42 column=price`. */
  samples: string[];
  /** Columns the violation was seen in (value-level codes only). */
  columns?: string[];
}

export const SAMPLE_LIMIT = 5;

export interface RestrictionColumn {
  /** Source column name (what the reader yields in `properties`). */
  column: string;
  propertyApiName: string;
  baseType: string;
  isArray: boolean;
}

export interface RestrictionSchema {
  objectTypeApiName: string;
  policy: IndexingDataPolicy;
  primaryKeyColumn: string | null;
  primaryKeyBaseType: string | null;
  primaryKeyIsArray: boolean;
  /** Mapped property columns, keyed by source column name. */
  columns: Map<string, RestrictionColumn>;
}

export function isNumericBaseType(baseType: string | null | undefined): boolean {
  return baseType != null && NUMERIC_BASE_TYPES.has(baseType);
}

export function isNonFiniteLiteral(v: string): boolean {
  return NON_FINITE_SET.has(v.trim().toLowerCase());
}

/** Config-level check: the primary key's declared type. */
export function primaryKeyTypeViolation(schema: RestrictionSchema): RestrictionViolation | null {
  const bt = schema.primaryKeyBaseType;
  if (bt == null) return null;
  const forbidden =
    schema.primaryKeyIsArray || bt.endsWith("_array") || FORBIDDEN_PRIMARY_KEY_BASE_TYPES.has(bt);
  if (!forbidden) return null;
  return {
    code: "forbidden_primary_key_type",
    count: 1,
    samples: [
      `primary key '${schema.primaryKeyColumn ?? "?"}' has type ${bt}${schema.primaryKeyIsArray ? "[]" : ""}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Per-row tracker
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  samples: string[];
  columns: Set<string>;
}

/** Collects value-level violations row by row in O(codes) memory. */
export class RestrictionTracker {
  private readonly buckets = new Map<RestrictionCode, Bucket>();

  constructor(private readonly schema: RestrictionSchema | null) {}

  record(code: RestrictionCode, sample: string, column?: string, n = 1): void {
    let b = this.buckets.get(code);
    if (!b) {
      b = { count: 0, samples: [], columns: new Set() };
      this.buckets.set(code, b);
    }
    b.count += n;
    if (b.samples.length < SAMPLE_LIMIT && !b.samples.includes(sample)) b.samples.push(sample);
    if (column !== undefined && b.columns.size < 50) b.columns.add(column);
  }

  /** Check one source row's property values. */
  observe(primaryKey: string, properties: Record<string, unknown>): void {
    const pkCol = this.schema?.primaryKeyColumn ?? null;
    for (const column in properties) {
      if (column === pkCol) continue; // PK nullness is the reader's concern
      const v = properties[column];
      if (v == null) continue;
      const meta = this.schema?.columns.get(column);
      this.checkValue(primaryKey, column, v, isNumericBaseType(meta?.baseType));
    }
  }

  private checkValue(pk: string, column: string, v: unknown, numericColumn: boolean): void {
    const sample = `pk=${pk} column=${column}`;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) this.record("non_finite_number", sample, column);
      return;
    }
    if (typeof v === "string") {
      if (v.length === 0) {
        this.record("empty_string", sample, column);
        return;
      }
      if (numericColumn && v.length <= 9 && isNonFiniteLiteral(v)) {
        this.record("non_finite_number", sample, column);
        return;
      }
      // UTF-8 is ≤ 3 bytes per UTF-16 code unit: skip the byte count unless
      // the string could possibly exceed the limit.
      if (
        v.length * 3 > OSV2_LIMITS.maxStringBytes &&
        Buffer.byteLength(v, "utf8") > OSV2_LIMITS.maxStringBytes
      ) {
        this.record("string_too_large", sample, column);
      }
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > OSV2_LIMITS.maxArrayElements) this.record("array_too_large", sample, column);
      let nested = false;
      let nullEl = false;
      let nonFinite = false;
      for (const el of v) {
        if (el == null) nullEl = true;
        else if (Array.isArray(el)) nested = true;
        else if (typeof el === "number" && !Number.isFinite(el)) nonFinite = true;
      }
      if (nested) this.record("nested_array", sample, column);
      if (nullEl) this.record("null_array_element", sample, column);
      if (nonFinite) this.record("non_finite_number", sample, column);
    }
  }

  violations(): RestrictionViolation[] {
    const out: RestrictionViolation[] = [];
    for (const [code, b] of this.buckets) {
      out.push({
        code,
        count: b.count,
        samples: b.samples,
        ...(b.columns.size > 0 ? { columns: [...b.columns].sort() } : {}),
      });
    }
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }
}

/** Merge violation lists (same code ⇒ counts add, samples/columns union). */
export function mergeViolations(...lists: RestrictionViolation[][]): RestrictionViolation[] {
  const t = new RestrictionTracker(null);
  const cols = new Map<RestrictionCode, Set<string>>();
  for (const list of lists) {
    for (const v of list) {
      if (v.count <= 0) continue;
      const [first, ...rest] = v.samples.length > 0 ? v.samples : [""];
      t.record(v.code, first, undefined, v.count);
      for (const s of rest) t.record(v.code, s, undefined, 0);
      if (v.columns) {
        const c = cols.get(v.code) ?? new Set<string>();
        for (const x of v.columns) c.add(x);
        cols.set(v.code, c);
      }
    }
  }
  return t.violations().map((v) => {
    const c = cols.get(v.code);
    return {
      ...v,
      samples: v.samples.filter((s) => s !== ""),
      ...(c && c.size > 0 ? { columns: [...c].sort() } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// DuckDB aggregate for the CSV fast path (all_varchar source)
// ---------------------------------------------------------------------------

function qIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export interface CsvRestrictionCheck {
  code: RestrictionCode;
  column: string;
  /** Boolean SQL predicate over the source row. */
  predicate: string;
  alias: string;
}

/**
 * Value-level checks for an all_varchar CSV scan: oversized strings, plus
 * NaN / ±Infinity spellings on numeric-typed columns. No empty-string
 * check: DuckDB's CSV reader turns both `,,` and `,"",` into NULL (the OSv1
 * "empty string → null" conversion), so an empty string can never reach the
 * index from this path.
 */
export function buildCsvRestrictionChecks(
  sourceColumns: string[],
  schema: RestrictionSchema | null,
): CsvRestrictionCheck[] {
  const pkCol = schema?.primaryKeyColumn ?? null;
  const checks: CsvRestrictionCheck[] = [];
  const literals = NON_FINITE_LITERALS.map((l) => `'${l}'`).join(", ");
  sourceColumns.forEach((column, i) => {
    if (column === pkCol) return;
    const c = qIdent(column);
    checks.push({
      code: "string_too_large",
      column,
      predicate: `strlen(${c}) > ${OSV2_LIMITS.maxStringBytes}`,
      alias: `r${i}_large`,
    });
    if (isNumericBaseType(schema?.columns.get(column)?.baseType)) {
      checks.push({
        code: "non_finite_number",
        column,
        predicate: `lower(trim(${c})) IN (${literals})`,
        alias: `r${i}_nonfinite`,
      });
    }
  });
  return checks;
}

/** `count(*) FILTER (WHERE …) AS alias` fragments for one aggregate scan. */
export function csvRestrictionAggregateSql(checks: CsvRestrictionCheck[]): string {
  return checks.map((k) => `count(*) FILTER (WHERE ${k.predicate}) AS ${k.alias}`).join(", ");
}

/** Fold the aggregate row into violations (samples are filled separately). */
export function violationsFromCsvAggregate(
  checks: CsvRestrictionCheck[],
  row: Record<string, unknown>,
): RestrictionViolation[] {
  const t = new RestrictionTracker(null);
  const cols = new Map<RestrictionCode, Set<string>>();
  for (const k of checks) {
    const n = Number(row[k.alias] ?? 0);
    if (n <= 0) continue;
    t.record(k.code, "", undefined, n);
    const c = cols.get(k.code) ?? new Set<string>();
    c.add(k.column);
    cols.set(k.code, c);
  }
  return t.violations().map((v) => ({
    ...v,
    samples: [],
    columns: [...(cols.get(v.code) ?? [])].sort(),
  }));
}

// ---------------------------------------------------------------------------
// Policy + schema
// ---------------------------------------------------------------------------

export class IndexingDataRestrictionError extends Error {
  constructor(
    readonly objectTypeApiName: string,
    readonly violations: RestrictionViolation[],
  ) {
    super(formatViolations(objectTypeApiName, violations));
    this.name = "IndexingDataRestrictionError";
  }
}

export function formatViolations(objectTypeApiName: string, violations: RestrictionViolation[]): string {
  const parts = violations.map((v) => {
    const cols = v.columns && v.columns.length > 0 ? ` columns=${JSON.stringify(v.columns)}` : "";
    const samples = v.samples.length > 0 ? ` samples=${JSON.stringify(v.samples)}` : "";
    return `${v.code}: ${v.count}${cols}${samples}`;
  });
  return (
    `object type '${objectTypeApiName}' violates OSv2 data restrictions ` +
    `(indexing_data_policy=strict): ${parts.join("; ")}. Fix the source data, ` +
    `or set indexing_data_policy='lenient' to record violations without failing.`
  );
}

/** Strict ⇒ throw on any violation. Lenient ⇒ return them for the summary. */
export function enforceRestrictions(
  schema: Pick<RestrictionSchema, "objectTypeApiName" | "policy"> | null,
  violations: RestrictionViolation[],
): RestrictionViolation[] {
  const real = violations.filter((v) => v.count > 0);
  if (schema?.policy === "strict" && real.length > 0) {
    throw new IndexingDataRestrictionError(schema.objectTypeApiName, real);
  }
  return real;
}

export function normalizePolicy(v: unknown): IndexingDataPolicy {
  return v === "strict" ? "strict" : "lenient";
}

/**
 * Load the object type's policy, primary-key type and property columns.
 * Returns null when the object type is unknown (pending-edit-only paths in
 * tests). A database without migration 197 reads as 'lenient'.
 */
export async function loadRestrictionSchema(
  objectTypeApiName: string,
): Promise<RestrictionSchema | null> {
  let policyCol = "ot.indexing_data_policy";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await query(
        `SELECT ot.object_type_id, ${policyCol} AS policy,
                pk.api_name AS pk_api_name, pk.base_type AS pk_base_type,
                COALESCE(pk.is_array, false) AS pk_is_array,
                bd.column_mapping, bd.primary_key_column
           FROM object_type ot
           LEFT JOIN property pk ON pk.property_id = ot.primary_key_property_id
           LEFT JOIN LATERAL (
             SELECT column_mapping, primary_key_column
               FROM backing_datasource b
              WHERE b.object_type_id = ot.object_type_id
              ORDER BY (b.file_path IS NOT NULL) DESC
              LIMIT 1
           ) bd ON true
          WHERE ot.api_name = $1
          LIMIT 1`,
        [objectTypeApiName],
      );
      const row = res.rows[0] as
        | {
            object_type_id: string;
            policy: string | null;
            pk_api_name: string | null;
            pk_base_type: string | null;
            pk_is_array: boolean;
            column_mapping: unknown;
            primary_key_column: string | null;
          }
        | undefined;
      if (!row) return null;
      const props = await query(
        `SELECT api_name, base_type, COALESCE(is_array, false) AS is_array
           FROM property WHERE object_type_id = $1`,
        [row.object_type_id],
      );
      let mapping: Record<string, string> = {};
      const raw =
        typeof row.column_mapping === "string" ? safeJson(row.column_mapping) : row.column_mapping;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        mapping = raw as Record<string, string>;
      }
      const columns = new Map<string, RestrictionColumn>();
      for (const p of props.rows as { api_name: string; base_type: string; is_array: boolean }[]) {
        const column = typeof mapping[p.api_name] === "string" ? mapping[p.api_name] : p.api_name;
        columns.set(column, {
          column,
          propertyApiName: p.api_name,
          baseType: p.base_type,
          isArray: p.is_array,
        });
      }
      const pkColumn =
        row.primary_key_column ??
        (row.pk_api_name ? (mapping[row.pk_api_name] ?? row.pk_api_name) : null);
      return {
        objectTypeApiName,
        policy: normalizePolicy(row.policy),
        primaryKeyColumn: pkColumn,
        primaryKeyBaseType: row.pk_base_type,
        primaryKeyIsArray: row.pk_is_array === true,
        columns,
      };
    } catch (err) {
      // 42703 undefined_column: migration 197 not applied yet ⇒ lenient.
      if ((err as { code?: string }).code === "42703" && attempt === 0) {
        policyCol = "NULL::text";
        continue;
      }
      throw err;
    }
  }
  return null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
