/**
 * B9 Funnel — Stage 1: Extract changelog events from Iceberg snapshots / CDC stream.
 *
 * Reads incremental snapshots (since last watermark) from the Iceberg dataset that
 * backs the configured ObjectType binding, decoding the canonical changelog format
 * produced by B5/B7. Emits a stream of typed RowEvent batches to Stage 2.
 */
import { Readable } from 'node:stream';
import { getCatalog } from '../../../lib/iceberg';
import type { ChangelogRecord } from '../../funnel/streams/changelog-format';

export interface ExtractConfig {
  readonly datasetRid: string;
  readonly tableNamespace: string;
  readonly tableName: string;
  readonly sinceSnapshotId?: string;
  readonly batchSize: number;
}

export interface ExtractedBatch {
  readonly snapshotId: string;
  readonly records: ChangelogRecord[];
}

export async function* extractIncremental(
  cfg: ExtractConfig,
): AsyncGenerator<ExtractedBatch, void, void> {
  const catalog = getCatalog();
  const table = await catalog.loadTable(cfg.tableNamespace, cfg.tableName);
  const snapshots = await catalog.listSnapshots(table, { since: cfg.sinceSnapshotId });

  for (const snap of snapshots) {
    const scan = await catalog.scan(table, { snapshotId: snap.id });
    let buf: ChangelogRecord[] = [];
    for await (const row of scan) {
      buf.push(row as ChangelogRecord);
      if (buf.length >= cfg.batchSize) {
        yield { snapshotId: snap.id, records: buf };
        buf = [];
      }
    }
    if (buf.length > 0) yield { snapshotId: snap.id, records: buf };
  }
}

export function toReadable(gen: AsyncGenerator<ExtractedBatch>): Readable {
  return Readable.from(gen, { objectMode: true });
}
