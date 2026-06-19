// ---------------------------------------------------------------------------
// Filesystem v2 Public API — Conjure-compatible /api/v2/filesystem/* surface
// ---------------------------------------------------------------------------
// Spec:      tasks/files-projects/files-projects-tasks.md §B3.
// Contracts: tasks/files-projects/contracts.md (B3-C-01..71).
//
// Wires the 17 endpoints listed in B3 against the existing service layer:
//   - projectService (B1+B2 wiring)
//   - folderService (B1 wiring)
//   - compassService (B1 read surface)
//
// Concerns (in mounting order):
//   1. JSON body parsing (inherited from app)
//   2. authenticate (existing JWT)
//   3. Idempotency-Key middleware (per state-allocating POST)
//   4. ETag/If-Match enforcement (per mutation route)
//   5. Conjure error envelope (final error handler on this sub-router)
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import foundryDb from "../config/foundryDb";
import { pool as pgPool } from "../db";
import { OntologyError } from "../utils/queryErrors";
import {
  getResource,
  getResourcesBatch,
  getResourceByPath,
  getChildren,
} from "../services/compassService";
import { ProjectService } from "../services/projectService";
import { FolderService } from "../services/folderService";
import { ROOT_SPACE_RID, isRid, type Rid } from "../lib/rid";
import { validatePageSize } from "../lib/cursor";
import { requireIfMatchV2, setV2Etag, formatV2Etag } from "../middleware/ifMatchV2";
import { idempotencyKeyMiddleware } from "../middleware/idempotencyKey";
import { conjureErrorHandler } from "../lib/conjureError";
import { v2RequestSeconds } from "../metrics/filesystemV2";

const router = Router();

// Service instances share the pg/knex pool so that B1-C-24 same-txn wiring
// (resources INSERT in same transaction as projects/folders) is honored.
const projectService = new ProjectService(foundryDb);
const folderService = new FolderService(foundryDb);

// ---------------------------------------------------------------------------
// Latency timer — wraps every handler with a histogram observation.
// ---------------------------------------------------------------------------
function timed(endpoint: string, handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const end = v2RequestSeconds.startTimer({ endpoint });
    try {
      await handler(req, res, next);
      end({ status: String(res.statusCode) });
    } catch (err) {
      end({ status: String(res.statusCode || 500) });
      next(err);
    }
  };
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function requireUserId(req: Request): string {
  const u = (req as Request & { user?: { id?: string } }).user;
  if (!u || typeof u.id !== "string") {
    throw new OntologyError("Missing authenticated user.", "PERMISSION_DENIED", 403, {});
  }
  return u.id;
}

function requireRidParam(req: Request, name: string): Rid {
  const v = req.params[name];
  if (!v || !isRid(v)) {
    throw new OntologyError(
      `Path parameter ${name} is not a valid RID.`,
      "INVALID_ARGUMENT",
      400,
      { received: v ?? null },
    );
  }
  return v as Rid;
}

// ---------------------------------------------------------------------------
// 9. GET /resources/{rid}                                       (B3-C-09)
// ---------------------------------------------------------------------------
router.get(
  "/resources/:rid",
  authenticate,
  timed(
    "GET /resources/{rid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "rid");
      const resource = await getResource(rid);
      setV2Etag(res, resource.etag);
      res.json(resource);
    }),
  ),
);

