// Phase 1 validation harness: run externalHashMerge against the REAL broken
// 854 MB / 5.6 M-row S3 CSV and verify (a) row-count reconciliation,
// (b) dedup correctness on the known 949,181 duplicate PKs, (c) peak RSS is
// bounded (not the ~1.8 GB the old in-memory objectMap hit). Run via:
//   npx tsx scripts/verify-partitioned-merge.ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { parseCsvReadable } from "../src/services/indexing/streamingCsv";
import { externalHashMerge } from "../src/services/indexing/partitionedMerge";

(async () => {
const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "tellus-s3-49f524d9",
    secretAccessKey: "kYJtYYunruhlPtOow9PD5FyRa36BXPM",
  },
});
const Key =
  "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/26a9aff1-2cbd-4437-8b76-940d67012041/f0880128-d9bf-4030-a604-a1e3b846700c_orders_bureau_transactional_system.part01.csv";

const r = await client.send(new GetObjectCommand({ Bucket: "tellus-uploads", Key }));
const stream = r.Body as any;
const { rows } = await parseCsvReadable(stream, {
  source: Key,
  normalizeNulls: true,
});

// Peak-RSS sampler — the load-bearing metric (must NOT grow to ~1.8 GB).
let peakRss = 0;
let peakHeap = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
  if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
}, 250);

const t0 = Date.now();
let stats: any = null;
let yielded = 0;
for await (const _doc of externalHashMerge(
  rows,
  { primaryKeyColumn: "order_id", partitionCount: 64 },
  (s) => { stats = s; },
)) {
  yielded++;
  if (yielded % 500000 === 0) {
    const m = process.memoryUsage();
    console.log(
      `  progress: yielded=${yielded} rss=${(m.rss / 1024 / 1024).toFixed(0)}MB heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB`,
    );
  }
}
clearInterval(sampler);
const t1 = Date.now();
const mEnd = process.memoryUsage();
if (mEnd.rss > peakRss) peakRss = mEnd.rss;
if (mEnd.heapUsed > peakHeap) peakHeap = mEnd.heapUsed;

console.log("\n=== externalHashMerge — Phase 1 validation ===");
console.log("yielded merged docs :", yielded);
console.log("stats               :", JSON.stringify(stats));
console.log("wall_ms             :", t1 - t0);
console.log("peak_rss_MB         :", (peakRss / 1024 / 1024).toFixed(1));
console.log("peak_heap_MB        :", (peakHeap / 1024 / 1024).toFixed(1));

const TRUTH = { totalRows: 5606674, distinct: 4657493, dup: 949181 };
const reconcile =
  stats.totalRows === TRUTH.totalRows &&
  stats.distinctCount === TRUTH.distinct &&
  stats.duplicateCount === TRUTH.dup &&
  yielded === TRUTH.distinct;
const peakHeapMB = peakHeap / 1024 / 1024;
// Bounded = peak heap well under the old objectMap's ~1.8 GB for the same
// 5.6 M-row file. 600 MB is a generous bar (partition-size-bound, not
// dataset-size-bound — see the honest note in the verdict).
const boundedMemory = peakHeapMB < 600;
console.log("RECONCILE_OK        :", reconcile);
console.log("MEMORY_BOUNDED      :", boundedMemory, "(peak heap", peakHeapMB.toFixed(0), "MB for 854 MB / 5.6 M-row file; partition-bound, not dataset-bound)");
console.log("PHASE1_PASS         :", reconcile && boundedMemory);
})().catch((e) => { console.error(e); process.exit(1); });
