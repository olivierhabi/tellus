/**
 * Tier 1 smoke — DB connectivity + server liveness (docs/ci.md).
 *
 * Proves, in seconds, that the integration lane is wired correctly before any
 * slower suite runs: the lane database is reachable and sealed to the lane
 * environment, and the globalSetup-spawned API server answers /health.
 * Listed in .github/ci/test-selection.json `smoke`.
 */
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 1,
});

afterAll(async () => {
  await pool.end();
});

describe("smoke: database connectivity", () => {
  it("connects to the isolated lane database", async () => {
    const { rows } = await pool.query<{ db: string }>("SELECT current_database() AS db");
    expect(rows[0].db).toBe(process.env.PGDATABASE);
  });

  it("lane database is sealed to the lane environment", async () => {
    const { rows } = await pool.query<{ environment_id: string }>(
      "SELECT environment_id FROM deployment_environment LIMIT 1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].environment_id).toBe(process.env.TELLUS_ENVIRONMENT_ID);
  });
});

describe("smoke: API server liveness", () => {
  it("GET /health returns 200", async () => {
    const baseUrl = process.env.TELLUS_TEST_API_BASE_URL ?? "http://localhost:3302";
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});
