// ---------------------------------------------------------------------------
// destructiveTestGuard — PURE UNIT tests (no live PG / HTTP).
//
// Every case injects BOTH a fabricated `env` and stubbed `deps`
// (liveDatabaseName / readDatabaseSeal / probeApiEnvironment), so the guard's
// real PG/HTTP sources are never touched. This is the offline proof of the
// fail-closed contract: no single environment flag — including
// TELLUS_DESTRUCTIVE_TESTS_ALLOWED='1' — can satisfy the assertion when any
// other identity field points at a dev/legacy/production shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  assertDestructiveTestEnvironment,
  DestructiveTestEnvironmentError,
} from "../../../src/services/testing/destructiveTestGuard";

type LaneEnvOverrides = Partial<Record<string, string | undefined>>;

/** Full, VALID test-lane environment. Overrides may unset a field (undefined). */
function fabEnv(overrides: LaneEnvOverrides = {}): NodeJS.ProcessEnv {
  return {
    TELLUS_DESTRUCTIVE_TESTS_ALLOWED: "1",
    TELLUS_ENVIRONMENT_ID: "tellus-tests-main",
    PGDATABASE: "tellus_tests",
    TEMPORAL_NAMESPACE: "tellus-funnel-tellus-tests-main",
    TEMPORAL_TASK_QUEUE: "tellus-funnel-queue-tellus-tests-main",
    KEYCLOAK_REALM: "tellus-tests",
    OS_INDEX_PREFIX: "ttest-ontology-",
    S3_BUCKET: "tellus-tests-bucket",
    TELLUS_TEST_API_BASE_URL: "http://localhost:3000",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

type Deps = NonNullable<
  Parameters<typeof assertDestructiveTestEnvironment>[0]["deps"]
>;
type DepsOverrides = {
  [K in keyof Deps]?: Deps[K] | (() => Promise<unknown>);
};

/** Stub deps: live DB agrees with config, seal agrees with the env id. */
function fabDeps(overrides: DepsOverrides = {}): Deps {
  return {
    liveDatabaseName: async () => "tellus_tests",
    readDatabaseSeal: async () => "tellus-tests-main",
    probeApiEnvironment: async () => undefined,
    ...overrides,
  };
}

describe("destructiveTestGuard", () => {
  it("happy path: returns the proof object with all ten fields", async () => {
    const proof = await assertDestructiveTestEnvironment({
      operation: "unit-test-happy-path",
      env: fabEnv(),
      deps: fabDeps(),
    });
    expect(proof).toEqual({
      environmentId: "tellus-tests-main",
      databaseEnvironmentId: "tellus-tests-main",
      databaseName: "tellus_tests",
      temporalNamespace: "tellus-funnel-tellus-tests-main",
      temporalTaskQueue: "tellus-funnel-queue-tellus-tests-main",
      keycloakRealm: "tellus-tests",
      objectIndexPrefix: "ttest-ontology-",
      objectStorageBucketOrPrefix: "tellus-tests-bucket",
      apiBaseUrl: "http://localhost:3000",
      destructiveTestsAllowed: true,
    });
    // All ten DestructiveTestEnvironmentProof fields are truthy.
    expect(proof.environmentId).toBeTruthy();
    expect(proof.databaseEnvironmentId).toBeTruthy();
    expect(proof.databaseName).toBeTruthy();
    expect(proof.temporalNamespace).toBeTruthy();
    expect(proof.temporalTaskQueue).toBeTruthy();
    expect(proof.keycloakRealm).toBeTruthy();
    expect(proof.objectIndexPrefix).toBeTruthy();
    expect(proof.objectStorageBucketOrPrefix).toBeTruthy();
    expect(proof.apiBaseUrl).toBeTruthy();
    expect(proof.destructiveTestsAllowed).toBe(true);
  });

  it("rejects with 'not_allowed' when TELLUS_DESTRUCTIVE_TESTS_ALLOWED is unset", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_DESTRUCTIVE_TESTS_ALLOWED: undefined }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "not_allowed" });
  });

  it("rejects with 'not_allowed' when the flag is 'true' (must be exactly '1')", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_DESTRUCTIVE_TESTS_ALLOWED: "true" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "not_allowed" });
  });

  it("rejects with 'environment_id_denied' for TELLUS_ENVIRONMENT_ID='tellus-dev'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_ENVIRONMENT_ID: "tellus-dev" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "environment_id_denied" });
  });

  it("rejects with 'environment_id_policy' for TELLUS_ENVIRONMENT_ID='prod-1'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_ENVIRONMENT_ID: "prod-1" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "environment_id_policy" });
  });

  it("rejects with 'environment_id_missing' when TELLUS_ENVIRONMENT_ID is unset", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_ENVIRONMENT_ID: undefined }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "environment_id_missing" });
  });

  it("rejects with 'database_denied' for PGDATABASE='tellus_db'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ PGDATABASE: "tellus_db" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "database_denied" });
  });

  it("rejects with 'database_missing' when PGDATABASE is unset", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ PGDATABASE: undefined }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "database_missing" });
  });

  it("rejects with 'database_ambiguous' when the live connection disagrees with PGDATABASE", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv(),
        deps: fabDeps({ liveDatabaseName: async () => "tellus_db" }),
      }),
    ).rejects.toMatchObject({ reasonCode: "database_ambiguous" });
  });

  it("rejects with 'database_unsealed' when the seal query returns null", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv(),
        deps: fabDeps({ readDatabaseSeal: async () => null }),
      }),
    ).rejects.toMatchObject({ reasonCode: "database_unsealed" });
  });

  it("rejects with 'database_seal_mismatch' when the seal disagrees with the env id", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv(),
        deps: fabDeps({ readDatabaseSeal: async () => "tellus-dev" }),
      }),
    ).rejects.toMatchObject({ reasonCode: "database_seal_mismatch" });
  });

  it("rejects with 'temporal_namespace_denied' for the legacy namespace 'tellus-funnel'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TEMPORAL_NAMESPACE: "tellus-funnel" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "temporal_namespace_denied" });
  });

  it("rejects with 'temporal_namespace_denied' for the dev namespace 'tellus-funnel-tellus-dev'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TEMPORAL_NAMESPACE: "tellus-funnel-tellus-dev" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "temporal_namespace_denied" });
  });

  it("rejects with 'temporal_task_queue_denied' for the legacy queue 'tellus-funnel-queue'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TEMPORAL_TASK_QUEUE: "tellus-funnel-queue" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "temporal_task_queue_denied" });
  });

  it("rejects with 'keycloak_realm_denied' for the dev realm 'tellus'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ KEYCLOAK_REALM: "tellus" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "keycloak_realm_denied" });
  });

  it("rejects with 'index_prefix_missing' when OS_INDEX_PREFIX is unset", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ OS_INDEX_PREFIX: undefined }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "index_prefix_missing" });
  });

  it("rejects with 'index_prefix_denied' for the dev/prod default 'ontology-'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ OS_INDEX_PREFIX: "ontology-" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "index_prefix_denied" });
  });

  it("rejects with 'bucket_denied' for the dev/prod bucket 'tellus-uploads'", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ S3_BUCKET: "tellus-uploads" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "bucket_denied" });
  });

  it("rejects with 'api_base_url_remote' for a non-loopback TELLUS_TEST_API_BASE_URL", async () => {
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv({ TELLUS_TEST_API_BASE_URL: "https://example.com" }),
        deps: fabDeps(),
      }),
    ).rejects.toMatchObject({ reasonCode: "api_base_url_remote" });
  });

  it("propagates the probe failure context when probeApiEnvironment rejects (skipApiProbe false)", async () => {
    const probeFailure = new DestructiveTestEnvironmentError(
      "destructive-test guard :: apiBaseUrl http://localhost:3000/health self-reports environmentId='tellus-dev'",
      "api_environment_mismatch",
      "apiBaseUrl",
    );
    await expect(
      assertDestructiveTestEnvironment({
        operation: "unit-test",
        env: fabEnv(),
        deps: fabDeps({
          probeApiEnvironment: async () => {
            throw probeFailure;
          },
        }),
      }),
    ).rejects.toMatchObject({
      reasonCode: "api_environment_mismatch",
      field: "apiBaseUrl",
    });
  });

  it("skipApiProbe: true skips the API probe entirely (stubbed probe throws, call succeeds)", async () => {
    const proof = await assertDestructiveTestEnvironment({
      operation: "unit-test",
      skipApiProbe: true,
      env: fabEnv(),
      deps: fabDeps({
        probeApiEnvironment: async () => {
          throw new Error("probe must NOT be invoked when skipped");
        },
      }),
    });
    expect(proof.environmentId).toBe("tellus-tests-main");
  });

  it.each([
    {
      label: "TEMPORAL_NAMESPACE flipped to the legacy namespace",
      overrides: { TEMPORAL_NAMESPACE: "tellus-funnel" },
      reasonCode: "temporal_namespace_denied",
    },
    {
      label: "PGDATABASE flipped to the shared dev database",
      overrides: { PGDATABASE: "tellus_db" },
      reasonCode: "database_denied",
    },
    {
      label: "KEYCLOAK_REALM flipped to the system realm",
      overrides: { KEYCLOAK_REALM: "master" },
      reasonCode: "keycloak_realm_denied",
    },
  ])(
    "no single-flag bypass: $label still fails with TELLUS_DESTRUCTIVE_TESTS_ALLOWED='1' ($reasonCode)",
    async ({ overrides, reasonCode }) => {
      await expect(
        assertDestructiveTestEnvironment({
          operation: "unit-test-no-bypass",
          env: fabEnv(overrides),
          deps: fabDeps(),
        }),
      ).rejects.toMatchObject({ reasonCode });
    },
  );
});
