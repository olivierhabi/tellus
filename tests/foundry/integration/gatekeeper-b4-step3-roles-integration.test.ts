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
const tag = `b4-step3-${randomUUID()}`;
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
let userId: string;
let userOther: string;
let projectRid: string;
let folderRid: string;
let nestedRid: string;
let projectId: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${tag}@x`, tag],
  );
  userId = u.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, DEFAULT_ORG]);
  const u2 = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${tag}-other@x`, tag],
  );
  userOther = u2.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userOther, DEFAULT_ORG]);

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
  folderRid = `ri.compass.main.folder.${randomUUID()}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by)
     VALUES ($1,'compass','COMPASS_FOLDER',$2,$3,$3,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$4,$4)
     ON CONFLICT (rid) DO NOTHING`,
    [folderRid, `${tag}-f`, projectRid, userId],
  );
  nestedRid = `ri.compass.main.folder.${randomUUID()}`;
  await pool.query(
    `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by)
     VALUES ($1,'compass','COMPASS_FOLDER',$2,$3,$4,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$5,$5)
     ON CONFLICT (rid) DO NOTHING`,
    [nestedRid, `${tag}-nested`, folderRid, projectRid, userId],
  );
  // Owner grant on project for userId
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2) ON CONFLICT DO NOTHING`,
    [projectRid, userId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM role_grants WHERE resource_rid IN ($1, $2, $3)`, [projectRid, folderRid, nestedRid]);
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid IN ($1, $2, $3)`, [projectRid, folderRid, nestedRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id IN ($1, $2)`, [userId, userOther]);
  await pool.query(`DELETE FROM users WHERE display_name = $1`, [tag]);
  await pool.end();
});

describe("B4.07 — gatekeeperService step 3 (role ancestor walk)", () => {
  it("owner grant on project → ALLOW view-resource on project", async () => {
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("owner grant on project → ALLOW edit on nested folder", async () => {
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:edit-resource", resourceRid: nestedRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("user without grant → DENY:OPERATION_NOT_GRANTED", async () => {
    const r = await svc.evaluate({ principalId: userOther, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("OPERATION_NOT_GRANTED");
  });

  it("EVERYONE grant on viewer role → ALLOW for any user (in-org)", async () => {
    await pool.query(
      `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
       VALUES ($1, NULL, 'EVERYONE', 'compass-viewer', $2) ON CONFLICT DO NOTHING`,
      [projectRid, userId],
    );
    const r = await svc.evaluate({ principalId: userOther, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("operation outside role's set → DENY", async () => {
    // userOther only has viewer (via EVERYONE) which doesn't include edit.
    const r = await svc.evaluate({ principalId: userOther, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("OPERATION_NOT_GRANTED");
  });

  it("disable_inherited_permissions on folder blocks the project owner walk", async () => {
    await pool.query(
      `UPDATE resources SET metadata = metadata || '{"disable_inherited_permissions":"true"}'::jsonb WHERE rid = $1`,
      [folderRid],
    );
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:edit-resource", resourceRid: nestedRid });
    expect(r.decision).toBe("DENY");
    expect((r as { reason: string }).reason).toBe("OPERATION_NOT_GRANTED");
    await pool.query(
      `UPDATE resources SET metadata = metadata - 'disable_inherited_permissions' WHERE rid = $1`,
      [folderRid],
    );
  });

  it("after restoring inheritance, owner walk works again", async () => {
    const r = await svc.evaluate({ principalId: userId, operationId: "compass:edit-resource", resourceRid: nestedRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("editor grant on project → ALLOW edit on project", async () => {
    await pool.query(
      `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
       VALUES ($1, $2, 'USER', 'compass-editor', $2) ON CONFLICT DO NOTHING`,
      [projectRid, userOther],
    );
    const r = await svc.evaluate({ principalId: userOther, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });

  it("DENY when no role_grants at any ancestor", async () => {
    // Create an unrelated project user has no grant on.
    const proj2 = await pool.query<{ id: string }>(`INSERT INTO projects (name, owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p2`, userId]);
    const p2Rid = `ri.compass.main.project.${proj2.rows[0].id}`;
    try {
      await pool.query(
        `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, legacy_uuid)
         VALUES ($1,'compass','PROJECT',$2,NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3,$4)
         ON CONFLICT (legacy_uuid) DO NOTHING`,
        [p2Rid, `${tag}-p2`, userId, proj2.rows[0].id],
      );
      await pool.query(`INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p2Rid, DEFAULT_ORG]);
      const r = await svc.evaluate({ principalId: userOther, operationId: "compass:view-resource", resourceRid: p2Rid });
      expect(r.decision).toBe("DENY");
    } finally {
      await pool.query(`DELETE FROM resources WHERE rid = $1`, [p2Rid]);
      await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [p2Rid]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [proj2.rows[0].id]);
    }
  });

  it("project_members trigger grants role + walk picks it up", async () => {
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userOther],
    );
    const r = await svc.evaluate({ principalId: userOther, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r.decision).toBe("ALLOW");
  });
});
