/**
 * Transform-step integrity guard.
 *
 * These cases are the shapes the lossy canvas round-trip actually persisted
 * (measured on the PaySim pipeline), plus the well-formed steps that must
 * still be allowed through — a guard that rejects valid work is its own bug.
 */
import { describe, it, expect } from "vitest";
import {
  findMalformedTransformSteps,
  describeTransformStepIssues,
} from "../../../src/services/pipelines/transformStepIntegrity";

describe("findMalformedTransformSteps", () => {
  it("flags the bare CaseExpression skeleton the editor persisted", () => {
    // This exact object replaced a 31-branch day ladder.
    const issues = findMalformedTransformSteps([{ function: "CaseExpression" }]);
    // Both required keys are reported, not just the first.
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.function === "CaseExpression")).toBe(true);
    expect(issues.map((i) => i.problem).join(" ")).toMatch(/branches/);
    expect(issues.map((i) => i.problem).join(" ")).toMatch(/outputColumn/);
  });

  it("flags the bare Join skeleton (no rightNodeId, no rightPath)", () => {
    // This exact object replaced both of node 48's joins.
    const issues = findMalformedTransformSteps([{ function: "Join" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].problem).toMatch(/rightNodeId.*rightPath|right-hand input/);
  });

  it("flags a bare Union skeleton", () => {
    expect(findMalformedTransformSteps([{ function: "Union" }])).toHaveLength(1);
  });

  it("flags a CaseExpression skeleton for outputColumn too", () => {
    const issues = findMalformedTransformSteps([
      { function: "CaseExpression", branches: [{ condition: { left: { kind: "column", value: "d" }, operator: "eq", right: { kind: "literal", value: 1 } }, value: { kind: "literal", value: 1 } }] },
    ]);
    expect(issues[0].problem).toMatch(/outputColumn/);
  });

  it("flags an empty Filter.conditions", () => {
    const issues = findMalformedTransformSteps([
      { function: "Filter", mode: "keep", match: "all", conditions: [] },
    ]);
    expect(issues[0].problem).toMatch(/conditions/);
  });

  it("flags an Aggregate with no aggregations", () => {
    const issues = findMalformedTransformSteps([{ function: "Aggregate", groupBy: [] }]);
    expect(issues[0].problem).toMatch(/aggregations/);
  });

  it("flags a step with no function at all", () => {
    const issues = findMalformedTransformSteps([{ columns: ["a"] }]);
    expect(issues[0].problem).toMatch(/no `function`/);
  });

  it("reports EVERY bad step, not just the first", () => {
    const issues = findMalformedTransformSteps([
      { function: "CaseExpression" },
      { function: "Rename", renames: [{ from: "a", to: "b" }] },
      { function: "Join" },
    ]);
    // CaseExpression skeleton reports branches + outputColumn; Join reports its
    // missing right input.
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.index)).toEqual([0, 0, 2]);
  });

  // ── Must NOT reject valid work ──────────────────────────────────
  it("accepts a Join carrying the persisted rightNodeId vocabulary", () => {
    expect(
      findMalformedTransformSteps([
        {
          function: "Join",
          joinType: "cross",
          conditions: [],
          rightNodeId: "815c09c7-33f6-43f8-b8dd-a0ba0d8e567e",
          rightPrefix: "right_",
        },
      ]),
    ).toEqual([]);
  });

  it("accepts a Join carrying the engine rightPath vocabulary", () => {
    expect(
      findMalformedTransformSteps([{ function: "Join", rightPath: "s3://b/k.parquet" }]),
    ).toEqual([]);
  });

  it("accepts a well-formed caseV2 CaseExpression (branches, NOT cases)", () => {
    // Canonical shape per types/pipeline.ts CaseExpressionBaseSchema.
    expect(
      findMalformedTransformSteps([
        {
          function: "CaseExpression",
          branches: [
            {
              condition: {
                left: { kind: "column", value: "day" },
                operator: "eq",
                right: { kind: "literal", value: 1, literalType: "integer" },
              },
              value: { kind: "literal", value: 1, literalType: "integer" },
            },
          ],
          defaultValue: null,
          outputColumn: "day_bucket",
        },
      ]),
    ).toEqual([]);
  });

  it("accepts a ConcatenateStrings with expressions and an output column", () => {
    expect(
      findMalformedTransformSteps([
        {
          function: "ConcatenateStrings",
          expressions: [{ kind: "column", value: "a" }, { kind: "column", value: "b" }],
          separator: "|",
          outputColumn: "id",
        },
      ]),
    ).toEqual([]);
  });

  it("flags a ConcatenateStrings with no expressions", () => {
    const issues = findMalformedTransformSteps([
      { function: "ConcatenateStrings", separator: "|", outputColumn: "id" },
    ]);
    expect(issues[0].problem).toMatch(/expressions/);
  });

  it("accepts a cross Join with empty conditions (cross needs no ON)", () => {
    expect(
      findMalformedTransformSteps([
        { function: "Join", joinType: "cross", conditions: [], rightNodeId: "abc" },
      ]),
    ).toEqual([]);
  });

  it("accepts a well-formed chain", () => {
    expect(
      findMalformedTransformSteps([
        { function: "Rename", renames: [{ from: "type", to: "step" }] },
        { function: "Filter", mode: "keep", match: "all", conditions: [{ column: "type", operator: "eq", value: "TRANSFER" }] },
        { function: "ConcatenateStrings", expressions: [{ kind: "column", value: "a" }], separator: "|", outputColumn: "id" },
        { function: "Union", rightNodeId: "x", mode: "wide" },
      ]),
    ).toEqual([]);
  });

  it("tolerates a non-array transforms value (no transforms yet)", () => {
    expect(findMalformedTransformSteps(undefined)).toEqual([]);
    expect(findMalformedTransformSteps([])).toEqual([]);
    expect(findMalformedTransformSteps("nope")).toEqual([]);
  });

  it("describes issues readably for a 400 body", () => {
    const msg = describeTransformStepIssues(findMalformedTransformSteps([{ function: "Join" }]));
    expect(msg).toMatch(/step 1 \(Join\)/);
  });
});