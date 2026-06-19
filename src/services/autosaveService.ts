// ---------------------------------------------------------------------------
// autosaveService — Foundry-faithful resource history capture + restore.
//
// Capture (`captureSnapshot`) is called from inside mutation transactions
// in source-of-truth services (workshop publish, dataset rename, etc.) so
// the snapshot row commits atomically with the mutation it describes. If
// the mutation rolls back, the snapshot rolls back with it.
//
// List (`listProjectSnapshots`) implements cursor pagination on
// `(snapshot_at DESC, id DESC)` — same total order as compass-children, so
// the FE can reuse its pagination helpers.
//
// Restore (`restoreSnapshot`) is the inverse of capture. It reads the
// payload, applies the historical state to the source-of-truth table for
// that resource_kind, then captures a fresh "restored" snapshot pointing
// at the original via `parent_snapshot_id` so the audit chain is intact.
//
// Payload shape — versioned per resource_kind. The discriminated union
// is documented in src/types/autosaveSnapshot.ts; capture writes the
// shape the kind expects, restore reads it.
// ---------------------------------------------------------------------------
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db";
import {
  AutosaveSnapshot,
  AutosavePayload,
  AutosaveSnapshotChangeKind,
  AutosaveSnapshotResourceKind,
  AutosaveSnapshotRow,
} from "../types/autosaveSnapshot";

export interface CaptureSnapshotInput {
  resourceRid: string;
  resourceKind: AutosaveSnapshotResourceKind;
  projectId: string;
  parentFolderRid: string | null;
  actorId: string | null;
  actorEmail: string | null;
  changeKind: AutosaveSnapshotChangeKind;
  changeSummary: string;
  payload: AutosavePayload;
  parentSnapshotId?: string | null;
  // null = keep forever; default = 90 days from snapshot_at.
  retentionUntil?: Date | null;
}

const DEFAULT_RETENTION_DAYS = 90;
const PAYLOAD_HARD_CAP_BYTES = 1_000_000; // 1 MB; matches the DDL CHECK.

function summarizeOrThrow(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    throw new Error("autosave: change_summary required");
  }
  if (trimmed.length > 256) {
    return trimmed.slice(0, 253) + "...";
  }
  return trimmed;
}

function payloadOrThrow(payload: AutosavePayload): AutosavePayload {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") >= PAYLOAD_HARD_CAP_BYTES) {
    throw new Error(
      `autosave: payload exceeds 1 MB limit (got ${Buffer.byteLength(json, "utf8")} bytes)`,
    );
  }
  return payload;
}

/**
 * Capture a snapshot inside an existing transaction. Pass either a
 * `PoolClient` (when called from a service that already owns a txn) or
 * undefined (the service borrows + releases its own connection — only
 * use this when there is no enclosing mutation).
 */