// ---------------------------------------------------------------------------
// 10. GET /resources?path=<path>                                 (B3-C-10)
// 11. POST /resources/getByPathsBatch                            (B3-C-11)
// (mounted before /resources/:rid in registration order via path specificity)
// ---------------------------------------------------------------------------
router.get(
  "/resources",
  authenticate,
  timed(
    "GET /resources",
    asyncHandler(async (req, res) => {
      const path = req.query.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new OntologyError(
          "Query parameter `path` is required.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      const resource = await getResourceByPath(path);
      setV2Etag(res, resource.etag);
      res.json(resource);
    }),
  ),
);

router.post(
  "/resources/getByPathsBatch",
  authenticate,
  timed(
    "POST /resources/getByPathsBatch",
    asyncHandler(async (req, res) => {
      const paths = (req.body as { paths?: unknown }).paths;
      if (!Array.isArray(paths)) {
        throw new OntologyError(
          "Request body must include `paths: string[]`.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      if (paths.length > 1000) {
        throw new OntologyError(
          "paths length exceeds 1000.",
          "BATCH_TOO_LARGE",
          400,
          { received: paths.length, max: 1000 },
        );
      }
      const out: Record<string, unknown> = {};
      for (const p of paths) {
        if (typeof p !== "string") {
          throw new OntologyError(
            "Each path must be a string.",
            "INVALID_ARGUMENT",
            400,
            {},
          );
        }
        try {
          out[p] = await getResourceByPath(p);
        } catch (err) {
          if (err instanceof OntologyError && err.code === "RESOURCE_NOT_FOUND") {
            // Conjure batch contract: omit missing keys rather than fail entire batch.
            continue;
          }
          throw err;
        }
      }
      res.json(out);
    }),
  ),
);

// ---------------------------------------------------------------------------
// 12-14. trash / restore / permanentlyDelete                     (B3-C-12..14)
// All require If-Match. B5 wires real trash semantics; B3 stub flips
// resources.trash_status atomically.
// ---------------------------------------------------------------------------
async function changeTrashStatus(
  req: Request,
  res: Response,
  newStatus: "DIRECTLY_TRASHED" | "NOT_TRASHED",
  endpoint: string,
): Promise<void> {
  const rid = requireRidParam(req, "rid");
  const cur = await getResource(rid);
  requireIfMatchV2(req, cur.etag, endpoint);
  await pgPool.query(
    `UPDATE resources SET trash_status = $1 WHERE rid = $2`,
    [newStatus, rid],
  );
  res.status(204).end();
}

router.post(
  "/resources/:rid/trash",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /resources/{rid}/trash"),
  timed(
    "POST /resources/{rid}/trash",
    asyncHandler(async (req, res) => {
      await changeTrashStatus(req, res, "DIRECTLY_TRASHED", "POST /resources/{rid}/trash");
    }),
  ),
);

router.post(
  "/resources/:rid/restore",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /resources/{rid}/restore"),
  timed(
    "POST /resources/{rid}/restore",
    asyncHandler(async (req, res) => {
      await changeTrashStatus(req, res, "NOT_TRASHED", "POST /resources/{rid}/restore");
    }),
  ),
);

router.post(
  "/resources/:rid/permanentlyDelete",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /resources/{rid}/permanentlyDelete"),
  timed(
    "POST /resources/{rid}/permanentlyDelete",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "rid");
      const cur = await getResource(rid);
      requireIfMatchV2(req, cur.etag, "POST /resources/{rid}/permanentlyDelete");
      // B3 stub: physical delete deferred to B5 trash purge worker. For now
      // we mark the row PERMANENTLY_DELETED so audit history is preserved.
      await pgPool.query(
        `UPDATE resources SET trash_status = 'PERMANENTLY_DELETED' WHERE rid = $1`,
        [rid],
      );
      res.status(204).end();
    }),
  ),
);

// ---------------------------------------------------------------------------
// 1-4. folders endpoints                                         (B3-C-01..04)
// ---------------------------------------------------------------------------
router.post(
  "/folders",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /folders"),
  timed(
    "POST /folders",
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req);
      const body = req.body as {
        parentFolderRid?: unknown;
        displayName?: unknown;
      };
      if (typeof body.displayName !== "string" || body.displayName.length === 0) {
        throw new OntologyError(
          "displayName is required (1..256 chars).",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      if (typeof body.parentFolderRid !== "string" || !isRid(body.parentFolderRid)) {
        throw new OntologyError(
          "parentFolderRid must be a valid RID.",
          "INVALID_ARGUMENT",
          400,
          { received: body.parentFolderRid ?? null },
        );
      }
      // Resolve project from parent. Parent may be the project rid itself
      // (top-level folder) or another folder rid.
      const parent = await getResource(body.parentFolderRid as Rid);
      const parentProjectRid = parent.type === "PROJECT" ? parent.rid : parent.projectRid;
      if (!parentProjectRid) {
        throw new OntologyError(
          "Parent resource is not within a project.",
          "INVALID_ARGUMENT",
          400,
          { parent: parent.rid },
        );
      }
      const projectLegacyId = parent.type === "PROJECT"
        ? parent.legacyUuid
        : (await getResource(parentProjectRid)).legacyUuid;
      if (!projectLegacyId) {
        throw new OntologyError(
          "Parent project missing legacy_uuid (B1 backfill incomplete).",
          "INVALID_ARGUMENT",
          400,
          { parent: parent.rid },
        );
      }
      const folder = await folderService.createFolder(
        projectLegacyId,
        body.displayName,
        parent.type === "PROJECT" ? null : (parent.legacyUuid ?? null),
        userId,
      );
      const folderRid = `ri.compass.main.compass-folder.${folder.id}` as Rid;
      const resource = await getResource(folderRid);
      setV2Etag(res, resource.etag);
      res.status(201).json(resource);
    }),
  ),
);

