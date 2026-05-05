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
import { buildMatBackends, MAT_CARD_TYPES } from "./mat/matBackend";
import { InProcessMatAdapter } from "./mat/inProcessMat";
import { instrumentMatPort } from "./mat/instrumentedMat";
import type { MatPort } from "./mat/matPort";
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

const MAT_BOUND_CARD_TYPES = new Set<string>(MAT_CARD_TYPES);

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
let injectedMatPort: MatPort | undefined;

function buildBackendsWithRealAdapters(rawOss: OssPort, rawMat: MatPort): CardBackend[] {
  const ossPort = instrumentOssPort(rawOss);
  const matPort = instrumentMatPort(rawMat);
  const stubs = buildAllStubBackends().filter(
    (b) => !OSS_BOUND_CARD_TYPES.has(b.cardType) && !MAT_BOUND_CARD_TYPES.has(b.cardType),
  );
  return [...stubs, ...buildOssBackends(ossPort), ...buildMatBackends(matPort)];
}

export function getComputeContext(): ComputeContext {
  if (cached) return cached;
  const router = new BackendRouter();
  const ossPort = injectedOssPort ?? new InProcessOssAdapter();
  const matPort = injectedMatPort ?? new InProcessMatAdapter();
  for (const b of buildBackendsWithRealAdapters(ossPort, matPort)) router.register(b);
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

export function setMatPortForTests(port: MatPort | undefined): void {
  injectedMatPort = port;
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
  matPort?: MatPort;
  now?: () => number;
}): () => void {
  const router = new BackendRouter();
  const backends = opts.backends
    ?? buildBackendsWithRealAdapters(
        opts.ossPort ?? new InProcessOssAdapter(),
        opts.matPort ?? new InProcessMatAdapter(),
      );
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
