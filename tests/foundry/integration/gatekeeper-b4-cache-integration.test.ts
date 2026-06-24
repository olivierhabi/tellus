// B4.10 — LRU cache + LISTEN/NOTIFY invalidation.
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
const tag = `b4-cache-${randomUUID()}`;
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
});

afterAll(async () => {
  await svc.stopInvalidationListener();
  await pool.query(`DELETE FROM project_organizations WHERE project_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.10 — gatekeeperService cache + invalidation", () => {
  it("repeated evaluate uses cache (size grows by 1)", async () => {
    svc.clearCache();
    expect(svc.cacheSize()).toBe(0);
    await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(svc.cacheSize()).toBe(1);
    await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(svc.cacheSize()).toBe(1);
  });

  it("LISTEN/NOTIFY on role_grants invalidates the cache", async () => {
    svc.clearCache();
    await svc.startInvalidationListener();
    // Initial evaluate: DENY (no grant)
    const r1 = await svc.evaluate({ principalId: userId, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r1.decision).toBe("DENY");
    expect(svc.cacheSize()).toBeGreaterThanOrEqual(1);

    // Grant editor — trigger fires NOTIFY, cache should clear
    await pool.query(
      `INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
       VALUES ($1, $2, 'USER', 'compass-editor', $2) ON CONFLICT DO NOTHING`,
      [projectRid, userId],
    );

    // Wait briefly for NOTIFY to round-trip.
    await new Promise((r) => setTimeout(r, 250));

    const r2 = await svc.evaluate({ principalId: userId, operationId: "compass:edit-resource", resourceRid: projectRid });
    expect(r2.decision).toBe("ALLOW");
  });

  it("clearCache zeroes the cache size", async () => {
    await svc.evaluate({ principalId: userId, operationId: "compass:view-resource", resourceRid: projectRid });
    expect(svc.cacheSize()).toBeGreaterThanOrEqual(1);
    svc.clearCache();
    expect(svc.cacheSize()).toBe(0);
  });
});
