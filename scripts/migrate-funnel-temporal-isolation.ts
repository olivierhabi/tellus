// scripts/migrate-funnel-temporal-isolation.ts — FUNN-ISO-9
//
// Safe migration of workflows out of the legacy SHARED Temporal namespace
// (`tellus-funnel` + `tellus-funnel-queue`, both code defaults before the
// environment-isolation change) into per-environment namespaces.
//
// Existing running workflows cannot be "moved" between namespaces — the
// procedure captures evidence, terminates them intentionally, marks their
// interrupted funnel_run rows with an explicit migration reason, and lets
// the next dispatch save start a RID-keyed workflow in the correct
// namespace. It performs, in order:
//
//   1. enumerate workflows in the legacy namespace;
//   2. write an evidence file (ids, runIds, start times) — never delete
//      the namespace before this file exists;
//   3. terminate RUNNING ObjectTypeFunnelWorkflow-* executions (reason is
//      recorded server-side);
//   4. mark the corresponding locally-visible funnel_run rows
//      (status IN running/dispatch_pending/workflow_started) as
//      'cancelled' with error 'temporal-isolation-migration';
//   5. report; the NEXT save/dispatch starts workflows under the new
//      RID-keyed id in the deployment's own namespace.
//
// Usage:
//   TEMPORAL_LEGACY_NAMESPACE=tellus-funnel \
//   pnpm exec tsx scripts/migrate-funnel-temporal-isolation.ts [--dry-run]
//
// Env: standard PG env (for step 4) + TEMPORAL_ADDRESS (default
// localhost:7233). Legacy NOT deleted here — TTL (72h in dev compose)
// expires its closed history; the namespace itself can be retired by
// cluster admins once empty.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, Connection } from "@temporalio/client";
import { query, pool } from "../src/db";
import { resolveEnvironmentIdentity } from "../src/config/environmentIdentity";

const DRY_RUN = process.argv.includes("--dry-run");
const LEGACY_NS = process.env.TEMPORAL_LEGACY_NAMESPACE ?? "tellus-funnel";
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const MIGRATION_REASON = "temporal-isolation-migration (FUNN-ISO)";

interface Evidence {
  at: string;
  legacyNamespace: string;
  newIdentity: Record<string, unknown>;
  dryRun: boolean;
  workflows: Array<{
    workflowId: string;
    runId: string;
    status: string;
    startTime?: string;
  }>;
  terminated: string[];
  cancelledFunnelRunIds: string[];
}

async function main(): Promise<void> {
  const identity = resolveEnvironmentIdentity();
  console.log(
    `legacy-namespace=${LEGACY_NS} target-env=${identity.environmentId} ` +
      `target-ns=${identity.temporalNamespace} dryRun=${DRY_RUN}`,
  );

  const conn = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection: conn, namespace: LEGACY_NS });

  // 1+2. Enumerate + evidence.
  const workflows: Evidence["workflows"] = [];
  for await (const wf of client.workflow.list({
    query: "ExecutionStatus = 'Running'",
  })) {
    workflows.push({
      workflowId: wf.workflowId,
      runId: wf.runId,
      status: "RUNNING",
      startTime: wf.startTime?.toISOString?.(),
    });
  }

  const evidenceDir = path.resolve(
    __dirname,
    "../.migration-evidence/funnel-temporal-isolation",
  );
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(
    evidenceDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  const evidence: Evidence = {
    at: new Date().toISOString(),
    legacyNamespace: LEGACY_NS,
    newIdentity: {
      environmentId: identity.environmentId,
      temporalNamespace: identity.temporalNamespace,
      temporalTaskQueue: identity.temporalTaskQueue,
      workerBuildId: identity.workerBuildId,
    },
    dryRun: DRY_RUN,
    workflows,
    terminated: [],
    cancelledFunnelRunIds: [],
  };

  // 3. Terminate RUNNING funnel workflows in the legacy namespace.
  const funnelWfs = workflows.filter((w) =>
    w.workflowId.startsWith("ObjectTypeFunnelWorkflow"),
  );
  for (const wf of funnelWfs) {
    console.log(`terminate ${wf.workflowId} (run ${wf.runId})`);
    if (!DRY_RUN) {
      await client.workflow.getHandle(wf.workflowId).terminate(MIGRATION_REASON);
      evidence.terminated.push(wf.workflowId);
    }
  }

  // 4. Mark interrupted funnel_run rows in the LOCAL database.
  if (!DRY_RUN) {
    const res = await query(
      `UPDATE funnel_run
          SET status = 'cancelled',
              error_message = $1,
              completed_at = now()
        WHERE status IN ('dispatch_pending', 'workflow_started', 'running')
        RETURNING run_id`,
      [MIGRATION_REASON],
    );
    evidence.cancelledFunnelRunIds = res.rows.map(
      (r: { run_id: string }) => r.run_id,
    );

    // The corresponding funnel_signal rows for those runs are re-queued so
    // the new RID-keyed pipeline picks the work up in the new namespace.
    const { requeueSignalsForRun } = await import(
      "../src/services/funnel/durableWorkflow"
    );
    await requeueSignalsForRun(evidence.cancelledFunnelRunIds);
  }

  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(
    `evidence → ${evidenceFile}\n  running workflows seen: ${workflows.length}` +
      `\n  terminated funnel workflows: ${evidence.terminated.length}` +
      `\n  funnel_run rows cancelled: ${evidence.cancelledFunnelRunIds.length}` +
      (DRY_RUN ? "\n  (dry-run — nothing mutated)" : ""),
  );

  await conn.close();
  await pool.end();
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
