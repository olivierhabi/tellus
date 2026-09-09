// ---------------------------------------------------------------------------
// Cast op (Palantir castV2) — extracted from transformService.ts.
//
// Contains the column-date-sniffing options builder, the lenient row-level
// cast application (shared by the preview and the chain replay), the output
// column metadata builder, and the preview/apply entry points. IO seams
// (input resolution, node config persistence) come in via TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import { convertValue, inferDateFormat } from '../../../utils/typeConverter';
import type { CastTargetType, CastPreviewInput, CastApplyInput } from '../../../types/pipeline';
import {
  CONVERTER_TYPE_MAP,
  sampleInfo,
  stripBom,
} from './shared';
import type { TransformOpsContext } from './transformOpsContext';

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
export function castOptionsForColumn(
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
 * Lenient per-row cast with failure telemetry. Failed casts become null
 * (Palantir behaviour) — but the FIRST failure reason and a truncated sample
 * of the offending value are reported so "N of N values could not be cast" is
 * debuggable (unsupported input shape vs. genuinely not of that type).
 */
export function castRows(
  rows: Array<Record<string, unknown>>,
  sourceCol: string,
  outputCol: string,
  converterType: string,
  castOptions: { coerce: true; dateFormat?: 'dmy' | 'mdy' },
): {
  rows: Array<Record<string, unknown>>;
  castErrors: number;
  castErrorReason: string | undefined;
  castErrorSample: string | undefined;
} {
  let castErrors = 0;
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

    return { ...row, [outputCol]: castValue };
  });
  return { rows: transformedRows, castErrors, castErrorReason, castErrorSample };
}

/**
 * The chain-replay variant: same lenient cast, no telemetry (the replay path
 * has no channel to report it on).
 */
export function applyCastToRows(
  rows: Array<Record<string, unknown>>,
  sourceCol: string,
  outputCol: string,
  converterType: string,
): Array<Record<string, unknown>> {
  const castOptions = castOptionsForColumn(rows, sourceCol, converterType);
  return castRows(rows, sourceCol, outputCol, converterType, castOptions).rows;
}

/**
 * Build output column metadata.
 *
 * If the output column replaces an existing one, its type is updated.
 * If it's a new column, it's appended with isNew: true.
 */
export function buildOutputColumns(
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
export async function castPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: CastPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(
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
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  if (!effectiveCols.some((c) => stripBom(c.name) === sourceCol)) {
    throw new AppError(
      `Column "${sourceCol}" does not exist. Available: ${effectiveCols.map((c) => c.name).join(', ')}`,
      400,
      'VALIDATION_ERROR',
    );
  }

  // Read CSV rows from S3, then replay prior transforms in the chain
  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms)
    .slice(0, input.limit);

  // Build effective column metadata reflecting any prior Cast transforms
  const effectiveColumns = ctx.applyExistingTransformColumns(
    sourceColumns,
    chainTransforms,
  );

  // Apply the Cast transform
  const castOptions = castOptionsForColumn(rows, sourceCol, converterType);
  const { rows: transformedRows, castErrors, castErrorReason, castErrorSample } =
    castRows(rows, sourceCol, outputCol, converterType, castOptions);

  // Build output column metadata using effective columns (which include
  // type changes from prior Cast transforms in the chain)
  const outputColumns = buildOutputColumns(
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

/**
 * Persist a Cast transform configuration into the pipeline node.
 *
 * Appends the cast spec to the node's config.transforms array.
 * This is configuration-only — no data is transformed. The saved
 * config is used during pipeline builds to materialise the transform.
 */
export async function castApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: CastApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);

  const transforms: unknown[] = Array.isArray(node.config.transforms)
    ? node.config.transforms
    : [];

  transforms.push({
    function: 'Cast',
    expression: input.expression,
    targetType: input.targetType,
    outputColumn: input.outputColumn ?? input.expression,
    createdAt: new Date().toISOString(),
  });

  node.config.transforms = transforms;

  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
