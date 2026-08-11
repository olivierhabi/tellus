import { describe, expect, it } from "vitest";
import { evaluatePindoFailover, type FailoverPolicy } from "../../../src/qa/rwanda/pindoAutomation";

const policy: FailoverPolicy = {
  breachThresholdMs: 1000, breachHoldDownMs: 60_000, recoveryHoldDownMs: 120_000,
  maxFailoversPerWindow: 1, rateWindowMs: 3_600_000, killSwitch: false, maxTelemetryGapMs: 60_000,
};
const sample = (measuredAt: string, latencyMs: number) => [{ measuredAt, latencyMs, errorRate: 0.01 }];

describe("Rwanda Pindo sustained-breach automation policy", () => {
  it("fails over exactly once after hold-down and enforces the rate window", () => {
    const first = evaluatePindoFailover(sample("2026-08-10T07:59:00Z", 2000), policy, { activeRoute: "primary", breachSince: "2026-08-10T07:58:00Z", failovers: [] }, "2026-08-10T08:00:00Z");
    expect(first.outcome).toBe("FAILOVER");
    const limited = evaluatePindoFailover(sample("2026-08-10T08:01:00Z", 2000), policy, { ...first.state, activeRoute: "primary", breachSince: "2026-08-10T08:00:00Z" }, "2026-08-10T08:02:00Z");
    expect(limited).toMatchObject({ outcome: "SUPPRESSED", reason: "failover rate limit reached" });
  });
  it("records kill-switch suppression under the automation identity", () => {
    expect(evaluatePindoFailover(sample("2026-08-10T08:00:00Z", 2000), { ...policy, killSwitch: true }, { activeRoute: "primary", failovers: [] }, "2026-08-10T08:00:00Z"))
      .toMatchObject({ outcome: "SUPPRESSED", reason: "global kill switch engaged", serviceIdentity: "rwanda-pindo-automation" });
  });
  it("rejects corrupt telemetry", () => {
    expect(evaluatePindoFailover(sample("2026-08-10T08:01:00Z", -1), policy, { activeRoute: "primary", failovers: [] }, "2026-08-10T08:00:00Z").outcome).toBe("SUPPRESSED");
  });
  it("prevents oscillation until recovery hold-down completes", () => {
    const held = evaluatePindoFailover(sample("2026-08-10T07:59:30Z", 100), policy, { activeRoute: "fallback", recoverySince: "2026-08-10T07:59:00Z", failovers: [] }, "2026-08-10T08:00:00Z");
    expect(held.outcome).toBe("NOOP");
    const restored = evaluatePindoFailover(sample("2026-08-10T08:01:00Z", 100), policy, held.state, "2026-08-10T08:02:00Z");
    expect(restored.outcome).toBe("RESTORE");
  });
});
