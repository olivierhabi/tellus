import { Knex } from 'knex';
import { parse } from 'csv-parse';
import { AppError } from '../utils/foundryAppError';
import { convertValue, inferDateFormat } from '../utils/typeConverter';
import { sanitizeCsvHeader } from '../utils/csvHeader';
import { findNearNameMatches, unionSideLabels } from '../utils/columnNameReconciler';
import { getObjectStream, toDuckDbReadUri } from './storageService';
import { readUploadedPreview } from './datasets/uploaded-dataset-reader';
import { validateUdfSpec } from './pipelines/udfTransform';
import { runUdfTransform } from './pipelines/udfRunner';
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
  Operand,
  BinaryOperator,
  ExpressionItem,
  StringOperand,
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
// Binary-expression evaluator (legacy TS engine). Applies the same small DSL
// used by ApplyExpression / Apply Multiple Expressions / Apply to Multiple
// Columns / Compute if Expression Absent. The SQL compilers translate the
// same DSL to native operators.
//
// Operator semantics:
//   + - * /   numeric arithmetic; operands coerced to Number.
//   ||        string concatenation.
//   == !=     equality (string or numeric, by inferred type).
//   > < >= <= ordered comparison (numeric when both look like numbers, else
//             lexicographic).
//
// All comparisons return boolean true/false. Arithmetic returns numbers,
// or null when either operand is null/absent. Concat returns string. Cast to
// `outputType` (when requested) is applied via convertValue after the eval.
// ---------------------------------------------------------------------------

function coerceNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerceString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function parseLiteral(op: Operand): unknown {
  // kind === 'literal'
  if (op.kind !== 'literal') return op.value;
  const t = op.literalType ?? 'string';
  switch (t) {
    case 'integer': {
      const n = parseInt(op.value, 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'numeric': {
      const n = parseFloat(op.value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return op.value === 'true';
    case 'string':
    default:
      return op.value;
  }
}

/**
 * Evaluate one binary expression per row. Left/right operands are
 * resolved to row values (kind=column) or to literals (kind=literal).
 */
function evaluateExpression(
  row: Record<string, unknown>,
  expr: Pick<ExpressionItem, 'left' | 'operator' | 'right'>,
): unknown {
  const left = expr.left.kind === 'column' ? row[expr.left.value] : parseLiteral(expr.left);
  const right = expr.right.kind === 'column' ? row[expr.right.value] : parseLiteral(expr.right);
  const op = expr.operator as BinaryOperator;

  // Null propagation for arithmetic / concat.
  if (
    (op === '+' || op === '-' || op === '*' || op === '/') &&
    (left === null || left === undefined || right === null || right === undefined)
  ) {
    return null;
  }

  switch (op) {
    case '+': return (coerceNumeric(left) ?? 0) + (coerceNumeric(right) ?? 0);
    case '-': return (coerceNumeric(left) ?? 0) - (coerceNumeric(right) ?? 0);
    case '*': return (coerceNumeric(left) ?? 0) * (coerceNumeric(right) ?? 0);
    case '/': {
      const r = coerceNumeric(right);
      if (r === null || r === 0) return null;
      return (coerceNumeric(left) ?? 0) / r;
    }
    case '||':
      return coerceString(left) + coerceString(right);
    case '==':
      return compareEq(left, right);
    case '!=':
      return !compareEq(left, right);
    case '>': return compareOrd(left, right) > 0;
    case '<': return compareOrd(left, right) < 0;
    case '>=': return compareOrd(left, right) >= 0;
    case '<=': return compareOrd(left, right) <= 0;
    default:
      return null;
  }
}


/**
 * Palantir formatStringV1 (https://www.palantir.com/docs/foundry/pb-functions-expression/formatStringV1):
 * "Formats string printf style."
 *
 * Supported subset of Java's Formatter mini-language:
 *   %[flags][width][.precision]conversion
 * conversions: s/S d x/X e/E f g/G %% %n
 * flags: '-'  left-justify, '+'  force sign, '0' zero-pad, space pad-positive
 *
 * Behaviours beyond the doc examples that are pinned here:
 *  - null/undefined arguments format as the literal text "null" (Example 4
 *    in the docs);
 *  - MORE %conversions than arguments → the missing argument formats as
 *    "null" (lenient; Java would throw — a template with a typo must not
 *    kill a preview);
 *  - FEWER %conversions than arguments → extra arguments are ignored;
 *  - %% → "%", %n → newline, unknown conversions are copied verbatim.
 * %s precision truncates the text (Java semantics).
 */
export function formatStringValue(format: string, args: unknown[]): string {
  let argIndex = 0;
  return format.replace(
    /%([-+ 0]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g,
    (_m: string, flags: string, widthStr: string | undefined, precStr: string | undefined, conv: string): string => {
      if (conv === '%') return '%';
      if (conv === 'n') return '\n';
      const width = widthStr ? parseInt(widthStr, 10) : 0;
      const precision = precStr !== undefined ? parseInt(precStr, 10) : undefined;
      const raw = argIndex < args.length ? args[argIndex++] : null;

      const c = conv.toLowerCase();
      let text: string;
      if (raw === null || raw === undefined) {
        text = 'null';
      } else if (c === 's') {
        text = String(raw);
        if (precision !== undefined) text = text.slice(0, precision);
        // Uppercase %S uppercases the VALUE (after truncation)
        if (conv === 'S') text = text.toUpperCase();
      } else {
        const num = coerceNumeric(raw);
        const value = num === null ? NaN : num;
        if (Number.isNaN(value)) {
          // Non-numeric input for a numeric conversion — format like Java's
          // Formatter on a type mismatch would throw; lenient render.
          text = String(raw);
        } else if (c === 'd') {
          text = String(Math.trunc(value));
        } else if (c === 'x') {
          text = Math.trunc(value).toString(16);
        } else if (c === 'e') {
          text = value.toExponential(precision ?? 6);
        } else if (c === 'g') {
          text = value.toPrecision(precision ?? 6);
        } else if (c === 'f') {
          text = value.toFixed(precision ?? 6);
        } else {
          return `%${flags}${widthStr ?? ''}${precStr !== undefined ? '.' + precStr : ''}${conv}`;
        }
        if (conv !== c) text = text.toUpperCase();
        // Sign flags
        if (!Number.isNaN(value) && value >= 0) {
          if (flags.includes('+')) text = '+' + text;
          else if (flags.includes(' ')) text = ' ' + text;
        }
      }

      if (!width) return text;
      if (text.length >= width) return text;
      const pad = width - text.length;
      if (flags.includes('-')) return text + ' '.repeat(pad);
      if (flags.includes('0')) {
        // Zero-pad AFTER an explicit sign, like printf.
        const sign = /^[+-]/.test(text) ? text.slice(0, 1) : '';
        return sign + '0'.repeat(pad) + text.slice(sign.length);
      }
      return ' '.repeat(pad) + text;
    },
  );
}

export function concatenateStringValues(
  row: Record<string, unknown>,
  expressions: StringOperand[],
  separator: string,
  nullOutputIfAnyInputIsNull: boolean,
): string | null {
  const values = expressions.map((expression) =>
    expression.kind === 'column' ? row[expression.value] : expression.value,
  );
  if (nullOutputIfAnyInputIsNull && values.some((value) => value === null || value === undefined)) return null;
  return values
    .filter((value) => value !== null && value !== undefined)
    .map(String)
    .join(separator);
}

function compareEq(a: unknown, b: unknown): boolean {
  const an = coerceNumeric(a);
  const bn = coerceNumeric(b);
  if (an !== null && bn !== null) return an === bn;
  return coerceString(a) === coerceString(b);
}

function compareOrd(a: unknown, b: unknown): number {
  const an = coerceNumeric(a);
  const bn = coerceNumeric(b);
  if (an !== null && bn !== null) {
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }
  const as = coerceString(a);
  const bs = coerceString(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/**
 * Build the ConvertOptions for a Cast, inferring the day/month order from the
 * column's own values when casting to date/timestamp.
 *
 * convertValue defaults to "dmy" (Rwanda). Spreadsheet exports are very often
 * month-first, and under the dmy default an ambiguous "7/6/23" silently
 * becomes June 7 instead of July 6. Sniffing the column for a value that can
 * only be read one way ("7/30/23") fixes the whole column. When the sample
 * carries no decisive evidence, inferDateFormat returns null and the dmy
 * default stands.
 */
function castOptionsForColumn(
  rows: Array<Record<string, unknown>>,
  sourceCol: string,
  converterType: string,
): { coerce: true; dateFormat?: 'dmy' | 'mdy' } {
  if (converterType !== 'date' && converterType !== 'timestamp') {
    return { coerce: true };
  }
  // Cap the sniff sample: one decisive value is enough, and columns can be
  // large. 1000 rows is ample and bounded.
  const samples: unknown[] = [];
  for (const row of rows) {
    samples.push(row[sourceCol]);
    if (samples.length >= 1000) break;
  }
  const inferred = inferDateFormat(samples);
  return inferred ? { coerce: true, dateFormat: inferred } : { coerce: true };
}

/**
 * Coerce an expression result to the requested logical type. Uses the same
 * convertValue path as Cast so chains behave consistently.
 */
function castExpressionResult(value: unknown, outputType: CastTargetType | undefined): unknown {
  if (outputType === undefined) return value;
  try {
    return convertValue(value, CONVERTER_TYPE_MAP[outputType], { coerce: true });
  } catch {
    return null;
  }
}

/**
 * Collects the ExpressionItem objects carried by an Apply-family transform
 * record persisted in `config.transforms[]`. Handles the four variants:
 *   - ApplyExpression           → single `expression`
 *   - ApplyMultipleExpressions   → array `expressions`
 *   - ApplyToMultipleColumns    → expand: one expression per input column
 *   - ComputeIfExpressionAbsent → single expression with `outputColumn` on
 *                                  the transform (not on the expression).
 */
function collectExpressionItems(tx: Record<string, unknown>): ExpressionItem[] {
  const fn = tx.function as string;
  if (fn === 'ApplyExpression' || fn === 'ApplyMultipleExpressions') {
    const list = (tx.expressions ?? (tx.expression ? [tx.expression] : [])) as ExpressionItem[];
    return list;
  }
  if (fn === 'ComputeIfExpressionAbsent') {
    const inner = (tx.expression as Omit<ExpressionItem, 'outputColumn'>) ?? null;
    if (!inner) return [];
    return [{ ...(inner as object), outputColumn: tx.outputColumn as string } as unknown as ExpressionItem];
  }
  if (fn === 'ApplyToMultipleColumns') {
    const cols = (tx.columns as string[]) ?? [];
    const op = tx.operator as BinaryOperator;
    const right = tx.right as Operand;
    const suffix = (tx.outputSuffix as string) ?? '_calc';
    const outs = (tx.outputColumns as string[] | undefined) ?? cols.map((c) => `${c}${suffix}`);
    const outType = tx.outputType as CastTargetType | undefined;
    return cols.map((c, i) => ({
      left: { kind: 'column', value: c },
      operator: op,
      right,
      outputColumn: outs[i],
      outputType: outType,
    }));
  }
  return [];
}

/**
 * How many source rows a preview reads before it stops.
 *
 * Previews run in the request path against the raw CSV, so they are bounded
 * rather than complete. That bound is invisible in the response unless we say
 * so: a `totalRows` of 5000 on a million-row dataset reads as "this dataset has
 * 5000 rows", which is wrong in a way that silently misleads whoever is
 * building the transform. `sampleInfo` (below) makes the distinction explicit.
 */
export const PREVIEW_SOURCE_ROW_LIMIT = 5000;

/**
 * How many source rows the legacy `/transforms/execute` path reads.
 *
 * Higher than a preview because this is the "Apply All" result the canvas
 * snapshots, but still bounded: it runs in the request path with the whole
 * result in memory. Deploy does not go through here — `materializeForDeploy`
 * re-reads every input unbounded — so this cap costs snapshot completeness,
 * not written-dataset completeness. It is reported via `truncated` so the
 * caller never reads a clipped result as a total.
 */
export const EXECUTE_SOURCE_ROW_LIMIT = 10000;

/**
 * Describe the sample a preview was computed over.
 *
 * `truncated` is true when the reader hit the cap, which means every count in
 * the response describes the first PREVIEW_SOURCE_ROW_LIMIT source rows and not
 * the dataset. Callers that surface row counts should qualify them when this is
 * set; `/transforms/execute` is the unbounded path.
 */
function sampleInfo(rawRowsRead: number): {
  sampledSourceRows: number;
  sourceRowLimit: number;
  truncated: boolean;
} {
  return {
    sampledSourceRows: rawRowsRead,
    sourceRowLimit: PREVIEW_SOURCE_ROW_LIMIT,
    truncated: rawRowsRead >= PREVIEW_SOURCE_ROW_LIMIT,
  };
}

/**
 * Validates that each `kind: 'column'` operand references a column that exists
 * in `effectiveCols`. Throws VALIDATION_ERROR with the available list.
 */
function validateExpressionColumns(
  expr: Pick<ExpressionItem, 'left' | 'right'>,
  effectiveCols: Array<{ name: string }>,
): void {
  for (const op of [expr.left, expr.right]) {
    if (op.kind !== 'column') continue;
    const want = stripBom(op.value);
    if (!effectiveCols.some((c) => stripBom(c.name) === want)) {
      throw new AppError(
        `Expression references column "${want}" which does not exist. ` +
          `Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }
}

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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(
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
    const rows = this.applyExistingTransforms(rawRows, chainTransforms)
      .slice(0, input.limit);

    // Build effective column metadata reflecting any prior Cast transforms
    const effectiveColumns = this.applyExistingTransformColumns(
      sourceColumns,
      chainTransforms,
    );

    // Apply the Cast transform
    const castOptions = castOptionsForColumn(rows, sourceCol, converterType);
    let castErrors = 0;
    // Lenient mode nulls a failed cast, which is correct — but discarding *why*
    // it failed makes "N of N values could not be cast" a dead end: the user
    // cannot tell an unsupported input shape (a real bug, fix the converter)
    // from a column that simply is not of that type (e.g. days_until_due holds
    // '59', a day count, so no timestamp exists to cast it to). Keep the first
    // reason and one offending sample so the message can say which it is.
    let castErrorReason: string | undefined;
    let castErrorSample: string | undefined;
    const transformedRows = rows.map((row) => {
      const rawValue = row[sourceCol];
      let castValue: unknown;

      try {
        castValue = convertValue(rawValue, converterType, castOptions);
      } catch (err) {
        // Lenient mode: failed casts become null (matches Palantir behaviour)
        castValue = null;
        castErrors++;
        if (castErrorReason === undefined) {
          castErrorReason =
            err instanceof Error ? err.message : String(err);
          // Truncate: a sample is for recognising the shape, not dumping a cell.
          const asText = rawValue === null || rawValue === undefined ? "" : String(rawValue);
          castErrorSample = asText.length > 60 ? `${asText.slice(0, 60)}…` : asText;
        }
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
      ...sampleInfo(rawRows.length),
      castErrors,
      castErrorReason,
      castErrorSample,
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(
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
      if (cond.valueIsColumn && cond.value) {
        const cleanValueCol = stripBom(cond.value);
        if (!effectiveCols.some((c) => stripBom(c.name) === cleanValueCol)) {
          throw new AppError(
            `Comparison column "${cleanValueCol}" does not exist. Available: ${effectiveCols.map((c) => stripBom(c.name)).join(', ')}`,
            400,
            'VALIDATION_ERROR',
          );
        }
        cond.value = cleanValueCol;
      }
    }

    // Read CSV rows, then replay prior transforms in the chain
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
      ...sampleInfo(rawRows.length),
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(
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

    // Refuse to drop every column — the DuckDB build compiler enforces the
    // same rule ("Drop removed every column.").
    if (colsToDrop.size >= effectiveCols.length) {
      throw new AppError('Drop removed every column.', 400, 'DROP_ALL_COLUMNS');
    }

    // Read and replay prior transforms
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
      ...sampleInfo(rawRows.length),
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(
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
      ...sampleInfo(rawRows.length),
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
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
      ...sampleInfo(rawRows.length),
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
  // Select Columns — Preview / Apply
  //
  // Keeps only the listed columns and removes the others — the inverse of
  // Drop. Palantir selectV1.
  // =========================================================================

  async selectPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: SelectPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const want = new Set(input.columns.map(stripBom));
    const unknown = input.columns.filter((c) => !effectiveCols.some((ec) => stripBom(ec.name) === stripBom(c)));
    if (unknown.length > 0) {
      throw new AppError(
        `Columns not found: ${unknown.join(', ')}. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);

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

  async selectApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: SelectApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'Select',
      columns: input.columns,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const k of input.sorts) {
      const c = stripBom(k.column);
      if (!effectiveCols.some((ec) => stripBom(ec.name) === c)) {
        throw new AppError(
          `Sort column "${c}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);

    const sorted = this.applySort(rows, input.sorts);
    const sliced = sorted.slice(0, input.limit);

    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows: sliced,
      rowCount: sliced.length,
      ...sampleInfo(rawRows.length),
      totalRows: rows.length,
      sortSummary: input.sorts.map((s) => `${s.column} ${s.direction.toUpperCase()}`).join(', '),
    };
  }

  async sortApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: SortApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'Sort',
      sorts: input.sorts,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const keyCols = input.columns?.map(stripBom) ?? null;
    if (keyCols) {
      for (const c of keyCols) {
        if (!effectiveCols.some((ec) => stripBom(ec.name) === c)) {
          throw new AppError(
            `Deduplicate key column "${c}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
            400,
            'VALIDATION_ERROR',
          );
        }
      }
    }

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
    const seen = new Set<string>();
    const deduped = rows.filter((row) => {
      let key: string;
      if (keyCols) {
        key = keyCols.map((c) => String(row[c] ?? '')).join('\u0001');
      } else {
        key = Object.keys(row).sort().map((k) => `${k}=${row[k] ?? ''}`).join('\u0001');
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const sliced = deduped.slice(0, input.limit);
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows: sliced,
      rowCount: sliced.length,
      ...sampleInfo(rawRows.length),
      totalRows: rows.length,
      duplicatesRemoved: rows.length - deduped.length,
      dedupeSummary: keyCols ? `By ${keyCols.join(', ')}` : 'By all columns',
    };
  }

  async dropDuplicatesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: DropDuplicatesApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'DropDuplicates',
      columns: input.columns,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);

    const transformed = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k.toUpperCase()] = v;
      return out;
    }).slice(0, input.limit);

    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms)
      .map((c) => ({ name: c.name.toUpperCase(), type: c.type, normalized: true }));

    return {
      columns: effectiveColumns,
      rows: transformed,
      rowCount: transformed.length,
      ...sampleInfo(rawRows.length),
      renameSummary: `Uppercased ${effectiveColumns.length} column names`,
    };
  }

  async uppercaseColumnNamesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UppercaseColumnNamesApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'UppercaseColumnNames',
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const outCol = input.outputColumn?.trim() || 'row_size';
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
    const transformed = rows
      .map((row) => ({ ...row, [outCol]: Buffer.byteLength(JSON.stringify(row), 'utf8') }))
      .slice(0, input.limit);

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

  async rowSizeApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: RowSizeApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'RowSize',
      outputColumn: input.outputColumn?.trim() || 'row_size',
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Apply Expression — Preview / Apply
  //
  // Palantir applyExpressionV1 — single binary expression producing a column.
  // =========================================================================

  private applyExpressionToRows(
    rows: Array<Record<string, unknown>>,
    expr: ExpressionItem,
  ): Array<Record<string, unknown>> {
    return rows.map((row) => {
      const result = evaluateExpression(row, expr);
      const cast = castExpressionResult(result, expr.outputType);
      return { ...row, [expr.outputColumn]: cast };
    });
  }

  async applyExpressionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyExpressionPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    validateExpressionColumns(input.expression, effectiveCols);

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
    const outCol = input.expression.outputColumn;
    const transformed = this.applyExpressionToRows(rows, input.expression).slice(0, input.limit);

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

  async applyExpressionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyExpressionApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'ApplyExpression',
      expression: input.expression,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  private applyCaseExpressionToRows(
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

  async caseExpressionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: CaseExpressionPreviewInput,
  ) {
    const { sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const branch of input.branches) {
      validateExpressionColumns(branch.condition as ExpressionItem, effectiveCols);
      if (branch.value.kind === 'column') validateExpressionColumns({ left: branch.value, right: branch.value } as ExpressionItem, effectiveCols);
    }
    if (input.defaultValue?.kind === 'column') validateExpressionColumns({ left: input.defaultValue, right: input.defaultValue } as ExpressionItem, effectiveCols);
    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
    const transformed = this.applyCaseExpressionToRows(rows, input).slice(0, input.limit);
    const outputColumns = effectiveCols.some((column) => column.name === input.outputColumn)
      ? effectiveCols.map((column) => column.name === input.outputColumn ? { ...column, type: input.outputType ?? 'string' } : column)
      : [...effectiveCols, { name: input.outputColumn, type: input.outputType ?? 'string', isNew: true }];
    return { columns: outputColumns, rows: transformed, rowCount: transformed.length, ...sampleInfo(rawRows.length), expressionSummary: `Applied Case expression to column "${input.outputColumn}"` };
  }

  async caseExpressionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: CaseExpressionApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({ function: 'CaseExpression', ...input, createdAt: new Date().toISOString() });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  async concatenateStringsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ConcatenateStringsPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const expression of input.expressions) {
      if (expression.kind === 'column' && !effectiveCols.some((column) => stripBom(column.name) === stripBom(expression.value))) {
        throw new AppError(`Expression references column "${expression.value}" which does not exist.`, 400, 'VALIDATION_ERROR');
      }
    }
    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
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

  async concatenateStringsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ConcatenateStringsApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({ function: 'ConcatenateStrings', ...input, createdAt: new Date().toISOString() });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const a of input.arguments) {
      if (a.kind === 'column' && !effectiveCols.some((c) => stripBom(c.name) === stripBom(a.value))) {
        throw new AppError(
          `Format argument references column "${a.value}" which does not exist. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
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

  async formatStringApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: FormatStringApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({ function: 'FormatString', ...input, createdAt: new Date().toISOString() });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    for (const e of input.expressions) validateExpressionColumns(e, effectiveCols);

    let rows = this.applyExistingTransforms(rawRows, chainTransforms);
    for (const e of input.expressions) rows = this.applyExpressionToRows(rows, e);
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

  async applyMultipleExpressionsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyMultipleExpressionsApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'ApplyMultipleExpressions',
      expressions: input.expressions,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
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

    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
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

  async applyToMultipleColumnsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ApplyToMultipleColumnsApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
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
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Compute If Expression Absent — Preview / Apply
  //
  // Palantir computeExpressionIfAbsentV1 — only fill the column when the
  // target column is null / empty-string / missing.
  // =========================================================================

  private isValueAbsent(v: unknown): boolean {
    return v === undefined || v === null || v === '' || (typeof v === 'string' && v.toLowerCase() === 'null');
  }

  async computeIfExpressionAbsentPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: ComputeIfExpressionAbsentPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveCols = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    validateExpressionColumns(input.expression, effectiveCols);

    const outCol = input.outputColumn;
    const rows = this.applyExistingTransforms(rawRows, chainTransforms);
    const transformed = rows.map((row) => {
      const current = row[outCol];
      if (!this.isValueAbsent(current)) return row;
      const result = evaluateExpression(row, input.expression);
      const cast = castExpressionResult(
        result,
        (input.expression as { outputType?: CastTargetType }).outputType,
      );
      return { ...row, [outCol]: cast };
    }).slice(0, input.limit);

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

  async computeIfExpressionAbsentApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: ComputeIfExpressionAbsentApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'ComputeIfExpressionAbsent',
      outputColumn: input.outputColumn,
      expression: input.expression,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);

    const rows = this.applyExistingTransforms(rawRows, chainTransforms).slice(0, input.limit);

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      textBlockSummary: input.title ? `Annotation: ${input.title}` : 'Annotation',
    };
  }

  async textBlockApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: TextBlockApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'TextBlock',
      text: input.text,
      title: input.title,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Aggregate-family transforms (PB-B2.follow-2) — shared TS-engine helpers.
  //
  // These mirror the field-reference semantics of the corresponding DuckDB
  // compilers in duckdbTransformEngine.ts; preview rows flow through the
  // legacy CSV path, so every helper here tolerates stringly-typed values
  // and coerces numerics exactly like evalBinaryExpression does.
  // =========================================================================

  /** Logical output type of an aggregation, derived from its input column. */
  private aggregationOutputType(item: AggregationItem, sourceType: string): string {
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
  private evalAggregation(
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
  private computeAggregations(
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
        outRow[item.outputColumn] = this.evalAggregation(item, groups.get(key) ?? []);
      });
      return outRow;
    });
  }

  /**
   * RollupV1 core: prefix-hierarchy grouping sets over rollupColumns.
   * Emits most-detailed groups first (all k columns) down to the grand
   * total (level 0, all key columns null) — DuckDB UNION ordering.
   */
  private computeRollup(
    rows: Array<Record<string, unknown>>,
    rollupColumns: string[],
    aggregations: AggregationItem[],
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let level = rollupColumns.length; level >= 0; level--) {
      const gbs = rollupColumns.slice(0, level);
      for (const row of this.computeAggregations(rows, gbs, aggregations)) {
        for (const c of rollupColumns.slice(level)) row[c] = null;
        out.push(row);
      }
    }
    return out;
  }

  /** Resolve an aggregateOnCondition ColumnPredicate to named columns. */
  private resolveOnConditionTargets(
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

  // =========================================================================
  // Aggregate — Preview / Apply
  //
  // Palantir groupAndAggregateV1.
  // =========================================================================

  async aggregatePreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregatePreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    this.assertColumnsExist(effectiveNames, [...input.groupBy, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Aggregate');

    const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
    const outColumns = [
      ...input.groupBy.map((g) => ({ name: g, type: typeOf(g) })),
      ...input.aggregations.map((item) => ({
        name: item.outputColumn,
        type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
      })),
    ];

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const rows = this.computeAggregations(chained, input.groupBy, input.aggregations).slice(0, input.limit);

    return {
      columns: outColumns,
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      aggregateSummary: `Group by [${input.groupBy.join(', ') || '(all)'}] · ${input.aggregations.length} aggregation(s)`,
    };
  }

  async aggregateApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'Aggregate',
      groupBy: input.groupBy,
      aggregations: input.aggregations,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    if (input.rollupColumns.length === 0 || input.aggregations.length === 0) {
      throw new AppError('Rollup requires at least one column and one aggregation', 400, 'VALIDATION_ERROR');
    }
    this.assertColumnsExist(effectiveNames, [...input.rollupColumns, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Rollup');

    const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
    const outColumns = [
      ...input.rollupColumns.map((g) => ({ name: g, type: typeOf(g) })),
      ...input.aggregations.map((item) => ({
        name: item.outputColumn,
        type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
      })),
    ];

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const rows = this.computeRollup(chained, input.rollupColumns, input.aggregations).slice(0, input.limit);

    return {
      columns: outColumns,
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      rollupSummary: `Rollup [${input.rollupColumns.join(' → ')}] · ${input.aggregations.length} aggregation(s)`,
    };
  }

  async rollupApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: RollupApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'Rollup',
      rollupColumns: input.rollupColumns,
      aggregations: input.aggregations,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
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

  async aggregateOnConditionPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateOnConditionPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const targets = this.resolveOnConditionTargets(input.predicate, effectiveColumns);
    if (targets.length === 0) {
      throw new AppError('Aggregate on Condition matched no columns for the given predicate', 400, 'VALIDATION_ERROR');
    }
    const aggregations = this.buildOnConditionAggregations(targets, input.aggregations);

    const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
    const outColumns = [
      ...input.groupBy.map((g) => ({ name: g, type: typeOf(g) })),
      ...aggregations.map((item) => ({
        name: item.outputColumn,
        type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
      })),
    ];

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const rows = this.computeAggregations(chained, input.groupBy, aggregations).slice(0, input.limit);

    return {
      columns: outColumns,
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      matchedColumns: targets,
    };
  }

  async aggregateOnConditionApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: AggregateOnConditionApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'AggregateOnCondition',
      predicate: input.predicate,
      groupBy: input.groupBy,
      aggregations: input.aggregations,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Top Rows — Preview / Apply
  //
  // Palantir topRowsV1.
  // =========================================================================

  /** topRowV2 core: partition → per-partition sort → first N rows. Mirror
   * of the DuckDB engine's ROW_NUMBER() OVER (PARTITION … ORDER BY …). */
  private computeTopRows(
    rows: Array<Record<string, unknown>>,
    partitionBy: string[],
    sorts: Array<{ column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>,
    topN: number,
  ): Array<Record<string, unknown>> {
    if (partitionBy.length === 0) {
      return this.applySort(rows, sorts).slice(0, topN);
    }
    const groups = new Map<string, Array<Record<string, unknown>>>();
    const order: string[] = [];
    for (const row of rows) {
      const key = JSON.stringify(partitionBy.map((c) => row[c] ?? null));
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const key of order) {
      out.push(...this.applySort(groups.get(key) ?? [], sorts).slice(0, topN));
    }
    return out;
  }

  async topRowsPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: TopRowsPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    if (input.sorts.length === 0) {
      throw new AppError('Top Rows requires at least one sort column', 400, 'VALIDATION_ERROR');
    }
    this.assertColumnsExist(effectiveNames, [...input.partitionBy, ...input.sorts.map((s) => s.column)], 'TopRows');

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const rows = this.computeTopRows(chained, input.partitionBy, input.sorts, input.topN).slice(0, input.limit);

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      topRowSummary: `Top ${input.topN} rows per ${input.partitionBy.length ? `[${input.partitionBy.join(', ')}]` : 'table'}`,
    };
  }

  async topRowsApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: TopRowsApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'TopRows',
      partitionBy: input.partitionBy,
      sorts: input.sorts,
      topN: input.topN,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Pivot — Preview / Apply
  //
  // Palantir pivotV1: long → wide.
  // =========================================================================

  /**
   * PivotV1 core. Mirrors the DuckDB emitter: one column per
   * (pivotValue × aggregation), valued by a filtered aggregate over the
   * rows where `pivotColumn = value`; output name is
   * `prefix` → `<alias>_<outputColumn>` / `suffix` → `<outputColumn>_<alias>`.
   * Values outside `pivotValues` contribute no columns or groups; groups
   * with no matching rows produce SQL-consistent cells (count=0, sum=null).
   */
  private computePivot(
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
          outRow[nameFor(pv.alias, agg)] = this.evalAggregation(agg, cellRows);
        }
      }
      return outRow;
    });
    return { rows: rowsOut, valueColumns };
  }

  async pivotPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: PivotPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    this.assertColumnsExist(effectiveNames, [input.pivotColumn, ...input.groupBy, ...input.aggregations.map((a) => a.column).filter((c): c is string => Boolean(c))], 'Pivot');
    if (input.aggregations.some((a) => !a.column)) {
      throw new AppError('Pivot aggregations require a column (count(*) pivot is not supported).', 400, 'VALIDATION_ERROR');
    }

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const { rows: allRows, valueColumns } = this.computePivot(
      chained, input.groupBy, input.pivotColumn, input.pivotValues, input.aggregations, input.aliasPosition,
    );

    const typeOf = (c: string) => effectiveColumns.find((col) => col.name === c)?.type ?? 'string';
    const typesByName = new Map(input.aggregations.map((item) => [
      item.outputColumn,
      this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
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

  async pivotApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: PivotApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
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
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Unpivot — Preview / Apply
  //
  // Palantir unpivotV1: wide → long; keeps NULL values.
  // =========================================================================

  /** unpivotV1 core: one row per (keat key, unpivoted column). */
  private computeUnpivot(
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

  async unpivotPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnpivotPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    this.assertColumnsExist(effectiveNames, input.columns, 'Unpivot');
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

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const rows = this.computeUnpivot(chained, input.columns, input.nameColumn, input.valueColumn, keptColumns.map((c) => c.name)).slice(0, input.limit);

    return {
      columns: outColumns,
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      unpivotSummary: `Unpivot ${input.columns.length} column(s) → "${input.nameColumn}" / "${input.valueColumn}"`,
    };
  }

  async unpivotApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: UnpivotApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'Unpivot',
      columns: input.columns,
      nameColumn: input.nameColumn,
      valueColumn: input.valueColumn,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Keep Duplicates — Preview / Apply
  //
  // Palantir keepDuplicatesV1: keep ALL rows whose key appears more than
  // once (contrast dropDuplicates which keeps only one).
  // =========================================================================

  /** keepDuplicatesV1 core: key-frequency filter, original order preserved. */
  private computeKeepDuplicates(
    rows: Array<Record<string, unknown>>,
    subset: string[],
    allColumns: string[],
  ): Array<Record<string, unknown>> {
    const keys = subset.length ? subset : allColumns;
    const keyOf = (row: Record<string, unknown>) => JSON.stringify(keys.map((c) => row[c] ?? null));
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = keyOf(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return rows.filter((row) => (counts.get(keyOf(row)) ?? 0) > 1);
  }

  async keepDuplicatesPreview(
    projectId: string, pipelineId: string, nodeId: string,
    input: KeepDuplicatesPreviewInput,
  ) {
    const { dataset, sourceColumns, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(projectId, pipelineId, nodeId);
    const chainTransforms = input.priorTransforms ?? existingTransforms;
    const effectiveColumns = this.applyExistingTransformColumns(sourceColumns, chainTransforms);
    const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
    // Omitting `columns` = exact-duplicate mode (key = every column).
    const subset = input.columns ?? [];
    this.assertColumnsExist(effectiveNames, subset, 'KeepDuplicates');

    const chained = this.applyExistingTransforms(rawRows, chainTransforms);
    const allNames = effectiveColumns.map((c) => c.name);
    const rows = this.computeKeepDuplicates(chained, subset, allNames).slice(0, input.limit);

    return {
      columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      rowCount: rows.length,
      ...sampleInfo(rawRows.length),
      keepDuplicatesSummary: `Keeping rows where (${subset.join(', ') || 'all columns'}) appears > 1 time`,
    };
  }

  async keepDuplicatesApply(
    projectId: string, pipelineId: string, nodeId: string,
    input: KeepDuplicatesApplyInput,
  ) {
    const node = await this.fetchNodeConfig(projectId, pipelineId, nodeId);
    const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
    transforms.push({
      function: 'KeepDuplicates',
      columns: input.columns,
      createdAt: new Date().toISOString(),
    });
    node.config.transforms = transforms;
    return this.saveNodeConfig(nodeId, pipelineId, node.config);
  }

  // =========================================================================
  // Private helpers — fetch / persist node config (DRY for the new apply
  // methods above; mirrors the inline pattern used by castApply et al).
  // =========================================================================

  private async fetchNodeConfig(
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

  private async saveNodeConfig(
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
  private assertColumnsExist(
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

  /**
   * Stable multi-key sort. Nulls are ordered first or last per SortKey.nulls
   * (default: 'last' for ascending, 'first' for descending — the SQL-standard
   * default in DuckDB/Postgres).
   */
  private applySort(
    rows: Array<Record<string, unknown>>,
    sorts: Array<{ column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>,
  ): Array<Record<string, unknown>> {
    const withIdx = rows.map((row, idx) => ({ row, idx }));
    withIdx.sort((a, b) => {
      for (const k of sorts) {
        const av = a.row[k.column];
        const bv = b.row[k.column];
        const aNull = av === null || av === undefined || av === '';
        const bNull = bv === null || bv === undefined || bv === '';
        if (aNull && bNull) continue;
        const nullsFirst = k.nulls === 'first' ? true : k.nulls === 'last' ? false : k.direction === 'desc';
        if (aNull) return nullsFirst ? -1 : 1;
        if (bNull) return nullsFirst ? 1 : -1;
        const an = coerceNumeric(av);
        const bn = coerceNumeric(bv);
        let cmp: number;
        if (an !== null && bn !== null) cmp = an < bn ? -1 : an > bn ? 1 : 0;
        else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        if (cmp !== 0) return k.direction === 'desc' ? -cmp : cmp;
      }
      // Stable: preserve original index for ties.
      return a.idx - b.idx;
    });
    return withIdx.map((x) => x.row);
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

    // ── Resolve the complete left input ──────────────────────────────
    // A join's left input is its source node, not the join node itself.
    // Resolving it through resolveNodeDataset() worked only for a raw
    // dataset/linear-transform chain: when the source was a join or union it
    // silently fell back to the leftmost CSV. That made the join editor reject
    // valid downstream columns (for example coverage_id on a claim-line →
    // claim join) and prevented temporal anti-joins from being configured.
    const targetNode = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config')
      .first();
    if (!targetNode) {
      throw new AppError('Pipeline node not found. It may have been deleted.', 404, 'NOT_FOUND');
    }
    const targetConfig = typeof targetNode.config === 'string'
      ? JSON.parse(targetNode.config)
      : (targetNode.config ?? {});
    const leftSourceNodeId = targetConfig.sourceNodeId as string | undefined;
    const leftData = leftSourceNodeId
      ? await this.resolveNodeData(projectId, pipelineId, leftSourceNodeId, input.priorTransforms)
      : null;

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

    // Both arms use the same resolver as output previews. This honors the
    // pinned snapshot of an upstream join/union instead of flattening it to a
    // raw dataset and makes the canvas schema match what deploy will execute.
    const rightData = await this.resolveNodeData(projectId, pipelineId, input.rightNodeId);
    const fallbackLeft = leftData ?? await this.resolveNodeData(
      projectId, pipelineId, nodeId, input.priorTransforms,
    );
    const leftRows = fallbackLeft.rows;
    const rightRows = rightData.rows;
    const effectiveLeftCols = fallbackLeft.columns;
    const rightCols = rightData.columns;

    if (leftRows.length === 0) {
      throw new AppError('Left input contains no rows. Apply transforms or check the source dataset.', 400, 'LEFT_EMPTY');
    }
    if (rightRows.length === 0) {
      throw new AppError('Right input contains no rows. Check the source dataset.', 400, 'RIGHT_EMPTY');
    }

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
    const coalesceJoinKeys = input.coalesceJoinKeys ?? false;
    const joinedRows = this.executeJoin(
      leftRows, rightRows, input.joinType, input.conditions,
      effectiveLeftCols, rightCols, rightPrefix, coalesceJoinKeys,
    );
    const rows = joinedRows.slice(0, input.limit);

    // Warn about zero matches
    if (joinedRows.length === 0 && input.joinType === 'inner') {
      warnings.push({
        code: 'ZERO_MATCHES',
        message: `Inner join produced 0 rows. No matching values were found between the join columns. Verify the match condition columns contain overlapping values.`,
      });
    } else if (input.joinType !== 'cross') {
      // An *outer* join hides the same failure an inner join makes obvious:
      // with zero overlap a left join still returns every left row, so nothing
      // errors and the only symptom is that every right-side column is null.
      // See joinMatchRate.ts for why this lives in a pure module.
      if (input.joinType === 'left' || input.joinType === 'right' || input.joinType === 'full_outer') {
        warnings.push(
          ...buildJoinMatchWarnings(
            leftRows,
            rightRows,
            input.joinType,
            input.conditions,
            stripBom,
          ),
        );
      }
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
    // Semi/anti joins surface LEFT columns only (Palantir joinV2) —
    // any right-side selection is ignored.
    const filteredRightCols = (input.joinType === 'semi' || input.joinType === 'anti')
      ? []
      : rightSelectedSet
        ? rightCols.filter((c) => rightSelectedSet.has(c.name))
        : rightCols;

    // Build output columns: left columns + right columns (prefixed if collision,
    // or dropped entirely when the key was coalesced into its left twin).
    const leftNames = new Set(filteredLeftCols.map((c) => c.name));
    const coalescedNames = coalesceJoinKeys
      ? coalescedJoinKeyNames(input.conditions, leftNames, stripBom)
      : new Set<string>();
    const outputCols = [
      ...filteredLeftCols.map((c) => ({ name: c.name, type: c.type, source: 'left' as const })),
      ...filteredRightCols
        .filter((c) => !coalescedNames.has(c.name))
        .map((c) => ({
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

    // Atomic schema persistence — when the caller persists, the snapshot is
    // written from THIS preview's output in the same request, so a join node
    // can never carry a schema that diverges from what was just computed.
    if (input.persist) {
      await this.persistExecutionSnapshot(projectId, pipelineId, nodeId, outputCols, filteredRows);
    }

    return {
      columns: outputCols,
      rows: filteredRows,
      rowCount: filteredRows.length,
      totalJoined: joinedRows.length,
      leftRowCount: leftRows.length,
      rightRowCount: rightRows.length,
      // Two bounded reads, so either side can be the truncated one — a join
      // preview whose left input was clipped is missing matches, not merely
      // showing fewer rows.
      ...sampleInfo(Math.max(leftRows.length, rightRows.length)),
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
      // The deploy path reads joinStep.rightPrefix, so a non-default prefix
      // that was not persisted here would silently revert to `right_` on
      // deploy while preview showed the chosen one.
      ...(input.rightPrefix ? { rightPrefix: input.rightPrefix } : {}),
      ...(input.coalesceJoinKeys ? { coalesceJoinKeys: true } : {}),
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
    const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
    const mode = input.mode ?? 'name-merge';

    // ── Resolve every input (uses snapshot if available) ──────────
    // Palantir's `union*ByNameV1` transforms take `List<Table>`, so a
    // three-way union is ONE node rather than two chained ones. The node the
    // request is addressed to is the first input; `rightNodeIds` (or the
    // legacy singular `rightNodeId`) supplies the rest, in order.
    const additionalIds = resolveUnionInputIds(input);
    const left = await this.resolveNodeData(projectId, pipelineId, nodeId, input.priorTransforms);
    const others = await Promise.all(
      additionalIds.map((id) => this.resolveNodeData(projectId, pipelineId, id)),
    );
    const branches = [left, ...others];

    const effectiveLeftCols = left.columns;
    const leftRows = left.rows;
    // Retained for the two-input wire shape the canvas still speaks; with more
    // than two inputs this collapses the tail branches together and
    // `branchRowCounts` carries the per-branch detail.
    const rightRows = others.flatMap((b) => b.rows);

    if (branches.every((b) => b.rows.length === 0)) {
      throw new AppError(
        branches.length === 2
          ? 'Both inputs contain no rows.'
          : `All ${branches.length} inputs contain no rows.`,
        400,
        'BOTH_EMPTY',
      );
    }

    // ── Union column merge — Palantir unionV1 modes ─────────────
    //   first : keep the FIRST input's schema; columns only in later inputs
    //           are dropped, and their rows get null for any missing column.
    //   narrow: keep columns present in EVERY input (first-input ordering).
    //   wide  : union of all inputs (canvas default, "name-merge").
    const leftColMap = new Map(effectiveLeftCols.map((c) => [c.name, c.type]));
    const otherColMaps = others.map((b) => new Map(b.columns.map((c) => [c.name, c.type])));

    /** Present in every input — what `narrow` keeps. */
    const inEveryInput = (name: string): boolean =>
      otherColMaps.every((m) => m.has(name));
    /** Present in at least one input other than the first. */
    const inSomeOther = (name: string): boolean =>
      otherColMaps.some((m) => m.has(name));

    // For two inputs these are exactly the historical leftOnly/rightOnly.
    const leftOnly = effectiveLeftCols.filter((c) => !inEveryInput(c.name)).map((c) => c.name);
    const rightOnly: string[] = [];
    for (const branch of others) {
      for (const c of branch.columns) {
        if (!leftColMap.has(c.name) && !rightOnly.includes(c.name)) rightOnly.push(c.name);
      }
    }

    // Type-mismatch warnings apply in every mode that keeps shared columns.
    for (const c of effectiveLeftCols) {
      for (const [i, m] of otherColMaps.entries()) {
        const otherType = m.get(c.name);
        if (otherType && otherType !== c.type) {
          warnings.push({
            code: 'TYPE_MISMATCH',
            message:
              branches.length === 2
                ? `Column "${c.name}" has type "${c.type}" in left and "${otherType}" in right. Values are cast to text.`
                : `Column "${c.name}" has type "${c.type}" in input 1 and "${otherType}" in input ${i + 2}. Values are cast to text.`,
          });
        }
      }
    }

    // "left"/"right" only read correctly for two inputs; N-input unions need
    // first-vs-later phrasing so the user knows which input to look at.
    const sideLabels = unionSideLabels(branches.length);

    let outputColNames: string[];
    let outputCols: Array<{ name: string; type: string; source: string }>;

    if (mode === 'first') {
      outputCols = effectiveLeftCols.map((c) => ({
        name: c.name,
        type: c.type,
        source: inSomeOther(c.name) ? 'both' : 'left',
      }));
      outputColNames = outputCols.map((c) => c.name);
      if (rightOnly.length > 0) {
        warnings.push({
          code: 'RIGHT_ONLY_COLUMNS_DROPPED',
          message: `${rightOnly.length} column${rightOnly.length > 1 ? 's' : ''} ${sideLabels.laterOnly} dropped by "first input schema" mode: ${rightOnly.join(', ')}.`,
          details: { columns: rightOnly },
        });
      }
    } else if (mode === 'narrow') {
      outputCols = effectiveLeftCols
        .filter((c) => inEveryInput(c.name))
        .map((c) => ({ name: c.name, type: c.type, source: 'both' }));
      outputColNames = outputCols.map((c) => c.name);
      if (outputCols.length === 0) {
        throw new AppError(
          `Union in "narrow" mode produced zero columns: the ${branches.length} inputs share no column names.`,
          400,
          'UNION_NARROW_EMPTY',
        );
      }
      if (leftOnly.length > 0) {
        warnings.push({
          code: 'LEFT_ONLY_COLUMNS_DROPPED',
          message: `${leftOnly.length} column${leftOnly.length > 1 ? 's' : ''} ${sideLabels.firstOnly} dropped by "narrow" mode: ${leftOnly.join(', ')}.`,
          details: { columns: leftOnly },
        });
      }
      if (rightOnly.length > 0) {
        warnings.push({
          code: 'RIGHT_ONLY_COLUMNS_DROPPED',
          message: `${rightOnly.length} column${rightOnly.length > 1 ? 's' : ''} ${sideLabels.laterOnly} dropped by "narrow" mode: ${rightOnly.join(', ')}.`,
          details: { columns: rightOnly },
        });
      }
    } else {
      // wide / name-merge (default): superset, left ordering preserved.
      outputCols = [];
      outputColNames = [];
      const seen = new Set<string>();
      for (const c of effectiveLeftCols) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          outputColNames.push(c.name);
          outputCols.push({ name: c.name, type: c.type, source: inSomeOther(c.name) ? 'both' : 'left' });
        }
      }
      // Later inputs contribute their new columns in input order, so column
      // ordering follows the first input then each additional one — the
      // ordering Palantir's wideUnionByNameV1 examples show.
      for (const branch of others) {
        for (const c of branch.columns) {
          if (!seen.has(c.name)) {
            seen.add(c.name);
            outputColNames.push(c.name);
            outputCols.push({ name: c.name, type: c.type, source: 'right' });
          }
        }
      }
      const twoBranches = branches.length === 2;
      if (leftOnly.length > 0) {
        warnings.push({
          code: 'LEFT_ONLY_COLUMNS',
          message:
            `${leftOnly.length} column${leftOnly.length > 1 ? 's' : ''} ${sideLabels.firstOnly}: ${leftOnly.join(', ')}. ` +
            (twoBranches
              ? 'Right rows will have null for these.'
              : 'Rows from the inputs that lack them will have null.'),
          details: { columns: leftOnly },
        });
      }
      if (rightOnly.length > 0) {
        warnings.push({
          code: 'RIGHT_ONLY_COLUMNS',
          message:
            `${rightOnly.length} column${rightOnly.length > 1 ? 's' : ''} ${sideLabels.laterOnly}: ${rightOnly.join(', ')}. ` +
            (twoBranches
              ? 'Left rows will have null for these.'
              : 'Rows from inputs that lack them will have null.'),
          details: { columns: rightOnly },
        });
      }
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
        `Union in strict mode requires identical column sets on ${sideLabels.allInputs}. ` +
          (leftOnly.length > 0 ? `Columns ${sideLabels.firstOnly}: ${leftOnly.join(', ')}. ` : '') +
          (rightOnly.length > 0 ? `Columns ${sideLabels.laterOnly}: ${rightOnly.join(', ')}.` : ''),
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

    // Rows are concatenated in input order — no dedup, matching Palantir
    // ("retains all rows, including duplicates").
    for (const branch of branches) {
      for (const row of branch.rows) {
        const out: Record<string, unknown> = {};
        for (const col of outputColNames) {
          out[col] = col in row ? row[col] : null;
        }
        unifiedRows.push(out);
      }
    }

    const rows = unifiedRows.slice(0, input.limit);

    // A preview window that ends inside the first branch shows only that
    // branch's rows, which reads as "the union dropped my other input" — the
    // exact confusion the 500-row default produces on a 500-row left branch.
    const branchRowCounts = branches.map((b) => b.rows.length);
    if (rows.length < unifiedRows.length) {
      let covered = 0;
      let branchesShown = 0;
      for (const n of branchRowCounts) {
        if (covered >= rows.length) break;
        branchesShown++;
        covered += n;
      }
      if (branchesShown < branches.length) {
        warnings.push({
          code: 'PREVIEW_WINDOW_ONE_BRANCH',
          message:
            `This ${rows.length.toLocaleString()}-row preview covers only ` +
            `${branchesShown} of ${branches.length} inputs — the remaining ` +
            `input${branches.length - branchesShown > 1 ? 's contribute' : ' contributes'} ` +
            `rows past the preview window. The union itself has ` +
            `${unifiedRows.length.toLocaleString()} rows; raise the row limit ` +
            `to see the later inputs.`,
          details: { branchesShown, branchCount: branches.length, branchRowCounts },
        });
      }
    }

    return {
      columns: outputCols,
      rows,
      rowCount: rows.length,
      totalUnioned: unifiedRows.length,
      leftRowCount: leftRows.length,
      // With more than two inputs this is every later input combined;
      // `branchRowCounts` is the per-input breakdown.
      rightRowCount: rightRows.length,
      inputCount: branches.length,
      branchRowCounts,
      // Any branch reaching the read cap makes totalUnioned a floor rather
      // than a count, so report the union as sampled if any side was.
      sampledSourceRows: branchRowCounts.reduce((a, b) => a + b, 0),
      sourceRowLimit: PREVIEW_SOURCE_ROW_LIMIT,
      truncated: branches.some((b) => b.truncated),
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
    // Persist BOTH shapes: `rightNodeIds` is the N-input list the deploy path
    // reads, and `rightNodeId` stays populated with the first entry so any
    // older reader (or a graph inspector) still sees a wired second input.
    const inputIds = resolveUnionInputIds(input);
    config.rightNodeIds = inputIds;
    config.rightNodeId = inputIds[0];
    // Union mode (unionV1): first / narrow / wide. Persisted so replay and
    // deploy materialization agree with the canvas preview. Absent = wide.
    if (input.mode) config.mode = input.mode;

    // Atomic schema persistence: the union is recomputed here against the
    // current inputs and its result is written TOGETHER with the wiring in
    // a single UPDATE. The legacy flow (client saves config, then separately
    // POSTs /preview-snapshot) left a failure window in which a union node
    // existed with wiring but no previewSnapshot, rendering "0 columns" on
    // the canvas and breaking every downstream node with SNAPSHOT_REQUIRED.
    // If this compute throws (e.g. an upstream input has no snapshot yet),
    // nothing is persisted — config and snapshot can never diverge.
    const sourceNodeId = typeof config.sourceNodeId === 'string' ? config.sourceNodeId : null;
    if (!sourceNodeId) {
      throw new AppError(
        'Union node has no sourceNodeId — wire the first input before applying.',
        400,
        'UNION_NO_SOURCE',
      );
    }
    const unionResult = await this.unionPreview(projectId, pipelineId, sourceNodeId, {
      rightNodeIds: inputIds,
      mode: config.mode as UnionPreviewInput['mode'],
      limit: 500,
    });
    config.previewSnapshot = {
      columns: unionResult.columns,
      rows: unionResult.rows,
      rowCount: unionResult.rows.length,
      transforms: [],
      chainHash: hashTransformChain([]),
      schemaFingerprint: fingerprintSchema(unionResult.columns),
      nodeId,
      transitiveInputSnapshots: await this.walkTransitiveInputs(pipelineId, nodeId),
      savedAt: new Date().toISOString(),
    };

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
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
    const spec = validateUdfSpec(input);
    const node = await this.knex('pipeline_nodes as pn')
      .join('pipelines as p', 'pn.pipeline_id', 'p.id')
      .where({ 'pn.id': nodeId, 'pn.pipeline_id': pipelineId, 'p.project_id': projectId })
      .select('pn.id', 'pn.config').first();
    if (!node) throw new AppError('Pipeline node not found', 404, 'NOT_FOUND');

    const config = typeof node.config === 'string' ? JSON.parse(node.config) : (node.config ?? {});
    config.udfTransform = { ...spec, createdAt: new Date().toISOString() };

    const [updated] = await this.knex('pipeline_nodes')
      .where({ id: nodeId, pipeline_id: pipelineId })
      .update({ config: JSON.stringify(config) }).returning('*');
    return updated;
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
    const spec = validateUdfSpec(input);
    const { dataset, existingTransforms, baseRows: rawRows } = await this.resolvePreviewInput(
      projectId, pipelineId, nodeId,
    );
    const rows = this.applyExistingTransforms(rawRows, existingTransforms)
      .slice(0, limit);

    const out = await runUdfTransform({
      buildRid: `udf-preview-${pipelineId}-${nodeId}`,
      tenant: projectId,
      spec,
      rows,
    });

    const columns = spec.outputColumns.length
      ? spec.outputColumns
      : Object.keys(out[0] ?? {}).map((name) => ({ name, type: 'string' }));
    return {
      columns,
      rows: out,
      rowCount: out.length,
      ...sampleInfo(rawRows.length),
    };
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
    const leftNames = new Set(leftCols.map((c) => c.name));
    const result: Array<Record<string, unknown>> = [];

    // Same-named equality keys that collapse into a single output column.
    const coalescedRight = coalesceJoinKeys
      ? coalescedJoinKeyNames(conditions, leftNames, stripBom)
      : new Set<string>();

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
          const bare = stripBom(k);
          if (coalescedRight.has(bare)) {
            // COALESCE(l.k, r.k): on a matched row both sides carry the same
            // value; on a right-only outer row the left side is null and the
            // right value is what the single column must show.
            if (out[bare] === undefined || out[bare] === null || out[bare] === '') out[bare] = v;
            continue;
          }
          const key = leftNames.has(bare) ? `${rightPrefix}${k}` : k;
          out[key] = v;
        }
      } else {
        for (const c of rightCols) {
          if (coalescedRight.has(c.name)) continue;
          const key = leftNames.has(c.name) ? `${rightPrefix}${c.name}` : c.name;
          out[key] = null;
        }
      }
      return out;
    };

    // Helper: check if a left row matches a right row on all conditions.
    // A condition list is Palantir's `and(...)` — every one must hold.
    // Per Palantir spec: null ≠ null — if either side is null/empty, no match.
    const isNullish = (v: unknown): boolean =>
      v === undefined || v === null || v === '' || String(v).toLowerCase() === 'null';

    const matches = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
      return conditions.every((c) => {
        const lv = left[stripBom(c.leftColumn)];
        const rv = right[stripBom(c.rightColumn)];
        if (isNullish(lv) || isNullish(rv)) return false;
        return compareJoinValues(lv, rv, c.operator ?? 'equals');
      });
    };

    if (joinType === 'cross') {
      for (const l of leftRows) {
        for (const r of rightRows) {
          result.push(mergeRow(l, r));
          if (result.length >= PREVIEW_SOURCE_ROW_LIMIT) return result;
        }
      }
      return result;
    }

    // Semi/anti (joinV2): existence filter on the left — no right columns
    // are surfaced. Callers strip right-side columns from the output.
    if (joinType === 'semi') {
      for (const l of leftRows) {
        if (rightRows.some((r) => matches(l, r))) result.push(mergeRow(l, null));
      }
      return result;
    }

    if (joinType === 'anti') {
      for (const l of leftRows) {
        if (!rightRows.some((r) => matches(l, r))) result.push(mergeRow(l, null));
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
  private async persistExecutionSnapshot(
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
            type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
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
            type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
          })),
        ];
      }
      if (fn === 'AggregateOnCondition') {
        const groupBy = (tx.groupBy ?? []) as string[];
        const targets = this.resolveOnConditionTargets(
          tx.predicate as ColumnPredicate,
          cols,
        );
        const aggs = this.buildOnConditionAggregations(
          targets,
          (tx.aggregations ?? []) as DynamicAggregation[],
        );
        const typeOf = (c: string) => cols.find((col) => col.name === c)?.type ?? 'string';
        cols = [
          ...groupBy.map((g) => ({ name: g, type: typeOf(g) })),
          ...aggs.map((item) => ({
            name: item.outputColumn,
            type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
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
              type: this.aggregationOutputType(item, item.column ? typeOf(item.column) : 'string'),
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
        const castOptions = castOptionsForColumn(result, expr, converterType);

        result = result.map((row) => {
          const rawValue = row[expr];
          let castValue: unknown;
          try {
            castValue = convertValue(rawValue, converterType, castOptions);
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
        if (result.length > 0 && Object.keys(result[0]).length === 0) {
          throw new AppError('Drop removed every column.', 400, 'DROP_ALL_COLUMNS');
        }
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
      } else if (fn === 'Select') {
        const keep = ((tx.columns ?? []) as string[]).map(stripBom);
        result = result.map((row) => {
          const out: Record<string, unknown> = {};
          for (const k of keep) out[k] = row[k] ?? null;
          return out;
        });
        if (result.length > 0 && Object.keys(result[0]).length === 0) {
          throw new AppError('Select kept zero columns.', 400, 'VALIDATION_ERROR');
        }
      } else if (fn === 'Sort') {
        const sorts = (tx.sorts ?? []) as Array<{
          column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last';
        }>;
        result = this.applySort(result, sorts);
      } else if (fn === 'DropDuplicates') {
        const keyCols = ((tx.columns ?? null) as string[] | null)?.map(stripBom) ?? null;
        const seen = new Set<string>();
        result = result.filter((row) => {
          let key: string;
          if (keyCols) key = keyCols.map((c) => String(row[c] ?? '')).join('\u0001');
          else key = Object.keys(row).sort().map((k) => `${k}=${row[k] ?? ''}`).join('\u0001');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } else if (fn === 'UppercaseColumnNames') {
        result = result.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) out[k.toUpperCase()] = v;
          return out;
        });
      } else if (fn === 'RowSize') {
        const out = (tx.outputColumn ?? 'row_size') as string;
        result = result.map((row) => ({ ...row, [out]: Buffer.byteLength(JSON.stringify(row), 'utf8') }));
      } else if (fn === 'ApplyExpression') {
        const exprs = collectExpressionItems(tx);
        for (const e of exprs) result = this.applyExpressionToRows(result, e);
      } else if (fn === 'CaseExpression') {
        result = this.applyCaseExpressionToRows(result, tx as unknown as CaseExpressionApplyInput);
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
        for (const e of exprs) result = this.applyExpressionToRows(result, e);
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
          result = this.applyExpressionToRows(result, e);
        }
      } else if (fn === 'ComputeIfExpressionAbsent') {
        const out = tx.outputColumn as string;
        const exprs = collectExpressionItems(tx);
        const e = exprs[0];
        result = result.map((row) => {
          const cur = row[out];
          if (!this.isValueAbsent(cur)) return row;
          const v = evaluateExpression(row, e);
          return { ...row, [out]: castExpressionResult(v, e.outputType) };
        });
      } else if (fn === 'TextBlock') {
        // Text block is pure annotation — pass rows through unchanged.
      } else if (fn === 'Aggregate') {
        result = this.computeAggregations(
          result,
          (tx.groupBy ?? []) as string[],
          (tx.aggregations ?? []) as AggregationItem[],
        );
      } else if (fn === 'Rollup') {
        result = this.computeRollup(
          result,
          (tx.rollupColumns ?? []) as string[],
          (tx.aggregations ?? []) as AggregationItem[],
        );
      } else if (fn === 'AggregateOnCondition') {
        // Rows-only replay: resolve the type predicate against the current
        // row keys (all 'string'-typed here; a predicate on a non-string
        // type matches nothing unless it targets strings or 'all').
        const colNames = result.length ? Object.keys(result[0]) : [];
        const targets = this.resolveOnConditionTargets(
          tx.predicate as ColumnPredicate,
          colNames.map((name) => ({ name, type: 'string' })),
        );
        const aggregations = this.buildOnConditionAggregations(
          targets,
          (tx.aggregations ?? []) as DynamicAggregation[],
        );
        result = this.computeAggregations(result, (tx.groupBy ?? []) as string[], aggregations);
      } else if (fn === 'TopRows') {
        result = this.computeTopRows(
          result,
          (tx.partitionBy ?? []) as string[],
          (tx.sorts ?? []) as Array<{ column: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>,
          (tx.topN ?? 1) as number,
        );
      } else if (fn === 'Pivot') {
        result = this.computePivot(
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
        result = this.computeUnpivot(result, unpivotCols, tx.nameColumn as string, tx.valueColumn as string, kept);
      } else if (fn === 'KeepDuplicates') {
        const subset = ((tx.columns ?? []) as string[]);
        const all = result.length ? Object.keys(result[0]) : [];
        result = this.computeKeepDuplicates(result, subset, all);
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

    // Right-hand operand: literal by default; when valueIsColumn is set the
    // value names another column, so resolve it from the row. A missing
    // right-hand column compares as empty string (never matches eq).
    const rhs = cond.valueIsColumn ? (row[cond.value ?? ''] ?? '') : (cond.value ?? '');

    // Palantir filterV1: "Values that return true are kept, others are
    // removed. Nulls are treated as false." An ordering comparison against a
    // null literal / null right-hand column is therefore false.
    const rhsIsNull =
      cond.value === undefined || cond.value === null ||
      rhs === '' || rhs.toLowerCase() === 'null';

    switch (op) {
      case 'is_null':
        // is_null always treats empty string as null (CSV semantics)
        return isNullValue;

      case 'is_not_null':
        return isNotNullEffective;

      case 'eq':
        return !isNullValue && raw === rhs;

      case 'neq':
        return isNullValue || raw !== rhs;

      // Ordering operators — column-to-column via valueIsColumn, or against a
      // literal. compareOrd coerces numerics first, then falls back to string
      // order; ISO-8601 dates/timestamps sort chronologically under string
      // order, which is what CSV replay gives us here.
      case 'lt':
        return !isNullValue && !rhsIsNull && compareOrd(raw, rhs) < 0;

      case 'lte':
        return !isNullValue && !rhsIsNull && compareOrd(raw, rhs) <= 0;

      case 'gt':
        return !isNullValue && !rhsIsNull && compareOrd(raw, rhs) > 0;

      case 'gte':
        return !isNullValue && !rhsIsNull && compareOrd(raw, rhs) >= 0;

      case 'starts_with':
        return !isNullValue && raw.startsWith(rhs);

      case 'ends_with':
        return !isNullValue && raw.endsWith(rhs);

      case 'contains':
        return !isNullValue && raw.includes(rhs);

      case 'regex_find': {
        if (isNullValue || !cond.value) return false;
        try {
          return new RegExp(rhs).test(raw);
        } catch {
          return false;
        }
      }

      case 'regex_match': {
        if (isNullValue || !cond.value) return false;
        try {
          const re = new RegExp(`^${rhs}$`);
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
  private async resolvePreviewInput(
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
