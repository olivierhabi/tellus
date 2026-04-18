// ---------------------------------------------------------------------------
// Object Data Store Routes — Express Router
//
// GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore
//
// Powers the "Default object data store" summary card next to the
// WorkflowDiagram on the ObjectType detail screen. Collapses pipeline
// state + index replacement state into the three fields the UI renders:
//
//   indexName           canonical target index identifier
//   dataLastWrittenAt   timestamp of the last successful materialization
//   schemaStatus        up_to_date | migrating | out_of_date
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { query } from "../db";
import { getState } from "../models/funnelState";
import { getIndexName } from "../services/opensearch/indexLifecycleManager";
import { sendSuccess, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

async function ontologyExists(ontologyId: string): Promise<boolean> {
  const result = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId],
  );
  return result.rows.length > 0;
}

async function objectTypeExists(
  ontologyId: string,
  apiName: string,
): Promise<boolean> {
  const result = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName],
  );
  return result.rows.length > 0;
}

type ReplacementState =
  | "LIVE"
  | "REPLACEMENT_BACKFILL"
  | "REPLACEMENT_SOAK"
  | "CUTOVER_PENDING"
  | "CUTOVER_COMPLETE"
  | "OLD_INDEX_DROPPED"
  | "ROLLED_BACK";

export interface IndexVersionRow {
  active_version: number;
  pending_version: number | null;
  state: ReplacementState;
  updated_at: string;
}

async function getIndexVersion(
  apiName: string,
): Promise<IndexVersionRow | null> {
  const result = await query(
    `SELECT active_version, pending_version, state, updated_at
       FROM object_type_active_index_version
      WHERE object_type_api_name = $1`,
    [apiName],
  );
  return (result.rows[0] as IndexVersionRow) ?? null;
}

export type SchemaStatus = "up_to_date" | "migrating" | "out_of_date";

// Steady-state object types have no row in object_type_active_index_version —
// rows are only inserted when a replacement is initiated, so "no row" means
// the live schema IS the current schema.
//
// Exported so the mapping is directly unit-testable — see
// `tests/funnel/unit/object-data-store.test.ts`.
export function deriveSchemaStatus(row: IndexVersionRow | null): SchemaStatus {
  if (!row) return "up_to_date";
  switch (row.state) {
    case "LIVE":
    case "CUTOVER_COMPLETE":
    case "OLD_INDEX_DROPPED":
      return "up_to_date";
    case "REPLACEMENT_BACKFILL":
    case "REPLACEMENT_SOAK":
    case "CUTOVER_PENDING":
      return "migrating";
    case "ROLLED_BACK":
      return "out_of_date";
  }
}

router.get("/", async (req: Request, res: Response) => {
  const { ontologyId, apiName } = req.params;

  try {
    if (!(await ontologyExists(ontologyId))) {
      return sendError(
        res,
        "ONTOLOGY_NOT_FOUND",
        `Ontology '${ontologyId}' not found.`,
      );
    }
    if (!(await objectTypeExists(ontologyId, apiName))) {
      return sendError(
        res,
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${apiName}' not found in ontology '${ontologyId}'.`,
      );
    }

    const [pipeline, versionRow] = await Promise.all([
      getState(apiName),
      getIndexVersion(apiName),
    ]);

    return sendSuccess(res, {
      objectTypeApiName: apiName,
      indexName: getIndexName(apiName),
      displayName: "Object Storage V2",
      dataLastWrittenAt: pipeline?.last_indexed_at ?? null,
      pipelineStatus: pipeline?.status ?? "idle",
      schemaStatus: deriveSchemaStatus(versionRow),
      schemaDetail: versionRow
        ? {
            activeVersion: versionRow.active_version,
            pendingVersion: versionRow.pending_version,
            replacementState: versionRow.state,
            updatedAt: versionRow.updated_at,
          }
        : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(
      res,
      "INTERNAL_ERROR",
      `Failed to retrieve data store status: ${message}`,
    );
  }
});

export default router;
