import "dotenv/config";
import http from "http";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pool, query } from "./db";
import requestLogger from "./middleware/requestLogger";
import { inputSanitizer } from "./middleware/inputSanitizer";
import { notFoundHandler, createDocsRouter } from "./middleware/notFoundHandler";
import errorHandler from "./middleware/errorHandler";
import ontologyRouter from "./routes/ontology";
import objectTypeRouter from "./routes/objectTypes";
import propertyRouter from "./routes/properties";
import datasourceRouter, { suggestMappingRouter } from "./routes/datasources";
import indexingRouter from "./routes/indexing";
import linkRouter from "./routes/links";
import actionTypeRouter from "./routes/actionTypes";
import actionsRouter, { validateRouter, batchRouter } from "./routes/actions";
import { actionAuditRouter, globalAuditRouter } from "./routes/auditLog";
import objectsRouter from "./routes/objects";
import healthRouter from "./routes/health";
import editsRouter from "./routes/edits";
import bulkActionsRouter from "./routes/bulkActions";
import reindexStatusRouter from "./routes/reindexStatus";
import dataPreviewRouter from "./routes/dataPreview";
import datasetRouter from "./routes/datasets";
import reindexRouter from "./routes/reindex";
import interfaceRouter from "./routes/interfaces";
import objectTypeInterfacesRouter from "./routes/objectTypeInterfaces";
import objectViewsRouter, { objectViewsByTypeRouter } from "./routes/objectViews";
import { ensureIndexTemplate } from "./services/opensearch/templateRegistry";

// Foundry data ingestion layer routes (BE-003 through BE-030)
import foundryProjectsRouter from "./routes/projects";
import foundryFoldersRouter from "./routes/folders";
import foundryUploadsRouter from "./routes/uploads";
import { folderDatasetsRouter as foundryFolderDatasetsRouter, datasetRouter as foundryDatasetRouter } from "./routes/foundryDatasets";
import foundrySearchRouter from "./routes/search";
import foundryBreadcrumbRouter from "./routes/breadcrumb";
import foundryAuthRouter from "./routes/auth";
import foundryMembersRouter from "./routes/members";
import foundryColumnStatsRouter from "./routes/columnStats";
import foundryVersionsRouter from "./routes/versions";
import { projectDuplicatesRouter, datasetDeduplicateRouter } from "./routes/duplicates";
import foundryPreferencesRouter from "./routes/preferences";
import { initWebSocketServer } from "./websocket/server";
import { setupSwagger as setupFoundrySwagger } from "./docs/openapi";
import { cleanupExpiredKeys } from "./actions/idempotency";
import { limiter } from "./middleware/rateLimiter";
import { serverTiming } from './middleware/serverTiming';
import { contentLanguage } from './middleware/contentLanguage';
import swaggerUi from "swagger-ui-express";
import * as fs from "fs";
import * as path from "path";

// Load OpenAPI spec JSON at startup
const openApiSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, "api-spec", "actions.openapi.json"), "utf-8")
);

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
app.use(serverTiming);
app.use(contentLanguage);

// Compress responses (gzip/brotli)
app.use(compression());

// Rate limiting — configurable requests per minute per IP
// Default: 200 req/min. Override via RATE_LIMIT_MAX env var.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "200", 10);
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  })
);

// Parse JSON request bodies. The 10 MB limit is needed because some API
// requests (like registering a backing datasource with a very large column
// mapping) can have substantial JSON bodies.
app.use(express.json({ limit: "10mb" }));

// CORS — restrict origins via CORS_ORIGINS env var; empty = allow all (dev)
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : undefined; // undefined = allow all origins

app.use(
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["X-Idempotency-Cached", "X-Total-Count", "Server-Timing", "Retry-After", "Content-Language"],
  })
);

// Input sanitization — trim, strip null bytes, normalize Unicode, XSS prevention
app.use(inputSanitizer);

// Structured JSON request/response logging
app.use(requestLogger);

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

// API routers
app.use(ontologyRouter);
app.use("/api/v2/ontologies/:ontologyId/objectTypes", objectTypeRouter);
app.use("/api/v2/ontologies/:ontologyId/objectTypes/:apiName", propertyRouter);
app.use(
  "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource",
  datasourceRouter
);
app.use(
  "/api/v2/ontology/:ontologyId/objectTypes/:apiName/suggestMapping",
  suggestMappingRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index",
  indexingRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/linkTypes",
  linkRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/actionTypes",
  actionTypeRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/actions",
  actionsRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/actions",
  actionAuditRouter
);
app.use("/api/v2/actions", validateRouter);
app.use("/api/v2/actions", batchRouter);
app.use("/api/v2/actions", bulkActionsRouter);
app.use("/api/v2/audit", globalAuditRouter);
app.use(
  "/api/v2/ontology/:ontologyId/objectTypes/:apiName/edits",
  editsRouter
);
app.use(
  "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index",
  reindexStatusRouter
);
app.use("/api/v2/datasets", datasetRouter);
app.use("/api/v2/datasets", dataPreviewRouter);
app.use(
  "/api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex",
  reindexRouter
);
app.use(
  "/api/v2/ontology/:ontologyId/interfaces",
  interfaceRouter
);
app.use(
  "/api/v2/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements",
  objectTypeInterfacesRouter
);
app.use(
  "/api/v2/ontology/:ontologyId/objectTypes/:objectTypeApiName",
  objectViewsRouter
);
app.use("/api/v2/objects/:objectType", objectViewsByTypeRouter);
app.use(objectsRouter);
app.use(healthRouter);

// ---------------------------------------------------------------------------
// Foundry Data Ingestion Layer routes (BE-003 through BE-030)
// These run alongside the ontology engine routes on the same Express app.
// ---------------------------------------------------------------------------
app.use("/api/projects", foundryProjectsRouter);
app.use("/api/projects/:projectId/folders", foundryFoldersRouter);
app.use("/api/projects/:projectId/folders/:folderId", foundryUploadsRouter);
app.use("/api/projects/:projectId/folders/:folderId/datasets", foundryFolderDatasetsRouter);
app.use("/api/datasets", foundryDatasetRouter);
app.use("/api/datasets", foundryColumnStatsRouter);
app.use("/api/datasets", foundryVersionsRouter);
app.use("/api/datasets", datasetDeduplicateRouter);
app.use("/api/projects", projectDuplicatesRouter);
app.use("/api/search", foundrySearchRouter);
app.use("/api/breadcrumb", foundryBreadcrumbRouter);
app.use("/api/auth", foundryAuthRouter);
app.use("/api/projects/:projectId/members", foundryMembersRouter);
app.use("/api/users/me/preferences", foundryPreferencesRouter);

// ---------------------------------------------------------------------------
// API Specification & Documentation
// ---------------------------------------------------------------------------

// GET /api/v2/spec — returns raw OpenAPI JSON
app.get("/api/v2/spec", (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

// GET /api/v2/docs — renders Swagger UI
app.use("/api/v2/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: ".swagger-ui .topbar { display: none }",
  customSiteTitle: "Tellus Ontology Engine — API Docs",
}));

// Foundry API docs (BE-029) — must be before notFoundHandler
setupFoundrySwagger(app);

// API endpoint listing (docs/endpoints)
app.use(createDocsRouter(app));

// 404 handler for unmatched routes — AFTER all route handlers
app.use(notFoundHandler);

// Global error handler — MUST be last in the middleware chain
app.use(errorHandler);

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

    server = app.listen(PORT, () => {
      console.log(
        `Ontology Engine started on port ${PORT} | PostgreSQL connected`
      );
    });

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
