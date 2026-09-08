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
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { isRid, isStructurallyRid, mintFunctionVersionRid } from "../../codeRepos/contracts/rid";
import { publishVersion, listVersions } from "../../functionsRegistry/store";
import {
  authorizePublish,
} from "../../functions/executionPolicy";
import {
  FUNCTION_IDENTITY_RE,
  parseFunctionPath,
} from "../../functions/discovery";
import { parseSemver, compareSemver, isPreviewRelease } from "../../functionsRegistry/semver";
import {
  createS3FunctionArtifactStore,
  FunctionArtifactError,
  resolveFunctionSource,
} from "../../functionsRegistry/artifactStore";
import { ERROR_CODES } from "../../codeRepos/contracts/errors";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import { codeReposError, type CodeReposErrorName } from "../errors";
import { inferFunctionObjectType } from "../functionObjectType";
import {
  applyEdits,
  loadOntologySnapshot,
  normalizeOntologyId,
  type OntologyEdit,
  type OntologySnapshot,
} from "../../functions/ontologyRuntime";
import { inspectTypeScriptV2Function } from "../../functionsPublish/service";
import type { FunctionType } from "../../functions/canonicalSignature";
import {
  createTtlCache,
  transpileCacheKey,
} from "./invokeCache";
import { runSandboxedWithSdkAsync } from "../../functionWorkerPool";
import type { SandboxBinding } from "../../functionRuntime";
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
import {
  clearDrafts,
  listDrafts,
  replaceDrafts,
  validateDraftsBody,
} from "../drafts/draftStore";
import {
  ChatSessionLimitExceededError,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
  validateCreateChatSessionBody,
  validateUpdateChatSessionBody,
  type ChatMessageInput,
  type ChatSessionRow,
} from "../chatSessions/chatSessionStore";

import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "../adapters/types";
import { FunctionsPublishError, type FunctionsPublishService } from "../../functionsPublish/service";
import {
  compareSemverLoose,
  computeImportsEtag,
  derivePrincipalSubUuid,
  deriveSignatureFromSource,
  elapsedSeconds,
  isLegalBranchName,
  isUuidV4,
  parseImportsEtag,
  parseShaIfMatch,
  parseVersionEtagOrNull,
  repoToResponse,
  sendError,
  toWireSignature,
  unwrapObjectSetRows,
  validateCommitBody,
  validateCreateBody,
  validateImportsBody,
  type CreateRepoBody,
  type ListingSignature,
  type PatchRepoBody,
  type RepoRow,
} from "./routeHelpers";
import {
  createRouteContext,
  type CodeRepositoryRoutesDeps,
  type CodeRepositoryRouteContext,
} from "./routeContext";
import { createReposRouter } from "./routers/reposRouter";
import { createBranchesRouter } from "./routers/branchesRouter";
import { createTreeRouter } from "./routers/treeRouter";
import { createCommitsRouter } from "./routers/commitsRouter";

