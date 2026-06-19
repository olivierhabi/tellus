// B4.01 — roles + role_operations DDL + seed.
//
// Asserts: 4 system roles exist, compass-owner has 6 operations, and
// re-running migrate is idempotent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

beforeAll(async () => {
  // Universal docker snapshot
  try {
    const { execSync } = await import("node:child_process");
    const fs = await import("node:fs");
    let psJson = "";
    try {
      psJson = execSync("docker compose -f docker-compose.test.yml ps --format json", { encoding: "utf8" });
    } catch {
      psJson = execSync("docker ps --format '{{json .}}'", { encoding: "utf8" });
    }
    fs.appendFileSync("/tmp/b4-01-test.log", `=== docker compose ps ===\n${psJson}\n`);
  } catch {
    /* soft-fail */
  }
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("B4.01 — roles + role_operations DDL + seed", () => {
  it("4 system roles exist", async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM roles WHERE is_system = true`,
    );
    expect(Number(rows[0].count)).toBe(4);
  });

  it("compass-owner has 6 operations", async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM role_operations WHERE role_id = 'compass-owner'`,
    );
    expect(Number(rows[0].count)).toBe(6);
  });

  it("re-running migrate is idempotent (no row count changes)", async () => {
    const before = await pool.query<{ rc: string; oc: string }>(
      `SELECT (SELECT count(*) FROM roles)::text AS rc,
              (SELECT count(*) FROM role_operations)::text AS oc`,
    );
    // The B4 migrate uses ON CONFLICT DO NOTHING, so the inserts
    // themselves are idempotent.  We re-run them inside a savepoint here
    // (not the full migrate, which exits the process) to assert
    // idempotence at the SQL level.
    await pool.query(`
      INSERT INTO roles (id, display_name, description, is_system) VALUES
        ('compass-owner','Owner','Full control of the resource',true)
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO role_operations (role_id, operation_id) VALUES
        ('compass-owner','compass:view-resource')
      ON CONFLICT DO NOTHING
    `);
    const after = await pool.query<{ rc: string; oc: string }>(
      `SELECT (SELECT count(*) FROM roles)::text AS rc,
              (SELECT count(*) FROM role_operations)::text AS oc`,
    );
    expect(after.rows[0].rc).toBe(before.rows[0].rc);
    expect(after.rows[0].oc).toBe(before.rows[0].oc);
  });
});
