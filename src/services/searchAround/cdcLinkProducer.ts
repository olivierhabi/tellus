// ---------------------------------------------------------------------------
// CDC producer for link events — Task B10
//
// Every link_edit commit emits a row to
//   cdc.links.<source_object_type>.<link_name>
// on Redpanda/Kafka. ClickHouse's Kafka engine table + materialized view
// (see `linkMaterializedView.ts`) consume from these topics and populate
// `link_<source>__<name>__<target>` MergeTree tables. Without this
// producer the link tables stay empty and graph traversals return zero
// rows — exactly the B10 audit gap.
//
// Topic naming MUST match `kafkaIngestDdl()` in linkMaterializedView.ts,
// which uses the sanitised form `cdc.links.<sanitised-source>.<sanitised-link>`
// without the target — ClickHouse MVs per link type are keyed by
// (source, link); target lives in the row payload.
// ---------------------------------------------------------------------------

import { Kafka, type Producer, type Admin, logLevel } from "kafkajs";

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const ENABLED = process.env.KAFKA_ENABLED !== "false" && process.env.B10_CDC_ENABLED !== "false";

let producer: Producer | null = null;
let connecting: Promise<void> | null = null;
let disabled = !ENABLED;

// Cold-connect patience: under CI load (parallel vitest workers hammering
// the same broker) the FIRST connect can blow its connectionTimeout even
// though the broker is healthy — the outbox then burns a publish_attempts
// on a row the broker never saw, and the background drainer succeeds
// minutes later (breaking the drain-exactly-once contract:
// run 32881622027, link-cdc-outbox-integration publish_attempts=2).
// Retry whole connect rounds here instead of letting one timeout leak an
// attempt into the durable ledger.
const CONNECT_ROUNDS = 4;
const CONNECT_ROUND_BACKOFF_MS = 400;

async function connectProducerOnce(): Promise<Producer> {
  // F-P4-06: explicit requestTimeout bounds broker silences so a
  // wedged controller can't stall a link-edit write path.
  const kafka = new Kafka({
    clientId: "tellus-funnel-cdc-links",
    brokers: BROKERS,
    logLevel: logLevel.ERROR,
    retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 2000 },
    connectionTimeout: 5000,
    requestTimeout: 5000,
  });
  const p = kafka.producer({
    allowAutoTopicCreation: true,
    idempotent: true,
    maxInFlightRequests: 5,
  });
  await p.connect();
  return p;
}

