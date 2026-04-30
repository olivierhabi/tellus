// ---------------------------------------------------------------------------
// Replacement-pipeline version manager — Task B9
//
// Owns the Postgres row that answers "which Quickwit index version is
// LIVE right now?" for a given Object Type. This is the alias that every
// query-path module resolves through; the cutover step is literally a
// single UPDATE of `active_version` wrapped in a transaction.
//
// State machine (see 013_replacement_pipeline.sql for the ENUM):
//
//   LIVE
//     └─► REPLACEMENT_BACKFILL   (schema change detected; sibling created)
//           └─► REPLACEMENT_SOAK (backfill done; shadow diff collecting)
//                 └─► CUTOVER_PENDING  (diff gate passed, flip approved)
//                       └─► CUTOVER_COMPLETE (alias flipped)
//                             ├─► OLD_INDEX_DROPPED  (after 48h grace)
//                             └─► ROLLED_BACK        (manual reverse)
//
// Every transition goes through this module so invariants stay in one place.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { query, withTransaction } from "../../../db";
import { getQuickwitIndexId } from "../docMapping";

export type ReplacementState =
  | "LIVE"
  | "REPLACEMENT_BACKFILL"
  | "REPLACEMENT_SOAK"
  | "CUTOVER_PENDING"
  | "CUTOVER_COMPLETE"
  | "OLD_INDEX_DROPPED"
  | "ROLLED_BACK";

