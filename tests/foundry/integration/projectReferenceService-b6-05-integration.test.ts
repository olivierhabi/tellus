import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ProjectReferenceService } from "../../../src/services/projectReferenceService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new ProjectReferenceService(pool);
const tag = `b6-05-${randomUUID()}`;
const p1 = `ri.compass.main.project.${tag}-p1`;
const p2 = `ri.compass.main.project.${tag}-p2`;
const ds = `ri.compass.main.dataset.${tag}-ds`;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM project_references WHERE owner_project_rid = ANY($1::text[]) OR referenced_resource_rid = ANY($1::text[])`, [[p1,p2,ds]]);
  await pool.end();
});

describe("B6.05 — projectReferenceService", () => {
  it("addReference + listReferences", async () => {
    await svc.addReference(p1, ds);
    const refs = await svc.listReferences(p1);
    expect(refs).toContain(ds);
  });
  it("listProjectsReferencing", async () => {
    await svc.addReference(p2, ds);
    const owners = await svc.listProjectsReferencing(ds);
    expect(new Set(owners)).toEqual(new Set([p1, p2]));
  });
  it("removeReference", async () => {
    const r = await svc.removeReference(p1, ds);
    expect(r.removed).toBe(1);
    const refs = await svc.listReferences(p1);
    expect(refs).not.toContain(ds);
  });
  it("addReference is idempotent", async () => {
    await svc.addReference(p2, ds);
    await svc.addReference(p2, ds);
    const refs = await svc.listReferences(p2);
    expect(refs.filter((r) => r === ds).length).toBe(1);
  });
});
