import "dotenv/config";
// PB-B9: bootstrap OTel BEFORE any instrumented library (pg, express,
// @temporalio/client, kafkajs) so auto-instrumentations patch the
// module graph on first require.
import "./services/otelBootstrap";
import crypto from "crypto";
import http from "http";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pool, query } from "./db";
import {
  enforceMigrationGate,
  MigrationDriftError,
} from "./db/migrationGate";
import requestLogger from "./middleware/requestLogger";
import { inputSanitizer } from "./middleware/inputSanitizer";
import { notFoundHandler } from "./middleware/notFoundHandler";
import errorHandler from "./middleware/errorHandler";
import ontologyRouter from "./routes/ontology";
import objectTypeRouter from "./routes/objectTypes";
import propertyRouter from "./routes/properties";
import branchesRouter from "./routes/branches";
import groupsRouter from "./routes/groups";
import functionsRouter from "./routes/functions";
import favoritesRouter from "./routes/favorites";
import explorationsRouter from "./routes/explorations";
import exportsRouter from "./routes/exports";
import summaryRouter from "./routes/summary";
import geoRouter from "./routes/geo";
import comparisonsRouter from "./routes/comparisons";
import migrationManagerRouter from "./routes/migrationManager";
import governanceRouter from "./routes/governance";
import { securityContext } from "./middleware/securityContext";
import { resolveOntologyAlias } from "./middleware/resolveOntologyAlias";
import datasourceRouter, { suggestMappingRouter } from "./routes/datasources";
import indexingRouter from "./routes/indexing";
import objectDataStoreRouter from "./routes/objectDataStore";
import linkRouter from "./routes/links";
import actionTypeRouter from "./routes/actionTypes";
import actionsRouter, { validateRouter, batchRouter } from "./routes/actions";
import { actionAuditRouter, globalAuditRouter } from "./routes/auditLog";
import objectsRouter from "./routes/objects";
import healthRouter from "./routes/health";
import editsRouter from "./routes/edits";
import reindexStatusRouter from "./routes/reindexStatus";
import dataPreviewRouter from "./routes/dataPreview";
import datasetRouter from "./routes/datasets";
import reindexRouter from "./routes/reindex";
import {
  resolveObjectTypeIdToApiName,
  saveToOntology,
} from "./routes/reindexById";
import interfaceRouter from "./routes/interfaces";
import objectTypeInterfacesRouter from "./routes/objectTypeInterfaces";
import objectViewsRouter, { objectViewsByTypeRouter } from "./routes/objectViews";
import { ensureIndexTemplate } from "./services/opensearch/templateRegistry";

// Modern Palantir-stack additions: DuckDB SQL, Polars charts, Kafka producer,
// pipeline status. Each module is documented inline.
import sqlRouter from "./routes/sql";
import chartsRouter from "./routes/charts";
import pipelinesStatusRouter from "./routes/pipelines-status";
import { shutdownKafka } from "./services/kafkaProducer";

// Object Data Funnel — tasks B1-B10. HTTP control plane + background
// workers (signal dispatcher + overlay sweeper).
import funnelRouter from "./routes/funnel";
import { startFunnelDispatcher, stopFunnelDispatcher } from "./services/funnel/funnelDispatcher";
import {
  startPipelineDispatcher,
  stopPipelineDispatcher,
  sweepOrphanPipelineDeployments,
} from "./services/pipelines/pipelineDispatcher";
import {
  startIcebergMaintenance,
  stopIcebergMaintenance,
} from "./services/pipelines/icebergMaintenance";
import { startOverlaySweeper, stopOverlaySweeper } from "./services/overlay/sweeper";
import { ensureLinkTablesForAllLinkTypes } from "./services/funnel/clickhouseBootstrap";

