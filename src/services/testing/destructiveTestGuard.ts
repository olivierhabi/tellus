// ---------------------------------------------------------------------------
// Destructive-test environment guard — FUNN-ISO-1 (fail closed).
//
// Every destructive test-side helper (seeds, ontology resets, truncations,
// index deletion, bucket cleanup, workflow termination, stack teardown)
// MUST call assertDestructiveTestEnvironment() BEFORE mutating anything.
//
// Why this exists: on 2026-07-31 the vitest globalSetup ran
// src/seed.ts → resetEnterpriseOntologyForSeed() against the SHARED dev
// database (tellus_db) and silently wiped the dev ontology — hours after a
// production-like incident recovery ran against the same tables. A suffix
// "test DBs should be separate" was not enough: the seed targeted whatever
// PGDATABASE happened to hold. This guard makes destructive test
// infrastructure STRUCTURALLY INCAPABLE of touching dev/production data.
//
// The proof is multi-source. No single environment flag can satisfy it:
//   * TELLUS_DESTRUCTIVE_TESTS_ALLOWED=1     — operator intent (necessary,
//                                              never sufficient);
//   * naming policy                          — every identity field must be
//                                              test-shape, dev/prod values
//                                              are DENY-listed regardless of
//                                              anything else;
//   * databaseEnvironmentId                  — the DB's first-writer-wins
//                                              `deployment_environment` seal,
//                                              server-side state a CLI flag
//                                              cannot forge;
//   * current_database()                     — live connection truth versus
//                                              the PGDATABASE config;
//   * /health.environmentId                  — the API process's own
//                                              self-reported environment id
//                                              (when the API probe is on);
//   * full-field presence                    — ANY missing/partially-set
//                                              field is treated as an
//                                              ambiguity and fails closed.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  objectIndexPrefix,
  DEFAULT_OBJECT_INDEX_PREFIX,
} from "../../config/environmentIdentity";

export class DestructiveTestEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "DestructiveTestEnvironmentError";
  }
}

