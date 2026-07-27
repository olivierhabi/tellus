// ---------------------------------------------------------------------------
// src/routes/notifications.ts — Phase 6.4 FE inbox reader + mark-read.
//
// All endpoints are scoped to the authenticated principal (their own
// inbox): `req.user.id` from `globalAuth()`. We don't expose an admin
// "view other-user's inbox" route here — that's an auditor function
// (separate /audit/lifecycle) and ships under its own authorization gate.
//
// Routes:
//   GET    /api/v1/notifications              — list the current user's inbox
//                                                (latest first, default 50,
//                                                max 200). Optional
//                                                `?unreadOnly=true&limit=N`.
//   GET    /api/v1/notifications/unread/count    — fast badge count (avoiding
//                                                the full listbouy fetch).
//   POST   /api/v1/notifications/:id/read       — mark a single notification
//                                                as read. 404 if the row
//                                                doesn't belong to the current
//                                                user (IDOR prevention).
//   POST   /api/v1/notifications/read/all        — mark all as read for the
//                                                current user; returns
//                                                `{ updated: N }`.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import {
  listNotificationsForUser,
  countUnreadForUser,
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationInboxRow,
} from "../models/notificationInbox";
import { OntologyError } from "../utils/queryErrors";
import { sendSuccess, sendError } from "../utils/responseFormatter";

export const notificationsRouter = Router();

function currentUser(req: Request): string | null {
  const user = (req as any).user;
  const principal = (req as any).tellusPrincipal;
  const sub = (req as any).auth?.sub;
  const uid = user?.id || principal?.userId || sub || null;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

// GET /api/v1/notifications?limit=50&unreadOnly=true
notificationsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = currentUser(req);
      if (!uid) {
        throw new OntologyError(
          "Authentication required to read your notification inbox.",
          "UNAUTHORIZED",
          401,
        );
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === "1";
      const rows = await listNotificationsForUser(uid, { limit, unreadOnly });
      const payload = rows.map((r: NotificationInboxRow) => ({
        id: r.notification_id,
        templateId: r.template_id,
        parameters: r.template_parameters,
        channel: r.channel,
        actionTypeApiName: r.action_type_api_name,
        executionId: r.execution_id,
        ontologyId: r.ontology_id,
        createdAt: r.created_at,
        readAt: r.read_at,
        read: r.read_at !== null,
      }));
      sendSuccess(res, { data: payload });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      sendError(res, "INTERNAL_ERROR", err?.message ?? String(err));
    }
  },
);

// GET /api/v1/notifications/unread/count
notificationsRouter.get(
  "/unread/count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = currentUser(req);
      if (!uid) {
        throw new OntologyError(
          "Authentication required to read your notification inbox.",
          "UNAUTHORIZED",
          401,
        );
      }
      const n = await countUnreadForUser(uid);
      sendSuccess(res, { unread: n });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      sendError(res, "INTERNAL_ERROR", err?.message ?? String(err));
    }
  },
);

// POST /api/v1/notifications/:id/read
notificationsRouter.post(
  "/:id/read",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = currentUser(req);
      if (!uid) {
        throw new OntologyError(
          "Authentication required to mark a notification as read.",
          "UNAUTHORIZED",
          401,
        );
      }
      const notificationId = String(req.params.id ?? "");
      if (!notificationId) {
        sendError(res, "INVALID_PARAMETER", "notification id is required");
        return;
      }
      const row = await markNotificationRead(notificationId, uid);
      if (!row) {
        // IDOR-safe: 404 (not 403) whether the row was someone else's or
        // doesn't exist at all — same envelope used elsewhere per §Task 28.
        throw new OntologyError(
          `Notification '${notificationId}' not found in your inbox.`,
          "NOTIFICATION_NOT_FOUND",
          404,
          { notificationId },
        );
      }
      sendSuccess(res, {
        id: row.notification_id,
        read: true,
        readAt: row.read_at,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      sendError(res, "INTERNAL_ERROR", err?.message ?? String(err));
    }
  },
);

// POST /api/v1/notifications/read/all
notificationsRouter.post(
  "/read/all",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = currentUser(req);
      if (!uid) {
        throw new OntologyError(
          "Authentication required to mark all notifications as read.",
          "UNAUTHORIZED",
          401,
        );
      }
      const updated = await markAllNotificationsRead(uid);
      sendSuccess(res, { updated });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      sendError(res, "INTERNAL_ERROR", err?.message ?? String(err));
    }
  },
);
