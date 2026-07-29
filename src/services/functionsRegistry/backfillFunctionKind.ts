// ---------------------------------------------------------------------------
// runFunctionKindBackfill — classify legacy registry versions.
//
// Fills function_registry_function_version.function_kind for rows where
// it IS NULL (legacy/unclassified), using the SAME publish-time
// classifier as new releases (inspectPublishedFunction) — this module
// contains NO separate classification logic. Classification reads the
// exact immutable source of each version —
// function_version.manifest_json.sources keyed by the function's
// api_name, joined through release_version_rid — never matched by
// apiName/sourcePath alone, so one release's source can never update
// another version.
//
// Idempotent: only NULL rows are processed and the UPDATE is guarded
// by function_kind IS NULL, so a second --apply run (or a concurrent
// one) updates nothing. Rows whose source is missing/corrupt or whose
// declaration is malformed are recorded 'unknown' (fail closed) and
// LISTED in the report — never silently dropped.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

import { inspectPublishedFunction } from "../functionsPublish/service";
import type { FunctionKind } from "../functionsPublish/functionKind";
import { resolveFunctionSource } from "./artifactStore";

/** Minimal query interface (Pool or a transaction client). */
export interface Queryable {
  query: Pool["query"];
}

export interface BackfillCandidateRow {
  function_rid: string;
  semver: string;
  branch: string;
  release_version_rid: string;
  source_path: string;
  api_name: string;
  manifest_json: { sources?: Record<string, unknown> } | null;
  artifact_blob_id: string | null;
}

export interface BackfillOutcome {
  /** function_rid@branch:semver (release release_version_rid) */
  identity: string;
  kind: FunctionKind | "unknown";
  /** Why classification produced 'unknown' (null for edit/query). */
  reason: string | null;
  /** true when --apply wrote the classification. */
  applied: boolean;
  /** The UPDATE failed — the row remains NULL. */
  updateError: string | null;
}

export interface FunctionKindBackfillReport {
  mode: "DRY-RUN" | "APPLY";
  /** Rows already classified before this run (skipped by design). */
  alreadyClassified: number;
  /** Rows still NULL when the run started. */
  candidates: number;
  counts: {
    edit: number;
    query: number;
    unknown: number;
    /** UPDATE failed — the row remains NULL. */
    failed: number;
    /** A concurrent run classified the row first. */
    skippedConcurrent: number;
  };
  outcomes: BackfillOutcome[];
}

async function classifyRow(
  row: BackfillCandidateRow,
): Promise<{ kind: FunctionKind | "unknown"; reason: string | null }> {
  // Source resolution (Track 2 #8): historical inline manifests
  // are served directly; blob-backed versions are fetched from
  // the content-addressed artifact store.
  let source: string | null;
  try {
    source = await resolveFunctionSource(row, row.api_name);
  } catch {
    source = null;
  }
  if (typeof source !== "string" || source.length === 0) {
    return { kind: "unknown", reason: "published source missing from release manifest or artifact store" };
  }
  try {
    const metadata = inspectPublishedFunction(row.source_path, source);
    return { kind: metadata.functionKind, reason: null };
  } catch (error) {
    return {
      kind: "unknown",
      reason: `classification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function backfillRowIdentity(row: BackfillCandidateRow): string {
  return `${row.function_rid}@${row.branch}:${row.semver} (release ${row.release_version_rid})`;
}

export async function runFunctionKindBackfill(
  db: Queryable | Pool | PoolClient,
  options: { apply: boolean },
): Promise<FunctionKindBackfillReport> {
  const apply = options.apply;

  const candidates = await db.query<BackfillCandidateRow>(
    `SELECT v.function_rid, v.semver, v.branch, v.release_version_rid, v.source_path,
            f.api_name, fv.manifest_json, fv.artifact_blob_id
       FROM function_registry_function_version v
       JOIN function_registry_function f ON f.rid = v.function_rid
       JOIN function_version fv ON fv.rid = v.release_version_rid
      WHERE v.function_kind IS NULL
      ORDER BY v.created_at ASC`,
  );
  const alreadyClassified = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM function_registry_function_version
      WHERE function_kind IS NOT NULL`,
  );

  const report: FunctionKindBackfillReport = {
    mode: apply ? "APPLY" : "DRY-RUN",
    alreadyClassified: Number(alreadyClassified.rows[0]?.count ?? 0),
    candidates: candidates.rowCount ?? candidates.rows.length,
    counts: { edit: 0, query: 0, unknown: 0, failed: 0, skippedConcurrent: 0 },
    outcomes: [],
  };

  for (const row of candidates.rows) {
    const identity = backfillRowIdentity(row);
    const outcome = await classifyRow(row);
    const record: BackfillOutcome = {
      identity,
      kind: outcome.kind,
      reason: outcome.reason,
      applied: false,
      updateError: null,
    };
    report.outcomes.push(record);
    if (!apply) {
      report.counts[outcome.kind] += 1;
      continue;
    }
    try {
      // Guarded by function_kind IS NULL so a concurrent or repeated
      // run can never overwrite an existing classification.
      const updated = await db.query(
        `UPDATE function_registry_function_version
            SET function_kind = $4
          WHERE function_rid = $1 AND branch = $2 AND semver = $3
            AND function_kind IS NULL`,
        [row.function_rid, row.branch, row.semver, outcome.kind],
      );
      if (updated.rowCount === 1) {
        report.counts[outcome.kind] += 1;
        record.applied = true;
      } else {
        report.counts.skippedConcurrent += 1;
      }
    } catch (error) {
      report.counts.failed += 1;
      record.updateError = error instanceof Error ? error.message : String(error);
    }
  }

  return report;
}
