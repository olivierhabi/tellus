import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { OmsService } from '../src/services/omsService';
const LOG = '/tmp/b8-load.log';
const pool = new Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'tellus', password: process.env.PGPASSWORD || 'tellus123', database: process.env.PGDATABASE || 'tellus_db' });
function log(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
async function main() {
  fs.writeFileSync(LOG, '');
  log(`[B8.15] OMS load probe ${new Date().toISOString()}`);
  const svc = new OmsService(pool);
  const tag = `b8load_${randomUUID().replace(/-/g, '_')}`;
  const onto = 'ri.ontology.main.ontology.default';
  const samples: number[] = [];
  const rids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = await svc.createObjectType({
      ontologyRid: onto, apiName: `${tag}_${i}`, displayName: 'L',
      primaryKeys: ['id'],
      properties: [{ apiName: 'id', displayName: 'I', dataType: 'STRING', isPrimaryKey: true }],
    });
    samples.push(performance.now() - t0);
    rids.push(r.rid);
  }
  await pool.query(`DELETE FROM object_type_properties WHERE object_type_rid = ANY($1::text[])`, [rids]);
  await pool.query(`DELETE FROM object_types WHERE rid = ANY($1::text[])`, [rids]);
  await pool.end();
  const p95 = pct(samples, 95);
  log(`[B8-LOAD] createObjectType n=${samples.length} p95=${p95.toFixed(2)}ms target=p95<200ms`);
  const pass = p95 < 200;
  log(`[B8.15] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
