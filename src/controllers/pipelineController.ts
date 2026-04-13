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
  SavePreviewSnapshotSchema,
  SavePipelineProgressSchema,
  DeployPipelineSchema,
} from '../types/pipeline';
import { AppError } from '../utils/foundryAppError';
import { DeploymentService } from '../services/deploymentService';

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

      res.json({ success: true, data: pipeline });
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

  // ── Deploy pipeline (async — returns immediately, builds in background) ──
  deployPipeline = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = this.getProjectId(req);
      const pipelineId = this.getPipelineId(req);
      const parsed = DeployPipelineSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      const userId = this.getUserId(req);
      const result = await this.deploymentService.startDeployment(projectId, pipelineId, userId, parsed.data);
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
