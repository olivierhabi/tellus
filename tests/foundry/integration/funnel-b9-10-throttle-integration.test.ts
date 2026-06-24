import { describe, expect, it } from "vitest";
import { B9Throttle } from "../../../src/services/funnel/b9Throttle";

describe("B9.10 — Throughput cap + backpressure", () => {
  it("permits up to maxOpsPerSec calls without waiting", async () => {
    const t = new B9Throttle(5);
    const results = await Promise.all(Array.from({ length: 5 }, () => t.acquire()));
    for (const r of results) expect(r.waitedMs).toBeLessThan(50);
    expect(t.size()).toBe(5);
  });

  it("blocks the (N+1)th call until the window opens", async () => {
    const t = new B9Throttle(2);
    await t.acquire();
    await t.acquire();
    const t0 = Date.now();
    await t.acquire();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s window
  }, 5000);

  it("size reflects the rolling window", async () => {
    const t = new B9Throttle(10);
    for (let i = 0; i < 5; i++) await t.acquire();
    expect(t.size()).toBe(5);
  });
});
