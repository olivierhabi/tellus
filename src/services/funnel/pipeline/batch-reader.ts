/**
 * B9 — Funnel batch reader.
 * Reads Iceberg snapshot pages and feeds Stage 1 of the pipeline.
 * Uses chunked pagination so the worker bounds memory on 1B-row scans.
 */
import { getIcebergCatalog } from "../../../lib/iceberg";

export type ReadPage = { rows: Record<string, unknown>[]; nextPageToken: string | null };

const PAGE_SIZE = 50000;

export async function* readDatasetPages(
  datasetRid: string,
  snapshotId: string | null,
): AsyncGenerator<Record<string, unknown>[]> {
  const catalog = getIcebergCatalog();
  let token: string | null = null;
  do {
    const page: ReadPage = await catalog.readPage({
      datasetRid,
      snapshotId,
      pageToken: token,
      pageSize: PAGE_SIZE,
    });
    if (page.rows.length > 0) yield page.rows;
    token = page.nextPageToken;
  } while (token);
}
