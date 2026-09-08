// ---------------------------------------------------------------------------
// Aggregate-family ops — extracted from transformService.ts:
//   Aggregate (groupAndAggregateV1), Rollup (rollupV1),
//   AggregateOnCondition (aggregateOnConditionV2).
//
// These mirror the field-reference semantics of the corresponding DuckDB
// compilers in duckdbTransformEngine.ts; preview rows flow through the
// legacy CSV path, so every helper here tolerates stringly-typed values
// and coerces numerics exactly like evalBinaryExpression does.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  AggregatePreviewInput,
  AggregateApplyInput,
  RollupPreviewInput,
  RollupApplyInput,
  AggregateOnConditionPreviewInput,
  AggregateOnConditionApplyInput,
  AggregationItem,
  ColumnPredicate,
  DynamicAggregation,
} from '../../../types/pipeline';
import { coerceNumeric, sampleInfo } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

/** Logical output type of an aggregation, derived from its input column. */
export function aggregationOutputType(item: AggregationItem, sourceType: string): string {
  switch (item.function) {
    case 'count':
    case 'count_distinct':
      return 'integer';
    case 'avg':
    case 'stddev':
    case 'variance':
      return 'double';
    case 'sum':
    case 'min':
    case 'max':
      return item.column ? sourceType : 'double';
  }
}

/**
 * Evaluate one aggregation item over the rows of a single group. Mirror
 * of the DuckDB engine's aggregateSql:
 *   count(col)   = non-null count; bare count = COUNT(*) (nulls included)
 *   *_distinct   = distinct non-null values
 *   numeric fns  = nulls skipped; all-null group → null
 *   stddev/var   = sample (n−1 denominator), n<2 → null (STDDEV_SAMP/VAR_SAMP)
 */
export function evalAggregation(
  item: AggregationItem,
  rows: Array<Record<string, unknown>>,
): unknown {
  const vals = item.column ? rows.map((r) => r[item.column as string]) : [];
  const nonNull = vals.filter((v) => v !== null && v !== undefined && v !== '');
  const numericVals: number[] = [];
  for (const v of nonNull) {
    const n = coerceNumeric(v);
    if (n !== null) numericVals.push(n);
  }
  switch (item.function) {
    case 'count':
      return item.column ? nonNull.length : rows.length;
    case 'count_distinct':
      return new Set(nonNull.map(String)).size;
    case 'sum':
      return numericVals.length ? numericVals.reduce((a, b) => a + b, 0) : null;
    case 'avg':
      return numericVals.length
        ? numericVals.reduce((a, b) => a + b, 0) / numericVals.length
        : null;
    case 'min':
      return numericVals.length ? Math.min(...numericVals) : null;
    case 'max':
      return numericVals.length ? Math.max(...numericVals) : null;
    case 'stddev':
    case 'variance': {
      if (numericVals.length < 2) return null;
      const mean = numericVals.reduce((a, b) => a + b, 0) / numericVals.length;
      const sq = numericVals.reduce((acc, b) => acc + (b - mean) ** 2, 0);
      const varSamp = sq / (numericVals.length - 1);
      return item.function === 'variance' ? varSamp : Math.sqrt(varSamp);
    }
  }
}

/**
 * GroupAndAggregate core: group rows by `groupBy` (nulls form their own
 * group, matching DuckDB GROUP BY) and evaluate every aggregation item
 * per group. Group order follows first appearance in the input.
 * When `aggregations` is empty the result is DISTINCT group keys —
 * mirrors Palantir groupAndAggregate note ("no aggregations → dedupe").
 */
export function computeAggregations(
  rows: Array<Record<string, unknown>>,
  groupBy: string[],
  aggregations: AggregationItem[],
): Array<Record<string, unknown>> {
  if (aggregations.length === 0) {
    const seen = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const key = JSON.stringify(groupBy.map((c) => row[c] ?? null));
      if (seen.has(key)) continue;
      seen.add(key);
      const outRow: Record<string, unknown> = {};
      for (const c of groupBy) outRow[c] = row[c] ?? null;
      out.push(outRow);
    }
    return out;
  }
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
  return order.map((key) => {
    const keyVals = JSON.parse(key) as unknown[];
    const outRow: Record<string, unknown> = {};
    groupBy.forEach((c, i) => { outRow[c] = keyVals[i]; });
    aggregations.forEach((item) => {
      outRow[item.outputColumn] = evalAggregation(item, groups.get(key) ?? []);
    });
    return outRow;
  });
}

/**
 * RollupV1 core: prefix-hierarchy grouping sets over rollupColumns.
 * Emits most-detailed groups first (all k columns) down to the grand
 * total (level 0, all key columns null) — DuckDB UNION ordering.
 */
