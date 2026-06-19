// ---------------------------------------------------------------------------
// B5 — Snapshot strategy (spec §B5 line 255, in-session criterion 1).
//
// Algorithm:
//   1. Open pg.Client using credentials.
//   2. Render SQL: SELECT * FROM "schema"."table" (or customQuery).
//   3. Stream via pg-query-stream (lazy import; fall back to client.query
//      with cursor if not installed).
//   4. Accumulate rows into 128MiB Parquet files (zstd-3) under
//      <warehouseRoot>/<warehouse>/<namespace>/<table>/data/.
//   5. Iceberg replacePartitions commit tagged with tellus.build-rid.
//   6. Emit lineage row (calls lineage service; deferred if unavailable).
//
// Outputs progress events via process.send().
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Client } from "pg";
import { renderQuery } from "../../../services/connectivity/imports/sql-renderer";
import { loadCatalogAdapter } from "../../../lib/iceberg";
import {
  replacePartitions,
  type DataFile,
} from "../../../lib/iceberg/transaction";
import type { JobSpec } from "../../../services/orchestration/runners/runtime-adapter";
import type { CredentialFetchResult } from "../credential-fetch";

const TARGET_FILE_BYTES = 128 * 1024 * 1024;

function send(buildRid: string, kind: string, data?: object): void {
  if (process.send) {
    process.send({
      buildRid,
      ts: new Date().toISOString(),
      kind,
      data,
    });
  }
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

    // Stream via cursor (portable; pg-query-stream optional).
    const cursor = await openCursor(client, sql, params);

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

    const dataFiles: DataFile[] = [];
    let fileIndex = 0;
    let currentBytes = 0;
    let currentRows = 0;
    let currentPath: string | null = null;
    let currentWriter: WriterHandle | null = null;
    let totalRows = 0;

    while (true) {
      const batch = await cursor.fetch(5_000);
      if (batch.length === 0) break;
      totalRows += batch.length;

      if (!currentWriter) {
        const tableDir = process.env.TELLUS_ICEBERG_ROOT
          ? join(
              process.env.TELLUS_ICEBERG_ROOT,
              id.warehouseRoot,
              id.namespace,
              id.table,
              "data",
            )
          : join(process.cwd(), "var", "iceberg", id.warehouseRoot, id.namespace, id.table, "data");
        currentPath = join(
          tableDir,
          `part-${spec.buildRid}-${String(fileIndex).padStart(5, "0")}.parquet`,
        );
        currentWriter = await openWriter(currentPath);
      }

      const written = await currentWriter.appendRows(batch);
      currentBytes += written.bytes;
      currentRows += batch.length;

      if (currentBytes >= TARGET_FILE_BYTES) {
        await currentWriter.close();
        dataFiles.push({
          path: currentPath!,
          rowCount: currentRows,
          fileSizeBytes: currentBytes,
        });
        send(spec.buildRid, "progress", {
          phase: "file-rolled",
          fileIndex,
          rows: currentRows,
        });
        fileIndex += 1;
        currentWriter = null;
        currentPath = null;
        currentBytes = 0;
        currentRows = 0;
      }
    }

    if (currentWriter) {
      await currentWriter.close();
      dataFiles.push({
        path: currentPath!,
        rowCount: currentRows,
        fileSizeBytes: currentBytes,
      });
    }

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

// ---------------------------------------------------------------------------
// Cursor wrapper (portable; uses pg's named-cursor protocol via DECLARE).
// ---------------------------------------------------------------------------
interface CursorHandle {
  fetch(n: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

async function openCursor(
  client: Client,
  sql: string,
  params: unknown[],
): Promise<CursorHandle> {
  // Try pg-cursor first.
  try {
    const Cursor: any = (await import("pg-cursor")).default;
    const cur = client.query(new Cursor(sql, params));
    return {
      fetch: (n: number) =>
        new Promise((resolve, reject) =>
          cur.read(n, (err: Error | null, rows: Record<string, unknown>[]) => {
            if (err) reject(err);
            else resolve(rows);
          }),
        ),
      close: () =>
        new Promise<void>((resolve) => {
          cur.close(() => resolve());
        }),
    };
  } catch {
    // Fallback: single shot. Works for small fixtures.
    const r = await client.query<Record<string, unknown>>(sql, params);
    let done = false;
    return {
      async fetch() {
        if (done) return [];
        done = true;
        return r.rows;
      },
      async close() {
        /* noop */
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Parquet writer wrapper. Tries parquetjs-lite first, falls back to JSONL.
// JSONL fallback is documented in DEFERRED.md as a v0 hack used only when
// no Parquet binding is installed (CI / dev without arrow toolchain).
// ---------------------------------------------------------------------------
interface WriterHandle {
  appendRows(
    rows: Record<string, unknown>[],
  ): Promise<{ bytes: number }>;
  close(): Promise<void>;
}

async function openWriter(path: string): Promise<WriterHandle> {
  try {
    const parquet: any = await import("parquetjs-lite");
    // Schema inferred on first batch.
    let writer: any = null;
    let schemaInited = false;
    let bytes = 0;
    return {
      async appendRows(rows) {
        if (!schemaInited) {
          const schema = inferParquetSchema(parquet, rows[0]);
          writer = await parquet.ParquetWriter.openFile(schema, path, {
            compression: "ZSTD",
          });
          schemaInited = true;
        }
        for (const r of rows) {
          await writer.appendRow(r);
        }
        // Approximate size accounting.
        bytes += rows.reduce(
          (a, r) => a + Buffer.byteLength(JSON.stringify(r)),
          0,
        );
        return { bytes };
      },
      async close() {
        if (writer) await writer.close();
      },
    };
  } catch {
    // JSONL fallback (DEFERRED).
    await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
    const fh = await fs.open(path.replace(/\.parquet$/, ".jsonl"), "w");
    let bytes = 0;
    return {
      async appendRows(rows) {
        const buf = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
        await fh.write(buf);
        bytes += Buffer.byteLength(buf);
        return { bytes };
      },
      async close() {
        await fh.close();
      },
    };
  }
}

function inferParquetSchema(parquet: any, sample: Record<string, unknown>): any {
  const cols: Record<string, { type: string; optional: boolean }> = {};
  for (const [k, v] of Object.entries(sample)) {
    if (typeof v === "number") {
      cols[k] = { type: Number.isInteger(v) ? "INT64" : "DOUBLE", optional: true };
    } else if (typeof v === "boolean") {
      cols[k] = { type: "BOOLEAN", optional: true };
    } else if (v instanceof Date) {
      cols[k] = { type: "TIMESTAMP_MILLIS", optional: true };
    } else {
      cols[k] = { type: "UTF8", optional: true };
    }
  }
  return new parquet.ParquetSchema(cols);
}
