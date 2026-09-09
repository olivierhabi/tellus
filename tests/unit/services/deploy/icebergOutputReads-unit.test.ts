// ---------------------------------------------------------------------------
// Unit tests for services/deploy/icebergOutputReads (extracted from
// deploymentService.ts). Pure ref derivation + the not-found / not-iceberg
// gates run against a minimal fake knex; sidecar calls are mocked.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

vi.mock("../../../../src/services/pipelines/icebergSidecar", () => ({
  icebergSnapshots: vi.fn(async () => ({ snapshots: [{ snapshot_id: 1 }] })),
  icebergScanAsOf: vi.fn(async () => ({
    columns: ["id"],
    rows: [{ id: 1 }],
    row_count: 1,
  })),
}));

import { icebergScanAsOf, icebergSnapshots } from "../../../../src/services/pipelines/icebergSidecar";
import {
  listPipelineOutputSnapshots,
  pipelineOutputIcebergRef,
  readPipelineOutputAsOf,
} from "../../../../src/services/deploy/icebergOutputReads";
import { AppError } from "../../../../src/utils/foundryAppError";

/** Minimal fake of the knex('pipelines').where(...).first() chain. */
function fakeKnex(pipelineRow: unknown): Knex {
  const first = vi.fn(async () => pipelineRow);
  const where = vi.fn(() => ({ first }));
  return vi.fn(() => ({ where })) as unknown as Knex;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.LAKEKEEPER_PIPELINE_WAREHOUSE;
});

describe("pipelineOutputIcebergRef", () => {
  it("derives warehouse/namespace/leaf deterministically from project + pipeline ids", () => {
    const ref = pipelineOutputIcebergRef(
      "12345678-1234-1234-1234-123456789abc",
      "abcdefab-0000-0000-0000-000000000000",
      { name: "My Pipeline" },
    );
    expect(ref.table).toBeDefined();
    expect(ref.namespace).toContain("proj_123456781234");
    expect(ref.namespace).toContain("abcdefab");
    expect(ref.warehouse).toBe("tellus-pipeline"); // env unset → default
  });

  it("honors the LAKEKEEPER_PIPELINE_WAREHOUSE override", () => {
    process.env.LAKEKEEPER_PIPELINE_WAREHOUSE = "custom-wh";
    const ref = pipelineOutputIcebergRef("p", "i", {});
    expect(ref.warehouse).toBe("custom-wh");
  });

  it("falls back to 'pipe' when the pipeline row has no name", () => {
    const ref = pipelineOutputIcebergRef("p", "i", { name: null });
    expect(ref.namespace).toContain("pipe");
  });
});

describe("listPipelineOutputSnapshots", () => {
  it("throws AppError 404 NOT_FOUND when the pipeline row is missing", async () => {
    await expect(
      listPipelineOutputSnapshots(fakeKnex(undefined), "proj", "pipe"),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("returns an empty snapshot list for non-Iceberg pipelines (no sidecar call)", async () => {
    const result = await listPipelineOutputSnapshots(
      fakeKnex({ name: "p", output_format: "csv" }),
      "proj",
      "pipe",
    );
    expect(result).toEqual({ snapshots: [] });
    expect(icebergSnapshots).not.toHaveBeenCalled();
  });

  it("delegates to the sidecar for Iceberg pipelines", async () => {
    const result = await listPipelineOutputSnapshots(
      fakeKnex({ name: "p", output_format: "iceberg" }),
      "proj",
      "pipe",
    );
    expect(result.snapshots).toHaveLength(1);
    expect(icebergSnapshots).toHaveBeenCalledTimes(1);
  });
});

describe("readPipelineOutputAsOf", () => {
  it("rejects non-Iceberg pipelines with OUTPUT_NOT_ICEBERG (400)", async () => {
    const err = await readPipelineOutputAsOf(
      fakeKnex({ name: "p", output_format: "parquet" }),
      "proj",
      "pipe",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe("OUTPUT_NOT_ICEBERG");
    expect(icebergScanAsOf).not.toHaveBeenCalled();
  });

  it("maps the sidecar row_count wire shape to rowCount", async () => {
    const result = await readPipelineOutputAsOf(
      fakeKnex({ name: "p", output_format: "iceberg" }),
      "proj",
      "pipe",
      { snapshotId: 42, limit: 10 },
    );
    expect(result).toEqual({ columns: ["id"], rows: [{ id: 1 }], rowCount: 1 });
    expect(icebergScanAsOf).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 42, limit: 10 }),
    );
  });
});
