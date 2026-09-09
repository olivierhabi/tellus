import { pool } from "../db";

// ---------------------------------------------------------------------------
// One-time data repair — RssbFraudSignal canonical `signalStatus` backfill.
//
// Background: the funnel merge wrote the raw source column `signal_status`
// (snake_case) verbatim into object_instances.properties, while the governed
// decision-sync (confirm/dismiss) writes the canonical property key
// `signalStatus` (camelCase apiName). A historical reindex then wiped the
// camelCase key on 429 of 449 signals, leaving them with only the snake-case
// value — so the governed rssbOpenFraudCase criteria
// ("Signal status must be OPEN to open a case", evaluated PG-first against
// the canonical key) rejected every untouched signal even though the serving
// projection (keyed canonical) displayed them as OPEN.
//
// This script copies `signal_status` → `signalStatus` ONLY where the
// canonical key is absent — it never overwrites a governed value — and is
// idempotent and re-runnable. After it completes, run the store→serving
// sync (syncObjectInstancesToOpenSearch) so the serving index matches.
//
// Usage: npx tsx src/scripts/backfillSignalStatus.ts
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE object_instances
          SET properties = properties
                || jsonb_build_object('signalStatus', properties->>'signal_status'),
              version = version + 1,
              last_modified_at = now()
        WHERE object_type_api_name = 'RssbFraudSignal'
          AND NOT (properties ? 'signalStatus')
          AND properties ? 'signal_status'
        RETURNING primary_key`,
    );
    console.log(
      `[backfill-signal-status] repaired ${res.rowCount} RssbFraudSignal rows`,
    );
    // Report the post-repair distribution for the verification record.
    const dist = await client.query(
      `SELECT properties->>'signalStatus' AS signal_status, count(*)
         FROM object_instances
        WHERE object_type_api_name = 'RssbFraudSignal'
        GROUP BY 1 ORDER BY 2 DESC`,
    );
    for (const row of dist.rows) {
      console.log(`  ${row.signal_status ?? "(null)"}: ${row.count}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[backfill-signal-status] FAILED: ${(err as Error).message}`);
  process.exit(1);
});
