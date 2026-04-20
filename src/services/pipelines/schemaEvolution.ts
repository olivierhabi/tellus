// ---------------------------------------------------------------------------
// Schema evolution — PB-B10.
//
// Computes the diff between a pipeline's prior-deploy output schema and
// the current one, classifies each operation as safe/unsafe per the
// spec's matrix, and produces the operation list the sidecar applies
// through pyiceberg's `update_schema()`.
//
// Semantics pinned to Iceberg V2 (same as the Funnel). Safe operations:
//   * ADD column (always nullable)
//   * RENAME column (column-id retained so old snapshots are readable)
//   * WIDEN column type within a family
//       int32 → int64
//       float32 → float64
//       decimal(p,s) → decimal(p',s')  where p'>=p and s'>=s
//   * DROP column (logical) — V2 retains the column id
//
// Unsafe / rejected:
//   * Narrowing type (shrink precision, int64→int32, etc.)
//   * Changing a nullable column to required
//   * Changing type ACROSS a family (string→int, int→timestamp, …)
//   * Any operation on a primary-key column
//
// The classifier never throws on a recognisable diff — it returns a
// structured {operations, blockingIssues} envelope so the dry-run
// endpoint can return it verbatim.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { canonicalStringify } from "./previewSnapshot";

export type LogicalType =
  | "string"
  | "integer"
  | "long"
  | "bigint"
  | "int32"
  | "int64"
  | "numeric"
  | "float"
  | "float32"
  | "double"
  | "float64"
  | "boolean"
  | "date"
  | "timestamp"
  | "timestamp_micros"
  | (string & {}); // allow the stringly-typed fall-through

export interface SchemaColumn {
  name: string;
  type: string;
  required?: boolean;
  /**
   * When classifying a schema change on a primary-key column the
   * classifier rejects the whole migration. Pipeline outputs set this
   * flag on the PK column.
   */
  primaryKey?: boolean;
  /** Decimal precision (for decimal(p,s) widening). */
  precision?: number;
  /** Decimal scale. */
  scale?: number;
}

export type SchemaOp =
  | { op: "add_column"; name: string; type: string; required?: boolean }
  | { op: "rename_column"; from: string; to: string }
  | { op: "update_column_type"; name: string; from: string; to: string }
  | { op: "delete_column"; name: string }
  | {
      op: "narrowing";
      name: string;
      from: string;
      to: string;
      reason: string;
    }
  | { op: "nullable_tighten"; name: string; reason: string }
  | { op: "primary_key_change"; name: string; reason: string }
  | { op: "cross_family_type_change"; name: string; from: string; to: string };

export interface SchemaDiffResult {
  operations: SchemaOp[];
  safeOperations: SchemaOp[];
  blockingIssues: SchemaOp[];
  willBeSafe: boolean;
  priorFingerprint: string | null;
  newFingerprint: string;
  changed: boolean;
}

const INT_FAMILY = new Set(["integer", "int", "int32", "long", "int64", "bigint"]);
const FLOAT_FAMILY = new Set(["numeric", "float", "float32", "double", "float64"]);
const DECIMAL_PREFIX = "decimal";

export function fingerprintOutputSchema(columns: SchemaColumn[]): string {
  // Canonicalise the schema: sort by name so reorder doesn't create a
  // ghost diff; the deploy path already preserves column order via
  // `ordinal_position` on dataset_columns, so this is safe.
  const norm = (columns ?? []).map((c) => ({
    name: String(c.name),
    type: String(c.type ?? "").toLowerCase(),
    required: c.required ?? false,
    primaryKey: c.primaryKey ?? false,
  }));
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(norm), "utf-8")
    .digest("hex");
}

function family(t: string): "int" | "float" | "decimal" | "other" {
  const s = (t ?? "").toLowerCase().trim();
  if (INT_FAMILY.has(s)) return "int";
  if (FLOAT_FAMILY.has(s)) return "float";
  if (s.startsWith(DECIMAL_PREFIX)) return "decimal";
  return "other";
}

function intRank(t: string): number {
  const s = (t ?? "").toLowerCase();
  if (s === "int32" || s === "integer" || s === "int") return 32;
  return 64; // long/int64/bigint
}

function floatRank(t: string): number {
  const s = (t ?? "").toLowerCase();
  if (s === "float32" || s === "float") return 32;
  return 64; // double/float64/numeric
}

function parseDecimal(t: string): { p: number; s: number } | null {
  const m = (t ?? "").toLowerCase().match(/^decimal\((\d+)\s*,\s*(\d+)\)$/);
  if (!m) return null;
  return { p: Number(m[1]), s: Number(m[2]) };
}

/**
 * Classify a single type-change as safe-widen / narrowing / cross-family.
 * Returns `null` when the types are semantically identical after
 * normalisation (e.g., "int" → "integer") — no op needed.
 */
