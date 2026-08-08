// B8 — Functions Registry admin routes.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { Pool } from "pg";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal.js";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency.js";
import { isStructurallyRid, mintFunctionVersionRid } from "../../codeRepos/contracts/rid.js";
import { functionsError, type FunctionsError } from "../errors.js";
import { parseRange, parseSemver } from "../semver.js";
import {
  getVersion,
  listVersions,
  publishVersion,
  resolveTarget,
  yankVersion,
} from "../store.js";
import {
  decodeRegistryCursor,
  encodeRegistryCursor,
  isFunctionRegistryRid,
} from "../pagination.js";
import { readCanonicalSignature } from "../../functions/canonicalSignature.js";
import {
  authorizePublish,
  executionPolicy,
} from "../../functions/executionPolicy.js";

/**
 * The canonical signature shape exposed to clients (Automate editors,
 * Workshop, API consumers): uniform per-parameter
 * {name, position, type, typeText, optional, hasDefault} regardless of
 * whether the row was published before or after contractVersion 2.
 */
function canonicalParametersForResponse(signature: unknown): unknown[] {
  const canonical = readCanonicalSignature(signature);
  if (canonical) {
    return canonical.parameters.map((parameter) => ({
      name: parameter.name,
      position: parameter.position,
      type: parameter.typeText,
      typeModel: parameter.type,
      optional: parameter.optional,
      hasDefault: parameter.hasDefault,
    }));
  }
  const legacy = (signature as { parameters?: unknown[] } | null)?.parameters;
  return Array.isArray(legacy) ? legacy : [];
}

export interface FunctionsRouterDeps {
  readonly pool: Pool;
}

function sendError(res: Response, err: FunctionsError): void {
  res.status(err.status).type("application/json").send(JSON.stringify(err.envelope));
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REGISTRY_PAGE_SIZE = 50;
const MAX_REGISTRY_PAGE_SIZE = 100;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface PublishVersionBody {
  readonly branch: string;
  readonly isPreview: boolean;
  readonly semver: string;
  readonly commitSha: string;
  readonly runtime: "NODE_20" | "PY_311";
  readonly artifactBlobId: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly manifest: Record<string, unknown>;
}

function validatePublishBody(body: unknown): { ok: true; body: PublishVersionBody } | { ok: false; err: FunctionsError } {
  if (!isObjectRecord(body)) return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "body-not-object" }) };
  const b = body as Record<string, unknown>;
  if (typeof b.branch !== "string" || b.branch.length === 0 || b.branch.length > 255) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-branch" }) };
  }
  if (typeof b.isPreview !== "boolean") return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-isPreview" }) };
  if (typeof b.semver !== "string") return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-semver" }) };
  try {
    parseSemver(b.semver);
  } catch {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-semver", semver: b.semver }) };
  }
  if (typeof b.commitSha !== "string" || !/^[0-9a-f]{7,64}$/.test(b.commitSha)) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-commit-sha" }) };
  }
  if (b.runtime !== "NODE_20" && b.runtime !== "PY_311") {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-runtime" }) };
  }
  if (typeof b.artifactBlobId !== "string" || b.artifactBlobId.length === 0) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-artifactBlobId" }) };
  }
  if (typeof b.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.artifactSha256)) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-artifactSha256" }) };
  }
  if (typeof b.artifactBytes !== "number" || !Number.isInteger(b.artifactBytes) || b.artifactBytes < 0) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-artifactBytes" }) };
  }
  if (!isObjectRecord(b.manifest)) return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-manifest" }) };
  return {
    ok: true,
    body: {
      branch: b.branch,
      isPreview: b.isPreview,
      semver: b.semver,
      commitSha: b.commitSha,
      runtime: b.runtime,
      artifactBlobId: b.artifactBlobId,
      artifactSha256: b.artifactSha256,
      artifactBytes: b.artifactBytes,
      manifest: b.manifest,
    },
  };
}

