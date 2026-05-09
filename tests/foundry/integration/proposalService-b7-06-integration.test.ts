import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ProposalService } from "../../../src/services/proposalService";
import { BranchService } from "../../../src/services/branchService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const propSvc = new ProposalService(pool);
const branchSvc = new BranchService(pool);
const tag = `b7-06-${randomUUID()}`;
const projectRid = `ri.compass.main.project.${tag}`;
let branchId: string;
let proposalId: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  await pool.query('SELECT 1');
  const ua = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}-a@x`, tag]);
  userA = ua.rows[0].id;
  const ub = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}-b@x`, tag]);
  userB = ub.rows[0].id;
  const b = await branchSvc.create(projectRid, 'feature');
  branchId = b.id;
  const p = await propSvc.open(branchId, 'B7.06 review');
  proposalId = p.id;
  // Set approval policy required=2
  await pool.query(`INSERT INTO approval_policies (scope_rid, required_count) VALUES ($1, 2)`, [projectRid]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM approval_policies WHERE scope_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM proposal_approvals WHERE proposal_id = $1`, [proposalId]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id IN ($1,$2)`, [userA, userB]);
  await pool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [userA, userB]);
  await pool.end();
});

describe("B7.06 — proposalService.approve", () => {
  it("first approval keeps status OPEN (need 2)", async () => {
    const p = await propSvc.approve(proposalId, userA, 'APPROVED');
    expect(p?.status).toBe('OPEN');
  });
  it("second approval transitions to APPROVED", async () => {
    const p = await propSvc.approve(proposalId, userB, 'APPROVED');
    expect(p?.status).toBe('APPROVED');
  });
  it("a single REJECTED forces REJECTED", async () => {
    // Create a fresh proposal to test rejection.
    const p2 = await propSvc.open(branchId, 'B7.06 reject');
    const r = await propSvc.approve(p2.id, userA, 'REJECTED', { comment: 'no' });
    expect(r?.status).toBe('REJECTED');
    expect(r?.closedAt).not.toBeNull();
    await pool.query(`DELETE FROM proposal_approvals WHERE proposal_id = $1`, [p2.id]);
    await pool.query(`DELETE FROM proposals WHERE id = $1`, [p2.id]);
  });
  it("listApprovals returns recorded decisions", async () => {
    const list = await propSvc.listApprovals(proposalId);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
