// B2 load probe — measures latency of `ProjectService.createProject` with a
// valid `spaceRid` (the data-plane behind v2 §B2.bf2's
// `POST /api/v2/filesystem/projects`). The HTTP route belongs to B3; this
// probe exercises the underlying service the route will call so the SLO
// is fixed at the data-plane layer first.
//
// Locked decision (per v2 §B2.bf2): P95 < 100 ms for createProject(spaceRid).
// Workload: 100 sequential creations against ROOT_SPACE_RID.
import foundryDb from '../src/config/foundryDb';
import { performance } from 'perf_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import { ProjectService } from '../src/services/projectService';
import { ROOT_SPACE_RID } from '../src/lib/rid';

const LOG = '/tmp/b2-load.log';

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function logLine(line: string) {
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

async function main() {
  fs.writeFileSync(LOG, '');
  logLine(`[B2.bf2] load probe starting at ${new Date().toISOString()}`);
  logLine(`[B2.bf2] target: createProject(spaceRid=${ROOT_SPACE_RID}) p95 < 100ms`);

  const probeEmail = `b2-load-${randomUUID()}@tellus.local`;
  const [user] = await foundryDb('users')
    .insert({ email: probeEmail, password_hash: 'x', display_name: 'b2-load-probe' })
    .returning(['id']);
  logLine(`[setup] probe user id=${user.id}`);

  const space = await foundryDb('spaces').where({ rid: ROOT_SPACE_RID }).first();
  if (!space) {
    logLine(`FAIL — ROOT_SPACE_RID not found in spaces; run migrate:foundry first`);
    process.exit(2);
  }

  const svc = new ProjectService(foundryDb);
  const samples: number[] = [];
  const N = 100;
  const created: string[] = [];

  for (let i = 0; i < 5; i++) {
    const p = await svc.createProject(`b2-warm-${randomUUID()}`, user.id, { spaceRid: ROOT_SPACE_RID });
    created.push(p.id);
  }

  for (let i = 0; i < N; i++) {
    const name = `b2-load-${randomUUID()}`;
    const t0 = performance.now();
    const p = await svc.createProject(name, user.id, { spaceRid: ROOT_SPACE_RID });
    const t1 = performance.now();
    samples.push(t1 - t0);
    created.push(p.id);
  }

  const p50 = pct(samples, 50);
  const p95 = pct(samples, 95);
  const p99 = pct(samples, 99);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

  logLine(`[B2-LOAD] createProject(spaceRid) n=${samples.length} avg=${avg.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms target=p95<100ms`);

  await foundryDb.transaction(async (trx) => {
    if (created.length === 0) return;
    await trx('project_members').whereIn('project_id', created).del();
    await trx('resources').whereIn('rid', created.map((id) => `ri.compass.main.project.${id}`)).del();
    await trx('projects').whereIn('id', created).del();
    await trx('users').where({ id: user.id }).del();
  });

  await foundryDb.destroy();

  const pass = p95 < 100;
  logLine(`[B2.bf2] result: ${pass ? 'PASS' : 'FAIL'} (p95=${p95.toFixed(2)}ms vs <100ms)`);
  process.exit(pass ? 0 : 2);
}

main().catch((err) => {
  fs.appendFileSync(LOG, `\nERROR: ${(err as Error).stack || err}\n`);
  console.error(err);
  process.exit(1);
});
