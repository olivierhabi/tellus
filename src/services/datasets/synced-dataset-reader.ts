// ---------------------------------------------------------------------------
// B5 — Synced-dataset reader (Dataset Preview).
//
// Reads a bounded preview (first N rows + inferred column schema) from the
// Iceberg table a table-import writes to. This is the read-side counterpart to
// the foundry-worker snapshot/append strategies, which write Parquet (or, when
// no Parquet binding is installed, a JSONL fallback) under
//   <iceberg-root>/<warehouse>/<namespace>/<table>/data/part-*.{parquet,jsonl}
// and commit an Iceberg snapshot whose `dataFiles` list the produced files.
//
// Design notes / system model (Palantir "Dataset Preview" — overview at
// https://www.palantir.com/docs/foundry/dataset-preview/overview/):
//   - Preview reads the CURRENT snapshot only (the committed view), never
//     uncommitted writer output. This mirrors Foundry, where a dataset preview
//     shows the latest committed transaction.
//   - It is BOUNDED: we read at most `limit` rows and stop, so a multi-GB
//     dataset previews in milliseconds without scanning every file.
//   - It is SCHEMA-ON-READ for the cell types: the writer records an empty
//     Iceberg field list (types are not yet projected), so columns and their
//     display types are inferred from the sampled rows — exactly what Foundry's
//     preview does for freshly-synced raw datasets.
//   - Path containment: data-file paths come from our own metadata.json, but we
//     still assert each resolved file lives under the configured Iceberg root
//     before reading it (defence-in-depth against a poisoned namespace/table).
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  loadCatalogAdapter,
  type CatalogIdentity,
  type IcebergSnapshot,
} from "../../lib/iceberg";

/** Display type vocabulary understood by the Dataset Preview grid (FE). */
export type PreviewColumnType =
  | "integer"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamp"
  | "text";

export interface PreviewColumn {
  name: string;
  type: PreviewColumnType;
}

export interface SnapshotSummary {
  /** Iceberg snapshot id of the current (previewed) snapshot. */
  id: string;
  /** Commit time (ms epoch → ISO). */
  committedAt: string;
  operation: IcebergSnapshot["operation"];
  /** Number of data files in this snapshot. */
  files: number;
  /** Total on-disk size of this snapshot's data files, in bytes. */
  sizeBytes: number;
  /** Records added by this snapshot (per the Iceberg summary). */
  addedRecords: number;
  /** Tellus build rid that produced the snapshot, when recorded. */
  buildRid: string | null;
}

export interface SyncedPreview {
  columns: PreviewColumn[];
  rows: Record<string, unknown>[];
  snapshot: SnapshotSummary | null;
}

/** The table-import config fields the reader needs to locate the table. */
export interface ImportConfigForRead {
  schema: string;
  table: string;
  targetTable?: string;
  warehouseRoot?: string;
}

/** Root the local-fs Iceberg adapter writes under (kept in sync with it). */
export function icebergRoot(): string {
  return process.env.TELLUS_ICEBERG_ROOT ?? join(process.cwd(), "var", "iceberg");
}

/**
 * Reconstruct the Iceberg table coordinates a build wrote to. Mirrors the
 * foundry-worker strategies: warehouse defaults to the connection tenant,
 * namespace is the source schema, table name is `targetTable ?? table`.
 */
export function syncTableIdentity(
  config: ImportConfigForRead,
  tenant: string,
): CatalogIdentity {
  return {
    warehouseRoot: config.warehouseRoot ?? tenant ?? "default",
    namespace: config.schema,
    table: config.targetTable ?? config.table,
  };
}

