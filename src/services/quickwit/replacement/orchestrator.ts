// ---------------------------------------------------------------------------
// Replacement-pipeline orchestrator — Task B9
//
// Single entrypoint that the schema-change endpoint and the Indexing
// activity call into. Responsibilities:
//
//   startReplacement()   — given a new property bag, decide if a sibling
//                          index must be spun up, and if so: provision it,
//                          transition state to REPLACEMENT_BACKFILL.
//   runBackfill()        — stream the merged dataset into the sibling
//                          index (reuses B6's indexing activity shape).
//   completeBackfill()   — transition BACKFILL → SOAK.
//   approveCutover()     — consult soakMonitor; if eligible, cutover.
//   sweepRetainedIndexes() — after 48h, call finalizeCutover and drop the
//                            old Quickwit index.
// ---------------------------------------------------------------------------

import {
  beginReplacementBackfill,
  cutover,
  enterSoak,
  finalizeCutover,
  getActiveVersion,
  indexIdForVersion,
  rollback as rollbackVersion,
} from "./versionManager";
import { diffPropertyBag, shouldTriggerReplacementForVolume } from "./schemaChangeDetector";
import { evaluateSoak } from "./soakMonitor";
import { runIndexingActivity, IndexingActivityInput } from "../indexingActivity";
import {
  buildIndexConfig,
  QuickwitPropertyInput,
} from "../docMapping";
import { getQuickwitClient, QuickwitClient } from "../client";
import { query } from "../../../db";

export interface StartReplacementInput {
  objectTypeApiName: string;
  primaryKeyApiName: string;
  previousProperties: QuickwitPropertyInput[];
  nextProperties: QuickwitPropertyInput[];
  kafkaBrokers?: string[];
  kafkaTopic?: string;
  soakDays?: number;
  /** Optional: data-volume trigger (>80% rows changed in one txn). */
  volumeTrigger?: { rowsChanged: number; totalRows: number };
  /** Force replacement even if schema diff alone wouldn't require it. */
  force?: boolean;
  client?: QuickwitClient;
}

export interface StartReplacementResult {
  triggered: boolean;
  reason: string;
  newVersion?: number;
  newIndexId?: string;
}

// ---------------------------------------------------------------------------
// startReplacement()
// ---------------------------------------------------------------------------

