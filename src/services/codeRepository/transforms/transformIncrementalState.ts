// ===========================================================================
// transformIncrementalState — Phase 4 read/upsert of the
// `transform_incremental_state` table. One row per
// (transform_identity, repository_rid, branch, output_dataset_id).
//
//	responsibilities:
//   1. computeTransformIdentity(sourcePath, entryPoint) — a SHA-256 hex of
//      "<sourcePath>:<entryPoint>" used as the unique key for the row.
//   2. resolveOutputDatasetId(rid) — looks up `dataset.dataset_id` for a
//      canonical RID (the row exists once a prior build materialized it).
//   3. loadIncrementalState(...) — read the prior-row state for the
//      (identity, repo, branch, outputDatasetId) quad.
//   4. upsertIncrementalState(...) — INSERT ... ON CONFLICT UPDATE for the
//      row's incremental_config snapshot + post-commit pointers.
//
// buildService wires these into the per-transform execution loop:
//   - before scheduling: compute identity → lookup output_dataset_id →
//     load prior state → compare semantic_version → decide forceSnapshot +
//     effective isIncremental.
//   - after a successful commit: upsert with the new last_semantic_version
//     (= discovered), last_build_rid, last_build_status='committed',
//     input_transaction_state (last-seen input tx_id per input dataset_id),
//     last_committed_output_transaction_id (materializeOutput's tx_id),
//     last_commit_sha.
//   - after an aborted transform: NO upsert — the prior row + the prior
//     pointers are preserved (per Palantir §6 — next build reprocesses the
//     same uncommitted input changes).
//
// All rows live in the same Postgres pool as the rest of the buildService
// (the migration 121 table is in the public schema).
// ===========================================================================
import crypto from "crypto";
import { pool } from "../../../db.js";

/** Stable per-(code-version) identity: sha256("<sourcePath>:<entryPoint>").
 * Renames + refactors that change either field produce a new identity → the
 * first build against the new identity is a non-incremental SNAPSHOT (matches
 * Palantir's "rename transform → reset incremental state to first-build"). */
