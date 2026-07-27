// ---------------------------------------------------------------------------
// Relationship State Repository
//
// Provides canonical CURRENT active relationship state. `link_edit` stays
// the immutable edit ledger; `link_instances` is the active-state projection
// (introduced by migration 122). Fork-backed relationships are NOT stored
// here — they are queried from `object_instances` using indexed
// relationship-property columns.
//
// Read surface (used by version-2 referential-integrity checks, planner,
// final-state validator):
//   * countActiveByEndpoint  — aggregate blocking counts (inbound/outbound)
//   * existsActiveByEndpoint — efficient EXISTS check (bounded)
//   * summaryByEndpoint      — bounded blocking-relationship summary for
//                               preview + execution error (sample capped).
//
// Maintenance:
//   * projectFromLedger      — idempotent rebuild of link_instances from the
//                              link_edit ledger. Used once on migration + on
//                              any reconciliation. Not used during execution.
//   * upsertActive / removeActive — incremental maintenance called by the
//                              edit applicator inside its PG transaction.
//
// The repository executes inside the caller's transaction (accepts a
// PoolClient) so referential-integrity reads see writes from earlier in the
// same action invocation without committing.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { query as poolQuery } from "../db";
import { incCounter } from "../services/funnel/metrics";
import {
  getByApiName as getLinkType,
  resolveObjectTypeApiName,
} from "../models/linkType";
import {
  buildBlockingSummary,
  MAX_BLOCKING_SAMPLE,
  type BlockingRelationshipSummary,
} from "./actionErrors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkInstanceRow {
  ontology_id: string;
  branch_id: string;
  link_type_api_name: string;
  source_object_type: string;
  source_primary_key: string;
  target_object_type: string;
  target_primary_key: string;
}

