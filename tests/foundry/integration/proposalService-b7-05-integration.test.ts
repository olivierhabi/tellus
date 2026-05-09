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
const tag = `b7-05-${randomUUID()}`;
const projectRid = `ri.compass.main.project.${tag}`;
let branchId: string;
let proposalId: string;

beforeAll(async () => {
  await pool.query('SELECT 1');
  const b = await branchSvc.create(projectRid, 'feature');
  branchId = b.id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM proposals WHERE branch_id = $1`, [branchId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  await pool.end();
});

describe("B7.05 — proposalService", () => {
  it("open returns Proposal status=OPEN", async () => {
    const p = await propSvc.open(branchId, 'Add feature X');
    proposalId = p.id;
    expect(p.status).toBe('OPEN');
  });
  it("getById round-trips", async () => {
    const p = await propSvc.getById(proposalId);
    expect(p?.title).toBe('Add feature X');
  });
  it("setStatus REJECTED stamps closed_at", async () => {
    const p = await propSvc.setStatus(proposalId, 'REJECTED');
    expect(p?.status).toBe('REJECTED');
    expect(p?.closedAt).not.toBeNull();
  });
  it("listByBranch lists all proposals", async () => {
    const list = await propSvc.listByBranch(branchId);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});
