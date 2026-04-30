// ---------------------------------------------------------------------------
// System Health Endpoints (Task 19)
//
// Comprehensive health check endpoints for production monitoring and
// Kubernetes probes. These supplement the existing /api/v1/health and
// /api/v1/status endpoints with more granular checks.
//
// Endpoints:
//   GET /api/v1/system/health     - Detailed per-check health
//   GET /api/v1/system/readiness  - Kubernetes readiness probe
//   GET /api/v1/system/liveness   - Kubernetes liveness probe
//
// Run self-tests: npx tsx src/routes/systemHealth.ts
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { pool } from "../db";
import { ping } from "../services/opensearch/client";
import type { PingResult } from "../services/opensearch/client";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "healthy" | "degraded" | "unhealthy";

export interface CheckResult {
  status: CheckStatus;
  responseMs: number;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HealthCheckResponse {
  status: CheckStatus;
  timestamp: string;
  checks: Record<string, CheckResult>;
  uptime: number;
  version: string;
}

/** Injected dependencies for testing without live services. */
export interface SystemHealthDeps {
  pgQuery: (text: string, values?: unknown[]) => Promise<QueryResult>;
  pingOpenSearch: () => Promise<PingResult>;
  getMemoryUsage: () => NodeJS.MemoryUsage;
  getUptime: () => number;
  getVersion: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PG_TIMEOUT_MS = 3000;
const OS_TIMEOUT_MS = 3000;
const MEMORY_THRESHOLD_PERCENT = 90; // degraded if heap usage > 90%

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultDeps(): SystemHealthDeps {
  return {
    pgQuery: (text: string, values?: unknown[]) => pool.query(text, values),
    pingOpenSearch: ping,
    getMemoryUsage: () => process.memoryUsage(),
    getUptime: () => process.uptime(),
    getVersion: () => {
      try {
        return require("../../package.json").version as string;
      } catch {
        return "unknown";
      }
    },
  };
}

/**
 * Run a function with a timeout. Rejects with a timeout error if not
 * resolved within the specified milliseconds.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Individual Health Checks
// ---------------------------------------------------------------------------

/**
 * PostgreSQL health check:
 * 1. Acquire a connection from the pool
 * 2. Run a simple query (SELECT 1)
 * 3. Run a more meaningful query (SHOW server_version)
 */
async function checkPostgresql(deps: SystemHealthDeps): Promise<CheckResult> {
  const start = performance.now();
  try {
    const [selectResult, versionResult] = await withTimeout(
      async () => {
        const sel = await deps.pgQuery("SELECT 1 AS ok");
        const ver = await deps.pgQuery("SHOW server_version");
        return [sel, ver] as const;
      },
      PG_TIMEOUT_MS,
      "PostgreSQL"
    );

    const responseMs = Math.round(performance.now() - start);
    const version = versionResult.rows[0]?.server_version as string;

    return {
      status: "healthy",
      responseMs,
      message: `PostgreSQL ${version} responding`,
      details: {
        version,
        connectionPoolSize: (pool as any).totalCount ?? null,
        idleConnections: (pool as any).idleCount ?? null,
        waitingRequests: (pool as any).waitingCount ?? null,
      },
    };
  } catch (err: unknown) {
    const responseMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "unhealthy",
      responseMs,
      message: `PostgreSQL check failed: ${message}`,
    };
  }
}

/**
 * OpenSearch health check:
 * 1. Ping the cluster
 * 2. Check cluster health status (green/yellow/red)
 */
async function checkOpenSearch(deps: SystemHealthDeps): Promise<CheckResult> {
  const start = performance.now();
  try {
    const result = await withTimeout(
      () => deps.pingOpenSearch(),
      OS_TIMEOUT_MS,
      "OpenSearch"
    );

    const responseMs = Math.round(performance.now() - start);

    if (!result.connected) {
      return {
        status: "unhealthy",
        responseMs,
        message: `OpenSearch not connected: ${(result as any).error}`,
      };
    }

    // Cluster status mapping: green -> healthy, yellow -> degraded, red -> unhealthy
    const clusterStatus = result.status;
    let status: CheckStatus = "healthy";
    if (clusterStatus === "yellow") status = "degraded";
    if (clusterStatus === "red") status = "unhealthy";

    return {
      status,
      responseMs,
      message: `OpenSearch cluster "${result.clusterName}" is ${clusterStatus}`,
      details: {
        clusterName: result.clusterName,
        clusterStatus,
        numberOfNodes: result.numberOfNodes,
      },
    };
  } catch (err: unknown) {
    const responseMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "unhealthy",
      responseMs,
      message: `OpenSearch check failed: ${message}`,
    };
  }
}

