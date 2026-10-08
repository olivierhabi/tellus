// ---------------------------------------------------------------------------
// Union ops (Palantir unionV1: first / narrow / wide; N-input unionByName) —
// extracted from transformService.ts.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import { findNearNameMatches, unionSideLabels } from '../../../utils/columnNameReconciler';
import { resolveUnionInputIds } from '../../../types/pipeline';
import type { UnionPreviewInput, UnionApplyInput } from '../../../types/pipeline';
import {
  chainHashFromNodeConfig,
  fingerprintSchema,
} from '../previewSnapshot';
import { PREVIEW_SOURCE_ROW_LIMIT } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

export async function unionPreview(
  ctx: TransformOpsContext,
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
  const left = await ctx.resolveNodeData(projectId, pipelineId, nodeId, input.priorTransforms);
  const others = await Promise.all(
    additionalIds.map((id) => ctx.resolveNodeData(projectId, pipelineId, id)),
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

// ---------------------------------------------------------------------------
// Union — Apply (persist config + atomic snapshot)
// ---------------------------------------------------------------------------

export async function unionApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: UnionApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const config = node.config;

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
  const unionResult = await ctx.unionPreview(projectId, pipelineId, sourceNodeId, {
    rightNodeIds: inputIds,
    mode: config.mode as UnionPreviewInput['mode'],
    limit: 500,
  });
  config.previewSnapshot = {
    columns: unionResult.columns,
    rows: unionResult.rows,
    rowCount: unionResult.rows.length,
    transforms: Array.isArray(config.transforms) ? config.transforms : [],
    // Hash the node's REAL chain + union wiring, never a hardcoded empty
    // chain. `unionApply` is not necessarily the last writer of this node's
    // transforms — a DropDuplicates/Case/... can be appended afterwards — and
    // pinning sha256("[]") here made every such node permanently
    // PREVIEW_STALE at deploy, with no API path able to reconcile it (union
    // preview has no `persist`, and re-applying the union just rewrote the
    // same empty hash). Must stay byte-identical to the reader in
    // previewPinning -> chainHashFromNodeConfig.
    chainHash: chainHashFromNodeConfig(config),
    schemaFingerprint: fingerprintSchema(unionResult.columns),
    nodeId,
    transitiveInputSnapshots: await ctx.walkTransitiveInputs(pipelineId, nodeId),
    savedAt: new Date().toISOString(),
  };

  return ctx.saveNodeConfig(nodeId, pipelineId, config);
}
