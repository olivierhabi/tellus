// Pipeline home activity — the composite read behind the /pipeline home table.
//
// Mirrors the Workshop home contract (services/workshop/activityService.ts)
// so the two app-home surfaces share one architecture:
//   - one GET returns recency + favorite state (user_recent_activity /
//     user_favorite), pipeline identity, the owning project's name, and the
//     creator's display name (Keycloak, TTL-cached via the workshop service's
//     exported resolver)
//   - replaces the client-side fan-out (project list + per-project pipeline
//     list) with a single user-scoped read
//
// Self-healing: recents/favorites rows pointing at archived (trashed) or
// never-existing pipelines are filtered by the JOIN — no DELETE endpoint
// needed to purge user_recent_activity. `pipelines.status='archived'` is the
// pipeline trash state (the table has no deleted_at column).

import type { QueryResult } from "pg";
import { query as productionQuery } from "../../db";
import {
  defaultPrincipalResolver,
  type ModuleActivityPrincipal,
  type PrincipalResolver,
} from "../workshop/activityService";

export interface PipelineActivityItem {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  projectName: string | null;
  /** "/{projectName}" — never null; unresolved projects render as "—". */
  path: string;
  pipelineType: string;
  status: string;
  createdBy: ModuleActivityPrincipal | null;
  createdAt: string;
  updatedAt: string;
  /** null for favorited-but-never-viewed pipelines. */
  lastViewedAt: string | null;
  isFavorite: boolean;
}

export interface ListPipelineActivityResult {
  items: PipelineActivityItem[];
}

export const MAX_PIPELINE_ACTIVITY_LIMIT = 100;

/** Injectable DB handle — production binding defaults to the shared pool. */
export interface PipelineActivityDb {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

const defaultDb: PipelineActivityDb = { query: productionQuery };

interface ActivityRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string;
  project_name: string | null;
  pipeline_type: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_viewed_at: string | null;
  is_favorite: boolean;
}

/**
 * Recents ∪ favorites for the caller, enriched for the home table.
 * Recency ordering (NULLS LAST) then case-insensitive name, keyed by id for
 * stability.
 */
export async function listPipelineActivity(
  userId: string,
  args: {
    limit?: number;
    resolvePrincipals?: PrincipalResolver;
    db?: PipelineActivityDb;
  } = {},
): Promise<ListPipelineActivityResult> {
  const limit = Math.min(
    Math.max(args.limit ?? 50, 1),
    MAX_PIPELINE_ACTIVITY_LIMIT,
  );
  const db = args.db ?? defaultDb;

  // user_recent_activity has no unique constraint — see the identical
  // dedupe note in workshop/activityService.ts (strict-mode write race).
  const result = await db.query(
    `SELECT p.id, p.name, p.description, p.project_id, p.pipeline_type,
            p.status, p.created_by, p.created_at, p.updated_at,
            pr.name AS project_name,
            ra.last_viewed_at,
            (fav.resource_id IS NOT NULL) AS is_favorite
       FROM pipelines p
       LEFT JOIN projects pr ON pr.id = p.project_id
       LEFT JOIN (
         SELECT resource_id, max(visited_at) AS last_viewed_at
           FROM user_recent_activity
          WHERE user_id = $1 AND resource_type = 'pipeline'
          GROUP BY resource_id
       ) ra ON ra.resource_id = p.id::text
       LEFT JOIN (
         SELECT DISTINCT resource_id
           FROM user_favorite
          WHERE user_id = $1 AND resource_type = 'pipeline'
       ) fav ON fav.resource_id = p.id::text
      WHERE p.status <> 'archived'
        AND (ra.resource_id IS NOT NULL OR fav.resource_id IS NOT NULL)
      ORDER BY ra.last_viewed_at DESC NULLS LAST, lower(p.name), p.id
      LIMIT ${limit}`,
    [userId],
  );
  const rows = result.rows as ActivityRow[];
  if (rows.length === 0) return { items: [] };

  const creatorIds = Array.from(
    new Set(rows.flatMap((r) => (r.created_by ? [r.created_by] : []))),
  );
  const resolvePrincipals = args.resolvePrincipals ?? defaultPrincipalResolver;
  const nameById = await resolvePrincipals(creatorIds);

  const principal = (id: string | null): ModuleActivityPrincipal | null =>
    id ? { id, displayName: nameById.get(id) ?? id } : null;

  const items: PipelineActivityItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    projectId: r.project_id,
    projectName: r.project_name,
    path: r.project_name ? `/${r.project_name}` : "—",
    pipelineType: r.pipeline_type,
    status: r.status,
    createdBy: principal(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastViewedAt: r.last_viewed_at,
    isFavorite: Boolean(r.is_favorite),
  }));
  return { items };
}