export function computeRollup(
  rows: Array<Record<string, unknown>>,
  rollupColumns: string[],
  aggregations: AggregationItem[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let level = rollupColumns.length; level >= 0; level--) {
    const gbs = rollupColumns.slice(0, level);
    for (const row of computeAggregations(rows, gbs, aggregations)) {
      for (const c of rollupColumns.slice(level)) row[c] = null;
      out.push(row);
    }
  }
  return out;
}

/** Resolve an aggregateOnCondition ColumnPredicate to named columns. */
export function resolveOnConditionTargets(
  predicate: ColumnPredicate,
  columns: Array<{ name: string; type: string }>,
): string[] {
  if (predicate.kind === 'all') return columns.map((c) => c.name);
  const wanted = (predicate.columnType ?? '').toLowerCase();
  const NUMERICish = new Set(['numeric', 'double', 'decimal', 'number', 'float', 'real']);
  const INTEGERish = new Set(['integer', 'int', 'long', 'bigint', 'smallint']);
  return columns
    .filter((c) => {
      const t = (c.type ?? 'string').toLowerCase();
      if (NUMERICish.has(wanted)) return NUMERICish.has(t);
      if (INTEGERish.has(wanted)) return INTEGERish.has(t);
      return t === wanted;
    })
    .map((c) => c.name);
}

/** Build the concrete aggregation list for an on-condition step. Each
 * dynamic aggregation lands on every target column with output name
 * `<column><suffix>` (Palantir columnNameConcat). */
export function buildOnConditionAggregations(
  targets: string[],
  expressions: DynamicAggregation[],
): AggregationItem[] {
  const items: AggregationItem[] = [];
  for (const target of targets) {
    for (const expr of expressions) {
      items.push({
        function: expr.function,
        column: target,
        outputColumn: `${target}${expr.suffix}`,
      });
    }
  }
  return items;
}

/** Shared output-column shape for the aggregate family. */
function aggregateOutColumns(
  keys: string[],
  aggregations: AggregationItem[],
  typeOf: (c: string) => string,
): Array<{ name: string; type: string }> {
  return [
    ...keys.map((g) => ({ name: g, type: typeOf(g) })),
    ...aggregations.map((item) => ({
      name: item.outputColumn,
      type: aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Aggregate — Preview / Apply (Palantir groupAndAggregateV1)
// ---------------------------------------------------------------------------

export async function aggregatePreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: AggregatePreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  ctx.assertColumnsExist(effectiveNames, [...input.groupBy, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Aggregate');

  const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
  const outColumns = aggregateOutColumns(input.groupBy, input.aggregations, typeOf);

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = computeAggregations(chained, input.groupBy, input.aggregations).slice(0, input.limit);

  return {
    columns: outColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    aggregateSummary: `Group by [${input.groupBy.join(', ') || '(all)'}] · ${input.aggregations.length} aggregation(s)`,
  };
}

export async function aggregateApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: AggregateApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Aggregate',
    groupBy: input.groupBy,
    aggregations: input.aggregations,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Rollup — Preview / Apply (Palantir rollupV1)
// ---------------------------------------------------------------------------

export async function rollupPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: RollupPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  if (input.rollupColumns.length === 0 || input.aggregations.length === 0) {
    throw new AppError('Rollup requires at least one column and one aggregation', 400, 'VALIDATION_ERROR');
  }
  ctx.assertColumnsExist(effectiveNames, [...input.rollupColumns, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Rollup');

  const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
  const outColumns = aggregateOutColumns(input.rollupColumns, input.aggregations, typeOf);

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = computeRollup(chained, input.rollupColumns, input.aggregations).slice(0, input.limit);

  return {
    columns: outColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    rollupSummary: `Rollup [${input.rollupColumns.join(' → ')}] · ${input.aggregations.length} aggregation(s)`,
  };
}

export async function rollupApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: RollupApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Rollup',
    rollupColumns: input.rollupColumns,
    aggregations: input.aggregations,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Aggregate on Condition — Preview / Apply (Palantir aggregateOnConditionV2)
// ---------------------------------------------------------------------------

export async function aggregateOnConditionPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: AggregateOnConditionPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const targets = resolveOnConditionTargets(input.predicate, effectiveColumns);
  if (targets.length === 0) {
    throw new AppError('Aggregate on Condition matched no columns for the given predicate', 400, 'VALIDATION_ERROR');
  }
  const aggregations = buildOnConditionAggregations(targets, input.aggregations);

  const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
  const outColumns = aggregateOutColumns(input.groupBy, aggregations, typeOf);

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = computeAggregations(chained, input.groupBy, aggregations).slice(0, input.limit);

  return {
    columns: outColumns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    matchedColumns: targets,
  };
}

export async function aggregateOnConditionApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: AggregateOnConditionApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'AggregateOnCondition',
    predicate: input.predicate,
    groupBy: input.groupBy,
    aggregations: input.aggregations,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
