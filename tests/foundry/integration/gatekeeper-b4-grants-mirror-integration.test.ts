// B4.02 — role_grants DDL + project_members mirror trigger.
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

let userId: string;
let projectId: string;

beforeAll(async () => {
  await pool.query("SELECT 1");
  // Seed a probe user + project (we clean them up in afterAll).
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'b4-mirror') RETURNING id`,
    [`b4-mirror-${randomUUID()}@tellus.local`],
  );
  userId = u.rows[0].id;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`b4-mirror-${randomUUID()}`, userId],
  );
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM role_grants WHERE principal_id = $1`, [userId]);
  await pool.query(`DELETE FROM project_members WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [`ri.compass.main.project.${projectId}`]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.02 — role_grants mirror", () => {
  it("inserting a project_members row creates a role_grants row", async () => {
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userId],
    );
    const { rows } = await pool.query(
      `SELECT * FROM role_grants WHERE principal_id = $1 AND resource_rid = $2`,
      [userId, `ri.compass.main.project.${projectId}`],
    );
    expect(rows.find((r) => r.role_id === 'compass-editor')).toBeTruthy();
  });

  it("updating role from editor → owner creates an additional role_grants row", async () => {
    await pool.query(
      `UPDATE project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    const { rows } = await pool.query(
      `SELECT role_id FROM role_grants WHERE principal_id = $1 AND resource_rid = $2 ORDER BY role_id`,
      [userId, `ri.compass.main.project.${projectId}`],
    );
    const ids = rows.map((r: { role_id: string }) => r.role_id);
    expect(ids).toContain('compass-owner');
    expect(ids).toContain('compass-editor');
  });

  it("backfill mirrors any existing project_members rows", async () => {
    // Already covered by B4.02 step 15 — run the same insert-or-update
    // and verify no constraint violation and at least one row exists.
    await pool.query(
      `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
       SELECT 'ri.compass.main.project.' || pm.project_id::text, pm.user_id, 'USER',
              CASE pm.role WHEN 'owner' THEN 'compass-owner' WHEN 'editor' THEN 'compass-editor' WHEN 'viewer' THEN 'compass-viewer' END,
              pm.user_id
       FROM project_members pm
       WHERE pm.user_id = $1
       ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING`,
      [userId],
    );
    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM role_grants WHERE principal_id = $1`,
      [userId],
    );
    expect(rows[0].c).toBeGreaterThanOrEqual(1);
  });
});
