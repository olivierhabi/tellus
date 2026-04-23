// ---------------------------------------------------------------------------
// Searcher pool management — Task B8
//
// Holds the registered Quickwit searcher nodes. In production these come
// from Kubernetes endpoint discovery; in development we read them from
// QUICKWIT_SEARCHERS (CSV of `host:port` entries, optional `!secondary`
// suffix to mark as replacement-pipeline targets).
//
// Provides:
//
//   • getPrimaryPool()   — active searchers handling live queries
//   • getSecondaryPool() — pre-warmed searchers (or empty) for cutover
//   • promoteSecondary() — atomically swap primary↔secondary (the last
//     step of a replacement pipeline)
// ---------------------------------------------------------------------------

import { Searcher } from "./searcherTopology";

let primary: Searcher[] = [];
let secondary: Searcher[] = [];
let loaded = false;

const DEFAULT_CACHE_BYTES = 180_000_000_000; // 180 GB — headroom under 200 GB NVMe

function parseEnv(): { primary: Searcher[]; secondary: Searcher[] } {
  const raw = (process.env.QUICKWIT_SEARCHERS ?? "").trim();
  if (!raw) return { primary: [], secondary: [] };
  const primaryOut: Searcher[] = [];
  const secondaryOut: Searcher[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const isSecondary = trimmed.endsWith("!secondary");
    const id = isSecondary ? trimmed.slice(0, -"!secondary".length) : trimmed;
    const s: Searcher = {
      id,
      role: isSecondary ? "secondary" : "primary",
      cacheBytes: DEFAULT_CACHE_BYTES,
    };
    (isSecondary ? secondaryOut : primaryOut).push(s);
  }
  return { primary: primaryOut, secondary: secondaryOut };
}

function ensureLoaded(): void {
  if (loaded) return;
  const parsed = parseEnv();
  primary = parsed.primary;
  secondary = parsed.secondary;
  loaded = true;
}

export function getPrimaryPool(): Searcher[] {
  ensureLoaded();
  return [...primary];
}

export function getSecondaryPool(): Searcher[] {
  ensureLoaded();
  return [...secondary];
}

/**
 * Replace the active (primary) pool with the pre-warmed (secondary) pool.
 * Used as the last step of a replacement pipeline: Hydration ran the
 * prefetch against `secondary`, queries now route there instead.
 *
 * The previous primary pool is demoted to secondary so it can be warmed
 * for the next cutover (or cleanly de-provisioned).
 */
export function promoteSecondary(): { promoted: Searcher[]; demoted: Searcher[] } {
  ensureLoaded();
  const promoted = secondary.map((s) => ({ ...s, role: "primary" as const }));
  const demoted = primary.map((s) => ({ ...s, role: "secondary" as const }));
  primary = promoted;
  secondary = demoted;
  return { promoted, demoted };
}

/** Overwrite the pools directly. Used by dynamic discovery and tests. */
export function setPools(input: { primary: Searcher[]; secondary?: Searcher[] }): void {
  primary = input.primary;
  secondary = input.secondary ?? [];
  loaded = true;
}

export function __resetSearcherPoolsForTesting(): void {
  primary = [];
  secondary = [];
  loaded = true; // keep loaded=true so getPrimaryPool() returns [] without re-reading env
}
