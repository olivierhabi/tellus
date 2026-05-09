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
const tag = `b809_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const createdRids: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [createdRids]);
  await pool.end();
});

describe("B8.09 — omsService.updateObjectType", () => {
  it("happy path: update display_name bumps etag", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_a`, displayName: 'Old',
      primaryKeys: ['id'], properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    const u = await svc.updateObjectType(r.rid, r.etag, { displayName: 'New' });
    expect(u.displayName).toBe('New');
    expect(u.etag).toBe(r.etag + 1);
  });

  it("PRECONDITION_FAILED on stale etag", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_b`, displayName: 'X',
      primaryKeys: ['id'], properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    await expect(svc.updateObjectType(r.rid, 999, { displayName: 'Y' })).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it("NOT_FOUND on non-existent rid", async () => {
    await expect(svc.updateObjectType('ri.ontology.main.object-type.ghost', 1, { displayName: 'X' })).rejects.toThrow(/NOT_FOUND/);
  });

  it("IMMUTABLE_API_NAME after status=ACTIVE", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_c`, displayName: 'X',
      primaryKeys: ['id'], properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    const promoted = await svc.updateObjectType(r.rid, r.etag, { status: 'ACTIVE' });
    await expect(svc.updateObjectType(r.rid, promoted.etag, { apiName: `${tag}_c2` })).rejects.toThrow(/IMMUTABLE_API_NAME/);
  });

  it("INVALID_API_NAME on bad regex when EXPERIMENTAL", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_d`, displayName: 'X',
      primaryKeys: ['id'], properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    await expect(svc.updateObjectType(r.rid, r.etag, { apiName: 'BAD-Name' })).rejects.toThrow(/INVALID_API_NAME/);
  });

  it("apiName change is allowed when EXPERIMENTAL", async () => {
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_e`, displayName: 'X',
      primaryKeys: ['id'], properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    createdRids.push(r.rid);
    const u = await svc.updateObjectType(r.rid, r.etag, { apiName: `${tag}_e2` });
    expect(u.apiName).toBe(`${tag}_e2`);
  });
});
