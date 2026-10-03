// ---------------------------------------------------------------------------
// OpenSearch bulk-response triage (pure — no I/O, safe to unit test).
//
// A single rejected document must never wedge a whole object type: the
// projector acknowledges every accepted document and retries only the
// rejected ones. A delete against a doc that was never indexed is
// idempotent success (404 not_found) — the end state (absent doc) is
// achieved.
// ---------------------------------------------------------------------------

export interface BulkItemResult {
  status?: number;
  _id?: string;
  result?: string;
  error?: { type?: string; reason?: string };
}

export interface BulkFailure {
  id: string;
  status: number;
  reason: string;
}

export function collectBulkFailures(
  items: Array<Record<string, BulkItemResult>> | undefined | null,
): BulkFailure[] {
  const failures: BulkFailure[] = [];
  for (const item of items ?? []) {
    const op = Object.keys(item)[0];
    const r = item[op] ?? {};
    const status = r.status ?? 0;
    if (status >= 400 && !(op === "delete" && status === 404)) {
      failures.push({
        id: String(r._id ?? ""),
        status,
        reason: r.error?.reason ?? r.result ?? `status ${status}`,
      });
    }
  }
  return failures;
}

/** One-line, log-safe summary (giant ids are truncated, never dumped whole). */
export function formatBulkFailures(failures: BulkFailure[], max = 3): string {
  return failures
    .slice(0, max)
    .map((f) => {
      const id = f.id.length > 60 ? `${f.id.slice(0, 57)}…(${f.id.length})` : f.id || "<no-id>";
      return `${id}: ${f.reason}`;
    })
    .join("; ");
}
