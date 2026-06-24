import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

// Each test mutates role_grants / project_members / markings directly and then
// re-evaluates. The gatekeeper LRU cache is invalidated via async Postgres
// LISTEN/NOTIFY, which races this synchronous test flow — so a key evaluated
// (and cached) by an earlier test can be read stale here. Clear the cache
// before each test for deterministic, pollution-free evaluations.
beforeEach(() => svc.clearCache());


// Per-suite probe rows — all carry the same suiteTag for cleanup.
const suiteTag = `b4-step1-${randomUUID()}`;
let userInOrg: string;
let userOutsideOrg: string;
let projectRid: string;
let folderRid: string;
let projectId: string;
let secondOrgId: string;

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

beforeAll(async () => {
  await pool.query("SELECT 1");

  const u1 = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${suiteTag}-in@x`, suiteTag],
  );
  userInOrg = u1.rows[0].id;
  await pool.query(
    `INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userInOrg, DEFAULT_ORG],
  );

  const u2 = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${suiteTag}-out@x`, suiteTag],
  );
  userOutsideOrg = u2.rows[0].id;
  // Remove default-org membership for this user (the migrate backfill
  // would have added it).
  await pool.query(
    `DELETE FROM user_organizations WHERE user_id = $1`,
    [userOutsideOrg],
  );

  // Create a probe project + ensure project_organizations row uses default org.
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`${suiteTag}-proj`, userInOrg],
  );
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, legacy_uuid)
     VALUES ($1, 'compass', 'PROJECT', $2, NULL, $1, 'ri.compass.main.space.00000000-0000-0000-0000-000000000000', $3, $3, $4)
     ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${suiteTag}-proj`, userInOrg, projectId],
  );
  await pool.query(
    `INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectRid, DEFAULT_ORG],
  );

  // Create a probe folder under that project.
  folderRid = `ri.compass.main.folder.${randomUUID()}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by)
     VALUES ($1, 'compass', 'COMPASS_FOLDER', $2, $3, $3, 'ri.compass.main.space.00000000-0000-0000-0000-000000000000', $4, $4)
     ON CONFLICT (rid) DO NOTHING`,
    [folderRid, `${suiteTag}-folder`, projectRid, userInOrg],
  );

  // Second org for multi-org case.
  secondOrgId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, display_name) VALUES ($1, $2, 'B4 second org') ON CONFLICT DO NOTHING`,
    [secondOrgId, `${suiteTag}-org2`],
  );
  await pool.query(
    `INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectRid, secondOrgId],
  );
  // B4.07-aware seed: grant compass-owner so role-walk step 3 finds operations.
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2)
     ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING`,
    [projectRid, userInOrg],
  );

});

afterAll(async () => {
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM organizations WHERE name LIKE $1`, [`${suiteTag}%`]);
  await pool.query(`DELETE FROM resources WHERE rid IN ($1, $2)`, [projectRid, folderRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id IN ($1, $2)`, [userInOrg, userOutsideOrg]);
  await pool.query(`DELETE FROM users WHERE display_name = $1`, [suiteTag]);
  await pool.end();
});

describe("B4.05 — gatekeeperService step 1 (org check)", () => {
  it("user in org → ALLOW (project)", async () => {
    const r = await svc.evaluate({ principalId: userInOrg, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("user not in org → DENY:NO_ORG_MEMBERSHIP (project)", async () => {
    const r = await svc.evaluate({ principalId: userOutsideOrg, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("NO_ORG_MEMBERSHIP");
  });

  it("user in org → ALLOW (folder under project)", async () => {
    const r = await svc.evaluate({ principalId: userInOrg, operationId: "compass:view-resource", resourceRid: folderRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("user not in org → DENY (folder under project)", async () => {
    const r = await svc.evaluate({ principalId: userOutsideOrg, operationId: "compass:view-resource", resourceRid: folderRid });
    expect(r.decision).toBe("DENY");
  });

  it("resource is space → ALLOW (no project ancestor)", async () => {
    const r = await svc.evaluate({ principalId: userOutsideOrg, operationId: "compass:view-resource", resourceRid: "ri.compass.main.space.00000000-0000-0000-0000-000000000000" });
    expect(r.decision).toBe("ALLOW");
  });

  it("multi-org project: user in one org → ALLOW", async () => {
    const r = await svc.evaluate({ principalId: userInOrg, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("unknown resource RID → ALLOW (step 1 only)", async () => {
    const r = await svc.evaluate({ principalId: userInOrg, operationId: "compass:view-resource", resourceRid: "ri.compass.main.project.unknown-${randomUUID()}" });
    expect(r.decision).toBe("ALLOW");
  });

  it("guest user (uo.is_guest=true) still counts as member → ALLOW", async () => {
    await pool.query(`UPDATE user_organizations SET is_guest = true WHERE user_id = $1`, [userInOrg]);
    const r = await svc.evaluate({ principalId: userInOrg, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
    await pool.query(`UPDATE user_organizations SET is_guest = false WHERE user_id = $1`, [userInOrg]);
  });
});
