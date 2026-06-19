import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { BranchService } from "../../../src/services/branchService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new BranchService(pool);
const tag = `b7-04-${randomUUID()}`;
const projectRid = `ri.compass.main.project.${tag}`;
let branchIds: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM branches WHERE id = ANY($1::uuid[])`, [branchIds]);
  await pool.end();
});

describe("B7.04 — branchService", () => {
  it("create returns Branch with status=OPEN", async () => {
    const b = await svc.create(projectRid, 'feature-x');
    branchIds.push(b.id);
    expect(b.name).toBe('feature-x');
    expect(b.status).toBe('OPEN');
  });
  it("getById returns the branch", async () => {
    const id = branchIds[0];
    const b = await svc.getById(id);
    expect(b?.id).toBe(id);
  });
  it("getByName returns by project + name", async () => {
    const b = await svc.getByName(projectRid, 'feature-x');
    expect(b?.id).toBe(branchIds[0]);
  });
  it("UNIQUE(project, name) prevents duplicates", async () => {
    await expect(svc.create(projectRid, 'feature-x')).rejects.toThrow();
  });
  it("listByProject returns all branches", async () => {
    const b2 = await svc.create(projectRid, 'feature-y');
    branchIds.push(b2.id);
    const list = await svc.listByProject(projectRid);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
