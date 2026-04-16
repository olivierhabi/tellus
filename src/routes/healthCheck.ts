// ---------------------------------------------------------------------------
// Enhanced Health & Status Endpoints (Task 25)
//
// Two endpoints:
//   1. GET /api/v1/health  — Simple health check (responds < 500ms)
//      Checks PG (SELECT 1, 2s timeout) and OpenSearch (GET /, 2s timeout)
//      Returns "healthy" (200) or "unhealthy" (503)
//
//   2. GET /api/v1/status  — Comprehensive system status (up to 10s)
//      System: memory (heapUsed/heapTotal/rss), uptime, nodeVersion
//      PostgreSQL: version, response time, table counts
//      OpenSearch: version, cluster health, indices, documents, storage
//      Ontology: counts of ontologies, objectTypes, properties, linkTypes, actionTypes
//      Datasets: count, transactions, storage
//      Edits: total, pending, indexed
//
// Run self-tests:  npx tsx src/routes/healthCheck.ts
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { pool, query } from "../db";
import { client, ping } from "../services/opensearch/client";
import type { PingResult } from "../services/opensearch/client";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected dependencies for testing without live services. */
export interface HealthCheckDeps {
  pgQuery: (text: string, values?: unknown[]) => Promise<QueryResult>;
  pingOpenSearch: () => Promise<PingResult>;
  getMemoryUsage: () => NodeJS.MemoryUsage;
  getUptime: () => number;
  getNodeVersion: () => string;
}

/** Simple health response shape. */
export interface SimpleHealthResponse {
  status: "healthy" | "unhealthy";
  timestamp: string;
  checks: {
    postgresql: { status: "up" | "down"; responseMs: number };
    opensearch: { status: "up" | "down"; responseMs: number };
  };
}

/** Table count entry. */
interface TableCountEntry {
  name: string;
  rowCount: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PG_TIMEOUT_MS = 2000;
const OS_TIMEOUT_MS = 2000;

const PG_TABLES = [
  "ontology",
  "object_type",
  "property",
  "link_type",
  "action_type",
  "backing_datasource",
  "ontology_edit",
  "funnel_pipeline_state",
  "action_audit_log",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function timedPgCheck(
  pgQuery: (text: string, values?: unknown[]) => Promise<QueryResult>,
  timeoutMs: number
): Promise<{ up: boolean; responseMs: number }> {
  const start = performance.now();
  try {
    await Promise.race([
      pgQuery("SELECT 1"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("PG timeout")), timeoutMs)
      ),
    ]);
    return { up: true, responseMs: Math.round(performance.now() - start) };
  } catch {
    return { up: false, responseMs: Math.round(performance.now() - start) };
  }
}

async function timedOsCheck(
  pingFn: () => Promise<PingResult>,
  timeoutMs: number
): Promise<{ up: boolean; responseMs: number; result?: PingResult }> {
  const start = performance.now();
  try {
    const result = await Promise.race([
      pingFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OS timeout")), timeoutMs)
      ),
    ]);
    const ms = Math.round(performance.now() - start);
    if (result.connected) {
      return { up: true, responseMs: ms, result };
    }
    return { up: false, responseMs: ms, result };
  } catch {
    return { up: false, responseMs: Math.round(performance.now() - start) };
  }
}

async function safeTableCount(
  tableName: string,
  pgQuery: (text: string, values?: unknown[]) => Promise<QueryResult>
): Promise<TableCountEntry> {
  try {
    const result = await pgQuery(`SELECT COUNT(*)::int AS cnt FROM ${tableName}`);
    return { name: tableName, rowCount: result.rows[0].cnt as number };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist")) {
      return { name: tableName, rowCount: 0, error: "table does not exist" };
    }
    return { name: tableName, rowCount: 0, error: msg };
  }
}

function resolveDefaultDeps(): HealthCheckDeps {
  return {
    pgQuery: (text: string, values?: unknown[]) => pool.query(text, values),
    pingOpenSearch: ping,
    getMemoryUsage: () => process.memoryUsage(),
    getUptime: () => process.uptime(),
    getNodeVersion: () => process.version,
  };
}

