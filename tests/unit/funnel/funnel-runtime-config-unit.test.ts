// ---------------------------------------------------------------------------
// Funnel runtime config — unit tests.
//
// The five non-secret funnel knobs live in versioned per-profile config
// (src/config/funnelRuntime.ts), never in `.env`. Pinned here:
//   * profile resolution from deployment identity only;
//   * 10-minute stall default on every profile;
//   * per-profile merge/DuckDB/endpoint values.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  funnelRuntimeProfile,
  funnelRuntimeConfig,
} from "../../../src/config/funnelRuntime";

describe("funnelRuntimeProfile", () => {
  it("resolves development by default", () => {
    expect(funnelRuntimeProfile({} as NodeJS.ProcessEnv)).toBe("development");
    expect(
      funnelRuntimeProfile({ TELLUS_ENVIRONMENT_ID: "tellus-dev" } as NodeJS.ProcessEnv),
    ).toBe("development");
  });

  it("resolves test lanes", () => {
    expect(funnelRuntimeProfile({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(
      "test",
    );
    expect(
      funnelRuntimeProfile({
        TELLUS_ENVIRONMENT_ID: "tellus-tests-main",
      } as NodeJS.ProcessEnv),
    ).toBe("test");
  });

  it("resolves strict deployments to production", () => {
    expect(
      funnelRuntimeProfile({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe("production");
    expect(
      funnelRuntimeProfile({ TELLUS_DEPLOYMENT_STRICT: "1" } as NodeJS.ProcessEnv),
    ).toBe("production");
  });
});

describe("funnelRuntimeConfig", () => {
  it("keeps the 10-minute stall default on every profile", () => {
    for (const env of [
      {},
      { NODE_ENV: "test", TELLUS_ENVIRONMENT_ID: "tellus-tests-main" },
      { NODE_ENV: "production" },
    ] as NodeJS.ProcessEnv[]) {
      expect(funnelRuntimeConfig(env).indexingStallAfterMs).toBe(600_000);
    }
  });

  it("versions the stage stall budget and merge-CLI timeout on every profile (§5.3)", () => {
    const prev = {
      s: process.env.FUNNEL_STAGE_STALL_AFTER_MS,
      t: process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS,
    };
    // Retired knobs: setting them must change nothing.
    process.env.FUNNEL_STAGE_STALL_AFTER_MS = "1";
    process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS = "1";
    try {
      for (const env of [
        {},
        { NODE_ENV: "test", TELLUS_ENVIRONMENT_ID: "tellus-tests-main" },
        { NODE_ENV: "production" },
      ] as NodeJS.ProcessEnv[]) {
        const merged = { ...env, FUNNEL_STAGE_STALL_AFTER_MS: "1", FUNNEL_MERGE_CLI_TIMEOUT_MS: "1" };
        expect(funnelRuntimeConfig(merged).stageStallAfterMs).toBe(60_000);
        expect(funnelRuntimeConfig(merged).mergeCliTimeoutMs).toBe(1_800_000);
      }
    } finally {
      if (prev.s === undefined) delete process.env.FUNNEL_STAGE_STALL_AFTER_MS;
      else process.env.FUNNEL_STAGE_STALL_AFTER_MS = prev.s;
      if (prev.t === undefined) delete process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS;
      else process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS = prev.t;
    }
  });

  it("states merge + DuckDB + endpoint values per profile", () => {
    const dev = funnelRuntimeConfig({} as NodeJS.ProcessEnv);
    expect(dev.mergeOutOfProcess).toBe(true);
    expect(dev.mergeBatchSize).toBe(5_000);
    expect(dev.duckdbMemoryLimit).toBe("8GB");
    expect(dev.icebergContainerEndpoint).toBe("http://minio:9000");
    const test = funnelRuntimeConfig({
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    expect(test.mergeOutOfProcess).toBe(false);
    expect(test.duckdbMemoryLimit).toBe("1GB");
    const prod = funnelRuntimeConfig({
      TELLUS_DEPLOYMENT_STRICT: "1",
    } as NodeJS.ProcessEnv);
    expect(prod.mergeOutOfProcess).toBe(true);
    expect(prod.duckdbCliPath).toBe("/usr/local/bin/duckdb");
    expect(prod.duckdbMemoryLimit).toBe("8GB");
  });
});
