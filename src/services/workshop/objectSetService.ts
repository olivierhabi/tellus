// =============================================================================
// B05 — Workshop Object-Set Load Proxy
//
// Spec §B05 acceptance: forwards executionMode, snapshotConsistency, branch
// and JWT verbatim. Per-user 100 req/s rate limit. P95 ≤ 800ms for pageSize
// ≤ 1000. Default OSS timeout 20s.
//
// This service:
//   1. Validates filter list against object-type schema (B07 compiler)
//   2. Compiles filters → predicate tree (B07)
//   3. Forwards to OSS adapter (D-02)
//   4. Records branch + JWT propagation (§0.5, §0.6)
// =============================================================================

import { getOss, type OssLoadRequest, type OssLoadResponse, type OssRequestContext } from "./ossAdapter.js";
import {
  compileFilters,
  type FilterValueIn,
  type PropertyType,
} from "./filterCompiler.js";
import { workshopError } from "./errors.js";
import { histObjectSetLoad, counterObjectSetLoad } from "./metrics.js";
import {
  withTimeout,
  withCircuit,
  getOssTimeoutMs,
} from "./timeouts.js";
export { setOssTimeoutMs, getOssTimeoutMs } from "./timeouts.js";

export interface LoadObjectSetRequest {
  ontologyRid: string;
  objectTypeApiName: string;
  /** Schema for filter type-checking. property name → type. */
  schema: Readonly<Record<string, PropertyType>>;
  filters: ReadonlyArray<FilterValueIn>;
  pageSize: number;
  pageToken?: string | null;
  orderBy?: ReadonlyArray<{ field: string; direction: "asc" | "desc" }>;
  executionMode?: "PREFER_ACCURACY" | "PREFER_SPEED" | null;
  snapshotConsistency?: "EVENTUAL" | "STRONG" | null;
}

export const MAX_PAGE_SIZE = 10_000;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Loads an object set with the given filters. Rejects pageSize <= 0 or > 10k
 * (per B05 SLO note that >1000 downgrades; we hard-cap at 10k to bound load).
 */
export async function loadObjectSet(
  req: LoadObjectSetRequest,
  ctx: OssRequestContext,
): Promise<OssLoadResponse> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    return await _loadObjectSetInner(req, ctx);
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histObjectSetLoad.observe({ result }, ns / 1e9);
    counterObjectSetLoad.inc({ status: result }, 1);
  }
}

async function _loadObjectSetInner(
  req: LoadObjectSetRequest,
  ctx: OssRequestContext,
): Promise<OssLoadResponse> {
  if (req.pageSize <= 0 || !Number.isFinite(req.pageSize)) {
    throw workshopError({
      errorName: "Tellus:Workshop:InvalidPageSize",
      status: 400,
      parameters: { pageSize: req.pageSize },
    });
  }
  if (req.pageSize > MAX_PAGE_SIZE) {
    throw workshopError({
      errorName: "Tellus:Workshop:PageSizeTooLarge",
      status: 400,
      parameters: { pageSize: req.pageSize, max: MAX_PAGE_SIZE },
    });
  }

  // Compile filters (B07)
  const predicate = compileFilters(req.filters, { properties: req.schema });

  const ossReq: OssLoadRequest = {
    ontologyRid: req.ontologyRid,
    objectTypeApiName: req.objectTypeApiName,
    predicate,
    pageSize: req.pageSize,
    pageToken: req.pageToken ?? null,
    orderBy: req.orderBy ?? [],
    executionMode: req.executionMode ?? null,
    snapshotConsistency: req.snapshotConsistency ?? null,
  };

  return await withCircuit("oss", () =>
    withTimeout(getOss().load(ossReq, ctx), getOssTimeoutMs(), "oss"),
  );
}
