// B10 — type contract unit tests.

import { describe, expect, it } from "vitest";
import {
  EmbedRequest,
  ParameterSchema,
  PublishDashboardRequest,
  PublishVisualFunctionRequest,
} from "../../../src/services/quiver/publishing/types";

describe("B10 C-04: ParameterSchema validates JSON Schema shape", () => {
  it("accepts a well-formed schema", () => {
    const r = ParameterSchema.safeParse({
      type: "object",
      properties: {
        threshold: { type: "number", default: 0.5 },
        status: { type: "string", enum: ["active", "closed"] },
      },
      required: ["threshold"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-object root", () => {
    const r = ParameterSchema.safeParse({ type: "array", properties: {} });
    expect(r.success).toBe(false);
  });

  it("rejects unknown property type", () => {
    const r = ParameterSchema.safeParse({
      type: "object",
      properties: { x: { type: "date" } },
      required: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("B10 C-01: PublishDashboardRequest", () => {
  it("requires analysisRid in canonical form", () => {
    const r = PublishDashboardRequest.safeParse({
      analysisRid: "not-a-rid",
      displayName: "x",
      exposedCanvases: ["c1"],
      parameterSchema: { type: "object", properties: {}, required: [] },
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one exposed canvas", () => {
    const r = PublishDashboardRequest.safeParse({
      analysisRid: "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab",
      displayName: "Dash",
      exposedCanvases: [],
      parameterSchema: { type: "object", properties: {}, required: [] },
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid request", () => {
    const r = PublishDashboardRequest.safeParse({
      analysisRid: "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab",
      displayName: "Dash",
      exposedCanvases: ["c1", "c2"],
      parameterSchema: { type: "object", properties: {}, required: [] },
    });
    expect(r.success).toBe(true);
  });
});

describe("B10 C-08: PublishVisualFunctionRequest", () => {
  it("requires rootCardId", () => {
    const r = PublishVisualFunctionRequest.safeParse({
      analysisRid: "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab",
      displayName: "VF",
      exposedParameterCardIds: ["p1"],
      rootCardId: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("B10 C-06/C-07: EmbedRequest", () => {
  it("targetRid required, paramBindings default {}", () => {
    const r = EmbedRequest.safeParse({ targetRid: "ri.foo.bar" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.paramBindings).toEqual({});
  });

  it("rejects when targetRid missing", () => {
    const r = EmbedRequest.safeParse({ paramBindings: {} });
    expect(r.success).toBe(false);
  });
});
