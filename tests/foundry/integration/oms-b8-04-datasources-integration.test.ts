import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b8-04-${randomUUID()}`;
const onto = 'ri.ontology.main.ontology.default';
const otRid = `ri.ontology.main.object-type.${tag}`;
const dsA = `ri.foundry.main.dataset.${tag}-a`;
const dsB = `ri.foundry.main.dataset.${tag}-b`;

beforeAll(async () => {
  await pool.query('SELECT 1');
  await pool.query(
    `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name) VALUES ($1, $2, NULL, $3, 'B804')`,
    [otRid, onto, `${tag}-it`],
  );
});
afterAll(async () => {
  await pool.query(`DELETE FROM object_type_datasources WHERE object_type_rid = $1`, [otRid]);
  await pool.query(`DELETE FROM object_types WHERE rid = $1`, [otRid]);
  await pool.end();
});

describe("B8.04 — object_type_datasources DDL", () => {
  it("attach datasource A as primary", async () => {
    await pool.query(
      `INSERT INTO object_type_datasources (object_type_rid, datasource_rid, primary_key_columns, is_primary)
       VALUES ($1, $2, ARRAY['id'], true)`,
      [otRid, dsA],
    );
    const { rows } = await pool.query(`SELECT is_primary, primary_key_columns FROM object_type_datasources WHERE object_type_rid = $1 AND datasource_rid = $2`, [otRid, dsA]);
    expect(rows[0].is_primary).toBe(true);
    expect(rows[0].primary_key_columns).toEqual(['id']);
  });

  it("attach datasource B as secondary", async () => {
    await pool.query(
      `INSERT INTO object_type_datasources (object_type_rid, datasource_rid) VALUES ($1, $2)`,
      [otRid, dsB],
    );
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM object_type_datasources WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].c).toBe(2);
  });

  it("PK prevents duplicate (object_type_rid, datasource_rid)", async () => {
    await expect(
      pool.query(`INSERT INTO object_type_datasources (object_type_rid, datasource_rid) VALUES ($1, $2)`, [otRid, dsA]),
    ).rejects.toThrow();
  });
});
