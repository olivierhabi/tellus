/**
 * QA-only fixture namespace reset for the Rwanda campaign runner.
 *
 * Mounted exclusively under TELLUS_TEST_HOOKS=1 (see server.ts), exactly like
 * the rate-limiter reset hook. It exists to restore the plan §10.5 lifecycle
 * invariant: every campaign must start from the same generated slate.
 *
 * Why it is needed: object edits use the `user_edit_wins` strategy, so an
 * earlier campaign's action results (e.g. a reconciled transaction) survive
 * the per-run datasource re-ingestion. Resetting by the `QA-RW-` primary-key
 * prefix — never by ontology or type name — guarantees the merged CSV state
 * is exact before any browser journey executes. All QA data is synthetic
 * (plan §10); deleting it is test-lifecycle housekeeping, never a product
 * audit operation.
 */
import type { Request, Response } from "express";
import { query } from "../../db";
import { getOverlayStore } from "../../services/overlay/getOverlayStore";
import { overlayKey } from "../../services/overlay/overlayStore";

const QA_PREFIX = "QA-RW-";

export const RWANDA_QA_RESET_ROUTE = "/api/v1/_test/qa/rwanda/reset";

export async function resetRwandaQaNamespace(_req: Request, res: Response): Promise<void> {
  try {
    // Purge writeback overlays for QA object types first, so no read path can
    // resurrect a stale projection after the PG rows vanish.
    const store = await getOverlayStore();
    const types = await query(
      `SELECT DISTINCT object_type_api_name FROM object_instances WHERE primary_key LIKE $1`,
      [`${QA_PREFIX}%`],
    ) as unknown as { rows: Array<{ object_type_api_name: string }> };
    let overlaysDropped = 0;
    for (const row of types.rows) {
      for (const record of await store.scan(row.object_type_api_name)) {
        if (record.primaryKey.startsWith(QA_PREFIX)) {
          await store.delete(overlayKey(record.branchId, record.objectType, record.primaryKey));
          overlaysDropped += 1;
        }
      }
    }

    const deleted: Record<string, number> = {};
    // The two Rwanda §6.3 tables are QA-exclusive (migration 168).
    deleted.rwanda_bulk_reconciliation_business_key = (
      await query(`DELETE FROM rwanda_bulk_reconciliation_business_key`)
    ).rowCount ?? 0;
    deleted.rwanda_bulk_reconciliation_run = (
      await query(`DELETE FROM rwanda_bulk_reconciliation_run`)
    ).rowCount ?? 0;
    // CDC outbox rows reference object payloads, not primary-key columns.
    deleted.object_cdc_outbox = (
      await query(`DELETE FROM object_cdc_outbox WHERE payload::text LIKE $1`, [`%${QA_PREFIX}%`])
    ).rowCount ?? 0;
    deleted.link_edit = (
      await query(
        `DELETE FROM link_edit WHERE source_primary_key LIKE $1 OR target_primary_key LIKE $1`,
        [`${QA_PREFIX}%`],
      )
    ).rowCount ?? 0;
    deleted.object_edits = (
      await query(`DELETE FROM object_edits WHERE primary_key LIKE $1`, [`${QA_PREFIX}%`])
    ).rowCount ?? 0;
    deleted.ontology_edit = (
      await query(`DELETE FROM ontology_edit WHERE primary_key LIKE $1`, [`${QA_PREFIX}%`])
    ).rowCount ?? 0;
    deleted.object_instances = (
      await query(`DELETE FROM object_instances WHERE primary_key LIKE $1`, [`${QA_PREFIX}%`])
    ).rowCount ?? 0;

    res.json({ ok: true, prefix: QA_PREFIX, overlaysDropped, deleted });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
