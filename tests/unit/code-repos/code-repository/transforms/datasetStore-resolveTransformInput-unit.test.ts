// ---------------------------------------------------------------------------
// datasetStore-resolveTransformInput-unit.test.ts — logic tests for the
// Foundry-catalog input bridge.
//
// resolveTransformInput bridges the transform runtime to BOTH dataset stores:
// the `dataset` table (transform/upload datasets, on-disk) AND `foundry_datasets`
// (the Foundry catalog; object storage, staged to a temp CSV the python driver
// reads). These pin the routing + the staging contract with pool + getObjectStream
// mocked (readCSV/the python driver consume the staged file in the harness +
// E2E tests). The no-leak cleanup is pinned in previewHarness-unit.test.ts.
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Readable } from "stream";

vi.mock("../../../../../src/db.js", () => ({
  pool: { query: vi.fn() },
  getClient: vi.fn(),
}));
vi.mock("../../../../../src/services/storageService.js", () => ({
  getObjectStream: vi.fn(),
}));
vi.mock("../../../../../src/services/fileScannerService.js", () => ({
  scanFile: vi.fn(),
}));

vi.mock("../../../../../src/services/codeRepository/transforms/authz.js", () => ({
  // These tests pin the BRIDGE logic, not authz (covered by authz-unit.test.ts).
  // Mocking authz also avoids loading foundryDb (requireSecret) at import.
  assertDatasetAccess: vi.fn().mockResolvedValue(undefined),
}));
import { resolveTransformInput } from "../../../../../src/services/codeRepository/transforms/datasetStore";
import { pool } from "../../../../../src/db";
import { getObjectStream } from "../../../../../src/services/storageService";

const mockedPool = pool as unknown as { query: { mockImplementation: (fn: (...a: unknown[]) => unknown) => void; mock: { calls: unknown[][] } } };
const mockedGetObjectStream = getObjectStream as unknown as { mockImplementation: (fn: (key: string) => unknown) => void; mock: { calls: unknown[][] } };

const UUID = "c3a54ed5-19a3-4394-a66b-7e8b0d5dee95";
// P0 authz: superadmin bypass skips the effectiveRole check (no DB hit) — the
// test exercises the RESOLUTION logic, not authz (covered by authz-unit.test.ts).
const SUPERADMIN = { userId: "test-superadmin", roles: ["tellus-superadmin"] };
const FOUNDRY_RID = `ri.foundry.main.dataset.${UUID}`;
const S3_KEY = "projects/abc/folders/def/orders.csv";
const CSV_BYTES = "order_id,customer,amount,status\n1,alice,120,completed\n2,bob,0,cancelled\n3,carol,80,completed\n";

const qResult = (rows: unknown[]) => ({ rows, rowCount: rows.length });

const stagedDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stagedDirs.length = 0;
  // Default: dataset-table miss, no foundry lookup unless a test overrides.
  mockedPool.query.mockImplementation(async (sqlOrObj: unknown) => {
    const sql = typeof sqlOrObj === "string" ? sqlOrObj : (sqlOrObj as { text?: string }).text ?? "";
    if (/FROM\s+dataset\s+WHERE\s+rid/i.test(sql)) return qResult([]); // dataset-table miss
    if (/FROM\s+foundry_datasets/i.test(sql)) return qResult([]); // no foundry row
    return qResult([]);
  });
  // Default: stream the CSV bytes to the staged file.
  mockedGetObjectStream.mockImplementation(async () => Readable.from([Buffer.from(CSV_BYTES)]));
});

