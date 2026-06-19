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
const tag = `b812_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const otRids: string[] = [];
const ltRids: string[] = [];

beforeAll(async () => {
  await pool.query('SELECT 1');
  const a = await svc.createObjectType({
    ontologyRid: onto, apiName: `${tag}_a`, displayName: 'A',
    primaryKeys: ['id'],
    properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
  });
  const b = await svc.createObjectType({
    ontologyRid: onto, apiName: `${tag}_b`, displayName: 'B',
    primaryKeys: ['id'],
    properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
  });
  otRids.push(a.rid, b.rid);
});

afterAll(async () => {
  await pool.query(`DELETE FROM link_types WHERE rid = ANY($1::text[])`, [ltRids]);
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = ANY($1::text[]) OR downstream_rid = ANY($1::text[])`, [otRids]);
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [otRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [otRids]);
  await pool.end();
});

describe("B8.12 — omsService link types", () => {
  it("createLinkType happy path", async () => {
    const lt = await svc.createLinkType({
      ontologyRid: onto, apiName: `${tag}_lt`, displayName: 'A->B',
      backingType: 'FOREIGN_KEY', cardinality: 'ONE_TO_MANY',
      aObjectTypeRid: otRids[0], bObjectTypeRid: otRids[1],
    });
    ltRids.push(lt.rid);
    expect(lt.cardinality).toBe('ONE_TO_MANY');
    expect(lt.backingType).toBe('FOREIGN_KEY');
  });

  it("INVALID_API_NAME rejects bad regex", async () => {
    await expect(svc.createLinkType({
      ontologyRid: onto, apiName: 'BAD-NAME', displayName: 'X',
      backingType: 'FOREIGN_KEY', cardinality: 'ONE_TO_ONE',
      aObjectTypeRid: otRids[0], bObjectTypeRid: otRids[1],
    })).rejects.toThrow(/INVALID_API_NAME/);
  });

  it("INVALID_BACKING_TYPE rejects bogus enum", async () => {
    await expect(svc.createLinkType({
      ontologyRid: onto, apiName: `${tag}_bad`, displayName: 'X',
      backingType: 'BOGUS' as any, cardinality: 'ONE_TO_ONE',
      aObjectTypeRid: otRids[0], bObjectTypeRid: otRids[1],
    })).rejects.toThrow(/INVALID_BACKING_TYPE/);
  });

  it("OBJECT_TYPE_NOT_FOUND when endpoints don't exist", async () => {
    await expect(svc.createLinkType({
      ontologyRid: onto, apiName: `${tag}_ghost`, displayName: 'X',
      backingType: 'FOREIGN_KEY', cardinality: 'ONE_TO_ONE',
      aObjectTypeRid: 'ri.ontology.main.object-type.ghost-a',
      bObjectTypeRid: 'ri.ontology.main.object-type.ghost-b',
    })).rejects.toThrow(/OBJECT_TYPE_NOT_FOUND/);
  });

  it("getLinkType returns the row", async () => {
    const r = await svc.getLinkType(onto, `${tag}_lt`);
    expect(r?.apiName).toBe(`${tag}_lt`);
  });

  it("listLinkTypes lists main rows", async () => {
    const list = await svc.listLinkTypes(onto);
    const apis = list.map((r) => r.apiName).filter((n) => n.startsWith(`${tag}_`));
    expect(apis).toContain(`${tag}_lt`);
  });
});