/** True when `child` is the same as, or nested under, `parent`. */
function isContained(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * Resolve a data-file path recorded in snapshot metadata to a file that
 * actually exists on disk, accounting for the Parquet→JSONL writer fallback
 * (metadata records `.parquet`, but without a Parquet binding the bytes land
 * in a sibling `.jsonl`). Returns null when neither variant exists or the
 * path escapes the Iceberg root.
 */
async function resolveDataFile(recordedPath: string): Promise<string | null> {
  const root = icebergRoot();
  const candidates = [recordedPath, recordedPath.replace(/\.parquet$/i, ".jsonl")];
  for (const candidate of candidates) {
    if (!isContained(root, candidate)) continue;
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Read up to `remaining` JSON rows from a JSONL file. */
async function readJsonlRows(
  path: string,
  remaining: number,
): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(path, "utf8");
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (out.length >= remaining) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* skip malformed line — preview is best-effort */
    }
  }
  return out;
}

/** Read up to `remaining` rows from a Parquet file, if a binding is present. */
async function readParquetRows(
  path: string,
  remaining: number,
): Promise<Record<string, unknown>[]> {
  // Parquet binding is optional (same one the writer probes). When absent the
  // data lives in the JSONL sibling, so this path is simply not reached.
  const parquet: any = await import("parquetjs-lite");
  const reader = await parquet.ParquetReader.openFile(path);
  const cursor = reader.getCursor();
  const out: Record<string, unknown>[] = [];
  let rec: Record<string, unknown> | null;
  while (out.length < remaining && (rec = await cursor.next())) {
    if (Object.keys(rec).length === 0) break;
    out.push(rec);
  }
  await reader.close();
  return out;
}

/** Read up to `remaining` rows from a single resolved data file. */
async function readDataFile(
  path: string,
  remaining: number,
): Promise<Record<string, unknown>[]> {
  if (/\.parquet$/i.test(path)) {
    try {
      return await readParquetRows(path, remaining);
    } catch {
      // Fall through: a sibling JSONL may hold the bytes (writer fallback).
      const jsonl = path.replace(/\.parquet$/i, ".jsonl");
      try {
        return await readJsonlRows(jsonl, remaining);
      } catch {
        return [];
      }
    }
  }
  return readJsonlRows(path, remaining);
}

// --- full-snapshot streaming -------------------------------------------------

/** Yield every row of a Parquet file via its streaming cursor. */
async function* iterParquetFile(
  path: string,
): AsyncGenerator<Record<string, unknown>> {
  const parquet: any = await import("parquetjs-lite");
  const reader = await parquet.ParquetReader.openFile(path);
  try {
    const cursor = reader.getCursor();
    let rec: Record<string, unknown> | null;
    while ((rec = await cursor.next())) {
      if (Object.keys(rec).length === 0) break;
      yield rec;
    }
  } finally {
    await reader.close();
  }
}

/** Yield every JSON row of a JSONL file, skipping malformed lines. */
async function* iterJsonlFile(
  path: string,
): AsyncGenerator<Record<string, unknown>> {
  const raw = await fs.readFile(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* skip malformed line — best-effort */
    }
  }
}

/**
 * Stream EVERY row of a synced dataset's current Iceberg snapshot — the
 * unbounded counterpart to `readSyncedPreview`. Rows are yielded one at a
 * time (per data file) so the Funnel changelog stage never materialises the
 * full table in memory. A recorded `.parquet` file whose bytes landed in a
 * JSONL sibling (writer fallback) is transparently substituted, mirroring
 * `resolveDataFile`. Yields nothing when the table has never been built.
 */
export async function* iterSyncedSnapshotRows(
  config: ImportConfigForRead,
  tenant: string,
): AsyncGenerator<Record<string, unknown>> {
  const adapter = await loadCatalogAdapter();
  const id = syncTableIdentity(config, tenant);
  const meta = await adapter.resolve(id);
  if (!meta || meta.currentSnapshotId == null) return;
  const snap = meta.snapshots.find((s) => s.snapshotId === meta.currentSnapshotId);
  if (!snap) return;

  for (const recorded of snap.dataFiles ?? []) {
    const file = await resolveDataFile(recorded);
    if (!file) continue;
    if (/\.parquet$/i.test(file)) {
      try {
        // Open first so a missing/corrupt parquet falls back to the JSONL
        // sibling BEFORE any rows are yielded (no duplicate-row risk).
        yield* iterParquetFile(file);
        continue;
      } catch (err) {
        const jsonl = file.replace(/\.parquet$/i, ".jsonl");
        const st = await fs.stat(jsonl).then(() => true, () => false);
        if (!st) throw err; // no fallback — surface the real read error
        yield* iterJsonlFile(jsonl);
        continue;
      }
    }
    yield* iterJsonlFile(file);
  }
}

