import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { B9ScheduledRerun } from "../../../src/jobs/b9ScheduledRerun";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const job = new B9ScheduledRerun(pool);
const tag = `b9-11-${randomUUID()}`;
const otRid = `ri.ontology.main.object-type.${tag}`;
const otFresh = `ri.ontology.main.object-type.${tag}-fresh`;

beforeAll(async () => {
  await pool.query('SELECT 1');
  // Stale row.
  await pool.query(
    `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, phase, last_run_at) VALUES ($1, 'ri.ontology.main.ontology.default', 'IDLE', now() - interval '12 hours')`,
    [otRid],
  );
  // Fresh row.
  await pool.query(
    `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, phase, last_run_at) VALUES ($1, 'ri.ontology.main.ontology.default', 'IDLE', now())`,
    [otFresh],
  );
});
afterAll(async () => {
  await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = ANY($1::text[])`, [[otRid, otFresh]]);
  await pool.end();
});

describe("B9.11 — scheduled re-run", () => {
  it("triggers stale rows only (>6h)", async () => {
    const triggered: string[] = [];
    const r = await job.runOnce(async (rid) => { triggered.push(rid); }, { staleHours: 6 });
    expect(triggered).toContain(otRid);
    expect(triggered).not.toContain(otFresh);
    expect(r.triggered).toBeGreaterThanOrEqual(1);
  });

  it("rows with NULL last_run_at are considered stale", async () => {
    const otNew = `${otRid}-null`;
    await pool.query(
      `INSERT INTO funnel_b9_state (object_type_rid, ontology_rid, phase, last_run_at) VALUES ($1, 'ri.ontology.main.ontology.default', 'IDLE', NULL)`,
      [otNew],
    );
    try {
      const triggered: string[] = [];
      await job.runOnce(async (rid) => { triggered.push(rid); }, { staleHours: 6 });
      expect(triggered).toContain(otNew);
    } finally {
      await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = $1`, [otNew]);
    }
  });

  it("staleHours = 0 triggers all rows", async () => {
    const triggered: string[] = [];
    await job.runOnce(async (rid) => { triggered.push(rid); }, { staleHours: 0 });
    expect(triggered).toContain(otFresh);
  });
});
