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
const tag = `b808_${randomUUID().replace(/-/g, '_')}`;
const onto = 'ri.ontology.main.ontology.default';
const branchRid = `ri.compass.main.branch.${tag}`;
const createdRids: string[] = [];

beforeAll(async () => {
  await pool.query('SELECT 1');
  const baseInput = (apiName: string, branch: string | null) => ({
    ontologyRid: onto,
    branchRid: branch,
    apiName,
    displayName: 'D',
    primaryKeys: ['id'],
    properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
  });
  const a = await svc.createObjectType(baseInput(`${tag}_a`, null));
  const b = await svc.createObjectType(baseInput(`${tag}_b`, null));
  const c = await svc.createObjectType(baseInput(`${tag}_c`, branchRid));
  createdRids.push(a.rid, b.rid, c.rid);
});

afterAll(async () => {
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [createdRids]);
  await pool.end();
});

describe("B8.08 — getObjectType + listObjectTypes branch-aware", () => {
  it("getObjectType main returns row", async () => {
    const r = await svc.getObjectType(onto, `${tag}_a`);
    expect(r?.apiName).toBe(`${tag}_a`);
    expect(r?.branchRid).toBeNull();
  });
  it("getObjectType for non-existent api returns null", async () => {
    const r = await svc.getObjectType(onto, `${tag}_ghost`);
    expect(r).toBeNull();
  });
  it("getObjectType for branch returns branch row", async () => {
    const r = await svc.getObjectType(onto, `${tag}_c`, branchRid);
    expect(r?.apiName).toBe(`${tag}_c`);
  });
  it("getObjectType main does NOT return branch row", async () => {
    const r = await svc.getObjectType(onto, `${tag}_c`);
    expect(r).toBeNull();
  });
  it("listObjectTypes main lists only main rows", async () => {
    const rs = await svc.listObjectTypes(onto);
    const apis = rs.map((r) => r.apiName).filter((n) => n.startsWith(`${tag}_`));
    expect(apis).toContain(`${tag}_a`);
    expect(apis).toContain(`${tag}_b`);
    expect(apis).not.toContain(`${tag}_c`);
  });
});
