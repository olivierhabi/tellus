// ---------------------------------------------------------------------------
// Truthful indexing stage helpers — shared by the PG-loop dispatcher
// (funnelDispatcher.ts) and the Temporal activity proxy (temporal/activities.ts).
//
// INVARIANT (do not relax without a design review):
//   markEditsAppliedToIndex(editIds) may ONLY run after the serving index has
//   durably confirmed the batch — today that means Quickwit published a split
//   covering the last Kafka offset we produced (runIndexingActivity waits for
//   that and THROWS on timeout). It must never run merely because Quickwit
//   was unreachable, an activity failed, or a publish wait timed out.
//
//   Why this matters: the Redis write-back overlay sweeper and the read path
//   retire read-after-write protection the moment `applied_to_index_at` is
//   set. A premature stamp therefore silently loses user edits from public
//   queries. A pending edit is retried by the next funnel run because
//   getPendingIndexEdits selects `applied_to_index_at IS NULL`; the
//   repair-pass below re-reads `object_instances` (the committed merged
//   projection) so coverage is complete even when the crash happened
//   between the Merge commit and the Index stamp.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { incCounter, setGauge } from "./metrics";
import type { MergedRow } from "../quickwit/docBuilder";

export interface PendingIndexEdit {
  edit_id: string;
  primary_key: string;
  operation: string; // 'create' | 'update' | 'delete'
  executed_at: Date | string | null;
}

/**
 * Complete coverage batch for one indexing attempt.
 *
 * `baseRows` are the rows merged by THIS run (already versioned); `pending`
 * is the full `getPendingIndexEdits` list for the type. For pending edits
 * whose PK is not covered by `baseRows` (merged in an earlier run whose
 * index attempt failed), we re-read the committed merged projection
 * (`object_instances`): a live instance yields an UPDATE row carrying the
 * latest state (never a stale older version), an absent instance yields a
 * DELETE tombstone so replay/rebuild produce identical active state.
 */
