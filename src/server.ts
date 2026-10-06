import "dotenv/config";
import { logger } from "./utils/logger";
// Dev-only runtime CA injection. NODE_EXTRA_CA_CERTS is a Node-native
// bootstrap env var read before any JS executes, so dotenv can't set it in
// time. Instead we expose TELLUS_DEV_EXTRA_CA_CERTS (loaded by dotenv above)
// and push the CA into the running TLS root store at startup. This lets the
// local case-management sandbox self-signed cert be trusted from .env alone,
// surviving restarts without an inline shell export. No-op in production
// (guard on NODE_ENV === "development") and silently skipped if the file is
// missing/unset.
if (process.env.NODE_ENV === "development" && process.env.TELLUS_DEV_EXTRA_CA_CERTS) {
  try {
    const https = require("node:https");
    const fs = require("node:fs");
    const caPath = process.env.TELLUS_DEV_EXTRA_CA_CERTS;
    if (fs.existsSync(caPath)) {
      const ca = fs.readFileSync(caPath, "utf8");
      // The webhook executor issues HTTPS egress via the default global agent
      // (no custom `agent` option in requestPinnedDestination), so injecting
      // the CA here makes all dev HTTPS egress trust the sandbox cert.
      https.globalAgent.options.ca = [ca];
      logger.info({ caPath }, "[dev-ca] Loaded extra CA");
    }
  } catch (e) {
    logger.warn({ error: (e as Error).message }, "[dev-ca] Failed to load extra CA");
  }
}
// PB-B9: bootstrap OTel BEFORE any instrumented library (pg, express,
// @temporalio/client, kafkajs) so auto-instrumentations patch the
// module graph on first require.
import "./services/otelBootstrap";
import { assertQuiverTestAuthSafe } from "./routes/quiver/testAuth";
import { assertNoTestAuthInProduction, TEST_AUTH_FLAGS } from "./utils/testAuthGate";
import { assertStrongWorkloadSecret } from "./services/multipass/tokens";
import { createCompressionMiddleware } from "./middleware/compression";
import crypto from "crypto";
import http from "http";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pool, query } from "./db";
import {
  enforceMigrationGate,
  MigrationDriftError,
} from "./db/migrationGate";
import {
  enforceSchemaContract,
  SchemaContractError,
} from "./db/schemaContract";
import requestLogger from "./middleware/requestLogger";
import { idempotencyKeyMiddleware } from "./middleware/idempotencyKey";
import { createInputSanitizer } from "./middleware/inputSanitizer";
import { notFoundHandler } from "./middleware/notFoundHandler";
import errorHandler from "./middleware/errorHandler";
import ontologyRouter from "./routes/ontology";
import objectTypeRouter from "./routes/objectTypes";
import propertyRouter from "./routes/properties";
import branchesRouter from "./routes/branches";
import ontologyWorkingStateRouter from "./routes/ontologyWorkingState";
import groupsRouter from "./routes/groups";
// functionsRouter (legacy) decommissioned — see vuln-0041 note at mount site.
import favoritesRouter from "./routes/favorites";
import explorationsRouter from "./routes/explorations";
import exportsRouter from "./routes/exports";
import summaryRouter from "./routes/summary";
import geoRouter from "./routes/geo";
import comparisonsRouter from "./routes/comparisons";
import migrationManagerRouter from "./routes/migrationManager";
import governanceRouter from "./routes/governance";
import purposesRouter from "./routes/purposes";
import { securityContext } from "./middleware/securityContext";
import { resolveOntologyAlias } from "./middleware/resolveOntologyAlias";
import datasourceRouter, { suggestMappingRouter } from "./routes/datasources";
import indexingRouter from "./routes/indexing";
import objectDataStoreRouter from "./routes/objectDataStore";
import linkRouter from "./routes/links";
import actionTypeRouter, { formatActionType } from "./routes/actionTypes";
import actionsRouter, { validateRouter, batchRouter } from "./routes/actions";
import automationsRouter from "./routes/automations";
import {
  startAutomateRuntime,
  stopAutomateRuntime,
} from "./services/automate/runtime";
import { runRwandaPindoAutomationOnce } from "./qa/rwanda/pindoAutomationRuntime";
import { actionAuditRouter, globalAuditRouter } from "./routes/auditLog";
import objectsRouter from "./routes/objects";
import objectSetsV2Router from "./routes/v2/objectSetsV2";
import objectsV2Router from "./routes/v2/objectsV2";
import linksV2Router from "./routes/v2/linksV2";
import actionsV2Router from "./routes/v2/actionsV2";
import omsV2Router from "./routes/v2/omsV2";
import attachmentsV2Router from "./routes/v2/attachmentsV2";
import mediaV2Router from "./routes/v2/mediaV2";
import healthRouter from "./routes/health";
import editsRouter from "./routes/edits";
import reindexStatusRouter from "./routes/reindexStatus";
import dataPreviewRouter from "./routes/dataPreview";
import datasetRouter from "./routes/datasets";
import { foundryDatasetsV1Router } from "./routes/foundryDatasetsV1";
import reindexRouter from "./routes/reindex";
import {
  resolveObjectTypeIdToApiName,
  saveToOntology,
} from "./routes/reindexById";
import interfaceRouter from "./routes/interfaces";
import interfaceLinkConstraintRouter from "./routes/interfaceLinkConstraints";
import webhookRouter from "./routes/webhooks";
import objectTypeInterfacesRouter from "./routes/objectTypeInterfaces";
import objectViewsRouter, { objectViewsByTypeRouter } from "./routes/objectViews";
import { ensureIndexTemplate } from "./services/opensearch/templateRegistry";

// Tellus PostgreSQL Connectivity v2 (B1) — Connections CRUD + Compass binding.
// Spec: tasks/postgres-connection/postgres-connection-tasks.md §B1.
// Mounted under /api/v1/connectivity to keep the spec's namespaced surface
// versioned independently of the existing /api/v1 ontology APIs.
import connectivityRouter, {
  initConnectivity,
  shutdownConnectivity,
} from "./routes/connectivity.routes";

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
import { startLinkCdcDrainer } from "./services/searchAround/linkCdcOutbox";
let stopLinkCdcDrainer: (() => void) | null = null;
import {
  startPipelineDispatcher,
  stopPipelineDispatcher,
  sweepOrphanPipelineDeployments,
} from "./services/pipelines/pipelineDispatcher";
import { startPipelineBuildScheduler } from "./services/pipelines/buildScheduler";
import {
  startIcebergMaintenance,
  stopIcebergMaintenance,
} from "./services/pipelines/icebergMaintenance";
import { startOverlaySweeper, stopOverlaySweeper } from "./services/overlay/sweeper";
import { startServingProjector, stopServingProjector } from "./services/serving/editProjector";
import { startAttachmentSweeper, stopAttachmentSweeper } from "./services/attachmentService";
import { stopHealthProber } from "./services/connectivity/health/prober";
import { ensureLinkTablesForAllLinkTypes } from "./services/funnel/clickhouseBootstrap";
import {
  startDeveloperConsoleReconciliationWorker,
  stopDeveloperConsoleReconciliationWorker,
} from "./services/developerConsole/reconciliationWorker";
import {
  startDeveloperConsoleArtifactBuildWorker,
  stopDeveloperConsoleArtifactBuildWorker,
} from "./services/developerConsole/artifactBuildWorker";

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
import compassChildrenRouter from "./routes/compassChildren";
import foundryFoldersRouter from "./routes/folders";
import foundryUploadsRouter from "./routes/uploads";
import foundryProjectUploadsRouter from "./routes/projectUploads";
import foundryUploadProgressRouter from "./routes/uploadProgress";
import projectWorkspaceRouter, { resourceLifecycleRouter } from "./routes/projectWorkspace";
import { autosaveProjectRouter, autosaveResourceRouter } from "./routes/autosaveSnapshots";
import { folderDatasetsRouter as foundryFolderDatasetsRouter, datasetRouter as foundryDatasetRouter } from "./routes/foundryDatasets";
import foundrySearchRouter from "./routes/search";
import foundryBreadcrumbRouter from "./routes/breadcrumb";
import tellusAuthV1Router from "./routes/tellusAuthV1";
import tellusAuthTestHooksRouter from "./routes/tellusAuthTestHooks";
import developerConsoleRouter from "./routes/developerConsole";
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
    logger.error(
      `FATAL: Required environment variable ${key} is not set. ` +
        "See .env.example for the full list."
    );
    process.exit(1);
  }
}

