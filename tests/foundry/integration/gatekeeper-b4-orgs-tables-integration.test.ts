import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

beforeAll(async () => { await pool.query("SELECT 1"); });
afterAll(async () => { await pool.end(); });

describe("B4.04 — organizations DDL + backfills", () => {
  it("default organization exists", async () => {
    const { rows } = await pool.query(
      `SELECT name FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('default');
  });

  it("every user has a row in user_organizations (no orphans)", async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans FROM users u
       LEFT JOIN user_organizations uo ON u.id = uo.user_id
       WHERE uo.org_id IS NULL`,
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });

  it("every project has a row in project_organizations", async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans FROM projects p
       LEFT JOIN project_organizations po ON ('ri.compass.main.project.' || p.id::text) = po.project_rid
       WHERE po.org_id IS NULL`,
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });
});
