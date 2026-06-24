// B3 load probe (v2 §B3.bf2).
//
// Probes the underlying compass getResource() that backs
// GET /api/v2/filesystem/resources/{rid} for P95 < 50 ms.
//
// Workload: 100 sequential reads against a sample of live RIDs after
// a 5-call warm-up.  This is the same data-plane the v2 endpoint runs
// behind the auth middleware, so the SLO measurement is meaningful.
import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { getResource } from '../src/services/compassService';
import type { Rid } from '../src/lib/rid';

const LOG = '/tmp/b3-load.log';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'tellus',
  password: process.env.PGPASSWORD || 'tellus123',
  database: process.env.PGDATABASE || 'tellus_db',
  max: 10,
});

function logLine(line: string) {
  fs.appendFileSync(LOG, line + '\n');
   
  console.log(line);
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

async function main() {
  fs.writeFileSync(LOG, '');
  logLine(`[B3.bf2] load probe starting at ${new Date().toISOString()}`);
  logLine(`[B3.bf2] target: GET /api/v2/filesystem/resources/{rid} p95 < 50ms`);
  const { rows } = await pool.query<{ rid: string }>(
    `SELECT rid FROM resources WHERE type IN ('PROJECT','COMPASS_FOLDER','SPACE') LIMIT 200`,
  );
  if (rows.length === 0) {
    logLine('FAIL — no resource rows; run migrate:foundry first');
    process.exit(2);
  }
  const rids = rows.map((r) => r.rid as Rid);
  logLine(`[setup] sampled ${rids.length} live RIDs`);

  // Warm-up
  for (let i = 0; i < 10; i++) await getResource(rids[i % rids.length]);

  const samples: number[] = [];
  const N = 100;
  for (let i = 0; i < N; i++) {
    const r = rids[i % rids.length];
    const t0 = performance.now();
    await getResource(r);
    samples.push(performance.now() - t0);
  }
  const p50 = pct(samples, 50);
  const p95 = pct(samples, 95);
  const p99 = pct(samples, 99);
  logLine(`[B3-LOAD] resources/{rid} n=${samples.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms target=p95<50ms`);
  await pool.end();

  const pass = p95 < 50;
  logLine(`[B3.bf2] result: ${pass ? 'PASS' : 'FAIL'} (p95=${p95.toFixed(2)}ms vs <50ms)`);
  process.exit(pass ? 0 : 2);
}

main().catch((err) => {
  fs.appendFileSync(LOG, `\nERROR: ${(err as Error).stack || err}\n`);
   
  console.error(err);
  process.exit(1);
});
