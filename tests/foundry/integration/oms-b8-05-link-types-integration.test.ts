import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b8-05-${randomUUID()}`;
const onto = 'ri.ontology.main.ontology.default';
const lt = `ri.ontology.main.link-type.${tag}`;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM link_types WHERE rid LIKE $1`, [`${lt}%`]);
  await pool.end();
});

describe("B8.05 — link_types DDL", () => {
  it("FK ONE_TO_MANY insert", async () => {
    await pool.query(
      `INSERT INTO link_types (rid, ontology_rid, branch_rid, api_name, display_name, backing_type, cardinality, a_object_type_rid, b_object_type_rid)
       VALUES ($1, $2, NULL, $3, 'A->B', 'FOREIGN_KEY', 'ONE_TO_MANY', 'ri.ontology.main.object-type.a', 'ri.ontology.main.object-type.b')`,
      [`${lt}-fk`, onto, `${tag}-fk`],
    );
    const { rows } = await pool.query(`SELECT cardinality, backing_type FROM link_types WHERE rid = $1`, [`${lt}-fk`]);
    expect(rows[0].cardinality).toBe('ONE_TO_MANY');
    expect(rows[0].backing_type).toBe('FOREIGN_KEY');
  });

  it("backing_type CHECK rejects bogus", async () => {
    await expect(
      pool.query(
        `INSERT INTO link_types (rid, ontology_rid, branch_rid, api_name, display_name, backing_type, cardinality, a_object_type_rid, b_object_type_rid)
         VALUES ($1, $2, NULL, $3, 'X', 'BOGUS', 'ONE_TO_ONE', 'ri.x', 'ri.y')`,
        [`${lt}-bad`, onto, `${tag}-bad`],
      ),
    ).rejects.toThrow();
  });

  it("cardinality CHECK rejects bogus", async () => {
    await expect(
      pool.query(
        `INSERT INTO link_types (rid, ontology_rid, branch_rid, api_name, display_name, backing_type, cardinality, a_object_type_rid, b_object_type_rid)
         VALUES ($1, $2, NULL, $3, 'X', 'JOIN_TABLE', 'OOPS', 'ri.x', 'ri.y')`,
        [`${lt}-bad2`, onto, `${tag}-bad2`],
      ),
    ).rejects.toThrow();
  });

  it("UNIQUE(ontology, branch, api_name) blocks duplicates", async () => {
    await expect(
      pool.query(
        `INSERT INTO link_types (rid, ontology_rid, branch_rid, api_name, display_name, backing_type, cardinality, a_object_type_rid, b_object_type_rid)
         VALUES ($1, $2, NULL, $3, 'dup', 'JOIN_TABLE', 'MANY_TO_MANY', 'ri.x', 'ri.y')`,
        [`${lt}-dup`, onto, `${tag}-fk`],
      ),
    ).rejects.toThrow();
  });
});
