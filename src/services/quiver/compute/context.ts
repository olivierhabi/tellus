/**
 * B5 — Compute coordinator singleton context.
 *
 * Lazily builds the BackendRouter, CacheRepository, and ComputeExecutor on
 * first use. Tests can override via `setComputeContextForTests` (used by
 * the chaos / SLO tests to inject deterministic stubs).
 */

import { pool } from "../../../db";
import { BackendRouter } from "./backendRouter";
import { CacheRepository } from "./cache";
import { ComputeExecutor } from "./executor";
import { buildAllStubBackends } from "./stubBackends";
import { buildOssBackends } from "./oss/ossBackend";
import { InProcessOssAdapter } from "./oss/inProcessOss";
import { instrumentOssPort } from "./oss/instrumentedOss";
import type { OssPort } from "./oss/ossPort";
import type { CardBackend } from "./types";
import type { AnalysisDocument } from "../types";

const OSS_BOUND_CARD_TYPES = new Set([
  "OBJECT_SET",
  "FILTER_OBJECT_SET",
  "SEARCH_AROUND",
  "AGGREGATION",
  "PROPERTY_VALUE_SELECT",
  "ACTION_BUTTON",
]);

export interface ComputeContext {
  router: BackendRouter;
  cache: CacheRepository;
  executor: ComputeExecutor;
}

let cached: ComputeContext | undefined;

/** v1 ontology resolver — returns a deterministic per-branch token.
 *  In production this calls the ontology metadata service; for B5 the
 *  stable token is sufficient and B6/B7/B8 will swap in the real call. */
async function defaultOntologyVersion(_analysisRid: string, branch: string): Promise<string> {
  // Echo of the branch name keeps cache keys stable per branch and cheap to derive.
  return `ontology@${branch}`;
}

/** v1 parameter dependency resolver — empty until F5 wires real bindings. */
function defaultParameterDeps(_cardId: string, _doc: AnalysisDocument): string[] {
  return [];
}

let injectedOssPort: OssPort | undefined;

function buildBackendsWithOss(rawPort: OssPort): CardBackend[] {
  // Take stub backends, then replace OSS-bound ones with real OssBackend instances
  // wrapped through the metrics-instrumentation proxy.
  const ossPort = instrumentOssPort(rawPort);
  const all = buildAllStubBackends().filter((b) => !OSS_BOUND_CARD_TYPES.has(b.cardType));
  return [...all, ...buildOssBackends(ossPort)];
}

export function getComputeContext(): ComputeContext {
  if (cached) return cached;
  const router = new BackendRouter();
  const ossPort = injectedOssPort ?? new InProcessOssAdapter();
  for (const b of buildBackendsWithOss(ossPort)) router.register(b);
  const cache = new CacheRepository(pool);
  const executor = new ComputeExecutor({
    router,
    cache,
    ontologyVersionResolver: defaultOntologyVersion,
    parameterDependencies: defaultParameterDeps,
  });
  cached = { router, cache, executor };
  return cached;
}

export function setOssPortForTests(port: OssPort | undefined): void {
  injectedOssPort = port;
  cached = undefined;
}

/**
 * Test override — injects a custom backend list and/or resolver.
 * Returns a teardown closure that resets the cache to defaults.
 */
export function setComputeContextForTests(opts: {
  backends?: CardBackend[];
  ontologyVersionResolver?: (analysisRid: string, branch: string) => Promise<string>;
  parameterDependencies?: (cardId: string, doc: AnalysisDocument) => string[];
  ossPort?: OssPort;
  now?: () => number;
}): () => void {
  const router = new BackendRouter();
  const backends = opts.backends
    ?? buildBackendsWithOss(opts.ossPort ?? new InProcessOssAdapter());
  for (const b of backends) router.register(b);
  const cache = new CacheRepository(pool);
  const executor = new ComputeExecutor({
    router,
    cache,
    ontologyVersionResolver: opts.ontologyVersionResolver ?? defaultOntologyVersion,
    parameterDependencies: opts.parameterDependencies ?? defaultParameterDeps,
    now: opts.now,
  });
  cached = { router, cache, executor };
  return () => {
    cached = undefined;
  };
}

export function resetComputeContext(): void {
  cached = undefined;
}
