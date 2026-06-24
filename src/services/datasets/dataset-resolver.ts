// ---------------------------------------------------------------------------
// Dataset resolution — maps a dataset RID to its identity and (when present)
// the producer that materialised its data.
//
// A Foundry Dataset is identified solely by its RID and can be referenced from
// any app on the platform. Two independent facts back a dataset:
//   1. Identity — the Compass `resources` row (name + parent folder), created
//      by the Create Dataset API. Sync-generated dataset RIDs may not have one.
//   2. Producer — what wrote the data. Today that is a table-import (sync) whose
//      `dataset_rid` points at this RID; it yields the Iceberg coordinates the
//      preview reads. This is the single seam to extend for other producers
//      (uploads, pipelines) without changing callers.
//
// Resolution is producer-agnostic at the call site: the preview/get handlers
// ask for a ResolvedDataset and render identity + (optional) data uniformly.
// ---------------------------------------------------------------------------

import { pool } from "../../db";

export interface DatasetProducer {
  kind: "sync";
  importRid: string;
  /** JdbcImportConfig: { schema, table, mode, targetTable?, warehouseRoot?, ... } */
  config: Record<string, unknown>;
  status: { state?: string } | null;
  connectionRid: string;
  connectionName: string | null;
  tenant: string;
  displayName: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
}

/**
 * The `foundry_datasets` row backing a dataset RID, when one exists. This is the
 * Compass-visible registry both file uploads and sync outputs write to, so it is
 * the single authority for a dataset's origin shape (uploaded file vs Iceberg
 * sync output) and for its committed metadata (row count, size, timestamps).
 */
export interface DatasetRegistry {
  id: string;
  name: string | null;
  filePath: string | null;
  originalFilename: string | null;
  format: string | null;
  status: string | null;
  rowCount: number | null;
  fileSizeBytes: number | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  createdBy: string | null;
  projectId: string | null;
}

/** The producing pipeline of an output dataset, when one can be resolved. */
export interface PipelineLink {
  pipelineRid: string;
  pipelineName: string | null;
  projectId: string | null;
}

/**
 * How a dataset's data came to exist — the platform analogue of Foundry's
 * "Updated via" provenance. A discriminated union so callers render the right
 * affordance (e.g. link to the producing data-connection) without re-deriving
 * the origin from loose fields. `pipeline` is reserved for the build producer
 * that does not yet flow through this resolver.
 */
export type DatasetProvenance =
  | {
      kind: "data-connection";
      label: string;
      mode: string | null;
      sourceRid: string;
      sourceName: string | null;
      schema: string | null;
      table: string | null;
      importRid: string;
    }
  | {
      kind: "file-import";
      label: string;
      originalFilename: string | null;
      format: string | null;
    }
  | {
      kind: "pipeline";
      label: string;
      pipelineRid: string | null;
      pipelineName: string | null;
      projectId: string | null;
    }
  | { kind: "manual"; label: string }
  | { kind: "unknown"; label: string };

export interface ResolvedDataset {
  rid: string;
  /** Compass display name (identity) when the dataset has a resources row. */
  name: string | null;
  parentFolderRid: string | null;
  producer: DatasetProducer | null;
  /** `foundry_datasets` origin/metadata row, when the RID is registered. */
  registry: DatasetRegistry | null;
  /** Derived origin of the dataset's data — never null (defaults to manual). */
  provenance: DatasetProvenance;
}

/** Last dot-segment of a Foundry RID is its UUID (segments are dot-joined). */
function ridUuid(rid: string): string {
  return rid.split(".").pop() ?? rid;
}

const PIPELINE_RID_PREFIX = "ri.foundry.main.pipeline.";

/** True for a `foundry_datasets.file_path` produced by a pipeline deploy. */
function isPipelineOutputPath(filePath: string | null | undefined): boolean {
  return !!filePath && filePath.includes("/pipeline-outputs/");
}

/**
 * Resolve the producing pipeline of an output dataset from its object path.
 * Pipeline deploys write to `projects/<projectId>/pipeline-outputs/<pipelineId>/…`
 * (see deploymentService), so the projectId + pipelineId are encoded in the
 * path. Best-effort: returns the link with whatever it can determine, and the
 * pipeline name when the row still exists.
 */
