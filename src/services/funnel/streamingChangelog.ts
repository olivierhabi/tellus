// ---------------------------------------------------------------------------
// Streaming Changelog — Task B4 (streaming branch)
//
// The batch `computeChangelog` activity in changelogStage.ts handles
// snapshot-diff sources. Streaming sources (Kafka-fed CDC feeds) need a
// long-running consumer that checkpoints Kafka offsets and the Iceberg
// snapshot atomically, so a crash after Kafka commit but before Iceberg
// commit (or vice-versa) cannot drop or duplicate a change.
//
// The atomicity trick from the spec:
//   "commit Kafka offsets into the Iceberg table's snapshot summary so
//    checkpoint and dataset commit are atomic."
//
// That is: we never call `consumer.commitOffsets()`. Instead, each time
// we flush a batch we write a new Iceberg snapshot whose `summary_json`
// contains `kafka_offsets: {partition: offset, …}`. On startup we read
// the latest snapshot, extract the offsets, and seek the consumer to
// (offset + 1) per partition. The Iceberg snapshot commit is the
// checkpoint. A crash replays from the last committed snapshot with
// exactly-once semantics at the snapshot granularity.
//
// Throughput cap: inherited from changelogStage via ThroughputGuard —
// 2 MiB/s per Object Type per spec.
// ---------------------------------------------------------------------------

import {
  Kafka,
  type Consumer,
  type EachBatchPayload,
  logLevel,
} from "kafkajs";
import { query } from "../../db";
import {
  ChangelogRow,
  ComputeChangelogResult,
  DEFAULT_THROUGHPUT_CAP,
  SourceChangeRow,
  ThroughputGuard,
} from "./changelogStage";
import {
  commitSnapshot,
  funnelNamespace,
  getTable,
  getLatestSnapshot,
  type ManifestEntry,
} from "./icebergCatalog";

export interface StreamingChangelogInput {
  ontologyId: string;
  objectTypeApiName: string;
  datasourceId: string;
  /** Kafka topic the CDC source publishes to — one per datasource. */
  sourceTopic: string;
  /** Commit a new snapshot after either N rows or T ms, whichever hits first. */
  flushRows?: number;
  flushIntervalMs?: number;
  throughputCapBytesPerSec?: number;
  /** Max duration before the activity voluntarily exits for workflow
   *  continue-as-new. Defaults to 55 minutes so Temporal's 1h activity
   *  timeout is never hit. */
  heartbeatExitAfterMs?: number;
}

export interface StreamingChangelogHandle {
  stop(): Promise<void>;
  /** Committed snapshots in the order they were produced. */
  commits: ComputeChangelogResult[];
}

export interface CdcMessage {
  primary_key: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  properties: Record<string, unknown>;
  source_transaction_id: string;
  source_commit_timestamp: string;
}

/**
 * Spin up a Kafka consumer for the CDC topic and checkpoint into the
 * Iceberg snapshot summary. Returns a handle the caller can `stop()` —
 * under Temporal this is called on cancellation.
 */
