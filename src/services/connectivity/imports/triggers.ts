// ---------------------------------------------------------------------------
// Build trigger classification — "who/what started this build".
//
// A build's `orchestration_builds.actor` column records the principal that
// enqueued it. There are exactly two kinds of principal in the system:
//
//   - A USER: a Keycloak subject id (UUID), recorded when someone clicks "Run"
//     (`enqueueBuildForImport(importRid, actor(req))`). Resolved to a display
//     name via the Keycloak admin lookup (see principalNames.ts).
//
//   - A SCHEDULE: one of the fixed system principals below, recorded when a
//     timer/cron fires the build instead of a person (the DB-poll scheduler or
//     the Temporal scheduler). Foundry surfaces these as "Build schedule".
//
// This module is the single source of truth for those system principals so the
// schedulers that WRITE the actor and the build envelope that CLASSIFIES it can
// never drift apart. Mirrors Foundry's job-tracker "Started by", which shows
// the initiating user or "Build schedule".
// ---------------------------------------------------------------------------

/** Audit principal recorded on builds fired by the DB-poll table-import scheduler. */
export const SCHEDULE_ACTOR_TABLE_IMPORT = "tellus-table-import-scheduler";

/** Audit principal recorded on builds fired by the Temporal scheduler. */
export const SCHEDULE_ACTOR_TEMPORAL = "tellus-temporal-scheduler";

/** Every non-user (schedule/system) principal that can enqueue a build. */
const SCHEDULE_ACTORS: ReadonlySet<string> = new Set([
  SCHEDULE_ACTOR_TABLE_IMPORT,
  SCHEDULE_ACTOR_TEMPORAL,
]);

/** How a build was started — mirrors Foundry's "Started by" distinction. */
export type BuildTrigger = "MANUAL" | "SCHEDULE";

/** True when the actor is a known schedule/system principal (not a user). */
export function isScheduleActor(actor: string | null | undefined): boolean {
  return actor != null && SCHEDULE_ACTORS.has(actor);
}

/** Classify a build's actor as a manual (user) or scheduled run. */
export function classifyTrigger(actor: string | null | undefined): BuildTrigger {
  return isScheduleActor(actor) ? "SCHEDULE" : "MANUAL";
}
