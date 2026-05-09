import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { OmsService } from "../../../src/services/omsService";
import * as kafkaModule from "../../../src/services/kafkaProducer";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new OmsService(pool);
const tag = `final05_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const dsRid = `ri.foundry.main.dataset.${tag}`;
let createdRid: string;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = $1 OR downstream_rid = $1`, [createdRid]);
  await pool.query(`DELETE FROM object_type_datasources WHERE object_type_rid = $1`, [createdRid]);
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = $1`, [createdRid]);
  await pool.query(`DELETE FROM object_types WHERE rid = $1`, [createdRid]);
  await pool.end();
});

describe("FINAL.05 — OMS lifecycle", () => {
  it("create object_type with datasource", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_emp`, displayName: 'Employee',
      primaryKeys: ['id'],
      properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
      datasources: [{ datasourceRid: dsRid, primaryKeyColumns: ['id_col'] }],
    });
    createdRid = r.rid;
    expect(r.status).toBe('EXPERIMENTAL');
  });
  it("BACKS edge created", async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM resource_dependencies WHERE upstream_rid = $1 AND downstream_rid = $2 AND edge_type = 'BACKS'`, [createdRid, dsRid]);
    expect(rows[0].c).toBe(1);
  });
  it("update emits Kafka event + bumps etag", async () => {
    const spy = vi.spyOn(kafkaModule, 'publishEvent').mockResolvedValue(undefined);
    const before = (await svc.getObjectType(onto, `${tag}_emp`))!;
    const after = await svc.updateObjectType(createdRid, before.etag, { displayName: 'Worker' });
    expect(after.etag).toBe(before.etag + 1);
    expect(after.displayName).toBe('Worker');
    expect(spy.mock.calls.find((c) => (c[1] as any).objectType === 'tellus.oms.object-type.updated')).toBeTruthy();
    spy.mockRestore();
  });
  it("list returns the row", async () => {
    const rows = await svc.listObjectTypes(onto);
    const apiNames = rows.map((r) => r.apiName);
    expect(apiNames).toContain(`${tag}_emp`);
  });
});
