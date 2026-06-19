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
const tag = `b6-04-${randomUUID()}`;
const a = `ri.compass.main.dataset.${tag}-a`;
const b = `ri.compass.main.dataset.${tag}-b`;
const c = `ri.compass.main.dataset.${tag}-c`;
const d = `ri.compass.main.dataset.${tag}-d`;

beforeAll(async () => {
  await pool.query('SELECT 1');
  await svc.addEdge(a, b);
  await svc.addEdge(b, c);
  await svc.addEdge(c, d);
});
afterAll(async () => {
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = ANY($1::text[]) OR downstream_rid = ANY($1::text[])`, [[a,b,c,d]]);
  await pool.end();
});

describe("B6.04 — lineage walks", () => {
  it("getDownstream(a) returns b,c,d", async () => {
    const ds = await svc.getDownstream(a);
    expect(new Set(ds)).toEqual(new Set([b, c, d]));
  });
  it("getUpstream(d) returns a,b,c", async () => {
    const us = await svc.getUpstream(d);
    expect(new Set(us)).toEqual(new Set([a, b, c]));
  });
  it("getLineage(b) returns {upstream:[a], downstream:[c,d]}", async () => {
    const lin = await svc.getLineage(b);
    expect(new Set(lin.upstream)).toEqual(new Set([a]));
    expect(new Set(lin.downstream)).toEqual(new Set([c, d]));
  });
  it("isolated rid returns empty", async () => {
    const lin = await svc.getLineage(`ri.compass.main.dataset.${tag}-iso`);
    expect(lin.upstream).toEqual([]);
    expect(lin.downstream).toEqual([]);
  });
});