// Background boot tasks (Lakekeeper, ClickHouse, superadmin seed, …) are
// fire-and-forget so they don't delay serving /health. shutdown() races
// them against a short timeout before calling pool.end() so a nodemon
// SIGINT during the first few hundred ms of boot doesn't leave an
// in-flight query hitting a closed pool.
const bootTasks: Promise<unknown>[] = [];
function trackBootTask(factory: () => Promise<unknown>): void {
  const p = factory().catch(() => undefined);
  bootTasks.push(p);
}
async function awaitBootTasksWithDeadline(timeoutMs: number): Promise<void> {
  if (bootTasks.length === 0) return;
  await Promise.race([
    Promise.allSettled(bootTasks),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
import { startTemporalWorker, stopTemporalWorker, isTemporalConnected } from "./services/funnel/temporal/worker";
import { bootstrapLakekeeper } from "./services/funnel/lakekeeperBootstrap";
import { ensurePipelineWarehouse } from "./services/pipelines/lakekeeperBootstrap";
import { startReplacementScheduler, stopReplacementScheduler } from "./services/funnel/replacementScheduler";

// Foundry data ingestion layer routes (BE-003 through BE-030)
import foundryProjectsRouter from "./routes/projects";
import foundryFoldersRouter from "./routes/folders";
import foundryUploadsRouter from "./routes/uploads";
import foundryProjectUploadsRouter from "./routes/projectUploads";
import { folderDatasetsRouter as foundryFolderDatasetsRouter, datasetRouter as foundryDatasetRouter } from "./routes/foundryDatasets";
import foundrySearchRouter from "./routes/search";
import foundryBreadcrumbRouter from "./routes/breadcrumb";
import tellusAuthV1Router from "./routes/tellusAuthV1";
import tellusAuthTestHooksRouter from "./routes/tellusAuthTestHooks";
import { purgeExpiredAuthChallenges } from "./services/totpService";
import { purgeExpiredReauthTokens } from "./services/reauthService";
import { flushEmailOutbox } from "./services/emailOutboxService";
import { getPasskeyEnrollmentService } from "./services/passkeyEnrollmentService";
import { patSecurityGate } from "./middleware/patSecurityGate";
import { globalAuth } from "./middleware/globalAuth";
import foundryMembersRouter from "./routes/members";
import foundryColumnStatsRouter from "./routes/columnStats";
import foundryVersionsRouter from "./routes/versions";
import { projectDuplicatesRouter, datasetDeduplicateRouter } from "./routes/duplicates";
import foundryPipelinesRouter from "./routes/pipelines";
import { devRouter } from "./routes/devTools";
import { healthDetailedRouter } from "./routes/healthDetailed";
import { initWebSocketServer, getWss } from "./websocket/server";
import { setupSwagger as setupFoundrySwagger } from "./docs/openapi";
import { cleanupExpiredKeys } from "./actions/idempotency";
import { limiter } from "./middleware/rateLimiter";
import { serverTiming } from './middleware/serverTiming';
import { contentLanguage } from './middleware/contentLanguage';
import foundryDb from "./config/foundryDb";
import { ensureBucket, destroyStorageClient, storageHealthCheck } from "./services/storageService";

// ---------------------------------------------------------------------------
// Config validation — fail fast if required env vars are missing
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(
      `FATAL: Required environment variable ${key} is not set. ` +
        "See .env.example for the full list."
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------
const app = express();

// Security headers (helmet defaults are sensible for APIs)
app.use(helmet());
// PB-B9 — trace context + X-Trace-Id response header. Must sit before
// any handler that might respond (including the helmet chain's early
// writes) so a user-facing error response ALWAYS carries the trace id
// the support ticket can attach.
import { traceContextMiddleware } from "./middleware/traceContext";
app.use(traceContextMiddleware);
app.use(serverTiming);
app.use(contentLanguage);

// Compress responses (gzip/brotli)
app.use(compression());

// Rate limiting — configurable requests per minute per IP.
//
// `/health`, `/api/v1/health`, and `/api/metrics` are intentionally exempted
// because Kubernetes liveness probes and Prometheus scrapers hit them on a
// fixed schedule that would otherwise burn the entire request budget. The
// production rule is: **observability must never throttle**.
//
// We also normalize the limit-exceeded response to the same
// `{ error: { code, message } }` envelope every other route uses, so
// monitoring and the frontend toaster can treat 429 like any other error.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "200", 10);
const RATE_LIMIT_SKIP = new Set<string>([
  "/health",
  "/api/v1/health",
  "/api/metrics",
]);
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req: Request) => RATE_LIMIT_SKIP.has(req.path),
    handler: (_req: Request, res: Response) => {
      // F-17: Include Retry-After header per RFC 6585 §4.
      res.set("Retry-After", "60");
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests, please try again later.",
          retryAfterSeconds: 60,
        },
      });
    },
  })
);

// Parse JSON request bodies. The 10 MB limit is needed because some API
// requests (like registering a backing datasource with a very large column
// mapping) can have substantial JSON bodies.
app.use(express.json({ limit: "10mb" }));

