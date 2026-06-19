import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B8.01 — ontologies DDL + default seed", () => {
  it("ontologies table exists with required columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='ontologies'`,
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toContain('rid');
    expect(cols).toContain('api_name');
    expect(cols).toContain('space_rid');
  });
  it("default ontology row exists with rid=ri.ontology.main.ontology.default", async () => {
    const { rows } = await pool.query(
      `SELECT api_name, space_rid FROM ontologies WHERE rid = 'ri.ontology.main.ontology.default'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].api_name).toBe('default');
    expect(rows[0].space_rid).toBe('ri.compass.main.space.00000000-0000-0000-0000-000000000000');
  });
  it("api_name UNIQUE constraint blocks duplicates", async () => {
    await expect(
      pool.query(`INSERT INTO ontologies (rid, api_name, display_name, space_rid) VALUES ('ri.ontology.main.ontology.dup', 'default', 'dup', 'ri.compass.main.space.00000000-0000-0000-0000-000000000000')`),
    ).rejects.toThrow();
  });
});
