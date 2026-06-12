// ---------------------------------------------------------------------------
// B5 — Append strategy (spec §B5 line 256, criterion 2).
//
// Read watermark → render query with bind param ($1) → STREAM the delta via a
// READ ONLY cursor → appendFiles commit → advance watermark to the type-correct
// MAX(incrementalColumn) observed. Strict `>` semantics. Zero rows ⇒ watermark
// unchanged.
//
// Crash-consistency: the worker commits the Iceberg appendFiles snapshot FIRST,
// then emits the new watermark to the parent (which persists it). A crash
// between commit and watermark-persist re-reads from the old watermark next
// run → at-least-once (zero loss, bounded duplication of one delta window).
//
// Streaming + type-aware MAX (see stream-extract) fix the prior buffer-all OOM
// risk and the lexicographic-watermark bug for int8/numeric columns.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { Client } from "pg";
import { renderQuery } from "../../../services/connectivity/imports/sql-renderer";
import { loadCatalogAdapter } from "../../../lib/iceberg";
import { appendFiles } from "../../../lib/iceberg/transaction";
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

export async function runAppend(
  spec: JobSpec,
  creds: CredentialFetchResult,
): Promise<void> {
  const cfg = spec.payload as {
    config: {
      schema: string;
      table: string;
      incrementalColumn: string;
      targetTable?: string;
      warehouseRoot?: string;
      customQuery?: string;
    };
    pgHost: string;
    pgPort: number;
    pgDatabase: string;
    lastWatermark?: string | null;
  };

  if (!cfg.config.incrementalColumn) {
    throw new Error(
      "append strategy requires config.incrementalColumn (B5 contract)",
    );
  }

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
    const baseSql =
      cfg.config.customQuery ??
      `SELECT * FROM "${cfg.config.schema}"."${cfg.config.table}"`;
    // Strict `>` watermark filter; bound as $1 (never string-substituted).
    const wrappedSql =
      cfg.lastWatermark == null
        ? baseSql
        : `SELECT * FROM (${baseSql}) AS s WHERE s."${cfg.config.incrementalColumn}" > :last_watermark`;
    const { sql, params } = await renderQuery(wrappedSql, {
      lastWatermark: cfg.lastWatermark ?? null,
    });

    const adapter = await loadCatalogAdapter();
    const id = {
      warehouseRoot: cfg.config.warehouseRoot ?? spec.tenant,
      namespace: cfg.config.schema,
      table: cfg.config.targetTable ?? cfg.config.table,
    };

    // For append, the table must already exist (snapshot creates it first).
    const meta = await adapter.resolve(id);
    if (!meta) {
      throw new Error(
        `append: target Iceberg table ${id.namespace}.${id.table} does not exist; run a snapshot first`,
      );
    }

    const { dataFiles, totalRows, observedMax } = await streamQueryToFiles({
      client,
      sql,
      params,
      tableDir: dataDirFor(id.warehouseRoot, id.namespace, id.table),
      filePrefix: `append-${spec.buildRid}`,
      watermarkColumn: cfg.config.incrementalColumn,
      initialWatermark: cfg.lastWatermark ?? null,
      onBatch: (rows) =>
        send(spec.buildRid, "progress", { phase: "streaming", rows }),
    });

    if (totalRows === 0) {
      send(spec.buildRid, "progress", {
        phase: "no-rows",
        watermarkUnchanged: true,
      });
      return;
    }

    // Commit the delta to Iceberg BEFORE advancing the watermark (crash-safe).
    const snap = await appendFiles(
      { adapter, id, buildRid: spec.buildRid },
      dataFiles,
      {
        "tellus.build-rid": spec.buildRid,
        "tellus.watermark.observed-max": String(observedMax ?? ""),
      },
    );

    send(spec.buildRid, "progress", {
      phase: "appended",
      snapshotId: snap.snapshotId,
      rows: totalRows,
      observedMax,
    });

    // Hand observedMax back to the parent (which persists it via watermarks.repo;
    // the worker has no DB writes by design).
    send(spec.buildRid, "progress", {
      phase: "watermark-advance",
      column: cfg.config.incrementalColumn,
      value: observedMax,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
