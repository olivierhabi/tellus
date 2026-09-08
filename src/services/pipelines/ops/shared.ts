// ---------------------------------------------------------------------------
// Shared pure primitives for the pipeline transform ops.
//
// Extracted from transformService.ts (god-file breakup): these are the
// dependency-free building blocks every per-operation module under
// src/services/pipelines/ops/ uses — the binary-expression evaluator, the
// printf-style formatStringV1 implementation, string concatenation, value
// coercion/comparison, CSV header hygiene, and the preview sampling contract.
//
// Everything here is pure (no DB, no object store, no service state) so it
// can be unit tested in isolation and shared by the legacy TS engine, the
// per-op previews, and the chain replay in TransformService.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import { convertValue } from '../../../utils/typeConverter';
import type {
  CastTargetType,
  Operand,
  BinaryOperator,
  ExpressionItem,
  StringOperand,
} from '../../../types/pipeline';

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
export const CONVERTER_TYPE_MAP: Record<CastTargetType, string> = {
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

export function coerceNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function coerceString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function parseLiteral(op: Operand): unknown {
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

export function compareEq(a: unknown, b: unknown): boolean {
  const an = coerceNumeric(a);
  const bn = coerceNumeric(b);
  if (an !== null && bn !== null) return an === bn;
  return coerceString(a) === coerceString(b);
}

export function compareOrd(a: unknown, b: unknown): number {
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
 * Evaluate one binary expression per row. Left/right operands are
 * resolved to row values (kind=column) or to literals (kind=literal).
 */
export function evaluateExpression(
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

/**
 * Coerce an expression result to the requested logical type. Uses the same
 * convertValue path as Cast so chains behave consistently.
 */
export function castExpressionResult(value: unknown, outputType: CastTargetType | undefined): unknown {
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
export function collectExpressionItems(tx: Record<string, unknown>): ExpressionItem[] {
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
export function sampleInfo(rawRowsRead: number): {
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

/** Strip BOM (U+FEFF) and other zero-width characters from a string. */
export function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, '').replace(/\uFEFF/g, '');
}

/**
 * Normalize a column name to lower_snake_case.
 * Mirrors Palantir's normalizeColumnNamesV1 behaviour.
 */
export function normalizeColumnName(name: string, removeSpecial: boolean): string {
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

/**
 * Validates that each `kind: 'column'` operand references a column that exists
 * in `effectiveCols`. Throws VALIDATION_ERROR with the available list.
 */
export function validateExpressionColumns(
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