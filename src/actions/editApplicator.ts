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
import { publishLinkCdc } from "../services/searchAround/cdcLinkProducer";
import { client as opensearchClient } from "../services/opensearch/client";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { markEditsAsIndexed } from "../models/ontologyEdit";
import { writeOverlayForEdit } from "../services/overlay/writebackOverlay";
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
   * Ontology that owns the edited object types. Optional for legacy callers.
   * When present, enables the B1/B7 writeback path: each edit also lands in
   * `object_edits`, `object_instances`, and the Writeback Overlay, so edits
   * are visible in search within 1 s independent of Quickwit's commit
   * cadence.
   */
  ontologyId?: string;
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

    // Step 2: Insert ontology_edit rows
    for (const edit of edits) {
      // B1: every Action writeback lands in the edit store inside the same
      // DB transaction as the user-visible response. applied_to_merged_at
      // and applied_to_index_at default to NULL — the Funnel will stamp
      // them as it consumes the edit.
      const result = await pgClient.query(
        `INSERT INTO ontology_edit
           (object_type_api_name, primary_key, operation, property_values,
            link_edits, action_type_api_name, execution_id, action_parameters,
            executed_by, edit_strategy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      // UPSERT `object_instances`, and write the Writeback Overlay so the
      // edit is visible in search within 1 s independent of Quickwit's
      // commit cadence. The spec requires every writeback to land in
      // `object_edits` — resolve the owning ontology from the object type
      // when the caller didn't pass one. The helper tolerates missing B1
      // tables so this is safe in transitional deployments.
      const ontologyId =
        executionContext.ontologyId ??
        (await resolveOntologyForObjectType(pgClient, edit.objectType));
      if (ontologyId) {
        await writeOverlayForEditInTxn(pgClient, {
          ontologyId,
          edit,
          editId,
          actorUserId: executionContext.executedBy,
        });
      }

      // Step 6: Insert link_edit rows for many-to-many links
      // (inside the same PG transaction for atomicity)
      if (edit.linkEdits && edit.linkEdits.length > 0) {
        for (const linkEdit of edit.linkEdits) {
          await pgClient.query(
            `INSERT INTO link_edit
               (link_type_api_name, source_primary_key, target_primary_key,
                operation, execution_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              linkEdit.linkTypeApiName,
              edit.primaryKey,
              linkEdit.targetPrimaryKey,
              linkEdit.operation,
              executionContext.executionId,
            ]
          );
        }
      }
    }

    // Step 3: Commit the PG transaction
    await pgClient.query("COMMIT");
  } catch (err) {
    await pgClient.query("ROLLBACK");
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
      void publishLinkCdc(edit.objectType, linkEdit.linkTypeApiName, {
        source_pk: edit.primaryKey,
        target_pk: linkEdit.targetPrimaryKey,
        link_props: {},
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
      // Build the full document including system properties
      const doc: Record<string, unknown> = {
        __pk: edit.primaryKey,
        __objectType: edit.objectType,
        __lastModified: now,
        __editedBy: executionContext.executedBy,
        __version: 1,
        ...edit.propertyValues,
      };

      bulkBody.push({ index: { _index: indexName, _id: edit.primaryKey } });
      bulkBody.push(doc);
    } else if (edit.operation === "update") {
      // Scripted update: atomically increment __version and merge properties.
      // Uses OpenSearch Painless scripting to ensure the version counter is
      // always incremented exactly once per update, even under concurrency.
      bulkBody.push({ update: { _index: indexName, _id: edit.primaryKey } });
      bulkBody.push({
        script: {
          source:
            "ctx._source.__version = (ctx._source.__version ?: 0) + 1; " +
            "ctx._source.__lastModified = params.now; " +
            "ctx._source.__editedBy = params.editedBy; " +
            "for (entry in params.props.entrySet()) { ctx._source[entry.getKey()] = entry.getValue(); }",
          params: {
            now,
            editedBy: executionContext.executedBy,
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
}

async function writeOverlayForEditInTxn(
  pgClient: PoolClient,
  input: WriteOverlayInTxnInput
): Promise<void> {
  const { edit, editId, ontologyId, actorUserId } = input;
  const deleted = edit.operation === "delete";
  const doc = deleted ? {} : edit.propertyValues ?? {};

  // Insert an object_edits summary row. One row per compiled edit keeps the
  // B6 Indexing activity able to mark the whole object's edit as applied
  // with a single UPDATE by edit_id. Per-property granularity lives in the
  // legacy `ontology_edit` table for now.
  try {
    await pgClient.query(
      `INSERT INTO object_edits
         (edit_id, ontology_id, object_type_api_name, primary_key,
          property_api_name, new_value, edit_strategy, actor_user_id,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'user_edit_wins', $7, NOW())
       ON CONFLICT (edit_id) DO NOTHING`,
      [
        editId,
        ontologyId,
        edit.objectType,
        edit.primaryKey,
        "*",
        JSON.stringify(doc),
        actorUserId,
      ]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*object_edits.* does not exist/i.test(msg)) {
      return; // transitional deployment — skip B1/B7 wiring
    }
    throw err;
  }

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
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { applyEdits };
