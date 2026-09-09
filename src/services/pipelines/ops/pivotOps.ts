// ---------------------------------------------------------------------------
// Pivot / Unpivot ops (Palantir pivotV1 long→wide, unpivotV1 wide→long) —
// extracted from transformService.ts.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  AggregationItem,
  PivotPreviewInput,
  PivotApplyInput,
  UnpivotPreviewInput,
  UnpivotApplyInput,
} from '../../../types/pipeline';
import { sampleInfo } from './shared';
import { aggregationOutputType, evalAggregation } from './aggregateOps';
import type { TransformOpsContext } from './transformOpsContext';

/**
 * PivotV1 core. Mirrors the DuckDB emitter: one column per
 * (pivotValue × aggregation), valued by a filtered aggregate over the
 * rows where `pivotColumn = value`; output name is
 * `prefix` → `<alias>_<outputColumn>` / `suffix` → `<outputColumn>_<alias>`.
 * Values outside `pivotValues` contribute no columns or groups; groups
 * with no matching rows produce SQL-consistent cells (count=0, sum=null).
 */
export function computePivot(
  rows: Array<Record<string, unknown>>,
  groupBy: string[],
  pivotColumn: string,
  pivotValues: Array<{ value: string; alias: string }>,
  aggregations: AggregationItem[],
  aliasPosition: 'prefix' | 'suffix',
): { rows: Array<Record<string, unknown>>; valueColumns: string[] } {
  const nameFor = (alias: string, agg: AggregationItem) =>
    aliasPosition === 'prefix'
      ? `${alias}_${agg.outputColumn}`
      : `${agg.outputColumn}_${alias}`;
  const valueColumns = pivotValues.flatMap((pv) =>
    aggregations.map((agg) => nameFor(pv.alias, agg)),
  );
  // Group rows by the groupBy key (nulls form their own group, first
  // appearance order — same as computeAggregations).
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const order: string[] = [];
  for (const row of rows) {
    const key = JSON.stringify(groupBy.map((c) => row[c] ?? null));
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
  }
  const rowsOut = order.map((key) => {
    const keyVals = JSON.parse(key) as unknown[];
    const groupRows = groups.get(key) ?? [];
    const outRow: Record<string, unknown> = {};
    groupBy.forEach((c, i) => { outRow[c] = keyVals[i]; });
    for (const pv of pivotValues) {
      const cellRows = groupRows.filter((r) => {
        const v = r[pivotColumn];
        return v !== null && v !== undefined && String(v) === pv.value;
      });
      for (const agg of aggregations) {
        outRow[nameFor(pv.alias, agg)] = evalAggregation(agg, cellRows);
      }
    }
    return outRow;
  });
  return { rows: rowsOut, valueColumns };
}

/** unpivotV1 core: one row per (kept key, unpivoted column). */
export function computeUnpivot(
  rows: Array<Record<string, unknown>>,
  columnsToUnpivot: string[],
  nameColumn: string,
  valueColumn: string,
  keptColumns: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    for (const c of columnsToUnpivot) {
      const outRow: Record<string, unknown> = {
        [nameColumn]: c,
        [valueColumn]: row[c] ?? null,
      };
      for (const k of keptColumns) outRow[k] = row[k] ?? null;
      out.push(outRow);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pivot — Preview / Apply
// ---------------------------------------------------------------------------

export async function pivotPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: PivotPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  ctx.assertColumnsExist(effectiveNames, [input.pivotColumn, ...input.groupBy, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Pivot');
  if (input.aggregations.some((a) => !a.column)) {
    throw new AppError('Pivot aggregations require a column (count(*) pivot is not supported).', 400, 'VALIDATION_ERROR');
  }

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const { rows: allRows, valueColumns } = computePivot(
    chained, input.groupBy, input.pivotColumn, input.pivotValues, input.aggregations, input.aliasPosition,
  );

  const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
  const typesByName = new Map(input.aggregations.map((item) => [
    item.outputColumn,
    aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
  ]));
  const outColumns = [
    ...input.groupBy.map((g) => ({ name: g, type: typeOf(g) })),
    ...valueColumns.map((vc) => {
      const aggName = input.aggregations
        .map((a) => a.outputColumn)
        .find((n) => vc.endsWith(`_${n}`) || vc.startsWith(`${n}_`));
      return { name: vc, type: aggName ? (typesByName.get(aggName) ?? 'string') : 'string' };
    }),
  ];

  const rows = allRows.slice(0, input.limit);
  return {
    columns: outColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    pivotSummary: `Pivot "${input.pivotColumn}" → ${valueColumns.length} output column(s)`,
  };
}

export async function pivotApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: PivotApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Pivot',
    groupBy: input.groupBy,
    pivotColumn: input.pivotColumn,
    pivotValues: input.pivotValues,
    aggregations: input.aggregations,
    aliasPosition: input.aliasPosition,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Unpivot — Preview / Apply
// ---------------------------------------------------------------------------

export async function unpivotPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: UnpivotPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  ctx.assertColumnsExist(effectiveNames, input.columns, 'Unpivot');
  if (effectiveNames.has(input.nameColumn) || effectiveNames.has(input.valueColumn)) {
    throw new AppError('Unpivot name/value column names must not collide with existing columns', 400, 'VALIDATION_ERROR');
  }

  const unpivotSet = new Set(input.columns);
  const keptColumns = effectiveColumns.filter((c) => !unpivotSet.has(c.name));
  const outColumns = [
    { name: input.nameColumn, type: 'string' },
    { name: input.valueColumn, type: 'string' },
    ...keptColumns.map((c) => ({ name: c.name, type: c.type })),
  ];

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = computeUnpivot(chained, input.columns, input.nameColumn, input.valueColumn, keptColumns.map((c) => c.name)).slice(0, input.limit);

  return {
    columns: outColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    unpivotSummary: `Unpivot ${input.columns.length} column(s) → "${input.nameColumn}" / "${input.valueColumn}"`,
  };
}

export async function unpivotApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: UnpivotApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Unpivot',
    columns: input.columns,
    nameColumn: input.nameColumn,
    valueColumn: input.valueColumn,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
