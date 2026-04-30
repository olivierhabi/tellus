// ---------------------------------------------------------------------------
// Partition-spec validator — PB-B4.
//
// `pipelines.iceberg_partition_spec JSONB` stores user-authored partition
// definitions like:
//
//   [
//     { "column": "event_date", "transform": "day" },
//     { "column": "tenant_id", "transform": "bucket", "n": 16 }
//   ]
//
// We validate the spec against the output schema at deploy time so the
// error lands with a typed 400 rather than a Python traceback from the
// sidecar. The PyIceberg sidecar accepts this exact shape — keep the
// two in sync when adding transforms.
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";

export type SupportedTransform =
  | "identity"
  | "year"
  | "month"
  | "day"
  | "hour"
  | "bucket"
  | "truncate";

export interface PartitionField {
  column: string;
  transform?: SupportedTransform;
  /** Required for bucket / truncate. */
  n?: number;
  /** Optional partition-column name override. */
  name?: string;
}

const SUPPORTED: Set<SupportedTransform> = new Set([
  "identity",
  "year",
  "month",
  "day",
  "hour",
  "bucket",
  "truncate",
]);

export interface OutputColumn {
  name: string;
  type: string;
}

/**
 * Validate a raw partition spec (straight out of the JSONB column).
 * Throws AppError(400, 'ICEBERG_PARTITION_SPEC_INVALID') on any
 * violation, with a `details.reasons` array pointing at the offending
 * entries.
 */
export function validatePartitionSpec(
  raw: unknown,
  columns: OutputColumn[],
): PartitionField[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw invalid(["partition_spec must be an array of partition-field objects"]);
  }
  const byName = new Map(columns.map((c) => [c.name, c]));
  const reasons: string[] = [];
  const out: PartitionField[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") {
      reasons.push(`entry[${i}] must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const column = typeof e.column === "string" ? e.column : "";
    const transform = ((e.transform as string) ?? "identity").toLowerCase() as SupportedTransform;
    const n = typeof e.n === "number" ? e.n : undefined;
    if (!column) {
      reasons.push(`entry[${i}].column is required`);
      continue;
    }
    if (!byName.has(column)) {
      reasons.push(
        `entry[${i}].column='${column}' is not present on the output schema`,
      );
      continue;
    }
    if (!SUPPORTED.has(transform)) {
      reasons.push(
        `entry[${i}].transform='${transform}' not supported (allowed: ${Array.from(SUPPORTED).join(", ")})`,
      );
      continue;
    }
    const colType = (byName.get(column)?.type ?? "").toLowerCase();
    // Transform/type compatibility: year/month/day/hour require a
    // date/timestamp source; bucket/truncate require an integral/string
    // column; identity accepts anything.
    if (["year", "month", "day", "hour"].includes(transform)) {
      if (!["date", "timestamp"].includes(colType)) {
        reasons.push(
          `entry[${i}] transform='${transform}' requires a date/timestamp column; got '${colType}'`,
        );
        continue;
      }
    }
    if (transform === "bucket" || transform === "truncate") {
      if (n === undefined || n <= 0 || !Number.isFinite(n)) {
        reasons.push(
          `entry[${i}] transform='${transform}' requires a positive integer 'n'`,
        );
        continue;
      }
    }
    out.push({
      column,
      transform,
      n,
      name: typeof e.name === "string" ? e.name : undefined,
    });
  }
  if (reasons.length > 0) throw invalid(reasons);
  // Duplicate-partition-name detection: Iceberg refuses two partition
  // fields with identical names.
  const seenName = new Set<string>();
  for (const [i, f] of out.entries()) {
    const pname =
      f.name ?? `${f.column}_${f.transform ?? "identity"}`;
    if (seenName.has(pname)) {
      reasons.push(`entry[${i}] duplicates partition name '${pname}'`);
    }
    seenName.add(pname);
  }
  if (reasons.length > 0) throw invalid(reasons);
  return out;
}

function invalid(reasons: string[]): AppError {
  const msg = `Invalid Iceberg partition spec: ${reasons.join("; ")}`;
  const err = new AppError(msg, 400, "ICEBERG_PARTITION_SPEC_INVALID");
  (err as unknown as { details?: unknown }).details = { reasons };
  return err;
}
