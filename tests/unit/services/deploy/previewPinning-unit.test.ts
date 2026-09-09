// ---------------------------------------------------------------------------
// collectPreviewPinning (PB-B6) — extracted from DeploymentService during
// the god-file breakup. These tests pin the pinning envelope directly
// against the standalone module: staleness detection, flag overrides,
// digest stability, and the audit-map shape.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { chainHashFromNodeConfig } from "../../../../src/services/pipelines/previewSnapshot";
import { collectPreviewPinning } from "../../../../src/services/deploy/previewPinning";
import { AppError } from "../../../../src/utils/foundryAppError";

const TRANSFORMS = [{ function: "Cast", expression: "age", targetType: "integer" }];

function node(id: string, transforms: unknown[], prev?: Record<string, unknown>) {
  return {
    id,
    dataset_id: `ds-${id}`,
    config: {
      transforms,
      ...(prev ? { previewSnapshot: prev } : {}),
    },
  };
}

function freshPrev(transforms: unknown[]) {
  return {
    chainHash: chainHashFromNodeConfig({ transforms }),
    format: "csv",
    datasetId: "ds-n1",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("collectPreviewPinning", () => {
  it("returns an empty envelope when no node carries a snapshot", async () => {
    await expect(
      collectPreviewPinning("p1", [node("n1", TRANSFORMS)], { force: false, ignorePreviewSnapshot: false }),
    ).resolves.toEqual({
      inputSnapshots: {},
      chainHashDigest: null,
      divergenceWarning: false,
      staleNodeIds: [],
    });
  });

  it("aggregates fresh csv snapshots and digests the sorted chain hashes", async () => {
    const t2 = [...TRANSFORMS, { function: "Drop", columns: ["x"] }];
    const res = await collectPreviewPinning(
      "p1",
      [node("n1", TRANSFORMS, freshPrev(TRANSFORMS)), node("n2", t2, freshPrev(t2))],
      { force: false, ignorePreviewSnapshot: false },
    );
    expect(Object.keys(res.inputSnapshots).sort()).toEqual(["n1", "n2"]);
    expect(res.inputSnapshots.n1).toMatchObject({ datasetId: "ds-n1", format: "csv" });
    const expected = createHash("sha256")
      .update(
        [chainHashFromNodeConfig({ transforms: TRANSFORMS }), chainHashFromNodeConfig({ transforms: t2 })]
          .sort()
          .join("\n"),
        "utf-8",
      )
      .digest("hex");
    expect(res.chainHashDigest).toBe(expected);
    expect(res.staleNodeIds).toEqual([]);
    expect(res.divergenceWarning).toBe(false);
  });

  it("accepts a JSON-string config like the knex row shape", async () => {
    const cfg = { transforms: TRANSFORMS, previewSnapshot: freshPrev(TRANSFORMS) };
    const res = await collectPreviewPinning(
      "p1",
      [{ id: "n1", dataset_id: "ds-n1", config: JSON.stringify(cfg) }],
      { force: false, ignorePreviewSnapshot: false },
    );
    expect(Object.keys(res.inputSnapshots)).toEqual(["n1"]);
  });

  it("rejects PREVIEW_STALE on drift and names the nodes in details", async () => {
    const stale = freshPrev([{ function: "Drop", columns: ["old"] }]);
    const err = await collectPreviewPinning(
      "p1",
      [node("n1", TRANSFORMS, stale)],
      { force: false, ignorePreviewSnapshot: false },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PREVIEW_STALE");
    expect((err as AppError).statusCode).toBe(409);
    expect((err as unknown as { details: { staleNodeIds: string[] } }).details).toEqual({
      staleNodeIds: ["n1"],
    });
  });

  it("force overrides staleness but does not trip divergence_warning", async () => {
    const stale = freshPrev([{ function: "Drop", columns: ["old"] }]);
    const res = await collectPreviewPinning(
      "p1",
      [node("n1", TRANSFORMS, stale)],
      { force: true, ignorePreviewSnapshot: false },
    );
    expect(res.staleNodeIds).toEqual(["n1"]);
    expect(res.divergenceWarning).toBe(false);
  });

  it("ignorePreviewSnapshot overrides staleness and trips divergence_warning", async () => {
    const stale = freshPrev([{ function: "Drop", columns: ["old"] }]);
    const res = await collectPreviewPinning(
      "p1",
      [node("n1", TRANSFORMS, stale)],
      { force: false, ignorePreviewSnapshot: true },
    );
    expect(res.staleNodeIds).toEqual(["n1"]);
    expect(res.divergenceWarning).toBe(true);
  });
});
