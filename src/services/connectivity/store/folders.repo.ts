// ---------------------------------------------------------------------------
// Folder picker repository — queries the `resources` table for
// PROJECT, COMPASS_FOLDER, and COMPASS_SPACE rows.
//
// Used by the GET /api/v2/connectivity/folders endpoint to power the
// folder-picker dialog in the connectivity UI.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { pool } from "../../../db";

// --- Types ----------------------------------------------------------------

export interface FolderItem {
  rid: string;
  displayName: string;
  type: string;
  hasChildren: boolean;
}

export interface CreatedFolder {
  rid: string;
  name: string;
  /** Ancestor path of the new folder's PARENT, e.g. "/Space/Project". */
  path: string;
}

interface ResourceRow {
  rid: string;
  type: string;
  display_name: string;
  parent_folder_rid: string | null;
  space_rid: string | null;
  project_rid: string | null;
}

// Defaults for the "Generate a new default output folder" affordance when the
// wizard has no explicitly-selected location. These mirror Foundry's
// per-enrollment default data project convention.
const DEFAULT_SPACE_NAME = "Ontologize Public-33fd9b";
const DEFAULT_PROJECT_NAME = "My Data Project";
export const DEFAULT_OUTPUT_FOLDER_NAME = "raw";

export interface ListFoldersResult {
  items: FolderItem[];
}

export interface ListFoldersParams {
  tenant: string;
  parentRid?: string;
  q?: string;
}

// --- Query ----------------------------------------------------------------

/**
 * List folder-like resources from the `resources` table.
 *
 * - When `parentRid` is set, returns direct children of that parent.
 * - When `parentRid` is omitted, returns root-level items
 *   (parent_folder_rid IS NULL).
 * - `q` applies an ILIKE filter on display_name.
 * - Only rows with type IN ('PROJECT', 'COMPASS_FOLDER', 'COMPASS_SPACE')
 *   and trash_status = 'NOT_TRASHED' are returned.
 * - `hasChildren` is a correlated EXISTS subquery.
 */
export async function listFolders(
  params: ListFoldersParams,
): Promise<ListFoldersResult> {
  const { parentRid, q } = params;

  const allowedTypes = ["PROJECT", "COMPASS_FOLDER", "COMPASS_SPACE"];
  const conditions: string[] = [
    `r.type = ANY($1::text[])`,
    `r.trash_status = 'NOT_TRASHED'`,
  ];
  // $1 is the types array.
  const queryParams: unknown[] = [allowedTypes];
  let nextIdx = 2;

  if (parentRid) {
    conditions.push(`r.parent_folder_rid = $${nextIdx}`);
    queryParams.push(parentRid);
    nextIdx++;
  } else {
    conditions.push(`r.parent_folder_rid IS NULL`);
  }

  if (q) {
    conditions.push(`r.display_name ILIKE $${nextIdx}`);
    queryParams.push(`%${q}%`);
    nextIdx++;
  }

  const sql = `
    SELECT
      r.rid,
      r.display_name  AS "displayName",
      r.type,
      EXISTS (
        SELECT 1
          FROM resources c
         WHERE c.parent_folder_rid = r.rid
           AND c.trash_status = 'NOT_TRASHED'
           AND c.type = ANY($1::text[])
      ) AS "hasChildren"
    FROM resources r
    WHERE ${conditions.join(" AND ")}
    ORDER BY r.display_name ASC
  `;

  const result = await pool.query<FolderItem>(sql, queryParams);
  return { items: result.rows };
}

// --- Output-folder creation -----------------------------------------------

async function getResource(rid: string): Promise<ResourceRow | null> {
  const { rows } = await pool.query<ResourceRow>(
    `SELECT rid, type, display_name, parent_folder_rid, space_rid, project_rid
       FROM resources
      WHERE rid = $1 AND trash_status = 'NOT_TRASHED'`,
    [rid],
  );
  return rows[0] ?? null;
}

