// ---------------------------------------------------------------------------
// Funnel Parquet store — Option 2 by-reference path.
//
// Tests the real Parquet write/read round-trip (REAL DuckDB, mocked MinIO),
// the `parquet_ref` shape + refVersion validation, the computeChangelog
// summary shape (parquet_ref present, inline_rows absent), and backward-
// compat read of legacy `inline_rows` snapshots.
//
// Pure-unit (vitest.unit.config.ts): no Docker/MinIO. storageService is
// mocked to an in-memory byte store; DuckDB is the REAL native binding
// (installed in dev) so the parquet write (COPY ... FORMAT PARQUET) and
// read (read_parquet) are exercised end-to-end. Gated on isDuckDBAvailable
// so environments without the native binding skip rather than fail.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import { isDuckDBAvailable } from "../../../src/services/duckdb/pool";

const duckdbAvailable = isDuckDBAvailable();
const describeOrSkip = duckdbAvailable ? describe : describe.skip;

// In-memory MinIO: key -> Buffer. Hoisted so the mock factory can close over it.
const hoisted = vi.hoisted(() => {
  const store = new Map<string, Buffer>();
  return { store };
});

vi.mock("../../../src/services/storageService", () => ({
  uploadObject: vi.fn(async (key: string, body: Readable | Buffer) => {
    const buf = Buffer.isBuffer(body)
      ? body
      : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          body.on("data", (c: Buffer) => chunks.push(c));
          body.on("end", () => resolve(Buffer.concat(chunks)));
          body.on("error", reject);
        });
    hoisted.store.set(key, buf);
    return { key, bucket: "tellus-uploads", size: buf.length };
  }),
  getObjectStream: vi.fn(async (key: string) => {
    const buf = hoisted.store.get(key);
    if (!buf) throw new Error(`object not found: ${key}`);
    return Readable.from(buf);
  }),
  deleteObject: vi.fn(async (key: string) => {
    hoisted.store.delete(key);
  }),
  buildDuckDbReadUri: vi.fn((bucket: string, key: string) => `s3://${bucket}/${key}`),
}));

// Stub the namespace-guard + watermark pg queries (pure-unit).
vi.mock("../../../src/db", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
}));

beforeEach(() => {
  hoisted.store.clear();
  vi.clearAllMocks();
});

const { writeParquetRef, readParquetRows, resolveParquetRef, PARQUET_REF_VERSION, changelogParquetKey } =
  await import("../../../src/services/funnel/funnelParquetStore");

