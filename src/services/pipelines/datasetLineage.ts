// ---------------------------------------------------------------------------
// Dataset lineage — PB-B8.
//
// Graph model:
//   * Node = foundry_datasets.id
//   * Edge = (downstream_dataset_id, upstream_dataset_id, edge_type)
//     - `pipeline_output`   : output of a Pipeline-Builder deploy
//       ← each input dataset the deploy read.
//     - `funnel_input`      : Object Type merged dataset
//       ← backing datasource registered on that OT.
//     - `virtual_table`     : admin-registered virtual joins (future).
//
// Cycle detection: insertEdge runs a recursive-CTE walk from the
// prospective `upstream_dataset_id` upward; if the `downstream_dataset_id`
// appears anywhere in the ancestor set we reject with
// LINEAGE_CYCLE_DETECTED. The PK already prohibits self-edges via the
// table-level CHECK, so the CTE only has to worry about multi-hop loops.
//
// Walks are bounded by `depth ≤ 10` per the spec's 500ms SLO on 1000-
// node graphs. The covering index `(upstream_dataset_id) INCLUDE
// (downstream_dataset_id, edge_type)` keeps each hop I/O-free on hot
// pages.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { AppError } from "../../utils/foundryAppError";

export type LineageEdgeType = "pipeline_output" | "funnel_input" | "virtual_table";
export type LineageDirection = "upstream" | "downstream";

export interface LineageEdgeRow {
  downstream_dataset_id: string;
  upstream_dataset_id: string;
  edge_type: LineageEdgeType;
  edge_metadata: Record<string, unknown>;
  created_at: string;
}

export interface LineageNode {
  id: string;
  name?: string | null;
  format?: string | null;
  project_id?: string | null;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: Array<{
    from: string;
    to: string;
    edge_type: LineageEdgeType;
    edge_metadata: Record<string, unknown>;
  }>;
}

export const MAX_LINEAGE_DEPTH = 10;
export const DEFAULT_LINEAGE_DEPTH = 3;

export class DatasetLineageService {
  constructor(private readonly knex: Knex = foundryDb) {}

