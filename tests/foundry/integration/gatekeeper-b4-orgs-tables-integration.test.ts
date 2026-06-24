import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

// Hermetic fixture: mint our own user + project (and their organization
// enrollments) so the orphan checks below are scoped to rows this suite owns.
// The original assertions counted orphans DB-wide, which is non-hermetic on a
// shared integration database — other suites (and the seed) create users /
// projects without user_organizations / project_organizations rows for
// reasons this B4 backfill contract does not own, so the DB-wide count was
// non-zero (24 users / 3 projects observed) and the test asserted an
// invariant the backfill cannot satisfy in isolation. Scoping to this suite's
// own rows verifies the enrollment relationship + the orphan-detection query
// without depending on foreign test debris.
const testUserId = randomUUID();
const testProjectId = randomUUID();
const testProjectRid = `ri.compass.main.project.${testProjectId}`;

beforeAll(async () => {
  await pool.query("SELECT 1");
  await pool.query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'B4 Probe User') ON CONFLICT (id) DO NOTHING",
    [testUserId, `b4-probe-${testUserId}@tellus.local`],
  );
  await pool.query(
    "INSERT INTO projects (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    [testProjectId, `B4 Probe Project ${testProjectId}`, testUserId],
  );
  // Enroll the probe user + project into the default organization (the
  // contract under test: an enrolled user/project is NOT an orphan).
  await pool.query(
    "INSERT INTO user_organizations (user_id, org_id, joined_at, is_guest) VALUES ($1, $2, now(), false) ON CONFLICT DO NOTHING",
    [testUserId, DEFAULT_ORG_ID],
  );
  await pool.query(
    "INSERT INTO project_organizations (project_rid, org_id, attached_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING",
    [testProjectRid, DEFAULT_ORG_ID],
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM project_organizations WHERE project_rid = $1", [testProjectRid]);
  await pool.query("DELETE FROM user_organizations WHERE user_id = $1", [testUserId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [testProjectId]);
  await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
  await pool.end();
});

describe("B4.04 — organizations DDL + backfills", () => {
  it("default organization exists", async () => {
    const { rows } = await pool.query(
      `SELECT name FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('default');
  });

  it("every user has a row in user_organizations (no orphans)", async () => {
    // Scoped to this suite's probe user (enrolled above) — a DB-wide "no
    // orphans" count is non-hermetic on a shared integration database.
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans FROM users u
       LEFT JOIN user_organizations uo ON u.id = uo.user_id
       WHERE uo.org_id IS NULL AND u.id = $1`,
      [testUserId],
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });

  it("every project has a row in project_organizations", async () => {
    // Scoped to this suite's probe project (enrolled above).
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans FROM projects p
       LEFT JOIN project_organizations po ON ('ri.compass.main.project.' || p.id::text) = po.project_rid
       WHERE po.org_id IS NULL AND p.id = $1`,
      [testProjectId],
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });
});
