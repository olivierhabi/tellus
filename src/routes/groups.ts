// ---------------------------------------------------------------------------
// Object Type Groups — Ontology Platform spec Task 15
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { objectTypeIndexName } from "../services/opensearch/objectIndexNames";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { client as osClient } from "../services/opensearch/client";
import { dataPlaneGuard } from "../middleware/requireRole";

const router = Router({ mergeParams: true });

// Function-level authorization: group create/update require ontology-editor;
// delete requires ontology-admin (PATs scope-gated upstream, superadmin
// passes, reads open).
router.use(dataPlaneGuard({ post: "write" }));

// Spec §Task 15: "Object count per card: cached in Elasticsearch _count,
// refreshed every 60s (not on every render)."
const COUNT_CACHE_TTL_MS = 60_000;
interface CountCacheEntry {
  count: number;
  expires: number;
}
const countCache = new Map<string, CountCacheEntry>();

async function getCachedCount(apiName: string): Promise<number | null> {
  const cached = countCache.get(apiName);
  if (cached && cached.expires > Date.now()) return cached.count;
  try {
    const result = await osClient.count({ index: objectTypeIndexName(apiName) });
    const count = Number((result.body as { count?: number })?.count ?? 0);
    countCache.set(apiName, { count, expires: Date.now() + COUNT_CACHE_TTL_MS });
    return count;
  } catch {
    return null;
  }
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { apiName, displayName, description, icon } = req.body || {};
    if (!apiName || !displayName) {
      return sendError(
        res,
        "VALIDATION_FAILED",
        "apiName and displayName are required."
      );
    }
    // The legacy schema uses `name`; the new schema adds `api_name` and
    // `display_name`. We set all three so INSERT succeeds regardless of
    // which schema is present in the live DB.
    const result = await query(
      `INSERT INTO object_type_group
         (ontology_id, name, api_name, display_name, description, icon)
       VALUES ($1, $2, $2, $3, $4, $5)
       RETURNING *`,
      [ontologyId, apiName, displayName, description || null, icon || "folder"]
    );
    sendCreated(res, result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return sendError(
        res,
        "API_NAME_CONFLICT",
        "A group with that apiName already exists."
      );
    }
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT g.*,
              (SELECT COUNT(*)::int FROM object_type_group_member m WHERE m.group_id = g.group_id) AS member_count
         FROM object_type_group g
        WHERE g.ontology_id = $1
        ORDER BY g.display_name`,
      [ontologyId]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/:groupApiName/counts",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, groupApiName } = req.params;
      const members = await query(
        `SELECT ot.api_name
           FROM object_type_group g
           JOIN object_type_group_member m ON m.group_id = g.group_id
           JOIN object_type ot ON ot.object_type_id = m.object_type_id
          WHERE g.ontology_id = $1 AND g.api_name = $2`,
        [ontologyId, groupApiName]
      );
      const counts: Record<string, number | null> = {};
      await Promise.all(
        members.rows.map(async (r: { api_name: string }) => {
          counts[r.api_name] = await getCachedCount(r.api_name);
        })
      );
      sendSuccess(res, { counts, cachedTtlMs: COUNT_CACHE_TTL_MS });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/graph", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    // Cytoscape-style nodes+edges. Cap at 200 nodes per spec.
    const groups = await query(
      "SELECT group_id, api_name, display_name FROM object_type_group WHERE ontology_id = $1 LIMIT 200",
      [ontologyId]
    );
    const members = await query(
      `SELECT m.group_id, ot.api_name AS object_type_api_name
         FROM object_type_group_member m
         JOIN object_type ot ON ot.object_type_id = m.object_type_id
        WHERE ot.ontology_id = $1`,
      [ontologyId]
    );
    const nodes = groups.rows.map((g: any) => ({
      data: { id: `g:${g.group_id}`, label: g.display_name, kind: "group" },
    }));
    const edges = members.rows.map((m: any) => ({
      data: {
        source: `g:${m.group_id}`,
        target: `ot:${m.object_type_api_name}`,
      },
    }));
    sendSuccess(res, {
      nodes,
      edges,
      truncated: groups.rowCount === 200,
    });
  } catch (err) {
    next(err);
  }
});

// UUID v1-v5 matcher. Both the group_id and object_type_id are UUIDs in
// `object_type_group` / `object_type` so we validate strictly before
// touching the DB.
const UUID_REGEX_GROUPS =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// UUID-keyed group membership add. Production callers should use this
// path — both group and object type are addressed by their stable UUID
// so a downstream rename never breaks the binding. Mounted BEFORE the
// `/:groupApiName/members` route so the literal `/by-id/...` segment
// wins under Express's first-match routing.
router.post(
  "/by-id/:groupId/members",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, groupId } = req.params;
      const { objectTypeId } = (req.body || {}) as { objectTypeId?: string };
      if (!UUID_REGEX_GROUPS.test(groupId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          `'${groupId}' is not a valid group UUID.`
        );
      }
      if (!objectTypeId || !UUID_REGEX_GROUPS.test(objectTypeId)) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "Body must include a valid `objectTypeId` UUID."
        );
      }
      const g = await query(
        "SELECT group_id FROM object_type_group WHERE ontology_id = $1 AND group_id = $2",
        [ontologyId, groupId]
      );
      const o = await query(
        "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND object_type_id = $2",
        [ontologyId, objectTypeId]
      );
      if (g.rowCount === 0) {
        return sendError(
          res,
          "GROUP_NOT_FOUND",
          `Group '${groupId}' not found in ontology '${ontologyId}'.`
        );
      }
      if (o.rowCount === 0) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${objectTypeId}' not found in ontology '${ontologyId}'.`
        );
      }
      await query(
        `INSERT INTO object_type_group_member (group_id, object_type_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [g.rows[0].group_id, o.rows[0].object_type_id]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:groupApiName/members",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, groupApiName } = req.params;
      const { objectTypeApiName } = req.body || {};
      const g = await query(
        "SELECT group_id FROM object_type_group WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, groupApiName]
      );
      const o = await query(
        "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, objectTypeApiName]
      );
      if (g.rowCount === 0 || o.rowCount === 0) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "Group or object type not found."
        );
      }
      await query(
        `INSERT INTO object_type_group_member (group_id, object_type_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [g.rows[0].group_id, o.rows[0].object_type_id]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:groupApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, groupApiName } = req.params;
      await query(
        "DELETE FROM object_type_group WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, groupApiName]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