async function getProducer(): Promise<Producer | null> {
  if (disabled) return null;
  if (producer) return producer;
  if (!connecting) {
    connecting = (async () => {
      try {
        let lastErr: unknown;
        for (let round = 1; round <= CONNECT_ROUNDS; round++) {
          try {
            producer = await connectProducerOnce();
            console.log(`[kafka/cdc-links] producer connected to ${BROKERS.join(",")}`);
            return;
          } catch (err) {
            lastErr = err;
            if (round < CONNECT_ROUNDS) {
              await new Promise((r) => setTimeout(r, CONNECT_ROUND_BACKOFF_MS * round));
            }
          }
        }
        // Do NOT permanently disable on a transient connect failure:
        // `producer` stays null and the next publish retries. The link
        // outbox (linkCdcOutbox.ts) bounds retries with backoff, so
        // retries naturally rate-limit and pickup is restart-safe.
        console.warn(
          `[kafka/cdc-links] broker unreachable after ${CONNECT_ROUNDS} connect rounds (${(lastErr as Error)?.message}) — will retry`
        );
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return producer;
}

export type LinkCdcOperation = "ADD" | "REMOVE" | "RETRACT";

export interface LinkCdcRow {
  source_pk: string;
  target_pk: string;
  link_props?: Record<string, unknown>;
  markings?: string[];
  source_ts?: string;
  cdc_offset?: number;
  // LT-B3 v2.0.0 — Ontology-edit semantics on the per-link CDC topic.
  schema_version?: string;
  event_id?: string;
  event_ts_micros?: number;
  ontology_id?: string;
  link_type_api_name?: string;
  operation?: LinkCdcOperation;
  actor_principal_id?: string;
  action_rid?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
  retracts_event_id?: string | null;
  direction?: "forward" | "reverse";
  /** Isolation dimensions carried into the versioned edge index. */
  branch_id?: string | null;
  tenant_id?: string | null;
  /** Globally monotonic outbox offset (migration 157); carried through to
   *  the edge-index row (`outbox_seq` column) for watermark confirmation. */
  outbox_seq?: number;
}

/**
 * Validate an outgoing LT-B3 v2 CDC payload before we hit Kafka.
 * Mirrors the Avro schema contract documented in tasks-02 §LT-B3.
 */
export function validateLinkCdcV2(row: LinkCdcRow): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!row.source_pk) errors.push("source_pk is required");
  if (!row.target_pk) errors.push("target_pk is required");
  if (!row.event_id) errors.push("event_id is required (v2)");
  if (!row.event_ts_micros) errors.push("event_ts_micros is required (v2)");
  if (!row.ontology_id) errors.push("ontology_id is required (v2)");
  if (!row.link_type_api_name) errors.push("link_type_api_name is required (v2)");
  if (!row.operation) errors.push("operation is required (v2)");
  if (row.operation && !["ADD", "REMOVE", "RETRACT"].includes(row.operation)) {
    errors.push(`operation must be ADD|REMOVE|RETRACT, got ${row.operation}`);
  }
  if (row.operation === "RETRACT" && !row.retracts_event_id) {
    errors.push("RETRACT requires retracts_event_id pointing at the original event");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function serialisePayload(row: LinkCdcRow): string {
  return JSON.stringify({
    // v1 backwards-compatible fields (Kafka engine / ClickHouse MV reads these)
    source_pk: row.source_pk,
    target_pk: row.target_pk,
    link_props: JSON.stringify(row.link_props ?? {}),
    markings: row.markings ?? [],
    source_ts: row.source_ts ?? toClickHouseDateTime(new Date()),
    cdc_offset: row.cdc_offset ?? Date.now(),
    // v2.0.0 — Ontology edit semantics
    schema_version: row.schema_version ?? "2.0.0",
    event_id: row.event_id ?? null,
    event_ts_micros: row.event_ts_micros ?? Date.now() * 1000,
    ontology_id: row.ontology_id ?? "",
    link_type_api_name: row.link_type_api_name ?? "",
    operation: row.operation ?? "ADD",
    actor_principal_id: row.actor_principal_id ?? null,
    action_rid: row.action_rid ?? null,
    correlation_id: row.correlation_id ?? null,
    causation_id: row.causation_id ?? null,
    retracts_event_id: row.retracts_event_id ?? null,
    direction: row.direction ?? "forward",
    // Edge-index scope keys are ClickHouse Strings — JSON null would make
    // the Kafka-engine message skip-as-broken instead of queryable (the
    // Stage 7 seq inherits it; DO NOT ever exploit skip_broken here).
    branch_id: row.branch_id ?? "",
    tenant_id: row.tenant_id ?? "",
    outbox_seq: row.outbox_seq ?? 0,
  });
}

function sanitise(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
}

/** Environment-scoped topic prefix — defaults preserve production naming;
 *  isolated lanes (see vitest.osv2-serving.config.ts) pin their own so
 *  parallel workstreams never share a CDC topic. */
function topicPrefix(): string {
  return (process.env.TELLUS_CDC_TOPIC_PREFIX ?? "cdc.links").replace(/\.+$/, "");
}

export function linkCdcTopic(sourceObjectType: string, linkName: string): string {
  return `${topicPrefix()}.${sanitise(sourceObjectType)}.${sanitise(linkName)}`;
}

/**
 * Publish one link CDC row. Non-fatal: if Kafka is unreachable we skip
 * (ClickHouse will stay behind but the write path returns); the missing
 * rows surface via the /api/v1/funnel/clickhouse/cdc-lag endpoint.
 */
export async function publishLinkCdc(
  sourceObjectType: string,
  linkName: string,
  row: LinkCdcRow
): Promise<boolean> {
  const p = await getProducer();
  if (!p) return false;
  const topic = linkCdcTopic(sourceObjectType, linkName);
  try {
    await p.send({
      topic,
      messages: [
        {
          key: `${row.source_pk}::${row.target_pk}`,
          value: serialisePayload(row),
          headers: {
            schema_version: row.schema_version ?? "2.0.0",
            operation: row.operation ?? "ADD",
          },
        },
      ],
    });
    return true;
  } catch (err) {
    console.warn(
      `[kafka/cdc-links] publish to ${topic} failed: ${(err as Error).message}`
    );
    return false;
  }
}

/**
 * Batch variant — sends all rows in a single Kafka request. Used by
 * backfill code that loads a whole link table at once.
 */
export async function publishLinkCdcBatch(
  sourceObjectType: string,
  linkName: string,
  rows: LinkCdcRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const p = await getProducer();
  if (!p) return 0;
  const topic = linkCdcTopic(sourceObjectType, linkName);
  try {
    await p.send({
      topic,
      messages: rows.map((row) => ({
        key: `${row.source_pk}::${row.target_pk}`,
        value: serialisePayload(row),
        headers: {
          schema_version: row.schema_version ?? "2.0.0",
          operation: row.operation ?? "ADD",
        },
      })),
    });
    return rows.length;
  } catch (err) {
    console.warn(
      `[kafka/cdc-links] batch publish to ${topic} failed: ${(err as Error).message}`
    );
    return 0;
  }
}

/**
 * Pre-create the CDC topic so ClickHouse's Kafka engine doesn't throw
 * "Unknown topic or partition" on first subscribe. Idempotent: if the
 * topic already exists the create call is a no-op. Returns true if the
 * topic was created (or already existed) — false if Kafka is
 * unreachable so callers can decide whether to fail or proceed.
 */
let adminClient: Admin | null = null;
let adminKafka: Kafka | null = null;

export async function ensureLinkCdcTopic(
  sourceObjectType: string,
  linkName: string,
  partitions = 1,
  replicationFactor = 1
): Promise<boolean> {
  if (disabled) return false;
  const topic = linkCdcTopic(sourceObjectType, linkName);
  try {
    if (!adminClient) {
      // F-P4-06: admin calls (createTopics) need requestTimeout too
      // — metadata requests hang indefinitely against a non-leader.
      adminKafka = new Kafka({
        clientId: "tellus-funnel-cdc-admin",
        brokers: BROKERS,
        logLevel: logLevel.ERROR,
        connectionTimeout: 2000,
        requestTimeout: 5000,
      });
      adminClient = adminKafka.admin();
      await adminClient.connect();
    }
    const created = await adminClient.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic,
          numPartitions: partitions,
          replicationFactor,
        },
      ],
    });
    if (created) {
      console.log(`[kafka/cdc-links] created topic ${topic}`);
    }
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    // kafkajs throws "already exists" — treat as success.
    if (/already exists|TOPIC_ALREADY_EXISTS/i.test(msg)) return true;
    console.warn(`[kafka/cdc-links] createTopics ${topic} failed: ${msg}`);
    return false;
  }
}

