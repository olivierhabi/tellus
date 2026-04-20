// ---------------------------------------------------------------------------
// PyIceberg sidecar runner — PB-B4.
//
// Spawns `python3 scripts/iceberg_sidecar/pb_b4_sidecar.py`, writes one
// JSON payload to stdin, reads one JSON payload from stdout.
//
// Why a sidecar (not DuckDB):
//   * DuckDB's iceberg extension is read-only in the versions shipped
//     with this repo (the funnel's `duckdbIceberg.ts` only exercises
//     iceberg_scan / iceberg_snapshots — never writes).
//   * Lakekeeper speaks the Iceberg REST catalog protocol, which
//     PyIceberg implements natively; writing snapshots through the REST
//     catalog is the sanctioned path and what the spec calls for
//     ("Where DuckDB's Iceberg writer has gaps … fall back to the same
//     PyIceberg sidecar").
//   * A Python subprocess boundary isolates Iceberg OOMs and
//     arrow/pyiceberg native crashes from the Node.js API pod.
//
// OCC retry: `append` can race another deploy's commit and come back
// with a CommitFailedException / 409 from the catalog. We retry with
// exponential backoff up to 5 attempts.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import path from "path";
import { AppError } from "../../utils/foundryAppError";

const SIDECAR_PATH =
  process.env.PB_B4_SIDECAR_PATH ??
  path.resolve(
    __dirname,
    "../../../scripts/iceberg_sidecar/pb_b4_sidecar.py",
  );
const PYTHON_BIN = process.env.PB_B4_PYTHON ?? "python3";

export interface SidecarCommonConfig {
  warehouse?: string;
  namespace: string;
  table: string;
  lakekeeperUrl?: string;
  s3Endpoint?: string;
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
}

export interface CreateOrGetInput extends SidecarCommonConfig {
  columns: Array<{ name: string; type: string }>;
  partitionSpec?: Array<{ column: string; transform?: string; n?: number; name?: string }>;
}

export interface AppendInput extends SidecarCommonConfig {
  parquetFiles: string[];
}

export interface RollbackInput extends SidecarCommonConfig {
  targetSnapshotId: number | string;
}

export interface SnapshotsInput extends SidecarCommonConfig {}

export interface ScanAsOfInput extends SidecarCommonConfig {
  snapshotId?: number | string;
  limit?: number;
}

export interface ExpireInput extends SidecarCommonConfig {
  retainLast?: number;
  olderThanMs?: number;
}

// Iceberg snapshot ids are random int64s that routinely exceed
// Number.MAX_SAFE_INTEGER. Node side carries them as strings and only
// calls Number(...) when it's verified safe (timestamps, row counts).
export interface CreateOrGetResult {
  created: boolean;
  snapshotId: string | null;
  location: string;
}
export interface AppendResult {
  priorSnapshotId: string | null;
  snapshotId: string | null;
  location: string;
}
export interface RollbackResult {
  snapshotId: string | null;
}
export interface SnapshotRow {
  snapshot_id: string;
  parent_id: string | null;
  timestamp_ms: number;
  operation: string | null;
  summary: Record<string, string>;
}
export interface ScanAsOfResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
}

export async function icebergCreateOrGet(
  input: CreateOrGetInput,
): Promise<CreateOrGetResult> {
  return invoke("create_or_get", {
    ...commonEnv(input),
    columns: input.columns,
    partition_spec: input.partitionSpec ?? [],
  });
}

export interface AppendOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Append with OCC retry. Every attempt goes through the sidecar; a
 * CommitFailedException / catalog 409 raises, and we backoff + retry.
 * The final failure bubbles up as an AppError so the caller can present
 * it as a typed 409 rather than a 500.
 */
export async function icebergAppend(
  input: AppendInput,
  options: AppendOptions = {},
): Promise<AppendResult & { attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 5;
  const base = options.baseDelayMs ?? 200;
  let attempts = 0;
  let lastError: Error | null = null;
  const t0 = Date.now();
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const res = await invoke<AppendResult>("append", {
        ...commonEnv(input),
        parquet_files: input.parquetFiles,
      });
      // PB-B9 — iceberg_snapshot_commit_duration_seconds histogram. Labelled by
      // table so dashboard panels can split per-output commit latency.
      try {
        const { recordIcebergCommit } = await import("./metrics");
        recordIcebergCommit(
          `${input.namespace}.${input.table}`,
          (Date.now() - t0) / 1000,
        );
      } catch {
        /* metric emission is best-effort */
      }
      return { ...res, attempts };
    } catch (err) {
      lastError = err as Error;
      const msg = (lastError.message ?? "").toLowerCase();
      const retriable =
        msg.includes("commitfailed") ||
        msg.includes("conflict") ||
        msg.includes("409") ||
        msg.includes("concurrent") ||
        msg.includes("rejected");
      if (!retriable) throw toAppError(err);
      // Exponential backoff with a mild jitter.
      const delay = base * Math.pow(2, attempts - 1) + Math.floor(Math.random() * base);
      await sleep(delay);
    }
  }
  throw toAppError(lastError, "ICEBERG_OCC_EXHAUSTED");
}

