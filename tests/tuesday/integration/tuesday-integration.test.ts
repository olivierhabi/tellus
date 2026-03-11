// ---------------------------------------------------------------------------
// Tuesday Integration Tests — Tasks 27-28
//
// 1. Full Indexing Pipeline (Task 28) — 87 tests across 14 phases.
//    Uses dependency injection. Always runs.
//
// 2. Link Resolver (Task 27) — 30 tests across 10 sections.
//    Requires live PostgreSQL + OpenSearch. Skips gracefully if unavailable.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { executeSelfTest } from "../../helpers/selfTestBridge";

// ---------------------------------------------------------------------------
// Service availability checks
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

async function isOpenSearchAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:9200", { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Tuesday Integration Tests", () => {
  describe("Full Indexing Pipeline (Task 28)", () => {
    it("passes all 14 phases", () => {
      const result = executeSelfTest("src/tests/indexing/fullPipelineTest.ts", 120_000);

      expect(result.failed, `Pipeline: ${result.failed} assertion(s) failed\n${result.output}`)
        .toBe(0);
      expect(result.passed).toBeGreaterThanOrEqual(80);
    });
  });

  describe("Link Resolver (Task 27)", async () => {
    const [pgOk, osOk] = await Promise.all([
      isPostgresAvailable(),
      isOpenSearchAvailable(),
    ]);

    if (!pgOk || !osOk) {
      it.skip(
        `requires PostgreSQL (${pgOk ? "UP" : "DOWN"}) + OpenSearch (${osOk ? "UP" : "DOWN"})`,
        () => {}
      );
      return;
    }

    it("passes all cardinality tests", () => {
      const result = executeSelfTest("tests/linkResolvers.test.ts", 180_000);

      expect(result.failed, `LinkResolver: ${result.failed} assertion(s) failed\n${result.output}`)
        .toBe(0);
      expect(result.passed).toBeGreaterThanOrEqual(25);
    });
  });
});
