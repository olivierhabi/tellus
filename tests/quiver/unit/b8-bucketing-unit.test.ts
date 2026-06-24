/**
 * B8 — Bucketing unit tests.
 *
 * Covers:
 *   B8 C-02 — ≤ 1000 buckets enforced; ops avg/min/max/sum/last/first
 *             produce expected reductions.
 */

import { describe, it, expect } from "vitest";
import { bucketSeries, MAX_BUCKETS } from "../../../src/services/quiver/compute/ts/bucketing";

const linear = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 1000, value: i }));

describe("B8 — bucketSeries", () => {
  it("B8 C-02 — empty input returns empty", () => {
    expect(bucketSeries([], 100)).toEqual([]);
  });

  it("B8 C-02 — input ≤ buckets returns input unchanged", () => {
    const small = linear.slice(0, 50);
    expect(bucketSeries(small, 100).length).toBe(50);
  });

  it("B8 C-02 — > 1000 buckets defensively capped to 1000", () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => ({ ts: i, value: i }));
    expect(bucketSeries(huge, 5000).length).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it.each([
    ["avg", 49.5],
    ["sum", 4950],
    ["min", 0],
    ["max", 99],
    ["first", 0],
    ["last", 99],
  ] as const)("B8 C-02 — op %s produces expected reduction over 100 points", (op, want) => {
    const points = Array.from({ length: 100 }, (_, i) => ({ ts: i, value: i }));
    const got = bucketSeries(points, 1, op);
    expect(got).toHaveLength(1);
    expect(got[0].value).toBe(want);
  });
});
