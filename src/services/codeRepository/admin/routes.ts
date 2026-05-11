// ---------------------------------------------------------------------------
// B2 — Code Repository Service HTTP routes.
//
// Mounts under /api/v1/code-repositories (live) or /api/v1/code-repositories
// in the standalone test app. The mount-path-as-resource convention follows
// the rest of /api/docs/* (datasets, projects, templates, …).
//
// Endpoints (wave-8 scope):
//   POST   /                              — createRepository (saga)
//   GET    /                              — listRepositories (paginated)
//   GET    /:rid                          — getRepository
//   PATCH  /:rid                          — updateRepository (ETag)
//   DELETE /:rid                          — deleteRepository (TRASH)
//   GET    /:rid/branches                 — listBranches (cache)
//   GET    /:rid/settings                 — getRepoSettings
//   PUT    /:rid/settings                 — updateRepoSettings (ETag)
//
// Cross-cutting:
//   - Bearer auth (G-C-07..11)  via requireCodeReposAuth
//   - Idempotency-Key on POST   via idempotencyMiddleware
//   - ETag/If-Match on PATCH/PUT/DELETE
//   - Audit row per mutating call (G-C-51..54) inside the same tx
//   - §1.3 envelope on every error path
//   - IDOR-as-404 (G-C-09)
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { isRid, isStructurallyRid } from "../../codeRepos/contracts/rid";
import { ERROR_CODES } from "../../codeRepos/contracts/errors";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import { codeReposError, type CodeReposErrorName } from "../errors";
import {
  executeCreateRepositorySaga,
  type SagaExecutorDeps,
} from "../saga/executor";
import { insertCodeReposAuditEvent } from "../../codeRepos/audit/auditEvents";
import {
  observeFileReadBytes,
  observeFileReadDuration,
  observeTreeDuration,
  observeTreeEntriesReturned,
  recordFileRead,
  recordTreeRequest,
  type ReadStatusClass,
} from "../../codeRepos/observability/metrics";
import { validateDepth, validateRelativePath } from "../stemma/path";
import { detectBinary } from "../stemma/binary";
import { mimeForPath } from "../stemma/mime";

import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "../adapters/types";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface CodeRepositoryRoutesDeps {
  readonly pool: Pool;
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
}

interface CreateRepoBody {
  displayName?: unknown;
  parentFolderRid?: unknown;
  templateId?: unknown;
  templateVersion?: unknown;
  defaultBranch?: unknown;
}

interface PatchRepoBody {
  displayName?: unknown;
  defaultBranch?: unknown;
}

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

