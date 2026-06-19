/**
 * B8 — InProcessCodexAdapter unit tests.
 *
 * Covers:
 *   B8 C-02 bucket count cap
 *   B8 C-05 cold-then-warm hydration sequence
 *   B8 C-06 branch propagation on every call
 *   B8 C-09 hydration token TTL = 60 s; expired → HydrationTokenExpiredError
 */

import { describe, it, expect } from "vitest";
import { InProcessCodexAdapter, HYDRATION_TOKEN_TTL_MS } from "../../../src/services/quiver/compute/ts/inProcessCodex";
import { HydrationTokenExpiredError, HydrationTokenUnknownError, type CodexCallContext, type SeriesQuery } from "../../../src/services/quiver/compute/ts/codexPort";

const ctx: CodexCallContext = { branch: "trunk", remainingMs: 5_000 };

function buildPoints(n: number): { ts: number; value: number }[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * 1000, value: i }));
}

describe("B8 — InProcessCodexAdapter", () => {
  it("B8 C-05 — first getSeries returns cold, second returns warm", async () => {
    const a = new InProcessCodexAdapter();
    a.registerSeries({ objectRid: "ri.x.1", propertyApiName: "p", points: buildPoints(100) });
    const q: SeriesQuery = { objectRid: "ri.x.1", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 100_000 } };
    const r1 = await a.getSeries(q, ctx);
    expect(r1.kind).toBe("cold");
    const r2 = await a.getSeries(q, ctx);
    expect(r2.kind).toBe("warm");
    if (r2.kind === "warm") {
      expect(r2.data.points.length).toBeGreaterThan(0);
      expect(r2.data.points.length).toBeLessThanOrEqual(1000);
    }
  });

  it("B8 C-05 — pollHydration after cold resolves to ready with bucketed data", async () => {
    const a = new InProcessCodexAdapter();
    a.registerSeries({ objectRid: "ri.x.2", propertyApiName: "p", points: buildPoints(50) });
    const q: SeriesQuery = { objectRid: "ri.x.2", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 50_000 } };
    const r1 = await a.getSeries(q, ctx);
    if (r1.kind !== "cold") throw new Error("expected cold first");
    const polled = await a.pollHydration(r1.hydrationToken, ctx);
    expect(polled.kind).toBe("ready");
    if (polled.kind === "ready") expect(polled.data.points.length).toBeGreaterThan(0);
  });

  it("B8 C-09 — hydration token expires after TTL_MS", async () => {
    let now = 0;
    const a = new InProcessCodexAdapter(() => now);
    a.registerSeries({ objectRid: "ri.x.3", propertyApiName: "p", points: buildPoints(10) });
    const q: SeriesQuery = { objectRid: "ri.x.3", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 10_000 } };
    const r1 = await a.getSeries(q, ctx);
    if (r1.kind !== "cold") throw new Error("expected cold");
    now = HYDRATION_TOKEN_TTL_MS + 1;
    await expect(a.pollHydration(r1.hydrationToken, ctx)).rejects.toBeInstanceOf(HydrationTokenExpiredError);
  });

  it("B8 — unknown token → HydrationTokenUnknownError", async () => {
    const a = new InProcessCodexAdapter();
    await expect(a.pollHydration("hyd-none", ctx)).rejects.toBeInstanceOf(HydrationTokenUnknownError);
  });

  it("B8 C-06 + G-09 — every call records branch", async () => {
    const a = new InProcessCodexAdapter();
    a.registerSeries({ objectRid: "ri.x.4", propertyApiName: "p", points: buildPoints(10) });
    const q: SeriesQuery = { objectRid: "ri.x.4", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 10_000 } };
    const c2: CodexCallContext = { branch: "feature-y", remainingMs: 1000 };
    const cold = await a.getSeries(q, c2);
    if (cold.kind !== "cold") throw new Error();
    await a.pollHydration(cold.hydrationToken, c2);
    await a.aggregateSeries([q], "avg", 1000, c2);
    await a.detectEvents(q, 5, "gt", c2);
    expect(a.calls.every((c) => c.branch === "feature-y")).toBe(true);
    expect(a.calls.map((c) => c.op)).toEqual(["getSeries", "pollHydration", "aggregateSeries", "detectEvents"]);
  });

  it("B8 C-02 — aggregateSeries caps bucket count at 1000", async () => {
    const a = new InProcessCodexAdapter();
    a.registerSeries({ objectRid: "ri.x.5", propertyApiName: "p", points: buildPoints(10_000) });
    const q: SeriesQuery = { objectRid: "ri.x.5", propertyApiName: "p", timeRange: { fromMs: 0, toMs: 10_000_000 } };
    const r = await a.aggregateSeries([q], "avg", 1, ctx);
    expect(r.points.length).toBeLessThanOrEqual(1000);
  });
});
