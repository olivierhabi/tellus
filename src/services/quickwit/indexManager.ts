// ---------------------------------------------------------------------------
// Quickwit index manager — Task B6
//
// Responsible for the lifecycle of `ot_<object_type_api_name>` indexes:
//   - load the Object Type's property definitions from Postgres
//   - build the Quickwit doc-mapping that respects searchable/sortable/
//     filterable flags
//   - create (or update) the index in Quickwit's metastore
//   - attach a Kafka source that consumes `merged.<object_type>`
//
// The activity layer (indexingActivity.ts) drives this manager; the manager
// never talks to Kafka or Iceberg directly.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  buildIndexConfig,
  getQuickwitIndexId,
  QuickwitPropertyInput,
  QuickwitIndexConfig,
} from "./docMapping";
import { getQuickwitClient, QuickwitClient } from "./client";

export interface EnsureIndexInput {
  objectTypeApiName: string;
  kafkaBrokers?: string[];
  kafkaTopic?: string;
  commitTimeoutSecs?: number;
}

export interface EnsureIndexResult {
  indexId: string;
  created: boolean;
  config: QuickwitIndexConfig;
  kafkaTopic: string;
  sourceId: string;
}

export interface PropertyRow {
  api_name: string;
  base_type: string;
  is_array: boolean;
  is_required: boolean;
  searchable?: boolean | null;
  sortable?: boolean | null;
  filterable?: boolean | null;
}

async function loadObjectTypeProperties(
  objectTypeApiName: string
): Promise<{ pk: string; properties: QuickwitPropertyInput[] }> {
  const otRes = await query(
    "SELECT object_type_id, primary_key_property_id FROM object_type WHERE api_name = $1",
    [objectTypeApiName]
  );
  if (otRes.rows.length === 0) {
    throw new Error(`Object type '${objectTypeApiName}' not found`);
  }
  const { object_type_id, primary_key_property_id } = otRes.rows[0];
  if (!primary_key_property_id) {
    throw new Error(`Object type '${objectTypeApiName}' has no primary key`);
  }

  const propsRes = await query(
    `SELECT api_name, base_type, is_array, is_required,
            searchable, sortable, filterable, property_id
       FROM property
      WHERE object_type_id = $1
      ORDER BY ordinal ASC, api_name ASC`,
    [object_type_id]
  );
  if (propsRes.rows.length === 0) {
    throw new Error(`Object type '${objectTypeApiName}' has no properties`);
  }

  const pkRow = propsRes.rows.find(
    (p: { property_id: string }) => p.property_id === primary_key_property_id
  );
  if (!pkRow) {
    throw new Error(
      `Primary key property missing in property table for '${objectTypeApiName}'`
    );
  }

  // Coerce flags: if the `property` table doesn't carry these columns (older
  // schemas), default to Palantir's behavior for the base type. Text is
  // searchable+filterable by default; numerics are sortable+filterable.
  const properties: QuickwitPropertyInput[] = propsRes.rows.map((p: PropertyRow) => ({
    api_name: p.api_name,
    base_type: p.base_type,
    is_array: p.is_array,
    is_required: p.is_required,
    searchable: coerceFlag(p.searchable, defaultSearchable(p.base_type)),
    sortable: coerceFlag(p.sortable, defaultSortable(p.base_type)),
    filterable: coerceFlag(p.filterable, true),
  }));

  return { pk: pkRow.api_name, properties };
}

function coerceFlag(v: boolean | null | undefined, fallback: boolean): boolean {
  if (v === true) return true;
  if (v === false) return false;
  return fallback;
}

function defaultSearchable(baseType: string): boolean {
  return baseType === "string" || baseType === "string_array";
}

function defaultSortable(baseType: string): boolean {
  switch (baseType) {
    case "integer":
    case "long":
    case "short":
    case "byte":
    case "double":
    case "float":
    case "decimal":
    case "date":
    case "timestamp":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// ensureIndex() — idempotent create-or-update
// ---------------------------------------------------------------------------

export async function ensureIndex(
  input: EnsureIndexInput,
  client: QuickwitClient = getQuickwitClient()
): Promise<EnsureIndexResult> {
  const { objectTypeApiName } = input;
  const indexId = getQuickwitIndexId(objectTypeApiName);

  const { pk, properties } = await loadObjectTypeProperties(objectTypeApiName);
  const config = buildIndexConfig({
    objectTypeApiName,
    properties,
    primaryKeyApiName: pk,
    commitTimeoutSecs: input.commitTimeoutSecs ?? 60,
  });

  const existing = await client.describeIndex(indexId);
  let created = false;
  if (!existing) {
    await client.createIndex(config);
    created = true;
  }

  // Preserve the Object Type's api-name casing in the Kafka topic so it
  // matches the B6 spec `merged.<object_type>` verbatim — some ingest
  // sources (tests, external producers) publish under the exact name
  // and a silent lowercase would route them to a different topic.
  const kafkaTopic = input.kafkaTopic ?? `merged.${objectTypeApiName}`;
  const kafkaBrokers =
    input.kafkaBrokers ??
    (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

  const sourceId = `${indexId}-kafka`;
  if (created) {
    await client.createKafkaSource(indexId, sourceId, kafkaTopic, kafkaBrokers);
  }

  return { indexId, created, config, kafkaTopic, sourceId };
}

// ---------------------------------------------------------------------------
// describeIndex — for health/introspection endpoints
// ---------------------------------------------------------------------------

export async function describeIndex(
  objectTypeApiName: string,
  client: QuickwitClient = getQuickwitClient()
): Promise<QuickwitIndexConfig | null> {
  return client.describeIndex(getQuickwitIndexId(objectTypeApiName));
}
