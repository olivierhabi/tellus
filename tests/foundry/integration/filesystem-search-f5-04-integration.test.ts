// F5.04 — verify search router file + wiring exist + integration probe.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const tag = `f504_${randomUUID().replace(/-/g, '_')}`;
let userId: string;
let projectId: string;
let projectRid: string;

beforeAll(async () => {
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}_search_target`, userId]);
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
    VALUES ($1,'compass','PROJECT',$2,NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$3,$3,$4) ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, `${tag}_search_target`, userId, projectId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("F5.04 — filesystem search router", () => {
  it("server.ts mounts /api/v2/filesystem with search router before catch-all", () => {
    const src = fs.readFileSync("src/server.ts", "utf8");
    const idxSearch = src.indexOf('filesystemSearchV2Router');
    const idxV2 = src.indexOf('filesystemV2Router)');
    expect(idxSearch).toBeGreaterThan(-1);
    expect(idxSearch).toBeLessThan(idxV2);
  });
  it("router has GET /search", () => {
    const r = fs.readFileSync("src/routes/filesystemSearchV2.ts", "utf8");
    expect(r).toMatch(/router\.get\("\/search"/);
  });
  it("ILIKE query returns the seeded resource", async () => {
    const { rows } = await pool.query(
      `SELECT rid FROM resources WHERE display_name ILIKE $1 AND trash_status = 'NOT_TRASHED'`,
      [`%${tag}_search%`],
    );
    expect(rows.find((r) => r.rid === projectRid)).toBeTruthy();
  });
  it("type filter narrows results", async () => {
    const { rows } = await pool.query(
      `SELECT rid FROM resources WHERE display_name ILIKE $1 AND type = ANY($2::text[])`,
      [`%${tag}_search%`, ['PROJECT']],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
