// ---------------------------------------------------------------------------
// Transform-step well-formedness guard.
//
// WHY THIS EXISTS
// The canvas transform editor round-trips a node's config through its OWN
// editor model, then PUTs the whole config back. That mapping only covers the
// transform types the editor owns. Measured on the PaySim pipeline:
//
//   • `CaseExpression` → `{ function, ...(t.caseExpression ?? {}) }` — when the
//     editor pane is not populated this persists a bare
//     `{ function: 'CaseExpression' }`, DISCARDING the authored `branches`.
//   • `Join` / `Union`  → NO branch exists at all, so they fall through to the
//     generic `return { function: fn, … }` and persist as a bare
//     `{ function: 'Join' }`, discarding `rightNodeId`, `joinType` and
//     `conditions`.
//
// The damage is silent and permanent: the node keeps its id and label, the
// canvas still draws it, and the loss only surfaces later as an execution
// failure (`Cannot read properties of undefined (reading 'map')` in
// compileCaseExpression, `(reading 'replace')` in readSource) or as silently
// wrong aggregates over columns that no longer exist.
//
// The steps above are NOT optional — a CaseExpression with no cases and a
// Join with no right input cannot execute under ANY engine. So a PUT carrying
// them is unambiguously a client bug, and it must be refused rather than
// persisted. Refusing costs the user a visible 400; accepting costs them the
// node's authored logic with no trace.
//
// This is deliberately a STRUCTURAL check (is the step's required payload
// present?), not a full schema validation. Field-level semantics are still
// the compiler's job — see pipelines/duckdbTransformEngine. The goal is to stop
// the irreversible loss, not to second-guess every step.
// ---------------------------------------------------------------------------

/** Transform functions that carry their payload in a top-level key we can assert on. */
const REQUIRED_PAYLOAD: Record<string, string[]> = {
  // branch payloads
  Filter: ["conditions"],
  Join: [], // rightNodeId OR rightPath — checked separately (either is valid)
  Union: [], // same
  // caseV2: `branches` (1..100) + `outputColumn` are required.
  // See types/pipeline.ts CaseExpressionBaseSchema, which cites
  // https://www.palantir.com/docs/foundry/pb-functions-expression/caseV2
  // An earlier revision of this file checked a non-existent `cases` key,
  // which would have rejected EVERY well-formed CaseExpression.
  CaseExpression: ["branches", "outputColumn"],
  ApplyExpression: ["expression"],
  ApplyMultipleExpressions: ["expressions"],
  Aggregate: ["aggregations"],
  Rollup: ["aggregations"],
  Pivot: ["aggregations"],
  Unpivot: ["columns"],
  // concatStringsV1: `expressions` (1..100) + `outputColumn` are required.
  ConcatenateStrings: ["expressions", "outputColumn"],
  FormatString: [],
  Sort: ["sorts"],
  TopRows: ["sorts"],
  AggregateOnCondition: ["aggregations"],
  // sha256V1 declares ONE Expression argument and a String output, so both
  // `expression` and `outputColumn` are load-bearing.
  // https://www.palantir.com/docs/foundry/pb-functions-expression/sha256V1
  HashSha256: ["expression", "outputColumn"],
  // windowV1 declares a non-empty Expressions list; `partitionBy` is
  // deliberately NOT required (an empty partition is the whole-table window).
  // https://www.palantir.com/docs/foundry/pb-functions-transform/windowV1
  Window: ["aggregations"],
};

export interface TransformStepIssue {
  index: number;
  function: string;
  problem: string;
}

/**
 * Returns the structural problems in a transforms array. Empty array = the
 * steps are at least plausibly complete.
 */
export function findMalformedTransformSteps(
  transforms: unknown,
): TransformStepIssue[] {
  const issues: TransformStepIssue[] = [];
  if (!Array.isArray(transforms)) return issues;

  transforms.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      issues.push({ index, function: "(none)", problem: "step is not an object" });
      return;
    }
    const step = raw as Record<string, unknown>;
    const fn = typeof step.function === "string" ? step.function : "";

    // A step with no function is unusable.
    if (!fn) {
      issues.push({ index, function: "(none)", problem: "step has no `function`" });
      return;
    }

    // Join/Union: the right-hand input is required, under EITHER vocabulary
    // (persisted `rightNodeId`, engine `rightPath`). Both missing = the step
    // can never resolve an input — this is exactly the bare-`{function:'Join'}`
    // the lossy editor mapping produces.
    if (fn === "Join") {
      const hasRight =
        (typeof step.rightNodeId === "string" && step.rightNodeId.trim() !== "") ||
        (typeof step.rightPath === "string" && step.rightPath.trim() !== "");
      if (!hasRight) {
        issues.push({
          index,
          function: fn,
          problem:
            "Join has neither `rightNodeId` nor `rightPath` — the right-hand input cannot be resolved",
        });
      }
      if (
        step.joinType !== undefined &&
        typeof step.joinType !== "string"
      ) {
        issues.push({ index, function: fn, problem: "`joinType` must be a string" });
      }
      return;
    }

    if (fn === "Union") {
      const hasOther =
        (typeof step.rightNodeId === "string" && step.rightNodeId.trim() !== "") ||
        (typeof step.rightNodeId === "object" && step.rightNodeId !== null) ||
        (typeof step.rightPath === "string" && step.rightPath.trim() !== "") ||
        Array.isArray(step.rightNodeIds) ||
        Array.isArray(step.otherPaths);
      if (!hasOther) {
        issues.push({
          index,
          function: fn,
          problem:
            "Union has no second input (`rightNodeId`/`rightNodeIds`/`rightPath`)",
        });
      }
      return;
    }

    for (const key of REQUIRED_PAYLOAD[fn] ?? []) {
      const v = step[key];
      const empty =
        v === undefined ||
        v === null ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "string" && v.trim() === "");
      if (empty) {
        issues.push({
          index,
          function: fn,
          problem: `\`${key}\` is missing or empty — a ${fn} step cannot execute without it`,
        });
      }
    }
  });

  return issues;
}

/** Human-readable one-liner for a 400 body. */
export function describeTransformStepIssues(issues: TransformStepIssue[]): string {
  return issues
    .map((i) => `step ${i.index + 1} (${i.function}): ${i.problem}`)
    .join("; ");
}