router.get(
  "/folders/:folderRid",
  authenticate,
  timed(
    "GET /folders/{folderRid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "folderRid");
      const resource = await getResource(rid);
      setV2Etag(res, resource.etag);
      res.json(resource);
    }),
  ),
);

router.post(
  "/folders/getBatch",
  authenticate,
  timed(
    "POST /folders/getBatch",
    asyncHandler(async (req, res) => {
      const folderRids = (req.body as { folderRids?: unknown }).folderRids;
      if (!Array.isArray(folderRids)) {
        throw new OntologyError(
          "Request body must include `folderRids: string[]`.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      if (folderRids.length > 1000) {
        throw new OntologyError(
          "folderRids length exceeds 1000.",
          "BATCH_TOO_LARGE",
          400,
          { received: folderRids.length, max: 1000 },
        );
      }
      // Validate each rid before hitting the DB to surface a clean 400.
      for (const r of folderRids) {
        if (typeof r !== "string" || !isRid(r)) {
          throw new OntologyError(
            "Each folderRid must be a valid RID.",
            "INVALID_ARGUMENT",
            400,
            { received: r },
          );
        }
      }
      const map = await getResourcesBatch(folderRids as Rid[]);
      // Preserve input order, omit missing.
      const ordered = (folderRids as Rid[]).map((rid) => map.get(rid)).filter((r) => !!r);
      res.json(ordered);
    }),
  ),
);

router.get(
  "/folders/:folderRid/children",
  authenticate,
  timed(
    "GET /folders/{folderRid}/children",
    asyncHandler(async (req, res) => {
      const parentRid = requireRidParam(req, "folderRid");
      const pageSize = validatePageSize(req.query.pageSize, 100);
      // Defer page-token validation/encoding to compassService.getChildren —
      // it owns the canonical encoder and rejects malformed tokens with
      // INVALID_PAGE_TOKEN. Local validation here would risk drift.
      const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : null;
      const page = await getChildren(parentRid, { pageSize, pageToken });
      const body: Record<string, unknown> = { data: page.data };
      if (page.nextPageToken) {
        body.nextPageToken = page.nextPageToken;
      }
      res.json(body);
    }),
  ),
);

// ---------------------------------------------------------------------------
// 5-8. projects endpoints                                         (B3-C-05..08)
// ---------------------------------------------------------------------------
router.post(
  "/projects",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /projects"),
  timed(
    "POST /projects",
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req);
      const body = req.body as { displayName?: unknown; spaceRid?: unknown };
      if (typeof body.displayName !== "string" || body.displayName.length === 0) {
        throw new OntologyError(
          "displayName is required.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      const spaceRid = typeof body.spaceRid === "string" ? (body.spaceRid as Rid) : undefined;
      const project = await projectService.createProject(body.displayName, userId, { spaceRid });
      const projectRid = `ri.compass.main.project.${project.id}` as Rid;
      const resource = await getResource(projectRid);
      setV2Etag(res, resource.etag);
      res.status(201).json(resource);
    }),
  ),
);

router.get(
  "/projects/:projectRid",
  authenticate,
  timed(
    "GET /projects/{projectRid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "projectRid");
      const resource = await getResource(rid);
      setV2Etag(res, resource.etag);
      res.json(resource);
    }),
  ),
);

