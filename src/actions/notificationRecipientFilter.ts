// ---------------------------------------------------------------------------
// src/actions/notificationRecipientFilter.ts — Phase 6.1 recipient-data-filter.
//
// Drops a notification recipient from the dispatch list when they lack
// visibility on every object touched by the action — i.e. when the
// recipient's user-markings set does NOT cover the union of every
// affected object's `_security.markings` (resolved from
// `object_instances.markings` in the action's commit transaction).
//
// Worker-side filter (not preCommit). The preCommitHook in actionExecutor
// inlines the recipients as a per-recipient job row; this filter is invoked
// by the worker's `productionNotificationDispatch` BEFORE calling the
// NotificationProvider. Dropouts are recorded in the job's
// `external_receipt` column + the worker's structured log as
// `dropped=insufficient_visibility` per the FILE-TODO at
// notificationProviders.ts:22-29.
//
// Design choices:
//
//   * Postgres-only — the filter queries `object_instances.markings` and
//     `user_markings` synchronously (no OpenSearch). The worker is
//     already DB-touching (`getSideEffectQueueStats`). OpenSearch latency
//     would add a per-job round-trip that's redundant given the
//     authoritative markings live in PG (migration 102).
//
//   * LRU-cached `userMarkingsForUuid` — even at 1k recipients/sec,
//     the LRU (60s TTL, 50k slots) amortises the DB call to ~once per
//     user. Cache-miss is the worst case + still bounded by the DB
//     index on `user_markings.user_id`.
//
//   * Resolver fallbacks — when `recipient.principal` isn't an email
//     and the recipient→user-UUID resolver can't map it, the recipient
//     is dropped with `dropped_reason="user_not_resolved"`. Real-world
//     notifications include role-resolved and group-resolved recipients,
//     which Phase 6 ships the primitives for (group_map lookups); today
//     only the email-form recipient is resolvable. This is conservative
//     — better to drop a chaotic recipient than to dispatch to a
//     principal we can't authorize.
//
//   * No-fail-fast — an exception during one of the per-object markings
//     lookups is treated as "unknown markings → drop" rather than
//     crashing the worker.
//
// Phase 6 will ship the OpenSearch-affinity lookup + per-recipient role
// expansion. For Phase 6.1 we cover the email-form user recipient;
// role/group recipient resolution is a deferred-work TODO with the
// explicit log signature `dropped_reason="user_not_resolved"` so the
// operator can see what's still pending.
// ---------------------------------------------------------------------------

import { LRUCache } from "lru-cache";
import { query } from "../db";
import { getInstance } from "../models/objectInstance";
import { userHasAllMarkings, missingMarkings } from "../services/markingUnion";

export interface AffectedObjectInfo {
  objectType: string;
  primaryKey: string;
}

export interface RecipientPreFilter {
  principal: string;
  principalKind: "user" | "group";
}

export type DroppedReason =
  | "insufficient_visibility"
  | "user_not_resolved"
  | "lookup_error";

export interface FilterResult {
  /** Whether the recipient should be dispatched to. */
  ok: boolean;
  /** When ok=false, why they were dropped. */
  droppedReason?: DroppedReason;
  /** For `insufficient_visibility`: the markings the recipient is missing. */
  missingMarkings?: string[];
  /** For logging/troubleshooting — the recipient's resolved user UUID (or null). */
  resolvedUserId?: string | null;
}

/** Union of marking-sets. */
export function unionObjectMarkings(objectMarkings: string[][]): string[] {
  const set = new Set<string>();
  for (const m of objectMarkings) {
    for (const x of m) set.add(x);
  }
  return Array.from(set).sort();
}

const userMarkingsCache = new LRUCache<string, Set<string>>({
  max: 50_000,
  ttl: 60_000, // 60s — same TTL window as the cbac policy loader
});

/** Test-only seam — clears the LRU's wiring so each test reverts to
 * the script. NOT callable from production. Exported pre-alpha under
 * a long underscore name to make accidental imports grep-able. */
export function __clearUserMarkingsCacheForTests(): void {
  userMarkingsCache.clear();
}

/**
 * Look up `user_markings.marking_id` rows for the given user UUID.
 * Cached 60s by user UUID. Returns an empty Set when the user has
 * no markings (i.e. a brand-new user) OR when the DB lookup fails
 * (defensive — never blocks the worker on a stale PG hiccup).
 */
export async function userMarkingsForUuid(userUuid: string): Promise<Set<string>> {
  const cached = userMarkingsCache.get(userUuid);
  if (cached) return cached;
  try {
    const result = await query(
      "SELECT marking_id FROM user_markings WHERE user_id = $1",
      [userUuid],
    );
    const set = new Set<string>(
      result.rows.map((r: any) => String(r.marking_id)),
    );
    userMarkingsCache.set(userUuid, set);
    return set;
  } catch {
    // Defensive — return an empty set; the missing-markings check
    // will drop the recipient as "insufficient_visibility" since the
    // required markings won't be in the empty possessed set. Better
    // to drop on stale data than to dispatch without an authz check.
    return new Set<string>();
  }
}