async function resolvePipelineLink(filePath: string): Promise<PipelineLink | null> {
  const m = /(?:^|\/)projects\/([^/]+)\/pipeline-outputs\/([^/]+)\//.exec(filePath);
  if (!m) return null;
  const [, projectId, pipelineId] = m;
  const r = await pool.query<{ name: string }>(
    `SELECT name FROM pipelines WHERE id = $1`,
    [pipelineId],
  );
  return {
    pipelineRid: PIPELINE_RID_PREFIX + pipelineId,
    pipelineName: r.rows[0]?.name ?? null,
    projectId,
  };
}

/**
 * Derive the dataset's provenance from its producer + registry row. Order of
 * precedence mirrors Foundry's "last writer wins" for the Updated-via field:
 *   1. A sync producer (table-import) → Data connection (+ CDC when streaming).
 *   2. Else a non-Iceberg registry row → a manually uploaded file.
 *   3. Else an Iceberg registry row with no producer → orphaned sync output.
 *   4. Else identity-only (Create Dataset API, no data yet) → manual/empty.
 */
function computeProvenance(
  producer: DatasetProducer | null,
  registry: DatasetRegistry | null,
  pipelineLink: PipelineLink | null,
): DatasetProvenance {
  if (producer) {
    const cfg = producer.config ?? {};
    const mode = (cfg.mode as string | undefined) ?? null;
    return {
      kind: "data-connection",
      label: mode === "cdc" ? "Data connection (CDC)" : "Data connection",
      mode,
      sourceRid: producer.connectionRid,
      sourceName: producer.connectionName,
      schema: (cfg.schema as string | undefined) ?? null,
      table:
        (cfg.table as string | undefined) ??
        (cfg.targetTable as string | undefined) ??
        null,
      importRid: producer.importRid,
    };
  }
  if (registry) {
    const fp = registry.filePath ?? "";
    // Iceberg-backed but no surviving import (e.g. the import was deleted).
    if (fp.startsWith("iceberg://")) return { kind: "unknown", label: "Unknown source" };
    // Bytes written by a pipeline deploy → a pipeline build, NOT a manual upload.
    if (isPipelineOutputPath(fp)) {
      return {
        kind: "pipeline",
        label: "Pipeline build",
        pipelineRid: pipelineLink?.pipelineRid ?? null,
        pipelineName: pipelineLink?.pipelineName ?? null,
        projectId: pipelineLink?.projectId ?? registry.projectId ?? null,
      };
    }
    // Any other stored object is a manually uploaded file.
    return {
      kind: "file-import",
      label: "Manual upload",
      originalFilename: registry.originalFilename ?? registry.name ?? null,
      format: registry.format ?? null,
    };
  }
  return { kind: "manual", label: "Not built yet" };
}

/** True for RIDs this resolver claims: `ri.foundry.main.dataset.<locator>`. */
export function isFoundryDatasetRid(rid: string): boolean {
  return /^ri\.foundry\.main\.dataset\.[A-Za-z0-9._-]+$/.test(rid);
}

/**
 * Resolve a dataset RID to its identity + producer. Returns null only when the
 * RID is unknown to BOTH the resource tree and every producer (→ DatasetNotFound).
 */
