// ---------------------------------------------------------------------------
// T-05 Phase B — export pipeline tunables.
//
// All values are operator-overridable via env so a runbook can dial them
// per-deployment without a code change. Constants here MUST be the single
// source of truth — no per-call-site override paths.
// ---------------------------------------------------------------------------

import { appError } from "../../utils/appError";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

/**
 * Page size used by the export worker when streaming rows from the
 * Quickwit/OpenSearch source. Matches T-09's `MAX_PAGE_SIZE` so the
 * worker does not exceed the read-side cap.
 */
export const EXPORT_PAGE_SIZE = envInt("EXPORT_PAGE_SIZE", 1000, 100, 10_000);

/**
 * Hard ceiling on row count per export job. Exceeding triggers
 * `EXPORT_LIMIT_EXCEEDED` and a `FAILED` status. The default aligns
 * with the Foundry Action edit cap (1M rows) so a single job cannot
 * exhaust the storage backing's per-object size limits.
 */
export const MAX_EXPORT_ROWS = envInt(
  "MAX_EXPORT_ROWS",
  1_000_000,
  1_000,
  100_000_000,
);

/** Signed URL TTL — 24h. Spec §T-05 5B.3. */
export const EXPORT_DOWNLOAD_TTL_MS = envInt(
  "EXPORT_DOWNLOAD_TTL_MS",
  24 * 60 * 60 * 1000,
  60_000,
  7 * 24 * 60 * 60 * 1000,
);

/** Workflow runtime ceiling — 1h. Spec §T-05 5B.3. */
export const EXPORT_WORKFLOW_TIMEOUT_MS = envInt(
  "EXPORT_WORKFLOW_TIMEOUT_MS",
  60 * 60 * 1000,
  60_000,
  24 * 60 * 60 * 1000,
);

/** Total Temporal attempts (initial + retries). Spec §T-05 5B.3. */
export const EXPORT_WORKFLOW_RETRIES = envInt(
  "EXPORT_WORKFLOW_RETRIES",
  3,
  1,
  10,
);

/** Initial backoff between retries (exponential 1s → 4s → 16s). */
export const EXPORT_WORKFLOW_INITIAL_BACKOFF_MS = envInt(
  "EXPORT_WORKFLOW_INITIAL_BACKOFF_MS",
  1_000,
  100,
  60_000,
);

/**
 * Build the canonical S3-style storage key for an export job. The job
 * id is sufficient for uniqueness; the format extension is the
 * caller-visible suffix.
 */
export function buildExportObjectKey(jobId: string, format: string): string {
  return `exports/${jobId}.${format}`;
}

/**
 * Validate the export format. Reused by both the route (POST validation)
 * and the worker (defence-in-depth: the snapshot is trusted but a
 * future schema change should not produce a worker that silently writes
 * an unsupported format).
 */
export function assertSupportedFormat(format: string): asserts format is "csv" | "xlsx" | "jsonl" {
  if (format !== "csv" && format !== "xlsx" && format !== "jsonl") {
    throw appError(
      "VALIDATION_ERROR",
      `Unsupported export format: ${format}.`,
      { format },
    );
  }
}
