import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ResourceGraphService } from '../src/services/resourceGraphService';
const LOG = '/tmp/b6-load.log';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'tellus', password: process.env.PGPASSWORD || 'tellus123',
  database: process.env.PGDATABASE || 'tellus_db',
});
function log(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
async function main() {
  fs.writeFileSync(LOG, '');
  log(`[B6.08] graph load probe ${new Date().toISOString()}`);
  const svc = new ResourceGraphService(pool);
  const tag = `b6-load-${randomUUID()}`;
  const rids: string[] = [];
  for (let i = 0; i < 50; i++) rids.push(`ri.compass.main.dataset.${tag}-${i}`);
  for (let i = 0; i < rids.length - 1; i++) await svc.addEdge(rids[i], rids[i+1]);
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await svc.getLineage(rids[Math.floor(Math.random() * rids.length)]);
    samples.push(performance.now() - t0);
  }
  const p95 = pct(samples, 95);
  log(`[B6-LOAD] getLineage n=${samples.length} p95=${p95.toFixed(2)}ms target=p95<150ms`);
  await pool.query(`DELETE FROM resource_dependencies WHERE upstream_rid = ANY($1::text[]) OR downstream_rid = ANY($1::text[])`, [rids]);
  await pool.end();
  const pass = p95 < 150;
  log(`[B6.08] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
