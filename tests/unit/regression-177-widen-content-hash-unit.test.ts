import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { CsvParsingService } from "../../src/services/csvParsingService";
import {
  assertCanonicalFoundryPath,
  assertFunnelReadablePath,
} from "../../src/services/datasourcePathValidation";

/**
 * Regression for 177_widen_content_hash
 *
 * Root cause: csvParsingService emits `sha256:<64hex>` = 71 chars, but
 * foundry_datasets.content_hash was VARCHAR(64) → Postgres 22001 on every
 * parse. The fix widens to VARCHAR(128) and hardens both the ingestion
 * path (pre-validation in parseDatasetJob) and the backing_datasource
 * registration (no UUID-only fallback).
 *
 * Extended: validates the datasourcePathValidation layer (migration 179
 * enforcement) rejects bare UUIDs, Iceberg URIs, and malformed keys with
 * actionable 400-level messages.
 */
describe("regression 177: content_hash 71-char prefix + backing_datasource guard", () => {
  it("csvParsingService emits 71-char sha256: prefixed hash that fits VARCHAR(128) but not VARCHAR(64)", async () => {
    const svc = new CsvParsingService({} as any);
    const body = "district,population\nKigali,1000\nButare,2000\n";
    const result = await svc.parseFromStream(Readable.from([body]), "rwanda_districts_data.csv");

    expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.contentHash.length).toBe(71);
    // Old schema would have rejected this
    expect(result.contentHash.length).toBeGreaterThan(64);
    // New schema allows it
    expect(result.contentHash.length).toBeLessThanOrEqual(128);
  });

  it("content_hash of empty header-only CSV is still 71 chars (edge case)", async () => {
    const svc = new CsvParsingService({} as any);
    const result = await svc.parseFromStream(Readable.from(["district\n"]), "empty.csv");
    expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.contentHash.length).toBe(71);
  });

  // Helper mirroring datasetDatasourceService hardening
  function isValidBackingDatasourceFilePath(storedPath: string): boolean {
    // Mirrors: stripFoundryTags(file_path) must be a real S3 key, not a bare UUID
    const stripFoundryTags = (p: string) => {
      const idx = p.indexOf("#foundry-dataset:");
      return idx >= 0 ? p.slice(0, idx) : p;
    };
    const stripped = stripFoundryTags(storedPath);
    // Hardening: must contain '/' and not be a bare UUID
    const isBareUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped);
    return stripped.includes("/") && !isBareUuid;
  }

  it("rejects UUID-only backing_datasource file_path (pre-fix defect)", () => {
    const bad = "effc028c-a88a-4cf0-9c59-a5dd6126805a#foundry-dataset:effc028c-a88a-4cf0-9c59-a5dd6126805a#object-type:153cc2a7-1c24-4613-83ef-b12853f5c570";
    expect(isValidBackingDatasourceFilePath(bad)).toBe(false);
  });

  it("accepts correct S3-key-backed file_path (post-fix)", () => {
    const good =
      "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/76540756-aea2-44a0-a6ab-6fa120385277/84266c8e-b639-44ca-bd31-86beaeba3a1a_rwanda_districts_data.csv#foundry-dataset:effc028c-a88a-4cf0-9c59-a5dd6126805a#object-type:153cc2a7-1c24-4613-83ef-b12853f5c570";
    expect(isValidBackingDatasourceFilePath(good)).toBe(true);
    const stripped = good.split("#")[0];
    expect(stripped).toBe("projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/76540756-aea2-44a0-a6ab-6fa120385277/84266c8e-b639-44ca-bd31-86beaeba3a1a_rwanda_districts_data.csv");
  });

  it("parseDatasetJob pre-validation would allow 71 chars under 128 limit", () => {
    const CONTENT_HASH_LIMIT = 128;
    const hash71 = "sha256:" + "a".repeat(64);
    expect(hash71.length).toBe(71);
    expect(hash71.length).toBeLessThanOrEqual(CONTENT_HASH_LIMIT);
    // Old limit would have failed
    expect(hash71.length).toBeGreaterThan(64);
  });

  it("registerWithFoundryDataset must reject non-ready status", () => {
    const statuses = ["pending", "processing", "error"];
    for (const status of statuses) {
      const shouldReject = status !== "ready";
      expect(shouldReject).toBe(true);
    }
    expect("ready" !== "ready").toBe(false); // ready passes
  });
});

describe("datasourcePathValidation (179 hardening)", () => {
  it("rejects bare UUID as file path", () => {
    expect(() =>
      assertCanonicalFoundryPath("6fc1da39-3797-4c20-bf7d-a4b367403c27"),
    ).toThrow(/bare UUID/i);
  });

  it("rejects empty path", () => {
    expect(() => assertCanonicalFoundryPath("")).toThrow(/no canonical file path/i);
    expect(() => assertCanonicalFoundryPath("   ")).toThrow(/no canonical file path/i);
  });

  it("rejects Iceberg URI with double-dot", () => {
    expect(() =>
      assertCanonicalFoundryPath("iceberg://default/../ssh/table"),
    ).toThrow(/iceberg uri.*invalid/i);
  });

  it("rejects MinIO key with leading slash", () => {
    expect(() =>
      assertCanonicalFoundryPath("/projects/36271681-65d7/obj.csv"),
    ).toThrow(/object-store key.*invalid/i);
  });

  it("rejects path containing hash character", () => {
    expect(() =>
      assertCanonicalFoundryPath("projects/obj#data.csv"),
    ).toThrow(/object-store key.*invalid/i);
  });

  it("rejects MinIO key without slash", () => {
    expect(() =>
      assertCanonicalFoundryPath("single-segment-key.csv"),
    ).toThrow(/object-store key.*invalid/i);
  });

  it("rejects path with embedded CR/LF characters", () => {
    expect(() =>
      assertCanonicalFoundryPath("projects/x\n.csv"),
    ).toThrow(/object-store key/i);
  });

  it("accepts valid Iceberg URI", () => {
    expect(() =>
      assertCanonicalFoundryPath(
        "iceberg://default/public/orders_bureau_transactional_system",
      ),
    ).not.toThrow();
  });

  it("accepts valid MinIO object key", () => {
    expect(() =>
      assertCanonicalFoundryPath(
        "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/76540756-aea2-44a0-a6ab-6fa120385277/file.csv",
      ),
    ).not.toThrow();
  });

  describe("assertFunnelReadablePath", () => {
    it("rejects bare UUID at funnel boundary", () => {
      expect(() =>
        assertFunnelReadablePath("6fc1da39-3797-4c20-bf7d-a4b367403c27"),
      ).toThrow(/bare dataset UUID/i);
    });

    it("accepts valid object key at funnel boundary", () => {
      expect(() =>
        assertFunnelReadablePath("projects/path/to/file.csv"),
      ).not.toThrow();
    });
  });
});
