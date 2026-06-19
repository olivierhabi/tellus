import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { BranchService } from '../src/services/branchService';
import { MergeService } from '../src/services/mergeService';
const LOG = '/tmp/b7-load.log';
const pool = new Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'tellus', password: process.env.PGPASSWORD || 'tellus123', database: process.env.PGDATABASE || 'tellus_db' });
function log(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
async function main() {
  fs.writeFileSync(LOG, '');
  log(`[B7.12] branch+merge load probe ${new Date().toISOString()}`);
  const branchSvc = new BranchService(pool);
  const merge = new MergeService(pool);
  const tag = `b7-load-${randomUUID()}`;
  const projectRid = `ri.compass.main.project.${tag}`;
  const u = await pool.query<{ id: string }>(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x','b7-load') RETURNING id`, [`b7-load-${randomUUID()}@x`]);
  const userId = u.rows[0].id;
  const samples: number[] = [];
  const branchIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const b = await branchSvc.create(projectRid, `b7-${randomUUID()}`);
    samples.push(performance.now() - t0);
    branchIds.push(b.id);
  }
  const conflictSamples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await merge.detectConflicts(branchIds[i % branchIds.length]);
    conflictSamples.push(performance.now() - t0);
  }
  const p95Branch = pct(samples, 95);
  const p95Conflict = pct(conflictSamples, 95);
  log(`[B7-LOAD] createBranch n=${samples.length} p95=${p95Branch.toFixed(2)}ms target=p95<150ms`);
  log(`[B7-LOAD] detectConflicts n=${conflictSamples.length} p95=${p95Conflict.toFixed(2)}ms target=p95<100ms`);
  await pool.query(`DELETE FROM branches WHERE id = ANY($1::uuid[])`, [branchIds]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
  const pass = p95Branch < 150 && p95Conflict < 100;
  log(`[B7.12] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
