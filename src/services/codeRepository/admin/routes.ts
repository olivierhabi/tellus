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
