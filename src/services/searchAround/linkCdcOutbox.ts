// ---------------------------------------------------------------------------
// Transactional outbox for link CDC events (OSv2 serving-index parity).
//
// `stageLinkCdcEvent` is called INSIDE the same PostgreSQL transaction as
// the `link_edit` insert in editApplicator.applyEdits — the domain
// mutation and its outbox record commit atomically, which eliminates the
// previous fire-and-forget window where a Kafka outage silently dropped
// link events (and where the producer disable was permanent).
//
// The drainer (`drainLinkOutboxOnce`, driven by `startLinkCdcDrainer`):
//   * restart-safe      — pending rows survive process restarts;
//   * idempotent        — stable event_id; publishing is done with an
//                         idempotent Kafka producer; consumers dedup on
//                         (edge identity, event_version) via the
//                         ReplacingMergeTree serving tables;
//   * bounded retries   — exponential backoff (2^attempt capped) + full
//                         jitter, then dead-letter;
//   * concurrency-safe  — FOR UPDATE SKIP LOCKED across claim/publish;
//   * observable        — funnel metrics counters/gauges + structured logs.
//
// ACK TRUTHFULNESS: `published_at` means "delivered to the broker", never
// "visible in the serving edge index". Action/indexing acknowledgement
// must not read this table for success.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "../../db";
import { incCounter, setGauge } from "../funnel/metrics";
import { GUARD_OUTBOX_SEQUENCE_SQL } from "./edgeVersion";
import {
  linkCdcTopic,
  publishRowsToTopic,
  type LinkCdcRow,
} from "./cdcLinkProducer";

export interface StageLinkCdcInput {
  eventId: string;
  sourceObjectType: string;
  linkTypeApiName: string;
  sourcePrimaryKey: string;
  targetPrimaryKey: string;
  operation: "ADD" | "REMOVE" | "RETRACT";
  ontologyId?: string | null;
  branchId?: string | null;
  tenantId?: string | null;
  eventTsMicros?: number;
  actorPrincipalId?: string | null;
  actionRid?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  retractsEventId?: string | null;
  markings?: string[];
  linkProps?: Record<string, unknown>;
}

export interface StagedLinkCdcEvent {
  eventId: string;
  /** Globally monotonic edge-event offset (BIGSERIAL), assigned at staging.
   *  Used as the ack handle version for edge-index confirmation
   *  (src/services/serving/edgeIndexWatermark.ts). */
  outboxSeq: number;
}

/**
 * Stage a link CDC event. MUST be called on the PoolClient that is
 * writing the link_edit row so both commit atomically. Idempotent at the
 * row level on (event_id): a retried action attempt re-inserts safely.
 * Returns the assigned monotonic outbox offset.
 */
export async function stageLinkCdcEvent(
  tx: PoolClient,
  input: StageLinkCdcInput,
): Promise<StagedLinkCdcEvent> {
  const payload: LinkCdcRow = {
    source_pk: input.sourcePrimaryKey,
    target_pk: input.targetPrimaryKey,
    link_props: input.linkProps ?? {},
    markings: input.markings ?? [],
    schema_version: "2.0.0",
    event_id: input.eventId,
    event_ts_micros: input.eventTsMicros ?? Date.now() * 1000,
    link_type_api_name: input.linkTypeApiName,
    operation: input.operation,
    actor_principal_id: input.actorPrincipalId ?? undefined,
    action_rid: input.actionRid ?? null,
    correlation_id: input.correlationId ?? null,
    causation_id: input.causationId ?? null,
    retracts_event_id: input.retractsEventId ?? null,
    direction: "forward",
    // Serving-index scope keys are ClickHouse Strings (DEFAULT ''): a JSON
    // `null` would be a broken Kafka message at the engine, not a queryable
    // value. Normalise to "" everywhere the payload feeds the edge index;
    // confirmation probes use the identical normalisation
    // (serving/edgeIndexWatermark.ts:scopeClause).
    branch_id: input.branchId ?? "",
    tenant_id: input.tenantId ?? "",
    ontology_id: input.ontologyId ?? "",
  };
  const inserted = await tx.query(
    `INSERT INTO link_cdc_outbox
       (event_id, topic, tenant_id, ontology_id, branch_id,
        link_type_api_name, source_object_type,
        source_primary_key, target_primary_key, operation, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING outbox_seq`,
    [
      input.eventId,
      linkCdcTopic(input.sourceObjectType, input.linkTypeApiName),
      input.tenantId ?? null,
      input.ontologyId ?? null,
      input.branchId ?? null,
      input.linkTypeApiName,
      input.sourceObjectType,
      input.sourcePrimaryKey,
      input.targetPrimaryKey,
      input.operation,
      JSON.stringify(payload),
    ],
  );
  let outboxSeq = inserted.rows[0]?.outbox_seq as string | number | undefined;
  if (outboxSeq === undefined) {
    // Conflict path (retried action attempt): keep the original row and
    // read its assigned seq. One logical event, one monotonic offset.
    const existing = await tx.query(
      `SELECT outbox_seq FROM link_cdc_outbox WHERE event_id = $1`,
      [input.eventId],
    );
    outboxSeq = existing.rows[0]?.outbox_seq as string | number;
    return { eventId: input.eventId, outboxSeq: Number(outboxSeq) };
  }
  outboxSeq = Number(outboxSeq); // node-pg serialises BIGINT as string
  // Embed the assigned offset in the stored payload so the drainer does not
  // need a second write and the index row carries it (outbox_seq column).
  await tx.query(
    `UPDATE link_cdc_outbox
        SET payload = jsonb_set(payload, '{outbox_seq}', to_jsonb($2::bigint))
      WHERE event_id = $1`,
    [input.eventId, outboxSeq],
  );
  return { eventId: input.eventId, outboxSeq };
}

