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

import { isRid, isStructurallyRid, mintFunctionVersionRid } from "../../codeRepos/contracts/rid";
import { publishVersion, listVersions } from "../../functionsRegistry/store";
import { parseSemver, compareSemver } from "../../functionsRegistry/semver";
import { ERROR_CODES } from "../../codeRepos/contracts/errors";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import { codeReposError, type CodeReposErrorName } from "../errors";
import { runSandboxed, runSandboxedWithSdk } from "../../functionRuntime";
import {
  applyEdits,
  buildOntologySdk,
  loadOntologySnapshot,
  normalizeOntologyId,
  type OntologyEdit,
  type OntologySnapshot,
} from "../../functions/ontologyRuntime";
import {
  createTtlCache,
  transpileCacheKey,
} from "./invokeCache";
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

// Per-process caches for the function-invoke hot path. See invokeCache.ts for
// the rationale (burst-coalescing the invokes a Workshop Object Table fires).
// `transpileCache` is content-addressed (no TTL); `snapshotCache` is TTL-bound
// because `object_instances` is mutable — a few seconds of staleness is the
// right tradeoff for a Workshop Live-Preview read (point-in-time snapshot).
const transpileCache = createTtlCache<string, string>({ maxEntries: 64 });
const SNAPSHOT_TTL_MS = Number(process.env.FUNCTION_SNAPSHOT_TTL_MS ?? 5_000);
const snapshotCache = createTtlCache<string, OntologySnapshot>({
  maxEntries: 8,
  ttlMs: SNAPSHOT_TTL_MS,
});

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
      const ifMatchVersion = parseVersionEtagOrNull(ifMatch);
      if (ifMatchVersion === null) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          field: "If-Match",
          reason: 'must be a resource-version ETag of the form W/"<n>" or "<n>"',
        }));
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
      values.push(rid, ifMatchVersion);

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
        // Row exists but resource_version did not match → optimistic-concurrency
        // failure. 412 Precondition Failed (RFC 7232), not 400. (Fix CR-11b.)
        return sendError(res, codeReposError("CodeRepos:PreconditionFailed", {
          reason: "If-Match resource version does not match current version",
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
      const ifMatchVersion = parseVersionEtagOrNull(ifMatch);
      if (ifMatchVersion === null) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          field: "If-Match",
          reason: 'must be a resource-version ETag of the form W/"<n>" or "<n>"',
        }));
      }

      const r = await pool.query(
        `UPDATE code_repository
            SET state = 'TRASHED', updated_at = now(), resource_version = resource_version + 1
          WHERE rid = $1 AND resource_version = $2 AND state = 'ACTIVE'`,
        [rid, ifMatchVersion],
      );
      if (r.rowCount === 0) {
        const ex = await pool.query(
          `SELECT state, resource_version FROM code_repository WHERE rid = $1`,
          [rid],
        );
        if (ex.rowCount === 0 || ex.rows[0].state === "TRASHED") {
          return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
        }
        // Row exists & ACTIVE but version mismatch → 412 (RFC 7232). (Fix CR-11b.)
        return sendError(res, codeReposError("CodeRepos:PreconditionFailed", {
          reason: "If-Match resource version does not match current version",
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
      const exists = await pool.query<{ default_branch: string }>(
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
      const cacheRows = await pool.query<{
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
      const sb = await deps.stemma.listBranches({ repositoryRid: rid });
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
  router.post("/:rid/branches", auth, idempotencyMiddleware({ pool }), async (req, res, next) => {
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
      const { rows } = await pool.query<{ default_branch: string; state: string }>(
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

      const out = await deps.stemma.createBranch({ repositoryRid: rid, newBranch: name, fromBranch });
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
      await pool
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
  router.delete("/:rid/branches/:branch", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      const branch = req.params.branch;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      const { rows } = await pool.query<{ default_branch: string; state: string }>(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (rows.length === 0 || rows[0].state === "TRASHED") {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      if (branch === rows[0].default_branch) {
        return sendError(res, codeReposError("CodeRepos:CannotModifyDefaultBranch", { branch }));
      }
      const out = await deps.stemma.deleteBranch({ repositoryRid: rid, branch });
      if (out.kind === "not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
      }
      if (out.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: out.reason }));
      }
      await pool
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
      const ifMatchVersion = parseVersionEtagOrNull(ifMatch);
      if (ifMatchVersion === null) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", {
          field: "If-Match",
          reason: 'must be a resource-version ETag of the form W/"<n>" or "<n>"',
        }));
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
        [JSON.stringify(body), rid, ifMatchVersion],
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
        // Settings ETag mismatch → 412 (RFC 7232). (Fix CR-11b consistency.)
        return sendError(res, codeReposError("CodeRepos:PreconditionFailed", {
          reason: "If-Match resource version does not match current version",
          currentVersion: ex.rows[0].resource_version,
        }));
      }
      res.setHeader("ETag", `W/"${r.rows[0].resource_version}"`);
      res.status(200).json(r.rows[0].settings_json);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:rid/resource-imports  — B4-C-10
  //
  // Returns the repository's current import set. Slim wire shape; the FE
  // re-resolves full ontology metadata (icons, display names, link
  // endpoints) via the existing /api/v1/ontology read path.
  //
  // ETag is the content-derived sha256 of the sorted (kind, api_name)
  // tuples (truncated to 16 hex) — stateless. Two empty sets always
  // return the same ETag; semantically-equal sets always return the same
  // ETag; the client never needs a separate version column to detect
  // staleness.
  //
  // Response shape:
  //   { ontologyId: string | null,
  //     items: Array<{ kind, apiName, rid, displayName }> }
  //
  // ontologyId === null iff items is empty.
  // -------------------------------------------------------------------------
  router.get("/:rid/resource-imports", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const repoExists = await pool.query(
        `SELECT 1 FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (repoExists.rowCount === 0) {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const r = await pool.query(
        `SELECT ontology_id, kind, api_name, rid AS row_rid, display_name
           FROM code_repository_resource_imports
          WHERE repository_rid = $1
          ORDER BY kind, api_name`,
        [rid],
      );
      const items = r.rows.map((row) => ({
        kind: row.kind as "object_type" | "link_type",
        apiName: row.api_name as string,
        rid: (row.row_rid as string | null) ?? null,
        displayName: (row.display_name as string | null) ?? null,
      }));
      // The DB column is `ontology_id` for legacy reasons; on the wire
      // we always speak `ontologyRid` (full `ri.ontology.<scope>.ontology.<uuid>`
      // form) because that is what gets persisted.
      const ontologyRid =
        items.length === 0 ? null : (r.rows[0].ontology_id as string);
      const etag = computeImportsEtag(items);
      res.setHeader("ETag", `W/"${etag}"`);
      res.status(200).json({ ontologyRid, items });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:rid/resource-imports  — B4-C-11
  //
  // Replace-all semantics. Atomic in one transaction (DELETE + bulk
  // INSERT). Idempotent: PUT'ing the same body twice yields the same
  // ETag and the second call is a no-op at the row level.
  //
  // Required headers:
  //   If-Match: W/"<etag>"  — fences against concurrent writes.
  //
  // Body:
  //   { ontologyId: string | null,
  //     items: Array<{ kind: "object_type"|"link_type",
  //                    apiName: string,
  //                    rid?: string,
  //                    displayName?: string }> }
  //
  //   items=[]  → ontologyId may be null; the repo's import set is cleared.
  //   items≠[]  → ontologyId is required and applies to every row.
  //
  // Validation rules (each maps to InvalidImportsBody):
  //   - body is JSON object
  //   - ontologyId is null|string (non-empty when items≠[])
  //   - items is an array (≤ 500 entries)
  //   - every item has valid kind + apiName (1..255 chars)
  //   - (kind, apiName) tuples are unique within the request
  //
  // Response: same shape as GET, with the new ETag in the response header.
  // -------------------------------------------------------------------------
  router.put("/:rid/resource-imports", auth, async (req, res, next) => {
    try {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", {}));
      }
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const ifMatch = req.header("If-Match");
      if (!ifMatch) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidImportsBody", { field: "If-Match" }),
        );
      }
      const parsedIfMatch = parseImportsEtag(ifMatch);
      if (parsedIfMatch === null) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidImportsBody", {
            field: "If-Match",
            reason: "expected W/\"<etag>\" form",
          }),
        );
      }

      const validation = validateImportsBody(req.body);
      if (!validation.ok) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidImportsBody", validation.parameters),
        );
      }
      const { ontologyRid: ontologyRidFromBody, items } = validation;

      // Repo lookup + archive check.
      const repoRow = await pool.query(
        `SELECT state FROM code_repository
          WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (repoRow.rowCount === 0) {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      if (repoRow.rows[0].state === "ARCHIVED") {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryArchived", { rid }),
        );
      }

      const principalUuid = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // ETag check against the live set.
        const currentRows = await client.query(
          `SELECT kind, api_name
             FROM code_repository_resource_imports
            WHERE repository_rid = $1
            ORDER BY kind, api_name
            FOR UPDATE`,
          [rid],
        );
        const currentItems = currentRows.rows.map((row) => ({
          kind: row.kind as "object_type" | "link_type",
          apiName: row.api_name as string,
        }));
        const currentEtag = computeImportsEtag(currentItems);
        if (parsedIfMatch !== currentEtag) {
          await client.query("ROLLBACK");
          return sendError(
            res,
            codeReposError("CodeRepos:StaleImportsState", {
              rid,
              currentEtag,
            }),
          );
        }

        await client.query(
          `DELETE FROM code_repository_resource_imports WHERE repository_rid = $1`,
          [rid],
        );

        if (items.length > 0) {
          // Bulk insert via UNNEST. Safe — every column is parametrized
          // and the array length is already bounded by MAX_IMPORTS.
          const kinds = items.map((it) => it.kind);
          const apiNames = items.map((it) => it.apiName);
          const rids = items.map((it) => it.rid ?? null);
          const displayNames = items.map((it) => it.displayName ?? null);
          await client.query(
            `INSERT INTO code_repository_resource_imports
                 (repository_rid, ontology_id, kind, api_name, rid, display_name, added_by)
             SELECT $1, $2, k, a, r, d, $3
               FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[])
                 AS t(k, a, r, d)`,
            [
              rid,
              ontologyRidFromBody,
              principalUuid,
              kinds,
              apiNames,
              rids,
              displayNames,
            ],
          );
        }

        // Audit row (G-C-51) inside the same tx so a rollback erases it.
        await insertCodeReposAuditEvent(client, {
          category: "code_repos",
          action: "resourceImports.put",
          targetRid: rid,
          targetType: "CodeRepository",
          principalUserId: principalUuid,
          principalSource:
            principal.source === "test" ? "system" : principal.source,
          requestId: req.header("X-Request-ID") ?? "",
          beforeHash: null,
          afterHash: null,
          sourceIp: principal.sourceIp,
          userAgent: principal.userAgent,
          parameters: {
            previousEtag: currentEtag,
            count: items.length,
            ontologyRid: ontologyRidFromBody,
            kinds: items.reduce(
              (acc, it) => {
                acc[it.kind] = (acc[it.kind] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            ),
          },
        });

        await client.query("COMMIT");

        const newEtag = computeImportsEtag(
          items.map((it) => ({ kind: it.kind, apiName: it.apiName })),
        );
        res.setHeader("ETag", `W/"${newEtag}"`);
        res.status(200).json({
          ontologyRid: items.length === 0 ? null : ontologyRidFromBody,
          items: items.map((it) => ({
            kind: it.kind,
            apiName: it.apiName,
            rid: it.rid ?? null,
            displayName: it.displayName ?? null,
          })),
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /:rid/tags  — Tag & Release (Foundry parity A16/B5).
  //
  // This is the load-bearing bridge from repository → functions registry that
  // makes TypeScript Functions v2 actually publishable. Steps (mirroring
  // Foundry's "Tag and release publishes ALL functions in the repository"):
  //
  //   1. Resolve the branch + its content-pinned tree hash (the publish's
  //      commit identifier).
  //   2. Discover every function under src/functions/*.ts (one default export
  //      per file; basename = apiName).
  //   3. Build each artifact (transpile-validate; a compile error fails the
  //      whole release — Foundry blocks publish on a failing build).
  //   4. Backward-compatibility check vs the prior highest version on the
  //      branch: a dropped function requires a MAJOR bump.
  //   5. Publish ONE immutable function_version row carrying the whole bundle
  //      (manifest.exports = [apiNames], manifest.sources = {apiName: src}),
  //      content-addressed by artifact_sha256. Immutability is enforced by the
  //      registry store's unique index.
  //
  //   Body: { tag | semver: "X.Y.Z", branch?, message? }
  //   201  { version, functions: [...], deduplicated? }
  // -------------------------------------------------------------------------
  router.post("/:rid/tags", auth, idempotencyMiddleware({ pool }), async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));

      const b = (req.body ?? {}) as { tag?: unknown; semver?: unknown; branch?: unknown; message?: unknown };
      const semverStr = typeof b.semver === "string" ? b.semver : typeof b.tag === "string" ? b.tag : "";
      let parsedSemver;
      try {
        parsedSemver = parseSemver(semverStr.replace(/^v/, ""));
      } catch {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "semver", reason: "must be a valid SemVer X.Y.Z[-prerelease]" }));
      }
      const semver = semverStr.replace(/^v/, "");

      const { rows: repoRows } = await pool.query<{ default_branch: string; state: string }>(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (repoRows.length === 0 || repoRows[0].state === "TRASHED") {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const defaultBranch = repoRows[0].default_branch;
      const branch = typeof b.branch === "string" && b.branch.length > 0 ? b.branch : defaultBranch;
      // Preview vs stable: a release off a non-default branch, or a prerelease
      // SemVer (1.2.3-rc1), is a preview build (never resolves on default).
      const isPreview = branch !== defaultBranch || parsedSemver.preRelease.length > 0;

      // 1 + 2 — tree + function discovery.
      const tree = await deps.stemma.listTree({ repositoryRid: rid, branch, path: "", depth: 6 });
      if (tree.kind === "branch-not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
      }
      if (tree.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "tree-read-failed" }));
      }
      const commitSha = tree.treeSha; // content-pinned identifier of the release tree
      const FN_RE = /(^|\/)src\/functions\/([A-Za-z_][A-Za-z0-9_]*)\.ts$/;
      const discovered: Array<{ apiName: string; path: string }> = [];
      for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        if (entry.name.includes(".test.")) continue;
        const m = FN_RE.exec(entry.path);
        if (m) discovered.push({ apiName: m[2], path: entry.path });
      }
      if (discovered.length === 0) {
        return sendError(res, codeReposError("CodeRepos:NoFunctionsToPublish", { branch }));
      }

      // 3 — build each artifact (read + transpile-validate).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ts = require("typescript") as typeof import("typescript");
      const sources: Record<string, string> = {};
      const exportsList: string[] = [];
      for (const fn of discovered.sort((a, c) => a.apiName.localeCompare(c.apiName))) {
        const blob = await deps.stemma.readBlob({ repositoryRid: rid, branch, path: fn.path });
        if (blob.kind !== "ok") {
          return sendError(res, codeReposError("CodeRepos:ReleaseCompileError", { apiName: fn.apiName, reason: "source unreadable" }));
        }
        const src = new TextDecoder("utf-8").decode(blob.content);
        const out = ts.transpileModule(src, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, isolatedModules: true },
          fileName: `${fn.apiName}.ts`,
        });
        if (out.diagnostics && out.diagnostics.length > 0) {
          return sendError(res, codeReposError("CodeRepos:ReleaseCompileError", { apiName: fn.apiName, reason: "transpile diagnostics" }));
        }
        sources[fn.apiName] = src;
        exportsList.push(fn.apiName);
      }

      // 4 — backward-compatibility check vs prior highest version on branch.
      let prior: { semver: string; exports: string[] } | null = null;
      const existing = await listVersions(pool, rid, { branch, includeYanked: false });
      for (const v of existing) {
        const exp = Array.isArray((v.manifest as { exports?: unknown }).exports)
          ? ((v.manifest as { exports: unknown[] }).exports.filter((x): x is string => typeof x === "string"))
          : [];
        if (prior === null || compareSemver(parseSemver(v.semver), parseSemver(prior.semver)) > 0) {
          prior = { semver: v.semver, exports: exp };
        }
      }
      if (prior !== null) {
        const cmp = compareSemver(parsedSemver, parseSemver(prior.semver));
        // Strictly-lower version → reject. Equal version falls through to the
        // registry's idempotent dedupe (same artifact → 200) or immutability
        // conflict (different artifact → 409); we must not pre-empt that here.
        if (cmp < 0) {
          return sendError(res, codeReposError("CodeRepos:VersionConflict", { reason: "semver must be greater than the latest published version", latest: prior.semver }));
        }
        const removed = prior.exports.filter((e) => !exportsList.includes(e));
        const majorBump = parseSemver(semver).major > parseSemver(prior.semver).major;
        if (removed.length > 0 && !majorBump) {
          return sendError(res, codeReposError("CodeRepos:BackwardIncompatible", {
            reason: "functions were removed without a major version bump",
            removedFunctions: removed,
            requiredBump: "major",
            latest: prior.semver,
          }));
        }
      }

      // 5 — publish the immutable bundle.
      const manifest = {
        exports: exportsList,
        sources,
        runtime: "NODE_20" as const,
        functionCount: exportsList.length,
        message: typeof b.message === "string" ? b.message.slice(0, 1024) : null,
      };
      const canonical = JSON.stringify({ exports: exportsList, sources });
      const artifactSha256 = createHash("sha256").update(canonical).digest("hex");
      const artifactBytes = Buffer.byteLength(canonical, "utf8");

      let publishResult;
      try {
        publishResult = await publishVersion(pool, {
          rid: mintFunctionVersionRid(),
          repositoryRid: rid,
          branch,
          isPreview,
          semver,
          commitSha,
          runtime: "NODE_20",
          artifactBlobId: `inline:${artifactSha256.slice(0, 16)}`,
          artifactSha256,
          artifactBytes,
          manifest,
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "23505") {
          return sendError(res, codeReposError("CodeRepos:VersionConflict", { reason: "version already exists", semver }));
        }
        throw e;
      }
      if (publishResult.outcome === "immutable-conflict") {
        return sendError(res, codeReposError("CodeRepos:VersionConflict", {
          reason: "this version already exists with a different artifact (immutable)",
          semver,
        }));
      }

      const status = publishResult.outcome === "inserted" ? 201 : 200;
      res.setHeader("ETag", `W/"${semver}"`);
      return res.status(status).type("application/json").send(JSON.stringify({
        version: {
          rid: publishResult.row.rid,
          repositoryRid: rid,
          branch,
          semver,
          isPreview,
          commitSha,
          runtime: "NODE_20",
          state: publishResult.row.state,
          artifactSha256,
          publishedAt: publishResult.row.publishedAt,
        },
        functions: exportsList,
        deduplicated: publishResult.outcome === "deduplicated",
      }));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:rid/functions  — B2-C-13 (user-facing read aggregator over B8)
  //
  // Returns the set of published functions for a repository on a given branch,
  // derived from the highest-semver AVAILABLE row per (repo, branch). The
  // manifest convention is { exports: string[] } (B8 publish payload).
  //
  // The IDE's FunctionBrowser calls this endpoint to populate the Published
  // tab. Published versions are produced by POST /:rid/tags (Tag & Release).
  // -------------------------------------------------------------------------
  router.get("/:rid/functions", auth, async (req, res, next) => {
    try {
      const { rid } = req.params;
      if (!isRid(rid)) {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }

      const repo = await pool.query(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1 LIMIT 1`,
        [rid],
      );
      if (repo.rowCount === 0) {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }
      if (repo.rows[0].state === "ARCHIVED") {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }

      const requestedBranch = typeof req.query.branch === "string" ? req.query.branch : null;
      const branch = requestedBranch ?? repo.rows[0].default_branch ?? "main";

      // Function rows returned to the client are the union of two sources:
      //   1. Published versions from `function_version` (post-CI-publish).
      //   2. Working-tree source files at `<root>/src/functions/<apiName>.{ts,py}`
      //      discovered via Stemma. The basename is the apiName per the
      //      template convention (one function per file, default export).
      // Published wins when both exist for the same apiName — the user
      // cares about the deployed artifact's metadata once it's available.
      type MergedFunctionRow = {
        apiName: string;
        versionRid: string | null;
        semver: string | null;
        branch: string;
        isPreview: boolean;
        runtime: string;
        commitSha: string | null;
        publishedAt: string | null;
        source: "published" | "working_tree";
        path: string | null;
      };
      const byApiName = new Map<string, MergedFunctionRow>();

      // ---- Published versions (B8) ------------------------------------
      // The function_version table may not exist on test schemas that didn't
      // load migration 055_b8_functions_registry.sql. Probe first; treat
      // table-absent as "no published functions yet" rather than 500.
      const tablePresence = await pool.query<{ exists: boolean }>(
        `SELECT to_regclass('function_version') IS NOT NULL AS exists`,
      );
      if (tablePresence.rows[0]?.exists) {
        // For each apiName exported by any AVAILABLE version on this branch,
        // pick the highest-semver row. The aggregation is single-pass; the
        // semver comparator is the one B8 uses to keep ordering consistent.
        const rowsRes = await pool.query<{
          rid: string;
          branch: string;
          semver: string;
          is_preview: boolean;
          runtime: string;
          commit_sha: string;
          // NB: the app configures node-postgres to return TIMESTAMPTZ (OID
          // 1184) as a raw ISO string, not a JS Date (src/db.ts). So this is
          // a string at runtime — never call Date methods on it directly.
          published_at: string | Date;
          manifest_json: { exports?: unknown };
        }>(
          `SELECT rid, branch, semver, is_preview, runtime, commit_sha, published_at, manifest_json
             FROM function_version
            WHERE repository_rid = $1 AND branch = $2 AND state = 'AVAILABLE'`,
          [rid, branch],
        );

        for (const r of rowsRes.rows) {
          const exportsRaw = r.manifest_json?.exports;
          if (!Array.isArray(exportsRaw)) continue;
          for (const name of exportsRaw) {
            if (typeof name !== "string" || name.length === 0) continue;
            const prev = byApiName.get(name);
            if (prev === undefined || compareSemverLoose(r.semver, prev.semver ?? "") > 0) {
              byApiName.set(name, {
                apiName: name,
                versionRid: r.rid,
                semver: r.semver,
                branch: r.branch,
                isPreview: r.is_preview,
                runtime: r.runtime,
                commitSha: r.commit_sha,
                // Robust to both string (production: db.ts type parser) and Date.
                publishedAt:
                  r.published_at instanceof Date
                    ? r.published_at.toISOString()
                    : new Date(r.published_at).toISOString(),
                source: "published",
                path: null,
              });
            }
          }
        }
      }

      // ---- Working-tree discovery (Stemma tree walk) ------------------
      // Convention (src/services/templates/manifest.ts:51 + :349):
      //   - typescript-functions: `<root>/src/functions/<apiName>.ts`
      //   - python-functions:     `<root>/src/functions/<apiName>.py`
      // One function per file, basename = identity, `export default`.
      // We walk at depth 5 to cover scaffold-nested layouts; if the branch
      // doesn't exist or the tree walk fails (transient), we silently fall
      // back to the published-only list — never 500 on discovery failure.
      // Working-tree entries are tracked SEPARATELY from published ones (not
      // merged into byApiName). A function that is both published AND present
      // in the working tree must surface under BOTH sources, because the
      // Published tab and the Live Preview tab are distinct surfaces: Published
      // runs the released artifact; Live Preview runs the current in-tree file
      // (which may differ from what was released). Masking working-tree behind
      // published would leave the Live Preview tab empty even though the file
      // exists — the exact symptom users hit after Tag & Release.
      const workingTree: MergedFunctionRow[] = [];
      const wtSeen = new Set<string>();
      try {
        const tree = await deps.stemma.listTree({
          repositoryRid: rid,
          branch,
          path: "",
          depth: 5,
        });
        if (tree.kind === "ok") {
          const FUNCTIONS_DIR_RE = /(^|\/)src\/functions\/([A-Za-z_][A-Za-z0-9_]*)\.(ts|py)$/;
          for (const entry of tree.entries) {
            if (entry.type !== "blob") continue;
            const m = FUNCTIONS_DIR_RE.exec(entry.path);
            if (m === null) continue;
            const apiName = m[2];
            const ext = m[3];
            // Skip test files and obvious non-functions defensively (the
            // convention says one function per file, but a `helloWorld.test.ts`
            // sibling could land in the same directory in real repos).
            if (apiName.endsWith("Test") || entry.name.includes(".test.")) continue;
            if (wtSeen.has(apiName)) continue; // one working-tree entry per apiName
            wtSeen.add(apiName);
            workingTree.push({
              apiName,
              versionRid: null,
              semver: null,
              branch,
              isPreview: true,
              runtime: ext === "py" ? "PY_311" : "NODE_20",
              commitSha: null,
              publishedAt: null,
              source: "working_tree",
              path: entry.path,
            });
          }
        }
      } catch {
        // Discovery is best-effort. A Stemma fault must not break the
        // published-versions response.
      }

      const data = [...byApiName.values(), ...workingTree].sort((a, b) =>
        a.apiName.localeCompare(b.apiName) || a.source.localeCompare(b.source),
      );
      res
        .status(200)
        .type("application/json")
        .send(JSON.stringify({ data, totalCount: data.length, branch }));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /:rid/functions/invoke  — invoke a working-tree function
  //
  // Reads `src/functions/<apiName>.ts` from the active branch, transpiles
  // TypeScript → CommonJS via the `typescript` package, and executes inside
  // a hardened `vm` sandbox (functionRuntime.ts) with a 5 s CPU cap and no
  // host access. Body: `{ apiName: string, args?: object, branch?: string,
  // source?: "working_tree" | "published" }`. Response:
  //   { status: "ok"|"error"|"timeout", output, durationMs, logs[],
  //     errorMessage? }
  // -------------------------------------------------------------------------
  router.post("/:rid/functions/invoke", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));

      // Body validation first — must precede file lookup so malformed
      // input returns a clean 4xx regardless of whether the function exists.
      const body = (req.body ?? {}) as {
        apiName?: unknown;
        args?: unknown;
        branch?: unknown;
        source?: unknown;
        inlineSource?: unknown;
        inlineSourcePath?: unknown;
        applyEdits?: unknown;
      };
      const apiName = typeof body.apiName === "string" ? body.apiName : "";
      if (!apiName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiName) || apiName.length > 128) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidArgumentBody", {
            field: "apiName",
            reason: "required; must match [A-Za-z_][A-Za-z0-9_]{0,127}",
          }),
        );
      }
      if (
        body.args !== undefined &&
        (body.args === null ||
          typeof body.args !== "object" ||
          Array.isArray(body.args))
      ) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidArgumentBody", {
            field: "args",
            reason: "must be a JSON object (or omitted)",
          }),
        );
      }
      // Path A: optional inline source for real-time edit-and-rerun.
      // The IDE's Monaco draft buffer travels with the Run request and
      // shortcuts the stemma read entirely. The user-facing flow is
      // therefore edit → Run (no Commit needed) — which is the Foundry
      // Code Repositories convention for unpublished function previews.
      //
      // Size cap: 256 KB. A single source file at that size already
      // exceeds the practical authoring limit (the largest scaffolded
      // function is ~2 KB); the cap exists to make a misbehaving client
      // observable rather than to constrain real authors.
      const INLINE_SOURCE_MAX_BYTES = 256 * 1024;
      let inlineSource: string | null = null;
      if (body.inlineSource !== undefined && body.inlineSource !== null) {
        if (typeof body.inlineSource !== "string") {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidArgumentBody", {
              field: "inlineSource",
              reason: "must be a string (UTF-8 source)",
            }),
          );
        }
        const bytes = Buffer.byteLength(body.inlineSource, "utf8");
        if (bytes > INLINE_SOURCE_MAX_BYTES) {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidArgumentBody", {
              field: "inlineSource",
              reason: `exceeds ${INLINE_SOURCE_MAX_BYTES} byte cap (got ${bytes})`,
            }),
          );
        }
        if (body.inlineSource.length > 0) inlineSource = body.inlineSource;
      }
      // inlineSourcePath is informational — used only to choose the
      // transpile language. If absent, we infer from the discovered tree
      // entry (or default to TS when inlineSource is provided without a
      // path, since the working-tree IDE only edits TS today).
      let inlineSourcePath: string | null = null;
      if (body.inlineSourcePath !== undefined && body.inlineSourcePath !== null) {
        if (typeof body.inlineSourcePath !== "string" || body.inlineSourcePath.length > 1024) {
          return sendError(
            res,
            codeReposError("CodeRepos:InvalidArgumentBody", {
              field: "inlineSourcePath",
              reason: "must be a string ≤ 1024 chars",
            }),
          );
        }
        inlineSourcePath = body.inlineSourcePath;
      }

      // Resolve the repo + branch.
      const { rows: repoRows } = await deps.pool.query<{
        rid: string;
        default_branch: string;
        state: string;
      }>(
        `SELECT rid, default_branch, state
           FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (repoRows.length === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const repo = repoRows[0];
      const branch =
        typeof body.branch === "string" && body.branch.length > 0
          ? String(body.branch)
          : repo.default_branch;

      // Resolve the source. Two paths:
      //
      //   1. Path A (real-time edit-and-rerun) — `inlineSource` is provided
      //      by the IDE's Monaco draft buffer. We skip the stemma read
      //      entirely; the user has not committed yet. Runtime is inferred
      //      from `inlineSourcePath`'s extension (`.py` → Python, anything
      //      else → TS).
      //
      //   2. Committed working tree — walk the tree, locate
      //      `<langProject>/src/functions/<apiName>.<ts|py>` (e.g.
      //      `typescript-functions/src/functions/helloWorld.ts`), readBlob.
      let source: string;
      let runtime: "NODE_20" | "PY_311" = "NODE_20";
      let resolvedPath: string | null = null;

      if (inlineSource !== null) {
        source = inlineSource;
        if (inlineSourcePath !== null && /\.py$/i.test(inlineSourcePath)) {
          runtime = "PY_311";
        }
        resolvedPath = inlineSourcePath; // informational only
      } else if (body.source === "published") {
        // Path B (published) — run the artifact registered by Tag & Release.
        // Resolve the highest-semver AVAILABLE version on the branch and pull
        // the function's source from its bundle manifest.
        const versions = await listVersions(deps.pool, rid, { branch, includeYanked: false });
        let chosen: { semver: string; sources: Record<string, string> } | null = null;
        for (const v of versions) {
          const m = v.manifest as { sources?: Record<string, unknown> };
          const src = m.sources && typeof m.sources[apiName] === "string" ? (m.sources[apiName] as string) : null;
          if (src === null) continue;
          if (chosen === null || compareSemver(parseSemver(v.semver), parseSemver(chosen.semver)) > 0) {
            chosen = { semver: v.semver, sources: { [apiName]: src } };
          }
        }
        if (chosen === null) {
          return sendError(res, codeReposError("CodeRepos:FunctionNotFound", { apiName, source: "published" }));
        }
        source = chosen.sources[apiName];
        runtime = "NODE_20";
        resolvedPath = `published:${chosen.semver}`;
      } else {
        const tree = await deps.stemma.listTree({
          repositoryRid: rid,
          branch,
          path: "",
          depth: 5,
        });
        if (tree.kind === "branch-not-found") {
          return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
        }
        if (tree.kind !== "ok") {
          return sendError(res, codeReposError("CodeRepos:FunctionNotFound", { apiName }));
        }
        const FN_RE = new RegExp(
          `(^|\\/)src\\/functions\\/${apiName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.(ts|py)$`,
        );
        let foundPath: string | null = null;
        for (const entry of tree.entries) {
          if (entry.type !== "blob") continue;
          const m = FN_RE.exec(entry.path);
          if (m === null) continue;
          if (entry.name.includes(".test.")) continue;
          foundPath = entry.path;
          runtime = m[2] === "py" ? "PY_311" : "NODE_20";
          break;
        }
        if (foundPath === null) {
          return sendError(res, codeReposError("CodeRepos:FunctionNotFound", { apiName }));
        }
        resolvedPath = foundPath;

        if (runtime !== "PY_311") {
          const blob = await deps.stemma.readBlob({
            repositoryRid: rid,
            branch,
            path: foundPath,
          });
          if (blob.kind === "branch-not-found") {
            return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
          }
          if (blob.kind !== "ok") {
            return sendError(res, codeReposError("CodeRepos:FunctionNotFound", { apiName }));
          }
          source = new TextDecoder("utf-8").decode(blob.content);
        } else {
          source = ""; // unreachable; the runtime guard below short-circuits
        }
      }

      if (runtime === "PY_311") {
        return sendError(
          res,
          codeReposError("CodeRepos:RuntimeNotSupported", {
            apiName,
            runtime,
            reason:
              "Python runtime is not yet available in the in-browser sandbox. Publish via CI to invoke server-side.",
          }),
        );
      }
      void resolvedPath; // surface for future telemetry; not used in response today

      // Transpile TS → CommonJS via the isolated-module path (fast, no
      // type-check diagnostics blocking execution). Content-addressed by
      // (apiName, source) so a repeated invoke (the common case — Workshop
      // re-invokes the same committed function on every render + retry) skips
      // the transpile entirely.
      const transpileKey = transpileCacheKey(apiName, source);
      let transpiled = transpileCache.get(transpileKey);
      if (transpiled === undefined) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const ts = require("typescript") as typeof import("typescript");
          const out = ts.transpileModule(source, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
              esModuleInterop: true,
              isolatedModules: true,
            },
            fileName: `${apiName}.ts`,
          });
          // TS may emit either `exports.<apiName>` (named exports) or
          // `exports.default` (default exports). Surface whichever is a
          // callable as the module's export so the sandbox picks it up.
          transpiled =
            out.outputText +
            `\nif (typeof module !== "undefined") {` +
            ` module.exports = ` +
            `(typeof exports[${JSON.stringify(apiName)}] === "function" ? exports[${JSON.stringify(apiName)}]` +
            ` : (typeof exports.default === "function" ? exports.default : module.exports));` +
            `}\n`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendError(
            res,
            codeReposError("CodeRepos:FunctionCompileError", {
              apiName,
              reason: msg,
            }),
          );
        }
        transpileCache.set(transpileKey, transpiled);
      }

      const input = (body.args ?? {}) as unknown;

      // ---- Ontology SDK injection (snapshot isolation) ------------------
      // Materialise a consistent view of the Ontology from the repo's imported
      // object types and inject `Objects`/`Edits` so the function can read and
      // express edits exactly like a Foundry TS Function v2. The snapshot is
      // built BEFORE the sandbox runs (the sandbox is synchronous).
      const imports = await deps.pool.query<{ ontology_id: string; api_name: string }>(
        `SELECT ontology_id, api_name FROM code_repository_resource_imports
          WHERE repository_rid = $1 AND kind = 'object_type'`,
        [rid],
      );
      let ontologyId: string | null = null;
      const importedTypes: string[] = [];
      for (const row of imports.rows) {
        const norm = normalizeOntologyId(row.ontology_id);
        if (norm) ontologyId = norm;
        importedTypes.push(row.api_name);
      }
      // Snapshot load is the single most expensive step on this path (up to a
      // 200k-row SELECT). Cache it per (ontology, imported types) with a short
      // TTL so the burst of invokes one table render fires reuses one load.
      // The request's abort signal cancels the SELECT if the budget is
      // exceeded, instead of letting it run to completion after we 504.
      const snapshotKey = ontologyId
        ? `${ontologyId}:${[...importedTypes].sort().join(",")}`
        : "";
      let snapshot: OntologySnapshot | undefined =
        ontologyId ? snapshotCache.get(snapshotKey) : undefined;
      if (ontologyId && !snapshot) {
        let loaded: OntologySnapshot;
        try {
          loaded = await loadOntologySnapshot(deps.pool, {
            ontologyId,
            objectTypes: importedTypes,
            signal: (req as unknown as { timeoutSignal?: AbortSignal }).timeoutSignal,
          });
        } catch (err) {
          // The request-budget middleware may have already 504'd (aborting the
          // SELECT). Don't double-send; otherwise surface a 500.
          if (res.headersSent || res.writableEnded) return;
          const msg = err instanceof Error ? err.message : String(err);
          return sendError(
            res,
            codeReposError("CodeRepos:Internal", {
              reason: "ontology-snapshot-load-failed",
              message: msg,
            }),
          );
        }
        snapshotCache.set(snapshotKey, loaded);
        snapshot = loaded;
      }
      const resolvedSnapshot: OntologySnapshot = snapshot ?? {
        byType: new Map(),
        ontologyId: "",
        objectCount: 0,
        objectTypes: [] as string[],
      };
      const { sdk, getEdits } = buildOntologySdk(resolvedSnapshot);

      const result = runSandboxedWithSdk(transpiled, input, {
        Objects: sdk.Objects,
        Edits: sdk.Edits,
        createEditBatch: sdk.createEditBatch,
        __ontologyTypes: sdk.objectTypeDescriptors,
      });
      // Foundry TS v2: an edit function RETURNS `batch.getEdits()`. Prefer the
      // returned edit array; fall back to the ambient `Edits` side-channel
      // (v1-style functions that mutate via Edits.update and return a value).
      const isEdit = (x: unknown): x is OntologyEdit =>
        !!x && typeof x === "object" &&
        ["create", "update", "delete", "link", "unlink"].includes((x as { op?: unknown }).op as string);
      const returnedEdits: OntologyEdit[] =
        Array.isArray(result.output) && result.output.length > 0 && result.output.every(isEdit)
          ? (result.output as OntologyEdit[])
          : [];
      const sideChannelEdits = result.status === "ok" ? getEdits() : [];
      const collectedEdits: OntologyEdit[] =
        result.status === "ok" ? (returnedEdits.length > 0 ? returnedEdits : sideChannelEdits) : [];

      // Edits do NOT persist on a plain invoke (Foundry: preview is read-only).
      // The caller opts in via `applyEdits: true`, simulating a function-backed
      // Action committing the batch to the Ontology system-of-record.
      let editsApplied: { created: number; updated: number; deleted: number; linked: number; unlinked: number } | null = null;
      if (result.status === "ok" && collectedEdits.length > 0 && body.applyEdits === true && ontologyId) {
        try {
          editsApplied = await applyEdits(deps.pool, {
            ontologyId,
            edits: collectedEdits,
            actorUserId: (req as { codeReposPrincipal?: { userId?: string } }).codeReposPrincipal?.userId ?? null,
          });
        } catch (e) {
          return sendError(res, codeReposError("CodeRepos:Internal", {
            reason: "edit-apply-failed",
            message: (e as Error)?.message ?? "unknown",
          }));
        }
      }

      // Partition captured logs into stdout/stderr (the runtime tags
      // error frames with a `[err] ` prefix; everything else is stdout).
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      for (const line of result.logs) {
        if (line.startsWith("[err] ")) stderrLines.push(line.slice(6));
        else stdoutLines.push(line);
      }

      if (result.status === "timeout") {
        return res
          .status(504)
          .type("application/json")
          .send(
            JSON.stringify({
              apiName,
              result: null,
              durationMs: result.durationMs,
              stdout: stdoutLines.join("\n"),
              stderr:
                (result.errorMessage ?? "Execution exceeded 5 s cap.") +
                (stderrLines.length > 0 ? "\n" + stderrLines.join("\n") : ""),
              status: "timeout",
            }),
          );
      }

      if (result.status === "error") {
        return res
          .status(200)
          .type("application/json")
          .send(
            JSON.stringify({
              apiName,
              result: null,
              durationMs: result.durationMs,
              stdout: stdoutLines.join("\n"),
              stderr:
                (result.errorMessage ?? "") +
                (stderrLines.length > 0 ? "\n" + stderrLines.join("\n") : ""),
              status: "error",
            }),
          );
      }

      // Stringify the result so the wire shape is always a string per the
      // FE contract; objects/numbers/booleans are JSON.stringified.
      const serialized =
        typeof result.output === "string"
          ? result.output
          : result.output === undefined
            ? ""
            : JSON.stringify(result.output);

      return res
        .status(200)
        .type("application/json")
        .send(
          JSON.stringify({
            apiName,
            result: serialized,
            durationMs: result.durationMs,
            stdout: stdoutLines.join("\n"),
            stderr: stderrLines.join("\n"),
            status: "ok",
            // Ontology integration surface (Foundry parity B7):
            edits: collectedEdits,
            editsApplied,
            ontology: {
              ontologyId: ontologyId ?? null,
              objectsLoaded: resolvedSnapshot.objectCount,
              objectTypes: resolvedSnapshot.objectTypes,
            },
          }),
        );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Loose semver comparator used by the read aggregator at routes.ts:GET
// /:rid/functions. Splits on `.` and `-`, compares numeric parts numerically,
// non-numeric parts lexicographically. Sufficient for "pick the highest
// version" — B8's own ordering for plain MAJOR.MINOR.PATCH agrees. Pre-release
// strings (`-alpha.1`) sort lower than the same release without the suffix.
function compareSemverLoose(a: string, b: string): number {
  const splitVersion = (v: string): readonly (number | string)[] => {
    const [release, pre] = v.split("-", 2);
    const releaseParts = release.split(".").map((p) => {
      const n = Number(p);
      return Number.isInteger(n) && p === String(n) ? n : p;
    });
    if (pre === undefined) return releaseParts;
    const preParts = pre.split(".").map((p) => {
      const n = Number(p);
      return Number.isInteger(n) && p === String(n) ? n : p;
    });
    return [...releaseParts, "-", ...preParts];
  };
  const aParts = splitVersion(a);
  const bParts = splitVersion(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    // A release version is HIGHER than a pre-release of the same release.
    if (ap === undefined) return bp === "-" ? 1 : -1;
    if (bp === undefined) return ap === "-" ? -1 : 1;
    if (typeof ap === "number" && typeof bp === "number") {
      if (ap !== bp) return ap - bp;
    } else if (typeof ap === "string" && typeof bp === "string") {
      if (ap !== bp) return ap < bp ? -1 : 1;
    } else {
      // Numeric segment sorts higher than string segment at the same index.
      return typeof ap === "number" ? 1 : -1;
    }
  }
  return 0;
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
 * Parse an `If-Match` resource-version ETag, returning `null` when the header
 * is present but unparseable (e.g. a bare token like `not-a-version`). Routes
 * must short-circuit to 400 on `null` BEFORE binding the value into a SQL
 * `bigint` parameter — otherwise `NaN` reaches Postgres and crashes the query
 * with "invalid input syntax for type bigint" (500). Fixes parity defect CR-11d.
 */
function parseVersionEtagOrNull(s: string): number | null {
  const n = parseEtag(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
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

// ---------------------------------------------------------------------------
// B4 resource-imports helpers.
// ---------------------------------------------------------------------------

const MAX_IMPORTS = 500;
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

/**
 * Stateless ETag for an import set. SHA-256 of the sorted (kind, api_name)
 * lines, truncated to 16 hex chars. Two semantically-equal sets always
 * yield the same etag regardless of insertion order or surrounding columns.
 */
function computeImportsEtag(
  items: ReadonlyArray<{ kind: string; apiName: string }>,
): string {
  if (items.length === 0) return "empty";
  const sorted = items
    .map((it) => `${it.kind}\t${it.apiName}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(sorted, "utf8").digest("hex").slice(0, 16);
}

/** Parse `W/"<etag>"` or `"<etag>"` into the raw etag, or null if malformed. */
function parseImportsEtag(s: string): string | null {
  const m = s.match(/^(?:W\/)?"([A-Za-z0-9_-]+|empty)"$/);
  return m ? m[1] : null;
}

// Renamed wire field is `ontologyRid`; the DB column is still `ontology_id`
// for migration compatibility.
interface ValidatedImportsBody {
  readonly ok: true;
  readonly ontologyRid: string;
  readonly items: ReadonlyArray<{
    readonly kind: "object_type" | "link_type";
    readonly apiName: string;
    readonly rid?: string;
    readonly displayName?: string;
  }>;
}

interface InvalidImportsBody {
  readonly ok: false;
  readonly parameters: Record<string, unknown>;
}

/**
 * Validate the PUT body. On success returns the normalized payload; on
 * failure returns the `parameters` to attach to the InvalidImportsBody
 * envelope so the FE can tell *which* field is bad.
 */
function validateImportsBody(
  body: unknown,
): ValidatedImportsBody | InvalidImportsBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, parameters: { reason: "body must be a JSON object" } };
  }
  const b = body as Record<string, unknown>;

  // items
  if (!Array.isArray(b.items)) {
    return { ok: false, parameters: { field: "items", reason: "must be array" } };
  }
  if (b.items.length > MAX_IMPORTS) {
    return {
      ok: false,
      parameters: { field: "items", reason: "too many", max: MAX_IMPORTS },
    };
  }

  // ontologyRid — required when items≠[], optional/null when items=[].
  // Accept legacy `ontologyId` as a deprecated alias so older callers
  // keep working; new callers must send `ontologyRid`.
  const ontologyRidRaw = b.ontologyRid ?? b.ontologyId;
  if (b.items.length > 0) {
    if (typeof ontologyRidRaw !== "string" || ontologyRidRaw.length === 0) {
      return {
        ok: false,
        parameters: { field: "ontologyRid", reason: "required when items≠[]" },
      };
    }
    if (ontologyRidRaw.length > 512) {
      return {
        ok: false,
        parameters: { field: "ontologyRid", reason: "too long" },
      };
    }
  } else if (
    ontologyRidRaw !== null &&
    ontologyRidRaw !== undefined &&
    typeof ontologyRidRaw !== "string"
  ) {
    return {
      ok: false,
      parameters: { field: "ontologyRid", reason: "must be string or null" },
    };
  }

  // items[]
  const seen = new Set<string>();
  const normalized: Array<{
    kind: "object_type" | "link_type";
    apiName: string;
    rid?: string;
    displayName?: string;
  }> = [];
  for (let i = 0; i < b.items.length; i += 1) {
    const raw = b.items[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        parameters: { field: `items[${i}]`, reason: "must be object" },
      };
    }
    const it = raw as Record<string, unknown>;
    const kind = it.kind;
    if (kind !== "object_type" && kind !== "link_type") {
      return {
        ok: false,
        parameters: {
          field: `items[${i}].kind`,
          reason: "must be 'object_type' or 'link_type'",
        },
      };
    }
    const apiName = it.apiName;
    if (typeof apiName !== "string" || !API_NAME_RE.test(apiName)) {
      return {
        ok: false,
        parameters: {
          field: `items[${i}].apiName`,
          reason: "must match /^[A-Za-z][A-Za-z0-9_]{0,254}$/",
        },
      };
    }
    const key = `${kind}\u0000${apiName}`;
    if (seen.has(key)) {
      return {
        ok: false,
        parameters: {
          field: `items[${i}]`,
          reason: "duplicate (kind, apiName) within request",
        },
      };
    }
    seen.add(key);

    const rid = it.rid;
    if (rid !== undefined && rid !== null) {
      if (typeof rid !== "string" || rid.length > 512) {
        return {
          ok: false,
          parameters: {
            field: `items[${i}].rid`,
            reason: "must be string ≤ 512 chars",
          },
        };
      }
    }
    const displayName = it.displayName;
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 255) {
        return {
          ok: false,
          parameters: {
            field: `items[${i}].displayName`,
            reason: "must be string ≤ 255 chars",
          },
        };
      }
    }
    normalized.push({
      kind,
      apiName,
      rid: typeof rid === "string" ? rid : undefined,
      displayName: typeof displayName === "string" ? displayName : undefined,
    });
  }

  return {
    ok: true,
    // ontologyRid is "" when items=[] and caller passed null — the column
    // still needs a value but the row never lands. We coerce here for
    // type-narrowing; the route's `items.length === 0 ? null : ontologyRid`
    // gate keeps the response shape honest.
    ontologyRid:
      typeof ontologyRidRaw === "string" ? ontologyRidRaw : "",
    items: normalized,
  };
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
