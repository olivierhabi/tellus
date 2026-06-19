import { performance } from 'perf_hooks';
import * as fs from 'node:fs';
import { B9MergeChanges } from '../src/services/funnel/b9MergeChanges';
import { B9Indexer } from '../src/services/funnel/b9Indexer';
import { B9Hydrator } from '../src/services/funnel/b9Hydrator';
import type { Change } from '../src/services/funnel/b9Changelog';

const LOG = '/tmp/b9-load.log';
function log(s: string) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }

async function main() {
  fs.writeFileSync(LOG, '');
  log(`[B9.12] funnel pipeline 1M-row throughput probe ${new Date().toISOString()}`);
  const N = 1_000_000;
  const merge = new B9MergeChanges();
  const indexer = new B9Indexer();
  const hydrator = new B9Hydrator();

  const changes: Change[] = [];
  for (let i = 0; i < N; i++) {
    changes.push({ primaryKey: `pk-${i % 250000}`, operation: i % 50 === 0 ? 'DELETE' : 'UPSERT', version: i + 1, payload: { i } });
  }

  const t0 = performance.now();
  const merged = merge.merge(changes);
  const tMerge = performance.now() - t0;

  let bulkCount = 0;
  const t1 = performance.now();
  await indexer.run({ indexName: 'b9-load', changes: merged, bulkFn: async (a) => { bulkCount += a.length; return { took: 1, errors: false, itemCount: a.length }; } });
  const tIdx = performance.now() - t1;

  let hyd = 0;
  const t2 = performance.now();
  await hydrator.run({ changes: merged, applyFn: async () => { hyd++; } });
  const tHyd = performance.now() - t2;

  const total = (performance.now() - t0) / 1000;
  const opsPerSec = N / total;
  log(`[B9-LOAD] N=${N} mergedSize=${merged.length} merge=${tMerge.toFixed(0)}ms indexer=${tIdx.toFixed(0)}ms hydrator=${tHyd.toFixed(0)}ms`);
  log(`[B9-LOAD] total=${total.toFixed(2)}s ops/sec=${opsPerSec.toFixed(0)} bulkCount=${bulkCount} hyd=${hyd} target=ops_per_sec>3300`);
  const pass = opsPerSec > 3300;
  log(`[B9.12] result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 2);
}
main().catch(e => { fs.appendFileSync(LOG, `\nERROR: ${(e as Error).stack}\n`); process.exit(1); });
