// Audit duplicate foundry_datasets groups — DRY RUN ONLY (incident item 4).
// Read-only: lists every duplicate (project_id, folder_id, name) group with
// per-row provenance (created_at/by, file, status) and every reference
// (output-node bindings, columns, versions, lineage, deploy registrations,
// deploy build_results). Prints KEEP / ORPHAN / NEEDS-DECISION per group.
// Deletes (DB + MinIO) happen only after explicit approval, in a separate
// step with an audit log. Never deletes here.
//
// Usage: PG* env for the target DB, then `npx tsx scripts/audit-duplicate-datasets.ts`
import knex from "knex";

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

interface DupRow {
  id: string;
  name: string;
  created_at: string;
  created_by: string | null;
  file_path: string | null;
  status: string;
  row_count: number | null;
}

async function refs(table: string, col: string, id: string): Promise<number> {
  try {
    const r = (await k(table).where({ [col]: id }).count("* as n")) as Array<{
      n: string;
    }>;
    return Number(r[0]?.n ?? 0);
  } catch {
    return -1; // table/col absent on this DB
  }
}

async function main() {
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
  console.log(`DUPLICATE GROUPS: ${groups.length}`);
  for (const g of groups) {
    const q = k("foundry_datasets")
      .select("id", "name", "created_at", "created_by", "file_path", "status", "row_count")
      .where({ project_id: g.project_id, name: g.name });
    if (g.folder_id) q.andWhere({ folder_id: g.folder_id });
    else q.andWhereRaw("folder_id IS NULL");
    const rows = (await q.orderBy("created_at")) as DupRow[];
    console.log(
      `\n### "${g.name}" x${rows.length} | project=${String(g.project_id).slice(0, 8)} ` +
        `| folder=${g.folder_id ? String(g.folder_id).slice(0, 8) : "NULL(root)"}`,
    );
    for (const r of rows) {
      const boundNodes = (await k("pipeline_nodes")
        .select("id", "pipeline_id", "label")
        .where({ dataset_id: r.id })) as Array<{
        id: string;
        pipeline_id: string;
        label: string;
      }>;
      const columns = await refs("dataset_columns", "dataset_id", r.id);
      const versions = await refs("dataset_versions", "dataset_id", r.id);
      const linDown = await refs("dataset_lineage", "downstream_dataset_id", r.id);
      const linUp = await refs("dataset_lineage", "upstream_dataset_id", r.id);
      const regRecs = await refs(
        "pipeline_deploy_output_registrations",
        "dataset_id",
        r.id,
      );
      const backing = await refs("backing_datasource", "dataset_id", r.id);
      const txns = await refs("dataset_transaction", "dataset_id", r.id);
      // Compass mirror + trash snapshots reference dataset ids inside JSON.
      let resHits = -1;
      try {
        const rr = (await k("resources")
          .count("* as n")
          .whereRaw("metadata::text LIKE ?", [`%${r.id}%`])) as Array<{
          n: string;
        }>;
        resHits = Number(rr[0]?.n ?? 0);
      } catch {
        resHits = -1;
      }
      // Deploy build_results referencing this id (JSON scan, bounded).
      const depHits = (await k("pipeline_deployments")
        .select("id", "status", "created_at")
        .whereRaw("build_results::text LIKE ?", [`%${r.id}%`])
        .limit(5)) as Array<{ id: string; status: string; created_at: string }>;
      console.log(
        `  ${String(r.id).slice(0, 8)} | ${r.created_at} | by=${String(r.created_by ?? "null").slice(0, 8)} ` +
          `| status=${r.status} | rows=${r.row_count ?? "?"}`,
      );
      console.log(`    file=${(r.file_path ?? "").slice(-90)}`);
      console.log(
        `    refs: nodes=[${boundNodes.map((n) => `${String(n.id).slice(0, 8)}:${n.label}`).join(",") || "-"}] ` +
          `cols=${columns} versions=${versions} lineage=${linDown}/${linUp} regRecords=${regRecs} ` +
          `backing=${backing} txns=${txns} resources=${resHits} ` +
          `deployHits=[${depHits.map((d) => `${String(d.id).slice(0, 8)}/${d.status}`).join(",") || "-"}]`,
      );
      const hasDependents =
        columns > 0 || versions > 0 || linDown + linUp > 0 || backing > 0 || txns > 0 || resHits > 0;
      const verdict =
        boundNodes.length > 0 || depHits.length > 0 || regRecs > 0
          ? "KEEP (referenced)"
          : hasDependents
            ? "NEEDS-DECISION (unbound but has dependent metadata)"
            : "ORPHAN (delete candidate)";
      console.log(`    => ${verdict}`);
    }
  }
  await k.destroy();
}

main().catch((e) => {
  console.error("AUDIT FAILED:", e.message);
  process.exit(1);
});
