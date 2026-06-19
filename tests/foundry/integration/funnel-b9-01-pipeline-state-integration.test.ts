import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b9-01-${randomUUID()}`;
const otRid = `ri.ontology.main.object-type.${tag}`;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
  await pool.end();
});

describe("B9.01 — funnel_b9_state DDL", () => {
  it("table has expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='funnel_b9_state'`,
    );
    const cols = rows.map(r => r.column_name).sort();
    expect(cols).toContain('object_type_rid');
    expect(cols).toContain('phase');
    expect(cols).toContain('last_offset');
  });

  it("inserts a row + reads back", async () => {
    await pool.query(
      `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, branch_rid, phase) VALUES ($1, $2, NULL, 'IDLE')`,
      [otRid, 'ri.ontology.main.ontology.default'],
    );
    const { rows } = await pool.query(`SELECT phase FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].phase).toBe('IDLE');
  });

  it("UNIQUE(object_type_rid, COALESCE(branch_rid,...)) blocks dup", async () => {
    await expect(
      pool.query(
        `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, branch_rid, phase) VALUES ($1, $2, NULL, 'CHANGELOG')`,
        [otRid, 'ri.ontology.main.ontology.default'],
      ),
    ).rejects.toThrow();
  });

  it("phase CHECK rejects bogus", async () => {
    await expect(
      pool.query(
        `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, phase) VALUES ($1, 'ri.ontology.main.ontology.default', 'BOGUS')`,
        [`${otRid}-bogus`],
      ),
    ).rejects.toThrow();
  });
});
