// ---------------------------------------------------------------------------
// src/services/security/provenanceService.ts
//
// FOUNDRY-GAPS §8 — unified "who-touched-this-data" provenance traversal.
//
// Foundry's Data Lineage answers two questions at once for any object:
//   (a) where did this data COME FROM / flow TO?  (dataset lineage graph)
//   (b) who READ it, who WROTE it, and under what AUTHORIZATION?  (audit)
//
// Until now those lived in separate, individually-audited streams:
//   * dataset_lineage      — data-flow edges between foundry_datasets (§6, PB-B8)
//   * action_audit_log     — hash-chained reads (`__read.*`) AND writes (actions)
//   * cbac_decision_log    — every allow/deny authorization decision (mig 037)
//   * access_purpose /
//     purpose_grant        — purpose-based access grants (mig 101)
//
// This service is the missing join: given a single object instance
// (ontology + objectType + primaryKey) it walks all of them and returns one
// coherent provenance record. It is READ-ONLY — it never mutates any stream,
// so it cannot weaken the tamper-evidence of the underlying logs; it only
// correlates them on the object's identity.
//
// Identity keys used to correlate (verified against the live schema):
//   * reads  — action_audit_log rows with action_type_api_name LIKE '__read.%'
//              carry parameters->>'object_type' + parameters->>'primary_key'
//              (+ metadata->>'purpose' from the §8 purpose gate).
//   * writes — non-read action rows carry affected_objects as a JSONB array of
//              {objectType, primaryKey, operation}; matched with the @>
//              containment operator (index-friendly, exact).
//   * access — cbac_decision_log rows are keyed by (ontology_id, resource_kind,
//              resource_id); we correlate the decisions for the action types
//              that actually wrote this object.
//   * lineage— object_type → backing_datasource → foundry_datasets.id, then a
//              bounded recursive walk up- and downstream over dataset_lineage.
// ---------------------------------------------------------------------------

import { query as defaultQuery } from "../../db";

/** Minimal shape of the project's `query` helper, for dependency injection. */
export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number | null }>;

export const DEFAULT_PROVENANCE_LIMIT = 50;
export const MAX_PROVENANCE_LIMIT = 500;
export const DEFAULT_LINEAGE_DEPTH = 5;
export const MAX_LINEAGE_DEPTH = 10;

export interface ProvenanceInput {
  ontologyId: string;
  objectTypeApiName: string;
  primaryKey: string;
  /** Per-stream row cap (reads/writes/decisions). Clamped to MAX_PROVENANCE_LIMIT. */
  limit?: number;
  /** Lineage walk depth in each direction. Clamped to MAX_LINEAGE_DEPTH. */
  lineageDepth?: number;
}

export interface ReadEvent {
  at: string;
  by: string;
  sourceIp: string | null;
  category: string; // object.read | object.search | object.traverse | ...
  purpose: string | null;
  result: string; // success | failed
  route: string | null;
  resultCount: number;
}

export interface WriteEvent {
  at: string;
  by: string;
  sourceIp: string | null;
  action: string; // action_type_api_name
  operation: string | null; // create | update | delete (from affected_objects)
  executionId: string | null;
  branchId: string | null;
  result: string;
  failureType: string | null;
}

export interface AccessDecisionEvent {
  at: string;
  subject: string;
  subjectKind: string;
  decision: "allow" | "deny" | string;
  reason: string;
  resourceKind: string;
  resourceId: string;
  sourceIp: string | null;
}

export interface LineageDatasetNode {
  id: string;
  name: string | null;
}

export interface ProvenanceLineage {
  dataset: LineageDatasetNode | null; // the object type's backing dataset
  upstream: LineageDatasetNode[]; // datasets this one was derived FROM
  downstream: LineageDatasetNode[]; // datasets derived FROM this one
}

export interface PurposeObservation {
  apiName: string;
  displayName: string | null;
  /** Whether the purpose still exists in the catalogue (not archived). */
  active: boolean;
  /** Count of reads of THIS object authorized under the purpose. */
  reads: number;
}

export interface ObjectProvenance {
  object: { ontologyId: string; objectTypeApiName: string; primaryKey: string };
  summary: {
    firstTouchedAt: string | null;
    lastTouchedAt: string | null;
    totalReads: number;
    totalWrites: number;
    distinctReaders: number;
    distinctWriters: number;
    denials: number;
  };
  reads: ReadEvent[];
  writes: WriteEvent[];
  accessDecisions: AccessDecisionEvent[];
  lineage: ProvenanceLineage;
  purposes: PurposeObservation[];
  /** Non-fatal notes (e.g. "no backing dataset — lineage empty"). */
  notes: string[];
}

function clamp(n: number | undefined, def: number, max: number): number {
  if (!Number.isFinite(n as number)) return def;
  return Math.min(Math.max(1, Math.floor(n as number)), max);
}

export class ProvenanceService {
  constructor(private readonly query: QueryFn = defaultQuery) {}

