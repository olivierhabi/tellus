// B1 load probe — measures getResource and getResourcesBatch latencies
// against the live Postgres test stack. Targets per contracts.md:
//   B1-C-50: getResource          p95 < 30 ms
//   B1-C-51: getResourcesBatch    p95 < 200 ms (batch=1000)
//
// Workload: 100 RPS sustained for 10s (warm cache).
import { Pool } from 'pg';
import { performance } from 'perf_hooks';
import { getResource, getResourcesBatch } from '../src/services/compassService';
import type { Rid } from '../src/lib/rid';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'tellus',
  password: process.env.PGPASSWORD || 'tellus123',
  database: process.env.PGDATABASE || 'tellus_db',
  max: 20,
});

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

async function main() {
  // Pull a sample of real RIDs from the live DB.
  const { rows } = await pool.query<{ rid: string }>(
    `SELECT rid FROM resources WHERE type IN ('PROJECT','COMPASS_FOLDER','FOUNDRY_DATASET') ORDER BY rid LIMIT 1000`,
  );
  if (rows.length === 0) throw new Error('no resource rows; run migrate first');
  const rids = rows.map((r) => r.rid as Rid);
  console.log(`[setup] sampled ${rids.length} live RIDs`);

  // -----------------------------------------------------------------------
  // Warm-up (5 s)
  // -----------------------------------------------------------------------
  const warmUntil = performance.now() + 5000;
  while (performance.now() < warmUntil) {
    await getResource(rids[Math.floor(Math.random() * rids.length)]);
  }

  // -----------------------------------------------------------------------
  // Probe 1: getResource at 100 RPS for 10 s
  // -----------------------------------------------------------------------
  const samplesA: number[] = [];
  const startA = performance.now();
  const endA = startA + 10_000;
  let nextDispatch = startA;
  const interval = 1000 / 100; // 10 ms per request
  const inflight: Promise<void>[] = [];
  while (performance.now() < endA) {
    if (performance.now() >= nextDispatch) {
      nextDispatch += interval;
      const rid = rids[Math.floor(Math.random() * rids.length)];
      const t0 = performance.now();
      inflight.push(
        getResource(rid).then(() => {
          samplesA.push(performance.now() - t0);
        }),
      );
    } else {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  await Promise.all(inflight);
  const p50A = pct(samplesA, 50);
  const p95A = pct(samplesA, 95);
  const p99A = pct(samplesA, 99);
  console.log(
    `[B1-C-50] getResource n=${samplesA.length}  p50=${p50A.toFixed(2)}ms  p95=${p95A.toFixed(2)}ms  p99=${p99A.toFixed(2)}ms  target=p95<30ms`,
  );
  const passA = p95A < 30;

  // -----------------------------------------------------------------------
  // Probe 2: getResourcesBatch (size 1000) — 50 iterations
  // -----------------------------------------------------------------------
  const samplesB: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await getResourcesBatch(rids);
    samplesB.push(performance.now() - t0);
  }
  const p50B = pct(samplesB, 50);
  const p95B = pct(samplesB, 95);
  const p99B = pct(samplesB, 99);
  console.log(
    `[B1-C-51] getResourcesBatch(${rids.length}) n=${samplesB.length}  p50=${p50B.toFixed(2)}ms  p95=${p95B.toFixed(2)}ms  p99=${p99B.toFixed(2)}ms  target=p95<200ms`,
  );
  const passB = p95B < 200;

  await pool.end();

  console.log('---');
  console.log(`B1-C-50 (getResource p95<30ms):       ${passA ? 'PASS' : 'FAIL'}`);
  console.log(`B1-C-51 (getResourcesBatch p95<200ms): ${passB ? 'PASS' : 'FAIL'}`);
  process.exit(passA && passB ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
