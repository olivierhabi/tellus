import { Knex } from 'knex';
import { parse } from 'csv-parse';
import { AppError } from '../utils/foundryAppError';
import { sanitizeCsvHeader } from '../utils/csvHeader';
import { findNearNameMatches, unionSideLabels } from '../utils/columnNameReconciler';
import { getObjectStream, toDuckDbReadUri } from './storageService';
import { readUploadedPreview } from './datasets/uploaded-dataset-reader';
import {
  buildJoinMatchWarnings,
  coalescedJoinKeyNames,
  compareJoinValues,
} from './pipelines/joinMatchRate';
import {
  chainHashFromNodeConfig,
  fingerprintSchema,
  hashTransformChain,
} from './pipelines/previewSnapshot';
import { resolveUnionInputIds } from '../types/pipeline';
import type {
  CastPreviewInput,
  CastApplyInput,
  FilterPreviewInput,
  FilterApplyInput,
  DropPreviewInput,
  DropApplyInput,
  RenamePreviewInput,
  RenameApplyInput,
  NormalizePreviewInput,
  NormalizeApplyInput,
  SavePreviewSnapshotInput,
  JoinPreviewInput,
  JoinApplyInput,
  JoinType,
  JoinOperator,
  UnionPreviewInput,
  UnionApplyInput,
  SelectPreviewInput,
  SelectApplyInput,
  SortPreviewInput,
  SortApplyInput,
  DropDuplicatesPreviewInput,
  DropDuplicatesApplyInput,
  UppercaseColumnNamesPreviewInput,
  UppercaseColumnNamesApplyInput,
  RowSizePreviewInput,
  RowSizeApplyInput,
  ApplyExpressionPreviewInput,
  ApplyExpressionApplyInput,
  CaseExpressionPreviewInput,
  CaseExpressionApplyInput,
  ConcatenateStringsPreviewInput,
  ConcatenateStringsApplyInput,
  FormatStringPreviewInput,
  FormatStringApplyInput,
  ApplyMultipleExpressionsPreviewInput,
  ApplyMultipleExpressionsApplyInput,
  ApplyToMultipleColumnsPreviewInput,
  ApplyToMultipleColumnsApplyInput,
  ComputeIfExpressionAbsentPreviewInput,
  ComputeIfExpressionAbsentApplyInput,
  TextBlockPreviewInput,
  TextBlockApplyInput,
  AggregatePreviewInput,
  AggregateApplyInput,
  RollupPreviewInput,
  RollupApplyInput,
  AggregateOnConditionPreviewInput,
  AggregateOnConditionApplyInput,
  TopRowsPreviewInput,
  TopRowsApplyInput,
  PivotPreviewInput,
  PivotApplyInput,
  UnpivotPreviewInput,
  UnpivotApplyInput,
  KeepDuplicatesPreviewInput,
  KeepDuplicatesApplyInput,
  AggregationItem,
  ColumnPredicate,
  DynamicAggregation,
} from '../types/pipeline';
import {
  EXECUTE_SOURCE_ROW_LIMIT,
  PREVIEW_SOURCE_ROW_LIMIT,
  concatenateStringValues,
  formatStringValue,
  stripBom,
} from './pipelines/ops/shared';

// Back-compat re-exports: these symbols were historically exported from this
// module and are imported elsewhere (routes, tests). The implementations now
// live in pipelines/ops/shared.
export {
  EXECUTE_SOURCE_ROW_LIMIT,
  PREVIEW_SOURCE_ROW_LIMIT,
  concatenateStringValues,
  formatStringValue,
} from './pipelines/ops/shared';
import {
  castApply as castApplyOp,
  castPreview as castPreviewOp,
} from './pipelines/ops/castOps';
import {
  filterApply as filterApplyOp,
  filterPreview as filterPreviewOp,
} from './pipelines/ops/filterOps';
import {
  computeTopRows as computeTopRowsOp,
  sortApply as sortApplyOp,
  sortPreview as sortPreviewOp,
  topRowsApply as topRowsApplyOp,
  topRowsPreview as topRowsPreviewOp,
} from './pipelines/ops/sortOps';
import {
  computeKeepDuplicates as computeKeepDuplicatesOp,
  dropDuplicatesApply as dropDuplicatesApplyOp,
  dropDuplicatesPreview as dropDuplicatesPreviewOp,
  keepDuplicatesApply as keepDuplicatesApplyOp,
  keepDuplicatesPreview as keepDuplicatesPreviewOp,
} from './pipelines/ops/dedupeOps';
import {
  dropApply as dropApplyOp,
  dropPreview as dropPreviewOp,
  rowSizeApply as rowSizeApplyOp,
  rowSizePreview as rowSizePreviewOp,
  selectApply as selectApplyOp,
  selectPreview as selectPreviewOp,
} from './pipelines/ops/columnOps';
import {
  normalizeApply as normalizeApplyOp,
  normalizePreview as normalizePreviewOp,
  renameApply as renameApplyOp,
  renamePreview as renamePreviewOp,
  uppercaseColumnNamesApply as uppercaseColumnNamesApplyOp,
  uppercaseColumnNamesPreview as uppercaseColumnNamesPreviewOp,
} from './pipelines/ops/columnNameOps';
import {
  applyExpressionApply as applyExpressionApplyOp,
  applyExpressionPreview as applyExpressionPreviewOp,
  applyMultipleExpressionsApply as applyMultipleExpressionsApplyOp,
  applyMultipleExpressionsPreview as applyMultipleExpressionsPreviewOp,
  applyToMultipleColumnsApply as applyToMultipleColumnsApplyOp,
  applyToMultipleColumnsPreview as applyToMultipleColumnsPreviewOp,
  caseExpressionApply as caseExpressionApplyOp,
  caseExpressionPreview as caseExpressionPreviewOp,
  computeIfExpressionAbsentApply as computeIfExpressionAbsentApplyOp,
  computeIfExpressionAbsentPreview as computeIfExpressionAbsentPreviewOp,
  textBlockApply as textBlockApplyOp,
  textBlockPreview as textBlockPreviewOp,
} from './pipelines/ops/expressionOps';
import {
  concatenateStringsApply as concatenateStringsApplyOp,
  concatenateStringsPreview as concatenateStringsPreviewOp,
  formatStringApply as formatStringApplyOp,
  formatStringPreview as formatStringPreviewOp,
} from './pipelines/ops/stringOps';
import {
  aggregateApply as aggregateApplyOp,
  aggregateOnConditionApply as aggregateOnConditionApplyOp,
  aggregateOnConditionPreview as aggregateOnConditionPreviewOp,
  aggregatePreview as aggregatePreviewOp,
  aggregationOutputType as aggregationOutputTypeOp,
  buildOnConditionAggregations as buildOnConditionAggregationsOp,
  computeAggregations as computeAggregationsOp,
  computeRollup as computeRollupOp,
  evalAggregation as evalAggregationOp,
  resolveOnConditionTargets as resolveOnConditionTargetsOp,
  rollupApply as rollupApplyOp,
  rollupPreview as rollupPreviewOp,
} from './pipelines/ops/aggregateOps';
import {
  computePivot as computePivotOp,
  computeUnpivot as computeUnpivotOp,
  pivotApply as pivotApplyOp,
  pivotPreview as pivotPreviewOp,
  unpivotApply as unpivotApplyOp,
  unpivotPreview as unpivotPreviewOp,
} from './pipelines/ops/pivotOps';
import {
  executeJoin as executeJoinOp,
  joinApply as joinApplyOp,
  joinPreview as joinPreviewOp,
} from './pipelines/ops/joinOps';
import {
  unionApply as unionApplyOp,
  unionPreview as unionPreviewOp,
} from './pipelines/ops/unionOps';
import {
  udfApply as udfApplyOp,
  udfPreview as udfPreviewOp,
} from './pipelines/ops/udfOps';
// Chain replay (saved config.transforms[] over rows / column metadata)
// extracted to ./transform/applyExisting — behavior-preserving move.
import {
  applyExistingTransformColumns as applyExistingTransformColumnsImpl,
  applyExistingTransforms as applyExistingTransformsImpl,
} from './transform/applyExisting';


// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * TransformService — executes pipeline transforms against dataset data
 * stored in S3/MinIO (CSV files).
 *
 * The data flow mirrors how DatasetService.getDatasetPreview works:
 *   1. Look up the dataset via pipeline_nodes → foundry_datasets
 *   2. Stream the CSV from S3 via storageService.getObjectStream
 *   3. Apply the transform (Cast) using typeConverter.convertValue
 *   4. Return the transformed rows
 *
 * This is the production-grade implementation used by the Pipeline Builder
 * frontend to preview and apply transforms.
 */


export class TransformService {
  constructor(private knex: Knex) {}

  // PB-B6 — pinned-input cache. When deploymentService has preview
  // snapshot metadata, it pre-reads each input at its captured pin
  // (Iceberg snapshot_id or S3 VersionId/ETag) and seeds this map. The
  // readCsvRows path consults the cache first so the downstream
  // transform chain sees the EXACT rows the preview saw — not whatever
  // was written to the live upstream between preview and deploy.
  private pinnedInputCache: Map<string, Array<Record<string, string>>> =
    new Map();

  setPinnedInputRows(filePath: string, rows: Array<Record<string, string>>): void {
    this.pinnedInputCache.set(filePath, rows);
  }