/**
 * Publish pre-serialised rows to an explicit topic. Used by the
 * transactional outbox drainer (linkCdcOutbox.ts) — returns the number of
 * messages the broker accepted; returns 0 on any failure so the caller
 * can retry with backoff (never throws).
 */
export async function publishRowsToTopic(topic: string, rows: LinkCdcRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const p = await getProducer();
  if (!p) return 0;
  const messages = rows.map((row) => ({
    key: `${row.source_pk}::${row.target_pk}`,
    value: serialisePayload(row),
    headers: {
      schema_version: row.schema_version ?? "2.0.0",
      operation: row.operation ?? "ADD",
      event_id: row.event_id ?? "",
    },
  }));
  // A topic created moments before the first publish can still race the
  // broker's metadata propagation ("This server does not host this
  // topic-partition" / UNKNOWN_TOPIC_OR_PARTITION on a cold leader). Retry
  // those topic-bootstrap classes once after a short settle — never the
  // generic failure classes (those fall through to the outbox retry).
  const RETRYABLE = /not host this topic-partition|UNKNOWN_TOPIC|NOT_LEADER|LEADER_NOT_AVAILABLE/i;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await p.send({ topic, messages });
      return rows.length;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt < 2 && RETRYABLE.test(msg)) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      console.warn(`[kafka/cdc-links] publish to ${topic} failed: ${msg}`);
      return 0;
    }
  }
  return 0;
}

function toClickHouseDateTime(d: Date): string {
  // "YYYY-MM-DD HH:MM:SS.sss" in UTC — the format ClickHouse's
  // JSONEachRow parses into DateTime64(3).
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

export async function shutdownCdcLinkProducer(): Promise<void> {
  if (adminClient) {
    try {
      await adminClient.disconnect();
    } catch {
      /* ignore */
    }
    adminClient = null;
    adminKafka = null;
  }
  if (producer) {
    try {
      await producer.disconnect();
    } catch {
      /* ignore */
    }
    producer = null;
  }
}
