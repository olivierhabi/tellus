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
const tag = `b7-08-${randomUUID()}`;
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
    VALUES ($1,'compass','FOUNDRY_DATASET','original-name',NULL,NULL,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2, 5) ON CONFLICT (rid) DO NOTHING`,
    [resRid, userId]);
  const b = await branchSvc.create(projectRid, 'feature');
  branchId = b.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM audit_log WHERE resource_rid = $1`, [resRid]);
  await pool.query(`DELETE FROM branch_overlays WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [resRid]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B7.08 — mergeService.applyMerge", () => {
  it("with conflicts returns CONFLICT result without changes", async () => {
    await pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'UPSERT', $3::jsonb)`,
      [branchId, resRid, JSON.stringify({ observedEtag: 1, fields: { displayName: 'should-not-apply' } })]);
    const r = await merge.applyMerge(branchId, userId);
    expect(r.status).toBe('CONFLICT');
    expect(r.applied).toBe(0);
    const { rows } = await pool.query<{ display_name: string }>(`SELECT display_name FROM resources WHERE rid = $1`, [resRid]);
    expect(rows[0].display_name).toBe('original-name');
    await pool.query(`DELETE FROM branch_overlays WHERE branch_id = $1`, [branchId]);
  });

  it("clean merge applies all overlays and flips branch to MERGED", async () => {
    // observedEtag = 5 matches current etag → no conflict
    await pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'RENAME', $3::jsonb)`,
      [branchId, resRid, JSON.stringify({ observedEtag: 5, newName: 'merged-name' })]);
    const r = await merge.applyMerge(branchId, userId);
    expect(r.status).toBe('MERGED');
    expect(r.applied).toBe(1);

    const { rows } = await pool.query<{ display_name: string; etag: string }>(`SELECT display_name, etag FROM resources WHERE rid = $1`, [resRid]);
    expect(rows[0].display_name).toBe('merged-name');
    expect(Number(rows[0].etag)).toBe(6);

    const { rows: branchRows } = await pool.query<{ status: string; merged_at: string | null }>(`SELECT status, merged_at FROM branches WHERE id = $1`, [branchId]);
    expect(branchRows[0].status).toBe('MERGED');
    expect(branchRows[0].merged_at).not.toBeNull();
  });

  it("audit row written for each merged overlay", async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE resource_rid = $1 AND reason = 'MERGE'`,
      [resRid],
    );
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
  });
});
