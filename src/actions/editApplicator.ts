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

import { getClient, query } from "../db";
import { client as opensearchClient } from "../services/opensearch/client";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { markEditsAsIndexed } from "../models/ontologyEdit";
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

/** Result of the applyEdits function. */
export interface ApplyResult {
  success: boolean;
  appliedEdits: AppliedEdit[];
  failedEdits: FailedEdit[];
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
      const result = await pgClient.query(
        `INSERT INTO ontology_edit
           (object_type_api_name, primary_key, operation, property_values,
            link_edits, action_type_api_name, execution_id, action_parameters,
            executed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    success: true, // PG transaction succeeded; indexing status is separate
    appliedEdits,
    failedEdits,
    indexingStatus,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { applyEdits };