export interface ActiveIndexRecord {
  objectTypeApiName: string;
  activeVersion: number;
  pendingVersion: number | null;
  state: ReplacementState;
  soakDays: number;
  diffRateThreshold: number;
  backfillStartedAt: Date | null;
  soakStartedAt: Date | null;
  lastCutoverAt: Date | null;
  lastRollbackAt: Date | null;
  oldIndexRetainedUntil: Date | null;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Index-id helpers — the v1 index keeps the legacy name `ot_<api>` for
// backwards compatibility with B6 so Object Types that never see a schema
// change never see a rename. Versions ≥2 always include the suffix.
// ---------------------------------------------------------------------------

export function indexIdForVersion(objectTypeApiName: string, version: number): string {
  const base = getQuickwitIndexId(objectTypeApiName);
  return version <= 1 ? base : `${base}__v${version}`;
}

// ---------------------------------------------------------------------------
// Row loader — initializes a LIVE row if the Object Type has never been
// registered. Callers should never see a null record.
// ---------------------------------------------------------------------------

export async function getOrCreateActiveVersion(
  objectTypeApiName: string
): Promise<ActiveIndexRecord> {
  await query(
    `INSERT INTO object_type_active_index_version (object_type_api_name)
     VALUES ($1)
     ON CONFLICT (object_type_api_name) DO NOTHING`,
    [objectTypeApiName]
  );
  const res = await query(
    `SELECT * FROM object_type_active_index_version WHERE object_type_api_name = $1`,
    [objectTypeApiName]
  );
  return rowToRecord(res.rows[0]);
}

export async function getActiveVersion(
  objectTypeApiName: string
): Promise<ActiveIndexRecord | null> {
  const res = await query(
    `SELECT * FROM object_type_active_index_version WHERE object_type_api_name = $1`,
    [objectTypeApiName]
  );
  return res.rows[0] ? rowToRecord(res.rows[0]) : null;
}

/** Resolve the index id a query-path module should read from. */
export async function resolveQueryIndexId(
  objectTypeApiName: string
): Promise<string> {
  const rec = await getOrCreateActiveVersion(objectTypeApiName);
  return indexIdForVersion(objectTypeApiName, rec.activeVersion);
}

/** Resolve the indexes a write-path module should write to. */
export interface WriteTargets {
  primary: string;
  pending: string | null;
  state: ReplacementState;
}

export async function resolveWriteTargets(
  objectTypeApiName: string
): Promise<WriteTargets> {
  const rec = await getOrCreateActiveVersion(objectTypeApiName);
  const primary = indexIdForVersion(objectTypeApiName, rec.activeVersion);
  const pending =
    rec.pendingVersion !== null
      ? indexIdForVersion(objectTypeApiName, rec.pendingVersion)
      : null;
  return { primary, pending, state: rec.state };
}

// ---------------------------------------------------------------------------
// Transition: LIVE → REPLACEMENT_BACKFILL
// Allocates the next version number and stamps backfill_started_at. Returns
// the new version; the caller is responsible for provisioning the sibling
// Quickwit index before sending writes to it.
// ---------------------------------------------------------------------------

export async function beginReplacementBackfill(
  objectTypeApiName: string,
  soakDays: number = 7
): Promise<{ newVersion: number; record: ActiveIndexRecord }> {
  if (soakDays < 1 || soakDays > 14) {
    throw new Error(`soakDays must be between 1 and 14 (got ${soakDays})`);
  }
  return withTransaction(async (client) => {
    const current = await selectForUpdate(client, objectTypeApiName);
    if (current && current.state !== "LIVE") {
      throw new Error(
        `Cannot begin replacement: object type '${objectTypeApiName}' is in state '${current.state}'`
      );
    }
    const nextVersion = (current?.activeVersion ?? 1) + 1;
    const res = await client.query(
      `UPDATE object_type_active_index_version
          SET pending_version       = $2,
              state                 = 'REPLACEMENT_BACKFILL',
              soak_days             = $3,
              backfill_started_at   = now(),
              soak_started_at       = NULL,
              updated_at            = now()
        WHERE object_type_api_name = $1
        RETURNING *`,
      [objectTypeApiName, nextVersion, soakDays]
    );
    return { newVersion: nextVersion, record: rowToRecord(res.rows[0]) };
  });
}

// ---------------------------------------------------------------------------
// Transition: REPLACEMENT_BACKFILL → REPLACEMENT_SOAK
// ---------------------------------------------------------------------------

export async function enterSoak(objectTypeApiName: string): Promise<ActiveIndexRecord> {
  return withTransaction(async (client) => {
    const current = await selectForUpdate(client, objectTypeApiName);
    if (!current || current.state !== "REPLACEMENT_BACKFILL") {
      throw new Error(
        `enterSoak requires state REPLACEMENT_BACKFILL; got '${current?.state ?? "none"}'`
      );
    }
    const res = await client.query(
      `UPDATE object_type_active_index_version
          SET state            = 'REPLACEMENT_SOAK',
              soak_started_at  = now(),
              updated_at       = now()
        WHERE object_type_api_name = $1
        RETURNING *`,
      [objectTypeApiName]
    );
    return rowToRecord(res.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Transition: REPLACEMENT_SOAK → CUTOVER_COMPLETE
//
// Atomic: flips active_version to pending_version and nulls pending.
// `old_index_retained_until` is set to now + 48h so the sweeper knows when
// it can drop the old index.
// ---------------------------------------------------------------------------

export async function cutover(objectTypeApiName: string): Promise<ActiveIndexRecord> {
  const record = await withTransaction(async (client) => {
    const current = await selectForUpdate(client, objectTypeApiName);
    if (!current || current.pendingVersion == null) {
      throw new Error(
        `cutover requires pending_version to be set; object '${objectTypeApiName}' has none`
      );
    }
    if (current.state !== "REPLACEMENT_SOAK" && current.state !== "CUTOVER_PENDING") {
      throw new Error(
        `cutover requires state SOAK or CUTOVER_PENDING; got '${current.state}'`
      );
    }
    const res = await client.query(
      `UPDATE object_type_active_index_version
          SET active_version            = pending_version,
              pending_version           = active_version,
              state                     = 'CUTOVER_COMPLETE',
              last_cutover_at           = now(),
              old_index_retained_until  = now() + interval '48 hours',
              updated_at                = now()
        WHERE object_type_api_name = $1
        RETURNING *`,
      [objectTypeApiName]
    );
    return rowToRecord(res.rows[0]);
  });

  // B8/B9: flip the Kubernetes Service selector so live traffic lands on
  // the pre-warmed searcher pool. Single atomic PATCH on the Service's
  // `spec.selector.role`. Best-effort — the Postgres `active_version`
  // row is the authoritative state and a transient K8s API blip is
  // corrected on the next sweeper/reconciler tick.
  if (process.env.QUICKWIT_K8S_FLIP_ENABLED === "true") {
    try {
      const { flipSearcherServiceSelector } = await import("../k8sServiceFlip");
      await flipSearcherServiceSelector("live");
    } catch (err) {
      console.warn(
        `[versionManager] K8s service flip failed for ${objectTypeApiName}: ${
          (err as Error).message
        }`
      );
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// Rollback (within 48h): swap active_version back to the old version.
// ---------------------------------------------------------------------------

export async function rollback(objectTypeApiName: string): Promise<ActiveIndexRecord> {
  return withTransaction(async (client) => {
    const current = await selectForUpdate(client, objectTypeApiName);
    if (!current || current.state !== "CUTOVER_COMPLETE") {
      throw new Error(
        `rollback requires state CUTOVER_COMPLETE; got '${current?.state ?? "none"}'`
      );
    }
    if (current.oldIndexRetainedUntil && current.oldIndexRetainedUntil.getTime() < Date.now()) {
      throw new Error(
        `rollback window elapsed at ${current.oldIndexRetainedUntil.toISOString()}`
      );
    }
    const res = await client.query(
      `UPDATE object_type_active_index_version
          SET active_version   = pending_version,
              pending_version  = active_version,
              state            = 'ROLLED_BACK',
              last_rollback_at = now(),
              updated_at       = now()
        WHERE object_type_api_name = $1
        RETURNING *`,
      [objectTypeApiName]
    );
    return rowToRecord(res.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Finalize: drop the old index reference after 48h.
// ---------------------------------------------------------------------------

export async function finalizeCutover(
  objectTypeApiName: string
): Promise<ActiveIndexRecord> {
  return withTransaction(async (client) => {
    const current = await selectForUpdate(client, objectTypeApiName);
    if (!current || current.state !== "CUTOVER_COMPLETE") {
      throw new Error(
        `finalizeCutover requires state CUTOVER_COMPLETE; got '${current?.state ?? "none"}'`
      );
    }
    if (!current.oldIndexRetainedUntil || current.oldIndexRetainedUntil.getTime() > Date.now()) {
      throw new Error(
        `finalizeCutover premature — grace window ends at ` +
          `${current.oldIndexRetainedUntil?.toISOString() ?? "unknown"}`
      );
    }
    const res = await client.query(
      `UPDATE object_type_active_index_version
          SET state           = 'OLD_INDEX_DROPPED',
              pending_version = NULL,
              updated_at      = now()
        WHERE object_type_api_name = $1
        RETURNING *`,
      [objectTypeApiName]
    );
    return rowToRecord(res.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function selectForUpdate(
  client: PoolClient,
  objectTypeApiName: string
): Promise<ActiveIndexRecord | null> {
  const res = await client.query(
    `SELECT * FROM object_type_active_index_version
      WHERE object_type_api_name = $1
      FOR UPDATE`,
    [objectTypeApiName]
  );
  return res.rows[0] ? rowToRecord(res.rows[0]) : null;
}

function rowToRecord(row: Record<string, unknown>): ActiveIndexRecord {
  return {
    objectTypeApiName: row.object_type_api_name as string,
    activeVersion: Number(row.active_version),
    pendingVersion: row.pending_version === null ? null : Number(row.pending_version),
    state: row.state as ReplacementState,
    soakDays: Number(row.soak_days),
    diffRateThreshold: Number(row.diff_rate_threshold),
    backfillStartedAt: row.backfill_started_at ? new Date(row.backfill_started_at as string) : null,
    soakStartedAt: row.soak_started_at ? new Date(row.soak_started_at as string) : null,
    lastCutoverAt: row.last_cutover_at ? new Date(row.last_cutover_at as string) : null,
    lastRollbackAt: row.last_rollback_at ? new Date(row.last_rollback_at as string) : null,
    oldIndexRetainedUntil: row.old_index_retained_until
      ? new Date(row.old_index_retained_until as string)
      : null,
    updatedAt: new Date(row.updated_at as string),
  };
}
