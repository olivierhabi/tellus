import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B6.02 — project_references DDL", () => {
  it("table exists", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='project_references'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
  it("PK is composite", async () => {
    const { rows } = await pool.query<{ pkdef: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS pkdef FROM pg_constraint c WHERE conrelid='public.project_references'::regclass AND contype='p'`,
    );
    expect(rows[0].pkdef).toMatch(/owner_project_rid.*referenced_resource_rid.*reference_type/s);
  });
  it("can insert a reference", async () => {
    const a = `ri.compass.main.project.b6-02-${Date.now()}-a`;
    const b = `ri.compass.main.dataset.b6-02-${Date.now()}-b`;
    await pool.query(`INSERT INTO project_references (owner_project_rid, referenced_resource_rid) VALUES ($1, $2)`, [a, b]);
    const r = await pool.query(`SELECT count(*)::int AS c FROM project_references WHERE owner_project_rid = $1`, [a]);
    expect(r.rows[0].c).toBe(1);
    await pool.query(`DELETE FROM project_references WHERE owner_project_rid = $1`, [a]);
  });
});
