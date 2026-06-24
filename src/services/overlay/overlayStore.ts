// ---------------------------------------------------------------------------
// Overlay store abstraction — Task B7, hardened by T-04.
//
// The Writeback Overlay is a short-lived cache that sits between every
// Action writeback and the Quickwit query path. Its job is to make an edit
// visible *immediately* even though Quickwit's commit cadence (B6) and
// delete-by-query cadence are measured in seconds-to-hours.
//
// The physical store is Redis in production. For dev/test we expose the
// same surface via an in-memory store, so the rest of the system (edit
// applicator, query merger, sweeper) never sees the difference.
//
// T-04 — branch-aware keyspace:
//   New keys:    overlay:<branchId>:<object_type_api_name>:<primary_key>
//   Legacy keys: overlay:<object_type_api_name>:<primary_key>
//
//   Legacy keys are read during phases 1 and 2 of the rollout
//   (`OVERLAY_READ_LEGACY === "true"` and only on `_main` reads), and
//   written during phases 0 and 1 (`OVERLAY_DUAL_WRITE === "true"` and
//   only when `branchId === "_main"`). They expire naturally via TTL
//   in phase 3.
//
// Value:      OverlayRecord (now includes branchId)
// TTL:        quickwit_commit_timeout_secs * 3 (default 180s)
// ---------------------------------------------------------------------------

/**
 * Sentinel for the "no branch context / main branch" cache slot. All
 * pre-T-04 writes are interpreted as `_main` reads when surfaced through
 * the legacy-fallback path.
 */
export const MAIN_BRANCH_SENTINEL = "_main";

export interface OverlayRecord {
  /** T-04: required. `_main` sentinel for unbranched writes. */
  branchId: string;
  objectType: string;
  primaryKey: string;
  /** Full current object state — replaces the Quickwit doc at query time. */
  doc: Record<string, unknown>;
  /** True when the edit was a delete — query-time filter drops the row. */
  deleted: boolean;
  /** Monotonic version of this object's edit history (from object_edits). */
  version: number;
  /** When the overlay was first written (for staleness checks). */
  createdAt: number;
  /** Which edit produced this overlay (for sweeper correlation). */
  editId: string;
  /** Who made the edit. */
  actorUserId?: string | null;
}

export interface OverlayStore {
  put(key: string, record: OverlayRecord, ttlSeconds: number): Promise<void>;
  /**
   * Returns the raw value for a single key. Used by T-04's branch-aware
   * `readOverlay` so the caller can fall back to the legacy key without
   * issuing a redundant `mget`.
   */
  get?(key: string): Promise<OverlayRecord | null>;
  mget(keys: string[]): Promise<Array<OverlayRecord | null>>;
  scan(objectType: string): Promise<OverlayRecord[]>;
  delete(key: string): Promise<void>;
  size(): Promise<number>;
  /** Optional — used by tests for reset between cases. */
  clear?(): Promise<void>;
}

/**
 * T-04 branch-aware key. `branchId` may be `null` (or empty) to mean
 * "no branch context"; we materialise that as the `_main` sentinel so
 * the keyspace is uniform.
 */
export function overlayKey(
  branchId: string | null | undefined,
  objectType: string,
  primaryKey: string,
): string {
  const slot =
    typeof branchId === "string" && branchId.length > 0
      ? branchId
      : MAIN_BRANCH_SENTINEL;
  return `overlay:${slot}:${objectType}:${primaryKey}`;
}

/**
 * Pre-T-04 keyspace. Retained because the dual-write rollout writes to
 * both formats during phases 0–1, and the legacy-fallback read path
 * needs a way to address the old keys. A single-revert revival of T-04
 * works by removing only the new-form `overlayKey` callers — the legacy
 * function continues to function unchanged.
 */
export function legacyOverlayKey(
  objectType: string,
  primaryKey: string,
): string {
  return `overlay:${objectType}:${primaryKey}`;
}

/**
 * Parse either the new `overlay:<branch>:<ot>:<pk>` form or the legacy
 * `overlay:<ot>:<pk>` form. Returns `branchId = null` for legacy keys so
 * downstream consumers know they came from the pre-T-04 namespace.
 */
export function parseOverlayKey(
  key: string,
):
  | { branchId: string | null; objectType: string; primaryKey: string }
  | null {
  // New form first — `overlay:<branch>:<ot>:<pk>`. The branch token is
  // greedy-of-not-colon to keep parser simple while still supporting
  // future UUID-shaped branchIds.
  const newForm = /^overlay:([^:]+):([^:]+):(.+)$/.exec(key);
  if (newForm) {
    // Disambiguate from `overlay:link:<linkType>:<src>:<tgt>` — link
    // keys also match this regex but mean something different.
    if (newForm[1] === "link") return null;
    return {
      branchId: newForm[1],
      objectType: newForm[2],
      primaryKey: newForm[3],
    };
  }
  const legacyForm = /^overlay:([^:]+):(.+)$/.exec(key);
  if (legacyForm) {
    return {
      branchId: null,
      objectType: legacyForm[1],
      primaryKey: legacyForm[2],
    };
  }
  return null;
}

// FNL-H5 — per-link overlay keys live in the same Redis namespace but
// under a separate prefix so sweeper/query code can tell them apart.
export function linkOverlayKey(
  linkTypeApiName: string,
  sourcePk: string,
  targetPk: string,
): string {
  return `overlay:link:${linkTypeApiName}:${sourcePk}:${targetPk}`;
}

export function parseLinkOverlayKey(
  key: string,
):
  | { linkTypeApiName: string; sourcePk: string; targetPk: string }
  | null {
  const m = /^overlay:link:([^:]+):([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  return { linkTypeApiName: m[1], sourcePk: m[2], targetPk: m[3] };
}

export interface LinkOverlayRecord {
  linkTypeApiName: string;
  sourcePk: string;
  targetPk: string;
  operation: "ADD" | "REMOVE" | "RETRACT";
  markings: string[];
  linkProps?: Record<string, unknown>;
  createdAt: number;
  eventId?: string;
  actorUserId?: string | null;
}

/**
 * Resolve `OVERLAY_DUAL_WRITE` env flag. Default: `true` (phases 0–1).
 * Operators flip to `"false"` to enter phase 2.
 */
export function isDualWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OVERLAY_DUAL_WRITE !== "false";
}

/**
 * Resolve `OVERLAY_READ_LEGACY` env flag. Default: `true` (phases 0–2).
 * Operators flip to `"false"` to enter phase 3.
 */
export function isLegacyReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OVERLAY_READ_LEGACY !== "false";
}
