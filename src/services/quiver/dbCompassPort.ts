// Quiver — DB-backed CompassPort (missing-authorization fix).
//
// Closes the finding that any authenticated user could read/mutate any
// analysis: the analysisService authorization seam (CompassPort) had only a
// no-op default and nothing in-tree ever wired a real implementation. This
// module is the real implementation, wired at router mount time by
// `wireDbCompassPort()` (src/routes/quiver/index.ts).
//
// Membership model (mirrors src/services/functionsRegistry/admin/routes.ts
// and src/services/datasetAcl.ts):
//   folderRid → resources row (rid, NOT_TRASHED) → project_rid UUID suffix
//     → projects.id   (fallback: trailing-UUID → folders.project_id, which
//     covers both `ri.compass.main.folder.*` and legacy
//     `ri.compass.main.compass-folder.*` parent shapes)
//   edit  = projects.owner_id = user  OR project_members role owner|editor
//   read  = edit  OR project_members role viewer
//
// Identity: `userSubject` is the LOCAL users.id UUID (globalAuth provisions
// it before req.user is exposed; the quiver router bridge copies it into
// securityContext). Non-UUID subjects can never match a membership row —
// they fail closed, they do not fail open.
//
// Fail-closed contract: every DB error denies (42P01/42703/3F000 →
// CompassNotConfigured "tables absent"; anything else → CompassUnavailable).
// An error during an authorization check is never permission granted.

import { query } from "../../db";
import { ROOT_SPACE_RID } from "../../lib/rid";
import type { CompassPort } from "./analysisService";
import {
  analysisNotFound,
  compassNotConfigured,
  compassUnavailable,
  insufficientPermission,
  isQuiverError,
  parentFolderNotFound,
} from "./errors";

/** Local users.id shape (project_members.user_id / projects.owner_id are
 *  UUID columns — a non-UUID subject cannot be a member). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Folder/project RIDs carry the underlying row UUID as their last segment. */
const TRAILING_UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type ProjectRole = "owner" | "editor" | "viewer";

/** Map any check failure onto a deny — never rethrow raw DB errors (they
 *  would surface as a generic 500 INTERNAL; a denial with a cause is both
 *  fail-closed and debuggable). */
function denyOnDbError(e: unknown): never {
  const code = (e as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "3F000") {
    throw compassNotConfigured({
      reason:
        "Compass tables are absent (resources / projects / project_members / folders)",
      pgErrorCode: code,
    });
  }
  throw compassUnavailable({ reason: "Compass authorization check failed" });
}

/**
 * Resolve a folder RID to its owning project id, or null when the folder
 * does not exist / is (ancestor-)trashed / cannot be tied to a project.
 */
async function resolveFolderProject(folderRid: string): Promise<string | null> {
  try {
    // 1. Compass resources row by exact rid (covers `folder.*`,
    //    `compass-folder.*` and the project-root rid itself).
    const res = await query(
      `SELECT trash_status, project_rid FROM resources WHERE rid = $1 LIMIT 1`,
      [folderRid],
    );
    const row = res.rows[0] as
      | { trash_status: string; project_rid: string | null }
      | undefined;
    if (row) {
      if (row.trash_status !== "NOT_TRASHED") return null;
      const m = row.project_rid?.match(TRAILING_UUID_RE);
      if (m) {
        const p = await query(
          `SELECT id::text AS project_id FROM projects WHERE id::text = $1 LIMIT 1`,
          [m[1]],
        );
        if (p.rows[0]) return p.rows[0].project_id as string;
      }
    }
    // 2. Legacy/alternate prefixes: the folders table keyed by the trailing
    //    UUID segment (same resolution fallback the workshop module mirror
    //    uses for legacy `folder.*` parents).
    const m2 = folderRid.match(TRAILING_UUID_RE);
    if (m2) {
      const f = await query(
        `SELECT project_id::text AS project_id FROM folders WHERE id::text = $1 LIMIT 1`,
        [m2[1]],
      );
      if (f.rows[0]) return f.rows[0].project_id as string;
    }
    return null;
  } catch (e) {
    denyOnDbError(e);
  }
}

