// ---------------------------------------------------------------------------
// Preview truncation transparency.
//
// Every preview reads at most PREVIEW_SOURCE_ROW_LIMIT source rows, so the
// counts it returns describe a sample rather than the dataset. Before this,
// nothing in the response said so: `totalRows: 5000` on a million-row dataset
// read as "this dataset has 5000 rows", which is wrong in a way that silently
// misleads whoever is authoring the transform.
//
// These tests pin the boundary itself — exactly at the cap the response must
// say `truncated: true`, one row below it `false` — because an off-by-one here
// is the difference between "always truncated" and "never truncated", and
// either one is invisible in a green suite that only checks the field exists.
//
// resolveNodeDataset and readCsvRows are stubbed so no DB or object store is
// needed; the assertion is about what the service reports, not where rows come
// from.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Knex } from "knex";
import {
  TransformService,
  PREVIEW_SOURCE_ROW_LIMIT,
  EXECUTE_SOURCE_ROW_LIMIT,
} from "../../../src/services/transformService";

type Row = Record<string, unknown>;

const COLUMNS = [
  { name: "id", type: "string" },
  { name: "qty", type: "string" },
];

/**
 * A TransformService whose two I/O seams are replaced: the node lookup returns
 * a fixed two-column dataset, and the CSV reader returns `rowsAvailable` rows
 * clipped to whatever limit the caller passed — which is exactly what the real
 * bounded reader does, and the only behaviour these tests depend on.
 */
function svcWith(rowsAvailable: number) {
  const svc = new TransformService(undefined as unknown as Knex);
  const priv = svc as unknown as {
    resolveNodeDataset: () => Promise<unknown>;
    readCsvRows: (path: string, limit: number) => Promise<Row[]>;
  };
  priv.resolveNodeDataset = async () => ({
    dataset: { id: "d1", file_path: "k.csv", status: "ready" },
    sourceColumns: COLUMNS,
    existingTransforms: [],
  });
  priv.readCsvRows = async (_path: string, limit: number) => {
    const n = Math.min(rowsAvailable, limit);
    return Array.from({ length: n }, (_v, i) => ({
      id: String(i),
      qty: String(i % 7),
    }));
  };
  return svc;
}

const args = ["p", "pl", "n"] as const;

describe("preview truncation reporting", () => {
  it("reports a short read as complete", async () => {
    const out = await svcWith(120).selectPreview(...args, {
      columns: ["id"],
      limit: 50,
    } as never);
    expect(out.truncated).toBe(false);
    expect(out.sampledSourceRows).toBe(120);
    expect(out.sourceRowLimit).toBe(PREVIEW_SOURCE_ROW_LIMIT);
    // The row slice is still bounded by the caller's own limit — truncation of
    // the *source* read and of the *returned page* are separate things.
    expect(out.rows).toHaveLength(50);
  });

  it("reports a read that hit the cap as truncated", async () => {
    const out = await svcWith(PREVIEW_SOURCE_ROW_LIMIT * 3).selectPreview(...args, {
      columns: ["id"],
      limit: 50,
    } as never);
    expect(out.truncated).toBe(true);
    expect(out.sampledSourceRows).toBe(PREVIEW_SOURCE_ROW_LIMIT);
  });

  it("does not flag a dataset that is exactly one row short of the cap", async () => {
    // The boundary case that a `>=` vs `>` slip would invert.
    const out = await svcWith(PREVIEW_SOURCE_ROW_LIMIT - 1).selectPreview(...args, {
      columns: ["id"],
      limit: 10,
    } as never);
    expect(out.truncated).toBe(false);
    expect(out.sampledSourceRows).toBe(PREVIEW_SOURCE_ROW_LIMIT - 1);
  });

  it("flags a dataset of exactly the cap, where the reader cannot tell there is no more", async () => {
    // A dataset of exactly 5000 rows is indistinguishable from a larger one to
    // a reader that stops at 5000, so it must report truncated rather than
    // claim completeness it cannot establish.
    const out = await svcWith(PREVIEW_SOURCE_ROW_LIMIT).selectPreview(...args, {
      columns: ["id"],
      limit: 10,
    } as never);
    expect(out.truncated).toBe(true);
  });

  it("qualifies filter's totalMatched, which is a sample count too", async () => {
    // filterPreview returns totalMatched/totalRows over the rows it read. Those
    // are the numbers most likely to be mistaken for dataset-wide counts, so
    // they must travel with the caveat.
    const out = await svcWith(PREVIEW_SOURCE_ROW_LIMIT * 2).filterPreview(...args, {
      mode: "keep",
      match: "all",
      conditions: [{ column: "qty", operator: "is_not_null" }],
      limit: 25,
    } as never);
    expect(out.truncated).toBe(true);
    expect(out.totalRows).toBe(PREVIEW_SOURCE_ROW_LIMIT);
    expect(out.totalMatched).toBeLessThanOrEqual(PREVIEW_SOURCE_ROW_LIMIT);
  });

  it("uses the higher execute cap on the no-transform executeChain path", async () => {
    // /transforms/execute is the "Apply All" path and reads further than a
    // preview, so it must report against its own limit — reusing the preview
    // constant here would under-report the sample size by 2x.
    const out = await svcWith(EXECUTE_SOURCE_ROW_LIMIT * 2).executeChain(...args);
    expect(out.sourceRowLimit).toBe(EXECUTE_SOURCE_ROW_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(EXECUTE_SOURCE_ROW_LIMIT);
  });

  it("keeps the two caps distinct", () => {
    // Guards against a later cleanup collapsing them into one constant, which
    // would silently change how much data "Apply All" materialises.
    expect(EXECUTE_SOURCE_ROW_LIMIT).toBeGreaterThan(PREVIEW_SOURCE_ROW_LIMIT);
  });
});