// Refuse to boot a production process with any test-auth bypass enabled — a
// single mis-set env var must never silently turn a request header into an
// authenticated identity. Fail loud at deploy time, not latent at runtime.
try {
  assertQuiverTestAuthSafe();
  // Covers CODE_REPOS_TEST_AUTH, CODE_ASSISTANT_TEST_AUTH,
  // QUIVER_ALLOW_TEST_AUTH and TELLUS_TEST_HOOKS (Phase 5: the
  // code-assistant bypass previously had NO boot guard).
  assertNoTestAuthInProduction(TEST_AUTH_FLAGS);
  // Refuse to boot with a known-weak workload JWT secret: the credential
  // unwrap route is unauthenticated-by-design (worker JWT only), so a weak
  // shared HS256 secret is a full vault-read bypass (Strix Sept 2026).
  assertStrongWorkloadSecret();
} catch (err) {
  logger.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------
const app = express();

// Trust the reverse-proxy hop(s) in front of this process when resolving
// req.ip. Every supported topology has exactly one trusted hop already:
//   - prod:           Traefik edge routes /api directly to this backend
//   - dev/bare docker: the Next.js /api catch-all proxy (tellus-fe)
// Without this, express-rate-limit v8 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// on every request, the global + login-brute-force limiters key on the
// PROXY address (all users share one bucket → spurious 429s), and audit
// logs (auditEventService.extractIp) record the proxy IP instead of the
// client's. Fail fast on a malformed override rather than booting with
// silently broken rate limiting.
//
// NEVER set this to Express `true` — that trusts client-supplied
// X-Forwarded-For blindly, letting attackers spoof IPs to bypass rate
// limiting and poison audit records. Use TRUST_PROXY_HOPS=0 to disable
// trust entirely (e.g. a deployment with no proxy in front).
const trustProxy: boolean | number = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (hops to trust), got: "${raw}"`
    );
  }
  return hops === 0 ? false : hops;
})();
app.set("trust proxy", trustProxy);

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

// Compress responses (gzip/brotli) — but NEVER text/event-stream. See
// src/middleware/compression.ts for why (zlib buffers SSE → "comes at once").
app.use(createCompressionMiddleware());

// Rate limiting — configurable requests per minute per IP. Default 1000:
// a single Workshop Provider Profile load legitimately bursts ~300 requests
// (per-claim Search Around fan-out × N claims + per-widget aggregates +
// searches + function invokes), measured 2026-10-02 — the previous default
// of 200 throttled the app's own frontend into 429s ("Failed to load pivot
// data"). Writes/actions keep their own stricter per-user limiters
// (middleware/rateLimiter.ts), so this coarse backstop stays meaningful.
//
// `/health`, `/api/v1/health`, and `/api/metrics` are intentionally exempted
// because Kubernetes liveness probes and Prometheus scrapers hit them on a
// fixed schedule that would otherwise burn the entire request budget. The
// production rule is: **observability must never throttle**.
//
// We also normalize the limit-exceeded response to the same
// `{ error: { code, message } }` envelope every other route uses, so
// monitoring and the frontend toaster can treat 429 like any other error.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "1000", 10);
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

// CORS — restrict origins via CORS_ORIGINS env var.
// Fail-closed in production: an unset/empty CORS_ORIGINS resolves to NO allowed
// origin (never `true`), so we never reflect arbitrary origins alongside
// credentials. Outside production we keep dev allow-all for local DX.
const isProduction = process.env.NODE_ENV === "production";
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : undefined;

// Explicit list (any env) → use it. Else: dev allows all, prod allows none.
const corsOrigin: string[] | boolean =
  corsOrigins && corsOrigins.length > 0 ? corsOrigins : !isProduction;

// Never expose the test-auth bypass headers in production.
const corsAllowedHeaders = [
  "Content-Type",
  "Authorization",
  "Idempotency-Key",
  "If-Match",
  "If-None-Match",
  "X-Request-ID",
  // Custom request headers the browser sends cross-origin (when the FE talks to
  // the backend directly rather than through a same-origin proxy). Each triggers
  // a CORS preflight, so they must be allow-listed or the request is blocked:
  //   X-Tellus-Branch — Quiver client, branch routing (sent on every call)
  //   X-Deadline      — Quiver compute deadline
  //   x-branch-id     — ontology client, branch selection
  //   X-Tellus-Reauth — settings client, step-up reauth token
  "X-Tellus-Branch",
  "X-Deadline",
  "x-branch-id",
  "X-Tellus-Reauth",
  // X-Upload-Id — upload progress channel; the FE sends this on multipart
  // upload POSTs so it can poll /v1/uploads/:id/progress. Without it in the
  // allow-list the browser blocks the POST at the preflight ("Network error")
  // and the upload never reaches the handler.
  "X-Upload-Id",
  ...(isProduction
    ? []
    : ["X-Tellus-Test-Principal", "X-Tellus-Test-Role", "X-Tellus-Test-Roles"]),
];

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: corsAllowedHeaders,
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

// Input sanitization — trim, strip null bytes, normalize Unicode, XSS prevention.
// shouldSkipBody: Workshop module saves carry a Vega spec JSON string that can exceed
// the 10k char cap; silently truncating it corrupts the spec. Skip body string
// mutation for /api/v1/workshop routes (depth guard still applies for DoS protection).
app.use(
  createInputSanitizer({
    shouldSkipBody: (req) => (req.path || "").startsWith("/api/v1/workshop"),
    // Workshop module documents are managed, schema-validated documents that
    // legitimately nest deeper than the generic API default (widget configs
    // with linked-filter chains, selection-event payloads, etc.).
    maxDepthForRoute: (req) =>
      (req.path || "").startsWith("/api/v1/workshop") ? 24 : undefined,
  }),
);

// F-P4-08 / Block F — per-request wall-clock budget. Attaches
// `req.timeoutSignal: AbortSignal` and arms a 504 on expiry. Must be
// mounted AFTER JSON parsing (so body upload is complete before the
// budget starts being spent on handler work) and BEFORE the auth /
// data-plane routes (so a wedged Keycloak or PG still surfaces as
// 504 instead of hanging the connection). /health, /ready, /metrics,
// and /openapi.json are exempted inside the middleware itself.
import { requestTimeoutMiddleware } from "./middleware/requestTimeout";
// The code-repositories function-invoke path (transpile + 200k-row ontology
// snapshot load + a 5s sandbox run) cannot fit the 5s data-plane budget, so
// it gets its own longer ceiling (CODE_REPOS_REQUEST_TIMEOUT_MS, default 30s)
// mounted on its router below. Exempt the whole mount prefix here so the
// global 5s timer does not fire first and 504 a request the longer budget
// would have allowed.
//
// `/api/v1/objects` is also exempted + given a longer ceiling below: the
// object-search read itself is sub-second, but it shares the single Node
// event loop with the (synchronous) function sandbox, which can block for up
// to FUNCTION_TIMEOUT_MS. A search queued behind a sandbox would otherwise
// blow the 5s budget and 504 even though its own work is ~ms. The longer
// ceiling lets it complete once the sandbox yields; the root-cause fix (the
// sandbox moved to a worker thread) is in functionRuntime/functionWorkerPool.
// Multipart uploads (POST .../upload + the .../transactions append route)
// move bytes: their duration scales with file size and client throughput, not
// handler work, so the 5s data-plane budget would 504 a legitimate large
// upload mid-stream. Give those POSTs a longer ceiling (default 10 min — well
// above the frontend's 5-min axios timeout and enough for a 1 GB upload on a
// decent link). Reads and other writes stay on the 5s budget.
const UPLOAD_REQUEST_TIMEOUT_MS = Number(
  process.env.UPLOAD_REQUEST_TIMEOUT_MS ?? 10 * 60 * 1000,
);
// Actions /apply|applyBatch can legitimately outlast the data-plane budget
// when LINK_INDEX_ACK_REQUIRED=true: the read-after-write barrier blocks
// up to LINK_INDEX_ACK_TIMEOUT_MS for the serving edge index while the PG
// commit is ALREADY durable — its terminal answer is 202
// COMMITTED_INDEX_PENDING (actions/linkIndexAckHttp.ts). Without this
// extension, the 5s data-plane timer fires first and surfaces the
// committed mutation as a 504, inviting client retries of an
// already-applied edit.
//
// The barrier wait is ADDITIVE to the action's ordinary work — and for
// applyBatch it is MULTIPLICATIVE: batch items execute sequentially and
// EACH is a full action execution (rule compile + PG tx + OS writeback)
// that waits on its own barrier. A stalled N-item batch can therefore
// block up to N × (ordinary work + ack deadline). The budget is
//   N × (data-plane allowance + ack deadline + 2 s of route headroom),
// with N read from the parsed body (express.json is mounted above) and
// clamped to the route's MAX_BATCH_SIZE; /apply and malformed bodies
// count as N=1, which reduces to exactly the single-apply budget.
// It applies ONLY when the flag is on.
const ACK_BUDGET_DATAPLANE_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 5_000);
const ACK_BUDGET_BARRIER_MS = Number(process.env.LINK_INDEX_ACK_TIMEOUT_MS ?? 5_000);
const ACK_BUDGET_HEADROOM_MS = 2_000;
const ACK_BUDGET_MAX_ITEMS = 100; // equals routes/actions.ts MAX_BATCH_SIZE
// Ceiling for the ack-aware budget: 100-item batches at generous
// per-item allowances would otherwise hold connections for many minutes
// (the ceiling was previously emergent = N × perItem, unbounded). When
// the cap truncates the budget, the batch route pre-defers later items'
// acks (ackBudgetMs → 0 ⇒ per-item 202 pending) instead of overrunning
// the wire deadline — invariant: a COMMITTED item is answered 202,
// never 504. Upload budgets are governed separately
// (UPLOAD_REQUEST_TIMEOUT_MS), not by this cap.
const MAX_REQUEST_BUDGET_MS = Number(process.env.MAX_REQUEST_BUDGET_MS ?? 120_000);
const actionAckBudgetFor = (req: Request): number | undefined =>
  process.env.LINK_INDEX_ACK_REQUIRED === "true"
    ? Math.min(
        Math.min(
          ACK_BUDGET_MAX_ITEMS,
          Math.max(
            1,
            /\/applyBatch$/.test(req.path) &&
              Array.isArray(
                (req.body as { requests?: unknown } | undefined)?.requests,
              )
              ? ((req.body as { requests: unknown[] }).requests.length || 1)
              : 1,
          ),
        ) *
          (ACK_BUDGET_DATAPLANE_MS + ACK_BUDGET_BARRIER_MS + ACK_BUDGET_HEADROOM_MS),
        MAX_REQUEST_BUDGET_MS,
      )
    : undefined;

// ---------------------------------------------------------------------------
// LINK_INDEX_ACK_REQUIRED startup invariant (Fix 2 — config half). The
// flag vouches that a committed link mutation is queryable through the
// indexed serving store; enabling it against a legacy/shadow mode would
// have the barrier assert visibility of a store the read path may not
// use. Boot FAILS for the misconfiguration below (a wrong process serving
// traffic is worse than no process); runtime shapes (CH schema/consumer
// liveness) are gated at /health/ready instead (src/routes/healthReady.ts).
// ---------------------------------------------------------------------------
import { assertLinkIndexAckStartupConfig } from "./services/serving/ackStartup";
assertLinkIndexAckStartupConfig();
app.use(requestTimeoutMiddleware({
  exemptPaths: [
    "/api/v1/code-repositories",
    "/api/v1/objects",
    "/api/v1/code-assistant",
  ],
  extendedBudgetFor: (req) =>
    req.method === "POST" && /\/(upload|transactions)$/.test(req.path),
  extendedTimeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
  budgetFor: (req) =>
    // NOTE: the route-interception regex covers ONLY apply|applyBatch.
    // routes/bulkActions.ts (applyBulk) is currently UNMOUNTED; if it is
    // ever mounted it MUST be added to this regex in the same change —
    // shipping applyBulk without the ack budget lets the data-plane
    // timer 504 committed ack-blocking mutations (invariant #1).
    req.method === "POST" &&
    /\/actions\/[^/]+\/(apply|applyBatch)$/.test(req.path)
      ? actionAckBudgetFor(req)
      : undefined,
}));
{
  const stack = (app as unknown as { _router?: { stack: Array<{ handle?: unknown; name?: string }> } })._router?.stack || [];
  const mounted = stack.some((layer) => layer.name === "requestTimeoutMw");
  if (!mounted) {
    logger.error("[boot] FATAL: requestTimeoutMiddleware is not mounted — data-plane requests would have no wall-clock budget");
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
    logger.error("[boot] FATAL: patSecurityGate is not mounted — PAT scope enforcement would be disabled");
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
    logger.error("[boot] FATAL: globalAuth middleware is not mounted — data-plane routes would be unauthenticated (F-01 regression)");
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
        // FUNN-ISO-1: non-secret deployment identity stamp. The destructive-
        // test guard uses this to prove which environment actually owns a
        // port before it is allowed to kill/replace the process there, and
        // to assert API↔test-lane coherence for destructive suites.
        // Uses the raw env var (never the resolver's implicit default) so a
        // dev server reports the DENY-listed "tellus-dev" value explicitly.
        environmentId: process.env.TELLUS_ENVIRONMENT_ID ?? "tellus-dev",
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

/**
 * GET /api/metrics — Prometheus scrape of the prom-client default registry.
 *
 * This path was already auth-exempt (middleware/globalAuth.ts), rate-limit
 * exempt (RATE_LIMIT_SKIP above), and RED-middleware skip-listed, but no
 * handler was ever mounted, so every scrape got a 404 and all prom-client
 * series — connectivity request duration/errors, workshop, and the new
 * connectivity probe/pool/egress metrics — were unreachable except through the
 * Workshop-scoped alias at /api/v1/workshop/metrics.
 *
 * prom-client stays a soft dependency (503, not 500, if it is absent), matching
 * routes/workshopModules.ts.
 */
app.get("/api/metrics", async (_req: Request, res: Response) => {
  try {
    const prom = (await import("prom-client")) as unknown as {
      register: { metrics(): Promise<string>; contentType: string };
    };
    res.setHeader("Content-Type", prom.register.contentType);
    res.send(await prom.register.metrics());
  } catch {
    res
      .status(503)
      .type("text/plain")
      .send("# prom-client unavailable in this build\n");
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
  // Loopback peer gate for the whole /api/v1/_test family (Strix Sept 2026):
  // the rate-limiter reset wipes every action-rate-limit window, so a
  // network peer must never drive it. Uses the raw socket peer (NOT req.ip)
  // so X-Forwarded-For cannot spoof loopback. tests/helpers/rateLimitReset.ts
  // always calls from localhost.
  const loopbackOnly = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket?.remoteAddress ?? "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      next();
      return;
    }
    res.status(403).json({
      errorCode: "FORBIDDEN",
      errorName: "Forbidden",
      message: "Test hooks are loopback-only",
      statusCode: 403,
    });
  };
  app.use("/api/v1/_test", loopbackOnly);
  // Lazy-import to avoid loading test-only code in production.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { limiter } = require("./middleware/rateLimiter");
  app.post(
    "/api/v1/_test/rate-limiter/reset",
    (req: Request, res: Response) => {
      // Header gate on top of the loopback peer check (Strix Sept 2026).
      // tests/helpers/rateLimitReset.ts sends this header.
      if (req.headers["x-tellus-test-hook"] !== "1") {
        res.status(403).json({
          errorCode: "FORBIDDEN",
          errorName: "Forbidden",
          message: "Test hook not authorized",
          statusCode: 403,
        });
        return;
      }
      limiter.reset();
      res.status(204).end();
    },
  );
  logger.info(
    "[test-hooks] Mounted /api/v1/_test/rate-limiter/reset (TELLUS_TEST_HOOKS=1, loopback+header gated)",
  );

  // Rwanda QA campaign: namespace-scoped fixture reset (see
  // src/qa/rwanda/resetNamespace.ts for why user_edit_wins makes this
  // necessary between campaigns).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RWANDA_QA_RESET_ROUTE, resetRwandaQaNamespace } = require(
    "./qa/rwanda/resetNamespace",
  ) as typeof import("./qa/rwanda/resetNamespace");
  app.post(RWANDA_QA_RESET_ROUTE, (req: Request, res: Response) => {
    void resetRwandaQaNamespace(req, res);
  });
  logger.info(
    `[test-hooks] Mounted ${RWANDA_QA_RESET_ROUTE} (TELLUS_TEST_HOOKS=1)`,
  );

  // Rwanda QA campaign: deterministic one-shot Pindo policy evaluation (plan
  // §3.9 functional slice — kill-switch / corrupt-telemetry refusals without
  // waiting real hold-down windows). See src/qa/rwanda/pindoAutomationProbe.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RWANDA_PINDO_EVALUATE_ROUTE, evaluateRwandaPindoOnce } = require(
    "./qa/rwanda/pindoAutomationProbe",
  ) as typeof import("./qa/rwanda/pindoAutomationProbe");
  app.post(RWANDA_PINDO_EVALUATE_ROUTE, (req: Request, res: Response) => {
    void evaluateRwandaPindoOnce(req, res);
  });
  logger.info(
    `[test-hooks] Mounted ${RWANDA_PINDO_EVALUATE_ROUTE} (TELLUS_TEST_HOOKS=1)`,
  );
}

// "One Enterprise, One Ontology" — collapse ANY ontology identifier in the
// path (a real UUID, a symbolic alias like `default`/`main`/`primary`, or any
// other value) onto the single canonical ontology, so every downstream router
// operates on the one ontology. We rewrite `req.url` so Express re-parses the
// param for us. `import` is excluded: it is a lifecycle sub-route of the
// ontology router, not an ontology identifier.
app.use(async (req, _res, next) => {
  // Cheap pre-check: only ontology-scoped sub-paths can be collapsed. The bare
  // `/api/v1/ontology` (list/create) has no trailing slash and is skipped.
  if (!req.url.startsWith("/api/v1/ontology/")) return next();
  try {
    const { getOntologyId, collapseOntologyUrl } = await import(
      "./services/ontology/canonicalOntology"
    );
    const canonical = await getOntologyId();
    if (canonical) {
      const rewritten = collapseOntologyUrl(req.url, canonical);
      if (rewritten) req.url = rewritten;
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
app.use("/api/v1/automations", automationsRouter);

// Phase 6.4 — per-user notification inbox. Mounted globally (not under
// /ontology/:ontologyId) because the inbox is user-scoped, not ontology-
// scoped. AuthN comes from globalAuth(); the route additionally reads
// `req.user.id` to scope list/mark-read to the authenticated principal.
import { notificationsRouter } from "./routes/notifications";
app.use("/api/v1/notifications", notificationsRouter);

// Global action type RID endpoints (Palantir Foundry style)
// Mounted at /api/v1/actionTypes (not under /ontology) to avoid route conflicts
// These allow looking up action types by RID without knowing the ontologyId
// NOTE: /by-rid/batch must be registered BEFORE /by-rid/:rid to avoid route conflicts
app.post(
  "/api/v1/actionTypes/by-rid/batch",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body;
      const rids: string[] = body.rids ?? body;

      if (!Array.isArray(rids)) {
        res.status(400).json({ errorCode: "INVALID_PARAMETER", message: "rids must be an array" });
        return;
      }

      if (rids.length === 0) {
        res.status(200).json({ data: [] });
        return;
      }

      if (rids.length > 500) {
        res.status(400).json({ errorCode: "INVALID_PARAMETER", message: "Maximum 500 RIDs allowed per batch request" });
        return;
      }

      const result = await query(
        "SELECT * FROM action_type WHERE action_type_id = ANY($1::uuid[])",
        [rids]
      );

      const data = result.rows.map((row: Record<string, any>) =>
        formatActionType(row),
      );

      res.status(200).json({ data });
    } catch (err: any) {
      next(err);
    }
  }
);

app.get(
  "/api/v1/actionTypes/by-rid/:rid",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { rid } = req.params;
      if (!rid || typeof rid !== "string") {
        res.status(400).json({ errorCode: "INVALID_PARAMETER", message: "rid is required" });
        return;
      }
      const row = await query(
        "SELECT * FROM action_type WHERE action_type_id = $1",
        [rid]
      );
      if (row.rows.length === 0) {
        res.status(404).json({ errorCode: "ACTION_TYPE_NOT_FOUND", message: `Action type with RID '${rid}' not found` });
        return;
      }
      res.status(200).json(formatActionType(row.rows[0]));
    } catch (err: any) {
      next(err);
    }
  }
);
// Edits feed — mounted at two paths so callers can address the parent
// object type by either its mutable apiName (legacy) or its stable
// UUID. Both mounts share the same router (`mergeParams: true`) and
// are disambiguated inside the handler by `resolveFromParams`. The
// `/by-id/...` mount must be registered FIRST so Express's
// first-match routing picks it before falling through to the api_name
// mount when callers send a UUID.
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/by-id/:objectTypeId/edits",
  editsRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/edits",
  editsRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/objectTypes/:apiName/index",
  reindexStatusRouter
);
// Foundry-parity Datasets API (create + get + preview), keyed by dataset RID.
// Mounted FIRST so its bare POST and its `ri.foundry.main.dataset.*` GET routes
// win; non-RID (UUID) requests fall through (next()) to the legacy upload /
// object-explorer datasets routers below, which keep working unchanged.
app.use("/api/v1/datasets", foundryDatasetsV1Router);
app.use("/api/v1/datasets", datasetRouter);
app.use("/api/v1/datasets", dataPreviewRouter);

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
import { PostgresStemma } from "./services/codeRepository/adapters/postgres";
import { FunctionsPublishService } from "./services/functionsPublish/service";
import { functionsPublishRunsRouter } from "./services/functionsPublish/routes";
// DURABLE Stemma (migration 086): persist branches/blobs/HEADs to Postgres so
// committed code survives restarts. Previously the in-memory adapter lost all
// git content on every reload, leaving repos showing only the template scaffold
// and drifting branch_cache (→ 412 on commit). The template adapter scaffolds
// through this same instance, so new repos materialise into Postgres too.
const codeRepoStemma = new PostgresStemma({ pool });
const functionsPublishService = new FunctionsPublishService({ pool, stemma: codeRepoStemma });
const codeRepoMount = mountCodeRepository({
  pool,
  stemma: codeRepoStemma,
  functionsPublisher: functionsPublishService,
});
// Dedicated wall budget for code-repositories routes (the function-invoke
// path transpiles + loads an ontology snapshot + runs a sandboxed function).
// The global 5s middleware exempted this prefix above; this longer ceiling
// (default 30s) still protects against true hangs while letting legitimate
// invokes complete. The sandbox's own FUNCTION_TIMEOUT_MS (5s) bounds CPU.
const CODE_REPOS_REQUEST_TIMEOUT_MS = Number(
  process.env.CODE_REPOS_REQUEST_TIMEOUT_MS ?? 30_000,
);
// Sync transform-execution routes (POST .../transforms/preview + .../transforms/test)
// run real PySpark in the request — the JVM cold-start can exceed the 30s
// code-repos budget. Give just those paths an extended ceiling (default 120s)
// so they don't 504 + orphan the child; the executor's own timeoutMs (100s for
// preview) SIGKILLs the transform before this fires. Other code-repos routes
// stay on the tight 30s budget.
const CODE_REPOS_EXTENDED_TIMEOUT_MS = Number(
  process.env.CODE_REPOS_EXTENDED_TIMEOUT_MS ?? 120_000,
);
app.use(
  "/api/v1/code-repositories",
  requestTimeoutMiddleware({
    timeoutMs: CODE_REPOS_REQUEST_TIMEOUT_MS,
    extendedTimeoutMs: CODE_REPOS_EXTENDED_TIMEOUT_MS,
    extendedBudgetFor: (req) => /\/transforms\/(preview|test)$/.test(req.path),
  }),
);
app.use("/api/v1/code-repositories", codeRepoMount.router);
app.use("/api/v1/jemma", functionsPublishRunsRouter({ pool, service: functionsPublishService }));

// Longer ceiling for the object read path (search/get/aggregate) so a request
// queued behind a synchronous function-sandbox block completes instead of
// 504ing at the 5s data-plane budget. See the exemption comment above.
const OBJECTS_REQUEST_TIMEOUT_MS = Number(
  process.env.OBJECTS_REQUEST_TIMEOUT_MS ?? 15_000,
);
app.use(
  "/api/v1/objects",
  requestTimeoutMiddleware({ timeoutMs: OBJECTS_REQUEST_TIMEOUT_MS }),
);

// Functions Registry (B8) — the platform-wide store of published, immutable,
// SemVer-versioned TypeScript Functions v2. Produced by Tag & Release
// (POST /api/v1/code-repositories/:rid/tags) and consumed by Workshop/Actions
// via resolve. Mounted here so /api/v1/functions/* is live in the running
// product (previously the router existed but was never wired up).
import { createFunctionsRouter } from "./services/functionsRegistry/admin/routes";
import { createFunctionPublishAdminRouter } from "./services/functions/admin/routes";
import { logFunctionPublishPolicySummary } from "./services/functions/executionPolicy";
// Function publish grant management (superadmin). Mounted BEFORE the
// /api/v1/functions registry router: Express matches mounts in registration
// order and /api/v1/functions is a prefix of /api/v1/functions/admin, so the
// more specific mount must come first. The router mounts requireCodeReposAuth
// itself (two-layer pattern); /api/v1/functions is already allowlisted in
// globalAuth, which covers this sub-prefix.
app.use("/api/v1/functions/admin", createFunctionPublishAdminRouter({ pool }));
// The registry router declares its routes as `/functions/:rid/...` (it was
// authored to mount at the root of a standalone app). Re-base it under
// `/api/v1/functions` by prepending `/functions` to the post-mount URL — this
// keeps the router's own auth/idempotency middleware scoped to this prefix
// (mounting it at `/api/v1` would apply those globally).
const functionsRegistryRouter = createFunctionsRouter({ pool });
app.use(
  "/api/v1/functions",
  (req: Request, _res: Response, next: NextFunction) => {
    req.url = "/functions" + (req.url === "/" ? "" : req.url);
    next();
  },
  functionsRegistryRouter,
);

// Code Repositories — Python @transform -> datasets (migration 103).
// The transform build engine: discover @transform on a committed ref,
// publish one job_spec per transform, execute in python3, materialize the
// OUTPUT dataset, and record input->output lineage. Mounted at /api/v1 AFTER
// the code-repositories router so `/code-repositories/:rid/builds` falls through
// to it. The jobSpec router (B7) is also mounted here so transform builds
// persist job_spec rows.
import { createTransformsRouter } from "./services/codeRepository/transforms/routes";
import { createJobSpecRouter } from "./services/jobSpec/admin/routes";
import { sweepStaleTransformBuilds } from "./services/codeRepository/transforms/crashSweeper";
import { requeueQueuedBuilds } from "./services/codeRepository/transforms/buildService";
const transformsStemma = new PostgresStemma({ pool });
app.use("/api/v1", createTransformsRouter({ stemma: transformsStemma }));
app.use("/api/v1", createJobSpecRouter({ pool }));

// Crash-recovery (Gap 2): on boot, reconcile transform_build rows left in a
// non-terminal state by a prior crash/restart.
//   - 'running' -> the process was MID-EXECUTION; resuming is unsafe (partial
//     output). Mark 'failed' (sweepStaleTransformBuilds). The user retries
//     explicitly via POST /builds/:rid/retry.
//   - 'queued'  -> enqueued but execution never began; no partial state, so
//     it is safe to re-run (requeueQueuedBuilds = idempotent recovery).
// Both best-effort, logged, non-blocking.
void (async () => {
  try {
    if (isShuttingDown) return;
    const swept = await sweepStaleTransformBuilds();
    if (swept > 0) logger.info(`[transforms] crash-recovery sweeper: marked ${swept} stale 'running' build(s) failed (lost on restart).`);
    const requeued = await requeueQueuedBuilds({ stemma: transformsStemma });
    if (requeued > 0) logger.info(`[transforms] crash-recovery: re-queued ${requeued} 'queued' build(s) (idempotent recovery).`);
  } catch (e) {
    logger.error({ error: String(e) }, "[transforms] crash-recovery failed");
  }
})();

// Boot-time rehydrator. No-op against a real Stemma client (production); a
// best-effort re-seed against the in-memory adapter (dev / e2e). Awaited
// inline at module load so the FE's first request after boot finds the
// branches it expects. Errors are logged + swallowed: a partial rehydrate
// must not block the server from accepting traffic.
void (async () => {
  // Skip if a shutdown is already underway — rehydrate is a best-effort boot
  // task; running it against a draining pool just logs a spurious fatal.
  if (isShuttingDown) return;
  try {
    const r = await rehydrateInMemoryStemma({
      pool,
      stemma: codeRepoMount.adapters.stemma,
      // Wave 22: scaffold-on-rehydrate so existing repos come back with the
      // v2 file tree, not as empty branches. Without this the file viewer
      // renders blank for every repo created before the current process boot.
      template: codeRepoMount.adapters.template,
      logger: (event, meta) =>
        logger.info({ event, ...(meta ?? {}) }),
    });
    if (r.applied && (r.rehydrated > 0 || r.failed > 0)) {
      logger.info({
          event: "code-repos.rehydrate.summary",
          rehydrated: r.rehydrated,
          skipped: r.skipped,
          failed: r.failed,
          total: r.total,
        });
    }
  } catch (err) {
    logger.error({
        event: "code-repos.rehydrate.fatal",
        message: (err as Error).message,
      });
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

// Pipeline Builder app home — composite recents ∪ favorites read for
// /pipeline (mirrors /api/v1/workshop/modules:activity). User-scoped, so it
// is mounted at /api/v1 rather than under /api/v1/projects/:projectId.
import pipelinesActivityRouter from "./routes/pipelinesActivity";
app.use("/api/v1", pipelinesActivityRouter);

// Workshop B01 — module CRUD with ETag/If-Match optimistic concurrency.
// Spec: tasks/workshop/workshop-tasks.md §B01. Mounted under the spec's
// `/api/v1/workshop` prefix (separate from `/api/v1` so the surface stays
// versioned independently of the existing Foundry-shaped APIs).
import workshopModulesRouter from "./routes/workshopModules";
app.use("/api/v1/workshop", workshopModulesRouter);

// Workshop Comments widget (docs: workshop/widgets-comments). Same mount
// prefix as modules; every handler re-verifies parent-object read access
// through the security-filtered object fetch before serving a thread.
import workshopCommentsRouter from "./routes/workshopComments";
app.use("/api/v1/workshop", workshopCommentsRouter);

// Quiver B1 — analysis CRUD (Phase 1).
// Spec: tasks/quiver/quiver-tasks.md §B1. Phase-flagged via TELLUS_QUIVER_PHASE.
// Mounted at /quiver/api/v1 to mirror the spec's base-path verbatim.
import { buildQuiverRouter } from "./routes/quiver";
app.use("/quiver/api/v1", buildQuiverRouter());

// Code Assistant — secure proxy to the telos-AIE-agent AI engine for the
// TypeScript Functions v2 coding assistant and Workshop Vega generation.
// Frontend posts to /api/v1/code-assistant/{typescript-v2|vega-chart}; this
// route forwards to the matching telos-AIE-agent route and wraps the engine's
// {response, _metadata} in the {success, data} envelope. The
// frontend never learns the AI engine URL. Two-layer auth (same pattern as
// /api/v1/code-repositories): globalAuth allowlists the prefix so the
// CODE_ASSISTANT_TEST_AUTH test-principal bypass works in CI; the router's
// own requireCodeAssistantAuth enforces real JWT/PAT in production.
import { createCodeAssistantRouter } from "./routes/codeAssistant";
// Exempt from the global 5s data-plane budget (above) and give the streaming
// LLM call its own longer ceiling (default 5 min) so a slow agentic loop does
// not 504. The engine fetch is separately bounded by AI_ENGINE_TIMEOUT_MS.
app.use(
  "/api/v1/code-assistant",
  requestTimeoutMiddleware({
    timeoutMs: Number(
      process.env.CODE_ASSISTANT_REQUEST_TIMEOUT_MS ?? 300000,
    ),
  }),
);
app.use("/api/v1/code-assistant", createCodeAssistantRouter());

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
// Idempotency-Key middleware: when the FE sends a UUIDv4 in the
// `Idempotency-Key` header, the same key replays the cached 202 +
// signalId without emitting a duplicate `editBatchPending` signal.
//
// Why this is required and `isCommitting` (FE) alone isn't:
//   - Two browser tabs open on the same OT can each fire a Save POST
//     concurrently. The FE in-flight lock is per-component-instance,
//     not cross-tab.
//   - axios retries on transient failures (e.g., network hiccup after
//     the backend received the request but before the response made
//     it back). Without idempotency, the retry creates a duplicate
//     funnel run.
//   - Browser back/forward navigation that unmounts and remounts the
//     editor mid-flight resets `isCommitting` to false; a follow-up
//     click would emit a second signal.
//
// The middleware sits BEFORE the resolver so a malformed key
// short-circuits with 400 INVALID_ARGUMENT without touching the DB.
app.post(
  "/api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId",
  idempotencyKeyMiddleware(pool, "POST /ontology/{ontologyId}/objectTypeId/{objectTypeId}"),
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
  "/api/v1/ontology/:ontologyId/interfaceLinkConstraints",
  interfaceLinkConstraintRouter
);
app.use(
  "/api/v1/ontology/:ontologyId/webhooks",
  webhookRouter
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

// ---------------------------------------------------------------------------
// OSS v2 / OSv2 / OMS v2 surface (canonical ObjectSet engine).
// Thin adapters — same securityContext + branch middleware as v1.
// ---------------------------------------------------------------------------
// Foundry-parity attachment upload (no :ontology segment — public path is
// /api/v2/ontologies/attachments/upload) plus the upload-only media picker.
// Mounted before the :ontology routers so `attachments` / `media` are never
// swallowed into the ontology-parameter slot; non-matching sub-paths fall
// through to the :ontology routers below regardless.
app.use("/api/v2/ontologies", attachmentsV2Router);
app.use("/api/v2/ontologies/:ontology/media", mediaV2Router);
app.use("/api/v2/ontologies/:ontology", objectSetsV2Router);
app.use("/api/v2/ontologies/:ontology", objectsV2Router);
app.use("/api/v2/ontologies/:ontology", linksV2Router);
app.use("/api/v2/ontologies/:ontology", actionsV2Router);
app.use("/api/v2/ontologies/:ontology", omsV2Router);
app.use(healthRouter);

// ---------------------------------------------------------------------------
// Ontology Platform spec Phase 2 — branching, groups, functions, favorites,
// saved explorations, exports, summary, geo, comparisons, schema migrations.
// ---------------------------------------------------------------------------
app.use("/api/v1/ontology/:ontologyId/branches", branchesRouter);
app.use("/api/v1/ontology/:ontologyId/working-state", ontologyWorkingStateRouter);
app.use("/api/v1/ontology/:ontologyId/groups", groupsRouter);
// DECOMMISSIONED (vuln-0041): the legacy /api/v1/ontology/:ontologyId/functions
// router (src/routes/functions.ts) registered+executed arbitrary TypeScript
// with NO publish gate and an in-process Node `vm` that is trivially escaped
// via the constructor chain — a low-priv viewer achieved host command
// execution. The canonical Functions registry (/api/v1/functions) and the
// code-repositories invoke path (gated by authorizePublish) replace it.
// app.use("/api/v1/ontology/:ontologyId/functions", functionsRouter);
app.use("/api/v1/ontology/:ontologyId/explorations", explorationsRouter);
app.use("/api/v1/ontology/:ontologyId/exports", exportsRouter);
app.use("/api/v1/ontology/:ontologyId/summary", summaryRouter);
app.use("/api/v1/ontology/:ontologyId/geo", geoRouter);
app.use("/api/v1/ontology/:ontologyId/comparisons", comparisonsRouter);
app.use("/api/v1/ontology/:ontologyId/migrations", migrationManagerRouter);
app.use("/api/v1/ontology/:ontologyId/governance", governanceRouter);
// FOUNDRY-GAPS §8 — purpose-based access control: purpose catalogue + grants.
// Enforcement on data-plane reads is via purposeGate middleware (env-gated
// by TELLUS_PURPOSE_ENFORCEMENT=on; default off).
app.use("/api/v1/ontology/:ontologyId/purposes", purposesRouter);
app.use("/api/v1/users/me/favorites", favoritesRouter);

// New Palantir-stack endpoints (Furnace SQL, Polars charts, Funnel pipeline status).
app.use("/api/v1", sqlRouter);
app.use("/api/v1", chartsRouter);
app.use("/api/v1", pipelinesStatusRouter);

// Tellus Connectivity v2 — B1 wave.
// Routes: POST/GET/PUT/DELETE /api/v1/connectivity/connections + /:rid/{configuration,status}
// The Compass outbox poller starts via initConnectivity() below; gated by
// TELLUS_DISABLE_CONNECTIVITY_POLLER=1 for unit-test workers that should
// not dispatch.
app.use("/api/v1/connectivity", connectivityRouter);
initConnectivity();
app.use("/api/v1/funnel", funnelRouter);

// ---------------------------------------------------------------------------
// Foundry Data Ingestion Layer routes (BE-003 through BE-030)
// These run alongside the ontology engine routes on the same Express app.
// ---------------------------------------------------------------------------
app.use("/api/v1/projects", foundryProjectsRouter);
app.use("/api/v1/projects/:projectId/folders", foundryFoldersRouter);
app.use("/api/v1/projects/:projectId/folders/:folderId", foundryUploadsRouter);
app.use("/api/v1/projects/:projectId", foundryProjectUploadsRouter);
// Project workspace sub-tabs: trashed listing + file/external references.
// Mounted at /api/v1/projects/:projectId so handlers can read req.params.projectId.
app.use("/api/v1/projects/:projectId", projectWorkspaceRouter);
app.use("/api/v1/projects", autosaveProjectRouter);
app.use("/api/v1/resources", autosaveResourceRouter);
// Resource lifecycle (restore, permanently-delete) is RID-scoped, not project-scoped.
app.use("/api/v1/resources", resourceLifecycleRouter);
app.use("/api/v1/projects/:projectId/folders/:folderId/datasets", foundryFolderDatasetsRouter);
app.use("/api/v1/datasets", foundryDatasetRouter);
app.use("/api/v1/datasets", foundryColumnStatsRouter);
app.use("/api/v1/datasets", foundryVersionsRouter);
app.use("/api/v1/datasets", datasetDeduplicateRouter);
app.use("/api/v1/projects", projectDuplicatesRouter);
app.use("/api/v1/search", foundrySearchRouter);
app.use("/api/v1/breadcrumb", foundryBreadcrumbRouter);
// Advisory upload-progress poll endpoint (polled by the FE while a multipart
// upload POST is in flight, to show the server→S3 streaming phase). See
// src/routes/uploadProgress.ts + src/services/uploadProgress.ts.
app.use("/api/v1/uploads", foundryUploadProgressRouter);
// Palantir Multipass-equivalent auth surface (see ontology/tellus-auth.md).
// The legacy /api/auth/{register,login,refresh,logout} router was retired
// in Phase 3; /api/v1/auth is the only supported authentication entry point.
app.use("/api/v1/auth", tellusAuthV1Router);

// Palantir Foundry Developer Console (third-party applications / OSDK apps).
// See tellus-fe/docs/developer-console/BACKEND_PALANTIR_PARITY.md
app.use("/api/v1/developer-console", developerConsoleRouter);

// Dev-only: Cypress's MFA cleanup hooks live under /api/v1/auth/_test.
// Mount conditionally so production bundles never expose the router at all.
// SECURITY (vuln: unauth MFA-reset account takeover): these hooks DELETE
// second factors, so mounting them requires BOTH the dev NODE_ENV AND the
// explicit TELLUS_AUTH_TEST_HOOKS=1 opt-in — a dev/staging box that only
// wants the rate-limiter reset (TELLUS_TEST_HOOKS) must not automatically
// also expose credential-mutation hooks. Each handler additionally
// re-checks the X-Tellus-Test-Hook header + loopback TCP peer.
if (
  process.env.NODE_ENV !== "production" &&
  process.env.TELLUS_AUTH_TEST_HOOKS === "1"
) {
  app.use("/api/v1/auth/_test", tellusAuthTestHooksRouter);
}
app.use("/api/v1/projects/:projectId/members", foundryMembersRouter);
app.use("/api/v1/projects/:projectId/pipelines", foundryPipelinesRouter);

// ---------------------------------------------------------------------------
// Compass Children Gateway — single fan-out endpoint that powers the
// project / folder workspace pages. Replaces the per-service list calls
// the FE used to make against /v1/projects/:id/{folders,datasets,...}.
//
//   GET /api/v1/compass/folders/:folderRid/children
// ---------------------------------------------------------------------------
app.use("/api/v1/compass", compassChildrenRouter);

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
    logger.error({
      type: "auth_challenge_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await purgeExpiredReauthTokens();
  } catch (err) {
    logger.error({
      type: "reauth_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await flushEmailOutbox();
  } catch (err) {
    logger.error({
      type: "email_flush_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    // Drop expired + consumed passkey enrollment rows so a leaked
    // stashed refresh token has a bounded lifetime even if the
    // happy-path consume() didn't fire.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getPasskeyEnrollmentService(foundryDb as any).purgeExpired();
  } catch (err) {
    logger.error({
      type: "passkey_enrollment_sweep_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}, 60_000);
if (typeof authMaintenanceSweeper.unref === "function") authMaintenanceSweeper.unref();

// ---------------------------------------------------------------------------
// Process-level error handlers — prevent silent crashes
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason: unknown) => {
  logger.error({
    type: "unhandled_rejection",
    timestamp: new Date().toISOString(),
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Do NOT shutdown for unhandled rejections — log and continue
});

process.on("uncaughtException", (err: Error) => {
  logger.error({
    type: "uncaught_exception",
    timestamp: new Date().toISOString(),
    error: err.message,
    stack: err.stack,
  });
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
      logger.info({
          type: "migration_gate.ok",
          mode: gateResult.mode,
          appliedDuringRun: gateResult.appliedDuringRun.length,
          pendingBefore: gateResult.pending.length,
          durationMs: gateResult.durationMs,
        });
    } catch (gateErr) {
      if (gateErr instanceof MigrationDriftError) {
        logger.error({
            type: "migration_gate.drift",
            pending: gateErr.pending,
            message: gateErr.message,
          });
      } else {
        logger.error({
            type: "migration_gate.error",
            error: gateErr instanceof Error ? gateErr.message : String(gateErr),
          });
      }
      // Refusing to start the server — drift / apply failure must
      // be treated as a deploy bug, not a soft warning.
      await pool.end().catch(() => {
        /* ignored — already shutting down */
      });
      process.exit(1);
    }

    // Schema contract — verifies that every column the codebase writes
    // to via raw SQL exists on the live DB. Catches the class of bug
    // where a column rename / removal lands without an accompanying SQL
    // edit. Runs after the migration gate so any pending migrations are
    // already applied.
    try {
      await enforceSchemaContract(pool);
    } catch (contractErr) {
      if (contractErr instanceof SchemaContractError) {
        logger.error({
            type: "schema_contract.refused",
            violations: contractErr.violations,
            message: contractErr.message,
          });
      } else {
        logger.error({
            type: "schema_contract.error",
            error:
              contractErr instanceof Error
                ? contractErr.message
                : String(contractErr),
          });
      }
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
      logger.warn(
        `WARNING: Could not ensure OpenSearch index template: ${msg}`
      );
    }

    // Ensure the S3/MinIO bucket exists (creates if missing).
    // Best-effort — server still starts if MinIO is unreachable.
    try {
      await ensureBucket();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
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
      logger.warn(
        `WARNING: K8s infra bootstrap failed (degraded mode): ${(err as Error).message}`,
      );
    }

    server = app.listen(PORT, () => {
      logger.info(
        `Ontology Engine started on port ${PORT} | PostgreSQL connected`
      );
      // Operator visibility into the Function publish authorization policy:
      // trust mode, publish role, live grant count, and whether the
      // deprecated env allowlist is still configured. Never blocks boot.
      void logFunctionPublishPolicySummary(pool);
    });
    if (process.env.FUNCTIONS_PUBLISH_SERVICE_DISABLED !== "true") {
      functionsPublishService.start();
    }
    if (process.env.AUTOMATE_RUNTIME_DISABLED !== "true") {
      startAutomateRuntime();
      logger.info("Automate durable scheduler and worker started");
    }
    // Rwanda QA §7.3: independent one-minute, durable policy evaluator.
    // It is independently switchable for focused clean browser suites, whose
    // fixture ingestion creates transient routes before the scenario under
    // test starts. Production keeps this enabled by default.
    if (process.env.PINDO_AUTOMATION_DISABLED !== "true") {
      const runPindo = () => void runRwandaPindoAutomationOnce().catch((error) =>
        logger.error({ err: error }, "rwanda-pindo-automation failed"),
      );
      runPindo();
      const pindoTimer = setInterval(runPindo, 60_000);
      pindoTimer.unref();
      logger.info("Rwanda Pindo automation scheduler started");
    }

    if (process.env.DEVELOPER_CONSOLE_WORKERS_DISABLED !== "true") {
      startDeveloperConsoleReconciliationWorker(foundryDb as unknown as import('knex').Knex);
      startDeveloperConsoleArtifactBuildWorker(foundryDb as unknown as import('knex').Knex);
    }

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
        logger.info("Funnel dispatcher started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start Funnel dispatcher: ${(err as Error).message}`
      );
    }

    // Transactional outbox drainer for link CDC (OSv2 parity): publishes
    // outbox rows committed inside Action transactions to Kafka with
    // bounded backoff; restart-safe and dead-letters after max attempts.
    try {
      if (process.env.LINK_CDC_DRAINER_DISABLED !== "true") {
        stopLinkCdcDrainer = startLinkCdcDrainer();
        logger.info("Link CDC outbox drainer started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start link CDC drainer: ${(err as Error).message}`
      );
    }

    // Start Asynchronous Multi-Source Compilation Worker
    try {
      if (process.env.DATASOURCE_COMPILER_CONSUMER_DISABLED !== "true") {
        const { startDatasourceCompilerConsumer } = require("./services/orchestration/datasource-compiler-consumer");
        startDatasourceCompilerConsumer();
        logger.info("Multi-Source Compilation Worker started");
      }
    } catch (err) {
      logger.warn(`WARNING: could not start Multi-Source Compilation Worker: ${(err as Error).message}`);
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
        logger.info(
          `Swept ${orphans.sweptIds.length} orphan pipeline_deployment(s) from prior restart`
        );
      }
    } catch (err) {
      logger.warn(
        `WARNING: pipeline orphan sweep failed: ${(err as Error).message}`
      );
    }
    try {
      if (process.env.PIPELINE_DISPATCHER_DISABLED !== "true") {
        startPipelineDispatcher();
        logger.info("Pipeline dispatcher started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start Pipeline dispatcher: ${(err as Error).message}`
      );
    }

    // Foundry build schedules — pipelines with schedule_enabled=true are
    // rebuilt every interval through the regular deploy path.
    try {
      startPipelineBuildScheduler();
      logger.info("Pipeline build scheduler started");
    } catch (err) {
      logger.warn(
        `WARNING: could not start Pipeline build scheduler: ${(err as Error).message}`
      );
    }

    // PB-B4 — Iceberg compaction + expiration loop for _pipeline.* tables.
    // Best-effort: skipped when PyIceberg sidecar is unreachable.
    try {
      if (process.env.PIPELINE_ICEBERG_MAINTENANCE_DISABLED !== "true") {
        startIcebergMaintenance();
        logger.info("Iceberg maintenance loop started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start Iceberg maintenance: ${(err as Error).message}`
      );
    }

    // Phase 3: resume opensearch_reindex_run rows orphaned by a prior
    // worker restart. Unlike funnel_run (which is swept to 'failed'),
    // these are RESUMED — the executor's resume-skip continues from the
    // last `indexed_count` checkpoint instead of restarting from zero
    // (the whole point of gap 2). Only active when the pipeline is enabled.
    try {
      const { resumeOrphanedOsReindexRuns } = await import(
        "./services/indexing/osReindexRun"
      );
      const resumed = await resumeOrphanedOsReindexRuns();
      if (resumed > 0) {
        logger.info(
          `Resumed ${resumed} orphaned opensearch_reindex_run row(s) from last checkpoint`
        );
      }
    } catch (err) {
      logger.warn(
        `WARNING: orphaned opensearch_reindex_run resume failed: ${(err as Error).message}`
      );
    }

    // B3: Temporal worker. When Temporal is reachable this is the
    // authoritative execution path; the PG-backed dispatcher above
    // becomes a fallback used only when `isTemporalConnected()` is
    // false at signal time.
    void (async () => {
      // The worker start is wrapped on its own so a failure here is logged but
      // does NOT skip the orphan sweep below — the sweep matters most exactly
      // when the worker is dead or disabled, because that is when rows are
      // left stranded at status='running'.
      try {
        const ok =
          process.env.TEMPORAL_WORKER_DISABLED === "true"
            ? false
            : await startTemporalWorker();
        if (ok) {
          const { getWorkerDiagnostics } = await import(
            "./services/funnel/temporal/worker"
          );
          const diag = getWorkerDiagnostics();
          logger.info(
            `Temporal worker registered on ${diag.identity?.temporalNamespace}/${diag.identity?.temporalTaskQueue} ` +
              `(env=${diag.identity?.environmentId} db=${diag.dbEnvironmentId} build=${diag.identity?.workerBuildId})`,
          );
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
            logger.info(
              `PB-B4 iceberg maintenance schedule: scheduled=${r.scheduled}${
                r.reason ? ` (${r.reason})` : ""
              }`,
            );
          } catch (err) {
            logger.warn(
              `WARNING: could not ensure PB-B4 maintenance schedule: ${(err as Error).message}`,
            );
          }
        } else {
          logger.info("Temporal unreachable — PG-backed dispatcher remains primary");
        }
      } catch (err) {
        logger.warn(
          `WARNING: Temporal worker failed to start: ${(err as Error).message}`
        );
      }

      // B3: Sweep funnel_run rows orphaned by a prior worker restart.
      // A SIGKILL / OOM / container restart mid-activity leaves rows at
      // status='running' that the UI polls and shows stuck on "sync"
      // forever. Close them out so every save-to-ontology click after a
      // restart starts from a clean slate.
      //
      // ORDER MATTERS, and it used to be wrong: this ran ~40 lines earlier,
      // BEFORE startTemporalWorker(). sweepOrphanedFunnelRuns prefers
      // Temporal visibility (a run is orphaned only if no live workflow
      // matches it) and falls back to a 4h05m age heuristic when the client
      // is absent. Running it pre-connect meant getTemporalClient() returned
      // null every single time, so the visibility path was unreachable dead
      // code and EVERY boot swept by age alone — which cannot distinguish a
      // dead run from a legitimately long one, so a >4h indexing pass on a
      // large object type got declared failed and its signals re-queued
      // while the activity was still running, producing a concurrent
      // duplicate pass over the same data.
      //
      // Awaited after the worker attempt resolves, on EVERY path — success,
      // unreachable, thrown, or TEMPORAL_WORKER_DISABLED. On success
      // visibility is live and precise; otherwise we degrade to the age
      // heuristic, which is what the old pre-connect placement silently always
      // did.
      try {
        const { sweepOrphanedFunnelRuns } = await import(
          "./services/funnel/durableWorkflow"
        );
        const swept = await sweepOrphanedFunnelRuns();
        if (swept.sweptRunIds.length > 0) {
          logger.info(
            `Swept ${swept.sweptRunIds.length} orphaned funnel_run row(s) + ${swept.sweptStageRuns} stage(s) from prior worker restart`
          );
        }
      } catch (err) {
        logger.warn(
          `WARNING: orphaned funnel_run sweep failed: ${(err as Error).message}`
        );
      }
      // Release funnel_state 'indexing' locks whose owner cannot be alive:
      // heartbeat older than the boot grace AND linked run terminal-or-
      // missing. Locks whose run is still 'running' are left alone — Temporal
      // may resume them after restart. Idempotent; safe on every boot.
      try {
        const { reconcileStaleIndexingLocks } = await import(
          "./services/funnel/indexingLease"
        );
        const { released } = await reconcileStaleIndexingLocks();
        if (released.length > 0) {
          logger.info(
            `Released ${released.length} stale indexing lock(s) at boot: ${released.join(", ")}`
          );
        }
      } catch (err) {
        logger.warn(
          `WARNING: stale indexing-lock reconcile failed: ${(err as Error).message}`
        );
      }
    })();
    try {
      if (process.env.OVERLAY_SWEEPER_DISABLED !== "true") {
        startOverlaySweeper();
        logger.info("Overlay sweeper started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start overlay sweeper: ${(err as Error).message}`
      );
    }

    // Serving edit projector: drains the ontology_edit WAL into the
    // OpenSearch serving indexes so Action-created/-modified objects become
    // queryable within seconds (the writeback overlay only covers the
    // read-your-writes window). Without it, Action commits were durably
    // stored but never reached object serving in this topology.
    try {
      if (process.env.SERVING_PROJECTOR_DISABLED !== "true") {
        startServingProjector();
        logger.info("Serving edit projector started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start serving projector: ${(err as Error).message}`
      );
    }

    // Attachment lifecycle sweeper (Foundry upload-attachments parity):
    // uploads never linked to an object via an action within 1h are
    // removed (bytes + row). Candidates referenced by any object instance
    // are never touched. Kill-switch: ATTACHMENT_SWEEPER_DISABLED=true;
    // observe-only: ATTACHMENT_SWEEP_DRY_RUN=true.
    try {
      if (process.env.ATTACHMENT_SWEEPER_DISABLED !== "true") {
        startAttachmentSweeper();
        logger.info("Attachment sweeper started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start attachment sweeper: ${(err as Error).message}`
      );
    }

    // B9: start the replacement pipeline scheduler. Every 60s it
    // evaluates SOAK gates and fires cutover when eligible, plus drops
    // the old index after its 48h retention window. Without this, the
    // state machine stays stuck at REPLACEMENT_SOAK forever.
    try {
      if (process.env.REPLACEMENT_SCHEDULER_DISABLED !== "true") {
        startReplacementScheduler();
        logger.info("Replacement scheduler started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start replacement scheduler: ${(err as Error).message}`
      );
    }

    // Phase 5 — durable side-effect outbox worker. Action types with
    // `side_effects` produce rows in `action_side_effect_job` inside
    // the audit transaction; this background worker drains the queue
    // via webhookSafeTransport + the registered NotificationProviders.
    // Durable post-commit delivery is the production default. Operators can
    // explicitly opt into the legacy in-process path with
    // ACTION_SIDE_EFFECT_WORKER_ENABLED=0.
    try {
      if (process.env.ACTION_SIDE_EFFECT_WORKER_ENABLED !== "0") {
        const { runWorkerLoop } = await import("./services/workers/sideEffectWorker");
        const controller = new AbortController();
        void runWorkerLoop({
          intervalMs: parseInt(process.env.ACTION_SIDE_EFFECT_WORKER_INTERVAL_MS ?? "2000", 10),
          limit: parseInt(process.env.ACTION_SIDE_EFFECT_WORKER_BATCH ?? "16", 10),
          signal: controller.signal,
        });
        logger.info("Side-effect outbox worker started");
      }
    } catch (err) {
      logger.warn(
        `WARNING: could not start side-effect outbox worker: ${(err as Error).message}`,
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
          logger.warn("Lakekeeper unreachable — Iceberg catalog falls back to PG shim");
        } else {
          logger.info(
            `Lakekeeper bootstrap: warehouse=${lk.warehouseId} funnel_namespaces=${lk.namespacesCreated}/${lk.objectTypesConsidered * 4} pipeline_namespaces=${lk.pipelineNamespacesCreated}/${lk.pipelinesConsidered}`
          );
          // PB-B4 — ensure the `tellus-pipeline` warehouse exists as
          // well. Pipeline data writes land here (separate from
          // `tellus-funnel` so remote-signing can be disabled per
          // warehouse without affecting the funnel). Reuses the SAME
          // lakekeeperClient via pipelines/lakekeeperBootstrap.
          try {
            const pw = await ensurePipelineWarehouse();
            logger.info(`Lakekeeper pipeline bootstrap: warehouse=${pw}`);
          } catch (err) {
            logger.warn(
              `WARNING: Lakekeeper pipeline warehouse bootstrap failed: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        logger.warn(`WARNING: Lakekeeper bootstrap failed: ${(err as Error).message}`);
      }
    });

    // B10: ensure ClickHouse link tables mirror every registered
    // link_type. Best-effort — a missing ClickHouse just leaves
    // traversal queries unserved until next refresh.
    trackBootTask(async () => {
      try {
        const result = await ensureLinkTablesForAllLinkTypes();
        if (result.skippedUnreachable) {
          logger.warn("ClickHouse unreachable — link tables not bootstrapped");
        } else {
          logger.info(
            `ClickHouse link tables ensured: ${result.tablesEnsured}/${result.linkTypesFound}`
          );
        }
      } catch (err) {
        logger.warn(
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
        logger.warn(
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
            logger.warn(
              `[bootstrap] superadmin email ${email} not found in Keycloak; skipping role grant (set NODE_ENV!=production to auto-create)`
            );
            return;
          }
          const userId = await kc.createUser({
            username: email,
            email,
            // The realm requires non-blank firstName/lastName for direct-grant
            // (see keycloakAdminService.createUser). The bootstrap has no real
            // name, so default to a role label the operator personalizes via
            // /settings/profile; allow env override for deployments that know
            // the operator's name.
            firstName: process.env.TELLUS_SUPERADMIN_FIRST_NAME || 'Tellus',
            lastName: process.env.TELLUS_SUPERADMIN_LAST_NAME || 'Administrator',
            password,
            enabled: true,
            emailVerified: true,
          });
          user = { id: userId, email, username: email };
          logger.info(`[bootstrap] created superadmin user ${email}`);
        } else if (autoCreate) {
          // Existing account: reconcile its Keycloak password with the
          // current TELLUS_SUPERADMIN_PASSWORD. The create-time password is
          // set ONCE; a later env rotation never reaches an already-created
          // user, so the credential drifts and login starts failing with
          // `invalid_grant`. Non-prod only — production must not silently
          // overwrite an operator-managed credential (autoCreate is false
          // there), so this is gated behind the same NODE_ENV check.
          await kc.resetPassword(user.id, password);
          logger.info(`[bootstrap] reconciled superadmin password for ${email}`);
        }
        await kc.assignRealmRoleToUser(user.id, TELLUS_SUPERADMIN_ROLE);
        logger.info(
          `[bootstrap] tellus-superadmin role ensured + granted to ${email}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[bootstrap] superadmin role bootstrap failed: ${msg}`);
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
          logger.info(`Idempotency cleanup: removed ${deleted} expired keys`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Idempotency cleanup error: ${msg}`);
      }
    }, SIX_HOURS_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(`FATAL: Cannot connect to PostgreSQL: ${message}`);
    process.exit(1);
  }
}

/**
 * Graceful shutdown: stop accepting new connections, wait for in-flight
 * requests to complete, then drain the PostgreSQL connection pool.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info(`${signal} received again — shutdown already in progress`);
    return;
  }

  isShuttingDown = true;

  logger.info({
    type: "shutdown_initiated",
    timestamp: new Date().toISOString(),
    signal,
    activeRequests,
  });

  if (server) {
    server.close(() => {
      logger.info({ type: "server_closed", timestamp: new Date().toISOString() });
    });
  }

  // Wait for in-progress requests to complete (max 25 seconds)
  const maxWait = 25_000;
  const startWait = Date.now();
  while (activeRequests > 0 && (Date.now() - startWait) < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    logger.info({ type: "shutdown_waiting", activeRequests, elapsed: Date.now() - startWait });
  }

  if (activeRequests > 0) {
    logger.warn({ type: "shutdown_forced", activeRequests, message: "Forcing shutdown with active requests" });
  }

  // Destroy the action rate limiter to prevent dangling setInterval
  limiter.destroy();

  // The auth-maintenance sweep queries the foundry pool on a 60s timer; clear
  // it before the drain so it can't fire against an ended pool.
  clearInterval(authMaintenanceSweeper);
  functionsPublishService.stop();

  // Quiesce background workers / timers BEFORE draining the DB pools. Each of
  // these runs a self-scheduling loop (FOR UPDATE SKIP LOCKED claimers, sweep
  // ticks) that would otherwise keep issuing queries against a pool we are
  // about to `end()`, racing the drain and logging spurious errors. Stop them
  // first, tolerate individual failures, and keep going — shutdown must not
  // hang on one misbehaving worker. The connectivity health prober is included
  // because its recordStatus() writes to the foundry pool every tick.
  const workerStops: Array<[string, () => unknown]> = [
    ["automateRuntime", stopAutomateRuntime],
    ["developerConsoleArtifactBuilder", stopDeveloperConsoleArtifactBuildWorker],
    ["developerConsoleReconciler", stopDeveloperConsoleReconciliationWorker],
    ["funnelDispatcher", stopFunnelDispatcher],
    ["pipelineDispatcher", stopPipelineDispatcher],
    ["overlaySweeper", stopOverlaySweeper],
    ["servingProjector", stopServingProjector],
    ["linkCdcDrainer", () => stopLinkCdcDrainer?.()],
    ["replacementScheduler", stopReplacementScheduler],
    ["icebergMaintenance", stopIcebergMaintenance],
    ["temporalWorker", stopTemporalWorker],
    ["healthProber", stopHealthProber],
  ];
  for (const [name, stop] of workerStops) {
    try {
      await Promise.resolve(stop());
    } catch (err) {
      logger.error({
        type: "worker_stop_error",
        worker: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Quit the Redis rate-limiter client, cache-invalidation bus and Kafka
  // producer cleanly so their sockets/timers don't keep the event loop alive.
  try {
    const { shutdownK8sInfra } = await import("./boot/cacheAndRateLimit");
    await shutdownK8sInfra();
  } catch (err) {
    logger.error({ type: "k8s_infra_shutdown_error", error: err instanceof Error ? err.message : String(err) });
  }
  try {
    await shutdownKafka();
  } catch (err) {
    logger.error({ type: "kafka_shutdown_error", error: err instanceof Error ? err.message : String(err) });
  }

  // Close foundry WebSocket connections
  const wss = getWss();
  if (wss) {
    logger.info({ type: "foundry_ws_closing" });
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
      logger.info({ type: "foundry_datasets_reset", count: resetCount });
    }
  } catch (err) {
    logger.error({ type: "foundry_datasets_reset_error", error: err instanceof Error ? err.message : String(err) });
  }

  // Destroy S3/MinIO client
  try {
    destroyStorageClient();
    logger.info({ type: "s3_client_destroyed" });
  } catch (err) {
    logger.error({ type: "s3_client_destroy_error", error: err instanceof Error ? err.message : String(err) });
  }

  // Drain foundry database connection pool
  try {
    await foundryDb.destroy();
    logger.info({ type: "foundry_db_disconnected" });
  } catch (err) {
    logger.error({ type: "foundry_db_disconnect_error", error: err instanceof Error ? err.message : String(err) });
  }

  // Stop connectivity background workers (outbox poller, credential rotation,
  // health prober, table-import scheduler, webhook reaper) and drain the
  // per-source PG pools. Must run BEFORE pool.end(): the prober and rotation
  // worker write to the main pool, so leaving them ticking past this point
  // produces "Cannot use a pool after calling end" noise on every shutdown.
  try {
    await shutdownConnectivity();
    logger.info({ type: "connectivity_shutdown" });
  } catch (err) {
    logger.error({ type: "connectivity_shutdown_error", error: err instanceof Error ? err.message : String(err) });
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
    logger.info({ type: "postgresql_disconnected" });
  } catch (err) {
    logger.error({ type: "postgresql_disconnect_error", error: err instanceof Error ? err.message : String(err) });
  }

  logger.info({ type: "shutdown_complete", timestamp: new Date().toISOString() });
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// nodemon restarts its child with SIGUSR2; the Temporal worker Runtime also
// consumes SIGUSR2/SIGQUIT as graceful-shutdown signals (SDK default
// shutdownSignals: SIGINT/SIGTERM/SIGQUIT/SIGUSR2). Without handlers here the
// Runtime swallows the signal, the process survives as a zombie (API up, no
// worker), and the Runtime stays in SHUTTING_DOWN state forever — every
// subsequent Worker.create() is drained within milliseconds (infinite
// restart loop). Exit cleanly so the supervisor reruns the process.
process.on("SIGUSR2", () => shutdown("SIGUSR2"));
process.on("SIGQUIT", () => shutdown("SIGQUIT"));

start();

export default app;