/** Effective project role for the user; null = no membership anywhere. */
async function resolveProjectRole(
  projectId: string,
  userSubject: string,
): Promise<ProjectRole | null> {
  if (!UUID_RE.test(userSubject)) return null; // can't match a UUID column
  try {
    const own = await query(
      `SELECT 1 FROM projects WHERE id::text = $1 AND owner_id::text = $2 LIMIT 1`,
      [projectId, userSubject],
    );
    if (own.rowCount && own.rowCount > 0) return "owner";
    const pm = await query(
      `SELECT role FROM project_members WHERE project_id::text = $1 AND user_id::text = $2 LIMIT 1`,
      [projectId, userSubject],
    );
    const role = pm.rows[0]?.role as string | undefined;
    if (role === "owner" || role === "editor" || role === "viewer") {
      return role as ProjectRole;
    }
    return null;
  } catch (e) {
    denyOnDbError(e);
  }
}

function assertRole(
  folderRid: string,
  role: ProjectRole | null,
  floor: "viewer" | "editor",
): void {
  if (role === null) {
    throw insufficientPermission({
      folderRid,
      requiredRole: floor,
      actualRole: "none",
    });
  }
  if (floor === "editor" && role === "viewer") {
    throw insufficientPermission({
      folderRid,
      requiredRole: "editor",
      actualRole: role,
    });
  }
}

/** The production CompassPort: membership-backed, fail-closed. */
export const dbCompassPort: CompassPort = {
  async assertEditorOnFolder({ folderRid, userSubject }) {
    const projectId = await resolveFolderProject(folderRid);
    if (projectId === null) throw parentFolderNotFound({ folderRid });
    assertRole(folderRid, await resolveProjectRole(projectId, userSubject), "editor");
  },

  async assertFolderReadable({ folderRid, userSubject }) {
    const projectId = await resolveFolderProject(folderRid);
    if (projectId === null) throw parentFolderNotFound({ folderRid });
    assertRole(folderRid, await resolveProjectRole(projectId, userSubject), "viewer");
  },

  async registerAnalysis({
    rid,
    parentFolderRid,
    displayName,
    userSubject,
  }) {
    const projectId = await resolveFolderProject(parentFolderRid);
    if (projectId === null) {
      throw parentFolderNotFound({ folderRid: parentFolderRid });
    }
    if (!UUID_RE.test(userSubject)) {
      // resources.created_by is a users FK — a non-local principal cannot
      // own the registration row. Fail closed rather than inserting a
      // fabricated owner.
      throw insufficientPermission({
        rid,
        reason: "registering principal is not a local user",
      });
    }
    try {
      await query(
        `INSERT INTO resources
           (rid, service, type, display_name,
            parent_folder_rid, project_rid, space_rid, trash_status,
            created_by, updated_by)
         VALUES ($1, 'tellus-quiver', 'ANALYSIS', $2,
                 $3, $4, $5, 'NOT_TRASHED',
                 $6::uuid, $6::uuid)
         ON CONFLICT (rid) DO NOTHING`,
        [
          rid,
          displayName,
          parentFolderRid,
          `ri.compass.main.project.${projectId}`,
          ROOT_SPACE_RID,
          userSubject,
        ],
      );
    } catch (e) {
      denyOnDbError(e);
    }
  },

  async assertReadable({ rid, userSubject }) {
    let parentFolderRid: string;
    try {
      const r = await query(
        `SELECT parent_folder_rid, is_deleted FROM quiver_analysis WHERE rid = $1 LIMIT 1`,
        [rid],
      );
      const row = r.rows[0] as
        | { parent_folder_rid: string; is_deleted: boolean }
        | undefined;
      if (!row || row.is_deleted) throw analysisNotFound({ rid });
      parentFolderRid = row.parent_folder_rid;
    } catch (e) {
      if (isQuiverError(e)) throw e;
      denyOnDbError(e);
    }
    const projectId = await resolveFolderProject(parentFolderRid);
    if (projectId === null) {
      // The analysis exists but its parent cannot be tied to a project —
      // deny rather than leak the row to an unresolvable audience.
      throw insufficientPermission({
        rid,
        reason: "analysis parent folder does not resolve to a project",
      });
    }
    const role = await resolveProjectRole(projectId, userSubject);
    if (role === null) {
      throw insufficientPermission({
        rid,
        requiredRole: "viewer",
        actualRole: "none",
      });
    }
  },
};