/**
 * Compute the human-readable ancestor path of a resource (used as the
 * displayed parent path of a freshly created output folder). Walks
 * `parent_folder_rid` to the top, then prepends the containing space's
 * display name. Example: "/Ontologize Public-33fd9b/My Data Project".
 */
async function computeAncestorPath(rid: string): Promise<string> {
  const names: string[] = [];
  let cursor: string | null = rid;
  let lastSpaceRid: string | null = null;
  let topWasSpace = false;
  // Bounded walk guards against cycles in malformed data.
  for (let hops = 0; cursor && hops < 50; hops++) {
    const row: ResourceRow | null = await getResource(cursor);
    if (!row) break;
    names.unshift(row.display_name);
    if (row.type === "COMPASS_SPACE") {
      topWasSpace = true;
      break;
    }
    lastSpaceRid = row.space_rid;
    cursor = row.parent_folder_rid;
  }
  if (!topWasSpace && lastSpaceRid) {
    const space = await getResource(lastSpaceRid);
    if (space) names.unshift(space.display_name);
  }
  return "/" + names.join("/");
}

// --- Resolve-by-RID (folder metadata for prefill) -------------------------

export interface ResolvedFolder {
  rid: string;
  displayName: string;
  type: string;
  /** Full ancestor path INCLUDING this resource, e.g. "/Space/Project/Folder". */
  path: string;
  /** Ancestor path of this resource's PARENT, e.g. "/Space/Project". */
  parentPath: string;
}

/**
 * Resolve a single folder-like resource (PROJECT / COMPASS_FOLDER /
 * COMPASS_SPACE, or any `resources` row) by RID into the display metadata used
 * to prefill the connection-settings UI with the location a source was created
 * in. Returns `null` when the RID does not resolve to a non-trashed resource.
 *
 * Unlike `compass.client.ts#getFolder`, this accepts projects and spaces (a
 * connection's `compassFolderRid` may point at any of them) and computes the
 * human-readable ancestor path the picker displays.
 */
export async function resolveFolder(
  rid: string,
): Promise<ResolvedFolder | null> {
  const row = await getResource(rid);
  if (!row) return null;

  const path = await computeAncestorPath(rid);

  let parentPath: string;
  if (row.parent_folder_rid) {
    parentPath = await computeAncestorPath(row.parent_folder_rid);
  } else if (row.space_rid && row.type !== "COMPASS_SPACE") {
    const space = await getResource(row.space_rid);
    parentPath = space ? `/${space.display_name}` : "/";
  } else {
    parentPath = "/";
  }

  return {
    rid: row.rid,
    displayName: row.display_name,
    type: row.type,
    path,
    parentPath,
  };
}

/**
 * Resolve a `users.id` (FK target for resources.created_by) from the
 * authenticated user's email, falling back to the earliest user so the
 * insert never violates the FK in dev/seed environments.
 */
