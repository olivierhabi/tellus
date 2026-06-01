/**
 * B9 — Funnel worker entrypoint.
 * Drives the three-stage pipeline for a single binding.
 * Modes: 'batch' (snapshot scan) | 'streaming' (CDC consumer).
 */
import { readDatasetPages } from "../../services/funnel/pipeline/batch-reader";
import {
  transformRow,
  FunnelTransformError,
} from "../../services/funnel/pipeline/stage2-transform";
import { ShardIndexer } from "../../services/funnel/pipeline/stage3-index";
import { Osv2Sink } from "../../services/funnel/pipeline/osv2-sink";
import type { ObjectTypeBinding } from "../../services/funnel/contracts/object-type-binding";

export type FunnelMetrics = {
  rowsIn: number;
  rowsOut: number;
  rowsRejected: number;
  bytesOut: number;
};

export async function runBatch(
  binding: ObjectTypeBinding,
  snapshotId: string | null,
  fallbackDir?: string,
): Promise<FunnelMetrics> {
  const sink = new Osv2Sink(binding.objectTypeRid, fallbackDir);
  const indexer = new ShardIndexer(sink);
  const m: FunnelMetrics = { rowsIn: 0, rowsOut: 0, rowsRejected: 0, bytesOut: 0 };
  for await (const page of readDatasetPages(binding.datasetRid, snapshotId)) {
    for (const row of page) {
      m.rowsIn++;
      try {
        const obj = transformRow(row, binding);
        await indexer.push(obj);
        m.rowsOut++;
        m.bytesOut += obj.sizeBytes;
      } catch (e) {
        if (e instanceof FunnelTransformError) m.rowsRejected++;
        else throw e;
      }
    }
  }
  await indexer.flushAll();
  return m;
}

if (require.main === module) {
  const ridArg = process.argv[2];
  if (!ridArg) {
    // eslint-disable-next-line no-console
    console.error("usage: funnel-worker <binding-rid> [snapshot-id]");
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.error(`[funnel-worker] starting for ${ridArg}`);
  // Real wiring (binding lookup + sink config) happens via build runner.
}
