import "dotenv/config";
import http from "http";
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pool, query } from "./db";
import requestLogger from "./middleware/requestLogger";
import errorHandler from "./middleware/errorHandler";
import ontologyRouter from "./routes/ontology";
import objectTypeRouter from "./routes/objectTypes";
import propertyRouter from "./routes/properties";
import datasourceRouter from "./routes/datasources";
import indexingRouter from "./routes/indexing";
import linkRouter from "./routes/links";
import actionTypeRouter from "./routes/actionTypes";
import actionsRouter, { validateRouter, batchRouter } from "./routes/actions";
import { actionAuditRouter, globalAuditRouter } from "./routes/auditLog";
import objectsRouter from "./routes/objects";
import healthRouter from "./routes/health";
import { ensureIndexTemplate } from "./services/opensearch/templateRegistry";
import { cleanupExpiredKeys } from "./actions/idempotency";
import { limiter } from "./middleware/rateLimiter";
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
    exposedHeaders: ["X-Idempotency-Cached"],
  })
);

// Structured JSON request/response logging
app.use(requestLogger);

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
app.use("/api/v2/audit", globalAuditRouter);
app.use(objectsRouter);
app.use(healthRouter);

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

// Global error handler — MUST be last in the middleware chain
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Process-level error handlers — prevent silent crashes
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err: Error) => {
  console.error("Uncaught exception — shutting down:", err);
  process.exit(1);
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
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then drain the PostgreSQL connection pool.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received — starting graceful shutdown`);

  if (server) {
    server.close(() => {
      console.log("HTTP server closed");
    });
  }

  // Destroy the action rate limiter to prevent dangling setInterval
  limiter.destroy();

  try {
    await pool.end();
    console.log("PostgreSQL pool drained");
  } catch (err) {
    console.error("Error draining pool:", err);
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();

export default app;
