/**
 * B5 — Cache TTL refresh integration test.
 *
 * Coverage of B5 contracts:
 *   B5 C-07 — Cache TTL 1 h base; refreshed on hit (expires_at = NOW() + 1h);
 *             hit_count incremented atomically.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../../src/db";
import { applyQuiverMigrations, teardownQuiverTables } from "./_harness";
import { CacheRepository } from "../../../src/services/quiver/compute/cache";

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await teardownQuiverTables();
});

describe("B5 C-07: TTL refreshed on hit; hit_count incremented atomically", () => {
  it("getAndTouch bumps hit_count and pushes expires_at into the future", async () => {
    const repo = new CacheRepository(pool);
    const row = await repo.put({
      cacheKey: "ck-c07",
      analysisRid: "ri.tellus-quiver.main.analysis.00000000-0000-7000-8000-000000000000",
      cardId: "$A",
      cardType: "OBJECT_SET",
      branchRid: "master",
      ontologyVersion: "ontology@master",
      resultType: "OBJECT_SET",
      payload: { kind: "stub" },
      ttlSeconds: 1, // short so we can verify the refresh extension is meaningful
    });
    expect(row.hitCount).toBe(0);

    // Pre-refresh expires_at snapshot
    const before = await pool.query(
      `SELECT expires_at FROM quiver_card_output_cache WHERE cache_key = $1`,
      ["ck-c07"],
    );
    const beforeExpires = new Date(before.rows[0].expires_at).getTime();

    // First touch
    const after1 = await repo.getAndTouch("ck-c07");
    expect(after1).not.toBeNull();
    expect(after1!.hitCount).toBe(1);

    // Second touch
    const after2 = await repo.getAndTouch("ck-c07");
    expect(after2!.hitCount).toBe(2);

    // expires_at should have been pushed forward to ~ NOW + 1h (we asked for 1s on insert).
    const after = await pool.query(
      `SELECT expires_at FROM quiver_card_output_cache WHERE cache_key = $1`,
      ["ck-c07"],
    );
    const afterExpires = new Date(after.rows[0].expires_at).getTime();
    // Refresh should have extended the row by at least 30 minutes.
    expect(afterExpires - beforeExpires).toBeGreaterThan(30 * 60 * 1000);
  });

  it("expired row → getAndTouch returns null", async () => {
    const repo = new CacheRepository(pool);
    await repo.put({
      cacheKey: "ck-c07-exp",
      analysisRid: "ri.tellus-quiver.main.analysis.00000000-0000-7000-8000-000000000000",
      cardId: "$A",
      cardType: "OBJECT_SET",
      branchRid: "master",
      ontologyVersion: "ontology@master",
      resultType: "OBJECT_SET",
      payload: {},
    });
    // Force expire
    await pool.query(
      `UPDATE quiver_card_output_cache SET expires_at = NOW() - INTERVAL '1 second' WHERE cache_key = $1`,
      ["ck-c07-exp"],
    );
    const r = await repo.getAndTouch("ck-c07-exp");
    expect(r).toBeNull();
  });
});
