import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { GatekeeperService } from "../../../src/services/gatekeeperService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new GatekeeperService(pool);
const tag = `b4-step2-${randomUUID()}`;
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
let userId: string;
let projectRid: string;
let projectId: string;
let m1: string;
let m2: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${tag}@x`, tag],
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, DEFAULT_ORG],
  );
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`${tag}-proj`, userId],
  );
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, legacy_uuid)
     VALUES ($1, 'compass', 'PROJECT', $2, NULL, $1, 'ri.compass.main.space.00000000-0000-0000-0000-000000000000', $3, $3, $4)
     ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${tag}-proj`, userId, projectId],
  );
  await pool.query(
    `INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectRid, DEFAULT_ORG],
  );

  m1 = `${tag}-m1`;
  m2 = `${tag}-m2`;
  await pool.query(`INSERT INTO markings (id, display_name) VALUES ($1, 'm1'), ($2, 'm2')`, [m1, m2]);
  // B4.07-aware seed: grant compass-owner so role-walk step 3 finds operations.
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2)
     ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING`,
    [projectRid, userId],
  );

});

afterAll(async () => {
  await pool.query(`DELETE FROM resource_markings WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM user_markings WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM markings WHERE id IN ($1, $2)`, [m1, m2]);
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.06 — gatekeeperService step 2 (markings check)", () => {
  it("no markings → ALLOW", async () => {
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("resource has marking m1, user has m1 → ALLOW", async () => {
    await pool.query(`INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'DIRECT') ON CONFLICT DO NOTHING`, [projectRid, m1]);
    await pool.query(`INSERT INTO user_markings (user_id, marking_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, m1]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("resource has m2, user does not → DENY:MISSING_MARKINGS:m2", async () => {
    await pool.query(`INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'DIRECT') ON CONFLICT DO NOTHING`, [projectRid, m2]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toContain("MISSING_MARKINGS");
    expect((r as { reason: string }).reason).toContain(m2);
  });

  it("user gains m2 → ALLOW", async () => {
    await pool.query(`INSERT INTO user_markings (user_id, marking_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, m2]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("INHERITED source counts toward required markings", async () => {
    const id3 = `${tag}-m3`;
    await pool.query(`INSERT INTO markings (id, display_name) VALUES ($1, 'm3') ON CONFLICT DO NOTHING`, [id3]);
    await pool.query(`INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'INHERITED') ON CONFLICT DO NOTHING`, [projectRid, id3]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toContain(id3);
    await pool.query(`DELETE FROM resource_markings WHERE resource_rid = $1 AND marking_id = $2`, [projectRid, id3]);
    await pool.query(`DELETE FROM markings WHERE id = $1`, [id3]);
  });

  it("missing markings sorted alphabetically in reason", async () => {
    const ids = [`${tag}-m-z`, `${tag}-m-a`];
    for (const id of ids) {
      await pool.query(`INSERT INTO markings (id, display_name) VALUES ($1, 'sort') ON CONFLICT DO NOTHING`, [id]);
      await pool.query(`INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'DIRECT') ON CONFLICT DO NOTHING`, [projectRid, id]);
    }
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    const reason = (r as { reason: string }).reason;
    const aIdx = reason.indexOf(ids[1]);
    const zIdx = reason.indexOf(ids[0]);
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(zIdx);
    for (const id of ids) {
      await pool.query(`DELETE FROM resource_markings WHERE marking_id = $1`, [id]);
      await pool.query(`DELETE FROM markings WHERE id = $1`, [id]);
    }
  });
});
