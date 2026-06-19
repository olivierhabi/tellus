// B4.12 — gatekeeper load probe (P95 < 5 ms cached, < 50 ms uncached).
import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { GatekeeperService } from '../src/services/gatekeeperService';

const LOG = '/tmp/b4-load.log';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'tellus',
  password: process.env.PGPASSWORD || 'tellus123',
  database: process.env.PGDATABASE || 'tellus_db',
});

function logLine(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }

async function main() {
  fs.writeFileSync(LOG, '');
  logLine(`[B4.12] gatekeeper load probe ${new Date().toISOString()}`);
  const svc = new GatekeeperService(pool);
  const { rows } = await pool.query<{ rid: string }>(`SELECT rid FROM resources WHERE type='PROJECT' LIMIT 50`);
  if (rows.length === 0) { logLine('FAIL — no projects'); process.exit(2); }
  const userRow = await pool.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const userId = userRow.rows[0].id;
  const rids = rows.map(r => r.rid);

  // warm-up + uncached run
  svc.clearCache();
  const uncached: number[] = [];
  for (let i = 0; i < 50; i++) {
    svc.clearCache();
    const t0 = performance.now();
    await svc.evaluate({ principalId: userId, operationId: 'compass:view-resource', resourceRid: rids[i % rids.length] });
    uncached.push(performance.now() - t0);
  }
  // cached run
  svc.clearCache();
  await svc.evaluate({ principalId: userId, operationId: 'compass:view-resource', resourceRid: rids[0] });
  const cached: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    await svc.evaluate({ principalId: userId, operationId: 'compass:view-resource', resourceRid: rids[0] });
    cached.push(performance.now() - t0);
  }

  const cp95 = pct(cached, 95);
  const up95 = pct(uncached, 95);
  logLine(`[B4-LOAD] uncached n=${uncached.length} p95=${up95.toFixed(2)}ms target=p95<50ms`);
  logLine(`[B4-LOAD] cached n=${cached.length} p95=${cp95.toFixed(2)}ms target=p95<5ms`);
  await pool.end();
  const pass = up95 < 50 && cp95 < 5;
  logLine(`[B4.12] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
