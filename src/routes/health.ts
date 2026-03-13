// ---------------------------------------------------------------------------
// System Health Check Endpoint
//
// GET /api/v2/status
//
// Returns comprehensive system health information including the status of
// PostgreSQL and OpenSearch, table row counts, index stats, and ontology
// summary data. This is the endpoint the human operator uses at the end
// of each day to verify everything is working.
//
// Overall status:
//   "healthy"   — both PostgreSQL and OpenSearch are reachable
//   "degraded"  — one of the two is down
//   "unhealthy" — both are down
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { pool } from "../db";
import { ping } from "../services/opensearch/client";
import { getIndexStats } from "../services/opensearch/indexLifecycleManager";
import { countAllObjectTypes } from "../services/opensearch/objectCounter";
import { getAllStates } from "../models/funnelState";
import type { FunnelPipelineState } from "../models/funnelState";
import type { PingResult } from "../services/opensearch/client";
import type { CountAllResult, ObjectTypeCount } from "../services/opensearch/objectCounter";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected dependencies for testing without live services. */
export interface HealthDeps {
  queryFn: (text: string, values?: unknown[]) => Promise<QueryResult>;
  pingOpenSearch: () => Promise<PingResult>;
  countAll: () => Promise<CountAllResult>;
  getAllPipelineStates: () => Promise<FunnelPipelineState[]>;
  getVersion: () => string;
  getUptime: () => number;
}

/** Table row count result. */
interface TableCount {
  rowCount: number;
  error?: string;
}

/** Shape of the ontology objectType summary entry. */
interface ObjectTypeSummary {
  apiName: string;
  propertyCount: number;
  objectCount: number;
  lastIndexed: string | null;
  indexStatus: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables to count in the PostgreSQL section. */
const PG_TABLES = [
  "ontology",
  "object_type",
  "property",
  "backing_datasource",
  "link_type",
  "action_type",
  "ontology_edit",
  "funnel_pipeline_state",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a seconds value into "{h}h {m}m {s}s" format.
 */
function formatUptime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

/**
 * Count rows in a single table. Returns { rowCount: 0, error: "..." } if
 * the table does not exist (relation "..." does not exist error).
 */
async function safeTableCount(
  tableName: string,
  queryFn: (text: string, values?: unknown[]) => Promise<QueryResult>
): Promise<TableCount> {
  try {
    const result = await queryFn(`SELECT COUNT(*)::int AS cnt FROM ${tableName}`);
    return { rowCount: result.rows[0].cnt as number };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // PostgreSQL error 42P01: relation does not exist
    if (msg.includes("does not exist")) {
      return { rowCount: 0, error: "table does not exist" };
    }
    return { rowCount: 0, error: msg };
  }
}

/**
 * Resolve default dependencies (live services).
 */
function resolveDefaultDeps(): HealthDeps {
  return {
    queryFn: (text: string, values?: unknown[]) => pool.query(text, values),
    pingOpenSearch: ping,
    countAll: () => countAllObjectTypes(),
    getAllPipelineStates: () => getAllStates(),
    getVersion: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("../../package.json").version as string;
      } catch {
        return "unknown";
      }
    },
    getUptime: () => process.uptime(),
  };
}

// ---------------------------------------------------------------------------
// Core handler (exported for direct testing)
// ---------------------------------------------------------------------------

/**
 * Build the full health check response object.
 *
 * Extracted from the route handler so self-tests can call it directly
 * with injected dependencies.
 */
