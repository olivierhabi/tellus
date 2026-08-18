// Workshop home activity — the composite read behind the /workshop home table.
//
// One GET returns everything the module table renders:
//   - recency + favorite state (user_recent_activity / user_favorite)
//   - module identity (workshop_module, trashed rows excluded)
//   - the parent folder path (folders ltree chain + project name)
//   - principal display names (Keycloak, TTL-cached)
//
// This replaces the previous client-side N+1 composition (1 recents call +
// N getModule + N breadcrumb + user directory), which cost ~40 requests per
// home load and could not filter stale recents rows whose module trashed
// server-side.
//
// Self-healing: recents/favorites rows pointing at trashed or never-existing
// modules are filtered by the JOIN — no DELETE endpoint needed to purge
// user_recent_activity.

import { LRUCache } from "lru-cache";
import { getKeycloakAdminService } from "../keycloakAdminService";
import { getWorkshopDb } from "./db";

export interface ModuleActivityPrincipal {
  id: string;
  displayName: string;
}

export interface ModuleActivityItem {
  rid: string;
  displayName: string;
  description: string | null;
  parentFolderRid: string;
  /** "/project/folder/…" — never null; unresolved parents render as "—". */
  path: string;
  createdBy: ModuleActivityPrincipal | null;
  lastEditedBy: ModuleActivityPrincipal | null;
  createdAt: string;
  updatedAt: string;
  publishedSemver: string | null;
  /** null for favorited-but-never-viewed modules. */
  lastViewedAt: string | null;
  isFavorite: boolean;
}

export interface ListModuleActivityResult {
  items: ModuleActivityItem[];
}

const FOLDER_RID_PREFIX = "ri.compass.main.folder.";
export const MAX_ACTIVITY_LIMIT = 100;

interface ActivityRow {
  rid: string;
  display_name: string;
  description: string | null;
  parent_folder_rid: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  published_semver: string | null;
  last_viewed_at: string | null;
  is_favorite: boolean;
}

// ---- Principal display-name resolution ----------------------------------
//
// Keycloak admin lookups per activity row would make the endpoint chatty
// (≤ 2 × limit calls). Display names change rarely, so resolve through a
// small promise-valued LRU (5-min TTL); caching the *promise* also coalesces
// concurrent requests for the same principal. 404 → null → the caller falls
// back to the raw id, matching the FE directory contract.
const principalCache = new LRUCache<string, Promise<string | null>>({
  max: 500,
  ttl: 5 * 60_000,
});

function principalDisplayName(u: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string;
}): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.username;
}

/** Exposed for tests — records resolved display names by principal id. */
export type PrincipalResolver = (ids: string[]) => Promise<Map<string, string>>;

export async function defaultPrincipalResolver(
  ids: string[],
): Promise<Map<string, string>> {
  const resolved = await Promise.all(
    ids.map(async (id) => {
      let pending = principalCache.get(id);
      if (!pending) {
        pending = getKeycloakAdminService()
          .getUserById(id)
          .then((u) => (u ? principalDisplayName(u) : null))
          .catch(() => {
            // Keycloak admin outage: degrade to raw ids rather than failing
            // the whole home table.
            principalCache.delete(id);
            return null;
          });
        principalCache.set(id, pending);
      }
      return [id, await pending] as const;
    }),
  );
  const out = new Map<string, string>();
  for (const [id, name] of resolved) {
    if (name) out.set(id, name);
  }
  return out;
}

// ---- Path composition -----------------------------------------------------

/**
 * "/{project}/{ancestor chain}" — the Foundry convention for the row
 * subtitle. Exported for direct unit coverage.
 */
export function composeModulePath(
  projectName: string | null,
  folderChain: string | null,
): string {
  if (!projectName) return "—";
  return folderChain ? `/${projectName}/${folderChain}` : `/${projectName}`;
}

