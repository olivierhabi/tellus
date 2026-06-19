import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { BranchInactivityCloser } from "../../../src/jobs/branchInactivityCloser";
import { BranchService } from "../../../src/services/branchService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const closer = new BranchInactivityCloser(pool);
const branchSvc = new BranchService(pool);
const tag = `b7-10-${randomUUID()}`;
const projectRid = `ri.compass.main.project.${tag}`;
const branchIds: string[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM branch_overlays WHERE branch_id = ANY($1::uuid[])`, [branchIds]);
  await pool.query(`DELETE FROM branches WHERE id = ANY($1::uuid[])`, [branchIds]);
  await pool.end();
});

describe("B7.10 — branchInactivityCloser", () => {
  it("recently created branch is NOT closed", async () => {
    const b = await branchSvc.create(projectRid, 'recent');
    branchIds.push(b.id);
    const r = await closer.runOnce(30);
    expect(r.scanned).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM branches WHERE id = $1`, [b.id]);
    expect(rows[0].status).toBe('OPEN');
  });

  it("branch older than threshold is closed to ABANDONED", async () => {
    const b = await branchSvc.create(projectRid, 'old');
    branchIds.push(b.id);
    // Backdate the branch's created_at past the threshold.
    await pool.query(
      `UPDATE branches SET created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = $1`,
      [b.id],
    );
    const r = await closer.runOnce(30);
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM branches WHERE id = $1`, [b.id]);
    expect(rows[0].status).toBe('ABANDONED');
  });

  it("recent overlay activity protects an old branch from closure", async () => {
    const b = await branchSvc.create(projectRid, 'old-with-recent-activity');
    branchIds.push(b.id);
    await pool.query(
      `UPDATE branches SET created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = $1`,
      [b.id],
    );
    // Recent overlay activity → MAX(overlay.created_at, branch.created_at) is now()
    await pool.query(
      `INSERT INTO branch_overlays (branch_id, resource_rid, operation, payload) VALUES ($1, $2, 'UPSERT', '{}'::jsonb)`,
      [b.id, `ri.compass.main.dataset.${tag}-active`],
    );
    await closer.runOnce(30);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM branches WHERE id = $1`, [b.id]);
    expect(rows[0].status).toBe('OPEN');
  });

  it("running twice on the same population is a no-op (idempotent)", async () => {
    const r1 = await closer.runOnce(30);
    const r2 = await closer.runOnce(30);
    expect(r2.closed).toBe(0);
    expect(r2.scanned).toBeLessThanOrEqual(r1.scanned);
  });
});
