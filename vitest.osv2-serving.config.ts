// ---------------------------------------------------------------------------
// Isolated lane for the OSv2 serving-index stage work (worktree:
// tellus-osv2-serving, branch feat/osv2-serving-index-stages).
//
// Isolation contract (never touch the shared lanes):
//   * PostgreSQL database  : osv2_serving (NOT tellus_tests / tellus_db)
//   * ClickHouse database  : osv2_serving
//   * Kafka topic prefix   : osv2.cdc (auto-created by producers where
//                            allowed; CH-side topics pre-created by
//                            ensureLinkCdcTopic with the prefixed name)
//   * no HTTP server boots — these lanes talk to PG/Kafka/CH directly.
// ---------------------------------------------------------------------------

import { defineConfig } from "vitest/config";
import { requiredTestSecret } from "./tests/testEnvFile";

// Test credentials are never baked into the repo. Secrets resolve env-first
// (CI secret or a local export) with a fallback to .env.test /
// .env.test.example (see tests/testEnvFile.ts), and fail fast when no
// source has a value — instead of falling back to an inline literal.
function requiredEnv(name: string): string {
  return requiredTestSecret(name);
}

export default defineConfig({
  test: {
    include: ["tests/osv2-serving/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 300_000,
    hookTimeout: 120_000,
    env: {
      PGHOST: "localhost",
      PGPORT: "5432",
      PGUSER: "tellus",
      PGPASSWORD: requiredEnv("PGPASSWORD"),
      PGDATABASE: "osv2_serving",
      KAFKA_BROKERS: "localhost:9092",
      // Isolated topic namespace: producers publish to osv2.cdc.<src>.<link>.
      TELLUS_CDC_TOPIC_PREFIX: "osv2.cdc",
      CLICKHOUSE_URL: "http://localhost:8123",
      CLICKHOUSE_USER: "tellus",
      CLICKHOUSE_PASSWORD: requiredEnv("CLICKHOUSE_PASSWORD"),
      CLICKHOUSE_DATABASE: "osv2_serving",
      // The Kafka-engine DDL emitted by the lane must use the INTERNAL
      // broker alias — the engine connects from inside the CH container.
      CLICKHOUSE_KAFKA_BROKERS: "kafka:29092",
      OPENSEARCH_URL: "https://localhost:9200",
      // Security plugin enabled on the shared dev cluster (https + Basic
      // auth, demo certs). The demo password is the committed compose
      // default — a deployment override wins via process.env.
      OPENSEARCH_USERNAME: "admin",
      OPENSEARCH_PASSWORD:
        process.env.OPENSEARCH_PASSWORD ?? "Str0ng!P@ssw0rd-Tellus-9a7b3Cz",
      OS_INDEX_PREFIX: "osv2srv-ontology-",
      OPENSEARCH_REQUEST_TIMEOUT: "10000",
      REDIS_URL: "redis://localhost:6379/15",
    },
  },
});