// Body-parser error catcher. Without this, Express maps `entity.too.large`
// and `entity.parse.failed` errors to a generic 500, which violates the
// "never return 5xx for client mistakes" rule the SRE audit checks. We
// translate them to the unified spec envelope (matching the rest of the
// auth surface + the global errorHandler) and keep a legacy shim on
// .error for backwards compatibility with older clients.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();
  const requestId = (req as any).requestId || crypto.randomUUID();
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({
      errorCode: "PAYLOAD_TOO_LARGE",
      errorName: "ValidationError",
      message: `Request body exceeds the ${err.limit ?? "10mb"} limit`,
      statusCode: 413,
      requestId,
      error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${err.limit ?? "10mb"} limit` },
    });
  }
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({
      errorCode: "VALIDATION_ERROR",
      errorName: "ValidationError",
      message: "Request body is not valid JSON",
      statusCode: 400,
      requestId,
      error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON" },
    });
  }
  return next(err);
});

// CORS — restrict origins via CORS_ORIGINS env var; empty = allow all (dev)
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : undefined; // undefined = allow all origins

app.use(
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "If-Match",
      "If-None-Match",
      "X-Request-ID",
      "X-Tellus-Test-Principal",
      "X-Tellus-Test-Role",
      "X-Tellus-Test-Roles",
    ],
    exposedHeaders: [
      "X-Idempotency-Cached",
      "X-Idempotent-Replay",
      "X-Total-Count",
      "Server-Timing",
      "Retry-After",
      "Content-Language",
      "X-Request-ID",
      "ETag",
    ],
  })
);

// Lightweight cookie parser — populates req.cookies for the Tellus auth
// middleware without pulling in an extra dependency. Keeps values URI-
// decoded and handles multiple cookies in one header.
app.use((req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (header) {
    for (const pair of header.split(/; */)) {
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  (req as Request & { cookies: Record<string, string> }).cookies = out;
  next();
});

// Input sanitization — trim, strip null bytes, normalize Unicode, XSS prevention
app.use(inputSanitizer);

// F-P4-08 / Block F — per-request wall-clock budget. Attaches
// `req.timeoutSignal: AbortSignal` and arms a 504 on expiry. Must be
// mounted AFTER JSON parsing (so body upload is complete before the
// budget starts being spent on handler work) and BEFORE the auth /
// data-plane routes (so a wedged Keycloak or PG still surfaces as
// 504 instead of hanging the connection). /health, /ready, /metrics,
// and /openapi.json are exempted inside the middleware itself.
import { requestTimeoutMiddleware } from "./middleware/requestTimeout";
app.use(requestTimeoutMiddleware());
{
  const stack = (app as unknown as { _router?: { stack: Array<{ handle?: unknown; name?: string }> } })._router?.stack || [];
  const mounted = stack.some((layer) => layer.name === "requestTimeoutMw");
  if (!mounted) {
    // eslint-disable-next-line no-console
    console.error("[boot] FATAL: requestTimeoutMiddleware is not mounted — data-plane requests would have no wall-clock budget");
    throw new Error("requestTimeoutMiddleware is not registered on the Express app");
  }
}

// App-wide PAT security gate. MUST be registered before every route
// handler in the middleware chain — Express only runs middleware
// whose use() call comes BEFORE the matching route mount. Without
// this gate the pre-existing ontology / dataset / project routes
// (which never used `authenticate`) would happily serve any Bearer
// tellus_pat_* token because nothing was looking at it. The gate:
//   1. Resolves the PAT via TellusAuthService.resolvePat()
//   2. Populates req.tellusPrincipal with the token's scopes
//   3. Enforces the route→scope map in services/patScopeMap.ts
// Interactive JWT / cookie sessions are untouched — only PAT-prefixed
// Bearer headers trigger the gate.
app.use("/api", patSecurityGate);

// Boot-time assertion: a future refactor must not be able to silently
// drop the app-wide PAT scope gate. If the middleware is no longer
// registered on the express router stack, fail loudly on startup rather
// than quietly serving every Bearer tellus_pat_* token with no scope
// check. The per-route inline gate that used to live in
// middleware/tellusAuth.ts was removed (it was redundant with this
// mount), so this assertion is now the sole structural guarantee.
{
  const stack = (app as unknown as { _router?: { stack: Array<{ handle?: unknown; name?: string }> } })._router?.stack || [];
  const mounted = stack.some((layer) => layer.handle === patSecurityGate || layer.name === "patSecurityGate");
  if (!mounted) {
    // eslint-disable-next-line no-console
    console.error("[boot] FATAL: patSecurityGate is not mounted — PAT scope enforcement would be disabled");
    throw new Error("patSecurityGate middleware is not registered on the Express app");
  }
}

// Structured JSON request/response logging
app.use(requestLogger);

// F-01 FIX — global authentication gate.
//
// Mounted BEFORE securityContext (so the extracted JWT claims populate
// req.auth / req.user and the downstream security filter is non-empty)
// and AFTER patSecurityGate (so PAT-bearing requests short-circuit the
// JWT verification path). Allowlist for /health, /metrics, /api/v1/auth/*,
// /api/docs, /api/v1/dev/*, /api/v1/_test/* with justifications in
// middleware/globalAuth.ts.
//
// This is the single enforcement point that makes the other 60 route
// files authenticated-by-default. The boot assertion immediately below
// refuses to start the server if the middleware is not on the stack.
app.use(globalAuth());
{
  const stack = (app as unknown as { _router?: { stack: Array<{ handle?: unknown; name?: string }> } })._router?.stack || [];
  const mounted = stack.some((layer) => layer.name === "globalAuthMiddleware");
  if (!mounted) {
    // eslint-disable-next-line no-console
    console.error("[boot] FATAL: globalAuth middleware is not mounted — data-plane routes would be unauthenticated (F-01 regression)");
    throw new Error("globalAuth middleware is not registered on the Express app");
  }
}

// Populate req.security with marking/org/cbac claims so every downstream
// search handler can inject a mandatory filter (Ontology Platform spec §Task 28).
app.use(securityContext);

// Increment Prometheus counters on every request. Must be registered
// BEFORE the route handlers so it sees every inbound HTTP call.
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next();
});

// ---------------------------------------------------------------------------
// In-flight request tracking + shutdown rejection (Task 21)
// ---------------------------------------------------------------------------
let activeRequests = 0;
let isShuttingDown = false;

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader("Connection", "close");
    return res.status(503).json({
      error: { code: "SERVICE_UNAVAILABLE", message: "Server is shutting down" },
    });
  }
  activeRequests++;
  res.on("finish", () => { activeRequests--; });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Detailed health check (must be before the foundry /health route)
app.use("/health", healthDetailedRouter);

// PB-B9 — readiness probe (PG + S3 + Temporal + Lakekeeper).
import healthReadyRouter from "./routes/healthReady";
app.use("/health", healthReadyRouter);

/**
 * GET /health
 *
 * Executes `SELECT NOW()` against PostgreSQL with a timeout and returns a
 * status object. Used by operators and Kubernetes health checks.
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const client = await pool.connect();
    try {
      // 3-second timeout prevents the health check from hanging indefinitely
      await client.query("SET statement_timeout = 3000");
      const result = await client.query("SELECT NOW()");
      res.status(200).json({
        status: "healthy",
        database: "connected",
        timestamp: result.rows[0].now,
      });
    } finally {
      // Reset timeout before releasing back to pool
      await client.query("SET statement_timeout = 0").catch(() => {});
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(503).json({
      status: "unhealthy",
      database: "disconnected",
      error: message,
    });
  }
});

// ---------------------------------------------------------------------------
// Test-only hooks — mounted iff TELLUS_TEST_HOOKS === "1". Used by integration
// suites that need to reset in-process state (e.g., rate-limiter windows)
// between tests without restarting the server. Production builds MUST NOT set
// this env var, and a misconfiguration is an immediate P0 deployment error.
//
// This is NOT an auth bypass, NOT a validation bypass, and never will be. It
// exists solely so the Palantir-1:1 rate-limiter integration contract
// ("Exceeding batch-per-user limit returns 429") can assert on a clean
// counter without cross-suite contamination from shared `batch:anonymous`
// keys.
// ---------------------------------------------------------------------------
if (process.env.TELLUS_TEST_HOOKS === "1") {
  // Lazy-import to avoid loading test-only code in production.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { limiter } = require("./middleware/rateLimiter");
  app.post(
    "/api/v1/_test/rate-limiter/reset",
    (_req: Request, res: Response) => {
      limiter.reset();
      res.status(204).end();
    },
  );
  console.log(
    "[test-hooks] Mounted /api/v1/_test/rate-limiter/reset (TELLUS_TEST_HOOKS=1)",
  );
}

// API routers — spec cypress tests hit `.../ontology/default/...`; rewrite
// the URL path so every downstream router sees the real UUID. This is a
// string substitution on `req.url` so Express re-parses params for us.
const ALIAS_RE = /^(\/api\/v1\/ontology)\/(default|main|primary)(\/|$)/;
app.use(async (req, _res, next) => {
  const m = req.url.match(ALIAS_RE);
  if (!m) return next();
  try {
    const { query } = await import("./db");
    const result = await query(
      "SELECT ontology_id FROM ontology ORDER BY created_at ASC LIMIT 1"
    );
    if (result.rowCount && result.rowCount > 0) {
      const real = result.rows[0].ontology_id as string;
      req.url = req.url.replace(ALIAS_RE, `$1/${real}$3`);
    }
  } catch {
    // fall through — route will return its own error
  }
  next();
});

app.use(ontologyRouter);
app.use("/api/v1/ontology/:ontologyId/objectTypes", objectTypeRouter);
app.use("/api/v1/ontology/:ontologyId/objectTypes/:apiName", propertyRouter);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource",
  datasourceRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/suggestMapping",
  suggestMappingRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/index",
  indexingRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore",
  objectDataStoreRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/linkTypes",
  linkRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/actionTypes",
  actionTypeRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/actions",
  actionsRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/actions",
  actionAuditRouter
);
app.use("/api/v1/actions", validateRouter);
app.use("/api/v1/actions", batchRouter);
app.use("/api/v1/audit", globalAuditRouter);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/edits",
  editsRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/index",
  reindexStatusRouter
);
app.use("/api/v1/datasets", datasetRouter);
app.use("/api/v1/datasets", dataPreviewRouter);

// PB-B8: v2 lineage surface (new semantics → v2 prefix per the
// project's framing note).
import lineageRouter from "./routes/lineage";
app.use("/api/v2", lineageRouter);

// Code Repositories (B2) — admin router mounted on the main server so
// the FE can reach the saga + ledger + branches via the existing auth chain.
//
// We use `mountCodeRepository` (not the router-only helper) so we keep a
// handle on the in-memory adapter instances. That lets the rehydrator below
// re-seed every ACTIVE `code_repository` row into the same adapter the
// router will use at request time — without it, a backend restart leaves
// existing repository RIDs unreadable until the row is re-created.
import { mountCodeRepository } from "./services/codeRepository/mount";
import { rehydrateInMemoryStemma } from "./services/codeRepository/rehydrate";
const codeRepoMount = mountCodeRepository({ pool });
app.use("/api/v1/code-repositories", codeRepoMount.router);

// Boot-time rehydrator. No-op against a real Stemma client (production); a
// best-effort re-seed against the in-memory adapter (dev / e2e). Awaited
// inline at module load so the FE's first request after boot finds the
// branches it expects. Errors are logged + swallowed: a partial rehydrate
// must not block the server from accepting traffic.
void (async () => {
  try {
    const r = await rehydrateInMemoryStemma({
      pool,
      stemma: codeRepoMount.adapters.stemma,
      logger: (event, meta) =>
        console.log(JSON.stringify({ event, ...(meta ?? {}) })),
    });
    if (r.applied && (r.rehydrated > 0 || r.failed > 0)) {
      console.log(
        JSON.stringify({
          event: "code-repos.rehydrate.summary",
          rehydrated: r.rehydrated,
          skipped: r.skipped,
          failed: r.failed,
          total: r.total,
        }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "code-repos.rehydrate.fatal",
        message: (err as Error).message,
      }),
    );
  }
})();

// Code Repositories — B3 Templates service.
//
// Per ADR-008 the B3 surface is split into two router factories, each
// mounted at its own resource prefix. This makes the mount strictly
// resource-scoped (no middleware leak across siblings) and lets every
// router declare its auth/idempotency stack as router-internal without
// risk of intercepting unrelated `/api/v1/*` traffic.
//
// History: this previously shipped as a single router whose router-level
// `requireCodeReposAuth()` middleware leaked across `/api/v1/*` (including
// `/api/v1/auth/login`) and 401-rejected sibling routes. ADR-008 codifies
// the rule that prevents the regression.
import {
  createTemplatesRouter,
  createScaffoldRouter,
} from "./services/templates/admin/routes";
app.use("/api/v1/templates", createTemplatesRouter({ pool }));
app.use("/api/v1/scaffold", createScaffoldRouter({ pool }));

// PB-B9: Prometheus scrape endpoint for the Pipeline Builder,
// parallel to /api/v1/funnel/metrics.
import pipelinesMetricsRouter from "./routes/pipelinesMetrics";
app.use("/api/v1/pipelines", pipelinesMetricsRouter);

// Workshop B01 — module CRUD with ETag/If-Match optimistic concurrency.
// Spec: tasks/workshop/workshop-tasks.md §B01. Mounted under the spec's
// `/api/v1/workshop` prefix (separate from `/api/v1` so the surface stays
// versioned independently of the existing Foundry-shaped APIs).
import workshopModulesRouter from "./routes/workshopModules";
app.use("/api/v1/workshop", workshopModulesRouter);

// Quiver B1 — analysis CRUD (Phase 1).
// Spec: tasks/quiver/quiver-tasks.md §B1. Phase-flagged via TELLUS_QUIVER_PHASE.
// Mounted at /quiver/api/v1 to mirror the spec's base-path verbatim.
import { buildQuiverRouter } from "./routes/quiver";
app.use("/quiver/api/v1", buildQuiverRouter());

// Wire the production-default Workshop OSS adapter to read from the seeded
// `workshop_demo_order` Postgres table (migration 061). Tests that exercise
// the OSS path swap their own RecordingOssAdapter via setOss() in beforeAll
// and restore it in afterAll, so this default does not affect the suite.
import { setOss } from "./services/workshop/ossAdapter";
import { PostgresOssAdapter } from "./services/workshop/postgresOssAdapter";
setOss(new PostgresOssAdapter());
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex",
  reindexRouter
);
// POST commit → emits the async funnel signal. Declared BEFORE the
// reindexRouter mount below so this handler wins for POST requests and
// the router only ever serves GET /status and GET /history for the
// UUID path.
app.post(
  "/api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId",
  resolveObjectTypeIdToApiName,
  saveToOntology
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId",
  resolveObjectTypeIdToApiName,
  reindexRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/interfaces",
  interfaceRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements",
  objectTypeInterfacesRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName",
  objectViewsRouter
);
app.use("/api/v1/objects/:objectType", objectViewsByTypeRouter);
app.use(objectsRouter);
app.use(healthRouter);

// ---------------------------------------------------------------------------
// Ontology Platform spec Phase 2 — branching, groups, functions, favorites,
// saved explorations, exports, summary, geo, comparisons, schema migrations.
// ---------------------------------------------------------------------------
app.use("/api/v1/ontology/:ontologyId/branches", branchesRouter);
app.use("/api/v1/ontology/:ontologyId/groups", groupsRouter);
app.use("/api/v1/ontology/:ontologyId/functions", functionsRouter);
app.use("/api/v1/ontology/:ontologyId/explorations", explorationsRouter);
app.use("/api/v1/ontology/:ontologyId/exports", exportsRouter);
app.use("/api/v1/ontology/:ontologyId/summary", summaryRouter);
app.use("/api/v1/ontology/:ontologyId/geo", geoRouter);
app.use("/api/v1/ontology/:ontologyId/comparisons", comparisonsRouter);
app.use("/api/v1/ontology/:ontologyId/migrations", migrationManagerRouter);
app.use("/api/v1/ontology/:ontologyId/governance", governanceRouter);
app.use("/api/v1/users/me/favorites", favoritesRouter);

// New Palantir-stack endpoints (Furnace SQL, Polars charts, Funnel pipeline status).
app.use("/api/v1", sqlRouter);
app.use("/api/v1", chartsRouter);
app.use("/api/v1", pipelinesStatusRouter);
app.use("/api/v1/funnel", funnelRouter);

// ---------------------------------------------------------------------------
// Foundry Data Ingestion Layer routes (BE-003 through BE-030)
// These run alongside the ontology engine routes on the same Express app.
// ---------------------------------------------------------------------------
app.use("/api/v1/projects", foundryProjectsRouter);
app.use("/api/v1/projects/:projectId/folders", foundryFoldersRouter);
app.use("/api/v1/projects/:projectId/folders/:folderId", foundryUploadsRouter);
app.use("/api/v1/projects/:projectId", foundryProjectUploadsRouter);
app.use("/api/v1/projects/:projectId/folders/:folderId/datasets", foundryFolderDatasetsRouter);
app.use("/api/v1/datasets", foundryDatasetRouter);
app.use("/api/v1/datasets", foundryColumnStatsRouter);
app.use("/api/v1/datasets", foundryVersionsRouter);
app.use("/api/v1/datasets", datasetDeduplicateRouter);
app.use("/api/v1/projects", projectDuplicatesRouter);
app.use("/api/v1/search", foundrySearchRouter);
app.use("/api/v1/breadcrumb", foundryBreadcrumbRouter);
// Palantir Multipass-equivalent auth surface (see ontology/tellus-auth.md).
// The legacy /api/auth/{register,login,refresh,logout} router was retired
// in Phase 3; /api/v1/auth is the only supported authentication entry point.
app.use("/api/v1/auth", tellusAuthV1Router);

// Dev-only: Cypress's MFA cleanup hooks live under /api/v1/auth/_test.
// Mount conditionally so production bundles never expose the router at all.
if (process.env.NODE_ENV !== "production") {
  app.use("/api/v1/auth/_test", tellusAuthTestHooksRouter);
}
app.use("/api/v1/projects/:projectId/members", foundryMembersRouter);
app.use("/api/v1/projects/:projectId/pipelines", foundryPipelinesRouter);

// ---------------------------------------------------------------------------
// API Specification & Documentation
// Served at GET /api/docs (Swagger UI) and GET /api/docs/spec.json (raw JSON).
// The old /api/v1/docs and /api/v1/spec endpoints have been removed —
// everything is consolidated under /api/docs.
// ---------------------------------------------------------------------------

// Dev tools (seed/reset/status) — only active in non-production
app.use("/api/v1/dev", devRouter);

// API docs (BE-029) — must be before notFoundHandler
setupFoundrySwagger(app);

// 404 handler for unmatched routes — AFTER all route handlers
app.use(notFoundHandler);

// Global error handler — MUST be last in the middleware chain
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Background maintenance — runs every 60 seconds:
//   • purge expired MFA / WebAuthn challenge rows
//   • purge expired reauth tokens
//   • flush pending rows from email_outbox (dev stub writer)
// Each task is isolated in its own try/catch so a failure in one
// doesn't block the others, and the interval is .unref()'d so it
// never keeps the event loop alive during a graceful shutdown.
// ---------------------------------------------------------------------------
const authMaintenanceSweeper = setInterval(async () => {
  try {
    await purgeExpiredAuthChallenges(foundryDb as never);
  } catch (err) {
    console.error(JSON.stringify({
      type: "auth_challenge_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  try {
    await purgeExpiredReauthTokens();
  } catch (err) {
    console.error(JSON.stringify({
      type: "reauth_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  try {
    await flushEmailOutbox();
  } catch (err) {
    console.error(JSON.stringify({
      type: "email_flush_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  try {
    // Drop expired + consumed passkey enrollment rows so a leaked
    // stashed refresh token has a bounded lifetime even if the
    // happy-path consume() didn't fire.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getPasskeyEnrollmentService(foundryDb as any).purgeExpired();
  } catch (err) {
    console.error(JSON.stringify({
      type: "passkey_enrollment_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}, 60_000);
if (typeof authMaintenanceSweeper.unref === "function") authMaintenanceSweeper.unref();

// ---------------------------------------------------------------------------
// Process-level error handlers — prevent silent crashes
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason: unknown) => {
  console.error(JSON.stringify({
    type: "unhandled_rejection",
    timestamp: new Date().toISOString(),
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  }));
  // Do NOT shutdown for unhandled rejections — log and continue
});

process.on("uncaughtException", (err: Error) => {
  console.error(JSON.stringify({
    type: "uncaught_exception",
    timestamp: new Date().toISOString(),
    error: err.message,
    stack: err.stack,
  }));
  shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);

let server: http.Server;

async function start(): Promise<void> {
  try {
    // Verify the database is reachable before accepting requests.
    await pool.query("SELECT NOW()");

    // Migration gate — fail-fast on schema drift (production) or
    // auto-apply pending migrations (dev).  Mode is selected by
    // TELLUS_MIGRATION_GATE env var; defaults to `strict` when
    // NODE_ENV=production, `auto` otherwise.  Gate runs BEFORE any
    // service tries to write to a Postgres table — failure here
    // exits the process so K8s/Apollo treats it as a deploy
    // failure and stops the rollout.  See decisions/code-repository/
    // D-2026-05-04-008-boot-migration-gate.md.
    try {
      const gateResult = await enforceMigrationGate({ pool });
      console.log(
        JSON.stringify({
          type: "migration_gate.ok",
          mode: gateResult.mode,
          appliedDuringRun: gateResult.appliedDuringRun.length,
          pendingBefore: gateResult.pending.length,
          durationMs: gateResult.durationMs,
        }),
      );
    } catch (gateErr) {
      if (gateErr instanceof MigrationDriftError) {
        console.error(
          JSON.stringify({
            type: "migration_gate.drift",
            pending: gateErr.pending,
            message: gateErr.message,
          }),
        );
      } else {
        console.error(
          JSON.stringify({
            type: "migration_gate.error",
            error: gateErr instanceof Error ? gateErr.message : String(gateErr),
          }),
        );
      }
      // Refusing to start the server — drift / apply failure must
      // be treated as a deploy bug, not a soft warning.
      await pool.end().catch(() => {
        /* ignored — already shutting down */
      });
      process.exit(1);
    }

    // Ensure the OpenSearch index template is in place before any indexing
    // operations. This is a best-effort call — if OpenSearch is not yet
    // reachable the server still starts (indexing will fail later with a
    // clear error), but the template will be applied on next restart.
    try {
      await ensureIndexTemplate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `WARNING: Could not ensure OpenSearch index template: ${msg}`
      );
    }

    // Ensure the S3/MinIO bucket exists (creates if missing).
    // Best-effort — server still starts if MinIO is unreachable.
    try {
      await ensureBucket();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `WARNING: Could not ensure S3/MinIO bucket: ${msg}`
      );
    }

    // F-P4-12 + F-P5-09 closure: arm the Redis-backed rate limiter and
    // the Kafka-backed cache-invalidation bus before the HTTP listener
    // opens. bootstrapK8sInfra is fail-soft — Redis/Kafka unreachable
    // degrades gracefully (memory limiter, no peer propagation) rather
    // than blocking boot.
    try {
      const { bootstrapK8sInfra } = await import("./boot/cacheAndRateLimit");
      await bootstrapK8sInfra();
    } catch (err) {
      console.warn(
        `WARNING: K8s infra bootstrap failed (degraded mode): ${(err as Error).message}`,
      );
    }

    server = app.listen(PORT, () => {
      console.log(
        `Ontology Engine started on port ${PORT} | PostgreSQL connected`
      );
    });

    // Object Data Funnel background workers.
    //
    // The dispatcher drains `funnel_signal` and drives one
    // ObjectTypeFunnelWorkflow per signal through the four stages
    // (changelog → merge → indexing → hydration). The overlay sweeper
    // reconciles Redis overlays against `ontology_edit.applied_to_index_at`.
    // Both are best-effort startup: a failure just logs and does not
    // block the server.
    try {
      if (process.env.FUNNEL_DISPATCHER_DISABLED !== "true") {
        startFunnelDispatcher();
        console.log("Funnel dispatcher started");
      }
    } catch (err) {
      console.warn(
        `WARNING: could not start Funnel dispatcher: ${(err as Error).message}`
      );
    }

    // PB-B1: Pipeline dispatcher + one-shot orphan sweep.
    //
    // The dispatcher drains pipeline_signal on a 2s tick and runs the
    // deploy via DeploymentService.executeDeploymentById. Mirrors the
    // Funnel's posture (Temporal preferred, PG-backed fallback).
    // The one-shot sweep on boot reconciles deployments orphaned by a
    // prior pod crash so the UI doesn't poll stuck rows forever.
    try {
      const orphans = await sweepOrphanPipelineDeployments();
      if (orphans.sweptIds.length > 0) {
        console.log(
          `Swept ${orphans.sweptIds.length} orphan pipeline_deployment(s) from prior restart`
        );
      }
    } catch (err) {
      console.warn(
        `WARNING: pipeline orphan sweep failed: ${(err as Error).message}`
      );
    }
    try {
      if (process.env.PIPELINE_DISPATCHER_DISABLED !== "true") {
        startPipelineDispatcher();
        console.log("Pipeline dispatcher started");
      }
    } catch (err) {
      console.warn(
        `WARNING: could not start Pipeline dispatcher: ${(err as Error).message}`
      );
    }
    void stopPipelineDispatcher; // retain symbol for shutdown wiring

    // PB-B4 — Iceberg compaction + expiration loop for _pipeline.* tables.
    // Best-effort: skipped when PyIceberg sidecar is unreachable.
    try {
      if (process.env.PIPELINE_ICEBERG_MAINTENANCE_DISABLED !== "true") {
        startIcebergMaintenance();
        console.log("Iceberg maintenance loop started");
      }
    } catch (err) {
      console.warn(
        `WARNING: could not start Iceberg maintenance: ${(err as Error).message}`
      );
    }
    void stopIcebergMaintenance;

    // B3: Sweep funnel_run rows orphaned by a prior worker restart.
    // A SIGKILL / OOM / container restart mid-activity leaves rows at
    // status='running' that the UI polls and shows stuck on "sync"
    // forever. Close them out before a new worker comes up so every
    // save-to-ontology click after restart starts from a clean slate.
    try {
      const { sweepOrphanedFunnelRuns } = await import(
        "./services/funnel/durableWorkflow"
      );
      const swept = await sweepOrphanedFunnelRuns();
      if (swept.sweptRunIds.length > 0) {
        console.log(
          `Swept ${swept.sweptRunIds.length} orphaned funnel_run row(s) + ${swept.sweptStageRuns} stage(s) from prior worker restart`
        );
      }
    } catch (err) {
      console.warn(
        `WARNING: orphaned funnel_run sweep failed: ${(err as Error).message}`
      );
    }

    // B3: Temporal worker. When Temporal is reachable this is the
    // authoritative execution path; the PG-backed dispatcher above
    // becomes a fallback used only when `isTemporalConnected()` is
    // false at signal time.
    void (async () => {
      try {
        if (process.env.TEMPORAL_WORKER_DISABLED === "true") return;
        const ok = await startTemporalWorker();
        if (ok) {
          console.log("Temporal worker registered on tellus-funnel");
          // PB-B4 follow-3.1 — kick the iceberg compaction+expiration
          // schedule. Falls back to the in-process interval loop when
          // Temporal is unreachable (the two paths don't double-execute;
          // the schedule emits on the same task queue and the loop's
          // `runIcebergMaintenanceOnce` is idempotent anyway).
          try {
            const { ensureIcebergMaintenanceSchedule } = await import(
              "./services/pipelines/temporal/schedule"
            );
            const r = await ensureIcebergMaintenanceSchedule();
            console.log(
              `PB-B4 iceberg maintenance schedule: scheduled=${r.scheduled}${
                r.reason ? ` (${r.reason})` : ""
              }`,
            );
          } catch (err) {
            console.warn(
              `WARNING: could not ensure PB-B4 maintenance schedule: ${(err as Error).message}`,
            );
          }
        } else {
          console.log("Temporal unreachable — PG-backed dispatcher remains primary");
        }
      } catch (err) {
        console.warn(
          `WARNING: Temporal worker failed to start: ${(err as Error).message}`
        );
      }
    })();
    try {
      if (process.env.OVERLAY_SWEEPER_DISABLED !== "true") {
        startOverlaySweeper();
        console.log("Overlay sweeper started");
      }
    } catch (err) {
      console.warn(
        `WARNING: could not start overlay sweeper: ${(err as Error).message}`
      );
    }

    // B9: start the replacement pipeline scheduler. Every 60s it
    // evaluates SOAK gates and fires cutover when eligible, plus drops
    // the old index after its 48h retention window. Without this, the
    // state machine stays stuck at REPLACEMENT_SOAK forever.
    try {
      if (process.env.REPLACEMENT_SCHEDULER_DISABLED !== "true") {
        startReplacementScheduler();
        console.log("Replacement scheduler started");
      }
    } catch (err) {
      console.warn(
        `WARNING: could not start replacement scheduler: ${(err as Error).message}`
      );
    }

    // B2: bootstrap the Iceberg REST catalog (Lakekeeper). Creates the
    // `tellus-funnel` warehouse on MinIO and one namespace per Object
    // Type. Best-effort — if Lakekeeper is unreachable the
    // PG-backed icebergCatalog.ts remains authoritative.
    trackBootTask(async () => {
      try {
        const lk = await bootstrapLakekeeper();
        if (!lk.reachable) {
          console.warn("Lakekeeper unreachable — Iceberg catalog falls back to PG shim");
        } else {
          console.log(
            `Lakekeeper bootstrap: warehouse=${lk.warehouseId} funnel_namespaces=${lk.namespacesCreated}/${lk.objectTypesConsidered * 4} pipeline_namespaces=${lk.pipelineNamespacesCreated}/${lk.pipelinesConsidered}`
          );
          // PB-B4 — ensure the `tellus-pipeline` warehouse exists as
          // well. Pipeline data writes land here (separate from
          // `tellus-funnel` so remote-signing can be disabled per
          // warehouse without affecting the funnel). Reuses the SAME
          // lakekeeperClient via pipelines/lakekeeperBootstrap.
          try {
            const pw = await ensurePipelineWarehouse();
            console.log(`Lakekeeper pipeline bootstrap: warehouse=${pw}`);
          } catch (err) {
            console.warn(
              `WARNING: Lakekeeper pipeline warehouse bootstrap failed: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        console.warn(`WARNING: Lakekeeper bootstrap failed: ${(err as Error).message}`);
      }
    });

    // B10: ensure ClickHouse link tables mirror every registered
    // link_type. Best-effort — a missing ClickHouse just leaves
    // traversal queries unserved until next refresh.
    trackBootTask(async () => {
      try {
        const result = await ensureLinkTablesForAllLinkTypes();
        if (result.skippedUnreachable) {
          console.warn("ClickHouse unreachable — link tables not bootstrapped");
        } else {
          console.log(
            `ClickHouse link tables ensured: ${result.tablesEnsured}/${result.linkTypesFound}`
          );
        }
      } catch (err) {
        console.warn(
          `WARNING: ClickHouse bootstrap failed: ${(err as Error).message}`
        );
      }
    });

    // ----------------------------------------------------------------
    // Bootstrap the tellus-superadmin realm role and seed it onto the
    // designated bootstrap account. This is idempotent and runs on
    // every boot: if the role already exists and the user already
    // holds it, both calls are no-ops. Failures are logged but do
    // NOT crash the server — Keycloak may be slow to come up, and
    // we want the API to keep serving the rest of the surface even
    // if the role bootstrap is briefly unavailable.
    //
    // The bootstrap account is configurable via TELLUS_SUPERADMIN_EMAIL
    // so a fresh deployment can hand the keys to whichever address
    // the operator owns. Default keeps the project-owner email pinned
    // for the dev environment.
    // ----------------------------------------------------------------
    void (async () => {
      const email = process.env.TELLUS_SUPERADMIN_EMAIL;
      const password = process.env.TELLUS_SUPERADMIN_PASSWORD;
      if (!email || !password) {
        console.warn(
          "[bootstrap] TELLUS_SUPERADMIN_EMAIL and TELLUS_SUPERADMIN_PASSWORD must both be set; skipping superadmin bootstrap"
        );
        return;
      }
      // Auto-create the superadmin in non-prod so `pnpm run dev` on a
      // fresh Keycloak volume lands with a working login. The prod
      // container sets NODE_ENV=production, which keeps this off.
      const autoCreate = process.env.NODE_ENV !== "production";
      try {
        const { getKeycloakAdminService } = await import(
          "./services/keycloakAdminService"
        );
        const { TELLUS_SUPERADMIN_ROLE } = await import(
          "./middleware/requireSuperAdmin"
        );
        const kc = getKeycloakAdminService();
        await kc.ensureRealmRole(
          TELLUS_SUPERADMIN_ROLE,
          "Tellus superadmin — full access to /admin/users and system settings",
        );
        let user = await kc.findUserByEmail(email);
        if (!user) {
          if (!autoCreate) {
            console.warn(
              `[bootstrap] superadmin email ${email} not found in Keycloak; skipping role grant (set NODE_ENV!=production to auto-create)`
            );
            return;
          }
          const userId = await kc.createUser({
            username: email,
            email,
            password,
            enabled: true,
            emailVerified: true,
          });
          user = { id: userId, email, username: email };
          console.log(`[bootstrap] created superadmin user ${email}`);
        }
        await kc.assignRealmRoleToUser(user.id, TELLUS_SUPERADMIN_ROLE);
        console.log(
          `[bootstrap] tellus-superadmin role ensured + granted to ${email}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[bootstrap] superadmin role bootstrap failed: ${msg}`);
      }
    })();

    // Attach WebSocket server for foundry real-time events (BE-012)
    initWebSocketServer(server);

    // Foundry Swagger docs are registered before server start (before notFoundHandler)

    // Clean up expired idempotency keys every 6 hours (Task 21)
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        const deleted = await cleanupExpiredKeys();
        if (deleted > 0) {
          console.log(`Idempotency cleanup: removed ${deleted} expired keys`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Idempotency cleanup error: ${msg}`);
      }
    }, SIX_HOURS_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`FATAL: Cannot connect to PostgreSQL: ${message}`);
    process.exit(1);
  }
}