export interface DestructiveTestEnvironmentProof {
  environmentId: string;
  databaseEnvironmentId: string;
  databaseName: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  keycloakRealm: string;
  objectIndexPrefix: string;
  objectStorageBucketOrPrefix: string;
  apiBaseUrl: string;
  destructiveTestsAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Naming policy. A test/verify environment must LOOK like one in every
// dimension, and must never equal a dev/legacy/production value.
// ---------------------------------------------------------------------------

/** Allowed environment-id families for destructive tests. */
export const TEST_ENVIRONMENT_ID_PATTERN =
  /^tellus-(tests|automate-verify)(-[a-z0-9-]+)?$/;

/** Hard deny-lists — checked unconditionally, cannot be overridden. */
export const DENIED_ENVIRONMENT_IDS = new Set([
  "tellus-dev",
  "dev",
  "default",
  "local",
  "test", // ambiguous: not a full identity
  "tellus-prod",
  "tellus-production",
  "production",
  "prod",
]);
const DENIED_DB_NAMES = new Set([
  "tellus_db", // shared dev database
  "postgres",
  "template0",
  "template1",
  "tellus_prod",
  "tellus_production",
]);
const DENIED_TEMPORAL_NAMESPACES = new Set([
  "default",
  "tellus-funnel", // legacy pre-isolation namespace
  "tellus-funnel-tellus-dev", // dev namespace
]);
const DENIED_TEMPORAL_TASK_QUEUES = new Set([
  "tellus-funnel-queue", // legacy pre-isolation queue
  "tellus-funnel-queue-tellus-dev", // dev queue
]);
const DENIED_KEYCLOAK_REALMS = new Set([
  "master",
  "tellus", // dev realm
]);
const DENIED_INDEX_PREFIXES = new Set([
  DEFAULT_OBJECT_INDEX_PREFIX, // "ontology-" — the dev/prod default
]);
const DENIED_BUCKETS = new Set([
  "tellus-uploads", // dev/prod object-storage default
  "tellus",
  "tellus-production",
]);

/** Pattern families each field must positively match. */
const TEST_FAMILY = /(?:tests|verify)/;
const TEST_INDEX_PREFIX_PATTERN = /^(ttest|verify)-[a-z0-9-]*ontology-$/;
const TEST_REALM_PATTERN = /^tellus-(tests|automate-verify)(-[a-z0-9-]+)?$/;
const TEST_NAMESPACE_PATTERN =
  /^tellus-funnel-(?:tellus-tests|verify)-[a-z0-9-]+$/;
const TEST_TASK_QUEUE_PATTERN =
  /^tellus-funnel-(?:queue-)?(?:tellus-tests|verify)-[a-z0-9-]+$/;

function fail(
  reasonCode: string,
  field: string,
  message: string,
): never {
  throw new DestructiveTestEnvironmentError(
    `destructive-test guard :: ${message}`,
    reasonCode,
    field,
  );
}

function requireEnvField(
  env: NodeJS.ProcessEnv,
  field: keyof NodeJS.ProcessEnv,
  reasonCode: string,
): string {
  const v = env[field]?.trim();
  if (!v) {
    fail(
      reasonCode,
      String(field),
      `${String(field)} is unset — destructive tests require EVERY environment ` +
        `field to be explicit; refusing to guess or inherit a default.`,
    );
  }
  return v!;
}

// ---------------------------------------------------------------------------
// API self-identification probe
// ---------------------------------------------------------------------------

async function probeApiEnvironment(
  apiBaseUrl: string,
  expectedEnvironmentId: string,
  timeoutMs = 4000,
): Promise<void> {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/health`;
  let body: { environmentId?: unknown } | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      fail(
        "api_probe_unhealthy",
        "apiBaseUrl",
        `apiBaseUrl ${url} returned HTTP ${res.status}; destructive tests ` +
          `must only run against a healthy, provably-isolated stack.`,
      );
    }
    body = (await res.json()) as { environmentId?: unknown };
  } catch (err) {
    if (err instanceof DestructiveTestEnvironmentError) throw err;
    fail(
      "api_probe_unreachable",
      "apiBaseUrl",
      `apiBaseUrl ${url} unreachable (${(err as Error).message}).`,
    );
  }
  const actual = typeof body?.environmentId === "string" ? body.environmentId : "";
  if (actual !== expectedEnvironmentId) {
    fail(
      "api_environment_mismatch",
      "apiBaseUrl",
      `apiBaseUrl ${url} self-reports environmentId='${actual || "<missing>"}' ` +
        `but the test lane is configured as '${expectedEnvironmentId}'. ` +
        `This is exactly how a destructive test would reach a foreign stack.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Database seal + live database identity
// ---------------------------------------------------------------------------

async function readDatabaseSeal(): Promise<string | null> {
  try {
    const r = await query(
      `SELECT environment_id FROM deployment_environment WHERE singleton = TRUE`,
    );
    return (r.rows[0]?.environment_id as string | undefined) ?? null;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/does not exist/i.test(msg)) return null;
    throw err;
  }
}

async function liveDatabaseName(): Promise<string> {
  const r = await query(`SELECT current_database() AS name`);
  return String(r.rows[0]?.name ?? "");
}

/**
 * Seal the connected database for a test environment (first-writer-wins).
 * Called by test-stack BOOTSTRAP, never by destructive operations themselves.
 */
export async function sealTestDatabaseEnvironment(
  environmentId: string,
): Promise<void> {
  await query(
    `INSERT INTO deployment_environment (singleton, environment_id, sealed_by)
     VALUES (TRUE, $1, 'destructive-test-bootstrap')
     ON CONFLICT (singleton) DO NOTHING`,
    [environmentId],
  );
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface AssertDestructiveTestOptions {
  /** Name of the destructive operation (for error context + logging). */
  operation: string;
  /** Skip the /health API probe (used BEFORE the API is spawned). */
  skipApiProbe?: boolean;
  /** Environment override (tests inject a fabricated env). */
  env?: NodeJS.ProcessEnv;
  /** Injected dependencies (unit tests stub PG + HTTP; production paths
   *  always use the real live sources — a stubbed production path would be
   *  self-deception). */
  deps?: {
    liveDatabaseName?: () => Promise<string>;
    readDatabaseSeal?: () => Promise<string | null>;
    probeApiEnvironment?: (
      apiBaseUrl: string,
      expectedEnvironmentId: string,
    ) => Promise<void>;
  };
}

export async function assertDestructiveTestEnvironment(
  options: AssertDestructiveTestOptions,
): Promise<DestructiveTestEnvironmentProof> {
  const env = options.env ?? process.env;

  // 0) Operator intent — necessary, never sufficient.
  if (env.TELLUS_DESTRUCTIVE_TESTS_ALLOWED !== "1") {
    fail(
      "not_allowed",
      "TELLUS_DESTRUCTIVE_TESTS_ALLOWED",
      `operation '${options.operation}' is DESTRUCTIVE and requires ` +
        `TELLUS_DESTRUCTIVE_TESTS_ALLOWED='1' exactly.`,
    );
  }

  // 1) Environment id: explicit, test-shaped, not deny-listed.
  const environmentId = requireEnvField(
    env,
    "TELLUS_ENVIRONMENT_ID",
    "environment_id_missing",
  );
  if (DENIED_ENVIRONMENT_IDS.has(environmentId)) {
    fail(
      "environment_id_denied",
      "TELLUS_ENVIRONMENT_ID",
      `TELLUS_ENVIRONMENT_ID='${environmentId}' is a deny-listed ` +
        `(dev/production/ambiguous) identity — destructive tests must never ` +
        `run as it.`,
    );
  }
  if (!TEST_ENVIRONMENT_ID_PATTERN.test(environmentId)) {
    fail(
      "environment_id_policy",
      "TELLUS_ENVIRONMENT_ID",
      `TELLUS_ENVIRONMENT_ID='${environmentId}' does not match the test/verify ` +
        `naming policy ${TEST_ENVIRONMENT_ID_PATTERN}.`,
    );
  }

  // 2) Database: explicit name, live truth, seal agreement, not deny-listed.
  const configuredDb = requireEnvField(env, "PGDATABASE", "database_missing");
  if (DENIED_DB_NAMES.has(configuredDb)) {
    fail(
      "database_denied",
      "PGDATABASE",
      `PGDATABASE='${configuredDb}' is a deny-listed (dev/production/system) ` +
        `database — destructive tests must never target it.`,
    );
  }
  const liveDb = await (options.deps?.liveDatabaseName ?? liveDatabaseName)();
  if (liveDb !== configuredDb) {
    fail(
      "database_ambiguous",
      "PGDATABASE",
      `configured PGDATABASE='${configuredDb}' but the live connection lands ` +
        `in '${liveDb}' — configuration and connection disagree; refusing a ` +
        `destructive operation under ambiguous targeting.`,
    );
  }
  const databaseEnvironmentId = await (options.deps?.readDatabaseSeal ?? readDatabaseSeal)();
  if (!databaseEnvironmentId) {
    fail(
      "database_unsealed",
      "databaseEnvironmentId",
      `database '${liveDb}' carries no deployment_environment seal — it has ` +
        `never been claimed. Claim it via the test-stack bootstrap ` +
        `(sealTestDatabaseEnvironment), not by hand.`,
    );
  }
  if (databaseEnvironmentId !== environmentId) {
    fail(
      "database_seal_mismatch",
      "databaseEnvironmentId",
      `database '${liveDb}' is sealed to '${databaseEnvironmentId}' but the ` +
        `test lane claims '${environmentId}'. The seal is first-writer-wins ` +
        `server state — pointing a config at a foreign database cannot pass.`,
    );
  }

  // 3) Temporal namespace + queue: explicit, test-shaped, !== dev/legacy/prod.
  const temporalNamespace = requireEnvField(
    env,
    "TEMPORAL_NAMESPACE",
    "temporal_namespace_missing",
  );
  if (DENIED_TEMPORAL_NAMESPACES.has(temporalNamespace)) {
    fail(
      "temporal_namespace_denied",
      "TEMPORAL_NAMESPACE",
      `TEMPORAL_NAMESPACE='${temporalNamespace}' is the legacy/dev namespace.`,
    );
  }
  if (
    !TEST_NAMESPACE_PATTERN.test(temporalNamespace) &&
    !TEST_FAMILY.test(temporalNamespace)
  ) {
    fail(
      "temporal_namespace_policy",
      "TEMPORAL_NAMESPACE",
      `TEMPORAL_NAMESPACE='${temporalNamespace}' is not test-shaped.`,
    );
  }
  const temporalTaskQueue = requireEnvField(
    env,
    "TEMPORAL_TASK_QUEUE",
    "temporal_task_queue_missing",
  );
  if (DENIED_TEMPORAL_TASK_QUEUES.has(temporalTaskQueue)) {
    fail(
      "temporal_task_queue_denied",
      "TEMPORAL_TASK_QUEUE",
      `TEMPORAL_TASK_QUEUE='${temporalTaskQueue}' is the legacy/dev queue.`,
    );
  }
  if (
    !TEST_TASK_QUEUE_PATTERN.test(temporalTaskQueue) &&
    !TEST_FAMILY.test(temporalTaskQueue)
  ) {
    fail(
      "temporal_task_queue_policy",
      "TEMPORAL_TASK_QUEUE",
      `TEMPORAL_TASK_QUEUE='${temporalTaskQueue}' is not test-shaped.`,
    );
  }

  // 4) Keycloak realm: explicit + test-specific.
  const keycloakRealm = requireEnvField(
    env,
    "KEYCLOAK_REALM",
    "keycloak_realm_missing",
  );
  if (DENIED_KEYCLOAK_REALMS.has(keycloakRealm)) {
    fail(
      "keycloak_realm_denied",
      "KEYCLOAK_REALM",
      `KEYCLOAK_REALM='${keycloakRealm}' is a deny-listed (dev/system) realm.`,
    );
  }
  if (!TEST_REALM_PATTERN.test(keycloakRealm)) {
    fail(
      "keycloak_realm_policy",
      "KEYCLOAK_REALM",
      `KEYCLOAK_REALM='${keycloakRealm}' is not test-shaped ` +
        `(${TEST_REALM_PATTERN}).`,
    );
  }

  // 5) OpenSearch index prefix: explicit + test-specific + !== dev default.
  const prefix = objectIndexPrefix(env);
  if (!env.OS_INDEX_PREFIX?.trim()) {
    fail(
      "index_prefix_missing",
      "OS_INDEX_PREFIX",
      `OS_INDEX_PREFIX is unset — a test environment must NEVER use the ` +
        `shared dev/production default '${DEFAULT_OBJECT_INDEX_PREFIX}'.`,
    );
  }
  if (DENIED_INDEX_PREFIXES.has(prefix)) {
    fail(
      "index_prefix_denied",
      "OS_INDEX_PREFIX",
      `OS_INDEX_PREFIX='${prefix}' is the deny-listed dev/prod default.`,
    );
  }
  if (!TEST_INDEX_PREFIX_PATTERN.test(prefix)) {
    fail(
      "index_prefix_policy",
      "OS_INDEX_PREFIX",
      `OS_INDEX_PREFIX='${prefix}' is not test-shaped ` +
        `(${TEST_INDEX_PREFIX_PATTERN}).`,
    );
  }

  // 6) Object storage bucket/prefix: explicit + not the dev/prod value.
  const bucket = requireEnvField(env, "S3_BUCKET", "bucket_missing");
  if (DENIED_BUCKETS.has(bucket)) {
    fail(
      "bucket_denied",
      "S3_BUCKET",
      `S3_BUCKET='${bucket}' is a deny-listed (dev/production) bucket.`,
    );
  }

  // 7) API base URL: explicit, loopback-only (destructive lanes never run
  //    against remote hosts), environment-advertised.
  const apiBaseUrl = requireEnvField(
    env,
    "TELLUS_TEST_API_BASE_URL",
    "api_base_url_missing",
  );
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    fail(
      "api_base_url_invalid",
      "TELLUS_TEST_API_BASE_URL",
      `TELLUS_TEST_API_BASE_URL='${apiBaseUrl}' is not a valid URL.`,
    );
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed!.hostname)) {
    fail(
      "api_base_url_remote",
      "TELLUS_TEST_API_BASE_URL",
      `TELLUS_TEST_API_BASE_URL host '${parsed!.hostname}' is not loopback — ` +
        `destructive tests may only run against a local isolated stack.`,
    );
  }
  if (!options.skipApiProbe) {
    await (options.deps?.probeApiEnvironment ?? probeApiEnvironment)(
      apiBaseUrl,
      environmentId,
    );
  }

  return {
    environmentId,
    databaseEnvironmentId: databaseEnvironmentId!,
    databaseName: liveDb,
    temporalNamespace,
    temporalTaskQueue,
    keycloakRealm,
    objectIndexPrefix: prefix,
    objectStorageBucketOrPrefix: bucket,
    apiBaseUrl,
    destructiveTestsAllowed: true,
  };
}
