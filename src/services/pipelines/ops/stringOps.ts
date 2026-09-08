// ---------------------------------------------------------------------------
// String ops — extracted from transformService.ts:
//   ConcatenateStrings and FormatString (Palantir formatStringV1).
// IO seams come in via TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  ConcatenateStringsPreviewInput,
  ConcatenateStringsApplyInput,
  FormatStringPreviewInput,
  FormatStringApplyInput,
} from '../../../types/pipeline';
import {
  concatenateStringValues,
  formatStringValue,
  sampleInfo,
  stripBom,
} from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Concatenate Strings — Preview / Apply
// ---------------------------------------------------------------------------

export async function concatenateStringsPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ConcatenateStringsPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const expression of input.expressions) {
    if (expression.kind === 'column' && !effectiveCols.some((column) => stripBom(column.name) === stripBom(expression.value))) {
      throw new AppError(`Expression references column "${expression.value}" which does not exist.`, 400, 'VALIDATION_ERROR');
    }
  }
  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = rows.slice(0, input.limit).map((row) => ({
    ...row,
    [input.outputColumn]: concatenateStringValues(row, input.expressions, input.separator, input.nullOutputIfAnyInputIsNull),
  }));
  const exists = effectiveCols.some((column) => column.name === input.outputColumn);
  const columns = exists
    ? effectiveCols.map((column) => column.name === input.outputColumn ? { ...column, type: 'string' } : column)
    : [...effectiveCols, { name: input.outputColumn, type: 'string', isNew: true }];
  return {
    columns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Concatenated ${input.expressions.length} string expression(s) into "${input.outputColumn}"`,
  };
}

export async function concatenateStringsApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ConcatenateStringsApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({ function: 'ConcatenateStrings', ...input, createdAt: new Date().toISOString() });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Format String — Preview / Apply
// ---------------------------------------------------------------------------

export async function formatStringPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: FormatStringPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const a of input.arguments) {
    if (a.kind === 'column' && !effectiveCols.some((c) => stripBom(c.name) === stripBom(a.value))) {
      throw new AppError(
        `Format argument references column "${a.value}" which does not exist. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = rows.slice(0, input.limit).map((row) => ({
    ...row,
    [input.outputColumn]: formatStringValue(
      input.format,
      input.arguments.map((a) => (a.kind === 'column' ? row[a.value] : a.value)),
    ),
  }));

  const exists = effectiveCols.some((c) => c.name === input.outputColumn);
  const columns = exists
    ? effectiveCols.map((c) => (c.name === input.outputColumn ? { ...c, type: 'string' } : c))
    : [...effectiveCols, { name: input.outputColumn, type: 'string', isNew: true }];
  return {
    columns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Formatted "${input.outputColumn}" with formatStringV1 (${input.arguments.length} argument(s))`,
  };
}

export async function formatStringApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: FormatStringApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({ function: 'FormatString', ...input, createdAt: new Date().toISOString() });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

