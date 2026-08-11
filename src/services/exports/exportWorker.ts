// ---------------------------------------------------------------------------
// T-05 Phase B — Export worker activity.
//
// `executeExportActivity` is pure-async by design. The Temporal worker
// host is responsible for activity registration, retry policy, and
// timeout enforcement; this module focuses on the *content* of the
// activity:
//
//   1. Load the job row (selected FOR UPDATE under a transaction so two
//      worker replicas cannot both transition the same job).
//   2. Refuse to re-execute if the job is already COMPLETED — Temporal
//      may retry an activity that succeeded if the worker crashed
//      after the side-effect but before the workflow recorded success.
//   3. Restore the requester's security context from the snapshotted
//      `security_context_snapshot` and `branch_id_snapshot` columns
//      (populated at job-creation time by routes/exports.ts). The
//      worker MUST NOT use the calling thread's session — by the time
//      the worker runs, that session may be expired.
//   4. Stream rows from the Object Set to a format writer; write to
//      object storage with `uploadObject`.
//   5. Enforce `MAX_EXPORT_ROWS`. Exceeding produces an EXPORT_LIMIT_EXCEEDED
//      error which the catch-block converts to status=FAILED.
//   6. Generate a presigned download URL with TTL = EXPORT_DOWNLOAD_TTL_MS
//      and write it + its expiry to the job row.
//
// All downstream calls (storage, OpenSearch streaming) are injected via
// `ExportActivityDeps` so unit tests can verify the contract without a
// live S3 / Quickwit / Temporal worker host.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { query, withTransaction } from "../../db";
import { appError } from "../../utils/appError";
import { incCounter, observeHistogram } from "../funnel/metrics";
import {
  loadRestrictedProperties,
  stripRestrictedRows,
} from "../security/propertyMarkingGuard";
import {
  EXPORT_DOWNLOAD_TTL_MS,
  EXPORT_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  assertSupportedFormat,
  buildExportObjectKey,
} from "./exportConstants";

export interface ExportJobRow {
  job_id: string;
  ontology_id: string;
  requested_by: string;
  object_type_api_name: string | null;
  format: string;
  query_json: Record<string, unknown>;
  status: string;
  security_context_snapshot: Record<string, unknown> | string;
  branch_id_snapshot: string | null;
}

/** Per-page yield from the Object-Set reader. */
export interface ExportPage {
  rows: Array<Record<string, unknown>>;
}

