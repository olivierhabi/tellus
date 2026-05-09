import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { GatekeeperService } from "../../../src/services/gatekeeperService";
import { ProjectReferenceService } from "../../../src/services/projectReferenceService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const gk = new GatekeeperService(pool);
const refs = new ProjectReferenceService(pool);
const tag = `b6-06-${randomUUID()}`;
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
let userId: string;
let p1Id: string;
let p2Id: string;
let p1Rid: string;
let p2Rid: string;
let dsRid: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, DEFAULT_ORG]);

  const r1 = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p1`, userId]);
  p1Id = r1.rows[0].id;
  p1Rid = `ri.compass.main.project.${p1Id}`;
  const r2 = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p2`, userId]);
  p2Id = r2.rows[0].id;
  p2Rid = `ri.compass.main.project.${p2Id}`;
  for (const [rid, projId] of [[p1Rid, p1Id], [p2Rid, p2Id]] as const) {
    await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
      VALUES ($1,'compass','PROJECT','p',NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2,$3) ON CONFLICT (legacy_uuid) DO NOTHING`,
      [rid, userId, projId]);
    await pool.query(`INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rid, DEFAULT_ORG]);
  }
  // Owner role on p1 only
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2) ON CONFLICT DO NOTHING`,
    [p1Rid, userId],
  );
  // Dataset belongs to p2 (no grant for user there)
  dsRid = `ri.compass.main.dataset.${tag}-ds`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by)
    VALUES ($1,'compass','FOUNDRY_DATASET','ds',NULL,$2,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3) ON CONFLICT (rid) DO NOTHING`,
    [dsRid, p2Rid, userId]);
  // p1 references ds in p2
  await refs.addReference(p1Rid, dsRid);
  gk.clearCache();
});

afterAll(async () => {
  await pool.query(`DELETE FROM project_references WHERE owner_project_rid = $1`, [p1Rid]);
  await pool.query(`DELETE FROM resources WHERE rid IN ($1,$2,$3)`, [p1Rid, p2Rid, dsRid]);
  await pool.query(`DELETE FROM project_organizations WHERE project_rid IN ($1,$2)`, [p1Rid, p2Rid]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid IN ($1,$2)`, [p1Rid, p2Rid]);
  await pool.query(`DELETE FROM project_members WHERE project_id IN ($1,$2)`, [p1Id, p2Id]);
  await pool.query(`DELETE FROM projects WHERE id IN ($1,$2)`, [p1Id, p2Id]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B6.06 — cross-project visibility", () => {
  it("evaluate(view ds) → DENY (no direct grant on p2)", async () => {
    gk.clearCache();
    const r = await gk.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: dsRid });
    expect(r.decision).toBe("DENY");
  });
  it("evaluateWithReferences(view ds) → ALLOW (referenced by p1 where user has owner)", async () => {
    gk.clearCache();
    const r = await gk.evaluateWithReferences({ principalId: userId, operationId: "compass:view-resource", resourceRid: dsRid });
    expect(r.decision).toBe("ALLOW");
  });
  it("evaluateWithReferences(edit ds) → DENY (edit not view-shaped)", async () => {
    gk.clearCache();
    const r = await gk.evaluateWithReferences({ principalId: userId, operationId: "compass:edit-resource", resourceRid: dsRid });
    expect(r.decision).toBe("DENY");
  });
});
