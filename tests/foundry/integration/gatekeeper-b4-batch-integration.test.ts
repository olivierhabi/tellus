// B4.09 — evaluateBatch unit/integration test.
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
const tag = `b4-batch-${randomUUID()}`;
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
let userId: string;
let projectRid: string;
let projectId: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [`${tag}@x`, tag],
  );
  userId = u.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, DEFAULT_ORG]);
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
  await pool.query(
    `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     VALUES ($1, $2, 'USER', 'compass-owner', $2) ON CONFLICT DO NOTHING`,
    [projectRid, userId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.09 — evaluateBatch", () => {
  it("returns a Map keyed by principal|operation|rid", async () => {
    const inputs = [
      { principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid },
      { principalId: userId, operationId: "compass:edit-resource", resourceRid: projectRid },
    ];
    const out = await svc.evaluateBatch(inputs);
    expect(out.size).toBe(2);
    expect(out.get(`${userId}|compass:view-resource|${projectRid}`)?.decision).toBe("ALLOW");
    expect(out.get(`${userId}|compass:edit-resource|${projectRid}`)?.decision).toBe("ALLOW");
  });

  it("dedupes identical inputs", async () => {
    const inputs = Array(5).fill(0).map(() => ({
      principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid,
    }));
    const out = await svc.evaluateBatch(inputs);
    expect(out.size).toBe(1);
  });

  it("empty input → empty Map", async () => {
    const out = await svc.evaluateBatch([]);
    expect(out.size).toBe(0);
  });

  it("mix of ALLOW/DENY decisions", async () => {
    const otherUser = `00000000-0000-0000-0000-${Math.floor(Math.random()*1e12).toString().padStart(12,'0')}`;
    const out = await svc.evaluateBatch([
      { principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid },
      { principalId: otherUser, operationId: "compass:edit-resource", resourceRid: projectRid },
    ]);
    expect(out.get(`${userId}|compass:view-resource|${projectRid}`)?.decision).toBe("ALLOW");
    expect(out.get(`${otherUser}|compass:edit-resource|${projectRid}`)?.decision).toBe("DENY");
  });
});
