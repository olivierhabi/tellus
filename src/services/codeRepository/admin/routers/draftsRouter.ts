// ---------------------------------------------------------------------------
// Drafts router — extracted from admin/routes.ts.
//
//   GET    /:rid/branches/:branch/drafts  — list the caller's drafts
//   PUT    /:rid/branches/:branch/drafts  — replace the caller's draft set
//   DELETE /:rid/branches/:branch/drafts  — clear all (after a commit)
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { clearDrafts, listDrafts, replaceDrafts, validateDraftsBody } from "../../drafts/draftStore";
import { derivePrincipalSubUuid, isLegalBranchName, isUuidV4, sendError } from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createDraftsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // Uncommitted drafts (migration 104). Per-user, per-branch, pre-commit
  // file drafts persisted backend-side so they survive across browsers/
  // sessions — but NOT a git commit; the frontend clears them on commit.
  //   GET    /:rid/branches/:branch/drafts  — list the caller's drafts
  //   PUT    /:rid/branches/:branch/drafts  — replace the caller's draft set
  //   DELETE /:rid/branches/:branch/drafts  — clear all (after a commit)
  // Keyed by `principal_sub` (derived UUID) so each user's drafts are private.
  // -------------------------------------------------------------------------
  router.get("/:rid/branches/:branch/drafts", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
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
      const drafts = await listDrafts(ctx.pool, { principalSub, repositoryRid: rid, branch });
      res.status(200).json({ drafts });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:rid/branches/:branch/drafts", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
      }
      const exists = await ctx.pool.query(
        `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const validation = validateDraftsBody(req.body);
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
      const drafts = await replaceDrafts(ctx.pool, {
        principalSub,
        repositoryRid: rid,
        branch,
        drafts: validation.drafts,
      });
      res.status(200).json({ drafts });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:rid/branches/:branch/drafts", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      await clearDrafts(ctx.pool, { principalSub, repositoryRid: rid, branch });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
