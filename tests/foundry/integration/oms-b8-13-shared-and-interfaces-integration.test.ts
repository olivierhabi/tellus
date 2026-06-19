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
const tag = `b813_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const sptRids: string[] = [];
const ifaceRids: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM shared_property_types WHERE rid = ANY($1::text[])`, [sptRids]);
  await pool.query(`DELETE FROM interfaces WHERE rid = ANY($1::text[])`, [ifaceRids]);
  await pool.end();
});

describe("B8.13 — shared property types + interfaces", () => {
  it("createSharedPropertyType happy path", async () => {
    const r = await svc.createSharedPropertyType({ ontologyRid: onto, apiName: `${tag}_t`, displayName: 'Title', dataType: 'STRING' });
    sptRids.push(r.rid);
    expect(r.dataType).toBe('STRING');
  });

  it("INVALID_API_NAME for SPT bad regex", async () => {
    await expect(svc.createSharedPropertyType({ ontologyRid: onto, apiName: 'BAD-N', displayName: 'X', dataType: 'STRING' })).rejects.toThrow(/INVALID_API_NAME/);
  });

  it("getSharedPropertyType returns row", async () => {
    const r = await svc.getSharedPropertyType(onto, `${tag}_t`);
    expect(r?.dataType).toBe('STRING');
  });

  it("listSharedPropertyTypes contains the row", async () => {
    const list = await svc.listSharedPropertyTypes(onto);
    const names = list.map((r) => r.apiName).filter((n) => n.startsWith(`${tag}_`));
    expect(names).toContain(`${tag}_t`);
  });

  it("createInterface happy path", async () => {
    const r = await svc.createInterface({ ontologyRid: onto, apiName: `${tag}_i`, displayName: 'Named', properties: [`${tag}_t`] });
    ifaceRids.push(r.rid);
    expect(r.properties).toEqual([`${tag}_t`]);
  });

  it("getInterface returns row", async () => {
    const r = await svc.getInterface(onto, `${tag}_i`);
    expect(r?.apiName).toBe(`${tag}_i`);
  });

  it("listInterfaces contains the row", async () => {
    const list = await svc.listInterfaces(onto);
    const names = list.map((r) => r.apiName).filter((n) => n.startsWith(`${tag}_`));
    expect(names).toContain(`${tag}_i`);
  });
});
