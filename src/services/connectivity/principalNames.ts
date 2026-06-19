// ---------------------------------------------------------------------------
// Principal display-name resolution for the connectivity surface.
//
// Connection audit columns (`created_by` / `updated_by`) hold Keycloak subject
// IDs, NOT rows in the local `users` table — the two are distinct identity
// stores. So display names ("Cypress User") are resolved from Keycloak via the
// admin service rather than a SQL join.
//
// Production characteristics:
//   - Process-level TTL cache keyed by subject id, so the same recurring
//     creators don't re-hit Keycloak on every page load.
//   - Bounded cache size (FIFO eviction) so a large user directory can't grow
//     the map without limit.
//   - Bounded concurrency on cold-cache fan-out so a page with many distinct
//     creators can't burst the Keycloak admin API past its rate limits.
//   - Failure-aware caching: a CONFIRMED-absent principal (Keycloak 404, which
//     getUserById maps to null) is negatively cached; a TRANSIENT failure
//     (Keycloak unreachable) is NOT cached, so names reappear the moment
//     Keycloak recovers instead of being suppressed for a full TTL.
//   - Never throws — unresolved ids map to null and the caller decides how to
//     present that (the UI shows "Unknown user", never a raw id).
// ---------------------------------------------------------------------------

import { getKeycloakAdminService } from "../keycloakAdminService";

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 5_000; // hard cap on distinct cached principals
const MAX_CONCURRENCY = 8; // simultaneous Keycloak admin lookups

interface CacheEntry {
  name: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Insert with FIFO eviction so the cache can't grow unbounded. */
function cacheSet(id: string, name: string | null, now: number): void {
  // Refresh insertion order on overwrite so the active set stays hot.
  cache.delete(id);
  cache.set(id, { name, expiresAt: now + TTL_MS });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Compose a human-readable label from a Keycloak user record. */
function displayNameOf(u: {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}): string | null {
  const full = [u.firstName, u.lastName]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ")
    .trim();
  return full || u.username || u.email || null;
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Resolve a set of Keycloak subject IDs to display names. Cached entries are
 * served immediately; misses are fetched with bounded concurrency. Never
 * throws — failures resolve to `null` for that id (and are not cached unless
 * the principal is confirmed absent).
 */
export async function resolvePrincipalNames(
  ids: Iterable<string>,
): Promise<Map<string, string | null>> {
  const now = Date.now();
  const unique = Array.from(new Set([...ids].filter((id) => id && id.length > 0)));
  const out = new Map<string, string | null>();
  const misses: string[] = [];

  for (const id of unique) {
    const hit = cache.get(id);
    if (hit && hit.expiresAt > now) {
      out.set(id, hit.name);
    } else {
      misses.push(id);
    }
  }

  if (misses.length > 0) {
    const kc = getKeycloakAdminService();
    await mapWithConcurrency(misses, MAX_CONCURRENCY, async (id) => {
      try {
        // getUserById returns null ONLY on a 404 (principal genuinely gone);
        // any other failure throws and is handled as transient below.
        const u = await kc.getUserById(id);
        const name = u ? displayNameOf(u) : null;
        cacheSet(id, name, Date.now());
        out.set(id, name);
      } catch {
        // Transient (Keycloak unreachable / breaker open): do NOT cache, so the
        // next request retries once Keycloak is healthy again.
        out.set(id, null);
      }
    });
  }

  return out;
}

/** Test seam — clears the in-process cache between cases. */
export function __clearPrincipalNameCacheForTest(): void {
  cache.clear();
}