export type { CodeRepositoryRoutesDeps };

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
  const routeCtx = createRouteContext(deps);

  // Repository CRUD (POST / GET / GET|PATCH|DELETE /:rid) lives in
  // ./routers/reposRouter.ts; mounted first to preserve the original
  // registration order.
  router.use(createReposRouter(routeCtx));

  // Branch list/create/delete lives in ./routers/branchesRouter.ts; mounted
  // here (where GET /:rid/branches was registered) to preserve order.
  router.use(createBranchesRouter(routeCtx));

  // -------------------------------------------------------------------------
  // Uncommitted drafts (migration 104). Per-user, per-branch, pre-commit
  // file drafts persisted backend-side so they survive across browsers/
  // sessions — but NOT a git commit; the frontend clears them on commit.
  //   GET    /:rid/branches/:branch/drafts  — list the caller's drafts
  //   PUT    /:rid/branches/:branch/drafts  — replace the caller's draft set
  //   DELETE /:rid/branches/:branch/drafts  — clear all (after a commit)
  // Keyed by `principal_sub` (derived UUID) so each user's drafts are private.
  // -------------------------------------------------------------------------
  router.get("/:rid/branches/:branch/drafts", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
      }
      const exists = await pool.query(
        `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const drafts = await listDrafts(pool, { principalSub, repositoryRid: rid, branch });
      res.status(200).json({ drafts });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:rid/branches/:branch/drafts", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
      }
      const exists = await pool.query(
        `SELECT 1 FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
        [rid],
      );
      if (exists.rowCount === 0) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const validation = validateDraftsBody(req.body);
      if (validation.kind === "invalid") {
        return sendError(res, codeReposError(validation.errorName, validation.parameters));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const drafts = await replaceDrafts(pool, {
        principalSub,
        repositoryRid: rid,
        branch,
        drafts: validation.drafts,
      });
      res.status(200).json({ drafts });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:rid/branches/:branch/drafts", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const branch = req.params.branch;
      if (!isLegalBranchName(branch)) {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { rid, branch }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      await clearDrafts(pool, { principalSub, repositoryRid: rid, branch });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Chat sessions (migration 126). Per-user, per-repo persistent chat
  // transcripts for the Code Assistant panel mounted inside the repo browser.
  // Sessions are private to the caller (`principal_sub`) — every query
  // filters on it, so an IDOR attempt to read another user's session by id
  // returns 404 (matches the IDOR-as-404 convention used by /drafts).
  //
  //   GET    /:rid/chat-sessions              — list the caller's sessions
  //                                            (no message bodies).
  //   POST   /:rid/chat-sessions              — create session + initial
  //                                            messages (atomic, Idempotency-Key).
  //   GET    /:rid/chat-sessions/:sessionId   — fetch one session WITH messages.
  //   PUT    /:rid/chat-sessions/:sessionId   — replace metadata and/or the
  //                                            full message set atomically.
  //   DELETE /:rid/chat-sessions/:sessionId   — delete one session (+ messages).
  // -------------------------------------------------------------------------
  router.get("/:rid/chat-sessions", auth, async (req, res, next) => {
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
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const sessions = await listChatSessions(pool, { principalSub, repositoryRid: rid });
      const items: ChatSessionRow[] = sessions;
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/:rid/chat-sessions",
    auth,
    idempotencyMiddleware({ pool }),
    async (req, res, next) => {
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
        const validation = validateCreateChatSessionBody(req.body);
        if (validation.kind === "invalid") {
          return sendError(res, codeReposError(validation.errorName, validation.parameters));
        }
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }
        const principalSub = isUuidV4(principal.userId)
          ? principal.userId
          : derivePrincipalSubUuid(principal.userId);
        // Checksum: pull `Idempotency-Key` from header so a replayed POST returns
        // the same created row (matches the createRepository saga contract).
        const idem = (req.header("Idempotency-Key") ?? "").trim();
        if (!idem) {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "Idempotency-Key" }));
        }

        try {
          const created = await createChatSession(pool, {
            principalSub,
            repositoryRid: rid,
            session: validation.session,
            messages: validation.messages,
          });
          res.status(201).json({
            sessionId: created.sessionId,
            assistantPath: created.assistantPath,
            title: created.title,
            branch: created.branch,
            lastActiveFilePath: created.lastActiveFilePath,
            modelId: created.modelId,
            mode: created.mode,
            messageCount: created.messageCount,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            messages: created.messages,
          });
        } catch (sessErr) {
          if (sessErr instanceof ChatSessionLimitExceededError) {
            return sendError(
              res,
              codeReposError("CodeRepos:ChatSessionLimitExceeded", {
                limit: sessErr.limit,
                repositoryRid: rid,
              }),
            );
          }
          throw sessErr;
        }
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/:rid/chat-sessions/:sessionId", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const session = await getChatSession(pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
      });
      if (!session) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(200).json({
        sessionId: session.sessionId,
        assistantPath: session.assistantPath,
        title: session.title,
        branch: session.branch,
        lastActiveFilePath: session.lastActiveFilePath,
        modelId: session.modelId,
        mode: session.mode,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:rid/chat-sessions/:sessionId", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const validation = validateUpdateChatSessionBody(req.body);
      if (validation.kind === "invalid") {
        return sendError(res, codeReposError(validation.errorName, validation.parameters));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const updated = await updateChatSession(pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
        patch: validation.patch,
        messages: validation.messages,
      });
      if (!updated) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(200).json({
        sessionId: updated.sessionId,
        assistantPath: updated.assistantPath,
        title: updated.title,
        branch: updated.branch,
        lastActiveFilePath: updated.lastActiveFilePath,
        modelId: updated.modelId,
        mode: updated.mode,
        messageCount: updated.messageCount,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        messages: updated.messages,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:rid/chat-sessions/:sessionId", auth, async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const sessionId = req.params.sessionId;
      if (!isUuidV4(sessionId)) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const principalSub = isUuidV4(principal.userId)
        ? principal.userId
        : derivePrincipalSubUuid(principal.userId);
      const deleted = await deleteChatSession(pool, {
        principalSub,
        repositoryRid: rid,
        sessionId,
      });
      if (!deleted) {
        return sendError(res, codeReposError("CodeRepos:ChatSessionNotFound", { sessionId }));
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });





  // Tree/blob reads live in ./routers/treeRouter.ts and commits in
  // ./routers/commitsRouter.ts; mounted here (where the branch-content
  // routes were registered) to preserve order.
  router.use(createTreeRouter(routeCtx));
  router.use(createCommitsRouter(routeCtx));

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

      // Publish authorization gate (execution security boundary): the
      // current executor is worker_threads + vm — NOT an untrusted-code
      // sandbox — so publishing executable Functions requires the publish
      // role, an active function_publish_grants entry, the legacy env
      // allowlist (deprecated), or open-development mode (never honored in
      // production). Every decision is persisted to
      // function_publish_audit_log; an allow whose audit write fails is
      // refused. See functions/executionPolicy.ts and
      // docs/operations/automate-function-invocation-contract.md.
      const publishPrincipal = req.codeReposPrincipal;
      if (!publishPrincipal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      // Read the tag early so the audit record can carry release_tag; full
      // SemVer validation happens below after the authorization check.
      const requestedTag = typeof (req.body as { semver?: unknown })?.semver === "string"
        ? ((req.body as { semver: string }).semver)
        : typeof (req.body as { tag?: unknown })?.tag === "string"
          ? ((req.body as { tag: string }).tag)
          : null;
      const publishDecision = await authorizePublish(pool, {
        localUserId: publishPrincipal.userId,
        keycloakSub: publishPrincipal.keycloakSub,
        roles: publishPrincipal.roles,
        repositoryRid: rid,
        releaseTag: requestedTag,
      });
      if (!publishDecision.allowed) {
        console.warn(
          JSON.stringify({
            type: "functions.publish.authorization_denied",
            repositoryRid: rid,
            userId: publishPrincipal.userId,
            reason: publishDecision.reason,
          }),
        );
        if (publishDecision.auditFailed) {
          return sendError(
            res,
            codeReposError("CodeRepos:Internal", { reason: "publish-audit-unavailable" }),
          );
        }
        return sendError(
          res,
          codeReposError("CodeRepos:PermissionDenied", {
            reason: publishDecision.reason,
          }),
        );
      }

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
      // Preview vs stable: single shared predicate (see
      // functionsRegistry/semver.ts) — non-default branch or a
      // prerelease SemVer is a preview build.
      const isPreview = isPreviewRelease(branch, defaultBranch, semver);

      // TypeScript v2 uses the durable functions-publish pipeline. Keep the
      // legacy synchronous implementation below as a compatibility fallback
      // for standalone route tests that do not inject the worker service.
      if (deps.functionsPublisher) {
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }
        try {
          const run = await deps.functionsPublisher.enqueue({
            repositoryRid: rid,
            branch,
            defaultBranch,
            semver,
            message: typeof b.message === "string" ? b.message.slice(0, 1024) : null,
            triggeredBy: derivePrincipalSubUuid(principal.userId),
            idempotencyKey: (req.header("Idempotency-Key") ?? randomUUID()).trim(),
          });
          res.setHeader("Location", `/api/v1/jemma/runs/${encodeURIComponent(run.runRid)}`);
          return res.status(run.replayed ? 200 : 202).json({
            run,
            status: run.state,
            deduplicated: run.replayed,
          });
        } catch (error) {
          if (error instanceof FunctionsPublishError) {
            if (error.code === "BRANCH_NOT_FOUND") {
              return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
            }
            if (error.code === "NO_FUNCTIONS") {
              return sendError(res, codeReposError("CodeRepos:NoFunctionsToPublish", { branch }));
            }
            if (error.code === "RUN_ALREADY_ACTIVE") {
              return sendError(res, codeReposError("CodeRepos:RunAlreadyActive", {
                branch,
                ...error.details,
              }));
            }
            return sendError(res, codeReposError("CodeRepos:VersionConflict", {
              reason: error.message,
              ...error.details,
            }));
          }
          throw error;
        }
      }

      // 1 + 2 — tree + function discovery.
      const tree = await deps.stemma.listTree({ repositoryRid: rid, branch, path: "", depth: 6 });
      if (tree.kind === "branch-not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
      }
      if (tree.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "tree-read-failed" }));
      }
      const commitSha = tree.treeSha; // content-pinned identifier of the release tree
      const discovered: Array<{ apiName: string; path: string }> = [];
      for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        // Shared identity rules (functions/discovery.ts): nested folders
        // under src/functions/ are first-class; the path is the identity.
        const parsed = parseFunctionPath(entry.path);
        if (parsed !== null && parsed.runtime === "NODE_20") {
          discovered.push({ apiName: parsed.apiName, path: entry.path });
        }
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
      const canonical = JSON.stringify({ exports: exportsList, sources });
      const artifactSha256 = createHash("sha256").update(canonical).digest("hex");
      const artifactBytes = Buffer.byteLength(canonical, "utf8");
      // Track 2 #8: real content-addressed blob — the same
      // store as the worker pipeline. The manifest carries no
      // source text; there is no inline fallback anywhere.
      let artifactBlobId: string;
      try {
        const put = await createS3FunctionArtifactStore().put({
          digest: artifactSha256,
          bundle: canonical,
        });
        artifactBlobId = put.blobId;
      } catch (e) {
        if (e instanceof FunctionArtifactError && e.code === "ARTIFACT_TOO_LARGE") {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { reason: e.message }));
        }
        throw e;
      }
      const manifest = {
        exports: exportsList,
        artifactFormat: "functions-publish-bundle/v1",
        runtime: "NODE_20" as const,
        functionCount: exportsList.length,
        message: typeof b.message === "string" ? b.message.slice(0, 1024) : null,
      };

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
          artifactBlobId,
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
        /** Stable registry RID for deep-links (function_registry_function). */
        functionRid: string | null;
        semver: string | null;
        branch: string;
        isPreview: boolean;
        runtime: string;
        commitSha: string | null;
        publishedAt: string | null;
        source: "published" | "working_tree";
        path: string | null;
        /** Path under `src/functions/` WITH extension (e.g. "orders/calc.ts")
         *  — drives the FE's subdirectory grouping (Foundry parity). */
        relativePath: string | null;
        /** True when the row exists ONLY as an uncommitted draft. */
        draftOnly: boolean;
        /** True when a committed file has an open (uncommitted) draft edit. */
        hasDraft: boolean;
        /** Object-type apiName the function binds to (from `@ontology/sdk`
         *  import / `ObjectSet<X>`), or null for a pure utility. The FE
         *  overlays the ontology display name + icon + colour. */
        objectTypeName: string | null;
        objectTypeIcon: string | null;
        /** Function input signature (null = not derivable) — drives the
         *  Functions tester's signature-driven Form tab. */
        signature: ListingSignature | null;
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
          manifest_json: { exports?: unknown; signatures?: unknown; objectTypes?: unknown };
        }>(
          `SELECT rid, branch, semver, is_preview, runtime, commit_sha, published_at, manifest_json
             FROM function_version
            WHERE repository_rid = $1 AND branch = $2 AND state = 'AVAILABLE'`,
          [rid, branch],
        );

        for (const r of rowsRes.rows) {
          const exportsRaw = r.manifest_json?.exports;
          if (!Array.isArray(exportsRaw)) continue;
          // Ontology bindings stamped at publish time (functionsPublish
          // worker, manifest.objectTypes). Historical manifests predate the
          // field — their rows fall back to live-tree inference below.
          const manifestObjectTypes =
            r.manifest_json && typeof (r.manifest_json as { objectTypes?: unknown }).objectTypes === "object"
              ? ((r.manifest_json as { objectTypes: Record<string, unknown> }).objectTypes)
              : null;
          for (const name of exportsRaw) {
            if (typeof name !== "string" || name.length === 0) continue;
            const prev = byApiName.get(name);
            if (prev === undefined || compareSemverLoose(r.semver, prev.semver ?? "") > 0) {
              const stamped = manifestObjectTypes?.[name];
              byApiName.set(name, {
                apiName: name,
                versionRid: r.rid,
                functionRid: null, // resolved per-export below (registry deep-link)
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
                relativePath: null,
                draftOnly: false,
                hasDraft: false,
                // Publish-time binding from manifest.objectTypes when present;
                // historical manifests fall back to live-tree inference below.
                objectTypeName: typeof stamped === "string" ? stamped : null,
                objectTypeIcon: null,
                // Publish-time canonical signature (manifest.signatures) —
                // historical manifests predating the field fall back to the
                // live-tree derivation stamped below.
                signature: toWireSignature(
                  (r.manifest_json?.signatures as Record<string, unknown> | undefined)?.[name] ?? null,
                ),
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
      // apiName → bound object-type apiName, inferred from each function's
      // source (`@ontology/sdk` import / `ObjectSet<X>`). Used to stamp BOTH
      // the working-tree row and the published row (the FE dedupes
      // published-first, so the published row must carry the type too).
      const objectTypeByApi = new Map<string, string | null>();
      try {
        const tree = await deps.stemma.listTree({
          repositoryRid: rid,
          branch,
          path: "",
          depth: 5,
        });
        if (tree.kind === "ok") {
          for (const entry of tree.entries) {
            if (entry.type !== "blob") continue;
            // Shared identity rules (functions/discovery.ts): nested folders
            // supported — identity is the path under src/functions/ without
            // extension ("orders/calc"); root files keep their basename.
            const parsed = parseFunctionPath(entry.path);
            if (parsed === null) continue;
            const { apiName } = parsed;
            const ext = parsed.relativePath.endsWith(".py") ? "py" : "ts";
            if (wtSeen.has(apiName)) continue; // one working-tree entry per identity
            wtSeen.add(apiName);
            // Infer the bound object type from the source. TS only — Python
            // functions use a different convention and surface null (utility)
            // for now. Per-file try/catch so one unreadable file can't blank
            // detection for the rest.
            let objectTypeName: string | null = null;
            let signature: ListingSignature | null = null;
            if (ext === "ts") {
              try {
                const blob = await deps.stemma.readBlob({
                  repositoryRid: rid,
                  branch,
                  path: entry.path,
                });
                if (blob.kind === "ok") {
                  const src = new TextDecoder("utf-8").decode(blob.content);
                  objectTypeName = inferFunctionObjectType(src);
                  // Same read already pays for the source: derive the input
                  // signature in the same pass (no extra I/O).
                  signature = deriveSignatureFromSource(entry.path, src);
                }
              } catch {
                // Best-effort: a read failure leaves this fn untyped (utility).
              }
            }
            objectTypeByApi.set(apiName, objectTypeName);
            workingTree.push({
              apiName,
              versionRid: null,
              functionRid: null,
              semver: null,
              branch,
              isPreview: true,
              runtime: parsed.runtime,
              commitSha: null,
              publishedAt: null,
              source: "working_tree",
              path: entry.path,
              relativePath: parsed.relativePath,
              draftOnly: false,
              hasDraft: false,
              objectTypeName,
              objectTypeIcon: null, // FE overlays icon/colour from the ontology
              signature,
            });
          }
        }
      } catch {
        // Discovery is best-effort. A Stemma fault must not break the
        // published-versions response.
      }

      // ---- Draft overlay (Foundry live-preview parity) ---------------------
      // Uncommitted editor work must appear in Live Preview BEFORE any
      // commit. Drafts are per-user (principal_sub), read fresh. A draft
      //     * editing a tracked file     → row content re-inferred from DRAFT
      //     * adding a NEW function file → extra row flagged draftOnly
      // File deletions are not drafts — the FE commits deletes immediately.
      const wtByApiName = new Map(workingTree.map((row) => [row.apiName, row]));
      const publishPrincipal = req.codeReposPrincipal;
      if (publishPrincipal) {
        try {
          const principalSub = isUuidV4(publishPrincipal.userId)
            ? publishPrincipal.userId
            : derivePrincipalSubUuid(publishPrincipal.userId);
          const drafts = await listDrafts(pool, { principalSub, repositoryRid: rid, branch });
          for (const draft of drafts) {
            const parsed = parseFunctionPath(draft.path);
            if (parsed === null) continue;
            const existing = wtByApiName.get(parsed.apiName);
            const objectTypeName =
              parsed.runtime === "NODE_20" ? inferFunctionObjectType(draft.content) : null;
            // The signature follows the DRAFT's source (Live Preview reflects
            // the editor, not HEAD) — same derivation pass as tree entries.
            const signature =
              parsed.runtime === "NODE_20"
                ? deriveSignatureFromSource(draft.path, draft.content)
                : null;
            objectTypeByApi.set(parsed.apiName, objectTypeName);
            if (existing) {
              // Draft wins over HEAD: the Live Preview tab reflects the
              // editor, not the last commit.
              existing.objectTypeName = objectTypeName;
              existing.hasDraft = true;
              existing.signature = signature;
            } else {
              const row: MergedFunctionRow = {
                apiName: parsed.apiName,
                versionRid: null,
                functionRid: null,
                semver: null,
                branch,
                isPreview: true,
                runtime: parsed.runtime,
                commitSha: null,
                publishedAt: null,
                source: "working_tree",
                path: draft.path,
                relativePath: parsed.relativePath,
                draftOnly: true,
                hasDraft: true,
                objectTypeName,
                objectTypeIcon: null,
                signature,
              };
              workingTree.push(row);
              wtByApiName.set(parsed.apiName, row);
            }
          }
        } catch {
          // Draft overlay is best-effort — the committed discovery above is
          // authoritative on its own.
        }
      }

      // Stamp the bound object type onto published rows WITHOUT a publish-time
      // `objectTypes` entry (historical manifests) via live-tree inference.
      for (const row of byApiName.values()) {
        if (row.objectTypeName === null && objectTypeByApi.has(row.apiName)) {
          row.objectTypeName = objectTypeByApi.get(row.apiName) ?? null;
        }
        // Historical manifests predating manifest.signatures: derive from the
        // live working-tree source (same apiName convention) when available.
        if (row.signature === null && objectTypeByApi.has(row.apiName)) {
          const wt = workingTree.find((w) => w.apiName === row.apiName);
          if (wt?.signature) row.signature = wt.signature;
        }
      }

      // Resolve registry function RIDs for deep-links (one query for all
      // published exports on this repo; retired rows excluded).
      if (byApiName.size > 0) {
        try {
          const apiNames = [...byApiName.keys()];
          const ridRes = await pool.query<{ rid: string; api_name: string }>(
            `SELECT rid, api_name FROM function_registry_function
              WHERE repository_rid = $1 AND api_name = ANY($2::text[]) AND retired_at IS NULL`,
            [rid, apiNames],
          );
          const ridByApi = new Map(ridRes.rows.map((r) => [r.api_name, r.rid]));
          for (const row of byApiName.values()) {
            row.functionRid = ridByApi.get(row.apiName) ?? null;
          }
        } catch {
          // Deep-link enrichment is optional — never fail the listing for it.
        }
      }

      const data = [...byApiName.values(), ...workingTree].sort((a, b) =>
        a.apiName.localeCompare(b.apiName) || a.source.localeCompare(b.source),
      );
      // The response embeds live working-tree + draft state; it must never
      // be served from a browser/intermediary cache or the IDE's Live
      // Preview would lag file adds/removes.
      res.setHeader("Cache-Control", "no-store");
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
      // Wall-clock origin for performance.phases (all phase times use
      // Date.now() — never performance.now() — because the sandbox runs in a
      // worker thread whose perf-hooks time origin differs).
      const t0 = Date.now();
      const phases: Array<{
        name: string;
        startOffsetMs: number;
        durationMs: number;
        depth?: number;
        calls?: number;
      }> = [];
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
      // Identity can be a plain identifier ("calc") or a directory-qualified
      // path under src/functions/ ("orders/calc") — see functions/discovery.ts.
      if (!apiName || !FUNCTION_IDENTITY_RE.test(apiName) || apiName.length > 256) {
        return sendError(
          res,
          codeReposError("CodeRepos:InvalidArgumentBody", {
            field: "apiName",
            reason: "required; must be a function identity (identifier or nested path under src/functions/)",
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
        // the function's source through resolveFunctionSource: compact
        // bundle manifests read from the artifact store, historical inline
        // manifests (manifest.sources) keep working.
        const versions = await listVersions(deps.pool, rid, { branch, includeYanked: false });
        let chosen: { semver: string; source: string } | null = null;
        // One version whose content-addressed bundle is gone (object store
        // rebuilt while Postgres metadata survived) must not poison invokes —
        // previously any ARTIFACT_NOT_FOUND escaped the loop and 500'd the
        // whole published-invoke path even though a healthy newer version
        // already resolved. Skip per-version, and only when NO version
        // delivers a source do we surface an actionable envelope.
        let artifactFailure: { semver: string; code: string } | null = null;
        for (const v of versions) {
          let src: string | null;
          try {
            src = await resolveFunctionSource(
              { manifest_json: v.manifest as { sources?: Record<string, unknown> } | null, artifact_blob_id: v.artifactBlobId },
              apiName,
            );
          } catch (e) {
            if (e instanceof FunctionArtifactError) {
              console.warn(
                `[functions/invoke] published artifact unavailable for ${apiName} ` +
                  `at ${rid}@${branch}:${v.semver} — skipping version: [${e.code}] ${e.message}`,
              );
              artifactFailure ??= { semver: v.semver, code: e.code };
              continue;
            }
            throw e;
          }
          if (src === null) continue;
          if (chosen === null || compareSemver(parseSemver(v.semver), parseSemver(chosen.semver)) > 0) {
            chosen = { semver: v.semver, source: src };
          }
        }
        if (chosen === null) {
          if (artifactFailure) {
            return sendError(
              res,
              codeReposError("CodeRepos:PublishedArtifactMissing", {
                apiName,
                branch,
                semver: artifactFailure.semver,
                artifactErrorCode: artifactFailure.code,
                reason:
                  `Published artifact for "${apiName}" (${artifactFailure.semver}) ` +
                  `is missing from object storage — try republishing the release.`,
              }),
            );
          }
          return sendError(res, codeReposError("CodeRepos:FunctionNotFound", { apiName, source: "published" }));
        }
        source = chosen.source;
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
        // apiName is the identity (path under src/functions/ without ext),
        // so nested functions resolve to src/functions/<identity>.{ts,py}.
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
      const imports = await deps.pool.query<{ ontology_id: string; api_name: string; kind: string }>(
        `SELECT ontology_id, api_name, kind FROM code_repository_resource_imports
          WHERE repository_rid = $1 AND kind IN ('object_type', 'link_type')`,
        [rid],
      );
      let ontologyId: string | null = null;
      const importedTypes: string[] = [];
      const importedLinkTypes: string[] = [];
      for (const row of imports.rows) {
        const norm = normalizeOntologyId(row.ontology_id);
        if (norm) ontologyId = norm;
        if (row.kind === "link_type") importedLinkTypes.push(row.api_name);
        else importedTypes.push(row.api_name);
      }
      // Snapshot load is the single most expensive step on this path (up to a
      // 200k-row SELECT). Cache it per (ontology, imported types) with a short
      // TTL so the burst of invokes one table render fires reuses one load.
      // The request's abort signal cancels the SELECT if the budget is
      // exceeded, instead of letting it run to completion after we 504.
      const snapshotKey = ontologyId
        ? `${ontologyId}:${[...importedTypes].sort().join(",")}|links:${[...importedLinkTypes].sort().join(",")}`
        : "";
      const snapshotStartAt = Date.now();
      let snapshot: OntologySnapshot | undefined =
        ontologyId ? snapshotCache.get(snapshotKey) : undefined;
      if (ontologyId && !snapshot) {
        let loaded: OntologySnapshot;
        try {
          loaded = await loadOntologySnapshot(deps.pool, {
            ontologyId,
            objectTypes: importedTypes,
            // Foundry parity: only DECLARED link-type imports are traversable.
            // A repo with zero link imports gets no link accessors — link
            // graph work is skipped entirely (zero added load cost).
            linkTypes: importedLinkTypes,
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
      if (ontologyId) {
        // The one real object-loading I/O phase of this pipeline (a cached
        // hit measures ~0 ms — the bar collapses, which is truthful).
        phases.push({
          name: "Load ontology snapshot",
          startOffsetMs: snapshotStartAt - t0,
          durationMs: Date.now() - snapshotStartAt,
        });
      }
      const resolvedSnapshot: OntologySnapshot = snapshot ?? {
        byType: new Map(),
        ontologyId: "",
        objectCount: 0,
        objectTypes: [] as string[],
        // No imports → no declared types → empty descriptor map (a function
        // in a repo that imports nothing has no `@ontology/sdk` types).
        importedTypes: [] as readonly string[],
      };
      // Invocation contract: when the function's annotation-derived signature
      // has ≥2 parameters, bind them POSITIONALLY by name — the tester must
      // match how published functions/Actions invoke (typescript-v2-positional-
      // v2), NOT the legacy "(CLIENT_STUB first) + envelope" heuristic, which
      // produced a throwing client-stub as the FIRST argument for ordinary
      // multi-parameter functions (e.g. `range(start, end)` got `start =
      // stub`, crashing at first property access). 0–1-parameter functions
      // keep the legacy envelope (fn(bag)) — preserving every existing
      // single-envelope caller (Workshop function columns, Live Preview).
      let binding: SandboxBinding | undefined;
      {
        const sig = deriveSignatureFromSource(resolvedPath ?? `${apiName}.ts`, source);
        if (sig !== null && sig.parameters.length >= 2) {
          binding = {
            contract: "typescript-v2-positional-v2",
            parameters: sig.parameters.map((p) => ({
              name: p.name,
              optional: p.optional,
              position: p.position,
              injected: p.typeModel.kind === "client" ? ("client" as const) : undefined,
            })),
          };
        }
      }
      // Execute the sandboxed function OFF the main event loop (a worker
      // pool) so a long-running function cannot starve concurrent request
      // handling (e.g. object-search reads → 504). Falls back to inline
      // sync execution if the pool is unavailable. Edits are collected by
      // the SDK during execution and returned with the result.
      const execStartAt = Date.now();
      const result = await runSandboxedWithSdkAsync(transpiled, input, resolvedSnapshot, binding);
      phases.push({
        name: "Execute function",
        startOffsetMs: execStartAt - t0,
        durationMs: Date.now() - execStartAt,
      });
      // Child phases: the object types the function loaded DURING execution,
      // indented under "Execute function" (Foundry: "Load objects from
      // arguments" bars nested inside the execution window).
      for (const load of result.objectLoads ?? []) {
        phases.push({
          name: `Load objects: ${load.objectType}`,
          startOffsetMs: load.firstStartAt - t0,
          durationMs: load.totalDurationMs,
          depth: 1,
          calls: load.calls,
        });
      }
      // Resource-imports scoping is enforced fail-silently above (only imported
      // object types are loaded into the snapshot, so Objects.search on a
      // non-imported type returns an empty ObjectSet). To turn that silent empty
      // into an actionable UX, diff the types the function actually queried
      // (recorded by the SDK) against the repo's imported object types and
      // surface the difference as a warning field on the response. The FE renders
      // an amber "accessed but not imported" banner with an "Open Resource
      // imports" action. Computed regardless of run status so a function that
      // queried a non-imported type then threw/timeout still surfaces it.
      const importedTypeSet = new Set(importedTypes);
      const unimportedAccessedTypes = (result.requestedTypes ?? []).filter(
        (t) => !importedTypeSet.has(t),
      );
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
      const sideChannelEdits = result.status === "ok" ? (result.edits ?? []) : [];
      const collectedEdits: OntologyEdit[] =
        result.status === "ok" ? (returnedEdits.length > 0 ? returnedEdits : sideChannelEdits) : [];

      // Edits do NOT persist on a plain invoke (Foundry: preview is read-only).
      // The caller opts in via `applyEdits: true`, simulating a function-backed
      // Action committing the batch to the Ontology system-of-record.
      let editsApplied: { created: number; updated: number; deleted: number; linked: number; unlinked: number } | null = null;
      if (result.status === "ok" && collectedEdits.length > 0 && body.applyEdits === true && ontologyId) {
        const editsStartAt = Date.now();
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
        phases.push({
          name: "Apply edits",
          startOffsetMs: editsStartAt - t0,
          durationMs: Date.now() - editsStartAt,
        });
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
              unimportedAccessedTypes,
              performance: { phases },
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
              unimportedAccessedTypes,
              performance: { phases },
            }),
          );
      }

      // Stringify the result so the wire shape is always a string per the
      // FE contract; objects/numbers/booleans are JSON.stringified.
      // A returned ObjectSet must be serialized as its row ARRAY — never as
      // the internal `{"rows":[...]}` representation (Palantir object
      // collections are array/`data`-shaped; the FE renders arrays as result
      // tables). Duck-typed, not instanceof: worker results cross postMessage
      // (structured clone), which strips the ObjectSet prototype. The
      // single-key shape cannot collide with the edit-batch contract (edits
      // are `Object.isArray(output) && every(isEdit)` — a {rows:[...]}
      // wrapper is never an array).
      const outputForWire = unwrapObjectSetRows(result.output);
      const serialized =
        typeof outputForWire === "string"
          ? outputForWire
          : outputForWire === undefined
            ? ""
            : JSON.stringify(outputForWire);

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
            unimportedAccessedTypes,
            performance: { phases },
          }),
        );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