export function classifyTypeChange(
  columnName: string,
  fromType: string,
  toType: string,
): SchemaOp | null {
  const from = (fromType ?? "").toLowerCase().trim();
  const to = (toType ?? "").toLowerCase().trim();
  if (from === to) return null;

  const fFam = family(from);
  const tFam = family(to);
  if (fFam !== tFam) {
    return {
      op: "cross_family_type_change",
      name: columnName,
      from,
      to,
    };
  }
  if (fFam === "int") {
    const fr = intRank(from);
    const tr = intRank(to);
    if (tr === fr) return null; // same-width alias (int/integer/int32 → int32)
    if (tr < fr) {
      return {
        op: "narrowing",
        name: columnName,
        from,
        to,
        reason: `int${fr} → int${tr}`,
      };
    }
    return { op: "update_column_type", name: columnName, from, to };
  }
  if (fFam === "float") {
    const fr = floatRank(from);
    const tr = floatRank(to);
    if (tr === fr) return null;
    if (tr < fr) {
      return {
        op: "narrowing",
        name: columnName,
        from,
        to,
        reason: `float${fr} → float${tr}`,
      };
    }
    return { op: "update_column_type", name: columnName, from, to };
  }
  if (fFam === "decimal") {
    const a = parseDecimal(from);
    const b = parseDecimal(to);
    if (!a || !b) {
      return {
        op: "cross_family_type_change",
        name: columnName,
        from,
        to,
      };
    }
    if (b.p < a.p || b.s < a.s) {
      return {
        op: "narrowing",
        name: columnName,
        from,
        to,
        reason: `decimal(${a.p},${a.s}) → decimal(${b.p},${b.s})`,
      };
    }
    return { op: "update_column_type", name: columnName, from, to };
  }
  // string / boolean / date / timestamp — any change is cross-family-ish.
  return {
    op: "cross_family_type_change",
    name: columnName,
    from,
    to,
  };
}

export function diffOutputSchema(
  prior: SchemaColumn[] | null | undefined,
  current: SchemaColumn[],
): Omit<SchemaDiffResult, "priorFingerprint" | "newFingerprint" | "changed"> {
  const priorList = prior ?? [];
  const currList = current ?? [];
  const priorByName = new Map(priorList.map((c) => [c.name, c]));
  const currByName = new Map(currList.map((c) => [c.name, c]));
  const ops: SchemaOp[] = [];

  // ADD — present in current, absent in prior.
  for (const c of currList) {
    if (!priorByName.has(c.name)) {
      ops.push({
        op: "add_column",
        name: c.name,
        type: String(c.type ?? "string"),
        required: c.required ?? false,
      });
    }
  }

  // DROP — present in prior, absent in current. But if there's an
  // add whose type matches a dropped column AND a rename hint is
  // provided via metadata, we'd treat it as a rename — the spec's
  // classifier takes the declarative path, so unless renames are
  // explicit we treat them as drop+add. The spec's "rename via
  // column-id remap" is authoritative when the caller passes
  // `rename_map` alongside the schema; today we treat every delete
  // as a logical drop (Iceberg V2 retains the column-id so that's
  // non-destructive anyway).
  for (const c of priorList) {
    if (!currByName.has(c.name)) {
      if (c.primaryKey) {
        ops.push({
          op: "primary_key_change",
          name: c.name,
          reason: "cannot drop a primary-key column",
        });
      } else {
        ops.push({ op: "delete_column", name: c.name });
      }
    }
  }

  // Changed-in-place: name present in both → compare type + required.
  for (const c of currList) {
    const prev = priorByName.get(c.name);
    if (!prev) continue;
    // Type change.
    const typeChange = classifyTypeChange(c.name, String(prev.type ?? ""), String(c.type ?? ""));
    if (typeChange) ops.push(typeChange);
    // Nullable-tightening: prev optional → current required.
    if ((c.required ?? false) === true && (prev.required ?? false) === false) {
      ops.push({
        op: "nullable_tighten",
        name: c.name,
        reason: "required flag flipped on a column with existing data",
      });
    }
    // Primary-key column re-typed → reject flatly.
    if ((prev.primaryKey ?? false) || (c.primaryKey ?? false)) {
      if (typeChange) {
        ops.push({
          op: "primary_key_change",
          name: c.name,
          reason: "cannot re-type a primary-key column",
        });
      }
    }
  }

  const blockingIssues = ops.filter((o) =>
    o.op === "narrowing" ||
    o.op === "nullable_tighten" ||
    o.op === "primary_key_change" ||
    o.op === "cross_family_type_change",
  );
  const safeOperations = ops.filter(
    (o) =>
      o.op === "add_column" ||
      o.op === "rename_column" ||
      o.op === "update_column_type" ||
      o.op === "delete_column",
  );
  return {
    operations: ops,
    safeOperations,
    blockingIssues,
    willBeSafe: blockingIssues.length === 0,
  };
}

/**
 * Full-envelope classifier — computes fingerprints and delegates to
 * `diffOutputSchema`. Returns `changed=false` when the fingerprint is
 * identical, in which case the caller skips the whole migration path.
 */
export function classifyEvolution(
  prior: SchemaColumn[] | null | undefined,
  current: SchemaColumn[],
  priorFingerprint: string | null,
): SchemaDiffResult {
  const newFingerprint = fingerprintOutputSchema(current);
  const priorFp = priorFingerprint ?? null;
  const changed = priorFp !== null && priorFp !== newFingerprint;
  if (!changed) {
    return {
      operations: [],
      safeOperations: [],
      blockingIssues: [],
      willBeSafe: true,
      priorFingerprint: priorFp,
      newFingerprint,
      changed: false,
    };
  }
  const inner = diffOutputSchema(prior, current);
  return { ...inner, priorFingerprint: priorFp, newFingerprint, changed: true };
}
