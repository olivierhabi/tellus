// ---------------------------------------------------------------------------
// PB-B9 acceptance (a) — a failing deploy generates a trace spanning
// HTTP → workflow → activity → DuckDB/Iceberg.
//
// End-to-end trace visibility in a UI needs a live OTLP collector, so
// this guard asserts the *wiring invariants* that make the end-to-end
// chain structurally present. If any link in the chain goes missing,
// this test fails — regardless of collector availability.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (rel: string): string =>
  readFileSync(resolve(__dirname, "../../../", rel), "utf-8");

describe("PB-B9 acceptance (a) — HTTP→workflow→activity trace wiring", () => {
  it("inbound HTTP handler writes X-Trace-Id response header and seeds ALS", () => {
    const mw = read("src/middleware/traceContext.ts");
    expect(mw).toMatch(/X-Trace-Id/i);
    expect(mw).toMatch(/withTraceFields/);
  });

  it("deploymentService reads currentTrace() and passes traceId/spanId to workflow start", () => {
    const deploy = read("src/services/deploymentService.ts");
    expect(deploy).toMatch(/currentTrace\s*\(\s*\)/);
    expect(deploy).toMatch(/traceId[^,]*spanId/s);
    expect(deploy).toMatch(/workflow\.start\s*\(\s*["']pipelineDeployWorkflow/);
  });

  it("workflow type forwards traceId/spanId to the activity input", () => {
    const wf = read("src/services/pipelines/temporal/workflows.ts");
    expect(wf).toMatch(/traceId\??:/);
    expect(wf).toMatch(/spanId\??:/);
  });

  it("activity wraps deploy execution in withTraceFields so DuckDB/Iceberg child ops inherit the trace", () => {
    const act = read("src/services/pipelines/temporal/activities.ts");
    expect(act).toMatch(/withTraceFields\s*\(\s*\{/);
    expect(act).toMatch(/traceId:\s*input\.traceId/);
  });

  it("structured logger emits trace_id/span_id/deployment_id fields per spec literal", () => {
    const log = read("src/services/structuredLogger.ts");
    expect(log).toMatch(/trace_id/);
    expect(log).toMatch(/span_id/);
    expect(log).toMatch(/deployment_id/);
  });

  it("OTel bootstrap runs before @temporalio/kafkajs imports (import order literal)", () => {
    const server = read("src/server.ts");
    // Match import STATEMENTS only, not mentions inside comments. The
    // otel side-effect import must land before any instrumented
    // library's own import line runs.
    const otel = server.search(/^\s*import\s+["']\.\/services\/otelBootstrap["']/m);
    const temporal = server.search(/^\s*import[^\n]*@temporalio\//m);
    const kafka = server.search(/^\s*import[^\n]*kafkaProducer/m);
    expect(otel).toBeGreaterThan(-1);
    if (temporal > -1) expect(otel).toBeLessThan(temporal);
    if (kafka > -1) expect(otel).toBeLessThan(kafka);
  });
});
