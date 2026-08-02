// ---------------------------------------------------------------------------
// ClickHouse link serving tables — versioned edge model (OSv2 parity).
//
// Per link type, one ReplacingMergeTree table:
//
//   link_<source_type>__<link_name>__<target_type> (
//       tenant_id, ontology_id, branch_id,   -- isolation dimensions in the key
//       source_pk, target_pk,                -- edge identity
//       link_props, markings,
//       operation (ADD|REMOVE|RETRACT), deleted, event_id,
//       event_version, cdc_offset, source_ts, ingested_at
//   ) ENGINE = ReplacingMergeTree(event_version)
//   ORDER BY (tenant_id, ontology_id, branch_id, source_pk, target_pk)
//
// Latest-state semantics:
//   * ADD re-creates an edge; REMOVE/RETRACT write a tombstone row for the
//     same identity with operation != 'ADD' (deleted=1).
//   * ReplacingMergeTree(event_version) collapses to the highest version
//     per identity; queries MUST use either FINAL or the argMax projection
//     in clickhouseTraversal.ts; a newer tombstone hides all older ADDs,
//     an older ADD can never resurrect a removed edge, and a duplicate
//     event_id with identical version is idempotent.
//
// Rows arrive from the CDC Kafka stream (outbox-drained, see
// linkCdcOutbox.ts) through a Kafka engine table + materialized view below.
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
// DDL — versioned serving table
// ---------------------------------------------------------------------------

function versionedTableDdl(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      tenant_id      String DEFAULT '',
      ontology_id    String DEFAULT '',
      branch_id      String DEFAULT '',
      source_pk      String,
      target_pk      String,
      link_props     String CODEC(ZSTD(3)),
      markings       Array(String),
      operation      LowCardinality(String) DEFAULT 'ADD',
      deleted        UInt8 DEFAULT 0,
      event_id       String DEFAULT '',
      event_version  UInt64 DEFAULT 0,
      cdc_offset     UInt64 DEFAULT 0,
      source_ts      DateTime64(3) DEFAULT now64(3),
      ingested_at    DateTime64(3) DEFAULT now64(3)
    )
    ENGINE = ReplacingMergeTree(event_version)
    PARTITION BY toYYYYMM(source_ts)
    ORDER BY (tenant_id, ontology_id, branch_id, source_pk, target_pk)
    SETTINGS index_granularity = 8192
  `;
}

async function getTableEngine(
  table: string,
  client: ClickHouseClient,
): Promise<string | null> {
  try {
    const rows = await client.exec<{ engine: string }>(
      `SELECT engine FROM system.tables WHERE database = currentDatabase() AND name = '${table}'`,
    );
    return rows[0]?.engine ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure the link type's serving table exists with the versioned
 * (ReplacingMergeTree) engine. A legacy plain-MergeTree table with the
 * same name is migrated in place: renamed to `<name>__legacy`, a versioned
 * table created, and existing rows copied with their last known state.
 * Copy-then-rename keeps reads consistent; the legacy table is retained
 * for the rollback window and removed by ops.
 */
export async function ensureLinkTable(
  link: LinkTypeDescriptor,
  client: ClickHouseClient = getClickHouseClient()
): Promise<string> {
  const table = linkTableName(link);
  const engine = await getTableEngine(table, client);
  if (!engine) {
    await client.command(versionedTableDdl(table));
    return table;
  }
  if (engine.startsWith("ReplacingMergeTree")) return table;

  // Legacy engine — migrate. Legacy rows have no version: give each
  // identity its max cdc_offset as the version so existing fresh rows win
  // over older duplicates after the copy.
  const legacy = `${table}__legacy_mergetree`;
  await client.command(`RENAME TABLE ${table} TO ${legacy}`);
  await client.command(versionedTableDdl(table));
  await client.command(`
    INSERT INTO ${table}
      (tenant_id, ontology_id, branch_id, source_pk, target_pk, link_props,
       markings, operation, deleted, event_id, event_version, cdc_offset, source_ts)
    SELECT
      '', '', '', source_pk, target_pk, link_props,
      markings, 'ADD', 0, '',
      max(cdc_offset), max(cdc_offset), max(source_ts)
    FROM ${legacy}
    GROUP BY source_pk, target_pk, link_props, markings
  `);
  console.warn(
    JSON.stringify({
      level: "warn",
      type: "link_table_engine_migrated",
      table,
      legacy,
      note: "legacy MergeTree renamed and copied into ReplacingMergeTree; drop the legacy table after verification",
    }),
  );
  return table;
}

// ---------------------------------------------------------------------------
// Kafka engine + materialized view DDL
//
// The v2 payload (see cdcLinkProducer.serialisePayload) is mapped in full —
// previously the operation/event columns were dropped at ingestion, so
// REMOVE/RETRACT appended rows instead of tombstoning them.
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
        source_pk        String,
        target_pk        String,
        link_props       String,
        markings         Array(String),
        source_ts        DateTime64(3),
        cdc_offset       UInt64,
        event_id         String,
        event_ts_micros  UInt64,
        ontology_id      String,
        branch_id        String,
        tenant_id        String,
        operation        String
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
        tenant_id, ontology_id, branch_id,
        source_pk, target_pk, link_props, markings,
        operation,
        if(operation = 'ADD', toUInt8(0), toUInt8(1)) AS deleted,
        event_id,
        event_ts_micros AS event_version,
        cdc_offset,
        source_ts
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
 * The serving table (the `link_<...>` ReplacingMergeTree holding the
 * actual rows) is NOT dropped — only the ingest pipeline in front of it.
 * Any rows already materialised remain.
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
// insertLinkRows — direct write path used for backfill and shadow tests. In
// production the Kafka engine drives ingestion; this helper is for
// programmatic seeding only. Writers MUST pass a monotonically increasing
// event_version (event_ts_micros from the source event) — an older version
// must never overwrite a newer indexed edge state.
// ---------------------------------------------------------------------------

export interface LinkRow {
  source_pk: string;
  target_pk: string;
  link_props?: Record<string, unknown>;
  markings?: string[];
  source_ts?: string;
  cdc_offset?: number;
  /** Latest-version enqueue; REQUIRED for REMOVE/RETRACT. */
  operation?: "ADD" | "REMOVE" | "RETRACT";
  event_id?: string;
  event_version?: number;
  ontology_id?: string;
  branch_id?: string;
  tenant_id?: string;
}

export async function insertLinkRows(
  link: LinkTypeDescriptor,
  rows: LinkRow[],
  client: ClickHouseClient = getClickHouseClient()
): Promise<void> {
  const table = linkTableName(link);
  const nowMicros = Date.now() * 1000;
  const normalized = rows.map((r) => {
    const operation = r.operation ?? "ADD";
    return {
      tenant_id: r.tenant_id ?? "",
      ontology_id: r.ontology_id ?? "",
      branch_id: r.branch_id ?? "",
      source_pk: r.source_pk,
      target_pk: r.target_pk,
      link_props: JSON.stringify(r.link_props ?? {}),
      markings: r.markings ?? [],
      operation,
      deleted: operation === "ADD" ? 0 : 1,
      event_id: r.event_id ?? "",
      event_version: r.event_version ?? nowMicros,
      cdc_offset: r.cdc_offset ?? 0,
      source_ts: toClickHouseDateTime64(r.source_ts),
    };
  });
  await client.insertJsonEachRow(table, normalized);
}

function toClickHouseDateTime64(v?: string): string {
  const d = v ? new Date(v) : new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}
