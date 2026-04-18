// ---------------------------------------------------------------------------
// Searcher topology — Task B8
//
// Quickwit itself uses rendezvous (HRW) hashing to route a given split's
// queries to the same searcher consistently — we re-implement it here so
// the hydration activity can enumerate which searcher will own which split
// and target it for pre-warm. The algorithm:
//
//   • for every split, score each searcher as `weight * hash(split_id,
//     searcher_id)`
//   • pick the searcher with the highest score
//
// With no weighting (all searchers equal), this collapses to HRW hashing,
// which is minimally-disruptive on cluster membership changes: adding or
// removing one node re-maps only `1/n` of splits.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";

export interface Searcher {
  id: string;
  /**
   * Role: "primary" for the main pool, "secondary" when provisioned as the
   * pre-warm target for a replacement pipeline cutover (see B8 spec).
   */
  role?: "primary" | "secondary";
  /** Usable cache capacity in bytes. Default 180 GB (B8 spec). */
  cacheBytes?: number;
  /** Relative weight for the HRW score. Default 1. */
  weight?: number;
}

export interface SplitPlacement {
  splitId: string;
  searcherId: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Hash & score
// ---------------------------------------------------------------------------

function hash64(...parts: string[]): bigint {
  // SHA-256 first 8 bytes, big-endian. Stable across Node versions; we use
  // it for routing, not cryptography.
  const buf = createHash("sha256").update(parts.join("|")).digest();
  let acc = 0n;
  for (let i = 0; i < 8; i++) {
    acc = (acc << 8n) | BigInt(buf[i]);
  }
  return acc;
}

function score(split: string, searcher: Searcher): number {
  const h = hash64(split, searcher.id);
  // Map 64-bit integer to [0,1) then scale by weight. Plain division in JS
  // is fine — we only need a stable ordering, not cryptographic precision.
  const unit = Number(h) / Number(0xffffffffffffffffn);
  const w = searcher.weight ?? 1;
  return w * unit;
}

// ---------------------------------------------------------------------------
// routeSplit() — pick the single searcher that owns this split
// ---------------------------------------------------------------------------

export function routeSplit(splitId: string, searchers: Searcher[]): Searcher | null {
  let best: Searcher | null = null;
  let bestScore = -Infinity;
  for (const s of searchers) {
    const sc = score(splitId, s);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// planPlacement() — enumerate the (split, searcher) pairs
// ---------------------------------------------------------------------------

export function planPlacement(
  splitIds: string[],
  searchers: Searcher[]
): SplitPlacement[] {
  if (searchers.length === 0) return [];
  const out: SplitPlacement[] = [];
  for (const splitId of splitIds) {
    const pick = routeSplit(splitId, searchers);
    if (pick) out.push({ splitId, searcherId: pick.id, score: score(splitId, pick) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// groupBySearcher() — inverse index used by the prefetch driver
// ---------------------------------------------------------------------------

export function groupBySearcher(placements: SplitPlacement[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of placements) {
    const bucket = out.get(p.searcherId);
    if (bucket) bucket.push(p.splitId);
    else out.set(p.searcherId, [p.splitId]);
  }
  return out;
}
