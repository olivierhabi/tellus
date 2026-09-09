// ---------------------------------------------------------------------------
// Backfill: RssbFraudSignal.severityRank (ops enrichment).
//
// The investigation queue orders by severityRank DESC. A data regeneration
// dropped the enrichment, leaving every signal's rank NULL and silently
// degrading the queue's severity ordering to amount-only.
//
// severityRank is the deterministic ordinal of the governed severity:
//   CRITICAL → 4, HIGH → 3, MEDIUM → 2, LOW → 1
//
// This script applies the enrichment through the platform's own write
// contract (object_instances upsert + ontology_edit WAL in one transaction),
// the same path the serving projector drains into OpenSearch — no direct
// serving-index writes. Idempotent: rows whose rank already matches are
// skipped, so it is safe to re-run after future detection builds.
// ---------------------------------------------------------------------------

import pg from "pg";

const POOL = new pg.Pool({
  connectionString:
    process.env.POSTGRES_URL ??
    "postgresql://tellus:tellus123@localhost:5432/tellus_db",
});

const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const client = await POOL.connect();
try {
  await client.query("BEGIN");
  const rows = await client.query(
    `SELECT ontology_id, branch_id, primary_key, properties, version
       FROM object_instances
      WHERE object_type_api_name = 'RssbFraudSignal'
      FOR UPDATE`,
  );
  let updated = 0;
  let skipped = 0;
  for (const row of rows.rows) {
    const severity = String(row.properties?.severity ?? "");
    const expected = RANK[severity] ?? null;
    if (expected == null) {
      skipped += 1;
      continue;
    }
    const current = row.properties?.severityRank ?? null;
    if (Number(current) === expected) {
      skipped += 1;
      continue;
    }
    const nextProperties = { ...row.properties, severityRank: expected };
    await client.query(
      `UPDATE object_instances
          SET properties = $1::jsonb, version = version + 1, last_modified_at = now()
        WHERE ontology_id = $2::uuid AND branch_id = $3::uuid
          AND object_type_api_name = 'RssbFraudSignal' AND primary_key = $4`,
      [JSON.stringify(nextProperties), row.ontology_id, row.branch_id, row.primary_key],
    );
    // ontology_edit WAL — the serving projector drains this into OpenSearch
    // (and any full reindex replays it), so the enrichment survives rebuilds.
    await client.query(
      `INSERT INTO ontology_edit
         (object_type_api_name, primary_key, operation, property_values,
          action_type_api_name, executed_by, edit_strategy, ontology_id, branch_id)
       VALUES ('RssbFraudSignal', $1, 'update', $2::jsonb,
               'opsSeverityRankBackfill', 'system', 'user_edit_wins', $3::uuid, $4::uuid)`,
      [row.primary_key, JSON.stringify({ severityRank: expected }), row.ontology_id, row.branch_id],
    );
    updated += 1;
  }
  await client.query("COMMIT");
  console.log(`severityRank backfill: updated=${updated} skipped=${skipped} total=${rows.rows.length}`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  await POOL.end();
}
