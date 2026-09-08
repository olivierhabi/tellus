// ---------------------------------------------------------------------------
// Content-read router — extracted from admin/routes.ts.
//
//   GET /:rid/branches/:branch/tree   (B2-C-10) — tree listing
//   GET /:rid/branches/:branch/files  (B2-C-11) — read one blob
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { insertCodeReposAuditEvent } from "../../../codeRepos/audit/auditEvents";
import {
  observeFileReadBytes,
  observeFileReadDuration,
  observeTreeDuration,
  observeTreeEntriesReturned,
  recordFileRead,
  recordTreeRequest,
  type ReadStatusClass,
} from "../../../codeRepos/observability/metrics";
import { validateDepth, validateRelativePath } from "../../stemma/path";
import { detectBinary } from "../../stemma/binary";
import { mimeForPath } from "../../stemma/mime";
import { elapsedSeconds, isLegalBranchName, sendError } from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createTreeRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /:rid/branches/:branch/tree   (B2-C-10)
  //
  // Tree listing rooted at `?path` (default repo root) at `?depth` levels
  // (default 1, max 5). ETag = stable hash of the projected entries.
  // If-None-Match honoured → 304 Not Modified.
  //
  // Branch names with `/` MUST be URL-encoded by the client (axios's
  // `encodeURIComponent` does this); Express decodes the path param
  // automatically.
  // -------------------------------------------------------------------------
  router.get("/:rid/branches/:branch/tree", ctx.auth, async (req, res, next) => {
    const start = process.hrtime.bigint();
    const recordOutcome = (klass: ReadStatusClass): void => {
      const dur = elapsedSeconds(start);
      recordTreeRequest({ status_class: klass });
      observeTreeDuration({ status_class: klass }, dur);
    };
    try {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        recordOutcome("5xx");
        return sendError(res, codeReposError("CodeRepos:Internal", {}));
      }

      const rid = req.params.rid;
      if (!isRid(rid)) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:BranchNotFound", { branch }),
        );
      }

      const pathV = validateRelativePath(req.query.path);
      if (!pathV.ok) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidPath", { reason: pathV.reason }),
        );
      }
      const depthV = validateDepth(req.query.depth);
      if (!depthV.ok) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidDepth", {
            reason: "depth must be an integer in [1,5]",
          }),
        );
      }

      // Existence + 404-as-IDOR for non-ACTIVE/ARCHIVED rows.
      const repoRow = await ctx.pool.query(
        `SELECT 1 FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (repoRow.rowCount === 0) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }

      const outcome = await ctx.stemma.listTree({
        repositoryRid: rid,
        branch,
        path: pathV.value.normalized,
        depth: depthV.value,
      });

      if (outcome.kind === "branch-not-found") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:BranchNotFound", { branch }),
        );
      }
      if (outcome.kind === "path-not-found") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:FileNotFound", {
            path: pathV.value.normalized,
            branch,
          }),
        );
      }
      if (outcome.kind === "transient") {
        recordOutcome("5xx");
        return sendError(
          res,
          codeReposError("CodeRepos:Internal", { reason: outcome.reason }),
        );
      }

      // Strong-shaped ETag (no W/) — the body is byte-stable for a given
      // (rid, branch, path, depth, treeSha).
      const etag = `"${outcome.treeSha}"`;
      const ifNone = req.header("If-None-Match");
      if (ifNone && ifNone === etag) {
        res.setHeader("ETag", etag);
        recordOutcome("3xx");
        return res.status(304).end();
      }

      observeTreeEntriesReturned(outcome.entries.length);

      // Audit event — durable-before-ack so an audit failure surfaces as
      // 503 to the client; mirrors the pattern used by createRepository.
      const auditClient = await ctx.pool.connect();
      try {
        await auditClient.query("BEGIN");
        await insertCodeReposAuditEvent(auditClient, {
          category: "code_repository",
          action: "readTree",
          principalUserId: principal.userId,
          principalSource: principal.source === "test" ? "system" : principal.source,
          requestId: req.header("X-Request-Id") ?? outcome.treeSha,
          targetType: "Repository",
          targetRid: rid,
          parameters: {
            branch,
            path: pathV.value.normalized,
            depth: depthV.value,
            entryCount: outcome.entries.length,
          },
          beforeHash: null,
          afterHash: null,
          sourceIp: principal.sourceIp,
          userAgent: principal.userAgent,
        });
        await auditClient.query("COMMIT");
      } catch (e) {
        try {
          await auditClient.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        throw e;
      } finally {
        auditClient.release();
      }

      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, must-revalidate");
      recordOutcome("2xx");
      res.status(200).json({
        entries: outcome.entries,
        truncated: outcome.truncated,
        branch,
        commitSha: outcome.branchHead,
      });
    } catch (err) {
      recordOutcome("5xx");
      next(err);
    }
  });
  // -------------------------------------------------------------------------
  // GET /:rid/branches/:branch/files   (B2-C-11)
  //
  // Read one blob. Required `?path`. Returns:
  //   - 304 if `If-None-Match` matches the blob SHA;
  //   - 200 + truncated:true (empty body) if size > 5 MiB;
  //   - 200 + base64 if isBinary && size ≤ 5 MiB;
  //   - 200 + utf-8 otherwise.
  // -------------------------------------------------------------------------
  router.get("/:rid/branches/:branch/files", ctx.auth, async (req, res, next) => {
    const start = process.hrtime.bigint();
    let recordedTruncated: "true" | "false" = "false";
    const recordOutcome = (klass: ReadStatusClass): void => {
      const dur = elapsedSeconds(start);
      recordFileRead({ status_class: klass, truncated: recordedTruncated });
      observeFileReadDuration({ status_class: klass, truncated: recordedTruncated }, dur);
    };
    try {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        recordOutcome("5xx");
        return sendError(res, codeReposError("CodeRepos:Internal", {}));
      }

      const rid = req.params.rid;
      if (!isRid(rid)) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:BranchNotFound", { branch }),
        );
      }

      const rawPath = req.query.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidPath", { reason: "missing" }),
        );
      }
      const pathV = validateRelativePath(rawPath);
      if (!pathV.ok) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidPath", { reason: pathV.reason }),
        );
      }
      if (pathV.value.normalized === "") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidPath", { reason: "empty" }),
        );
      }

      const repoRow = await ctx.pool.query(
        `SELECT 1 FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (repoRow.rowCount === 0) {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }

      const outcome = await ctx.stemma.readBlob({
        repositoryRid: rid,
        branch,
        path: pathV.value.normalized,
      });

      if (outcome.kind === "branch-not-found") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:BranchNotFound", { branch }),
        );
      }
      if (outcome.kind === "path-not-found") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:FileNotFound", {
            path: pathV.value.normalized,
          }),
        );
      }
      if (outcome.kind === "path-is-tree") {
        recordOutcome("4xx");
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidPathType", {
            path: pathV.value.normalized,
            actualType: "tree",
          }),
        );
      }
      if (outcome.kind === "transient") {
        recordOutcome("5xx");
        return sendError(
          res,
          codeReposError("CodeRepos:Internal", { reason: outcome.reason }),
        );
      }

      const etag = `"${outcome.sha}"`;
      const ifNone = req.header("If-None-Match");
      if (ifNone && ifNone === etag) {
        res.setHeader("ETag", etag);
        recordOutcome("3xx");
        return res.status(304).end();
      }

      const SIZE_CAP = 5 * 1024 * 1024;
      const isBinary = detectBinary(outcome.content);
      const mime = mimeForPath(pathV.value.normalized, isBinary);
      const truncated = outcome.size > SIZE_CAP;
      recordedTruncated = truncated ? "true" : "false";
      observeFileReadBytes(outcome.size);

      // Audit row (durable-before-ack) before we ship the bytes.
      const auditClient = await ctx.pool.connect();
      try {
        await auditClient.query("BEGIN");
        await insertCodeReposAuditEvent(auditClient, {
          category: "code_repository",
          action: "readFile",
          principalUserId: principal.userId,
          principalSource: principal.source === "test" ? "system" : principal.source,
          requestId: req.header("X-Request-Id") ?? outcome.sha,
          targetType: "Repository",
          targetRid: rid,
          parameters: {
            branch,
            path: pathV.value.normalized,
            size: outcome.size,
            sha: outcome.sha,
            truncated,
            mime,
            isBinary,
          },
          beforeHash: null,
          afterHash: null,
          sourceIp: principal.sourceIp,
          userAgent: principal.userAgent,
        });
        await auditClient.query("COMMIT");
      } catch (e) {
        try {
          await auditClient.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        throw e;
      } finally {
        auditClient.release();
      }

      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, must-revalidate");

      if (truncated) {
        recordOutcome("2xx");
        res.status(200).json({
          content: "",
          encoding: "utf-8",
          size: outcome.size,
          sha: outcome.sha,
          mimeType: mime,
          isBinary,
          truncated: true,
        });
        return;
      }

      let body: { content: string; encoding: "utf-8" | "base64" };
      if (isBinary) {
        body = {
          content: Buffer.from(outcome.content).toString("base64"),
          encoding: "base64",
        };
      } else {
        body = {
          content: Buffer.from(outcome.content).toString("utf8"),
          encoding: "utf-8",
        };
      }

      recordOutcome("2xx");
      res.status(200).json({
        content: body.content,
        encoding: body.encoding,
        size: outcome.size,
        sha: outcome.sha,
        mimeType: mime,
        isBinary,
        truncated: false,
      });
    } catch (err) {
      recordOutcome("5xx");
      next(err);
    }
  });

  return router;
}
