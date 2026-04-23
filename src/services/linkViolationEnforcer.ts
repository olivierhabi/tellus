// ---------------------------------------------------------------------------
// LT-B4 — ONE_TO_ONE violation enforcer
//
// Centralises the policy decision (warn | reject | quarantine) that used
// to be a bare `console.warn` inside the resolver. Called by the Action
// layer (linkRules, editApplicator) *before* committing a link edit, and
// by the resolver *after* reading results so historical violations
// surface as data-quality warnings without breaking the read path.
// ---------------------------------------------------------------------------

import { appError } from "../utils/appError";
import type { LinkTypeRow, ViolationPolicy } from "../models/linkType";
import { insertQuarantineEntry, bumpViolationCounter } from "../models/linkQuarantine";
import { client as osClient } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import { incCounter } from "./funnel/metrics";

// F-P3-04: PG SQLSTATE codes we tolerate as "pre-migration transitional".
// 42P01 = undefined_table. Any other error (including 42703 undefined_column,
// which hid this bug for months) MUST fail loudly — silent catch-all
// swallowing was the direct cause of ONE_TO_ONE / ONE_TO_MANY enforcement
// being dead code.
const PG_UNDEFINED_TABLE = "42P01";

function isTransitionalMissingTable(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return code === PG_UNDEFINED_TABLE;
}

export interface EnforceResult {
  allowed: boolean;
  quarantined: boolean;
  warnings: string[];
  violationId?: string;
}

/**
 * Decide whether an incoming ONE_TO_ONE add is allowed under the
 * link type's configured policy.
 *
 * Returns `{allowed:false}` for `reject` — callers must stop and
 * surface `ONE_TO_ONE_VIOLATION`. Returns `{allowed:true,quarantined:true}`
 * for `quarantine` — the caller proceeds with success but the violation
 * is persisted to link_quarantine. For `warn`, returns
 * `{allowed:true}` with a warning string.
 */
export async function enforceOneToOneAdd(input: {
  linkType: LinkTypeRow;
  ontologyId: string;
  /**
   * F-P3-12: the branch this add is scoped to. REQUIRED — without a
   * branch filter the ONE_TO_ONE / ONE_TO_MANY cardinality check
   * aggregates link_edit rows across every branch of the ontology,
   * so a branch-A write would spuriously conflict with a branch-B
   * write. All cardinality queries below inject `AND branch_id = $N`.
   * Callers that do not know the branch up front must resolve it via
   * `src/services/branchContext.ts:resolveBranchIdOrMain` before
   * entering the enforcer.
   */
  branchId: string;
  sourcePk: string;
  targetPk: string;
  reasonContext?: Record<string, unknown>;
}): Promise<EnforceResult> {
  const { linkType, ontologyId, branchId, sourcePk, targetPk, reasonContext } = input;

  // F-11: ONE_TO_MANY enforcement — a source PK may link to many
  // targets, but a target PK must NOT appear in more than one source.
  // MANY_TO_MANY has no cardinality constraint.
  if (linkType.cardinality === "MANY_TO_MANY") {
    return { allowed: true, quarantined: false, warnings: [] };
  }
  if (linkType.cardinality === "ONE_TO_MANY") {
    return enforceOneToManyAdd(linkType, ontologyId, branchId, sourcePk, targetPk, reasonContext);
  }
  if (linkType.cardinality !== "ONE_TO_ONE") {
    return { allowed: true, quarantined: false, warnings: [] };
  }

  const existingTarget = await findExistingOneToOneTarget(linkType, branchId, sourcePk);
  // No existing target = no conflict. The add is trivially allowed.
  if (!existingTarget || existingTarget === targetPk) {
    return { allowed: true, quarantined: false, warnings: [] };
  }

  // F-06: Default policy changed from "warn" to "reject". A ONE_TO_ONE
  // link must reject duplicate targets by default. Operators can opt in
  // to "warn" or "quarantine" explicitly on a per-link-type basis.
  const policy = (linkType.violation_policy ?? "reject") as ViolationPolicy;
  const reason = {
    policy,
    existing_target_pk: existingTarget,
    attempted_target_pk: targetPk,
    source_pk: sourcePk,
    ...reasonContext,
  };

  switch (policy) {
    case "warn": {
      console.warn(
        `[ONE_TO_ONE_VIOLATION] link '${linkType.api_name}' source=${sourcePk} already links to ${existingTarget}; ignoring new target ${targetPk}`
      );
      // F-P3-04 / Hard Rule §6: Prometheus counter for every enforcement decision.
      incCounter("tellus_link_violation_allowed_total", {
        cardinality: "ONE_TO_ONE",
        policy: "warn",
        link_type: linkType.api_name,
      });
      await bumpViolationCounter(linkType.link_type_id).catch(() => undefined);
      return {
        allowed: true,
        quarantined: false,
        warnings: [
          `ONE_TO_ONE link '${linkType.api_name}' already has target ${existingTarget} for source ${sourcePk}; warn policy kept original.`,
        ],
      };
    }
    case "reject": {
      incCounter("tellus_link_violation_blocked_total", {
        cardinality: "ONE_TO_ONE",
        policy: "reject",
        link_type: linkType.api_name,
      });
      await bumpViolationCounter(linkType.link_type_id).catch(() => undefined);
      throw appError(
        "ONE_TO_ONE_VIOLATION",
        `Link '${linkType.api_name}' already has a target for source '${sourcePk}'. violation_policy=reject.`,
        reason
      );
    }
    case "quarantine": {
      const entry = await insertQuarantineEntry({
        linkTypeId: linkType.link_type_id,
        ontologyId,
        linkTypeApiName: linkType.api_name,
        sourcePk,
        targetPk,
        reason,
      });
      incCounter("tellus_link_violation_allowed_total", {
        cardinality: "ONE_TO_ONE",
        policy: "quarantine",
        link_type: linkType.api_name,
      });
      await bumpViolationCounter(linkType.link_type_id).catch(() => undefined);
      return {
        allowed: true,
        quarantined: true,
        warnings: [
          `ONE_TO_ONE_VIOLATION_QUARANTINED: link '${linkType.api_name}' source ${sourcePk} kept original target ${existingTarget}; conflicting ${targetPk} moved to quarantine.`,
        ],
        violationId: entry.violation_id,
      };
    }
    default: {
      return { allowed: true, quarantined: false, warnings: [] };
    }
  }
}

