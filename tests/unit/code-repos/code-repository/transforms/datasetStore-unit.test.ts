// ---------------------------------------------------------------------------
// Unit tests for datasetStore.ts (mocked pool — no DB).
//
// Covers the two flagged bug-prone spots in the incremental path:
//   - resolvePreviousTransaction: the SQL must use LIMIT 1 OFFSET 1 to read
//     the SECOND-newest committed transaction. If OFFSET 1 is dropped it
//     returns the CURRENT transaction, so is_incremental would be true on
//     the very first build (wrong) and mode='previous' would read the
//     in-progress output (wrong). This test pins OFFSET 1.
//   - resolveDatasetByRid: the latest-committed-tx resolution + the
//     storage_path fallback.
// Plus the failure path the user explicitly asked about — does
// materializeOutput roll back cleanly or land half-committed when a DB step
// fails mid-transaction? (It rolls back: ROLLBACK is issued, COMMIT is not,
// the client is released, and the error rethrows.)
// ---------------------------------------------------------------------------
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Mock the db module (pool.query + getClient) BEFORE importing datasetStore.
vi.mock("../../../../../src/db", () => ({
  pool: { query: vi.fn() },
  getClient: vi.fn(),
}));
// Mock scanFile so materializeOutput doesn't touch the real file scanner.
vi.mock("../../../../../src/services/fileScannerService", () => ({
  scanFile: vi.fn(),
}));

import {
  resolveDatasetByRid,
  resolvePreviousTransaction,
  materializeOutput,
} from "../../../../../src/services/codeRepository/transforms/datasetStore";
import { pool, getClient } from "../../../../../src/db";
import { scanFile } from "../../../../../src/services/fileScannerService";

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const getClientFn = getClient as unknown as ReturnType<typeof vi.fn>;
const scanFn = scanFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// resolvePreviousTransaction — the OFFSET-1 regression guard.
// ===========================================================================
describe("resolvePreviousTransaction (the OFFSET-1 guard)", () => {
  it("returns null when the dataset RID does not exist", async () => {
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // dataset lookup
    const r = await resolvePreviousTransaction("ri.foundry.main.dataset.no");
    expect(r).toBeNull();
    // Only the dataset-lookup query should have run; no tx query.
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("returns null on the FIRST build (only 1 committed tx — OFFSET 1 yields nothing)", async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1" }] }); // dataset
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // tx (OFFSET 1) -> none
    const r = await resolvePreviousTransaction("ri.foundry.main.dataset.out");
    expect(r).toBeNull();
  });

  it("returns the second-newest committed tx file on the SECOND build", async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1" }] });
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ file_path: "/abs/prev.csv" }] });
    const r = await resolvePreviousTransaction("ri.foundry.main.dataset.out");
    expect(r).toEqual({ filePath: "/abs/prev.csv" });
  });

  it("resolves a relative file_path against the server CWD", async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1" }] });
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ file_path: "data/prev.csv" }] });
    const r = await resolvePreviousTransaction("ri.foundry.main.dataset.out");
    expect(r).not.toBeNull();
    expect(path.isAbsolute(r!.filePath)).toBe(true);
    expect(r!.filePath.endsWith("data/prev.csv")).toBe(true);
  });

  it("REGRESSION: the tx query SQL uses LIMIT 1 OFFSET 1 (not the current tx)", async () => {
    // If OFFSET 1 is dropped, this returns the CURRENT tx -> is_incremental
    // would be true on the first build (wrong). Pin the SQL.
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1" }] });
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await resolvePreviousTransaction("ri.foundry.main.dataset.out");
    const txSql = q.mock.calls[1][0] as string;
    expect(txSql).toMatch(/ORDER BY committed_at DESC/);
    expect(txSql).toMatch(/LIMIT 1 OFFSET 1/);
    expect(txSql).toMatch(/status = 'committed'/);
  });
});

// ===========================================================================
// resolveDatasetByRid — latest committed tx + storage_path fallback.
// ===========================================================================
describe("resolveDatasetByRid (latest committed + storage_path fallback)", () => {
  it("returns the latest committed transaction file + dataset id", async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1", file_format: "csv", storage_path: null }] });
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ file_path: "/abs/latest.csv" }] });
    const r = await resolveDatasetByRid("ri.foundry.main.dataset.in");
    expect(r).toEqual({ datasetId: "d1", filePath: "/abs/latest.csv", fileFormat: "csv", name: null });
  });

  it("falls back to dataset.storage_path when no committed transaction exists", async () => {
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1", file_format: "csv", storage_path: "/abs/legacy.csv" }] });
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // no committed tx
    const r = await resolveDatasetByRid("ri.foundry.main.dataset.in");
    expect(r).toEqual({ datasetId: "d1", filePath: "/abs/legacy.csv", fileFormat: "csv", name: null });
  });

  it("returns null when the dataset RID does not exist", async () => {
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r = await resolveDatasetByRid("ri.foundry.main.dataset.no");
    expect(r).toBeNull();
  });
});

