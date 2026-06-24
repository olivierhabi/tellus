// ---------------------------------------------------------------------------
// B5 — Local-FS Iceberg adapter (spec §B5 line 258).
//
// Writes Parquet files plus a metadata.json conforming to Iceberg spec v2
// to ${TELLUS_ICEBERG_ROOT}/<warehouse>/<namespace>/<table>/. Atomic commits
// via .tmp + fsync + rename.
//
// Parquet writing itself is delegated to `transaction.appendFiles()` which
// invokes parquetjs-lite or @dsnp/parquetjs — adapter just records the file
// paths in metadata.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CatalogAdapter,
  CatalogIdentity,
  IcebergMetadata,
  IcebergSnapshot,
} from "../index";

export function createLocalFsAdapter(): CatalogAdapter {
  const root =
    process.env.TELLUS_ICEBERG_ROOT ?? join(process.cwd(), "var", "iceberg");

  function pathFor(id: CatalogIdentity): {
    tableDir: string;
    metadataPath: string;
  } {
    const tableDir = join(root, id.warehouseRoot, id.namespace, id.table);
    const metadataPath = join(tableDir, "metadata.json");
    return { tableDir, metadataPath };
  }

  return {
    async ensureTable(id, initial) {
      const { tableDir, metadataPath } = pathFor(id);
      await fs.mkdir(tableDir, { recursive: true });
      await fs.mkdir(join(tableDir, "data"), { recursive: true });
      // Only write initial metadata if missing — never overwrite an existing
      // table's state from this method.
      try {
        await fs.access(metadataPath);
      } catch {
        const meta: IcebergMetadata = {
          ...initial,
          tableUuid: initial.tableUuid ?? randomUUID(),
          location: tableDir,
        };
        await atomicWriteJson(metadataPath, meta);
      }
    },

    async resolve(id) {
      const { metadataPath } = pathFor(id);
      try {
        const raw = await fs.readFile(metadataPath, "utf8");
        return JSON.parse(raw) as IcebergMetadata;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async commit(id, meta) {
      const { metadataPath } = pathFor(id);
      await atomicWriteJson(metadataPath, meta);
    },

    async listSnapshots(id): Promise<IcebergSnapshot[]> {
      const meta = await this.resolve(id);
      return meta?.snapshots ?? [];
    },
  };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(value, null, 2);
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(json);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}
