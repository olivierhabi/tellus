// Quiver B2 C-14 — validator SLO (CPU-bound, no I/O).
//
// Targets: P50 ≤ 25 ms, P95 ≤ 80 ms, P99 ≤ 250 ms for documents ≤ 500 cards.
// Asserted at 250-card workload (mid-range) on this machine.

import { describe, expect, it } from "vitest";
import { validate } from "../../../src/services/quiver/dag";
import type { AnalysisDocument, Card } from "../../../src/services/quiver/types";

function bigDoc(n: number): Pick<AnalysisDocument, "cards" | "canvases"> {
  const cards: Record<string, Card> = {};
  cards["$A"] = { id: "$A", type: "OBJECT_SET", config: {}, inputs: {}, hidden: false } as Card;
  cards["$P"] = { id: "$P", type: "BOOLEAN_FORMULA", config: {}, inputs: {}, hidden: false } as Card;
  let prev = "$A";
  for (let i = 0; i < n; i++) {
    const id = "$F" + i;
    cards[id] = { id, type: "FILTER_OBJECT_SET", config: {}, inputs: { src: prev, predicate: "$P" }, hidden: false } as Card;
    prev = id;
  }
  return { cards, canvases: [] };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i];
}

describe("DagValidator — SLO (B2 C-14)", () => {
  it("250-card chain: p50 ≤ 25 ms, p95 ≤ 80 ms, p99 ≤ 250 ms", () => {
    const doc = bigDoc(250);
    // Warm-up to amortize V8 JIT.
    for (let i = 0; i < 5; i++) validate(doc);
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = process.hrtime.bigint();
      const r = validate(doc);
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6; // ms
      expect(r.valid).toBe(true);
      samples.push(elapsed);
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const p99 = percentile(samples, 0.99);
    // Generous CI multipliers; on a workstation these are typically <5ms.
    expect(p50).toBeLessThanOrEqual(25);
    expect(p95).toBeLessThanOrEqual(80);
    expect(p99).toBeLessThanOrEqual(250);
  });

  it("500-card chain (hard limit) still validates within bounds", () => {
    const doc = bigDoc(498); // root + boolean-formula + 498 filters = 500
    const t0 = process.hrtime.bigint();
    const r = validate(doc);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.valid).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(250);
  });
});
