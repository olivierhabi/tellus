// ---------------------------------------------------------------------------
// B5 — Temporal activities for table-import scheduling.
//
// One activity: `enqueueTableImportBuild`. A Temporal Schedule (cron / interval
// + timezone, overlap=SKIP, catchupWindow) fires `tableImportSyncWorkflow`,
// which calls this activity to enqueue a build through the EXACT same path as a
// manual "Run" / the DB-poll fallback (`enqueueBuildForImport`). The build's
// single-active lock provides idempotency, so Temporal retries / overlapping
// fires never stack duplicate builds.
//
// Runs in the worker's Node context (full DB access) — not the workflow sandbox.
// ---------------------------------------------------------------------------

import { enqueueBuildForImport } from "../handlers";
import { SCHEDULE_ACTOR_TEMPORAL } from "../triggers";

// Shared with the build envelope's trigger classifier so a Temporal-fired
// build's "Started by" reads "Build schedule" rather than a raw principal id.
const SCHEDULER_ACTOR = SCHEDULE_ACTOR_TEMPORAL;

export interface EnqueueTableImportBuildInput {
  importRid: string;
}
export interface EnqueueTableImportBuildResult {
  importRid: string;
  buildRid: string;
  coalesced: boolean;
}

export async function enqueueTableImportBuild(
  input: EnqueueTableImportBuildInput,
): Promise<EnqueueTableImportBuildResult> {
  const { buildRid, coalesced } = await enqueueBuildForImport(
    input.importRid,
    SCHEDULER_ACTOR,
  );
  return { importRid: input.importRid, buildRid, coalesced };
}