export async function resolveDataset(
  datasetRid: string,
): Promise<ResolvedDataset | null> {
  // The three lookups are independent — run them in one round-trip via
  // Promise.all instead of three sequential awaits (latency at scale).
  //   1. Identity from the Compass resource tree (Create Dataset API output).
  const identP = pool.query<{
    name: string;
    parent_folder_rid: string | null;
  }>(
    `SELECT display_name AS name, parent_folder_rid
       FROM resources
      WHERE rid = $1 AND type = 'DATASET' AND trash_status = 'NOT_TRASHED'`,
    [datasetRid],
  );

  // 2. Producer: the most-recent table-import that targets this dataset RID.
  const prodP = pool.query<{
    import_rid: string;
    config: Record<string, unknown>;
    status: { state?: string } | null;
    connection_rid: string;
    connection_name: string | null;
    tenant: string | null;
    display_name: string;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string;
  }>(
    `SELECT ti.rid AS import_rid, ti.config, ti.status, ti.connection_rid,
            ti.display_name, ti.created_at, ti.updated_at, ti.created_by,
            c.name AS connection_name, c.tenant AS tenant
       FROM table_imports ti
       LEFT JOIN connectivity_connections c ON c.rid = ti.connection_rid
      WHERE ti.dataset_rid = $1 AND ti.deleted_at IS NULL
      ORDER BY ti.created_at DESC
      LIMIT 1`,
    [datasetRid],
  );

  // 3. Registry: the `foundry_datasets` row (origin shape + committed metadata).
  //    Present for both uploads and sync outputs; the single authority for a
  //    dataset's origin and a fallback for identity/metadata when there is no
  //    Compass `resources` row (sync-generated RIDs often have none).
  const regP = pool.query<{
    id: string;
    name: string | null;
    file_path: string | null;
    original_filename: string | null;
    format: string | null;
    status: string | null;
    row_count: string | number | null;
    row_count_exact: string | number | null;
    file_size_bytes: string | number | null;
    created_at: Date | string | null;
    updated_at: Date | string | null;
    created_by: string | null;
    project_id: string | null;
  }>(
    `SELECT id::text AS id, name, file_path, original_filename, format, status,
            row_count, row_count_exact, file_size_bytes,
            created_at, updated_at, created_by::text AS created_by,
            project_id::text AS project_id
       FROM foundry_datasets
      WHERE id = $1`,
    [ridUuid(datasetRid)],
  );

  const [ident, prod, reg] = await Promise.all([identP, prodP, regP]);
  const identity = ident.rows[0] ?? null;
  const p = prod.rows[0] ?? null;
  const rr = reg.rows[0] ?? null;

  if (!identity && !p && !rr) return null;

  const producer: DatasetProducer | null = p
    ? {
        kind: "sync",
        importRid: p.import_rid,
        config: p.config,
        status: p.status,
        connectionRid: p.connection_rid,
        connectionName: p.connection_name,
        tenant: p.tenant ?? "default",
        displayName: p.display_name,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        createdBy: p.created_by,
      }
    : null;

  const registry: DatasetRegistry | null = rr
    ? {
        id: rr.id,
        name: rr.name,
        filePath: rr.file_path,
        originalFilename: rr.original_filename,
        format: rr.format,
        status: rr.status,
        rowCount:
          rr.row_count_exact != null
            ? Number(rr.row_count_exact)
            : rr.row_count != null
              ? Number(rr.row_count)
              : null,
        fileSizeBytes: rr.file_size_bytes != null ? Number(rr.file_size_bytes) : null,
        createdAt: rr.created_at,
        updatedAt: rr.updated_at,
        createdBy: rr.created_by,
        projectId: rr.project_id,
      }
    : null;

  // Only an output-without-producer needs its producing pipeline resolved.
  const pipelineLink =
    !producer && registry && isPipelineOutputPath(registry.filePath)
      ? await resolvePipelineLink(registry.filePath!)
      : null;

  return {
    rid: datasetRid,
    name: identity?.name ?? p?.display_name ?? registry?.name ?? null,
    parentFolderRid: identity?.parent_folder_rid ?? null,
    producer,
    registry,
    provenance: computeProvenance(producer, registry, pipelineLink),
  };
}

/** Latest build for an import — authoritative row count + last-update time. */
export async function latestBuildForImport(importRid: string): Promise<{
  rid: string;
  status: string;
  endedAt: Date | string | null;
  rowsWritten: number | null;
} | null> {
  const r = await pool.query<{
    rid: string;
    status: string;
    ended_at: Date | string | null;
    rows_written: string | number | null;
  }>(
    `SELECT rid, status, ended_at, rows_written
       FROM orchestration_builds
      WHERE import_rid = $1
      ORDER BY enqueued_at DESC
      LIMIT 1`,
    [importRid],
  );
  const b = r.rows[0];
  if (!b) return null;
  return {
    rid: b.rid,
    status: b.status,
    endedAt: b.ended_at,
    rowsWritten: b.rows_written != null ? Number(b.rows_written) : null,
  };
}
