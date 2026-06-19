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
const tag = `b5-06-${randomUUID()}`;
let userId: string;
let projectRid: string;
let folder1Rid: string;
let folder2Rid: string;
let projectId: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p`, userId]);
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
    VALUES ($1,'compass','PROJECT',$2,NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3,$4) ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${tag}-p`, userId, projectId]);
  folder1Rid = `ri.compass.main.folder.${randomUUID()}`;
  folder2Rid = `ri.compass.main.folder.${randomUUID()}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by) VALUES
    ($1,'compass','COMPASS_FOLDER','f1',$2,$2,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3),
    ($4,'compass','COMPASS_FOLDER','f2',$1,$2,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3)
    ON CONFLICT (rid) DO NOTHING`, [folder1Rid, projectRid, userId, folder2Rid]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM resources WHERE rid IN ($1,$2,$3)`, [projectRid, folder1Rid, folder2Rid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B5.06 — permanentlyDelete + retention", () => {
  it("refuses to delete a non-trashed resource", async () => {
    const r = await svc.permanentlyDelete(folder1Rid);
    expect(r.deleted).toBe(0);
  });

  it("trash + permanentlyDelete removes the rows", async () => {
    await svc.trash(folder1Rid, userId);
    const r = await svc.permanentlyDelete(folder1Rid);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT rid FROM resources WHERE rid IN ($1,$2)`, [folder1Rid, folder2Rid]);
    expect(rows.length).toBe(0);
  });
});
