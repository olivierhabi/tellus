import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { OmsService } from "../../../src/services/omsService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new OmsService(pool);
const tag = `b810_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const dsRid = `ri.foundry.main.dataset.${tag}`;
const createdRids: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = ANY($1::text[]) OR downstream_rid = ANY($1::text[])`, [[...createdRids, dsRid]]);
  await pool.query(`DELETE FROM object_type_datasources WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [createdRids]);
  await pool.end();
});

describe("B8.10 — BACKS edge registration", () => {
  it("createObjectType with datasource registers BACKS edge", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_a`, displayName: 'X',
      primaryKeys: ['id'],
      properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
      datasources: [{ datasourceRid: dsRid, primaryKeyColumns: ['id_col'] }],
    });
    createdRids.push(r.rid);
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM resource_dependencies WHERE upstream_rid = $1 AND downstream_rid = $2 AND edge_type = 'BACKS'`, [r.rid, dsRid]);
    expect(rows[0].c).toBe(1);
  });
  it("createObjectType with datasource registers INPUT_OF edge", async () => {
    const rid = createdRids[0];
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM resource_dependencies WHERE upstream_rid = $1 AND downstream_rid = $2 AND edge_type = 'INPUT_OF'`, [dsRid, rid]);
    expect(rows[0].c).toBe(1);
  });
  it("createObjectType without datasources registers no edges", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_b`, displayName: 'X',
      primaryKeys: ['id'],
      properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM resource_dependencies WHERE upstream_rid = $1 OR downstream_rid = $1`, [r.rid]);
    expect(rows[0].c).toBe(0);
  });
});
