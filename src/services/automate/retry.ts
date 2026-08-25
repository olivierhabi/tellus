import type { RetryPolicy } from "./contracts";

export function retryDelaySeconds(
  policy: RetryPolicy,
  completedAttemptNumber: number,
  random: () => number = Math.random,
): number {
  if (!policy.enabled || completedAttemptNumber >= policy.maxAttempts) return 0;
  const base =
    policy.strategy === "exponential"
      ? policy.delaySeconds *
        Math.pow(policy.multiplier, Math.max(0, completedAttemptNumber - 1))
      : policy.delaySeconds;
  const bounded = Math.min(base, policy.maxDelaySeconds);
  if (policy.jitter.kind === "none") return bounded;
  if (policy.jitter.kind === "factor") {
    const spread = bounded * policy.jitter.factor;
    return Math.max(0, bounded - spread + random() * spread * 2);
  }
  const spread = policy.jitter.durationSeconds;
  return Math.max(0, bounded - spread + random() * spread * 2);
}

export function shouldAutoMute(input: {
  enabled: boolean;
  minimumExecutions: number;
  failureRateThreshold: number;
  outcomes: Array<"succeeded" | "failed" | "partially_failed">;
}): boolean {
  if (!input.enabled || input.outcomes.length < input.minimumExecutions) {
    return false;
  }
  const failures = input.outcomes.filter((outcome) => outcome === "failed").length;
  return failures / input.outcomes.length >= input.failureRateThreshold;
}
