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
import { defaultMatPortFromEnv } from "./mat/sparkMatAdapter";
import { instrumentMatPort } from "./mat/instrumentedMat";
import type { MatPort } from "./mat/matPort";
import { buildTsBackends, TS_CARD_TYPES } from "./ts/tsBackend";
import { InProcessCodexAdapter } from "./ts/inProcessCodex";
import { instrumentCodexPort } from "./ts/instrumentedCodex";
import type { CodexPort } from "./ts/codexPort";
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
const TS_BOUND_CARD_TYPES = new Set<string>(TS_CARD_TYPES);

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
let injectedCodexPort: CodexPort | undefined;
let cachedCodexPort: CodexPort | undefined;
let cachedRawCodexPort: CodexPort | undefined;

function buildBackendsWithRealAdapters(rawOss: OssPort, rawMat: MatPort, rawCodex: CodexPort): CardBackend[] {
  const ossPort = instrumentOssPort(rawOss);
  const matPort = instrumentMatPort(rawMat);
  const codexPort = instrumentCodexPort(rawCodex);
  cachedRawCodexPort = rawCodex;
  cachedCodexPort = codexPort;
  const stubs = buildAllStubBackends().filter(
    (b) =>
      !OSS_BOUND_CARD_TYPES.has(b.cardType) &&
      !MAT_BOUND_CARD_TYPES.has(b.cardType) &&
      !TS_BOUND_CARD_TYPES.has(b.cardType),
  );
  return [
    ...stubs,
    ...buildOssBackends(ossPort),
    ...buildMatBackends(matPort),
    ...buildTsBackends(codexPort),
  ];
}

export function getComputeContext(): ComputeContext {
  if (cached) return cached;
  const router = new BackendRouter();
  const ossPort = injectedOssPort ?? new InProcessOssAdapter();
  // FOUNDRY-GAPS §1: when LIVY_URL is set the Spark tier submits via Livy
  // (sparkMatAdapter.ts); with the env unset this returns the plain
  // InProcessMatAdapter — zero behavior change for dev/test environments.
  const matPort = injectedMatPort ?? defaultMatPortFromEnv();
  const codexPort = injectedCodexPort ?? new InProcessCodexAdapter();
  for (const b of buildBackendsWithRealAdapters(ossPort, matPort, codexPort)) router.register(b);
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

export function setCodexPortForTests(port: CodexPort | undefined): void {
  injectedCodexPort = port;
  cached = undefined;
  cachedCodexPort = undefined;
  cachedRawCodexPort = undefined;
}

/**
 * Returns the instrumented Codex port currently in use by the compute
 * context — the route layer (compute/timeseries cold-poll) needs this
 * directly, separate from the per-card backend dispatch.
 */
export function getCurrentCodexPort(): CodexPort {
  // Make sure compute context is initialised so the cached ports are populated.
  getComputeContext();
  return cachedCodexPort ?? new InProcessCodexAdapter();
}

/** Same as `getCurrentCodexPort` but returns the *raw* port (no instrumentation
 *  proxy) — useful for tests that need to assert on `calls[]`. */
export function getRawCodexPort(): CodexPort | undefined {
  return cachedRawCodexPort;
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
  codexPort?: CodexPort;
  now?: () => number;
}): () => void {
  const router = new BackendRouter();
  const backends = opts.backends
    ?? buildBackendsWithRealAdapters(
        opts.ossPort ?? new InProcessOssAdapter(),
        opts.matPort ?? new InProcessMatAdapter(),
        opts.codexPort ?? new InProcessCodexAdapter(),
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
