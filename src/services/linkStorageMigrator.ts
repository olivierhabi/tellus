// ---------------------------------------------------------------------------
// LT-B1 — Storage backend migrator
//
// Migrates an M2M link type from CSV-on-disk (`csv_legacy`) to the
// Lakekeeper-managed Iceberg namespace (`_links.<ontology>.<link>`).
// The actual Iceberg writes are delegated to a PyIceberg sidecar (shared
// with PB-B4). In environments where the sidecar isn't reachable we
// simulate the migration: flip the flag, pre-compute the manifest
// metadata in Postgres, and keep the CSV as the 30-day backup so the
// legacy path keeps working. Real deployments overwrite the stub via
// PYICEBERG_SIDECAR_URL.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { query } from "../db";
import { appError } from "../utils/appError";
import type { LinkTypeRow } from "../models/linkType";

const SIDECAR_URL = process.env.PYICEBERG_SIDECAR_URL;

export interface MigrationResult {
  linkTypeApiName: string;
  previousBackend: "csv_legacy" | "iceberg";
  newBackend: "iceberg";
  icebergTableName: string;
  csvRows: number;
  csvBackupRetainedUntil: string;
  durationMs: number;
  sidecarUsed: boolean;
}

function icebergTableName(ontologyId: string, linkApiName: string): string {
  const ont = ontologyId.replace(/-/g, "_").slice(0, 32);
  const link = linkApiName.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  return `_links.ont_${ont}.${link}`;
}

function countCsvRows(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const data = fs.readFileSync(filePath, "utf-8");
  const lines = data.trim().split("\n");
  return Math.max(0, lines.length - 1); // header
}

async function callSidecar(
  action: "migrate" | "append",
  payload: Record<string, unknown>
): Promise<{ ok: boolean; rows?: number; error?: string }> {
  if (!SIDECAR_URL) return { ok: false, error: "no_sidecar" };
  try {
    const resp = await fetch(`${SIDECAR_URL.replace(/\/+$/, "")}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `sidecar ${resp.status}: ${text.slice(0, 200)}` };
    }
    const body = (await resp.json()) as { rows?: number };
    return { ok: true, rows: body.rows ?? 0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function migrateLinkStorage(
  linkType: LinkTypeRow,
  ontologyId: string
): Promise<MigrationResult> {
  if (linkType.cardinality !== "MANY_TO_MANY") {
    throw appError(
      "VALIDATION_FAILED",
      `Only MANY_TO_MANY link types can migrate to Iceberg (got ${linkType.cardinality}).`
    );
  }
  if (linkType.storage_backend === "iceberg") {
    throw appError(
      "VALIDATION_FAILED",
      `Link type '${linkType.api_name}' already uses the iceberg backend.`
    );
  }
  if (!linkType.join_table_file_path) {
    throw appError(
      "VALIDATION_FAILED",
      "Legacy CSV join table is missing; nothing to migrate."
    );
  }

  const start = Date.now();
  const tableName = icebergTableName(ontologyId, linkType.api_name);
  const csvRows = countCsvRows(linkType.join_table_file_path);

  await query(
    `UPDATE link_type
        SET migration_started_at = now(),
            migration_failed_at = NULL,
            last_migration_error = NULL
      WHERE link_type_id = $1`,
    [linkType.link_type_id]
  );

  const sidecarRes = await callSidecar("migrate", {
    table: tableName,
    csv_path: linkType.join_table_file_path,
    ontology_id: ontologyId,
    link_api_name: linkType.api_name,
  });

  // TRUTHFULNESS FIX (OSv2 migration parity): the serving-backend flag
  // flips ONLY when the target write confirmed success AND the row-count
  // checksum matches the CSV source. Previously `storage_backend` flipped
  // unconditionally, which silently switched traversal to an Iceberg table
  // that may not exist (the `/edges` route then served empty results).
  const rowCountMatches =
    sidecarRes.ok && (sidecarRes.rows === undefined || sidecarRes.rows === csvRows);

  if (!rowCountMatches) {
    const reason = !sidecarRes.ok
      ? (sidecarRes.error ?? "sidecar_unavailable")
      : `row_count_mismatch: csv=${csvRows} sidecar=${sidecarRes.rows}`;
    await query(
      `UPDATE link_type
          SET migration_failed_at = now(),
              last_migration_error = $2
        WHERE link_type_id = $1`,
      [linkType.link_type_id, reason.slice(0, 500)]
    );
    throw appError(
      "STORAGE_MIGRATION_FAILED",
      `Migration of link type '${linkType.api_name}' to iceberg did not complete: ${reason}. ` +
        `storage_backend is unchanged (${linkType.storage_backend ?? "csv_legacy"}); safe to retry.`,
      { csvRows, sidecarRows: sidecarRes.rows ?? null }
    );
  }

  await query(
    `UPDATE link_type
        SET storage_backend = 'iceberg',
            iceberg_table_name = $2,
            migration_completed_at = now(),
            migration_failed_at = NULL,
            last_migration_error = NULL
      WHERE link_type_id = $1`,
    [linkType.link_type_id, tableName]
  );

  const retainedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    linkTypeApiName: linkType.api_name,
    previousBackend: (linkType.storage_backend ?? "csv_legacy") as "csv_legacy",
    newBackend: "iceberg",
    icebergTableName: tableName,
    csvRows: sidecarRes.rows ?? csvRows,
    csvBackupRetainedUntil: retainedUntil,
    durationMs: Date.now() - start,
    sidecarUsed: sidecarRes.ok,
  };
}
