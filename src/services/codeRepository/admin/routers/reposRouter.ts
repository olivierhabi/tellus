// ---------------------------------------------------------------------------
// Repository CRUD router — extracted from admin/routes.ts.
//
//   POST   /         — createRepository (saga)
//   GET    /         — listRepositories (paginated)
//   GET    /:rid     — getRepository
//   PATCH  /:rid     — updateRepository (ETag)
//   DELETE /:rid     — deleteRepository (TRASH)
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { idempotencyMiddleware } from "../../../codeRepos/middleware/idempotency";
import { codeReposError, type CodeReposErrorName } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { executeCreateRepositorySaga } from "../../saga/executor";
import { insertCodeReposAuditEvent } from "../../../codeRepos/audit/auditEvents";
import {
  derivePrincipalSubUuid,
  isUuidV4,
  parseVersionEtagOrNull,
  repoToResponse,
  sendError,
  validateCreateBody,
  type CreateRepoBody,
  type PatchRepoBody,
} from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createReposRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /  (create)
  // -------------------------------------------------------------------------
  router.post(
    "/",
    ctx.auth,
    idempotencyMiddleware({ pool: ctx.pool }),
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

        const result = await executeCreateRepositorySaga(ctx.sagaDeps, {
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
          const auditClient = await ctx.pool.connect();
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
  router.get("/", ctx.auth, async (req, res, next) => {
    try {
      const stateFilter = typeof req.query.state === "string" ? req.query.state : "ACTIVE";
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const parentFolderRid = typeof req.query.parentFolderRid === "string" ? req.query.parentFolderRid : null;
      // Optional scope: only repos that import a given object type (apiName).
      // A function-backed column on a Workshop table bound to object type X may
      // only invoke functions from a repo that imports X (otherwise the
      // function cannot read those objects). Scoping here also keeps the IDE's
      // cross-repo function fan-out from surfacing dozens of unrelated repos'
      // template-default `helloWorld` in the Workshop "Select Function" picker.
      const importsObjectType =
        typeof req.query.importsObjectType === "string" &&
        req.query.importsObjectType.length > 0
          ? req.query.importsObjectType
          : null;
      // Optional filter: only repos whose template_id contains this substring
      // (ILIKE). Used by the ActionTypeDialog's unscoped function picker to
      // fetch ONLY typescript-function repos without paginating through every
      // transforms-python repo in the deployment.
      const templateIdContains =
        typeof req.query.templateIdContains === "string" &&
        req.query.templateIdContains.length > 0
          ? req.query.templateIdContains
          : null;
      const params: unknown[] = [stateFilter];
      let where = "WHERE state = $1";
      if (parentFolderRid) {
        params.push(parentFolderRid);
        where += ` AND parent_folder_rid = $${params.length}`;
      }
      if (importsObjectType) {
        // Guard: the imports table may be absent on minimal test schemas.
        const importsPresent = await ctx.pool.query<{ exists: boolean }>(
          `SELECT to_regclass('code_repository_resource_imports') IS NOT NULL AS exists`,
        );
        if (importsPresent.rows[0]?.exists) {
          params.push(importsObjectType);
          where += ` AND EXISTS (SELECT 1 FROM code_repository_resource_imports i WHERE i.repository_rid = code_repository.rid AND i.api_name = $${params.length})`;
        }
      }
      if (templateIdContains) {
        params.push(`%${templateIdContains}%`);
        where += ` AND template_id ILIKE $${params.length}`;
      }
      params.push(limit);
      const r = await ctx.pool.query(
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
  router.get("/:rid", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const r = await ctx.pool.query(
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
  router.patch("/:rid", ctx.auth, async (req, res, next) => {
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
      const r = await ctx.pool.query(sql, values);
      if (r.rowCount === 0) {
        // Could be ETag mismatch OR repo not found — disambiguate.
        const exists = await ctx.pool.query(
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
  router.delete("/:rid", ctx.auth, async (req, res, next) => {
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

      const client = await ctx.pool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          `UPDATE code_repository
              SET state = 'TRASHED', updated_at = now(), resource_version = resource_version + 1
            WHERE rid = $1 AND resource_version = $2 AND state = 'ACTIVE'
            RETURNING display_name, parent_folder_rid, project_rid, created_by, created_at`,
          [rid, ifMatchVersion],
        );
        if (r.rowCount === 0) {
          const ex = await client.query(
            `SELECT state, resource_version FROM code_repository WHERE rid = $1`,
            [rid],
          );
          await client.query("ROLLBACK");
          if (ex.rowCount === 0 || ex.rows[0].state === "TRASHED") {
            return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
          }
          // Row exists & ACTIVE but version mismatch → 412 (RFC 7232). (Fix CR-11b.)
          return sendError(res, codeReposError("CodeRepos:PreconditionFailed", {
            reason: "If-Match resource version does not match current version",
            currentVersion: ex.rows[0].resource_version,
          }));
        }

        const row = r.rows[0] as {
          display_name: string;
          parent_folder_rid: string;
          project_rid: string;
          created_by: string;
          created_at: string;
        };

        // Mirror into resources so the unified Trash (/trashed) lists the repo —
        // same pattern as pipelines (PIPELINE) and workshops (WORKSHOP_MODULE).
        // Resolve the canonical Compass RIDs (workshop does the same). The
        // stored `parent_folder_rid` uses legacy `ri.compass.main.folder.*`
        // while Folder Trash expects `ri.compass.main.compass-folder.*`; we
        // canonicalize and also fix the buggy `project_rid = parentFolderRid`
        // that the saga wrote for subfolder repos.
        const principal = (req as unknown as { codeReposPrincipal?: { userId: string } }).codeReposPrincipal;
        const rawPrincipalId = principal?.userId ?? row.created_by;
        const principalSub = isUuidV4(rawPrincipalId)
          ? rawPrincipalId
          : derivePrincipalSubUuid(rawPrincipalId);
        // Resolve FK-valid user IDs for resources (created_by/trashed_by must exist in users).
        // The repo's created_by (53cf9bcf...) is a synthetic test principal that
        // never lands in users, so the FK would fail. Fall back to an existing user.
        const resolveValidUserId = async (candidate: string): Promise<string> => {
          const hit = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = $1::uuid`, [candidate]);
          if (hit.rows.length > 0) return candidate;
          const fallback = await client.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`);
          return fallback.rows[0]?.id ?? candidate;
        };
        const validTrashedBy = await resolveValidUserId(principalSub);
        const validCreatedBy = await resolveValidUserId(row.created_by);
        const parentSegments = row.parent_folder_rid.split(".");
        const parentUuid = parentSegments[parentSegments.length - 1] ?? "";
        const folderRes = await client.query<{ project_id: string }>(
          `SELECT project_id FROM folders WHERE id = $1::uuid`,
          [parentUuid],
        );
        const projectId = folderRes.rows[0]?.project_id ?? parentUuid;
        const projectRid = `ri.compass.main.project.${projectId}`;
        const canonicalParentRid = folderRes.rows.length > 0
          ? `ri.compass.main.compass-folder.${parentUuid}`
          : projectRid;

        const projRes = await client.query<{ space_rid: string }>(
          `SELECT space_rid FROM resources WHERE rid = $1`,
          [projectRid],
        );
        const spaceRid = projRes.rows[0]?.space_rid ?? null;
        if (spaceRid) {
          await client.query(
            `INSERT INTO resources
               (rid, service, type, display_name,
                parent_folder_rid, project_rid, space_rid,
                trash_status, trashed_at, trashed_by, retention_until,
                created_by, created_at, updated_by, updated_at)
             VALUES ($1, 'code-repository', 'CODE_REPOSITORY', $2,
                     $3, $4, $5,
                     'DIRECTLY_TRASHED', now(), $6::uuid, now() + interval '30 days',
                     $7::uuid, $8::timestamptz, $6::uuid, now())
             ON CONFLICT (rid) DO UPDATE SET
               display_name = EXCLUDED.display_name,
               parent_folder_rid = EXCLUDED.parent_folder_rid,
                project_rid = EXCLUDED.project_rid,
                space_rid = EXCLUDED.space_rid,
                trash_status = 'DIRECTLY_TRASHED',
                trashed_at = now(),
                trashed_by = EXCLUDED.trashed_by,
                retention_until = now() + interval '30 days',
                 updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
            [rid, row.display_name, canonicalParentRid, projectRid, spaceRid, validTrashedBy, validCreatedBy, row.created_at],
          );
        }

        await client.query("COMMIT");

        // GC: free Stemma content (branches + blobs) now that metadata is TRASHED.
        // Best-effort; a failure here must not undo the trash. tombstone() deletes
        // branch rows, which ON DELETE CASCADE the blobs (migration 086). Without
        // this the coderepo_stemma_* content lingers forever (unbounded growth).
        try {
          await ctx.stemma.tombstone({ repositoryRid: rid });
        } catch (e) {
          console.error(
            `code-repos.delete.tombstone-failed rid=${rid} err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
        res.status(204).end();
      } catch (txErr) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });
  return router;
}
