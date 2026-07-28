// ---------------------------------------------------------------------------
// Edit Applicator
//
// Stage 6 of the action execution pipeline. Takes compiled edits from the
// Rule Compiler and applies them to both the PostgreSQL edit store and
// OpenSearch.
//
// Atomicity model:
//   - PostgreSQL edit store: transactional (all-or-nothing). Both
//     ontology_edit and link_edit rows are written inside a single PG
//     transaction. If any insert fails, the entire transaction is rolled
//     back and no edits are persisted.
//   - OpenSearch indexing: best-effort, outside the PG transaction. If
//     OpenSearch is unavailable or a document fails to index, the edit
//     remains durably recorded in PostgreSQL with indexed=false and will
//     be picked up on the next reindex. This matches Palantir's Funnel
//     eventual-consistency model between the edit store and the object
//     database.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { getClient, query } from "../db";
import { OntologyError } from "../utils/queryErrors";
import { publishLinkCdc } from "../services/searchAround/cdcLinkProducer";
import { incCounter } from "../services/funnel/metrics";

function genEventId(): string {
  try {
    return require("crypto").randomUUID();
  } catch {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
import { client as opensearchClient } from "../services/opensearch/client";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { markEditsAsIndexed } from "../models/ontologyEdit";
import { writeOverlayForEdit, writeOverlayForLinkEdit } from "../services/overlay/writebackOverlay";
import { isB1Ready } from "../services/funnel/b1Readiness";
import { ensureDocumentSecurity } from "../services/security/documentSecurity";
import { mintObjectRid } from "../services/objectIdentity";
import {
  getByApiName as getLinkType,
  resolveObjectTypeApiName,
} from "../models/linkType";
import {
  upsertActive,
  removeActive,
} from "./relationshipStateRepository";
import { isV2ExecutionEnabled } from "./actionSemanticsFlags";
import { acquireActionLocks, type LockIdentity } from "./actionLockManager";
import type { ActionError } from "./actionErrors";
import type { CompiledEdit, LinkEdit } from "./ruleCompiler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata about the execution, passed by the action executor. */
export interface ApplyExecutionContext {
  executionId: string;
  actionTypeApiName: string;
  parameters: Record<string, unknown>;
  executedBy: string;
  /**
   * F-05: Optimistic concurrency — when set, the PG transaction will
   * SELECT FOR UPDATE the target object_instances row and verify its
   * version matches before applying edits. If the version diverges,
   * the transaction is rolled back and an error is thrown. This
   * eliminates the TOCTOU race that existed when the check lived
   * outside the transaction.
   */
  expectedVersion?: number;
  /** The single (objectType, primaryKey) pair the version check applies to. */
  expectedVersionTarget?: { objectType: string; primaryKey: string };
  /**
   * Ontology that owns the edited object types. Optional for legacy callers.
   * When present, enables the B1/B7 writeback path: each edit also lands in
   * `object_edits`, `object_instances`, and the Writeback Overlay, so edits
   * are visible in search within 1 s independent of Quickwit's commit
   * cadence.
   */
  ontologyId?: string;
  /**
   * F-P3-12 — branch isolation. The UUID of the `ontology_branch` row
   * this write belongs to. REQUIRED: migration 040 promoted
   * `link_edit.branch_id` to NOT NULL + FK, so every link-edit insert
   * must carry a resolved UUID. The caller (normally the executor at
   * `actionExecutor.ts`) is responsible for resolving `context.branchId`
   * to the ontology's `main` branch UUID via
   * `src/services/branchContext.ts:resolveBranchIdOrMain` when the HTTP
   * request omits the header. If this field is missing, TypeScript
   * compilation fails — there is no runtime fallback inside
   * `applyEdits` itself.
   */
  branchId: string;
  /**
   * FNL-H2 — cross-cutting provenance. `correlationId` ties together
   * every edit produced by a single HTTP request; `causationId` links
   * the immediate upstream event; `actionRid` identifies the Action
   * workflow and `eventId` is the per-edit unique id carried on the CDC
   * topic. All optional so legacy callers stay source-compatible.
   */
  correlationId?: string;
  causationId?: string;
  actionRid?: string;
  eventId?: string;
  /**
   * F-P3-11 — durable-before-ack audit. Called AFTER all edits have been
   * inserted into ontology_edit/link_edit/object_instances (inside the
   * same PG transaction) but BEFORE the COMMIT. The hook MUST write the
   * action_audit_log row via insertAuditRowWithHashChain so the audit
   * row + edit rows commit atomically. If the hook throws, the
   * transaction rolls back and the caller sees the thrown error —
   * client ultimately receives 503 Service Unavailable. This is the
   * single place the audit-durability contract lives for the success
   * path; no other branch of the code may skip or defer it.
   */
  preCommitHook?: (client: PoolClient) => Promise<void>;
  /**
   * Action Semantics version of the executing action type (Phase 6).
   * v1: link_instances projection is NOT dual-written (legacy behaviour
   * unchanged — the projection is bootstrapped separately, never
   * incrementally maintained for v1 streams). v2: each M2M link edit
   * also upserts/removes the matching link_instances row inside the same
   * transaction, gated on the version-2 execution feature flag so the
   * projection stays consistent with v2 restrict-delete checks. v1
   * behaviour is preserved exactly when semanticsVersion !== 2 or the
   * flag is off.
   */
  semanticsVersion?: number;
  /**
   * Phase 6 — version-2 transaction invariant. When `semanticsVersion===2`
   * and the v2 execution flag is on, `applyEdits` calls this hook AFTER
   * `BEGIN` + OCC check + advisory/row lock acquisition, but BEFORE any
   * ontology_edit/link_edit insert. The hook reloads canonical active
   * relationship state from `link_instances` (now locked) and re-runs the
   * final-state validator against the reloaded plan. Returns the list of
   * structured errors; non-empty ⇒ the whole action transaction is rolled
   * back (no partial edits) and the first error is thrown to the caller.
   * The v1 path never sets this hook, so v1 behaviour is unchanged.
   */
  v2RevalidateAfterLock?: (client: PoolClient) => Promise<ActionError[]>;
  /**
   * Phase 6 — version-2 lock identities produced by the action planner.
   * Advisory + row locks are acquired for these inside the transaction
   * (deterministic order), before the reload/revalidate step. Only used
   * when `semanticsVersion===2` and the v2 execution flag is on.
   */
  plannedLockIdentities?: LockIdentity[];
}

/** A single successfully applied edit. */
export interface AppliedEdit {
  editId: string;
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
}

/** A single edit that failed during OpenSearch indexing. */
export interface FailedEdit {
  objectType: string;
  primaryKey: string;
  error: string;
}

/**
 * Result of the applyEdits function.
 *
 * `success` reflects whether the PostgreSQL transaction committed. It is
 * always `true` when this result is returned (PG failures throw and roll
 * back, so the caller never sees `success: false` from a normal return).
 *
 * `indexingStatus` reflects OpenSearch indexing outcome:
 *   - "success"  — all edits were indexed in OpenSearch
 *   - "partial"  — some edits failed to index (will be retried by the indexer)
 *   - "failed"   — ALL edits failed to index (data IS durably in PG; OS will
 *                   catch up via the reindex pipeline)
 *
 * Callers should NOT treat `indexingStatus === "failed"` as data loss.
 * The edits are always durable in PostgreSQL when `success` is `true`.
 */
export interface ApplyResult {
  /** Whether the PostgreSQL transaction committed successfully. */
  success: boolean;
  /** Edits that were durably written to PostgreSQL. */
  appliedEdits: AppliedEdit[];
  /** Edits whose OpenSearch indexing failed (PG rows have indexed=false). */
  failedEdits: FailedEdit[];
  /** OpenSearch indexing outcome — separate from PG durability. */
  indexingStatus: "success" | "partial" | "failed";
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Applies compiled edits to the PostgreSQL edit store and OpenSearch.
 *
 * @param edits            - The compiled edits from ruleCompiler.compileRules().
 * @param executionContext  - Metadata about this action execution.
 * @returns ApplyResult with success status, applied/failed edits, and indexing status.
 */
export async function applyEdits(
  edits: CompiledEdit[],
  executionContext: ApplyExecutionContext
): Promise<ApplyResult> {
  if (edits.length === 0) {
    return {
      success: true,
      appliedEdits: [],
      failedEdits: [],
      indexingStatus: "success",
    };
  }

  // -----------------------------------------------------------------
  // Step 1-3: PostgreSQL transaction — write ontology_edit + link_edit
  // -----------------------------------------------------------------

  const appliedEdits: AppliedEdit[] = [];
  // Map from "objectType::primaryKey" to the edit_id for indexed marking
  const editIdMap = new Map<string, string>();

  const pgClient = await getClient();
  try {
    await pgClient.query("BEGIN");

    // F-05: Atomic optimistic concurrency check — inside the PG
    // transaction so no concurrent writer can slip between the read
    // and the write. Tries object_instances first (row-level lock via
    // SELECT FOR UPDATE); if no row exists there (B1 writeback not yet
    // active), falls back to counting ontology_edit rows which always
    // exist and whose count matches OpenSearch's __version (1 after
    // create, +1 per update).
    if (
      executionContext.expectedVersion !== undefined &&
      executionContext.expectedVersionTarget
    ) {
      const { objectType, primaryKey } = executionContext.expectedVersionTarget;
      let currentVersion: number | undefined;

      // Strategy 1: object_instances (B1/B7 writeback table).
      //
      // F-19 FIX: `object_instances.version` is BIGINT; node-postgres
      // returns BIGINT as a STRING by default to avoid precision loss.
      // The strict !== comparison below would ALWAYS fire if we kept
      // the string, because the caller's expectedVersion arrives as a
      // JS number. Normalize via Number() on all three branches so
      // the type never mismatches. Strategy 2 already returned an
      // int thanks to COUNT(*)::int, but belt-and-braces.
      try {
        const vRes = await pgClient.query(
          `SELECT version FROM object_instances
            WHERE object_type_api_name = $1 AND primary_key = $2
            FOR UPDATE`,
          [objectType, primaryKey]
        );
        if ((vRes.rowCount ?? 0) > 0) {
          const raw = vRes.rows[0].version ?? 0;
          currentVersion = Number(raw);
        }
        // rowCount === 0 → no B1 row yet, fall through to strategy 2
      } catch {
        // Table doesn't exist (transitional deployment) → fall through
      }

      // Strategy 2: count ontology_edit rows (always available)
      if (currentVersion === undefined) {
        try {
          const countRes = await pgClient.query(
            `SELECT COUNT(*)::int AS version FROM ontology_edit
              WHERE object_type_api_name = $1 AND primary_key = $2`,
            [objectType, primaryKey]
          );
          currentVersion = Number(countRes.rows[0]?.version ?? 0);
        } catch {
          // ontology_edit table somehow missing — skip check entirely
          currentVersion = undefined;
        }
      }

      if (
        currentVersion !== undefined &&
        currentVersion !== executionContext.expectedVersion
      ) {
        await pgClient.query("ROLLBACK");
        // Do NOT release pgClient here — the finally block at the end
        // of this try/catch handles release unconditionally. Releasing
        // here causes a double-release: throw → catch → ROLLBACK on
        // released client → finally → release() on released client.
        throw new OntologyError(
          `Object '${primaryKey}' of type '${objectType}' has been modified since you last read it. ` +
          `Expected version ${executionContext.expectedVersion}, found ${currentVersion}. Reload and retry.`,
          "CONCURRENCY_CONFLICT",
          409,
          {
            objectType,
            primaryKey,
            expectedVersion: executionContext.expectedVersion,
            currentVersion,
          }
        );
      }
    }

    // -----------------------------------------------------------------
    // Phase 6 — version-2 transaction invariants (advisory + row locks,
    // reload, revalidate final state). Gated on semanticsVersion===2 AND
    // the v2 execution feature flag; the v1 path is unchanged. This runs
    // AFTER BEGIN + OCC, BEFORE any edit insert, so a failed invariant
    // leaves the transaction empty and is rolled back with no partial
    // edits.
    // -----------------------------------------------------------------
    const runV2Invariants =
      executionContext.semanticsVersion === 2 && isV2ExecutionEnabled();
    if (runV2Invariants) {
      if (executionContext.plannedLockIdentities && executionContext.plannedLockIdentities.length > 0) {
        await acquireActionLocks(pgClient, executionContext.plannedLockIdentities);
      }
      if (executionContext.v2RevalidateAfterLock) {
        const revalErrors = await executionContext.v2RevalidateAfterLock(pgClient);
        if (revalErrors.length > 0) {
          await pgClient.query("ROLLBACK");
          const first = revalErrors[0];
          throw new OntologyError(
            first.message,
            first.code,
            undefined,
            { errors: revalErrors.map((e) => ({ code: e.code, path: e.path })), executionId: executionContext.executionId },
          );
        }
      }
    }

    // Step 2: Insert ontology_edit rows
    for (const edit of edits) {
      // F-P3-12 / migration 039+040: resolve the owning ontology BEFORE
      // the INSERT so `ontology_id` and `branch_id` can be supplied as
      // NOT NULL columns. The caller may pass `ontologyId` explicitly;
      // if not, fall back to resolving from the object type. Without
      // this, every action write fails with
      //   null value in column "ontology_id" of relation "ontology_edit"
      //   violates not-null constraint
      // which surfaces as a 500 on /actions/:apiName/apply.
      const ontologyId =
        executionContext.ontologyId ??
        (await resolveOntologyForObjectType(pgClient, edit.objectType));
      if (!ontologyId) {
        throw new OntologyError(
          `Cannot resolve ontology for object type '${edit.objectType}'. ` +
            `The action executor must pass context.ontologyId, or the ` +
            `object type must be registered under exactly one ontology.`,
          "ONTOLOGY_NOT_FOUND",
          400,
          { objectType: edit.objectType }
        );
      }

      // B1: every Action writeback lands in the edit store inside the same
      // DB transaction as the user-visible response. applied_to_merged_at
      // and applied_to_index_at default to NULL — the Funnel will stamp
      // them as it consumes the edit.
      const result = await pgClient.query(
        `INSERT INTO ontology_edit
           (object_type_api_name, primary_key, operation, property_values,
            link_edits, action_type_api_name, execution_id, action_parameters,
            executed_by, edit_strategy, ontology_id, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING edit_id`,
        [
          edit.objectType,
          edit.primaryKey,
          edit.operation,
          edit.propertyValues != null
            ? JSON.stringify(edit.propertyValues)
            : "{}",
          JSON.stringify(edit.linkEdits ?? []),
          executionContext.actionTypeApiName,
          executionContext.executionId,
          JSON.stringify(executionContext.parameters ?? {}),
          executionContext.executedBy,
          "user_edit_wins",
          ontologyId,
          executionContext.branchId,
        ]
      );

      const editId: string = result.rows[0].edit_id;

      appliedEdits.push({
        editId,
        objectType: edit.objectType,
        primaryKey: edit.primaryKey,
        operation: edit.operation,
      });

      editIdMap.set(`${edit.objectType}::${edit.primaryKey}`, editId);

      // B1/B7: in the same transaction, land the edit in `object_edits`,
      // UPSERT `object_instances`, and write the Writeback Overlay so
      // the edit is visible in search within 1 s independent of
      // Quickwit's commit cadence. The spec requires every writeback to
      // land in `object_edits` — we use the `ontologyId` resolved above.
      // We gate this on the boot-time B1-readiness probe so transitional
      // deployments (migrations not yet applied) pay zero per-edit
      // overhead; a savepoint is still used once the tables exist,
      // defending against mid-life drops.
      if (await isB1Ready()) {
        await writeOverlayForEditInTxn(pgClient, {
          ontologyId,
          edit,
          editId,
          actorUserId: executionContext.executedBy,
          correlationId: executionContext.correlationId,
          causationId: executionContext.causationId,
          actionRid: executionContext.actionRid ?? executionContext.actionTypeApiName,
        });
      }

      // Step 6: Insert link_edit rows for many-to-many links
      // (inside the same PG transaction for atomicity).
      //
      // FNL-H2 / LT-B3: carry correlation_id / causation_id / action_rid
      // / actor through to the link_edit row so the downstream CDC
      // producer can emit v2.0.0 Avro payloads with full provenance.
      if (edit.linkEdits && edit.linkEdits.length > 0) {
        for (const linkEdit of edit.linkEdits) {
          await pgClient.query(
            `INSERT INTO link_edit
               (link_type_api_name, source_primary_key, target_primary_key,
                operation, execution_id,
                event_id, schema_version,
                actor_principal_id, action_rid,
                correlation_id, causation_id_uuid,
                ontology_id, branch_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              linkEdit.linkTypeApiName,
              edit.primaryKey,
              linkEdit.targetPrimaryKey,
              linkEdit.operation,
              executionContext.executionId,
              executionContext.eventId ?? genEventId(),
              "2.0.0",
              executionContext.executedBy,
              executionContext.actionRid ?? executionContext.actionTypeApiName,
              executionContext.correlationId ?? null,
              executionContext.causationId ?? null,
              // Migration 039/040: ontology_id + branch_id are NOT NULL on
              // link_edit. ontologyId was resolved at top of this function;
              // branchId is required on the execution context.
              ontologyId,
              executionContext.branchId,
            ]
          );

          incCounter("tellus_link_edit_writes_total", {
            branch_id: executionContext.branchId,
            link_type: linkEdit.linkTypeApiName,
            operation: linkEdit.operation,
          });

          // Phase 6 — link_instances dual-write (v2 only, feature-flagged).
          // The active-state projection must stay consistent with v2
          // restrict-delete EXISTS checks. v1 behaviour is unchanged: no
          // incremental projection. Wrapped in a savepoint so a projection
          // failure (transitional/deferred dependency) never aborts the
          // committed edit — v2 restrict-delete itself stays disabled until
          // the projection bootstrap has been verified (see §6).
          if (
            executionContext.semanticsVersion === 2 &&
            isV2ExecutionEnabled()
          ) {
            await pgClient.query("SAVEPOINT link_instances_dw");
            try {
              const lt = await getLinkType(
                executionContext.ontologyId ?? "",
                linkEdit.linkTypeApiName,
              );
              if (lt) {
                const srcOt = edit.objectType;
                const tgtOt = await resolveObjectTypeApiName(lt.target_object_type).catch(() => null);
                if (tgtOt) {
                  if (linkEdit.operation === "add") {
                    await upsertActive(pgClient, {
                      ontologyId: executionContext.ontologyId ?? "",
                      branchId: executionContext.branchId,
                      linkTypeApiName: linkEdit.linkTypeApiName,
                      sourceObjectType: srcOt,
                      sourcePrimaryKey: edit.primaryKey,
                      targetObjectType: tgtOt,
                      targetPrimaryKey: linkEdit.targetPrimaryKey,
                      executionId: executionContext.executionId,
                    });
                  } else {
                    await removeActive(pgClient, {
                      ontologyId: executionContext.ontologyId ?? "",
                      branchId: executionContext.branchId,
                      linkTypeApiName: linkEdit.linkTypeApiName,
                      sourcePrimaryKey: edit.primaryKey,
                      targetPrimaryKey: linkEdit.targetPrimaryKey,
                    });
                  }
                }
              }
              await pgClient.query("RELEASE SAVEPOINT link_instances_dw");
            } catch (dwErr) {
              await pgClient.query("ROLLBACK TO SAVEPOINT link_instances_dw");
              const dwMsg = dwErr instanceof Error ? dwErr.message : String(dwErr);
              console.warn(
                `[editApplicator] link_instances dual-write skipped for ` +
                  `${linkEdit.linkTypeApiName} ${edit.primaryKey}->` +
                  `${linkEdit.targetPrimaryKey}: ${dwMsg}`,
              );
            }
          }
        }
      }
    }

    // Step 2.5 (F-P3-11): durable-before-ack audit insert BEFORE commit.
    // If the hook throws, the catch block below rolls back — audit and
    // edits are atomic.
    if (executionContext.preCommitHook) {
      await executionContext.preCommitHook(pgClient);
    }

    // Step 3: Commit the PG transaction
    await pgClient.query("COMMIT");
  } catch (err) {
    await pgClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    pgClient.release();
  }

  // B10: publish link_edit rows to the CDC topic. Outside the PG txn so
  // a down Kafka doesn't roll back the edit; if it fails the
  // /api/v1/funnel/clickhouse/cdc-lag endpoint surfaces the drift.
  for (const edit of edits) {
    if (!edit.linkEdits || edit.linkEdits.length === 0) continue;
    for (const linkEdit of edit.linkEdits) {
      // The source-type for a link_edit is the same object type the
      // action modified; link direction is decoupled via source_pk /
      // target_pk columns on the link table.
      //
      // LT-B3: emit full v2.0.0 provenance on the per-link CDC topic.
      const rawOp = (linkEdit.operation ?? "add") as string;
      const op: "ADD" | "REMOVE" | "RETRACT" =
        rawOp === "remove"
          ? "REMOVE"
          : rawOp === "retract"
            ? "RETRACT"
            : "ADD";
      void publishLinkCdc(edit.objectType, linkEdit.linkTypeApiName, {
        source_pk: edit.primaryKey,
        target_pk: linkEdit.targetPrimaryKey,
        link_props: {},
        markings: [],
        schema_version: "2.0.0",
        event_id: genEventId(),
        event_ts_micros: Date.now() * 1000,
        ontology_id: executionContext.ontologyId,
        link_type_api_name: linkEdit.linkTypeApiName,
        operation: op,
        actor_principal_id: executionContext.executedBy,
        action_rid: executionContext.actionRid ?? executionContext.actionTypeApiName ?? null,
        correlation_id: executionContext.correlationId ?? null,
        causation_id: executionContext.causationId ?? null,
        direction: "forward",
      });

      // FNL-H5 — writeback overlay for the link edit so the resolver
      // sees the change immediately even if Quickwit/CH ingestion lags.
      void writeOverlayForLinkEdit({
        linkTypeApiName: linkEdit.linkTypeApiName,
        sourcePk: edit.primaryKey,
        targetPk: linkEdit.targetPrimaryKey,
        operation: op,
        markings: [],
      });
    }
  }

  // -----------------------------------------------------------------
  // Step 4: Apply changes to OpenSearch (best-effort)
  // -----------------------------------------------------------------

  const failedEdits: FailedEdit[] = [];
  const successfulEditIds: string[] = [];

  const bulkBody: Array<Record<string, unknown>> = [];

  for (const edit of edits) {
    const indexName = getIndexName(edit.objectType);
    const now = new Date().toISOString();

    if (edit.operation === "create") {
      // Build the full document including system properties. Phase A4
      // (F-03): every indexed document MUST carry `_security.markings` or
      // it becomes invisible to marking-constrained users after the
      // public-leak branch in buildSecurityFilter was removed. The
      // caller may pre-populate `edit.propertyValues._security` for
      // action types that explicitly classify their output (e.g., seed
      // fixtures that tag some rows as SECRET); otherwise we stamp the
      // default PUBLIC classification via ensureDocumentSecurity.
      const rawDoc: Record<string, unknown> = {
        __pk: edit.primaryKey,
        // Phase 2: stable object rid. Prefer a rid supplied by the
        // caller (e.g. read from object_instances); otherwise mint a
        // fresh one for this newly created object.
        __rid:
          (edit.propertyValues?.__rid as string | undefined) ??
          mintObjectRid(),
        __objectType: edit.objectType,
        __lastModified: now,
        __editedBy: executionContext.executedBy,
        __version: 1,
        // F-P3-13: stamp branch on every create so the read-path
        // security filter's `term: { __branch: ... }` clause matches.
        // The writer boundary guarantees `branchId` is a resolved UUID
        // (see F-P3-12); legacy docs without this field remain visible
        // under the transitional OR clause in `injectSecurityFilter`.
        __branch: executionContext.branchId,
        ...edit.propertyValues,
      };
      const doc = ensureDocumentSecurity(rawDoc);

      bulkBody.push({ index: { _index: indexName, _id: edit.primaryKey } });
      bulkBody.push(doc);
    } else if (edit.operation === "update") {
      // Scripted update: atomically increment __version and merge properties.
      // Uses OpenSearch Painless scripting to ensure the version counter is
      // always incremented exactly once per update, even under concurrency.
      bulkBody.push({ update: { _index: indexName, _id: edit.primaryKey } });
      bulkBody.push({
        script: {
          // F-P3-13: back-fill `__branch` on updates of legacy docs that
          // predate the field, and keep it in sync when an edit moves a
          // document between branches. The `?:` guards the "no existing
          // value" case so a first-ever update on a pre-F-P3-13 doc sets
          // the branch without overwriting a mismatch detected earlier.
          source:
            "ctx._source.__version = (ctx._source.__version ?: 0) + 1; " +
            "ctx._source.__lastModified = params.now; " +
            "ctx._source.__editedBy = params.editedBy; " +
            "ctx._source.__branch = params.branchId; " +
            "for (entry in params.props.entrySet()) { ctx._source[entry.getKey()] = entry.getValue(); }",
          params: {
            now,
            editedBy: executionContext.executedBy,
            branchId: executionContext.branchId,
            props: edit.propertyValues ?? {},
          },
        },
      });
    } else if (edit.operation === "delete") {
      bulkBody.push({ delete: { _index: indexName, _id: edit.primaryKey } });
    }
  }

  // Execute bulk request if there are operations
  if (bulkBody.length > 0) {
    try {
      const { body } = await opensearchClient.bulk({ body: bulkBody });

      const response = body as unknown as {
        errors: boolean;
        items: Array<
          Record<
            string,
            {
              _index: string;
              _id: string;
              status: number;
              result?: string;
              error?: { type: string; reason: string };
            }
          >
        >;
      };

      // Step 5: Process OpenSearch response
      for (let i = 0; i < response.items.length; i++) {
        const item = response.items[i];
        // Each item has exactly one key: "index", "update", or "delete"
        const actionKey = Object.keys(item)[0];
        const action = item[actionKey];
        if (!action) continue;

        // Match back to the original edit
        const matchedEdit = edits[i];
        if (!matchedEdit) continue;

        const editKey = `${matchedEdit.objectType}::${matchedEdit.primaryKey}`;
        const editId = editIdMap.get(editKey);

        // 404 on delete is not a failure — object is already gone
        const isDeleteNotFound =
          actionKey === "delete" && action.status === 404;

        if (action.status >= 400 && !isDeleteNotFound) {
          const errorMsg = action.error
            ? `${action.error.type}: ${action.error.reason}`
            : `HTTP ${action.status}`;

          failedEdits.push({
            objectType: matchedEdit.objectType,
            primaryKey: matchedEdit.primaryKey,
            error: errorMsg,
          });

          console.warn(
            `OpenSearch indexing failed for ${matchedEdit.objectType}/${matchedEdit.primaryKey}: ${errorMsg}`
          );
        } else {
          // Success — mark for indexed update
          if (editId) {
            successfulEditIds.push(editId);
          }
        }
      }
    } catch (err: unknown) {
      // OpenSearch entirely unreachable — all edits fail indexing but
      // PG edits are already committed (eventual consistency)
      const errorMsg =
        err instanceof Error ? err.message : String(err);

      console.error(
        `OpenSearch bulk request failed: ${errorMsg}. ` +
          `${edits.length} edit(s) recorded in PostgreSQL with indexed=false.`
      );

      for (const edit of edits) {
        failedEdits.push({
          objectType: edit.objectType,
          primaryKey: edit.primaryKey,
          error: `OpenSearch unreachable: ${errorMsg}`,
        });
      }
    }
  }

  // Mark successfully indexed edits in PostgreSQL
  if (successfulEditIds.length > 0) {
    try {
      await markEditsAsIndexed(successfulEditIds);
    } catch (err: unknown) {
      // Non-fatal: edits are still recorded, just not marked as indexed.
      // They'll be picked up on the next reindex.
      const errorMsg =
        err instanceof Error ? err.message : String(err);
      console.warn(
        `Failed to mark ${successfulEditIds.length} edit(s) as indexed: ${errorMsg}`
      );
    }
  }

  // Refresh indices to make changes immediately searchable
  if (successfulEditIds.length > 0) {
    const uniqueIndices = new Set(
      edits.map((e) => getIndexName(e.objectType))
    );
    for (const indexName of uniqueIndices) {
      try {
        await opensearchClient.indices.refresh({ index: indexName });
      } catch {
        // Non-fatal: documents become searchable after refresh_interval
      }
    }
  }

  // -----------------------------------------------------------------
  // Step 7: Build and return result
  // -----------------------------------------------------------------

  let indexingStatus: "success" | "partial" | "failed";
  if (failedEdits.length === 0) {
    indexingStatus = "success";
  } else if (failedEdits.length < edits.length) {
    indexingStatus = "partial";
  } else {
    indexingStatus = "failed";
  }

  return {
    // PG transaction committed — all edits are durably stored. OpenSearch
    // indexing is best-effort and tracked separately via indexingStatus.
    // Even when indexingStatus is "failed", data IS persisted in PG and
    // the reindex pipeline will eventually sync it to OpenSearch.
    success: true,
    appliedEdits,
    failedEdits,
    indexingStatus,
  };
}

// ---------------------------------------------------------------------------
// B1/B7 internal helper — writeback into object_edits, object_instances,
// and Writeback Overlay, all inside the caller's transaction.
// ---------------------------------------------------------------------------

async function resolveOntologyForObjectType(
  pgClient: PoolClient,
  objectTypeApiName: string
): Promise<string | undefined> {
  try {
    const res = await pgClient.query(
      "SELECT ontology_id FROM object_type WHERE api_name = $1 LIMIT 1",
      [objectTypeApiName]
    );
    return res.rows[0]?.ontology_id ?? undefined;
  } catch {
    return undefined;
  }
}

interface WriteOverlayInTxnInput {
  ontologyId: string;
  edit: CompiledEdit;
  editId: string;
  actorUserId: string;
  correlationId?: string;
  causationId?: string;
  actionRid?: string;
}

async function writeOverlayForEditInTxn(
  pgClient: PoolClient,
  input: WriteOverlayInTxnInput
): Promise<void> {
  const { edit, editId, ontologyId, actorUserId, correlationId, causationId, actionRid } = input;
  const deleted = edit.operation === "delete";
  const doc = deleted ? {} : edit.propertyValues ?? {};

  // Guard the B1/B7 writeback behind a SAVEPOINT. A missing `object_edits`
  // or `object_instances` table (transitional deployments where migration
  // 012 hasn't run yet) would otherwise abort the enclosing PG transaction
  // and silently kill every subsequent edit — PG leaves the txn in
  // "current transaction is aborted" state until ROLLBACK, so catching
  // the error here wouldn't rescue it. Rolling back to the savepoint
  // preserves the outer txn exactly.
  await pgClient.query("SAVEPOINT b1_writeback");
  try {
    await pgClient.query(
      `INSERT INTO object_edits
         (edit_id, ontology_id, object_type_api_name, primary_key,
          property_api_name, new_value, edit_strategy, actor_user_id,
          created_at, correlation_id, causation_id, action_rid)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'user_edit_wins', $7, NOW(), $8, $9, $10)
       ON CONFLICT (edit_id) DO NOTHING`,
      [
        editId,
        ontologyId,
        edit.objectType,
        edit.primaryKey,
        "*",
        JSON.stringify(doc),
        actorUserId,
        correlationId ?? null,
        causationId ?? null,
        actionRid ?? null,
      ]
    );

    await writeOverlayForEdit(pgClient, {
      ontologyId,
      objectType: edit.objectType,
      primaryKey: edit.primaryKey,
      doc,
      deleted,
      version: 1, // monotonic bump is owned by object_instances UPSERT itself
      editId,
      actorUserId,
    });

    await pgClient.query("RELEASE SAVEPOINT b1_writeback");
  } catch (err) {
    // The B1/B7 writeback is a best-effort performance optimisation
    // (sub-1s edit visibility through the Redis overlay). It MUST NOT
    // fail the Action execution — if the column shape, actor_user_id
    // format, or Redis probe drifts, the user-facing action still has
    // to land its ontology_edit row and return 200. We roll back the
    // savepoint, log, and move on. Quickwit's normal indexing cadence
    // absorbs the edit without the overlay.
    await pgClient.query("ROLLBACK TO SAVEPOINT b1_writeback");
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[editApplicator] B1/B7 overlay writeback skipped for edit ` +
        `${edit.objectType}/${edit.primaryKey}: ${msg}`,
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { applyEdits };
