// ---------------------------------------------------------------------------
// Marking policy — PB-B7.
//
// Runs at deploy time:
//   * union every input dataset's markings into one required-marking
//     set (shared helper, Funnel and Pipeline Builder never drift)
//   * verify the triggering user possesses every marking in that union
//   * on failure, throw `MISSING_MARKING:<code>` as an AppError
//   * on success, return the union so the caller can stamp it onto
//     `pipelines.input_markings` and the output dataset
//
// Marking sources:
//   * dataset-level: `foundry_datasets.markings TEXT[]` — directly
//     attached markings on each input node's dataset.
//   * user-level: `marking_assignment` rows where
//     (subject_type='user', subject_id=<userId>) joined to `marking.code`.
//
// The spec calls this "mandatory access" — dropping a single marking
// silently under-protects the output, so the tests are explicit about
// union (not intersection) and exercise randomly-constructed marking
// sets.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import { AppError } from "../../utils/foundryAppError";
import {
  missingMarkings as findMissing,
  unionMarkings,
  userHasAllMarkings,
} from "../markingUnion";
import { isRbacEnabled } from "./pipelineAcl";

export interface MarkingPolicyResult {
  /** Computed union of input-dataset markings (sorted, duplicate-free). */
  unionMarkings: string[];
  /** Datasets (by id) contributing at least one marking. */
  contributingDatasetIds: string[];
  /** User's effective markings at the time of the check. */
  userMarkings: string[];
  /** True when the policy was evaluated; false when RBAC is disabled. */
  enforced: boolean;
}

export async function applyMarkingPolicyAtDeploy(
  knex: Knex,
  pipelineId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipelineNodes: any[],
  triggeredBy: string,
): Promise<MarkingPolicyResult> {
  if (!isRbacEnabled()) {
    return {
      unionMarkings: [],
      contributingDatasetIds: [],
      userMarkings: [],
      enforced: false,
    };
  }

  // Collect dataset ids from every node that binds to a foundry_datasets
  // row. Transform / output nodes often carry a dataset_id themselves
  // (set by PB-B3's Parquet deploy path); dataset nodes obviously do.
  const datasetIds = Array.from(
    new Set(
      pipelineNodes
        .map((n) => n?.dataset_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const datasets = datasetIds.length
    ? await knex("foundry_datasets")
        .whereIn("id", datasetIds)
        .select("id", "markings")
    : [];

  const markingSets = datasets.map((d) =>
    Array.isArray(d.markings) ? (d.markings as string[]) : [],
  );
  const union = unionMarkings(...markingSets);
  const contributing = datasets
    .filter((d) => Array.isArray(d.markings) && d.markings.length > 0)
    .map((d) => d.id as string);

  // If the union is empty there's nothing to check — admit.
  if (union.length === 0) {
    return {
      unionMarkings: [],
      contributingDatasetIds: contributing,
      userMarkings: [],
      enforced: true,
    };
  }

  const userMarkingRows = await knex("marking_assignment as ma")
    .join("marking as m", "m.marking_id", "ma.marking_id")
    .where({ "ma.subject_type": "user", "ma.subject_id": triggeredBy })
    .pluck("m.code");
  const userMarkings = userMarkingRows as string[];

  if (!userHasAllMarkings(union, userMarkings)) {
    const missing = findMissing(union, userMarkings);
    const code = `MISSING_MARKING:${missing[0]}`;
    const err = new AppError(
      `Deploy rejected: user is missing required markings: ${missing.join(", ")}.`,
      403,
      code,
    );
    (err as unknown as { details?: unknown }).details = {
      missing,
      required: union,
      pipelineId,
    };
    // Fire-and-forget audit event so the denied attempt is recorded.
    try {
      const { emitAuditEvent } = await import("../auditEventService");
      await emitAuditEvent({
        keycloakSub: triggeredBy,
        category: "pipeline_marking",
        action: "pipeline.marking.deny",
        result: "FAILURE",
        details: { pipelineId, missing, required: union },
      });
    } catch {
      /* audit must never block the deploy */
    }
    throw err;
  }

  // Success audit — propagation event so an ops engineer can correlate
  // the dataset markings with the deploys that carried them downstream.
  try {
    const { emitAuditEvent } = await import("../auditEventService");
    await emitAuditEvent({
      keycloakSub: triggeredBy,
      category: "pipeline_marking",
      action: "pipeline.marking.propagate",
      result: "SUCCESS",
      details: {
        pipelineId,
        required: union,
        contributingDatasetIds: contributing,
      },
    });
  } catch {
    /* ignore */
  }

  return {
    unionMarkings: union,
    contributingDatasetIds: contributing,
    userMarkings,
    enforced: true,
  };
}

/**
 * Stamp the union onto a freshly-created / updated output dataset row.
 * Called from the deploy worker after the data file lands.
 */
export async function stampOutputMarkings(
  knex: Knex,
  datasetId: string,
  markings: string[],
): Promise<void> {
  if (!datasetId) return;
  await knex("foundry_datasets")
    .where({ id: datasetId })
    .update({ markings });
}
