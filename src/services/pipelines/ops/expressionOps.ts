// ---------------------------------------------------------------------------
// Expression-family ops — extracted from transformService.ts:
//   ApplyExpression (applyExpressionV1), CaseExpression,
//   (ConcatenateStrings / FormatString live in ./stringOps.)
//   ApplyMultipleExpressions (projectV1),
//   ApplyToMultipleColumns (projectOnConditionV1), ComputeIfExpressionAbsent
//   (computeExpressionIfAbsentV1), TextBlock (textBlockV1 — pure annotation).
//
// The binary-expression evaluator itself lives in ./shared; this module holds
// the per-op row application and the preview/apply entry points.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  CastTargetType,
  Operand,
  ExpressionItem,
  ApplyExpressionPreviewInput,
  ApplyExpressionApplyInput,
  CaseExpressionPreviewInput,
  CaseExpressionApplyInput,
  ApplyMultipleExpressionsPreviewInput,
  ApplyMultipleExpressionsApplyInput,
  ApplyToMultipleColumnsPreviewInput,
  ApplyToMultipleColumnsApplyInput,
  ComputeIfExpressionAbsentPreviewInput,
  ComputeIfExpressionAbsentApplyInput,
  TextBlockPreviewInput,
  TextBlockApplyInput,
} from '../../../types/pipeline';
import {
  castExpressionResult,
  evaluateExpression,
  parseLiteral,
  sampleInfo,
  stripBom,
  validateExpressionColumns,
} from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Pure row transforms (chain-replay semantics)
// ---------------------------------------------------------------------------

export function applyExpressionToRows(
  rows: Array<Record<string, unknown>>,
  expr: ExpressionItem,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const result = evaluateExpression(row, expr);
    const cast = castExpressionResult(result, expr.outputType);
    return { ...row, [expr.outputColumn]: cast };
  });
}

export function applyCaseExpressionToRows(
  rows: Array<Record<string, unknown>>,
  input: CaseExpressionApplyInput,
): Array<Record<string, unknown>> {
  const resolve = (row: Record<string, unknown>, operand: Operand | null): unknown => {
    if (operand === null) return null;
    return operand.kind === 'column' ? row[operand.value] : parseLiteral(operand);
  };
  return rows.map((row) => {
    const matched = input.branches.find((branch) => evaluateExpression(row, branch.condition) === true);
    const value = resolve(row, matched?.value ?? input.defaultValue);
    return { ...row, [input.outputColumn]: castExpressionResult(value, input.outputType) };
  });
}

export function isValueAbsent(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.toLowerCase() === 'null');
}

/** ComputeIfExpressionAbsent replay: only fill rows where the target is absent. */
export function applyComputeIfAbsentRows(
  rows: Array<Record<string, unknown>>,
  outputColumn: string,
  expr: ExpressionItem,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const cur = row[outputColumn];
    if (!isValueAbsent(cur)) return row;
    const v = evaluateExpression(row, expr);
    return { ...row, [outputColumn]: castExpressionResult(v, expr.outputType) };
  });
}

// ---------------------------------------------------------------------------
// Apply Expression — Preview / Apply
// ---------------------------------------------------------------------------

export async function applyExpressionPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyExpressionPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  validateExpressionColumns(input.expression, effectiveCols);

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const outCol = input.expression.outputColumn;
  const transformed = applyExpressionToRows(rows, input.expression).slice(0, input.limit);

  const baseCols = effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  const resultType = input.expression.outputType ?? 'string';
  const exists = baseCols.some((c) => c.name === outCol);
  const outputColumns = exists
    ? baseCols.map((c) => (c.name === outCol ? { ...c, type: resultType } : c))
    : [...baseCols, { name: outCol, type: resultType, isNew: true }];

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Applied expression to column "${outCol}"`,
  };
}

export async function applyExpressionApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyExpressionApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'ApplyExpression',
    expression: input.expression,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Case Expression — Preview / Apply
// ---------------------------------------------------------------------------

export async function caseExpressionPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: CaseExpressionPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const branch of input.branches) {
    validateExpressionColumns(branch.condition as ExpressionItem, effectiveCols);
    if (branch.value.kind === 'column') validateExpressionColumns({ left: branch.value, right: branch.value } as ExpressionItem, effectiveCols);
  }
  if (input.defaultValue?.kind === 'column') validateExpressionColumns({ left: input.defaultValue, right: input.defaultValue } as ExpressionItem, effectiveCols);
  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = applyCaseExpressionToRows(rows, input).slice(0, input.limit);
  const outputColumns = effectiveCols.some((column) => column.name === input.outputColumn)
    ? effectiveCols.map((column) => column.name === input.outputColumn ? { ...column, type: input.outputType ?? 'string' } : column)
    : [...effectiveCols, { name: input.outputColumn, type: input.outputType ?? 'string', isNew: true }];
  return { columns: outputColumns, rows: transformed, rowCount: transformed.length, ...sampleInfo(rawRows.length), expressionSummary: `Applied Case expression to column "${input.outputColumn}"` };
}

export async function caseExpressionApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: CaseExpressionApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({ function: 'CaseExpression', ...input, createdAt: new Date().toISOString() });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Apply Multiple Expressions — Preview / Apply
// ---------------------------------------------------------------------------

export async function applyMultipleExpressionsPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyMultipleExpressionsPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const e of input.expressions) validateExpressionColumns(e, effectiveCols);

  let rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  for (const e of input.expressions) rows = applyExpressionToRows(rows, e);
  const transformed = rows.slice(0, input.limit);

  let outputColumns: Array<{ name: string; type: string; isNew?: boolean }> =
    effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  for (const e of input.expressions) {
    const t = e.outputType ?? 'string';
    const idx = outputColumns.findIndex((c) => c.name === e.outputColumn);
    if (idx >= 0) outputColumns[idx] = { ...outputColumns[idx], type: t };
    else outputColumns.push({ name: e.outputColumn, type: t, isNew: true });
  }

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Applied ${input.expressions.length} expression(s)`,
  };
}

