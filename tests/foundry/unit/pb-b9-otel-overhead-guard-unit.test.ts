// ---------------------------------------------------------------------------
// PB-B9 "Risk" literal — measure OTel auto-instrumentation overhead.
//
// The spec explicitly calls out: "OTel auto-instrumentation in Node has
// overhead — measure baseline preview latency before/after and ensure
// overhead is <5%. If higher, switch to manual instrumentation for hot
// paths." This guard exercises the trace-context ALS path (the OTel
// surrogate in src/services/traceContext.ts) over 10k invocations and
// asserts the per-call cost stays under 50µs p95. If this regresses
// to ms-scale, the 5% overhead budget will blow on any moderate-fanout
// route.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { withTraceFields, currentTrace, annotateTrace } from "../../../src/services/traceContext";

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

describe("PB-B9 — trace context overhead guard (<5% spec risk)", () => {
  it("withTraceFields + annotate + currentTrace stays under 50µs p95", () => {
    const timings: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = performance.now();
      withTraceFields(
        { deploymentId: `d-${i}`, pipelineId: `p-${i}` },
        () => {
          annotateTrace({ extra: { iter: i } });
          const t = currentTrace();
          // Touch a field so V8 doesn't dead-code-eliminate.
          if (!t?.traceId) throw new Error("missing trace");
        },
      );
      timings.push((performance.now() - t0) * 1000); // µs
    }
    const p95 = percentile(timings, 0.95);
    // 50µs at p95 keeps a typical 20ms handler's trace overhead at
    // ≤0.25%, well under the 5% envelope.
    expect(p95).toBeLessThan(50);
  });

  it("OTel bootstrap is a no-op when OTEL_SDK_DISABLED=true (test default)", async () => {
    const prev = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_SDK_DISABLED = "true";
    const mod = await import("../../../src/services/otelBootstrap");
    expect(mod.otelSdk).toBeFalsy();
    process.env.OTEL_SDK_DISABLED = prev;
  });
});