/**
 * Memory usage check:
 * Reports heap usage and flags degraded if heap utilization > 90%.
 */
function checkMemory(deps: SystemHealthDeps): CheckResult {
  const start = performance.now();
  const mem = deps.getMemoryUsage();
  const heapPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const responseMs = Math.round(performance.now() - start);

  const status: CheckStatus = heapPercent > MEMORY_THRESHOLD_PERCENT ? "degraded" : "healthy";

  return {
    status,
    responseMs,
    message: `Heap usage: ${heapPercent}% (${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)})`,
    details: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      heapPercent,
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Core: Build detailed health response
// ---------------------------------------------------------------------------

export async function buildDetailedHealthResponse(
  deps: SystemHealthDeps
): Promise<{ statusCode: number; body: HealthCheckResponse }> {
  // Run checks in parallel
  const [pgResult, osResult] = await Promise.all([
    checkPostgresql(deps),
    checkOpenSearch(deps),
  ]);

  const memResult = checkMemory(deps);

  const checks: Record<string, CheckResult> = {
    postgresql: pgResult,
    opensearch: osResult,
    memory: memResult,
  };

  // Determine overall status: worst of all checks
  let overall: CheckStatus = "healthy";
  for (const check of Object.values(checks)) {
    if (check.status === "unhealthy") {
      overall = "unhealthy";
      break;
    }
    if (check.status === "degraded") {
      overall = "degraded";
    }
  }

  const body: HealthCheckResponse = {
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
    uptime: Math.floor(deps.getUptime()),
    version: deps.getVersion(),
  };

  // HTTP status: 200 for healthy/degraded, 503 for unhealthy
  const statusCode = overall === "unhealthy" ? 503 : 200;

  return { statusCode, body };
}

// ---------------------------------------------------------------------------
// Core: Build readiness response
// ---------------------------------------------------------------------------

export async function buildReadinessResponse(
  deps: SystemHealthDeps
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  // Lightweight checks — just verify connectivity, no heavy queries
  const [pgOk, osOk] = await Promise.all([
    deps.pgQuery("SELECT 1").then(() => true).catch(() => false),
    deps.pingOpenSearch().then((r) => r.connected).catch(() => false),
  ]);

  const ready = pgOk && osOk;

  return {
    statusCode: ready ? 200 : 503,
    body: {
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        postgresql: pgOk ? "ready" : "not_ready",
        opensearch: osOk ? "ready" : "not_ready",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Core: Build liveness response
// ---------------------------------------------------------------------------

export function buildLivenessResponse(): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  return {
    statusCode: 200,
    body: {
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// Detailed health check
router.get("/api/v1/system/health", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildDetailedHealthResponse(deps);
    res.status(statusCode).json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(503).json({
      status: "unhealthy",
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Kubernetes readiness probe
router.get("/api/v1/system/readiness", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildReadinessResponse(deps);
    res.status(statusCode).json(body);
  } catch (err: unknown) {
    res.status(503).json({
      ready: false,
      timestamp: new Date().toISOString(),
    });
  }
});

// Kubernetes liveness probe
router.get("/api/v1/system/liveness", (_req: Request, res: Response) => {
  const { statusCode, body } = buildLivenessResponse();
  res.status(statusCode).json(body);
});

export default router;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/routes/systemHealth.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      /* v8 ignore next 2 */
      failed++;
    }
  }

  console.log("Running systemHealth self-tests...\n");

  // =========================================================================
  // Helpers: create mock deps
  // =========================================================================

  function createMockDeps(overrides: Partial<SystemHealthDeps> = {}): SystemHealthDeps {
    const defaults: SystemHealthDeps = {
      pgQuery: async (text: string): Promise<QueryResult> => {
        if (text === "SELECT 1 AS ok" || text === "SELECT 1") {
          return { rows: [{ ok: 1 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text.includes("server_version")) {
          return { rows: [{ server_version: "16.2" }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] } as unknown as QueryResult;
      },
      pingOpenSearch: async (): Promise<PingResult> => ({
        connected: true,
        clusterName: "test-cluster",
        status: "green",
        numberOfNodes: 1,
      }),
      getMemoryUsage: () => ({
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 1 * 1024 * 1024,
      }),
      getUptime: () => 3600,
      getVersion: () => "0.1.0",
    };
    return { ...defaults, ...overrides };
  }

  // =========================================================================
  // Test 1: All healthy
  // =========================================================================
  console.log("=== 1. All healthy ===");
  {
    const deps = createMockDeps();
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200");
    assert(body.status === "healthy", "overall status is healthy");
    assert(typeof body.timestamp === "string", "has timestamp");
    assert(body.uptime === 3600, "uptime is 3600");
    assert(body.version === "0.1.0", "version is 0.1.0");

    assert(body.checks.postgresql.status === "healthy", "pg is healthy");
    assert(body.checks.opensearch.status === "healthy", "os is healthy");
    assert(body.checks.memory.status === "healthy", "memory is healthy");

    assert(typeof body.checks.postgresql.responseMs === "number", "pg has responseMs");
    assert(typeof body.checks.opensearch.responseMs === "number", "os has responseMs");
    assert(typeof body.checks.memory.responseMs === "number", "memory has responseMs");
  }

  // =========================================================================
  // Test 2: PostgreSQL down
  // =========================================================================
  console.log("\n=== 2. PostgreSQL down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "overall status is unhealthy");
    assert(body.checks.postgresql.status === "unhealthy", "pg is unhealthy");
    assert(body.checks.opensearch.status === "healthy", "os is still healthy");
  }

  // =========================================================================
  // Test 3: OpenSearch down
  // =========================================================================
  console.log("\n=== 3. OpenSearch down ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "overall status is unhealthy");
    assert(body.checks.postgresql.status === "healthy", "pg is healthy");
    assert(body.checks.opensearch.status === "unhealthy", "os is unhealthy");
  }

  // =========================================================================
  // Test 4: OpenSearch yellow cluster
  // =========================================================================
  console.log("\n=== 4. OpenSearch yellow ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => ({
        connected: true,
        clusterName: "test-cluster",
        status: "yellow",
        numberOfNodes: 2,
      }),
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded not 503)");
    assert(body.status === "degraded", "overall status is degraded");
    assert(body.checks.opensearch.status === "degraded", "os is degraded");
  }

  // =========================================================================
  // Test 5: High memory usage
  // =========================================================================
  console.log("\n=== 5. High memory usage ===");
  {
    const deps = createMockDeps({
      getMemoryUsage: () => ({
        rss: 200 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 95 * 1024 * 1024, // 95%
        external: 5 * 1024 * 1024,
        arrayBuffers: 1 * 1024 * 1024,
      }),
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded)");
    assert(body.status === "degraded", "overall status is degraded");
    assert(body.checks.memory.status === "degraded", "memory is degraded");
  }

  // =========================================================================
  // Test 6: Readiness — all ready
  // =========================================================================
  console.log("\n=== 6. Readiness — all ready ===");
  {
    const deps = createMockDeps();
    const { statusCode, body } = await buildReadinessResponse(deps);

    assert(statusCode === 200, "statusCode is 200");
    assert(body.ready === true, "ready is true");
    assert((body.checks as any).postgresql === "ready", "pg ready");
    assert((body.checks as any).opensearch === "ready", "os ready");
  }

  // =========================================================================
  // Test 7: Readiness — PG not ready
  // =========================================================================
  console.log("\n=== 7. Readiness — PG not ready ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { statusCode, body } = await buildReadinessResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.ready === false, "ready is false");
    assert((body.checks as any).postgresql === "not_ready", "pg not ready");
    assert((body.checks as any).opensearch === "ready", "os ready");
  }

  // =========================================================================
  // Test 8: Readiness — OS not ready
  // =========================================================================
  console.log("\n=== 8. Readiness — OS not ready ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { statusCode, body } = await buildReadinessResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.ready === false, "ready is false");
  }

  // =========================================================================
  // Test 9: Liveness — always 200
  // =========================================================================
  console.log("\n=== 9. Liveness ===");
  {
    const { statusCode, body } = buildLivenessResponse();

    assert(statusCode === 200, "statusCode is 200");
    assert(body.alive === true, "alive is true");
    assert(typeof body.timestamp === "string", "has timestamp");
    assert(typeof body.uptime === "number", "has uptime");
  }

  // =========================================================================
  // Test 10: Both services down
  // =========================================================================
  console.log("\n=== 10. Both services down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");
    assert(body.checks.postgresql.status === "unhealthy", "pg unhealthy");
    assert(body.checks.opensearch.status === "unhealthy", "os unhealthy");
  }

  // =========================================================================
  // Test 11: OpenSearch red cluster
  // =========================================================================
  console.log("\n=== 11. OpenSearch red cluster ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => ({
        connected: true,
        clusterName: "test-cluster",
        status: "red",
        numberOfNodes: 1,
      }),
    });
    const { statusCode, body } = await buildDetailedHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503 for red cluster");
    assert(body.status === "unhealthy", "overall unhealthy for red cluster");
    assert(body.checks.opensearch.status === "unhealthy", "os unhealthy for red");
  }

  // =========================================================================
  // Test 12: Response shapes
  // =========================================================================
  console.log("\n=== 12. Response shapes ===");
  {
    const deps = createMockDeps();
    const { body } = await buildDetailedHealthResponse(deps);

    assert("status" in body, "health has status");
    assert("timestamp" in body, "health has timestamp");
    assert("checks" in body, "health has checks");
    assert("uptime" in body, "health has uptime");
    assert("version" in body, "health has version");

    for (const check of Object.values(body.checks)) {
      assert("status" in check, "check has status");
      assert("responseMs" in check, "check has responseMs");
    }
  }

  // =========================================================================
  // Test 13: Check message content
  // =========================================================================
  console.log("\n=== 13. Check messages ===");
  {
    const deps = createMockDeps();
    const { body } = await buildDetailedHealthResponse(deps);

    assert(
      body.checks.postgresql.message!.includes("16.2"),
      "pg message contains version"
    );
    assert(
      body.checks.opensearch.message!.includes("test-cluster"),
      "os message contains cluster name"
    );
    assert(
      body.checks.memory.message!.includes("Heap usage"),
      "memory message contains heap usage"
    );
  }

  // =========================================================================
  // Test 14: formatBytes helper
  // =========================================================================
  console.log("\n=== 14. formatBytes ===");
  {
    assert(formatBytes(500) === "500 B", "500 bytes");
    assert(formatBytes(1024) === "1.0 KB", "1 KB");
    assert(formatBytes(1024 * 1024) === "1.0 MB", "1 MB");
    assert(formatBytes(1024 * 1024 * 1024) === "1.00 GB", "1 GB");
    assert(formatBytes(0) === "0 B", "0 bytes");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll systemHealth tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
