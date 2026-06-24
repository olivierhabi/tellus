// B5.08 — trash load probe (P95 < 100 ms for trash on 100-row tree).
import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { TrashService } from '../src/services/trashService';
const LOG = '/tmp/b5-load.log';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'tellus', password: process.env.PGPASSWORD || 'tellus123',
  database: process.env.PGDATABASE || 'tellus_db',
});
function logLine(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
async function main() {
  fs.writeFileSync(LOG,'');
  logLine(`[B5.08] trash load probe ${new Date().toISOString()}`);
  const svc = new TrashService(pool);
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x','b5-load') RETURNING id`, [`b5-load-${randomUUID()}@x`]);
  const userId = u.rows[0].id;
  const samples: number[] = [];
  const created: string[] = [];
  for (let i = 0; i < 20; i++) {
    const p = await pool.query<{ id: string }>(`INSERT INTO projects (name,owner_id) VALUES ($1,$2) RETURNING id`, [`b5l-${randomUUID()}`, userId]);
    const projectRid = `ri.compass.main.project.${p.rows[0].id}`;
    await pool.query(`INSERT INTO resources (rid,service,type,display_name,parent_folder_rid,project_rid,space_rid,created_by,updated_by,legacy_uuid) VALUES ($1,'compass','PROJECT','p',NULL,$1,'ri.compass.main.space.00000000-0000-0000-0000-000000000000',$2,$2,$3) ON CONFLICT (legacy_uuid) DO NOTHING`, [projectRid, userId, p.rows[0].id]);
    const t0 = performance.now();
    await svc.trash(projectRid, userId);
    samples.push(performance.now() - t0);
    created.push(projectRid);
  }
  for (const rid of created) await svc.permanentlyDelete(rid);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
  const p95 = pct(samples, 95);
  logLine(`[B5-LOAD] trash n=${samples.length} p95=${p95.toFixed(2)}ms target=p95<100ms`);
  const pass = p95 < 100;
  logLine(`[B5.08] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