/**
 * F-11: ONE_TO_MANY enforcement — verify that the target PK is not
 * already claimed by a different source. Uses PG link_edit table
 * (transactional) instead of OpenSearch (eventually consistent).
 */
async function enforceOneToManyAdd(
  linkType: LinkTypeRow,
  ontologyId: string,
  branchId: string,
  sourcePk: string,
  targetPk: string,
  reasonContext?: Record<string, unknown>,
): Promise<EnforceResult> {
  // `ontologyId` is preserved on the signature for future per-ontology
  // scoping hooks even though the current query filters by link_type +
  // branch. Touch it for the linter without changing semantics.
  void ontologyId;
  try {
    // F-P3-04: column is `executed_at`, not `created_at`. The previous
    // `ORDER BY created_at DESC` raised SQLSTATE 42703 on every call and
    // was silently swallowed — enforcement returned `{allowed:true}`
    // unconditionally. See `017_link_type_extensions.sql:143` for the
    // canonical column and its covering index.
    //
    // F-P3-12: `AND branch_id = $3` scopes the cardinality check to the
    // writer's branch. Without this clause a ONE_TO_MANY add on branch
    // A would see branch B's conflicting row and spuriously reject.
    // Matching composite index: `idx_link_edit_type_branch_time` in
    // migration 043.
    const res = await query(
      `SELECT source_primary_key FROM link_edit
       WHERE link_type_api_name = $1
         AND target_primary_key = $2
         AND branch_id = $3
         AND operation = 'add'
       ORDER BY executed_at DESC LIMIT 1`,
      [linkType.api_name, targetPk, branchId]
    );
    if (res.rows.length > 0 && res.rows[0].source_primary_key !== sourcePk) {
      const existingSource = res.rows[0].source_primary_key;
      const policy = (linkType.violation_policy ?? "reject") as ViolationPolicy;
      if (policy === "reject") {
        incCounter("tellus_link_violation_blocked_total", {
          cardinality: "ONE_TO_MANY",
          policy: "reject",
          link_type: linkType.api_name,
        });
        throw appError(
          "ONE_TO_MANY_VIOLATION",
          `Link '${linkType.api_name}' target '${targetPk}' is already linked from source '${existingSource}'. violation_policy=reject.`,
          { existing_source_pk: existingSource, attempted_source_pk: sourcePk, target_pk: targetPk, ...reasonContext }
        );
      }
      // warn or quarantine — allow but surface
      incCounter("tellus_link_violation_allowed_total", {
        cardinality: "ONE_TO_MANY",
        policy,
        link_type: linkType.api_name,
      });
      return {
        allowed: true,
        quarantined: false,
        warnings: [
          `ONE_TO_MANY link '${linkType.api_name}' target ${targetPk} already linked from ${existingSource}; ${policy} policy.`,
        ],
      };
    }
  } catch (e: any) {
    if (e?.code === "ONE_TO_MANY_VIOLATION") throw e;
    if (isTransitionalMissingTable(e)) {
      incCounter("tellus_link_enforcement_degraded_total", {
        reason: "missing_table",
        cardinality: "ONE_TO_MANY",
      });
      return { allowed: true, quarantined: false, warnings: [] };
    }
    // F-P3-04: any other error — undefined_column, permission denied,
    // syntax error — is a real defect. Fail the write with a typed error
    // so the operator sees the regression instead of silently ignoring
    // cardinality.
    incCounter("tellus_link_enforcement_degraded_total", {
      reason: "query_error",
      cardinality: "ONE_TO_MANY",
    });
    throw appError(
      "LINK_ENFORCEMENT_UNAVAILABLE",
      `Cardinality check for link '${linkType.api_name}' failed: ${e?.message ?? "unknown"}`,
      { cause: e?.code ?? e?.message, cardinality: "ONE_TO_MANY" }
    );
  }
  return { allowed: true, quarantined: false, warnings: [] };
}

