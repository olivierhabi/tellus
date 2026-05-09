import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { OmsService, ValidationError } from "../../../src/services/omsService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new OmsService(pool);
const tag = `b807_${randomUUID().replace(/-/g, "_")}`;
const onto = 'ri.ontology.main.ontology.default';
const createdRids: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM object_type_datasources WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [createdRids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [createdRids]);
  await pool.end();
});

describe("B8.07 — omsService.createObjectType", () => {
  const baseInput = (apiName: string) => ({
    ontologyRid: onto,
    apiName,
    displayName: 'Employee',
    primaryKeys: ['id'],
    properties: [
      { apiName: 'id', displayName: 'ID', dataType: 'STRING', isPrimaryKey: true },
      { apiName: 'name', displayName: 'Name', dataType: 'STRING' },
    ],
  });

  it("happy path: creates row + properties + datasources atomically", async () => {
    const r = await svc.createObjectType({
      ...baseInput(`${tag}_h`),
      titleProperty: 'name',
      datasources: [{ datasourceRid: `ri.foundry.main.dataset.${tag}-ds`, primaryKeyColumns: ['id_col'], propertyMapping: { name: 'name_col' }, isPrimary: true }],
    });
    createdRids.push(r.rid);
    expect(r.apiName).toBe(`${tag}_h`);
    expect(r.status).toBe('EXPERIMENTAL');
    const ds = await pool.query(`SELECT count(*)::int AS c FROM object_type_datasources WHERE object_type_rid = $1`, [r.rid]);
    expect(ds.rows[0].c).toBe(1);
  });

  it("INVALID_API_NAME for bad regex", async () => {
    await expect(svc.createObjectType(baseInput('Has-Capital'))).rejects.toThrow(/INVALID_API_NAME/);
  });

  it("INVALID_API_NAME starting with digit", async () => {
    await expect(svc.createObjectType(baseInput('1bad'))).rejects.toThrow(/INVALID_API_NAME/);
  });

  it("MISSING_DISPLAY_NAME when empty", async () => {
    await expect(svc.createObjectType({ ...baseInput(`${tag}_d`), displayName: '' })).rejects.toThrow(/MISSING_DISPLAY_NAME/);
  });

  it("PRIMARY_KEYS_REQUIRED when empty", async () => {
    await expect(svc.createObjectType({ ...baseInput(`${tag}_pk`), primaryKeys: [] })).rejects.toThrow(/PRIMARY_KEYS_REQUIRED/);
  });

  it("PROPERTIES_REQUIRED when empty", async () => {
    await expect(svc.createObjectType({ ...baseInput(`${tag}_p`), properties: [] })).rejects.toThrow(/PROPERTIES_REQUIRED/);
  });

  it("PK_NOT_FOUND when primary key references missing property", async () => {
    await expect(svc.createObjectType({ ...baseInput(`${tag}_pkn`), primaryKeys: ['ghost'] })).rejects.toThrow(/PK_NOT_FOUND/);
  });

  it("TITLE_PROPERTY_NOT_FOUND when titleProperty references missing property", async () => {
    await expect(svc.createObjectType({ ...baseInput(`${tag}_t`), titleProperty: 'missing' })).rejects.toThrow(/TITLE_PROPERTY_NOT_FOUND/);
  });

  it("PK_LENGTH_MISMATCH when datasource primary_key_columns length doesn't match", async () => {
    await expect(svc.createObjectType({
      ...baseInput(`${tag}_pkl`),
      datasources: [{ datasourceRid: `ri.foundry.main.dataset.${tag}-x`, primaryKeyColumns: ['a','b'] }],
    })).rejects.toThrow(/PK_LENGTH_MISMATCH/);
  });

  it("PROPERTY_MAPPING_UNKNOWN when datasource maps a non-existent property", async () => {
    await expect(svc.createObjectType({
      ...baseInput(`${tag}_pm`),
      datasources: [{ datasourceRid: `ri.foundry.main.dataset.${tag}-y`, primaryKeyColumns: ['id_col'], propertyMapping: { ghost: 'col' } }],
    })).rejects.toThrow(/PROPERTY_MAPPING_UNKNOWN/);
  });

  it("dup api_name on same ontology+branch fails on insert (UNIQUE)", async () => {
    const inp = { ...baseInput(`${tag}_dup`), titleProperty: 'name' };
    const r = await svc.createObjectType(inp);
    createdRids.push(r.rid);
    await expect(svc.createObjectType(inp)).rejects.toThrow();
  });

  it("ValidationError carries error code field", async () => {
    try {
      await svc.createObjectType(baseInput(''));
    } catch (e: any) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.code).toBe('INVALID_API_NAME');
    }
  });
});
