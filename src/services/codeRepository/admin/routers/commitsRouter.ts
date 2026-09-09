// ---------------------------------------------------------------------------
// Commits router — extracted from admin/routes.ts.
//
//   POST /:rid/branches/:branch/commits  (B2-C-12) — compose a commit
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { idempotencyMiddleware } from "../../../codeRepos/middleware/idempotency";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { insertCodeReposAuditEvent } from "../../../codeRepos/audit/auditEvents";
import {
  derivePrincipalSubUuid,
  isLegalBranchName,
  isUuidV4,
  sendError,
} from "../routeHelpers";
import {
  parseShaIfMatch,
  validateCommitBody,
} from "../commitValidators";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createCommitsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /:rid/branches/:branch/commits     (B2-C-12, F4 spec line 953-957)
  //
  // Compose a single commit on `branch` from a list of file changes. The
  // canonical source of HEAD is the StemmaAdapter; the branch_cache table
  // is updated as a secondary effect so reads stay cheap.
  //
  // Contract:
  //   Headers
  //     Idempotency-Key   UUID v4 (G-C-20). Replays return the original
  //                       response with X-Idempotent-Replay: true.
  //     If-Match          The parent commit SHA (40 hex). Wrap in `"..."`
  //                       per RFC 7232; weak `W/"..."` is also accepted.
  //                       Mismatch with current HEAD → 412 StaleRefHead
  //                       with both expected and current SHAs in
  //                       parameters so the IDE can offer the F4 rebase
  //                       prompt without an extra GET.
  //   Body { message, fileChanges: [{ path, op, contentBase64?, mode? }] }
  //     op ∈ "add" | "modify" | "delete". add/modify require
  //     contentBase64. delete forbids it. mode ∈ "100644" | "100755",
  //     defaults to "100644".
  //
  // Outcomes:
  //   201 + { commitSha, parentSha, fileCount, totalBytes, … } + ETag
  //   400 EmptyChangeSet                — fileChanges is empty
  //   400 InvalidSettings               — body shape / encoding errors
  //   404 RepositoryNotFound            — rid unknown or TRASHED (IDOR-as-404)
  //   404 BranchNotFound                — branch not on this repo
  //   412 RepositoryArchived            — repo is ARCHIVED
  //   412 StaleRefHead                  — If-Match ≠ current HEAD
  //   502 CommitFailed                  — adapter transient failure
  //
  // Side effects (one Postgres tx):
  //   * UPSERT code_repository_branch_cache (head_sha, last_commit_at,
  //     last_commit_author, updated_at)
  //   * INSERT code_repos_audit_events row with action="commit",
  //     beforeHash=parentSha, afterHash=commitSha (the chain captures the
  //     commit-DAG advance for after-the-fact reconstruction).
  // -------------------------------------------------------------------------
  router.post(
    "/:rid/branches/:branch/commits",
    ctx.auth,
    idempotencyMiddleware({ pool: ctx.pool }),
    async (req, res, next) => {
      try {
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }

        const rid = req.params.rid;
        const branch = req.params.branch;
        if (!isRid(rid)) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        if (!isLegalBranchName(branch)) {
          return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
        }

        const ifMatch = req.header("If-Match");
        if (!ifMatch) {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "If-Match" }));
        }
        const parentSha = parseShaIfMatch(ifMatch);
        if (parentSha === null) {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidSettings", {
              field: "If-Match",
              reason: 'must be a 40-char hex SHA wrapped in "..." (or W/"...")',
            }),
          );
        }

        const validation = validateCommitBody(req.body);
        if (validation.kind === "invalid") {
          return sendError(res, codeReposError(validation.errorName, validation.parameters));
        }

        const repoRow = await ctx.pool.query<{ state: string }>(
          `SELECT state FROM code_repository
            WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
          [rid],
        );
        if (repoRow.rowCount === 0) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        if (repoRow.rows[0].state === "ARCHIVED") {
          return sendError(res, codeReposError("CodeRepos:RepositoryArchived", { rid }));
        }

        const principalSub = isUuidV4(principal.userId)
          ? principal.userId
          : derivePrincipalSubUuid(principal.userId);

        const outcome = await ctx.stemma.commitFiles({
          repositoryRid: rid,
          branch,
          files: validation.files,
          deletePaths: validation.deletePaths,
          parentSha,
          message: validation.message,
          principalSub,
        });

        if (outcome.kind === "branch-not-found") {
          return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
        }
        if (outcome.kind === "stale-ref") {
          return sendError(
            res,
            codeReposError("CodeRepos:StaleRefHead", {
              rid,
              branch,
              expectedSha: outcome.expectedSha,
              currentHead: outcome.currentHead,
            }),
          );
        }
        if (outcome.kind === "transient") {
          return sendError(
            res,
            codeReposError("CodeRepos:CommitFailed", {
              rid,
              branch,
              reason: outcome.reason,
            }),
          );
        }

        const committedAt = new Date();
        const client = await ctx.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO code_repository_branch_cache
                (repository_rid, branch_name, head_sha,
                 last_commit_at, last_commit_author, updated_at)
              VALUES ($1, $2, $3, $4, $5, $4)
              ON CONFLICT (repository_rid, branch_name) DO UPDATE
                 SET head_sha = EXCLUDED.head_sha,
                     last_commit_at = EXCLUDED.last_commit_at,
                     last_commit_author = EXCLUDED.last_commit_author,
                     updated_at = EXCLUDED.updated_at`,
            [rid, branch, outcome.commitSha, committedAt, principalSub],
          );
          await insertCodeReposAuditEvent(client, {
            category: "code_repository",
            action: "commit",
            principalUserId: principal.userId,
            principalSource: principal.source === "test" ? "system" : principal.source,
            requestId: req.header("X-Request-Id") ?? outcome.commitSha,
            targetType: "Branch",
            targetRid: `${rid}@${branch}`,
            parameters: {
              commitSha: outcome.commitSha,
              parentSha,
              fileCount: outcome.fileCount,
              totalBytes: outcome.totalBytes,
              message: validation.message,
              addedOrModified: validation.files.length,
              deleted: validation.deletePaths.length,
            },
            // before_hash/after_hash on the audit chain are sha256 (64 hex)
            // by DDL contract — they are NOT the git SHAs (40 hex). The
            // commit-DAG advance is captured in `parameters` instead. We
            // pass null/null here to mirror the readFile audit pattern.
            beforeHash: null,
            afterHash: null,
            sourceIp: principal.sourceIp,
            userAgent: principal.userAgent,
          });
          await client.query("COMMIT");
        } catch (e) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* swallow */
          }
          throw e;
        } finally {
          client.release();
        }

        // Strong ETag = the new HEAD SHA. Clients pass this back as
        // If-Match on the next commit so the chain stays linear.
        res.setHeader("ETag", `"${outcome.commitSha}"`);
        res.status(201).json({
          repositoryRid: rid,
          branch,
          commitSha: outcome.commitSha,
          parentSha,
          fileCount: outcome.fileCount,
          totalBytes: outcome.totalBytes,
          addedOrModified: validation.files.length,
          deleted: validation.deletePaths.length,
          committedAt: committedAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
