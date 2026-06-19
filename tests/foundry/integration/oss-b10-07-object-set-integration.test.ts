import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ObjectSetService } from "../../../src/services/oss/objectSetService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const svc = new ObjectSetService(pool);
const tag = `b10-07-${randomUUID()}`;
let userId: string;
let projectRid: string;
let projectId: string;
const savedRids: string[] = [];

beforeAll(async () => {
  await pool.query('SELECT 1');
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x',$2) RETURNING id`, [`${tag}@x`, tag]);
  userId = u.rows[0].id;
  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`${tag}-p`, userId]);
  projectId = p.rows[0].id;
  projectRid = `ri.compass.main.project.${projectId}`;
  await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid)
    VALUES ($1,'compass','PROJECT','p',NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2,$3) ON CONFLICT (legacy_uuid) DO NOTHING`,
    [projectRid, userId, projectId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM resources WHERE rid = ANY($1::text[])`, [savedRids]);
  await pool.query(`DELETE FROM resources WHERE rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM role_grants WHERE resource_rid = $1`, [projectRid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B10.07 — object set CRUD", () => {
  it("save returns a persisted SavedObjectSet", async () => {
    const r = await svc.save({
      actorId: userId,
      parentFolderRid: projectRid,
      displayName: 'Active employees',
      request: {
        ontologyRid: 'ri.ontology.main.ontology.default',
        objectType: 'employee',
        filter: { kind: 'term', field: 'status', operator: 'eq', value: 'ACTIVE' },
      },
    });
    savedRids.push(r.rid);
    expect(r.rid).toMatch(/^ri\.compass\.main\.object-set\./);
    expect(r.objectType).toBe('employee');
  });

  it("get round-trips the IR", async () => {
    const rid = savedRids[0];
    const r = await svc.get(rid);
    expect(r?.objectType).toBe('employee');
    expect((r?.query as any).filter.value).toBe('ACTIVE');
  });

  it("save with invalid IR throws INVALID_ARGUMENT", async () => {
    await expect(svc.save({
      actorId: userId, parentFolderRid: projectRid, displayName: 'bad',
      request: { ontologyRid: '', objectType: 'y' },
    })).rejects.toThrow(/INVALID_ARGUMENT/);
  });

  it("save with missing parent → PARENT_NOT_FOUND", async () => {
    await expect(svc.save({
      actorId: userId, parentFolderRid: 'ri.compass.main.folder.ghost', displayName: 'x',
      request: { ontologyRid: 'x', objectType: 'y' },
    })).rejects.toThrow(/PARENT_NOT_FOUND/);
  });

  it("get on non-existent rid returns null", async () => {
    const r = await svc.get('ri.compass.main.object-set.ghost');
    expect(r).toBeNull();
  });
});