export async function applyMultipleExpressionsApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyMultipleExpressionsApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'ApplyMultipleExpressions',
    expressions: input.expressions,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Apply To Multiple Columns — Preview / Apply
// ---------------------------------------------------------------------------

export async function applyToMultipleColumnsPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyToMultipleColumnsPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const cols = input.columns.map(stripBom);
  for (const c of cols) {
    if (!effectiveCols.some((ec) => stripBom(ec.name) === c)) {
      throw new AppError(
        `Column "${c}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }
  if (input.right.kind === 'column') {
    const r = stripBom(input.right.value);
    if (!effectiveCols.some((ec) => stripBom(ec.name) === r)) {
      throw new AppError(
        `Right-operand column "${r}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }
  if (input.outputColumns && input.outputColumns.length !== cols.length) {
    throw new AppError(
      `outputColumns length (${input.outputColumns.length}) must match columns length (${cols.length}).`,
      400,
      'VALIDATION_ERROR',
    );
  }
  const suffix = input.outputSuffix ?? '_calc';
  const outNames = input.outputColumns ?? cols.map((c) => `${c}${suffix}`);

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (let i = 0; i < cols.length; i++) {
      const expr: ExpressionItem = {
        left: { kind: 'column', value: cols[i] },
        operator: input.operator,
        right: input.right,
        outputColumn: outNames[i],
        outputType: input.outputType,
      };
      const v = evaluateExpression(row, expr);
      out[outNames[i]] = castExpressionResult(v, input.outputType);
    }
    return out;
  }).slice(0, input.limit);

  let outputColumns: Array<{ name: string; type: string; isNew?: boolean }> =
    effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  const t = input.outputType ?? 'string';
  for (const n of outNames) {
    const idx = outputColumns.findIndex((c) => c.name === n);
    if (idx >= 0) outputColumns[idx] = { ...outputColumns[idx], type: t, isNew: false };
    else outputColumns.push({ name: n, type: t, isNew: true });
  }

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Applied "${input.operator}" to ${cols.length} column(s) → ${outNames.join(', ')}`,
  };
}

export async function applyToMultipleColumnsApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ApplyToMultipleColumnsApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'ApplyToMultipleColumns',
    columns: input.columns,
    operator: input.operator,
    right: input.right,
    outputSuffix: input.outputSuffix,
    outputColumns: input.outputColumns,
    outputType: input.outputType,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Compute If Expression Absent — Preview / Apply
// ---------------------------------------------------------------------------

export async function computeIfExpressionAbsentPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ComputeIfExpressionAbsentPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  validateExpressionColumns(input.expression, effectiveCols);

  const outCol = input.outputColumn;
  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const expr = { ...input.expression, outputColumn: outCol } as ExpressionItem;
  const transformed = applyComputeIfAbsentRows(rows, outCol, expr).slice(0, input.limit);

  const baseCols = effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  const resultType = (input.expression as { outputType?: CastTargetType }).outputType ?? 'string';
  const exists = baseCols.some((c) => c.name === outCol);
  const outputColumns = exists
    ? baseCols.map((c) => (c.name === outCol ? { ...c, type: resultType } : c))
    : [...baseCols, { name: outCol, type: resultType, isNew: true }];

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    expressionSummary: `Filled "${outCol}" when absent`,
  };
}

export async function computeIfExpressionAbsentApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: ComputeIfExpressionAbsentApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'ComputeIfExpressionAbsent',
    outputColumn: input.outputColumn,
    expression: input.expression,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Text Block — Preview / Apply
// ---------------------------------------------------------------------------

export async function textBlockPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: TextBlockPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms).slice(0, input.limit);

  return {
    columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    textBlockSummary: input.title ? `Annotation: ${input.title}` : 'Annotation',
  };
}

export async function textBlockApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: TextBlockApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'TextBlock',
    text: input.text,
    title: input.title,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
