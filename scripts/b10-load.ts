// B10.10 — OSS load probe: P95 < 50 ms for compileSearch + executeFn round-trip.
import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { OssService } from '../src/services/oss/ossService';
const LOG = '/tmp/b10-load.log';
function log(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
function pct(arr: number[], p: number) { const s = arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; }
async function main() {
  fs.writeFileSync(LOG, '');
  log(`[B10.10] OSS load probe ${new Date().toISOString()}`);
  const svc = new OssService();
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    await svc.load({
      ontologyRid: 'ri.ontology.main.ontology.default', objectType: 'employee', pageSize: 50,
      filter: { kind: 'and', filters: [
        { kind: 'term', field: 'status', operator: 'eq', value: 'ACTIVE' },
        { kind: 'range', field: 'age', gte: 18, lt: 65 },
      ]},
    } as any, async () => ({ hits: Array.from({ length: 50 }, (_, j) => ({ _id: `id-${j}`, _source: { name: `User ${j}` } })), total: 50 }));
    samples.push(performance.now() - t0);
  }
  const p95 = pct(samples, 95);
  log(`[B10-LOAD] OssService.load n=${samples.length} p95=${p95.toFixed(2)}ms target=p95<50ms`);
  const pass = p95 < 50;
  log(`[B10.10] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
