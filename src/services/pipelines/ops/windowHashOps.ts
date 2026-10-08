// ---------------------------------------------------------------------------
// Hash sha256 (sha256V1) and Window (windowV1) ops.
//
// Both are Palantir parity targets researched from the public function docs:
//   - https://www.palantir.com/docs/foundry/pb-functions-expression/sha256V1
//     "Hashes the input using sha256 hashing algorithm." One
//     Expression<Binary | String>, output String, supported Batch/Faster/
//     Streaming, documented example `null -> null` (NULL-PROPOGATING).
//   - https://www.palantir.com/docs/foundry/pb-functions-transform/windowV1
//     "Performs the specified aggregations on the input dataset grouped by a
//     set of columns." Batch/Faster. Row cardinality is preserved — each
//     aggregation is an analytic aggregate over the partition.
//
// The preview path runs in the legacy in-heap engine, so it evaluates the
// same semantics the DuckDB compiler emits, rather than delegating.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { AppError } from '../../../utils/foundryAppError';
import type {
  AggregationItem,
  HashSha256ApplyInput,
  HashSha256PreviewInput,
  WindowApplyInput,
  WindowPreviewInput,
} from '../../../types/pipeline';
import { coerceNumeric, sampleInfo } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Hash sha256
// ---------------------------------------------------------------------------

/**
 * Value-level sha256 with Palantir's null propagation. `undefined` and `''`
 * are NOT conflated: an empty string hashes the empty string, exactly as
 * DuckDB's sha256('') does.
 */
export function sha256Value(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Buffer.isBuffer(v)) {
    // Binary input (Buffer/Uint8Array) hashes its bytes; anything else is
    // stringified the way a DuckDB VARCHAR cast would render it.
    if (ArrayBuffer.isView(v)) {
      return createHash('sha256')
        .update(Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength))
        .digest('hex');
    }
    return createHash('sha256').update(JSON.stringify(v), 'utf-8').digest('hex');
  }
  return createHash('sha256')
    .update(typeof v === 'string' ? v : String(v), 'utf-8')
    .digest('hex');
}

export function applyHashSha256ToRows(
  rows: Array<Record<string, unknown>>,
  expression: string,
  outputColumn: string,
): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row, [outputColumn]: sha256Value(row[expression]) }));
}

export async function hashSha256Preview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: HashSha256PreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } =
    await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  ctx.assertColumnsExist(
    new Set(effectiveCols.map((c) => c.name)),
    [input.expression],
    'HashSha256',
  );

  const rows = applyHashSha256ToRows(
    ctx.applyExistingTransforms(rawRows, chainTransforms),
    input.expression,
    input.outputColumn,
  ).slice(0, input.limit);

  const base = effectiveCols.map((c) => ({ name: c.name, type: c.type }));
  const exists = base.some((c) => c.name === input.outputColumn);
  const columns = exists
    ? base.map((c) => (c.name === input.outputColumn ? { ...c, type: 'string' } : c))
    : [...base, { name: input.outputColumn, type: 'string', isNew: true }];

  return {
    columns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    hashSha256Summary: `sha256("${input.expression}") -> "${input.outputColumn}"`,
  };
}

export async function hashSha256Apply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: HashSha256ApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'HashSha256',
    expression: input.expression,
    outputColumn: input.outputColumn,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Group row INDICES by the `partitionBy` values, preserving input order both
 * within a bucket and across buckets (the caller re-emits by index).
 */
function partitionRowIndexes(
  rows: Array<Record<string, unknown>>,
  partitionBy: string[],
): number[][] {
  if (partitionBy.length === 0) return [rows.map((_, i) => i)];
  const buckets = new Map<string, number[]>();
  rows.forEach((row, i) => {
    // NULL is its own group and must not collide with the literal string
    // "null" — SQL PARTITION BY groups NULLs together but apart from text.
    const key = partitionBy
      .map((c) => {
        const v = row[c];
        return v === null || v === undefined ? '\u0000NULL' : String(v);
      })
      .join('\u0001');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  });
  return [...buckets.values()];
}