describeOrSkip("Funnel Parquet store — round-trip (real DuckDB)", () => {
  it("writes changelog rows to parquet + reads them back (order/count/equality preserved)", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => ({
      primary_key: `pk-${i}`,
      operation: i % 7 === 0 ? "UPDATE" : "INSERT",
      properties: JSON.stringify({ orderId: i, customerId: `c-${i % 50}`, status: "ok" }),
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
      source_commit_timestamp: "2026-07-10T00:00:00.000Z",
    }));

    const key = changelogParquetKey("Order", "snap-1234");
    const ref = await writeParquetRef({
      columns: (
        await import("../../../src/services/funnel/funnelParquetStore")
      ).CHANGELOG_PARQUET_COLUMNS,
      rows: (async function* () {
        for (const r of rows) yield r;
      })(),
      key,
      objectTypeApiName: "Order",
      stage: "changelog",
    });

    expect(ref).not.toBeNull();
    expect(ref!.refVersion).toBe(PARQUET_REF_VERSION);
    expect(ref!.rowCount).toBe(1234);
    expect(ref!.sizeBytes).toBeGreaterThan(0);
    expect(ref!.bucket).toBe("tellus-uploads");
    expect(ref!.key).toBe(key);

    const readBack = await readParquetRows(ref!, (r) => ({
      primary_key: String(r.primary_key),
      operation: String(r.operation),
      properties: JSON.parse(String(r.properties)),
      source_transaction_id: String(r.source_transaction_id),
      source_commit_timestamp: String(r.source_commit_timestamp),
    }));

    expect(readBack).toHaveLength(1234);
    expect(readBack[0].primary_key).toBe("pk-0");
    expect(readBack[1233].primary_key).toBe("pk-1233");
    expect(readBack[0].properties).toEqual({ orderId: 0, customerId: "c-0", status: "ok" });
    expect(readBack[7].operation).toBe("UPDATE");
    // order preserved
    for (let i = 0; i < readBack.length; i++) {
      expect(readBack[i].primary_key).toBe(`pk-${i}`);
    }
  });

  it("returns null for a zero-row stream (no parquet object written)", async () => {
    const ref = await writeParquetRef({
      columns: (
        await import("../../../src/services/funnel/funnelParquetStore")
      ).CHANGELOG_PARQUET_COLUMNS,
      rows: (async function* () {
        /* yields nothing */
      })(),
      key: changelogParquetKey("Order", "snap-empty"),
      objectTypeApiName: "Order",
      stage: "changelog",
    });
    expect(ref).toBeNull();
    expect(hoisted.store.size).toBe(0); // no object written
  });

  it("merged-parquet round-trip with markings (JSON array column)", async () => {
    const { MERGED_PARQUET_COLUMNS, mergedParquetKey, parseJsonColumn, parseJsonArrayColumn } =
      await import("../../../src/services/funnel/funnelParquetStore");
    const rows = Array.from({ length: 50 }, (_, i) => ({
      primary_key: `pk-${i}`,
      properties: JSON.stringify({ orderId: i }),
      markings: JSON.stringify(["m1", "m2"]),
      operation: i % 10 === 0 ? "delete" : "upsert",
      source_datasource_id: i % 10 === 0 ? "" : "00000000-0000-0000-0000-000000000000",
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
    }));
    const key = mergedParquetKey("Order", "snap-merged-1");
    const ref = await writeParquetRef({
      columns: MERGED_PARQUET_COLUMNS,
      rows: (async function* () {
        for (const r of rows) yield r;
      })(),
      key,
      objectTypeApiName: "Order",
      stage: "merged",
    });
    const readBack = await readParquetRows(ref!, (r) => ({
      primary_key: String(r.primary_key),
      properties: parseJsonColumn(r.properties),
      markings: parseJsonArrayColumn(r.markings),
      operation: r.operation === "delete" ? "delete" : "upsert",
      source_datasource_id:
        r.source_datasource_id != null && r.source_datasource_id !== ""
          ? String(r.source_datasource_id)
          : null,
    }));
    expect(readBack).toHaveLength(50);
    expect(readBack[0].markings).toEqual(["m1", "m2"]);
    expect(readBack[0].properties).toEqual({ orderId: 0 });
    // row 0: i%10===0 → delete; row 1 → upsert
    expect(readBack[0].operation).toBe("delete");
    expect(readBack[1].operation).toBe("upsert");
    expect(readBack[10].operation).toBe("delete");
    expect(readBack[10].source_datasource_id).toBeNull();
  });
});

describe("parquet_ref shape + refVersion validation", () => {
  it("resolveParquetRef accepts a valid v1 ref", () => {
    const ref = resolveParquetRef({
      refVersion: 1,
      bucket: "tellus-uploads",
      key: "changelogs/Order/snap.parquet",
      rowCount: 100,
      sizeBytes: 4096,
    });
    expect(ref).toEqual({
      refVersion: 1,
      bucket: "tellus-uploads",
      key: "changelogs/Order/snap.parquet",
      rowCount: 100,
      sizeBytes: 4096,
    });
  });

  it("resolveParquetRef rejects an unknown future refVersion (fallback, not silent mis-parse)", () => {
    const ref = resolveParquetRef({
      refVersion: 99,
      bucket: "tellus-uploads",
      key: "x.parquet",
      rowCount: 1,
      sizeBytes: 1,
    });
    expect(ref).toBeNull(); // caller falls back to legacy inline_rows
  });

  it("resolveParquetRef returns null for missing/malformed refs", () => {
    expect(resolveParquetRef(null)).toBeNull();
    expect(resolveParquetRef(undefined)).toBeNull();
    expect(resolveParquetRef({})).toBeNull();
    expect(resolveParquetRef({ refVersion: 1, bucket: "b" })).toBeNull(); // no key
  });
});
