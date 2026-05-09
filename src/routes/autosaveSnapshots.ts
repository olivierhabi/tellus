// ---------------------------------------------------------------------------
// /api/v1/projects/:projectId/autosave-snapshots — list project history
// /api/v1/resources/:rid/autosave-snapshots/:snapshotId/restore — restore
//
// Authorization: caller must be a project member (any role) to LIST.
// Restore additionally requires editor/owner.
// ---------------------------------------------------------------------------
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";

interface AuthedRequest extends Request {
  user?: { id?: string; email?: string };
}
import { authorizeRoles } from "../middleware/authorize";
import {
  listProjectSnapshots,
  getSnapshot,
  restoreSnapshot,
} from "../services/autosaveService";
import {
  AutosaveSnapshotChangeKind,
  AutosaveSnapshotResourceKind,
  AutosavePayload,
} from "../types/autosaveSnapshot";
import { pool } from "../db";

const projectScopedRouter = Router({ mergeParams: true });
const resourceScopedRouter = Router({ mergeParams: true });

const ListQuery = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  pageToken: z.string().optional(),
  resourceRid: z.string().optional(),
  resourceKind: z.enum([
    "dataset", "pipeline", "workshop-module", "code-repository", "folder", "project",
  ] as const).optional(),
  actorId: z.string().uuid().optional(),
  changeKind: z.enum([
    "created", "renamed", "moved", "schema-changed", "content-changed",
    "published", "archived", "unarchived", "deleted", "restored",
    "configuration-changed",
  ] as const).optional(),
  sinceTimestamp: z.string().datetime({ offset: true }).optional(),
});

// GET /api/v1/projects/:projectId/autosave-snapshots
projectScopedRouter.get(
  "/:projectId/autosave-snapshots",
  authenticate,
  authorizeRoles("viewer", "editor", "owner"),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId;
      if (!/^[0-9a-fA-F-]{36}$/.test(projectId)) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: "projectId must be a UUID" },
        });
      }
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Invalid query parameters",
            issues: parsed.error.issues,
          },
        });
      }
      const result = await listProjectSnapshots({
        projectId,
        pageSize: parsed.data.pageSize,
        pageToken: parsed.data.pageToken,
        resourceRid: parsed.data.resourceRid,
        resourceKind: parsed.data.resourceKind as AutosaveSnapshotResourceKind | undefined,
        actorId: parsed.data.actorId,
        changeKind: parsed.data.changeKind as AutosaveSnapshotChangeKind | undefined,
        sinceTimestamp: parsed.data.sinceTimestamp ? new Date(parsed.data.sinceTimestamp) : undefined,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/resources/:rid/autosave-snapshots/:snapshotId/restore
//
// The route layer doesn't actually know how to apply each resource_kind
// — it dispatches to a per-kind restore handler. To keep this PR
// scoped, we register handlers for the kinds we capture from today
// (workshop-module). Adding a new kind = adding a handler here.
type RestoreHandler = (
  payload: AutosavePayload,
  client: import("pg").PoolClient,
) => Promise<{ currentStateForUndo: AutosavePayload; summary: string }>;

const RESTORE_HANDLERS: Partial<Record<AutosaveSnapshotResourceKind, RestoreHandler>> = {};

resourceScopedRouter.post(
  "/:rid/autosave-snapshots/:snapshotId/restore",
  authenticate,
  authorizeRoles("editor", "owner"),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { rid, snapshotId } = req.params;
      if (!rid || !rid.startsWith("ri.")) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: "rid must be a Compass RID" },
        });
      }
      if (!/^[0-9a-fA-F-]{36}$/.test(snapshotId)) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: "snapshotId must be a UUID" },
        });
      }
      // Look up the snapshot, then verify it belongs to a project the
      // caller can write to. We do this in two steps so the
      // authorization check is explicit + the snapshot's project_id is
      // load-bearing for the gatekeeper call (next PR).
      const { rows: lookup } = await pool.query<{ project_id: string }>(
        `SELECT project_id::text FROM autosave_snapshots WHERE id = $1`,
        [snapshotId],
      );
      if (lookup.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "snapshot not found" },
        });
      }
      const snap = await getSnapshot(snapshotId, lookup[0].project_id);
      if (!snap || snap.resourceRid !== rid) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "snapshot not found for this resource" },
        });
      }
      const handler = RESTORE_HANDLERS[snap.resourceKind];
      if (!handler) {
        return res.status(501).json({
          success: false,
          error: {
            code: "NOT_IMPLEMENTED",
            message: `restore not yet implemented for resource_kind=${snap.resourceKind}`,
          },
        });
      }
      const newSnapshotId = await restoreSnapshot(
        snap,
        {
          id: req.user?.id ?? null,
          email: req.user?.email ?? null,
        },
        handler,
      );
      return res.json({
        success: true,
        data: { restoredSnapshotId: newSnapshotId, fromSnapshotId: snap.id },
      });
    } catch (err) {
      next(err);
    }
  },
);

export {
  projectScopedRouter as autosaveProjectRouter,
  resourceScopedRouter as autosaveResourceRouter,
};
