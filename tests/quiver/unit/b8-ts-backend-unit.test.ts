/**
 * B8 — TimeSeriesBackend unit tests.
 *
 * Covers:
 *   B8 C-01 backend wired for 5 card types
 *   B8 C-03 per-axis hydration: independent calls per axis; one cold
 *           does not block another warm
 *   B8 C-04 xAxisGroupId is passed through to payload
 */

import { describe, it, expect } from "vitest";
import { InProcessCodexAdapter } from "../../../src/services/quiver/compute/ts/inProcessCodex";
import { TimeSeriesBackend, TS_CARD_TYPES, buildTsBackends } from "../../../src/services/quiver/compute/ts/tsBackend";
import type { BackendExecuteInput } from "../../../src/services/quiver/compute/types";

const baseInput = (overrides: Partial<BackendExecuteInput>): BackendExecuteInput => ({
  cardId: "$T",
  cardType: "TIME_SERIES_CHART",
  config: {},
  upstreamResults: new Map(),
  branch: "trunk",
  parameterOverrides: {},
  remainingMs: 5_000,
  analysisRid: "ri.tellus.main.analysis.t1",
  userSubject: "u",
  ...overrides,
});

describe("B8 — TimeSeriesBackend", () => {
  it("B8 C-01 — buildTsBackends returns 5 backends", () => {
    const adapter = new InProcessCodexAdapter();
    const all = buildTsBackends(adapter);
    expect(all.map((b) => b.cardType).sort()).toEqual([...TS_CARD_TYPES].sort());
    for (const b of all) expect(b.backendName).toBe("CODEX");
  });

  it("B8 C-03 — chart with N axes triggers N independent hydration jobs", async () => {
    const adapter = new InProcessCodexAdapter();
    adapter.registerSeries({ objectRid: "ri.a", propertyApiName: "p1", points: [{ ts: 1, value: 1 }] });
    adapter.registerSeries({ objectRid: "ri.b", propertyApiName: "p2", points: [{ ts: 1, value: 2 }] });
    const b = new TimeSeriesBackend("TIME_SERIES_CHART", adapter);
    const input = baseInput({
      cardType: "TIME_SERIES_CHART",
      config: {
        axes: [
          { id: "ax1", query: { objectRid: "ri.a", propertyApiName: "p1", timeRange: { fromMs: 0, toMs: 10 } }, xAxisGroupId: "g1" },
          { id: "ax2", query: { objectRid: "ri.b", propertyApiName: "p2", timeRange: { fromMs: 0, toMs: 10 } }, xAxisGroupId: "g1" },
        ],
      },
    });
    const r = await b.execute(input);
    expect(r.resultType).toBe("TIME_SERIES_CHART");
    const payload = r.payload as { axes: Array<{ axisId: string; state: "warm" | "cold" }>; xAxisGroupId: string };
    // First call → cold, both axes
    expect(payload.axes.map((a) => a.axisId).sort()).toEqual(["ax1", "ax2"]);
    expect(payload.axes.every((a) => a.state === "cold")).toBe(true);
    expect(payload.xAxisGroupId).toBe("g1"); // B8 C-04
    expect(r.status).toBe("PARTIAL");

    // Second call → both warm independently
    const r2 = await b.execute(input);
    const payload2 = r2.payload as { axes: Array<{ state: "warm" | "cold" }> };
    expect(payload2.axes.every((a) => a.state === "warm")).toBe(true);
    expect(r2.status).toBe("OK");
  });

  it("B8 C-03 — invalidating axis-1 dependency does not invalidate axis-2 (calls is per-axis)", async () => {
    const adapter = new InProcessCodexAdapter();
    adapter.registerSeries({ objectRid: "ri.a", propertyApiName: "p1", points: [{ ts: 1, value: 1 }] });
    adapter.registerSeries({ objectRid: "ri.b", propertyApiName: "p2", points: [{ ts: 1, value: 2 }] });
    const b = new TimeSeriesBackend("TIME_SERIES_CHART", adapter);
    const input = baseInput({
      cardType: "TIME_SERIES_CHART",
      config: {
        axes: [
          { id: "ax1", query: { objectRid: "ri.a", propertyApiName: "p1", timeRange: { fromMs: 0, toMs: 10 } } },
          { id: "ax2", query: { objectRid: "ri.b", propertyApiName: "p2", timeRange: { fromMs: 0, toMs: 10 } } },
        ],
      },
    });
    await b.execute(input); // first call hydrates both
    const callsBefore = adapter.calls.filter((c) => c.op === "getSeries").length;
    expect(callsBefore).toBe(2);

    // Re-run with only axis-2 changed time-range; axis-1 is still warm.
    const input2 = baseInput({
      cardType: "TIME_SERIES_CHART",
      config: {
        axes: [
          { id: "ax1", query: { objectRid: "ri.a", propertyApiName: "p1", timeRange: { fromMs: 0, toMs: 10 } } },
          { id: "ax2", query: { objectRid: "ri.b", propertyApiName: "p2", timeRange: { fromMs: 0, toMs: 50 } } },
        ],
      },
    });
    const r = await b.execute(input2);
    const payload = r.payload as { axes: Array<{ axisId: string; state: "warm" | "cold" }> };
    // ax1 still warm (same query); ax2 cold (new time range).
    expect(payload.axes.find((a) => a.axisId === "ax1")?.state).toBe("warm");
    expect(payload.axes.find((a) => a.axisId === "ax2")?.state).toBe("cold");
  });

  it("B8 C-01 — TIME_SERIES_PLOT, ROLLING_AGGREGATE, EVENT_SET, TIME_SERIES_FORMULA all dispatch", async () => {
    const adapter = new InProcessCodexAdapter();
    adapter.registerSeries({ objectRid: "ri.c", propertyApiName: "p", points: [{ ts: 1, value: 5 }, { ts: 2, value: 10 }] });
    const q = { objectRid: "ri.c", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 10 } };

    const plot = new TimeSeriesBackend("TIME_SERIES_PLOT", adapter);
    const r1 = await plot.execute(baseInput({ cardType: "TIME_SERIES_PLOT", config: { query: q } }));
    expect((r1.payload as any).state).toBe("cold"); // first call hydrates

    const rolling = new TimeSeriesBackend("ROLLING_AGGREGATE", adapter);
    const r2 = await rolling.execute(baseInput({ cardType: "ROLLING_AGGREGATE", config: { queries: [q], op: "avg", windowMs: 1 } }));
    expect((r2.payload as any).state).toBe("warm");

    const events = new TimeSeriesBackend("EVENT_SET", adapter);
    const r3 = await events.execute(baseInput({ cardType: "EVENT_SET", config: { query: q, threshold: 7, comparator: "gt" } }));
    expect((r3.payload as any).events.events.length).toBe(1);

    const formula = new TimeSeriesBackend("TIME_SERIES_FORMULA", adapter);
    const r4 = await formula.execute(baseInput({ cardType: "TIME_SERIES_FORMULA", config: { queries: [q] } }));
    expect((r4.payload as any).derivedFromFormula).toBe(true);
  });
});
