// ---------------------------------------------------------------------------
// B5 — Temporal workflow for table-import scheduling.
//
// `tableImportSyncWorkflow` is the action a per-import Temporal Schedule starts
// on every cron/interval tick. It is intentionally thin: proxy the
// `enqueueTableImportBuild` activity (Temporal handles retries/timeouts). Must
// stay deterministic — no clocks, no env, no DB — so it bundles into the
// workflow sandbox cleanly.
// ---------------------------------------------------------------------------

import { proxyActivities } from "@temporalio/workflow";
import type {
  EnqueueTableImportBuildInput,
  EnqueueTableImportBuildResult,
} from "./activities";

const { enqueueTableImportBuild } = proxyActivities<{
  enqueueTableImportBuild(
    input: EnqueueTableImportBuildInput,
  ): Promise<EnqueueTableImportBuildResult>;
}>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5 seconds",
    maximumInterval: "1 minute",
    backoffCoefficient: 2.0,
  },
});

export interface TableImportSyncWorkflowInput {
  importRid: string;
}

export async function tableImportSyncWorkflow(
  input: TableImportSyncWorkflowInput,
): Promise<EnqueueTableImportBuildResult> {
  return enqueueTableImportBuild({ importRid: input.importRid });
}
