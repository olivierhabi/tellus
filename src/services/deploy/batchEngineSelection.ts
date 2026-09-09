// ---------------------------------------------------------------------------
// Batch engine selection gate (extracted from services/deploymentService.ts
// during the god-file breakup — behavior-preserving move).
//
// Decides whether a deploy should attempt the Trino engine path or fall
// straight through to the in-process + PyIceberg-sidecar build. Kept pure
// (env reads stay at the call site) so the selection policy is unit-testable
// without a coordinator, a catalog, or a database.
// ---------------------------------------------------------------------------

import type { BatchEngineKind } from '../pipelines/computeEngine';

/**
 * Engine path is the default ("auto"): used wherever a real Trino
 * coordinator is configured, else we fall through to the in-process +
 * PyIceberg-sidecar path. Forced "in-process" opts out entirely; forced
 * "trino" always attempts it (tests inject an in-memory engine). The engine
 * path only writes Iceberg outputs — CSV/Parquet outputs never qualify.
 */
export function shouldAttemptEngineBuild(opts: {
  engineMode: BatchEngineKind;
  coordinatorConfigured: boolean;
  outputFormat?: string | null;
}): boolean {
  if (opts.engineMode === 'in-process') return false;
  if (opts.engineMode === 'auto' && !opts.coordinatorConfigured) return false;
  if ((opts.outputFormat ?? 'csv') !== 'iceberg') return false;
  return true;
}
