import { Request, Response, NextFunction } from 'express';
import { PipelineService } from '../services/pipelineService';
import { TransformService } from '../services/transformService';
import {
  CreatePipelineSchema,
  UpdatePipelineSchema,
  PipelineParamsSchema,
  ProjectParamsSchema,
  CreatePipelineNodeSchema,
  BulkCreatePipelineNodesSchema,
  UpdatePipelineNodeSchema,
  PipelineNodeParamsSchema,
  BatchUpdatePositionsSchema,
  CastPreviewSchema,
  CastApplySchema,
  FilterPreviewSchema,
  FilterApplySchema,
  DropPreviewSchema,
  DropApplySchema,
  RenamePreviewSchema,
  RenameApplySchema,
  NormalizePreviewSchema,
  NormalizeApplySchema,
  JoinPreviewSchema,
  JoinApplySchema,
  UnionPreviewSchema,
  UnionApplySchema,
  SelectPreviewSchema,
  SelectApplySchema,
  SortPreviewSchema,
  SortApplySchema,
  DropDuplicatesPreviewSchema,
  DropDuplicatesApplySchema,
  UppercaseColumnNamesPreviewSchema,
  UppercaseColumnNamesApplySchema,
  RowSizePreviewSchema,
  RowSizeApplySchema,
  ApplyExpressionPreviewSchema,
  ApplyExpressionApplySchema,
  ApplyMultipleExpressionsPreviewSchema,
  ApplyMultipleExpressionsApplySchema,
  ApplyToMultipleColumnsPreviewSchema,
  ApplyToMultipleColumnsApplySchema,
  ComputeIfExpressionAbsentPreviewSchema,
  ComputeIfExpressionAbsentApplySchema,
  TextBlockPreviewSchema,
  TextBlockApplySchema,
  AggregatePreviewSchema,
  AggregateApplySchema,
  RollupPreviewSchema,
  RollupApplySchema,
  AggregateOnConditionPreviewSchema,
  AggregateOnConditionApplySchema,
  TopRowsPreviewSchema,
  TopRowsApplySchema,
  PivotPreviewSchema,
  PivotApplySchema,
  UnpivotPreviewSchema,
  UnpivotApplySchema,
  KeepDuplicatesPreviewSchema,
  KeepDuplicatesApplySchema,
  SavePreviewSnapshotSchema,
  SavePipelineProgressSchema,
  DeployPipelineSchema,
} from '../types/pipeline';
import { AppError } from '../utils/foundryAppError';
import { DeploymentService } from '../services/deploymentService';
import foundryDb from '../config/foundryDb';

/**
 * PipelineController — HTTP layer for pipeline CRUD operations.
 *
 * Follows the same pattern as ProjectController:
 * - Arrow function methods bound to `this` for safe route binding
 * - Zod validation on request body and params
 * - Delegates all business logic to PipelineService
 * - Standard { success, data } response envelope
 */
export class PipelineController {
  private transformService: TransformService;
  private deploymentService: DeploymentService;

  constructor(
    private pipelineService: PipelineService,
    transformService: TransformService,
    deploymentService: DeploymentService,
  ) {
    this.transformService = transformService;
    this.deploymentService = deploymentService;
  }

  /** Extract authenticated user ID from request. */
  private getUserId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  /** Extract the Keycloak sub claim for audit attribution. */
  private getKeycloakSub(req: Request): string | null {
    const principal = (req as unknown as {
      tellusPrincipal?: { sub?: string; userId?: string };
    }).tellusPrincipal;
    return principal?.sub ?? null;
  }