/**
 * Look up the currently-resolved target PK for a ONE_TO_ONE link.
 * F-06: Uses PG transactional store (link_edit table) instead of
 * OpenSearch, eliminating the race window where concurrent writes
 * could both pass the check. Falls back to OpenSearch-based check
 * if the link_edit table has no data (transitional deployment).
 */
async function findExistingOneToOneTarget(
  linkType: LinkTypeRow,
  branchId: string,
  sourcePk: string
): Promise<string | null> {
  // F-06 + F-P3-04: Try PG (transactional, race-safe) first using the
  // correct `executed_at` column. A bare `catch {}` here used to hide
  // the 42703 column-rename bug; now we only swallow 42P01 (table missing)
  // and surface every other SQLSTATE as a typed error.
  //
  // F-P3-12: `AND branch_id = $3` scopes the lookup to the writer's
  // branch. Composite index `idx_link_edit_type_branch_time`
  // (migration 043) covers the predicate.
  try {
    const pgRes = await query(
      `SELECT target_primary_key FROM link_edit
       WHERE link_type_api_name = $1
         AND source_primary_key = $2
         AND branch_id = $3
         AND operation = 'add'
       ORDER BY executed_at DESC LIMIT 1`,
      [linkType.api_name, sourcePk, branchId]
    );
    if (pgRes.rows.length > 0) {
      return String(pgRes.rows[0].target_primary_key);
    }
  } catch (e: unknown) {
    if (!isTransitionalMissingTable(e)) {
      incCounter("tellus_link_enforcement_degraded_total", {
        reason: "query_error",
        cardinality: "ONE_TO_ONE",
      });
      throw appError(
        "LINK_ENFORCEMENT_UNAVAILABLE",
        `ONE_TO_ONE lookup for link '${linkType.api_name}' failed: ${(e as { message?: string })?.message ?? "unknown"}`,
        { cause: (e as { code?: string })?.code, cardinality: "ONE_TO_ONE" }
      );
    }
    incCounter("tellus_link_enforcement_degraded_total", {
      reason: "missing_table",
      cardinality: "ONE_TO_ONE",
    });
    // link_edit table may not exist yet — fall through to OS
  }

  // Fallback to OpenSearch for transitional deployments
  try {
    if (linkType.source_property_id) {
      const propResult = await query(
        "SELECT api_name FROM property WHERE property_id = $1",
        [linkType.source_property_id]
      );
      if (propResult.rows.length === 0) return null;
      const sourcePropApiName = propResult.rows[0].api_name as string;

      const otResult = await query(
        "SELECT api_name FROM object_type WHERE object_type_id = $1",
        [linkType.source_object_type]
      );
      if (otResult.rows.length === 0) return null;
      const sourceIndex = getIndexName(otResult.rows[0].api_name as string);

      const { body } = await osClient.get({ index: sourceIndex, id: sourcePk });
      const doc = (body as any)._source as Record<string, unknown>;
      const fk = doc?.[sourcePropApiName];
      return fk === null || fk === undefined || fk === "" ? null : String(fk);
    }
    if (linkType.target_property_id) {
      const propResult = await query(
        "SELECT api_name FROM property WHERE property_id = $1",
        [linkType.target_property_id]
      );
      if (propResult.rows.length === 0) return null;
      const targetPropApiName = propResult.rows[0].api_name as string;

      const otResult = await query(
        "SELECT api_name FROM object_type WHERE object_type_id = $1",
        [linkType.target_object_type]
      );
      if (otResult.rows.length === 0) return null;
      const targetIndex = getIndexName(otResult.rows[0].api_name as string);

      const { body } = await osClient.search({
        index: targetIndex,
        body: {
          size: 1,
          query: { term: { [`${targetPropApiName}.keyword`]: sourcePk } },
        },
      });
      const hits = ((body as any).hits?.hits ?? []) as Array<{ _source: Record<string, unknown> }>;
      if (hits.length === 0) return null;
      return String(hits[0]._source.__pk);
    }
  } catch {
    return null;
  }
  return null;
}
