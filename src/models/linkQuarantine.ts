// ---------------------------------------------------------------------------
// LT-B4 — link_quarantine model
//
// Stores ONE_TO_ONE violations that the `quarantine` policy chose to
// preserve instead of rejecting. Admins can inspect, resolve (pick a
// target to keep) or dismiss pending entries.
// ---------------------------------------------------------------------------

import { query } from "../db";

export type QuarantineStatus = "pending" | "resolved" | "dismissed";

export interface LinkQuarantineRow {
  violation_id: string;
  link_type_id: string;
  ontology_id: string;
  link_type_api_name: string;
  source_pk: string;
  target_pk: string;
  attempted_at: string;
  reason: Record<string, unknown>;
  status: QuarantineStatus;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export async function insertQuarantineEntry(input: {
  linkTypeId: string;
  ontologyId: string;
  linkTypeApiName: string;
  sourcePk: string;
  targetPk: string;
  reason: Record<string, unknown>;
}): Promise<LinkQuarantineRow> {
  const result = await query(
    `INSERT INTO link_quarantine
       (link_type_id, ontology_id, link_type_api_name, source_pk, target_pk, reason)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.linkTypeId,
      input.ontologyId,
      input.linkTypeApiName,
      input.sourcePk,
      input.targetPk,
      JSON.stringify(input.reason ?? {}),
    ]
  );
  return result.rows[0] as LinkQuarantineRow;
}

export async function listQuarantineEntries(input: {
  ontologyId: string;
  linkTypeApiName?: string;
  status?: QuarantineStatus;
  limit?: number;
  offset?: number;
}): Promise<{ rows: LinkQuarantineRow[]; totalCount: number }> {
  const clauses: string[] = ["ontology_id = $1"];
  const params: any[] = [input.ontologyId];
  if (input.linkTypeApiName) {
    params.push(input.linkTypeApiName);
    clauses.push(`link_type_api_name = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.join(" AND ");
  const limit = Math.min(input.limit ?? 100, 1000);
  const offset = Math.max(input.offset ?? 0, 0);

  const countRes = await query(
    `SELECT COUNT(*)::int AS count FROM link_quarantine WHERE ${where}`,
    params
  );
  const listRes = await query(
    `SELECT * FROM link_quarantine WHERE ${where}
     ORDER BY attempted_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  return { rows: listRes.rows as LinkQuarantineRow[], totalCount: countRes.rows[0].count };
}

export async function resolveQuarantineEntry(
  violationId: string,
  resolvedBy: string,
  note?: string
): Promise<LinkQuarantineRow | null> {
  const result = await query(
    `UPDATE link_quarantine
        SET status = 'resolved',
            resolved_at = now(),
            resolved_by = $2,
            resolution_note = $3
      WHERE violation_id = $1 AND status = 'pending'
      RETURNING *`,
    [violationId, resolvedBy, note ?? null]
  );
  return (result.rows[0] as LinkQuarantineRow | undefined) ?? null;
}

export async function dismissQuarantineEntry(
  violationId: string,
  resolvedBy: string,
  note?: string
): Promise<LinkQuarantineRow | null> {
  const result = await query(
    `UPDATE link_quarantine
        SET status = 'dismissed',
            resolved_at = now(),
            resolved_by = $2,
            resolution_note = $3
      WHERE violation_id = $1 AND status = 'pending'
      RETURNING *`,
    [violationId, resolvedBy, note ?? null]
  );
  return (result.rows[0] as LinkQuarantineRow | undefined) ?? null;
}

/**
 * Bump the rolling violation counter on the link_type row. The counter
 * is decayed back to zero by a separate hourly job (see
 * services/linkViolationDecayJob.ts).
 */
export async function bumpViolationCounter(linkTypeId: string): Promise<void> {
  await query(
    `UPDATE link_type SET violation_count_24h = violation_count_24h + 1 WHERE link_type_id = $1`,
    [linkTypeId]
  );
}
