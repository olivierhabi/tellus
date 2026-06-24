/**
 * B7 — Tier selector unit tests.
 *
 * Covers:
 *   B7 C-02 selector picks polars when cells × cols ≤ 10 M and est mem ≤ 2 GiB
 *   B7 C-03 default never picks Spark when input fits Polars threshold
 *   B7 C-02 explicit force= overrides
 *   B7 C-02 configurable threshold
 */

import { describe, it, expect } from "vitest";
import { selectTier } from "../../../src/services/quiver/compute/mat/matBackend";

describe("B7 — selectTier", () => {
  it("B7 C-02 — small input → polars", () => {
    expect(selectTier({ rows: 1_000, cols: 5, estMemoryBytes: 40_000 }).tier).toBe("polars");
  });

  it("B7 C-02 — exceeds 10 M cells → spark/exceeds-cells", () => {
    const sel = selectTier({ rows: 2_000_000, cols: 6, estMemoryBytes: 1_000_000 });
    expect(sel).toEqual({ tier: "spark", reason: "exceeds-cells" });
  });

  it("B7 C-02 — exceeds 2 GiB estimated memory → spark/exceeds-memory", () => {
    const sel = selectTier({ rows: 100, cols: 5, estMemoryBytes: 3 * 1024 * 1024 * 1024 });
    expect(sel).toEqual({ tier: "spark", reason: "exceeds-memory" });
  });

  it("B7 C-03 — default never spark when input fits polars threshold", () => {
    // exactly 1 M rows × 5 cols × 8 B = 40 MiB; well under both thresholds
    const sel = selectTier({ rows: 1_000_000, cols: 5, estMemoryBytes: 40_000_000 });
    expect(sel.tier).toBe("polars");
    expect(sel.reason).toBe("fits-polars");
  });

  it("B7 C-02 — force=spark overrides", () => {
    expect(selectTier({ rows: 1, cols: 1, estMemoryBytes: 1 }, { force: "spark" })).toEqual({
      tier: "spark",
      reason: "forced-spark",
    });
  });

  it("B7 C-02 — force=polars overrides even on huge input", () => {
    expect(selectTier({ rows: 1e9, cols: 100, estMemoryBytes: 1e12 }, { force: "polars" })).toEqual({
      tier: "polars",
      reason: "forced-polars",
    });
  });

  it("B7 C-02 — configurable cellThreshold via tellus.quiver.mat.polars_cell_threshold", () => {
    const sel = selectTier({ rows: 100_000, cols: 10, estMemoryBytes: 1_000_000 }, { cellThreshold: 100_000 });
    expect(sel).toEqual({ tier: "spark", reason: "exceeds-cells" });
  });
});
