// ---------------------------------------------------------------------------
// reconcile-demo-datasources.ts
//
// Repairs the demo ontology's serving state so the Ontology Manager's
// Datasources tab and the Object Explorer tell the truth, and every Object
// Type that holds data is actually searchable.
//
// WHY THIS EXISTS
//
//   The demo environment was seeded by writing `object_type` +
//   `object_instances` rows directly, so 18 of its 47 Object Types ended up
//   with NEITHER a `backing_datasource` row NOR a `funnel_state` row. The
//   editor route still resolves (the object type exists), so the Datasources
//   tab renders — against nothing. Three of those types
//   (RssbClaim / RssbAppeal / RssbAuditCase) held 1,098 instances in the
//   system of record with NO OpenSearch index at all, i.e. invisible.
//
//   This script reconciles the three stores that must agree:
//
//     object_instances (SoR)  ── truth about what exists
//     ontology-<apiname>      ── truth about what is searchable
//     funnel_state            ── what the UI badge renders
//
// DESIGN RULES (each learned the hard way)
//
//   1. DISK PREFLIGHT IS MANDATORY. On 2026-10-03 the demo VM's root
//      filesystem hit 98% (29G). OpenSearch crossed its 95% flood-stage
//      watermark and set `read_only_allow_delete` on EVERY index. Every
//      index write then failed with
//      `TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark`.
//      Symptoms were wildly misleading: a stuck `ontology_edit` WAL row, an
//      empty evidence index, and missing indices all looked like data or seed
//      bugs. Syncing against a full disk does not error loudly — it silently
//      writes nothing. So we refuse to start unless the node has headroom.
//
//   2. NEVER PRUNE AN OVER-INDEXED TYPE. If OpenSearch holds MORE documents
//      than `object_instances`, the extra docs are not garbage to delete —
//      they may be real rows the SoR lost. Measured case:
//      `ontology-rssbapprovalrequest` served 76 seeded rows while the SoR's
//      only 9 rows were action-test probes (`APR-PROBE-RACE-01`,
//      `APR-PROBE-ROLE-DENIAL-01`, ...). Pruning would have destroyed the
//      real demo data and replaced it with test junk. Over-indexed types are
//      reported and left alone.
//
//   3. `objects_indexed` IS THE SERVED COUNT. It feeds the badge and the
//      "N objects" card, so it is written from the index's document count —
//      not from the SoR — for exactly the reason in (2).
//
//   4. IDEMPOTENT. Re-running when everything agrees is a no-op. Safe to put
//      in a deploy hook.
//
//   5. NO FABRICATED BACKING DATASOURCES. Action-written Object Types
//      (e.g. RssbEvidence, created by `rssbCreateInvestigationEvidence`) have
//      no dataset by design. This script never invents a `backing_datasource`
//      row; the empty Datasources tab for such a type is the CORRECT state,
//      and fabricating a pointer to a non-existent file would make a later
//      reindex fail.
//
// USAGE
//
//   npx tsx scripts/reconcile-demo-datasources.ts            # dry run (default)
//   npx tsx scripts/reconcile-demo-datasources.ts --apply    # write
//   npx tsx scripts/reconcile-demo-datasources.ts --types=RssbClaim,RssbEvidence
//   npx tsx scripts/reconcile-demo-datasources.ts --include-overindexed  # prune
//
// Exits non-zero if any target ends up unserved.
// ---------------------------------------------------------------------------

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "../src/db";
import { client } from "../src/services/opensearch/client";
import {
  getIndexName,
  getIndexStats,
} from "../src/services/opensearch/indexLifecycleManager";
import { syncObjectInstancesToOpenSearch } from "../src/services/opensearch/syncFromInstances";

/**
 * The Object Types to reconcile. Deliberately NOT "every Object Type with
 * missing metadata" — the 13 remaining unregistered types on the demo VM
 * (RssbPilotReadiness, RssbUatScenario, RssbServiceLevelObjective, ...)
 * hold ZERO instances and have no backing CSV. They are empty QA scaffolding
 * and are legitimately left alone; minting synthetic data for them is a
 * product decision, not a migration.
 */
