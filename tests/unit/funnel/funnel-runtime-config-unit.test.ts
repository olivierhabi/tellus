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
