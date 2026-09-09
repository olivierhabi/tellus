// ---------------------------------------------------------------------------
// Column-name ops — extracted from transformService.ts:
//   Rename, Normalize (normalizeColumnNamesV1),
//   UppercaseColumnNames (uppercaseColumnNamesV1).
//
// Each op contributes a pure row-transform (shared by the preview and the
// chain replay) and the preview/apply entry points. IO seams come in via
// TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  RenamePreviewInput,
  RenameApplyInput,
  NormalizePreviewInput,
  NormalizeApplyInput,
  UppercaseColumnNamesPreviewInput,
  UppercaseColumnNamesApplyInput,
} from '../../../types/pipeline';
import { normalizeColumnName, sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Pure row transforms (chain-replay semantics)
// ---------------------------------------------------------------------------

/** Rename columns per `{from → to}` pairs (BOM-insensitive on `from`). */
export function applyRenameRows(
  rows: Array<Record<string, unknown>>,
  renames: Array<{ from: string; to: string }>,
): Array<Record<string, unknown>> {
  const map = new Map(renames.map((r) => [stripBom(r.from), r.to]));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[map.get(stripBom(k)) ?? k] = v;
    }
    return out;
  });
}

/**
 * Build the normalize map { oldName → newName } for a column list, resolving
 * collisions by appending _1, _2, … in first-appearance order.
 */
export function buildNormalizeMap(
  columnNames: string[],
  removeSpecial: boolean,
): Map<string, string> {
  const normalizeMap = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const name of columnNames) {
    let newName = normalizeColumnName(name, removeSpecial);
    if (usedNames.has(newName)) {
      let i = 1;
      while (usedNames.has(`${newName}_${i}`)) i++;
      newName = `${newName}_${i}`;
    }
    usedNames.add(newName);
    normalizeMap.set(stripBom(name), newName);
  }
  return normalizeMap;
}

/** Chain-replay Normalize: the map is derived from the rows' own keys. */
export function applyNormalizeRows(
  rows: Array<Record<string, unknown>>,
  removeSpecial: boolean,
): Array<Record<string, unknown>> {
  if (rows.length === 0) return rows;
  const nMap = buildNormalizeMap(Object.keys(rows[0]), removeSpecial);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) { out[nMap.get(k) ?? k] = v; }
    return out;
  });
}

/** Uppercase every column name; values untouched. */
export function applyUppercaseRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k.toUpperCase()] = v;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Rename — Preview / Apply
// ---------------------------------------------------------------------------

export async function renamePreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: RenamePreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(
    projectId, pipelineId, nodeId,
  );

  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);

  // Build rename map { from → to }
  const renameMap = new Map<string, string>();
  for (const r of input.renames) {
    const from = stripBom(r.from);
    if (!effectiveCols.some((c) => stripBom(c.name) === from)) {
      throw new AppError(
        `Column "${from}" does not exist. Available: ${effectiveCols.map((c) => stripBom(c.name)).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
    renameMap.set(from, r.to);
  }

  // Read and replay prior transforms
  const chainedRows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  // Apply renames to rows
  const renamedRows = chainedRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const cleanK = stripBom(k);
      const newName = renameMap.get(cleanK) ?? k;
      out[newName] = v;
    }
    return out;
  });

  const rows = renamedRows.slice(0, input.limit);

  // Build output columns with renames applied
  const outputColumns = effectiveCols.map((c) => {
    const cleanName = stripBom(c.name);
    const newName = renameMap.get(cleanName);
    return {
      name: newName ?? c.name,
      type: c.type,
      renamed: !!newName,
      originalName: newName ? c.name : undefined,
    };
  });

  return {
    columns: outputColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    totalRows: chainedRows.length,
    renames: input.renames,
  };
}

export async function renameApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: RenameApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Rename',
    renames: input.renames.map((r) => ({ from: stripBom(r.from), to: r.to })),
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Normalize — Preview / Apply
// ---------------------------------------------------------------------------

export async function normalizePreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: NormalizePreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);

  // Build normalize map { oldName → newName }
  const normalizeMap = buildNormalizeMap(effectiveCols.map((c) => c.name), input.removeSpecialCharacters);

  // Read and replay prior transforms
  const chainedRows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  // Apply normalization to rows
  const normalizedRows = chainedRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[normalizeMap.get(stripBom(k)) ?? k] = v;
    }
    return out;
  });

  const rows = normalizedRows.slice(0, input.limit);

  const outputColumns = effectiveCols.map((c) => {
    const newName = normalizeMap.get(stripBom(c.name));
    return {
      name: newName ?? c.name,
      type: c.type,
      normalized: newName !== c.name,
      originalName: newName !== c.name ? c.name : undefined,
    };
  });

  return {
    columns: outputColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    totalRows: chainedRows.length,
    removeSpecialCharacters: input.removeSpecialCharacters,
  };
}

export async function normalizeApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: NormalizeApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Normalize',
    removeSpecialCharacters: input.removeSpecialCharacters,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Uppercase Column Names — Preview / Apply
// ---------------------------------------------------------------------------

export async function uppercaseColumnNamesPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: UppercaseColumnNamesPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  const transformed = applyUppercaseRows(rows).slice(0, input.limit);

  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms)
    .map((c) => ({ name: c.name.toUpperCase(), type: c.type, normalized: true }));

  return {
    columns: effectiveColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    renameSummary: `Uppercased ${effectiveColumns.length} column names`,
  };
}

export async function uppercaseColumnNamesApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  _input: UppercaseColumnNamesApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'UppercaseColumnNames',
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
