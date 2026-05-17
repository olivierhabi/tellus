import { Knex } from 'knex';
import { parse } from 'csv-parse';
import { AppError } from '../utils/foundryAppError';
import { convertValue } from '../utils/typeConverter';
import { sanitizeCsvHeader } from '../utils/csvHeader';
import { findNearNameMatches } from '../utils/columnNameReconciler';
import { getObjectStream, toDuckDbReadUri } from './storageService';
import {
  chainHashFromNodeConfig,
  fingerprintSchema,
  hashTransformChain,
} from './pipelines/previewSnapshot';
import type {
  CastTargetType,
  CastPreviewInput,
  CastApplyInput,
  FilterPreviewInput,
  FilterApplyInput,
  FilterCondition,
  FilterOperator,
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
  UnionPreviewInput,
  UnionApplyInput,
} from '../types/pipeline';

// ---------------------------------------------------------------------------
// Type mapping: our logical types → typeConverter baseType strings
// ---------------------------------------------------------------------------

/**
 * Maps CastTargetType to the base type string expected by convertValue().
 *
 * Follows Palantir Pipeline Builder Cast (castV2) semantics:
 *   https://www.palantir.com/docs/foundry/pb-functions-expression/castV2/
 *
 *   string    → "string"   (StringType)
 *   integer   → "integer"  (LongType / IntegerType)
 *   numeric   → "double"   (DoubleType)
 *   boolean   → "boolean"  (BooleanType)
 *   date      → "date"     (DateType)
 *   timestamp → "timestamp"(TimestampType)
 */
const CONVERTER_TYPE_MAP: Record<CastTargetType, string> = {
  string: 'string',
  integer: 'integer',
  numeric: 'double',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp',
};

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
/** Strip BOM (U+FEFF) and other zero-width characters from a string. */
function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, '').replace(/\uFEFF/g, '');
}

/**
 * Normalize a column name to lower_snake_case.
 * Mirrors Palantir's normalizeColumnNamesV1 behaviour.
 */
