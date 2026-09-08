// ---------------------------------------------------------------------------
// Chat-sessions router — extracted from admin/routes.ts.
//
//   GET    /:rid/chat-sessions              — list the caller's sessions
//   POST   /:rid/chat-sessions              — create session + messages
//   GET    /:rid/chat-sessions/:sessionId   — fetch one session
//   PUT    /:rid/chat-sessions/:sessionId   — replace metadata/messages
//   DELETE /:rid/chat-sessions/:sessionId   — delete one session
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { idempotencyMiddleware } from "../../../codeRepos/middleware/idempotency";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import {
  ChatSessionLimitExceededError,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
  validateCreateChatSessionBody,
  validateUpdateChatSessionBody,
  type ChatSessionRow,
} from "../../chatSessions/chatSessionStore";
import { derivePrincipalSubUuid, isUuidV4, sendError } from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createChatSessionsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // Chat sessions (migration 126). Per-user, per-repo persistent chat
  // transcripts for the Code Assistant panel mounted inside the repo browser.
  // Sessions are private to the caller (`principal_sub`) — every query
  // filters on it, so an IDOR attempt to read another user's session by id
  // returns 404 (matches the IDOR-as-404 convention used by /drafts).
  //
  //   GET    /:rid/chat-sessions              — list the caller's sessions
  //                                            (no message bodies).
  //   POST   /:rid/chat-sessions              — create session + initial
  //                                            messages (atomic, Idempotency-Key).
  //   GET    /:rid/chat-sessions/:sessionId   — fetch one session WITH messages.
  //   PUT    /:rid/chat-sessions/:sessionId   — replace metadata and/or the
  //                                            full message set atomically.
  //   DELETE /:rid/chat-sessions/:sessionId   — delete one session (+ messages).
  // -------------------------------------------------------------------------
  router.get("/:rid/chat-sessions", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const exists = await ctx.pool.query(
        `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const sessions = await listChatSessions(ctx.pool, { principalSub, repositoryRid: rid });
      const items: ChatSessionRow[] = sessions;
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/:rid/chat-sessions",
    ctx.auth,
    idempotencyMiddleware({ pool: ctx.pool }),
    async (req, res, next) => {
      try {
        const rid = req.params.rid;
        if (!isRid(rid)) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        const exists = await ctx.pool.query(
          `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
          [rid],
        );
        if (exists.rowCount === 0) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        const validation = validateCreateChatSessionBody(req.body);
        if (validation.kind === "invalid") {
          return sendError(res, codeReposError(validation.errorName, validation.parameters));
        }
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }
        const principalSub = isUuidV4(principal.userId)
          ? principal.userId
          : derivePrincipalSubUuid(principal.userId);
        // Checksum: pull `Idempotency-Key` from header so a replayed POST returns
        // the same created row (matches the createRepository saga contract).
        const idem = (req.header("Idempotency-Key") ?? "").trim();
        if (!idem) {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "Idempotency-Key" }));
        }

        try {
          const created = await createChatSession(ctx.pool, {
            principalSub,
            repositoryRid: rid,
            session: validation.session,
            messages: validation.messages,
          });
          res.status(201).json({
            sessionId: created.sessionId,
            assistantPath: created.assistantPath,
            title: created.title,
            branch: created.branch,
            lastActiveFilePath: created.lastActiveFilePath,
            modelId: created.modelId,
            mode: created.mode,
            messageCount: created.messageCount,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            messages: created.messages,
          });
        } catch (sessErr) {
          if (sessErr instanceof ChatSessionLimitExceededError) {
            return sendError(
              res,
              codeReposError("CodeRepos:ChatSessionLimitExceeded", {
                limit: sessErr.limit,
                repositoryRid: rid,
              }),
            );
          }
          throw sessErr;
        }
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/:rid/chat-sessions/:sessionId", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const session = await getChatSession(ctx.pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
      });
      if (!session) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(200).json({
        sessionId: session.sessionId,
        assistantPath: session.assistantPath,
        title: session.title,
        branch: session.branch,
        lastActiveFilePath: session.lastActiveFilePath,
        modelId: session.modelId,
        mode: session.mode,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:rid/chat-sessions/:sessionId", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const validation = validateUpdateChatSessionBody(req.body);
      if (validation.kind === "invalid") {
        return sendError(res, codeReposError(validation.errorName, validation.parameters));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const updated = await updateChatSession(ctx.pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
        patch: validation.patch,
        messages: validation.messages,
      });
      if (!updated) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(200).json({
        sessionId: updated.sessionId,
        assistantPath: updated.assistantPath,
        title: updated.title,
        branch: updated.branch,
        lastActiveFilePath: updated.lastActiveFilePath,
        modelId: updated.modelId,
        mode: updated.mode,
        messageCount: updated.messageCount,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        messages: updated.messages,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:rid/chat-sessions/:sessionId", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const deleted = await deleteChatSession(ctx.pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
      });
      if (!deleted) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
