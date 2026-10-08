import { describe, expect, it } from "vitest";

import {
  allocateGeneratedSequence,
  effectivePadLength,
  GENERATED_SEQUENCE_PAD_MAX,
  GENERATED_SEQUENCE_PAD_MIN,
  previewGeneratedSequence,
} from "../../../src/actions/generatedSequence";

const source = (padLength: unknown) => ({
  source: "generatedSequence" as const,
  sequenceKey: "evidenceId-sequence",
  prefix: "EVD",
  padLength: padLength as number,
  startAt: 1000001,
});

describe("effectivePadLength", () => {
  it("passes through in-range values untouched", () => {
    expect(effectivePadLength(6, "k")).toBe(6);
    expect(effectivePadLength(GENERATED_SEQUENCE_PAD_MIN, "k")).toBe(1);
    expect(effectivePadLength(GENERATED_SEQUENCE_PAD_MAX, "k")).toBe(18);
  });

  it("clamps legacy out-of-range configs instead of minting unindexable ids", () => {
    expect(effectivePadLength(12026, "k")).toBe(GENERATED_SEQUENCE_PAD_MAX);
    expect(effectivePadLength(0, "k")).toBe(GENERATED_SEQUENCE_PAD_MIN);
    expect(effectivePadLength(-4, "k")).toBe(GENERATED_SEQUENCE_PAD_MIN);
    expect(effectivePadLength(undefined, "k")).toBe(GENERATED_SEQUENCE_PAD_MAX);
  });
});

describe("previewGeneratedSequence", () => {
  it("never emits an id longer than prefix + 18 chars", () => {
    const id = previewGeneratedSequence(source(12026));
    expect(id).toBe(`EVD${"1000001".padStart(GENERATED_SEQUENCE_PAD_MAX, "0")}`);
    expect(id.length).toBeLessThanOrEqual(3 + GENERATED_SEQUENCE_PAD_MAX);
  });
});

describe("allocateGeneratedSequence", () => {
  const stubClient = (value: string) => ({
    query: async () => ({ rows: [{ value }] }),
  });

  it("clamps a legacy padLength at allocation time", async () => {
    const id = await allocateGeneratedSequence("ontology-id", source(12026), stubClient("1000003"));
    expect(id).toBe(`EVD${"1000003".padStart(GENERATED_SEQUENCE_PAD_MAX, "0")}`);
    expect(id.length).toBeLessThanOrEqual(3 + GENERATED_SEQUENCE_PAD_MAX);
  });

  it("keeps a sane padLength exactly as configured", async () => {
    const id = await allocateGeneratedSequence("ontology-id", source(6), stubClient("42"));
    expect(id).toBe("EVD000042");
  });
});