export async function icebergRollback(
  input: RollbackInput,
): Promise<RollbackResult> {
  return invoke("rollback", {
    ...commonEnv(input),
    target_snapshot_id: input.targetSnapshotId,
  });
}

export async function icebergSnapshots(
  input: SnapshotsInput,
): Promise<{ snapshots: SnapshotRow[] }> {
  return invoke("snapshots", commonEnv(input));
}

export async function icebergScanAsOf(
  input: ScanAsOfInput,
): Promise<ScanAsOfResult> {
  return invoke("scan_as_of", {
    ...commonEnv(input),
    snapshot_id: input.snapshotId ?? null,
    limit: input.limit ?? 1000,
  });
}

export interface ScanDeltaInput extends SidecarCommonConfig {
  fromSnapshotId: string | null;
  toSnapshotId: string;
}

export interface ScanDeltaResult extends ScanAsOfResult {
  files: string[];
  /**
   * True when the snapshot range contains a non-append operation
   * (overwrite/delete) that the delta reader cannot honestly express
   * as "added rows only". The consumer should fall back to a full
   * scan_as_of of the target snapshot to recover consistency.
   */
  delta_requires_full_scan?: boolean;
  reason?: string;
}

/**
 * Manifest-level incremental read (PB-B4 follow-4.1). Returns rows
 * added between `fromSnapshotId` (exclusive, null = first snapshot) and
 * `toSnapshotId` (inclusive). Callers advance
 * `pipeline_changelog_watermark` after processing.
 */
export async function icebergScanDelta(
  input: ScanDeltaInput,
): Promise<ScanDeltaResult> {
  return invoke("scan_delta", {
    ...commonEnv(input),
    from_snapshot_id: input.fromSnapshotId,
    to_snapshot_id: input.toSnapshotId,
  });
}

export async function icebergExpire(
  input: ExpireInput,
): Promise<{ snapshot_count_after: number }> {
  return invoke("expire", {
    ...commonEnv(input),
    retain_last: input.retainLast ?? 100,
    older_than_ms: input.olderThanMs ?? 30 * 24 * 3600 * 1000,
  });
}

export async function icebergCompact(
  input: SnapshotsInput,
): Promise<{ snapshot_id: number | null }> {
  return invoke("compact", commonEnv(input));
}

export type IcebergSchemaOp =
  | { op: "add_column"; name: string; type: string }
  | { op: "rename_column"; from: string; to: string }
  | { op: "update_column_type"; name: string; from?: string; to: string }
  | { op: "delete_column"; name: string };

export interface UpdateSchemaInput extends SidecarCommonConfig {
  operations: IcebergSchemaOp[];
}

export interface UpdateSchemaResult {
  applied: number;
  schemaId: number;
  snapshotId: string | null;
}

/**
 * PB-B10 — apply a batch of safe schema operations through the
 * sidecar's `update_schema` transaction. Pre-classified by the Node
 * side via `schemaEvolution.classifyEvolution`.
 */
