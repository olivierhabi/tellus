// B4.11 — requirePermission middleware swap.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { requirePermission } from "../../../src/middleware/requirePermission";
import * as gateModule from "../../../src/services/gatekeeperService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

const tag = `b4-11-${randomUUID()}`;
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
     VALUES ($1, $2, 'USER', 'compass-viewer', $2) ON CONFLICT DO NOTHING`,
    [projectRid, userId],
  );
  // Make sure cache is empty so test triggers fresh evaluation.
  gateModule.gatekeeperService.clearCache();
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

describe("B4.11 — requirePermission middleware", () => {
  it("ALLOW path → next() with no args", async () => {
    const mw = requirePermission("compass:view-resource");
    const req: any = { user: { id: userId }, params: { rid: projectRid } };
    const res: any = {};
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
  });

  it("DENY path → next(err) with status 403 and reason", async () => {
    const mw = requirePermission("compass:edit-resource");
    const req: any = { user: { id: userId }, params: { rid: projectRid } };
    const res: any = {};
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(403);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.reason).toBe("OPERATION_NOT_GRANTED");
  });

  it("missing user → 401", async () => {
    const mw = requirePermission("compass:view-resource");
    const req: any = { params: { rid: projectRid } };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(next.mock.calls[0][0].status).toBe(401);
  });

  it("missing rid → 400", async () => {
    const mw = requirePermission("compass:view-resource");
    const req: any = { user: { id: userId }, params: {} };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("custom ridFrom resolver works", async () => {
    const mw = requirePermission("compass:view-resource", {
      ridFrom: (r: any) => r.body?.target,
    });
    const req: any = { user: { id: userId }, params: {}, body: { target: projectRid } };
    const next = vi.fn();
    await mw(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
  });
});
