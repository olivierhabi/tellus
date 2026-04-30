// ---------------------------------------------------------------------------
// stageDelay.ts — unit tests
//
// `FUNNEL_STAGE_DELAY_MS` is read ONCE at module load. A prod deployment
// that mistypes the env (`"abc"`, `"-500"`, `"5000ms"`) must never stall
// a live pipeline by an unexpected delay. These tests lock that parse
// contract by re-importing the module under different env values.
//
// Each block uses `vi.resetModules()` + `vi.stubEnv()` so the module's
// top-level `const FUNNEL_STAGE_DELAY_MS = ...` is re-evaluated against
// the current env. Dynamic `import()` is required — a top-level
// `import` wouldn't re-execute after `resetModules()`.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadStageDelay(envValue: string | undefined) {
  vi.resetModules();
  if (envValue === undefined) {
    vi.stubEnv("FUNNEL_STAGE_DELAY_MS", "");
  } else {
    vi.stubEnv("FUNNEL_STAGE_DELAY_MS", envValue);
  }
  // Force-unset when the caller wants the env absent. `vi.stubEnv("", "")`
  // is still a set; we need a real `delete` to cover the default-path.
  if (envValue === undefined) {
    delete process.env.FUNNEL_STAGE_DELAY_MS;
  }
  return await import("../../../src/services/funnel/stageDelay");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("FUNNEL_STAGE_DELAY_MS parse", () => {
  it("defaults to 0 when the env is unset", async () => {
    const mod = await loadStageDelay(undefined);
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("parses a plain integer string", async () => {
    const mod = await loadStageDelay("5000");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(5000);
  });

  it("floors fractional milliseconds (e.g. 5000.7 → 5000)", async () => {
    const mod = await loadStageDelay("5000.7");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(5000);
  });

  it("coerces a non-numeric string to 0 (fail-safe)", async () => {
    const mod = await loadStageDelay("abc");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("coerces a negative value to 0 (fail-safe)", async () => {
    const mod = await loadStageDelay("-500");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("coerces zero to zero (explicit prod default)", async () => {
    const mod = await loadStageDelay("0");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("treats an empty string as unset → 0", async () => {
    const mod = await loadStageDelay("");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("rejects trailing units like '5000ms' → 0 (Number() returns NaN)", async () => {
    const mod = await loadStageDelay("5000ms");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(0);
  });

  it("reads the env only at module load (subsequent env changes ignored)", async () => {
    const mod = await loadStageDelay("5000");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(5000);

    // Change the env AFTER the module is loaded.
    vi.stubEnv("FUNNEL_STAGE_DELAY_MS", "99999");
    expect(mod.FUNNEL_STAGE_DELAY_MS).toBe(5000);

    // Only re-importing picks up the change.
    const reloaded = await loadStageDelay("99999");
    expect(reloaded.FUNNEL_STAGE_DELAY_MS).toBe(99999);
  });
});

describe("sleepForStageDelay", () => {
  it("returns an already-resolved promise when delay is 0 (zero-overhead prod path)", async () => {
    const mod = await loadStageDelay("0");
    const start = performance.now();
    await mod.sleepForStageDelay();
    const elapsed = performance.now() - start;
    // Resolves synchronously — no setTimeout hop — so elapsed should
    // be a fraction of a millisecond.
    expect(elapsed).toBeLessThan(5);
  });

  it("waits at least the configured delay when non-zero", async () => {
    // 50 ms is short enough to keep the unit test fast but long
    // enough to be measurable above wall-clock jitter.
    const mod = await loadStageDelay("50");
    const start = performance.now();
    await mod.sleepForStageDelay();
    const elapsed = performance.now() - start;
    // ≥ 45 ms absorbs timer-resolution jitter on slower CI hosts.
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});