const DEFAULT_TARGETS = [
  "RssbEvidence",
  "RssbAppeal",
  "RssbAuditCase",
  "RssbClaimPayment",
  "RssbApprovalRequest",
];

type Decision = "missing-index" | "under-indexed" | "in-sync" | "over-indexed" | "empty";

interface TargetReport {
  apiName: string;
  objectTypeId: string | null;
  ontologyId: string | null;
  instances: number;
  indexName: string;
  servedBefore: number;
  servedAfter: number | null;
  decision: Decision;
  action: "synced" | "left-alone" | "funnel-state-only" | "pruned";
  funnelStatus: string | null;
  warning?: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const INCLUDE_OVERINDEXED = process.argv.includes("--include-overindexed");
const TARGETS = (arg("types") ?? DEFAULT_TARGETS.join(",")).split(",").map((t) => t.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Preflight: disk headroom
// ---------------------------------------------------------------------------

/**
 * Read this node's filesystem usage out of the OpenSearch nodes stats API.
 *
 * Returns used% of the data path. OpenSearch's defaults on this deployment
 * are low=85% / high=90% / flood=95%; at flood the cluster switches indices
 * to `read_only_allow_delete` and every write is rejected. We require
 * strictly less than the LOW watermark so a sync that begins now cannot be
 * interrupted partway by the high watermark.
 */
async function diskUsedPercent(): Promise<number | null> {
  try {
    const { body } = await client.nodes.stats({ metric: ["fs"] });
    const nodes = (body as any)?.nodes ?? {};
    const values: number[] = [];
    for (const node of Object.values(nodes) as any[]) {
      const total = node?.fs?.total?.total_in_bytes;
      const available = node?.fs?.total?.available_in_bytes;
      if (typeof total === "number" && typeof available === "number" && total > 0) {
        values.push(((total - available) / total) * 100);
      }
    }
    if (values.length === 0) return null;
    return Math.max(...values);
  } catch {
    return null;
  }
}

const DISK_LIMIT_PCT = 85; // OpenSearch low watermark — sync must not start near it

async function preflight(): Promise<void> {
  const used = await diskUsedPercent();
  if (used === null) {
    console.log("  disk: could not read node fs stats — continuing (cannot verify headroom)");
    return;
  }
  console.log(`  disk: ${used.toFixed(1)}% used (must stay < ${DISK_LIMIT_PCT}% low watermark)`);
  if (used >= DISK_LIMIT_PCT) {
    const how =
      "\n  OpenSearch has crossed its disk watermark, so every index is likely in\n" +
      "  read_only_allow_delete and a sync would silently write NOTHING. Free space\n" +
      "  first, e.g.:\n" +
      "    docker builder prune -af\n" +
      "    docker image prune -af\n";
    if (!FORCE) {
      console.error(how);
      throw new Error("PREFLIGHT_DISK_PRESSURE");
    }
    console.warn(how);
    console.warn("  --force given: continuing anyway.");
  }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

async function resolveTarget(apiName: string) {
  const ot = await query(
    `SELECT object_type_id::text AS object_type_id, ontology_id::text AS ontology_id
       FROM object_type WHERE api_name = $1`,
    [apiName],
  );
  const inst = await query(
    `SELECT count(*)::int AS c FROM object_instances WHERE object_type_api_name = $1`,
    [apiName],
  );
  const pending = await query(
    `SELECT count(*)::int AS c FROM ontology_edit
      WHERE object_type_api_name = $1 AND applied_to_index_at IS NULL`,
    [apiName],
  );
  return {
    objectTypeId: (ot.rows[0]?.object_type_id as string | undefined) ?? null,
    ontologyId: (ot.rows[0]?.ontology_id as string | undefined) ?? null,
    instances: Number(inst.rows[0]?.c ?? 0),
    pendingEdits: Number(pending.rows[0]?.c ?? 0),
  };
}

async function servedCount(apiName: string): Promise<{ exists: boolean; count: number }> {
  try {
    const stats = await getIndexStats(apiName);
    if (!stats.exists) return { exists: false, count: 0 };
    return { exists: true, count: stats.documentCount };
  } catch (err) {
    console.warn(`  ! stats for ${apiName} failed: ${(err as Error).message}`);
    return { exists: false, count: 0 };
  }
}

function decide(instances: number, exists: boolean, served: number): Decision {
  if (!exists) return "missing-index";
  if (served < instances) return "under-indexed";
  if (served === instances) return "in-sync";
  return "over-indexed";
}

// ---------------------------------------------------------------------------
// funnel_state reconciliation
// ---------------------------------------------------------------------------

async function backupFunnelState(objectTypeIds: string[]): Promise<string | null> {
  if (objectTypeIds.length === 0) return null;
  const { rows } = await query(
    `SELECT * FROM funnel_state WHERE object_type_id = ANY($1::uuid[])`,
    [objectTypeIds],
  );
  // The container runs as a non-root user on a read-only-ish image, so the
  // default backup root is a writable temp dir rather than the repo cwd
  // (which is root-owned and made the first run die with EACCES).
  const dir =
    arg("backup-dir") ??
    join(process.env.RECONCILE_BACKUP_DIR ?? "/tmp", "reconcile-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "funnel_state.json");
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return file;
}

/**
 * Upsert the badge row for one Object Type.
 *
 * `objects_indexed` comes from the SERVED document count (rule 3). When the
 * index exists but is empty while the SoR has rows, we record `failed` with
 * an explanatory message rather than a green `indexed` badge over zero
 * served objects — a lying badge is what made this drift invisible.
 */
async function writeFunnelState(
  objectTypeId: string,
  apiName: string,
  served: number,
  instances: number,
  pendingEdits: number,
): Promise<string> {
  const indexName = getIndexName(apiName);
  const healthy = served > 0 || instances === 0;
  const status = healthy ? "indexed" : "failed";
  const errorMessage = healthy
    ? null
    : `Serving index '${indexName}' holds 0 documents while ${instances} object_instances rows exist in the system of record`;

  await query(
    `INSERT INTO funnel_state (
        object_type_id, status, objects_indexed, objects_failed, edits_pending,
        last_indexed_at, error_message, error_count, index_name
     )
     VALUES ($1, $2, $3, 0, $4, now(), $5, 0, $6)
     ON CONFLICT (object_type_id) DO UPDATE SET
        status = EXCLUDED.status,
        objects_indexed = EXCLUDED.objects_indexed,
        edits_pending = EXCLUDED.edits_pending,
        last_indexed_at = EXCLUDED.last_indexed_at,
        error_message = EXCLUDED.error_message,
        error_count = EXCLUDED.error_count,
        index_name = EXCLUDED.index_name,
        -- clear a stale run so the UI can never render a permanent "indexing"
        active_run_id = NULL,
        active_run_started_at = NULL,
        updated_at = now()`,
    [objectTypeId, status, served, pendingEdits, errorMessage, indexName],
  );
  return status;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n[reconcile] mode=${APPLY ? "APPLY" : "DRY RUN"} targets=${TARGETS.length}\n`);
  await preflight();
  console.log("");

  const reports: TargetReport[] = [];

  for (const apiName of TARGETS) {
    const { objectTypeId, ontologyId, instances, pendingEdits } = await resolveTarget(apiName);
    if (!objectTypeId || !ontologyId) {
      // Data with no schema row: the Object Type was removed upstream while
      // its `object_instances` rows (and possibly a serving index) survived.
      // NOT repairable here — recreating the type needs its properties and
      // mappings, which no longer exist anywhere. Reported, never fabricated.
      reports.push({
        apiName, objectTypeId, ontologyId, instances,
        indexName: getIndexName(apiName), servedBefore: -1, servedAfter: null,
        decision: "empty", action: "left-alone", funnelStatus: null,
        warning:
          instances > 0
            ? `no object_type row — ${instances} orphaned object_instances row(s) exist with no schema; needs a schema decision`
            : "no such object type — skipped",
      });
      console.log(
        `[${apiName}] SKIP — no object_type row` +
        (instances > 0 ? ` (${instances} orphaned instance(s) reported, not touched)` : ""),
      );
      continue;
    }

    const before = await servedCount(apiName);
    const decision = decide(instances, before.exists, before.count);
    const report: TargetReport = {
      apiName, objectTypeId, ontologyId, instances,
      indexName: getIndexName(apiName),
      servedBefore: before.exists ? before.count : 0,
      servedAfter: null,
      decision,
      action: "left-alone",
      funnelStatus: null,
    };

    console.log(
      `[${apiName}] SoR=${instances} served=${before.exists ? before.count : "NO INDEX"} ` +
      `pendingEdits=${pendingEdits} -> ${decision}`,
    );

    // ---- serving -------------------------------------------------------
    const shouldSync = decision === "missing-index" || decision === "under-indexed";
    const shouldPrune = decision === "over-indexed" && INCLUDE_OVERINDEXED;

    if ((shouldSync || shouldPrune) && APPLY) {
      const res = await syncObjectInstancesToOpenSearch(apiName, ontologyId);
      const after = await servedCount(apiName);
      report.servedAfter = after.count;
      report.action = shouldPrune ? "pruned" : "synced";
      console.log(
        `   synced: indexCreated=${res.indexCreated} read=${res.rowsRead} ` +
        `indexed=${res.rowsIndexed} failed=${res.rowsFailed} pruned=${res.rowsOrphanDeleted} ` +
        `-> served=${after.count} (${res.durationMs}ms)`,
      );
      if (res.rowsFailed > 0) {
        report.warning = `${res.rowsFailed} document(s) rejected by OpenSearch`;
      }
    } else if (decision === "over-indexed" && !INCLUDE_OVERINDEXED) {
      report.action = "left-alone";
      report.warning =
        `index serves ${before.count} docs but the SoR holds ${instances} — ` +
        `NOT pruning (see rule 2); serving count wins`;
      console.log(`   report-only: ${report.warning}`);
    } else {
      report.action = "left-alone";
    }

    // ---- funnel_state --------------------------------------------------
    const servedFinal = report.servedAfter ?? (before.exists ? before.count : 0);
    if (APPLY && instances > 0) {
      report.funnelStatus = await writeFunnelState(
        objectTypeId, apiName, servedFinal, instances, pendingEdits,
      );
      console.log(`   funnel_state: ${report.funnelStatus} (objects_indexed=${servedFinal})`);
    } else if (instances > 0) {
      const would = servedFinal > 0 ? "indexed" : "failed";
      report.funnelStatus = would;
      console.log(`   would write funnel_state: ${would} (objects_indexed=${servedFinal})`);
    }

    reports.push(report);
    console.log("");
  }

  // ---- backup + summary ------------------------------------------------
  const ids = reports.map((r) => r.objectTypeId).filter((v): v is string => !!v);
  const backupFile = await backupFunnelState(ids);
  if (backupFile) console.log(`[reconcile] funnel_state backup: ${backupFile}\n`);

  console.log("SUMMARY");
  console.log(
    `${"object type".padEnd(24)}${"SoR".padStart(6)}${"served".padStart(9)}  ${"decision".padEnd(15)}action`,
  );
  for (const r of reports) {
    console.log(
      `${r.apiName.padEnd(24)}${String(r.instances).padStart(6)}` +
      `${String(r.servedAfter ?? r.servedBefore).padStart(9)}  ` +
      `${r.decision.padEnd(15)}${r.action}`,
    );
    if (r.warning) console.log(`${" ".repeat(24)}↳ ${r.warning}`);
  }

  // A target is "unserved" only if we actually assessed it — entries skipped
  // for having no schema row are reported above, not treated as failures here.
  const unserved = reports.filter(
    (r) => r.decision !== "empty" && r.instances > 0 && (r.servedAfter ?? Math.max(r.servedBefore, 0)) === 0,
  );
  console.log("");
  if (unserved.length > 0) {
    console.error(`FAIL — ${unserved.length} type(s) hold data but serve nothing: ${unserved.map((r) => r.apiName).join(", ")}`);
    process.exit(1);
  }
  console.log(APPLY ? "OK — all targeted types serve their data." : "DRY RUN — pass --apply to write.");
}

main().catch((err: unknown) => {
  console.error("\n[reconcile] FAIL:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});