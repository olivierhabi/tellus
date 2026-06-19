import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { MergeService } from "../../../src/services/mergeService";
import { BranchService } from "../../../src/services/branchService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const merge = new MergeService(pool);
const branchSvc = new BranchService(pool);
const tag = `b7-07-${randomUUID()}`;
const projectRid = `ri.compass.main.project.${tag}`;
let userId: string;
let branchId: string;
let resRid: string;

beforeAll(async () => {
  await pool.query('SELECT 1');
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  resRid = `ri.compass.main.dataset.${tag}-r`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,etag)
    VALUES ($1,'compass','FOUNDRY_DATASET','r',NULL,NULL,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2, 5) ON CONFLICT (rid) DO NOTHING`,
    [resRid, userId]);
  const b = await branchSvc.create(projectRid, 'feature');
  branchId = b.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM branch_overlays WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [resRid]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B7.07 — mergeService.detectConflicts", () => {
  it("no overlays → no conflicts", async () => {
    const c = await merge.detectConflicts(branchId);
    expect(c).toEqual([]);
  });
  it("overlay with observedEtag = current → no conflict", async () => {
    await pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'UPSERT', $3::jsonb)`,
      [branchId, resRid, JSON.stringify({ observedEtag: 5 })]);
    const c = await merge.detectConflicts(branchId);
    expect(c).toEqual([]);
  });
  it("overlay with observedEtag < current → conflict", async () => {
    await pool.query(`UPDATE resources SET etag = etag + 1 WHERE rid = $1`, [resRid]);
    const c = await merge.detectConflicts(branchId);
    expect(c.length).toBe(1);
    expect(c[0].resourceRid).toBe(resRid);
    expect(c[0].observedEtag).toBeLessThan(c[0].currentEtag);
  });
});