  async getObjectProvenance(input: ProvenanceInput): Promise<ObjectProvenance> {
    const { ontologyId, objectTypeApiName, primaryKey } = input;
    const limit = clamp(input.limit, DEFAULT_PROVENANCE_LIMIT, MAX_PROVENANCE_LIMIT);
    const depth = clamp(input.lineageDepth, DEFAULT_LINEAGE_DEPTH, MAX_LINEAGE_DEPTH);
    const notes: string[] = [];

    const reads = await this.fetchReads(ontologyId, objectTypeApiName, primaryKey, limit);
    const writes = await this.fetchWrites(objectTypeApiName, primaryKey, limit);
    const accessDecisions = await this.fetchAccessDecisions(
      ontologyId,
      Array.from(new Set(writes.map((w) => w.action))),
      limit,
    );
    const lineage = await this.fetchLineage(ontologyId, objectTypeApiName, depth, notes);
    const purposes = await this.fetchPurposes(ontologyId, objectTypeApiName, primaryKey);

    return {
      object: { ontologyId, objectTypeApiName, primaryKey },
      summary: this.summarize(reads, writes, accessDecisions),
      reads,
      writes,
      accessDecisions,
      lineage,
      purposes,
      notes,
    };
  }

  // -- reads (direct object reads under §8 read-audit) ----------------------
  private async fetchReads(
    ontologyId: string,
    ot: string,
    pk: string,
    limit: number,
  ): Promise<ReadEvent[]> {
    const r = await this.query(
      `SELECT executed_at, executed_by, source_ip, result,
              parameters->>'route'   AS route,
              metadata->>'purpose'   AS purpose,
              affected_object_count  AS result_count,
              replace(action_type_api_name, '__read.', '') AS category
         FROM action_audit_log
        WHERE action_type_api_name LIKE '__read.%'
          AND parameters->>'ontology_id' = $1
          AND parameters->>'object_type' = $2
          AND parameters->>'primary_key' = $3
        ORDER BY executed_at DESC
        LIMIT $4`,
      [ontologyId, ot, pk, limit],
    );
    return r.rows.map((row) => ({
      at: new Date(row.executed_at).toISOString(),
      by: row.executed_by ?? "unknown",
      sourceIp: row.source_ip ?? null,
      category: row.category ?? "object.read",
      purpose: row.purpose ?? null,
      result: row.result ?? "success",
      route: row.route ?? null,
      resultCount: Number(row.result_count ?? 0),
    }));
  }

  // -- writes (actions whose affected_objects include this instance) --------
  private async fetchWrites(ot: string, pk: string, limit: number): Promise<WriteEvent[]> {
    // Exact JSONB containment: the row's affected_objects array must contain an
    // element matching {objectType, primaryKey}. The element also carries
    // `operation`, which we pull back out for display.
    const needle = JSON.stringify([{ objectType: ot, primaryKey: pk }]);
    const r = await this.query(
      `SELECT executed_at, executed_by, source_ip, result, failure_type,
              action_type_api_name AS action, execution_id, branch_id,
              (SELECT elem->>'operation'
                 FROM jsonb_array_elements(affected_objects) elem
                WHERE elem->>'objectType' = $1 AND elem->>'primaryKey' = $2
                LIMIT 1) AS operation
         FROM action_audit_log
        WHERE action_type_api_name NOT LIKE '\\_\\_%'
          AND affected_objects @> $3::jsonb
        ORDER BY executed_at DESC
        LIMIT $4`,
      [ot, pk, needle, limit],
    );
    return r.rows.map((row) => ({
      at: new Date(row.executed_at).toISOString(),
      by: row.executed_by ?? "unknown",
      sourceIp: row.source_ip ?? null,
      action: row.action,
      operation: row.operation ?? null,
      executionId: row.execution_id ?? null,
      branchId: row.branch_id ?? null,
      result: row.result ?? "success",
      failureType: row.failure_type ?? null,
    }));
  }

  // -- access-control decisions for the actions that wrote this object ------
  private async fetchAccessDecisions(
    ontologyId: string,
    actionIds: string[],
    limit: number,
  ): Promise<AccessDecisionEvent[]> {
    if (actionIds.length === 0) return [];
    const r = await this.query(
      `SELECT decided_at, subject, subject_kind, decision, reason,
              resource_kind, resource_id, source_ip
         FROM cbac_decision_log
        WHERE ontology_id = $1
          AND resource_kind = 'action_type'
          AND resource_id = ANY($2)
        ORDER BY decided_at DESC
        LIMIT $3`,
      [ontologyId, actionIds, limit],
    );
    return r.rows.map((row) => ({
      at: new Date(row.decided_at).toISOString(),
      subject: row.subject,
      subjectKind: row.subject_kind,
      decision: row.decision,
      reason: row.reason,
      resourceKind: row.resource_kind,
      resourceId: row.resource_id,
      sourceIp: row.source_ip ?? null,
    }));
  }

