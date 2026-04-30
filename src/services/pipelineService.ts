import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import type {
  CreatePipelineInput,
  UpdatePipelineInput,
  PipelineStatus,
  CreatePipelineNodeInput,
  UpdatePipelineNodeInput,
} from '../types/pipeline';

/**
 * PipelineService — data-access and business logic for pipeline entities.
 *
 * Follows the same class-based DI pattern used by ProjectService:
 * the Knex instance is injected via constructor so the service is
 * trivially testable with a mock/transaction-scoped knex.
 */
export class PipelineService {
  constructor(private knex: Knex) {}

  /**
   * Create a new pipeline within a project.
   * Enforces unique (project_id, name) constraint at the DB level
   * but provides a friendly error message on conflict.
   */
  async createPipeline(
    projectId: string,
    createdBy: string,
    input: CreatePipelineInput,
  ) {
    // Verify the project exists
    const project = await this.knex('projects').where({ id: projectId }).select('id').first();
    if (!project) {
      throw new AppError('Project not found', 404, 'NOT_FOUND');
    }

    // Check for duplicate name within the project
    const existing = await this.knex('pipelines')
      .where({ project_id: projectId, name: input.name })
      .first();
    if (existing) {
      throw new AppError(
        'A pipeline with this name already exists in the project',
        409,
        'CONFLICT',
      );
    }

    const [pipeline] = await this.knex('pipelines')
      .insert({
        project_id: projectId,
        name: input.name,
        description: input.description ?? null,
        pipeline_type: input.pipelineType,
        compute_type: input.computeType,
        output_format: input.outputFormat,
        status: 'draft' as PipelineStatus,
        created_by: createdBy,
        folder_id: input.folderId ?? null,
      })
      .returning('*');

    // PB-B7 — seed the default (creator, 'owner') ACL grant so the
    // person who created the pipeline can immediately read / edit /
    // deploy / share it under RBAC_ENABLED=true.
    if (createdBy) {
      await this.knex.raw(
        `INSERT INTO pipeline_acl
           (pipeline_id, principal_id, principal_type, role, granted_by, granted_at)
         VALUES (?, ?, 'user', 'owner', ?, NOW())
         ON CONFLICT (pipeline_id, principal_id, principal_type) DO NOTHING`,
        [pipeline.id, createdBy, createdBy],
      );
    }

    return pipeline;
  }

  /**
   * List all pipelines for a project, ordered by most recently updated.
   * If folderId is provided, filters to that folder.
   * If folderId is explicitly null, returns only root-level pipelines.
   * If folderId is undefined, returns all pipelines in the project.
   */
  async listPipelines(projectId: string, folderId?: string | null) {
    const query = this.knex('pipelines')
      .where({ project_id: projectId });

    if (folderId === null) {
      query.whereNull('folder_id');
    } else if (folderId !== undefined) {
      query.where({ folder_id: folderId });
    }

    return query.orderBy('updated_at', 'desc');
  }

  /**
   * Get a single pipeline by ID within a project scope.
   */
  async getPipelineById(projectId: string, pipelineId: string) {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    return pipeline || null;
  }

