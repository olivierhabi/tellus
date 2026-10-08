// ---------------------------------------------------------------------------
// Foundry marker LOADER — fail-closed regression test (verification §4.1).
//
// parseFoundryMarker itself was already unit-tested, but the loader that
// calls it wrapped the call in a catch-all `catch { return null; }`. A
// malformed marker was therefore swallowed into `null`, the changelog fell
// through to the pending-edit fallback with sourceNonEmpty=false, the
// zero-row gate stayed disarmed, and the run completed with ZERO rows
// silently. These tests pin the loader contract, with `query` mocked:
//   * malformed / missing marker on a foundry-bridged row => THROWS;
//   * well-formed marker => resolves the datasource;
//   * legacy (non-bridged) path => null (pending-edit fallback owns it);
//   * catalog lookup failure => null (unchanged best-effort behaviour).
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

let respond: () => { rows: Record<string, unknown>[] } = () => ({ rows: [] });

vi.mock("../../../src/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: async () => {
      const { rows } = respond();
      return { rowCount: rows.length, rows };
    },
  };
});

import { loadFoundryBridgedDatasource } from "../../../src/services/funnel/temporal/activities";

const DS = "7ff4f9f6-de66-4dec-b117-19176feb66db";
const OT = "7e7c2da4-a837-498c-974a-d8d167b568ac";
const GOOD = `gate4/accounts_synth.csv#foundry-dataset:${DS}#object-type:${OT}`;

function row(filePath: string, foundryDatasetId: string | null = null) {
  return {
    file_path: filePath,
    file_format: null,
    primary_key_column: "account_id",
    foundry_dataset_id: foundryDatasetId,
  };
}

beforeEach(() => {
  respond = () => ({ rows: [] });
});

describe("loadFoundryBridgedDatasource — fail-closed marker", () => {
  it("throws on a garbage foundry-dataset marker (never resolves null)", async () => {
    respond = () => ({ rows: [row("gate4/accounts_synth.csv#foundry-dataset:garbage")] });
    await expect(loadFoundryBridgedDatasource("Account")).rejects.toThrow(
      /malformed marker/,
    );
  });

  it("throws when a bridged-by-id row has no marker at all", async () => {
    respond = () => ({ rows: [row("gate4/accounts_synth.csv", DS)] });
    await expect(loadFoundryBridgedDatasource("Account")).rejects.toThrow(
      /malformed marker/,
    );
  });

  it("throws when the object-type tag is missing", async () => {
    respond = () => ({
      rows: [row(`gate4/accounts_synth.csv#foundry-dataset:${DS}`)],
    });
    await expect(loadFoundryBridgedDatasource("Account")).rejects.toThrow(
      /malformed marker/,
    );
  });

  it("resolves a well-formed locator", async () => {
    respond = () => ({ rows: [row(GOOD, DS)] });
    await expect(loadFoundryBridgedDatasource("Account")).resolves.toEqual({
      filePath: GOOD,
      fileFormat: "csv",
      primaryKeyColumn: "account_id",
    });
  });

  it("returns null for a legacy non-bridged path", async () => {
    respond = () => ({ rows: [row("/data/legacy/accounts.csv")] });
    await expect(loadFoundryBridgedDatasource("Account")).resolves.toBeNull();
  });

  it("returns null when there is no backing row", async () => {
    await expect(loadFoundryBridgedDatasource("Account")).resolves.toBeNull();
  });

  it("returns null when the catalog lookup itself fails", async () => {
    respond = () => {
      throw new Error("connection refused");
    };
    await expect(loadFoundryBridgedDatasource("Account")).resolves.toBeNull();
  });
});
