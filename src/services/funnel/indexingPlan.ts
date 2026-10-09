// ---------------------------------------------------------------------------
// Full vs incremental indexing — Palantir Funnel batch-pipeline rule.
//
// Palantir (https://www.palantir.com/docs/foundry/object-indexing/funnel-
// batch-pipelines/) indexes batch datasources incrementally by default and
// falls back to a full reindex when more than 80% of the rows changed in the
// transaction, when the object type's schema changed (a replacement pipeline
// — Tellus: src/services/quickwit/replacement), or when a user asks for one.
//
// Merge records a plan from the delta it already computes; Indexing turns it
// into a decision, adding the one check only it can make: the serving index
// must already reflect the delta's base snapshot (funnel_index_watermark).
// Otherwise publishing just the delta would leave the index missing every
// change from the snapshot(s) that never got indexed.
// ---------------------------------------------------------------------------

import { query } from "../../db";

export type IndexingMode = "full" | "incremental";

export type IndexingPlanReason =
  | "delta_within_threshold"
  | "changed_fraction_above_threshold"
  | "no_previous_snapshot"
  | "delta_unavailable"
  | "empty_snapshot";

export interface IndexingPlan {
  mode: IndexingMode;
  reason: IndexingPlanReason;
  totalRows: number;
  changedRows: number | null;
  changedFraction: number | null;
  /** Merged snapshot the delta is relative to. */
  baseSnapshotId: string | null;
  threshold: number;
}

/** Plan recorded on the merged snapshot (pure). */
export function planIndexing(args: {
  totalRows: number;
  delta: { rows: number; prevSnapshotId: string } | null;
  /** The delta rows are readable later (uploaded, or zero rows). */
  deltaRefAvailable: boolean;
  deltaUploadFailed?: boolean;
  fullReindexFraction: number;
}): IndexingPlan {
  const threshold = args.fullReindexFraction;
  const base = {
    totalRows: args.totalRows,
    changedRows: args.delta?.rows ?? null,
    baseSnapshotId: args.delta?.prevSnapshotId ?? null,
    threshold,
  };
  if (args.totalRows <= 0) {
    return { ...base, mode: "full", reason: "empty_snapshot", changedFraction: null };
  }
  if (!args.delta) {
    return { ...base, mode: "full", reason: "no_previous_snapshot", changedFraction: null };
  }
  const changedFraction = args.delta.rows / args.totalRows;
  if (!args.deltaRefAvailable || args.deltaUploadFailed) {
    return { ...base, mode: "full", reason: "delta_unavailable", changedFraction };
  }
  if (changedFraction > threshold) {
    return { ...base, mode: "full", reason: "changed_fraction_above_threshold", changedFraction };
  }
  return { ...base, mode: "incremental", reason: "delta_within_threshold", changedFraction };
}

export type IndexingDecisionReason =
  | IndexingPlanReason
  | "user_requested_full"
  | "incremental_disabled"
  | "no_plan"
  | "index_behind_base_snapshot"
  | "already_indexed";

export interface IndexingDecision {
  mode: IndexingMode;
  reason: IndexingDecisionReason;
  /** This snapshot is already in the serving index: nothing to publish
   *  beyond pending-edit repairs. */
  alreadyIndexed: boolean;
}

/** Final decision at indexing time (pure). */
export function decideIndexingMode(args: {
  mergedSnapshotId: string;
  plan: IndexingPlan | null;
  lastIndexedSnapshotId: string | null;
  incrementalEnabled: boolean;
  forceFull?: boolean;
}): IndexingDecision {
  const alreadyIndexed = args.lastIndexedSnapshotId === args.mergedSnapshotId;
  if (args.forceFull) return { mode: "full", reason: "user_requested_full", alreadyIndexed: false };
  if (alreadyIndexed) return { mode: "incremental", reason: "already_indexed", alreadyIndexed };
  if (!args.incrementalEnabled) return { mode: "full", reason: "incremental_disabled", alreadyIndexed };
  if (!args.plan) return { mode: "full", reason: "no_plan", alreadyIndexed };
  if (args.plan.mode === "full") return { mode: "full", reason: args.plan.reason, alreadyIndexed };
  if (!args.plan.baseSnapshotId || args.plan.baseSnapshotId !== args.lastIndexedSnapshotId) {
    return { mode: "full", reason: "index_behind_base_snapshot", alreadyIndexed };
  }
  return { mode: "incremental", reason: args.plan.reason, alreadyIndexed };
}

export function parseIndexingPlan(raw: unknown): IndexingPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<IndexingPlan>;
  if (p.mode !== "full" && p.mode !== "incremental") return null;
  return {
    mode: p.mode,
    reason: (p.reason ?? "no_previous_snapshot") as IndexingPlanReason,
    totalRows: Number(p.totalRows ?? 0),
    changedRows: p.changedRows == null ? null : Number(p.changedRows),
    changedFraction: p.changedFraction == null ? null : Number(p.changedFraction),
    baseSnapshotId: typeof p.baseSnapshotId === "string" ? p.baseSnapshotId : null,
    threshold: Number(p.threshold ?? 0.8),
  };
}

export async function readIndexWatermark(
  ontologyId: string,
  objectTypeApiName: string,
): Promise<string | null> {
  try {
    const r = await query(
      `SELECT last_indexed_merged_snapshot_id::text AS id
         FROM funnel_index_watermark
        WHERE ontology_id = $1 AND object_type_api_name = $2`,
      [ontologyId, objectTypeApiName],
    );
    return (r.rows[0] as { id?: string } | undefined)?.id ?? null;
  } catch (err) {
    // 42P01 undefined_table: migration 197 not applied ⇒ no watermark ⇒ full.
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

/** Called only after the serving index confirmed publication. */
export async function writeIndexWatermark(args: {
  ontologyId: string;
  objectTypeApiName: string;
  mergedSnapshotId: string;
  mode: IndexingMode;
  rowsPublished: number;
}): Promise<void> {
  await query(
    `INSERT INTO funnel_index_watermark
       (ontology_id, object_type_api_name, last_indexed_merged_snapshot_id,
        last_mode, last_rows_published, indexed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (ontology_id, object_type_api_name) DO UPDATE SET
       last_indexed_merged_snapshot_id = EXCLUDED.last_indexed_merged_snapshot_id,
       last_mode           = EXCLUDED.last_mode,
       last_rows_published = EXCLUDED.last_rows_published,
       indexed_at          = now()`,
    [args.ontologyId, args.objectTypeApiName, args.mergedSnapshotId, args.mode, args.rowsPublished],
  );
}

/** Force the next indexing pass to be full (user-triggered reindex). */
export async function clearIndexWatermark(
  ontologyId: string,
  objectTypeApiName: string,
): Promise<void> {
  try {
    await query(
      `DELETE FROM funnel_index_watermark WHERE ontology_id = $1 AND object_type_api_name = $2`,
      [ontologyId, objectTypeApiName],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return;
    throw err;
  }
}