  /**
   * Insert an edge. Checks for cycles via a recursive CTE BEFORE the
   * insert — throws LINEAGE_CYCLE_DETECTED if the new edge would close
   * one. Idempotent on PK: re-inserting the same (downstream, upstream,
   * edge_type) triple is a no-op.
   */
  async insertEdge(input: {
    downstreamDatasetId: string;
    upstreamDatasetId: string;
    edgeType: LineageEdgeType;
    metadata?: Record<string, unknown>;
  }): Promise<{ inserted: boolean }> {
    if (input.downstreamDatasetId === input.upstreamDatasetId) {
      throw new AppError(
        "Self-loops are not allowed in the lineage graph.",
        400,
        "LINEAGE_CYCLE_DETECTED",
      );
    }

    // Cycle detection: would an edge (downstream ← upstream) close a
    // loop? Walk upward from `upstream`; if `downstream` is reachable,
    // the new edge creates a cycle.
    const cycleCheck = await this.knex.raw(
      `WITH RECURSIVE ancestors(node) AS (
         SELECT ?::uuid
         UNION
         SELECT l.upstream_dataset_id
           FROM dataset_lineage l
           JOIN ancestors a ON l.downstream_dataset_id = a.node
       )
       SELECT 1 FROM ancestors WHERE node = ?::uuid LIMIT 1`,
      [input.upstreamDatasetId, input.downstreamDatasetId],
    );
    const rows = ((cycleCheck as unknown as { rows?: unknown[] }).rows
      ?? (cycleCheck as unknown as unknown[])
      ?? []) as unknown[];
    if (rows.length > 0) {
      const err = new AppError(
        "Inserting this edge would close a lineage cycle.",
        409,
        "LINEAGE_CYCLE_DETECTED",
      );
      (err as unknown as { details?: unknown }).details = {
        downstreamDatasetId: input.downstreamDatasetId,
        upstreamDatasetId: input.upstreamDatasetId,
        edgeType: input.edgeType,
      };
      throw err;
    }

    const res = await this.knex.raw(
      `INSERT INTO dataset_lineage
         (downstream_dataset_id, upstream_dataset_id, edge_type, edge_metadata)
       VALUES (?, ?, ?, ?::jsonb)
       ON CONFLICT (downstream_dataset_id, upstream_dataset_id, edge_type) DO NOTHING
       RETURNING 1`,
      [
        input.downstreamDatasetId,
        input.upstreamDatasetId,
        input.edgeType,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const inserted = ((res as unknown as { rows?: unknown[] }).rows
      ?? (res as unknown as unknown[])
      ?? []) as unknown[];
    return { inserted: inserted.length > 0 };
  }

  /**
   * Walk the lineage graph from `rootId` in `direction` up to `depth`
   * hops. Returns a `LineageGraph` suitable for the frontend's graph
   * renderer. The walker stops at `depth` hops OR when no new nodes
   * are discovered, whichever happens first.
   *
   * Uses the covering `(upstream_dataset_id)` index when walking
   * downstream, and the reverse `(downstream_dataset_id)` index for
   * upstream; both stay cheap at scale.
   */
  async walk(
    rootId: string,
    direction: LineageDirection,
    depth: number = DEFAULT_LINEAGE_DEPTH,
  ): Promise<LineageGraph> {
    const d = Math.min(Math.max(1, Math.floor(depth || DEFAULT_LINEAGE_DEPTH)), MAX_LINEAGE_DEPTH);
    const startCol = direction === "downstream" ? "upstream_dataset_id" : "downstream_dataset_id";
    const nextCol = direction === "downstream" ? "downstream_dataset_id" : "upstream_dataset_id";
    // Recursive CTE bounds the walk at `depth` hops so the planner
    // can short-circuit cycles (though we guard against them on
    // insert, a partially-migrated graph may still contain one).
    const res = await this.knex.raw(
      `WITH RECURSIVE walk(node, hop) AS (
         SELECT ?::uuid AS node, 0 AS hop
         UNION
         SELECT l.${nextCol}, w.hop + 1
           FROM dataset_lineage l
           JOIN walk w ON l.${startCol} = w.node
          WHERE w.hop < ?
       )
       SELECT DISTINCT node FROM walk`,
      [rootId, d],
    );
    const walkRows = (((res as unknown as { rows?: unknown[] }).rows
      ?? (res as unknown as unknown[])
      ?? []) as Array<{ node: string }>);
    const nodeIds = Array.from(new Set(walkRows.map((r) => r.node)));
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // Pull the edges between those nodes only — tight subgraph.
    const edgeRows = await this.knex("dataset_lineage as dl")
      .whereIn("dl.downstream_dataset_id", nodeIds)
      .andWhere((q: Knex.QueryBuilder) => q.whereIn("dl.upstream_dataset_id", nodeIds))
      .select(
        "dl.downstream_dataset_id as downstream_dataset_id",
        "dl.upstream_dataset_id as upstream_dataset_id",
        "dl.edge_type as edge_type",
        "dl.edge_metadata as edge_metadata",
      );
    const nodeRows = await this.knex("foundry_datasets")
      .whereIn("id", nodeIds)
      .select("id", "name", "format", "project_id");
    const nodes: LineageNode[] = nodeIds.map((id) => {
      const row = nodeRows.find((n: { id: string }) => n.id === id);
      return {
        id,
        name: row?.name ?? null,
        format: row?.format ?? null,
        project_id: row?.project_id ?? null,
      };
    });
    const edges = edgeRows.map(
      (e: {
        downstream_dataset_id: string;
        upstream_dataset_id: string;
        edge_type: LineageEdgeType;
        edge_metadata: Record<string, unknown> | string;
      }) => ({
        from: e.upstream_dataset_id,
        to: e.downstream_dataset_id,
        edge_type: e.edge_type,
        edge_metadata:
          typeof e.edge_metadata === "string"
            ? (JSON.parse(e.edge_metadata) as Record<string, unknown>)
            : (e.edge_metadata ?? {}),
      }),
    );
    return { nodes, edges };
  }

  /**
   * For a just-deployed foundry_datasets row, return every Object Type
   * whose backing_datasource points at it. Because
   * `backing_datasource.dataset_id` still FKs to the LEGACY `dataset`
   * table (not `foundry_datasets`), we also match on
   * `backing_datasource.file_path = foundry_datasets.file_path` so
   * OT registrations made through the path-based flow are still
   * discovered. This dual-match keeps PB-B8 auto-fire working across
   * the legacy→foundry datasets migration.
   */
  async findObjectTypesFor(datasetId: string): Promise<Array<{
    ontologyId: string;
    objectTypeApiName: string;
    datasourceId: string;
  }>> {
    // Three matching paths, in preferred-to-fallback order:
    //   1. PB-B8 follow-bd-migrate — `foundry_dataset_id` (new FK).
    //   2. Legacy `dataset_id` — old ontology-engine link.
    //   3. `file_path` equality — catches backing_datasources registered
    //      via the path-based flow that never got a dataset-id hook.
    const rows = await this.knex.raw(
      `SELECT DISTINCT
              ot.ontology_id           AS ontology_id,
              ot.api_name              AS object_type_api_name,
              bd.mapping_id            AS datasource_id
         FROM backing_datasource bd
         JOIN object_type        ot ON ot.object_type_id = bd.object_type_id
         LEFT JOIN foundry_datasets fd ON fd.id = ?::uuid
        WHERE bd.foundry_dataset_id = ?::uuid
           OR bd.dataset_id = ?::uuid
           OR (fd.file_path IS NOT NULL AND bd.file_path = fd.file_path)`,
      [datasetId, datasetId, datasetId],
    );
    const result = ((rows as unknown as { rows?: unknown[] }).rows
      ?? (rows as unknown as unknown[])
      ?? []) as Array<{
        ontology_id: string;
        object_type_api_name: string;
        datasource_id: string;
      }>;
    return result.map((r) => ({
      ontologyId: r.ontology_id,
      objectTypeApiName: r.object_type_api_name,
      datasourceId: r.datasource_id,
    }));
  }

  /** Convenience: list all pipeline_output edges feeding `datasetId`. */
  async inputsFor(datasetId: string): Promise<string[]> {
    const rows = await this.knex("dataset_lineage")
      .where({ downstream_dataset_id: datasetId, edge_type: "pipeline_output" })
      .pluck("upstream_dataset_id");
    return rows as string[];
  }
}
