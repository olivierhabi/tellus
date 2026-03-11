// ---------------------------------------------------------------------------
// Monday Integration Tests — Tasks 1-6, 8-19, 21-28
//
// End-to-end API tests against a running Express server. Uses the existing
// test suites (ontology, objectType, property, etc.) but wraps them in
// Vitest describe/it blocks for proper reporting.
//
// These tests require a running PostgreSQL instance. If the server cannot
// start, the entire suite is skipped gracefully.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Runner } from "../../helpers/runner";
import { ensureServer, stopServer } from "../../helpers/server";
import { createContext } from "./context";

import * as ontology from "./ontology.test";
import * as objectType from "./objectType.test";
import * as property from "./property.test";
import * as datasource from "./datasource.test";
import * as statistics from "./statistics.test";
import * as lifecycle from "./lifecycle.test";
import * as exportImport from "./exportImport.test";
import * as validation from "./validation.test";
import * as cleanup from "./cleanup.test";

// ---------------------------------------------------------------------------
// Service availability check
// ---------------------------------------------------------------------------

async function isPostgresAvailable(): Promise<boolean> {
  try {
    const { Pool } = require("pg");
    const pool = new Pool({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      database: process.env.PGDATABASE || "tellus_db",
      user: process.env.PGUSER || "tellus",
      password: process.env.PGPASSWORD || "tellus123",
      connectionTimeoutMillis: 3000,
    });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Monday Integration Tests", async () => {
  const pgAvailable = await isPostgresAvailable();

  if (!pgAvailable) {
    it.skip("PostgreSQL is not available — skipping integration tests", () => {});
    return;
  }

  const runner = new Runner();
  const ctx = createContext();

  beforeAll(async () => {
    await ensureServer();
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanup.cleanupLeftovers();
    } catch {
      // Ignore cleanup errors
    }
    stopServer();
  });

  const suites = [
    { name: "Ontology CRUD",          run: ontology.run },
    { name: "Object Type CRUD",       run: objectType.run },
    { name: "Property CRUD",          run: property.run },
    { name: "Datasource & Scanning",  run: datasource.run },
    { name: "Statistics",             run: statistics.run },
    { name: "Lifecycle Operations",   run: lifecycle.run },
    { name: "Export/Import",          run: exportImport.run },
    { name: "Validation & Guards",    run: validation.run },
    { name: "Cleanup & Cascades",     run: cleanup.run },
  ];

  for (const suite of suites) {
    it(`${suite.name}`, async () => {
      const beforeFailed = runner.failed;
      await suite.run(runner, ctx);
      expect(
        runner.failed,
        `${suite.name}: ${runner.failed - beforeFailed} test(s) failed`
      ).toBe(beforeFailed);
    });
  }

  it("all integration tests pass", () => {
    expect(runner.failed).toBe(0);
    expect(runner.passed).toBeGreaterThan(0);
  });
});