export async function captureSnapshot(
  input: CaptureSnapshotInput,
  client?: PoolClient,
  pool: Pool = defaultPool,
): Promise<string> {
  const summary = summarizeOrThrow(input.changeSummary);
  const payload = payloadOrThrow(input.payload);
  const retentionUntil =
    input.retentionUntil === null
      ? null
      : input.retentionUntil ??
        new Date(Date.now() + DEFAULT_RETENTION_DAYS * 86_400_000);

  const exec = client ?? pool;
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO autosave_snapshots (
       resource_rid, resource_kind, project_id, parent_folder_rid,
       actor_id, actor_email, change_kind, change_summary, payload,
       parent_snapshot_id, retention_until
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
     )
     RETURNING id`,
    [
      input.resourceRid,
      input.resourceKind,
      input.projectId,
      input.parentFolderRid,
      input.actorId,
      input.actorEmail,
      input.changeKind,
      summary,
      JSON.stringify(payload),
      input.parentSnapshotId ?? null,
      retentionUntil,
    ],
  );
  return rows[0].id;
}

export interface ListSnapshotsOptions {
  projectId: string;
  pageSize?: number;
  pageToken?: string;          // base64({snapshotAt, id}) cursor
  resourceRid?: string;        // filter to a single resource (per-resource history)
  resourceKind?: AutosaveSnapshotResourceKind;
  actorId?: string;
  changeKind?: AutosaveSnapshotChangeKind;
  sinceTimestamp?: Date;       // for "snapshots since I last visited"
}

export interface ListSnapshotsResult {
  items: AutosaveSnapshot[];
  nextPageToken: string | null;
  pageSize: number;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

interface DecodedCursor { snapshotAt: string; id: string }

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(token: string | undefined): DecodedCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      typeof parsed?.snapshotAt === "string" &&
      typeof parsed?.id === "string"
    ) {
      return { snapshotAt: parsed.snapshotAt, id: parsed.id };
    }
  } catch {
    // fall through
  }
  return null;
}

function rowToSnapshot(r: AutosaveSnapshotRow): AutosaveSnapshot {
  return {
    id: r.id,
    resourceRid: r.resource_rid,
    resourceKind: r.resource_kind,
    projectId: r.project_id,
    parentFolderRid: r.parent_folder_rid,
    snapshotAt: new Date(r.snapshot_at).toISOString(),
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    changeKind: r.change_kind,
    changeSummary: r.change_summary,
    payload: r.payload as AutosavePayload,
    parentSnapshotId: r.parent_snapshot_id,
    retentionUntil: r.retention_until ? new Date(r.retention_until).toISOString() : null,
  };
}

/**
 * List snapshots scoped to a project, paginated by (snapshot_at, id).
 */
export async function listProjectSnapshots(
  opts: ListSnapshotsOptions,
  pool: Pool = defaultPool,
): Promise<ListSnapshotsResult> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const cursor = decodeCursor(opts.pageToken);
  const params: unknown[] = [opts.projectId];
  let where = "project_id = $1";

  if (opts.resourceRid) {
    params.push(opts.resourceRid);
    where += ` AND resource_rid = $${params.length}`;
  }
  if (opts.resourceKind) {
    params.push(opts.resourceKind);
    where += ` AND resource_kind = $${params.length}`;
  }
  if (opts.actorId) {
    params.push(opts.actorId);
    where += ` AND actor_id = $${params.length}`;
  }
  if (opts.changeKind) {
    params.push(opts.changeKind);
    where += ` AND change_kind = $${params.length}`;
  }
  if (opts.sinceTimestamp) {
    params.push(opts.sinceTimestamp.toISOString());
    where += ` AND snapshot_at >= $${params.length}::timestamptz`;
  }
  if (cursor) {
    params.push(cursor.snapshotAt, cursor.id);
    where += ` AND (snapshot_at, id::text) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(pageSize + 1);
  const sql = `
    SELECT id::text, resource_rid, resource_kind, project_id::text,
           parent_folder_rid, snapshot_at, actor_id::text,
           actor_email, change_kind, change_summary, payload,
           parent_snapshot_id::text, retention_until
    FROM autosave_snapshots
    WHERE ${where}
    ORDER BY snapshot_at DESC, id DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query<AutosaveSnapshotRow>(sql, params);
  const items = rows.slice(0, pageSize).map(rowToSnapshot);
  const more = rows.length > pageSize;
  const nextPageToken =
    more && items.length > 0
      ? encodeCursor({
          snapshotAt: items[items.length - 1].snapshotAt,
          id: items[items.length - 1].id,
        })
      : null;
  return { items, nextPageToken, pageSize };
}

/**
 * Look up a single snapshot by id, scoped to a project for authorization.
 */
export async function getSnapshot(
  snapshotId: string,
  projectId: string,
  pool: Pool = defaultPool,
): Promise<AutosaveSnapshot | null> {
  const { rows } = await pool.query<AutosaveSnapshotRow>(
    `SELECT id::text, resource_rid, resource_kind, project_id::text,
            parent_folder_rid, snapshot_at, actor_id::text,
            actor_email, change_kind, change_summary, payload,
            parent_snapshot_id::text, retention_until
     FROM autosave_snapshots
     WHERE id = $1 AND project_id = $2
     LIMIT 1`,
    [snapshotId, projectId],
  );
  if (rows.length === 0) return null;
  return rowToSnapshot(rows[0]);
}

/**
 * Restore a snapshot. Strategy: write a "restored" snapshot of the
 * current state first (so the user can undo the restore), then apply
 * the historical payload to the source-of-truth table for the
 * resource_kind. Returns the new snapshot id.
 *
 * The actual application is delegated to a per-kind restore handler
 * passed by the caller — the route layer maps `resourceKind` to the
 * right service. This keeps autosaveService free of source-of-truth
 * dependencies (pipelineService, workshopService, etc.) which would
 * otherwise create circular imports.
 */
export async function restoreSnapshot(
  snapshot: AutosaveSnapshot,
  actor: { id: string | null; email: string | null },
  applyHistoricalState: (payload: AutosavePayload, client: PoolClient) => Promise<{
    currentStateForUndo: AutosavePayload;
    summary: string;
  }>,
  pool: Pool = defaultPool,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const undo = await applyHistoricalState(snapshot.payload, client);
    const newSnapshotId = await captureSnapshot(
      {
        resourceRid: snapshot.resourceRid,
        resourceKind: snapshot.resourceKind,
        projectId: snapshot.projectId,
        parentFolderRid: snapshot.parentFolderRid,
        actorId: actor.id,
        actorEmail: actor.email,
        changeKind: "restored",
        changeSummary: `Restored from snapshot taken ${snapshot.snapshotAt}: ${undo.summary}`,
        payload: undo.currentStateForUndo,
        parentSnapshotId: snapshot.id,
      },
      client,
    );
    await client.query("COMMIT");
    return newSnapshotId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
