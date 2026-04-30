import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePipelineRole } from '../middleware/pipelineRbac';
import { PipelineController } from '../controllers/pipelineController';
import { PipelineService } from '../services/pipelineService';
import { TransformService } from '../services/transformService';
import { DeploymentService } from '../services/deploymentService';
import foundryDb from '../config/foundryDb';

// PB-B7 — short aliases so the route list below stays readable.
const viewer = requirePipelineRole('viewer');
const editor = requirePipelineRole('editor');
const owner = requirePipelineRole('owner');

const router = Router({ mergeParams: true });
const pipelineService = new PipelineService(foundryDb);
const transformService = new TransformService(foundryDb);
const deploymentService = new DeploymentService(foundryDb, transformService);
const pipelineController = new PipelineController(pipelineService, transformService, deploymentService);

router.post('/', authenticate, pipelineController.create);
router.get('/', authenticate, pipelineController.list);
router.get('/:pipelineId', authenticate, viewer, pipelineController.getById);
router.put('/:pipelineId', authenticate, editor, pipelineController.update);
router.delete('/:pipelineId', authenticate, editor, pipelineController.delete);

// Save pipeline progress (atomic full-state save)
router.post('/:pipelineId/save', authenticate, editor, pipelineController.savePipelineProgress);

// Deploy pipeline (execute + build outputs)
router.post('/:pipelineId/deploy', authenticate, owner, pipelineController.deployPipeline);
router.get('/:pipelineId/deployments', authenticate, viewer, pipelineController.listDeployments);
router.get('/:pipelineId/deployments/:deploymentId', authenticate, viewer, pipelineController.getDeployment);
// PB-B1: cooperative cancellation. Sets cancellation_requested_at; the
// supervisor worker polls between outputs and finalises status='cancelled'.
router.delete('/:pipelineId/deployments/:deploymentId', authenticate, owner, pipelineController.cancelDeployment);

// PB-B3: atomically switch a pipeline's output_format to Parquet and
// re-deploy. Rejects with SCHEMA_NOT_TYPED_FOR_PARQUET when any output
// column lacks a concrete type.
router.post('/:pipelineId/migrate-output-format', authenticate, owner, pipelineController.migrateOutputFormat);

// PB-B4: Iceberg snapshot history + time travel reads.
router.get('/:pipelineId/output/snapshots', authenticate, viewer, pipelineController.listOutputSnapshots);
router.get('/:pipelineId/output', authenticate, viewer, pipelineController.readOutputAsOf);

// PB-B5: streaming restart + live stats.
router.post('/:pipelineId/deployments/:deploymentId/restart', authenticate, owner, pipelineController.restartStreamingDeployment);
router.get('/:pipelineId/deployments/:deploymentId/streaming-stats', authenticate, viewer, pipelineController.streamingStats);

// PB-B7 — ACL management endpoints. Owner-only: lists and mutations
// require the principal to have 'owner' on the pipeline.
router.get('/:pipelineId/acl', authenticate, owner, pipelineController.listAcl);
router.put('/:pipelineId/acl/:principalId', authenticate, owner, pipelineController.upsertAcl);
router.delete('/:pipelineId/acl/:principalId', authenticate, owner, pipelineController.revokeAcl);

// Viewport save/restore — per PB-B7 both are mutations/reads on
// pipeline state but viewports are trivial UX state; treat them as
// viewer (read) and editor (save) respectively.
router.put('/:pipelineId/viewport', authenticate, editor, pipelineController.saveViewport);
router.get('/:pipelineId/viewport', authenticate, viewer, pipelineController.getViewport);

// Pipeline node routes — node CRUD is PUT/POST/DELETE on pipeline state → editor.
router.post('/:pipelineId/nodes', authenticate, editor, pipelineController.addNode);
router.post('/:pipelineId/nodes/bulk', authenticate, editor, pipelineController.addNodesBulk);
router.get('/:pipelineId/nodes', authenticate, viewer, pipelineController.listNodes);
router.put('/:pipelineId/nodes/:nodeId', authenticate, editor, pipelineController.updateNode);
router.delete('/:pipelineId/nodes/:nodeId', authenticate, editor, pipelineController.deleteNode);
router.delete('/:pipelineId/nodes', authenticate, editor, pipelineController.deleteAllNodes);
router.patch('/:pipelineId/nodes/positions', authenticate, editor, pipelineController.batchUpdatePositions);

// Transform endpoints — previews are reads (viewer); applies mutate the
// node's transform chain (editor).
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/preview', authenticate, viewer, pipelineController.castPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/apply', authenticate, editor, pipelineController.castApply);

router.post('/:pipelineId/nodes/:nodeId/transforms/filter/preview', authenticate, viewer, pipelineController.filterPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/filter/apply', authenticate, editor, pipelineController.filterApply);

router.post('/:pipelineId/nodes/:nodeId/transforms/drop/preview', authenticate, viewer, pipelineController.dropPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/drop/apply', authenticate, editor, pipelineController.dropApply);

router.post('/:pipelineId/nodes/:nodeId/transforms/rename/preview', authenticate, viewer, pipelineController.renamePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/rename/apply', authenticate, editor, pipelineController.renameApply);

router.post('/:pipelineId/nodes/:nodeId/join/preview', authenticate, viewer, pipelineController.joinPreview);
router.post('/:pipelineId/nodes/:nodeId/join/apply', authenticate, editor, pipelineController.joinApply);

router.post('/:pipelineId/nodes/:nodeId/union/preview', authenticate, viewer, pipelineController.unionPreview);
router.post('/:pipelineId/nodes/:nodeId/union/apply', authenticate, editor, pipelineController.unionApply);

router.post('/:pipelineId/nodes/:nodeId/transforms/normalize/preview', authenticate, viewer, pipelineController.normalizePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/normalize/apply', authenticate, editor, pipelineController.normalizeApply);

// Execute full transform chain — executes against upstream data so it's
// effectively a read-side preview, viewer-level.
router.post('/:pipelineId/nodes/:nodeId/transforms/execute', authenticate, viewer, pipelineController.executeChain);

// Output preview — fully resolved data from upstream chain (read).
router.post('/:pipelineId/nodes/:nodeId/output/preview', authenticate, viewer, pipelineController.outputPreview);

// Preview snapshot — save (editor) and retrieve (viewer).
router.post('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, editor, pipelineController.savePreviewSnapshot);
router.get('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, viewer, pipelineController.getPreviewSnapshot);

export default router;
