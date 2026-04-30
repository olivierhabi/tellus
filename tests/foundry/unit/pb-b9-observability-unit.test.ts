// ---------------------------------------------------------------------------
// PB-B9 — observability primitives (unit).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  newTraceId,
  newSpanId,
  withTraceFields,
  currentTrace,
  annotateTrace,
} from "../../../src/services/traceContext";
import {
  recordDeployDuration,
  recordPreviewDuration,
  incActiveDeploys,
  addInputRowsProcessed,
  recordOrphanSwept,
  renderPrometheus,
} from "../../../src/services/pipelines/metrics";
import { __resetMetricsForTesting } from "../../../src/services/funnel/metrics";

describe("traceContext", () => {
  it("generates 128-bit hex trace ids", () => {
    expect(newTraceId()).toMatch(/^[a-f0-9]{32}$/);
  });
  it("generates 64-bit hex span ids", () => {
    expect(newSpanId()).toMatch(/^[a-f0-9]{16}$/);
  });
  it("propagates trace fields through async boundaries", async () => {
    await withTraceFields(
      { traceId: "t-outer", spanId: "s-outer", pipelineId: "p-1" },
      async () => {
        await new Promise((r) => setImmediate(r));
        const ctx = currentTrace();
        expect(ctx?.traceId).toBe("t-outer");
        expect(ctx?.pipelineId).toBe("p-1");
      },
    );
  });
  it("annotateTrace merges fields onto the active context", () => {
    withTraceFields({ traceId: "t", spanId: "s" }, () => {
      annotateTrace({ deploymentId: "d-1", projectId: "pr-1" });
      expect(currentTrace()?.deploymentId).toBe("d-1");
      expect(currentTrace()?.projectId).toBe("pr-1");
    });
  });
  it("annotateTrace is a no-op off-request", () => {
    annotateTrace({ deploymentId: "ignored" });
    expect(currentTrace()).toBeUndefined();
  });
});

describe("pipelines/metrics", () => {
  it("emits the PB-B9 histogram + counter shape", () => {
    __resetMetricsForTesting();
    recordDeployDuration("pipe-1", "succeeded", 2.5);
    recordDeployDuration("pipe-2", "failed", 0.9);
    const txt = renderPrometheus();
    // Counter name + labels present.
    expect(txt).toMatch(/# TYPE pipeline_deploy_total counter/);
    expect(txt).toMatch(/pipeline_deploy_total\{status="succeeded"\} 1/);
    expect(txt).toMatch(/pipeline_deploy_total\{status="failed"\} 1/);
    // Histogram with the spec's name.
    expect(txt).toMatch(/# TYPE pipeline_deploy_duration_seconds histogram/);
  });

  it("preview + active + rows + orphan swept counters surface on /metrics", () => {
    __resetMetricsForTesting();
    recordPreviewDuration("Cast", 0.18);
    incActiveDeploys(1);
    incActiveDeploys(1);
    incActiveDeploys(-1);
    addInputRowsProcessed(42);
    recordOrphanSwept(3);
    const txt = renderPrometheus();
    expect(txt).toMatch(/pipeline_preview_duration_seconds_bucket/);
    expect(txt).toMatch(/pipeline_active_deploys 1/);
    expect(txt).toMatch(/pipeline_input_rows_processed_total 42/);
    expect(txt).toMatch(/pipeline_orphan_runs_swept_total 3/);
  });
});
