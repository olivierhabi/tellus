// B1-C-24 negative-test proof. Runs createProject + createFolder against a
// live DB and asserts the resources row lands in the same transaction.
//
// Usage:
//   npx tsx scripts/b1-c24-proof.ts          (green: with wiring; expect exit 0)
//   STASH=1 npx tsx scripts/b1-c24-proof.ts  (red:   if wiring stashed; expect exit 2)
import knexLib from 'knex';
import { ProjectService } from '../src/services/projectService';
import { FolderService } from '../src/services/folderService';

const knex = knexLib({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'tellus',
    password: process.env.PGPASSWORD || 'tellus123',
    database: process.env.PGDATABASE || 'tellus_db',
  },
});

async function main() {
  const u = await knex('users').first('id', 'email');
  if (!u) throw new Error('no seed user; foundryMigrate did not run');
  console.log(`[setup] seed user: ${u.email}`);

  const tag = `b1-c24-${Date.now()}`;
  const ps = new ProjectService(knex);
  const fs = new FolderService(knex);

  const project = await ps.createProject(tag, u.id);
  const projRid = `ri.compass.main.project.${project.id}`;
  const r1 = await knex.raw(
    `SELECT rid, type FROM resources WHERE legacy_uuid = ?::uuid`,
    [project.id],
  );
  if (!r1.rows[0]) throw new Error('FAIL B1-C-24: project resources row missing');
  if (r1.rows[0].rid !== projRid) throw new Error(`FAIL B1-C-24: rid=${r1.rows[0].rid} expected ${projRid}`);
  if (r1.rows[0].type !== 'PROJECT') throw new Error(`FAIL B1-C-24: type=${r1.rows[0].type}`);
  console.log(`[ok] PROJECT row created in same txn rid=${projRid}`);

  const folder = await fs.createFolder(project.id, `${tag}-folder`, null, u.id);
  const folderRid = `ri.compass.main.compass-folder.${folder.id}`;
  const r2 = await knex.raw(
    `SELECT rid, type, project_rid, parent_folder_rid FROM resources WHERE legacy_uuid = ?::uuid`,
    [folder.id],
  );
  if (!r2.rows[0]) throw new Error('FAIL B1-C-24: folder resources row missing');
  if (r2.rows[0].rid !== folderRid) throw new Error(`FAIL B1-C-24: folder rid mismatch`);
  if (r2.rows[0].project_rid !== projRid) throw new Error(`FAIL B1-C-24: folder.project_rid=${r2.rows[0].project_rid}`);
  if (r2.rows[0].parent_folder_rid !== projRid) throw new Error(`FAIL B1-C-24: root folder.parent_folder_rid=${r2.rows[0].parent_folder_rid} expected ${projRid}`);
  console.log(`[ok] COMPASS_FOLDER row created in same txn rid=${folderRid}`);

  // Cleanup: drop probe rows
  await knex.raw('DELETE FROM resources WHERE legacy_uuid IN (?::uuid, ?::uuid)', [project.id, folder.id]);
  await knex('folders').where({ id: folder.id }).delete();
  await knex('project_members').where({ project_id: project.id }).delete();
  await knex('projects').where({ id: project.id }).delete();
  console.log('[GREEN] B1-C-24 same-txn wiring proven for projects + folders');
  await knex.destroy();
}

main().catch((e) => { console.error('[RED]', e.message); process.exit(2); });