// resolveTransformInput stages to a temp dir; clean anything left so a missed
// cleanup assertion doesn't pollute the next test.
afterEach(() => {
  for (const d of stagedDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

// Helper: make the dataset-table query return a resolved on-disk row.
function datasetTableHit(filePath: string) {
  mockedPool.query.mockImplementation(async (sqlOrObj: unknown) => {
    const sql = typeof sqlOrObj === "string" ? sqlOrObj : (sqlOrObj as { text?: string }).text ?? "";
    if (/FROM\s+dataset\s+WHERE\s+rid/i.test(sql)) return qResult([{ dataset_id: "ds-1", file_format: "csv", storage_path: null }]);
    if (/FROM\s+dataset_transaction/i.test(sql)) return qResult([{ file_path: filePath }]); // committed tx
    if (/FROM\s+foundry_datasets/i.test(sql)) return qResult([]);
    return qResult([]);
  });
}

describe("resolveTransformInput — dataset-table path (unchanged behavior)", () => {
  it("returns origin 'dataset-table' + stagedPath null when the rid is in the dataset table", async () => {
    const onDisk = path.join(os.tmpdir(), "ondisk-input.csv");
    fs.writeFileSync(onDisk, CSV_BYTES);
    datasetTableHit(onDisk);

    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).not.toBeNull();
    expect(r!.origin).toBe("dataset-table");
    expect(r!.stagedPath).toBeNull();
    expect(r!.filePath).toBe(onDisk);
    expect(r!.fileFormat).toBe("csv");
    // No object-storage staging happened (the file is already on disk).
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0);
  });
});

describe("resolveTransformInput — Foundry-catalog bridge", () => {
  function foundryRow(opts: Partial<{ file_path: string; format: string; mime_type: string; status: string }> = {}) {
    mockedPool.query.mockImplementation(async (sqlOrObj: unknown) => {
      const sql = typeof sqlOrObj === "string" ? sqlOrObj : (sqlOrObj as { text?: string }).text ?? "";
      if (/FROM\s+dataset\s+WHERE\s+rid/i.test(sql)) return qResult([]); // dataset miss
      if (/FROM\s+foundry_datasets/i.test(sql)) return qResult([{
        file_path: opts.file_path ?? S3_KEY,
        format: opts.format ?? "csv",
        mime_type: opts.mime_type ?? "text/csv",
        status: opts.status ?? "ready",
      }]);
      return qResult([]);
    });
  }

  it("stages a csv/ready foundry row to a temp CSV + returns origin 'foundry-bridge'", async () => {
    foundryRow();
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).not.toBeNull();
    expect(r!.origin).toBe("foundry-bridge");
    expect(r!.datasetId).toBe(UUID);
    expect(r!.fileFormat).toBe("csv");
    expect(r!.stagedPath).not.toBeNull();
    // The staged file exists + carries the streamed bytes.
    expect(fs.existsSync(r!.stagedPath!)).toBe(true);
    expect(fs.readFileSync(r!.stagedPath!, "utf8")).toBe(CSV_BYTES);
    // The driver reads the staged temp path.
    expect(r!.filePath).toBe(r!.stagedPath);
    // getObjectStream was called with the S3 key (tags stripped).
    expect(mockedGetObjectStream.mock.calls[0][0]).toBe(S3_KEY);
    // Track for cleanup.
    stagedDirs.push(path.dirname(r!.stagedPath!));
  });

  it("strips a '#foundry-dataset:' tag from the file_path before reading", async () => {
    foundryRow({ file_path: `${S3_KEY}#foundry-dataset:synced` });
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).not.toBeNull();
    expect(mockedGetObjectStream.mock.calls[0][0]).toBe(S3_KEY); // tag stripped
    stagedDirs.push(path.dirname(r!.stagedPath!));
  });

  it("returns null for an Iceberg-backed foundry row (driver reads CSV only)", async () => {
    foundryRow({ format: "iceberg", mime_type: "application/x-iceberg" });
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).toBeNull();
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0); // never staged
  });

  it("returns null when the foundry row is not 'ready'", async () => {
    foundryRow({ status: "processing" });
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).toBeNull();
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0);
  });

  it("returns null when the foundry row has no file_path", async () => {
    foundryRow({ file_path: "" });
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).toBeNull();
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0);
  });

  it("returns null when the uuid suffix is not in foundry_datasets", async () => {
    foundryRow(); // foundry query returns [] anyway via the default, but force it:
    mockedPool.query.mockImplementation(async (sqlOrObj: unknown) => {
      const sql = typeof sqlOrObj === "string" ? sqlOrObj : (sqlOrObj as { text?: string }).text ?? "";
      if (/FROM\s+dataset\s+WHERE\s+rid/i.test(sql)) return qResult([]);
      if (/FROM\s+foundry_datasets/i.test(sql)) return qResult([]); // uuid unknown
      return qResult([]);
    });
    const r = await resolveTransformInput(FOUNDRY_RID, "main", SUPERADMIN);
    expect(r).toBeNull();
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0);
  });
});

describe("resolveTransformInput — routing (no spurious foundry lookup)", () => {
  it("does NOT query foundry_datasets when the rid suffix is not a UUID (slug rids)", async () => {
    // A dataset-table-style slug rid that misses the dataset table must NOT
    // trigger a foundry_datasets lookup (the suffix can't be a uuid id).
    mockedPool.query.mockImplementation(async () => qResult([])); // everything misses
    const r = await resolveTransformInput("ri.foundry.main.dataset.orders-raw-8ded8dae", "main", SUPERADMIN);
    expect(r).toBeNull();
    // Only the dataset-table query fired — foundry_datasets was never queried.
    const sqls = mockedPool.query.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : (c[0] as { text?: string }).text ?? ""));
    expect(sqls.some((s) => /FROM\s+foundry_datasets/i.test(s))).toBe(false);
    expect(mockedGetObjectStream.mock.calls).toHaveLength(0);
  });
});
