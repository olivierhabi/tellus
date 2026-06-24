// ---------------------------------------------------------------------------
// invokeCache — per-process caches for the function-invoke hot path.
//
// A Workshop Object Table that renders function-backed columns fires one
// `POST /code-repositories/:rid/functions/invoke` per (repository, function)
// in a tight burst, and React Query retries each on failure. Every invoke
// otherwise re-resolves the source blob, re-transpiles it, AND re-runs a
// (potentially 200k-row) `object_instances` SELECT to build the ontology
// snapshot — the bulk of the per-invoke latency and the reason invokes blew
// past the request budget and 504'd in bulk.
//
// These caches coalesce that burst:
//   • transpileCache  — content-addressed (key = sha256(apiName + source)).
//     Same source ⇒ identical transpiled output, so it never goes stale and
//     carries no TTL. Capped to bound memory across many distinct functions.
//   • snapshotCache   — keyed by (ontologyId, imported types). The underlying
//     `object_instances` rows ARE mutable, so a short TTL bounds staleness
//     while still letting the 2nd…Nth invoke in a burst reuse one DB load.
//
// Single-process, in-memory — intentionally not distributed. The right scope
// for a burst-coalescer is per-process; a Redis round-trip on every invoke
// would defeat the purpose. Cache misses fall through to the existing loader,
// so correctness never depends on the cache being warm.
//
// Safety: the Foundry Functions contract treats `Objects` reads as read-only
// (mutations go through `Edits`/`createEditBatch`, which copy). The snapshot
// objects are therefore shared across cached invokes under the same contract
// that already governs a single invoke — a function that mutates a read
// object is undefined behaviour with or without this cache.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export interface TtlCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  /** Test-only: clear all entries. */
  clear(): void;
}

/**
 * Minimal TTL + LRU cache. `Map` preserves insertion order, so on a hit we
 * delete + re-insert to mark the entry most-recently-used; eviction drops the
 * oldest entry (first key) when the cap is exceeded. `ttlMs === 0` (or
 * omitted) means "no expiry" — for content-addressed caches whose key already
 * encodes the inputs.
 */
export function createTtlCache<K, V>(opts: {
  maxEntries?: number;
  ttlMs?: number;
}): TtlCache<K, V> {
  const maxEntries = opts.maxEntries ?? 64;
  const ttlMs = opts.ttlMs ?? 0;
  const store = new Map<K, { value: V; expiresAt: number }>();

  return {
    get(key: K): V | undefined {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (ttlMs > 0 && Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      // LRU: move to most-recently-used position.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: K, value: V): void {
      if (store.has(key)) store.delete(key);
      store.set(key, {
        value,
        expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER,
      });
      while (store.size > maxEntries) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value as K);
      }
    },
    clear(): void {
      store.clear();
    },
  };
}

/** Content-addressed key for a function's transpiled source. */
export function transpileCacheKey(apiName: string, source: string): string {
  return createHash("sha256")
    .update(`${apiName}\0${source}`)
    .digest("hex");
}
