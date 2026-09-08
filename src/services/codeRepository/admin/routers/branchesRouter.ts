// ---------------------------------------------------------------------------
// Branches router — extracted from admin/routes.ts.
//
//   GET    /:rid/branches            — listBranches (cache-enriched)
//   POST   /:rid/branches            — create a branch
//   DELETE /:rid/branches/:branch    — delete a branch (not the default)
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { idempotencyMiddleware } from "../../../codeRepos/middleware/idempotency";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { isLegalBranchName, sendError } from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createBranchesRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();


  // -------------------------------------------------------------------------
  // GET /:rid/branches
  // -------------------------------------------------------------------------
  router.get("/:rid/branches", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const exists = await ctx.pool.query<{ default_branch: string }>(
        `SELECT default_branch FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      void exists.rows[0].default_branch;
      const protectedFilter = req.query.protected;

      // Branch-cache metadata (is_protected / PR count / last-commit), keyed by
      // branch name. This is a denormalised ENRICHMENT only — never the source
      // of which branches exist (that drifts after restarts / new branches).
      const cacheRows = await ctx.pool.query<{
        branch_name: string; head_sha: string; is_protected: boolean;
        last_commit_at: Date | null; last_commit_author: string | null;
        open_pr_count: number; updated_at: Date;
      }>(
        `SELECT branch_name, head_sha, is_protected, last_commit_at,
                last_commit_author, open_pr_count, updated_at
           FROM code_repository_branch_cache WHERE repository_rid = $1`,
        [rid],
      );
      const meta = new Map(cacheRows.rows.map((b) => [b.branch_name, b]));

      // Authoritative branch list comes from the Stemma adapter (durable),
      // NOT the cache. This is the fix for branches disappearing/duplicating
      // after a restart or after creating a branch the cache hasn't caught up on.
      const sb = await ctx.stemma.listBranches({ repositoryRid: rid });
      let branches: Array<{
        name: string; headSha: string; isProtected: boolean;
        lastCommitAt: unknown; lastCommitAuthor: string | null;
        openPrCount: number; updatedAt: unknown;
      }>;
      if (sb.kind === "ok") {
        branches = sb.branches.map((br) => {
          const m = meta.get(br.name);
          return {
            name: br.name,
            headSha: br.head, // live Stemma HEAD wins over any stale cached sha
            isProtected: m?.is_protected ?? false,
            lastCommitAt: m?.last_commit_at ?? null,
            lastCommitAuthor: m?.last_commit_author ?? null,
            openPrCount: m?.open_pr_count ?? 0,
            updatedAt: m?.updated_at ?? new Date().toISOString(),
          };
        });
      } else {
        // Adapter has no branch list (e.g. a test seam) — fall back to cache.
        branches = cacheRows.rows.map((b) => ({
          name: b.branch_name, headSha: b.head_sha, isProtected: b.is_protected,
          lastCommitAt: b.last_commit_at, lastCommitAuthor: b.last_commit_author,
          openPrCount: b.open_pr_count, updatedAt: b.updated_at,
        }));
      }

      if (protectedFilter === "true") branches = branches.filter((b) => b.isProtected);
      else if (protectedFilter === "false") branches = branches.filter((b) => !b.isProtected);
      branches.sort((a, b) => a.name.localeCompare(b.name));

      res.status(200).json({ branches });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /:rid/branches  — create a branch.
  //
  // Forks `fromBranch` (default: the repo's default branch) into a NEW ref
  // `name`. Body: { name, fromBranch? }. 201 { name, headSha, fromBranch }.
  //   409 BranchExists — name already taken.
  //   404 BranchNotFound — fromBranch does not exist.
  // -------------------------------------------------------------------------
  router.post("/:rid/branches", ctx.auth, idempotencyMiddleware({ pool: ctx.pool }), async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      const body = (req.body ?? {}) as { name?: unknown; fromBranch?: unknown };
      const name = typeof body.name === "string" ? body.name : "";
      if (!isLegalBranchName(name)) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          field: "name",
          reason: "branch name must match [A-Za-z0-9._/-], no leading dash/slash, no '..'",
        }));
      }
      const { rows } = await ctx.pool.query<{ default_branch: string; state: string }>(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (rows.length === 0 || rows[0].state === "TRASHED") {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const fromBranch =
        typeof body.fromBranch === "string" && body.fromBranch.length > 0
          ? body.fromBranch
          : rows[0].default_branch;

      const out = await ctx.stemma.createBranch({ repositoryRid: rid, newBranch: name, fromBranch });
      if (out.kind === "branch-exists") {
        return sendError(res, codeReposError("CodeRepos:BranchExists", { name }));
      }
      if (out.kind === "source-not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch: fromBranch }));
      }
      if (out.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: out.reason }));
      }
      // Seed branch_cache so GET /branches reflects the new branch immediately.
      await ctx.pool
        .query(
          `INSERT INTO code_repository_branch_cache
             (repository_rid, branch_name, head_sha, is_protected,
              last_commit_at, last_commit_author, open_pr_count, updated_at)
           VALUES ($1, $2, $3, FALSE, now(), NULL, 0, now())
           ON CONFLICT (repository_rid, branch_name)
           DO UPDATE SET head_sha = EXCLUDED.head_sha, updated_at = now()`,
          [rid, name, out.head],
        )
        .catch(() => {});
      return res.status(201).json({ name, headSha: out.head, fromBranch, isProtected: false });
    } catch (err) {
      next(err);
    }
  });
  // -------------------------------------------------------------------------
  // DELETE /:rid/branches/:branch  — delete a branch.
  //
  // The repo's default branch cannot be deleted (412). 204 on success.
  // -------------------------------------------------------------------------
  router.delete("/:rid/branches/:branch", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      const branch = req.params.branch;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      const { rows } = await ctx.pool.query<{ default_branch: string; state: string }>(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (rows.length === 0 || rows[0].state === "TRASHED") {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      if (branch === rows[0].default_branch) {
        return sendError(res, codeReposError("CodeRepos:CannotModifyDefaultBranch", { branch }));
      }
      const out = await ctx.stemma.deleteBranch({ repositoryRid: rid, branch });
      if (out.kind === "not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
      }
      if (out.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: out.reason }));
      }
      await ctx.pool
        .query(
          `DELETE FROM code_repository_branch_cache WHERE repository_rid = $1 AND branch_name = $2`,
          [rid, branch],
        )
        .catch(() => {});
      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