export function computeTransformIdentity(
  sourcePath: string,
  entryPoint: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${sourcePath}:${entryPoint}`, "utf8")
    .digest("hex");
}

/** Look up `dataset.dataset_id` for a resolved output RID. Returns null if the
 * row doesn't exist (first build / output dataset never materialized). */
export async function resolveOutputDatasetId(
  outputRid: string,
  branch: string | null | undefined,
): Promise<string | null> {
  // Reuse the existing dataset lookup — same branch-scoped latest-committed
  // row that buildService's is_incremental existence check uses. NULL when no
  // row exists on this branch.
  const { rows } = await pool.query<{ dataset_id: string }>(
    `SELECT dataset_id
       FROM dataset
      WHERE rid = $1
      -- branch-scoped existence: the dataset row does NOT have a branch column
      -- (branch-agnostic, identity-only); the existence check here is purely
      -- on the dataset row, NOT on a committed transaction. The buildService
      -- checks transaction existence separately via resolveDatasetByRid.
      LIMIT 1`,
    [outputRid],
  );
  return rows.length > 0 ? rows[0].dataset_id : null;
}

export interface IncrementalStateRow {
  state_id: number;
  transform_identity: string;
  repository_rid: string;
  branch: string;
  output_dataset_id: string;
  entry_point: string;
  source_path: string;
  require_incremental: boolean;
  semantic_version: number;
  snapshot_inputs: string[];
  allow_retention: boolean;
  strict_append: boolean;
  v2_semantics: boolean;
  last_semantic_version: number;
  last_build_rid: string | null;
  last_build_status: "pending" | "running" | "committed" | "aborted" | "failed";
  input_transaction_state: Record<string, string>;
  last_committed_output_transaction_id: string | null;
  last_commit_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Read the prior state row for the (identity, repo, branch, outputDatasetId)
 * quad. Returns null when no row exists yet (first build OR a freshly renamed
 * transform). branch=NULL means the unscoped path (treated as a literal NULL
 * lookup; the canonical `transform_incremental_state` row has branch='main'
 * etc.). */
export async function loadIncrementalState(args: {
  transformIdentity: string;
  repositoryRid: string;
  branch: string;
  outputDatasetId: string;
}): Promise<IncrementalStateRow | null> {
  const { rows } = await pool.query(
    `SELECT state_id, transform_identity, repository_rid, branch,
            output_dataset_id, entry_point, source_path,
            require_incremental, semantic_version, snapshot_inputs,
            allow_retention, strict_append, v2_semantics,
            last_semantic_version, last_build_rid, last_build_status,
            input_transaction_state, last_committed_output_transaction_id,
            last_commit_sha, created_at, updated_at
       FROM transform_incremental_state
      WHERE transform_identity = $1
        AND repository_rid = $2
        AND branch = $3
        AND output_dataset_id = $4
      LIMIT 1`,
    [
      args.transformIdentity,
      args.repositoryRid,
      args.branch,
      args.outputDatasetId,
    ],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    snapshot_inputs: Array.isArray(r.snapshot_inputs) ? r.snapshot_inputs : [],
    input_transaction_state:
      (r.input_transaction_state && typeof r.input_transaction_state === "object")
        ? r.input_transaction_state
        : {},
  } as IncrementalStateRow;
}

/** Insert or update the state row for the (identity, repo, branch, output)
 * quad. Always mirrors the discovered transform's incremental config (so a
 * decorator change persists without a separate migration path).
 *
 * Branch semantics: the row's `branch` column is the build branch (matches
 * the input_transaction_state pointers, which are also branch-scoped). */
export async function upsertIncrementalState(args: {
  transformIdentity: string;
  repositoryRid: string;
  branch: string;
  outputDatasetId: string;
  entryPoint: string;
  sourcePath: string;
  requireIncremental: boolean;
  semanticVersion: number;
  snapshotInputs: string[];
  allowRetention: boolean;
  strictAppend: boolean;
  v2Semantics: boolean;
  lastSemanticVersion: number; // The semantic_version the build ran with (advanced post-commit on a semantic version bump snapshot)
  lastBuildRid: string;
  lastBuildStatus: "committed" | "aborted" | "failed";
  inputTransactionState: Record<string, string>;
  lastCommittedOutputTransactionId: string | null;
  lastCommitSha: string | null;
}): Promise<void> {
  const snap = JSON.stringify(args.snapshotInputs ?? []);
  const its = JSON.stringify(args.inputTransactionState ?? {});
  await pool.query(
    `INSERT INTO transform_incremental_state (
        transform_identity, repository_rid, branch, output_dataset_id,
        entry_point, source_path,
        require_incremental, semantic_version, snapshot_inputs,
        allow_retention, strict_append, v2_semantics,
        last_semantic_version, last_build_rid, last_build_status,
        input_transaction_state, last_committed_output_transaction_id,
        last_commit_sha
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
      ON CONFLICT (transform_identity, repository_rid, branch, output_dataset_id)
      DO UPDATE SET
        entry_point = EXCLUDED.entry_point,
        source_path = EXCLUDED.source_path,
        require_incremental = EXCLUDED.require_incremental,
        semantic_version = EXCLUDED.semantic_version,
        snapshot_inputs = EXCLUDED.snapshot_inputs,
        allow_retention = EXCLUDED.allow_retention,
        strict_append = EXCLUDED.strict_append,
        v2_semantics = EXCLUDED.v2_semantics,
        last_semantic_version = EXCLUDED.last_semantic_version,
        last_build_rid = EXCLUDED.last_build_rid,
        last_build_status = EXCLUDED.last_build_status,
        input_transaction_state = EXCLUDED.input_transaction_state,
        last_committed_output_transaction_id = EXCLUDED.last_committed_output_transaction_id,
        last_commit_sha = EXCLUDED.last_commit_sha,
        updated_at = now()`,
    [
      args.transformIdentity,
      args.repositoryRid,
      args.branch,
      args.outputDatasetId,
      args.entryPoint,
      args.sourcePath,
      args.requireIncremental,
      args.semanticVersion,
      snap,
      args.allowRetention,
      args.strictAppend,
      args.v2Semantics,
      args.lastSemanticVersion,
      args.lastBuildRid,
      args.lastBuildStatus,
      its,
      args.lastCommittedOutputTransactionId,
      args.lastCommitSha,
    ],
  );
}

/** Mark a state row's `last_build_rid` + `last_build_status='running'` at
 * scheduling time, leaving all other pointers (semantic_version, transaction
 * pointers) unchanged. This protects against a crash mid-build: the next
 * build sees the prior committed pointers intact, NOT the in-flight build's
 * tentative state. */
export async function markBuildRunning(args: {
  transformIdentity: string;
  repositoryRid: string;
  branch: string;
  outputDatasetId: string;
  buildRid: string;
}): Promise<void> {
  await pool.query(
    `UPDATE transform_incremental_state
        SET last_build_rid = $5,
            last_build_status = 'running',
            updated_at = now()
      WHERE transform_identity = $1
        AND repository_rid = $2
        AND branch = $3
        AND output_dataset_id = $4`,
    [
      args.transformIdentity,
      args.repositoryRid,
      args.branch,
      args.outputDatasetId,
      args.buildRid,
    ],
  );
}