  /**
   * Update an existing pipeline.
   * Only non-undefined fields in the input are applied.
   */
  async updatePipeline(
    projectId: string,
    pipelineId: string,
    input: UpdatePipelineInput,
  ) {
    // If renaming, check for conflicts
    if (input.name) {
      const existing = await this.knex('pipelines')
        .where({ project_id: projectId, name: input.name })
        .whereNot({ id: pipelineId })
        .first();
      if (existing) {
        throw new AppError(
          'A pipeline with this name already exists in the project',
          409,
          'CONFLICT',
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name.trim();
    if (input.description !== undefined) updateData.description = input.description;
    if (input.pipelineType !== undefined) updateData.pipeline_type = input.pipelineType;
    if (input.computeType !== undefined) updateData.compute_type = input.computeType;
    if (input.outputFormat !== undefined) updateData.output_format = input.outputFormat;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.config !== undefined) updateData.config = JSON.stringify(input.config);

    const [updated] = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .update(updateData)
      .returning('*');

    return updated || null;
  }

  /**
   * Delete a pipeline. Returns true if a row was deleted.
   */
  async deletePipeline(projectId: string, pipelineId: string): Promise<boolean> {
    const deleted = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .delete();
    return deleted > 0;
  }

  /* ======================================================================= */
  /*  Pipeline Nodes                                                          */
  /* ======================================================================= */

  /**
   * Verify that a pipeline belongs to the given project.
   * Returns the pipeline row or throws 404.
   */
  private async ensurePipelineExists(projectId: string, pipelineId: string) {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) {
      throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
    }
    return pipeline;
  }

  /**
   * Add a single node to a pipeline.
   */
  async addNode(
    projectId: string,
    pipelineId: string,
    input: CreatePipelineNodeInput,
  ) {
    await this.ensurePipelineExists(projectId, pipelineId);

    // If a dataset reference is provided, verify it exists in this project
    if (input.datasetId) {
      const dataset = await this.knex('foundry_datasets')
        .where({ id: input.datasetId })
        .where(function () {
          this.where('project_id', projectId)
            .orWhereIn('folder_id', function () {
              this.select('id').from('folders').where('project_id', projectId);
            });
        })
        .first();
      if (!dataset) {
        throw new AppError('Dataset not found in this project', 404, 'NOT_FOUND');
      }
    }

    const [node] = await this.knex('pipeline_nodes')
      .insert({
        pipeline_id: pipelineId,
        dataset_id: input.datasetId ?? null,
        node_type: input.nodeType,
        label: input.label,
        position_x: input.positionX,
        position_y: input.positionY,
        config: JSON.stringify(input.config ?? {}),
      })
      .returning('*');

    return node;
  }

  /**
   * Bulk-add nodes to a pipeline in a single transaction.
   * Returns all created node rows.
   */
  async addNodes(
    projectId: string,
    pipelineId: string,
    inputs: CreatePipelineNodeInput[],
  ) {
    await this.ensurePipelineExists(projectId, pipelineId);

    // Collect dataset IDs that need verification
    const datasetIds = inputs
      .map((n) => n.datasetId)
      .filter((id): id is string => id != null);

    if (datasetIds.length > 0) {
      const foundDatasets = await this.knex('foundry_datasets')
        .whereIn('id', datasetIds)
        .where(function () {
          this.where('project_id', projectId)
            .orWhereIn('folder_id', function () {
              this.select('id').from('folders').where('project_id', projectId);
            });
        })
        .select('id');

      const foundIds = new Set(foundDatasets.map((d: { id: string }) => d.id));
      const missing = datasetIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new AppError(
          `Datasets not found in this project: ${missing.join(', ')}`,
          404,
          'NOT_FOUND',
        );
      }
    }

    const rows = inputs.map((input) => ({
      pipeline_id: pipelineId,
      dataset_id: input.datasetId ?? null,
      node_type: input.nodeType,
      label: input.label,
      position_x: input.positionX,
      position_y: input.positionY,
      config: JSON.stringify(input.config ?? {}),
    }));

    const nodes = await this.knex('pipeline_nodes')
      .insert(rows)
      .returning('*');

    return nodes;
  }

  /**
   * List all nodes for a pipeline, ordered by creation time.
   */
  async listNodes(projectId: string, pipelineId: string) {
    await this.ensurePipelineExists(projectId, pipelineId);

    return this.knex('pipeline_nodes as pn')
      .leftJoin('foundry_datasets as d', 'pn.dataset_id', 'd.id')
      .where('pn.pipeline_id', pipelineId)
      .select(
        'pn.id',
        'pn.pipeline_id',
        'pn.dataset_id',
        'pn.node_type',
        'pn.label',
        'pn.position_x',
        'pn.position_y',
        'pn.config',
        'pn.created_at',
        'pn.updated_at',
        'd.column_count as dataset_column_count',
        'd.row_count as dataset_row_count',
        'd.name as dataset_name',
        'd.status as dataset_status',
      )
      .orderBy('pn.created_at', 'asc');
  }

  /**
   * Update a single pipeline node.
   */
  async updateNode(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: UpdatePipelineNodeInput,
  ) {
    await this.ensurePipelineExists(projectId, pipelineId);

    const updateData: Record<string, unknown> = {};
    if (input.label !== undefined) updateData.label = input.label;
    if (input.nodeType !== undefined) updateData.node_type = input.nodeType;
    if (input.positionX !== undefined) updateData.position_x = input.positionX;
    if (input.positionY !== undefined) updateData.position_y = input.positionY;
    if (input.config !== undefined) updateData.config = JSON.stringify(input.config);

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update(updateData)
      .returning('*');

    return updated || null;
  }

