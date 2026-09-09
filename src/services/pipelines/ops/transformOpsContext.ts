// ---------------------------------------------------------------------------
// The seam between TransformService (DB / object-store IO, chain replay) and
// the per-operation modules under src/services/pipelines/ops/.
//
// Every extracted op is a set of functions taking this context as their first
// parameter instead of living as methods on the TransformService god-class.
// The service instance itself satisfies the interface, so existing tests that
// stub these seams on the instance (resolvePreviewInput, walkTransitiveInputs,
// unionPreview, …) keep working unchanged.
// ---------------------------------------------------------------------------

import type { UnionPreviewInput } from '../../../types/pipeline';

export interface PreviewInputResolution {
  dataset: { id: string; file_path: string; status: string } | null;
  sourceColumns: Array<{ name: string; type: string }>;
  existingTransforms: unknown[];
  baseRows: Array<Record<string, unknown>>;
}

export interface NodeDataResolution {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  truncated?: boolean;
}

export interface TransitiveInputSnapshot {
  nodeId: string;
  datasetId: string | null;
  filePath: string | null;
  format: string | null;
}

export interface TransformOpsContext {
  resolvePreviewInput(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<PreviewInputResolution>;

  applyExistingTransforms(
    rows: Array<Record<string, unknown>>,
    transforms: unknown[],
  ): Array<Record<string, unknown>>;

  applyExistingTransformColumns(
    sourceColumns: Array<{ name: string; type: string }>,
    transforms: unknown[],
  ): Array<{ name: string; type: string }>;

  fetchNodeConfig(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<{ id: string; config: Record<string, unknown> }>;

  saveNodeConfig(
    nodeId: string,
    pipelineId: string,
    config: Record<string, unknown>,
  ): Promise<unknown>;

  assertColumnsExist(
    effectiveNames: Set<string>,
    needed: string[],
    fnName: string,
  ): void;

  resolveNodeData(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    priorTransforms?: unknown[],
  ): Promise<NodeDataResolution>;

  persistExecutionSnapshot(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    columns: Array<{ name: string; type: string }>,
    rows: Array<Record<string, unknown>>,
  ): Promise<void>;

  walkTransitiveInputs(
    pipelineId: string,
    startNodeId: string,
  ): Promise<TransitiveInputSnapshot[]>;

  unionPreview(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: UnionPreviewInput,
  ): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
  }>;
}
