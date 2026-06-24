import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B7.03 — approval_policies + branch_overlays DDL", () => {
  it("approval_policies table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='approval_policies'`);
    expect(rows.map(r => r.column_name)).toContain('scope_rid');
    expect(rows.map(r => r.column_name)).toContain('required_count');
  });
  it("branch_overlays table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='branch_overlays'`);
    expect(rows.map(r => r.column_name)).toContain('operation');
    expect(rows.map(r => r.column_name)).toContain('payload');
  });
  it("operation CHECK rejects invalid", async () => {
    await expect(
      pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation) VALUES (gen_random_uuid(),'r','NUKE')`),
    ).rejects.toThrow();
  });
});
