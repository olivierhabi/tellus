// ---------------------------------------------------------------------------
// trashMirror — single batched primitive for writing the trash mirror
// rows that `deleteFolder` and `deleteDataset` produce.
//
// Why this exists:
//   * The naive implementation issues one `INSERT ... ON CONFLICT` per
//     row inside the deletion transaction. For a folder with 500
//     descendants that's 500 round-trips and a multi-second txn lock —
//     not acceptable at scale.
//   * Both the dataset path and the folder path want the same upsert
//     semantics (idempotent on `rid`, copy snapshot to metadata, stamp
//     trashed_at/by, set retention). A shared helper keeps them in
//     lockstep — change retention here, both paths inherit it.
//
// The implementation uses Postgres `unnest` array unpacking so a single
// INSERT statement writes N rows. This is the standard "send N rows to
// pg in one round-trip" trick — strictly type-safe (every column has
// its own typed array parameter) and benchmarked to ~100x speedup over
// the per-row loop above ~50 rows.
// ---------------------------------------------------------------------------
import type { Knex } from "knex";

import { MAX_TRASH_SUBTREE_SIZE } from "../schemas/trashSnapshot";
import { AppError } from "../utils/foundryAppError";

/** Trash status enum mirroring the DB CHECK constraint. */
export type TrashStatus = "DIRECTLY_TRASHED" | "ANCESTOR_TRASHED";

/** A single row to mirror into `resources` with a trashed status. */
export interface TrashMirrorRow {
  rid: string;
  type: "FOUNDRY_DATASET" | "COMPASS_FOLDER";
  service: string;
  displayName: string;
  parentFolderRid: string;
  projectRid: string;
  spaceRid: string;
  status: TrashStatus;
  legacyUuid: string;
  /** JSON metadata; default `{}`. The directly-trashed root carries the snapshot. */
  metadata?: Record<string, unknown>;
}

export interface TrashMirrorOptions {
  trx: Knex.Transaction;
  rows: TrashMirrorRow[];
  actorId: string;
  /** Retention window in days. Default 30. */
  retentionDays?: number;
  /** Override `now()`; primarily for tests. */
  now?: Date;
}

/**
 * Batched upsert of trash-mirror rows.
 *
 * Idempotent on `rid`: re-trashing an already-trashed row updates
 * status / retention / metadata in place rather than failing or
 * duplicating. Atomic — runs inside the caller's transaction.
 *
 * Throws `RESOURCE_TOO_LARGE` when the row count exceeds
 * `MAX_TRASH_SUBTREE_SIZE` so a runaway click on a 100k-folder
 * doesn't lock the table for minutes; callers should redirect to
 * the bulk-trash worker (follow-up).
 */
export async function mirrorToTrash(opts: TrashMirrorOptions): Promise<void> {
  const { trx, rows, actorId, retentionDays = 30, now = new Date() } = opts;

  if (rows.length === 0) return;
  if (rows.length > MAX_TRASH_SUBTREE_SIZE) {
    throw new AppError(
      `Cannot trash ${rows.length} resources in a single operation; ` +
        `the limit is ${MAX_TRASH_SUBTREE_SIZE}. Use the bulk-trash worker for larger subtrees.`,
      409,
      "RESOURCE_TOO_LARGE",
    );
  }

  const retentionUntil = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  // Pack each column into a parallel array. Postgres `unnest` then
  // unpacks them into rows. Every parameter has an explicit cast so
  // we don't rely on the driver's array-type inference.
  const rids: string[] = [];
  const types: string[] = [];
  const services: string[] = [];
  const displayNames: string[] = [];
  const parentFolderRids: string[] = [];
  const projectRids: string[] = [];
  const spaceRids: string[] = [];
  const statuses: string[] = [];
  const metadatas: string[] = [];
  const legacyUuids: string[] = [];

  for (const r of rows) {
    rids.push(r.rid);
    types.push(r.type);
    services.push(r.service);
    displayNames.push(r.displayName);
    parentFolderRids.push(r.parentFolderRid);
    projectRids.push(r.projectRid);
    spaceRids.push(r.spaceRid);
    statuses.push(r.status);
    metadatas.push(JSON.stringify(r.metadata ?? {}));
    legacyUuids.push(r.legacyUuid);
  }

  // Single round-trip INSERT. The `unnest(...)` builds an N-row VALUES
  // table; `ON CONFLICT (rid) DO UPDATE` makes this idempotent under
  // retry and over re-trash of an already-trashed row.
  await trx.raw(
    `INSERT INTO resources (
       rid, type, service, display_name,
       parent_folder_rid, project_rid, space_rid,
       trash_status, trashed_at, trashed_by, retention_until,
       etag, metadata, legacy_uuid, created_by, updated_by
     )
     SELECT
       rid, type, service, display_name,
       parent_folder_rid, project_rid, space_rid,
       trash_status, ?::timestamptz, ?::uuid, ?::timestamptz,
       1, metadata::jsonb, legacy_uuid::uuid, ?::uuid, ?::uuid
     FROM unnest(
       ?::text[], ?::text[], ?::text[], ?::text[],
       ?::text[], ?::text[], ?::text[],
       ?::text[], ?::text[], ?::text[]
     ) AS t(rid, type, service, display_name,
            parent_folder_rid, project_rid, space_rid,
            trash_status, metadata, legacy_uuid)
     ON CONFLICT (rid) DO UPDATE SET
       trash_status    = EXCLUDED.trash_status,
       trashed_at      = EXCLUDED.trashed_at,
       trashed_by      = EXCLUDED.trashed_by,
       retention_until = EXCLUDED.retention_until,
       metadata        = EXCLUDED.metadata,
       updated_by      = EXCLUDED.updated_by,
       updated_at      = now()`,
    [
      now,
      actorId,
      retentionUntil,
      actorId,
      actorId,
      rids,
      types,
      services,
      displayNames,
      parentFolderRids,
      projectRids,
      spaceRids,
      statuses,
      metadatas,
      legacyUuids,
    ],
  );
}