export interface EndpointCount {
  inboundCount: number;
  outboundCount: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Active-state counts and EXISTS checks
// ---------------------------------------------------------------------------

/**
 * Count active relationships where `objectType:pk` is either source OR
 * target in the given ontology+branch. Returns inbound/outbound/total.
 *
 * Uses the indexed `(ontology_id, branch_id, source|target_object_type,
 * source|target_primary_key)` lookups — two indexed `COUNT(*)`, no
 * ledger replay, no unbounded set.
 */
export async function countActiveByEndpoint(
  client: PoolClient,
  ontologyId: string,
  branchId: string,
  objectType: string,
  primaryKey: string,
): Promise<EndpointCount> {
  const [outRows, inRows] = await Promise.all([
    client.query(
      `SELECT COUNT(*)::int AS c FROM link_instances
        WHERE ontology_id = $1 AND branch_id = $2
          AND source_object_type = $3 AND source_primary_key = $4`,
      [ontologyId, branchId, objectType, primaryKey],
    ),
    client.query(
      `SELECT COUNT(*)::int AS c FROM link_instances
        WHERE ontology_id = $1 AND branch_id = $2
          AND target_object_type = $3 AND target_primary_key = $4`,
      [ontologyId, branchId, objectType, primaryKey],
    ),
  ]);
  const outboundCount = Number(outRows.rows[0]?.c ?? 0);
  const inboundCount = Number(inRows.rows[0]?.c ?? 0);
  return { inboundCount, outboundCount, total: inboundCount + outboundCount };
}

/**
 * Efficient EXISTS check: does the given object have ANY active relationship
 * (inbound or outbound)? Bounded — single index probe per direction, no
 * relationship loading. This is the function the version-2 `restrict`
 * delete policy calls at execution time.
 */
export async function existsActiveByEndpoint(
  client: PoolClient,
  ontologyId: string,
  branchId: string,
  objectType: string,
  primaryKey: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM link_instances
      WHERE ontology_id = $1 AND branch_id = $2
        AND (
          (source_object_type = $3 AND source_primary_key = $4)
          OR
          (target_object_type = $3 AND target_primary_key = $4)
        )
      LIMIT 1`,
    [ontologyId, branchId, objectType, primaryKey],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Bounded blocking-relationship summary (preview + execution error)
// ---------------------------------------------------------------------------

/**
 * Build the bounded `BlockingRelationshipSummary` used by the preview
 * contract and embedded (bounded) in the version-2 delete execution error.
 *
 * Counts are always exact; `sample` is capped at MAX_BLOCKING_SAMPLE. Full
 * detail is only available via a separate inspection endpoint — never
 * unbounded in an action-validation response (§7).
 */
export async function blockingSummaryByEndpoint(
  client: PoolClient,
  ontologyId: string,
  branchId: string,
  objectType: string,
  primaryKey: string,
): Promise<BlockingRelationshipSummary> {
  // Aggregate counts per link_type + direction (two indexed queries).
  const outAgg = await client.query(
    `SELECT link_type_api_name, COUNT(*)::int AS c
       FROM link_instances
       WHERE ontology_id = $1 AND branch_id = $2
         AND source_object_type = $3 AND source_primary_key = $4
       GROUP BY link_type_api_name`,
    [ontologyId, branchId, objectType, primaryKey],
  );
  const inAgg = await client.query(
    `SELECT link_type_api_name, COUNT(*)::int AS c
       FROM link_instances
       WHERE ontology_id = $1 AND branch_id = $2
         AND target_object_type = $3 AND target_primary_key = $4
       GROUP BY link_type_api_name`,
    [ontologyId, branchId, objectType, primaryKey],
  );

  const byLinkTypeMap = new Map<string, { inbound: number; outbound: number }>();
  let outboundCount = 0;
  for (const row of outAgg.rows as Array<{ link_type_api_name: string; c: number }>) {
    outboundCount += row.c;
    const id = byLinkTypeMap.get(row.link_type_api_name) ?? { inbound: 0, outbound: 0 };
    id.outbound += row.c;
    byLinkTypeMap.set(row.link_type_api_name, id);
  }
  let inboundCount = 0;
  for (const row of inAgg.rows as Array<{ link_type_api_name: string; c: number }>) {
    inboundCount += row.c;
    const id = byLinkTypeMap.get(row.link_type_api_name) ?? { inbound: 0, outbound: 0 };
    id.inbound += row.c;
    byLinkTypeMap.set(row.link_type_api_name, id);
  }
  const total = inboundCount + outboundCount;

  // Bounded sample — at most MAX_BLOCKING_SAMPLE rows ordered by link type.
  const sampleRows = await client.query(
    `SELECT link_type_api_name, source_object_type, source_primary_key,
            target_object_type, target_primary_key,
            CASE WHEN source_object_type = $3 AND source_primary_key = $4
                 THEN 'outbound' ELSE 'inbound' END AS direction
       FROM link_instances
       WHERE ontology_id = $1 AND branch_id = $2
         AND (
           (source_object_type = $3 AND source_primary_key = $4)
           OR
           (target_object_type = $3 AND target_primary_key = $4)
         )
       ORDER BY link_type_api_name
       LIMIT $5`,
    [ontologyId, branchId, objectType, primaryKey, MAX_BLOCKING_SAMPLE],
  );

  const raw = sampleRows.rows as Array<{
    link_type_api_name: string;
    source_object_type: string;
    source_primary_key: string;
    target_object_type: string;
    target_primary_key: string;
    direction: "inbound" | "outbound";
  }>;

  return buildBlockingSummary(
    raw.map((row) => ({
      linkType: row.link_type_api_name,
      sourceObjectType: row.source_object_type,
      sourcePrimaryKey: row.source_primary_key,
      targetObjectType: row.target_object_type,
      targetPrimaryKey: row.target_primary_key,
      direction: row.direction,
    })),
  );
}

// ---------------------------------------------------------------------------
// Incremental maintenance (called by the edit applicator inside its txn)
// ---------------------------------------------------------------------------

/**
 * Insert/activate a relationship edge. Idempotent: ON CONFLICT bumps
 * updated_at and last_execution_id so reconciliation can detect the edge
 * was reasserted.
 */
export async function upsertActive(
  client: PoolClient,
  edge: {
    ontologyId: string;
    branchId: string;
    linkTypeApiName: string;
    sourceObjectType: string;
    sourcePrimaryKey: string;
    targetObjectType: string;
    targetPrimaryKey: string;
    executionId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO link_instances
       (ontology_id, branch_id, link_type_api_name,
        source_object_type, source_primary_key,
        target_object_type, target_primary_key,
        updated_at, last_execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT
       (ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key)
     DO UPDATE SET
       updated_at = now(),
       last_execution_id = EXCLUDED.last_execution_id`,
    [
      edge.ontologyId,
      edge.branchId,
      edge.linkTypeApiName,
      edge.sourceObjectType,
      edge.sourcePrimaryKey,
      edge.targetObjectType,
      edge.targetPrimaryKey,
      edge.executionId,
    ],
  );
}

