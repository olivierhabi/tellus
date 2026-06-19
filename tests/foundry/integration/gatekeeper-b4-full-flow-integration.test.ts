// B4.08 — full evaluate() flow integration test.
// Drives a single principal/resource through all 3 steps in sequence:
//   step 1 (orgs) → step 2 (markings) → step 3 (roles)
// and asserts the failure mode reported at each level.
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
const tag = `b4-full-${randomUUID()}`;
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
let userId: string;
let projectRid: string;
let projectId: string;
let markingId: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${tag}@x`, tag],
  );
  userId = u.rows[0].id;
  // Backfill removed default-org membership for clean step1 testing.
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);

  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name, owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p`, userId]);
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, legacy_uuid)
     VALUES ($1,'compass','PROJECT',$2,NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3,$4)
     ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${tag}-p`, userId, projectId],
  );
  await pool.query(`INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [projectRid, DEFAULT_ORG]);

  markingId = `${tag}-m`;
  await pool.query(`INSERT INTO markings (id, display_name) VALUES ($1, 'b4-full m') ON CONFLICT DO NOTHING`, [markingId]);
  await pool.query(`INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'DIRECT') ON CONFLICT DO NOTHING`, [projectRid, markingId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM resource_markings WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM user_markings WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM markings WHERE id = $1`, [markingId]);
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.08 — gatekeeperService full flow", () => {
  it("step 1 fails first: no org membership → DENY:NO_ORG_MEMBERSHIP", async () => {
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("NO_ORG_MEMBERSHIP");
  });

  it("step 2 fails second: org ok, markings missing", async () => {
    await pool.query(`INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, DEFAULT_ORG]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toContain("MISSING_MARKINGS");
  });

  it("step 3 fails third: org+markings ok, no role grants", async () => {
    await pool.query(`INSERT INTO user_markings (user_id, marking_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, markingId]);
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("OPERATION_NOT_GRANTED");
  });

  it("all 3 steps pass → ALLOW", async () => {
    await pool.query(
      `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
       VALUES ($1, $2, 'USER', 'compass-viewer', $2) ON CONFLICT DO NOTHING`,
      [projectRid, userId],
    );
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });
});
