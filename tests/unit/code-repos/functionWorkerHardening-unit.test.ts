// ---------------------------------------------------------------------------
// functionWorkerHardening — Phase 5 worker construction tests.
//
// Workers must be spawned with:
//   • a memory cap (resourceLimits.maxOldGenerationSizeMb) — the vm
//     timeout bounds CPU only;
//   • an environment WHITELIST — never the full process.env (which
//     carries DB credentials and other secrets).
//
// The pool uses its sync fallback where the .ts worker cannot be
// resolved (unit lane), so these tests pin the construction options
// directly; spawnSlot consumes workerOptions() unchanged.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest";

import { workerOptions } from "../../../src/services/functionWorkerPool";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("function worker hardening (Phase 5)", () => {
  it("caps worker memory (resourceLimits.maxOldSpaceSizeMB)", () => {
    const options = workerOptions();
    expect(options.resourceLimits.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(64);
  });

  it("honors the FUNCTION_WORKER_MAX_OLD_SPACE_MB override with a 64MB floor", () => {
    vi.stubEnv("FUNCTION_WORKER_MAX_OLD_SPACE_MB", "512");
    expect(workerOptions().resourceLimits.maxOldGenerationSizeMb).toBe(512);
    vi.stubEnv("FUNCTION_WORKER_MAX_OLD_SPACE_MB", "8");
    expect(workerOptions().resourceLimits.maxOldGenerationSizeMb).toBe(64);
  });

  it("whitelists the worker environment — no secrets leak", () => {
    vi.stubEnv("PGPASSWORD", "super-secret");
    vi.stubEnv("LLM_API_KEY", "also-secret");
    vi.stubEnv("TELOS_AIE_AGENT_TOKEN", "token-secret");

    const options = workerOptions();

    expect(Object.keys(options.env).sort()).toEqual([
      "HOME",
      "NODE_ENV",
      "PATH",
      "TZ",
    ]);
    expect(options.env.PGPASSWORD).toBeUndefined();
    expect(options.env.LLM_API_KEY).toBeUndefined();
    expect(options.env.TELOS_AIE_AGENT_TOKEN).toBeUndefined();
  });
});
