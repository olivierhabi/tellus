export interface CarrierSample {
  measuredAt: string;
  latencyMs: number;
  errorRate: number;
}

export interface FailoverPolicy {
  breachThresholdMs: number;
  breachHoldDownMs: number;
  recoveryHoldDownMs: number;
  maxFailoversPerWindow: number;
  rateWindowMs: number;
  killSwitch: boolean;
  maxTelemetryGapMs: number;
}

export interface AutomationState {
  activeRoute: "primary" | "fallback";
  breachSince?: string;
  recoverySince?: string;
  failovers: string[];
}

export type AutomationDecision = {
  outcome: "FAILOVER" | "RESTORE" | "NOOP" | "SUPPRESSED";
  reason: string;
  serviceIdentity: "rwanda-pindo-automation";
  state: AutomationState;
};

const at = (value: string) => Date.parse(value);

/** Pure, injected-time policy effect used by the seeded Pindo automation. */
export function evaluatePindoFailover(
  samples: CarrierSample[],
  policy: FailoverPolicy,
  previous: AutomationState,
  now: string,
): AutomationDecision {
  const nowMs = at(now);
  const state: AutomationState = { ...previous, failovers: previous.failovers.filter((value) => nowMs - at(value) <= policy.rateWindowMs) };
  const result = (outcome: AutomationDecision["outcome"], reason: string): AutomationDecision => ({
    outcome, reason, state, serviceIdentity: "rwanda-pindo-automation",
  });
  if (policy.killSwitch) return result("SUPPRESSED", "global kill switch engaged");
  if (samples.length === 0) return result("SUPPRESSED", "telemetry gap: no samples");
  const ordered = [...samples].sort((a, b) => at(a.measuredAt) - at(b.measuredAt));
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index]!;
    if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0 || !Number.isFinite(sample.errorRate) || sample.errorRate < 0) return result("SUPPRESSED", "implausible negative telemetry");
    if (!Number.isFinite(at(sample.measuredAt)) || at(sample.measuredAt) > nowMs) return result("SUPPRESSED", "future telemetry timestamp");
    if (index > 0 && at(sample.measuredAt) - at(ordered[index - 1]!.measuredAt) > policy.maxTelemetryGapMs) return result("SUPPRESSED", "telemetry gap exceeds policy");
  }
  const latest = ordered[ordered.length - 1]!;
  if (nowMs - at(latest.measuredAt) > policy.maxTelemetryGapMs) {
    return result("SUPPRESSED", "telemetry gap: latest sample is stale");
  }
  const breached = latest.latencyMs >= policy.breachThresholdMs;
  if (state.activeRoute === "primary") {
    state.recoverySince = undefined;
    state.breachSince = breached ? state.breachSince ?? latest.measuredAt : undefined;
    if (!breached || nowMs - at(state.breachSince!) < policy.breachHoldDownMs) return result("NOOP", breached ? "breach hold-down active" : "healthy");
    if (state.failovers.length >= policy.maxFailoversPerWindow) return result("SUPPRESSED", "failover rate limit reached");
    state.activeRoute = "fallback";
    state.failovers.push(now);
    state.breachSince = undefined;
    return result("FAILOVER", "sustained latency breach");
  }
  state.breachSince = undefined;
  state.recoverySince = breached ? undefined : state.recoverySince ?? latest.measuredAt;
  if (breached || nowMs - at(state.recoverySince!) < policy.recoveryHoldDownMs) return result("NOOP", breached ? "fallback retained during breach" : "recovery hold-down active");
  state.activeRoute = "primary";
  state.recoverySince = undefined;
  return result("RESTORE", "sustained recovery");
}