export async function runStreamingChangelog(
  input: StreamingChangelogInput
): Promise<StreamingChangelogHandle> {
  const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
  // F-P4-06: pin consumer-side timeouts too. Unbounded heartbeats let a
  // wedged coordinator stall the streaming changelog indefinitely and
  // mask the failure as "just slow".
  const kafka = new Kafka({
    clientId: `tellus-funnel-changelog-${input.objectTypeApiName}`,
    brokers,
    logLevel: logLevel.ERROR,
    retry: { retries: 5, initialRetryTime: 200, maxRetryTime: 2000 },
    connectionTimeout: 2000,
    requestTimeout: 10000,
  });

  const groupId = `funnel.${input.objectTypeApiName}.changelog.${input.datasourceId}`;
  const consumer: Consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: input.sourceTopic, fromBeginning: false });

  // Resolve the changelog table. The streaming workflow is responsible
  // for ensuring the table already exists via the dispatcher; here we
  // only look it up.
  const namespace = funnelNamespace(input.objectTypeApiName, "changelog");
  const table = await getTable(namespace, input.datasourceId);
  if (!table) {
    await consumer.disconnect();
    throw new Error(
      `streaming changelog: table ${namespace}.${input.datasourceId} not registered`
    );
  }
  const changelogTableId = table.dataset_table_id;

  // Seek to the offsets committed in the latest Iceberg snapshot so
  // checkpoint and dataset state are in lockstep. No offsets → start
  // from the broker's current high-water (fromBeginning=false above).
  const resumeOffsets = await loadOffsetsFromSnapshot(changelogTableId);
  if (resumeOffsets) {
    for (const [partition, offset] of Object.entries(resumeOffsets)) {
      consumer.seek({
        topic: input.sourceTopic,
        partition: Number(partition),
        offset: String(Number(offset) + 1),
      });
    }
  }

  const throughput = new ThroughputGuard(
    input.throughputCapBytesPerSec ?? DEFAULT_THROUGHPUT_CAP
  );

  const flushRows = input.flushRows ?? 5000;
  const flushIntervalMs = input.flushIntervalMs ?? 5000;
  const exitAfterMs = input.heartbeatExitAfterMs ?? 55 * 60 * 1000;

  const pending: ChangelogRow[] = [];
  const offsetBuffer = new Map<number, string>();
  const commits: ComputeChangelogResult[] = [];
  const startedAt = Date.now();

  let resolveStopped: () => void;
  const stopped = new Promise<void>((res) => (resolveStopped = res));
  let stopping = false;

  const maybeFlush = async () => {
    if (pending.length === 0) return;
    const rows = pending.splice(0, pending.length);
    const offsets = Object.fromEntries(offsetBuffer.entries());
    offsetBuffer.clear();
    const result = await commitStreamingBatch({
      table_id: changelogTableId,
      datasource_id: input.datasourceId,
      rows,
      kafkaOffsets: offsets,
    });
    // B4 spec rule: update the watermark so the dispatcher can detect
    // lag and so the B9 replacement auto-trigger can compare volumes.
    await query(
      `INSERT INTO funnel_changelog_watermark
         (ontology_id, object_type_api_name, source_datasource_id,
          last_from_snapshot_id, last_to_snapshot_id, last_run_at, last_rows_emitted)
       VALUES ($1, $2, $3, NULL, $4, now(), $5)
       ON CONFLICT (ontology_id, object_type_api_name, source_datasource_id) DO UPDATE SET
         last_to_snapshot_id = EXCLUDED.last_to_snapshot_id,
         last_run_at         = now(),
         last_rows_emitted   = EXCLUDED.last_rows_emitted`,
      [
        input.ontologyId,
        input.objectTypeApiName,
        input.datasourceId,
        result.snapshotId,
        rows.length,
      ]
    );
    commits.push(result);
  };

  const periodicFlushTimer = setInterval(() => {
    void maybeFlush().catch((err) => {
      console.warn(
        `[streamingChangelog] periodic flush failed: ${(err as Error).message}`
      );
    });
  }, flushIntervalMs);

  // eachBatch so we can inspect partition+offset and treat the whole
  // batch atomically. We do NOT call resolveOffset — the Iceberg
  // snapshot is our offset store.
  void consumer
    .run({
      autoCommit: false,
      eachBatch: async (payload: EachBatchPayload) => {
        const { batch, heartbeat, isRunning, isStale } = payload;
        for (const msg of batch.messages) {
          if (!isRunning() || isStale()) return;
          if (Date.now() - startedAt > exitAfterMs) {
            // Let the workflow continue-as-new — flush and exit.
            await maybeFlush();
            resolveStopped();
            return;
          }
          const payloadStr = msg.value ? msg.value.toString("utf8") : "";
          if (!payloadStr) continue;
          let parsed: CdcMessage | null = null;
          try {
            parsed = JSON.parse(payloadStr) as CdcMessage;
          } catch {
            continue;
          }
          if (!parsed.primary_key || !parsed.operation) continue;
          const byteSize = Buffer.byteLength(payloadStr, "utf8");
          await throughput.consume(byteSize);

          const row: SourceChangeRow = {
            primary_key: String(parsed.primary_key),
            operation: parsed.operation,
            properties: parsed.properties ?? {},
            source_transaction_id: String(parsed.source_transaction_id ?? ""),
            source_commit_timestamp: String(parsed.source_commit_timestamp ?? ""),
            byte_size: byteSize,
          };
          pending.push({
            primary_key: row.primary_key,
            operation: row.operation,
            properties: row.properties,
            source_transaction_id: row.source_transaction_id,
            source_commit_timestamp: row.source_commit_timestamp,
          });
          offsetBuffer.set(batch.partition, msg.offset);

          if (pending.length >= flushRows) {
            await maybeFlush();
          }
          await heartbeat();
        }
        // One flush at end of batch keeps max checkpoint lag bounded by
        // a single Kafka batch even if flushRows is never hit.
        if (pending.length > 0) {
          await maybeFlush();
        }
      },
    })
    .catch((err) => {
      console.error(
        `[streamingChangelog] consumer loop failed: ${(err as Error).message}`
      );
    });

  return {
    commits,
    async stop(): Promise<void> {
      if (stopping) return stopped;
      stopping = true;
      clearInterval(periodicFlushTimer);
      try {
        await maybeFlush();
      } finally {
        await consumer.disconnect();
        resolveStopped();
      }
      return stopped;
    },
  };
}

async function commitStreamingBatch(args: {
  table_id: string;
  datasource_id: string;
  rows: ChangelogRow[];
  kafkaOffsets: Record<string, string>;
}): Promise<ComputeChangelogResult> {
  const manifest: ManifestEntry[] = [
    {
      file_path: `kafka://streaming/${args.datasource_id}/${Date.now()}`,
      file_size_bytes: 0,
      row_count: args.rows.length,
      operation: "added",
    },
  ];
  const snapshot = await commitSnapshot({
    tableId: args.table_id,
    operation: "append",
    manifest,
    summary: {
      source_datasource_id: args.datasource_id,
      rows_emitted: args.rows.length,
      // Spec-critical: offsets embedded IN the snapshot summary make
      // the Kafka checkpoint and Iceberg commit atomic.
      kafka_offsets: args.kafkaOffsets,
    },
  });
  return {
    snapshotId: snapshot.snapshot_id,
    rowsEmitted: args.rows.length,
    manifest,
    rows: args.rows,
  };
}

async function loadOffsetsFromSnapshot(
  tableId: string
): Promise<Record<string, string> | null> {
  const head = await getLatestSnapshot(tableId);
  if (!head) return null;
  const offsets = (head.summary_json as Record<string, unknown>)?.kafka_offsets;
  if (offsets && typeof offsets === "object") {
    return offsets as Record<string, string>;
  }
  return null;
}
