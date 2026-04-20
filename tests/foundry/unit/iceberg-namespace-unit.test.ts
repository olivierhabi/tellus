// ---------------------------------------------------------------------------
// PB-B4 — namespace + slug helpers (unit).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  pipelineNamespace,
  pipelineOutputTable,
  slugForNamespace,
} from "../../../src/services/pipelines/icebergNamespace";

describe("slugForNamespace", () => {
  it("lowercases and substitutes invalid chars", () => {
    expect(slugForNamespace("My Pipeline 01!")).toBe("my_pipeline_01");
  });

  it("strips leading/trailing underscores", () => {
    expect(slugForNamespace("__foo__")).toBe("foo");
  });

  it("caps at 60 chars", () => {
    expect(slugForNamespace("a".repeat(200)).length).toBe(60);
  });

  it("throws on empty input", () => {
    expect(() => slugForNamespace("")).toThrow(/empty/);
    expect(() => slugForNamespace("   ")).toThrow(/empty/);
  });
});

describe("pipelineNamespace", () => {
  it("formats as _pipeline.<project>.<pipeline>", () => {
    expect(pipelineNamespace("Acme Corp", "Orders Daily")).toBe(
      "_pipeline.acme_corp.orders_daily",
    );
  });
});

describe("pipelineOutputTable", () => {
  it("adds .output leaf", () => {
    expect(pipelineOutputTable("acme", "orders")).toBe(
      "_pipeline.acme.orders.output",
    );
  });
});
