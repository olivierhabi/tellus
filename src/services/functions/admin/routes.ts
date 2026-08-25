// ---------------------------------------------------------------------------
// Function publish authorization — superadmin grant management API.
//
// Mounted at /api/v1/functions/admin (registered in server.ts BEFORE the
// /api/v1/functions registry mount so the prefix wins).
//
//   POST   /function-publish-grants          create a grant (global | repo scope)
//   DELETE /function-publish-grants/:id      soft-revoke (effective next request)
//   GET    /function-publish-grants          list grants (filters + keyset pagination)
//   GET    /function-publish-audit-log       list audit events (filters + keyset pagination)
//
// Grant MANAGEMENT is role-based (tellus-superadmin) even though publish
// AUTHORIZATION historically was env-based: the superadmin role is the
// platform's existing admin boundary and authorizePublish() remains the
// only enforcement point for publication itself.
// ---------------------------------------------------------------------------

import express, { type Request, type Response, type Router } from "express";
import type { Pool, QueryResultRow } from "pg";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { functionsError, type FunctionsError } from "../../functionsRegistry/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function sendError(res: Response, err: FunctionsError): void {
  res.status(err.status).type("application/json").send(JSON.stringify(err.envelope));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) return null;
  return n;
}

interface KeysetCursor {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): KeysetCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (!isObjectRecord(parsed)) return null;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