// --- column inference --------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export function classifyValue(v: unknown): PreviewColumnType | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "numeric";
  if (v instanceof Date) return "timestamp";
  if (typeof v === "string") {
    if (ISO_TIMESTAMP.test(v)) return "timestamp";
    if (ISO_DATE.test(v)) return "date";
    if (v === "true" || v === "false") return "boolean";
    if (v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number.isInteger(Number(v)) ? "integer" : "numeric";
    }
    return "text";
  }
  return "text";
}

/**
 * Infer one display type per column from the sampled rows (majority of the
 * non-null observations; ties and the empty column fall back to `text`).
 * Column order follows first appearance across the sample so the grid matches
 * the source table's column order.
 */
function inferColumns(rows: Record<string, unknown>[]): PreviewColumn[] {
  const order: string[] = [];
  const counts = new Map<string, Map<PreviewColumnType, number>>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!counts.has(key)) {
        counts.set(key, new Map());
        order.push(key);
      }
      const t = classifyValue(row[key]);
      if (!t) continue;
      const m = counts.get(key)!;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
  }
  return order.map((name) => {
    const m = counts.get(name)!;
    let best: PreviewColumnType = "text";
    let bestN = 0;
    for (const [t, n] of m) {
      if (n > bestN) {
        best = t;
        bestN = n;
      }
    }
    // integer is a refinement of numeric; if any non-integer numeric appears,
    // widen integer→numeric so the column type doesn't misrepresent decimals.
    if (best === "integer" && (m.get("numeric") ?? 0) > 0) best = "numeric";
    return { name, type: best };
  });
}

function summarizeSnapshot(snap: IcebergSnapshot): SnapshotSummary {
  const num = (k: string) => {
    const n = Number(snap.summary?.[k]);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id: String(snap.snapshotId),
    committedAt: new Date(snap.timestampMs).toISOString(),
    operation: snap.operation,
    files: snap.dataFiles?.length ?? 0,
    sizeBytes: num("added-files-size"),
    addedRecords: num("added-records"),
    buildRid: snap.tellusBuildRid ?? null,
  };
}

/**
 * Read a bounded preview of the dataset a table-import has materialised.
 * Returns an empty (but well-formed) preview when the table has never been
 * built — the caller surfaces that as the "not built yet" state.
 */
export async function readSyncedPreview(
  config: ImportConfigForRead,
  tenant: string,
  limit: number,
): Promise<SyncedPreview> {
  const adapter = await loadCatalogAdapter();
  const id = syncTableIdentity(config, tenant);
  const meta = await adapter.resolve(id);
  if (!meta || meta.currentSnapshotId == null) {
    return { columns: [], rows: [], snapshot: null };
  }
  const snap = meta.snapshots.find((s) => s.snapshotId === meta.currentSnapshotId);
  if (!snap) {
    return { columns: [], rows: [], snapshot: null };
  }

  const rows: Record<string, unknown>[] = [];
  for (const recorded of snap.dataFiles ?? []) {
    if (rows.length >= limit) break;
    const file = await resolveDataFile(recorded);
    if (!file) continue;
    const batch = await readDataFile(file, limit - rows.length);
    rows.push(...batch);
  }

  return {
    columns: inferColumns(rows),
    rows,
    snapshot: summarizeSnapshot(snap),
  };
}
