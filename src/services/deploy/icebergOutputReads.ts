// ---------------------------------------------------------------------------
// Iceberg sidecar output reads (extracted from services/deploymentService.ts
// during the god-file breakup — behavior-preserving move).
//
// The DeploymentService's time-travel surface (listOutputSnapshots /
// readOutputAsOf) is a thin wrapper over the PyIceberg sidecar: load the
// pipeline row, gate on output_format === 'iceberg', resolve the Lakekeeper
// warehouse/namespace for the pipeline's leaf table, then delegate to the
// sidecar action. Keeping that in one focused module makes the ref
// derivation unit-testable without booting the deployment service.
// ---------------------------------------------------------------------------

import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';
import {
  pipelineNamespace,
  PIPELINE_LEAF_TABLE,
  slugForNamespace,
} from '../pipelines/icebergNamespace';

export interface PipelineIcebergRef {
  warehouse: string;
  namespace: string;
  table: string;
}

/**
 * Derive the Iceberg location of a pipeline's output leaf table. Pure —
 * deterministic function of (projectId, pipeline name/id) plus the
 * LAKEKEEPER_PIPELINE_WAREHOUSE env override.
 */
export function pipelineOutputIcebergRef(
  projectId: string,
  pipelineId: string,
  pipeline: { name?: unknown },
): PipelineIcebergRef {
  const warehouse =
    process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? 'tellus-pipeline';
  const projectSlug = slugForNamespace(
    `proj_${projectId.replace(/-/g, '').slice(0, 12)}`,
  );
  const pipelineSlug = slugForNamespace(
    `${(pipeline.name ?? 'pipe').toString()}_${pipelineId.replace(/-/g, '').slice(0, 8)}`,
  );
  return { warehouse, namespace: pipelineNamespace(projectSlug, pipelineSlug), table: PIPELINE_LEAF_TABLE };
}

type PipelineRow = { name?: unknown; output_format?: string } | undefined;

async function loadPipelineOrThrow(
  knex: Knex,
  projectId: string,
  pipelineId: string,
): Promise<NonNullable<PipelineRow>> {
  const pipeline = await knex('pipelines')
    .where({ id: pipelineId, project_id: projectId })
    .first();
  if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
  return pipeline;
}

/**
 * PB-B4 — list Iceberg snapshots for the pipeline's output table. Each
 * row has (snapshot_id, parent_id, timestamp_ms, operation, summary).
 * When output_format != 'iceberg' this is an empty list (we do not
 * pretend there's an Iceberg history).
 */
export async function listPipelineOutputSnapshots(
  knex: Knex,
  projectId: string,
  pipelineId: string,
): Promise<{ snapshots: Array<Record<string, unknown>> }> {
  const pipeline = await loadPipelineOrThrow(knex, projectId, pipelineId);
  if (pipeline.output_format !== 'iceberg') {
    return { snapshots: [] };
  }
  const ref = pipelineOutputIcebergRef(projectId, pipelineId, pipeline);
  const { icebergSnapshots } = await import('../pipelines/icebergSidecar');
  const { snapshots } = await icebergSnapshots({
    warehouse: ref.warehouse,
    namespace: ref.namespace,
    table: ref.table,
  });
  return { snapshots: snapshots as unknown as Array<Record<string, unknown>> };
}

/**
 * PB-B4 — time-travel scan. Returns rows at a specific snapshot_id
 * (or latest if omitted). This wraps the sidecar's scan_as_of action
 * which routes through PyIceberg's scan API; the spec also allows
 * DuckDB's iceberg_scan as a read path but on this binding that is
 * read-only and slower, so the sidecar owns this for now.
 */
export async function readPipelineOutputAsOf(
  knex: Knex,
  projectId: string,
  pipelineId: string,
  opts: { snapshotId?: number | string; limit?: number } = {},
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number }> {
  const pipeline = await loadPipelineOrThrow(knex, projectId, pipelineId);
  if (pipeline.output_format !== 'iceberg') {
    throw new AppError(
      "Time-travel scans are only supported on Iceberg-backed pipelines.",
      400,
      'OUTPUT_NOT_ICEBERG',
    );
  }
  const ref = pipelineOutputIcebergRef(projectId, pipelineId, pipeline);
  const { icebergScanAsOf } = await import('../pipelines/icebergSidecar');
  const res = await icebergScanAsOf({
    warehouse: ref.warehouse,
    namespace: ref.namespace,
    table: ref.table,
    snapshotId: opts.snapshotId,
    limit: opts.limit,
  });
  return {
    columns: res.columns,
    rows: res.rows,
    rowCount: res.row_count,
  };
}
