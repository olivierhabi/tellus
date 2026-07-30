// ---------------------------------------------------------------------------
// Action V2 State Loader
//
// Loads persisted object existence and canonical active relationship state
// for the plan's object identities. Used by the pre-lock initial plan
// (executeAction v2 branch) and by the in-transaction revalidation closure
// (after advisory + row locks are acquired), so the final-state validator
// runs against the canonical locked state rather than a stale snapshot.
//
// Reads use the indexed `link_instances` lookups (objectType + pk) so the
// delete-restrict EXISTS/aggregate checks are index-driven, not ledger
// replays. FK-backed relationships are queried from `object_instances` via
// the relationship property columns; that path is verified separately with
// EXPLAIN ANALYZE (see scripts/action_semantics_v2_db_verify.ts).
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { query as poolQuery } from "../db";
import { objectKey, type ObjectIdentity } from "./actionPlanner";
import { canonicalPrimaryKey } from "./actionLockManager";
import {
  countActiveByEndpoint,
  existsActiveByEndpoint,
} from "./relationshipStateRepository";
import type { LockIdentity } from "./actionLockManager";

/** Check whether each identity currently exists in object_instances. */
export async function loadExistingObjects(
  identities: ObjectIdentity[],
  client?: PoolClient,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of identities) {
    try {
      const res = client
        ? await client.query(
            `SELECT 1 FROM object_instances
              WHERE object_type_api_name = $1 AND primary_key = $2 LIMIT 1`,
            [id.objectType, String(id.primaryKey)],
          )
        : await poolQuery(
            `SELECT 1 FROM object_instances
              WHERE object_type_api_name = $1 AND primary_key = $2 LIMIT 1`,
            [id.objectType, String(id.primaryKey)],
          );
      if ((res.rowCount ?? 0) > 0) out.add(objectKey(id));
    } catch {
      // transitional deployments without object_instances — treat as absent.
    }
  }
  return out;
}

/**
 * Load active M2M edges where any of the identities is source or target.
 * Uses the indexed (ontology, branch, objectType, pk) lookups per
 * identity (no full-table scan). Returns canonical edge keys
 * `link|srcObjType|srcPk|tgtObjType|tgtPk`.
 */
export async function loadActiveEdgesForIdentities(
  identities: ObjectIdentity[],
  client?: PoolClient,
): Promise<Set<string>> {
  const out = new Set<string>();
  const exec = async (sql: string, args: unknown[]) => {
    return client ? client.query(sql, args) : poolQuery(sql, args);
  };
  for (const id of identities) {
    const ont = id.ontologyId;
    const br = id.branchId;
    const ot = id.objectType;
    const pk = String(id.primaryKey);
    // outbound (id is source)
    const outRows = await exec(
      `SELECT link_type_api_name, source_object_type, source_primary_key,
              target_object_type, target_primary_key
         FROM link_instances
        WHERE ontology_id=$1 AND branch_id=$2
          AND source_object_type=$3 AND source_primary_key=$4`,
      [ont, br, ot, pk],
    );
    for (const r of ((outRows as any).rows) ?? []) {
      // Canonicalize the pks so the persisted edge key matches the planner's
      // objectKey/canonicalPrimaryKey encoding (e.g. `S:<pk>` for string pks).
      // Without this, a removeLink delta (canonical) never matched the persisted
      // edge (raw pk) -> the edge survived the delete and was flagged dangling.
      out.add(`${r.link_type_api_name}|${r.source_object_type}|${canonicalPrimaryKey(r.source_primary_key)}|${r.target_object_type}|${canonicalPrimaryKey(r.target_primary_key)}`);
    }
    // inbound (id is target)
    const inRows = await exec(
      `SELECT link_type_api_name, source_object_type, source_primary_key,
              target_object_type, target_primary_key
         FROM link_instances
        WHERE ontology_id=$1 AND branch_id=$2
          AND target_object_type=$3 AND target_primary_key=$4`,
      [ont, br, ot, pk],
    );
    for (const r of (inRows as any).rows ?? []) {
      out.add(`${r.link_type_api_name}|${r.source_object_type}|${canonicalPrimaryKey(r.source_primary_key)}|${r.target_object_type}|${canonicalPrimaryKey(r.target_primary_key)}`);
    }
  }
  return out;
}

/** Convenience: build the persisted-state snapshot for the plan's identities. */
export async function loadPersistedState(
  identities: ObjectIdentity[],
  client?: PoolClient,
): Promise<{ existingObjects: Set<string>; activeEdges: Set<string> }> {
  const [existingObjects, activeEdges] = await Promise.all([
    loadExistingObjects(identities, client),
    loadActiveEdgesForIdentities(identities, client),
  ]);
  return { existingObjects, activeEdges };
}

/** Coerce ObjectIdentity[] → LockIdentity[] for the lock manager. */
export function toLockIdentities(identities: ObjectIdentity[]): LockIdentity[] {
  return identities.map((id) => ({
    ontologyId: id.ontologyId,
    branchId: id.branchId,
    objectType: id.objectType,
    primaryKey: id.primaryKey,
  }));
}

// Re-export the bounded EXIST/aggregate helpers for the restrict-delete check.
export { countActiveByEndpoint, existsActiveByEndpoint };
