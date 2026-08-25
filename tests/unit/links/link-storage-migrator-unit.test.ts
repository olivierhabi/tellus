// ---------------------------------------------------------------------------
// linkStorageMigrator truthfulness: the serving-backend flag may flip to
// 'iceberg' ONLY on confirmed target-migration success with matching
// checksums. A failed target migration must leave storage_backend unchanged
// and record a first-class failure state.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LinkTypeRow } from "../../../src/models/linkType";

const linkType = (over: Partial<LinkTypeRow> = {}): LinkTypeRow =>
  ({
    link_type_id: "lt-1",
    api_name: "ownedBy",
    cardinality: "MANY_TO_MANY",
    storage_backend: "csv_legacy",
    join_table_file_path: "/nonexistent/path/join.csv", // countCsvRows → 0
    ...over,
  }) as unknown as LinkTypeRow;

// The SUT captures PYICEBERG_SIDECAR_URL at module load; use fresh module
// instances per test so each scenario controls the env.
async function harness(sidecarUrl?: string) {
  vi.resetModules();
  vi.restoreAllMocks();
  if (sidecarUrl) process.env.PYICEBERG_SIDECAR_URL = sidecarUrl;
  else delete process.env.PYICEBERG_SIDECAR_URL;
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const dbMod = await import("../../../src/db");
  vi.spyOn(dbMod, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
    executed.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 1 } as never;
  });
  const { migrateLinkStorage } = await import("../../../src/services/linkStorageMigrator");
  return { executed, migrateLinkStorage };
}

describe("migrateLinkStorage truthfulness", () => {
  const originalSidecar = process.env.PYICEBERG_SIDECAR_URL;
  beforeEach(() => {
    delete process.env.PYICEBERG_SIDECAR_URL;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSidecar) process.env.PYICEBERG_SIDECAR_URL = originalSidecar;
    else delete process.env.PYICEBERG_SIDECAR_URL;
  });

  it("sidecar unavailable ⇒ throws STORAGE_MIGRATION_FAILED, backend NOT flipped, failure recorded", async () => {
    const { executed, migrateLinkStorage } = await harness();
    await expect(migrateLinkStorage(linkType(), "ont-1")).rejects.toMatchObject({
      code: "STORAGE_MIGRATION_FAILED",
    });
    expect(executed.some((q) => q.sql.includes("SET storage_backend = 'iceberg'"))).toBe(false);
    expect(executed.some((q) => q.sql.includes("migration_failed_at = now()"))).toBe(true);
  });

  it("row-checksum mismatch ⇒ throws STORAGE_MIGRATION_FAILED, backend NOT flipped", async () => {
    const { executed, migrateLinkStorage } = await harness("http://sidecar");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rows: 7 }), { status: 200 })));
    // csvRows = 0 (missing file) but sidecar claims 7 rows → mismatch
    await expect(migrateLinkStorage(linkType(), "ont-1")).rejects.toMatchObject({
      code: "STORAGE_MIGRATION_FAILED",
    });
    expect(executed.some((q) => q.sql.includes("SET storage_backend = 'iceberg'"))).toBe(false);
  });

  it("confirmed success with matching checksum flips the flag and stamps completed_at", async () => {
    const { executed, migrateLinkStorage } = await harness("http://sidecar");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rows: 0 }), { status: 200 })));
    const res = await migrateLinkStorage(linkType(), "ont-1");
    expect(res.newBackend).toBe("iceberg");
    const flip = executed.find((q) => q.sql.includes("SET storage_backend = 'iceberg'"));
    expect(flip).toBeDefined();
    expect(flip!.sql).toContain("migration_completed_at = now()");
    expect(flip!.sql).toContain("migration_failed_at = NULL");
  });

  it("rejects non-M2M link types before touching state", async () => {
    const { migrateLinkStorage } = await harness();
    await expect(
      migrateLinkStorage(linkType({ cardinality: "ONE_TO_ONE" as never }), "ont-1"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
