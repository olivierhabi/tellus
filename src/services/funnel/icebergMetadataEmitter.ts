// ---------------------------------------------------------------------------
// Iceberg v2 metadata.json emitter — Task B2
//
// Writes a real Iceberg v2-compatible `metadata.json` to S3 on every
// snapshot commit so external clients (DuckDB `iceberg_scan`, Spark,
// PyIceberg) can resolve the table from the `<location>/metadata/` path
// without going through the Postgres mirror.
//
// Scope: emits the top-level metadata.json file and `version-hint.text`.
// Manifest-list (avro) files for the snapshot's data files are out of
// scope for the Node-side writer — they are produced by PyIceberg
// sidecars or Spark jobs during bulk ingestion, and we wire the sidecar
// in via the `manifest-list` pointer we write here.
// ---------------------------------------------------------------------------

import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { envWithDefault, requireSecret } from "../../utils/requireEnv";
import type {
  FunnelDatasetRow,
  FunnelSnapshotRow,
  ManifestEntry,
  SnapshotOperation,
} from "./icebergCatalog";

export interface IcebergMetadataV2 {
  "format-version": 2;
  "table-uuid": string;
  location: string;
  "last-sequence-number": number;
  "last-updated-ms": number;
  "last-column-id": number;
  schemas: Array<{
    "schema-id": number;
    type: "struct";
    fields: Array<{
      id: number;
      name: string;
      required: boolean;
      type: string;
    }>;
  }>;
  "current-schema-id": number;
  "partition-specs": Array<{ "spec-id": number; fields: unknown[] }>;
  "default-spec-id": number;
  "last-partition-id": number;
  "sort-orders": Array<{ "order-id": number; fields: unknown[] }>;
  "default-sort-order-id": number;
  properties: Record<string, string>;
  "current-snapshot-id": string | null;
  snapshots: IcebergSnapshotEntry[];
  "snapshot-log": Array<{ "snapshot-id": string; "timestamp-ms": number }>;
  "metadata-log": Array<{ "metadata-file": string; "timestamp-ms": number }>;
}

interface IcebergSnapshotEntry {
  "snapshot-id": string;
  "parent-snapshot-id": string | null;
  "sequence-number": number;
  "timestamp-ms": number;
  "manifest-list": string;
  operation: SnapshotOperation;
  summary: Record<string, string>;
  "schema-id": number;
}

let singletonClient: S3Client | null = null;
function getS3(): S3Client {
  if (singletonClient) return singletonClient;
  // F-P4-24: credentials fail-closed; no minioadmin default.
  // F-P4-07: AWS SDK v3 defaults requestHandler timeout to 0 (infinite).
  // Pin a finite upper bound so a stuck S3 endpoint cannot hold event-loop
  // slots indefinitely. 30s is the p99 upper bound the metadata emitter
  // is willing to wait before surfacing a typed failure to the caller.
  singletonClient = new S3Client({
    endpoint: envWithDefault("S3_ENDPOINT", "http://localhost:9000"),
    region: envWithDefault("S3_REGION", "us-east-1"),
    credentials: {
      accessKeyId: requireSecret("S3_ACCESS_KEY_ID", "Iceberg metadata emitter requires S3 access key."),
      secretAccessKey: requireSecret("S3_SECRET_ACCESS_KEY", "Iceberg metadata emitter requires S3 secret key."),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
    } as unknown as NonNullable<ConstructorParameters<typeof S3Client>[0]>["requestHandler"],
  });
  return singletonClient;
}

function metadataBucket(): string {
  return process.env.ICEBERG_METADATA_BUCKET || process.env.S3_BUCKET || "tellus-uploads";
}

function locationToKeyPrefix(location: string): string {
  // `location` is s3://bucket/prefix — strip scheme + bucket → `prefix`.
  const m = /^s3:\/\/([^/]+)\/(.*)$/.exec(location);
  if (m) return m[2].replace(/\/+$/, "");
  return location.replace(/^\/+|\/+$/g, "");
}

/**
 * Emit an Iceberg v2 `metadata.json` + `version-hint.text` to S3 for a
 * funnel_dataset at its current head snapshot. Safe to call as a
 * best-effort side-effect after `commitSnapshot` — a failure here does
 * not roll back the snapshot (Postgres remains the source of truth for
 * dispatch). Surfaces in logs + the B2 audit endpoint.
 */