  /** Extract and validate projectId from route params. */
  private getProjectId(req: Request): string {
    const parsed = ProjectParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new AppError('Invalid project UUID format', 400, 'VALIDATION_ERROR');
    }
    return parsed.data.projectId;
  }

  /**
   * POST /projects/:projectId/pipelines
   * Create a new pipeline within a project.
   */
  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const userId = this.getUserId(req);

      const parsed = CreatePipelineSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const pipeline = await this.pipelineService.createPipeline(
        projectId,
        userId,
        parsed.data,
      );

      res.status(201).json({ success: true, data: pipeline });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /projects/:projectId/pipelines
   * List pipelines for a project.
   * Query params:
   *   - folderId=null  → root-level pipelines only
   *   - folderId=<uuid> → pipelines in that folder
   *   - (omitted)       → all pipelines in project
   */
  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);

      // Parse optional folderId filter
      const rawFolderId = req.query.folderId;
      let folderId: string | null | undefined;
      if (rawFolderId === 'null' || rawFolderId === '') {
        folderId = null; // root-level only
      } else if (typeof rawFolderId === 'string') {
        folderId = rawFolderId;
      }
      // else: undefined → return all

      const pipelines = await this.pipelineService.listPipelines(projectId, folderId);

      res.setHeader('X-Total-Count', String(pipelines.length));
      res.json({ success: true, data: pipelines });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /projects/:projectId/pipelines/:pipelineId
   * Get a single pipeline by ID.
   */
  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);

      const pipelineParsed = PipelineParamsSchema.safeParse(req.params);
      if (!pipelineParsed.success) {
        throw new AppError('Invalid pipeline UUID format', 400, 'VALIDATION_ERROR');
      }

      const pipeline = await this.pipelineService.getPipelineById(
        projectId,
        pipelineParsed.data.pipelineId,
      );
      if (!pipeline) {
        throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
      }

      // PB-B8 — surface `lineage.feedsObjectTypes` so the frontend can
      // show "deploys into Object Type: Order" next to the pipeline
      // name. We look up the latest output dataset for the pipeline
      // and call the lineage service's OT resolver. Empty list when
      // the pipeline has never deployed a dataset.
      let feedsObjectTypes: Array<{
        ontologyId: string;
        apiName: string;
        role: 'backing_datasource';
      }> = [];
      try {
        const outNode = await foundryDb('pipeline_nodes')
          .where({ pipeline_id: (pipeline as { id: string }).id, node_type: 'output' })
          .whereNotNull('dataset_id')
          .orderBy('updated_at', 'desc')
          .first('dataset_id');
        if (outNode?.dataset_id) {
          const { DatasetLineageService } = await import('../services/pipelines/datasetLineage');
          const lineage = new DatasetLineageService();
          const ots = await lineage.findObjectTypesFor(outNode.dataset_id);
          feedsObjectTypes = ots.map((o) => ({
            ontologyId: o.ontologyId,
            apiName: o.objectTypeApiName,
            role: 'backing_datasource' as const,
          }));
        }
      } catch (err) {
        // Lineage lookup is additive context — a failure should not
        // break the core GET.
        console.warn(
          `[pipelines/getById] lineage lookup failed: ${(err as Error).message}`,
        );
      }

      res.json({
        success: true,
        data: {
          ...(pipeline as Record<string, unknown>),
          lineage: { feedsObjectTypes },
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /projects/:projectId/pipelines/:pipelineId
   * Update a pipeline.
   */
  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);

      const pipelineParsed = PipelineParamsSchema.safeParse(req.params);
      if (!pipelineParsed.success) {
        throw new AppError('Invalid pipeline UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = UpdatePipelineSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const pipeline = await this.pipelineService.updatePipeline(
        projectId,
        pipelineParsed.data.pipelineId,
        bodyParsed.data,
      );
      if (!pipeline) {
        throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
      }

      res.json({ success: true, data: pipeline });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /projects/:projectId/pipelines/:pipelineId
   * Delete a pipeline.
   */
  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);

      const pipelineParsed = PipelineParamsSchema.safeParse(req.params);
      if (!pipelineParsed.success) {
        throw new AppError('Invalid pipeline UUID format', 400, 'VALIDATION_ERROR');
      }

      const deleted = await this.pipelineService.deletePipeline(
        projectId,
        pipelineParsed.data.pipelineId,
      );
      if (!deleted) {
        throw new AppError('Pipeline not found', 404, 'NOT_FOUND');
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  /* ======================================================================= */
  /*  Pipeline Node endpoints                                                 */
  /* ======================================================================= */

  /** Helper: extract and validate pipelineId from params */
  private getPipelineId(req: Request): string {
    const parsed = PipelineParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new AppError('Invalid pipeline UUID format', 400, 'VALIDATION_ERROR');
    }
    return parsed.data.pipelineId;
  }

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes
   * Add a single node to a pipeline.
   */
  addNode = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const parsed = CreatePipelineNodeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const node = await this.pipelineService.addNode(projectId, pipelineId, parsed.data);
      res.status(201).json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/kafka-source
   * Register a Kafka topic as a streaming-pipeline source (§2 direct
   * Kafka→pipeline path). Body: { label?, topic, columns: [{name,type}], positionX?, positionY? }.
   */
  addKafkaStreamSource = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const body = req.body ?? {};
      if (typeof body.topic !== 'string' || !Array.isArray(body.columns)) {
        throw new AppError('topic (string) and columns (array) are required', 400, 'VALIDATION_ERROR');
      }
      const result = await this.pipelineService.createKafkaStreamSource(projectId, pipelineId, {
        label: typeof body.label === 'string' ? body.label : undefined,
        topic: body.topic,
        columns: body.columns,
        positionX: typeof body.positionX === 'number' ? body.positionX : undefined,
        positionY: typeof body.positionY === 'number' ? body.positionY : undefined,
      });
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/bulk
   * Bulk-add nodes (used when user selects multiple datasets in Add Data dialog).
   */
  addNodesBulk = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const parsed = BulkCreatePipelineNodesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const nodes = await this.pipelineService.addNodes(
        projectId,
        pipelineId,
        parsed.data.nodes,
      );

      res.status(201).json({ success: true, data: nodes });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /projects/:projectId/pipelines/:pipelineId/nodes
   * List all nodes for a pipeline.
   */
  listNodes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const nodes = await this.pipelineService.listNodes(projectId, pipelineId);

      res.setHeader('X-Total-Count', String(nodes.length));
      res.json({ success: true, data: nodes });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId
   * Update a pipeline node (position, label, config, etc.).
   */
  updateNode = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = UpdatePipelineNodeSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const node = await this.pipelineService.updateNode(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        bodyParsed.data,
      );
      if (!node) {
        throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
      }

      res.json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId
   * Delete a single pipeline node.
   */
  deleteNode = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const deleted = await this.pipelineService.deleteNode(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
      );
      if (!deleted) {
        throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /projects/:projectId/pipelines/:pipelineId/nodes
   * Delete all nodes for a pipeline (reset graph).
   */
  deleteAllNodes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);

      const count = await this.pipelineService.deleteAllNodes(projectId, pipelineId);

      res.json({ success: true, data: { deletedCount: count } });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PATCH /projects/:projectId/pipelines/:pipelineId/nodes/positions
   * Batch update node positions (persists after drag on canvas).
   */
  batchUpdatePositions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const bodyParsed = BatchUpdatePositionsSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const updated = await this.pipelineService.batchUpdatePositions(
        projectId, pipelineId, bodyParsed.data.positions,
      );
      res.json({ success: true, data: { updatedCount: updated } });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /projects/:projectId/pipelines/:pipelineId/viewport
   */
  saveViewport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const { x, y, zoom } = req.body;
      if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') {
        throw new AppError('x, y, and zoom are required numbers', 400, 'VALIDATION_ERROR');
      }
      await this.pipelineService.saveViewport(projectId, pipelineId, { x, y, zoom });
      res.json({ success: true });
    } catch (error) { next(error); }
  };

  /**
   * GET /projects/:projectId/pipelines/:pipelineId/viewport
   */
  getViewport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const viewport = await this.pipelineService.getViewport(projectId, pipelineId);
      res.json({ success: true, data: viewport });
    } catch (error) { next(error); }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Cast                                              */
  /* ======================================================================= */

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/cast/preview
   *
   * Execute a Cast transform preview against the node's dataset.
   * Returns up to `limit` rows with the cast column applied.
   *
   * Follows Palantir Pipeline Builder Cast (castV2) semantics:
   *   https://www.palantir.com/docs/foundry/pb-functions-expression/castV2/
   */
  castPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = CastPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const result = await this.transformService.castPreview(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        bodyParsed.data,
      );

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/cast/apply
   *
   * Persist a Cast transform configuration to the pipeline node.
   * Appends the transform to the node's config.transforms array.
   * Does NOT execute SQL — configuration only.
   */
  castApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = CastApplySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const node = await this.transformService.castApply(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        bodyParsed.data,
      );

      res.json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  };

  /* ======================================================================= */
  /*  Transform endpoints — UDF (user-authored code, gVisor sandbox §2)      */
  /* ======================================================================= */

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/udf/apply
   * Body is validated inside the service (validateUdfSpec) so the typed
   * UDF_* errors flow through the standard error envelope.
   */
  udfApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }
      const node = await this.transformService.udfApply(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        req.body,
      );
      res.json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/udf/preview
   * Runs the UDF over a bounded slice of input rows inside the gVisor sandbox.
   */
  udfPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }
      const limit = Math.min(1000, Math.max(1, Number(req.body?.limit ?? 100)));
      const result = await this.transformService.udfPreview(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        req.body,
        limit,
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Filter                                           */
  /* ======================================================================= */

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/filter/preview
   */
  filterPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = FilterPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const result = await this.transformService.filterPreview(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        bodyParsed.data,
      );

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/pipelines/:pipelineId/nodes/:nodeId/transforms/filter/apply
   */
  filterApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) {
        throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = FilterApplySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const node = await this.transformService.filterApply(
        projectId,
        pipelineId,
        nodeParsed.data.nodeId,
        bodyParsed.data,
      );

      res.json({ success: true, data: node });
    } catch (error) {
      next(error);
    }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Drop Columns                                     */
  /* ======================================================================= */

  dropPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = DropPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.dropPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  dropApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = DropApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.dropApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Rename Columns                                   */
  /* ======================================================================= */

  renamePreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RenamePreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.renamePreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  renameApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RenameApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.renameApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Normalize Column Names                           */
  /* ======================================================================= */

  normalizePreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = NormalizePreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.normalizePreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  normalizeApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = NormalizeApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.normalizeApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  /* ======================================================================= */
  /*  Transform endpoints — Tier A single-input (PB-B2.follow)               */
  /*                                                                         */
  /*  Select / Sort / DropDuplicates / UppercaseColumnNames / RowSize /      */
  /*  ApplyExpression / ApplyMultipleExpressions / ApplyToMultipleColumns /  */
  /*  ComputeIfExpressionAbsent / TextBlock.                                 */
  /* ======================================================================= */

  // ---- Select -----------------------------------------------------------
  selectPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = SelectPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.selectPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  selectApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = SelectApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.selectApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Sort ------------------------------------------------------------
  sortPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = SortPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.sortPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  sortApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = SortApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.sortApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Drop Duplicates -------------------------------------------------
  dropDuplicatesPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = DropDuplicatesPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.dropDuplicatesPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  dropDuplicatesApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = DropDuplicatesApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.dropDuplicatesApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Uppercase Column Names ------------------------------------------
  uppercaseColumnNamesPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UppercaseColumnNamesPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.uppercaseColumnNamesPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  uppercaseColumnNamesApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UppercaseColumnNamesApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.uppercaseColumnNamesApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Row Size --------------------------------------------------------
  rowSizePreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RowSizePreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.rowSizePreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  rowSizeApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RowSizeApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.rowSizeApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Apply Expression ------------------------------------------------
  applyExpressionPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyExpressionPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.applyExpressionPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  applyExpressionApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyExpressionApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.applyExpressionApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Apply Multiple Expressions --------------------------------------
  applyMultipleExpressionsPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyMultipleExpressionsPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.applyMultipleExpressionsPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  applyMultipleExpressionsApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyMultipleExpressionsApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.applyMultipleExpressionsApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Apply To Multiple Columns ---------------------------------------
  applyToMultipleColumnsPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyToMultipleColumnsPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.applyToMultipleColumnsPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  applyToMultipleColumnsApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ApplyToMultipleColumnsApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.applyToMultipleColumnsApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Compute If Expression Absent ------------------------------------
  computeIfExpressionAbsentPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ComputeIfExpressionAbsentPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.computeIfExpressionAbsentPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  computeIfExpressionAbsentApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = ComputeIfExpressionAbsentApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.computeIfExpressionAbsentApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Text Block ------------------------------------------------------
  textBlockPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = TextBlockPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.textBlockPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  textBlockApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = TextBlockApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.textBlockApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Aggregate (groupAndAggregateV1) --------------------------------
  aggregatePreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = AggregatePreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.aggregatePreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  aggregateApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = AggregateApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.aggregateApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Rollup (rollupV1) ----------------------------------------------
  rollupPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RollupPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.rollupPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  rollupApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = RollupApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.rollupApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Aggregate on Condition (aggregateOnConditionV2) -----------------
  aggregateOnConditionPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = AggregateOnConditionPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.aggregateOnConditionPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  aggregateOnConditionApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = AggregateOnConditionApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.aggregateOnConditionApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Top Rows (topRowsV1) --------------------------------------------
  topRowsPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = TopRowsPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.topRowsPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  topRowsApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = TopRowsApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.topRowsApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Pivot (pivotV1) --------------------------------------------------
  pivotPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = PivotPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.pivotPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  pivotApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = PivotApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.pivotApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Unpivot (unpivotV1) ----------------------------------------------
  unpivotPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UnpivotPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.unpivotPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  unpivotApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UnpivotApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.unpivotApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  // ---- Keep Duplicates (keepDuplicatesV1) --------------------------------
  keepDuplicatesPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = KeepDuplicatesPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.keepDuplicatesPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  keepDuplicatesApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = KeepDuplicatesApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.keepDuplicatesApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  /* ======================================================================= */
  /*  Preview Snapshot — save and retrieve                                    */
  /* ======================================================================= */

  /**
   * POST .../nodes/:nodeId/transforms/execute
   * Execute the full transform chain on all data. Called by "Apply All".
   */
  /* ======================================================================= */
  /*  Transform endpoints — Join                                              */
  /* ======================================================================= */

  joinPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = JoinPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.joinPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  joinApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = JoinApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.joinApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  unionPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UnionPreviewSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.transformService.unionPreview(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  unionApply = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = UnionApplySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.unionApply(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  executeChain = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const result = await this.transformService.executeChain(projectId, pipelineId, nodeParsed.data.nodeId);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── Save pipeline progress (atomic full-state save) ─────────────────────
  savePipelineProgress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const parsed = SavePipelineProgressSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const result = await this.pipelineService.savePipelineProgress(projectId, pipelineId, parsed.data);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── Deploy pipeline (PB-B1 supervised — returns immediately, dispatcher builds) ──
  //
  // Idempotency protocol:
  //   * Clients SHOULD send `Idempotency-Key: <uuid>`. Two POSTs with the
  //     same key within the dedup window return the same deploymentId.
  //   * During the deprecation window the server auto-generates a key if
  //     the header is absent and echoes it back in
  //     `Idempotency-Key-Generated`. Clients should capture that value on
  //     the first response and re-use it on retries.
  deployPipeline = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const parsed = DeployPipelineSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const userId = this.getUserId(req);
      const headerKey = req.header('Idempotency-Key') ?? req.header('idempotency-key');
      const idempotencyKey = typeof headerKey === 'string' && headerKey.length > 0
        ? headerKey.slice(0, 256)
        : undefined;
      // PB-B6 — `?ignorePreviewSnapshot=true` is an escape hatch that
      // both skips the preview-chain stale check AND records
      // divergence_warning on the deployment row. Accept common
      // truthy spellings so CLI/curl/fe all work.
      const truthy = (raw: unknown): boolean => {
        const v = String(raw ?? '').toLowerCase();
        return v === 'true' || v === '1' || v === 'yes';
      };
      const ignorePreviewSnapshot = truthy(req.query.ignorePreviewSnapshot);
      // PB-B10 — dryRun + force_schema_migration + accept_data_loss.
      const dryRun = truthy(req.query.dryRun);
      const forceSchemaMigration = truthy(req.query.force_schema_migration);
      const acceptDataLoss = truthy(req.query.accept_data_loss);
      const result = await this.deploymentService.startDeployment(
        projectId, pipelineId, userId, parsed.data,
        {
          idempotencyKey,
          ignorePreviewSnapshot,
          dryRun,
          forceSchemaMigration,
          acceptDataLoss,
        },
      );
      // PB-B10 — dry-run response: no deployment is created, so we
      // serve the classified schema diff envelope directly.
      if ('dryRun' in result && result.dryRun === true) {
        res.json({ success: true, data: result });
        return;
      }
      const deployResult = result as Extract<typeof result, { deploymentId: string }>;
      if (deployResult.idempotencyKeyGenerated) {
        res.setHeader('Idempotency-Key-Generated', deployResult.idempotencyKey);
      }
      // Envelope is unchanged from the pre-PB-B1 shape (the new
      // idempotency / reused fields are additive and older clients
      // ignore them). This keeps the existing tellus-fe deploy flow
      // working without any frontend changes.
      res.json({
        success: true,
        data: {
          deploymentId: deployResult.deploymentId,
          status: deployResult.status,
          startedAt: deployResult.startedAt,
          outputCount: deployResult.outputCount,
          idempotencyKey: deployResult.idempotencyKey,
          reused: deployResult.reused,
        },
      });
    } catch (error) { next(error); }
  };

  // ── ACL management (PB-B7) ───────────────────────────────────────────────
  //
  // GET    /:pipelineId/acl                 → list grants
  // PUT    /:pipelineId/acl/:principalId    → upsert {role, principalType}
  // DELETE /:pipelineId/acl/:principalId    → revoke (principalType query)
  //
  // Route-level middleware already gated all three at `owner`. Every
  // mutation emits a tellus_audit_events row tagged
  // category='pipeline_acl' so the access trail is reconstructable.
  listAcl = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pipelineId = this.getPipelineId(req);
      const { PipelineAclService } = await import('../services/pipelines/pipelineAcl');
      const svc = new PipelineAclService();
      const rows = await svc.list(pipelineId);
      res.json({ success: true, data: { acl: rows } });
    } catch (error) { next(error); }
  };

  upsertAcl = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pipelineId = this.getPipelineId(req);
      const principalId = req.params.principalId;
      if (!principalId) throw new AppError('principalId required', 400, 'VALIDATION_ERROR');
      const principalType = (req.body?.principalType ?? 'user') as 'user' | 'group';
      const role = req.body?.role as 'owner' | 'editor' | 'viewer';
      if (!role) throw new AppError('role required', 400, 'VALIDATION_ERROR');
      const actorUserId = this.getUserId(req);
      const actorSub = this.getKeycloakSub(req);
      const { PipelineAclService } = await import('../services/pipelines/pipelineAcl');
      const svc = new PipelineAclService();
      const row = await svc.grant({
        pipelineId, principalId, principalType, role,
        grantedBy: actorUserId,
      });
      // Audit: an ACL grant emits regardless of whether it was a new
      // row or a role change. Callers can reconcile from the details.
      const { emitAuditEvent } = await import('../services/auditEventService');
      await emitAuditEvent({
        keycloakSub: actorSub ?? actorUserId,
        category: 'pipeline_acl',
        action: 'pipeline.acl.grant',
        result: 'SUCCESS',
        req,
        details: {
          pipelineId, principalId, principalType, role,
          grantedBy: actorUserId,
        },
      });
      res.json({ success: true, data: row });
    } catch (error) { next(error); }
  };

  revokeAcl = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pipelineId = this.getPipelineId(req);
      const principalId = req.params.principalId;
      if (!principalId) throw new AppError('principalId required', 400, 'VALIDATION_ERROR');
      const principalType = (req.query.principalType as 'user' | 'group' | undefined) ?? 'user';
      const actorUserId = this.getUserId(req);
      const actorSub = this.getKeycloakSub(req);
      const { PipelineAclService } = await import('../services/pipelines/pipelineAcl');
      const svc = new PipelineAclService();
      const r = await svc.revoke({ pipelineId, principalId, principalType });
      const { emitAuditEvent } = await import('../services/auditEventService');
      await emitAuditEvent({
        keycloakSub: actorSub ?? actorUserId,
        category: 'pipeline_acl',
        action: 'pipeline.acl.revoke',
        result: r.removed ? 'SUCCESS' : 'FAILURE',
        req,
        details: { pipelineId, principalId, principalType, removed: r.removed },
      });
      res.json({ success: true, data: r });
    } catch (error) { next(error); }
  };

  // ── Streaming restart + stats (PB-B5) ────────────────────────────────────
  //
  // POST /:pipelineId/deployments/:id/restart — resumes a streaming
  //   deploy from its savepoint_path; produces a NEW deployment row.
  // GET  /:pipelineId/deployments/:id/streaming-stats — watermarks,
  //   lag, checkpoint health via the Flink adapter.
  restartStreamingDeployment = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const deploymentId = req.params.deploymentId;
      if (!deploymentId) throw new AppError('Deployment ID required', 400, 'VALIDATION_ERROR');
      const result = await this.deploymentService.restartStreamingDeploy(
        projectId, pipelineId, deploymentId,
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  streamingStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const deploymentId = req.params.deploymentId;
      if (!deploymentId) throw new AppError('Deployment ID required', 400, 'VALIDATION_ERROR');
      const result = await this.deploymentService.getStreamingStats(
        projectId, pipelineId, deploymentId,
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── Iceberg output snapshots + time travel (PB-B4) ───────────────────────
  //
  // GET /:pipelineId/output/snapshots       — list {snapshot_id, parent_id, timestamp_ms, operation, summary}
  // GET /:pipelineId/output?as_of_snapshot=N — rows at that snapshot (default: latest)
  listOutputSnapshots = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const result = await this.deploymentService.listOutputSnapshots(projectId, pipelineId);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  readOutputAsOf = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const asOf = req.query.as_of_snapshot as string | undefined;
      const limit = req.query.limit as string | undefined;
      const result = await this.deploymentService.readOutputAsOf(
        projectId, pipelineId,
        {
          snapshotId: asOf && asOf.length > 0 ? asOf : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── Migrate output format (PB-B3) ────────────────────────────────────────
  //
  // POST /:pipelineId/migrate-output-format
  // Body: { target: 'parquet' }
  // Flips pipelines.output_format atomically and triggers a supervised
  // re-deploy. Rejects with SCHEMA_NOT_TYPED_FOR_PARQUET if any output
  // column lacks a concrete type (Parquet requires typed columns).
  migrateOutputFormat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const userId = this.getUserId(req);
      const target = (req.body?.target ?? 'parquet') as string;
      if (target !== 'parquet') {
        throw new AppError(
          "Only target='parquet' is supported; 'iceberg' is blocked on PB-B4.",
          400,
          'VALIDATION_ERROR',
        );
      }
      const result = await this.deploymentService.migrateOutputFormat(
        projectId, pipelineId, userId, 'parquet',
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── Cancel deployment (PB-B1) ────────────────────────────────────────────
  //
  // Sets `cancellation_requested_at`; the supervisor worker polls the
  // column between outputs and transitions the row to 'cancelled' within
  // the time of the current output. Returns the requested timestamp so
  // the UI can show a "cancelling..." state.
  cancelDeployment = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const deploymentId = req.params.deploymentId;
      if (!deploymentId) throw new AppError('Deployment ID required', 400, 'VALIDATION_ERROR');
      const result = await this.deploymentService.cancelDeployment(projectId, pipelineId, deploymentId);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  // ── List deployments ───────────────────────────────────────────────────
  listDeployments = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const deployments = await this.deploymentService.listDeployments(projectId, pipelineId);
      res.json({ success: true, data: deployments });
    } catch (error) { next(error); }
  };

  // ── Get deployment ─────────────────────────────────────────────────────
  getDeployment = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const deploymentId = req.params.deploymentId;
      if (!deploymentId) throw new AppError('Deployment ID required', 400, 'VALIDATION_ERROR');
      const deployment = await this.deploymentService.getDeployment(projectId, pipelineId, deploymentId);
      res.json({ success: true, data: deployment });
    } catch (error) { next(error); }
  };

  // ── Output preview ──────────────────────────────────────────────────────
  outputPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const limit = typeof req.body?.limit === 'number' ? req.body.limit : 500;
      const result = await this.transformService.outputPreview(projectId, pipelineId, nodeParsed.data.nodeId, limit);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  };

  savePreviewSnapshot = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const bodyParsed = SavePreviewSnapshotSchema.safeParse(req.body);
      if (!bodyParsed.success) throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const node = await this.transformService.savePreviewSnapshot(projectId, pipelineId, nodeParsed.data.nodeId, bodyParsed.data);
      res.json({ success: true, data: node });
    } catch (error) { next(error); }
  };

  getPreviewSnapshot = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const nodeParsed = PipelineNodeParamsSchema.safeParse(req.params);
      if (!nodeParsed.success) throw new AppError('Invalid node UUID format', 400, 'VALIDATION_ERROR');
      const snapshot = await this.transformService.getPreviewSnapshot(projectId, pipelineId, nodeParsed.data.nodeId);
      res.json({ success: true, data: snapshot });
    } catch (error) { next(error); }
  };
}
