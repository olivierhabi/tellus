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
const tag = `b7-09-${randomUUID()}`;
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
    VALUES ($1,'compass','FOUNDRY_DATASET','original',NULL,NULL,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2, 5) ON CONFLICT (rid) DO NOTHING`,
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

describe("B7.09 — idempotent merge replay", () => {
  it("first merge applies overlay and flips branch to MERGED", async () => {
    await pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'RENAME', $3::jsonb)`,
      [branchId, resRid, JSON.stringify({ observedEtag: 5, newName: 'first-merge' })]);
    const r = await merge.applyMerge(branchId, userId);
    expect(r.status).toBe('MERGED');
    expect(r.applied).toBe(1);
    const { rows } = await pool.query<{ etag: string; display_name: string }>(`SELECT etag, display_name FROM resources WHERE rid = $1`, [resRid]);
    expect(Number(rows[0].etag)).toBe(6);
    expect(rows[0].display_name).toBe('first-merge');
  });

  it("second merge call is a no-op (applied=0, status=MERGED)", async () => {
    const r = await merge.applyMerge(branchId, userId);
    expect(r.status).toBe('MERGED');
    expect(r.applied).toBe(0);
    expect(r.audited).toBe(0);
    expect(r.emitted).toBe(0);
  });

  it("resource etag did not bump on the no-op replay", async () => {
    const { rows } = await pool.query<{ etag: string; display_name: string }>(`SELECT etag, display_name FROM resources WHERE rid = $1`, [resRid]);
    expect(Number(rows[0].etag)).toBe(6);
    expect(rows[0].display_name).toBe('first-merge');
  });

  it("audit log has only one MERGE row for the resource (no double-write)", async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE resource_rid = $1 AND reason = 'MERGE'`,
      [resRid],
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
