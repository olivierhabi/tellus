import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B6.01 — resource_dependencies DDL", () => {
  it("table exists with expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='resource_dependencies'`,
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(['created_at','created_by','downstream_rid','edge_type','metadata','upstream_rid']);
  });
  it("PK is composite on (upstream, downstream, edge_type)", async () => {
    const { rows } = await pool.query<{ pkdef: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS pkdef FROM pg_constraint c
       WHERE conrelid='public.resource_dependencies'::regclass AND contype='p'`,
    );
    expect(rows[0].pkdef).toContain('upstream_rid');
    expect(rows[0].pkdef).toContain('downstream_rid');
    expect(rows[0].pkdef).toContain('edge_type');
  });
  it("CHECK rejects self-loop edges", async () => {
    await expect(
      pool.query(`INSERT INTO resource_dependencies (upstream_rid, downstream_rid) VALUES ('x','x')`),
    ).rejects.toThrow();
  });
});
