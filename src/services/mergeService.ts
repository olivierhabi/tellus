// ---------------------------------------------------------------------------
// mergeService — branch merge algorithm (B7.07 + B7.08).
//
// detectConflicts(branchId): returns the list of branch_overlay rows
// whose target resource has been modified since the overlay was created.
//
// applyMerge(branchId, actorId): atomically applies all overlays for a
// branch, writes audit rows, emits Kafka events, and flips the branch
// status to MERGED.  Refuses to merge if any conflicts remain.
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool, PoolClient } from "pg";
import { auditWriter } from "./audit";
import { publishEvent } from "./kafkaProducer";

export interface MergeConflict {
  resourceRid: string;
  operation: 'UPSERT' | 'DELETE' | 'RENAME';
  observedEtag: number;
  currentEtag: number;
}

export interface MergeResult {
  branchId: string;
  applied: number;
  audited: number;
  emitted: number;
  status: 'MERGED' | 'CONFLICT';
  conflicts: MergeConflict[];
}

export class MergeService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async detectConflicts(branchId: string): Promise<MergeConflict[]> {
    const { rows } = await this.pool.query<{
      resource_rid: string;
      operation: 'UPSERT' | 'DELETE' | 'RENAME';
      observed_etag: number | null;
      current_etag: number | null;
    }>(
      `SELECT bo.resource_rid,
              bo.operation,
              (bo.payload->>'observedEtag')::int AS observed_etag,
              r.etag AS current_etag
       FROM branch_overlays bo
       LEFT JOIN resources r ON r.rid = bo.resource_rid
       WHERE bo.branch_id = $1`,
      [branchId],
    );
    return rows
      .filter((r) => r.observed_etag !== null && r.current_etag !== null && r.current_etag > r.observed_etag)
      .map((r) => ({
        resourceRid: r.resource_rid,
        operation: r.operation,
        observedEtag: Number(r.observed_etag),
        currentEtag: Number(r.current_etag),
      }));
  }

  /**
   * Apply all overlays for a branch in a single transaction. On success:
   *   - resources are updated/renamed/deleted per overlay payload,
   *   - one audit row is written per overlay (ALLOW + reason=MERGE),
   *   - one Kafka event is emitted per overlay on `ontology.events`,
   *   - the branch is flipped to MERGED.
   * If any overlay has a conflict, the transaction is aborted and a
   * CONFLICT result is returned without touching audit / Kafka.
   */
  async applyMerge(branchId: string, actorId: string): Promise<MergeResult> {
    // B7.09 — idempotent replay. If the branch is already MERGED, return
    // a no-op MergeResult without re-applying overlays. This makes the
    // merge endpoint safe to retry under network flakes / client retries
    // without double-applying.
    const branchRow = await this.pool.query<{ status: string }>(
      `SELECT status FROM branches WHERE id = $1`,
      [branchId],
    );
    if (branchRow.rows[0]?.status === 'MERGED') {
      return { branchId, applied: 0, audited: 0, emitted: 0, status: 'MERGED', conflicts: [] };
    }

    const conflicts = await this.detectConflicts(branchId);
    if (conflicts.length > 0) {
      return { branchId, applied: 0, audited: 0, emitted: 0, status: 'CONFLICT', conflicts };
    }

    const client = await this.pool.connect();
    let applied = 0;
    const overlays: Array<{ resource_rid: string; operation: 'UPSERT' | 'DELETE' | 'RENAME'; payload: Record<string, unknown> }> = [];
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{
        resource_rid: string;
        operation: 'UPSERT' | 'DELETE' | 'RENAME';
        payload: Record<string, unknown>;
      }>(
        `SELECT resource_rid, operation, payload FROM branch_overlays WHERE branch_id = $1 ORDER BY created_at ASC`,
        [branchId],
      );

      for (const ov of rows) {
        await this.applyOverlay(client, ov.resource_rid, ov.operation, ov.payload, actorId);
        applied += 1;
        overlays.push(ov);
      }

      await client.query(
        `UPDATE branches SET status = 'MERGED', merged_at = now(), updated_at = now() WHERE id = $1`,
        [branchId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // After the transaction commits, write audit + Kafka best-effort.
    let audited = 0;
    let emitted = 0;
    for (const ov of overlays) {
      try {
        await auditWriter.write({
          actorId,
          operationId: `compass:merge-${ov.operation.toLowerCase()}`,
          resourceRid: ov.resource_rid,
          decision: 'ALLOW',
          reason: 'MERGE',
          metadata: { branchId, payload: ov.payload },
        });
        audited += 1;
      } catch {
        /* audit best-effort */
      }
      try {
        await publishEvent('ontology.events', {
          ontologyId: ov.resource_rid,
          objectType: 'compass.branch.merge',
          branchId,
          operation: ov.operation,
          payload: ov.payload,
          actorId,
        });
        emitted += 1;
      } catch {
        /* kafka best-effort */
      }
    }

    return { branchId, applied, audited, emitted, status: 'MERGED', conflicts: [] };
  }

  private async applyOverlay(
    client: PoolClient,
    resourceRid: string,
    operation: 'UPSERT' | 'DELETE' | 'RENAME',
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<void> {
    if (operation === 'UPSERT') {
      const fields = (payload.fields as Record<string, unknown> | undefined) ?? {};
      const displayName = fields.displayName as string | undefined;
      if (displayName) {
        await client.query(
          `UPDATE resources SET display_name = $2, etag = etag + 1, updated_at = now(), updated_by = $3 WHERE rid = $1`,
          [resourceRid, displayName, actorId],
        );
      } else {
        await client.query(
          `UPDATE resources SET etag = etag + 1, updated_at = now(), updated_by = $2 WHERE rid = $1`,
          [resourceRid, actorId],
        );
      }
    } else if (operation === 'RENAME') {
      const newName = payload.newName as string | undefined;
      if (!newName) throw new Error('RENAME overlay missing newName');
      await client.query(
        `UPDATE resources SET display_name = $2, etag = etag + 1, updated_at = now(), updated_by = $3 WHERE rid = $1`,
        [resourceRid, newName, actorId],
      );
    } else if (operation === 'DELETE') {
      await client.query(
        `UPDATE resources SET trash_status = 'DIRECTLY_TRASHED', trashed_at = now(), trashed_by = $2,
                              etag = etag + 1, updated_at = now(), updated_by = $2 WHERE rid = $1`,
        [resourceRid, actorId],
      );
    }
  }
}

export const mergeService = new MergeService();
