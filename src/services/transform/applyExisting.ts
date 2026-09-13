// ---------------------------------------------------------------------------
// Chain replay for saved pipeline transforms (extracted from
// services/transformService.ts during the god-file breakup —
// behavior-preserving move).
//
// applyExistingTransforms / applyExistingTransformColumns replay a node's
// saved config.transforms[] sequentially over raw CSV rows (rows path) or
// over the declared column list (metadata path) so previews, deploy
// materialization, and the ops modules share one replay semantics.
//
// Previously these were public methods on TransformService that reached the
// aggregate/top-rows/pivot helpers through `this.*` one-line delegates.
// Every delegate now resolves directly to its pipelines/ops/*
// implementation, so this module is dependency-free (no knex, no S3) and
// unit-testable in isolation. TransformService keeps thin wrappers so the
// public API and the TransformOpsContext seam are unchanged.
// ---------------------------------------------------------------------------

import type {
  AggregationItem,
  BinaryOperator,
  CaseExpressionApplyInput,
  CastTargetType,
  CleanStringActions,
  ColumnPredicate,
  DynamicAggregation,
  ExpressionItem,
  FilterCondition,
  Operand,
  StringOperand,
} from '../../types/pipeline';
import {
  CONVERTER_TYPE_MAP,
  collectExpressionItems,
  concatenateStringValues,
  formatStringValue,
  normalizeColumnName,
  stripBom,
} from '../pipelines/ops/shared';
import { applyCastToRows } from '../pipelines/ops/castOps';
import { applyFilterRows } from '../pipelines/ops/filterOps';
import { applySort, computeTopRows as computeTopRowsOp } from '../pipelines/ops/sortOps';
import {
  applyDropDuplicates,
  computeKeepDuplicates as computeKeepDuplicatesOp,
} from '../pipelines/ops/dedupeOps';
import {
  applyDropColumnsRows,
  applyRowSizeRows,
  applySelectRows,
} from '../pipelines/ops/columnOps';
import {
  applyNormalizeRows,
  applyRenameRows,
  applyUppercaseRows,
} from '../pipelines/ops/columnNameOps';
import { applyCleanStringRows } from '../pipelines/ops/cleanStringOps';
import {
  applyCaseExpressionToRows,
  applyComputeIfAbsentRows,
  applyExpressionToRows,
} from '../pipelines/ops/expressionOps';
import {
  aggregationOutputType as aggregationOutputTypeOp,
  buildOnConditionAggregations as buildOnConditionAggregationsOp,
  computeAggregations as computeAggregationsOp,
  computeRollup as computeRollupOp,
  resolveOnConditionTargets as resolveOnConditionTargetsOp,
} from '../pipelines/ops/aggregateOps';
import {
  computePivot as computePivotOp,
  computeUnpivot as computeUnpivotOp,
} from '../pipelines/ops/pivotOps';

export type ColumnDef = { name: string; type: string };

/**
 * Replay the saved transform chain over the declared column list.
 * Pure column-metadata walk — transforms that only reorder/filter rows
 * (Sort, DropDuplicates, TopRows, KeepDuplicates, TextBlock) leave the
 * schema untouched and are skipped here.
 */
