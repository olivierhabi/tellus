// ---------------------------------------------------------------------------
// Settings router — extracted from admin/routes.ts.
//
//   GET /:rid/settings           — getRepoSettings
//   PUT /:rid/settings           — updateRepoSettings (ETag)
//   GET /:rid/resource-imports   — B4-C-10 current import set
//   PUT /:rid/resource-imports   — B4-C-11 replace-all imports (ETag)
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { insertCodeReposAuditEvent } from "../../../codeRepos/audit/auditEvents";
import {
  computeImportsEtag,
  derivePrincipalSubUuid,
  isUuidV4,
  parseImportsEtag,
  parseVersionEtagOrNull,
  sendError,
  validateImportsBody,
} from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createSettingsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // GET /:rid/settings
  // -------------------------------------------------------------------------
  router.get("/:rid/settings", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const r = await ctx.pool.query(
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
  router.put("/:rid/settings", ctx.auth, async (req, res, next) => {
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

      const r = await ctx.pool.query(
        `UPDATE code_repository
            SET settings_json = $1::jsonb,
                resource_version = resource_version + 1,
                updated_at = now()
          WHERE rid = $2 AND resource_version = $3 AND state IN ('ACTIVE','ARCHIVED')
          RETURNING settings_json, resource_version`,
        [JSON.stringify(body), rid, ifMatchVersion],
      );
      if (r.rowCount === 0) {
        const ex = await ctx.pool.query(
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
  router.get("/:rid/resource-imports", ctx.auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(
          res,
          codeReposError("CodeRepos:RepositoryNotFound", { rid }),
        );
      }
      const repoExists = await ctx.pool.query(
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
      const r = await ctx.pool.query(
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
  router.put("/:rid/resource-imports", ctx.auth, async (req, res, next) => {
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
      const repoRow = await ctx.pool.query(
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

      const client = await ctx.pool.connect();
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

  return router;
}