// ---------------------------------------------------------------------------
// Core: buildSimpleHealthResponse
// ---------------------------------------------------------------------------

export async function buildSimpleHealthResponse(
  deps: HealthCheckDeps
): Promise<{ statusCode: number; body: SimpleHealthResponse }> {
  const [pgCheck, osCheck] = await Promise.all([
    timedPgCheck(deps.pgQuery, PG_TIMEOUT_MS),
    timedOsCheck(deps.pingOpenSearch, OS_TIMEOUT_MS),
  ]);

  const allUp = pgCheck.up && osCheck.up;

  const body: SimpleHealthResponse = {
    status: allUp ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    checks: {
      postgresql: {
        status: pgCheck.up ? "up" : "down",
        responseMs: pgCheck.responseMs,
      },
      opensearch: {
        status: osCheck.up ? "up" : "down",
        responseMs: osCheck.responseMs,
      },
    },
  };

  return { statusCode: allUp ? 200 : 503, body };
}

// ---------------------------------------------------------------------------
// Core: buildComprehensiveStatusResponse
// ---------------------------------------------------------------------------

export async function buildComprehensiveStatusResponse(
  deps: HealthCheckDeps
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  // -----------------------------------------------------------------------
  // 1. System info
  // -----------------------------------------------------------------------
  const mem = deps.getMemoryUsage();
  const system = {
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      heapUsedFormatted: formatBytes(mem.heapUsed),
      heapTotalFormatted: formatBytes(mem.heapTotal),
      rssFormatted: formatBytes(mem.rss),
    },
    uptime: formatUptime(deps.getUptime()),
    uptimeSeconds: Math.floor(deps.getUptime()),
    nodeVersion: deps.getNodeVersion(),
  };

  // -----------------------------------------------------------------------
  // 2. PostgreSQL
  // -----------------------------------------------------------------------
  let pgConnected = false;
  let pgVersion: string | null = null;
  let pgResponseMs = 0;
  const pgTables: TableCountEntry[] = [];

  const pgStart = performance.now();
  try {
    const versionResult = await deps.pgQuery("SHOW server_version");
    pgVersion = `PostgreSQL ${versionResult.rows[0].server_version as string}`;
    pgConnected = true;
    pgResponseMs = Math.round(performance.now() - pgStart);

    // Table counts in parallel
    const countPromises = PG_TABLES.map((t) => safeTableCount(t, deps.pgQuery));
    const counts = await Promise.all(countPromises);
    pgTables.push(...counts);
  } catch {
    pgResponseMs = Math.round(performance.now() - pgStart);
  }

  // -----------------------------------------------------------------------
  // 3. OpenSearch
  // -----------------------------------------------------------------------
  let osConnected = false;
  let osVersion: string | null = null;
  let osClusterName: string | null = null;
  let osClusterStatus: string | null = null;
  let osNodeCount = 0;
  let osResponseMs = 0;
  let osIndicesCount = 0;
  let osTotalDocuments = 0;
  let osTotalStorageBytes = 0;

  const osStart = performance.now();
  try {
    const pingResult = await deps.pingOpenSearch();
    osResponseMs = Math.round(performance.now() - osStart);
    if (pingResult.connected) {
      osConnected = true;
      osClusterName = pingResult.clusterName;
      osClusterStatus = pingResult.status;
      osNodeCount = pingResult.numberOfNodes;

      // Try to get cluster stats for version, indices, docs, storage
      try {
        const { body: clusterStats } = await client.cluster.stats({});
        const stats = clusterStats as Record<string, any>;
        osVersion = stats.nodes?.versions?.[0] ?? null;
        const indices = stats.indices as Record<string, any> | undefined;
        if (indices) {
          osIndicesCount = indices.count ?? 0;
          osTotalDocuments = indices.docs?.count ?? 0;
          osTotalStorageBytes = indices.store?.size_in_bytes ?? 0;
        }
      } catch {
        // Partial data is fine
      }
    }
  } catch {
    osResponseMs = Math.round(performance.now() - osStart);
  }

  // -----------------------------------------------------------------------
  // 4. Ontology counts
  // -----------------------------------------------------------------------
  let ontologyCount = 0;
  let objectTypeCount = 0;
  let propertyCount = 0;
  let linkTypeCount = 0;
  let actionTypeCount = 0;

  if (pgConnected) {
    for (const t of pgTables) {
      if (t.name === "ontology") ontologyCount = t.rowCount;
      if (t.name === "object_type") objectTypeCount = t.rowCount;
      if (t.name === "property") propertyCount = t.rowCount;
      if (t.name === "link_type") linkTypeCount = t.rowCount;
      if (t.name === "action_type") actionTypeCount = t.rowCount;
    }
  }

  // -----------------------------------------------------------------------
  // 5. Dataset info
  // -----------------------------------------------------------------------
  let datasetCount = 0;
  let transactionCount = 0;
  let datasetStorageBytes = 0;

  if (pgConnected) {
    try {
      const dsResult = await deps.pgQuery(
        "SELECT COUNT(*)::int AS cnt FROM dataset"
      );
      datasetCount = dsResult.rows[0].cnt;
    } catch {
      // table may not exist
    }
    try {
      const txResult = await deps.pgQuery(
        "SELECT COUNT(*)::int AS cnt FROM dataset_transaction"
      );
      transactionCount = txResult.rows[0].cnt;
    } catch {
      // table may not exist
    }
    try {
      const storageResult = await deps.pgQuery(
        "SELECT COALESCE(SUM(file_size_bytes), 0)::bigint AS total FROM dataset_transaction"
      );
      datasetStorageBytes = Number(storageResult.rows[0].total);
    } catch {
      // column may not exist
    }
  }

  // -----------------------------------------------------------------------
  // 6. Edit info
  // -----------------------------------------------------------------------
  let editTotal = 0;
  let editPending = 0;
  let editIndexed = 0;

  if (pgConnected) {
    try {
      const editResult = await deps.pgQuery(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE indexed = false)::int AS pending,
           COUNT(*) FILTER (WHERE indexed = true)::int AS indexed
         FROM ontology_edit`
      );
      editTotal = editResult.rows[0].total;
      editPending = editResult.rows[0].pending;
      editIndexed = editResult.rows[0].indexed;
    } catch {
      // table may not exist
    }
  }

  // -----------------------------------------------------------------------
  // 7. Determine overall status
  // -----------------------------------------------------------------------
  let overallStatus: "healthy" | "degraded" | "unhealthy";
  if (pgConnected && osConnected) {
    overallStatus = "healthy";
  } else if (!pgConnected && !osConnected) {
    overallStatus = "unhealthy";
  } else {
    overallStatus = "degraded";
  }

  // -----------------------------------------------------------------------
  // 8. Build response
  // -----------------------------------------------------------------------
  const body: Record<string, unknown> = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    system,
    postgresql: {
      connected: pgConnected,
      version: pgVersion,
      responseMs: pgResponseMs,
      tables: pgTables,
    },
    opensearch: {
      connected: osConnected,
      version: osVersion,
      clusterName: osClusterName,
      clusterStatus: osClusterStatus,
      nodeCount: osNodeCount,
      responseMs: osResponseMs,
      indices: osIndicesCount,
      totalDocuments: osTotalDocuments,
      totalStorageBytes: osTotalStorageBytes,
      totalStorageFormatted: formatBytes(osTotalStorageBytes),
    },
    ontology: {
      ontologies: ontologyCount,
      objectTypes: objectTypeCount,
      properties: propertyCount,
      linkTypes: linkTypeCount,
      actionTypes: actionTypeCount,
    },
    datasets: {
      count: datasetCount,
      transactions: transactionCount,
      storageBytes: datasetStorageBytes,
      storageFormatted: formatBytes(datasetStorageBytes),
    },
    edits: {
      total: editTotal,
      pending: editPending,
      indexed: editIndexed,
    },
  };

  const statusCode = overallStatus === "unhealthy" ? 503 : 200;
  return { statusCode, body };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

router.get("/api/v1/health", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildSimpleHealthResponse(deps);
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

router.get("/api/v1/status", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildComprehensiveStatusResponse(deps);
    res.status(statusCode).json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({
      status: "unhealthy",
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/routes/healthCheck.ts)
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

  console.log("Running healthCheck self-tests...\n");

  // =========================================================================
  // Helpers
  // =========================================================================

  function createMockDeps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
    const defaults: HealthCheckDeps = {
      pgQuery: async (text: string): Promise<QueryResult> => {
        if (text.includes("server_version")) {
          return { rows: [{ server_version: "16.2" }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text === "SELECT 1") {
          return { rows: [{ "?column?": 1 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text.includes("SUM(file_size_bytes)")) {
          return { rows: [{ total: "1048576" }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        // Edit stats query — must check before generic COUNT(*)
        if (text.includes("FILTER") && text.includes("indexed")) {
          return { rows: [{ total: 100, pending: 15, indexed: 85 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text.includes("COUNT(*)") && text.includes("FROM")) {
          const tableMatch = text.match(/FROM\s+(\w+)/i);
          const table = tableMatch?.[1] ?? "unknown";
          const counts: Record<string, number> = {
            ontology: 2, object_type: 5, property: 30, link_type: 3,
            action_type: 4, backing_datasource: 2, ontology_edit: 100,
            funnel_pipeline_state: 5, action_audit_log: 200,
            dataset: 3, dataset_transaction: 7,
          };
          return { rows: [{ cnt: counts[table] ?? 0 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
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
        heapTotal: 60 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 1 * 1024 * 1024,
      }),
      getUptime: () => 3661,
      getNodeVersion: () => "v20.10.0",
    };
    return { ...defaults, ...overrides };
  }

  // =========================================================================
  // Test 1: Simple health — both up
  // =========================================================================
  console.log("=== 1. Simple health — both up ===");
  {
    const deps = createMockDeps();
    const { statusCode, body } = await buildSimpleHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200");
    assert(body.status === "healthy", "status is healthy");
    assert(typeof body.timestamp === "string", "has timestamp");
    assert(body.checks.postgresql.status === "up", "pg is up");
    assert(body.checks.opensearch.status === "up", "os is up");
    assert(typeof body.checks.postgresql.responseMs === "number", "pg has responseMs");
    assert(typeof body.checks.opensearch.responseMs === "number", "os has responseMs");
  }

  // =========================================================================
  // Test 2: Simple health — PG down
  // =========================================================================
  console.log("\n=== 2. Simple health — PG down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { statusCode, body } = await buildSimpleHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");
    assert(body.checks.postgresql.status === "down", "pg is down");
    assert(body.checks.opensearch.status === "up", "os is up");
  }

  // =========================================================================
  // Test 3: Simple health — OS down
  // =========================================================================
  console.log("\n=== 3. Simple health — OS down ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildSimpleHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");
    assert(body.checks.postgresql.status === "up", "pg is up");
    assert(body.checks.opensearch.status === "down", "os is down");
  }

  // =========================================================================
  // Test 4: Simple health — both down
  // =========================================================================
  console.log("\n=== 4. Simple health — both down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildSimpleHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");
    assert(body.checks.postgresql.status === "down", "pg is down");
    assert(body.checks.opensearch.status === "down", "os is down");
  }

  // =========================================================================
  // Test 5: Comprehensive status — all healthy
  // =========================================================================
  console.log("\n=== 5. Comprehensive status — all healthy ===");
  {
    const deps = createMockDeps();
    const { statusCode, body } = await buildComprehensiveStatusResponse(deps);

    assert(statusCode === 200, "statusCode is 200");
    assert(body.status === "healthy", "status is healthy");
    assert(typeof body.timestamp === "string", "has timestamp");

    // System
    const system = body.system as Record<string, any>;
    assert(system.memory.heapUsed === 40 * 1024 * 1024, "heapUsed correct");
    assert(system.memory.heapTotal === 60 * 1024 * 1024, "heapTotal correct");
    assert(system.memory.rss === 100 * 1024 * 1024, "rss correct");
    assert(system.uptime === "1h 1m 1s", `uptime is 1h 1m 1s (got: ${system.uptime})`);
    assert(system.nodeVersion === "v20.10.0", "nodeVersion correct");

    // PostgreSQL
    const pg = body.postgresql as Record<string, any>;
    assert(pg.connected === true, "pg connected");
    assert((pg.version as string).includes("16.2"), "pg version includes 16.2");
    assert(typeof pg.responseMs === "number", "pg responseMs is number");

    const tables = pg.tables as TableCountEntry[];
    assert(tables.length === PG_TABLES.length, `pg has ${PG_TABLES.length} tables`);

    const ontologyTable = tables.find((t) => t.name === "ontology");
    assert(ontologyTable !== undefined, "ontology table present");
    assert(ontologyTable!.rowCount === 2, "ontology count is 2");

    // Ontology section
    const ont = body.ontology as Record<string, any>;
    assert(ont.ontologies === 2, "ontology count");
    assert(ont.objectTypes === 5, "objectType count");
    assert(ont.properties === 30, "property count");
    assert(ont.linkTypes === 3, "linkType count");
    assert(ont.actionTypes === 4, "actionType count");

    // Datasets
    const ds = body.datasets as Record<string, any>;
    assert(ds.count === 3, "dataset count");
    assert(ds.transactions === 7, "transaction count");
    assert(ds.storageBytes === 1048576, "storage bytes");

    // Edits
    const edits = body.edits as Record<string, any>;
    assert(edits.total === 100, "edit total");
    assert(edits.pending === 15, "edit pending");
    assert(edits.indexed === 85, "edit indexed");
  }

  // =========================================================================
  // Test 6: Comprehensive status — PG down
  // =========================================================================
  console.log("\n=== 6. Comprehensive status — PG down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { statusCode, body } = await buildComprehensiveStatusResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded)");
    assert(body.status === "degraded", "status is degraded");

    const pg = body.postgresql as Record<string, any>;
    assert(pg.connected === false, "pg not connected");
    assert(pg.tables.length === 0, "no table counts");

    const ont = body.ontology as Record<string, any>;
    assert(ont.ontologies === 0, "ontology count 0");
  }

  // =========================================================================
  // Test 7: Comprehensive status — OS down
  // =========================================================================
  console.log("\n=== 7. Comprehensive status — OS down ===");
  {
    const deps = createMockDeps({
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildComprehensiveStatusResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded)");
    assert(body.status === "degraded", "status is degraded");

    const os = body.opensearch as Record<string, any>;
    assert(os.connected === false, "os not connected");
  }

  // =========================================================================
  // Test 8: Comprehensive status — both down
  // =========================================================================
  console.log("\n=== 8. Comprehensive status — both down ===");
  {
    const deps = createMockDeps({
      pgQuery: async () => { throw new Error("ECONNREFUSED"); },
      pingOpenSearch: async () => ({ connected: false, error: "ECONNREFUSED" }),
    });
    const { statusCode, body } = await buildComprehensiveStatusResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");
  }

  // =========================================================================
  // Test 9: formatUptime edge cases
  // =========================================================================
  console.log("\n=== 9. formatUptime ===");
  {
    assert(formatUptime(0) === "0h 0m 0s", "0s");
    assert(formatUptime(59) === "0h 0m 59s", "59s");
    assert(formatUptime(60) === "0h 1m 0s", "60s");
    assert(formatUptime(3600) === "1h 0m 0s", "3600s");
    assert(formatUptime(3661) === "1h 1m 1s", "3661s");
    assert(formatUptime(86400) === "24h 0m 0s", "86400s");
    assert(formatUptime(1.7) === "0h 0m 1s", "1.7s fractional");
  }

  // =========================================================================
  // Test 10: formatBytes
  // =========================================================================
  console.log("\n=== 10. formatBytes ===");
  {
    assert(formatBytes(500) === "500 B", "500 bytes");
    assert(formatBytes(1024) === "1.0 KB", "1 KB");
    assert(formatBytes(1024 * 1024) === "1.0 MB", "1 MB");
    assert(formatBytes(1024 * 1024 * 1024) === "1.00 GB", "1 GB");
  }

  // =========================================================================
  // Test 11: Response shape — simple health
  // =========================================================================
  console.log("\n=== 11. Response shape — simple health ===");
  {
    const deps = createMockDeps();
    const { body } = await buildSimpleHealthResponse(deps);

    assert("status" in body, "has status");
    assert("timestamp" in body, "has timestamp");
    assert("checks" in body, "has checks");
    assert("postgresql" in body.checks, "has postgresql check");
    assert("opensearch" in body.checks, "has opensearch check");
    assert("status" in body.checks.postgresql, "pg has status");
    assert("responseMs" in body.checks.postgresql, "pg has responseMs");
    assert("status" in body.checks.opensearch, "os has status");
    assert("responseMs" in body.checks.opensearch, "os has responseMs");
  }

  // =========================================================================
  // Test 12: Response shape — comprehensive status
  // =========================================================================
  console.log("\n=== 12. Response shape — comprehensive status ===");
  {
    const deps = createMockDeps();
    const { body } = await buildComprehensiveStatusResponse(deps);

    assert("status" in body, "has status");
    assert("timestamp" in body, "has timestamp");
    assert("system" in body, "has system");
    assert("postgresql" in body, "has postgresql");
    assert("opensearch" in body, "has opensearch");
    assert("ontology" in body, "has ontology");
    assert("datasets" in body, "has datasets");
    assert("edits" in body, "has edits");

    const sys = body.system as Record<string, any>;
    assert("memory" in sys, "system has memory");
    assert("uptime" in sys, "system has uptime");
    assert("nodeVersion" in sys, "system has nodeVersion");

    const mem = sys.memory as Record<string, any>;
    assert("heapUsed" in mem, "memory has heapUsed");
    assert("heapTotal" in mem, "memory has heapTotal");
    assert("rss" in mem, "memory has rss");
  }

  // =========================================================================
  // Test 13: PG table count error handling
  // =========================================================================
  console.log("\n=== 13. PG table count error handling ===");
  {
    const deps = createMockDeps({
      pgQuery: async (text: string): Promise<QueryResult> => {
        if (text.includes("server_version")) {
          return { rows: [{ server_version: "16.2" }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text.includes("ontology_edit")) {
          throw new Error('relation "ontology_edit" does not exist');
        }
        if (text.includes("COUNT(*)")) {
          return { rows: [{ cnt: 0 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        if (text === "SELECT 1") {
          return { rows: [{}], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
        }
        return { rows: [{ total: 0, pending: 0, indexed: 0 }], command: "", rowCount: 1, oid: 0, fields: [] } as unknown as QueryResult;
      },
    });
    const { body } = await buildComprehensiveStatusResponse(deps);

    const pg = body.postgresql as Record<string, any>;
    const editTable = (pg.tables as TableCountEntry[]).find((t) => t.name === "ontology_edit");
    assert(editTable !== undefined, "ontology_edit entry exists");
    assert(editTable!.rowCount === 0, "ontology_edit rowCount is 0");
    assert(editTable!.error === "table does not exist", "ontology_edit has error");
  }

  // =========================================================================
  // Test 14: Timestamp is valid ISO 8601
  // =========================================================================
  console.log("\n=== 14. Timestamp format ===");
  {
    const deps = createMockDeps();
    const { body: simple } = await buildSimpleHealthResponse(deps);
    const { body: comprehensive } = await buildComprehensiveStatusResponse(deps);

    const ts1 = simple.timestamp;
    const ts2 = comprehensive.timestamp as string;
    assert(!isNaN(new Date(ts1).getTime()), "simple timestamp is valid date");
    assert(ts1.endsWith("Z"), "simple timestamp ends with Z");
    assert(!isNaN(new Date(ts2).getTime()), "comprehensive timestamp is valid date");
    assert(ts2.endsWith("Z"), "comprehensive timestamp ends with Z");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll healthCheck tests passed");
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