export async function buildHealthResponse(deps: HealthDeps): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  let pgConnected = false;
  let pgVersion = "";
  const tableCounts: Record<string, TableCount> = {};

  let osConnected = false;
  let osClusterName = "";
  let osClusterStatus = "";
  let osNodeCount = 0;

  let countAllResult: CountAllResult = { objectTypes: [], totalObjects: 0 };
  let pipelineStates: FunnelPipelineState[] = [];

  // -----------------------------------------------------------------------
  // 1. PostgreSQL health
  // -----------------------------------------------------------------------
  try {
    const versionResult = await deps.queryFn("SHOW server_version");
    pgVersion = `PostgreSQL ${versionResult.rows[0].server_version as string}`;
    pgConnected = true;

    // Count rows in each table
    for (const table of PG_TABLES) {
      tableCounts[table] = await safeTableCount(table, deps.queryFn);
    }
  } catch {
    pgConnected = false;
    // Fill tables with zeros + error
    for (const table of PG_TABLES) {
      tableCounts[table] = { rowCount: 0, error: "database unreachable" };
    }
  }

  // -----------------------------------------------------------------------
  // 2. OpenSearch health
  // -----------------------------------------------------------------------
  let osIndices: {
    count: number;
    totalDocuments: number;
    totalSizeBytes: number;
    details: Array<{ name: string; documents: number; sizeBytes: number }>;
  } = { count: 0, totalDocuments: 0, totalSizeBytes: 0, details: [] };

  try {
    const pingResult = await deps.pingOpenSearch();
    if (pingResult.connected) {
      osConnected = true;
      osClusterName = pingResult.clusterName;
      osClusterStatus = pingResult.status;
      osNodeCount = pingResult.numberOfNodes;

      // Get index-level details
      try {
        countAllResult = await deps.countAll();
        let totalSizeBytes = 0;
        const details = countAllResult.objectTypes.map((ot: ObjectTypeCount) => {
          totalSizeBytes += ot.sizeBytes;
          return {
            name: ot.indexName,
            documents: ot.count,
            sizeBytes: ot.sizeBytes,
          };
        });

        osIndices = {
          count: countAllResult.objectTypes.length,
          totalDocuments: countAllResult.totalObjects,
          totalSizeBytes,
          details,
        };
      } catch {
        // OpenSearch is up but cat.indices failed — partial data
      }
    }
  } catch {
    osConnected = false;
  }

  // -----------------------------------------------------------------------
  // 3. Pipeline states (for ontology summary)
  // -----------------------------------------------------------------------
  try {
    pipelineStates = await deps.getAllPipelineStates();
  } catch {
    pipelineStates = [];
  }

  // Build a lookup from apiName → pipeline state
  const stateMap = new Map<string, FunnelPipelineState>();
  for (const ps of pipelineStates) {
    stateMap.set(ps.object_type_api_name, ps);
  }

  // -----------------------------------------------------------------------
  // 4. Ontology summary — merge object type counts with pipeline states
  // -----------------------------------------------------------------------

  // Build a set of apiNames from both sources
  const allApiNames = new Set<string>();
  for (const ot of countAllResult.objectTypes) {
    allApiNames.add(ot.apiName);
  }
  for (const ps of pipelineStates) {
    allApiNames.add(ps.object_type_api_name);
  }

  // Property counts — query from PG if available
  let propertyCounts = new Map<string, number>();
  if (pgConnected) {
    try {
      const propResult = await deps.queryFn(
        `SELECT ot.api_name, COUNT(p.property_id)::int AS cnt
         FROM object_type ot
         LEFT JOIN property p ON p.object_type_id = ot.object_type_id
         GROUP BY ot.api_name`
      );
      for (const row of propResult.rows) {
        propertyCounts.set(row.api_name as string, row.cnt as number);
      }
    } catch {
      // No property counts available
    }
  }

  // Link type count
  let linkTypeCount = 0;
  if (pgConnected && tableCounts["link_type"] && !tableCounts["link_type"].error) {
    linkTypeCount = tableCounts["link_type"].rowCount;
  }

  // Action type count
  let actionTypeCount = 0;
  if (pgConnected && tableCounts["action_type"] && !tableCounts["action_type"].error) {
    actionTypeCount = tableCounts["action_type"].rowCount;
  }

  const objectTypeSummaries: ObjectTypeSummary[] = [];

  for (const apiName of allApiNames) {
    const osEntry = countAllResult.objectTypes.find((ot) => ot.apiName === apiName);
    const ps = stateMap.get(apiName);

    objectTypeSummaries.push({
      apiName,
      propertyCount: propertyCounts.get(apiName) ?? 0,
      objectCount: osEntry?.count ?? 0,
      lastIndexed: ps?.last_indexed_at ?? null,
      indexStatus: ps?.status ?? "unknown",
    });
  }

  // -----------------------------------------------------------------------
  // 5. Determine overall status
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
  // 6. Build response
  // -----------------------------------------------------------------------
  const body: Record<string, unknown> = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      postgresql: {
        connected: pgConnected,
        version: pgVersion || null,
        tables: tableCounts,
      },
      opensearch: {
        connected: osConnected,
        clusterName: osClusterName || null,
        clusterStatus: osClusterStatus || null,
        nodeCount: osNodeCount,
        indices: osIndices,
      },
    },
    ontology: {
      objectTypes: objectTypeSummaries,
      linkTypes: linkTypeCount,
      actionTypes: actionTypeCount,
      totalObjects: countAllResult.totalObjects,
    },
    uptime: formatUptime(deps.getUptime()),
    version: deps.getVersion(),
  };

  // HTTP status: 200 for healthy/degraded, 503 for unhealthy
  const statusCode = overallStatus === "unhealthy" ? 503 : 200;

  return { statusCode, body };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

