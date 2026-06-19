import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ResourceGraphService } from "../../../src/services/resourceGraphService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new ResourceGraphService(pool);
const tag = `b6-03-${randomUUID()}`;
const a = `ri.compass.main.dataset.${tag}-a`;
const b = `ri.compass.main.dataset.${tag}-b`;
const c = `ri.compass.main.dataset.${tag}-c`;

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = ANY($1::text[]) OR downstream_rid = ANY($1::text[])`, [[a,b,c]]);
  await pool.end();
});

describe("B6.03 — resourceGraphService", () => {
  it("addEdge a→b creates row", async () => {
    await svc.addEdge(a, b);
    const { rows } = await pool.query(`SELECT * FROM resource_dependencies WHERE upstream_rid = $1 AND downstream_rid = $2`, [a, b]);
    expect(rows.length).toBe(1);
  });
  it("addEdge b→a throws CYCLE", async () => {
    await expect(svc.addEdge(b, a)).rejects.toThrow(/CYCLE/);
  });
  it("addEdge a→a (self) throws CYCLE", async () => {
    await expect(svc.addEdge(a, a)).rejects.toThrow(/CYCLE/);
  });
  it("addEdge b→c then c→a throws CYCLE (transitive)", async () => {
    await svc.addEdge(b, c);
    await expect(svc.addEdge(c, a)).rejects.toThrow(/CYCLE/);
    await svc.removeEdge(b, c);
  });
  it("removeEdge deletes the row", async () => {
    const r = await svc.removeEdge(a, b);
    expect(r.removed).toBe(1);
  });
});
