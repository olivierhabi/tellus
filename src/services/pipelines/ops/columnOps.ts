// ---------------------------------------------------------------------------
// Column ops — extracted from transformService.ts:
//   Drop (dropColumnsV1-ish), Select (selectV1), RowSize (rowSizeV1).
//   (Rename / Normalize / UppercaseColumnNames live in ./columnNameOps.)
//
// Each op contributes a pure row-transform (shared by the preview and the
// chain replay) and the preview/apply entry points. IO seams come in via
// TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  DropPreviewInput,
  DropApplyInput,
  SelectPreviewInput,
  SelectApplyInput,
  RowSizePreviewInput,
  RowSizeApplyInput,
} from '../../../types/pipeline';
import { sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Pure row transforms (chain-replay semantics)
// ---------------------------------------------------------------------------

/** Remove the given columns from every row. Throws when nothing survives. */
export function applyDropColumnsRows(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): Array<Record<string, unknown>> {
  const dropCols = new Set(columns.map(stripBom));
  const result = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!dropCols.has(stripBom(k))) out[k] = v;
    }
    return out;
  });
  if (result.length > 0 && Object.keys(result[0]).length === 0) {
    throw new AppError('Drop removed every column.', 400, 'DROP_ALL_COLUMNS');
  }
  return result;
}

/** Keep only the listed columns, in the user's order; missing → null. */
export function applySelectRows(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): Array<Record<string, unknown>> {
  const keep = columns.map(stripBom);
  const result = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const k of keep) out[k] = row[k] ?? null;
    return out;
  });
  if (result.length > 0 && Object.keys(result[0]).length === 0) {
    throw new AppError('Select kept zero columns.', 400, 'VALIDATION_ERROR');
  }
  return result;
}

/** Add a per-row byte-size estimate column (JSON.stringify byte length). */
export function applyRowSizeRows(
  rows: Array<Record<string, unknown>>,
  outputColumn: string,
): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row, [outputColumn]: Buffer.byteLength(JSON.stringify(row), 'utf8') }));
}

// ---------------------------------------------------------------------------
// Drop — Preview / Apply
// ---------------------------------------------------------------------------

export async function dropPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: DropPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(
    projectId,
    pipelineId,
    nodeId,
  );

  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const colsToDrop = new Set(input.columns.map(stripBom));

  // Validate columns exist
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const col of colsToDrop) {
    if (!effectiveCols.some((c) => stripBom(c.name) === col)) {
      throw new AppError(
        `Column "${col}" does not exist. Available: ${effectiveCols.map((c) => stripBom(c.name)).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }

  // Refuse to drop every column — the DuckDB build compiler enforces the
  // same rule ("Drop removed every column.").
  if (colsToDrop.size >= effectiveCols.length) {
    throw new AppError('Drop removed every column.', 400, 'DROP_ALL_COLUMNS');
  }

  // Read and replay prior transforms
  const chainedRows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  // Drop columns from each row
  const droppedRows = chainedRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!colsToDrop.has(stripBom(k))) out[k] = v;
    }
    return out;
  });

  const rows = droppedRows.slice(0, input.limit);

  // Build output columns (prior chain columns minus dropped)
  const outputColumns = effectiveCols
    .filter((c) => !colsToDrop.has(stripBom(c.name)))
    .map((c) => ({ name: c.name, type: c.type }));

  return {
    columns: outputColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    totalRows: chainedRows.length,
    droppedColumns: [...colsToDrop],
  };
}

export async function dropApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: DropApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Drop',
    columns: input.columns.map(stripBom),
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Select — Preview / Apply
// ---------------------------------------------------------------------------

export async function selectPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: SelectPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const unknown = input.columns.filter((c) => !effectiveCols.some((ec) => stripBom(ec.name) === stripBom(c)));
  if (unknown.length > 0) {
    throw new AppError(
      `Columns not found: ${unknown.join(', ')}. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
      400,
      'VALIDATION_ERROR',
    );
  }

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  // Preserve order to user's listed order.
  const ordered = input.columns.map(stripBom);
  const transformed = rows
    .map((row) => {
      const out: Record<string, unknown> = {};
      for (const k of ordered) out[k] = row[k] ?? null;
      return out;
    })
    .slice(0, input.limit);

  const outputColumns = ordered.map((name) => {
    const found = effectiveCols.find((c) => stripBom(c.name) === name);
    return { name, type: found?.type ?? 'string' };
  });

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    totalRows: rows.length,
    selectSummary: `Keep ${ordered.length} of ${effectiveCols.length} columns`,
  };
}

export async function selectApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: SelectApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Select',
    columns: input.columns,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Row Size — Preview / Apply
// ---------------------------------------------------------------------------

export async function rowSizePreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: RowSizePreviewInput,
) {
  const outCol = input.outputColumn?.trim() || 'row_size';
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = applyRowSizeRows(rows, outCol).slice(0, input.limit);

  const baseCols = effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  const exists = baseCols.some((c) => c.name === outCol);
  const outputColumns = exists
    ? baseCols.map((c) => (c.name === outCol ? { ...c, type: 'integer' } : c))
    : [...baseCols, { name: outCol, type: 'integer', isNew: true }];

  return {
    columns: outputColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    rowSizeSummary: `Added column "${outCol}" with row byte size`,
  };
}

export async function rowSizeApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: RowSizeApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'RowSize',
    outputColumn: input.outputColumn?.trim() || 'row_size',
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
