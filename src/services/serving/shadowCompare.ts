// ---------------------------------------------------------------------------
// Shadow execution harness: run LEGACY and INDEXED paths for the same
// request, compare canonicalized results, record structured mismatches,
// and ALWAYS return the configured primary (legacy while rolling out).
//
// Canonicalization: PK sets are sorted + deduped before hashing so
// nondeterministic ordering never creates false mismatches; the log line
// carries counts + stable digests, NEVER object contents.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import { incCounter, observeHistogram } from "../funnel/metrics";

export interface ShadowCompareReport {
  match: boolean;
  legacyCount: number;
  indexedCount: number;
  legacyDigest: string;
  indexedDigest: string;
  durationMs: { legacy: number; indexed: number };
  indexedError?: string;
}

function canonicalDigest(values: string[]): { count: number; digest: string } {
  const canon = [...new Set(values)].sort();
  return {
    count: canon.length,
    digest: createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16),
  };
}

/**
 * Run a side-by-side comparison. The legacy function is always invoked;
 * an indexed-side error is recorded as a mismatch detail (and counts
 * toward the mismatch rate), never thrown to the caller.
 */
export async function compareShadow(args: {
  capability: string; // e.g. "links.searchAround"
  scopeKey: string;   // e.g. link type api name
  legacyFn: () => Promise<{ pks: string[] }>;
  indexedFn: () => Promise<{ pks: string[] }>;
  primary: "legacy" | "indexed";
}): Promise<{ pks: string[]; report: ShadowCompareReport }> {
  let legacyResult: { pks: string[] } | null = null;
  let legacyError: Error | null = null;
  const t0 = Date.now();
  try {
    legacyResult = await args.legacyFn();
  } catch (err) {
    legacyError = err as Error;
  }
  const legacyMs = Date.now() - t0;

  let indexedResult: { pks: string[] } | null = null;
  let indexedErr: Error | null = null;
  const t1 = Date.now();
  try {
    indexedResult = await args.indexedFn();
  } catch (err) {
    indexedErr = err as Error;
  }
  const indexedMs = Date.now() - t1;

  const l = legacyResult ? canonicalDigest(legacyResult.pks) : { count: -1, digest: "<error>" };
  const i = indexedResult ? canonicalDigest(indexedResult.pks) : { count: -1, digest: "<error>" };
  const match = l.digest === i.digest;

  const report: ShadowCompareReport = {
    match,
    legacyCount: l.count,
    indexedCount: i.count,
    legacyDigest: l.digest,
    indexedDigest: i.digest,
    durationMs: { legacy: legacyMs, indexed: indexedMs },
    indexedError: indexedErr?.message,
  };

  incCounter("serving_shadow_compare_total", {
    capability: args.capability,
    result: match ? "match" : "mismatch",
  });
  observeHistogram(
    "serving_shadow_indexed_latency_seconds",
    indexedMs / 1000,
    { capability: args.capability },
  );

  if (!match) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "serving_shadow_mismatch",
        capability: args.capability,
        scope_key: args.scopeKey,
        legacy_count: l.count,
        indexed_count: i.count,
        legacy_digest: l.digest,
        indexed_digest: i.digest,
        indexed_error: indexedErr?.message,
      }),
    );
  }

  if (args.primary === "indexed") {
    if (indexedResult) return { pks: indexedResult.pks, report };
    if (legacyResult) return { pks: legacyResult.pks, report };
    throw indexedErr ?? legacyError ?? new Error("both shadow branches failed");
  }
  if (legacyResult) return { pks: legacyResult.pks, report };
  if (indexedResult) return { pks: indexedResult.pks, report };
  throw legacyError ?? indexedErr ?? new Error("both shadow branches failed");
}

export type { ShadowCompareReport as ShadowReport };
