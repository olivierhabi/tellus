// ---------------------------------------------------------------------------
// Full vs incremental indexing (Palantir funnel batch-pipeline rule).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  decideIndexingMode,
  parseIndexingPlan,
  planIndexing,
} from "../../../src/services/funnel/indexingPlan";

const delta = (rows: number) => ({ rows, prevSnapshotId: "prev" });

describe("planIndexing (merge side)", () => {
  it("is incremental at exactly 80% changed and full just above", () => {
    expect(
      planIndexing({ totalRows: 100, delta: delta(80), deltaRefAvailable: true, fullReindexFraction: 0.8 }),
    ).toMatchObject({ mode: "incremental", reason: "delta_within_threshold", changedFraction: 0.8 });
    expect(
      planIndexing({ totalRows: 100, delta: delta(81), deltaRefAvailable: true, fullReindexFraction: 0.8 }),
    ).toMatchObject({ mode: "full", reason: "changed_fraction_above_threshold", changedRows: 81 });
  });
  it("is full without a previous snapshot, without a readable delta, or when empty", () => {
    expect(planIndexing({ totalRows: 10, delta: null, deltaRefAvailable: false, fullReindexFraction: 0.8 }).reason).toBe(
      "no_previous_snapshot",
    );
    expect(planIndexing({ totalRows: 10, delta: delta(1), deltaRefAvailable: false, fullReindexFraction: 0.8 }).reason).toBe(
      "delta_unavailable",
    );
    expect(
      planIndexing({ totalRows: 10, delta: delta(1), deltaRefAvailable: true, deltaUploadFailed: true, fullReindexFraction: 0.8 })
        .reason,
    ).toBe("delta_unavailable");
    expect(planIndexing({ totalRows: 0, delta: null, deltaRefAvailable: false, fullReindexFraction: 0.8 }).reason).toBe(
      "empty_snapshot",
    );
  });
  it("a zero-row delta is incremental (nothing to publish)", () => {
    expect(
      planIndexing({ totalRows: 10, delta: delta(0), deltaRefAvailable: true, fullReindexFraction: 0.8 }),
    ).toMatchObject({ mode: "incremental", changedRows: 0, baseSnapshotId: "prev" });
  });
  it("round-trips through summary_json", () => {
    const p = planIndexing({ totalRows: 10, delta: delta(2), deltaRefAvailable: true, fullReindexFraction: 0.8 });
    expect(parseIndexingPlan(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(parseIndexingPlan(null)).toBeNull();
    expect(parseIndexingPlan({ mode: "bogus" })).toBeNull();
  });
});

describe("decideIndexingMode (indexing side)", () => {
  const plan = planIndexing({ totalRows: 10, delta: delta(2), deltaRefAvailable: true, fullReindexFraction: 0.8 });
  const base = { mergedSnapshotId: "new", plan, lastIndexedSnapshotId: "prev", incrementalEnabled: true };

  it("goes incremental only when the index holds the delta's base snapshot", () => {
    expect(decideIndexingMode(base)).toEqual({ mode: "incremental", reason: "delta_within_threshold", alreadyIndexed: false });
    expect(decideIndexingMode({ ...base, lastIndexedSnapshotId: "older" }).reason).toBe("index_behind_base_snapshot");
    expect(decideIndexingMode({ ...base, lastIndexedSnapshotId: null }).mode).toBe("full");
  });
  it("user-requested full and the kill switch win", () => {
    expect(decideIndexingMode({ ...base, forceFull: true })).toMatchObject({ mode: "full", reason: "user_requested_full" });
    expect(decideIndexingMode({ ...base, incrementalEnabled: false })).toMatchObject({ mode: "full", reason: "incremental_disabled" });
  });
  it("legacy snapshots without a plan go full; a full plan stays full", () => {
    expect(decideIndexingMode({ ...base, plan: null }).reason).toBe("no_plan");
    const full = planIndexing({ totalRows: 10, delta: delta(9), deltaRefAvailable: true, fullReindexFraction: 0.8 });
    expect(decideIndexingMode({ ...base, plan: full }).reason).toBe("changed_fraction_above_threshold");
  });
  it("a snapshot that is already indexed is recognised", () => {
    expect(decideIndexingMode({ ...base, lastIndexedSnapshotId: "new" }).alreadyIndexed).toBe(true);
  });
});

describe("temporal indexing gate: source-only changes reach the index", () => {
  async function run(watermark: string | null) {
    const { vi } = await import("vitest");
    process.env.TELLUS_ENVIRONMENT_ID = "plan-test";
    const dbMod = await import("../../../src/db");
    const plan = planIndexing({ totalRows: 10, delta: delta(2), deltaRefAvailable: true, fullReindexFraction: 0.8 });
    const spy = vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/FROM ontology_edit/i.test(sql)) return { rows: [], rowCount: 0 } as never;
      if (/indexing_plan/i.test(sql)) return { rows: [{ plan }], rowCount: 1 } as never;
      if (/FROM funnel_index_watermark/i.test(sql)) {
        return { rows: watermark ? [{ id: watermark }] : [], rowCount: watermark ? 1 : 0 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    const fetchMock = vi.fn(async () => Promise.reject(new Error("down")));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { runIndexingActivityProxy } = await import("../../../src/services/funnel/temporal/activities");
      const out = await runIndexingActivityProxy({
        ontologyId: "o",
        objectTypeApiName: "Orders",
        environmentId: "plan-test",
        mergedSnapshotId: "new",
        mergedRowCount: 10,
      } as never);
      return { out, fetched: fetchMock.mock.calls.length > 0 };
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  }

  it("no pending edits but an un-indexed snapshot ⇒ tries the serving index", async () => {
    const { out, fetched } = await run("prev");
    expect(fetched).toBe(true); // got past the gate to the reachability probe
    expect(out.quickwit).toBe(false); // unreachable in this test
  });

  it("no pending edits and the snapshot is already indexed ⇒ no-op", async () => {
    const { out, fetched } = await run("new");
    expect(fetched).toBe(false);
    expect(out).toEqual({ editsIndexed: 0, publishedSplitIds: [], quickwit: false });
  });
});