export async function buildFullIndexBatch(input: {
  ontologyId: string;
  objectTypeApiName: string;
  baseRows: MergedRow[];
  pending: PendingIndexEdit[];
}): Promise<{ rows: MergedRow[]; editIds: string[] }> {
  const { ontologyId, objectTypeApiName, baseRows, pending } = input;

  const covered = new Set(baseRows.map((r) => r.primary_key));
  const uncoveredByPk = new Map<string, PendingIndexEdit[]>();
  const editIds: string[] = [];
  for (const e of pending) {
    editIds.push(e.edit_id);
    if (covered.has(e.primary_key)) continue;
    const list = uncoveredByPk.get(e.primary_key) ?? [];
    list.push(e);
    uncoveredByPk.set(e.primary_key, list);
  }

  let nextVersion = baseRows.reduce((m, r) => Math.max(m, r.version ?? 0), 0);
  const repairRows: MergedRow[] = [];

  const uncoveredPks = [...uncoveredByPk.keys()];
  const instances = await loadInstanceStates(ontologyId, objectTypeApiName, uncoveredPks);

  for (const pk of uncoveredPks) {
    const edits = uncoveredByPk.get(pk)!;
    // Latest executed edit for this PK wins; ties broken by edit_id for
    // determinism (same-transaction bulk edits share executed_at).
    edits.sort((a, b) => {
      const ta = a.executed_at ? new Date(a.executed_at).getTime() : 0;
      const tb = b.executed_at ? new Date(b.executed_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.edit_id.localeCompare(b.edit_id);
    });
    const latest = edits[edits.length - 1];
    const instance = instances.get(pk);
    nextVersion += 1;
    if (latest.operation !== "delete" && instance) {
      repairRows.push({
        primary_key: pk,
        properties: instance,
        operation: "UPDATE",
        version: nextVersion,
      });
    } else {
      // Latest intent is delete, or the instance is already gone — either
      // way the serving index must converge to "absent": tombstone.
      repairRows.push({
        primary_key: pk,
        properties: {},
        operation: "DELETE",
        version: nextVersion,
      });
    }
  }

  return { rows: [...baseRows, ...repairRows], editIds };
}

/**
 * STREAMING equivalent of {@link buildFullIndexBatch} — yields fixed-size
 * batches instead of building one array holding every merged row.
 *
 * `buildFullIndexBatch` needs the base rows only to answer one question ("is
 * this pending edit's PK already covered?") and then concatenates
 * `[...baseRows, ...repairRows]`. Both of those forced the caller to hold the
 * entire merged result in heap, which is why the Quickwit indexing activity
 * used the materialising `loadMergedRowsFromSnapshot` and therefore hard-failed
 * on any Object Type above the 2M-row read gate. Here the coverage question is
 * answered incrementally against the *pending* PK set — bounded by the number
 * of outstanding edits, not by the row count — so memory is flat regardless of
 * whether the snapshot holds 700 rows or 4.65M.
 *
 * Yields base-row batches first, in stream order, then a final batch with the
 * repair/tombstone rows for pending PKs the stream never covered. Row
 * `version` continues monotonically across batches, matching the array
 * variant's `i + 1` numbering so replay/rebuild converge on the same state.
 *
 * `editIds` rides on the FIRST yielded batch and is empty on the rest, because
 * `runIndexingActivity` unions them into a Set for its own `editsMarkedApplied`
 * bookkeeping and repeating the list per batch would be pure noise. The array
 * variant collected every pending edit id unconditionally — coverage never
 * affected acknowledgement — and that is preserved here. Acknowledgement itself
 * still belongs to the caller, only after the serving index confirms
 * publication: the invariant at the top of this file.
 *
 * At least one batch is always yielded when `pending` is non-empty, since every
 * pending PK is either covered by a streamed base row (base batch) or is not
 * (repair batch), so the edit ids can never be stranded.
 */
export async function* streamFullIndexBatches(input: {
  ontologyId: string;
  objectTypeApiName: string;
  baseRows: AsyncIterable<{
    primary_key: string;
    properties: Record<string, unknown>;
    operation: "upsert" | "delete";
    source_transaction_id?: string | null;
  }>;
  pending: PendingIndexEdit[];
  /** Rows per yielded batch. Bounds peak heap; 5k keeps the Kafka publish
   *  loop busy without holding a meaningful slice of a 4.65M-row snapshot. */
  batchSize?: number;
}): AsyncGenerator<{ rows: MergedRow[]; editIds: string[] }> {
  const { ontologyId, objectTypeApiName, baseRows, pending } = input;
  const batchSize = input.batchSize && input.batchSize > 0 ? input.batchSize : 5000;

  // Rides on the first yielded batch only (see doc comment).
  let pendingEditIds: string[] = pending.map((e) => e.edit_id);
  const takeEditIds = (): string[] => {
    const out = pendingEditIds;
    pendingEditIds = [];
    return out;
  };

  // Pending edits grouped by PK. Anything still here once the stream ends was
  // merged by an EARLIER run whose index attempt failed, and needs the
  // object_instances repair read.
  const uncoveredByPk = new Map<string, PendingIndexEdit[]>();
  for (const e of pending) {
    const list = uncoveredByPk.get(e.primary_key) ?? [];
    list.push(e);
    uncoveredByPk.set(e.primary_key, list);
  }

  let version = 0;
  let buffer: MergedRow[] = [];
  for await (const r of baseRows) {
    version += 1;
    buffer.push({
      primary_key: r.primary_key,
      properties: r.properties,
      operation: r.operation === "delete" ? "DELETE" : "UPDATE",
      version,
      source_transaction_id: r.source_transaction_id ?? undefined,
    });
    // This run already carries the PK, so no repair read is needed for it.
    uncoveredByPk.delete(r.primary_key);
    if (buffer.length >= batchSize) {
      yield { rows: buffer, editIds: takeEditIds() };
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    yield { rows: buffer, editIds: takeEditIds() };
    buffer = [];
  }

  const uncoveredPks = [...uncoveredByPk.keys()];
  if (uncoveredPks.length === 0) return;

  const instances = await loadInstanceStates(ontologyId, objectTypeApiName, uncoveredPks);
  const repairRows: MergedRow[] = [];
  for (const pk of uncoveredPks) {
    const edits = uncoveredByPk.get(pk)!;
    // Latest executed edit for this PK wins; ties broken by edit_id for
    // determinism (same-transaction bulk edits share executed_at).
    edits.sort((a, b) => {
      const ta = a.executed_at ? new Date(a.executed_at).getTime() : 0;
      const tb = b.executed_at ? new Date(b.executed_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.edit_id.localeCompare(b.edit_id);
    });
    const latest = edits[edits.length - 1];
    const instance = instances.get(pk);
    version += 1;
    if (latest.operation !== "delete" && instance) {
      repairRows.push({
        primary_key: pk,
        properties: instance,
        operation: "UPDATE",
        version,
      });
    } else {
      // Latest intent is delete, or the instance is already gone — either way
      // the serving index must converge to "absent": tombstone.
      repairRows.push({
        primary_key: pk,
        properties: {},
        operation: "DELETE",
        version,
      });
    }
    if (repairRows.length >= batchSize) {
      yield { rows: repairRows.splice(0, repairRows.length), editIds: takeEditIds() };
    }
  }
  if (repairRows.length > 0) yield { rows: repairRows, editIds: takeEditIds() };
}

async function loadInstanceStates(
  ontologyId: string,
  objectTypeApiName: string,
  pks: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const CHUNK = 1000;
  for (let i = 0; i < pks.length; i += CHUNK) {
    const slice = pks.slice(i, i + CHUNK);
    const res = await query(
      `SELECT primary_key, properties
         FROM object_instances
        WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = ANY($3)`,
      [ontologyId, objectTypeApiName, slice],
    );
    for (const row of res.rows) {
      out.set(row.primary_key as string, (row.properties as Record<string, unknown>) ?? {});
    }
  }
  return out;
}

/**
 * Record a deferred (NOT acknowledged) indexing attempt: edits stay
 * pending, metrics/log reflect the true state, and the next funnel run
 * retries. Never call markEditsAppliedToIndex from a deferred path.
 */
export function recordIndexingDeferred(input: {
  objectTypeApiName: string;
  pending: PendingIndexEdit[];
  reason: "quickwit_unreachable" | "quickwit_indexing_failed";
  error?: string;
}): void {
  const { objectTypeApiName: objectType, pending, reason, error } = input;
  incCounter("funnel_indexing_deferred_total", { object_type: objectType, reason });
  updatePendingIndexGauges(objectType, pending);
  console.warn(
    JSON.stringify({
      level: "warn",
      type: "funnel_indexing_deferred",
      object_type: objectType,
      reason,
      pending_edits: pending.length,
      error: error?.slice(0, 500),
      note: "edits remain applied_to_index_at IS NULL — Redis overlay retained; next funnel run retries",
    }),
  );
}

export function updatePendingIndexGauges(
  objectTypeApiName: string,
  pending: PendingIndexEdit[],
): void {
  setGauge("funnel_pending_index_edits", pending.length, { object_type: objectTypeApiName });
  let oldestAge = 0;
  const now = Date.now();
  for (const e of pending) {
    const ts = e.executed_at ? new Date(e.executed_at).getTime() : NaN;
    if (Number.isFinite(ts)) oldestAge = Math.max(oldestAge, (now - ts) / 1000);
  }
  setGauge("funnel_indexing_oldest_pending_age_seconds", oldestAge, {
    object_type: objectTypeApiName,
  });
}