/** The platform admin boundary for grant management. */
function requireSuperadmin(req: Request, res: Response): boolean {
  const principal = req.codeReposPrincipal;
  if (
    !principal ||
    !principal.roles.some((role) => role.toLowerCase() === "tellus-superadmin")
  ) {
    sendError(
      res,
      functionsError("Functions:PermissionDenied", { reason: "superadmin-required" }),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Row shapes + serializers
// ---------------------------------------------------------------------------

interface GrantRow extends QueryResultRow {
  readonly id: string;
  readonly subject_type: "local_user" | "keycloak_sub";
  readonly subject_id: string;
  readonly scope_type: "global" | "repository";
  readonly scope_rid: string | null;
  readonly granted_by: string;
  readonly reason: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly total_count?: number;
}

function serializeGrant(row: GrantRow) {
  const now = Date.now();
  const revoked = row.revoked_at !== null;
  const expired =
    !revoked && row.expires_at !== null && Date.parse(row.expires_at) <= now;
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    scopeType: row.scope_type,
    scopeRid: row.scope_rid,
    grantedBy: row.granted_by,
    reason: row.reason,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: revoked ? "revoked" : expired ? "expired" : "active",
  };
}

interface AuditRow extends QueryResultRow {
  readonly id: string;
  readonly event_type: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly keycloak_sub: string | null;
  readonly local_user_id: string | null;
  readonly repository_rid: string | null;
  readonly release_tag: string | null;
  readonly decision_source: string | null;
  readonly grant_id: string | null;
  readonly actor_id: string | null;
  readonly detail: Record<string, unknown>;
  readonly created_at: string;
  readonly total_count?: number;
}

function serializeAudit(row: AuditRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    keycloakSub: row.keycloak_sub,
    localUserId: row.local_user_id,
    repositoryRid: row.repository_rid,
    releaseTag: row.release_tag,
    decisionSource: row.decision_source,
    grantId: row.grant_id,
    actorId: row.actor_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

const AUDIT_EVENT_TYPES = new Set([
  "publish_allowed",
  "publish_denied",
  "grant_created",
  "grant_revoked",
  "grant_expired_denial",
]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface FunctionPublishAdminDeps {
  readonly pool: Pool;
}

export function createFunctionPublishAdminRouter(
  deps: FunctionPublishAdminDeps,
): Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));
  router.use(requireCodeReposAuth());

  const asyncRoute = (
    handler: (req: Request, res: Response) => Promise<void>,
  ) =>
    (req: Request, res: Response, next: (err?: unknown) => void) => {
      void handler(req, res).catch(next);
    };

  // -------------------------------------------------------------------------
  // POST /function-publish-grants — create a grant.
  // -------------------------------------------------------------------------
  router.post(
    "/function-publish-grants",
    asyncRoute(async (req: Request, res: Response) => {
      if (!requireSuperadmin(req, res)) return;
      const principal = req.codeReposPrincipal!;
      const body = isObjectRecord(req.body) ? req.body : {};

      const subjectType = body.subjectType ?? body.subject_type;
      if (subjectType !== "local_user" && subjectType !== "keycloak_sub") {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "subjectType-must-be-local_user-or-keycloak_sub",
          }),
        );
        return;
      }
      const subjectId = asNonEmptyString(body.subjectId ?? body.subject_id, 512);
      if (!subjectId) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", { reason: "subjectId-required" }),
        );
        return;
      }
      const scopeType = body.scopeType ?? body.scope_type;
      if (scopeType !== "global" && scopeType !== "repository") {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "scopeType-must-be-global-or-repository",
          }),
        );
        return;
      }
      let scopeRid: string | null = null;
      if (scopeType === "repository") {
        scopeRid = asNonEmptyString(body.scopeRid ?? body.scope_rid, 512);
        if (!scopeRid) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", {
              reason: "scopeRid-required-for-repository-scope",
            }),
          );
          return;
        }
        const repo = await deps.pool.query(
          `SELECT 1 FROM code_repository WHERE rid = $1`,
          [scopeRid],
        );
        if (repo.rowCount === 0) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", {
              reason: "repository-not-found",
            }),
          );
          return;
        }
      }
      const reason = asNonEmptyString(body.reason, 2000);
      if (!reason) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", { reason: "reason-required" }),
        );
        return;
      }
      let expiresAt: string | null = null;
      const rawExpires = body.expiresAt ?? body.expires_at;
      if (rawExpires !== undefined && rawExpires !== null) {
        const parsed =
          typeof rawExpires === "string" ? Date.parse(rawExpires) : NaN;
        if (Number.isNaN(parsed)) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", {
              reason: "expiresAt-must-be-an-ISO-timestamp",
            }),
          );
          return;
        }
        if (parsed <= Date.now()) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", {
              reason: "expiresAt-must-be-in-the-future",
            }),
          );
          return;
        }
        expiresAt = new Date(parsed).toISOString();
      }

      // Grant + audit row in one transaction: a grant with no audit record
      // must never exist.
      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT 1 FROM function_publish_grants
            WHERE revoked_at IS NULL
              AND subject_type = $1 AND subject_id = $2
              AND scope_type = $3
              AND COALESCE(scope_rid, '') = COALESCE($4, '')`,
          [subjectType, subjectId, scopeType, scopeRid],
        );
        if ((existing.rowCount ?? 0) > 0) {
          await client.query("ROLLBACK");
          sendError(
            res,
            functionsError("Functions:GrantConflict", {
              reason: "active-grant-already-exists",
            }),
          );
          return;
        }
        const inserted = await client.query<GrantRow>(
          `INSERT INTO function_publish_grants
             (subject_type, subject_id, scope_type, scope_rid, granted_by, reason, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [subjectType, subjectId, scopeType, scopeRid, principal.userId, reason, expiresAt],
        );
        const grant = inserted.rows[0]!;
        await client.query(
          `INSERT INTO function_publish_audit_log
             (event_type, subject_type, subject_id, repository_rid, grant_id, actor_id, detail)
           VALUES ('grant_created', $1, $2, $3, $4, $5, $6::jsonb)`,
          [
            subjectType,
            subjectId,
            scopeRid,
            grant.id,
            principal.userId,
            JSON.stringify({
              scopeType,
              expiresAt,
              reason,
              grantedByKeycloakSub: principal.keycloakSub ?? null,
            }),
          ],
        );
        await client.query("COMMIT");
        res.status(201).json({ grant: serializeGrant(grant) });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: string }).code === "23505"
        ) {
          // Lost the race against the partial unique index.
          sendError(
            res,
            functionsError("Functions:GrantConflict", {
              reason: "active-grant-already-exists",
            }),
          );
          return;
        }
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /function-publish-grants/:id — soft revoke (effective next request).
  // -------------------------------------------------------------------------
  router.delete(
    "/function-publish-grants/:id",
    asyncRoute(async (req: Request, res: Response) => {
      if (!requireSuperadmin(req, res)) return;
      const principal = req.codeReposPrincipal!;
      const id = req.params.id;

      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query<GrantRow>(
          `UPDATE function_publish_grants
              SET revoked_at = now(), revoked_by = $2, updated_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING *`,
          [id, principal.userId],
        );
        if (updated.rowCount === 0) {
          await client.query("ROLLBACK");
          sendError(
            res,
            functionsError("Functions:GrantNotFound", { grantId: id }),
          );
          return;
        }
        const grant = updated.rows[0]!;
        await client.query(
          `INSERT INTO function_publish_audit_log
             (event_type, subject_type, subject_id, repository_rid, grant_id, actor_id, detail)
           VALUES ('grant_revoked', $1, $2, $3, $4, $5, $6::jsonb)`,
          [
            grant.subject_type,
            grant.subject_id,
            grant.scope_rid,
            grant.id,
            principal.userId,
            JSON.stringify({ scopeType: grant.scope_type }),
          ],
        );
        await client.query("COMMIT");
        res.status(200).json({ grant: serializeGrant(grant) });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -------------------------------------------------------------------------
  // GET /function-publish-grants — list (filters + keyset pagination).
  // -------------------------------------------------------------------------
  router.get(
    "/function-publish-grants",
    asyncRoute(async (req: Request, res: Response) => {
      if (!requireSuperadmin(req, res)) return;
      const limit = parseLimit(req.query.limit);
      if (limit === null) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: `limit-must-be-1-${MAX_PAGE_SIZE}`,
          }),
        );
        return;
      }
      const subjectId =
        req.query.subject !== undefined
          ? asNonEmptyString(req.query.subject, 512)
          : null;
      const subjectType =
        req.query.subjectType !== undefined ? req.query.subjectType : undefined;
      if (
        subjectType !== undefined &&
        subjectType !== "local_user" &&
        subjectType !== "keycloak_sub"
      ) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "subjectType-must-be-local_user-or-keycloak_sub",
          }),
        );
        return;
      }
      const scope = req.query.scope;
      if (scope !== undefined && scope !== "global" && scope !== "repository") {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "scope-must-be-global-or-repository",
          }),
        );
        return;
      }
      const status = req.query.status ?? "all";
      if (
        status !== "all" &&
        status !== "active" &&
        status !== "expired" &&
        status !== "revoked"
      ) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "status-must-be-active-expired-revoked-or-all",
          }),
        );
        return;
      }
      let cursor: KeysetCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor =
          typeof req.query.cursor === "string"
            ? decodeCursor(req.query.cursor)
            : null;
        if (!cursor) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", { reason: "invalid-cursor" }),
          );
          return;
        }
      }

      const clauses: string[] = [];
      const params: unknown[] = [];
      const addParam = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      if (subjectId) clauses.push(`subject_id = ${addParam(subjectId)}`);
      if (subjectType) clauses.push(`subject_type = ${addParam(subjectType)}`);
      if (scope) clauses.push(`scope_type = ${addParam(scope)}`);
      if (status === "active") {
        clauses.push(
          "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
        );
      } else if (status === "expired") {
        clauses.push(
          "revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()",
        );
      } else if (status === "revoked") {
        clauses.push("revoked_at IS NOT NULL");
      }
      if (cursor) {
        clauses.push(
          `(created_at < ${addParam(cursor.createdAt)} OR (created_at = ${addParam(cursor.createdAt)} AND id > ${addParam(cursor.id)}))`,
        );
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limitParam = addParam(limit + 1);

      const result = await deps.pool.query<GrantRow>(
        `WITH page AS (
           SELECT * FROM function_publish_grants
           ${where}
           ORDER BY created_at DESC, id ASC
           LIMIT ${limitParam}
         ), totals AS (
           SELECT count(*)::int AS total_count FROM page
         )
         SELECT page.*, totals.total_count FROM page, totals`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      res.status(200).json({
        items: pageRows.map(serializeGrant),
        totalCount: Number(rows[0]?.total_count ?? 0),
        nextPageToken:
          hasMore && last
            ? encodeCursor({ createdAt: last.created_at, id: last.id })
            : null,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /function-publish-audit-log — list (filters + keyset pagination).
  // -------------------------------------------------------------------------
  router.get(
    "/function-publish-audit-log",
    asyncRoute(async (req: Request, res: Response) => {
      if (!requireSuperadmin(req, res)) return;
      const limit = parseLimit(req.query.limit);
      if (limit === null) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: `limit-must-be-1-${MAX_PAGE_SIZE}`,
          }),
        );
        return;
      }
      const subjectId =
        req.query.subject !== undefined
          ? asNonEmptyString(req.query.subject, 512)
          : null;
      const repositoryRid =
        req.query.repositoryRid !== undefined
          ? asNonEmptyString(req.query.repositoryRid, 512)
          : null;
      const eventType = req.query.eventType;
      if (
        eventType !== undefined &&
        (typeof eventType !== "string" || !AUDIT_EVENT_TYPES.has(eventType))
      ) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "eventType-must-be-a-known-audit-event",
          }),
        );
        return;
      }
      const from =
        typeof req.query.from === "string" && !Number.isNaN(Date.parse(req.query.from))
          ? req.query.from
          : null;
      const to =
        typeof req.query.to === "string" && !Number.isNaN(Date.parse(req.query.to))
          ? req.query.to
          : null;
      if (
        (req.query.from !== undefined && !from) ||
        (req.query.to !== undefined && !to)
      ) {
        sendError(
          res,
          functionsError("Functions:InvalidArgument", {
            reason: "from-to-must-be-ISO-timestamps",
          }),
        );
        return;
      }
      let cursor: KeysetCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor =
          typeof req.query.cursor === "string"
            ? decodeCursor(req.query.cursor)
            : null;
        if (!cursor) {
          sendError(
            res,
            functionsError("Functions:InvalidArgument", { reason: "invalid-cursor" }),
          );
          return;
        }
      }

      const clauses: string[] = [];
      const params: unknown[] = [];
      const addParam = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      if (subjectId) clauses.push(`subject_id = ${addParam(subjectId)}`);
      if (repositoryRid) {
        clauses.push(`repository_rid = ${addParam(repositoryRid)}`);
      }
      if (eventType) clauses.push(`event_type = ${addParam(eventType)}`);
      if (from) clauses.push(`created_at >= ${addParam(from)}`);
      if (to) clauses.push(`created_at <= ${addParam(to)}`);
      if (cursor) {
        clauses.push(
          `(created_at < ${addParam(cursor.createdAt)} OR (created_at = ${addParam(cursor.createdAt)} AND id > ${addParam(cursor.id)}))`,
        );
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limitParam = addParam(limit + 1);

      const result = await deps.pool.query<AuditRow>(
        `WITH page AS (
           SELECT * FROM function_publish_audit_log
           ${where}
           ORDER BY created_at DESC, id ASC
           LIMIT ${limitParam}
         ), totals AS (
           SELECT count(*)::int AS total_count FROM page
         )
         SELECT page.*, totals.total_count FROM page, totals`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      res.status(200).json({
        items: pageRows.map(serializeAudit),
        totalCount: Number(rows[0]?.total_count ?? 0),
        nextPageToken:
          hasMore && last
            ? encodeCursor({ createdAt: last.created_at, id: last.id })
            : null,
      });
    }),
  );

  return router;
}