/**
 * Graceful shutdown: stop accepting new connections, wait for in-flight
 * requests to complete, then drain the PostgreSQL connection pool.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`${signal} received again — shutdown already in progress`);
    return;
  }

  isShuttingDown = true;

  console.log(JSON.stringify({
    type: "shutdown_initiated",
    timestamp: new Date().toISOString(),
    signal,
    activeRequests,
  }));

  if (server) {
    server.close(() => {
      console.log(JSON.stringify({ type: "server_closed", timestamp: new Date().toISOString() }));
    });
  }

  // Wait for in-progress requests to complete (max 25 seconds)
  const maxWait = 25_000;
  const startWait = Date.now();
  while (activeRequests > 0 && (Date.now() - startWait) < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(JSON.stringify({ type: "shutdown_waiting", activeRequests, elapsed: Date.now() - startWait }));
  }

  if (activeRequests > 0) {
    console.warn(JSON.stringify({ type: "shutdown_forced", activeRequests, message: "Forcing shutdown with active requests" }));
  }

  // Destroy the action rate limiter to prevent dangling setInterval
  limiter.destroy();

  // Close foundry WebSocket connections
  const wss = getWss();
  if (wss) {
    console.log(JSON.stringify({ type: "foundry_ws_closing" }));
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.close(1001, 'Server shutting down');
      }
    }
  }

  // Reset foundry datasets stuck in "processing" to "pending"
  try {
    const resetCount = await foundryDb('foundry_datasets')
      .where({ status: 'processing' })
      .update({ status: 'pending' });
    if (resetCount > 0) {
      console.log(JSON.stringify({ type: "foundry_datasets_reset", count: resetCount }));
    }
  } catch (err) {
    console.error(JSON.stringify({ type: "foundry_datasets_reset_error", error: err instanceof Error ? err.message : String(err) }));
  }

  // Destroy S3/MinIO client
  try {
    destroyStorageClient();
    console.log(JSON.stringify({ type: "s3_client_destroyed" }));
  } catch (err) {
    console.error(JSON.stringify({ type: "s3_client_destroy_error", error: err instanceof Error ? err.message : String(err) }));
  }

  // Drain foundry database connection pool
  try {
    await foundryDb.destroy();
    console.log(JSON.stringify({ type: "foundry_db_disconnected" }));
  } catch (err) {
    console.error(JSON.stringify({ type: "foundry_db_disconnect_error", error: err instanceof Error ? err.message : String(err) }));
  }

  // Give any still-running boot tasks (Lakekeeper / ClickHouse / seed
  // scripts) a short window to finish so they don't hit pool.end() mid
  // query. 2s is more than enough on a healthy host and bounded
  // regardless of what the task is doing.
  try {
    await awaitBootTasksWithDeadline(2_000);
  } catch {
    /* ignored — we're already shutting down */
  }

  try {
    await pool.end();
    console.log(JSON.stringify({ type: "postgresql_disconnected" }));
  } catch (err) {
    console.error(JSON.stringify({ type: "postgresql_disconnect_error", error: err instanceof Error ? err.message : String(err) }));
  }

  console.log(JSON.stringify({ type: "shutdown_complete", timestamp: new Date().toISOString() }));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();

export default app;
