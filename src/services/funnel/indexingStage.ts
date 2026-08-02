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
