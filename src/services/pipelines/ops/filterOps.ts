// ---------------------------------------------------------------------------
// Filter op (Palantir filterV1) — extracted from transformService.ts.
//
// Contains the single-condition evaluator (string-based, CSV semantics for
// null) and the row-filter application shared by the preview and the chain
// replay, plus the preview/apply entry points. IO seams come in via
// TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type { FilterPreviewInput, FilterApplyInput, FilterCondition, FilterOperator } from '../../../types/pipeline';
import { compareOrd, sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

/**
 * Evaluate a single filter condition against a row.
 *
 * All comparisons are string-based since CSV data is strings.
 * Null = undefined, empty string, or literal "null"/"NULL".
 */
export function evaluateCondition(
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

/**
 * Apply a Filter to rows: values are stringified for comparison (CSV
 * semantics), conditions combined by `match` (all=AND, any=OR), and matching
 * rows are kept or removed per `mode`.
 */
export function applyFilterRows(
  rows: Array<Record<string, unknown>>,
  mode: 'keep' | 'remove',
  match: 'all' | 'any',
  conditions: FilterCondition[],
): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const stringRow = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v == null ? '' : String(v)]),
    );
    const results = conditions.map((cond) =>
      evaluateCondition(stringRow, cond),
    );
    const matches =
      match === 'all'
        ? results.every(Boolean)
        : results.some(Boolean);
    return mode === 'keep' ? matches : !matches;
  });
}

/**
 * Preview a Filter transform.
 *
 * Reads rows from the source CSV, evaluates each condition against each
 * row, and returns only the rows that match (mode=keep) or don't match
 * (mode=remove) based on the match logic (all=AND, any=OR).
 */
export async function filterPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: FilterPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(
    projectId,
    pipelineId,
    nodeId,
  );

  // Prefer priorTransforms sent in the request body (the frontend knows
  // the full panel chain) over the transforms persisted on the node.
  const chainTransforms = input.priorTransforms ?? existingTransforms;

  // Validate against effective columns (after prior transforms like Normalize)
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
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
  const allRows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  // Apply filter — convert rows to string for comparison
  const filtered = applyFilterRows(allRows, input.mode, input.match, input.conditions);

  // Apply limit
  const rows = filtered.slice(0, input.limit);

  // Build column metadata that reflects any prior Cast transforms so the
  // output table shows cumulative column types (e.g. Cast→Filter).
  const effectiveColumns = ctx.applyExistingTransformColumns(
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

export async function filterApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: FilterApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);

  const transforms: unknown[] = Array.isArray(node.config.transforms)
    ? node.config.transforms
    : [];

  transforms.push({
    function: 'Filter',
    mode: input.mode,
    match: input.match,
    conditions: input.conditions,
    createdAt: new Date().toISOString(),
  });

  node.config.transforms = transforms;

  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
