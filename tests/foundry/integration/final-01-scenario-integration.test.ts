// FINAL.01 — End-to-end scenario 1: project + folder lifecycle.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ProjectService } from "../../../src/services/projectService";
import foundryDb from "../../../src/config/foundryDb";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `final01_${randomUUID().replace(/-/g, '_')}`;
const ROOT_SPACE = "ri.compass.main.space.00000000-0000-0000-0000-000000000000";
let userId: string;
const created: { projectIds: string[]; folderRids: string[] } = { projectIds: [], folderRids: [] };

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
});
afterAll(async () => {
  for (const rid of created.folderRids) await pool.query(`DELETE FROM resources WHERE rid = $1`, [rid]);
  for (const pid of created.projectIds) {
    await pool.query(`DELETE FROM resources WHERE rid = $1`, [`ri.compass.main.project.${pid}`]);
    await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [`ri.compass.main.project.${pid}`]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
  await foundryDb.destroy();
});

describe("FINAL.01 — project + folder lifecycle", () => {
  let projectRid: string;
  let projectId: string;

  it("creates a project and yields a Compass-faithful RID", async () => {
    const svc = new ProjectService(foundryDb);
    const proj = await svc.createProject(`${tag}-project`, userId, { spaceRid: ROOT_SPACE });
    projectId = proj.id;
    projectRid = `ri.compass.main.project.${projectId}`;
    created.projectIds.push(projectId);
    expect(projectRid).toMatch(/^ri\.compass\.main\.project\./);
    const r = await pool.query(`SELECT type, space_rid, project_rid FROM resources WHERE rid = $1`, [projectRid]);
    expect(r.rows[0].type).toBe('PROJECT');
    expect(r.rows[0].space_rid).toBe(ROOT_SPACE);
    expect(r.rows[0].project_rid).toBe(projectRid);
  });

  it("creates a folder inside the project, parented correctly", async () => {
    const folderRid = `ri.compass.main.folder.${randomUUID()}`;
    await pool.query(
      `INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by)
       VALUES ($1,'compass','COMPASS_FOLDER',$2,$3,$3,$4,$5,$5)`,
      [folderRid, `${tag}-folder`, projectRid, ROOT_SPACE, userId],
    );
    created.folderRids.push(folderRid);
    const r = await pool.query(`SELECT parent_folder_rid, project_rid FROM resources WHERE rid = $1`, [folderRid]);
    expect(r.rows[0].parent_folder_rid).toBe(projectRid);
    expect(r.rows[0].project_rid).toBe(projectRid);
  });

  it("project is the user's owner via project_members", async () => {
    const r = await pool.query(`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
    expect(r.rows[0]?.role).toBe('owner');
  });

  it("etag starts at 1 for new resources", async () => {
    const r = await pool.query<{ etag: string }>(`SELECT etag FROM resources WHERE rid = $1`, [projectRid]);
    expect(Number(r.rows[0].etag)).toBe(1);
  });
});
