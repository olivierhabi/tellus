import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B7.02 — proposals DDL", () => {
  it("proposals table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='proposals'`);
    expect(rows.map(r => r.column_name)).toContain('branch_id');
    expect(rows.map(r => r.column_name)).toContain('status');
  });
  it("proposal_approvals table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='proposal_approvals'`);
    expect(rows.map(r => r.column_name)).toContain('proposal_id');
    expect(rows.map(r => r.column_name)).toContain('decision');
  });
  it("decision CHECK rejects invalid values", async () => {
    await expect(
      pool.query(`INSERT INTO proposal_approvals (proposal_id, approver_id, decision) VALUES (gen_random_uuid(), gen_random_uuid(), 'BOGUS')`),
    ).rejects.toThrow();
  });
});