/**
 * Backfill boundary (Stage 7): restate CURRENT edge truth through the
 * outbox. MUST be called on a PoolClient whose transaction performed the
 * current snapshot read — by construction the allocated versions correspond
 * to the observed truth, so they may legitimately win over anything older.
 * REPLAY of a historical snapshot is the BANNED twin: replay must flow the
 * PUBLISHED payload with its ORIGINAL outbox_seq (re-delivered, never
 * re-staged).
 */
export async function stageBackfillEdges(
  tx: PoolClient,
  edges: Array<Omit<StageLinkCdcInput, "eventId" | "operation">>,
): Promise<StagedLinkCdcEvent[]> {
  const out: StagedLinkCdcEvent[] = [];
  for (const e of edges) {
    out.push(await stageLinkCdcEvent(tx, { ...e, eventId: randomUUID(), operation: "ADD" }));
  }
  return out;
}

export interface LinkOutboxDrainResult {
  scanned: number;
  published: number;
  retrying: number;
  deadLettered: number;
}

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 20;

function nextAttemptAt(attempt: number): string {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempt, 16), MAX_BACKOFF_MS);
  const jitter = Math.random() * exp; // full jitter
  return new Date(Date.now() + exp + jitter).toISOString();
}

/**
 * Drain a batch of pending outbox rows to Kafka. Safe under concurrent
 * callers (FOR UPDATE SKIP LOCKED). Never marks published unless the
 * broker accepted the batch.
 */
export async function drainLinkOutboxOnce(
  batchSize = 500,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<LinkOutboxDrainResult> {
  const pending = await query(
    `SELECT event_id, topic, payload, publish_attempts, outbox_seq
       FROM link_cdc_outbox
      WHERE published_at IS NULL
        AND dead_lettered_at IS NULL
        AND next_attempt_at <= now()
      ORDER BY outbox_seq
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );
  const rows = (pending.rows as Array<{
    event_id: string;
    topic: string;
    payload: LinkCdcRow;
    publish_attempts: number;
    outbox_seq: number;
  }>).map((r) => ({
    ...r,
    // Defensive: rows staged before outbox_seq existed (migration 157)
    // carry no offset in the payload; embed it now so the serving edge
    // index always receives the monotonic offset.
    payload: { ...r.payload, outbox_seq: r.payload?.outbox_seq ?? r.outbox_seq },
  }));
  if (rows.length === 0) {
    setGauge("link_cdc_outbox_pending", 0);
    return { scanned: 0, published: 0, retrying: 0, deadLettered: 0 };
  }
  setGauge("link_cdc_outbox_pending", rows.length);

  const byTopic = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTopic.get(r.topic) ?? [];
    list.push(r);
    byTopic.set(r.topic, list);
  }

  let published = 0;
  let retrying = 0;
  let deadLettered = 0;
  for (const [topic, batch] of byTopic) {
    // Partition by remaining attempts so exhausted rows dead-letter even
    // when their topic batch publishes fine.
    const publishable = batch.filter((r) => r.publish_attempts + 1 <= maxAttempts);
    const exhausted = batch.filter((r) => r.publish_attempts + 1 > maxAttempts);
    if (publishable.length > 0) {
      const sent = await publishRowsToTopic(topic, publishable.map((r) => r.payload));
      if (sent === publishable.length) {
        await query(
          `UPDATE link_cdc_outbox
              SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE event_id = ANY($1::uuid[])`,
          [publishable.map((r) => r.event_id)],
        );
        published += publishable.length;
        incCounter("link_cdc_publish_total", { result: "ok" }, publishable.length);
      } else {
        await scheduleRetry(publishable);
        retrying += publishable.length;
        incCounter("link_cdc_publish_total", { result: "retry" }, publishable.length);
      }
    }
    if (exhausted.length > 0) {
      await query(
        `UPDATE link_cdc_outbox
            SET dead_lettered_at = now(),
                publish_attempts = publish_attempts + 1,
                last_error = COALESCE(last_error, 'max_attempts_exceeded')
          WHERE event_id = ANY($1::uuid[])`,
        [exhausted.map((r) => r.event_id)],
      );
      deadLettered += exhausted.length;
      incCounter("link_cdc_dead_letter_total", {}, exhausted.length);
      console.error(
        JSON.stringify({
          level: "error",
          type: "link_cdc_dead_letter",
          topic,
          count: exhausted.length,
          event_ids: exhausted.map((r) => r.event_id),
        }),
      );
    }
  }
  return { scanned: rows.length, published, retrying, deadLettered };
}

async function scheduleRetry(rows: Array<{ event_id: string; publish_attempts: number }>): Promise<void> {
  for (const r of rows) {
    await query(
      `UPDATE link_cdc_outbox
          SET publish_attempts = publish_attempts + 1,
              next_attempt_at = $2,
              last_error = 'publish_failed'
        WHERE event_id = $1`,
      [r.event_id, nextAttemptAt(r.publish_attempts + 1)],
    );
  }
}

/** Periodic drainer — call once from the server boot path. */
export function startLinkCdcDrainer(intervalMs = 2_000): () => void {
  let running = false;
  let guarded = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (!guarded) {
        // DB-restore anomaly: a "table kept + sequence reset" restore would
        // re-allocate seqs already in the table → equal versions →
        // argMax nondeterminism. Guard runs once per boot.
        await query(GUARD_OUTBOX_SEQUENCE_SQL);
        guarded = true;
      }
      await drainLinkOutboxOnce(500);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          type: "link_cdc_drain_error",
          error: (err as Error).message?.slice(0, 500),
        }),
      );
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