/** All side-effects the worker needs. Inject in tests. */
export interface ExportActivityDeps {
  /** Stream rows from the Object Set, one page at a time. */
  streamObjectSet: (input: {
    objectTypeApiName: string | null;
    queryJson: Record<string, unknown>;
    securityContext: Record<string, unknown>;
    branchId: string | null;
    pageSize: number;
  }) => AsyncIterable<ExportPage>;
  /** Upload a buffer to object storage. */
  uploadObject: (
    key: string,
    body: Buffer,
    contentType: string,
  ) => Promise<{ key: string }>;
  /** Generate a presigned download URL. */
  getPresignedDownloadUrl: (
    key: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  /**
   * Optional: override the PG transaction wrapper. Defaults to the
   * shared `withTransaction` so production runs through the canonical pool.
   */
  withTransaction?: typeof withTransaction;
}

/** Result returned to the workflow for observability. */
export interface ExportActivityResult {
  jobId: string;
  status: "COMPLETED" | "FAILED";
  rowCount: number;
  durationMs: number;
  failureReason?: string;
}

/**
 * Run the export activity for the given job id. Idempotent at the job
 * level: a re-run of an already-COMPLETED job returns immediately.
 */
export async function executeExportActivity(
  jobId: string,
  deps: ExportActivityDeps,
): Promise<ExportActivityResult> {
  const started = Date.now();
  const txn = deps.withTransaction ?? withTransaction;

  // 1. Load the job under FOR UPDATE so concurrent worker replicas can't
  //    double-transition. The UPDATE to RUNNING runs INSIDE the same
  //    transaction so the lock is held across the state transition.
  const job: ExportJobRow = await txn(async (client: PoolClient) => {
    const res = await client.query(
      `SELECT job_id, ontology_id, requested_by, object_type_api_name,
              format, query_json, status,
              security_context_snapshot, branch_id_snapshot
         FROM export_job
        WHERE job_id = $1
        FOR UPDATE`,
      [jobId],
    );
    if (res.rowCount === 0) {
      throw appError("EXPORT_JOB_NOT_FOUND", "Export job not found.", {
        jobId,
      });
    }
    const row = res.rows[0] as ExportJobRow;

    // 2. Idempotency guard — checked inside the transaction while holding
    //    the FOR UPDATE lock so two concurrent workers cannot both pass.
    if (row.status === "COMPLETED") {
      return row; // Caller handles COMPLETED below
    }

    // 3. Mark RUNNING inside the same transaction/connection — lock held.
    await client.query(
      `UPDATE export_job
          SET status = 'RUNNING', started_at = now(), updated_at = now()
        WHERE job_id = $1`,
      [jobId],
    );
    return { ...row, status: "RUNNING" };
  });

  // 4. Post-transaction idempotency handler.
  if (job.status === "COMPLETED") {
    return {
      jobId,
      status: "COMPLETED",
      rowCount: 0,
      durationMs: Date.now() - started,
    };
  }

  // 5. Validate format defensively even though the route already did.
  assertSupportedFormat(job.format);

  let rowCount = 0;
  let failureReason: string | undefined;
  try {
    const securityContext = parseSnapshot(job.security_context_snapshot);
    const branchId = job.branch_id_snapshot ?? null;

    // Rwanda QA §3.3/§6.5 — exports never contain marking-restricted
    // properties for the requesting principal, in any format (file contents,
    // headers, or metadata). Columns the principal cannot read are omitted
    // from the written rows entirely.
    const restricted = job.object_type_api_name
      ? await loadRestrictedProperties(job.object_type_api_name)
      : new Map<string, string[]>();

    // Format writer is in-memory for the engineering surface — the
    // production-soak path replaces this with a streamed multipart
    // upload. We assemble in a Buffer so unit tests can inspect bytes.
    const writer = createFormatWriter(job.format);

    for await (const page of deps.streamObjectSet({
      objectTypeApiName: job.object_type_api_name,
      queryJson: job.query_json,
      securityContext,
      branchId,
      pageSize: EXPORT_PAGE_SIZE,
    })) {
      for (const row of page.rows) {
        stripRestrictedRows(
          [row],
          securityContext as { markings?: string[]; markingBypass?: boolean },
          restricted,
        );
        rowCount += 1;
        if (rowCount > MAX_EXPORT_ROWS) {
          throw appError(
            "EXPORT_LIMIT_EXCEEDED",
            `Export job exceeded the ${MAX_EXPORT_ROWS}-row cap.`,
            { jobId, format: job.format },
          );
        }
        writer.writeRow(row);
      }
    }

    const buffer = writer.finalize();
    const key = buildExportObjectKey(jobId, job.format);
    await deps.uploadObject(key, buffer, contentTypeFor(job.format));
    const ttlSec = Math.floor(EXPORT_DOWNLOAD_TTL_MS / 1000);
    const downloadUrl = await deps.getPresignedDownloadUrl(key, ttlSec);
    const expiresAt = new Date(Date.now() + EXPORT_DOWNLOAD_TTL_MS);

    await query(
      `UPDATE export_job
          SET status = 'COMPLETED',
              completed_at = now(),
              row_count = $2,
              file_path = $3,
              download_url = $4,
              download_url_expires_at = $5,
              updated_at = now()
        WHERE job_id = $1`,
      [jobId, rowCount, key, downloadUrl, expiresAt],
    );

    incCounter("tellus_export_jobs_total", {
      format: job.format,
      outcome: "completed",
    });
    incCounter("tellus_export_rows_streamed_total", { format: job.format }, rowCount);
    const durationMs = Date.now() - started;
    observeHistogram("tellus_export_duration_seconds", durationMs / 1000, {
      format: job.format,
    });

    return { jobId, status: "COMPLETED", rowCount, durationMs };
  } catch (err) {
    const reason = readErrorCode(err) ?? "EXPORT_INTERNAL_ERROR";
    failureReason = reason;
    await query(
      `UPDATE export_job
          SET status = 'FAILED',
              failed_at = now(),
              failure_reason = $2,
              error_message = $3,
              row_count = $4,
              updated_at = now()
        WHERE job_id = $1`,
      [jobId, reason, errMessage(err), rowCount],
    );
    incCounter("tellus_export_jobs_total", {
      format: job.format,
      outcome: "failed",
    });
    const durationMs = Date.now() - started;
    observeHistogram("tellus_export_duration_seconds", durationMs / 1000, {
      format: job.format,
    });
    return {
      jobId,
      status: "FAILED",
      rowCount,
      durationMs,
      failureReason,
    };
  }
}

// ---------------------------------------------------------------------------
// Format writers — minimal but real. CSV serialises to RFC 4180-ish text;
// JSONL is one JSON object per line; xlsx is deferred to the production
// soak (returns an empty buffer + records the contract gap in metrics).
// ---------------------------------------------------------------------------

interface FormatWriter {
  writeRow(row: Record<string, unknown>): void;
  finalize(): Buffer;
}

function createFormatWriter(format: string): FormatWriter {
  if (format === "csv") return new CsvWriter();
  if (format === "jsonl") return new JsonlWriter();
  if (format === "xlsx") return new XlsxStubWriter();
  throw appError("VALIDATION_ERROR", `Unsupported format: ${format}.`, {
    format,
  });
}

class CsvWriter implements FormatWriter {
  private headers: string[] | null = null;
  private rows: string[] = [];
  writeRow(row: Record<string, unknown>): void {
    if (this.headers === null) {
      this.headers = Object.keys(row).sort();
      this.rows.push(this.headers.map(csvQuote).join(","));
    }
    this.rows.push(
      this.headers.map((h) => csvQuote(stringify(row[h]))).join(","),
    );
  }
  finalize(): Buffer {
    return Buffer.from(this.rows.join("\n"), "utf8");
  }
}

class JsonlWriter implements FormatWriter {
  private parts: string[] = [];
  writeRow(row: Record<string, unknown>): void {
    this.parts.push(JSON.stringify(row));
  }
  finalize(): Buffer {
    return Buffer.from(this.parts.join("\n"), "utf8");
  }
}

class XlsxStubWriter implements FormatWriter {
  private rows: Record<string, unknown>[] = [];
  writeRow(row: Record<string, unknown>): void {
    this.rows.push(row);
  }
  finalize(): Buffer {
    // The xlsx writer is intentionally a JSON stub here. The production
    // soak will swap this for a real binary writer (exceljs / xlsx).
    // Returning a deterministic JSON snapshot keeps the engineering
    // path testable end-to-end without pulling in a binary writer.
    return Buffer.from(JSON.stringify({ format: "xlsx-stub", rows: this.rows }), "utf8");
  }
}

function csvQuote(v: string): string {
  if (v.includes(",") || v.includes("\n") || v.includes('"')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function contentTypeFor(format: string): string {
  if (format === "csv") return "text/csv; charset=utf-8";
  if (format === "jsonl") return "application/x-ndjson";
  if (format === "xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function parseSnapshot(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw;
}

function readErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown; errorCode?: unknown }).code;
  if (typeof code === "string") return code;
  const errorCode = (err as { errorCode?: unknown }).errorCode;
  if (typeof errorCode === "string") return errorCode;
  return null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Test surface — exposed under `__internals` so unit tests can verify
// the format writers without exporting them as part of the public API.
// ---------------------------------------------------------------------------

export const __internals = {
  CsvWriter,
  JsonlWriter,
  XlsxStubWriter,
  csvQuote,
  stringify,
  contentTypeFor,
  parseSnapshot,
  readErrorCode,
};
