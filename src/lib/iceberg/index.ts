// ---------------------------------------------------------------------------
// B5 — CatalogAdapter (spec §B5 line 257).
//
// Abstracts the underlying Iceberg metadata store. Tellus ships a local-fs
// adapter by default (sufficient for dev + small deployments) and stubs for
// REST / Glue / Snowflake. Production swaps via TELLUS_ICEBERG_ADAPTER.
//
// Adapter contract:
//   - resolve(): given a (warehouse, namespace, table) triple, return the
//     current metadata.json contents (or null if not exists).
//   - commit(): atomically replace metadata.json (via rename) with a new
//     version produced by the transaction module. Returns the new version.
//   - listSnapshots(): chronological list for read-back tests.
// ---------------------------------------------------------------------------

export interface IcebergMetadata {
  formatVersion: 2;
  tableUuid: string;
  location: string;
  /** Logical schema (Iceberg JSON schema). */
  schemas: Array<{
    schemaId: number;
    fields: Array<{
      id: number;
      name: string;
      type: string;
      required: boolean;
    }>;
  }>;
  currentSchemaId: number;
  partitionSpecs: Array<{
    specId: number;
    fields: Array<{ name: string; transform: string; sourceId: number }>;
  }>;
  defaultSpecId: number;
  snapshots: IcebergSnapshot[];
  currentSnapshotId: number | null;
  properties: Record<string, string>;
}

export interface IcebergSnapshot {
  snapshotId: number;
  timestampMs: number;
  /** Operation: `append`, `replace`, `overwrite`. */
  operation: "append" | "replace" | "overwrite";
  /** List of data file paths (Parquet). */
  dataFiles: string[];
  summary: Record<string, string>;
  /** Tellus build RID that produced this snapshot. */
  tellusBuildRid?: string;
}

export interface CatalogIdentity {
  warehouseRoot: string;
  namespace: string;
  table: string;
}

export interface CatalogAdapter {
  /** Read current metadata.json or null. */
  resolve(id: CatalogIdentity): Promise<IcebergMetadata | null>;

  /**
   * Atomically rename-commit a new metadata.json. The new file is staged
   * (write to .tmp), fsynced, then renamed over the old one — POSIX rename
   * is atomic within the same filesystem.
   */
  commit(id: CatalogIdentity, meta: IcebergMetadata): Promise<void>;

  /** Return snapshot list (for read-back tests). */
  listSnapshots(id: CatalogIdentity): Promise<IcebergSnapshot[]>;

  /** Create the namespace + table directories if missing. */
  ensureTable(id: CatalogIdentity, initial: IcebergMetadata): Promise<void>;
}

/** Boot the configured adapter. */
export async function loadCatalogAdapter(): Promise<CatalogAdapter> {
  const which = process.env.TELLUS_ICEBERG_ADAPTER ?? "local-fs";
  switch (which) {
    case "local-fs": {
      const mod = await import("./adapters/local-fs");
      return mod.createLocalFsAdapter();
    }
    case "rest": {
      const mod = await import("./adapters/rest");
      return mod.createRestAdapter();
    }
    default:
      throw new Error(`Unknown TELLUS_ICEBERG_ADAPTER: ${which}`);
  }
}

// ---------------------------------------------------------------------------
// Extended catalog surface used by B9 Funnel (batch reader + extract stage).
// Implementations not required for spec-level B5 SLO; lazy default returns
// an empty-page generator so unit tests of higher layers compile and run.
// Production deployments override TELLUS_ICEBERG_CATALOG with a real impl.
// ---------------------------------------------------------------------------

export interface FunnelCatalogPage {
  rows: Record<string, unknown>[];
  nextPageToken: string | null;
}

export interface FunnelCatalog {
  readPage(args: {
    datasetRid: string;
    snapshotId: string | null;
    pageToken: string | null;
    pageSize: number;
  }): Promise<FunnelCatalogPage>;
  /** Resolve a table identity for incremental extraction. */
  loadTable(namespace: string, name: string): Promise<{ namespace: string; name: string }>;
  /** List snapshots since an optional anchor. */
  listSnapshots(
    table: { namespace: string; name: string },
    opts?: { since?: string },
  ): Promise<Array<{ id: string }>>;
  /** Async scan of records in a snapshot. */
  scan(
    table: { namespace: string; name: string },
    opts: { snapshotId: string },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

let funnelCatalog: FunnelCatalog | null = null;

/** Register a Funnel-grade catalog (called once at process boot). */
export function setFunnelCatalog(c: FunnelCatalog): void {
  funnelCatalog = c;
}

function defaultFunnelCatalog(): FunnelCatalog {
  return {
    async readPage() {
      return { rows: [], nextPageToken: null };
    },
    async loadTable(namespace, name) {
      return { namespace, name };
    },
    async listSnapshots() {
      return [];
    },
    async scan() {
      async function* empty(): AsyncGenerator<Record<string, unknown>> {
        // intentionally empty
      }
      return empty();
    },
  };
}

/** Public accessors. Aliases provided for backwards-compatible call sites. */
export function getIcebergCatalog(): FunnelCatalog {
  return funnelCatalog ?? defaultFunnelCatalog();
}
export const getCatalog = getIcebergCatalog;