export function applyExistingTransformColumns(
  sourceColumns: Array<ColumnDef>,
  transforms: unknown[],
): Array<ColumnDef> {
  let cols = sourceColumns.map((c) => ({ ...c }));

  for (const t of transforms) {
    const tx = t as Record<string, unknown>;
    const fn = tx.function as string;

    if (fn === 'Cast') {
      const expr = tx.expression as string;
      const outputCol = ((tx.outputColumn ?? expr) as string);
      const targetType = tx.targetType as string;
      const exists = cols.some((c) => c.name === outputCol);

      if (exists) {
        cols = cols.map((c) =>
          c.name === outputCol ? { ...c, type: targetType } : c,
        );
      } else {
        cols.push({ name: outputCol, type: targetType });
      }
    }
    // Filter transforms don't change column metadata — skip
    if (fn === 'Drop') {
      const dropCols = new Set(
        ((tx.columns ?? []) as string[]).map(stripBom),
      );
      cols = cols.filter((c) => !dropCols.has(stripBom(c.name)));
    }
    if (fn === 'Rename') {
      const renames = (tx.renames ?? []) as Array<{ from: string; to: string }>;
      const map = new Map(renames.map((r) => [stripBom(r.from), r.to]));
      cols = cols.map((c) => {
        const newName = map.get(stripBom(c.name));
        return newName ? { ...c, name: newName } : c;
      });
    }
    if (fn === 'Normalize') {
      const removeSpecial = (tx.removeSpecialCharacters ?? false) as boolean;
      const usedNames = new Set<string>();
      cols = cols.map((c) => {
        let newName = normalizeColumnName(c.name, removeSpecial);
        if (usedNames.has(newName)) { let i = 1; while (usedNames.has(`${newName}_${i}`)) i++; newName = `${newName}_${i}`; }
        usedNames.add(newName);
        return { ...c, name: newName };
      });
    }
    if (fn === 'Select') {
      const keep = (tx.columns ?? []) as string[];
      const keepSet = new Set(keep.map(stripBom));
      cols = keep
        .map(stripBom)
        .map((name) => {
          const found = cols.find((c) => stripBom(c.name) === name);
          return found ?? { name, type: 'string' };
        })
        .filter((c) => keepSet.has(stripBom(c.name)));
    }
    if (fn === 'UppercaseColumnNames') {
      cols = cols.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    }
    if (fn === 'RowSize') {
      const out = (tx.outputColumn ?? 'row_size') as string;
      if (!cols.some((c) => c.name === out)) cols.push({ name: out, type: 'integer' });
    }
    if (
      fn === 'ApplyExpression' ||
      fn === 'ApplyMultipleExpressions' ||
      fn === 'ApplyToMultipleColumns' ||
      fn === 'ComputeIfExpressionAbsent'
    ) {
      const exprs = collectExpressionItems(tx);
      for (const e of exprs) {
        const t = e.outputType ?? 'string';
        const idx = cols.findIndex((c) => c.name === e.outputColumn);
        if (idx >= 0) cols[idx] = { ...cols[idx], type: t };
        else cols.push({ name: e.outputColumn, type: t });
      }
    }
    if (fn === 'CaseExpression') {
      const out = tx.outputColumn as string;
      const type = (tx.outputType as string | undefined) ?? 'string';
      const idx = cols.findIndex((column) => column.name === out);
      if (idx >= 0) cols[idx] = { ...cols[idx], type };
      else cols.push({ name: out, type });
    }
    if (fn === 'ConcatenateStrings') {
      const out = tx.outputColumn as string;
      const idx = cols.findIndex((column) => column.name === out);
      if (idx >= 0) cols[idx] = { ...cols[idx], type: 'string' };
      else cols.push({ name: out, type: 'string' });
    }
    if (fn === 'FormatString') {
      const out = tx.outputColumn as string;
      const idx = cols.findIndex((column) => column.name === out);
      if (idx >= 0) cols[idx] = { ...cols[idx], type: 'string' };
      else cols.push({ name: out, type: 'string' });
    }
    if (fn === 'Aggregate') {
      const groupBy = (tx.groupBy ?? []) as string[];
      const aggs = (tx.aggregations ?? []) as AggregationItem[];
      const typeOf = (c: string) => cols.find((col) => col.name === c)?.type ?? 'string';
      cols = [
        ...groupBy.map((g) => ({ name: g, type: typeOf(g) })),
        ...aggs.map((item) => ({
          name: item.outputColumn,
          type: aggregationOutputTypeOp(item, item.column ? typeOf(item.column) : 'string'),
        })),
      ];
    }
    if (fn === 'Rollup') {
      const rollupColumns = (tx.rollupColumns ?? []) as string[];
      const aggs = (tx.aggregations ?? []) as AggregationItem[];
      const typeOf = (c: string) => cols.find((col) => col.name === c)?.type ?? 'string';
      cols = [
        ...rollupColumns.map((g) => ({ name: g, type: typeOf(g) })),
        ...aggs.map((item) => ({
          name: item.outputColumn,
          type: aggregationOutputTypeOp(item, item.column ? typeOf(item.column) : 'string'),
        })),
      ];
    }
    if (fn === 'AggregateOnCondition') {
      const groupBy = (tx.groupBy ?? []) as string[];
      const targets = resolveOnConditionTargetsOp(
        tx.predicate as ColumnPredicate,
        cols,
      );
      const aggs = buildOnConditionAggregationsOp(
        targets,
        (tx.aggregations ?? []) as DynamicAggregation[],
      );
      const typeOf = (c: string) => cols.find((col) => col.name === c)?.type ?? 'string';
      cols = [
        ...groupBy.map((g) => ({ name: g, type: typeOf(g) })),
        ...aggs.map((item) => ({
          name: item.outputColumn,
          type: aggregationOutputTypeOp(item, item.column ? typeOf(item.column) : 'string'),
        })),
      ];
    }
    if (fn === 'Pivot') {
      const groupBy = (tx.groupBy ?? []) as string[];
      const aggs = (tx.aggregations ?? []) as AggregationItem[];
      const pivotValues = (tx.pivotValues ?? []) as Array<{ value: string; alias: string }>;
      const aliasPosition = (tx.aliasPosition ?? 'prefix') as 'prefix' | 'suffix';
      const typeOf = (c: string) => cols.find((col) => col.name === c)?.type ?? 'string';
      // Schema-only path: pivot values are declared explicitly in the
      // spec (unpivotV1-style wildcard pivots are not supported), so the
      // value columns are fully known here.
      cols = [
        ...groupBy.map((g) => ({ name: g, type: typeOf(g) })),
        ...pivotValues.flatMap((pv) =>
          aggs.map((item) => ({
            name: aliasPosition === 'prefix'
              ? `${pv.alias}_${item.outputColumn}`
              : `${item.outputColumn}_${pv.alias}`,
            type: aggregationOutputTypeOp(item, item.column ? typeOf(item.column) : 'string'),
          })),
        ),
      ];
    }
    if (fn === 'Unpivot') {
      const unpivotSet = new Set((tx.columns ?? []) as string[]);
      const nameColumn = tx.nameColumn as string;
      const valueColumn = tx.valueColumn as string;
      cols = [
        { name: nameColumn, type: 'string' },
        { name: valueColumn, type: 'string' },
        ...cols.filter((c) => !unpivotSet.has(c.name)),
      ];
    }
    if (fn === 'CurrentTimestamp') {
      // Palantir currentTimestampV1: the build-time column the row-path
      // stamps; metadata must declare it so the CSV/Parquet writers keep
      // the column (otherwise the value computed per row is dropped from
      // the published schema).
      const outputCol = tx.outputColumn as string;
      if (!cols.some((c) => c.name === outputCol)) {
        cols.push({ name: outputCol, type: 'timestamp' });
      }
    }
    // Sort, DropDuplicates, TopRows, KeepDuplicates, TextBlock don't
    // change column metadata — skip
  }

  return cols;
}

