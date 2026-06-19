// ---------------------------------------------------------------------------
// B5 — Snapshot strategy (spec §B5 line 255, in-session criterion 1).
//
// Algorithm:
//   1. Open pg.Client using credentials.
//   2. Render SQL: SELECT * FROM "schema"."table" (or customQuery), validated
//      SELECT-only by the renderer.
//   3. Stream via a READ ONLY transaction + cursor (shared stream-extract),
//      accumulating rows into rolling Parquet files (zstd) — JSONL fallback
//      when no Parquet binding — under <warehouseRoot>/<namespace>/<table>/data/.
//   4. Iceberg replacePartitions commit tagged with tellus.build-rid.
//
// Outputs progress events via process.send().
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { Client } from "pg";
import { renderQuery } from "../../../services/connectivity/imports/sql-renderer";
import { loadCatalogAdapter } from "../../../lib/iceberg";
import { replacePartitions } from "../../../lib/iceberg/transaction";
import type { JobSpec } from "../../../services/orchestration/runners/runtime-adapter";
import type { CredentialFetchResult } from "../credential-fetch";
import { streamQueryToFiles } from "./stream-extract";

function send(buildRid: string, kind: string, data?: object): void {
  if (process.send) {
    process.send({ buildRid, ts: new Date().toISOString(), kind, data });
  }
}

function dataDirFor(warehouseRoot: string, namespace: string, table: string): string {
  const root =
    process.env.TELLUS_ICEBERG_ROOT ?? join(process.cwd(), "var", "iceberg");
  return join(root, warehouseRoot, namespace, table, "data");
}

export async function runSnapshot(
  spec: JobSpec,
  creds: CredentialFetchResult,
): Promise<void> {
  const cfg = spec.payload as {
    config: {
      schema: string;
      table: string;
      customQuery?: string;
      targetTable?: string;
      warehouseRoot?: string;
      parquetCompression: "zstd" | "snappy" | "none";
    };
    pgHost: string;
    pgPort: number;
    pgDatabase: string;
  };

  const client = new Client({
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: cfg.pgDatabase,
    user: creds.fields.user,
    password: creds.fields.password,
    ssl: creds.fields.serverCaPem
      ? { ca: creds.fields.serverCaPem, rejectUnauthorized: true }
      : false,
  });
  await client.connect();

  try {
    const querySource =
      cfg.config.customQuery ??
      `SELECT * FROM "${cfg.config.schema}"."${cfg.config.table}"`;
    const { sql, params } = await renderQuery(querySource, {});

    send(spec.buildRid, "progress", { phase: "query-rendered" });

    const adapter = await loadCatalogAdapter();
    const id = {
      warehouseRoot: cfg.config.warehouseRoot ?? spec.tenant,
      namespace: cfg.config.schema,
      table: cfg.config.targetTable ?? cfg.config.table,
    };

    // Bootstrap table if missing.
    await adapter.ensureTable(id, {
      formatVersion: 2,
      tableUuid: "",
      location: "",
      schemas: [{ schemaId: 0, fields: [] }],
      currentSchemaId: 0,
      partitionSpecs: [{ specId: 0, fields: [] }],
      defaultSpecId: 0,
      snapshots: [],
      currentSnapshotId: null,
      properties: { "tellus.created-by": spec.actor },
    });

    const { dataFiles, totalRows } = await streamQueryToFiles({
      client,
      sql,
      params,
      tableDir: dataDirFor(id.warehouseRoot, id.namespace, id.table),
      filePrefix: `part-${spec.buildRid}`,
      onBatch: (rows) =>
        send(spec.buildRid, "progress", { phase: "streaming", rows }),
    });

    const snap = await replacePartitions(
      { adapter, id, buildRid: spec.buildRid },
      dataFiles,
      { "tellus.build-rid": spec.buildRid },
    );

    send(spec.buildRid, "progress", {
      phase: "committed",
      snapshotId: snap.snapshotId,
      totalRows,
      files: dataFiles.length,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
