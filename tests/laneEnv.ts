// ---------------------------------------------------------------------------
// Integration-lane environment — FUNN-ISO-1.
//
// The default vitest lane (tests/globalSetup.ts + vitest.config.ts) MUST be
// structurally incapable of touching the shared dev environment. Prior
// incident: `npx vitest run` reset the dev ontology (tellus_db) through
// src/seed.ts because nothing forced the lane onto isolated plumbing.
//
// This module is the single source of truth for the lane's identity. It is
// imported with SIDE EFFECTS (import order matters — it MUST be the first
// import of globalSetup) so even the pg pool module sees lane values:
//
//   import "./laneEnv";   // first!
//
// Workers (spawned by vitest in fresh processes) receive the SAME values
// from vitest.config.ts, which imports LANE from here — one definition,
// two injection points, zero drift.
// ---------------------------------------------------------------------------

import { requiredTestSecret } from "./testEnvFile";

export interface LaneEnv {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
  TELLUS_ENVIRONMENT_ID: string;
  TEMPORAL_NAMESPACE: string;
  TEMPORAL_TASK_QUEUE: string;
  KEYCLOAK_REALM: string;
  S3_BUCKET: string;
  OS_INDEX_PREFIX: string;
  TELLUS_DESTRUCTIVE_TESTS_ALLOWED: string;
  TELLUS_TEST_API_BASE_URL: string;
  TEST_BASE_URL: string;
  TELLUS_TEST_BASE_URL: string;
  PORT: string;
  DATA_DIR: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_PASSWORD: string;
}

export const LANE: LaneEnv = {
  PGHOST: "localhost",
  PGPORT: "5432",
  PGUSER: "tellus",
  // No baked-in literals: env first (CI provisions lane containers with
  // secret passwords that must win), then .env.test / .env.test.example
  // (local-dev defaults matching docker-compose-test.yml). Fail fast when
  // neither source has a value.
  PGPASSWORD: requiredTestSecret("PGPASSWORD"),
  PGDATABASE: "tellus_tests",
  TELLUS_ENVIRONMENT_ID: "tellus-tests-main",
  TEMPORAL_NAMESPACE: "tellus-funnel-tellus-tests-main",
  TEMPORAL_TASK_QUEUE: "tellus-funnel-queue-tellus-tests-main",
  KEYCLOAK_REALM: "tellus-tests",
  S3_BUCKET: "tellus-tests-bucket",
  OS_INDEX_PREFIX: "ttest-ontology-",
  TELLUS_DESTRUCTIVE_TESTS_ALLOWED: "1",
  TELLUS_TEST_API_BASE_URL: "http://localhost:3302",
  TEST_BASE_URL: "http://localhost:3302",
  TELLUS_TEST_BASE_URL: "http://localhost:3302",
  PORT: "3302",
  DATA_DIR: "/tmp/ontology-testdata",
  // The lane ClickHouse container authenticates as tellus (compose users.d);
  // anonymous is denied → the lane must pin these or no CH test can pass.
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "tellus",
  CLICKHOUSE_PASSWORD: requiredTestSecret("CLICKHOUSE_PASSWORD"),
};

/**
 * Hard-pins the lane identity into `target` (default: process.env). Lane
 * runs must NOT inherit any of these from the developer's shell/.env — the
 * whole point is that pointing the lane at dev is impossible through a
 * partially-overridden config.
 */
export function applyLaneEnv(target: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(LANE)) {
    target[key] = value;
  }
}

// Side effect on import: pin THIS process immediately.
applyLaneEnv();
