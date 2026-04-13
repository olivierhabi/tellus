import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { PipelineController } from '../controllers/pipelineController';
import { PipelineService } from '../services/pipelineService';
import { TransformService } from '../services/transformService';
import { DeploymentService } from '../services/deploymentService';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });
const pipelineService = new PipelineService(foundryDb);
const transformService = new TransformService(foundryDb);
const deploymentService = new DeploymentService(foundryDb, transformService);
const pipelineController = new PipelineController(pipelineService, transformService, deploymentService);

router.post('/', authenticate, pipelineController.create);
router.get('/', authenticate, pipelineController.list);
router.get('/:pipelineId', authenticate, pipelineController.getById);
router.put('/:pipelineId', authenticate, pipelineController.update);
router.delete('/:pipelineId', authenticate, pipelineController.delete);

// Save pipeline progress (atomic full-state save)
router.post('/:pipelineId/save', authenticate, pipelineController.savePipelineProgress);

// Deploy pipeline (execute + build outputs)
router.post('/:pipelineId/deploy', authenticate, pipelineController.deployPipeline);
router.get('/:pipelineId/deployments', authenticate, pipelineController.listDeployments);
router.get('/:pipelineId/deployments/:deploymentId', authenticate, pipelineController.getDeployment);

// Viewport save/restore
router.put('/:pipelineId/viewport', authenticate, pipelineController.saveViewport);
router.get('/:pipelineId/viewport', authenticate, pipelineController.getViewport);

// Pipeline node routes
router.post('/:pipelineId/nodes', authenticate, pipelineController.addNode);
router.post('/:pipelineId/nodes/bulk', authenticate, pipelineController.addNodesBulk);
router.get('/:pipelineId/nodes', authenticate, pipelineController.listNodes);
router.put('/:pipelineId/nodes/:nodeId', authenticate, pipelineController.updateNode);
router.delete('/:pipelineId/nodes/:nodeId', authenticate, pipelineController.deleteNode);
router.delete('/:pipelineId/nodes', authenticate, pipelineController.deleteAllNodes);
router.patch('/:pipelineId/nodes/positions', authenticate, pipelineController.batchUpdatePositions);

// Transform endpoints — Cast
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/preview', authenticate, pipelineController.castPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/apply', authenticate, pipelineController.castApply);

// Transform endpoints — Filter
router.post('/:pipelineId/nodes/:nodeId/transforms/filter/preview', authenticate, pipelineController.filterPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/filter/apply', authenticate, pipelineController.filterApply);

// Transform endpoints — Drop Columns
router.post('/:pipelineId/nodes/:nodeId/transforms/drop/preview', authenticate, pipelineController.dropPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/drop/apply', authenticate, pipelineController.dropApply);

// Transform endpoints — Rename Columns
router.post('/:pipelineId/nodes/:nodeId/transforms/rename/preview', authenticate, pipelineController.renamePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/rename/apply', authenticate, pipelineController.renameApply);

// Join endpoints
router.post('/:pipelineId/nodes/:nodeId/join/preview', authenticate, pipelineController.joinPreview);
router.post('/:pipelineId/nodes/:nodeId/join/apply', authenticate, pipelineController.joinApply);

// Union by name endpoints
router.post('/:pipelineId/nodes/:nodeId/union/preview', authenticate, pipelineController.unionPreview);
router.post('/:pipelineId/nodes/:nodeId/union/apply', authenticate, pipelineController.unionApply);

// Transform endpoints — Normalize Column Names
router.post('/:pipelineId/nodes/:nodeId/transforms/normalize/preview', authenticate, pipelineController.normalizePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/normalize/apply', authenticate, pipelineController.normalizeApply);

// Execute full transform chain
router.post('/:pipelineId/nodes/:nodeId/transforms/execute', authenticate, pipelineController.executeChain);

// Output preview — fully resolved data from upstream chain
router.post('/:pipelineId/nodes/:nodeId/output/preview', authenticate, pipelineController.outputPreview);

// Preview snapshot — save and retrieve
router.post('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, pipelineController.savePreviewSnapshot);
router.get('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, pipelineController.getPreviewSnapshot);

export default router;
