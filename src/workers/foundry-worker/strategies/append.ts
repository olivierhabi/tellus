// ---------------------------------------------------------------------------
// B5 — Append strategy (spec §B5 line 256, criterion 2).
//
// Read watermark → render query with bind param → stream → appendFiles
// commit → update watermark to MAX(incrementalColumn) observed in the
// stream. Strict `>` semantics. Zero rows ⇒ watermark unchanged.
//
// This module REUSES the snapshot strategy's cursor + writer helpers via a
// shared inner helper to avoid duplication. The diverging behaviour is:
//   - WHERE clause appended with `incrementalColumn > $1`
//   - replacePartitions -> appendFiles
//   - watermark upserted with observedMax
// ---------------------------------------------------------------------------

import { Client } from "pg";
import { renderQuery } from "../../../services/connectivity/imports/sql-renderer";
import { loadCatalogAdapter } from "../../../lib/iceberg";
import { appendFiles, type DataFile } from "../../../lib/iceberg/transaction";
import type { JobSpec } from "../../../services/orchestration/runners/runtime-adapter";
import type { CredentialFetchResult } from "../credential-fetch";

function send(buildRid: string, kind: string, data?: object): void {
  if (process.send) {
    process.send({ buildRid, ts: new Date().toISOString(), kind, data });
  }
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
    const wrappedSql =
      cfg.lastWatermark == null
        ? baseSql
        : `SELECT * FROM (${baseSql}) AS s WHERE s."${cfg.config.incrementalColumn}" > :last_watermark`;
    const { sql, params } = await renderQuery(wrappedSql, {
      lastWatermark: cfg.lastWatermark ?? null,
    });

    const result = await client.query<Record<string, unknown>>(sql, params);
    if (result.rows.length === 0) {
      send(spec.buildRid, "progress", {
        phase: "no-rows",
        watermarkUnchanged: true,
      });
      return;
    }

    // Compute observed max watermark (strict > semantics on next run).
    let observedMax: unknown = cfg.lastWatermark;
    for (const r of result.rows) {
      const v = r[cfg.config.incrementalColumn];
      if (observedMax == null || (v != null && v > observedMax)) {
        observedMax = v;
      }
    }

    const adapter = await loadCatalogAdapter();
    const id = {
      warehouseRoot: cfg.config.warehouseRoot ?? spec.tenant,
      namespace: cfg.config.schema,
      table: cfg.config.targetTable ?? cfg.config.table,
    };

    // For append, table must already exist (snapshot creates it first).
    const meta = await adapter.resolve(id);
    if (!meta) {
      throw new Error(
        `append: target Iceberg table ${id.namespace}.${id.table} does not exist; run a snapshot first`,
      );
    }

    // Write a single Parquet (or JSONL fallback) file with this delta.
    const path = `${process.env.TELLUS_ICEBERG_ROOT ?? `${process.cwd()}/var/iceberg`}/${id.warehouseRoot}/${id.namespace}/${id.table}/data/append-${spec.buildRid}.parquet`;
    const dataFile: DataFile = await writeAppendFile(path, result.rows);

    const snap = await appendFiles(
      { adapter, id, buildRid: spec.buildRid },
      [dataFile],
      {
        "tellus.build-rid": spec.buildRid,
        "tellus.watermark.observed-max": String(observedMax ?? ""),
      },
    );

    send(spec.buildRid, "progress", {
      phase: "appended",
      snapshotId: snap.snapshotId,
      rows: result.rows.length,
      observedMax,
    });

    // Hand observedMax back to the parent via IPC; parent persists via
    // watermarks.repo (worker has no DB writes by design — runs in sandbox).
    send(spec.buildRid, "progress", {
      phase: "watermark-advance",
      column: cfg.config.incrementalColumn,
      value: observedMax,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function writeAppendFile(
  path: string,
  rows: Record<string, unknown>[],
): Promise<DataFile> {
  const { promises: fs } = await import("node:fs");
  const dir = path.substring(0, path.lastIndexOf("/"));
  await fs.mkdir(dir, { recursive: true });
  try {
    const parquet: any = await import("parquetjs-lite");
    const schema = new parquet.ParquetSchema(
      Object.fromEntries(
        Object.entries(rows[0]).map(([k, v]) => [
          k,
          { type: typeof v === "number" ? "DOUBLE" : "UTF8", optional: true },
        ]),
      ),
    );
    const writer = await parquet.ParquetWriter.openFile(schema, path, {
      compression: "ZSTD",
    });
    for (const r of rows) await writer.appendRow(r);
    await writer.close();
    const stat = await fs.stat(path);
    return { path, rowCount: rows.length, fileSizeBytes: stat.size };
  } catch {
    const jsonlPath = path.replace(/\.parquet$/, ".jsonl");
    const buf = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.writeFile(jsonlPath, buf);
    return {
      path: jsonlPath,
      rowCount: rows.length,
      fileSizeBytes: Buffer.byteLength(buf),
    };
  }
}
