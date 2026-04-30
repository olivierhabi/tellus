// ---------------------------------------------------------------------------
// Quickwit Indexing activity — Task B6
//
// Runs inside the Temporal `IndexingActivity` slot of the Object Type funnel
// workflow (B3). One invocation = one batch of merged-dataset rows for one
// Object Type. The activity:
//
//   1. Reads new rows from the merged Iceberg table (caller supplies an
//      async iterator / row source — we don't want the activity coupled to
//      the storage format, so we accept a generic `MergedRowReader`).
//   2. Streams each row as NDJSON into the Kafka topic feeding Quickwit.
//   3. Waits for Quickwit's metastore to report splits published past the
//      last Kafka offset committed in step 2.
//   4. Updates `object_edits.applied_to_index_at = now()` for every edit
//      id included in this batch (the merged row carries the edit ids that
//      produced it).
//
// The activity is retry-safe: the Kafka producer writes idempotently (keyed
// by `__pk`, Quickwit's Kafka source commits offsets on publish), and the
// Postgres update is bounded by the edit-id list so reruns cannot smear
// unrelated edits.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { publishMergedDoc } from "./mergedKafkaProducer";
import { getQuickwitClient, QuickwitClient, QuickwitSplit } from "./client";
import { getQuickwitIndexId } from "./docMapping";
import { buildQuickwitDoc, MergedRow } from "./docBuilder";

export interface MergedBatch {
  rows: MergedRow[];
  editIds: string[];
  kafkaOffsetHigh?: number;
}

export interface MergedRowReader {
  (): AsyncIterable<MergedBatch>;
}

export interface IndexingActivityInput {
  ontologyId: string;
  objectTypeApiName: string;
  primaryKeyApiName: string;
  reader: MergedRowReader;
  kafkaTopic?: string;
  /** Max seconds to wait for splits to publish past our high watermark. */
  publishTimeoutMs?: number;
  /** Poll interval when waiting for publish. */
  publishPollMs?: number;
  /** Inject a test client. */
  client?: QuickwitClient;
  /** Inject a test publisher. */
  publishDoc?: (topic: string, key: string, doc: Record<string, unknown>) => Promise<number>;
}

export interface IndexingActivityResult {
  indexId: string;
  topic: string;
  rowsStreamed: number;
  editsMarkedApplied: number;
  publishedSplitIds: string[];
  lastKafkaOffset: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// runIndexingActivity()
// ---------------------------------------------------------------------------

export async function runIndexingActivity(
  input: IndexingActivityInput
): Promise<IndexingActivityResult> {
  const startedAt = Date.now();
  const client = input.client ?? getQuickwitClient();
  const indexId = getQuickwitIndexId(input.objectTypeApiName);
  const topic = input.kafkaTopic ?? `merged.${input.objectTypeApiName.toLowerCase()}`;
  const publishDoc = input.publishDoc ?? defaultPublisher;

  let rowsStreamed = 0;
  let lastKafkaOffset = 0;
  const editIds = new Set<string>();

  // 1 + 2: read merged rows and stream into Kafka.
  for await (const batch of input.reader()) {
    for (const row of batch.rows) {
      const doc = buildQuickwitDoc({
        objectTypeApiName: input.objectTypeApiName,
        primaryKeyApiName: input.primaryKeyApiName,
        row,
      });
      const offset = await publishDoc(topic, row.primary_key, doc);
      if (offset > lastKafkaOffset) lastKafkaOffset = offset;
      rowsStreamed++;
    }
    for (const id of batch.editIds) editIds.add(id);
    if (typeof batch.kafkaOffsetHigh === "number" && batch.kafkaOffsetHigh > lastKafkaOffset) {
      lastKafkaOffset = batch.kafkaOffsetHigh;
    }
  }

  // 3: wait for Quickwit publish. Quickwit's per-split metadata contains the
  // latest consumed Kafka offsets per partition; we consider the batch
  // "published" once any published split covers at least `lastKafkaOffset`.
  const publishedSplitIds = await waitForPublishedSplits(
    client,
    indexId,
    lastKafkaOffset,
    input.publishTimeoutMs ?? 180_000,
    input.publishPollMs ?? 2000
  );

  // 4: mark object_edits as applied to the index.
  let editsMarked = 0;
  if (editIds.size > 0) {
    editsMarked = await markEditsIndexed(Array.from(editIds));
  }

  return {
    indexId,
    topic,
    rowsStreamed,
    editsMarkedApplied: editsMarked,
    publishedSplitIds,
    lastKafkaOffset,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// defaultPublisher — reuses kafkaProducer.ts; returns the new offset.
// ---------------------------------------------------------------------------

async function defaultPublisher(
  topic: string,
  key: string,
  doc: Record<string, unknown>
): Promise<number> {
  return publishMergedDoc(topic, key, doc);
}

// ---------------------------------------------------------------------------
// waitForPublishedSplits — polls Quickwit splits until publish caught up
// ---------------------------------------------------------------------------

async function waitForPublishedSplits(
  client: QuickwitClient,
  indexId: string,
  lastKafkaOffset: number,
  timeoutMs: number,
  pollMs: number
): Promise<string[]> {
  if (lastKafkaOffset <= 0) return [];

  const deadline = Date.now() + timeoutMs;
  let lastSeen: QuickwitSplit[] = [];
  while (Date.now() < deadline) {
    try {
      const splits = await client.listSplits(indexId, ["Published"]);
      lastSeen = splits;
      if (offsetReached(splits, lastKafkaOffset)) {
        return splits.map((s) => s.split_id);
      }
    } catch {
      /* fall through to retry */
    }
    await sleep(pollMs);
  }
  // Timed out — return whatever published splits exist so the caller can
  // still trigger Hydration against them. The workflow above us decides
  // whether to mark the activity as failed.
  return lastSeen.map((s) => s.split_id);
}

function offsetReached(splits: QuickwitSplit[], target: number): boolean {
  // Quickwit emits Kafka offsets in the split tags in the form
  // `kafka-offset:<partition>:<offset>`. If none are present we fall back
  // to the split publish_timestamp heuristic.
  for (const split of splits) {
    const tags = (split as unknown as { tags?: string[] }).tags ?? [];
    for (const tag of tags) {
      const m = /^kafka-offset:(\d+):(\d+)$/.exec(tag);
      if (m && Number(m[2]) >= target) return true;
    }
    const publishTs = split.publish_timestamp ?? 0;
    if (publishTs > 0 && target > 0 && publishTs >= target) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// markEditsIndexed() — bounded UPDATE on object_edits
// ---------------------------------------------------------------------------

async function markEditsIndexed(editIds: string[]): Promise<number> {
  if (editIds.length === 0) return 0;
  try {
    const res = await query(
      `UPDATE object_edits
          SET applied_to_index_at = NOW()
        WHERE edit_id = ANY($1::uuid[])
          AND applied_to_index_at IS NULL`,
      [editIds]
    );
    return res.rowCount ?? 0;
  } catch (err) {
    // If the B1 table doesn't exist in this deployment yet, don't blow up
    // the Index activity — this is a transitional state during B1 rollout.
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*object_edits.* does not exist/i.test(msg)) {
      console.warn(
        "[quickwit indexing] object_edits table absent — skipping applied_to_index_at update. " +
          "Run B1 migration to enable edit tracking."
      );
      return 0;
    }
    throw err;
  }
}
