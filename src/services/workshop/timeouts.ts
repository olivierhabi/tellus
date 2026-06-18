// =============================================================================
// Workshop downstream timeout / circuit-open helpers.
// Spec §B05/§B10 default OSS=20s / Action=60s (overridable via env or setter).
// =============================================================================

import { workshopError } from "./errors.js";

let _ossTimeoutMs = Number(process.env.WORKSHOP_OSS_TIMEOUT_MS ?? "20000");
let _actionsTimeoutMs = Number(
  process.env.WORKSHOP_ACTIONS_TIMEOUT_MS ?? "60000",
);

export function setOssTimeoutMs(ms: number): number {
  const prev = _ossTimeoutMs;
  _ossTimeoutMs = ms;
  return prev;
}
export function getOssTimeoutMs(): number {
  return _ossTimeoutMs;
}
export function setActionsTimeoutMs(ms: number): number {
  const prev = _actionsTimeoutMs;
  _actionsTimeoutMs = ms;
  return prev;
}
export function getActionsTimeoutMs(): number {
  return _actionsTimeoutMs;
}

/**
 * Race `p` against a timeout. On expiry, rejects with
 * `Tellus:Workshop:DownstreamTimeout` (504). The downstream label is
 * surfaced in `parameters.downstream` so dashboards/alerts can split.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  downstream: "oss" | "actions" | "oms" | "functions",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        workshopError({
          errorName: "Tellus:Workshop:DownstreamTimeout",
          status: 504,
          parameters: { downstream, timeoutMs: ms },
        }),
      );
    }, ms);
  });
  try {
    return (await Promise.race([p, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker — 5 consecutive failures → open for 30s.
// Per downstream label. Tests can reset via resetCircuit().
// ---------------------------------------------------------------------------

interface CircuitState {
  failures: number;
  openedAt: number | null;
}
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 30_000;
const _circuits = new Map<string, CircuitState>();

export function resetCircuits(): void {
  _circuits.clear();
}

function get(downstream: string): CircuitState {
  let s = _circuits.get(downstream);
  if (!s) {
    s = { failures: 0, openedAt: null };
    _circuits.set(downstream, s);
  }
  return s;
}

export function isCircuitOpen(downstream: string): boolean {
  const s = get(downstream);
  if (s.openedAt == null) return false;
  if (Date.now() - s.openedAt > OPEN_MS) {
    s.openedAt = null;
    s.failures = 0;
    return false;
  }
  return true;
}

export async function withCircuit<T>(
  downstream: "oss" | "actions" | "oms" | "functions",
  fn: () => Promise<T>,
): Promise<T> {
  if (isCircuitOpen(downstream)) {
    throw workshopError({
      errorName: "Tellus:Workshop:DownstreamCircuitOpen",
      status: 503,
      parameters: { downstream },
    });
  }
  const s = get(downstream);
  try {
    const out = await fn();
    s.failures = 0;
    return out;
  } catch (e) {
    s.failures += 1;
    if (s.failures >= FAILURE_THRESHOLD) {
      s.openedAt = Date.now();
    }
    throw e;
  }
}