export async function startReplacement(
  input: StartReplacementInput
): Promise<StartReplacementResult> {
  const schemaDiff = diffPropertyBag(input.previousProperties, input.nextProperties);
  const volumeVerdict = input.volumeTrigger
    ? shouldTriggerReplacementForVolume(input.volumeTrigger)
    : null;

  const triggered =
    input.force ||
    schemaDiff.replacementRequired ||
    (volumeVerdict?.shouldTrigger ?? false);

  if (!triggered) {
    return {
      triggered: false,
      reason: [
        schemaDiff.reason,
        volumeVerdict ? `volume: ${volumeVerdict.reason}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  const { newVersion } = await beginReplacementBackfill(
    input.objectTypeApiName,
    input.soakDays ?? 7
  );
  const newIndexId = indexIdForVersion(input.objectTypeApiName, newVersion);
  const client = input.client ?? getQuickwitClient();

  // Provision the sibling index in Quickwit using the *new* property bag.
  const config = buildIndexConfig({
    objectTypeApiName: input.objectTypeApiName,
    properties: input.nextProperties,
    primaryKeyApiName: input.primaryKeyApiName,
  });
  const siblingConfig = { ...config, index_id: newIndexId };
  const existing = await client.describeIndex(newIndexId);
  if (!existing) {
    await client.createIndex(siblingConfig);
    const topic = input.kafkaTopic ?? `merged.${input.objectTypeApiName.toLowerCase()}`;
    const kafkaBrokers =
      input.kafkaBrokers ??
      (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
    await client.createKafkaSource(
      newIndexId,
      `${newIndexId}-kafka`,
      topic,
      kafkaBrokers
    );
  }

  const combinedReason = [
    input.force ? "forced" : null,
    schemaDiff.replacementRequired ? `schema: ${schemaDiff.reason}` : null,
    volumeVerdict?.shouldTrigger ? `volume: ${volumeVerdict.reason}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    triggered: true,
    reason: combinedReason || "triggered",
    newVersion,
    newIndexId,
  };
}

// ---------------------------------------------------------------------------
// runBackfill() — full scan of merged dataset into the sibling index.
// Delegates to the standard Indexing activity with a pinned index id.
// ---------------------------------------------------------------------------

export interface RunBackfillInput
  extends Omit<IndexingActivityInput, "kafkaTopic"> {
  /**
   * Override topic to a backfill-specific one so the sibling's Kafka source
   * only sees the backfill stream until cutover completes.
   */
  backfillTopic?: string;
}

export async function runBackfill(
  input: RunBackfillInput
): Promise<{
  indexId: string;
  rowsStreamed: number;
  publishedSplitIds: string[];
  durationMs: number;
}> {
  const current = await getActiveVersion(input.objectTypeApiName);
  if (!current || current.pendingVersion === null) {
    throw new Error(
      `runBackfill requires pending_version; object '${input.objectTypeApiName}' is in state ${current?.state ?? "unknown"}`
    );
  }
  const pendingIndexId = indexIdForVersion(
    input.objectTypeApiName,
    current.pendingVersion
  );
  const topic =
    input.backfillTopic ??
    `merged.${input.objectTypeApiName.toLowerCase()}.backfill.v${current.pendingVersion}`;

  const result = await runIndexingActivity({
    ...input,
    kafkaTopic: topic,
  });
  return {
    indexId: pendingIndexId,
    rowsStreamed: result.rowsStreamed,
    publishedSplitIds: result.publishedSplitIds,
    durationMs: result.durationMs,
  };
}

// ---------------------------------------------------------------------------
// completeBackfill(): BACKFILL → SOAK
// ---------------------------------------------------------------------------

export async function completeBackfill(
  objectTypeApiName: string
): Promise<void> {
  await enterSoak(objectTypeApiName);
}

// ---------------------------------------------------------------------------
// approveCutover(): consult the soak monitor; if eligible, flip the alias.
// ---------------------------------------------------------------------------

export interface CutoverAttempt {
  attempted: boolean;
  performed: boolean;
  reason: string;
  diffRate: number;
}

export async function approveCutover(
  objectTypeApiName: string
): Promise<CutoverAttempt> {
  const verdict = await evaluateSoak(objectTypeApiName);
  if (!verdict.eligible) {
    return {
      attempted: true,
      performed: false,
      reason: verdict.reason,
      diffRate: verdict.diffRate,
    };
  }
  await cutover(objectTypeApiName);
  return {
    attempted: true,
    performed: true,
    reason: verdict.reason,
    diffRate: verdict.diffRate,
  };
}

export async function rollbackCutover(objectTypeApiName: string): Promise<void> {
  await rollbackVersion(objectTypeApiName);
}

// ---------------------------------------------------------------------------
// sweepRetainedIndexes(): drop old indexes whose 48h grace window elapsed.
// ---------------------------------------------------------------------------

export interface SweepResult {
  examined: number;
  droppedIndexIds: string[];
}

export async function sweepRetainedIndexes(
  client: QuickwitClient = getQuickwitClient()
): Promise<SweepResult> {
  const res = await query(
    `SELECT * FROM object_type_active_index_version
      WHERE state = 'CUTOVER_COMPLETE'
        AND old_index_retained_until IS NOT NULL
        AND old_index_retained_until <= now()`,
    []
  );
  const dropped: string[] = [];
  for (const row of res.rows) {
    const name = row.object_type_api_name as string;
    const oldVersion = Number(row.pending_version); // pending holds the old after cutover
    if (!Number.isFinite(oldVersion) || oldVersion <= 0) continue;
    const oldIndexId = indexIdForVersion(name, oldVersion);
    try {
      await client.deleteIndex(oldIndexId);
      dropped.push(oldIndexId);
    } catch (err) {
      console.warn(
        `[replacement] failed to drop retained index ${oldIndexId}: ${(err as Error).message}`
      );
    }
    await finalizeCutover(name).catch((err) => {
      console.warn(
        `[replacement] finalizeCutover for ${name} failed: ${(err as Error).message}`
      );
    });
  }
  return { examined: res.rows.length, droppedIndexIds: dropped };
}
