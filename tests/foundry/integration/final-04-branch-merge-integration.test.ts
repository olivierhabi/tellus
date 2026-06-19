import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { BranchService } from "../../../src/services/branchService";
import { ProposalService } from "../../../src/services/proposalService";
import { MergeService } from "../../../src/services/mergeService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `final04_${randomUUID()}`;
const ROOT_SPACE = "ri.compass.main.space.00000000-0000-0000-0000-000000000000";
let userA: string;
let userB: string;
let projectRid: string;
let resRid: string;
let branchId: string;
let proposalId: string;

beforeAll(async () => {
  const ua = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}-a@x`, tag]);
  userA = ua.rows[0].id;
  const ub = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}-b@x`, tag]);
  userB = ub.rows[0].id;
  projectRid = `ri.compass.main.project.${randomUUID()}`;
  resRid = `ri.compass.main.dataset.${tag}-r`;
  await pool.query(
    `INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,etag)
     VALUES ($1,'compass','FOUNDRY_DATASET','original-name',NULL,NULL,$2,$3,$3, 5) ON CONFLICT (rid) DO NOTHING`,
    [resRid, ROOT_SPACE, userA],
  );
  await pool.query(`DELETE FROM approval_policies WHERE scope_rid = $1`, [projectRid]);
  await pool.query(`INSERT INTO approval_policies (scope_rid, required_count) VALUES ($1, 1)`, [projectRid]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM audit_log WHERE resource_rid = $1`, [resRid]);
  await pool.query(`DELETE FROM proposal_approvals WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM branch_overlays WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  await pool.query(`DELETE FROM approval_policies WHERE scope_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [resRid]);
  await pool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [userA, userB]);
  await pool.end();
});

describe("FINAL.04 — branch + proposal + merge", () => {
  it("create a branch off main", async () => {
    const svc = new BranchService(pool);
    const b = await svc.create(projectRid, 'feature');
    branchId = b.id;
    expect(b.status).toBe('OPEN');
  });
  it("attach an overlay (RENAME) on the branch", async () => {
    await pool.query(`INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'RENAME', $3::jsonb)`,
      [branchId, resRid, JSON.stringify({ observedEtag: 5, newName: 'merged-name' })]);
    const r = await pool.query(`SELECT count(*)::int AS c FROM branch_overlays WHERE branch_id = $1`, [branchId]);
    expect(r.rows[0].c).toBe(1);
  });
  it("open a proposal and approve it", async () => {
    const svc = new ProposalService(pool);
    const p = await svc.open(branchId, 'rename + ship');
    proposalId = p.id;
    const r = await svc.approve(proposalId, userB, 'APPROVED');
    expect(r?.status).toBe('APPROVED');
  });
  it("merge applies the overlay and flips branch + bumps etag", async () => {
    const svc = new MergeService(pool);
    const r = await svc.applyMerge(branchId, userA);
    expect(r.status).toBe('MERGED');
    expect(r.applied).toBe(1);
    const { rows } = await pool.query<{ display_name: string; etag: string }>(`SELECT display_name, etag FROM resources WHERE rid = $1`, [resRid]);
    expect(rows[0].display_name).toBe('merged-name');
    expect(Number(rows[0].etag)).toBe(6);
  });
});
