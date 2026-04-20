// ---------------------------------------------------------------------------
// LT-B8 — Object-level CDC producer
//
// Mirrors the per-link CDC pattern for object edits. Events are staged
// in the `object_cdc_outbox` table inside the same Postgres transaction
// that writes to `object_edits`, then drained to Kafka asynchronously
// by `drainOutboxOnce` (invoked by a scheduler or on-demand for tests).
//
// Schema v1.0.0:
//   record ObjectEdit {
//     schema_version, event_id, event_ts_micros, ontology_id,
//     object_type_api_name, primary_key, operation (CREATE|UPDATE|DELETE),
//     property_changes, markings, actor_principal_id, action_rid,
//     correlation_id, causation_id
//   }
// ---------------------------------------------------------------------------

import { Kafka, type Producer, logLevel } from "kafkajs";
import { query } from "../db";
import type { PoolClient } from "pg";

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const ENABLED = process.env.KAFKA_ENABLED !== "false";

let producer: Producer | null = null;
let connecting: Promise<void> | null = null;
let disabled = !ENABLED;

export type ObjectCdcOperation = "CREATE" | "UPDATE" | "DELETE";

export interface ObjectCdcEvent {
  event_id?: string;
  event_ts_micros?: number;
  ontology_id: string;
  object_type_api_name: string;
  primary_key: string;
  operation: ObjectCdcOperation;
  property_changes?: Record<string, unknown> | null;
  markings?: string[];
  actor_principal_id?: string;
  action_rid?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
}

function sanitise(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
}

export function objectCdcTopic(objectTypeApiName: string): string {
  return `object_cdc.${sanitise(objectTypeApiName)}`;
}

/**
 * Stage an object CDC event inside the given Postgres transaction.
 * MUST be called on the same PoolClient that's writing `object_edits`
 * so the INSERT is atomic with the edit — this is the whole point of
 * the outbox pattern (no inconsistency window between Postgres commit
 * and Kafka publish).
 */
export async function stageObjectCdcEvent(
  tx: PoolClient,
  event: ObjectCdcEvent
): Promise<string> {
  const eventId = event.event_id ?? genUuid();
  const payload = {
    schema_version: "1.0.0",
    event_id: eventId,
    event_ts_micros: event.event_ts_micros ?? Date.now() * 1000,
    ontology_id: event.ontology_id,
    object_type_api_name: event.object_type_api_name,
    primary_key: event.primary_key,
    operation: event.operation,
    property_changes: event.property_changes ?? null,
    markings: event.markings ?? [],
    actor_principal_id: event.actor_principal_id ?? null,
    action_rid: event.action_rid ?? null,
    correlation_id: event.correlation_id ?? null,
    causation_id: event.causation_id ?? null,
  };
  await tx.query(
    `INSERT INTO object_cdc_outbox (event_id, topic, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [eventId, objectCdcTopic(event.object_type_api_name), JSON.stringify(payload)]
  );
  return eventId;
}

function genUuid(): string {
  try {
    return require("crypto").randomUUID();
  } catch {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function getProducer(): Promise<Producer | null> {
  if (disabled) return null;
  if (producer) return producer;
  if (!connecting) {
    connecting = (async () => {
      try {
        const kafka = new Kafka({
          clientId: "tellus-object-cdc",
          brokers: BROKERS,
          logLevel: logLevel.ERROR,
          retry: { retries: 3, initialRetryTime: 300 },
          connectionTimeout: 2000,
        });
        const p = kafka.producer({
          allowAutoTopicCreation: true,
          idempotent: true,
          maxInFlightRequests: 5,
        });
        await p.connect();
        producer = p;
        console.log(`[kafka/object-cdc] producer connected to ${BROKERS.join(",")}`);
      } catch (err) {
        disabled = true;
        console.warn(
          `[kafka/object-cdc] producer disabled — broker unreachable (${(err as Error).message})`
        );
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return producer;
}

export interface DrainResult {
  scanned: number;
  published: number;
  failed: number;
}

/**
 * Drain pending rows out of the outbox to Kafka. Safe to run
 * concurrently — we SELECT ... FOR UPDATE SKIP LOCKED so a second
 * caller cannot steal in-flight rows.
 */
export async function drainOutboxOnce(batchSize = 500): Promise<DrainResult> {
  const p = await getProducer();
  // Even if Kafka is down, the outbox row stays pending so a later drain
  // picks it up — the SoR (object_edits) is not blocked.
  const pending = await query(
    `SELECT event_id, topic, payload, publish_attempts
       FROM object_cdc_outbox
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize]
  );

  const rows = pending.rows as Array<{
    event_id: string;
    topic: string;
    payload: Record<string, unknown>;
    publish_attempts: number;
  }>;

  if (rows.length === 0) {
    return { scanned: 0, published: 0, failed: 0 };
  }

  if (!p) {
    // Bump attempts so stuck rows become visible in metrics; don't mark
    // published so a future drain retries.
    await query(
      `UPDATE object_cdc_outbox
          SET publish_attempts = publish_attempts + 1,
              last_error = 'kafka_unreachable'
        WHERE event_id = ANY($1::uuid[])`,
      [rows.map((r) => r.event_id)]
    );
    return { scanned: rows.length, published: 0, failed: rows.length };
  }

  const byTopic = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTopic.get(row.topic) ?? [];
    list.push(row);
    byTopic.set(row.topic, list);
  }

  let published = 0;
  let failed = 0;
  for (const [topic, batch] of byTopic.entries()) {
    try {
      await p.send({
        topic,
        messages: batch.map((r) => ({
          key: String((r.payload as any).primary_key ?? r.event_id),
          value: JSON.stringify(r.payload),
          headers: {
            schema_version: "1.0.0",
            operation: String((r.payload as any).operation ?? "UPDATE"),
          },
        })),
      });
      await query(
        `UPDATE object_cdc_outbox
            SET published_at = now(),
                publish_attempts = publish_attempts + 1,
                last_error = NULL
          WHERE event_id = ANY($1::uuid[])`,
        [batch.map((r) => r.event_id)]
      );
      published += batch.length;
    } catch (err) {
      failed += batch.length;
      await query(
        `UPDATE object_cdc_outbox
            SET publish_attempts = publish_attempts + 1,
                last_error = $2
          WHERE event_id = ANY($1::uuid[])`,
        [batch.map((r) => r.event_id), (err as Error).message.slice(0, 500)]
      );
      console.warn(`[kafka/object-cdc] batch publish to ${topic} failed: ${(err as Error).message}`);
    }
  }
  return { scanned: rows.length, published, failed };
}

/** Periodic drainer — call from the process boot path. */
export function startObjectCdcDrainer(intervalMs = 2_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutboxOnce(500);
    } catch (err) {
      console.warn(`[kafka/object-cdc] drain loop error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function shutdownObjectCdcProducer(): Promise<void> {
  if (producer) {
    try {
      await producer.disconnect();
    } catch {
      /* ignore */
    }
    producer = null;
  }
}
