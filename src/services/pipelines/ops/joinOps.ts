// ---------------------------------------------------------------------------
// Join op (Palantir joinV2) — extracted from transformService.ts.
//
// Contains the pure in-memory join engine (executeJoin), the preview with its
// non-fatal warning surface (type mismatch, zero-match, null-rate, Cartesian
// explosion), and config persistence. IO seams come in via
// TransformOpsContext.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type { JoinPreviewInput, JoinApplyInput, JoinType, JoinOperator } from '../../../types/pipeline';
import {
  buildJoinMatchWarnings,
  coalescedJoinKeyNames,
  compareJoinValues,
} from '../joinMatchRate';
import { PREVIEW_SOURCE_ROW_LIMIT, sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

/**
 * The join execution engine: pure, in-memory, order-preserving.
 *
 * Join types follow Palantir's joinV2 semantics:
 *   - left: keep all left rows, match right where conditions met
 *   - right: keep all right rows, match left where conditions met
 *   - inner: only rows matching in both sides
 *   - full_outer: all rows from both sides
 *   - cross: Cartesian product (no conditions needed), capped at the preview
 *     source-row limit
 *   - semi / anti: existence filter on the left — no right columns surfaced
 *
 * Per Palantir spec: null ≠ null — if either side is null/empty, no match.
 */
export function executeJoin(
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

// ---------------------------------------------------------------------------
// Join — Preview
// ---------------------------------------------------------------------------

/**
 * Preview a Join transform.
 *
 * Reads both left and right datasets from S3, applies prior transforms
 * to the left side, then joins based on conditions and join type.
 */
export async function joinPreview(
  ctx: TransformOpsContext,
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
  let targetNode: { id: string; config: Record<string, unknown> };
  try {
    targetNode = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError('Pipeline node not found. It may have been deleted.', 404, 'NOT_FOUND');
    }
    throw err;
  }
  const targetConfig = targetNode.config;
  const leftSourceNodeId = targetConfig.sourceNodeId as string | undefined;
  const leftData = leftSourceNodeId
    ? await ctx.resolveNodeData(projectId, pipelineId, leftSourceNodeId, input.priorTransforms)
    : null;

  // ── Resolve right dataset ───────────────────────────────────────
  let rightNode: { id: string; config: Record<string, unknown> };
  try {
    rightNode = await ctx.fetchNodeConfig(projectId, pipelineId, input.rightNodeId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError('Right input node not found. It may have been deleted.', 404, 'RIGHT_NODE_NOT_FOUND');
    }
    throw err;
  }

  // Prevent self-join
  if (rightNode.id === nodeId) {
    throw new AppError('Cannot join a node with itself. Select a different right input.', 400, 'SELF_JOIN');
  }

  // Both arms use the same resolver as output previews. This honors the
  // pinned snapshot of an upstream join/union instead of flattening it to a
  // raw dataset and makes the canvas schema match what deploy will execute.
  const rightData = await ctx.resolveNodeData(projectId, pipelineId, input.rightNodeId);
  const fallbackLeft = leftData ?? await ctx.resolveNodeData(
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
  const joinedRows = executeJoin(
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
    await ctx.persistExecutionSnapshot(projectId, pipelineId, nodeId, outputCols, filteredRows);
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

// ---------------------------------------------------------------------------
// Join — Apply (persist config)
// ---------------------------------------------------------------------------

export async function joinApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: JoinApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);

  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
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
  node.config.transforms = transforms;

  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