  /**
   * Delete a single pipeline node. Returns true if deleted.
   */
  async deleteNode(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<boolean> {
    await this.ensurePipelineExists(projectId, pipelineId);

    const deleted = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .delete();
    return deleted > 0;
  }

  /**
   * Delete all nodes for a pipeline. Returns count of deleted rows.
   */
  async deleteAllNodes(
    projectId: string,
    pipelineId: string,
  ): Promise<number> {
    await this.ensurePipelineExists(projectId, pipelineId);

    return this.knex('pipeline_nodes')
      .where({ pipeline_id: pipelineId })
      .delete();
  }

  /**
   * Batch update node positions.
   * Uses a single transaction to update all positions atomically.
   */
  async batchUpdatePositions(
    projectId: string,
    pipelineId: string,
    positions: Array<{ nodeId: string; positionX: number; positionY: number }>,
  ): Promise<number> {
    // Verify pipeline belongs to project
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();

    if (!pipeline) {
      throw new (await import('../utils/foundryAppError')).AppError(
        'Pipeline not found', 404, 'NOT_FOUND',
      );
    }

    let updated = 0;

    await this.knex.transaction(async (trx) => {
      for (const pos of positions) {
        const count = await trx('pipeline_nodes')
          .where({ id: pos.nodeId, pipeline_id: pipelineId })
          .update({
            position_x: pos.positionX,
            position_y: pos.positionY,
          });
        updated += count;
      }
    });

    return updated;
  }

  /**
   * Save the canvas viewport (zoom + pan position) for a pipeline.
   */
  async saveViewport(
    projectId: string,
    pipelineId: string,
    viewport: { x: number; y: number; zoom: number },
  ): Promise<void> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) {
      throw new (await import('../utils/foundryAppError')).AppError(
        'Pipeline not found', 404, 'NOT_FOUND',
      );
    }

    const config = typeof pipeline.config === 'string'
      ? JSON.parse(pipeline.config) : (pipeline.config ?? {});
    config.viewport = viewport;

    await this.knex('pipelines')
      .where({ id: pipelineId })
      .update({ config: JSON.stringify(config) });
  }

  /**
   * Save full pipeline progress in a single atomic transaction.
   *
   * This is the primary "Save" action in the Pipeline Builder UI.
   * It batches ALL state into one database transaction:
   *   1. Pipeline metadata (name, description, status)
   *   2. Canvas viewport (zoom, pan)
   *   3. All node positions
   *   4. Pipeline updated_at timestamp
   *
   * Atomicity: if any write fails, the entire save is rolled back.
   * This prevents partial-save states where positions are updated
   * but the viewport is stale (or vice versa).
   */
  async savePipelineProgress(
    projectId: string,
    pipelineId: string,
    input: import('../types/pipeline').SavePipelineProgressInput,
  ): Promise<{ updatedNodes: number; savedAt: string }> {
    const { AppError } = await import('../utils/foundryAppError');

    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) throw new AppError('Pipeline not found', 404, 'NOT_FOUND');

    let updatedNodes = 0;
    const savedAt = new Date().toISOString();

    await this.knex.transaction(async (trx) => {
      // ── 1. Pipeline metadata ──
      const pipelineUpdate: Record<string, unknown> = {};
      if (input.name !== undefined) pipelineUpdate.name = input.name;
      if (input.description !== undefined) pipelineUpdate.description = input.description;
      if (input.status !== undefined) pipelineUpdate.status = input.status;

      // ── 2. Viewport → config.viewport ──
      if (input.viewport) {
        const config = typeof pipeline.config === 'string'
          ? JSON.parse(pipeline.config) : (pipeline.config ?? {});
        config.viewport = input.viewport;
        pipelineUpdate.config = JSON.stringify(config);
      }

      // Always touch updated_at on save — even if only positions changed
      pipelineUpdate.updated_at = new Date().toISOString();
      await trx('pipelines')
        .where({ id: pipelineId })
        .update(pipelineUpdate);

      // ── 3. Node positions ──
      if (input.positions && input.positions.length > 0) {
        for (const pos of input.positions) {
          const count = await trx('pipeline_nodes')
            .where({ id: pos.nodeId, pipeline_id: pipelineId })
            .update({
              position_x: pos.positionX,
              position_y: pos.positionY,
            });
          updatedNodes += count;
        }
      }
    });

    return { updatedNodes, savedAt };
  }

  /**
   * Get the saved canvas viewport for a pipeline.
   */
  async getViewport(
    projectId: string,
    pipelineId: string,
  ): Promise<{ x: number; y: number; zoom: number } | null> {
    const pipeline = await this.knex('pipelines')
      .where({ id: pipelineId, project_id: projectId })
      .first();
    if (!pipeline) {
      throw new (await import('../utils/foundryAppError')).AppError(
        'Pipeline not found', 404, 'NOT_FOUND',
      );
    }

    const config = typeof pipeline.config === 'string'
      ? JSON.parse(pipeline.config) : (pipeline.config ?? {});
    return config.viewport ?? null;
  }
}
