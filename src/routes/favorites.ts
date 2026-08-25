// ---------------------------------------------------------------------------
// Favorites / Recent activity — Ontology Platform spec Task 14 (OMA)
// ---------------------------------------------------------------------------
// Mounted at /api/v1/users/me/favorites
//   POST   /                    — mark a resource as favorite
//   DELETE /:type/:id           — unfavorite
//   GET    /                    — list favorites for the current user
//   POST   /recent              — record a recent visit
//   GET    /recent              — list the 50 most recent items
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { resolveDataset } from "../services/datasets/dataset-resolver";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { currentUser } from "../middleware/currentUser";
import { routeMetric } from "../utils/routeInstrumentation";

const router = Router();

const MAX_RECENTS = 50;

/**
 * Resolve a human-readable `name` + icon `kind` (+ navigation context)
 * for each recent item.
 *
 * `user_recent_activity` stores only `(resource_type, resource_id,
 * visited_at)` — no name — so without this step every FE consumer would
 * have to N+1-resolve names itself. We batch one SELECT per resource_type
 * present in the page (bounded by MAX_RECENTS rows ⇒ at most a handful of
 * types) and cast ids to text so uuid and text primary keys both match.
 *
 * Navigation context returned when available:
 *   - `project_id`     for folder / pipeline (routes are project-scoped)
 *   - `object_type_id` for object_type (FE routes key on UUID, not api_name)
 *
 * Graceful by design: an unknown resource_type, a missing table/column,
 * or a type mismatch must NEVER break the recents list — the row is still
 * returned with `name: null` and `kind: resource_type`, so the FE can
 * always render "X minutes ago" and fall back to the resource id.
 */
const RECENT_RESOLVERS: Record<
  string,
  {
    table: string;
    idCol: string;
    nameCol: string;
    kind: string;
    /** Optional extra column (e.g. project_id) aliased as project_id. */
    projectIdCol?: string;
    /** Optional extra column aliased as object_type_id. */
    objectTypeIdCol?: string;
  }
> = {
  project: { table: "projects", idCol: "id", nameCol: "name", kind: "folder" },
  pipeline: {
    table: "pipelines",
    idCol: "id",
    nameCol: "name",
    kind: "code",
    projectIdCol: "project_id",
  },
  folder: {
    table: "folders",
    idCol: "id",
    nameCol: "name",
    kind: "folder",
    projectIdCol: "project_id",
  },
  // Datasets surfaced via /projects/:pid/datasets/all come from the
  // foundry_datasets table (id + name — see projectUploads.ts /datasets/all),
  // NOT the legacy `dataset` table (whose PK is dataset_id).
  dataset: { table: "foundry_datasets", idCol: "id", nameCol: "name", kind: "doc" },
  object_type: {
    table: "object_type",
    idCol: "api_name",
    nameCol: "display_name",
    kind: "ontology",
    objectTypeIdCol: "object_type_id",
  },
  // Code repositories live in their own `code_repository` table (rid +
  // display_name — see services/codeRepository/rehydrate.ts). The rid is
  // unique so a name resolves cleanly.
  code_repository: {
    table: "code_repository",
    idCol: "rid",
    nameCol: "display_name",
    kind: "code",
  },
  // Workshop modules live in their own table (rid + display_name — see
  // migrations/058_b1_workshop_module.sql).
  workshop_module: {
    table: "workshop_module",
    idCol: "rid",
    nameCol: "display_name",
    kind: "learning",
  },
  // Data-connection sources live in `connectivity_connections` (rid + name —
  // see services/connectivity/store/connections.repo.ts findByRid).
  data_connection: {
    table: "connectivity_connections",
    idCol: "rid",
    nameCol: "name",
    kind: "equip",
  },
};
// NOTE: `foundry_dataset` (ri.foundry.main.dataset.*) is NOT in the table map
// — sync-generated dataset rids often have NO `resources` identity row, so the
// name must come from resolveDataset() (which falls back to producer/registry).
// Handled by a special case in resolveRecentNames below.

type ResolvedMeta = {
  name: string | null;
  kind: string;
  project_id?: string | null;
  object_type_id?: string | null;
};

