// ---------------------------------------------------------------------------
// FUNN-ISO — environment identity configuration tests (pure unit).
//
// These guard the "no implicit shared defaults" contract that the
// 2026-07-31 split-brain violated: in production-like environments missing
// identity fields MUST fail startup with an actionable error, and two
// distinct deployments MUST never resolve to the same namespace/queue.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  resolveEnvironmentIdentity,
  DeploymentConfigurationError,
  LOCAL_DEV_ENVIRONMENT_ID,
} from "../../../src/config/environmentIdentity";

const BASE = {
  TELLUS_DEPLOYMENT_STRICT: undefined,
  NODE_ENV: undefined,
  TEMPORAL_ADDRESS: "localhost:7233",
} as NodeJS.ProcessEnv;

describe("environmentIdentity (FUNN-ISO)", () => {
  it("local mode: explicit, deterministic dev defaults derived from env id", () => {
    const id = resolveEnvironmentIdentity({ ...BASE } as any);
    expect(id.environmentId).toBe(LOCAL_DEV_ENVIRONMENT_ID);
    expect(id.temporalNamespace).toBe(`tellus-funnel-${LOCAL_DEV_ENVIRONMENT_ID}`);
    expect(id.temporalTaskQueue).toBe(`tellus-funnel-queue-${LOCAL_DEV_ENVIRONMENT_ID}`);
    expect(id.mode).toBe("local");
    expect(id.workerIdentity).toMatch(/^tellus-dev:[a-z0-9.-]+:\d+@/);
  });

  it("local mode: two different env ids NEVER share a default namespace", () => {
    const a = resolveEnvironmentIdentity({ ...BASE, TELLUS_ENVIRONMENT_ID: "tellus-dev" } as any);
    const b = resolveEnvironmentIdentity({ ...BASE, TELLUS_ENVIRONMENT_ID: "verify-x" } as any);
    expect(a.temporalNamespace).not.toBe(b.temporalNamespace);
    expect(a.temporalTaskQueue).not.toBe(b.temporalTaskQueue);
  });

  it("strict mode: missing TELLUS_ENVIRONMENT_ID fails startup", () => {
    expect(() =>
      resolveEnvironmentIdentity({
        ...BASE,
        TELLUS_DEPLOYMENT_STRICT: "1",
        TEMPORAL_NAMESPACE: "ns-x",
        TEMPORAL_TASK_QUEUE: "q-x",
      } as any),
    ).toThrow(DeploymentConfigurationError);
  });

  it("strict mode: missing TEMPORAL_NAMESPACE fails startup", () => {
    expect(() =>
      resolveEnvironmentIdentity({
        ...BASE,
        TELLUS_DEPLOYMENT_STRICT: "1",
        TELLUS_ENVIRONMENT_ID: "tellus-prod",
        TEMPORAL_TASK_QUEUE: "q-x",
      } as any),
    ).toThrow(/TEMPORAL_NAMESPACE is required/);
  });

  it("strict mode: missing TEMPORAL_TASK_QUEUE fails startup", () => {
    expect(() =>
      resolveEnvironmentIdentity({
        ...BASE,
        TELLUS_DEPLOYMENT_STRICT: "1",
        TELLUS_ENVIRONMENT_ID: "tellus-prod",
        TEMPORAL_NAMESPACE: "ns-x",
      } as any),
    ).toThrow(/TEMPORAL_TASK_QUEUE is required/);
  });

  it("strict mode: NODE_ENV=production triggers the same requirement", () => {
    expect(() =>
      resolveEnvironmentIdentity({
        ...BASE,
        NODE_ENV: "production",
      } as any),
    ).toThrow(DeploymentConfigurationError);
  });

  it("strict mode: fully-specified identity resolves cleanly", () => {
    const id = resolveEnvironmentIdentity({
      ...BASE,
      TELLUS_DEPLOYMENT_STRICT: "1",
      TELLUS_ENVIRONMENT_ID: "tellus-prod",
      TEMPORAL_NAMESPACE: "tellus-funnel-prod",
      TEMPORAL_TASK_QUEUE: "tellus-funnel-queue-prod",
      TEMPORAL_WORKER_BUILD_ID: "abc123",
    } as any);
    expect(id.environmentId).toBe("tellus-prod");
    expect(id.temporalNamespace).toBe("tellus-funnel-prod");
    expect(id.temporalTaskQueue).toBe("tellus-funnel-queue-prod");
    expect(id.workerBuildId).toBe("abc123");
    expect(id.mode).toBe("strict");
  });

  it("invalid characters are rejected (namespace-safe ids only)", () => {
    expect(() =>
      resolveEnvironmentIdentity({
        ...BASE,
        TELLUS_ENVIRONMENT_ID: "bad env with spaces",
      } as any),
    ).toThrow(DeploymentConfigurationError);
  });

  it("worker identity embeds env + build + pid + host for poller audits", () => {
    const id = resolveEnvironmentIdentity({ ...BASE, TELLUS_ENVIRONMENT_ID: "prod-eu" } as any);
    expect(id.workerIdentity.startsWith("prod-eu:")).toBe(true);
    expect(id.workerIdentity).toContain("@");
    expect(id.workerIdentity.split(":").length).toBeGreaterThanOrEqual(3);
  });
});