function normalizeColumnName(name: string, removeSpecial: boolean): string {
  let result = stripBom(name).toLowerCase();
  // Replace spaces, hyphens, dots, slashes with underscores
  result = result.replace(/[\s\-./\\]+/g, '_');
  if (removeSpecial) {
    // Strip everything except letters, digits, underscores
    result = result.replace(/[^a-z0-9_]/g, '');
  }
  // Collapse consecutive underscores
  result = result.replace(/_+/g, '_');
  // Trim leading/trailing underscores
  result = result.replace(/^_+|_+$/g, '');
  return result || 'column';
}

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
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId,
      pipelineId,
      nodeId,
    );

    // Prefer priorTransforms sent in the request body (the frontend knows
    // the full panel chain) over the transforms persisted on the node.
    const chainTransforms = input.priorTransforms ?? existingTransforms;

    const sourceCol = stripBom(input.expression);
    const outputCol = stripBom(input.outputColumn ?? sourceCol);
    const converterType = CONVERTER_TYPE_MAP[input.targetType];

    // Validate against effective columns (after prior transforms like Normalize/Rename)
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    if (!effectiveCols.some((c) => stripBom(c.name) === sourceCol)) {
      throw new AppError(
        `Column "${sourceCol}" does not exist. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }

    // Read CSV rows from S3, then replay prior transforms in the chain
    const rawRows = await this.readCsvRows(dataset.file_path, 5000);
    const rows = this.applyExistingTransforms(rawRows, chainTransforms)
      .slice(0, input.limit);

    // Build effective column metadata reflecting any prior Cast transforms
    const effectiveColumns = this.applyExistingTransformColumns(
      sourceColumns,
      chainTransforms,
    );

    // Apply the Cast transform
    let castErrors = 0;
    const transformedRows = rows.map((row) => {
      const rawValue = row[sourceCol];
      let castValue: unknown;

      try {
        castValue = convertValue(rawValue, converterType, { coerce: true });
      } catch {
        // Lenient mode: failed casts become null (matches Palantir behaviour)
        castValue = null;
        castErrors++;
      }

      // Build the output row
      if (outputCol === sourceCol) {
        // Replace in-place
        return { ...row, [outputCol]: castValue };
      }
      // New column — append
      return { ...row, [outputCol]: castValue };
    });

    // Build output column metadata using effective columns (which include
    // type changes from prior Cast transforms in the chain)
    const outputColumns = this.buildOutputColumns(
      effectiveColumns,
      outputCol,
      input.targetType,
    );

    return {
      columns: outputColumns,
      rows: transformedRows,
      rowCount: transformedRows.length,
      castErrors,
      castExpression: `CAST("${sourceCol}" AS ${input.targetType.toUpperCase()})`,
    };
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
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({
        'pn.id': nodeId,
        'pn.pipeline_id': pipelineId,
        'p.project_id': projectId,
      })
      .select('pn.id', 'pn.config')
      .first();

    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }

    const config = typeof node.config === 'string'
      ? JSON.parse(node.config)
      : (node.config ?? {});

    const transforms: unknown[] = Array.isArray(config.transforms)
      ? config.transforms
      : [];

    transforms.push({
      function: 'Cast',
      expression: input.expression,
      targetType: input.targetType,
      outputColumn: input.outputColumn ?? input.expression,
      createdAt: new Date().toISOString(),
    });

    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) })
      .returning('*');

    return updated;
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
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId,
      pipelineId,
      nodeId,
    );

    // Prefer priorTransforms sent in the request body (the frontend knows
    // the full panel chain) over the transforms persisted on the node.
    const chainTransforms = input.priorTransforms ?? existingTransforms;

    // Validate against effective columns (after prior transforms like Normalize)
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const cond of input.conditions) {
      const cleanCol = stripBom(cond.column);
      if (!effectiveCols.some((c) => stripBom(c.name) === cleanCol)) {
        throw new AppError(
          `Column "${cleanCol}" does not exist. Available: ${effectiveCols.map((c) => stripBom(c.name)).join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
      cond.column = cleanCol;
    }

    // Read CSV rows, then replay prior transforms in the chain
    const rawRows = await this.readCsvRows(dataset.file_path, 5000);
    const allRows = this.applyExistingTransforms(rawRows, chainTransforms);

    // Apply filter — convert rows to string for comparison
    const filtered = allRows.filter((row) => {
      const stringRow = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v == null ? '' : String(v)]),
      );
      const results = input.conditions.map((cond) =>
        this.evaluateCondition(stringRow, cond),
      );
      const matches =
        input.match === 'all'
          ? results.every(Boolean)
          : results.some(Boolean);
      return input.mode === 'keep' ? matches : !matches;
    });

    // Apply limit
    const rows = filtered.slice(0, input.limit);

    // Build column metadata that reflects any prior Cast transforms so the
    // output table shows cumulative column types (e.g. Cast→Filter).
    const effectiveColumns = this.applyExistingTransformColumns(
      sourceColumns,
      chainTransforms,
    );

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      rowCount: rows.length,
      totalMatched: filtered.length,
      totalRows: allRows.length,
      filterSummary: `${input.mode === 'keep' ? 'Keep' : 'Remove'} rows where ${input.match} of ${input.conditions.length} condition(s) match`,
    };
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
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({
        'pn.id': nodeId,
        'pn.pipeline_id': pipelineId,
        'p.project_id': projectId,
      })
      .select('pn.id', 'pn.config')
      .first();

    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }

    const config = typeof node.config === 'string'
      ? JSON.parse(node.config)
      : (node.config ?? {});

    const transforms: unknown[] = Array.isArray(config.transforms)
      ? config.transforms
      : [];

    transforms.push({
      function: 'Filter',
      mode: input.mode,
      match: input.match,
      conditions: input.conditions,
      createdAt: new Date().toISOString(),
    });

    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) })
      .returning('*');

    return updated;
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
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId,
      pipelineId,
      nodeId,
    );

    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const colsToDrop = new Set(input.columns.map(stripBom));

    // Validate columns exist
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const col of colsToDrop) {
      if (!effectiveCols.some((c) => stripBom(c.name) === col)) {
        throw new AppError(
          `Column "${col}" does not exist. Available: ${effectiveCols.map((c) => stripBom(c.name)).join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }

    // Read and replay prior transforms
    const rawRows = await this.readCsvRows(dataset.file_path, 5000);
    const chainedRows = this.applyExistingTransforms(rawRows, chainTransforms);

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
      totalRows: chainedRows.length,
      droppedColumns: [...colsToDrop],
    };
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
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({
        'pn.id': nodeId,
        'pn.pipeline_id': pipelineId,
        'p.project_id': projectId,
      })
      .select('pn.id', 'pn.config')
      .first();

    if (!node) {
      throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');
    }

    const config = typeof node.config === 'string'
      ? JSON.parse(node.config)
      : (node.config ?? {});

    const transforms: unknown[] = Array.isArray(config.transforms)
      ? config.transforms
      : [];

    transforms.push({
      function: 'Drop',
      columns: input.columns.map(stripBom),
      createdAt: new Date().toISOString(),
    });

    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) })
      .returning('*');

    return updated;
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
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId, pipelineId, nodeId,
    );

    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);

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
    const rawRows = await this.readCsvRows(dataset.file_path, 5000);
    const chainedRows = this.applyExistingTransforms(rawRows, chainTransforms);

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
      totalRows: chainedRows.length,
      renames: input.renames,
    };
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
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({
        'pn.id': nodeId,
        'pn.pipeline_id': pipelineId,
        'p.project_id': projectId,
      })
      .select('pn.id', 'pn.config')
      .first();

    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string'
      ? JSON.parse(node.config) : (node.config ?? {});

    const transforms: unknown[] = Array.isArray(config.transforms) ? config.transforms : [];
    transforms.push({
      function: 'Rename',
      renames: input.renames.map((r) => ({ from: stripBom(r.from), to: r.to })),
      createdAt: new Date().toISOString(),
    });
    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) })
      .returning('*');

    return updated;
  }

  // =========================================================================
  // Normalize Column Names — Preview
  // =========================================================================

  async normalizePreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: NormalizePreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);

    // Build normalize map { oldName → newName }
    const normalizeMap = new Map<string, string>();
    const usedNames = new Set<string>();
    for (const col of effectiveCols) {
      let newName = normalizeColumnName(col.name, input.removeSpecialCharacters);
      // Handle duplicates by appending _1, _2, etc.
      if (usedNames.has(newName)) {
        let i = 1;
        while (usedNames.has(`${newName}_${i}`)) i++;
        newName = `${newName}_${i}`;
      }
      usedNames.add(newName);
      normalizeMap.set(stripBom(col.name), newName);
    }

    // Read and replay prior transforms
    const rawRows = await this.readCsvRows(dataset.file_path, 5000);
    const chainedRows = this.applyExistingTransforms(rawRows, chainTransforms);

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
      totalRows: chainedRows.length,
      removeSpecialCharacters: input.removeSpecialCharacters,
    };
  }

  // =========================================================================
  // Normalize Column Names — Apply
  // =========================================================================

  async normalizeApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: NormalizeApplyInput,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const transforms: unknown[] = Array.isArray(config.transforms) ? config.transforms : [];
    transforms.push({
      function: 'Normalize',
      removeSpecialCharacters: input.removeSpecialCharacters,
      createdAt: new Date().toISOString(),
    });
    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
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
    // Collect non-fatal warnings to return alongside results
    const warnings: Array<{ code: string; message: string }> = [];

    // ── Resolve left dataset ────────────────────────────────────────
    const { dataset: leftDataset, sourceColumns: leftCols, existingTransforms } =
      await this.resolveNodeDataset(projectId, pipelineId, nodeId);

    // ── Resolve right dataset ───────────────────────────────────────
    const rightNode = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': input.rightNodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.dataset_id', 'pn.config').first();

    if (!rightNode) {
      throw new AppError('Right input node not found. It may have been deleted.', 404, 'RIGHT_NODE_NOT_FOUND');
    }

    // Prevent self-join
    if (rightNode.id === nodeId) {
      throw new AppError('Cannot join a node with itself. Select a different right input.', 400, 'SELF_JOIN');
    }

    let rightDatasetId = rightNode.dataset_id;
    if (!rightDatasetId) {
      const cfg = typeof rightNode.config === 'string' ? JSON.parse(rightNode.config) : (rightNode.config ?? {});
      if (cfg.sourceNodeId) {
        const src = await this.knex('pipeline_nodes').where({ id: cfg.sourceNodeId, pipeline_id: pipelineId }).select('dataset_id').first();
        rightDatasetId = src?.dataset_id;
      }
    }
    if (!rightDatasetId) {
      throw new AppError('Right input has no associated dataset. Ensure it is connected to a dataset node.', 400, 'RIGHT_NO_DATASET');
    }

    const rightDataset = await this.knex('foundry_datasets').where({ id: rightDatasetId }).select('id', 'file_path', 'status').first();
    if (!rightDataset) {
      throw new AppError('Right dataset not found. It may have been deleted.', 404, 'RIGHT_DATASET_NOT_FOUND');
    }
    if (rightDataset.status !== 'ready') {
      throw new AppError(`Right dataset is not ready (status: ${rightDataset.status}). Wait for ingestion to complete.`, 400, 'RIGHT_DATASET_NOT_READY');
    }
    if (!rightDataset.file_path) {
      throw new AppError('Right dataset has no data file. Re-upload or re-ingest the dataset.', 400, 'RIGHT_NO_DATA');
    }

    const rightColsRaw = await this.knex('dataset_columns').where({ dataset_id: rightDatasetId }).select('column_name', 'column_type').orderBy('ordinal_position', 'asc');
    const rightCols = rightColsRaw.map((c: { column_name: string; column_type: string }) => ({ name: stripBom(c.column_name), type: c.column_type }));

    if (rightCols.length === 0) {
      throw new AppError('Right dataset has no columns. Re-upload or re-ingest the dataset.', 400, 'RIGHT_NO_COLUMNS');
    }

    // ── Read data ───────────────────────────────────────────────────
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const leftRaw = await this.readCsvRows(leftDataset.file_path, 5000);
    const leftRows = this.applyExistingTransforms(leftRaw, chainTransforms);
    const rightRows = await this.readCsvRows(rightDataset.file_path, 5000);

    if (leftRows.length === 0) {
      throw new AppError('Left input contains no rows. Apply transforms or check the source dataset.', 400, 'LEFT_EMPTY');
    }
    if (rightRows.length === 0) {
      throw new AppError('Right input contains no rows. Check the source dataset.', 400, 'RIGHT_EMPTY');
    }

    const effectiveLeftCols = this.applyExistingTransformColumns(leftCols, chainTransforms);

    // ── Validate conditions ─────────────────────────────────────────
    if (input.joinType !== 'cross' && input.conditions.length === 0) {
      throw new AppError('At least one join condition is required for non-cross joins. Add a match condition.', 400, 'NO_CONDITIONS');
    }

    for (const cond of input.conditions) {
      const leftCol = effectiveLeftCols.find((c) => stripBom(c.name) === stripBom(cond.leftColumn));
      const rightCol = rightCols.find((c) => stripBom(c.name) === stripBom(cond.rightColumn));

      if (!leftCol) {
        throw new AppError(
          `Left column "${cond.leftColumn}" not found. Available columns: ${effectiveLeftCols.map((c) => c.name).join(', ')}`,
          400, 'LEFT_COLUMN_NOT_FOUND',
        );
      }
      if (!rightCol) {
        throw new AppError(
          `Right column "${cond.rightColumn}" not found. Available columns: ${rightCols.map((c) => c.name).join(', ')}`,
          400, 'RIGHT_COLUMN_NOT_FOUND',
        );
      }

      // Type mismatch warning (non-fatal — strings are compared via String())
      if (leftCol.type !== rightCol.type) {
        warnings.push({
          code: 'TYPE_MISMATCH',
          message: `Join columns have different types: "${cond.leftColumn}" (${leftCol.type}) vs "${cond.rightColumn}" (${rightCol.type}). Values are compared as text, which may produce unexpected matches.`,
        });
      }
    }

    const rightPrefix = input.rightPrefix ?? 'right_';

    // ── Execute join ──────────────────────────────────────────────────
    const joinedRows = this.executeJoin(leftRows, rightRows, input.joinType, input.conditions, effectiveLeftCols, rightCols, rightPrefix);
    const rows = joinedRows.slice(0, input.limit);

    // Warn about zero matches
    if (joinedRows.length === 0 && input.joinType === 'inner') {
      warnings.push({
        code: 'ZERO_MATCHES',
        message: `Inner join produced 0 rows. No matching values were found between the join columns. Verify the match condition columns contain overlapping values.`,
      });
    } else if (input.joinType !== 'cross') {
      // Check for high null rate on join keys
      for (const cond of input.conditions) {
        const leftNulls = leftRows.filter((r) => {
          const v = r[stripBom(cond.leftColumn)]; return v === null || v === undefined || v === '' || String(v).toLowerCase() === 'null';
        }).length;
        const rightNulls = rightRows.filter((r) => {
          const v = r[stripBom(cond.rightColumn)]; return v === null || v === undefined || v === '' || String(v).toLowerCase() === 'null';
        }).length;
        const leftPct = Math.round((leftNulls / leftRows.length) * 100);
        const rightPct = Math.round((rightNulls / rightRows.length) * 100);
        if (leftPct > 20) {
          warnings.push({ code: 'HIGH_NULL_RATE', message: `${leftPct}% of left rows have null/empty "${cond.leftColumn}". These rows will not match per join semantics (null ≠ null).` });
        }
        if (rightPct > 20) {
          warnings.push({ code: 'HIGH_NULL_RATE', message: `${rightPct}% of right rows have null/empty "${cond.rightColumn}". These rows will not match per join semantics (null ≠ null).` });
        }
      }

      // Warn about Cartesian explosion
      if (joinedRows.length > leftRows.length * 3 && joinedRows.length > 1000) {
        warnings.push({
          code: 'CARTESIAN_EXPLOSION',
          message: `Join produced ${joinedRows.length.toLocaleString()} rows from ${leftRows.length.toLocaleString()} left × ${rightRows.length.toLocaleString()} right. This may indicate non-unique join keys causing row duplication.`,
        });
      }
    }

    // Filter columns based on user selection (if provided)
    const leftSelectedSet = input.leftSelectedColumns
      ? new Set(input.leftSelectedColumns.map((n) => stripBom(n)))
      : null;
    const rightSelectedSet = input.rightSelectedColumns
      ? new Set(input.rightSelectedColumns.map((n) => stripBom(n)))
      : null;

    const filteredLeftCols = leftSelectedSet
      ? effectiveLeftCols.filter((c) => leftSelectedSet.has(c.name))
      : effectiveLeftCols;
    const filteredRightCols = rightSelectedSet
      ? rightCols.filter((c) => rightSelectedSet.has(c.name))
      : rightCols;

    // Build output columns: left columns + right columns (prefixed if collision)
    const leftNames = new Set(filteredLeftCols.map((c) => c.name));
    const outputCols = [
      ...filteredLeftCols.map((c) => ({ name: c.name, type: c.type, source: 'left' as const })),
      ...filteredRightCols.map((c) => ({
        name: leftNames.has(c.name) ? `${rightPrefix}${c.name}` : c.name,
        type: c.type,
        source: 'right' as const,
      })),
    ];

    // Strip deselected columns from rows
    const outputColNames = new Set(outputCols.map((c) => c.name));
    const filteredRows = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const colName of outputColNames) {
        if (colName in row) out[colName] = row[colName];
      }
      return out;
    });

    return {
      columns: outputCols,
      rows: filteredRows,
      rowCount: filteredRows.length,
      totalJoined: joinedRows.length,
      leftRowCount: leftRows.length,
      rightRowCount: rightRows.length,
      joinType: input.joinType,
      warnings,
    };
  }

  // =========================================================================
  // Join — Apply (persist config)
  // =========================================================================

  async joinApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: JoinApplyInput,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    const transforms: unknown[] = Array.isArray(config.transforms) ? config.transforms : [];
    transforms.push({
      function: 'Join',
      rightNodeId: input.rightNodeId,
      joinType: input.joinType,
      conditions: input.conditions,
      createdAt: new Date().toISOString(),
    });
    config.transforms = transforms;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
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
  private async resolveNodeData(
    projectId: string, pipelineId: string, nodeId: string,
    priorTransforms?: unknown[],
    /** Internal guard: detect sourceNodeId cycles in malformed graphs. */
    _visited: Set<string> = new Set<string>(),
  ): Promise<{ columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>> }> {
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
    const raw = await this.readCsvRows(dataset.file_path, 5000);
    const rows = this.applyExistingTransforms(raw, transforms);
    const columns = this.applyExistingTransformColumns(sourceColumns, transforms);
    return { columns, rows };
  }

  // ── Output node preview ──────────────────────────────────────────────────
  // Resolves the fully-transformed data from the upstream chain for an output
  // node. Walks sourceNodeId → collects transforms → reads CSV → applies them.
  // Returns the same shape as transform/join/union previews.

  async outputPreview(
    projectId: string, pipelineId: string, nodeId: string,
    limit = 500,
  ): Promise<{ columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>>; totalRows: number }> {
    const data = await this.resolveNodeData(projectId, pipelineId, nodeId);
    const totalRows = data.rows.length;
    const rows = data.rows.slice(0, limit);
    return { columns: data.columns, rows, totalRows };
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
              conditions?: Array<{ leftColumn: string; rightColumn: string }>;
              rightNodeId?: string;
              rightPrefix?: string;
            }
          | undefined;
        const joinType =
          ((cfg.joinType ?? joinStep?.joinType) as JoinType | undefined);
        const conditions = (cfg.conditions ?? joinStep?.conditions) as
          | Array<{ leftColumn: string; rightColumn: string }>
          | undefined;
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
        if (!joinType || !Array.isArray(conditions) || conditions.length === 0) {
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
        const columns: Array<{ name: string; type: string }> = [
          ...filteredLeftCols,
          ...filteredRightCols.map((c) => ({
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
        const rightSrc = cfg.rightNodeId as string | undefined;
        if (!leftSrc || !rightSrc) {
          throw new AppError(
            `Union node ${nodeId} requires both sourceNodeId and rightNodeId.`,
            400,
            'UNION_UNWIRED',
          );
        }
        const left = await this.materializeForDeploy(
          projectId, pipelineId, leftSrc, new Set<string>(_visited),
        );
        const right = await this.materializeForDeploy(
          projectId, pipelineId, rightSrc, new Set<string>(_visited),
        );
        // Union-by-name (canvas default): output columns = unique union
        // with left ordering preserved; rows from each side are rebased
        // onto the unified column set with null-fill for missing names.
        const seen = new Set<string>();
        const columns: Array<{ name: string; type: string }> = [];
        for (const c of left.columns) {
          if (!seen.has(c.name)) { seen.add(c.name); columns.push(c); }
        }
        for (const c of right.columns) {
          if (!seen.has(c.name)) { seen.add(c.name); columns.push(c); }
        }
        const colNames = columns.map((c) => c.name);
        const rebase = (
          r: Record<string, unknown>,
        ): Record<string, unknown> => {
          const out: Record<string, unknown> = {};
          for (const c of colNames) out[c] = (c in r) ? r[c] : null;
          return out;
        };
        const rows = [
          ...left.rows.map(rebase),
          ...right.rows.map(rebase),
        ];
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
    const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
    const mode = input.mode ?? 'name-merge';

    // ── Resolve left and right data (uses snapshot if available) ──
    const left = await this.resolveNodeData(projectId, pipelineId, nodeId, input.priorTransforms);
    const right = await this.resolveNodeData(projectId, pipelineId, input.rightNodeId);

    const effectiveLeftCols = left.columns;
    const leftRows = left.rows;
    const effectiveRightCols = right.columns;
    const rightRows = right.rows;

    if (leftRows.length === 0 && rightRows.length === 0) {
      throw new AppError('Both inputs contain no rows.', 400, 'BOTH_EMPTY');
    }

    // ── Union by name: merge columns ────────────────────────────
    // Output columns = union of all column names from both sides.
    // Columns present in both keep the left type. Columns unique to
    // one side get null for rows from the other.
    const leftColMap = new Map(effectiveLeftCols.map((c) => [c.name, c.type]));
    const rightColMap = new Map(effectiveRightCols.map((c) => [c.name, c.type]));

    const outputColNames: string[] = [];
    const outputCols: Array<{ name: string; type: string; source: string }> = [];
    const seen = new Set<string>();

    // Left columns first (preserves left ordering)
    for (const c of effectiveLeftCols) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        outputColNames.push(c.name);
        const rightType = rightColMap.get(c.name);
        const source = rightType ? 'both' : 'left';
        outputCols.push({ name: c.name, type: c.type, source });
        if (rightType && rightType !== c.type) {
          warnings.push({
            code: 'TYPE_MISMATCH',
            message: `Column "${c.name}" has type "${c.type}" in left and "${rightType}" in right. Values are cast to text.`,
          });
        }
      }
    }
    // Right-only columns
    for (const c of effectiveRightCols) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        outputColNames.push(c.name);
        outputCols.push({ name: c.name, type: c.type, source: 'right' });
      }
    }

    // Warn about columns unique to one side
    const leftOnly = effectiveLeftCols.filter((c) => !rightColMap.has(c.name)).map((c) => c.name);
    const rightOnly = effectiveRightCols.filter((c) => !leftColMap.has(c.name)).map((c) => c.name);
    if (leftOnly.length > 0) {
      warnings.push({
        code: 'LEFT_ONLY_COLUMNS',
        message: `${leftOnly.length} column${leftOnly.length > 1 ? 's' : ''} only in left: ${leftOnly.join(', ')}. Right rows will have null for these.`,
        details: { columns: leftOnly },
      });
    }
    if (rightOnly.length > 0) {
      warnings.push({
        code: 'RIGHT_ONLY_COLUMNS',
        message: `${rightOnly.length} column${rightOnly.length > 1 ? 's' : ''} only in right: ${rightOnly.join(', ')}. Left rows will have null for these.`,
        details: { columns: rightOnly },
      });
    }

    // ── Near-name detection ────────────────────────────────────
    // Two 11-column inputs that diverged on a rename (e.g.
    // `order_id` → `orderid`) silently widen to 12 columns under
    // union-by-name. Surface those pairs so the UI can offer a
    // one-click rename and keep the schema stable downstream.
    const nameMismatches = findNearNameMatches(leftOnly, rightOnly);
    if (nameMismatches.length > 0) {
      const preview = nameMismatches
        .slice(0, 3)
        .map((m) => `"${m.left}" ↔ "${m.right}"`)
        .join(', ');
      const more = nameMismatches.length > 3 ? ` (+${nameMismatches.length - 3} more)` : '';
      warnings.push({
        code: 'NAME_MISMATCH_SUGGESTION',
        message:
          `${nameMismatches.length} column pair${nameMismatches.length > 1 ? 's' : ''} ` +
          `look like the same column under different names: ${preview}${more}. ` +
          `Rename one side to align the schema and avoid widening the union.`,
        details: { suggestedRenames: nameMismatches },
      });
    }

    // ── Strict mode: fail fast on any schema divergence ────────
    // Pipelines that promise a stable output schema (deploy graph
    // fingerprinting, Iceberg writers, ontology object types) opt
    // into strict mode rather than silently widening.
    if (mode === 'strict' && (leftOnly.length > 0 || rightOnly.length > 0)) {
      const err = new AppError(
        'Union in strict mode requires identical column sets on both inputs. ' +
          (leftOnly.length > 0 ? `Left-only: ${leftOnly.join(', ')}. ` : '') +
          (rightOnly.length > 0 ? `Right-only: ${rightOnly.join(', ')}.` : ''),
        400,
        'UNION_SCHEMA_MISMATCH',
      );
      (err as AppError & { details?: unknown }).details = {
        leftOnly,
        rightOnly,
        suggestedRenames: nameMismatches,
      };
      throw err;
    }

    // ── Build unified rows ──────────────────────────────────────
    const unifiedRows: Array<Record<string, unknown>> = [];

    for (const row of leftRows) {
      const out: Record<string, unknown> = {};
      for (const col of outputColNames) {
        out[col] = col in row ? row[col] : null;
      }
      unifiedRows.push(out);
    }
    for (const row of rightRows) {
      const out: Record<string, unknown> = {};
      for (const col of outputColNames) {
        out[col] = col in row ? row[col] : null;
      }
      unifiedRows.push(out);
    }

    const rows = unifiedRows.slice(0, input.limit);

    return {
      columns: outputCols,
      rows,
      rowCount: rows.length,
      totalUnioned: unifiedRows.length,
      leftRowCount: leftRows.length,
      rightRowCount: rightRows.length,
      warnings,
    };
  }

  // =========================================================================
  // Union by name — Apply (persist config)
  // =========================================================================

  async unionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnionApplyInput,
  ) {
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    config.rightNodeId = input.rightNodeId;

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
  }

  // =========================================================================
  // Private: Join execution engine
  // =========================================================================

  private executeJoin(
    leftRows: Array<Record<string, unknown>>,
    rightRows: Array<Record<string, unknown>>,
    joinType: JoinType,
    conditions: Array<{ leftColumn: string; rightColumn: string }>,
    leftCols: Array<{ name: string; type: string }>,
    rightCols: Array<{ name: string; type: string }>,
    rightPrefix = 'right_',
  ): Array<Record<string, unknown>> {
    const leftNames = new Set(leftCols.map((c) => c.name));
    const result: Array<Record<string, unknown>> = [];

    // Helper: merge a left row with a right row, prefixing right columns if collision
    const mergeRow = (
      left: Record<string, unknown> | null,
      right: Record<string, unknown> | null,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      if (left) { for (const [k, v] of Object.entries(left)) out[k] = v; }
      else { for (const c of leftCols) out[c.name] = null; }
      if (right) {
        for (const [k, v] of Object.entries(right)) {
          const key = leftNames.has(stripBom(k)) ? `${rightPrefix}${k}` : k;
          out[key] = v;
        }
      } else {
        for (const c of rightCols) {
          const key = leftNames.has(c.name) ? `${rightPrefix}${c.name}` : c.name;
          out[key] = null;
        }
      }
      return out;
    };

    // Helper: check if a left row matches a right row on all conditions.
    // Per Palantir spec: null ≠ null — if either side is null/empty, no match.
    const isNullish = (v: unknown): boolean =>
      v === undefined || v === null || v === '' || String(v).toLowerCase() === 'null';

    const matches = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
      return conditions.every((c) => {
        const lv = left[stripBom(c.leftColumn)];
        const rv = right[stripBom(c.rightColumn)];
        if (isNullish(lv) || isNullish(rv)) return false;
        return String(lv) === String(rv);
      });
    };

    if (joinType === 'cross') {
      for (const l of leftRows) {
        for (const r of rightRows) {
          result.push(mergeRow(l, r));
          if (result.length >= 5000) return result;
        }
      }
      return result;
    }

    if (joinType === 'inner') {
      for (const l of leftRows) {
        for (const r of rightRows) {
          if (matches(l, r)) result.push(mergeRow(l, r));
        }
      }
      return result;
    }

    if (joinType === 'left') {
      for (const l of leftRows) {
        let matched = false;
        for (const r of rightRows) {
          if (matches(l, r)) { result.push(mergeRow(l, r)); matched = true; }
        }
        if (!matched) result.push(mergeRow(l, null));
      }
      return result;
    }

    if (joinType === 'right') {
      for (const r of rightRows) {
        let matched = false;
        for (const l of leftRows) {
          if (matches(l, r)) { result.push(mergeRow(l, r)); matched = true; }
        }
        if (!matched) result.push(mergeRow(null, r));
      }
      return result;
    }

    // full_outer
    const rightMatched = new Set<number>();
    for (const l of leftRows) {
      let matched = false;
      for (let ri = 0; ri < rightRows.length; ri++) {
        if (matches(l, rightRows[ri])) {
          result.push(mergeRow(l, rightRows[ri]));
          rightMatched.add(ri);
          matched = true;
        }
      }
      if (!matched) result.push(mergeRow(l, null));
    }
    for (let ri = 0; ri < rightRows.length; ri++) {
      if (!rightMatched.has(ri)) result.push(mergeRow(null, rightRows[ri]));
    }
    return result;
  }

  // =========================================================================
  // Execute Full Chain — runs ALL saved transforms on ALL data
  // =========================================================================

  /**
   * Execute the entire transform chain saved on a node against the full
   * source dataset. This is called when the user clicks "Apply All".
   *
   * Returns the complete transformed dataset (all rows, all columns after
   * transforms). The frontend saves this as the preview snapshot.
   */
  async executeChain(
    projectId: string, pipelineId: string, nodeId: string,
  ) {
    const { dataset, sourceColumns, existingTransforms } = await this.resolveNodeDataset(
      projectId, pipelineId, nodeId,
    );

    if (existingTransforms.length === 0) {
      // No transforms — return raw data
      const rawRows = await this.readCsvRows(dataset.file_path, 10000);
      return {
        columns: sourceColumns.map((c) => ({ name: c.name, type: c.type })),
        rows: rawRows,
        rowCount: rawRows.length,
        transformCount: 0,
      };
    }

    // PB-B2 engine selector — reads pipelines.compute_type.
    //   'duckdb'        → compile chain into one SQL statement and run
    //                     via the shared DuckDB pool (default for new
    //                     pipelines).
    //   'legacy_nodejs' → the pure-TS engine below (kept for one release
    //                     cycle so existing pipelines keep green).
    //
    // Chains containing `Normalize` fall back to legacy automatically
    // because Normalize requires the legacy engine's unicode folding
    // until PB-B2.follow-2 ships the Rust UDF — instead of compiling a
    // broken SQL statement we route around it so the user's request
    // still completes with matching semantics.
    const computeType = await this.getComputeType(pipelineId);
    const hasNormalize = existingTransforms.some(
      (t) => (t as { function?: string })?.function === 'Normalize',
    );
    if (computeType === 'duckdb' && !hasNormalize) {
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
          { inputPath: inputUri, limit: 10_000 },
        );
        return {
          columns: out.columns,
          rows: out.rows,
          rowCount: out.rowCount,
          transformCount: existingTransforms.length,
          engine: 'duckdb' as const,
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
        // Anything else bubbles as 500 — let the global error handler
        // log it with the request id for follow-up.
        throw err;
      }
    }

    // Legacy TS engine path.
    const rawRows = await this.readCsvRows(dataset.file_path, 10000);
    const transformedRows = this.applyExistingTransforms(rawRows, existingTransforms);
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, existingTransforms);

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows: transformedRows,
      rowCount: transformedRows.length,
      transformCount: existingTransforms.length,
      engine: 'legacy_nodejs' as const,
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
  private async walkTransitiveInputs(
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
  private applyExistingTransformColumns(
    sourceColumns: Array<{ name: string; type: string }>,
    transforms: unknown[],
  ): Array<{ name: string; type: string }> {
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
    }

    return cols;
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
  private applyExistingTransforms(
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

        result = result.map((row) => {
          const rawValue = row[expr];
          let castValue: unknown;
          try {
            castValue = convertValue(rawValue, converterType, { coerce: true });
          } catch {
            castValue = null;
          }
          return { ...row, [outputCol]: castValue };
        });
      } else if (fn === 'Filter') {
        const mode = (tx.mode ?? 'keep') as string;
        const match = (tx.match ?? 'all') as string;
        const conditions = (tx.conditions ?? []) as FilterCondition[];

        result = result.filter((row) => {
          const stringRow = Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v == null ? '' : String(v)]),
          );
          const results = conditions.map((cond) =>
            this.evaluateCondition(stringRow, cond),
          );
          const matches = match === 'all'
            ? results.every(Boolean)
            : results.some(Boolean);
          return mode === 'keep' ? matches : !matches;
        });
      } else if (fn === 'Drop') {
        const dropCols = new Set(
          ((tx.columns ?? []) as string[]).map(stripBom),
        );
        result = result.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!dropCols.has(stripBom(k))) out[k] = v;
          }
          return out;
        });
      } else if (fn === 'Rename') {
        const renames = (tx.renames ?? []) as Array<{ from: string; to: string }>;
        const map = new Map(renames.map((r) => [stripBom(r.from), r.to]));
        result = result.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            out[map.get(stripBom(k)) ?? k] = v;
          }
          return out;
        });
      } else if (fn === 'Normalize') {
        const removeSpecial = (tx.removeSpecialCharacters ?? false) as boolean;
        // Build normalize map from current row keys
        if (result.length > 0) {
          const keys = Object.keys(result[0]);
          const usedNames = new Set<string>();
          const nMap = new Map<string, string>();
          for (const k of keys) {
            let newName = normalizeColumnName(k, removeSpecial);
            if (usedNames.has(newName)) { let i = 1; while (usedNames.has(`${newName}_${i}`)) i++; newName = `${newName}_${i}`; }
            usedNames.add(newName);
            nMap.set(k, newName);
          }
          result = result.map((row) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) { out[nMap.get(k) ?? k] = v; }
            return out;
          });
        }
      }
    }

    return result;
  }

  // =========================================================================
  // Private: condition evaluator
  // =========================================================================

  /**
   * Evaluate a single filter condition against a row.
   *
   * All comparisons are string-based since CSV data is strings.
   * Null = undefined, empty string, or literal "null"/"NULL".
   */
  private evaluateCondition(
    row: Record<string, string>,
    cond: FilterCondition,
  ): boolean {
    const raw = row[cond.column];

    // In CSV, null = undefined, empty string, or literal "null"/"NULL"
    const isNullValue =
      raw === undefined ||
      raw === null ||
      raw === '' ||
      raw.toLowerCase() === 'null';

    // For is_not_null: treatEmptyAsNull controls whether "" counts as null.
    // When false (default), only undefined/null/"null" are null — "" is a value.
    // When true, "" is also treated as null.
    const treatEmpty = cond.treatEmptyAsNull ?? false;
    const isNotNullEffective = treatEmpty
      ? !isNullValue
      : !(raw === undefined || raw === null || raw.toLowerCase() === 'null');

    const op = cond.operator as FilterOperator;

    switch (op) {
      case 'is_null':
        // is_null always treats empty string as null (CSV semantics)
        return isNullValue;

      case 'is_not_null':
        return isNotNullEffective;

      case 'eq':
        return !isNullValue && raw === (cond.value ?? '');

      case 'neq':
        return isNullValue || raw !== (cond.value ?? '');

      case 'starts_with':
        return !isNullValue && raw.startsWith(cond.value ?? '');

      case 'ends_with':
        return !isNullValue && raw.endsWith(cond.value ?? '');

      case 'contains':
        return !isNullValue && raw.includes(cond.value ?? '');

      case 'regex_find': {
        if (isNullValue || !cond.value) return false;
        try {
          return new RegExp(cond.value).test(raw);
        } catch {
          return false;
        }
      }

      case 'regex_match': {
        if (isNullValue || !cond.value) return false;
        try {
          const re = new RegExp(`^${cond.value}$`);
          return re.test(raw);
        } catch {
          return false;
        }
      }

      default:
        return true;
    }
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

    const columns = rawColumns.map((c: { column_name: string; column_type: string }) => ({
      name: stripBom(c.column_name),
      type: c.column_type,
    }));

    // Merge all collected transforms in chain order (reverse because we
    // walked from the outermost node inward — transforms closer to the
    // dataset must be applied first).
    const existingTransforms: unknown[] = chainTransformSets.reverse().flat();

    return { dataset, sourceColumns: columns, existingTransforms };
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

  /**
   * Build output column metadata.
   *
   * If the output column replaces an existing one, its type is updated.
   * If it's a new column, it's appended with isNew: true.
   */
  private buildOutputColumns(
    sourceColumns: Array<{ name: string; type: string }>,
    outputCol: string,
    targetType: CastTargetType,
  ): Array<{ name: string; type: string; isNew: boolean }> {
    const existing = sourceColumns.map((c) => ({
      name: c.name,
      type: c.type,
      isNew: false,
    }));

    const alreadyExists = sourceColumns.some((c) => c.name === outputCol);

    if (alreadyExists) {
      return existing.map((c) =>
        c.name === outputCol ? { ...c, type: targetType, isNew: false } : c,
      );
    }

    return [...existing, { name: outputCol, type: targetType, isNew: true }];
  }
}