async function resolveRecentNames(
  rows: { resource_type: string; resource_id: string; visited_at: string }[],
) {
  if (rows.length === 0) return rows;
  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const list = byType.get(r.resource_type) ?? [];
    list.push(r.resource_id);
    byType.set(r.resource_type, list);
  }
  const resolved = new Map<string, ResolvedMeta>();
  for (const [type, ids] of byType) {
    // foundry_dataset: sync-generated rids may have no `resources` identity
    // row, so resolve via resolveDataset() (falls back to producer/registry
    // .name). One call per rid (bounded by MAX_RECENTS).
    if (type === "foundry_dataset") {
      for (const id of Array.from(new Set(ids))) {
        try {
          const ds = await resolveDataset(id);
          if (ds?.name)
            resolved.set(`foundry_dataset:${id}`, { name: ds.name, kind: "doc" });
        } catch {
          // graceful
        }
      }
      continue;
    }
    const cfg = RECENT_RESOLVERS[type];
    if (!cfg) continue;
    try {
      const uniqueIds = Array.from(new Set(ids));
      const extras: string[] = [];
      if (cfg.projectIdCol) {
        extras.push(`${cfg.projectIdCol}::text AS project_id`);
      }
      if (cfg.objectTypeIdCol) {
        extras.push(`${cfg.objectTypeIdCol}::text AS object_type_id`);
      }
      const extraSql = extras.length ? `, ${extras.join(", ")}` : "";
      const r = await query(
        `SELECT ${cfg.idCol}::text AS id, ${cfg.nameCol} AS name${extraSql}
           FROM ${cfg.table}
          WHERE ${cfg.idCol}::text = ANY($1::text[])`,
        [uniqueIds],
      );
      for (const row of r.rows) {
        resolved.set(`${type}:${row.id}`, {
          name: (row.name as string | null) ?? null,
          kind: cfg.kind,
          project_id: (row.project_id as string | null | undefined) ?? null,
          object_type_id:
            (row.object_type_id as string | null | undefined) ?? null,
        });
      }
    } catch {
      // Graceful: never let one bad type break the whole recents list.
    }
  }
  return rows.map((r) => {
    const hit = resolved.get(`${r.resource_type}:${r.resource_id}`);
    return {
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      visited_at: r.visited_at,
      name: hit?.name ?? null,
      kind: hit?.kind ?? r.resource_type,
      project_id: hit?.project_id ?? null,
      object_type_id: hit?.object_type_id ?? null,
    };
  });
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "favorites.toggle", null);
    const { resourceType, resourceId } = req.body || {};
    if (!resourceType || !resourceId) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and resourceId required.");
    }
    await query(
      `INSERT INTO user_favorite (user_id, resource_type, resource_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [currentUser(req), resourceType, resourceId]
    );
    sendCreated(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/:resourceType/:resourceId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      routeMetric(req, "favorites.toggle", null);
      await query(
        `DELETE FROM user_favorite
          WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [currentUser(req), req.params.resourceType, req.params.resourceId]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "favorites.list", null);
    const result = await query(
      "SELECT resource_type, resource_id, created_at FROM user_favorite WHERE user_id = $1 ORDER BY created_at DESC",
      [currentUser(req)]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.post("/recent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "favorites.recent.record", null);
    const { resourceType, resourceId } = req.body || {};
    if (!resourceType || !resourceId) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and resourceId required.");
    }
    const userId = currentUser(req);
    // Upsert without relying on a unique constraint: delete any existing
    // row for this (user, type, id) then insert, so revisiting a resource
    // refreshes `visited_at` instead of producing duplicate recents.
    await query(
      `DELETE FROM user_recent_activity
        WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
      [userId, resourceType, resourceId],
    );
    await query(
      `INSERT INTO user_recent_activity (user_id, resource_type, resource_id)
       VALUES ($1, $2, $3)`,
      [userId, resourceType, resourceId],
    );
    // Trim to the last MAX_RECENTS entries per user.
    await query(
      `DELETE FROM user_recent_activity
         WHERE id IN (
           SELECT id FROM user_recent_activity
            WHERE user_id = $1
            ORDER BY visited_at DESC
           OFFSET $2
         )`,
      [userId, MAX_RECENTS]
    );
    sendCreated(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/recent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "favorites.recent.list", null);
    // DISTINCT ON (resource_type, resource_id) de-dupes: the write-side
    // (useRecordRecent) can fire twice in React strict-mode dev (double
    // useEffect invoke), and the delete-then-insert POST races under that
    // burst, leaving duplicate rows. Collapse to one row per entity (the
    // most recent), then order by recency + cap.
    const result = await query(
      `SELECT resource_type, resource_id, visited_at
         FROM (
           SELECT DISTINCT ON (resource_type, resource_id)
                  resource_type, resource_id, visited_at
             FROM user_recent_activity
            WHERE user_id = $1
            ORDER BY resource_type, resource_id, visited_at DESC
         ) sub
         ORDER BY visited_at DESC
         LIMIT $2`,
      [currentUser(req), MAX_RECENTS]
    );
    const data = await resolveRecentNames(result.rows);
    sendSuccess(res, { data, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

export default router;