/** Evaluate one aggregation over a whole partition. */
function evalWindowAggregation(
  item: AggregationItem,
  rows: Array<Record<string, unknown>>,
): unknown {
  const col = item.column;
  switch (item.function) {
    case 'count': {
      if (!col) return rows.length;
      return rows.reduce((n, r) => (r[col] === null || r[col] === undefined || r[col] === '' ? n : n + 1), 0);
    }
    case 'count_distinct': {
      const seen = new Set<string>();
      for (const r of rows) {
        const v = r[col as string];
        if (v !== null && v !== undefined) seen.add(String(v));
      }
      return seen.size;
    }
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'stddev':
    case 'variance': {
      const nums = rows
        .map((r) => coerceNumeric(r[col as string]))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      switch (item.function) {
        case 'sum': return nums.reduce((a, b) => a + b, 0);
        case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'min': return Math.min(...nums);
        case 'max': return Math.max(...nums);
        case 'variance': {
          const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
          return nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1);
        }
        case 'stddev': {
          const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
          return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1));
        }
      }
      return null;
    }
    default:
      throw new AppError(`Unsupported window aggregation '${item.function}'`, 400, 'VALIDATION_ERROR');
  }
}

/**
 * Attach each partition's aggregate to every row of that partition. Input row
 * order is preserved and row count is unchanged (the defining difference from
 * Aggregate).
 */
export function applyWindowToRows(
  rows: Array<Record<string, unknown>>,
  input: Pick<WindowApplyInput, 'partitionBy' | 'aggregations'>,
): Array<Record<string, unknown>> {
  // Write into a slot array indexed by the ORIGINAL row position, so output
  // order is byte-identical to input order — a window transform must not
  // permute rows (an unordered GROUP BY would have).
  const slots: Array<Record<string, unknown>> = new Array(rows.length);
  for (const idxs of partitionRowIndexes(rows, input.partitionBy ?? [])) {
    // Computed once per partition and written to each of its rows, so an
    // unordered window is still deterministic in value.
    const part = idxs.map((i) => rows[i]);
    const computed = input.aggregations.map((a) => ({
      column: a.outputColumn,
      value: evalWindowAggregation(a, part),
    }));
    for (const i of idxs) {
      const next = { ...rows[i] };
      for (const c of computed) next[c.column] = c.value;
      slots[i] = next;
    }
  }
  return slots;
}

export async function windowPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: WindowPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } =
    await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const names = effectiveCols.map((c) => c.name);
  ctx.assertColumnsExist(new Set(names), input.partitionBy ?? [], 'Window');
  for (const a of input.aggregations) {
    if (a.column) ctx.assertColumnsExist(new Set(names), [a.column], 'Window');
  }

  const base = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = applyWindowToRows(base, input).slice(0, input.limit);

  const columns: Array<{ name: string; type: string }> = effectiveCols.map((c) => ({
    name: c.name,
    type: c.type,
  }));
  for (const a of input.aggregations) {
    if (!columns.some((c) => c.name === a.outputColumn)) {
      const srcType = a.column
        ? effectiveCols.find((c) => c.name === a.column)?.type
        : undefined;
      columns.push({
        name: a.outputColumn,
        type:
          a.function === 'count' || a.function === 'count_distinct'
            ? 'integer'
            : a.function === 'avg' || a.function === 'stddev' || a.function === 'variance'
              ? 'double'
              : (srcType ?? 'double'),
      });
    }
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    windowSummary:
      `${input.aggregations.length} aggregation(s) over partition [${(input.partitionBy ?? []).join(', ') || 'all rows'}]`,
  };
}

export async function windowApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: WindowApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Window',
    partitionBy: input.partitionBy ?? [],
    orderBy: input.orderBy ?? [],
    aggregations: input.aggregations,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}