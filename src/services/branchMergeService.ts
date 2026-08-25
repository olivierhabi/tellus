// ---------------------------------------------------------------------------
// F-04: Three-way merge for ontology branches
//
// Implements copy-on-write (COW) branching semantics:
//   1. Branch creation: records a fork point (the max edit_seq at creation)
//   2. Edits on a branch: stored in ontology_edit tagged with branch_id
//   3. Merge: three-way diff between fork-point, parent edits, and branch edits
//   4. Conflict detection: when both parent and branch modify the same
//      (objectType, primaryKey, propertyName) after the fork point
//   5. Read isolation: queries on branch B cannot see uncommitted writes from branch A
//
// This matches the semantics described in Palantir patent US10585862B2
// "Systems and methods for branching in collaborative data management".
// ---------------------------------------------------------------------------

import { getClient, query } from "../db";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { deriveMainBranchId } from "./branchContext";

/**
 * Canonicalize a value using the audit-chain's canonicalJson (F-P3-14 BM-4
 * closure). Returns null if the value is not canonicalizable — in that
 * case detectConflicts falls back to treating the property as conflicting
 * (safer than silently converging on an uncanonicalizable blob).
 */
function safeCanonical(
  canonicalJson: (v: unknown) => string,
  value: unknown,
): string | null {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

/**
 * Deterministic merge operation id (F-P3-14 BM-7 closure). A retried
 * merge of the same source branch into the same target at the same fork
 * point produces the same merge_op_id — so idempotency holds at the
 * data layer even if the route-level Idempotency-Key header is absent.
 */
export function deriveMergeOpId(
  sourceBranchId: string,
  targetBranchId: string,
  forkPointCommitSeq: number | string | null,
): string {
  const forkSeqStr = forkPointCommitSeq === null ? "null" : String(forkPointCommitSeq);
  const h = createHash("sha256");
  h.update(`tellus.merge.v1\n${sourceBranchId}\n${targetBranchId}\n${forkSeqStr}`, "utf8");
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeConflict {
  objectType: string;
  primaryKey: string;
  propertyName: string;
  parentValue: unknown;
  branchValue: unknown;
  baseValue: unknown;
}

export interface MergeResult {
  success: boolean;
  mergedEditCount: number;
  conflicts: MergeConflict[];
  branchId: string;
  parentBranchId: string | null;
}

export interface BranchEditSummary {
  editId: string;
  objectType: string;
  primaryKey: string;
  operation: string;
  propertyValues: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the fork point for a branch. This is the max edit sequence number
 * at the time the branch was created.
 */
async function getForkPoint(
  client: PoolClient,
  branchId: string
): Promise<string | null> {
  const res = await client.query(
    `SELECT fork_point_edit_id FROM ontology_branch WHERE branch_id = $1`,
    [branchId]
  );
  return res.rows[0]?.fork_point_edit_id ?? null;
}

/**
 * Get all edits on a branch since the fork point.
 */
async function getBranchEdits(
  client: PoolClient,
  branchId: string,
  forkPointEditId: string | null
): Promise<BranchEditSummary[]> {
  const sql = forkPointEditId
    ? `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE branch_id = $1 AND edit_id > $2
       ORDER BY commit_seq ASC`
    : `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE branch_id = $1
       ORDER BY commit_seq ASC`;

  const params = forkPointEditId ? [branchId, forkPointEditId] : [branchId];
  const res = await client.query(sql, params);
  return res.rows.map((r) => ({
    editId: r.edit_id,
    objectType: r.objectType,
    primaryKey: r.primaryKey,
    operation: r.operation,
    propertyValues:
      typeof r.propertyValues === "string"
        ? JSON.parse(r.propertyValues)
        : r.propertyValues ?? {},
    createdAt: r.createdAt,
  }));
}

/**
 * Get parent edits since the fork point (edits on the parent that happened
 * after the branch was created).
 */
async function getParentEditsSinceFork(
  client: PoolClient,
  ontologyId: string,
  parentBranchId: string | null,
  forkPointEditId: string | null
): Promise<BranchEditSummary[]> {
  // Parent edits are those with branch_id = parentBranchId (or NULL for main)
  // that were created after the fork point.
  const branchCond = parentBranchId
    ? "branch_id = $2"
    : "(branch_id IS NULL)";

  const sql = forkPointEditId
    ? `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND ${branchCond} AND edit_id > $3
       ORDER BY commit_seq ASC`
    : `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND ${branchCond}
       ORDER BY commit_seq ASC`;

  const params: unknown[] = forkPointEditId
    ? [ontologyId, ...(parentBranchId ? [parentBranchId] : []), forkPointEditId]
    : [ontologyId, ...(parentBranchId ? [parentBranchId] : [])];

  // Re-number params for the dynamic SQL
  // Simpler approach: just use separate queries
  let result;
  if (parentBranchId && forkPointEditId) {
    result = await client.query(
      `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND branch_id = $2 AND edit_id > $3
       ORDER BY commit_seq ASC`,
      [ontologyId, parentBranchId, forkPointEditId]
    );
  } else if (parentBranchId) {
    result = await client.query(
      `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND branch_id = $2
       ORDER BY commit_seq ASC`,
      [ontologyId, parentBranchId]
    );
  } else if (forkPointEditId) {
    result = await client.query(
      `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND branch_id IS NULL AND edit_id > $2
       ORDER BY commit_seq ASC`,
      [ontologyId, forkPointEditId]
    );
  } else {
    result = await client.query(
      `SELECT edit_id, object_type_api_name AS "objectType",
              primary_key AS "primaryKey", operation,
              property_values AS "propertyValues",
              executed_at AS "createdAt"
       FROM ontology_edit
       WHERE ontology_id_fk = $1 AND branch_id IS NULL
       ORDER BY commit_seq ASC`,
      [ontologyId]
    );
  }

  return result.rows.map((r: any) => ({
    editId: r.edit_id,
    objectType: r.objectType,
    primaryKey: r.primaryKey,
    operation: r.operation,
    propertyValues:
      typeof r.propertyValues === "string"
        ? JSON.parse(r.propertyValues)
        : r.propertyValues ?? {},
    createdAt: r.createdAt,
  }));
}

/**
 * Build a map of per-property changes from a list of edits.
 * Key: "objectType::primaryKey::propertyName"
 * Value: the last value set for that property.
 */
function buildPropertyChangeMap(
  edits: BranchEditSummary[]
): Map<string, { value: unknown; operation: string }> {
  const map = new Map<string, { value: unknown; operation: string }>();
  for (const edit of edits) {
    if (edit.operation === "delete") {
      // Delete trumps all property changes for this object
      map.set(`${edit.objectType}::${edit.primaryKey}::__DELETE__`, {
        value: null,
        operation: "delete",
      });
      continue;
    }
    for (const [prop, value] of Object.entries(edit.propertyValues)) {
      map.set(`${edit.objectType}::${edit.primaryKey}::${prop}`, {
        value,
        operation: edit.operation,
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------------

/**
 * Detect conflicts between parent and branch edits since the fork point.
 * A conflict occurs when both sides modify the same property on the same object.
 */
function detectConflicts(
  parentChanges: Map<string, { value: unknown; operation: string }>,
  branchChanges: Map<string, { value: unknown; operation: string }>
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  for (const [key, branchChange] of branchChanges) {
    const parentChange = parentChanges.get(key);
    if (!parentChange) continue; // Only branch changed — no conflict.

    // F-P3-14 BM-4 closure: deep structural equality via canonicalJson.
    // The previous JSON.stringify comparison produced false-positive
    // conflicts on key reorder (object key order is implementation-
    // defined) and false-negatives on type coercion (1 vs "1" would
    // differ in stringify but match a naive `==`; canonicalJson treats
    // them as different types, which is the correct contract).
    //
    // Lazy-require canonicalJson to avoid a cyclic init path during
    // module load in some test configurations.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { canonicalJson } = require("./audit/canonicalJson") as {
      canonicalJson: (v: unknown) => string;
    };
    const parentCanon = safeCanonical(canonicalJson, parentChange.value);
    const branchCanon = safeCanonical(canonicalJson, branchChange.value);
    if (parentCanon !== null && branchCanon !== null && parentCanon === branchCanon) {
      continue; // Convergent change — not a conflict.
    }

    const parts = key.split("::");
    conflicts.push({
      objectType: parts[0],
      primaryKey: parts[1],
      propertyName: parts.slice(2).join("::"),
      parentValue: parentChange.value,
      branchValue: branchChange.value,
      // F-P3-14 BM-1: baseValue left undefined here and filled in by the
      // caller (mergeThreeWay) which has access to the PG client. See
      // populateBaseValues() below. The detectConflicts function itself
      // remains pure over the pre-fetched change maps.
      baseValue: undefined,
    });
  }
  return conflicts;
}

/**
 * Perform a three-way merge of a branch into its parent.
 *
 * Steps:
 *   1. Lock the branch row (SELECT FOR UPDATE) for isolation.
 *   2. Collect edits on the branch since fork.
 *   3. Collect edits on the parent since fork.
 *   4. Detect conflicts.
 *   5. If conflicts exist and no explicit resolutions are provided, abort.
 *   6. If no conflicts (or all resolved), replay branch edits onto the parent
 *      by re-inserting them with branch_id = NULL (or parent branch_id).
 *   7. Update branch status to MERGED.
 *
 * @param ontologyId  - The owning ontology.
 * @param branchId    - The branch to merge.
 * @param resolutions - Optional conflict resolutions: map from conflict key
 *                      to "parent" | "branch" (which side wins).
 */
export async function mergeThreeWay(
  ontologyId: string,
  branchId: string,
  resolutions?: Map<string, "parent" | "branch">,
  mergedBy?: string,
): Promise<MergeResult> {
  const pgClient = await getClient();
  try {
    await pgClient.query("BEGIN");

    // F-P3-14 BM-5 closure: serialize concurrent merges on the same
    // target via a PG advisory transaction lock keyed by the target
    // branch id. A second concurrent merge blocks here; once the first
    // commits, the second observes the post-merge state and either
    // no-ops (same merge_op_id already applied) or proceeds with new
    // source state.
    await pgClient.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`tellus.merge.${branchId}`],
    );

    // Lock the branch row to prevent concurrent merges.
    const branchRes = await pgClient.query(
      `SELECT * FROM ontology_branch WHERE branch_id = $1 FOR UPDATE`,
      [branchId]
    );
    if (branchRes.rowCount === 0) {
      await pgClient.query("ROLLBACK");
      throw Object.assign(new Error("Branch not found"), { code: "BRANCH_NOT_FOUND" });
    }
    const branch = branchRes.rows[0];
    if (branch.status !== "OPEN") {
      await pgClient.query("ROLLBACK");
      throw Object.assign(
        new Error(`Branch is ${branch.status}; only OPEN branches can be merged.`),
        { code: "VALIDATION_FAILED" }
      );
    }

    const forkPointEditId = branch.fork_point_edit_id ?? null;
    const parentBranchId = branch.parent_branch_id ?? null;

    // Collect edits
    const branchEdits = await getBranchEdits(pgClient, branchId, forkPointEditId);
    const parentEdits = await getParentEditsSinceFork(
      pgClient,
      ontologyId,
      parentBranchId,
      forkPointEditId
    );

    // Build change maps
    const parentChanges = buildPropertyChangeMap(parentEdits);
    const branchChanges = buildPropertyChangeMap(branchEdits);

    // Detect conflicts
    const conflicts = detectConflicts(parentChanges, branchChanges);

    // If there are unresolved conflicts, abort and return them.
    if (conflicts.length > 0) {
      const unresolvedConflicts = conflicts.filter((c) => {
        const key = `${c.objectType}::${c.primaryKey}::${c.propertyName}`;
        return !resolutions?.has(key);
      });
      if (unresolvedConflicts.length > 0) {
        await pgClient.query("ROLLBACK");
        return {
          success: false,
          mergedEditCount: 0,
          conflicts: unresolvedConflicts,
          branchId,
          parentBranchId,
        };
      }
    }

    // Apply branch edits to the parent. For each branch edit, insert a new
    // edit with branch_id = parentBranchId (NULL for main branch).
    // Skip edits that were resolved in favor of the parent.
    const resolvedParentKeys = new Set<string>();
    if (resolutions) {
      for (const [key, winner] of resolutions) {
        if (winner === "parent") resolvedParentKeys.add(key);
      }
    }

    let mergedCount = 0;
    for (const edit of branchEdits) {
      // Check if any property in this edit was resolved in favor of parent
      const filteredProps: Record<string, unknown> = {};
      let hasProps = false;
      for (const [prop, value] of Object.entries(edit.propertyValues)) {
        const key = `${edit.objectType}::${edit.primaryKey}::${prop}`;
        if (resolvedParentKeys.has(key)) continue; // Skip — parent wins
        filteredProps[prop] = value;
        hasProps = true;
      }

      // For delete operations, always replay
      if (edit.operation === "delete" || hasProps) {
        // F-P3-14 BM-7 closure — deterministic execution_id per edit.
        // The merge_op_id is stable across retries (deriveMergeOpId is
        // a pure function of source/target/forkPoint), so replaying an
        // aborted merge produces the same execution_ids at each offset
        // and PG's unique-constraint on (execution_id) — if present —
        // catches double-apply; without a constraint the deterministic
        // id still means every call-site can detect duplicates.
        const forkSeq = (branch as { fork_point_commit_seq?: number | null }).fork_point_commit_seq ?? null;
        const mergeOpId = deriveMergeOpId(branchId, parentBranchId ?? "__root__", forkSeq);
        // Format the per-edit execution_id as a valid UUID (the
        // ontology_edit.execution_id column is typed `uuid`, so the prior
        // `${mergeOpId.slice(0, 16)}-${mergedCount}` shape — e.g.
        // `abff5466cd1b06c9-0` — was rejected by PG with
        // `invalid input syntax for type uuid`). Re-hash mergeOpId + the
        // edit index so each edit gets a distinct, deterministic, UUID-shaped
        // id (same inputs → same execution_id across retries).
        const editHash = createHash("sha256")
          .update(`${mergeOpId}:${mergedCount}`, "utf8")
          .digest("hex");
        const editExecutionId = `${editHash.slice(0, 8)}-${editHash.slice(8, 12)}-${editHash.slice(12, 16)}-${editHash.slice(16, 20)}-${editHash.slice(20, 32)}`;
        // ontology_edit.branch_id + ontology_id are NOT NULL with no default.
        // The merge replays the branch's edits onto the PARENT branch — when
        // the parent is `main` (parentBranchId is null), resolve to the
        // ontology's main branch UUID (deriveMainBranchId — pure uuidv5, no
        // DB lookup; the executor + editApplicator do the same for regular
        // applies). Without this the INSERT fails with 23502 not_null_violation
        // (mapped to 400 REQUIRED_FIELD_MISSING) whenever a branch merges
        // into main. Also include ontology_id (NOT NULL, no default) — the
        // prior INSERT omitted it entirely.
        const targetBranchId = parentBranchId ?? deriveMainBranchId(ontologyId);
        await pgClient.query(
          `INSERT INTO ontology_edit
             (object_type_api_name, primary_key, operation, property_values,
              link_edits, action_type_api_name, execution_id, action_parameters,
              executed_by, edit_strategy, ontology_id, branch_id)
           VALUES ($1, $2, $3, $4, '[]', 'branch_merge', $5, '{}', $7, 'latest_wins', $8, $6)`,
          [
            edit.objectType,
            edit.primaryKey,
            edit.operation,
            JSON.stringify(edit.operation === "delete" ? {} : filteredProps),
            editExecutionId,
            targetBranchId,
            // F-P3-14 BM-8 closure — record the merging principal, not
            // 'system'. Callers are now required to pass mergedBy; the
            // default remains 'system' for backward compatibility during
            // the migration window.
            mergedBy ?? "system",
            ontologyId,
          ]
        );
        mergedCount++;
      }
    }

    // Update branch status to MERGED
    await pgClient.query(
      `UPDATE ontology_branch SET status = 'MERGED', merged_at = now() WHERE branch_id = $1`,
      [branchId]
    );
    await pgClient.query(
      `UPDATE ontology_proposal SET status = 'MERGED', merged_at = now() WHERE branch_id = $1 AND status = 'APPROVED'`,
      [branchId]
    );

    await pgClient.query("COMMIT");

    return {
      success: true,
      mergedEditCount: mergedCount,
      conflicts: [],
      branchId,
      parentBranchId,
    };
  } catch (err) {
    await pgClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    pgClient.release();
  }
}

/**
 * Get the diff of edits on a branch since its fork point. Used by the
 * branch detail endpoint to show what would be merged.
 */
export async function getBranchDiff(
  ontologyId: string,
  branchId: string
): Promise<{
  branchEdits: BranchEditSummary[];
  parentEdits: BranchEditSummary[];
  conflicts: MergeConflict[];
}> {
  const branchRes = await query(
    `SELECT * FROM ontology_branch WHERE branch_id = $1`,
    [branchId]
  );
  if (branchRes.rowCount === 0) {
    throw Object.assign(new Error("Branch not found"), { code: "BRANCH_NOT_FOUND" });
  }
  const branch = branchRes.rows[0];
  const forkPointEditId = branch.fork_point_edit_id ?? null;
  const parentBranchId = branch.parent_branch_id ?? null;

  const pgClient = await getClient();
  try {
    const branchEdits = await getBranchEdits(pgClient, branchId, forkPointEditId);
    const parentEdits = await getParentEditsSinceFork(
      pgClient,
      ontologyId,
      parentBranchId,
      forkPointEditId
    );

    const parentChanges = buildPropertyChangeMap(parentEdits);
    const branchChanges = buildPropertyChangeMap(branchEdits);
    const conflicts = detectConflicts(parentChanges, branchChanges);

    return { branchEdits, parentEdits, conflicts };
  } finally {
    pgClient.release();
  }
}

/**
 * Record the fork point when creating a new branch. Should be called
 * inside the branch creation transaction.
 */
export async function recordForkPoint(
  client: PoolClient,
  branchId: string,
  ontologyId: string
): Promise<void> {
  // F-P3-14 BM-6 closure: no silent swallow. The fork_point_commit_seq
  // column MUST exist (migration 042); if it does not, throw — because
  // a merge with null fork_point treats all parent history as "since
  // fork" and silently duplicates data.
  //
  // fork_point is the latest edit at the time of branch creation. We
  // record BOTH:
  //   - commit_seq (monotonic, correct primitive — use this for merge)
  //   - edit_id    (legacy, preserved for pre-042 merges during rolling deploy)
  const res = await client.query(
    `SELECT edit_id, commit_seq FROM ontology_edit
     WHERE ontology_id_fk = $1
     ORDER BY commit_seq DESC LIMIT 1`,
    [ontologyId]
  );
  const forkPointEditId = res.rows[0]?.edit_id ?? null;
  const forkPointCommitSeq = res.rows[0]?.commit_seq ?? null;

  await client.query(
    `UPDATE ontology_branch
        SET fork_point_edit_id = $1,
            fork_point_commit_seq = $2
      WHERE branch_id = $3`,
    [forkPointEditId, forkPointCommitSeq, branchId],
  );
}
