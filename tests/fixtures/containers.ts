// ---------------------------------------------------------------------------
// Shared Testcontainers helpers for the connectivity test suite.
//
// startPostgres16(): spin up postgres:16 with logical replication enabled,
// apply tests/fixtures/connectivity-bootstrap.sql to provision the minimal
// schema, run B1's migrations (074, 075), seed a root space + test user
// + a folder, and return the connection details.
//
// stopPostgres16(): cleanup; safe to call after a failed start.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  connectionString: string;
  testUserId: string;
  testSpaceRid: string;
  testFolderRid: string;
  cleanup: () => Promise<void>;
}

const REPO_ROOT = resolve(__dirname, "..", "..");
const BOOTSTRAP_SQL_PATH = resolve(
  REPO_ROOT,
  "tests/fixtures/connectivity-bootstrap.sql",
);
const B1_MIGRATIONS = [
  "src/migrations/074_b1_connectivity_connections.sql",
  "src/migrations/075_b1_connectivity_outbox.sql",
];

function readSql(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

/**
 * Spin up a fresh postgres:16 container for the connectivity tests.
 * Enables `wal_level=logical` so the same fixture serves B7's CDC tests.
 *
 * Returns a Pool wired to the container plus the seeded test identities.
 */
export async function startPostgres16(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer("postgres:16")
    .withDatabase("tellus_test")
    .withUsername("tellus")
    .withPassword("tellus")
    .withCommand([
      "postgres",
      "-c",
      "wal_level=logical",
      "-c",
      "max_replication_slots=10",
      "-c",
      "max_wal_senders=10",
    ])
    .start();

  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString, max: 4 });

  // 1. Apply bootstrap (users + resources + idempotency_keys).
  await pool.query(readSql("tests/fixtures/connectivity-bootstrap.sql"));

  // 2. Apply B1 migrations (074 connections + 075 outbox).
  for (const mig of B1_MIGRATIONS) {
    await pool.query(readSql(mig));
  }

  // 3. Seed test identities.
  const testUserId = randomUUID();
  const testSpaceRid = `ri.compass.main.space.${randomUUID()}`;
  const testFolderRid = `ri.compass.main.folder.${randomUUID()}`;

  await pool.query(
    `INSERT INTO users (id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [testUserId, `test-${testUserId}@tellus.local`, "Test User"],
  );

  // Root space (self-referential space_rid).
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name,
                            space_rid, created_by, updated_by)
     VALUES ($1, 'compass', 'space', 'Test Space', $1, $2, $2)
     ON CONFLICT (rid) DO NOTHING`,
    [testSpaceRid, testUserId],
  );

  // A folder under the space; will be the parent of test connections.
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name,
                            parent_folder_rid, space_rid, created_by, updated_by)
     VALUES ($1, 'compass', 'folder', 'Test Folder', NULL, $2, $3, $3)
     ON CONFLICT (rid) DO NOTHING`,
    [testFolderRid, testSpaceRid, testUserId],
  );

  return {
    container,
    pool,
    connectionString,
    testUserId,
    testSpaceRid,
    testFolderRid,
    async cleanup() {
      await pool.end().catch(() => undefined);
      await container.stop().catch(() => undefined);
    },
  };
}

/** Truncate all connectivity-owned rows between tests. Leaves bootstrap intact. */
export async function resetConnectivityTables(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE
    connectivity_connection_status_log,
    connectivity_outbox,
    connectivity_connections,
    idempotency_keys
    RESTART IDENTITY CASCADE`);
  // Tombstone any connection-shaped Compass rows from a previous test.
  await pool.query(
    `DELETE FROM resources WHERE service = 'magritte' AND type = 'source'`,
  );
}

/**
 * Set the connectivity service's DB pool to point at the Testcontainers PG.
 * Production code reads from src/db.ts which reads DATABASE_URL at module load.
 * Tests should call this BEFORE importing any handler so the pool is bound.
 */
export function setEnvForTest(fixture: PgFixture): void {
  process.env.DATABASE_URL = fixture.connectionString;
  // Disable the outbox poller in test-host; tests drive it explicitly via
  // outbox.drainForTest() to avoid background race with assertions.
  process.env.TELLUS_DISABLE_CONNECTIVITY_POLLER = "1";
}
