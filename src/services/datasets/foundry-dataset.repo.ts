// ---------------------------------------------------------------------------
// Foundry-parity Dataset repository — Create Dataset.
//
// Mirrors the Palantir Foundry "Create Dataset" semantics
// (https://www.palantir.com/docs/foundry/api/v2/datasets-v2-resources/datasets/create-dataset/):
// a Dataset is a Compass resource (`resources` row, type='DATASET') created
// inside a parent folder/project/space. Creating one does NOT materialise any
// data — data arrives later via transactions / syncs — exactly like Foundry,
// where create-dataset returns an empty dataset resource.
//
// Validations replicated from Foundry:
//   - the parent must be an existing, non-trashed container (FolderNotFound)
//   - the name must be unique among non-trashed siblings (ResourceNameAlreadyExists)
// The RID follows Foundry's shape: ri.foundry.main.dataset.<uuid>.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { pool } from "../../db";

/** Resource types a dataset may be parented under (Compass containers). */
const CONTAINER_TYPES = new Set(["PROJECT", "COMPASS_FOLDER", "COMPASS_SPACE"]);

/** Thrown when `parentFolderRid` does not resolve to a live container. */
export class ParentFolderNotFound extends Error {
  constructor(public readonly parentFolderRid: string) {
    super(`parent folder not found: ${parentFolderRid}`);
    this.name = "ParentFolderNotFound";
  }
}

/** Thrown when a sibling resource already uses the requested name. */
export class DatasetNameAlreadyExists extends Error {
  constructor(
    public readonly datasetName: string,
    public readonly parentFolderRid: string,
  ) {
    super(`name already exists in folder: ${datasetName}`);
    this.name = "DatasetNameAlreadyExists";
  }
}

export interface CreateDatasetInput {
  name: string;
  parentFolderRid: string;
  /** Authenticated principal id/email/sub; resolved to a users.id for ownership. */
  actor?: string;
}

export interface CreatedDataset {
  rid: string;
  name: string;
  parentFolderRid: string;
}

/**
 * Resolve a `users.id` (FK target for resources.created_by) from the
 * authenticated principal, tolerant of an id, an email, or neither: falls back
 * to the earliest user so the insert never violates the FK in dev/seed.
 * (`id::text` comparison avoids a uuid cast error when the principal is a
 * non-uuid subject claim.)
 */
async function resolveOwnerId(actor: string | undefined): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT COALESCE(
        (SELECT id FROM users WHERE id::text = $1 LIMIT 1),
        (SELECT id FROM users WHERE email = $1 LIMIT 1),
        (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
      ) AS id`,
    [actor ?? null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no users available to own the dataset");
  return id;
}

/**
 * Create an empty Dataset resource under `parentFolderRid`.
 * Throws {@link ParentFolderNotFound} / {@link DatasetNameAlreadyExists} for
 * the caller to translate into the Foundry error envelope.
 */
export async function createDataset(
  input: CreateDatasetInput,
): Promise<CreatedDataset> {
  const { name, parentFolderRid } = input;

  // 1. Parent must exist, be live, and be a container.
  const parent = await pool.query<{
    rid: string;
    type: string;
    space_rid: string | null;
    project_rid: string | null;
  }>(
    `SELECT rid, type, space_rid, project_rid
       FROM resources
      WHERE rid = $1 AND trash_status = 'NOT_TRASHED'`,
    [parentFolderRid],
  );
  if (parent.rowCount === 0 || !CONTAINER_TYPES.has(parent.rows[0].type)) {
    throw new ParentFolderNotFound(parentFolderRid);
  }
  const p = parent.rows[0];

  // 2. Name must be unique among non-trashed siblings (any resource type).
  const dupe = await pool.query(
    `SELECT 1 FROM resources
      WHERE parent_folder_rid = $1 AND display_name = $2
        AND trash_status = 'NOT_TRASHED'
      LIMIT 1`,
    [parentFolderRid, name],
  );
  if ((dupe.rowCount ?? 0) > 0) {
    throw new DatasetNameAlreadyExists(name, parentFolderRid);
  }

  // 3. Insert. Inherit space/project from the parent (a space/project is its
  //    own space_rid/project_rid).
  const ownerId = await resolveOwnerId(input.actor);
  const spaceRid = p.type === "COMPASS_SPACE" ? p.rid : p.space_rid;
  const projectRid = p.type === "PROJECT" ? p.rid : p.project_rid;
  const rid = `ri.foundry.main.dataset.${randomUUID()}`;

  await pool.query(
    `INSERT INTO resources
       (rid, service, type, display_name, parent_folder_rid,
        space_rid, project_rid, created_by, updated_by)
     VALUES ($1, 'foundry', 'DATASET', $2, $3, $4, $5, $6, $6)`,
    [rid, name, parentFolderRid, spaceRid, projectRid, ownerId],
  );

  return { rid, name, parentFolderRid };
}
