// ---------------------------------------------------------------------------
// datasetStore-materializeOutput-foundry-unit.test.ts — the Foundry-catalog
// OUTPUT bridge in materializeOutput.
//
// A transform Output("ri.foundry.main.dataset.<uuid>") targets a `foundry_datasets`
// catalog row; the dataset page reads foundry_datasets.file_path (MinIO), NOT the
// `dataset` table the build writes. materializeOutput now ALSO uploads the output
// to S3 + UPDATEs foundry_datasets (atomic with the dataset-table tx) so the
// catalog reflects the build. Slug-rid outputs are unchanged (gated on the uuid
// match). These pin the write path + the rollback orphan-cleanup.
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Set DATA_DIR before datasetStore loads (vi.hoisted runs before imports) so
// materializeOutput's moveInto writes to a temp data dir, not the project's
// ./data. Unique per worker (process.pid) so parallel files don't collide.
vi.hoisted(() => {
  process.env.DATA_DIR = `/tmp/tellus-mat-test-${process.pid}`;
});

vi.mock("../../../../../src/db.js", () => ({
  pool: { query: vi.fn() },
  getClient: vi.fn(),
}));
vi.mock("../../../../../src/services/storageService.js", () => ({
  uploadObject: vi.fn(),
  deleteObject: vi.fn(),
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
import { materializeOutput } from "../../../../../src/services/codeRepository/transforms/datasetStore";
import { getClient } from "../../../../../src/db";
import { uploadObject, deleteObject } from "../../../../../src/services/storageService";
import { scanFile } from "../../../../../src/services/fileScannerService";

const mockedGetClient = getClient as unknown as { mockImplementation: (fn: () => unknown) => void };
const mockedUpload = uploadObject as unknown as { mock: { calls: unknown[][] }; mockImplementation: (fn: () => unknown) => void };
const mockedDelete = deleteObject as unknown as { mock: { calls: unknown[][] }; mockImplementation: (fn: () => unknown) => void };
const mockedScan = scanFile as unknown as { mockImplementation: (fn: () => unknown) => void };

// P0 authz: superadmin bypass skips the write-check (no DB hit) — this test pins the
// OUTPUT bridge (upload + foundry_datasets UPDATE + rollback), not authz.
const SUPERADMIN = { userId: "test-superadmin", roles: ["tellus-superadmin"] };
const FOUNDRY_RID = "ri.foundry.main.dataset.5786dafb-265a-47b6-a92f-f5bc6af7a9b9";
const SLUG_RID = "ri.foundry.main.dataset.lightweight-preview-out";

const SCAN = {
  columnNames: ["order_id", "customer_id", "status", "assignee"],
  rowCount: 746,
  schemaHash: "hash-5786",
  inferredTypes: { order_id: "string", customer_id: "string", status: "string", assignee: "string" },
};

/** Build a mock PoolClient whose .query routes by SQL keyword. Returns the list
 * of (sql, params) calls so tests assert what fired + in what order. */
function makeClient(opts: { foundryRow?: unknown; priorSchema?: { column_names: string[]; schema_hash: string } | null }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    // Route by unique substrings (the SQL is multi-line — avoid `.*` across newlines).
    if (/FROM foundry_datasets WHERE id/i.test(sql)) {
      return { rows: opts.foundryRow ? [opts.foundryRow] : [], rowCount: opts.foundryRow ? 1 : 0 };
    }
    if (/FROM dataset WHERE rid/i.test(sql)) return { rows: [], rowCount: 0 }; // new dataset (FOR UPDATE)
    if (/RETURNING dataset_id/i.test(sql)) return { rows: [{ dataset_id: "ds-new-uuid" }], rowCount: 1 }; // INSERT dataset
    if (/FROM dataset_schema_version/i.test(sql)) {
      return { rows: opts.priorSchema ? [opts.priorSchema] : [], rowCount: opts.priorSchema ? 1 : 0 };
    }
    if (/^COMMIT$/i.test(sql.trim())) { committed = true; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK$/i.test(sql.trim())) { rolledBack = true; return { rows: [], rowCount: 0 }; }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: vi.fn() };
  return { client, calls, isCommitted: () => committed, isRolledBack: () => rolledBack };
}

let csvPath: string;
let csvDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockedScan.mockImplementation(() => SCAN);
  // The real uploadObject reads the streamed body to S3; the mock must DRAIN it
  // (read the file while it still exists), else the lazy Readable opens AFTER
  // moveInto renamed csvPath -> unhandled ENOENT.
  mockedUpload.mockImplementation(async (_key: unknown, body: unknown) => {
    const r = body as { on?: (e: string, cb: () => void) => void; resume?: () => void };
    if (r && typeof r.on === "function" && typeof r.resume === "function") {
      await new Promise<void>((res) => { r.on!("end", res); r.on!("error", res); r.resume!(); });
    }
  });
  fs.mkdirSync(process.env.DATA_DIR!, { recursive: true });
  csvDir = fs.mkdtempSync(path.join(os.tmpdir(), "tellus-mat-csv-"));
  csvPath = path.join(csvDir, "out.csv");
  fs.writeFileSync(csvPath, "order_id,customer_id\n1,c\n");
});