async function resolveFolderPaths(
  parentFolderRids: string[],
): Promise<Map<string, string>> {
  const uuids = parentFolderRids
    .filter((r) => r.startsWith(FOLDER_RID_PREFIX))
    .map((r) => r.slice(FOLDER_RID_PREFIX.length));
  const paths = new Map<string, string>();
  if (uuids.length === 0) return paths;

  // Folders carry an ltree path; the project root's UUID may (deployment-
  // dependent) map straight onto the projects row instead of a folders row,
  // hence the two-step resolution.
  const folderRows = await getWorkshopDb().query(
    `SELECT f.id::text AS id, p.name AS project_name,
            (SELECT string_agg(a.name, '/' ORDER BY a.depth)
               FROM folders a
              WHERE a.project_id = f.project_id
                AND a.path @> f.path) AS chain
       FROM folders f
       JOIN projects p ON p.id = f.project_id
      WHERE f.id::text = ANY($1::text[])`,
    [uuids],
  );
  for (const row of folderRows.rows as Array<{
    id: string;
    project_name: string;
    chain: string | null;
  }>) {
    paths.set(row.id, composeModulePath(row.project_name, row.chain));
  }

  const unresolved = uuids.filter((id) => !paths.has(id));
  if (unresolved.length > 0) {
    const projectRows = await getWorkshopDb().query(
      `SELECT id::text AS id, name FROM projects
        WHERE id::text = ANY($1::text[])`,
      [unresolved],
    );
    for (const row of projectRows.rows as Array<{ id: string; name: string }>) {
      paths.set(row.id, composeModulePath(row.name, null));
    }
  }
  return paths;
}

// ---- Composite query ------------------------------------------------------

/**
 * Recents ∪ favorites for the caller, enriched for the home table.
 * Recency ordering (NULLS LAST) then case-insensitive displayName, keyed by
 * rid for stability.
 */
export async function listModuleActivity(
  userId: string,
  args: { limit?: number; resolvePrincipals?: PrincipalResolver } = {},
): Promise<ListModuleActivityResult> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), MAX_ACTIVITY_LIMIT);
  const db = getWorkshopDb();

  // user_recent_activity has no unique constraint — the write-side
  // (POST /recent) races under React strict-mode double-invoke and can
  // leave duplicates. `GET /recent` already dedupes read-side for this
  // reason; mirror it with GROUP BY here so one module = one row.
  const result = await db.query(
    `SELECT m.rid, m.display_name, m.description, m.parent_folder_rid,
            m.created_by, m.updated_by, m.created_at, m.updated_at,
            m.published_semver,
            ra.last_viewed_at,
            (fav.resource_id IS NOT NULL) AS is_favorite
       FROM workshop_module m
       LEFT JOIN (
         SELECT resource_id, max(visited_at) AS last_viewed_at
           FROM user_recent_activity
          WHERE user_id = $1 AND resource_type = 'workshop_module'
          GROUP BY resource_id
       ) ra ON ra.resource_id = m.rid
       LEFT JOIN (
         SELECT DISTINCT resource_id
           FROM user_favorite
          WHERE user_id = $1 AND resource_type = 'workshop_module'
       ) fav ON fav.resource_id = m.rid
      WHERE m.deleted_at IS NULL
        AND (ra.resource_id IS NOT NULL OR fav.resource_id IS NOT NULL)
      ORDER BY ra.last_viewed_at DESC NULLS LAST, lower(m.display_name), m.rid
      LIMIT ${limit}`,
    [userId],
  );
  const rows = result.rows as ActivityRow[];
  if (rows.length === 0) return { items: [] };

  // Two bounded fan-outs, parallel: folder paths (DB) + principal names
  // (Keycloak via TTL cache).
  const parentFolderRids = Array.from(
    new Set(rows.map((r) => r.parent_folder_rid)),
  );
  const principalIds = Array.from(
    new Set(rows.flatMap((r) => [r.created_by, r.updated_by])),
  );
  const resolvePrincipals = args.resolvePrincipals ?? defaultPrincipalResolver;
  const [pathByUuid, nameById] = await Promise.all([
    resolveFolderPaths(parentFolderRids),
    resolvePrincipals(principalIds),
  ]);

  const principal = (id: string): ModuleActivityPrincipal | null =>
    id
      ? { id, displayName: nameById.get(id) ?? id }
      : null;

  const items: ModuleActivityItem[] = rows.map((r) => ({
    rid: r.rid,
    displayName: r.display_name,
    description: r.description,
    parentFolderRid: r.parent_folder_rid,
    path:
      pathByUuid.get(r.parent_folder_rid.slice(FOLDER_RID_PREFIX.length)) ??
      "—",
    createdBy: principal(r.created_by),
    lastEditedBy: principal(r.updated_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedSemver: r.published_semver,
    lastViewedAt: r.last_viewed_at,
    isFavorite: Boolean(r.is_favorite),
  }));
  return { items };
}
