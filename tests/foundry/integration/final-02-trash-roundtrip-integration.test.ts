import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { TrashService } from "../../../src/services/trashService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new TrashService(pool);
const tag = `final02_${randomUUID()}`;
const ROOT_SPACE = "ri.compass.main.space.00000000-0000-0000-0000-000000000000";
let userId: string;
let projectId: string;
let projectRid: string;
let f1: string;
let f2: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p`, userId]);
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
    VALUES ($1,'compass','PROJECT',$2,NULL,$1,$3,$4,$4,$5) ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${tag}-p`, ROOT_SPACE, userId, projectId]);
  f1 = `ri.compass.main.folder.${randomUUID()}`;
  f2 = `ri.compass.main.folder.${randomUUID()}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by) VALUES
    ($1,'compass','COMPASS_FOLDER','f1',$2,$2,$3,$4,$4),
    ($5,'compass','COMPASS_FOLDER','f2',$1,$2,$3,$4,$4) ON CONFLICT (rid) DO NOTHING`,
    [f1, projectRid, ROOT_SPACE, userId, f2]);
});
afterAll(async () => {
  await pool.query(`DELETE FROM resources WHERE rid IN ($1,$2,$3)`, [projectRid, f1, f2]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("FINAL.02 — trash → restore → permanently delete round-trip", () => {
  it("step 1: trash f1 cascades to f2", async () => {
    const r = await svc.trash(f1, userId);
    expect(r.affected).toBe(2);
  });
  it("step 2: f1 + f2 are TRASHED", async () => {
    const { rows } = await pool.query(`SELECT trash_status FROM resources WHERE rid IN ($1,$2)`, [f1, f2]);
    expect(rows.every((r: any) => r.trash_status !== 'NOT_TRASHED')).toBe(true);
  });
  it("step 3: restore brings them both back", async () => {
    const r = await svc.restore(f1, userId);
    expect(r.affected).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT trash_status FROM resources WHERE rid IN ($1,$2)`, [f1, f2]);
    expect(rows.every((r: any) => r.trash_status === 'NOT_TRASHED')).toBe(true);
  });
  it("step 4: trash again + permanently delete removes the rows", async () => {
    await svc.trash(f1, userId);
    const r = await svc.permanentlyDelete(f1);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT rid FROM resources WHERE rid IN ($1,$2)`, [f1, f2]);
    expect(rows.length).toBe(0);
  });
});
