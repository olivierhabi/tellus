import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b8-03-${randomUUID()}`;
const onto = 'ri.ontology.main.ontology.default';
const otRid = `ri.ontology.main.object-type.${tag}`;

beforeAll(async () => {
  await pool.query('SELECT 1');
  await pool.query(
    `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name) VALUES ($1, $2, NULL, $3, 'B803')`,
    [otRid, onto, `${tag}-employee`],
  );
});
afterAll(async () => {
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = $1`, [otRid]);
  await pool.query(`DELETE FROM object_types WHERE rid = $1`, [otRid]);
  await pool.end();
});

describe("B8.03 — object_type_properties DDL", () => {
  it("insert property + read", async () => {
    await pool.query(
      `INSERT INTO object_type_properties (object_type_rid, api_name, display_name, data_type, is_primary_key)
       VALUES ($1, 'employeeId', 'Employee ID', 'STRING', true)`,
      [otRid],
    );
    const { rows } = await pool.query(`SELECT api_name, data_type FROM object_type_properties WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].api_name).toBe('employeeId');
    expect(rows[0].data_type).toBe('STRING');
  });

  it("PK on (object_type_rid, api_name) prevents dup api_name", async () => {
    await expect(
      pool.query(
        `INSERT INTO object_type_properties (object_type_rid, api_name, display_name, data_type) VALUES ($1, 'employeeId', 'X', 'STRING')`,
        [otRid],
      ),
    ).rejects.toThrow();
  });

  it("CASCADE deletes properties when object_type is deleted", async () => {
    const trash = `${otRid}-trash`;
    await pool.query(
      `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name) VALUES ($1, $2, NULL, $3, 'trash')`,
      [trash, onto, `${tag}-trash`],
    );
    await pool.query(
      `INSERT INTO object_type_properties (object_type_rid, api_name, display_name, data_type) VALUES ($1, 'p1', 'P1', 'INTEGER')`,
      [trash],
    );
    await pool.query(`DELETE FROM object_types WHERE rid = $1`, [trash]);
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM object_type_properties WHERE object_type_rid = $1`, [trash]);
    expect(rows[0].c).toBe(0);
  });
});
