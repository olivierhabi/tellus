// ---------------------------------------------------------------------------
// B5 — Iceberg transaction primitives (spec §B5 line 260).
//
// Provides three operations against a CatalogAdapter:
//   - replacePartitions(): snapshot mode (drop & replace all data files).
//   - appendFiles(): incremental mode (extend snapshot with new files).
//   - commit(): atomic metadata.json rename via adapter.commit.
//
// Parquet writing itself is done by callers via parquetjs-lite / @dsnp;
// transaction.ts only handles file-list bookkeeping + snapshot construction.
// ---------------------------------------------------------------------------

import type {
  CatalogAdapter,
  CatalogIdentity,
  IcebergMetadata,
  IcebergSnapshot,
} from "./index";

export interface DataFile {
  path: string;
  rowCount: number;
  fileSizeBytes: number;
}

export interface TransactionContext {
  adapter: CatalogAdapter;
  id: CatalogIdentity;
  buildRid?: string;
}

export async function replacePartitions(
  ctx: TransactionContext,
  newFiles: DataFile[],
  summary: Record<string, string> = {},
): Promise<IcebergSnapshot> {
  const current = await ctx.adapter.resolve(ctx.id);
  if (!current) {
    throw new Error(
      `replacePartitions: table ${ctx.id.namespace}.${ctx.id.table} does not exist`,
    );
  }
  const snapshot = makeSnapshot(current, newFiles, "replace", summary, ctx.buildRid);
  const next: IcebergMetadata = {
    ...current,
    snapshots: [...current.snapshots, snapshot],
    currentSnapshotId: snapshot.snapshotId,
  };
  await ctx.adapter.commit(ctx.id, next);
  return snapshot;
}

export async function appendFiles(
  ctx: TransactionContext,
  newFiles: DataFile[],
  summary: Record<string, string> = {},
): Promise<IcebergSnapshot> {
  const current = await ctx.adapter.resolve(ctx.id);
  if (!current) {
    throw new Error(
      `appendFiles: table ${ctx.id.namespace}.${ctx.id.table} does not exist`,
    );
  }
  const parent =
    current.snapshots.find((s) => s.snapshotId === current.currentSnapshotId) ??
    null;
  const carriedFiles = parent?.dataFiles ?? [];
  const snapshot = makeSnapshot(
    current,
    [...carriedFiles, ...newFiles.map((f) => f.path)] as unknown as DataFile[],
    "append",
    summary,
    ctx.buildRid,
  );
  // makeSnapshot used DataFile[] but I passed strings; rebuild data files
  // as raw paths to keep snapshot shape correct.
  snapshot.dataFiles = [
    ...carriedFiles,
    ...newFiles.map((f) => f.path),
  ];
  const next: IcebergMetadata = {
    ...current,
    snapshots: [...current.snapshots, snapshot],
    currentSnapshotId: snapshot.snapshotId,
  };
  await ctx.adapter.commit(ctx.id, next);
  return snapshot;
}

function makeSnapshot(
  current: IcebergMetadata,
  newFiles: DataFile[],
  operation: IcebergSnapshot["operation"],
  summary: Record<string, string>,
  buildRid?: string,
): IcebergSnapshot {
  const snapshotId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const totalRows = newFiles.reduce((a, f) => a + f.rowCount, 0);
  const totalBytes = newFiles.reduce((a, f) => a + f.fileSizeBytes, 0);
  return {
    snapshotId,
    timestampMs: Date.now(),
    operation,
    dataFiles: newFiles.map((f) => f.path),
    summary: {
      "added-data-files": String(newFiles.length),
      "added-records": String(totalRows),
      "added-files-size": String(totalBytes),
      ...summary,
    },
    tellusBuildRid: buildRid,
  };
}
