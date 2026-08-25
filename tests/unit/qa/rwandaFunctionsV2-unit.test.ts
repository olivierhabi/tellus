import { describe, expect, it } from "vitest";
import { runSandboxed } from "../../../src/services/functionRuntime";
import { inlineSource, rwandaFunctionsV2 } from "../../../src/qa/rwanda/functionsV2";
import { expectedFunctionRows } from "../../../tools/synthetic-data/generate";

describe("Rwanda Functions v2 deterministic contracts", () => {
  it("covers every pinned function without wall-clock reads", async () => {
    const pins = (await import("../../../config/rwanda-functions.pins.json")).default;
    expect(Object.keys(rwandaFunctionsV2).sort()).toEqual(Object.keys(pins.functions).sort());
    for (const fn of Object.values(rwandaFunctionsV2)) {
      expect(fn.toString()).not.toMatch(/Date\.now|new Date\(\s*\)/);
    }
  });

  it("returns exact representative outputs across all four scenarios", () => {
    expect(rwandaFunctionsV2.calculateCreditRiskV2({ score: 92 })).toEqual({ score: 92, band: "HIGH", explanation: "High synthetic risk" });
    expect(rwandaFunctionsV2.validateRraTaxClearanceV2({ clearanceId: "T-1", status: "VALID", expiresAt: "2026-09-01T00:00:00Z", now: "2026-08-10T08:00:00Z" })).toEqual({ valid: true, failures: [] });
    expect(rwandaFunctionsV2.classifyIso8583FailureV2({ responseCode: "91" })).toEqual({ responseCode: "91", failureClass: "ISSUER_UNAVAILABLE" });
    expect(rwandaFunctionsV2.calculateCarrierHealthV2({ p95Latency: 1200, errorRate: 0.01, sampleAt: "2026-08-10T07:59:00Z", now: "2026-08-10T08:00:00Z", threshold: 1000 })).toEqual({ health: "DEGRADED", reasons: ["latency or error-rate threshold breached"], plausible: true });
  });

  it("publishes self-contained JavaScript that executes in the production sandbox", () => {
    const result = runSandboxed(inlineSource("calculateCreditRiskV2"), { score: 92 });
    expect(result).toMatchObject({ status: "ok", output: { score: 92, band: "HIGH", explanation: "High synthetic risk" } });
  });

  it("matches 100% of expected_outputs.csv contract rows in all four scenarios", () => {
    const rows = expectedFunctionRows();
    expect(rows).toHaveLength(12);
    for (const [name, inputJson, outputJson] of rows as [keyof typeof rwandaFunctionsV2, string, string][]) {
      expect(rwandaFunctionsV2[name](JSON.parse(inputJson) as never)).toEqual(JSON.parse(outputJson));
    }
  });
});