export function createFunctionsRouter(deps: FunctionsRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "10mb" }));
  router.use(requireCodeReposAuth());
  router.use(idempotencyMiddleware({ pool: deps.pool }));

  // Paginated, permission-aware registry projection used by Ontology
  // Manager's Functions page. One row is returned per stable function RID;
  // the version fields come from that function's most recently published
  // immutable version. Keyset pagination keeps latency predictable as the
  // registry grows and avoids duplicate/omitted rows under concurrent writes.
  router.get("/functions/registry", asyncRoute(async (req: Request, res: Response) => {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : DEFAULT_REGISTRY_PAGE_SIZE;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_REGISTRY_PAGE_SIZE) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-limit" }));
      return;
    }

    const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (rawQuery.length > 256) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "query-too-long" }));
      return;
    }

    const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const cursor = rawCursor === null ? null : decodeRegistryCursor(rawCursor);
    if (rawCursor !== null && cursor === null) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-cursor" }));
      return;
    }

    const principal = req.codeReposPrincipal;
    if (!principal) {
      sendError(res, functionsError("Functions:Internal", { reason: "missing-principal" }));
      return;
    }
    const isPlatformAdmin = principal.roles.some((role) => role.toLowerCase() === "tellus-superadmin");
    const principalUserId = UUID_RE.test(principal.userId) ? principal.userId : null;
    const searchPattern = rawQuery.length > 0 ? `%${escapeLike(rawQuery)}%` : null;

    const result = await deps.pool.query(
      `WITH registry AS (
         SELECT f.rid,
                f.api_name,
                f.display_name,
                f.source_path,
                f.retired_at,
                r.rid AS repository_rid,
                r.display_name AS repository_name,
                latest.semver,
                latest.branch,
                latest.function_kind,
                latest.created_at AS published_at,
                latest.created_at::text AS published_at_cursor,
                COALESCE(parent_project.id, direct_project.id)::text AS project_id,
                COALESCE(parent_project.name, direct_project.name) AS project_name
           FROM function_registry_function f
           JOIN code_repository r ON r.rid = f.repository_rid
            JOIN LATERAL (
              SELECT v.semver, v.branch, v.created_at, v.function_kind
               FROM function_registry_function_version v
              WHERE v.function_rid = f.rid
              ORDER BY v.created_at DESC, v.semver DESC, v.branch ASC
              LIMIT 1
           ) latest ON TRUE
           LEFT JOIN folders parent_folder
             ON parent_folder.id::text = substring(r.parent_folder_rid FROM '([0-9a-fA-F-]{36})$')
           LEFT JOIN projects parent_project ON parent_project.id = parent_folder.project_id
           LEFT JOIN projects direct_project
             ON direct_project.id::text = substring(r.project_rid FROM '([0-9a-fA-F-]{36})$')
          WHERE r.state IN ('ACTIVE', 'ARCHIVED')
            AND (
              $4::boolean
              OR ($5::text IS NOT NULL AND r.created_by::text = $5)
              OR ($5::text IS NOT NULL AND EXISTS (
                SELECT 1
                  FROM project_members membership
                 WHERE membership.project_id = COALESCE(parent_project.id, direct_project.id)
                   AND membership.user_id::text = $5
              ))
            )
            AND (
              $1::text IS NULL
              OR f.api_name ILIKE $1 ESCAPE '\\'
              OR f.display_name ILIKE $1 ESCAPE '\\'
              OR r.display_name ILIKE $1 ESCAPE '\\'
              OR COALESCE(parent_project.name, direct_project.name, '') ILIKE $1 ESCAPE '\\'
            )
       ), totals AS (
         SELECT count(*)::int AS total_count FROM registry
       )
       SELECT registry.*, totals.total_count
         FROM registry
         CROSS JOIN totals
        WHERE ($2::timestamptz IS NULL
               OR registry.published_at < $2
               OR (registry.published_at = $2 AND registry.rid > $3))
        ORDER BY registry.published_at DESC, registry.rid ASC
        LIMIT $6`,
      [
        searchPattern,
        cursor?.publishedAt ?? null,
        cursor?.rid ?? null,
        isPlatformAdmin,
        principalUserId,
        rawLimit + 1,
      ],
    );

    const hasMore = result.rows.length > rawLimit;
    const pageRows = hasMore ? result.rows.slice(0, rawLimit) : result.rows;
    const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    res.status(200).json({
      items: pageRows.map((row) => ({
        rid: row.rid,
        apiName: row.api_name,
        displayName: row.display_name,
        repositoryRid: row.repository_rid,
        repositoryName: row.repository_name,
        sourcePath: row.source_path,
        version: row.semver,
        branch: row.branch,
        // Declared kind of the LATEST registry version (NULL = never
        // analyzed — the FE treats NULL and 'unknown' as not
        // edit-capable).
        functionKind: row.function_kind ?? null,
        owningProject: row.project_id && row.project_name
          ? { id: row.project_id, displayName: row.project_name }
          : null,
        visibility: row.retired_at === null ? "VISIBLE" : "HIDDEN",
        publishedAt: iso(row.published_at),
      })),
      totalCount: Number(result.rows[0]?.total_count ?? 0),
      nextPageToken: hasMore && lastRow
        ? encodeRegistryCursor({ publishedAt: lastRow.published_at_cursor, rid: lastRow.rid })
        : null,
    });
  }));

  // GET /functions/registry/legacy/versions — every AVAILABLE immutable
  // version still published under the deprecated legacy-object-envelope-v1
  // invocation contract. THE operational inventory for the contract
  // migration burndown (republish targets). Superadmin only.
  // Registered BEFORE /functions/registry/:functionRid on purpose.
  router.get("/functions/registry/legacy/versions", asyncRoute(async (req: Request, res: Response) => {
    const principal = req.codeReposPrincipal;
    if (!principal) {
      sendError(res, functionsError("Functions:Internal", { reason: "missing-principal" }));
      return;
    }
    if (!principal.roles.some((role) => role.toLowerCase() === "tellus-superadmin")) {
      sendError(res, functionsError("Functions:PermissionDenied", { reason: "superadmin-required" }));
      return;
    }
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-limit" }));
      return;
    }
    const result = await deps.pool.query(
      `SELECT v.function_rid, f.repository_rid, f.api_name, v.branch, v.semver,
              v.artifact_sha256, v.signature_hash, v.created_at,
              release.state AS release_state
         FROM function_registry_function_version v
         JOIN function_registry_function f ON f.rid = v.function_rid
         JOIN function_version release ON release.rid = v.release_version_rid
        WHERE v.invocation_contract = 'legacy-object-envelope-v1'
        ORDER BY v.created_at DESC
        LIMIT $1`,
      [rawLimit],
    );
    res.status(200).json({
      invocationContract: "legacy-object-envelope-v1",
      count: result.rowCount,
      versions: result.rows.map((row: {
        function_rid: string; repository_rid: string; api_name: string;
        branch: string; semver: string; artifact_sha256: string;
        signature_hash: string | null; created_at: Date | string;
        release_state: string;
      }) => ({
        functionRid: row.function_rid,
        repositoryRid: row.repository_rid,
        apiName: row.api_name,
        branch: row.branch,
        semver: row.semver,
        releaseState: row.release_state,
        artifactSha256: row.artifact_sha256,
        signatureHash: row.signature_hash,
        publishedAt: iso(row.created_at),
      })),
    });
  }));

  // GET /functions/registry/legacy/status — contract migration burndown:
  // version counts by contract, automations whose saved draft pins a legacy
  // version, legacy execution counts over the trailing window, and the
  // operator policy (kill switch + deprecation date). Superadmin only.
  router.get("/functions/registry/legacy/status", asyncRoute(async (req: Request, res: Response) => {
    const principal = req.codeReposPrincipal;
    if (!principal) {
      sendError(res, functionsError("Functions:Internal", { reason: "missing-principal" }));
      return;
    }
    if (!principal.roles.some((role) => role.toLowerCase() === "tellus-superadmin")) {
      sendError(res, functionsError("Functions:PermissionDenied", { reason: "superadmin-required" }));
      return;
    }
    const [versionCounts, pinnedAutomations, recentExecutions] = await Promise.all([
      deps.pool.query(
        `SELECT invocation_contract, count(*)::int AS versions,
                count(DISTINCT function_rid)::int AS functions
           FROM function_registry_function_version
          GROUP BY invocation_contract
          ORDER BY invocation_contract`,
      ),
      // Saved automation drafts (primary Function effects) that pin a
      // legacy-contract version. fallbackEffect references are excluded by
      // design — a fallback that never saved a legacy pin stays invisible
      // until the primary is migrated.
      deps.pool.query(
        `SELECT count(DISTINCT av.automation_id)::int AS automations
           FROM automation_version av
          CROSS JOIN LATERAL jsonb_array_elements(av.definition #> '{effects}') e
          WHERE e ->> 'type' = 'function'
            AND EXISTS (
              SELECT 1
                FROM function_registry_function_version fv
               WHERE fv.function_rid = e ->> 'functionRid'
                 AND fv.branch = e ->> 'branch'
                 AND fv.semver = e ->> 'version'
                 AND fv.invocation_contract = 'legacy-object-envelope-v1'
            )`,
      ),
      deps.pool.query(
        `SELECT invocation_contract, status, count(*)::int AS executions
           FROM automation_effect_execution
          WHERE invocation_contract IS NOT NULL
            AND created_at >= now() - make_interval(days => 30)
          GROUP BY invocation_contract, status
          ORDER BY invocation_contract, status`,
      ),
    ]);
    const policy = executionPolicy();
    res.status(200).json({
      versions: versionCounts.rows,
      automationsPinningLegacyVersions: pinnedAutomations.rows[0]?.automations ?? 0,
      executionsLast30Days: recentExecutions.rows,
      policy: {
        legacyContractDisabled: policy.legacyContractDisabled,
        legacyDeprecationDate: policy.legacyDeprecationDate,
        trustMode: policy.trustMode,
      },
      migrationGuide:
        "Edit the function source (declare real parameters, drop the single-envelope parameter), republish via POST /api/code-repos/:rid/tags, then re-pin or auto-upgrade the automation. Never edit published artifacts in place.",
    });
  }));

  // Stable per-function resource. TypeScript v2 publication assigns one RID
  // per source path; `version` selects immutable signature/artifact metadata.
  router.get("/functions/registry/:functionRid", asyncRoute(async (req: Request, res: Response) => {
    const { functionRid } = req.params;
    if (!isFunctionRegistryRid(functionRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-function-rid" }));
      return;
    }
    const version = typeof req.query.version === "string" ? req.query.version : null;
    const branch = typeof req.query.branch === "string" ? req.query.branch : null;
    const result = await deps.pool.query(
      `SELECT f.rid, f.repository_rid, f.api_name, f.display_name, f.source_path,
              v.semver, v.branch, v.release_version_rid, v.commit_sha,
              v.artifact_sha256, v.signature, v.function_kind,
              v.invocation_contract, v.created_at
         FROM function_registry_function f
         JOIN function_registry_function_version v ON v.function_rid = f.rid
        WHERE f.rid = $1
          AND ($2::text IS NULL OR v.semver = $2)
          AND ($3::text IS NULL OR v.branch = $3)
        ORDER BY string_to_array(split_part(v.semver, '-', 1), '.')::int[] DESC,
                 v.created_at DESC
        LIMIT 1`,
      [functionRid, version, branch],
    );
    if (!result.rowCount) {
      sendError(res, functionsError("Functions:VersionNotFound", { functionRid, version }));
      return;
    }
        const row = result.rows[0];
    res.status(200).json({
      rid: row.rid,
      repositoryRid: row.repository_rid,
      apiName: row.api_name,
      displayName: row.display_name,
      sourcePath: row.source_path,
      version: row.semver,
      branch: row.branch,
      releaseVersionRid: row.release_version_rid,
      commitSha: row.commit_sha,
      artifactSha256: row.artifact_sha256,
      parameters: canonicalParametersForResponse(row.signature),
      output: row.signature?.output ?? null,
      functionKind: row.function_kind ?? null,
      invocationContract: row.invocation_contract ?? "legacy-object-envelope-v1",
      publishedAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    });
  }));

  router.get("/functions/registry/:functionRid/versions", asyncRoute(async (req: Request, res: Response) => {
    const { functionRid } = req.params;
    if (!isFunctionRegistryRid(functionRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-function-rid" }));
      return;
    }
    const principal = req.codeReposPrincipal;
    if (!principal) {
      sendError(res, functionsError("Functions:Internal", { reason: "missing-principal" }));
      return;
    }
    const isPlatformAdmin = principal.roles.some(
      (role) => role.toLowerCase() === "tellus-superadmin",
    );
    const principalUserId = UUID_RE.test(principal.userId) ? principal.userId : null;
    const result = await deps.pool.query(
      `SELECT function.rid, function.repository_rid, function.api_name,
              function.display_name, version.semver, version.branch,
              version.release_version_rid, version.commit_sha,
              version.artifact_sha256, version.signature,
              version.function_kind, version.invocation_contract,
              version.created_at
         FROM function_registry_function function
         JOIN function_registry_function_version version
           ON version.function_rid = function.rid
         JOIN code_repository repository
           ON repository.rid = function.repository_rid
         LEFT JOIN folders parent_folder
           ON parent_folder.id::text =
              substring(repository.parent_folder_rid FROM '([0-9a-fA-F-]{36})$')
         LEFT JOIN projects parent_project
           ON parent_project.id = parent_folder.project_id
         LEFT JOIN projects direct_project
           ON direct_project.id::text =
              substring(repository.project_rid FROM '([0-9a-fA-F-]{36})$')
        WHERE function.rid = $1
          AND repository.state IN ('ACTIVE', 'ARCHIVED')
          AND (
            $2::boolean
            OR ($3::text IS NOT NULL AND repository.created_by::text = $3)
            OR ($3::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM project_members membership
               WHERE membership.project_id =
                     COALESCE(parent_project.id, direct_project.id)
                 AND membership.user_id::text = $3
            ))
          )
        ORDER BY string_to_array(split_part(version.semver, '-', 1), '.')::int[] DESC,
                 version.created_at DESC
        LIMIT 100`,
      [functionRid, isPlatformAdmin, principalUserId],
    );
    if (!result.rowCount) {
      sendError(res, functionsError("Functions:VersionNotFound", { functionRid }));
      return;
    }
    res.status(200).json({
      items: result.rows.map((row) => ({
        rid: row.rid,
        repositoryRid: row.repository_rid,
        apiName: row.api_name,
        displayName: row.display_name,
        version: row.semver,
        branch: row.branch,
        releaseVersionRid: row.release_version_rid,
        commitSha: row.commit_sha,
        artifactSha256: row.artifact_sha256,
        parameters: canonicalParametersForResponse(row.signature),
        output: row.signature?.output ?? null,
        functionKind: row.function_kind ?? null,
        invocationContract:
          row.invocation_contract ?? "legacy-object-envelope-v1",
        publishedAt: iso(row.created_at),
      })),
    });
  }));

  router.post("/functions/:repositoryRid/versions", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    // Publish authorization gate (execution security boundary): executable
    // artifacts are accepted only from authorized authors while the executor
    // is not an untrusted-code sandbox. Every decision is persisted to
    // function_publish_audit_log; an allow whose audit write fails is
    // refused. See functions/executionPolicy.ts.
    {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        sendError(
          res,
          functionsError("Functions:Unauthenticated", { reason: "principal-not-bound" }),
        );
        return;
      }
      const decision = await authorizePublish(deps.pool, {
        localUserId: principal.userId,
        keycloakSub: principal.keycloakSub,
        roles: principal.roles,
        repositoryRid,
        releaseTag:
          typeof (req.body as { semver?: unknown })?.semver === "string"
            ? (req.body as { semver: string }).semver
            : null,
      });
      if (!decision.allowed) {
        console.warn(
          JSON.stringify({
            type: "functions.publish.authorization_denied",
            repositoryRid,
            userId: principal.userId,
            reason: decision.reason,
          }),
        );
        if (decision.auditFailed) {
          sendError(
            res,
            functionsError("Functions:Internal", { reason: "publish-audit-unavailable" }),
          );
          return;
        }
        sendError(
          res,
          functionsError("Functions:PermissionDenied", { reason: decision.reason }),
        );
        return;
      }
    }
    const v = validatePublishBody(req.body);
    if (!v.ok) {
      sendError(res, v.err);
      return;
    }
    try {
      const result = await publishVersion(deps.pool, {
        rid: mintFunctionVersionRid(),
        repositoryRid,
        branch: v.body.branch,
        isPreview: v.body.isPreview,
        semver: v.body.semver,
        commitSha: v.body.commitSha,
        runtime: v.body.runtime,
        artifactBlobId: v.body.artifactBlobId,
        artifactSha256: v.body.artifactSha256,
        artifactBytes: v.body.artifactBytes,
        manifest: v.body.manifest,
      });
      if (result.outcome === "immutable-conflict") {
        sendError(res, functionsError("Functions:VersionImmutable", {
          reason: "artifact-sha-mismatch",
          existingArtifactSha256: result.existingArtifactSha256,
        }));
        return;
      }
      const status = result.outcome === "inserted" ? 201 : 200;
      res.status(status).json(result.row);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505") {
        // Race lost in the same transactional boundary; treat as dedup failure.
        sendError(res, functionsError("Functions:VersionImmutable", { reason: "concurrent-publish" }));
        return;
      }
      if (code === "40001") {
        sendError(res, functionsError("Functions:Internal", { reason: "serialization-conflict-retry-required" }));
        return;
      }
      sendError(res, functionsError("Functions:Internal", { message: (e as Error)?.message ?? "unknown" }));
    }
  });

  router.get("/functions/:repositoryRid/versions", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const includeYanked = req.query.includeYanked === "true";
    const rows = await listVersions(deps.pool, repositoryRid, { branch, includeYanked });
    res.status(200).json({ versions: rows });
  });

  router.get("/functions/:repositoryRid/versions/:semver", async (req: Request, res: Response) => {
    const { repositoryRid, semver } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const row = await getVersion(deps.pool, repositoryRid, semver, branch);
    if (row === null) {
      sendError(res, functionsError("Functions:VersionNotFound", { repositoryRid, semver }));
      return;
    }
    res.status(200).json(row);
  });

  router.get("/functions/:repositoryRid/resolve", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const versionTarget = typeof req.query.versionTarget === "string" ? req.query.versionTarget : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : "main";
    const defaultBranch = typeof req.query.defaultBranch === "string" ? req.query.defaultBranch : "main";
    if (versionTarget === undefined) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "missing-versionTarget" }));
      return;
    }
    let range;
    try {
      range = parseRange(versionTarget);
    } catch {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-versionTarget", versionTarget }));
      return;
    }
    const winner = await resolveTarget(deps.pool, {
      repositoryRid,
      versionRange: range,
      requestedBranch: branch,
      defaultBranch,
    });
    if (winner === null) {
      sendError(res, functionsError("Functions:VersionTargetUnsatisfied", { versionTarget, branch, defaultBranch }));
      return;
    }
    res.status(200).json(winner);
  });

  router.post("/functions/:repositoryRid/versions/:semver/yank", async (req: Request, res: Response) => {
    const { repositoryRid, semver } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const row = await getVersion(deps.pool, repositoryRid, semver, branch);
    if (row === null) {
      sendError(res, functionsError("Functions:VersionNotFound", { repositoryRid, semver }));
      return;
    }
    if (row.state === "YANKED") {
      // Idempotent yank: no change.
      res.status(200).json(row);
      return;
    }
    const updated = await yankVersion(deps.pool, row.rid);
    res.status(200).json(updated);
  });

  return router;
}