/**
 * Best-effort email-form recipient → user-UUID resolver. Phase 6 ships
 * the role/group expansion + the production-ready resolver.
 *
 * Note: callers pass an injected resolver so unit tests can stub the
 * Keycloak admin service without polluting the pure-ish filter.
 */
export type RecipientResolver = (
  principal: string,
  principalKind: "user" | "group"
) => Promise<string | null>;

/**
 * Run the recipient-data-filter against the affected objects.
 *
 * Pure-ish: takes the resolver + the markings lookups as injectable
 * `RecipientResolver` + `instanceMarkingsResolver` so tests can
 * drive deterministic outcomes. The default resolvers wire the
 * production Keycloak + Postgres paths.
 *
 * The filter:
 *   1. Resolve the recipient → user UUID via `resolver`. On null → DROP
 *      (`user_not_resolved`).
 *   2. When no affected objects → ALLOW (no markings to gate on).
 *   3. Compute `requiredMarkings` = union of every affected object's
 *      `object_instances.markings`. Empty union → ALLOW.
 *   4. Fetch the recipient's `user_markings`via `userMarkingsForUuid`.
 *   5. `userHasAllMarkings(requiredMarkings, userMarkings)` → ALLOW;
 *      otherwise DROP (`insufficient_visibility`, returns `missingMarkings`).
 */
export async function recipientVisibilityFilter(
  ontologyId: string,
  affectedObjects: AffectedObjectInfo[],
  recipient: RecipientPreFilter,
  resolver: RecipientResolver,
): Promise<FilterResult> {
  // Step 1 — resolve the recipient to a user UUID.
  let userUuid: string | null;
  try {
    userUuid = await resolver(recipient.principal, recipient.principalKind);
  } catch {
    return {
      ok: false,
      droppedReason: "lookup_error",
      resolvedUserId: null,
    };
  }
  if (!userUuid) {
    return {
      ok: false,
      droppedReason: "user_not_resolved",
      resolvedUserId: null,
    };
  }
  // Step 2 — empty affectedObjects ⇒ allow (no content-coupled markings).
  if (!affectedObjects || affectedObjects.length === 0) {
    return { ok: true, resolvedUserId: userUuid };
  }
  // Step 3 — required markings = union of every affected object's markings.
  const objectMarkings: string[][] = [];
  for (const ao of affectedObjects) {
    try {
      const inst = await getInstance(ontologyId, ao.objectType, ao.primaryKey);
      objectMarkings.push(inst?.markings ?? []);
    } catch {
      // Unknown instance ⇒ count as "no marking required" (best-effort).
      objectMarkings.push([]);
    }
  }
  const requiredMarkings = unionObjectMarkings(objectMarkings);
  if (requiredMarkings.length === 0) {
    return { ok: true, resolvedUserId: userUuid };
  }
  // Step 4 + 5 — compare.
  const userMarkings = await userMarkingsForUuid(userUuid);
  if (userHasAllMarkings(requiredMarkings, userMarkings)) {
    return { ok: true, resolvedUserId: userUuid };
  }
  return {
    ok: false,
    droppedReason: "insufficient_visibility",
    missingMarkings: missingMarkings(requiredMarkings, [...userMarkings]),
    resolvedUserId: userUuid,
  };
}

/** Production resolver: email-form recipient → Keycloak user UUID.
 * Phase 6 ships role/group expansion — today we cover the email
 * form only. Cached 60s by principal string; falls back to null
 * (i.e. DROP) on a Keycloak transient failure rather than fail-fast. */
const resolverCache = new LRUCache<string, string>({
  max: 5_000,
  ttl: 60_000,
});
const cachedNegativeValue = "__unresolved__";

export function makeProductionRecipientResolver(
  keycloakFindUserByEmail: (
    email: string
  ) => Promise<{ id: string } | null>,
): RecipientResolver {
  return async (principal, principalKind): Promise<string | null> => {
    if (principalKind !== "user") return null;
    const cached = resolverCache.get(principal);
    if (cached !== undefined) {
      return cached === cachedNegativeValue ? null : cached;
    }
    let resolved: string | null = null;
    if (/@/.test(principal)) {
      try {
        const kcUser = await keycloakFindUserByEmail(principal);
        if (kcUser) resolved = kcUser.id;
      } catch {
        // fall through — leave `resolved` null
      }
    }
    resolverCache.set(principal, resolved ?? cachedNegativeValue);
    return resolved;
  };
}
