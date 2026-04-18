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

async function getProducer(): Promise<Producer | null> {
  if (disabled) return null;
  if (producer) return producer;
  if (!connecting) {
    connecting = (async () => {
      try {
        const kafka = new Kafka({
          clientId: "tellus-funnel-cdc-links",
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
        console.log(`[kafka/cdc-links] producer connected to ${BROKERS.join(",")}`);
      } catch (err) {
        disabled = true;
        console.warn(
          `[kafka/cdc-links] producer disabled — broker unreachable (${(err as Error).message})`
        );
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return producer;
}

export interface LinkCdcRow {
  source_pk: string;
  target_pk: string;
  link_props?: Record<string, unknown>;
  markings?: string[];
  source_ts?: string;
  cdc_offset?: number;
}

function sanitise(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
}

export function linkCdcTopic(sourceObjectType: string, linkName: string): string {
  return `cdc.links.${sanitise(sourceObjectType)}.${sanitise(linkName)}`;
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
          value: JSON.stringify({
            source_pk: row.source_pk,
            target_pk: row.target_pk,
            link_props: JSON.stringify(row.link_props ?? {}),
            markings: row.markings ?? [],
            // ClickHouse JSONEachRow parses DateTime64(3) as
          // `YYYY-MM-DD HH:MM:SS.sss`, NOT as ISO-8601 (`T`...`Z`). The
          // Kafka engine fails with CANNOT_PARSE_INPUT_ASSERTION_FAILED
          // on ISO input. Format accordingly.
          source_ts: row.source_ts ?? toClickHouseDateTime(new Date()),
            cdc_offset: row.cdc_offset ?? Date.now(),
          }),
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
        value: JSON.stringify({
          source_pk: row.source_pk,
          target_pk: row.target_pk,
          link_props: JSON.stringify(row.link_props ?? {}),
          markings: row.markings ?? [],
          // ClickHouse JSONEachRow parses DateTime64(3) as
          // `YYYY-MM-DD HH:MM:SS.sss`, NOT as ISO-8601 (`T`...`Z`). The
          // Kafka engine fails with CANNOT_PARSE_INPUT_ASSERTION_FAILED
          // on ISO input. Format accordingly.
          source_ts: row.source_ts ?? toClickHouseDateTime(new Date()),
          cdc_offset: row.cdc_offset ?? Date.now(),
        }),
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
      adminKafka = new Kafka({
        clientId: "tellus-funnel-cdc-admin",
        brokers: BROKERS,
        logLevel: logLevel.ERROR,
        connectionTimeout: 2000,
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
