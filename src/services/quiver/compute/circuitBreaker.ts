/**
 * B5 — Circuit breaker (per B5 C-14).
 *
 * Opens after >= 50% failure rate over a sliding 50-call window.
 * Half-open after 30 s; on first half-open success → closed; on first
 * half-open failure → re-open with cooldown reset.
 *
 * Exposes `state` for the `tellus_quiver_compute_circuit_state{backend}`
 * gauge.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  windowSize: number;       // default 50
  thresholdRatio: number;   // default 0.5
  cooldownMs: number;       // default 30_000
  minCallsToTrip: number;   // default 10 — avoid tripping on tiny windows
}

const DEFAULTS: CircuitBreakerOptions = {
  windowSize: 50,
  thresholdRatio: 0.5,
  cooldownMs: 30_000,
  minCallsToTrip: 10,
};

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(public readonly backend: string) {
    super(`circuit open for backend ${backend}`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private window: boolean[] = [];   // true=success, false=failure
  private openedAt = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(public readonly name: string, opts: Partial<CircuitBreakerOptions> = {}, private readonly now: () => number = Date.now) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Synchronous gate; throws CircuitOpenError if open + still cooling. */
  guard(): void {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = 'half_open';
      } else {
        throw new CircuitOpenError(this.name);
      }
    }
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.window = [];
      return;
    }
    this.pushSample(true);
    this.evaluate();
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }
    this.pushSample(false);
    this.evaluate();
  }

  private pushSample(ok: boolean) {
    this.window.push(ok);
    if (this.window.length > this.opts.windowSize) {
      this.window.shift();
    }
  }

  private evaluate() {
    if (this.window.length < this.opts.minCallsToTrip) return;
    const failures = this.window.filter((v) => !v).length;
    const ratio = failures / this.window.length;
    if (ratio >= this.opts.thresholdRatio) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Test-only — reset to closed with empty window. */
  reset(): void {
    this.state = 'closed';
    this.window = [];
    this.openedAt = 0;
  }
}
