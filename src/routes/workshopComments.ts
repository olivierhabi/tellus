// ---------------------------------------------------------------------------
// workshopComments — REST routes for the Workshop Comments widget.
//
// Mounted at /api/v1/workshop from server.ts (single point of mount, like
// workshopModules). Authentication comes from the global auth middleware;
// every handler additionally enforces the PARENT OBJECT permission gate
// inside commentService (docs: "Comments follow the permissions of the
// parent object").
//
//   GET    /api/v1/workshop/comments/:objectType/:primaryKey
//   POST   /api/v1/workshop/comments/:objectType/:primaryKey
//   DELETE /api/v1/workshop/comments/id/:commentId
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { requireSecurityContext } from "../middleware/securityContext";
import {
  CommentAuthorOnlyError,
  CommentNotFoundError,
  CommentPermissionError,
  createComment,
  deleteComment,
  listComments,
} from "../services/workshop/commentService";

const router: Router = Router();

function handleCommentError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  const e = err as {
    statusCode?: number;
    errorName?: string;
    message?: string;
  };
  if (
    err instanceof CommentPermissionError ||
    err instanceof CommentNotFoundError ||
    err instanceof CommentAuthorOnlyError ||
    typeof e?.statusCode === "number"
  ) {
    res.status(e.statusCode ?? 500).json({
      errorCode: e.errorName ?? "CommentError",
      errorName: e.errorName ?? "CommentError",
      message: e.message ?? "Comment request failed.",
    });
    return;
  }
  next(err);
}

router.get(
  "/comments/:objectType/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const security = requireSecurityContext(req);
      const comments = await listComments(
        req.params.objectType,
        decodeURIComponent(req.params.primaryKey),
        security,
      );
      // `viewerUserId` lets the FE render the delete affordance for the
      // viewer's own comments (docs: "You can also delete your own
      // comments") without a second identity round-trip.
      res.status(200).json({ data: comments, viewerUserId: security.userId });
    } catch (err) {
      handleCommentError(err, res, next);
    }
  },
);

router.post(
  "/comments/:objectType/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const security = requireSecurityContext(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const comment = await createComment({
        objectTypeApiName: req.params.objectType,
        primaryKey: decodeURIComponent(req.params.primaryKey),
        body: typeof body.body === "string" ? body.body : "",
        references: body.references,
        attachments: body.attachments,
        ontologyId:
          typeof body.ontologyId === "string" ? body.ontologyId : null,
        sendDefaultNotifications: body.sendDefaultNotifications !== false,
        security,
      });
      res.status(201).json(comment);
    } catch (err) {
      handleCommentError(err, res, next);
    }
  },
);

router.delete(
  "/comments/id/:commentId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const security = requireSecurityContext(req);
      await deleteComment(req.params.commentId, security);
      res.status(204).end();
    } catch (err) {
      handleCommentError(err, res, next);
    }
  },
);

export default router;
