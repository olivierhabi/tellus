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
const tag = `b811_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const createdRids: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [createdRids]);
  await pool.end();
});

describe("B8.11 — Kafka emit on updateObjectType", () => {
  it("emits tellus.oms.object-type.updated on update", async () => {
    const spy = vi.spyOn(kafkaModule, 'publishEvent').mockResolvedValue(undefined);
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_a`, displayName: 'X',
      primaryKeys: ['id'],
      properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    await svc.updateObjectType(r.rid, r.etag, { displayName: 'Y' });
    expect(spy).toHaveBeenCalled();
    const calls = spy.mock.calls;
    const updateCall = calls.find((c) => (c[1] as any).objectType === 'tellus.oms.object-type.updated');
    expect(updateCall).toBeTruthy();
    expect((updateCall![1] as any).objectTypeRid).toBe(r.rid);
    expect((updateCall![1] as any).etag).toBe(r.etag + 1);
    spy.mockRestore();
  });
});