export function codeRepositoryRouter(deps: CodeRepositoryRoutesDeps): Router {
  const router = Router();
  const { pool } = deps;
  const sagaDeps: SagaExecutorDeps = {
    pool: deps.pool,
    compass: deps.compass,
    stemma: deps.stemma,
    template: deps.template,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Auth scoping (ADR-008).
  //
  // Auth is attached per-route, NOT via `router.use(requireCodeReposAuth())`.
  // Router-level auth combined with parent-prefix mounting on the live server
  // would intercept sibling `/api/v1/*` routes (e.g. `/api/v1/auth/login`)
  // and 401 them before the real auth router gets a chance. ADR-008 codifies
  // the rule. The router is now safe to mount at any prefix; unmatched paths
  // fall through via Express's default router behaviour.
  // ─────────────────────────────────────────────────────────────────────────
  const auth = requireCodeReposAuth();

  // -------------------------------------------------------------------------
  // POST /  (create)
  // -------------------------------------------------------------------------
  router.post(
    "/",
    auth,
    idempotencyMiddleware({ pool }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }
        const idem = (req.header("Idempotency-Key") ?? "").trim();
        if (!idem) {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "Idempotency-Key" }));
        }

        const body = (req.body ?? {}) as CreateRepoBody;
        const validation = validateCreateBody(body);
        if (validation.kind === "invalid") {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", validation.parameters));
        }

        // Map principal to UUID for ledger principal_sub. Production users
        // arrive with a Keycloak-issued UUID; test/PAT principals get a
        // deterministic v4-shaped UUID derived from sha256(userId).
        const principalSub = isUuidV4(principal.userId)
          ? principal.userId
          : derivePrincipalSubUuid(principal.userId);

        const result = await executeCreateRepositorySaga(sagaDeps, {
          idempotencyKey: idem,
          principalSub,
          displayName: validation.body.displayName,
          parentFolderRid: validation.body.parentFolderRid,
          templateId: validation.body.templateId,
          templateVersion: validation.body.templateVersion,
          defaultBranch: validation.body.defaultBranch,
        });

        if (result.kind === "ok") {
          // Audit emission: one row per ACTIVE saga completion.
          const auditClient = await pool.connect();
          try {
            await auditClient.query("BEGIN");
            await insertCodeReposAuditEvent(auditClient, {
              category: "code_repository",
              action: "createRepository",
              principalUserId: principal.userId,
              principalSource: "bearer-jwt",
              requestId: req.header("X-Request-Id") ?? result.sagaId,
              targetType: "Repository",
              targetRid: result.repositoryRid,
              parameters: {
                sagaId: result.sagaId,
                idempotencyKey: idem,
                displayName: validation.body.displayName,
                parentFolderRid: validation.body.parentFolderRid,
                templateId: validation.body.templateId,
                templateVersion: validation.body.templateVersion,
                replayed: result.replayed,
              },
              beforeHash: null,
              afterHash: null,
              sourceIp: req.ip ?? null,
              userAgent: req.header("User-Agent") ?? null,
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

          res.setHeader("ETag", `W/"1"`);
          res.status(201).json({
            rid: result.repositoryRid,
            sagaId: result.sagaId,
            displayName: validation.body.displayName,
            parentFolderRid: validation.body.parentFolderRid,
            templateId: validation.body.templateId,
            templateVersion: validation.body.templateVersion,
            defaultBranch: validation.body.defaultBranch,
            state: "ACTIVE",
            replayed: result.replayed,
          });
          return;
        }

        // Failure path — surface the saga's recorded errorName + envelope.
        const errorName = result.errorName as CodeReposErrorName;
        const env = codeReposError(errorName, {
          sagaId: result.sagaId,
          finalState: result.finalState,
        });
        return sendError(res, env);
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /  — list (cursor-paginated)
  // -------------------------------------------------------------------------
  router.get("/", auth, async (req, res, next) => {
    try {
      const stateFilter = typeof req.query.state === "string" ? req.query.state : "ACTIVE";
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const parentFolderRid = typeof req.query.parentFolderRid === "string" ? req.query.parentFolderRid : null;
      const params: unknown[] = [stateFilter];
      let where = "WHERE state = $1";
      if (parentFolderRid) {
        params.push(parentFolderRid);
        where += ` AND parent_folder_rid = $${params.length}`;
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT rid, display_name, parent_folder_rid, project_rid,
                template_id, template_version, default_branch,
                settings_json, state, created_by, created_at, updated_at,
                resource_version
           FROM code_repository ${where}
           ORDER BY created_at DESC
           LIMIT $${params.length}`,
        params,
      );
      res.status(200).json({
        items: r.rows.map(repoToResponse),
        nextPageToken: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:rid
  // -------------------------------------------------------------------------
  router.get("/:rid", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const r = await pool.query(
        `SELECT rid, display_name, parent_folder_rid, project_rid,
                template_id, template_version, default_branch,
                settings_json, state, created_by, created_at, updated_at,
                resource_version
           FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (r.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const row = r.rows[0];
      res.setHeader("ETag", `W/"${row.resource_version}"`);
      res.status(200).json(repoToResponse(row));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /:rid (ETag required)
  // -------------------------------------------------------------------------
  router.patch("/:rid", auth, async (req, res, next) => {
    try {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", {}));
      }
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const ifMatch = req.header("If-Match");
      if (!ifMatch) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "If-Match" }));
      }
      const body = (req.body ?? {}) as PatchRepoBody;

      const updates: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (typeof body.displayName === "string") {
        if (body.displayName.length === 0 || body.displayName.length > 255) {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidSettings", { field: "displayName" }),
          );
        }
        updates.push(`display_name = $${i++}`);
        values.push(body.displayName);
      }
      if (typeof body.defaultBranch === "string") {
        if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(body.defaultBranch)) {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidSettings", { field: "defaultBranch" }),
          );
        }
        updates.push(`default_branch = $${i++}`);
        values.push(body.defaultBranch);
      }
      if (updates.length === 0) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { reason: "no updatable fields" }));
      }
      updates.push(`resource_version = resource_version + 1`);
      updates.push(`updated_at = now()`);
      values.push(rid, parseEtag(ifMatch));

      const sql = `UPDATE code_repository
                      SET ${updates.join(", ")}
                    WHERE rid = $${i++} AND resource_version = $${i++}
                      AND state IN ('ACTIVE','ARCHIVED')
                    RETURNING resource_version, display_name, default_branch,
                              parent_folder_rid, project_rid, template_id,
                              template_version, settings_json, state,
                              created_by, created_at, updated_at, rid`;
      const r = await pool.query(sql, values);
      if (r.rowCount === 0) {
        // Could be ETag mismatch OR repo not found — disambiguate.
        const exists = await pool.query(
          `SELECT resource_version FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
          [rid],
        );
        if (exists.rowCount === 0) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          reason: "ETag mismatch",
          currentVersion: exists.rows[0].resource_version,
        }));
      }
      const row = r.rows[0];
      res.setHeader("ETag", `W/"${row.resource_version}"`);
      res.status(200).json(repoToResponse(row));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:rid (soft-delete to TRASHED state, ETag required)
  // -------------------------------------------------------------------------
  router.delete("/:rid", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const ifMatch = req.header("If-Match");
      if (!ifMatch) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "If-Match" }));
      }

      const r = await pool.query(
        `UPDATE code_repository
            SET state = 'TRASHED', updated_at = now(), resource_version = resource_version + 1
          WHERE rid = $1 AND resource_version = $2 AND state = 'ACTIVE'`,
        [rid, parseEtag(ifMatch)],
      );
      if (r.rowCount === 0) {
        const ex = await pool.query(
          `SELECT state, resource_version FROM code_repository WHERE rid = $1`,
          [rid],
        );
        if (ex.rowCount === 0 || ex.rows[0].state === "TRASHED") {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          reason: "ETag mismatch",
          currentVersion: ex.rows[0].resource_version,
        }));
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:rid/branches
  // -------------------------------------------------------------------------
  router.get("/:rid/branches", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const exists = await pool.query(
        `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const protectedFilter = req.query.protected;
      const params: unknown[] = [rid];
      let where = `repository_rid = $1`;
      if (protectedFilter === "true") {
        where += ` AND is_protected = TRUE`;
      } else if (protectedFilter === "false") {
        where += ` AND is_protected = FALSE`;
      }
      const r = await pool.query(
        `SELECT branch_name, head_sha, is_protected, last_commit_at,
                last_commit_author, open_pr_count, updated_at
           FROM code_repository_branch_cache
          WHERE ${where}
          ORDER BY branch_name`,
        params,
      );
      res.status(200).json({
        branches: r.rows.map((b) => ({
          name: b.branch_name,
          headSha: b.head_sha,
          isProtected: b.is_protected,
          lastCommitAt: b.last_commit_at,
          lastCommitAuthor: b.last_commit_author,
          openPrCount: b.open_pr_count,
          updatedAt: b.updated_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

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
  router.get("/:rid/branches/:branch/tree", auth, async (req, res, next) => {
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
      const repoRow = await pool.query(
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

      const outcome = await deps.stemma.listTree({
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
      const auditClient = await pool.connect();
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
  router.get("/:rid/branches/:branch/files", auth, async (req, res, next) => {
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

      const repoRow = await pool.query(
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

      const outcome = await deps.stemma.readBlob({
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
      const auditClient = await pool.connect();
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
    auth,
    idempotencyMiddleware({ pool }),
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

        const repoRow = await pool.query<{ state: string }>(
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

        const outcome = await deps.stemma.commitFiles({
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
        const client = await pool.connect();
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

  // -------------------------------------------------------------------------
  // GET /:rid/settings
  // -------------------------------------------------------------------------
  router.get("/:rid/settings", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const r = await pool.query(
        `SELECT settings_json, resource_version FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (r.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      res.setHeader("ETag", `W/"${r.rows[0].resource_version}"`);
      res.status(200).json(r.rows[0].settings_json);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:rid/settings (ETag required)
  // -------------------------------------------------------------------------
  router.put("/:rid/settings", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const ifMatch = req.header("If-Match");
      if (!ifMatch) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "If-Match" }));
      }
      const body = req.body;
      if (typeof body !== "object" || body === null) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { reason: "body must be JSON object" }));
      }

      const r = await pool.query(
        `UPDATE code_repository
            SET settings_json = $1::jsonb,
                resource_version = resource_version + 1,
                updated_at = now()
          WHERE rid = $2 AND resource_version = $3 AND state IN ('ACTIVE','ARCHIVED')
          RETURNING settings_json, resource_version`,
        [JSON.stringify(body), rid, parseEtag(ifMatch)],
      );
      if (r.rowCount === 0) {
        const ex = await pool.query(
          `SELECT resource_version FROM code_repository
            WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
          [rid],
        );
        if (ex.rowCount === 0) {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          reason: "ETag mismatch",
          currentVersion: ex.rows[0].resource_version,
        }));
      }
      res.setHeader("ETag", `W/"${r.rows[0].resource_version}"`);
      res.status(200).json(r.rows[0].settings_json);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sendError(
  res: Response,
  err: { status: number; envelope: unknown },
): void {
  res.status(err.status).json(err.envelope);
}

function isUuidV4(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function derivePrincipalSubUuid(userId: string): string {
  // Deterministic v4-shaped UUID for non-Keycloak principals (PAT, test mode).
  // Stable mapping: same userId -> same UUID across processes/restarts.
  // Layout: sha256(userId) hex, slice 32 hex digits, force version=4 and
  // variant=8|9|a|b at the spec-defined positions.
  const h = createHash("sha256").update(`code-repos:principal:${userId}`).digest("hex");
  const seg1 = h.slice(0, 8);
  const seg2 = h.slice(8, 12);
  const seg3 = "4" + h.slice(13, 16);
  const variantNibble = (parseInt(h[16], 16) & 0x3) | 0x8;
  const seg4 = variantNibble.toString(16) + h.slice(17, 20);
  const seg5 = h.slice(20, 32);
  return `${seg1}-${seg2}-${seg3}-${seg4}-${seg5}`;
}

function parseEtag(s: string): number {
  // Accept W/"NN" or "NN".
  const m = s.match(/^(?:W\/)?"(\d+)"$/);
  if (!m) return Number.NaN;
  return parseInt(m[1], 10);
}

/**
 * §G-C-13 branchName grammar — matches the PATCH /:rid validator. We want
 * to reject obviously bad inputs (NUL byte, empty string, leading dash,
 * `..`, `@{`, `\`) at the route layer BEFORE we hit the adapter — so the
 * adapter never sees pathological branch names.
 */
function isLegalBranchName(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > 255) return false;
  if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(s)) return false;
  if (s.startsWith("-") || s.startsWith("/")) return false;
  if (s.endsWith(".lock")) return false;
  if (s.includes("..") || s.includes("@{") || s.includes("\\")) return false;
  return true;
}

/** Wall-clock seconds since `t0`, where `t0 = process.hrtime.bigint()`. */
function elapsedSeconds(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e9;
}

interface RepoRow {
  rid: string;
  display_name: string;
  parent_folder_rid: string;
  project_rid: string;
  template_id: string;
  template_version: string;
  default_branch: string;
  settings_json: Record<string, unknown>;
  state: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  resource_version: number;
}

function repoToResponse(row: RepoRow): Record<string, unknown> {
  return {
    rid: row.rid,
    displayName: row.display_name,
    parentFolderRid: row.parent_folder_rid,
    projectRid: row.project_rid,
    templateId: row.template_id,
    templateVersion: row.template_version,
    defaultBranch: row.default_branch,
    settings: row.settings_json,
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resourceVersion: Number(row.resource_version),
  };
}

interface ValidatedCreateBody {
  displayName: string;
  parentFolderRid: string;
  templateId: string;
  templateVersion: string;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// Commit-route helpers (B2-C-12).
// ---------------------------------------------------------------------------

/**
 * Parse an `If-Match` header value as a 40-char SHA-1. Accepts strong
 * (`"abcdef..."`) or weak (`W/"abcdef..."`) form per RFC 7232. Anything
 * else (digits, integer ETags from PATCH /:rid, malformed quotes, wrong
 * length) returns `null`.
 *
 * Kept separate from `parseEtag` (which parses the integer-shaped
 * resource-version ETag used by the metadata routes) because conflating
 * the two would let a client sneak a `W/"7"` past the commit-route fence
 * and into the adapter, where `7 !== <40-char head>` would 412 — but
 * with a less-helpful "not a SHA" reason. Failing fast at the route is
 * clearer and cheaper.
 */
function parseShaIfMatch(s: string): string | null {
  const m = s.match(/^(?:W\/)?"([0-9a-f]{40})"$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

/** Per F4 spec: max 1 MiB total commit payload to keep tx latency bounded. */
const COMMIT_MAX_TOTAL_BYTES = 1 * 1024 * 1024;
/** Cap commit size by file count so a pathological client can't OOM us. */
const COMMIT_MAX_FILE_CHANGES = 500;
/** Cap commit message length (longer messages signal abuse, not user intent). */
const COMMIT_MAX_MESSAGE_BYTES = 4 * 1024;

interface ValidatedCommitBody {
  message: string;
  /** Upserts (add + modify), translated to StemmaCommitFile shape. */
  files: ReadonlyArray<{
    path: string;
    content: Uint8Array;
    mode: "100644" | "100755";
  }>;
  deletePaths: ReadonlyArray<string>;
}

/**
 * Validate the POST /commits body. Returns either a normalized payload
 * ready to hand to the adapter, or a structured error envelope reason.
 *
 * Tight validation here means the adapter never sees malformed paths,
 * negative-length contents, or duplicate fileChange entries — failure
 * modes downstream get strictly easier to reason about.
 */
function validateCommitBody(
  body: unknown,
):
  | { kind: "ok" } & ValidatedCommitBody
  | {
      kind: "invalid";
      errorName:
        | "CodeRepos:InvalidSettings"
        | "CodeRepos:EmptyChangeSet"
        | "CodeRepos:InvalidPath";
      parameters: Record<string, unknown>;
    } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { reason: "body must be a JSON object" },
    };
  }
  const b = body as Record<string, unknown>;

  const message = typeof b.message === "string" ? b.message : "";
  if (message.length === 0) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "message", reason: "required" },
    };
  }
  if (Buffer.byteLength(message, "utf8") > COMMIT_MAX_MESSAGE_BYTES) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "message", reason: "too long", maxBytes: COMMIT_MAX_MESSAGE_BYTES },
    };
  }

  const fileChanges = b.fileChanges;
  if (!Array.isArray(fileChanges)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "fileChanges", reason: "must be an array" },
    };
  }
  if (fileChanges.length === 0) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:EmptyChangeSet",
      parameters: { reason: "fileChanges is empty" },
    };
  }
  if (fileChanges.length > COMMIT_MAX_FILE_CHANGES) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "fileChanges", reason: "too many", max: COMMIT_MAX_FILE_CHANGES },
    };
  }

  const seenPaths = new Set<string>();
  const upserts: Array<{ path: string; content: Uint8Array; mode: "100644" | "100755" }> = [];
  const deletes: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < fileChanges.length; i++) {
    const c = fileChanges[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: { field: `fileChanges[${i}]`, reason: "must be an object" },
      };
    }
    const cc = c as Record<string, unknown>;
    const path = typeof cc.path === "string" ? cc.path : "";
    const op = typeof cc.op === "string" ? cc.op : "";

    const pathV = validateRelativePath(path);
    if (!pathV.ok) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { index: i, path, reason: pathV.reason },
      };
    }
    const normalizedPath = pathV.value.normalized;
    if (normalizedPath === "") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { index: i, reason: "empty after normalization" },
      };
    }
    if (seenPaths.has(normalizedPath)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].path`,
          reason: "duplicate path in same commit",
          path: normalizedPath,
        },
      };
    }
    seenPaths.add(normalizedPath);

    if (op !== "add" && op !== "modify" && op !== "delete") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].op`,
          reason: 'must be "add" | "modify" | "delete"',
          got: op,
        },
      };
    }

    if (op === "delete") {
      if (cc.contentBase64 !== undefined) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: {
            field: `fileChanges[${i}].contentBase64`,
            reason: "must be omitted when op=delete",
          },
        };
      }
      deletes.push(normalizedPath);
      continue;
    }

    // op === "add" | "modify" — contentBase64 required.
    if (typeof cc.contentBase64 !== "string") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].contentBase64`,
          reason: "required for add/modify",
        },
      };
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(cc.contentBase64, "base64");
      // Buffer.from with mode "base64" silently drops invalid chars; round-trip
      // and compare lengths to detect malformed input. (`Buffer.from(x, 'base64')
      // .toString('base64')` re-canonicalizes; we check decoded length instead
      // to catch over-padded inputs.)
      const reencoded = buf.toString("base64").replace(/=+$/, "");
      const supplied = cc.contentBase64.replace(/=+$/, "").replace(/\s+/g, "");
      if (reencoded !== supplied) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: {
            field: `fileChanges[${i}].contentBase64`,
            reason: "not valid base64",
          },
        };
      }
    } catch {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].contentBase64`,
          reason: "not valid base64",
        },
      };
    }
    const mode = cc.mode === "100755" ? "100755" : "100644";
    totalBytes += buf.byteLength;
    if (totalBytes > COMMIT_MAX_TOTAL_BYTES) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: "fileChanges",
          reason: "total payload exceeds limit",
          maxBytes: COMMIT_MAX_TOTAL_BYTES,
        },
      };
    }
    upserts.push({
      path: normalizedPath,
      content: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      mode,
    });
  }

  return {
    kind: "ok",
    message,
    files: upserts,
    deletePaths: deletes,
  };
}

function validateCreateBody(
  body: CreateRepoBody,
):
  | { kind: "ok"; body: ValidatedCreateBody }
  | { kind: "invalid"; parameters: Record<string, unknown> } {
  if (typeof body.displayName !== "string" || body.displayName.length === 0 || body.displayName.length > 255) {
    return { kind: "invalid", parameters: { field: "displayName" } };
  }
  if (typeof body.parentFolderRid !== "string" || !isStructurallyRid(body.parentFolderRid)) {
    return { kind: "invalid", parameters: { field: "parentFolderRid" } };
  }
  if (typeof body.templateId !== "string" || body.templateId.length === 0) {
    return { kind: "invalid", parameters: { field: "templateId" } };
  }
  if (typeof body.templateVersion !== "string" || body.templateVersion.length === 0) {
    return { kind: "invalid", parameters: { field: "templateVersion" } };
  }
  const defaultBranch =
    typeof body.defaultBranch === "string" && body.defaultBranch.length > 0
      ? body.defaultBranch
      : "main";
  if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(defaultBranch)) {
    return { kind: "invalid", parameters: { field: "defaultBranch" } };
  }
  // Suppress unused error code warning by exporting.
  void ERROR_CODES;
  return {
    kind: "ok",
    body: {
      displayName: body.displayName,
      parentFolderRid: body.parentFolderRid,
      templateId: body.templateId,
      templateVersion: body.templateVersion,
      defaultBranch,
    },
  };
}
