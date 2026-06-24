// ---------------------------------------------------------------------------
// sync-olivier-markings.ts — one-off showcase utility.
//
// Re-syncs an object type's `object_instances` rows into OpenSearch via the
// real instance-sync path (`syncObjectInstancesToOpenSearch`), which stamps
// each doc's `_security.markings` from the Postgres `markings` column. The
// datasource reindex endpoint (`.../reindex`) rebuilds from the CSV/datasource
// and defaults markings to PUBLIC, so it CANNOT carry the seeded spread — this
// instance-sync is the path that does.
//
// Pairs with tellus-fe `scripts/seed-object-table-markings.mjs`, which sets the
// `markings` column. Run that first (sets the column), then this (lands it in
// the search index):
//
//   cd tellus && npx tsx scripts/sync-olivier-markings.ts
//
// Override the type via OBJECT_TYPE. Self-configures DB (PG*) + OpenSearch
// (OPENSEARCH_URL, default http://localhost:9200) from .env.
// ---------------------------------------------------------------------------
import "dotenv/config";

async function main() {
  // Import AFTER dotenv so db.ts builds its Pool from the loaded env.
  const { syncObjectInstancesToOpenSearch } = await import(
    "../src/services/opensearch/syncFromInstances"
  );
  const type = process.env.OBJECT_TYPE ?? "OlivierOrderJune";
  const result = await syncObjectInstancesToOpenSearch(type);
  console.log("[sync]", JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