/**
 * Apply all previously-saved transforms (from config.transforms[])
 * sequentially to raw CSV rows, producing the intermediate dataset
 * that the next transform should operate on.
 *
 * This ensures chained transforms work correctly:
 *   Cast(age→int) → Filter(age > 25) operates on casted integer values.
 */
export function applyExistingTransforms(
  rows: Array<Record<string, unknown>>,
  transforms: unknown[],
): Array<Record<string, unknown>> {
  let result = rows;

  for (const t of transforms) {
    const tx = t as Record<string, unknown>;
    const fn = tx.function as string;

    if (fn === 'Cast') {
      const expr = tx.expression as string;
      const outputCol = (tx.outputColumn ?? expr) as string;
      const targetType = tx.targetType as string;
      const converterType = CONVERTER_TYPE_MAP[targetType as CastTargetType] ?? 'string';
      result = applyCastToRows(result, expr, outputCol, converterType);
    } else if (fn === 'Filter') {
      const mode = (tx.mode ?? 'keep') as 'keep' | 'remove';
      const match = (tx.match ?? 'all') as 'all' | 'any';
      const conditions = (tx.conditions ?? []) as FilterCondition[];
      result = applyFilterRows(result, mode, match, conditions);
    } else if (fn === 'Drop') {
      result = applyDropColumnsRows(result, (tx.columns ?? []) as string[]);
    } else if (fn === 'Rename') {
      result = applyRenameRows(result, (tx.renames ?? []) as Array<{ from: string; to: string }>);
    } else if (fn === 'Normalize') {
      const removeSpecial = (tx.removeSpecialCharacters ?? false) as boolean;
      result = applyNormalizeRows(result, removeSpecial);
    } else if (fn === 'Select') {
      result = applySelectRows(result, (tx.columns ?? []) as string[]);
    } else if (fn === 'Sort') {
      const sorts = (tx.sorts ?? []) as Array<{
        column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last';
      }>;
      result = applySort(result, sorts);
    } else if (fn === 'DropDuplicates') {
      const keyCols = ((tx.columns ?? null) as string[] | null)?.map(stripBom) ?? null;
      result = applyDropDuplicates(result, keyCols);
    } else if (fn === 'UppercaseColumnNames') {
      result = applyUppercaseRows(result);
    } else if (fn === 'RowSize') {
      const out = (tx.outputColumn ?? 'row_size') as string;
      result = applyRowSizeRows(result, out);
    } else if (fn === 'CleanString') {
      result = applyCleanStringRows(
        result,
        tx.columns as string[] | undefined,
        (tx.actions ?? { trim: true }) as CleanStringActions,
      );
    } else if (fn === 'ApplyExpression') {
      const exprs = collectExpressionItems(tx);
      for (const e of exprs) result = applyExpressionToRows(result, e);
    } else if (fn === 'CaseExpression') {
      result = applyCaseExpressionToRows(result, tx as unknown as CaseExpressionApplyInput);
    } else if (fn === 'ConcatenateStrings') {
      const expressions = (tx.expressions ?? []) as StringOperand[];
      const separator = (tx.separator ?? '') as string;
      const strict = (tx.nullOutputIfAnyInputIsNull ?? false) as boolean;
      const out = tx.outputColumn as string;
      result = result.map((row) => ({ ...row, [out]: concatenateStringValues(row, expressions, separator, strict) }));
    } else if (fn === 'FormatString') {
      // Palantir formatStringV1 — printf-style template over ordered args.
      // Same operand semantics as ConcatenateStrings: kind=column resolves
      // from the row, kind=literal uses the value verbatim.
      const fmtArgs = (tx.arguments ?? []) as StringOperand[];
      const fmt = (tx.format ?? '') as string;
      const out = tx.outputColumn as string;
      result = result.map((row) => ({
        ...row,
        [out]: formatStringValue(
          fmt,
          fmtArgs.map((a) => (a.kind === 'column' ? row[a.value] : a.value)),
        ),
      }));
    } else if (fn === 'ApplyMultipleExpressions') {
      const exprs = collectExpressionItems(tx);
      for (const e of exprs) result = applyExpressionToRows(result, e);
    } else if (fn === 'ApplyToMultipleColumns') {
      const cols = ((tx.columns ?? []) as string[]).map(stripBom);
      const op = tx.operator as BinaryOperator;
      const right = tx.right as Operand;
      const suffix = (tx.outputSuffix ?? '_calc') as string;
      const outNames = (tx.outputColumns as string[] | undefined) ?? cols.map((c) => `${c}${suffix}`);
      const outType = tx.outputType as CastTargetType | undefined;
      for (let i = 0; i < cols.length; i++) {
        const e: ExpressionItem = {
          left: { kind: 'column', value: cols[i] },
          operator: op,
          right,
          outputColumn: outNames[i],
          outputType: outType,
        };
        result = applyExpressionToRows(result, e);
      }
    } else if (fn === 'ComputeIfExpressionAbsent') {
      const out = tx.outputColumn as string;
      const exprs = collectExpressionItems(tx);
      const e = exprs[0];
      result = applyComputeIfAbsentRows(result, out, e);
    } else if (fn === 'TextBlock') {
      // Text block is pure annotation — pass rows through unchanged.
    } else if (fn === 'Aggregate') {
      result = computeAggregationsOp(
        result,
        (tx.groupBy ?? []) as string[],
        (tx.aggregations ?? []) as AggregationItem[],
      );
    } else if (fn === 'Rollup') {
      result = computeRollupOp(
        result,
        (tx.rollupColumns ?? []) as string[],
        (tx.aggregations ?? []) as AggregationItem[],
      );
    } else if (fn === 'AggregateOnCondition') {
      // Rows-only replay: resolve the type predicate against the current
      // row keys (all 'string'-typed here; a predicate on a non-string
      // type matches nothing unless it targets strings or 'all').
      const colNames = result.length ? Object.keys(result[0]) : [];
      const targets = resolveOnConditionTargetsOp(
        tx.predicate as ColumnPredicate,
        colNames.map((name) => ({ name, type: 'string' })),
      );
      const aggregations = buildOnConditionAggregationsOp(
        targets,
        (tx.aggregations ?? []) as DynamicAggregation[],
      );
      result = computeAggregationsOp(result, (tx.groupBy ?? []) as string[], aggregations);
    } else if (fn === 'TopRows') {
      result = computeTopRowsOp(
        result,
        (tx.partitionBy ?? []) as string[],
        (tx.sorts ?? []) as Array<{ column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>,
        (tx.topN ?? 1) as number,
      );
    } else if (fn === 'Pivot') {
      result = computePivotOp(
        result,
        (tx.groupBy ?? []) as string[],
        tx.pivotColumn as string,
        (tx.pivotValues ?? []) as Array<{ value: string; alias: string }>,
        (tx.aggregations ?? []) as AggregationItem[],
        (tx.aliasPosition ?? 'prefix') as 'prefix' | 'suffix',
      ).rows;
    } else if (fn === 'Unpivot') {
      const unpivotCols = (tx.columns ?? []) as string[];
      const unpivotSet = new Set(unpivotCols);
      const kept = result.length ? Object.keys(result[0]).filter((k) => !unpivotSet.has(k)) : [];
      result = computeUnpivotOp(result, unpivotCols, tx.nameColumn as string, tx.valueColumn as string, kept);
    } else if (fn === 'KeepDuplicates') {
      const subset = ((tx.columns ?? []) as string[]);
      const all = result.length ? Object.keys(result[0]) : [];
      result = computeKeepDuplicatesOp(result, subset, all);
    } else if (fn === 'CurrentTimestamp') {
      // Palantir currentTimestampV1 parity: one build-time value for every
      // row of the chain — captured once per chain execution so a deploy
      // stamps all rows with the same detection timestamp.
      const outputCol = tx.outputColumn as string;
      const buildTime = new Date().toISOString();
      result = result.map((row) => ({ ...row, [outputCol]: buildTime }));
    }
  }

  return result;
}