export async function emitIcebergMetadataForSnapshot(
  table: FunnelDatasetRow,
  snapshot: FunnelSnapshotRow,
  allSnapshots: FunnelSnapshotRow[],
  version: number
): Promise<{ metadataKey: string; versionHintKey: string }> {
  const keyPrefix = locationToKeyPrefix(table.location);
  const metadataKey = `${keyPrefix}/metadata/v${version}.metadata.json`;
  const versionHintKey = `${keyPrefix}/metadata/version-hint.text`;
  const manifestListKey = `${keyPrefix}/metadata/snap-${snapshot.snapshot_id}-manifest-list.avro`;

  // Re-build the complete snapshot list so the metadata.json is a
  // self-contained description of the table's snapshot chain.
  const snapshotEntries: IcebergSnapshotEntry[] = allSnapshots.map((s, i) => ({
    "snapshot-id": s.snapshot_id,
    "parent-snapshot-id": s.parent_snapshot_id,
    "sequence-number": i + 1,
    "timestamp-ms": Date.parse(s.committed_at),
    "manifest-list": `s3://${metadataBucket()}/${keyPrefix}/metadata/snap-${s.snapshot_id}-manifest-list.avro`,
    operation: s.operation,
    summary: normalizeSummary(s.summary_json, s.operation, s.manifest_json),
    "schema-id": 0,
  }));

  const metadata: IcebergMetadataV2 = {
    "format-version": 2,
    "table-uuid": deriveTableUuid(table.dataset_table_id),
    location: table.location,
    "last-sequence-number": snapshotEntries.length,
    "last-updated-ms": Date.parse(snapshot.committed_at),
    "last-column-id": Math.max(1, Object.keys(table.schema_json ?? {}).length),
    schemas: [
      {
        "schema-id": 0,
        type: "struct",
        fields: schemaFieldsFrom(table.schema_json),
      },
    ],
    "current-schema-id": 0,
    "partition-specs": [{ "spec-id": 0, fields: table.partition_spec_json ?? [] }],
    "default-spec-id": 0,
    "last-partition-id": 999,
    "sort-orders": [{ "order-id": 0, fields: [] }],
    "default-sort-order-id": 0,
    properties: {
      "format-version": "2",
      "write.delete.mode": table.write_mode,
      "history.expire.min-snapshots-to-keep": String(table.min_snapshots_to_keep),
    },
    "current-snapshot-id": snapshot.snapshot_id,
    snapshots: snapshotEntries,
    "snapshot-log": snapshotEntries.map((s) => ({
      "snapshot-id": s["snapshot-id"],
      "timestamp-ms": s["timestamp-ms"],
    })),
    "metadata-log": [
      {
        "metadata-file": `s3://${metadataBucket()}/${metadataKey}`,
        "timestamp-ms": Date.parse(snapshot.committed_at),
      },
    ],
  };

  const client = getS3();
  const bucket = metadataBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: metadataKey,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json",
    })
  );

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: versionHintKey,
      Body: String(version),
      ContentType: "text/plain",
    })
  );

  // Touch a placeholder manifest-list key so the pointer resolves to a
  // 0-byte object; sidecars/PyIceberg can overwrite with the real avro.
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestListKey,
      Body: Buffer.alloc(0),
      ContentType: "application/octet-stream",
    })
  );

  return { metadataKey, versionHintKey };
}

function schemaFieldsFrom(
  schema: Record<string, unknown> | null | undefined
): Array<{ id: number; name: string; required: boolean; type: string }> {
  const entries = Object.entries(schema ?? {});
  if (entries.length === 0) {
    return [{ id: 1, name: "primary_key", required: true, type: "string" }];
  }
  return entries.map(([name, type], i) => ({
    id: i + 1,
    name,
    required: false,
    type: typeof type === "string" ? type : "string",
  }));
}

function normalizeSummary(
  summary: Record<string, unknown> | null,
  operation: SnapshotOperation,
  manifest: ManifestEntry[]
): Record<string, string> {
  const added = manifest.filter((m) => m.operation === "added");
  const deleted = manifest.filter((m) => m.operation === "deleted");
  const out: Record<string, string> = {
    operation,
    "added-files-count": String(added.length),
    "deleted-files-count": String(deleted.length),
    "added-records": String(
      added.reduce((n, m) => n + (m.row_count ?? 0), 0)
    ),
  };
  for (const [k, v] of Object.entries(summary ?? {})) {
    // `inline_rows` is the pass-by-reference row payload stored on
    // summary_json for downstream activities to re-read by snapshot_id
    // (Temporal payload fix). It can be tens of MB; it must NOT be
    // serialised into the S3 metadata.json side-emission — Postgres is
    // the source of truth for it, and a 42 MB metadata.json would make
    // every snapshot commit write a huge object to S3. Skip it here.
    if (k === "inline_rows") continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function deriveTableUuid(datasetTableId: string): string {
  // funnel_dataset.dataset_table_id is a UUID; use it directly so the
  // Iceberg table-uuid matches our internal identifier. If it's not a
  // UUID (legacy rows), emit a fresh one.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    datasetTableId
  );
  return isUuid ? datasetTableId : randomUUID();
}