export async function icebergUpdateSchema(
  input: UpdateSchemaInput,
): Promise<UpdateSchemaResult> {
  return invoke("update_schema", {
    ...commonEnv(input),
    operations: input.operations,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function commonEnv(input: SidecarCommonConfig): Record<string, unknown> {
  return {
    // PB-B4 pipeline outputs default to the `tellus-pipeline` warehouse
    // (parallel to the Funnel's `tellus-funnel`). Explicit
    // LAKEKEEPER_PIPELINE_WAREHOUSE wins; LAKEKEEPER_WAREHOUSE is kept
    // for callers that share the Funnel warehouse in prod.
    warehouse:
      input.warehouse ??
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ??
      process.env.LAKEKEEPER_WAREHOUSE ??
      "tellus-pipeline",
    namespace: input.namespace,
    table: input.table,
    lakekeeper_url: input.lakekeeperUrl ?? process.env.LAKEKEEPER_URL ?? "http://localhost:8181",
    s3_endpoint:
      input.s3Endpoint ??
      process.env.ICEBERG_S3_ENDPOINT ??
      process.env.S3_ENDPOINT ??
      "http://localhost:9000",
    s3_region: input.s3Region ?? process.env.S3_REGION ?? "us-east-1",
    s3_access_key_id: input.s3AccessKeyId ?? process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    s3_secret_access_key:
      input.s3SecretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
  };
}

interface SidecarResponse {
  ok: boolean;
  error?: string;
  error_type?: string;
  traceback?: string;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke<T extends object = any>(
  action: string,
  payload: Record<string, unknown>,
): Promise<T> {
  // In dev the Node server talks to docker-internal `minio:9000` /
  // `lakekeeper:8181` hostnames; without /etc/hosts entries the sidecar
  // can't resolve them. When NODE_ENV != 'production' and the caller
  // hasn't already set the toggle, we default it on so `npm run dev`
  // works out of the box. Production inherits whatever the pod's
  // systemd / compose env sets (typically unset → native pyarrow path).
  const devDnsOverride =
    process.env.PB_B4_LOCAL_DNS_OVERRIDE ??
    (process.env.NODE_ENV !== "production" ? "1" : undefined);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SIDECAR_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...(devDnsOverride !== undefined ? { PB_B4_LOCAL_DNS_OVERRIDE: devDnsOverride } : {}),
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b) => stdoutChunks.push(b));
    child.stderr.on("data", (b) => stderrChunks.push(b));
    child.on("error", (err) => {
      reject(
        new AppError(
          `pyiceberg sidecar could not be spawned: ${err.message}`,
          503,
          "ICEBERG_SIDECAR_UNREACHABLE",
        ),
      );
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (!stdout) {
        return reject(
          new AppError(
            `pyiceberg sidecar produced no stdout (exit ${code}). stderr: ${stderr.slice(0, 2000)}`,
            502,
            "ICEBERG_SIDECAR_EMPTY",
          ),
        );
      }
      let parsed: SidecarResponse;
      try {
        parsed = JSON.parse(stdout) as SidecarResponse;
      } catch (err) {
        return reject(
          new AppError(
            `pyiceberg sidecar returned invalid JSON: ${(err as Error).message}. Raw: ${stdout.slice(0, 2000)}`,
            502,
            "ICEBERG_SIDECAR_BAD_JSON",
          ),
        );
      }
      if (!parsed.ok) {
        // Forward the Python-side error type into the Node error so the
        // retry logic in icebergAppend can match on "commitfailed" etc.
        const err = new Error(parsed.error ?? "sidecar reported failure");
        (err as Error & { errorType?: string; traceback?: string }).errorType =
          parsed.error_type;
        (err as Error & { traceback?: string }).traceback = parsed.traceback;
        return reject(err);
      }
      // Python returned {"ok": true, ...}. Camel-case top-level keys so
      // the Node-side interfaces (e.g. `snapshotId`, `priorSnapshotId`,
      // `rowCount`) line up with the snake-case fields the Python
      // sidecar emits. Nested arrays/objects are passed through as-is
      // — snapshot rows and scan_delta `files` keep their Python shape.
      const { ok: _ok, ...rest } = parsed;
      const camel = camelTop(rest);
      resolve(camel as unknown as T);
    });
    child.stdin.write(JSON.stringify({ action, ...payload }));
    child.stdin.end();
  });
}

function camelTop(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const ck = k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    // Preserve both camel and snake-case top-level so existing call
    // sites that deref the snake form (e.g. `scan.row_count`,
    // `scan_delta.files`) keep working.
    out[ck] = v;
    if (ck !== k) out[k] = v;
  }
  return out;
}

function toAppError(err: unknown, fallbackCode = "ICEBERG_SIDECAR_ERROR"): Error {
  if (err instanceof AppError) return err;
  const e = err as Error & { errorType?: string };
  const code = e.errorType ? `ICEBERG_${e.errorType.toUpperCase()}` : fallbackCode;
  return new AppError(e.message ?? String(err), 500, code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Probe whether the pyiceberg sidecar can be invoked. Used by the deploy
 * path to surface a typed error instead of a crash when Python or
 * pyiceberg is missing on this host.
 */
export async function icebergSidecarAvailable(): Promise<boolean> {
  try {
    const { spawnSync } = await import("child_process");
    const res = spawnSync(PYTHON_BIN, ["-c", "import pyiceberg"], { timeout: 5000 });
    return res.status === 0;
  } catch {
    return false;
  }
}