router.put(
  "/projects/:projectRid",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "PUT /projects/{projectRid}"),
  timed(
    "PUT /projects/{projectRid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "projectRid");
      const cur = await getResource(rid);
      requireIfMatchV2(req, cur.etag, "PUT /projects/{projectRid}");
      const body = req.body as { displayName?: unknown; description?: unknown };
      const sets: string[] = [];
      const args: unknown[] = [];
      if (typeof body.displayName === "string" && body.displayName.length > 0) {
        args.push(body.displayName);
        sets.push(`display_name = $${args.length}`);
      }
      if (typeof body.description === "string") {
        args.push(body.description);
        sets.push(`description = $${args.length}`);
      }
      if (sets.length === 0) {
        throw new OntologyError(
          "Request body must update at least one field.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      args.push(rid);
      await pgPool.query(
        `UPDATE resources SET ${sets.join(", ")} WHERE rid = $${args.length}`,
        args,
      );
      const updated = await getResource(rid);
      setV2Etag(res, updated.etag);
      res.json(updated);
    }),
  ),
);

router.delete(
  "/projects/:projectRid",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "DELETE /projects/{projectRid}"),
  timed(
    "DELETE /projects/{projectRid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "projectRid");
      const cur = await getResource(rid);
      requireIfMatchV2(req, cur.etag, "DELETE /projects/{projectRid}");
      // Stub for B3: flip to DIRECTLY_TRASHED. B5 wires retention + cascade.
      await pgPool.query(
        `UPDATE resources SET trash_status = 'DIRECTLY_TRASHED' WHERE rid = $1`,
        [rid],
      );
      res.status(204).end();
    }),
  ),
);

// ---------------------------------------------------------------------------
// 15-17. spaces endpoints                                         (B3-C-15..17)
// ---------------------------------------------------------------------------
router.post(
  "/spaces",
  authenticate,
  idempotencyKeyMiddleware(pgPool, "POST /spaces"),
  timed(
    "POST /spaces",
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req);
      const body = req.body as { displayName?: unknown };
      if (typeof body.displayName !== "string" || body.displayName.length === 0) {
        throw new OntologyError(
          "displayName is required.",
          "INVALID_ARGUMENT",
          400,
          {},
        );
      }
      const ridStr = `ri.compass.main.space.${randomUUID()}`;
      const rid = ridStr as Rid;
      // resources row + spaces row in one transaction (B1-C-24 invariant).
      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO resources (rid, service, type, display_name, space_rid, created_by, updated_by)
           VALUES ($1, 'compass', 'SPACE', $2, $1, $3, $3)`,
          [rid, body.displayName, userId],
        );
        await client.query(
          `INSERT INTO spaces (rid, display_name, enrollment_rid, file_system_id, is_root)
           VALUES ($1, $2, 'ri.compass.main.enrollment.default', gen_random_uuid(), false)`,
          [rid, body.displayName],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      const resource = await getResource(rid);
      setV2Etag(res, resource.etag);
      res.status(201).json(resource);
    }),
  ),
);

router.get(
  "/spaces",
  authenticate,
  timed(
    "GET /spaces",
    asyncHandler(async (_req, res) => {
      const { rows } = await pgPool.query(
        `SELECT s.rid, s.display_name, s.is_root, s.file_system_id, s.created_at,
                r.etag
         FROM spaces s
         JOIN resources r ON r.rid = s.rid
         ORDER BY s.created_at ASC`,
      );
      res.json({ data: rows });
    }),
  ),
);

router.get(
  "/spaces/:spaceRid",
  authenticate,
  timed(
    "GET /spaces/{spaceRid}",
    asyncHandler(async (req, res) => {
      const rid = requireRidParam(req, "spaceRid");
      const resource = await getResource(rid);
      if (resource.type !== "SPACE" && rid !== ROOT_SPACE_RID) {
        throw new OntologyError(
          "Resource is not a space.",
          "RESOURCE_NOT_FOUND",
          404,
          { rid },
        );
      }
      setV2Etag(res, resource.etag);
      res.json(resource);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Conjure error envelope handler — last in the chain.
// ---------------------------------------------------------------------------
router.use(conjureErrorHandler);

export default router;

// Re-export helpers for tests.
export { formatV2Etag };
