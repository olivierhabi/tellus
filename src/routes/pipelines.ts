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

// Foundry build schedule — editor-configured; the pipeline build scheduler
// rebuilds the pipeline every interval while enabled.
router.get('/:pipelineId/schedule', authenticate, viewer, pipelineController.getBuildSchedule);
router.put('/:pipelineId/schedule', authenticate, editor, pipelineController.updateBuildSchedule);

// Foundry data expectations — declarative data-quality gates on builds.
router.get('/:pipelineId/expectations', authenticate, viewer, pipelineController.listExpectations);
router.post('/:pipelineId/expectations', authenticate, editor, pipelineController.addExpectation);
router.delete('/:pipelineId/expectations/:expectationId', authenticate, editor, pipelineController.removeExpectation);

// Pipeline node routes — node CRUD is PUT/POST/DELETE on pipeline state → editor.
router.post('/:pipelineId/nodes', authenticate, editor, pipelineController.addNode);
router.post('/:pipelineId/nodes/bulk', authenticate, editor, pipelineController.addNodesBulk);
// §2 direct Kafka→pipeline: register a Kafka topic as a streaming source node.
router.post('/:pipelineId/nodes/kafka-source', authenticate, editor, pipelineController.addKafkaStreamSource);
router.get('/:pipelineId/nodes', authenticate, viewer, pipelineController.listNodes);
router.put('/:pipelineId/nodes/:nodeId', authenticate, editor, pipelineController.updateNode);
// Foundry "Overwrite dataset": one-time ownership grant of an existing
// dataset to an output node. Editor role, explicit confirm required.
router.post('/:pipelineId/nodes/:nodeId/adopt-output', authenticate, editor, pipelineController.adoptOutputDataset);
router.delete('/:pipelineId/nodes/:nodeId', authenticate, editor, pipelineController.deleteNode);
router.delete('/:pipelineId/nodes', authenticate, editor, pipelineController.deleteAllNodes);
router.patch('/:pipelineId/nodes/positions', authenticate, editor, pipelineController.batchUpdatePositions);

// Transform endpoints — previews are reads (viewer); applies mutate the
// node's transform chain (editor).
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/preview', authenticate, viewer, pipelineController.castPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/cast/apply', authenticate, editor, pipelineController.castApply);

// UDF — user-authored code transform, executed in the gVisor sandbox (§2).
router.post('/:pipelineId/nodes/:nodeId/transforms/udf/preview', authenticate, viewer, pipelineController.udfPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/udf/apply', authenticate, editor, pipelineController.udfApply);

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

// Tier A single-input transforms (PB-B2.follow).
router.post('/:pipelineId/nodes/:nodeId/transforms/select/preview', authenticate, viewer, pipelineController.selectPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/select/apply', authenticate, editor, pipelineController.selectApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/sort/preview', authenticate, viewer, pipelineController.sortPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/sort/apply', authenticate, editor, pipelineController.sortApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/drop-duplicates/preview', authenticate, viewer, pipelineController.dropDuplicatesPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/drop-duplicates/apply', authenticate, editor, pipelineController.dropDuplicatesApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/uppercase-column-names/preview', authenticate, viewer, pipelineController.uppercaseColumnNamesPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/uppercase-column-names/apply', authenticate, editor, pipelineController.uppercaseColumnNamesApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/row-size/preview', authenticate, viewer, pipelineController.rowSizePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/row-size/apply', authenticate, editor, pipelineController.rowSizeApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/clean-string/preview', authenticate, viewer, pipelineController.cleanStringPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/clean-string/apply', authenticate, editor, pipelineController.cleanStringApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-expression/preview', authenticate, viewer, pipelineController.applyExpressionPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-expression/apply', authenticate, editor, pipelineController.applyExpressionApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/case-expression/preview', authenticate, viewer, pipelineController.caseExpressionPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/case-expression/apply', authenticate, editor, pipelineController.caseExpressionApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/concatenate-strings/preview', authenticate, viewer, pipelineController.concatenateStringsPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/concatenate-strings/apply', authenticate, editor, pipelineController.concatenateStringsApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/format-string/preview', authenticate, viewer, pipelineController.formatStringPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/format-string/apply', authenticate, editor, pipelineController.formatStringApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-multiple-expressions/preview', authenticate, viewer, pipelineController.applyMultipleExpressionsPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-multiple-expressions/apply', authenticate, editor, pipelineController.applyMultipleExpressionsApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-to-multiple-columns/preview', authenticate, viewer, pipelineController.applyToMultipleColumnsPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/apply-to-multiple-columns/apply', authenticate, editor, pipelineController.applyToMultipleColumnsApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/compute-if-absent/preview', authenticate, viewer, pipelineController.computeIfExpressionAbsentPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/compute-if-absent/apply', authenticate, editor, pipelineController.computeIfExpressionAbsentApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/text-block/preview', authenticate, viewer, pipelineController.textBlockPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/text-block/apply', authenticate, editor, pipelineController.textBlockApply);

// Tier B aggregate-family transforms (PB-B2.follow-2).
router.post('/:pipelineId/nodes/:nodeId/transforms/aggregate/preview', authenticate, viewer, pipelineController.aggregatePreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/aggregate/apply', authenticate, editor, pipelineController.aggregateApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/rollup/preview', authenticate, viewer, pipelineController.rollupPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/rollup/apply', authenticate, editor, pipelineController.rollupApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/aggregate-on-condition/preview', authenticate, viewer, pipelineController.aggregateOnConditionPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/aggregate-on-condition/apply', authenticate, editor, pipelineController.aggregateOnConditionApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/top-rows/preview', authenticate, viewer, pipelineController.topRowsPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/top-rows/apply', authenticate, editor, pipelineController.topRowsApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/pivot/preview', authenticate, viewer, pipelineController.pivotPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/pivot/apply', authenticate, editor, pipelineController.pivotApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/unpivot/preview', authenticate, viewer, pipelineController.unpivotPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/unpivot/apply', authenticate, editor, pipelineController.unpivotApply);
router.post('/:pipelineId/nodes/:nodeId/transforms/keep-duplicates/preview', authenticate, viewer, pipelineController.keepDuplicatesPreview);
router.post('/:pipelineId/nodes/:nodeId/transforms/keep-duplicates/apply', authenticate, editor, pipelineController.keepDuplicatesApply);

// Execute full transform chain — executes against upstream data so it's
// effectively a read-side preview, viewer-level.
router.post('/:pipelineId/nodes/:nodeId/transforms/execute', authenticate, viewer, pipelineController.executeChain);

// Output preview — fully resolved data from upstream chain (read).
router.post('/:pipelineId/nodes/:nodeId/output/preview', authenticate, viewer, pipelineController.outputPreview);

// Preview snapshot — save (editor) and retrieve (viewer).
router.post('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, editor, pipelineController.savePreviewSnapshot);
router.get('/:pipelineId/nodes/:nodeId/preview-snapshot', authenticate, viewer, pipelineController.getPreviewSnapshot);

export default router;
