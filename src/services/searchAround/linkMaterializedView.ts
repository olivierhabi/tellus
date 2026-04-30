// ---------------------------------------------------------------------------
// ClickHouse link materialized views — Task B10
//
// Per link type, we maintain one MergeTree table:
//
//   link_<source_type>__<link_name>__<target_type> (
//       source_pk    String,
//       target_pk    String,
//       link_props   JSON,
//       markings     Array(String),
//       source_ts    DateTime64(3),
//       cdc_offset   UInt64
//   )
//   ORDER BY (source_pk, target_pk)
//
// Rows are appended from a Kafka engine table fed by the same CDC stream
// (`ontology.links` — see kafkaProducer.ts) and a materialized view that
// transforms raw events into the flat form above. The 3-shard × 2-replica
// topology is a deployment concern (docker-compose / helm), not this
// module's — we only own the DDL and lag tracking.
// ---------------------------------------------------------------------------

import { ClickHouseClient, getClickHouseClient } from "./clickhouseClient";
import { ensureLinkCdcTopic } from "./cdcLinkProducer";

export interface LinkTypeDescriptor {
  sourceObjectType: string;
  linkName: string;
  targetObjectType: string;
}

export function linkTableName(link: LinkTypeDescriptor): string {
  return [
    "link",
    sanitize(link.sourceObjectType),
    sanitize(link.linkName),
    sanitize(link.targetObjectType),
  ].join("__");
}

/**
 * ClickHouse identifier safety — we only allow `[A-Za-z0-9_]`. ClickHouse
 * itself tolerates more, but our view names are derived from user-
 * controlled Object Type names, so we strip aggressively.
 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export async function ensureLinkTable(
  link: LinkTypeDescriptor,
  client: ClickHouseClient = getClickHouseClient()
): Promise<string> {
  const table = linkTableName(link);
  await client.command(`
    CREATE TABLE IF NOT EXISTS ${table} (
      source_pk    String,
      target_pk    String,
      link_props   String CODEC(ZSTD(3)),
      markings     Array(String),
      source_ts    DateTime64(3) DEFAULT now64(3),
      cdc_offset   UInt64 DEFAULT 0
    )
    ENGINE = MergeTree()
    PARTITION BY toYYYYMM(source_ts)
    ORDER BY (source_pk, target_pk)
    SETTINGS index_granularity = 8192
  `);
  return table;
}

// ---------------------------------------------------------------------------
// Kafka engine + materialized view DDL
//
// In production these are created once per link type by a platform job.
// We expose the DDL here so tests can stub ClickHouse and verify the
// statements that would run.
// ---------------------------------------------------------------------------

export function kafkaIngestDdl(link: LinkTypeDescriptor): {
  kafkaTable: string;
  mv: string;
  kafkaDdl: string;
  mvDdl: string;
  topic: string;
} {
  const target = linkTableName(link);
  const kafkaTable = `${target}__kafka`;
  const mv = `${target}__mv`;
  const topic = `cdc.links.${sanitize(link.sourceObjectType)}.${sanitize(link.linkName)}`;
  // ClickHouse's Kafka-engine resolves the broker address from inside
  // its own container — so `localhost:9092` (the host-published
  // listener) does NOT work even though the Node producer uses it. In
  // Docker Compose the internal listener is `redpanda:29092`. Prefer
  // an explicit env var when set, else fall back to the internal name.
  const internalBroker =
    process.env.CLICKHOUSE_KAFKA_BROKERS ??
    process.env.KAFKA_INTERNAL_BROKERS ??
    "redpanda:29092";
  return {
    kafkaTable,
    mv,
    topic,
    kafkaDdl: `
      CREATE TABLE IF NOT EXISTS ${kafkaTable} (
        source_pk    String,
        target_pk    String,
        link_props   String,
        markings     Array(String),
        source_ts    DateTime64(3),
        cdc_offset   UInt64
      )
      ENGINE = Kafka()
      SETTINGS
        kafka_broker_list = '${internalBroker}',
        kafka_topic_list = '${topic}',
        kafka_group_name = 'clickhouse-${target}',
        kafka_format = 'JSONEachRow',
        kafka_num_consumers = 1,
        kafka_thread_per_consumer = 1,
        kafka_client_id = 'clickhouse-${target}',
        kafka_poll_timeout_ms = 500,
        kafka_flush_interval_ms = 1000
    `,
    mvDdl: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${mv}
      TO ${target}
      AS SELECT
        source_pk, target_pk, link_props, markings, source_ts, cdc_offset
      FROM ${kafkaTable}
    `,
  };
}

export async function ensureLinkIngestTopology(
  link: LinkTypeDescriptor,
  client: ClickHouseClient = getClickHouseClient()
): Promise<void> {
  // Pre-create the CDC topic so ClickHouse's Kafka engine doesn't
  // spin up against a missing topic (which on librdkafka triggers
  // "Unknown topic or partition" → with kafka_skip_broken_messages=1
  // the consumer silently gives up and never retries).
  await ensureLinkCdcTopic(link.sourceObjectType, link.linkName);
  await ensureLinkTable(link, client);
  const ddl = kafkaIngestDdl(link);
  await client.command(ddl.kafkaDdl);
  await client.command(ddl.mvDdl);
}

/**
 * Drop and re-create the Kafka engine + materialized view for a link
 * type. Used when the Kafka-engine DDL (broker address, topic, format)
 * changes so the existing tables stop pointing at a stale broker.
 *
 * The target MergeTree (the `link_<...>` table holding the actual
 * rows) is NOT dropped — only the ingest pipeline in front of it. Any
 * rows already materialised remain.
 */
export async function rebuildLinkIngestTopology(
  link: LinkTypeDescriptor,
  client: ClickHouseClient = getClickHouseClient()
): Promise<void> {
  await ensureLinkCdcTopic(link.sourceObjectType, link.linkName);
  const ddl = kafkaIngestDdl(link);
  await client.command(`DROP VIEW IF EXISTS ${ddl.mv}`);
  await client.command(`DROP TABLE IF EXISTS ${ddl.kafkaTable}`);
  await ensureLinkTable(link, client);
  await client.command(ddl.kafkaDdl);
  await client.command(ddl.mvDdl);
}

// ---------------------------------------------------------------------------
// insertLinkRows — direct write path used for backfill and tests. In
// production the Kafka engine drives ingestion; this helper is for
// programmatic seeding only.
// ---------------------------------------------------------------------------

export interface LinkRow {
  source_pk: string;
  target_pk: string;
  link_props?: Record<string, unknown>;
  markings?: string[];
  source_ts?: string;
  cdc_offset?: number;
}

export async function insertLinkRows(
  link: LinkTypeDescriptor,
  rows: LinkRow[],
  client: ClickHouseClient = getClickHouseClient()
): Promise<void> {
  const table = linkTableName(link);
  const normalized = rows.map((r) => ({
    source_pk: r.source_pk,
    target_pk: r.target_pk,
    link_props: JSON.stringify(r.link_props ?? {}),
    markings: r.markings ?? [],
    source_ts: r.source_ts ?? new Date().toISOString(),
    cdc_offset: r.cdc_offset ?? 0,
  }));
  await client.insertJsonEachRow(table, normalized);
}
