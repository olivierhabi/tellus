import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `b8-06-${randomUUID()}`;
const onto = 'ri.ontology.main.ontology.default';

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM shared_property_types WHERE rid LIKE $1`, [`%${tag}%`]);
  await pool.query(`DELETE FROM interfaces WHERE rid LIKE $1`, [`%${tag}%`]);
  await pool.end();
});

describe("B8.06 — shared_property_types + interfaces DDL", () => {
  it("shared_property_types row insert", async () => {
    await pool.query(
      `INSERT INTO shared_property_types (rid, ontology_rid, api_name, display_name, data_type) VALUES ($1, $2, $3, 'Title', 'STRING')`,
      [`ri.ontology.main.spt.${tag}`, onto, `${tag}-title`],
    );
    const { rows } = await pool.query(`SELECT data_type FROM shared_property_types WHERE rid = $1`, [`ri.ontology.main.spt.${tag}`]);
    expect(rows[0].data_type).toBe('STRING');
  });

  it("shared_property_types UNIQUE blocks dup api_name in same ontology", async () => {
    await expect(
      pool.query(`INSERT INTO shared_property_types (rid, ontology_rid, api_name, display_name, data_type) VALUES ($1, $2, $3, 'dup', 'STRING')`,
        [`ri.ontology.main.spt.${tag}-dup`, onto, `${tag}-title`]),
    ).rejects.toThrow();
  });

  it("interfaces insert + read", async () => {
    await pool.query(
      `INSERT INTO interfaces (rid, ontology_rid, api_name, display_name, properties) VALUES ($1, $2, $3, 'Named', ARRAY['title','name'])`,
      [`ri.ontology.main.iface.${tag}`, onto, `${tag}-named`],
    );
    const { rows } = await pool.query(`SELECT properties FROM interfaces WHERE rid = $1`, [`ri.ontology.main.iface.${tag}`]);
    expect(rows[0].properties).toEqual(['title','name']);
  });
});