afterEach(() => {
  try { fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(csvDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("materializeOutput — Foundry-catalog output bridge", () => {
  it("uploads the output to S3 + UPDATEs foundry_datasets atomically (catalog reflects the build)", async () => {
    const { client, calls, isCommitted } = makeClient({ foundryRow: { project_id: "proj-123" } });
    mockedGetClient.mockImplementation(() => client);

    const res = await materializeOutput({
      rid: FOUNDRY_RID, name: "lightweight_transform", csvFilePath: csvPath,
      transactionType: "SNAPSHOT", actor: "cypress", branch: "main", buildRid: "build-abc",
      principal: SUPERADMIN,
    });

    // The S3 upload fired with the transform-outputs key under the project.
    expect(mockedUpload.mock.calls).toHaveLength(1);
    expect(mockedUpload.mock.calls[0][0]).toBe("projects/proj-123/transform-outputs/build-abc/lightweight_transform.csv");
    expect(mockedUpload.mock.calls[0][2]).toBe("text/csv");
    // No orphan cleanup (success).
    expect(mockedDelete.mock.calls).toHaveLength(0);

    // The foundry_datasets UPDATE fired in the tx (atomic with the dataset-table write).
    const upd = calls.find((c) => /UPDATE foundry_datasets/i.test(c.sql));
    expect(upd).toBeDefined();
    expect(upd!.params[0]).toBe("projects/proj-123/transform-outputs/build-abc/lightweight_transform.csv"); // file_path
    expect(upd!.params[2]).toBe(746); // row_count
    expect(upd!.params[5]).toBe("5786dafb-265a-47b6-a92f-f5bc6af7a9b9"); // WHERE id

    // The dataset-table path still ran (lineage + build-panel preview backing).
    expect(calls.some((c) => /RETURNING dataset_id/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO dataset_transaction/i.test(c.sql))).toBe(true);
    expect(isCommitted()).toBe(true);
    // The materialize result carries the new dataset-table id + columns.
    expect(res.datasetId).toBe("ds-new-uuid");
    expect(res.columns).toEqual(SCAN.columnNames);
  });

  it("does NOT touch foundry_datasets for a slug-rid output (regression guard)", async () => {
    const { client, calls, isCommitted } = makeClient({ foundryRow: null }); // no foundry row anyway
    mockedGetClient.mockImplementation(() => client);

    await materializeOutput({
      rid: SLUG_RID, name: "lightweight_transform", csvFilePath: csvPath,
      transactionType: "SNAPSHOT", actor: "cypress", branch: "main", buildRid: "build-abc",
      principal: SUPERADMIN,
    });

    // No S3 upload + no foundry_datasets UPDATE — the slug rid's suffix isn't a
    // uuid, so the detect branch is skipped entirely.
    expect(mockedUpload.mock.calls).toHaveLength(0);
    expect(calls.some((c) => /UPDATE foundry_datasets/i.test(c.sql))).toBe(false);
    // The detect query itself was NOT issued (UUID_RE guard short-circuits).
    expect(calls.some((c) => /FROM foundry_datasets WHERE id/i.test(c.sql))).toBe(false);
    // The dataset-table path still committed normally.
    expect(calls.some((c) => /RETURNING dataset_id/i.test(c.sql))).toBe(true);
    expect(isCommitted()).toBe(true);
  });

  it("rolls back + deletes the orphaned S3 object on a breaking-schema failure", async () => {
    // Prior schema_version has columns the new output DROPS -> breaking -> throw.
    const { client, calls, isCommitted, isRolledBack } = makeClient({
      foundryRow: { project_id: "proj-123" },
      priorSchema: { column_names: ["officegoods_customer_id", "bureau_customer_id"], schema_hash: "old-hash" },
    });
    mockedGetClient.mockImplementation(() => client);

    await expect(materializeOutput({
      rid: FOUNDRY_RID, name: "lightweight_transform", csvFilePath: csvPath,
      transactionType: "SNAPSHOT", actor: "cypress", branch: "main", buildRid: "build-abc",
      principal: SUPERADMIN,
    })).rejects.toThrow(/BreakingSchemaChange/);

    // The S3 upload happened before BEGIN; the rollback must delete the orphan.
    expect(mockedUpload.mock.calls).toHaveLength(1);
    expect(mockedDelete.mock.calls).toHaveLength(1);
    expect(mockedDelete.mock.calls[0][0]).toBe("projects/proj-123/transform-outputs/build-abc/lightweight_transform.csv");
    // The foundry_datasets UPDATE never fired (the schema guard threw before it).
    expect(calls.some((c) => /UPDATE foundry_datasets/i.test(c.sql))).toBe(false);
    expect(isCommitted()).toBe(false);
    expect(isRolledBack()).toBe(true);
  });
});
