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
const tag = `final03_${randomUUID()}`;
const ROOT_SPACE = "ri.compass.main.space.00000000-0000-0000-0000-000000000000";
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
  p1Id = r1.rows[0].id; p1Rid = `ri.compass.main.project.${p1Id}`;
  const r2 = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p2`, userId]);
  p2Id = r2.rows[0].id; p2Rid = `ri.compass.main.project.${p2Id}`;
  for (const [rid, pid] of [[p1Rid, p1Id], [p2Rid, p2Id]] as const) {
    await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
      VALUES ($1,'compass','PROJECT','p',NULL,$1,$2,$3,$3,$4) ON CONFLICT (legacy_uuid) DO NOTHING`,
      [rid, ROOT_SPACE, userId, pid]);
    await pool.query(`INSERT INTO project_organizations (project_rid, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rid, DEFAULT_ORG]);
  }
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2) ON CONFLICT DO NOTHING`,
    [p1Rid, userId],
  );
  dsRid = `ri.compass.main.dataset.${tag}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by)
    VALUES ($1,'compass','FOUNDRY_DATASET','ds',NULL,$2,$3,$4,$4) ON CONFLICT (rid) DO NOTHING`,
    [dsRid, p2Rid, ROOT_SPACE, userId]);
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

describe("FINAL.03 — cross-project references", () => {
  it("evaluate(view ds) is DENIED (no direct grant on p2)", async () => {
    gk.clearCache();
    const r = await gk.evaluate({ principalId: userId, operationId: 'compass:view-resource', resourceRid: dsRid });
    expect(r.decision).toBe('DENY');
  });
  it("evaluateWithReferences(view ds) is ALLOWED via reference from p1", async () => {
    gk.clearCache();
    const r = await gk.evaluateWithReferences({ principalId: userId, operationId: 'compass:view-resource', resourceRid: dsRid });
    expect(r.decision).toBe('ALLOW');
  });
  it("evaluateWithReferences(edit ds) is DENIED (only read is widened)", async () => {
    gk.clearCache();
    const r = await gk.evaluateWithReferences({ principalId: userId, operationId: 'compass:edit-resource', resourceRid: dsRid });
    expect(r.decision).toBe('DENY');
  });
});
