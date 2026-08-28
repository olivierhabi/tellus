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

    // Defense in depth: refuse a `folderId` whose folder lives in a
    // different project. The frontend already guards this, but a
    // direct API caller (script, curl, third-party) could still
    // submit a foreign-project folder and corrupt the cross-project
    // graph if we trusted the input.
    if (input.folderId) {
      const folder = await this.knex('folders')
        .where({ id: input.folderId })
        .select('id', 'project_id')
        .first();
      if (!folder) {
        throw new AppError(
          'Destination folder not found',
          404,
          'FOLDER_NOT_FOUND',
        );
      }
      if (folder.project_id !== projectId) {
        throw new AppError(
          'Destination folder belongs to a different project',
          409,
          'CROSS_PROJECT_FOLDER',
        );
      }
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
      .where({ project_id: projectId })
      .whereNotExists(function () {
        this.select('*')
          .from('resources as pipeline_resource')
          .whereRaw(
            "pipeline_resource.rid = 'ri.foundry.main.pipeline.' || pipelines.id::text",
          )
          .whereNot('pipeline_resource.trash_status', 'NOT_TRASHED');
      });

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
      .whereNotExists(function () {
        this.select('*')
          .from('resources as pipeline_resource')
          .whereRaw(
            "pipeline_resource.rid = 'ri.foundry.main.pipeline.' || pipelines.id::text",
          )
          .whereNot('pipeline_resource.trash_status', 'NOT_TRASHED');
      })
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
      .whereNotExists(function () {
        this.select('*')
          .from('resources as pipeline_resource')
          .whereRaw(
            "pipeline_resource.rid = 'ri.foundry.main.pipeline.' || pipelines.id::text",
          )
          .whereNot('pipeline_resource.trash_status', 'NOT_TRASHED');
      })
      .update(updateData)
      .returning('*');

    return updated || null;
  }

  /** Move a pipeline to Compass Trash without destroying its graph. */
  async deletePipeline(
    projectId: string,
    pipelineId: string,
    actorId: string,
  ): Promise<boolean> {
    return this.knex.transaction(async (trx) => {
      const pipeline = await trx('pipelines')
        .where({ id: pipelineId, project_id: projectId })
        .first();
      if (!pipeline) return false;

      const pipelineRid = `ri.foundry.main.pipeline.${pipelineId}`;
      const projectRid = `ri.compass.main.project.${projectId}`;
      const parentRid = pipeline.folder_id
        ? `ri.compass.main.compass-folder.${pipeline.folder_id}`
        : projectRid;
      const projectResource = await trx('resources')
        .where({ rid: projectRid })
        .select('space_rid')
        .first();
      if (!projectResource?.space_rid) {
        throw new AppError('Project resource is missing', 409, 'RESOURCE_ORPHANED');
      }

      await trx.raw(
        `INSERT INTO resources
           (rid, service, type, display_name, description,
            parent_folder_rid, project_rid, space_rid,
            trash_status, trashed_at, trashed_by, retention_until,
            created_by, created_at, updated_by, updated_at, legacy_uuid)
         VALUES (?, 'foundry', 'PIPELINE', ?, ?, ?, ?, ?,
                 'DIRECTLY_TRASHED', NOW(), ?, NOW() + interval '30 days',
                 ?, ?, ?, NOW(), ?)
         ON CONFLICT (rid) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           parent_folder_rid = EXCLUDED.parent_folder_rid,
           project_rid = EXCLUDED.project_rid,
           space_rid = EXCLUDED.space_rid,
           trash_status = 'DIRECTLY_TRASHED',
           trashed_at = NOW(),
           trashed_by = EXCLUDED.trashed_by,
           retention_until = NOW() + interval '30 days',
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [
          pipelineRid,
          pipeline.name,
          pipeline.description ?? null,
          parentRid,
          projectRid,
          projectResource.space_rid,
          actorId,
          pipeline.created_by ?? actorId,
          pipeline.created_at,
          actorId,
          pipelineId,
        ],
      );
      return true;
    });
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
      .whereNotExists(function () {
        this.select('*')
          .from('resources as pipeline_resource')
          .whereRaw(
            "pipeline_resource.rid = 'ri.foundry.main.pipeline.' || pipelines.id::text",
          )
          .whereNot('pipeline_resource.trash_status', 'NOT_TRASHED');
      })
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
   * Register a Kafka topic as a streaming-pipeline source (FOUNDRY-GAPS §2
   * direct Kafka→pipeline path). Creates a `foundry_datasets` row with
   * `format='stream'` (topic name stored in `file_path`), its `dataset_columns`
   * schema, and a `dataset` pipeline node wired to it. At deploy time
   * `DeploymentService.resolveStreamingSources` turns this into a Flink Kafka
   * source connector (`compileStreamingJob`).
   */
  async createKafkaStreamSource(
    projectId: string,
    pipelineId: string,
    input: {
      label?: string;
      topic: string;
      columns: Array<{ name: string; type: string }>;
      positionX?: number;
      positionY?: number;
    },
  ) {
    await this.ensurePipelineExists(projectId, pipelineId);
    const topic = (input.topic ?? '').trim();
    if (!topic) {
      throw new AppError('Kafka topic is required', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new AppError(
        'At least one column is required for a Kafka stream source',
        400,
        'VALIDATION_ERROR',
      );
    }
    const label = input.label?.trim() || `kafka:${topic}`;

    return this.knex.transaction(async (trx) => {
      const [dataset] = await trx('foundry_datasets')
        .insert({
          name: label,
          project_id: projectId,
          folder_id: null,
          // The topic is stored as file_path; the streaming source resolver
          // reads it as the Flink Kafka connector `topic`.
          file_path: topic,
          format: 'stream',
          status: 'ready',
          column_count: input.columns.length,
        })
        .returning('*');

      await trx('dataset_columns').insert(
        input.columns.map((c, i) => ({
          dataset_id: dataset.id,
          column_name: c.name,
          column_type: c.type,
          ordinal_position: i,
        })),
      );

      const [node] = await trx('pipeline_nodes')
        .insert({
          pipeline_id: pipelineId,
          dataset_id: dataset.id,
          node_type: 'dataset',
          label,
          position_x: input.positionX ?? 0,
          position_y: input.positionY ?? 0,
          config: JSON.stringify({ kafkaTopic: topic, streamFormat: 'json' }),
        })
        .returning('*');

      return { dataset, node };
    });
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