  clearPinnedInputCache(): void {
    this.pinnedInputCache.clear();
  }

  private pinnedInputRows(filePath: string): Array<Record<string, string>> | null {
    return this.pinnedInputCache.get(filePath) ?? null;
  }

  // =========================================================================
  // Cast — Preview
  // =========================================================================

  /**
   * Preview a CAST transform.
   *
   * Reads up to `limit` rows from the source CSV, applies
   * `convertValue(value, targetType)` to the expression column,
   * and returns the transformed rows.
   *
   * Mirrors Palantir castV2 behaviour:
   *   - If outputColumn === expression, the column is replaced in-place
   *   - If outputColumn differs, a new column is appended
   *   - Values that fail to cast become null (lenient mode)
   *   - Null inputs remain null
   */
  async castPreview(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: CastPreviewInput,
  ) {
    return castPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Cast — Apply (persist config)
  // =========================================================================

  /**
   * Persist a Cast transform configuration into the pipeline node.
   *
   * Appends the cast spec to the node's config.transforms array.
   * This is configuration-only — no data is transformed. The saved
   * config is used during pipeline builds to materialise the transform.
   */
  async castApply(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: CastApplyInput,
  ) {
    return castApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Filter — Preview
  // =========================================================================

  /**
   * Preview a Filter transform.
   *
   * Reads rows from the source CSV, evaluates each condition against each
   * row, and returns only the rows that match (mode=keep) or don't match
   * (mode=remove) based on the match logic (all=AND, any=OR).
   */
  async filterPreview(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: FilterPreviewInput,
  ) {
    return filterPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Filter — Apply (persist config)
  // =========================================================================

  async filterApply(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: FilterApplyInput,
  ) {
    return filterApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Drop Columns — Preview
  // =========================================================================

  /**
   * Preview a Drop Columns transform.
   *
   * Reads rows from the source CSV, replays any prior transforms,
   * then removes the specified columns from each row.
   */
  async dropPreview(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: DropPreviewInput,
  ) {
    return dropPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Drop Columns — Apply (persist config)
  // =========================================================================

  async dropApply(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: DropApplyInput,
  ) {
    return dropApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Rename Columns — Preview
  // =========================================================================

  async renamePreview(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: RenamePreviewInput,
  ) {
    return renamePreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Rename Columns — Apply (persist config)
  // =========================================================================

  async renameApply(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    input: RenameApplyInput,
  ) {
    return renameApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Normalize Column Names — Preview
  // =========================================================================

  async normalizePreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: NormalizePreviewInput,
  ) {
    return normalizePreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Normalize Column Names — Apply
  // =========================================================================

  async normalizeApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: NormalizeApplyInput,
  ) {
    return normalizeApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Select Columns — Preview / Apply
  //
  // Keeps only the listed columns and removes the others — the inverse of
  // Drop. Palantir selectV1.
  // =========================================================================

  async selectPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: SelectPreviewInput,
  ) {
    return selectPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async selectApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: SelectApplyInput,
  ) {
    return selectApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Sort — Preview / Apply
  //
  // Stable multi-key ordering. Palantir sortV2.
  // =========================================================================

  async sortPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: SortPreviewInput,
  ) {
    return sortPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async sortApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: SortApplyInput,
  ) {
    return sortApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Drop Duplicates — Preview / Apply
  //
  // Palantir dropDuplicatesV1. When `columns` is omitted, dedupe on the
  // entire row (every column's value must match to be considered duplicate).
  // =========================================================================

  async dropDuplicatesPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: DropDuplicatesPreviewInput,
  ) {
    return dropDuplicatesPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async dropDuplicatesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: DropDuplicatesApplyInput,
  ) {
    return dropDuplicatesApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Uppercase Column Names — Preview / Apply
  //
  // Palantir uppercaseColumnNamesV1. Pure rename — no value changes.
  // =========================================================================

  async uppercaseColumnNamesPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: UppercaseColumnNamesPreviewInput,
  ) {
    return uppercaseColumnNamesPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async uppercaseColumnNamesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UppercaseColumnNamesApplyInput,
  ) {
    return uppercaseColumnNamesApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Row Size — Preview / Apply
  //
  // Palantir rowSizeV1. Estimation: byte length of JSON.stringify(row).
  // =========================================================================

  async rowSizePreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: RowSizePreviewInput,
  ) {
    return rowSizePreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async rowSizeApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: RowSizeApplyInput,
  ) {
    return rowSizeApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Apply Expression — Preview / Apply
  //
  // Palantir applyExpressionV1 — single binary expression producing a column.
  // =========================================================================

  async applyExpressionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyExpressionPreviewInput,
  ) {
    return applyExpressionPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async applyExpressionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyExpressionApplyInput,
  ) {
    return applyExpressionApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  async caseExpressionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: CaseExpressionPreviewInput,
  ) {
    return caseExpressionPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async caseExpressionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: CaseExpressionApplyInput,
  ) {
    return caseExpressionApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  async concatenateStringsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ConcatenateStringsPreviewInput,
  ) {
    return concatenateStringsPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async concatenateStringsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ConcatenateStringsApplyInput,
  ) {
    return concatenateStringsApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Format string — Preview / Apply
  //
  // Palantir formatStringV1 — a printf-style template over an ordered arg
  // list producing a String column. With an empty argument list this
  // produces a constant column (the PB tutorial pattern: "Format string" =
  // 'INACTIVE_COVERAGE' + Output column = signal_type).
  // =========================================================================

  async formatStringPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: FormatStringPreviewInput,
  ) {
    return formatStringPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async formatStringApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: FormatStringApplyInput,
  ) {
    return formatStringApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Apply Multiple Expressions — Preview / Apply
  //
  // Palantir projectV1 — multiple binary expressions producing columns.
  // =========================================================================

  async applyMultipleExpressionsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyMultipleExpressionsPreviewInput,
  ) {
    return applyMultipleExpressionsPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async applyMultipleExpressionsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyMultipleExpressionsApplyInput,
  ) {
    return applyMultipleExpressionsApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Apply To Multiple Columns — Preview / Apply
  //
  // Palantir projectOnConditionV1 — apply the same operator+right operand to
  // N columns (substituted in the left role), producing N new columns.
  // =========================================================================

  async applyToMultipleColumnsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyToMultipleColumnsPreviewInput,
  ) {
    return applyToMultipleColumnsPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async applyToMultipleColumnsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyToMultipleColumnsApplyInput,
  ) {
    return applyToMultipleColumnsApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Compute If Expression Absent — Preview / Apply
  //
  // Palantir computeExpressionIfAbsentV1 — only fill the column when the
  // target column is null / empty-string / missing.
  // =========================================================================

  async computeIfExpressionAbsentPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ComputeIfExpressionAbsentPreviewInput,
  ) {
    return computeIfExpressionAbsentPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async computeIfExpressionAbsentApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ComputeIfExpressionAbsentApplyInput,
  ) {
    return computeIfExpressionAbsentApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Text Block — Preview / Apply
  //
  // Palantir textBlockV1 — pure annotation; passes data through untouched
  // so the chain hash remains stable when an annotation is added.
  // =========================================================================

  async textBlockPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: TextBlockPreviewInput,
  ) {
    return textBlockPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async textBlockApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: TextBlockApplyInput,
  ) {
    return textBlockApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Aggregate-family transforms (PB-B2.follow-2) — shared TS-engine helpers.
  //
  // These mirror the field-reference semantics of the corresponding DuckDB
  // compilers in duckdbTransformEngine.ts; preview rows flow through the
  // legacy CSV path, so every helper here tolerates stringly-typed values
  // and coerces numerics exactly like evalBinaryExpression does.
  // =========================================================================

  // The implementations live in pipelines/ops/aggregateOps; these delegates
  // remain because existing unit tests exercise them through the service.
  private aggregationOutputType(item: AggregationItem, sourceType: string): string {
    return aggregationOutputTypeOp(item, sourceType);
  }

  private evalAggregation(
    item: AggregationItem,
    rows: Array<Record<string, unknown>>,
  ): unknown {
    return evalAggregationOp(item, rows);
  }

  private computeAggregations(
    rows: Array<Record<string, unknown>>,
    groupBy: string[],
    aggregations: AggregationItem[],
  ): Array<Record<string, unknown>> {
    return computeAggregationsOp(rows, groupBy, aggregations);
  }

  private computeRollup(
    rows: Array<Record<string, unknown>>,
    rollupColumns: string[],
    aggregations: AggregationItem[],
  ): Array<Record<string, unknown>> {
    return computeRollupOp(rows, rollupColumns, aggregations);
  }

  private resolveOnConditionTargets(
    predicate: ColumnPredicate,
    columns: Array<{ name: string; type: string }>,
  ): string[] {
    return resolveOnConditionTargetsOp(predicate, columns);
  }

  // =========================================================================
  // Aggregate — Preview / Apply
  //
  // Palantir groupAndAggregateV1.
  // =========================================================================

  async aggregatePreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregatePreviewInput,
  ) {
    return aggregatePreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async aggregateApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateApplyInput,
  ) {
    return aggregateApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Rollup — Preview / Apply
  //
  // Palantir rollupV1.
  // =========================================================================

  async rollupPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: RollupPreviewInput,
  ) {
    return rollupPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async rollupApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: RollupApplyInput,
  ) {
    return rollupApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Aggregate on Condition — Preview / Apply
  //
  // Palantir aggregateOnConditionV2.
  // =========================================================================

  /** Build the concrete aggregation list for an on-condition step. Each
   * dynamic aggregation lands on every target column with output name
   * `<column><suffix>` (Palantir columnNameConcat). */
  private buildOnConditionAggregations(
    targets: string[],
    expressions: DynamicAggregation[],
  ): AggregationItem[] {
    return buildOnConditionAggregationsOp(targets, expressions);
  }

  async aggregateOnConditionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateOnConditionPreviewInput,
  ) {
    return aggregateOnConditionPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async aggregateOnConditionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateOnConditionApplyInput,
  ) {
    return aggregateOnConditionApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Top Rows — Preview / Apply
  //
  // Palantir topRowsV1.
  // =========================================================================

  /** topRowV2 core: partition → per-partition sort → first N rows. Mirror
   * of the DuckDB engine's ROW_NUMBER() OVER (PARTITION … ORDER BY …).
   * Implementation lives in pipelines/ops/sortOps; the delegate remains
   * because existing unit tests exercise it through the service. */
  private computeTopRows(
    rows: Array<Record<string, unknown>>,
    partitionBy: string[],
    sorts: Array<{ column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>,
    topN: number,
  ): Array<Record<string, unknown>> {
    return computeTopRowsOp(rows, partitionBy, sorts, topN);
  }

  async topRowsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: TopRowsPreviewInput,
  ) {
    return topRowsPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async topRowsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: TopRowsApplyInput,
  ) {
    return topRowsApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Pivot — Preview / Apply
  //
  // Palantir pivotV1: long → wide.
  // =========================================================================

  /**
   * PivotV1 core. Implementation lives in pipelines/ops/pivotOps; the
   * delegate remains because existing unit tests exercise it through the
   * service.
   */
  private computePivot(
    rows: Array<Record<string, unknown>>,
    groupBy: string[],
    pivotColumn: string,
    pivotValues: Array<{ value: string; alias: string }>,
    aggregations: AggregationItem[],
    aliasPosition: 'prefix' | 'suffix',
  ): { rows: Array<Record<string, unknown>>; valueColumns: string[] } {
    return computePivotOp(rows, groupBy, pivotColumn, pivotValues, aggregations, aliasPosition);
  }

  async pivotPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: PivotPreviewInput,
  ) {
    return pivotPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async pivotApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: PivotApplyInput,
  ) {
    return pivotApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Unpivot — Preview / Apply
  //
  // Palantir unpivotV1: wide → long; keeps NULL values.
  // =========================================================================

  /** unpivotV1 core: one row per (kept key, unpivoted column).
   * Implementation lives in pipelines/ops/pivotOps; the delegate remains
   * because existing unit tests exercise it through the service. */
  private computeUnpivot(
    rows: Array<Record<string, unknown>>,
    columnsToUnpivot: string[],
    nameColumn: string,
    valueColumn: string,
    keptColumns: string[],
  ): Array<Record<string, unknown>> {
    return computeUnpivotOp(rows, columnsToUnpivot, nameColumn, valueColumn, keptColumns);
  }

  async unpivotPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnpivotPreviewInput,
  ) {
    return unpivotPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async unpivotApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnpivotApplyInput,
  ) {
    return unpivotApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Keep Duplicates — Preview / Apply
  //
  // Palantir keepDuplicatesV1: keep ALL rows whose key appears more than
  // once (contrast dropDuplicates which keeps only one).
  // =========================================================================

  /** keepDuplicatesV1 core: key-frequency filter, original order preserved.
   * Implementation lives in pipelines/ops/dedupeOps; the delegate remains
   * because existing unit tests exercise it through the service. */
  private computeKeepDuplicates(
    rows: Array<Record<string, unknown>>,
    subset: string[],
    allColumns: string[],
  ): Array<Record<string, unknown>> {
    return computeKeepDuplicatesOp(rows, subset, allColumns);
  }

  async keepDuplicatesPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: KeepDuplicatesPreviewInput,
  ) {
    return keepDuplicatesPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  async keepDuplicatesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: KeepDuplicatesApplyInput,
  ) {
    return keepDuplicatesApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Private helpers — fetch / persist node config (DRY for the new apply
  // methods above; mirrors the inline pattern used by castApply et al).
  // =========================================================================

  public async fetchNodeConfig(
    projectId: string, pipelineId: string, nodeId: string,
  ): Promise<{ id: string; config: Record<string, unknown> }> {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    return { id: node.id, config };
  }

  public async saveNodeConfig(
    nodeId: string, pipelineId: string, config: Record<string, unknown>,
  ) {
    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
  }

  /**
   * Shared column-existence validation for the aggregate-family previews.
   * Throws the same 400 shape used by the older preview methods.
   */
  public assertColumnsExist(
    effectiveNames: Set<string>,
    needed: string[],
    fnName: string,
  ): void {
    for (const c of needed) {
      if (!effectiveNames.has(c)) {
        throw new AppError(
          `${fnName} column "${c}" does not exist. Available: ${[...effectiveNames].join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }
  }


  // =========================================================================
  // Join — Preview
  // =========================================================================

  /**
   * Preview a Join transform.
   *
   * Reads both left and right datasets from S3, applies prior transforms
   * to the left side, then joins based on conditions and join type.
   *
   * Join types follow Palantir's joinV2 semantics:
   *   - left: keep all left rows, match right where conditions met
   *   - right: keep all right rows, match left where conditions met
   *   - inner: only rows matching in both sides
   *   - full_outer: all rows from both sides
   *   - cross: Cartesian product (no conditions needed)
   */
  async joinPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: JoinPreviewInput,
  ) {
    return joinPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Join — Apply (persist config)
  // =========================================================================

  async joinApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: JoinApplyInput,
  ) {
    return joinApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Union by name — Preview
  // =========================================================================

  /**
   * Resolve the effective columns and rows for a node, using the best
   * available data source. The decision tree is driven by node_type so
   * deploy and preview share the exact same materialization semantics:
   *
   *   - `dataset`   → read the raw CSV + apply this node's transforms.
   *   - `transform` → walk upstream via `resolveNodeDataset` which
   *                   collapses the linear transform chain onto a single
   *                   dataset CSV; then apply the merged transforms.
   *   - `join` / `union` → MUST use `previewSnapshot`. Joins and unions
   *                   are not linearly compose-able onto a single CSV;
   *                   replaying them requires the snapshot captured at
   *                   Apply time. If the snapshot is missing or empty
   *                   we hard-fail with `SNAPSHOT_REQUIRED` rather than
   *                   silently degrading to "read the leftmost CSV"
   *                   (which is the deploy-correctness bug fixed here).
   *   - `output`    → recurse into `sourceNodeId`. The output node
   *                   itself never carries a snapshot; its data is
   *                   exactly the data of the node it points at. This
   *                   is the entry point used by the deploy worker.
   *
   * The previous implementation only honored the snapshot of the
   * requested node; for an output node (which never has one) the
   * fallback walked `sourceNodeId` via `resolveNodeDataset` and
   * collapsed everything onto the leftmost dataset's CSV — silently
   * dropping every join and union in the graph. The deployed dataset
   * ended up reflecting one branch instead of the union's output.
   */
  public async resolveNodeData(
    projectId: string, pipelineId: string, nodeId: string,
    priorTransforms?: unknown[],
    /** Internal guard: detect sourceNodeId cycles in malformed graphs. */
    _visited: Set<string> = new Set<string>(),
  ): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    /**
     * True when this branch's rows came from a bounded CSV read that hit the
     * cap. Snapshot-backed branches report false: a snapshot is whatever Apply
     * captured, and its own truncation was recorded at capture time.
     */
    truncated?: boolean;
  }> {
    if (_visited.has(nodeId)) {
      throw new AppError(
        `Cycle detected in pipeline node graph at ${nodeId}.`,
        400,
        'PIPELINE_CYCLE',
      );
    }
    _visited.add(nodeId);

    const node = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .select('id', 'node_type', 'config')
      .first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const cfg = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const snap = cfg.previewSnapshot;
    const hasSnapshot =
      snap && Array.isArray(snap.columns) && Array.isArray(snap.rows)
        && snap.columns.length > 0;

    // Output nodes are pure passthroughs — never carry their own snapshot.
    // Forward to the upstream node so the union/join semantics are honored.
    if (node.node_type === 'output') {
      const src = cfg.sourceNodeId as string | undefined;
      if (!src) {
        throw new AppError(
          'Output node has no sourceNodeId configured.',
          400,
          'OUTPUT_UNWIRED',
        );
      }
      return this.resolveNodeData(projectId, pipelineId, src, priorTransforms, _visited);
    }

    // Join/union outputs must come from the pinned snapshot — they are
    // not linearly compose-able with the transform chain. A missing
    // snapshot at this point means the user added the node but never
    // hit Apply; failing loudly here prevents the deploy from silently
    // reading only the left branch.
    if (node.node_type === 'join' || node.node_type === 'union') {
      if (hasSnapshot) {
        return { columns: snap.columns, rows: snap.rows };
      }
      throw new AppError(
        `Cannot resolve ${node.node_type} node "${nodeId}" — no preview ` +
          `snapshot has been captured. Open the node and click "Apply" ` +
          `to materialize its output before previewing or deploying.`,
        400,
        'SNAPSHOT_REQUIRED',
      );
    }

    // For dataset/transform nodes the snapshot, when present, is still
    // the freshest representation (e.g. a transform node where Apply
    // pinned the output). Prefer it.
    if (hasSnapshot) {
      return { columns: snap.columns, rows: snap.rows };
    }

    // Fallback: resolve from raw CSV + transform chain.
    const { dataset, sourceColumns, existingTransforms } =
      await this.resolveNodeDataset(projectId, pipelineId, nodeId);
    const transforms = priorTransforms ?? existingTransforms;
    const raw = await this.readCsvRows(dataset.file_path, PREVIEW_SOURCE_ROW_LIMIT);
    const rows = this.applyExistingTransforms(raw, transforms);
    const columns = this.applyExistingTransformColumns(sourceColumns, transforms);
    return {
      columns,
      rows,
      truncated: raw.length >= PREVIEW_SOURCE_ROW_LIMIT,
    };
  }

  // ── Output node preview ──────────────────────────────────────────────────
  // Resolves the fully-transformed data from the upstream chain for an output
  // node. Walks sourceNodeId → collects transforms → reads CSV → applies them.
  // Returns the same shape as transform/join/union previews.

  async outputPreview(
    projectId: string, pipelineId: string, nodeId: string,
    limit = 500,
  ): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    totalRows: number;
    sampledSourceRows: number;
    sourceRowLimit: number;
    truncated: boolean;
  }> {
    const data = await this.resolveNodeData(projectId, pipelineId, nodeId);
    const totalRows = data.rows.length;
    const rows = data.rows.slice(0, limit);
    // `totalRows` here is post-transform, so it can legitimately differ from
    // the rows read; what matters to the caller is whether the read that fed
    // it was itself clipped. Deploy uses materializeForDeploy, which is
    // unbounded, so this flag is a preview-only caveat.
    return {
      columns: data.columns,
      rows,
      totalRows,
      sampledSourceRows: data.rows.length,
      sourceRowLimit: PREVIEW_SOURCE_ROW_LIMIT,
      truncated: Boolean(data.truncated),
    };
  }

  // ============================================================================
  // Deploy-time materialization — FULL DAG RE-EXECUTION (unbounded)
  // ============================================================================
  //
  // Foundry semantics: preview is bounded (the canvas needs instant
  // feedback, ~500 rows). Deploy is UNBOUNDED — the dataset written to
  // storage must reflect every input row, not the canvas's truncated
  // preview snapshot.
  //
  // The legacy deploy path resolved each output via `outputPreview` →
  // `resolveNodeData` → `previewSnapshot.rows`. For join/union nodes
  // `resolveNodeData` HARD-REQUIRES the snapshot (because joins/unions
  // can't be linearly composed). That snapshot is persisted by the
  // canvas at Apply time with at most ~500 rows. Result: any pipeline
  // whose terminal output passed through a join or union silently
  // dropped every row past 500 — independent of the 100k cap on the
  // `outputPreview` slice itself.
  //
  // This method bypasses snapshots entirely on the deploy path. It
  // walks the node graph from the requested node back to its dataset
  // leaves, re-reading every CSV unbounded and re-executing every
  // transform / join / union from raw inputs.
  //
  // The execution primitives are the same battle-tested ones used by
  // the canvas preview (`readCsvRows`, `applyExistingTransforms`,
  // `executeJoin`, the union-by-name rebase) — only the row bound and
  // the snapshot dependency differ.
  //
  // Topology (mirrors `walkTransitiveInputs`):
  //   - dataset   → `pn.dataset_id` → `foundry_datasets.file_path`
  //   - transform → `config.sourceNodeId` (recurse)
  //   - join      → `config.sourceNodeId` (left) + `config.rightNodeId`
  //                 or the rightNodeId persisted on the Join transform step
  //   - union     → `config.sourceNodeId` (left) + `config.rightNodeId`
  //   - output    → `config.sourceNodeId` (recurse)
  async materializeForDeploy(
    projectId: string,
    pipelineId: string,
    nodeId: string,
    _visited: Set<string> = new Set<string>(),
  ): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    totalRows: number;
  }> {
    if (_visited.has(nodeId)) {
      throw new AppError(
        `Cycle detected in pipeline node graph at ${nodeId}.`,
        400,
        'PIPELINE_CYCLE',
      );
    }
    _visited.add(nodeId);

    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.node_type', 'pn.dataset_id', 'pn.config')
      .first();
    if (!node) {
      throw new AppError(
        `Pipeline node not found: ${nodeId}`,
        404,
        'NOT_FOUND',
      );
    }

    const cfg =
      typeof node.config === 'string'
        ? JSON.parse(node.config)
        : (node.config ?? {});
    const ownTransforms: unknown[] = Array.isArray(cfg.transforms)
      ? cfg.transforms
      : [];

    switch (node.node_type) {
      case 'output': {
        const src = cfg.sourceNodeId as string | undefined;
        if (!src) {
          throw new AppError(
            `Output node ${nodeId} has no sourceNodeId configured.`,
            400,
            'OUTPUT_UNWIRED',
          );
        }
        return this.materializeForDeploy(projectId, pipelineId, src, _visited);
      }

      case 'dataset': {
        const { dataset, sourceColumns } = await this.resolveNodeDataset(
          projectId, pipelineId, nodeId,
        );
        // FULL read — no row cap. Pinned-input cache (PB-B6) is still
        // honoured inside readCsvRows so deploy parity with the captured
        // pin is preserved when seedPinnedInputsForDeploy ran first.
        const raw = await this.readCsvRows(
          dataset.file_path,
          Number.MAX_SAFE_INTEGER,
        );
        const rows = this.applyExistingTransforms(raw, ownTransforms);
        const columns = this.applyExistingTransformColumns(
          sourceColumns,
          ownTransforms,
        );
        return { columns, rows, totalRows: rows.length };
      }

      case 'transform': {
        // Prefer explicit upstream wiring (canvas graph edge). When a
        // transform points at a join/union/transform parent we recurse
        // through materializeForDeploy so the FULL upstream is rebuilt
        // — never the capped snapshot.
        const src = cfg.sourceNodeId as string | undefined;
        if (src) {
          const up = await this.materializeForDeploy(
            projectId, pipelineId, src, _visited,
          );
          const rows = this.applyExistingTransforms(up.rows, ownTransforms);
          const columns = this.applyExistingTransformColumns(
            up.columns,
            ownTransforms,
          );
          return { columns, rows, totalRows: rows.length };
        }
        // Legacy/seed shape — transform node bound directly to a dataset
        // through resolveNodeDataset's recursive walk (no sourceNodeId
        // hop). Replays the full collapsed transform chain unbounded.
        const { dataset, sourceColumns, existingTransforms } =
          await this.resolveNodeDataset(projectId, pipelineId, nodeId);
        const raw = await this.readCsvRows(
          dataset.file_path,
          Number.MAX_SAFE_INTEGER,
        );
        const rows = this.applyExistingTransforms(raw, existingTransforms);
        const columns = this.applyExistingTransformColumns(
          sourceColumns,
          existingTransforms,
        );
        return { columns, rows, totalRows: rows.length };
      }

      case 'join': {
        // Canvas convention: join spec lives at the TOP LEVEL of
        // config (joinType, conditions, sourceNodeId, rightNodeId,
        // *SelectedColumns). The legacy `transforms[].{function:'Join'}`
        // shape is still honoured as a fallback so older pipelines
        // deploy correctly without a migration.
        const joinStep = ownTransforms.find(
          (t) => (t as { function?: string })?.function === 'Join',
        ) as
          | {
              joinType?: JoinType;
              conditions?: Array<{ leftColumn: string; rightColumn: string; operator?: JoinOperator }>;
              rightNodeId?: string;
              rightPrefix?: string;
              coalesceJoinKeys?: boolean;
            }
          | undefined;
        const joinType =
          ((cfg.joinType ?? joinStep?.joinType) as JoinType | undefined);
        const conditions = (cfg.conditions ?? joinStep?.conditions) as
          | Array<{ leftColumn: string; rightColumn: string; operator?: JoinOperator }>
          | undefined;
        const coalesceJoinKeys = Boolean(
          cfg.coalesceJoinKeys ?? joinStep?.coalesceJoinKeys,
        );
        const leftSrc = cfg.sourceNodeId as string | undefined;
        const rightSrc =
          (cfg.rightNodeId as string | undefined) ?? joinStep?.rightNodeId;
        const rightPrefix = (cfg.rightPrefix as string | undefined)
          ?? joinStep?.rightPrefix ?? 'right_';
        const leftSelected = Array.isArray(cfg.leftSelectedColumns)
          ? new Set<string>(cfg.leftSelectedColumns as string[])
          : null;
        const rightSelected = Array.isArray(cfg.rightSelectedColumns)
          ? new Set<string>(cfg.rightSelectedColumns as string[])
          : null;
        if (!leftSrc) {
          throw new AppError(
            `Join node ${nodeId} has no sourceNodeId (left input).`,
            400,
            'JOIN_UNWIRED',
          );
        }
        if (!rightSrc) {
          throw new AppError(
            `Join node ${nodeId} has no rightNodeId (right input).`,
            400,
            'JOIN_UNWIRED',
          );
        }
        // Cross joins legitimately carry no conditions (Cartesian product) —
        // the preview schema allows an empty condition list for them, so the
        // deploy materialiser must too, or a cross join that previews fine is
        // undeployable (preview/deploy semantics must not diverge).
        if (
          !joinType ||
          !Array.isArray(conditions) ||
          (conditions.length === 0 && joinType !== 'cross')
        ) {
          throw new AppError(
            `Join node ${nodeId} is missing joinType or conditions.`,
            400,
            'JOIN_SPEC_MISSING',
          );
        }
        // Two-input fan-in: clone _visited per branch so a legitimate
        // shared upstream (the same dataset feeding both arms of a
        // self-join, for instance) is not falsely flagged as a cycle.
        // Within a single branch the original cycle guard still fires.
        const left = await this.materializeForDeploy(
          projectId, pipelineId, leftSrc, new Set<string>(_visited),
        );
        const right = await this.materializeForDeploy(
          projectId, pipelineId, rightSrc, new Set<string>(_visited),
        );
        // Execute the join with the FULL column set on both sides so
        // outer-join null fills land on every name the canvas knows
        // about — column selection is applied as a projection after.
        const joinedRows = this.executeJoin(
          left.rows,
          right.rows,
          joinType,
          conditions,
          left.columns,
          right.columns,
          rightPrefix,
          coalesceJoinKeys,
        );
        // Compose output columns mirroring joinPreview: filter each
        // side by its *SelectedColumns set, then concatenate with the
        // right names prefixed on collision with left.
        const filteredLeftCols = leftSelected
          ? left.columns.filter((c) => leftSelected.has(c.name))
          : left.columns;
        const filteredRightCols = rightSelected
          ? right.columns.filter((c) => rightSelected.has(c.name))
          : right.columns;
        const leftNames = new Set(filteredLeftCols.map((c) => c.name));
        // Same derivation as joinPreview: a coalesced right key must be
        // absent here too, or deploy would emit a column the rows do not
        // carry (blank downstream) while preview showed one merged column.
        const coalescedNames = coalesceJoinKeys
          ? coalescedJoinKeyNames(conditions, leftNames, stripBom)
          : new Set<string>();
        const columns: Array<{ name: string; type: string }> = [
          ...filteredLeftCols,
          ...filteredRightCols
            .filter((c) => !coalescedNames.has(c.name))
            .map((c) => ({
              name: leftNames.has(c.name) ? `${rightPrefix}${c.name}` : c.name,
              type: c.type,
            })),
        ];
        // Project rows down to the selected column set (preserves
        // output ordering; absent keys are omitted, matching the
        // canvas's filteredRows step in joinPreview).
        const outputColNames = columns.map((c) => c.name);
        const rows = joinedRows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const c of outputColNames) if (c in r) out[c] = r[c];
          return out;
        });
        return { columns, rows, totalRows: rows.length };
      }

      case 'union': {
        const leftSrc = cfg.sourceNodeId as string | undefined;
        // N-input union (Palantir `List<Table>`): `rightNodeIds` is the list
        // unionApply persists; the singular `rightNodeId` is the legacy shape
        // and is folded in by resolveUnionInputIds.
        const additionalSrc = resolveUnionInputIds({
          rightNodeId: cfg.rightNodeId as string | undefined,
          rightNodeIds: cfg.rightNodeIds as string[] | undefined,
        });
        if (!leftSrc || additionalSrc.length === 0) {
          throw new AppError(
            `Union node ${nodeId} requires sourceNodeId and at least one ` +
              `additional input (rightNodeIds, or the legacy rightNodeId).`,
            400,
            'UNION_UNWIRED',
          );
        }
        const left = await this.materializeForDeploy(
          projectId, pipelineId, leftSrc, new Set<string>(_visited),
        );
        const others = await Promise.all(
          additionalSrc.map((src) => this.materializeForDeploy(
            projectId, pipelineId, src, new Set<string>(_visited),
          )),
        );
        const branches = [left, ...others];
        // Union modes (unionV1): cfg.mode persists the canvas choice.
        //   first : first input's schema only; later-only columns dropped.
        //   narrow: columns present in EVERY input.
        //   wide  : name superset in input order (canvas default).
        const mode = (cfg.mode as string | undefined) ?? 'wide';
        const otherNameSets = others.map((b) => new Set(b.columns.map((c) => c.name)));
        let columns: Array<{ name: string; type: string }>;
        if (mode === 'first') {
          columns = left.columns;
        } else if (mode === 'narrow') {
          columns = left.columns.filter((c) => otherNameSets.every((s) => s.has(c.name)));
          if (columns.length === 0) {
            throw new AppError(
              `Union node ${nodeId} in "narrow" mode produced zero columns: ` +
                `the ${branches.length} inputs share no column names.`,
              400,
              'UNION_NARROW_EMPTY',
            );
          }
        } else {
          // Union-by-name (canvas default): output columns = unique union
          // with input ordering preserved (first input, then each later one).
          const seen = new Set<string>();
          columns = [];
          for (const branch of branches) {
            for (const c of branch.columns) {
              if (!seen.has(c.name)) { seen.add(c.name); columns.push(c); }
            }
          }
        }
        // Rows from each input are rebased onto the output column set
        // with null-fill for missing names.
        const colNames = columns.map((c) => c.name);
        const rebase = (
          r: Record<string, unknown>,
        ): Record<string, unknown> => {
          const out: Record<string, unknown> = {};
          for (const c of colNames) out[c] = (c in r) ? r[c] : null;
          return out;
        };
        const rows = branches.flatMap((b) => b.rows.map(rebase));
        return { columns, rows, totalRows: rows.length };
      }

      default:
        throw new AppError(
          `materializeForDeploy: unknown node_type "${node.node_type}" for node ${nodeId}.`,
          400,
          'UNKNOWN_NODE_TYPE',
        );
    }
  }

  async unionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnionPreviewInput,
  ) {
    return unionPreviewOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // Union by name — Apply (persist config)
  // =========================================================================

  async unionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnionApplyInput,
  ) {
    return unionApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  // =========================================================================
  // UDF — user-authored transform (FOUNDRY-GAPS §2)
  //
  // A UDF is the one transform that cannot compile to engine SQL: it is
  // arbitrary user code. It is stored on the node's `config.udfTransform`
  // slot — deliberately NOT in `config.transforms` so the Trino/DuckDB
  // compilers never try to fold it — and executed inside the gVisor sandbox
  // proven in §1/§3 (a Kubernetes Job pinned to the `gvisor` RuntimeClass,
  // hardened pod, deny-all egress). There is no in-process eval path: running
  // user code unsandboxed is exactly the risk the substrate work removed.
  // =========================================================================

  /**
   * Persist a UDF transform onto a node. Validates the spec (language allow-
   * list, code size, entrypoint identifier, timeout bounds) before storing it.
   */
  async udfApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: unknown,
  ) {
    return udfApplyOp(this, projectId, pipelineId, nodeId, input);
  }

  /**
   * Preview a UDF: resolve the node's input rows (the existing CSV + prior
   * transform chain), then execute the user code over a bounded slice inside
   * the gVisor sandbox and return the transformed rows. Requires the sandbox
   * runtime (TELLUS_UDF_RUNTIME=k8s); otherwise surfaces a typed 503 so the
   * UI can explain that the substrate isn't wired in this environment.
   */
  async udfPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: unknown,
    limit = 100,
  ) {
    return udfPreviewOp(this, projectId, pipelineId, nodeId, input, limit);
  }

  // =========================================================================
  // Private: Join execution engine
  // =========================================================================

  private executeJoin(
    leftRows: Array<Record<string, unknown>>,
    rightRows: Array<Record<string, unknown>>,
    joinType: JoinType,
    conditions: Array<{ leftColumn: string; rightColumn: string; operator?: JoinOperator }>,
    leftCols: Array<{ name: string; type: string }>,
    rightCols: Array<{ name: string; type: string }>,
    rightPrefix = 'right_',
    coalesceJoinKeys = false,
  ): Array<Record<string, unknown>> {
    return executeJoinOp(leftRows, rightRows, joinType, conditions, leftCols, rightCols, rightPrefix, coalesceJoinKeys);
  }

  // =========================================================================
  // Execute Full Chain — runs ALL saved transforms on ALL data
  // =========================================================================

  /**
   * Execute the entire transform chain saved on a node against the full
   * source dataset. This is called when the user clicks "Apply All".
   *
   * Returns the complete transformed dataset (all rows, all columns after
   * transforms). The result (first 500 rows) is ALSO persisted as the
   * node's previewSnapshot here — the legacy flow had the client save the
   * snapshot in a second request, so a failed/interrupted follow-up left
   * a node whose config and saved schema diverged ("0 columns" forever).
   */
  async executeChain(
    projectId: string, pipelineId: string, nodeId: string,
  ) {
    const result = await this.executeChainInternal(projectId, pipelineId, nodeId);
    await this.persistExecutionSnapshot(projectId, pipelineId, nodeId, result.columns, result.rows);
    return result;
  }

  /**
   * Write the outcome of a successful full-chain execution as the node's
   * previewSnapshot, merging into the existing config so unrelated keys
   * (wiring, labels) are preserved. The transforms recorded are the node's
   * OWN persisted chain — the same source the deploy stale-check hashes —
   * so snapshot and config can never disagree about which chain produced
   * the saved rows.
   */
  public async persistExecutionSnapshot(
    projectId: string, pipelineId: string, nodeId: string,
    columns: Array<{ name: string; type: string }>,
    rows: Array<Record<string, unknown>>,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const transforms: unknown[] = Array.isArray(config.transforms) ? config.transforms : [];
    const snapshotRows = rows.slice(0, 500);
    config.previewSnapshot = {
      ...(config.previewSnapshot ?? {}),
      columns,
      rows: snapshotRows,
      rowCount: snapshotRows.length,
      transforms,
      chainHash: hashTransformChain(transforms),
      schemaFingerprint: fingerprintSchema(columns),
      nodeId,
      transitiveInputSnapshots: await this.walkTransitiveInputs(pipelineId, nodeId),
      savedAt: new Date().toISOString(),
    };
    await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) });
  }

  private async executeChainInternal(
    projectId: string, pipelineId: string, nodeId: string,
  ) {
    // Join/union chains: never replay the left CSV — rebuild the full graph
    // input (unbounded, exactly like deploy) and apply this node's own
    // transforms on top. This is what lets "Apply All" on a transform node
    // hanging off a join pin the correct filtered/joined snapshot instead of
    // silently capturing the join's left branch.
    const graph = await this.detectGraphTarget(projectId, pipelineId, nodeId);
    if (graph) {
      const up = await this.materializeForDeploy(projectId, pipelineId, graph.targetId);
      const transforms = graph.ownTransforms;
      const transformedRows = transforms.length > 0
        ? this.applyExistingTransforms(up.rows, transforms)
        : up.rows;
      const effectiveColumns = transforms.length > 0
        ? this.applyExistingTransformColumns(up.columns, transforms)
        : up.columns;
      return {
        columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
        rows: transformedRows,
        rowCount: transformedRows.length,
        transformCount: transforms.length,
        engine: 'legacy_nodejs' as const,
        sampledSourceRows: transformedRows.length,
        sourceRowLimit: EXECUTE_SOURCE_ROW_LIMIT,
        truncated: false,
      };
    }

    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId, pipelineId, nodeId,
    );

    if (existingTransforms.length === 0) {
      // No transforms — return raw data
      const rawRows = await this.readCsvRows(dataset.file_path, EXECUTE_SOURCE_ROW_LIMIT);
      return {
        columns: sourceColumns.map((c) => ({ name: c.name, type: c.type })),
        rows: rawRows,
        rowCount: rawRows.length,
        transformCount: 0,
        sampledSourceRows: rawRows.length,
        sourceRowLimit: EXECUTE_SOURCE_ROW_LIMIT,
        truncated: rawRows.length >= EXECUTE_SOURCE_ROW_LIMIT,
      };
    }

    // PB-B2 engine selector — reads pipelines.compute_type.
    //   'duckdb'        → compile chain into one SQL statement and run
    //                     via the shared DuckDB pool (default for new
    //                     pipelines).
    //   'legacy_nodejs' → the pure-TS engine below (kept for one release
    //                     cycle so existing pipelines keep green).
    //
    // Chains containing `Normalize`, `UppercaseColumnNames` or `RowSize`
    // fall back to legacy automatically — those three need the legacy TS
    // engine (Normalize for unicode folding, UppercaseColumnNames for the
    // column-name fold, RowSize for a portable whole-row byte estimate)
    // until PB-B2.follow-2 ships the Rust UDFs — instead of compiling a
    // broken SQL statement we route around it so the user's request
    // still completes with matching semantics.
    const computeType = await this.getComputeType(pipelineId);
    // FormatString stays legacy too: printf-style templating (%+.4f etc.) has no
    // portable DuckDB translation, and preview/deploy already agree on the TS
    // engine for it.
    const needsLegacy = new Set(['Normalize', 'UppercaseColumnNames', 'RowSize', 'FormatString']);
    const hasLegacyOnly = existingTransforms.some((t) =>
      needsLegacy.has((t as { function?: string })?.function ?? ''),
    );
    if (computeType === 'duckdb' && !hasLegacyOnly) {
      try {
        const { executeTransformChain } = await import(
          './pipelines/duckdbTransformEngine'
        );
        // `dataset.file_path` is the bare S3 object key produced by
        // `buildObjectKey()` (e.g. `projects/<id>/folders/<id>/file.csv`).
        // DuckDB cannot read that directly — without an `s3://<bucket>/`
        // prefix it falls through to the local filesystem and fails with
        // `IO Error: No files found that match the pattern ...`.
        // `toDuckDbReadUri` prepends the configured bucket so the engine's
        // httpfs path can resolve the object via the same MinIO/S3
        // endpoint that the legacy `getObjectStream()` reader uses. The
        // engine itself also asserts the URI is qualified (defense in depth).
        const inputUri = toDuckDbReadUri(dataset.file_path);
        const out = await executeTransformChain(
          existingTransforms as Parameters<typeof executeTransformChain>[0],
          { inputPath: inputUri, limit: EXECUTE_SOURCE_ROW_LIMIT },
        );
        return {
          columns: out.columns,
          rows: out.rows,
          rowCount: out.rowCount,
          transformCount: existingTransforms.length,
          engine: 'duckdb' as const,
          // The SQL limit lands on the chain's *output*, so a full result is
          // only distinguishable from a clipped one by whether it hit the cap.
          // Both engines report this identically so the canvas doesn't have to
          // know which one ran.
          sampledSourceRows: out.rowCount,
          sourceRowLimit: EXECUTE_SOURCE_ROW_LIMIT,
          truncated: out.rowCount >= EXECUTE_SOURCE_ROW_LIMIT,
        };
      } catch (err) {
        // Already-typed errors (compile rejection, cross-join, native
        // binding missing, our boundary validation) flow through as-is.
        if (err instanceof AppError) throw err;
        // Map DuckDB IO failures to a typed 404 so clients can
        // distinguish "the dataset's underlying file is gone" from a
        // genuine 500. The DuckDB binding surfaces these as plain
        // `Error` with messages like:
        //   `IO Error: No files found that match the pattern "..."`
        //   `HTTP Error: HTTP GET error on '...' (HTTP 403)`
        //   `HTTP Error: HTTP GET error on '...' (HTTP 404)`
        // We sanitise the message so the SQL line marker DuckDB appends
        // does not leak into the API contract.
        const message = err instanceof Error ? err.message : String(err);
        if (
          /^IO Error: No files found that match the pattern/i.test(message) ||
          /HTTP\s+(?:404|403)/i.test(message) ||
          /HTTPException.*(?:NoSuchKey|AccessDenied)/i.test(message)
        ) {
          throw new AppError(
            `Dataset file is not readable from object storage. ` +
              `It may have been deleted, moved, or the storage credentials ` +
              `may have changed. Re-upload the source file or contact an ` +
              `administrator.`,
            404,
            'DATASET_FILE_NOT_FOUND',
          );
        }
        // A connection failure is a different problem from a missing object:
        // the object store is unreachable from this process (wrong endpoint
        // hostname, MinIO/S3 down, network policy). Reporting it as a generic
        // 500 sent people hunting for a bug in the transform chain, so name it.
        if (
          /Could not establish connection/i.test(message) ||
          /Connection refused|ECONNREFUSED/i.test(message) ||
          /Could not resolve host|Timeout was reached/i.test(message)
        ) {
          throw new AppError(
            `Object storage is unreachable from the server, so the transform ` +
              `chain could not be materialised. Check that the storage service ` +
              `is running and that S3_ENDPOINT resolves from this process.`,
            503,
            'OBJECT_STORAGE_UNREACHABLE',
          );
        }
        // Anything else bubbles as 500 — let the global error handler
        // log it with the request id for follow-up.
        throw err;
      }
    }

    // Legacy TS engine path.
    const rawRows = await this.readCsvRows(dataset.file_path, EXECUTE_SOURCE_ROW_LIMIT);
    const transformedRows = this.applyExistingTransforms(rawRows, existingTransforms);
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, existingTransforms);

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows: transformedRows,
      rowCount: transformedRows.length,
      transformCount: existingTransforms.length,
      engine: 'legacy_nodejs' as const,
      sampledSourceRows: rawRows.length,
      sourceRowLimit: EXECUTE_SOURCE_ROW_LIMIT,
      truncated: rawRows.length >= EXECUTE_SOURCE_ROW_LIMIT,
    };
  }

  private async getComputeType(
    pipelineId: string,
  ): Promise<'duckdb' | 'legacy_nodejs'> {
    const row = await this.knex('pipelines')
      .where({ id: pipelineId })
      .first('compute_type');
    const ct = (row?.compute_type ?? 'legacy_nodejs') as string;
    // Defensive: the column's CHECK constraint restricts to the two
    // values, but older seed data may still carry legacy enum values.
    return ct === 'duckdb' ? 'duckdb' : 'legacy_nodejs';
  }

  // =========================================================================
  // Preview Snapshot — save and retrieve
  // =========================================================================

  /**
   * Save a transform preview snapshot to the node's config.
   * Called when user clicks "Apply All". Stores the final preview result
   * so it can be retrieved later when the transform node is selected.
   */
  async savePreviewSnapshot(
    projectId: string, pipelineId: string, nodeId: string,
    input: SavePreviewSnapshotInput,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.dataset_id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    // PB-B6 — capture the chain hash + schema fingerprint so the deploy
    // path can detect drift (PREVIEW_STALE) and so the frontend GET can
    // surface a `stale=true` flag when the user edits the chain.
    //
    // Upstream version capture (Iceberg snapshot id / S3 version id) is
    // optional here: the legacy FE saves only the preview rows + chain,
    // and doesn't know the upstream revision coordinates. When the
    // deploy path runs PB-B6's stale+pin flow it can re-capture against
    // the current upstream; for the immediate envelope we at least
    // record enough to detect chain-level drift.
    const chainHash = hashTransformChain(input.transforms ?? []);
    const schemaFingerprint = fingerprintSchema(input.columns ?? []);
    // PB-B6 follow-transitive — walk the node graph to collect every
    // upstream dataset (direct sourceNodeId chain + rightNodeId on
    // join/union nodes). Capture a per-dataset pin so the deploy path
    // can audit the full input set via `input_snapshots` without
    // re-discovering the graph.
    const transitiveInputSnapshots = await this.walkTransitiveInputs(
      pipelineId,
      nodeId,
    );
    config.previewSnapshot = {
      ...(config.previewSnapshot ?? {}),
      columns: input.columns,
      rows: input.rows,
      rowCount: input.rowCount,
      transforms: input.transforms,
      chainHash,
      schemaFingerprint,
      // nodeId recorded redundantly so downstream readers can tell which
      // node the envelope was captured against.
      nodeId,
      transitiveInputSnapshots,
      savedAt: new Date().toISOString(),
    };

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
  }

  /**
   * Retrieve the saved preview snapshot from a node's config. PB-B6 —
   * augments the payload with `stale=true` when the live transforms on
   * the node have drifted from the captured chain hash, so the frontend
   * can render a "Re-preview required" banner without extra RTTs.
   */
  /**
   * PB-B6 follow-transitive — walk a pipeline node's upstream graph
   * and collect the dataset coordinates of every contributor. This
   * covers:
   *   * sourceNodeId chains (transform nodes that reference another
   *     node as their upstream).
   *   * rightNodeId joins/unions (the right-hand dataset is a distinct
   *     contributor and must land in input_snapshots).
   * Visited nodes are tracked so a malformed graph with a cycle
   * still terminates in O(nodes) work.
   */
  public async walkTransitiveInputs(
    pipelineId: string,
    startNodeId: string,
  ): Promise<Array<{
    nodeId: string;
    datasetId: string | null;
    filePath: string | null;
    format: string | null;
  }>> {
    const out: Array<{
      nodeId: string;
      datasetId: string | null;
      filePath: string | null;
      format: string | null;
    }> = [];
    const visited = new Set<string>();
    const queue: string[] = [startNodeId];
    while (queue.length > 0) {
      const nid = queue.shift()!;
      if (visited.has(nid)) continue;
      visited.add(nid);
      const row = await this.knex('pipeline_nodes as pn')
        .leftJoin('foundry_datasets as fd', 'pn.dataset_id', 'fd.id')
        .where({ 'pn.id': nid, 'pn.pipeline_id': pipelineId })
        .select(
          'pn.id',
          'pn.dataset_id',
          'pn.config',
          'fd.file_path as file_path',
          'fd.format as format',
        )
        .first();
      if (!row) continue;
      if (row.dataset_id) {
        out.push({
          nodeId: row.id,
          datasetId: row.dataset_id,
          filePath: row.file_path ?? null,
          format: row.format ?? null,
        });
      }
      const cfg =
        typeof row.config === 'string' ? JSON.parse(row.config) : row.config ?? {};
      const next: string[] = [];
      if (typeof cfg.sourceNodeId === 'string') next.push(cfg.sourceNodeId);
      if (typeof cfg.rightNodeId === 'string') next.push(cfg.rightNodeId);
      if (typeof cfg.leftNodeId === 'string') next.push(cfg.leftNodeId);
      for (const id of next) if (!visited.has(id)) queue.push(id);
    }
    return out;
  }

  async getPreviewSnapshot(
    projectId: string, pipelineId: string, nodeId: string,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const snap = config.previewSnapshot;
    if (!snap) return null;
    const currentChainHash = chainHashFromNodeConfig(config);
    const stale = snap.chainHash ? snap.chainHash !== currentChainHash : false;
    return {
      ...snap,
      currentChainHash,
      stale,
    };
  }

  // =========================================================================
  // Private: update column metadata after replaying existing transforms
  // =========================================================================

  /**
   * Walk the saved transform chain and update column metadata to reflect
   * type changes made by Cast transforms.  This ensures that preview
   * responses return the correct column types even when earlier transforms
   * changed them (e.g. Cast before Filter).
   */
  /**
   * Replay the saved transform chain over the declared column list.
   * Implementation lives in ./transform/applyExisting (extracted during
   * the god-file breakup; behavior identical, unit-tested in isolation).
   */
  public applyExistingTransformColumns(
    sourceColumns: Array<{ name: string; type: string }>,
    transforms: unknown[],
  ): Array<{ name: string; type: string }> {
    return applyExistingTransformColumnsImpl(sourceColumns, transforms);
  }

  // =========================================================================
  // Private: replay existing transform chain
  // =========================================================================

  /**
   * Apply all previously-saved transforms (from config.transforms[])
   * sequentially to raw CSV rows, producing the intermediate dataset
   * that the next transform should operate on.
   *
   * This ensures chained transforms work correctly:
   *   Cast(age→int) → Filter(age > 25) operates on casted integer values.
   */
  /**
   * Apply all previously-saved transforms (from config.transforms[])
   * sequentially to raw CSV rows, producing the intermediate dataset
   * that the next transform should operate on.
   *
   * Implementation lives in ./transform/applyExisting (extracted during
   * the god-file breakup; behavior identical, unit-tested in isolation).
   *
   * This ensures chained transforms work correctly:
   *   Cast(age→int) → Filter(age > 25) operates on casted integer values.
   */
  public applyExistingTransforms(
    rows: Array<Record<string, unknown>>,
    transforms: unknown[],
  ): Array<Record<string, unknown>> {
    return applyExistingTransformsImpl(rows, transforms);
  }


  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Resolve the dataset backing a pipeline node.
   *
   * Walks: pipeline_nodes → foundry_datasets
   * Returns the dataset row and its column definitions.
   */
  private async resolveNodeDataset(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<{
    dataset: { id: string; file_path: string; status: string };
    sourceColumns: Array<{ name: string; type: string }>;
    existingTransforms: unknown[];
  }> {
    // Find the node and verify ownership
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({
        'pn.id': nodeId,
        'pn.pipeline_id': pipelineId,
        'p.project_id': projectId,
      })
      .select('pn.dataset_id', 'pn.config')
      .first();

    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }

    // For transform nodes, the source dataset may be referenced
    // via config.sourceNodeId (the dataset node it was created from)
    let datasetId = node.dataset_id;

    // Collect transforms from ALL nodes in the chain (in reverse order,
    // so transforms closer to the dataset are applied first).
    // e.g. join → transform → dataset: the transform node's transforms
    // must be collected and applied to the raw dataset data.
    const chainTransformSets: unknown[][] = [];

    // Collect transforms from the starting node itself
    const startConfig = typeof node.config === 'string'
      ? JSON.parse(node.config)
      : (node.config ?? {});
    if (Array.isArray(startConfig.transforms) && startConfig.transforms.length > 0) {
      chainTransformSets.push(startConfig.transforms);
    }

    if (!datasetId) {
      // Recursively walk sourceNodeId chain until we find a node with dataset_id.
      // Supports: join → transform → dataset, or transform → transform → dataset.
      let currentSourceId = startConfig.sourceNodeId as string | undefined;
      const visited = new Set<string>();
      while (currentSourceId && !datasetId && !visited.has(currentSourceId)) {
        visited.add(currentSourceId);
        const sourceNode = await this.knex('pipeline_nodes')
          .where({ id: currentSourceId, pipeline_id: pipelineId })
          .select('dataset_id', 'config')
          .first();
        if (sourceNode?.config) {
          const srcCfg = typeof sourceNode.config === 'string'
            ? JSON.parse(sourceNode.config)
            : (sourceNode.config ?? {});
          // Collect transforms from this intermediate node
          if (Array.isArray(srcCfg.transforms) && srcCfg.transforms.length > 0) {
            chainTransformSets.push(srcCfg.transforms);
          }
        }
        if (sourceNode?.dataset_id) {
          datasetId = sourceNode.dataset_id;
        } else if (sourceNode?.config) {
          const srcCfg = typeof sourceNode.config === 'string'
            ? JSON.parse(sourceNode.config)
            : (sourceNode.config ?? {});
          currentSourceId = srcCfg.sourceNodeId;
        } else {
          break;
        }
      }
    }

    if (!datasetId) {
      throw new AppError(
        'Node has no associated dataset. Ensure the transform node is connected to a dataset node.',
        400,
        'NO_DATASET',
      );
    }

    const dataset = await this.knex('foundry_datasets')
      .where({ id: datasetId })
      .select('id', 'file_path', 'status')
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    if (dataset.status !== 'ready') {
      throw new AppError(
        `Dataset is not ready for transforms. Current status: ${dataset.status}`,
        400,
        'DATASET_NOT_READY',
      );
    }

    // Fetch column definitions (DB columns are column_name, column_type)
    const rawColumns = await this.knex('dataset_columns')
      .where({ dataset_id: datasetId })
      .select('column_name', 'column_type')
      .orderBy('ordinal_position', 'asc');

    let columns = rawColumns.map((c: { column_name: string; column_type: string }) => ({
      name: stripBom(c.column_name),
      type: c.column_type,
    }));

    // Fallback: the upload-time schema scan persisted nothing (failed scan,
    // legacy dataset, status error) — derive the schema from the live data
    // instead of silently returning an empty column list, which previously
    // produced 200 previews with `columns: []` and union/transform nodes that
    // appeared to have "0 columns". Mirrors resolveDatasetColumns in
    // datasets/datasetColumns.ts (the datasets page behaviour) so both
    // surfaces see the same schema. readUploadedPreview never throws: on an
    // unreadable object it returns an empty, well-formed preview.
    if (columns.length === 0 && dataset.file_path && !dataset.file_path.startsWith('iceberg://')) {
      const preview = await readUploadedPreview(dataset.file_path, 50);
      columns = preview.columns.map((c) => ({ name: stripBom(c.name), type: c.type }));
    }

    // Merge all collected transforms in chain order (reverse because we
    // walked from the outermost node inward — transforms closer to the
    // dataset must be applied first).
    const existingTransforms: unknown[] = chainTransformSets.reverse().flat();

    return { dataset, sourceColumns: columns, existingTransforms };
  }

  // =========================================================================
  // Graph-aware preview/execute input resolution (join / union chains)
  // =========================================================================
  //
  // resolveNodeDataset answers "which CSV do the transforms replay over" —
  // the right question for dataset-anchored chains, but the wrong one once a
  // join or union sits in the graph: its sourceNodeId walk lands on the first
  // raw dataset upstream (e.g. a join's LEFT input). Before this helper
  // existed, a transform preview on a 15-column join evaluated against the
  // left CSV's 9 columns, so filters/expressions referencing join-only
  // columns (e.g. `valid_from`) failed validation with "column does not
  // exist" — and worse, filters on left-side columns silently returned
  // un-joined rows.
  //
  // The JOIN design contract (see materializeForDeploy): canvas convention
  // stores transforms on a TRANSFORM node whose `sourceNodeId` is the join
  // node; the join node's own config carries the join spec, not a transforms
  // array. So for graph inputs:
  //   - sourceColumns = the materialised upstream's columns (what the canvas
  //     node card already shows via previewSnapshot),
  //   - existingTransforms = only the edited node's own transforms (the
  //     upstream materialisation already folds in every upstream transform).
  //
  // Note: replay rows come from the upstream node's pinned previewSnapshot
  // when available (consistent with resolveNodeData semantics) and fall back
  // to a live materializeForDeploy recomputation when no snapshot exists yet
  // (join never Applied), so previews work in either state.

  /**
   * Detect whether `nodeId`'s transformed input passes through a join/union.
   * Returns the graph target to materialise and the transforms that belong
   * to the edited node itself — or null for CSV-anchored chains, which must
   * keep the resolveNodeDataset fast path (pin-cache parity).
   */
  private async detectGraphTarget(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<{ targetId: string; ownTransforms: unknown[] } | null> {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.node_type', 'pn.config')
      .first();
    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }
    const cfg = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const ownTransforms: unknown[] = Array.isArray(cfg.transforms) ? cfg.transforms : [];

    // Transforms may also be persisted directly onto a join/union node
    // (e.g. a Filter saved via nodeId of the join itself), so treat the
    // node as its own target and let the caller apply ownTransforms on top.
    if (node.node_type === 'join' || node.node_type === 'union') {
      return { targetId: nodeId, ownTransforms };
    }
    if (node.node_type !== 'transform') {
      return null;
    }

    let cursor = typeof cfg.sourceNodeId === 'string' ? cfg.sourceNodeId : undefined;
    if (!cursor) return null;
    const visited = new Set<string>([nodeId]);
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const src = await this.knex('pipeline_nodes')
        .where({ id: cursor, pipeline_id: pipelineId })
        .select('node_type', 'dataset_id', 'config')
        .first();
      if (!src) return null;
      if (src.node_type === 'join' || src.node_type === 'union') {
        // Materialise the node's IMMEDIATE source; nested joins beneath it
        // are rebuilt recursively by the materialiser itself.
        return { targetId: cfg.sourceNodeId, ownTransforms };
      }
      if (src.node_type === 'dataset' || typeof src.dataset_id === 'string' && src.dataset_id) {
        return null; // dataset-anchored chain — CSV fast path
      }
      const srcCfg = typeof src.config === 'string' ? JSON.parse(src.config) : (src.config ?? {});
      cursor = srcCfg.sourceNodeId as string | undefined;
    }
    return null;
  }

  /** Fetch the materialised input table for a graph target (join/union +
   *  anything downstream of one). Pinned snapshot first; live recompute as
   *  fallback. Rows are capped at the preview cap, matching the CSV path's
   *  PREVIEW_SOURCE_ROW_LIMIT contract that feeds sampleInfo(). */
  private async resolveGraphInput(
    projectId: string,
    pipelineId: string,
    targetId: string,
  ): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
  }> {
    const node = await this.knex('pipeline_nodes')
      .where({ id: targetId, pipeline_id: pipelineId })
      .select('node_type', 'config')
      .first();
    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }
    const cfg = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const snap = cfg.previewSnapshot as
      | { columns?: Array<{ name: string; type: string }>; rows?: Array<Record<string, unknown>> }
      | undefined;
    if (Array.isArray(snap?.columns) && snap.columns.length > 0 && Array.isArray(snap?.rows)) {
      return { columns: snap.columns, rows: snap.rows.slice(0, PREVIEW_SOURCE_ROW_LIMIT) };
    }
    // No snapshot yet (join never Applied) — rebuild live, capped for preview.
    const up = await this.materializeForDeploy(projectId, pipelineId, targetId);
    return { columns: up.columns, rows: up.rows.slice(0, PREVIEW_SOURCE_ROW_LIMIT) };
  }

  /**
   * Preview-time input resolution for ALL single-input transform previews.
   *
   * Drop-in upgrade of the historical pattern used by every preview method:
   *     const { dataset, sourceColumns, existingTransforms } =
   *       await this.resolveNodeDataset(projectId, pipelineId, nodeId);
   *     const rawRows = await this.readCsvRows(dataset.file_path, PREVIEW_SOURCE_ROW_LIMIT);
   * becomes:
   *     const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } =
   *       await this.resolvePreviewInput(projectId, pipelineId, nodeId);
   *
   * dataset is null when the input is graph-materialised (join/union chain)
   * — preview methods must not touch dataset.file_path in that case (they
   * already only used it for the readCsvRows call this helper performs).
   */
  public async resolvePreviewInput(
    projectId: string,
    pipelineId: string,
    nodeId: string,
  ): Promise<{
    dataset: { id: string; file_path: string; status: string } | null;
    sourceColumns: Array<{ name: string; type: string }>;
    existingTransforms: unknown[];
    baseRows: Array<Record<string, unknown>>;
  }> {
    const graph = await this.detectGraphTarget(projectId, pipelineId, nodeId);
    if (graph) {
      const up = await this.resolveGraphInput(projectId, pipelineId, graph.targetId);
      return {
        dataset: null,
        sourceColumns: up.columns,
        existingTransforms: graph.ownTransforms,
        baseRows: up.rows,
      };
    }
    const { dataset, sourceColumns, existingTransforms } =
      await this.resolveNodeDataset(projectId, pipelineId, nodeId);
    const baseRows = await this.readCsvRows(dataset.file_path, PREVIEW_SOURCE_ROW_LIMIT);
    return { dataset, sourceColumns, existingTransforms, baseRows };
  }

  /**
   * Read CSV rows from S3/MinIO.
   *
   * Uses the same streaming CSV parser as DatasetService.getDatasetPreview.
   */
  private async readCsvRows(
    filePath: string,
    limit: number,
  ): Promise<Array<Record<string, string>>> {
    // PB-B6 — honour the pinned-input cache before falling back to a
    // live S3 read. The deploy path seeds this cache with the EXACT
    // rows captured at preview time (via icebergScanAsOf for Iceberg
    // inputs, getObjectStreamPinned for S3-versioned inputs). Without
    // this, a write to the upstream between preview and deploy would
    // leak into the deploy output.
    const pinned = this.pinnedInputRows(filePath);
    if (pinned) {
      return pinned.slice(0, limit);
    }
    const readStream = await getObjectStream(filePath);
    const ext = filePath.toLowerCase();
    const delimiter = ext.endsWith('.tsv') ? '\t' : ',';

    return new Promise<Array<Record<string, string>>>((resolve, reject) => {
      const rows: Array<Record<string, string>> = [];
      let settled = false;

      const parser = parse({
        delimiter,
        // See `src/utils/csvHeader.ts` — the sanitizer guarantees the
        // record keys we read below are 1:1 with physical header cells,
        // even when the source file has duplicate or blank header names.
        columns: (h: string[]) => sanitizeCsvHeader(h, { source: filePath }),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      });

      const settle = () => {
        if (!settled) {
          settled = true;
          resolve(rows);
        }
      };

      parser.on('readable', () => {
        let record: Record<string, string>;
        while ((record = parser.read()) !== null) {
          // Strip BOM from column keys
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(record)) {
            clean[stripBom(k)] = v;
          }
          rows.push(clean);
          if (rows.length >= limit) {
            parser.destroy();
            break;
          }
        }
      });

      parser.on('error', (err) => {
        readStream.destroy();
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      parser.on('end', settle);
      parser.on('close', settle);

      readStream.pipe(parser);
    });
  }

}
