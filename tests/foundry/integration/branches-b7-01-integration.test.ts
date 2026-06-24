import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B7.01 — branches DDL", () => {
  it("branches table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='branches'`,
    );
    expect(rows.map(r => r.column_name)).toContain('project_rid');
    expect(rows.map(r => r.column_name)).toContain('status');
  });
  it("branch_resources table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='branch_resources'`,
    );
    expect(rows.map(r => r.column_name)).toContain('branch_id');
  });
  it("status CHECK constraint enforces enum values", async () => {
    await expect(
      pool.query(`INSERT INTO branches (project_rid, name, status) VALUES ('ri.compass.main.project.b7-01', 'b1', 'BOGUS')`),
    ).rejects.toThrow();
  });
});