// ===========================================================================
// REGRESSION: is_incremental (existence) vs previousPath (OFFSET 1).
// buildService computes ctx.is_incremental as `!!resolveDatasetByRid(outputRid)`
// (an EXISTENCE check: does the output have >=1 prior committed tx). It MUST
// NOT use resolvePreviousTransaction (OFFSET 1) for is_incremental — that
// returns null when exactly 1 prior tx exists (build 2), which left
// is_incremental=false on build 2 so the second build ran a full SNAPSHOT
// instead of APPEND. resolvePreviousTransaction (OFFSET 1) is only for
// Input.dataframe(mode='previous') — the input's prior VERSION. This test
// pins the distinction: with 1 prior committed tx, existence=true but
// OFFSET-1=null.
// ===========================================================================
describe("is_incremental (existence) vs previousPath (OFFSET 1) — regression", () => {
  it("with exactly 1 prior committed tx: resolveDatasetByRid is non-null (is_incremental=true) but resolvePreviousTransaction is null (previousPath unavailable)", async () => {
    const rid = "ri.foundry.main.dataset.out";
    // resolveDatasetByRid: dataset lookup + latest tx (1 row).
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1", file_format: "csv", storage_path: null }] });
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ file_path: "/abs/tx1.csv" }] });
    // resolvePreviousTransaction: dataset lookup + OFFSET-1 tx (0 rows).
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ dataset_id: "d1" }] });
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const exists = await resolveDatasetByRid(rid);
    const previous = await resolvePreviousTransaction(rid);
    expect(exists, "is_incremental = !!resolveDatasetByRid -> true on build 2").not.toBeNull();
    expect(previous, "previousPath = resolvePreviousTransaction (OFFSET 1) -> null on build 2").toBeNull();
  });
});

// ===========================================================================
// materializeOutput — failure path: a DB step failing mid-transaction must
// ROLLBACK (not land half-committed), release the client, and rethrow.
// ===========================================================================
describe("materializeOutput (mid-transaction failure rolls back, no half-commit)", () => {
  let tmpCsv: string;

  beforeEach(() => {
    tmpCsv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-")), "in.csv");
    fs.writeFileSync(tmpCsv, "id,v\n1,10\n");
    scanFn.mockResolvedValue({ columnNames: ["id", "v"], inferredTypes: ["int", "int"], rowCount: 1, schemaHash: "h" });
  });

  it("issues ROLLBACK (not COMMIT), releases the client, and rethrows when a post-BEGIN query fails", async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    getClientFn.mockResolvedValue(client);
    // Default: any client.query call resolves (incl. the ROLLBACK the catch
    // block issues — the real pg client always returns a Promise, so the mock
    // must too, else `client.query("ROLLBACK").catch(...)` blows up). Then
    // queue: call 1 = BEGIN ok, call 2 = the failing post-BEGIN step.
    client.query.mockResolvedValue({});
    client.query
      .mockResolvedValueOnce({}) // call 1: BEGIN
      .mockRejectedValueOnce(new Error("db boom")); // call 2: failing step

    await expect(
      materializeOutput({
        rid: "ri.foundry.main.dataset.out",
        name: "t",
        description: null,
        csvFilePath: tmpCsv,
        transactionType: "SNAPSHOT",
        actor: "tester",
      }),
    ).rejects.toThrow("db boom");

    // ROLLBACK was issued, COMMIT was not, and the client was released.
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("propagates a scanFile failure BEFORE BEGIN (malformed schema -> no transaction started, no half-commit)", async () => {
    // scanFile (schema inference) runs before getClient/BEGIN. If it fails
    // (malformed CSV / unreadable schema), materializeOutput must rethrow
    // WITHOUT starting a transaction — so there is nothing to roll back and
    // no half-committed dataset_transaction.
    scanFn.mockRejectedValue(new Error("malformed csv: bad header"));
    getClientFn.mockResolvedValue({ query: vi.fn(), release: vi.fn() });

    await expect(
      materializeOutput({
        rid: "ri.foundry.main.dataset.out",
        name: "t",
        description: null,
        csvFilePath: tmpCsv,
        transactionType: "SNAPSHOT",
        actor: "tester",
      }),
    ).rejects.toThrow("malformed csv: bad header");

    // No transaction was started.
    expect(getClientFn).not.toHaveBeenCalled();
  });
});
