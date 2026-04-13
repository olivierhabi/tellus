import { Knex } from 'knex';
import { uploadObject } from './storageService';
import { TransformService } from './transformService';
import { AppError } from '../utils/foundryAppError';

// ─── CSV Serialization (RFC 4180) ───────────────────────────────────────────

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsvBuffer(
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): Buffer {
  const header = columns.map((c) => escapeCsvField(c.name)).join(',');
  const lines = [header];
  for (const row of rows) {
    const line = columns.map((c) => escapeCsvField(row[c.name])).join(',');
    lines.push(line);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf-8');
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface BuildResult {
  nodeId: string;
  nodeLabel: string;
  datasetId: string;
  datasetName: string;
  filePath: string;
  rowCount: number;
  columnCount: number;
  status: 'succeeded' | 'failed';
  error?: string;
  durationMs: number;
}

export interface DeployPipelineInput {
  outputNodeIds?: string[];
}

// ─── DeploymentService ──────────────────────────────────────────────────────
//
// Async deployment pattern:
//
//   1. POST /deploy → creates deployment record (status: 'running'), returns
//      immediately with { deploymentId, status: 'running' }.
//   2. Builds run in the background (fire-and-forget).
//   3. Frontend polls GET /deployments/:id every 2s to get current status.
//   4. When builds finish, deployment record is updated to 'succeeded'/'failed'.
//
// This prevents HTTP timeouts on large datasets and gives the UI real-time
// progress visibility.

export class DeploymentService {
  constructor(
    private knex: Knex,
    private transformService: TransformService,
  ) {}

  /**
   * Start a deployment — creates the record and kicks off builds in background.
   * Returns immediately with the deployment ID so the frontend can poll.
   */
  async startDeployment(
    projectId: string,
    pipelineId: string,
    triggeredBy: string,
    input: DeployPipelineInput,
  ): Promise<{
    deploymentId: string;
    status: string;
    startedAt: string;
    outputCount: number;
  }> {
    // Validate pipeline
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');

    // Find output nodes
    const allNodes = await this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId })
      .select('*');

    let outputNodes = allNodes.filter((n: { node_type: string }) => n.node_type === 'output');
    if (input.outputNodeIds && input.outputNodeIds.length > 0) {
      const selectedSet = new Set(input.outputNodeIds);
      outputNodes = outputNodes.filter((n: { id: string }) => selectedSet.has(n.id));
    }

    if (outputNodes.length === 0) {
      throw new AppError(
        'No output nodes to build. Add at least one output node to the pipeline.',
        400,
        'NO_OUTPUTS',
      );
    }

    // Create deployment record
    const startedAt = new Date();
    const [deployment] = await this.knex('pipeline_deployments')
      .insert({
        pipeline_id: pipelineId,
        project_id: projectId,
        status: 'running',
        triggered_by: triggeredBy,
        started_at: startedAt.toISOString(),
        config: JSON.stringify({
          selectedOutputs: outputNodes.map((n: { id: string; label: string }) => ({
            id: n.id,
            label: n.label,
          })),
        }),
      })
      .returning('*');

    // Fire-and-forget: run builds in background
    this.executeBuild(projectId, pipelineId, deployment.id, triggeredBy, outputNodes, pipeline)
      .catch((err) => {
        console.error(`[DeploymentService] Background build failed for deployment ${deployment.id}:`, err);
      });

    return {
      deploymentId: deployment.id,
      status: 'running',
      startedAt: startedAt.toISOString(),
      outputCount: outputNodes.length,
    };
  }

  /**
   * Background build execution — runs after startDeployment returns.
   * Updates the deployment record as builds complete.
   */
  private async executeBuild(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
    triggeredBy: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputNodes: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipeline: any,
  ): Promise<void> {
    const startedAt = Date.now();
    const buildResults: BuildResult[] = [];

    for (const outputNode of outputNodes) {
      const buildStart = Date.now();
      const cfg = typeof outputNode.config === 'string'
        ? JSON.parse(outputNode.config)
        : (outputNode.config ?? {});

      try {
        // Resolve upstream data
        let data: { columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>>; totalRows: number };
        try {
          data = await this.transformService.outputPreview(
            projectId, pipelineId, outputNode.id, 100_000,
          );
        } catch (resolveErr) {
          const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
          if (msg.includes('NO_DATASET') || msg.includes('no associated dataset')) {
            throw new Error(
              `Cannot build "${outputNode.label}": upstream join/union node hasn't been applied. ` +
              `Open the join/union node and click "Apply" before deploying.`
            );
          }
          throw resolveErr;
        }

        if (data.rows.length === 0) {
          throw new Error('Upstream chain produced zero rows');
        }

        // Serialize to CSV
        const csvBuffer = rowsToCsvBuffer(data.columns, data.rows);

        // Upload to S3
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = outputNode.label.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        const s3Key = `projects/${projectId}/pipeline-outputs/${pipelineId}/${safeName}_${timestamp}.csv`;

        await uploadObject(s3Key, csvBuffer, 'text/csv', {
          pipelineId,
          nodeId: outputNode.id,
          deploymentId,
        });

        // Create or update output dataset
        let datasetId: string;
        const existingDatasetId = cfg.outputDatasetId as string | undefined;

        if (existingDatasetId) {
          await this.knex('foundry_datasets')
            .where({ id: existingDatasetId })
            .update({
              file_path: s3Key,
              row_count: data.rows.length,
              column_count: data.columns.length,
              file_size_bytes: csvBuffer.length,
              status: 'ready',
              updated_by: triggeredBy,
            });
          datasetId = existingDatasetId;
          await this.knex('dataset_columns').where({ dataset_id: datasetId }).del();
        } else {
          const [newDataset] = await this.knex('foundry_datasets')
            .insert({
              name: outputNode.label,
              project_id: projectId,
              file_path: s3Key,
              original_filename: `${safeName}.csv`,
              mime_type: 'text/csv',
              file_size_bytes: csvBuffer.length,
              row_count: data.rows.length,
              column_count: data.columns.length,
              status: 'ready',
              created_by: triggeredBy,
              updated_by: triggeredBy,
            })
            .returning('*');
          datasetId = newDataset.id;

          await this.knex('pipeline_nodes')
            .where({ id: outputNode.id })
            .update({
              dataset_id: datasetId,
              config: JSON.stringify({ ...cfg, outputDatasetId: datasetId }),
            });
        }

        // Insert column schema
        const columnRows = data.columns.map((col, idx) => ({
          dataset_id: datasetId,
          column_name: col.name,
          column_type: col.type || 'text',
          ordinal_position: idx + 1,
          nullable: true,
        }));
        if (columnRows.length > 0) {
          await this.knex('dataset_columns').insert(columnRows);
        }

        buildResults.push({
          nodeId: outputNode.id,
          nodeLabel: outputNode.label,
          datasetId,
          datasetName: outputNode.label,
          filePath: s3Key,
          rowCount: data.rows.length,
          columnCount: data.columns.length,
          status: 'succeeded',
          durationMs: Date.now() - buildStart,
        });

        // Update deployment record with partial progress
        await this.knex('pipeline_deployments')
          .where({ id: deploymentId })
          .update({ build_results: JSON.stringify(buildResults) });

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        buildResults.push({
          nodeId: outputNode.id,
          nodeLabel: outputNode.label,
          datasetId: '',
          datasetName: outputNode.label,
          filePath: '',
          rowCount: 0,
          columnCount: 0,
          status: 'failed',
          error: errMsg,
          durationMs: Date.now() - buildStart,
        });

        // Update deployment record with partial progress (including failure)
        await this.knex('pipeline_deployments')
          .where({ id: deploymentId })
          .update({ build_results: JSON.stringify(buildResults) });
      }
    }

    // Finalize deployment
    const durationMs = Date.now() - startedAt;
    const succeededCount = buildResults.filter((r) => r.status === 'succeeded').length;
    const overallStatus = succeededCount > 0 ? 'succeeded' : 'failed';

    await this.knex('pipeline_deployments')
      .where({ id: deploymentId })
      .update({
        status: overallStatus,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        build_results: JSON.stringify(buildResults),
        error_message: overallStatus === 'failed'
          ? buildResults.filter((r) => r.status === 'failed').map((r) => r.error).join('; ')
          : null,
      });

    // Update pipeline status on full success
    const newPipelineStatus = succeededCount === outputNodes.length ? 'active' : pipeline.status;
    if (newPipelineStatus !== pipeline.status) {
      await this.knex('pipelines')
        .where({ id: pipeline.id })
        .update({ status: newPipelineStatus });
    }
  }

  /** Get a single deployment by ID (used for polling) */
  async getDeployment(
    projectId: string,
    pipelineId: string,
    deploymentId: string,
  ): Promise<unknown> {
    const deployment = await this.knex('pipeline_deployments')
      .where({ id: deploymentId, pipeline_id: pipelineId, project_id: projectId })
      .first();
    if (!deployment) throw new AppError('Deployment not found', 404, 'NOT_FOUND');
    // Parse JSONB fields
    if (typeof deployment.build_results === 'string') {
      deployment.build_results = JSON.parse(deployment.build_results);
    }
    if (typeof deployment.config === 'string') {
      deployment.config = JSON.parse(deployment.config);
    }
    return deployment;
  }

  /** List deployments for a pipeline, most recent first */
  async listDeployments(projectId: string, pipelineId: string): Promise<unknown[]> {
    const rows = await this.knex('pipeline_deployments')
      .where({ pipeline_id: pipelineId, project_id: projectId })
      .orderBy('started_at', 'desc')
      .limit(50);
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      build_results: typeof r.build_results === 'string' ? JSON.parse(r.build_results as string) : r.build_results,
      config: typeof r.config === 'string' ? JSON.parse(r.config as string) : r.config,
    }));
  }
}
