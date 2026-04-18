// ---------------------------------------------------------------------------
// Hydration activity — Task B8
//
// Reproduces Palantir's "download index files to search node disks" step
// using Quickwit's split-cache prefetch API. The activity:
//
//   1. Reads the list of splits Quickwit published in the preceding
//      Indexing activity (the caller passes these in — hydration never
//      polls the metastore, that's the Indexing activity's job).
//   2. Projects them onto the current searcher pool (primary by default,
//      secondary when `mode='replacement'`) via rendezvous hashing, so
//      each split is pre-warmed on the exact node that will serve it.
//   3. Issues one prefetch call per split, batched by target searcher.
//
// The result carries the (split, searcher) placement so callers can
// correlate with observed query latency in Grafana / the reindex status
// endpoint.
// ---------------------------------------------------------------------------

import { getQuickwitClient, QuickwitClient } from "./client";
import {
  getPrimaryPool,
  getSecondaryPool,
  promoteSecondary,
} from "./searcherPool";
import {
  Searcher,
  SplitPlacement,
  groupBySearcher,
  planPlacement,
} from "./searcherTopology";

export type HydrationMode = "live" | "replacement";

export interface HydrationActivityInput {
  objectTypeApiName: string;
  /** Splits the Indexing activity just published. */
  splitIds: string[];
  /**
   * "live"        — prefetch against the active searchers (refresh after
   *                 normal index tick).
   * "replacement" — prefetch against the secondary pool; caller promotes
   *                 after prefetch succeeds.
   */
  mode?: HydrationMode;
  /** If true, auto-promote secondary → primary after prefetch. */
  autoPromote?: boolean;
  /** Override pool list — used by tests. */
  searchers?: Searcher[];
  /** Inject a test client. */
  client?: QuickwitClient;
}

export interface HydrationActivityResult {
  objectTypeApiName: string;
  mode: HydrationMode;
  placements: SplitPlacement[];
  prefetchedSplitCount: number;
  perSearcherPlan: Array<{ searcherId: string; splitCount: number }>;
  promoted: boolean;
  durationMs: number;
}

const QUICKWIT_INDEX_PREFIX = "ot_";

// ---------------------------------------------------------------------------
// runHydrationActivity()
// ---------------------------------------------------------------------------

export async function runHydrationActivity(
  input: HydrationActivityInput
): Promise<HydrationActivityResult> {
  const started = Date.now();
  const mode: HydrationMode = input.mode ?? "live";
  const client = input.client ?? getQuickwitClient();
  const indexId = toIndexId(input.objectTypeApiName);

  const searchers =
    input.searchers ??
    (mode === "replacement" ? getSecondaryPool() : getPrimaryPool());

  if (searchers.length === 0) {
    // Hydration is a best-effort warm step — if no searchers are known we
    // log and return. Queries will still work, they'll just pay one-time
    // S3 range-GET latency (the B8 "cold" path).
    console.warn(
      `[quickwit hydration] no ${mode} searchers registered — skipping prefetch`
    );
    return {
      objectTypeApiName: input.objectTypeApiName,
      mode,
      placements: [],
      prefetchedSplitCount: 0,
      perSearcherPlan: [],
      promoted: false,
      durationMs: Date.now() - started,
    };
  }

  const placements = planPlacement(input.splitIds, searchers);
  const perSearcher = groupBySearcher(placements);

  // Prefetch in parallel across searchers. Quickwit's prefetch endpoint is
  // idempotent, so retries on partial failure are safe.
  await Promise.all(
    Array.from(perSearcher.entries()).map(async ([, splits]) => {
      try {
        await client.prefetchSplits(indexId, splits);
      } catch (err) {
        console.warn(
          `[quickwit hydration] prefetch failed on some splits ` +
            `(${splits.length} splits, error: ${(err as Error).message})`
        );
      }
    })
  );

  const promoted = mode === "replacement" && input.autoPromote === true;
  if (promoted) {
    promoteSecondary();
  }

  return {
    objectTypeApiName: input.objectTypeApiName,
    mode,
    placements,
    prefetchedSplitCount: placements.length,
    perSearcherPlan: Array.from(perSearcher.entries()).map(([id, splits]) => ({
      searcherId: id,
      splitCount: splits.length,
    })),
    promoted,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// toIndexId — duplicate of docMapping.getQuickwitIndexId to keep this
// module decoupled from that one for tree-shaking in the Temporal worker.
// ---------------------------------------------------------------------------

function toIndexId(apiName: string): string {
  const sanitized = apiName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${QUICKWIT_INDEX_PREFIX}${sanitized}`;
}
