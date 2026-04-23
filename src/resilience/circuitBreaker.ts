// ---------------------------------------------------------------------------
// src/resilience/circuitBreaker.ts
//
// Shared circuit-breaker implementation for Block F (F-P4-11).
//
// Wraps an async dependency call with CLOSED → OPEN → HALF_OPEN state.
// Per-label registry so callers share state across the process (callers
// on different replicas have independent state by design — cross-replica
// coordination is Block H's Kafka-based invalidation bus per F-P5-08).
// ---------------------------------------------------------------------------

import { incCounter, setGauge } from "../services/funnel/metrics";

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  failureThreshold: number;   // consecutive failures to trip to OPEN
  cooldownMs: number;         // time in OPEN before probing HALF_OPEN
  halfOpenMaxProbes: number;  // concurrent probes allowed in HALF_OPEN
}

const DEFAULTS: BreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 10_000,
  halfOpenMaxProbes: 1,
};

export class CircuitOpenError extends Error {
  public readonly code = "CIRCUIT_OPEN";
  public readonly statusCode = 503;
  constructor(public readonly label: string) {
    super(`circuit breaker OPEN for ${label}`);
    this.name = "CircuitOpenError";
  }
}

interface BreakerInstance {
  label: string;
  options: BreakerOptions;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenProbesInFlight: number;
}

const registry = new Map<string, BreakerInstance>();

function ensure(label: string, options: Partial<BreakerOptions>): BreakerInstance {
  let b = registry.get(label);
  if (!b) {
    b = {
      label,
      options: { ...DEFAULTS, ...options },
      state: "closed",
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenProbesInFlight: 0,
    };
    registry.set(label, b);
  }
  return b;
}

function transition(b: BreakerInstance, next: BreakerState): void {
  if (b.state === next) return;
  b.state = next;
  if (next === "open") b.openedAt = Date.now();
  if (next === "closed") {
    b.consecutiveFailures = 0;
    b.halfOpenProbesInFlight = 0;
  }
  incCounter("tellus_circuit_breaker_transition_total", { label: b.label, to: next });
  setGauge("tellus_circuit_breaker_state", b.state === "closed" ? 0 : b.state === "half_open" ? 1 : 2);
}

/**
 * Execute `fn` through the circuit breaker keyed by `label`. Throws
 * CircuitOpenError when OPEN. Records success/failure per dependency
 * convention (anything that throws counts as failure unless `isFailure`
 * explicitly returns false).
 */
export async function withBreaker<T>(
  label: string,
  fn: () => Promise<T>,
  options: Partial<BreakerOptions> = {},
  isFailure: (err: unknown) => boolean = () => true,
): Promise<T> {
  const b = ensure(label, options);

  // Transition OPEN → HALF_OPEN once cooldown elapses.
  if (b.state === "open" && Date.now() - b.openedAt >= b.options.cooldownMs) {
    transition(b, "half_open");
  }

  if (b.state === "open") {
    incCounter("tellus_circuit_breaker_rejected_total", { label });
    throw new CircuitOpenError(label);
  }

  if (b.state === "half_open" && b.halfOpenProbesInFlight >= b.options.halfOpenMaxProbes) {
    incCounter("tellus_circuit_breaker_rejected_total", { label });
    throw new CircuitOpenError(label);
  }

  if (b.state === "half_open") b.halfOpenProbesInFlight += 1;

  try {
    const result = await fn();
    onSuccess(b);
    return result;
  } catch (err) {
    if (isFailure(err)) onFailure(b);
    else onSuccess(b); // classified as non-failure (e.g., 4xx client error)
    throw err;
  } finally {
    if (b.state === "half_open") b.halfOpenProbesInFlight = Math.max(0, b.halfOpenProbesInFlight - 1);
  }
}

function onSuccess(b: BreakerInstance): void {
  if (b.state === "half_open") transition(b, "closed");
  b.consecutiveFailures = 0;
}

function onFailure(b: BreakerInstance): void {
  b.consecutiveFailures += 1;
  if (b.state === "half_open") {
    transition(b, "open");
    return;
  }
  if (b.state === "closed" && b.consecutiveFailures >= b.options.failureThreshold) {
    transition(b, "open");
  }
}

/** Test hook — not part of production API. */
export function __resetBreakers(): void {
  registry.clear();
}

export function getBreakerState(label: string): BreakerState | null {
  return registry.get(label)?.state ?? null;
}

export default { withBreaker, CircuitOpenError, getBreakerState };