/**
 * Deactivate (delete) a relationship edge. Returns true if a row was
 * removed, false if the edge was already absent. Idempotent.
 */
export async function removeActive(
  client: PoolClient,
  edge: {
    ontologyId: string;
    branchId: string;
    linkTypeApiName: string;
    sourcePrimaryKey: string;
    targetPrimaryKey: string;
  },
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM link_instances
       WHERE ontology_id = $1 AND branch_id = $2
         AND link_type_api_name = $3
         AND source_primary_key = $4
         AND target_primary_key = $5`,
    [
      edge.ontologyId,
      edge.branchId,
      edge.linkTypeApiName,
      edge.sourcePrimaryKey,
      edge.targetPrimaryKey,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Pure ledger-projection logic (unit-testable, no DB)
// ---------------------------------------------------------------------------

/** A single ledger entry in execution order. */
export interface LedgerEntry {
  linkTypeApiName: string;
  sourcePrimaryKey: string;
  targetPrimaryKey: string;
  operation: "add" | "remove";
}

/** An active-edge key, stable per (link type, source, target) tuple. */
export function edgeKey(e: {
  linkTypeApiName: string;
  sourcePrimaryKey: string;
  targetPrimaryKey: string;
}): string {
  return `${e.linkTypeApiName}\u0001${e.sourcePrimaryKey}\u0001${e.targetPrimaryKey}`;
}

/**
 * Compute the active-relationship projection from an ordered ledger of
 * add/remove entries. Mirrors the canonical "net active" derivation that
 * `deleteObjectRule.checkManyToManyLinks` used:
 *     SUM(CASE WHEN op='add' THEN 1 ELSE -1 END) HAVING net > 0 per edge.
 *
 * Returns the SET of active edge keys. Pure — no DB — so this is the
 * single place the active-projection invariant lives and is unit-tested.
 * The transactional maintenance paths (upsertActive/removeActive) and the
 * full rebuild (projectFromLedger) MUST produce a projection identical to
 * what this function returns for the same ledger ordering.
 */
export function computeActiveProjection(
  ledger: LedgerEntry[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of ledger) {
    const key = edgeKey(entry);
    const delta = entry.operation === "add" ? 1 : -1;
    counts.set(key, (counts.get(key) ?? 0) + delta);
  }
  const active = new Set<string>();
  for (const [key, net] of counts) {
    if (net > 0) active.add(key);
  }
  return active;
}

// ---------------------------------------------------------------------------
// Inquiry helpers (set membership form, used by planner/finalStateValidator)
// ---------------------------------------------------------------------------

/**
 * Given an active-edge set (from computeActiveProjection over planned edits
 * earlier in the invocation) plus a persisted-state set, return the merged
 * active set. Used by the planner to merge pending edits with current state
 * without re-deriving from scratch.
 */
export function mergeActiveSets(
  persisted: Set<string>,
  pendingAdds: Set<string>,
  pendingRemoves: Set<string>,
): Set<string> {
  const out = new Set(persisted);
  for (const key of pendingAdds) out.add(key);
  for (const key of pendingRemoves) out.delete(key);
  return out;
}

// ---------------------------------------------------------------------------
// Ledger projection rebuild (idempotent, one-time + reconciliation)
// ---------------------------------------------------------------------------

/**
 * Rebuild `link_instances` from the `link_edit` ledger. Idempotent —
 * safe to run once on migration and again for reconciliation. Processes
 * the ledger in order and applies add (upsert) / remove (delete) so the
 * projection ends up reflecting the net active state.
 *
 * Runs in its own transaction; not used on the execution hot path.
 */
export async function projectFromLedger(
  ontologyId?: string,
  branchId?: string,
): Promise<{ inserted: number; deleted: number }> {
  // Pull the whole ledger ordered by executed_at for the (optionally scoped)
  // ontology/branch. The ledger does NOT carry object types, so we resolve
  // source/target object types from the link_type definition per edge (with
  // a small in-memory cache so high-cardinality bootstraps stay bounded).
  const where: string[] = [];
  const args: unknown[] = [];
  if (ontologyId) {
    args.push(ontologyId);
    where.push(`ontology_id = $${args.length}`);
  }
  if (branchId) {
    args.push(branchId);
    where.push(`branch_id = $${args.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const ledger = await poolQuery(
    `SELECT link_type_api_name, source_primary_key, target_primary_key, operation,
            execution_id, executed_at, ontology_id, branch_id
       FROM link_edit
       ${whereSql}
       ORDER BY executed_at ASC, link_edit_id ASC`,
    args,
  );

  const ltCache = new Map<string, { srcOt: string; tgtOt: string } | null>();
  const resolveOt = async (ont: string, linkApi: string) => {
    const k = `${ont}|${linkApi}`;
    if (ltCache.has(k)) return ltCache.get(k)!;
    let out: { srcOt: string; tgtOt: string } | null = null;
    try {
      const lt = await getLinkType(ont, linkApi);
      if (lt) {
        const srcOt = await resolveObjectTypeApiName(lt.source_object_type).catch(() => "");
        const tgtOt = await resolveObjectTypeApiName(lt.target_object_type).catch(() => "");
        out = { srcOt, tgtOt };
      }
    } catch { /* link_type missing — skip */ }
    ltCache.set(k, out);
    return out;
  };

  let inserted = 0;
  let deleted = 0;
  for (const row of ledger.rows as Array<{
    link_type_api_name: string;
    source_primary_key: string;
    target_primary_key: string;
    operation: string;
    execution_id: string;
    ontology_id: string;
    branch_id: string;
  }>) {
    const ots = await resolveOt(row.ontology_id, row.link_type_api_name);
    if (!ots) continue; // link type unresolved — cannot project this edge
    if (row.operation === "add") {
      await poolQuery(
        `INSERT INTO link_instances
           (ontology_id, branch_id, link_type_api_name,
            source_object_type, source_primary_key,
            target_object_type, target_primary_key,
            updated_at, last_execution_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         ON CONFLICT
           (ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key)
         DO UPDATE SET updated_at = now(), last_execution_id = EXCLUDED.last_execution_id`,
        [
          row.ontology_id,
          row.branch_id,
          row.link_type_api_name,
          ots.srcOt,
          row.source_primary_key,
          ots.tgtOt,
          row.target_primary_key,
          row.execution_id,
        ],
      );
      inserted++;
    } else if (row.operation === "remove") {
      const r = await poolQuery(
        `DELETE FROM link_instances
           WHERE ontology_id = $1 AND branch_id = $2
             AND link_type_api_name = $3
             AND source_primary_key = $4
             AND target_primary_key = $5`,
        [
          row.ontology_id,
          row.branch_id,
          row.link_type_api_name,
          row.source_primary_key,
          row.target_primary_key,
        ],
      );
      if ((r.rowCount ?? 0) > 0) deleted++;
    }
  }

  return { inserted, deleted };
}

// ---------------------------------------------------------------------------
// Reconciliation — projection vs ledger-derived active state (§6)
// ---------------------------------------------------------------------------

/**
 * Reconcile `link_instances` against the canonical active projection
 * derived from the `link_edit` ledger. Returns:
 *   * `ledgerActiveCount` — edges the ledger says should be active
 *   * `projectionCount` — edges currently in link_instances
 *   * `mismatches` — count of edges that disagree (missing from projection
 *     or present in projection but not ledger-active). MUST be zero before
 *     v2 restrict-delete is enabled.
 *
 * Runs a single reconciliation pass; not used on the execution hot path.
 */
export async function reconcileProjection(
  ontologyId?: string,
  branchId?: string,
): Promise<{
  ledgerActiveCount: number;
  projectionCount: number;
  mismatches: number;
  onlyInLedger: number;
  onlyInProjection: number;
}> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (ontologyId) { args.push(ontologyId); where.push(`ontology_id = $${args.length}`); }
  if (branchId) { args.push(branchId); where.push(`branch_id = $${args.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Ledger-derived active edges (canonical net-active computation), in SQL.
  // The ledger carries only PKs (no object types) so the edge key is
  // link|src_pk|tgt_pk; the projection is compared on the same key shape.
  const ledger = await poolQuery(
    `SELECT link_type_api_name, source_primary_key, target_primary_key
       FROM (
         SELECT ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key,
                SUM(CASE WHEN operation = 'add' THEN 1 ELSE -1 END) AS net
           FROM link_edit ${whereSql}
          GROUP BY ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key
       ) le
      WHERE net > 0`,
    args,
  );
  const ledgerActive = new Set<string>();
  for (const r of ledger.rows as Array<{ link_type_api_name: string; source_primary_key: string; target_primary_key: string }>) {
    ledgerActive.add(`${r.link_type_api_name}|${r.source_primary_key}|${r.target_primary_key}`);
  }

  const proj = await poolQuery(
    `SELECT link_type_api_name, source_primary_key, target_primary_key
       FROM link_instances ${whereSql}`,
    args,
  );
  const projection = new Set<string>();
  for (const r of proj.rows as Array<{ link_type_api_name: string; source_primary_key: string; target_primary_key: string }>) {
    projection.add(`${r.link_type_api_name}|${r.source_primary_key}|${r.target_primary_key}`);
  }

  let onlyInLedger = 0;
  let onlyInProjection = 0;
  for (const k of ledgerActive) if (!projection.has(k)) onlyInLedger++;
  for (const k of projection) if (!ledgerActive.has(k)) onlyInProjection++;

  // Phase 8 — observe projection health. Operational alert when > 0;
  // v2 restrict-delete stays fail-closed while isV2ProjectionReady() is false.
  try {
    if (onlyInLedger + onlyInProjection > 0) {
      incCounter("tellus_action_projection_mismatch_total", {
        only_in_ledger: String(onlyInLedger),
        only_in_projection: String(onlyInProjection),
      });
    }
  } catch { /* metrics non-blocking */ }

  return {
    ledgerActiveCount: ledgerActive.size,
    projectionCount: projection.size,
    mismatches: onlyInLedger + onlyInProjection,
    onlyInLedger,
    onlyInProjection,
  };
}

/** Whether the projection is ready for v2 restrict-delete (zero mismatches). */
export async function isProjectionReady(
  ontologyId?: string,
  branchId?: string,
): Promise<boolean> {
  const r = await reconcileProjection(ontologyId, branchId);
  return r.mismatches === 0;
}
