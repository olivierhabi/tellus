// B9.10 — Throughput cap + backpressure for the funnel.
//
// Implements a sliding-window rate limiter: at most `maxOpsPerSec` bulk
// operations may be issued per second. When the cap is exceeded, the
// caller awaits until the window opens. The pipeline records the
// observed wait-time so we can alert on saturation.
export interface ThrottleResult {
  permittedAt: number;
  waitedMs: number;
}

export class B9Throttle {
  private readonly window: number[] = [];
  constructor(private readonly maxOpsPerSec: number, private readonly nowFn: () => number = () => Date.now()) {}

  /** Awaits a slot in the current 1s window. Returns when the call is permitted. */
  async acquire(): Promise<ThrottleResult> {
    const start = this.nowFn();
    while (true) {
      const now = this.nowFn();
      // Drop expired entries (older than 1s).
      while (this.window.length > 0 && now - this.window[0]! >= 1000) this.window.shift();
      if (this.window.length < this.maxOpsPerSec) {
        this.window.push(now);
        return { permittedAt: now, waitedMs: now - start };
      }
      const sleepFor = 1000 - (now - this.window[0]!);
      await new Promise((r) => setTimeout(r, Math.max(1, sleepFor)));
    }
  }

  size(): number { return this.window.length; }
}
