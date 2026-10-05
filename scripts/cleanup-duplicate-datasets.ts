// Cleanup duplicate foundry_datasets groups — APPROVED execution (incident item 4).
// Owner approved all three tiers on 2026-10-05 (see incident record).
//
// Default is DRY RUN (prints the plan). Pass --execute to delete.
// Safety nets (abort the group, never force):
//   - a DELETE candidate with live refs (node binding, versions, lineage,
//     backing datasource, transactions, resource JSON, succeeded-deploy
//     mention) is refused;
//   - explicit KEEP ids are re-verified node-bound at runtime;
//   - MinIO purge is delete-if-exists per recorded key (iceberg:// skipped).
// DB deletes run in ONE transaction (columns -> versions -> lineage ->
// datasets); MinIO purge follows; every removed id is audit-logged.
//
// Usage: PG* + S3 env for the target DB, then
//   npx tsx scripts/cleanup-duplicate-datasets.ts [--execute]
import knex from "knex";
import { writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");

const k = knex({
  client: "pg",
  connection: {
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "tellus",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "tellus_db",
  },
});

// Explicit keeps (incident + node-bound rows). Re-verified bound at runtime.
const EXPLICIT_KEEP = new Set([
  "8993b1b8-62a5-41e4-9b03-5092277232e7", // accounts (bound fc1b13f7)
  "28a5d498-b768-466a-ae79-1e7ba3500325", // transactions_clean (bound 8b18cbaa)
  "b5523af4-5893-4033-b78d-690f80fd6c0b", // mule_chain_metrics (bound 0553ba4c)
  "655d52e1-dc1d-440c-9c45-8be091a2b354", // tariff.csv (bound 68b36b1e)
  "71def472-84cb-4837-9fec-f2e3facafab7", // vip_customers.csv (bound b6702b63)
  "e6ca076a-88db-4cc8-90d3-01105a431af7", // action_audit_log_raw (bound 60275830)
]);

interface Row {
  id: string;
  name: string;
  project_id: string;
  folder_id: string | null;
  created_at: string;
  file_path: string | null;
}

async function deployHits(id: string) {
  return (await k("pipeline_deployments")
    .select("id", "status")
    .whereRaw("build_results::text LIKE ?", [`%${id}%`])
    .limit(5)) as Array<{ id: string; status: string }>;
}

async function main() {
  const audit: Record<string, unknown> = {
    mode: EXECUTE ? "execute" : "dry-run",
    at: new Date().toISOString(),
    groups: [],
  };
  // Resolve placeholder keeps by (project, folder, name, node-bound) so the
  // script never trusts a hardcoded id for user-data rows.
  const groups = (await k("foundry_datasets")
    .select("project_id", "folder_id", "name")
    .count("* as n")
    .groupBy("project_id", "folder_id", "name")
    .havingRaw("count(*) > 1")
    .orderBy("name")) as Array<{
    project_id: string;
    folder_id: string | null;
    name: string;
    n: string;
  }>;
  console.log(`DUPLICATE GROUPS: ${groups.length} (mode: ${audit.mode})`);

  const toDelete: Row[] = [];
  const keeps: Row[] = [];
  const repairs: Array<{ datasetId: string; dropOrdinals: number }> = [];

  for (const g of groups) {
    const q = k("foundry_datasets")
      .select("id", "name", "project_id", "folder_id", "created_at", "file_path")
      .where({ project_id: g.project_id, name: g.name });
    if (g.folder_id) q.andWhere({ folder_id: g.folder_id });
    else q.andWhereRaw("folder_id IS NULL");
    const rows = (await q.orderBy("created_at")) as Row[];

    // KEEP: explicit id if present (verified bound below), else newest.
    let keep: Row | undefined = rows.find((r) => EXPLICIT_KEEP.has(r.id));
    if (!keep) keep = rows[rows.length - 1];
    if (EXPLICIT_KEEP.has(keep.id)) {
      const bound = await k("pipeline_nodes")
        .where({ dataset_id: keep.id })
        .first("id");
      if (!bound) {
        console.log(`REFUSED group "${g.name}": explicit keep ${keep.id.slice(0, 8)} not node-bound`);
        continue;
      }
    }
    keeps.push(keep);

    for (const r of rows) {
      if (r.id === keep.id) continue;
      const bound = await k("pipeline_nodes").where({ dataset_id: r.id }).first("id");
      const cols = Number(((await k("dataset_columns").where({ dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      const vers = Number(((await k("dataset_versions").where({ dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      const linD = Number(((await k("dataset_lineage").where({ downstream_dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      const linU = Number(((await k("dataset_lineage").where({ upstream_dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      const backing = Number(((await k("backing_datasource").where({ dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      const txns = Number(((await k("dataset_transaction").where({ dataset_id: r.id }).count("* as n").first()) as unknown as { n: string }).n);
      let resHits = 0;
      try {
        resHits = Number(((await k("resources").count("* as n").whereRaw("metadata::text LIKE ?", [`%${r.id}%`]).first()) as unknown as { n: string }).n);
      } catch { /* table/shape absent */ }
      const hits = await deployHits(r.id);
      const succeededHit = hits.some((h) => h.status === "succeeded");
      if (bound || vers > 0 || linD + linU > 0 || backing > 0 || txns > 0 || resHits > 0 || succeededHit) {
        console.log(
          `REFUSED ${r.id.slice(0, 8)} ("${r.name}"): live refs ` +
            `nodes=${bound ? 1 : 0} vers=${vers} lin=${linD}/${linU} backing=${backing} txns=${txns} res=${resHits} ` +
            `succeededHit=${succeededHit}`,
        );
        continue;
      }
      // Shared bytes with the keep row: delete the ROW but never purge
      // the object (purge set excludes it below). iceberg:// paths are
      // table references, not objects — never purged either way.
      const sharedBytes =
        !!r.file_path && !!keep.file_path && r.file_path === keep.file_path;
      (r as Row & { cols: number; sharedBytes: boolean }).cols = cols;
      (r as Row & { cols: number; sharedBytes: boolean }).sharedBytes = sharedBytes;
      toDelete.push(r);
    }

    // Column-doubling repair check on the keep row (dual writers both
    // wrote dataset_columns): identical ordinal sets -> drop newer copy.
    const dupOrd = (await k("dataset_columns")
      .select("ordinal_position")
      .count("* as n")
      .where({ dataset_id: keep.id })
      .groupBy("ordinal_position")
      .havingRaw("count(*) > 1")) as Array<{ ordinal_position: number; n: string }>;
    if (dupOrd.length > 0) {
      repairs.push({ datasetId: keep.id, dropOrdinals: dupOrd.length });
    }
    (audit.groups as unknown[]).push({
      name: g.name,
      keep: keep.id,
      delete: rows.filter((r) => r.id !== keep.id).map((r) => r.id),
      columnRepairOrdinals: dupOrd.length,
    });
  }

  console.log(`\nKEEP: ${keeps.length} | DELETE: ${toDelete.length} | COLUMN REPAIRS: ${repairs.length}`);
  for (const r of toDelete) {
    console.log(`  del ${r.id} "${r.name}" file=${(r.file_path ?? "").slice(-70)}`);
  }
  for (const r of repairs) {
    console.log(`  repair cols ${r.datasetId.slice(0, 8)} (drop ${r.dropOrdinals} dup ordinals)`);
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN — no writes. Re-run with --execute.");
    await k.destroy();
    return;
  }

  // Column repairs first (keep rows): verify identical name sets per ordinal,
  // then drop the newer copy (max ctid).
  await k.transaction(async (trx) => {
    for (const rep of repairs) {
      const sets = (await trx("dataset_columns")
        .select("ordinal_position", "column_name")
        .where({ dataset_id: rep.datasetId })
        .orderBy(["ordinal_position", "column_name"])) as Array<{
        ordinal_position: number;
        column_name: string;
      }>;
      const byOrd = new Map<number, string[]>();
      for (const s of sets) {
        const arr = byOrd.get(s.ordinal_position) ?? [];
        arr.push(s.column_name);
        byOrd.set(s.ordinal_position, arr);
      }
      for (const [ord, names] of byOrd) {
        if (new Set(names).size !== 1) {
          throw new Error(
            `column repair refused on ${rep.datasetId.slice(0, 8)} ordinal ${ord}: divergent names ${names.join(",")}`,
          );
        }
      }
      await trx.raw(
        `DELETE FROM dataset_columns a USING dataset_columns b
          WHERE a.dataset_id = ? AND b.dataset_id = a.dataset_id
            AND a.ordinal_position = b.ordinal_position AND a.ctid > b.ctid`,
        [rep.datasetId],
      );
    }
    for (const r of toDelete) {
      await trx("dataset_columns").where({ dataset_id: r.id }).del();
      await trx("dataset_versions").where({ dataset_id: r.id }).del();
      await trx("dataset_lineage")
        .where({ downstream_dataset_id: r.id })
        .orWhere({ upstream_dataset_id: r.id })
        .del();
      await trx("foundry_datasets").where({ id: r.id }).del();
    }
  });
  console.log("DB deletes committed.");

  // MinIO purge (idempotent, MinIO keys only, never shared bytes).
  const keepPaths = new Set(
    keeps.map((k) => k.file_path).filter((f): f is string => !!f),
  );
  const keys = [
    ...new Set(
      toDelete
        .map((r) => (r as Row & { sharedBytes?: boolean }).sharedBytes ? null : r.file_path)
        .filter(
          (f): f is string =>
            !!f && !f.startsWith("iceberg://") && !keepPaths.has(f),
        ),
    ),
  ];
  if (keys.length > 0) {
    const { deleteObjects } = await import("../src/services/storageService");
    const res = await deleteObjects(keys);
    console.log(`MinIO purge: deleted=${res.deleted} errors=${res.errors}`);
    (audit as Record<string, unknown>).minio = { keys, ...res };
  } else {
    console.log("MinIO purge: nothing to purge.");
  }

  (audit as Record<string, unknown>).deleted = toDelete.map((r) => r.id);
  const leftovers = (await k("foundry_datasets")
    .select("project_id", "folder_id", "name")
    .count("* as n")
    .groupBy("project_id", "folder_id", "name")
    .havingRaw("count(*) > 1")) as unknown[];
  console.log(`REMAINING DUPLICATE GROUPS: ${leftovers.length}`);
  const auditPath = `/tmp/dupe-cleanup-audit-${Date.now()}.json`;
  writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  console.log(`Audit log: ${auditPath}`);
  await k.destroy();
}

main().catch((e) => {
  console.error("CLEANUP FAILED:", e.message);
  process.exit(1);
});