  // -- data-flow lineage of the object type's backing dataset ---------------
  private async fetchLineage(
    ontologyId: string,
    ot: string,
    depth: number,
    notes: string[],
  ): Promise<ProvenanceLineage> {
    const ds = await this.query(
      `SELECT COALESCE(bd.foundry_dataset_id, fd.id)::text AS dataset_id
         FROM object_type ot
         JOIN backing_datasource bd ON bd.object_type_id = ot.object_type_id
         LEFT JOIN foundry_datasets fd
                ON fd.id = bd.foundry_dataset_id
                OR (fd.file_path IS NOT NULL AND fd.file_path = bd.file_path)
        WHERE ot.ontology_id = $1 AND ot.api_name = $2
          AND COALESCE(bd.foundry_dataset_id, fd.id) IS NOT NULL
        LIMIT 1`,
      [ontologyId, ot],
    );
    const datasetId: string | undefined = ds.rows[0]?.dataset_id;
    if (!datasetId) {
      notes.push(
        "Object type has no backing foundry_datasets row — data-flow lineage is empty (virtual / unregistered object type).",
      );
      return { dataset: null, upstream: [], downstream: [] };
    }

    const [self, upstream, downstream] = await Promise.all([
      this.datasetNode(datasetId),
      this.walkLineage(datasetId, "upstream", depth),
      this.walkLineage(datasetId, "downstream", depth),
    ]);
    return { dataset: self, upstream, downstream };
  }

  private async datasetNode(id: string): Promise<LineageDatasetNode> {
    const r = await this.query(
      `SELECT id::text AS id, name FROM foundry_datasets WHERE id = $1::uuid LIMIT 1`,
      [id],
    );
    return { id, name: r.rows[0]?.name ?? null };
  }

  /**
   * Bounded recursive walk over dataset_lineage. `upstream` follows edges
   * toward the data this dataset was derived from; `downstream` follows edges
   * toward datasets derived from it. The hop bound makes the walk terminate
   * even on a partially-migrated graph that still contains a cycle.
   */
  private async walkLineage(
    datasetId: string,
    direction: "upstream" | "downstream",
    depth: number,
  ): Promise<LineageDatasetNode[]> {
    const startCol = direction === "downstream" ? "upstream_dataset_id" : "downstream_dataset_id";
    const nextCol = direction === "downstream" ? "downstream_dataset_id" : "upstream_dataset_id";
    const r = await this.query(
      `WITH RECURSIVE walk(node, hop) AS (
         SELECT $1::uuid AS node, 0 AS hop
         UNION
         SELECT l.${nextCol}, w.hop + 1
           FROM dataset_lineage l
           JOIN walk w ON l.${startCol} = w.node
          WHERE w.hop < $2
       )
       SELECT DISTINCT fd.id::text AS id, fd.name AS name
         FROM walk w
         JOIN foundry_datasets fd ON fd.id = w.node
        WHERE w.node <> $1::uuid`,
      [datasetId, depth],
    );
    return r.rows.map((row) => ({ id: row.id, name: row.name ?? null }));
  }

  // -- purposes that authorized reads of this object ------------------------
  private async fetchPurposes(
    ontologyId: string,
    ot: string,
    pk: string,
  ): Promise<PurposeObservation[]> {
    const r = await this.query(
      `SELECT metadata->>'purpose' AS purpose, count(*)::int AS reads
         FROM action_audit_log
        WHERE action_type_api_name LIKE '__read.%'
          AND parameters->>'ontology_id' = $1
          AND parameters->>'object_type' = $2
          AND parameters->>'primary_key' = $3
          AND metadata->>'purpose' IS NOT NULL
        GROUP BY 1`,
      [ontologyId, ot, pk],
    );
    if (r.rows.length === 0) return [];

    const apiNames = r.rows.map((row) => row.purpose as string);
    const cat = await this.query(
      `SELECT api_name, display_name
         FROM access_purpose
        WHERE ontology_id = $1 AND api_name = ANY($2) AND archived_at IS NULL`,
      [ontologyId, apiNames],
    );
    const known = new Map<string, string | null>(
      cat.rows.map((row) => [row.api_name as string, (row.display_name as string) ?? null]),
    );
    return r.rows.map((row) => ({
      apiName: row.purpose as string,
      displayName: known.get(row.purpose as string) ?? null,
      active: known.has(row.purpose as string),
      reads: Number(row.reads ?? 0),
    }));
  }

  private summarize(
    reads: ReadEvent[],
    writes: WriteEvent[],
    decisions: AccessDecisionEvent[],
  ): ObjectProvenance["summary"] {
    const times = [...reads.map((r) => r.at), ...writes.map((w) => w.at)].sort();
    return {
      firstTouchedAt: times[0] ?? null,
      lastTouchedAt: times[times.length - 1] ?? null,
      totalReads: reads.length,
      totalWrites: writes.length,
      distinctReaders: new Set(reads.map((r) => r.by)).size,
      distinctWriters: new Set(writes.map((w) => w.by)).size,
      denials: decisions.filter((d) => d.decision === "deny").length,
    };
  }
}

export default ProvenanceService;