router.get("/api/v2/status", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildHealthResponse(deps);
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

// ---------------------------------------------------------------------------
// Kubernetes-style health endpoints (Sunday Task)
// ---------------------------------------------------------------------------

/**
 * GET /api/v2/system/health — Full health check (same as /api/v2/status)
 */
router.get("/api/v2/system/health", async (_req: Request, res: Response) => {
  try {
    const deps = resolveDefaultDeps();
    const { statusCode, body } = await buildHealthResponse(deps);
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

/**
 * GET /api/v2/system/readiness — Readiness probe
 *
 * Returns 200 if the system can handle requests (DB is reachable).
 * Returns 503 if the database is unreachable.
 */
router.get("/api/v2/system/readiness", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ready",
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(503).json({
      status: "not_ready",
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v2/system/liveness — Liveness probe
 *
 * Always returns 200 if the process is running. This is a simple
 * liveness check that does not depend on external services.
 */
router.get("/api/v2/system/liveness", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "alive",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/routes/health.ts)
// ---------------------------------------------------------------------------

async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  console.log("Running health endpoint self-tests...\n");

  // =======================================================================
  // Helper: create mock deps
  // =======================================================================

  interface MockOptions {
    pgUp?: boolean;
    pgVersion?: string;
    pgTables?: Record<string, number | "missing">;
    osUp?: boolean;
    osClusterName?: string;
    osClusterStatus?: string;
    osNodeCount?: number;
    osObjectTypes?: Array<{ apiName: string; indexName: string; count: number; sizeBytes: number }>;
    pipelineStates?: FunnelPipelineState[];
    propertyCounts?: Array<{ api_name: string; cnt: number }>;
    version?: string;
    uptime?: number;
  }

  function createMockDeps(opts: MockOptions = {}): HealthDeps {
    const {
      pgUp = true,
      pgVersion = "16.1",
      pgTables = {},
      osUp = true,
      osClusterName = "docker-cluster",
      osClusterStatus = "green",
      osNodeCount = 1,
      osObjectTypes = [],
      pipelineStates = [],
      propertyCounts = [],
      version = "0.1.0-day2",
      uptime = 30615, // 8h 30m 15s
    } = opts;

    const queryFn = async (text: string): Promise<QueryResult> => {
      if (!pgUp) throw new Error("connect ECONNREFUSED");

      // SHOW server_version
      if (text.includes("server_version")) {
        return {
          rows: [{ server_version: pgVersion }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        } as unknown as QueryResult;
      }

      // COUNT(*) FROM <table>
      const countMatch = text.match(/FROM\s+(\w+)/i);
      if (countMatch && text.includes("COUNT(*)")) {
        const tableName = countMatch[1];
        const val = pgTables[tableName];
        if (val === "missing") {
          throw new Error(`relation "${tableName}" does not exist`);
        }
        return {
          rows: [{ cnt: val ?? 0 }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        } as unknown as QueryResult;
      }

      // Property counts join
      if (text.includes("LEFT JOIN property")) {
        return {
          rows: propertyCounts,
          command: "",
          rowCount: propertyCounts.length,
          oid: 0,
          fields: [],
        } as unknown as QueryResult;
      }

      return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] } as unknown as QueryResult;
    };

    const pingOpenSearch = async (): Promise<PingResult> => {
      if (!osUp) {
        return { connected: false, error: "connect ECONNREFUSED" };
      }
      return {
        connected: true,
        clusterName: osClusterName,
        status: osClusterStatus,
        numberOfNodes: osNodeCount,
      };
    };

    const countAll = async (): Promise<CountAllResult> => {
      if (!osUp) throw new Error("connect ECONNREFUSED");
      let total = 0;
      for (const ot of osObjectTypes) total += ot.count;
      return { objectTypes: osObjectTypes, totalObjects: total };
    };

    const getAllPipelineStates = async (): Promise<FunnelPipelineState[]> => {
      if (!pgUp) return [];
      return pipelineStates;
    };

    return {
      queryFn,
      pingOpenSearch,
      countAll,
      getAllPipelineStates,
      getVersion: () => version,
      getUptime: () => uptime,
    };
  }

  // =======================================================================
  // 1. Both services healthy — full response
  // =======================================================================
  console.log("=== 1. Both services healthy ===");
  {
    const deps = createMockDeps({
      pgTables: {
        ontology: 1,
        object_type: 3,
        property: 28,
        backing_datasource: 2,
        link_type: 0,
        action_type: 0,
        ontology_edit: "missing",
        funnel_pipeline_state: 2,
      },
      osObjectTypes: [
        { apiName: "Employee", indexName: "ontology-employee", count: 1000, sizeBytes: 500000 },
        { apiName: "Company", indexName: "ontology-company", count: 50, sizeBytes: 25000 },
      ],
      pipelineStates: [
        {
          object_type_api_name: "Employee",
          status: "success",
          last_indexed_at: "2025-03-11T10:30:00Z",
          objects_indexed: 1000,
          duration_ms: 2500,
          datasource_version: null,
          error_message: null,
          retry_count: 0,
          created_at: "2025-03-11T10:00:00Z",
          updated_at: "2025-03-11T10:30:00Z",
        },
        {
          object_type_api_name: "Company",
          status: "success",
          last_indexed_at: "2025-03-11T11:00:00Z",
          objects_indexed: 50,
          duration_ms: 500,
          datasource_version: null,
          error_message: null,
          retry_count: 0,
          created_at: "2025-03-11T10:30:00Z",
          updated_at: "2025-03-11T11:00:00Z",
        },
      ],
      propertyCounts: [
        { api_name: "Employee", cnt: 10 },
        { api_name: "Company", cnt: 5 },
      ],
      uptime: 30615,
    });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200");
    assert(body.status === "healthy", "status is healthy");
    assert(typeof body.timestamp === "string", "timestamp is string");
    assert(body.uptime === "8h 30m 15s", `uptime is '8h 30m 15s' (got: '${body.uptime}')`);
    assert(body.version === "0.1.0-day2", `version is '0.1.0-day2' (got: '${body.version}')`);

    // PostgreSQL section
    const svc = body.services as Record<string, unknown>;
    const pg = svc.postgresql as Record<string, unknown>;
    assert(pg.connected === true, "pg connected");
    assert((pg.version as string).includes("16.1"), `pg version includes 16.1 (got: '${pg.version}')`);

    const tables = pg.tables as Record<string, TableCount>;
    assert(tables.ontology.rowCount === 1, "ontology rowCount 1");
    assert(tables.object_type.rowCount === 3, "object_type rowCount 3");
    assert(tables.property.rowCount === 28, "property rowCount 28");
    assert(tables.backing_datasource.rowCount === 2, "backing_datasource rowCount 2");
    assert(tables.link_type.rowCount === 0, "link_type rowCount 0");
    assert(tables.action_type.rowCount === 0, "action_type rowCount 0");
    assert(tables.ontology_edit.rowCount === 0, "ontology_edit rowCount 0 (missing table)");
    assert(tables.ontology_edit.error === "table does not exist", "ontology_edit has error");
    assert(tables.funnel_pipeline_state.rowCount === 2, "funnel_pipeline_state rowCount 2");

    // OpenSearch section
    const os = svc.opensearch as Record<string, unknown>;
    assert(os.connected === true, "os connected");
    assert(os.clusterName === "docker-cluster", "os clusterName");
    assert(os.clusterStatus === "green", "os clusterStatus");
    assert(os.nodeCount === 1, "os nodeCount");

    const indices = os.indices as Record<string, unknown>;
    assert(indices.count === 2, "os indices count 2");
    assert(indices.totalDocuments === 1050, "os totalDocuments 1050");
    assert(indices.totalSizeBytes === 525000, "os totalSizeBytes 525000");

    const details = indices.details as Array<{ name: string; documents: number; sizeBytes: number }>;
    assert(details.length === 2, "os details length 2");
    assert(details[0].name === "ontology-employee", "details[0] name");
    assert(details[0].documents === 1000, "details[0] documents");
    assert(details[0].sizeBytes === 500000, "details[0] sizeBytes");
    assert(details[1].name === "ontology-company", "details[1] name");
    assert(details[1].documents === 50, "details[1] documents");

    // Ontology section
    const ont = body.ontology as Record<string, unknown>;
    const objectTypes = ont.objectTypes as ObjectTypeSummary[];
    assert(objectTypes.length === 2, "ontology objectTypes length 2");

    const emp = objectTypes.find((o) => o.apiName === "Employee");
    assert(emp !== undefined, "Employee found in ontology summary");
    assert(emp!.propertyCount === 10, "Employee propertyCount 10");
    assert(emp!.objectCount === 1000, "Employee objectCount 1000");
    assert(emp!.lastIndexed === "2025-03-11T10:30:00Z", "Employee lastIndexed");
    assert(emp!.indexStatus === "success", "Employee indexStatus success");

    const co = objectTypes.find((o) => o.apiName === "Company");
    assert(co !== undefined, "Company found in ontology summary");
    assert(co!.propertyCount === 5, "Company propertyCount 5");
    assert(co!.objectCount === 50, "Company objectCount 50");

    assert(ont.totalObjects === 1050, "ontology totalObjects 1050");
    assert(ont.linkTypes === 0, "ontology linkTypes 0");
    assert(ont.actionTypes === 0, "ontology actionTypes 0");
  }

  // =======================================================================
  // 2. PostgreSQL down, OpenSearch up — degraded
  // =======================================================================
  console.log("\n=== 2. PostgreSQL down, OpenSearch up ===");
  {
    const deps = createMockDeps({
      pgUp: false,
      osUp: true,
      osObjectTypes: [
        { apiName: "employee", indexName: "ontology-employee", count: 500, sizeBytes: 200000 },
      ],
    });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded is not 503)");
    assert(body.status === "degraded", "status is degraded");

    const svc = body.services as Record<string, unknown>;
    const pg = svc.postgresql as Record<string, unknown>;
    assert(pg.connected === false, "pg not connected");

    const tables = pg.tables as Record<string, TableCount>;
    assert(tables.ontology.error === "database unreachable", "tables have error");

    const os = svc.opensearch as Record<string, unknown>;
    assert(os.connected === true, "os connected");
  }

  // =======================================================================
  // 3. PostgreSQL up, OpenSearch down — degraded
  // =======================================================================
  console.log("\n=== 3. PostgreSQL up, OpenSearch down ===");
  {
    const deps = createMockDeps({
      pgUp: true,
      pgTables: { ontology: 1, object_type: 0, property: 0, backing_datasource: 0, link_type: 0, action_type: "missing", ontology_edit: "missing", funnel_pipeline_state: 0 },
      osUp: false,
      pipelineStates: [
        {
          object_type_api_name: "Employee",
          status: "failed",
          last_indexed_at: null,
          objects_indexed: null,
          duration_ms: null,
          datasource_version: null,
          error_message: "OpenSearch unreachable",
          retry_count: 1,
          created_at: "2025-03-11T10:00:00Z",
          updated_at: "2025-03-11T10:05:00Z",
        },
      ],
    });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 200, "statusCode is 200 (degraded)");
    assert(body.status === "degraded", "status is degraded");

    const svc = body.services as Record<string, unknown>;
    assert((svc.postgresql as Record<string, unknown>).connected === true, "pg connected");
    assert((svc.opensearch as Record<string, unknown>).connected === false, "os not connected");

    // Object type from pipeline state should still appear
    const ont = body.ontology as Record<string, unknown>;
    const objectTypes = ont.objectTypes as ObjectTypeSummary[];
    assert(objectTypes.length === 1, "1 object type from pipeline state");
    assert(objectTypes[0].indexStatus === "failed", "indexStatus failed");
    assert(objectTypes[0].objectCount === 0, "objectCount 0 (no OS data)");
  }

  // =======================================================================
  // 4. Both services down — unhealthy
  // =======================================================================
  console.log("\n=== 4. Both services down ===");
  {
    const deps = createMockDeps({ pgUp: false, osUp: false });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 503, "statusCode is 503");
    assert(body.status === "unhealthy", "status is unhealthy");

    const svc = body.services as Record<string, unknown>;
    assert((svc.postgresql as Record<string, unknown>).connected === false, "pg not connected");
    assert((svc.opensearch as Record<string, unknown>).connected === false, "os not connected");
  }

  // =======================================================================
  // 5. Uptime formatting
  // =======================================================================
  console.log("\n=== 5. Uptime formatting ===");
  {
    assert(formatUptime(0) === "0h 0m 0s", `0s => '0h 0m 0s' (got: '${formatUptime(0)}')`);
    assert(formatUptime(59) === "0h 0m 59s", `59s => '0h 0m 59s' (got: '${formatUptime(59)}')`);
    assert(formatUptime(60) === "0h 1m 0s", `60s => '0h 1m 0s' (got: '${formatUptime(60)}')`);
    assert(formatUptime(3600) === "1h 0m 0s", `3600s => '1h 0m 0s' (got: '${formatUptime(3600)}')`);
    assert(formatUptime(3661) === "1h 1m 1s", `3661s => '1h 1m 1s' (got: '${formatUptime(3661)}')`);
    assert(formatUptime(30615) === "8h 30m 15s", `30615s => '8h 30m 15s' (got: '${formatUptime(30615)}')`);
    assert(formatUptime(86400) === "24h 0m 0s", `86400s => '24h 0m 0s' (got: '${formatUptime(86400)}')`);
    assert(formatUptime(90061) === "25h 1m 1s", `90061s => '25h 1m 1s' (got: '${formatUptime(90061)}')`);
    // Fractional seconds truncated
    assert(formatUptime(1.7) === "0h 0m 1s", `1.7s => '0h 0m 1s' (got: '${formatUptime(1.7)}')`);
  }

  // =======================================================================
  // 6. Empty system — no object types, no indices
  // =======================================================================
  console.log("\n=== 6. Empty system ===");
  {
    const deps = createMockDeps({
      pgTables: {
        ontology: 0,
        object_type: 0,
        property: 0,
        backing_datasource: 0,
        link_type: 0,
        action_type: "missing",
        ontology_edit: "missing",
        funnel_pipeline_state: 0,
      },
      osObjectTypes: [],
      pipelineStates: [],
    });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 200, "statusCode 200");
    assert(body.status === "healthy", "status healthy");

    const ont = body.ontology as Record<string, unknown>;
    assert((ont.objectTypes as unknown[]).length === 0, "0 object types");
    assert(ont.totalObjects === 0, "totalObjects 0");

    const os = (body.services as Record<string, unknown>).opensearch as Record<string, unknown>;
    const indices = os.indices as Record<string, unknown>;
    assert(indices.count === 0, "0 indices");
    assert(indices.totalDocuments === 0, "0 documents");
  }

  // =======================================================================
  // 7. Missing tables handled gracefully
  // =======================================================================
  console.log("\n=== 7. Missing tables ===");
  {
    const deps = createMockDeps({
      pgTables: {
        ontology: 1,
        object_type: 2,
        property: 10,
        backing_datasource: 1,
        link_type: "missing",
        action_type: "missing",
        ontology_edit: "missing",
        funnel_pipeline_state: 1,
      },
    });

    const { statusCode, body } = await buildHealthResponse(deps);

    assert(statusCode === 200, "statusCode 200 despite missing tables");

    const tables = ((body.services as Record<string, unknown>).postgresql as Record<string, unknown>)
      .tables as Record<string, TableCount>;

    assert(tables.link_type.rowCount === 0, "link_type rowCount 0");
    assert(tables.link_type.error === "table does not exist", "link_type error msg");
    assert(tables.action_type.rowCount === 0, "action_type rowCount 0");
    assert(tables.action_type.error === "table does not exist", "action_type error msg");
    assert(tables.ontology_edit.rowCount === 0, "ontology_edit rowCount 0");
    assert(tables.ontology_edit.error === "table does not exist", "ontology_edit error msg");
  }

  // =======================================================================
  // 8. Version from package.json
  // =======================================================================
  console.log("\n=== 8. Version ===");
  {
    const deps = createMockDeps({ version: "2.5.0-beta" });
    const { body } = await buildHealthResponse(deps);
    assert(body.version === "2.5.0-beta", `version is '2.5.0-beta' (got: '${body.version}')`);
  }

  // =======================================================================
  // 9. Object types in pipeline state but not in OpenSearch
  // =======================================================================
  console.log("\n=== 9. Pipeline state without OS index ===");
  {
    const deps = createMockDeps({
      pgTables: {
        ontology: 1,
        object_type: 1,
        property: 5,
        backing_datasource: 1,
        link_type: 0,
        action_type: "missing",
        ontology_edit: "missing",
        funnel_pipeline_state: 1,
      },
      osObjectTypes: [], // no OS indices
      pipelineStates: [
        {
          object_type_api_name: "Employee",
          status: "running",
          last_indexed_at: null,
          objects_indexed: null,
          duration_ms: null,
          datasource_version: null,
          error_message: null,
          retry_count: 0,
          created_at: "2025-03-11T10:00:00Z",
          updated_at: "2025-03-11T10:00:00Z",
        },
      ],
      propertyCounts: [{ api_name: "Employee", cnt: 5 }],
    });

    const { body } = await buildHealthResponse(deps);
    const ont = body.ontology as Record<string, unknown>;
    const objectTypes = ont.objectTypes as ObjectTypeSummary[];

    assert(objectTypes.length === 1, "1 object type from pipeline state");
    assert(objectTypes[0].apiName === "Employee", "apiName Employee");
    assert(objectTypes[0].objectCount === 0, "objectCount 0 (not yet indexed)");
    assert(objectTypes[0].indexStatus === "running", "indexStatus running");
    assert(objectTypes[0].propertyCount === 5, "propertyCount from PG");
  }

  // =======================================================================
  // 10. OpenSearch cluster status yellow
  // =======================================================================
  console.log("\n=== 10. OpenSearch yellow status ===");
  {
    const deps = createMockDeps({
      osClusterStatus: "yellow",
      osNodeCount: 2,
    });

    const { body } = await buildHealthResponse(deps);
    assert(body.status === "healthy", "overall status still healthy");

    const os = ((body.services as Record<string, unknown>).opensearch as Record<string, unknown>);
    assert(os.clusterStatus === "yellow", "clusterStatus yellow");
    assert(os.nodeCount === 2, "nodeCount 2");
  }

  // =======================================================================
  // 11. Response shape completeness
  // =======================================================================
  console.log("\n=== 11. Response shape ===");
  {
    const deps = createMockDeps({});
    const { body } = await buildHealthResponse(deps);

    assert("status" in body, "has status");
    assert("timestamp" in body, "has timestamp");
    assert("services" in body, "has services");
    assert("ontology" in body, "has ontology");
    assert("uptime" in body, "has uptime");
    assert("version" in body, "has version");

    const svc = body.services as Record<string, unknown>;
    assert("postgresql" in svc, "has postgresql");
    assert("opensearch" in svc, "has opensearch");

    const pg = svc.postgresql as Record<string, unknown>;
    assert("connected" in pg, "pg has connected");
    assert("version" in pg, "pg has version");
    assert("tables" in pg, "pg has tables");

    const os = svc.opensearch as Record<string, unknown>;
    assert("connected" in os, "os has connected");
    assert("clusterName" in os, "os has clusterName");
    assert("clusterStatus" in os, "os has clusterStatus");
    assert("nodeCount" in os, "os has nodeCount");
    assert("indices" in os, "os has indices");

    const indices = os.indices as Record<string, unknown>;
    assert("count" in indices, "indices has count");
    assert("totalDocuments" in indices, "indices has totalDocuments");
    assert("totalSizeBytes" in indices, "indices has totalSizeBytes");
    assert("details" in indices, "indices has details");

    const ont = body.ontology as Record<string, unknown>;
    assert("objectTypes" in ont, "ont has objectTypes");
    assert("linkTypes" in ont, "ont has linkTypes");
    assert("actionTypes" in ont, "ont has actionTypes");
    assert("totalObjects" in ont, "ont has totalObjects");
  }

  // =======================================================================
  // 12. Timestamp is valid ISO 8601
  // =======================================================================
  console.log("\n=== 12. Timestamp format ===");
  {
    const deps = createMockDeps({});
    const { body } = await buildHealthResponse(deps);
    const ts = body.timestamp as string;
    const parsed = new Date(ts);
    assert(!isNaN(parsed.getTime()), "timestamp parses as valid date");
    assert(ts.endsWith("Z"), "timestamp ends with Z");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll health endpoint tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
