// ---------------------------------------------------------------------------
// Funnel execution plan registry — FUNN-ISO-4.
//
// Every funnel_run carries an IMMUTABLE snapshot of the pipeline definition
// it was dispatched under (columns definition_version + execution_plan,
// migration 151). Terminal validation derives completeness from THAT row,
// never from this registry's CURRENT default, so deploying a new definition
// changes nothing for in-flight history.
//
// Stage vocab must remain compatible with funnel_stage_run.stage's DB CHECK
// constraint (004-era): adding a stage to a future definition FIRST
// widens the constraint in a migration, then registers below.
// ---------------------------------------------------------------------------

export type FunnelStageName =
  | "changelog"
  | "merge"
  | "indexing"
  | "hydration";

export interface FunnelExecutionPlan {
  definitionVersion: number;
  requiredStages: FunnelStageName[];
  optionalStages: FunnelStageName[];
  stageDependencies: Record<FunnelStageName, FunnelStageName[]>;
}

export class UnknownFunnelDefinitionError extends Error {
  constructor(version: number) {
    super(
      `funnel pipeline definition v${version} is not registered — refusing ` +
        `to derive stage requirements from an unknown shape (fail-closed).`,
    );
    this.name = "UnknownFunnelDefinitionError";
  }
}

/** DB-enforced stage vocabubary — a plan stage outside this list fails closed. */
export const FUNNEL_STAGE_VOCABULARY: readonly FunnelStageName[] = [
  "changelog",
  "merge",
  "indexing",
  "hydration",
];

export const PIPELINE_DEFINITION_V1: FunnelExecutionPlan = {
  definitionVersion: 1,
  requiredStages: ["changelog", "merge", "indexing", "hydration"],
  optionalStages: [],
  stageDependencies: {
    changelog: [],
    merge: ["changelog"],
    indexing: ["changelog", "merge"],
    hydration: ["changelog"],
  },
};

/**
 * Example evolution (used by the pipeline-evolution tests): identical
 * stages but the hydration pass — a best-effort enrichment — is OPTIONAL
 * when the pipeline runs in a degraded-availability configuration. New
 * runs dispatched under v2 complete with {changelog, merge, indexing};
 * v1-dispatched in-flight runs continue requiring hydration.
 */
export const PIPELINE_DEFINITION_V2: FunnelExecutionPlan = {
  definitionVersion: 2,
  requiredStages: ["changelog", "merge", "indexing"],
  optionalStages: ["hydration"],
  stageDependencies: {
    changelog: [],
    merge: ["changelog"],
    indexing: ["changelog", "merge"],
    hydration: ["changelog"],
  },
};

const PIPELINE_DEFINITIONS: Record<number, FunnelExecutionPlan> = {
  1: PIPELINE_DEFINITION_V1,
  2: PIPELINE_DEFINITION_V2,
};

/**
 * Which definition NEW dispatches stamp onto their funnel_run rows. Code
 * rollouts flip this constant in lockstep with the definitions above; rows
 * in flight keep their persisted snapshots.
 */
export const CURRENT_DEFINITION_VERSION = 1;

export function getDefinition(version: number): FunnelExecutionPlan {
  const def = PIPELINE_DEFINITIONS[version];
  if (!def) throw new UnknownFunnelDefinitionError(version);
  return def;
}

export function currentDefinition(): FunnelExecutionPlan {
  return getDefinition(CURRENT_DEFINITION_VERSION);
}

/**
 * Parse + validate a persisted plan snapshot. Unknown versions and stages
 * outside the DB vocabulary fail closed.
 */
export function parseExecutionPlan(json: unknown): FunnelExecutionPlan {
  if (typeof json === "string") {
    try {
      json = JSON.parse(json);
    } catch {
      throw new UnknownFunnelDefinitionError(NaN);
    }
  }
  const plan = json as FunnelExecutionPlan;
  if (!plan || typeof plan.definitionVersion !== "number") {
    throw new UnknownFunnelDefinitionError(NaN);
  }
  // The version must be registered (unknown versions = unknown semantics).
  const registered = getDefinition(plan.definitionVersion);
  for (const stage of [...plan.requiredStages, ...plan.optionalStages]) {
    if (!(FUNNEL_STAGE_VOCABULARY as readonly string[]).includes(stage)) {
      throw new UnknownFunnelDefinitionError(plan.definitionVersion);
    }
  }
  void registered;
  return plan;
}
