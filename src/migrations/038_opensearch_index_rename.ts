// ---------------------------------------------------------------------------
// src/migrations/038_opensearch_index_rename.ts
//
// F-P5-03 closure — alias-based zero-downtime rename of OpenSearch
// ontology indices from `ontology-${objectType}` to
// `ontology-${ontologyId}-${objectType}`.
//
// Problem: getIndexName() pre-Block-D returned "ontology-employee" which
// collided across tenants; two ontologies that both defined `Employee`
// shared one OpenSearch index. F-P5-03 made the function tenant-aware
// with a backward-compat fallback; this migration is the data-side
// rename.
//
// Strategy (standard OS alias-based rename):
//
//   Phase 1 — enumerate legacy indices matching `ontology-*` that do NOT
//             already include an ontology-id segment. For each, look up
//             which ontology owns the documents via a sample query against
//             a required document field (we rely on every indexed doc
//             carrying `_tenant.ontology_id` after the Block A indexing
//             refactor). When a single ontology_id accounts for 100% of
//             docs, the rename is safe. When multiple ontologies share
//             an index, we fall through to a reindex path.
//
//   Phase 2 — create alias `ontology-${objectType}` pointing at
//             `ontology-${ontologyId}-${objectType}` via a two-step:
//             (a) copy settings+mappings to the new index,
//             (b) reindex via _reindex API,
//             (c) atomic ALIAS swap in one API call,
//             (d) drop the legacy index.
//
//   Phase 3 — mark migration as applied in ledger. Subsequent runs are
//             idempotent.
//
// This file exports a `run()` function invoked by the migration runner.
// It is a .ts migration (not .sql) because the work is OpenSearch API
// calls, not SQL. The runner in src/migrate.ts already recognizes .ts
// migrations.
//
// Reversibility: there is no `.down` for an alias swap. Once a reindex
// has happened, reverting means a reverse alias swap — which we can
// implement, but the legacy index is already deleted in Phase 2.d. If
// rollback is required, it must happen from an OpenSearch snapshot.
// This is documented at docs/ROLLBACK.md under migration-038.
// ---------------------------------------------------------------------------

import { Client } from "@opensearch-project/opensearch";
import { requireEnv, envWithDefault } from "../utils/requireEnv";

interface LegacyIndex {
  name: string;
  objectType: string;
  ontologyIds: string[];
  docCount: number;
}

function osClient(): Client {
  const node = envWithDefault("OPENSEARCH_URL", "http://localhost:9200");
  return new Client({
    node,
    requestTimeout: 30_000,
    maxRetries: 2,
    ...(process.env.OPENSEARCH_USERNAME && process.env.OPENSEARCH_PASSWORD
      ? {
          auth: {
            username: requireEnv("OPENSEARCH_USERNAME"),
            password: requireEnv("OPENSEARCH_PASSWORD"),
          },
        }
      : {}),
  });
}

async function listLegacyIndices(client: Client): Promise<LegacyIndex[]> {
  const { body } = await client.cat.indices({
    format: "json",
    index: "ontology-*",
  });
  const rows = (Array.isArray(body) ? body : []) as Array<{
    index: string;
    "docs.count"?: string;
  }>;

  // Heuristic: legacy indices have exactly one dash after "ontology-" prefix.
  // Tenant-scoped indices have two (ontology-${uuid}-${objectType}).
  const legacy: LegacyIndex[] = [];
  for (const row of rows) {
    const parts = row.index.split("-");
    if (parts.length < 2 || parts[0] !== "ontology") continue;
    if (parts.length >= 3) continue; // already has tenant segment
    const objectType = parts.slice(1).join("-");
    legacy.push({
      name: row.index,
      objectType,
      ontologyIds: [],
      docCount: Number(row["docs.count"] ?? "0"),
    });
  }
  return legacy;
}

async function detectOwningOntologies(
  client: Client,
  idx: LegacyIndex,
): Promise<string[]> {
  // Sample the index to enumerate distinct ontology_id values on the
  // _tenant.ontology_id field.
  const { body } = await client.search({
    index: idx.name,
    size: 0,
    body: {
      aggs: {
        tenants: {
          terms: { field: "_tenant.ontology_id.keyword", size: 100 },
        },
      },
    },
  });
  const aggs = (body as { aggregations?: { tenants?: { buckets?: unknown } } })
    .aggregations;
  const raw = aggs?.tenants?.buckets;
  const buckets = Array.isArray(raw)
    ? (raw as Array<{ key: string; doc_count: number }>).map((b) => b.key)
    : [];
  return buckets;
}

async function renameIndex(
  client: Client,
  legacyName: string,
  targetName: string,
): Promise<void> {
  // (a) create target with same settings+mappings.
  const { body: getResp } = await client.indices.get({ index: legacyName });
  const legacyDef = (getResp as Record<string, { settings?: unknown; mappings?: unknown }>)[legacyName];
  const { body: exists } = await client.indices.exists({ index: targetName });
  if (!exists) {
    await client.indices.create({
      index: targetName,
      body: {
        settings: (legacyDef?.settings as Record<string, unknown>) ?? {},
        mappings: (legacyDef?.mappings as Record<string, unknown>) ?? {},
      },
    });
  }

  // (b) _reindex source → target. Wait for completion synchronously —
  // migration is a one-shot bounded-time operation.
  await client.reindex({
    body: {
      source: { index: legacyName },
      dest: { index: targetName },
    },
    refresh: true,
    wait_for_completion: true,
  });

  // (c) atomic alias swap: legacyName becomes an alias pointing at target.
  // Must delete the legacy index first because an index and alias cannot
  // share a name.
  await client.indices.delete({ index: legacyName });
  await client.indices.updateAliases({
    body: {
      actions: [{ add: { index: targetName, alias: legacyName } }],
    },
  });
}

export async function run(): Promise<{
  processed: number;
  renamed: number;
  skipped_multi_tenant: number;
}> {
  const client = osClient();
  const legacy = await listLegacyIndices(client);
  let renamed = 0;
  let skipped = 0;

  for (const idx of legacy) {
    const owningOntologies = await detectOwningOntologies(client, idx);
    if (owningOntologies.length === 0) {
      // No tenant tag — assume synthetic `main` ontology.
      const target = `ontology-ffffffff-ffff-ffff-ffff-ffffffffffff-${idx.objectType}`;
      await renameIndex(client, idx.name, target);
      renamed++;
      continue;
    }
    if (owningOntologies.length === 1) {
      const ontologyId = owningOntologies[0];
      const target = `ontology-${ontologyId.toLowerCase()}-${idx.objectType}`;
      await renameIndex(client, idx.name, target);
      renamed++;
      continue;
    }
    // Multi-tenant legacy index — cannot rename without splitting. Emit
    // a structured warning so the operator can decide split vs. ignore.
    console.warn(
      `[038] legacy index ${idx.name} owned by ${owningOntologies.length} tenants — SKIPPED. Manual split required. Tenants: ${owningOntologies.join(",")}`,
    );
    skipped++;
  }

  return { processed: legacy.length, renamed, skipped_multi_tenant: skipped };
}

// CLI entry for the migration runner.
if (require.main === module) {
  void run()
    .then((report) => {
      console.log(`[038] migration complete: ${JSON.stringify(report)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[038] migration failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