async function resolveUserId(email: string | undefined): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT COALESCE(
        (SELECT id FROM users WHERE email = $1 LIMIT 1),
        (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
      ) AS id`,
    [email ?? null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no users available to own the output folder");
  return id;
}

async function findChildByName(
  parentRid: string,
  name: string,
): Promise<ResourceRow | null> {
  const { rows } = await pool.query<ResourceRow>(
    `SELECT rid, type, display_name, parent_folder_rid, space_rid, project_rid
       FROM resources
      WHERE parent_folder_rid = $1
        AND display_name = $2
        AND type = 'COMPASS_FOLDER'
        AND trash_status = 'NOT_TRASHED'
      LIMIT 1`,
    [parentRid, name],
  );
  return rows[0] ?? null;
}

/**
 * Ensure the default "Ontologize Public-33fd9b" space and "My Data Project"
 * project exist (idempotent by display name) and return the project RID.
 * Used when the wizard generates a default output folder without an
 * explicitly-selected parent location.
 */
async function ensureDefaultProject(ownerUserId: string): Promise<string> {
  // 1) Space
  const spaceSel = await pool.query<{ rid: string }>(
    `SELECT rid FROM resources
      WHERE type = 'COMPASS_SPACE' AND display_name = $1
        AND trash_status = 'NOT_TRASHED' LIMIT 1`,
    [DEFAULT_SPACE_NAME],
  );
  let spaceRid = spaceSel.rows[0]?.rid;
  if (!spaceRid) {
    spaceRid = `ri.compass.main.space.${randomUUID()}`;
    await pool.query(
      `INSERT INTO resources
         (rid, service, type, display_name, space_rid, created_by, updated_by)
       VALUES ($1, 'compass', 'COMPASS_SPACE', $2, $1, $3, $3)`,
      [spaceRid, DEFAULT_SPACE_NAME, ownerUserId],
    );
  }

  // 2) Project under the space
  const projSel = await pool.query<{ rid: string }>(
    `SELECT rid FROM resources
      WHERE type = 'PROJECT' AND display_name = $1 AND space_rid = $2
        AND trash_status = 'NOT_TRASHED' LIMIT 1`,
    [DEFAULT_PROJECT_NAME, spaceRid],
  );
  let projectRid = projSel.rows[0]?.rid;
  if (!projectRid) {
    projectRid = `ri.compass.main.project.${randomUUID()}`;
    await pool.query(
      `INSERT INTO resources
         (rid, service, type, display_name, space_rid, project_rid, created_by, updated_by)
       VALUES ($1, 'compass', 'PROJECT', $2, $3, $1, $4, $4)`,
      [projectRid, DEFAULT_PROJECT_NAME, spaceRid, ownerUserId],
    );
  }
  return projectRid;
}

export interface CreateOutputFolderParams {
  /** Optional parent (the wizard's selected location). Falls back to the
   *  default data project when absent or not found. */
  parentRid?: string;
  /** Folder display name. Defaults to "raw". */
  name?: string;
  /** Authenticated user's email — resolved to a users.id for created_by. */
  ownerEmail?: string;
}

/**
 * Create (or reuse) an output folder for syncs. Idempotent: if a non-trashed
 * folder with the same name already exists under the resolved parent, it is
 * returned instead of inserting a duplicate.
 */
export async function createOutputFolder(
  params: CreateOutputFolderParams,
): Promise<CreatedFolder> {
  const name = (params.name ?? DEFAULT_OUTPUT_FOLDER_NAME).trim();
  const ownerUserId = await resolveUserId(params.ownerEmail);

  // Resolve the parent. Use the provided RID only if it exists; otherwise
  // fall back to the default data project.
  let parent: ResourceRow | null = null;
  if (params.parentRid) parent = await getResource(params.parentRid);
  if (!parent) {
    const projectRid = await ensureDefaultProject(ownerUserId);
    parent = await getResource(projectRid);
  }
  if (!parent) throw new Error("could not resolve a parent for the output folder");

  // Reuse an existing identically-named folder under this parent.
  const existing = await findChildByName(parent.rid, name);
  if (existing) {
    return { rid: existing.rid, name, path: await computeAncestorPath(parent.rid) };
  }

  // Inherit the space from the parent (a space is its own space_rid).
  const spaceRid =
    parent.type === "COMPASS_SPACE" ? parent.rid : parent.space_rid;
  const projectRid =
    parent.type === "PROJECT" ? parent.rid : parent.project_rid;
  const rid = `ri.compass.main.compass-folder.${randomUUID()}`;
  await pool.query(
    `INSERT INTO resources
       (rid, service, type, display_name, parent_folder_rid, space_rid, project_rid, created_by, updated_by)
     VALUES ($1, 'compass', 'COMPASS_FOLDER', $2, $3, $4, $5, $6, $6)`,
    [rid, name, parent.rid, spaceRid, projectRid, ownerUserId],
  );

  return { rid, name, path: await computeAncestorPath(parent.rid) };
}
