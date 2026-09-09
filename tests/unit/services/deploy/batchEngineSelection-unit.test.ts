// ---------------------------------------------------------------------------
// Unit tests for services/deploy/batchEngineSelection (extracted from
// deploymentService.ts tryEngineBuild — the pure engine-attempt gate).
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { shouldAttemptEngineBuild } from "../../../../src/services/deploy/batchEngineSelection";

describe("shouldAttemptEngineBuild", () => {
  it("forced in-process always opts out", () => {
    expect(
      shouldAttemptEngineBuild({
        engineMode: "in-process",
        coordinatorConfigured: true,
        outputFormat: "iceberg",
      }),
    ).toBe(false);
  });

  it("auto without a configured coordinator falls back to in-process", () => {
    expect(
      shouldAttemptEngineBuild({
        engineMode: "auto",
        coordinatorConfigured: false,
        outputFormat: "iceberg",
      }),
    ).toBe(false);
  });

  it("auto with a coordinator attempts the engine for Iceberg outputs", () => {
    expect(
      shouldAttemptEngineBuild({
        engineMode: "auto",
        coordinatorConfigured: true,
        outputFormat: "iceberg",
      }),
    ).toBe(true);
  });

  it("forced trino always attempts (tests inject an in-memory engine)", () => {
    expect(
      shouldAttemptEngineBuild({
        engineMode: "trino",
        coordinatorConfigured: false,
        outputFormat: "iceberg",
      }),
    ).toBe(true);
  });

  it.each([["csv"], ["parquet"], [undefined], [null]] as const)(
    "never attempts the engine for non-Iceberg output format %s",
    (outputFormat) => {
      expect(
        shouldAttemptEngineBuild({
          engineMode: "trino",
          coordinatorConfigured: true,
          outputFormat: outputFormat as string | null | undefined,
        }),
      ).toBe(false);
    },
  );

  it("missing output_format defaults to csv (never engine)", () => {
    expect(
      shouldAttemptEngineBuild({
        engineMode: "auto",
        coordinatorConfigured: true,
      }),
    ).toBe(false);
  });
});
