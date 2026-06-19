import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b8-02-${randomUUID()}`;
const onto = 'ri.ontology.main.ontology.default';
const ridA = `ri.ontology.main.object-type.${tag}-A`;
const ridB = `ri.ontology.main.object-type.${tag}-B`;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM object_types WHERE rid IN ($1,$2)`, [ridA, ridB]);
  await pool.end();
});

describe("B8.02 — object_types DDL + UNIQUE", () => {
  it("inserts a row successfully", async () => {
    await pool.query(
      `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name) VALUES ($1, $2, NULL, $3, 'A')`,
      [ridA, onto, `${tag}-employee`],
    );
    const { rows } = await pool.query(`SELECT api_name FROM object_types WHERE rid = $1`, [ridA]);
    expect(rows[0].api_name).toBe(`${tag}-employee`);
  });

  it("UNIQUE(ontology, branch, api_name) prevents duplicate", async () => {
    await expect(
      pool.query(
        `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name) VALUES ($1, $2, NULL, $3, 'B')`,
        [ridB, onto, `${tag}-employee`],
      ),
    ).rejects.toThrow();
  });

  it("status CHECK rejects invalid value", async () => {
    await expect(
      pool.query(
        `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name, status) VALUES ($1, $2, NULL, $3, 'X', 'BOGUS')`,
        [`${ridA}-bad`, onto, `${tag}-bad`],
      ),
    ).rejects.toThrow();
  });
});
