// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §6 — dataset branches & tags unit tests.
//
// The PyIceberg sidecar bridge is fully mocked (vi.mock) so these tests run
// offline: they pin the validation rules (DATASET_NOT_ICEBERG /
// REF_NAME_INVALID), the Iceberg-location resolution for both recorded
// conventions, the sidecar error → AppError mapping (REF_EXISTS et al.) and
// the happy-path payloads handed to the bridge.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/services/pipelines/icebergSidecar", () => ({
  icebergCreateBranch: vi.fn(),
  icebergCreateTag: vi.fn(),
  icebergListRefs: vi.fn(),
  icebergDropRef: vi.fn(),
  icebergFastForward: vi.fn(),
}));

import {
  icebergCreateBranch,
  icebergCreateTag,
  icebergDropRef,
  icebergFastForward,
  icebergListRefs,
} from "../../../src/services/pipelines/icebergSidecar";
import {
  createBranch,
  createTag,
  dropRef,
  fastForward,
  listRefs,
  resolveIcebergTarget,
  type DatasetRowLike,
} from "../../../src/services/pipelines/datasetBranches";
import { AppError } from "../../../src/utils/foundryAppError";

const mockCreateBranch = vi.mocked(icebergCreateBranch);
const mockCreateTag = vi.mocked(icebergCreateTag);
const mockListRefs = vi.mocked(icebergListRefs);
const mockDropRef = vi.mocked(icebergDropRef);
const mockFastForward = vi.mocked(icebergFastForward);

const COLON_DATASET: DatasetRowLike = {
  id: "ds-1",
  format: "iceberg",
  file_path: "tellus-funnel:_funnel.proj_a.orders",
};

const SLASH_DATASET: DatasetRowLike = {
  id: "ds-2",
  format: "iceberg",
  file_path: "tellus-pipeline/_pipeline.proj_x.pipe_y/output#snapshot=4216",
};

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
  statusCode?: number,
): Promise<AppError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appErr = caught as AppError;
  expect(appErr.code).toBe(code);
  if (statusCode !== undefined) expect(appErr.statusCode).toBe(statusCode);
  return appErr;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveIcebergTarget", () => {
  it("resolves the colon (Funnel) convention", () => {
    expect(resolveIcebergTarget(COLON_DATASET)).toEqual({
      warehouse: "tellus-funnel",
      namespace: "_funnel.proj_a",
      table: "orders",
      snapshotId: null,
    });
  });

  it("resolves the slash (pipeline deploy) convention with a snapshot pin", () => {
    expect(resolveIcebergTarget(SLASH_DATASET)).toEqual({
      warehouse: "tellus-pipeline",
      namespace: "_pipeline.proj_x.pipe_y",
      table: "output",
      snapshotId: "4216",
    });
  });

  it("prefers iceberg_location over file_path when both are present", () => {
    expect(
      resolveIcebergTarget({
        id: "ds-3",
        format: "iceberg",
        file_path: "uploads/abc.csv",
        iceberg_location: "wh:ns.tbl",
      }),
    ).toEqual({ warehouse: "wh", namespace: "ns", table: "tbl", snapshotId: null });
  });

  it("rejects non-iceberg datasets with DATASET_NOT_ICEBERG", () => {
    expect(() =>
      resolveIcebergTarget({ id: "ds-csv", format: "csv", file_path: "wh:ns.tbl" }),
    ).toThrowError(
      expect.objectContaining({ code: "DATASET_NOT_ICEBERG", statusCode: 400 }),
    );
  });

  it("rejects iceberg datasets whose location does not parse", () => {
    expect(() =>
      resolveIcebergTarget({
        id: "ds-bad",
        format: "iceberg",
        file_path: "uploads/2024/file.parquet",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "DATASET_NOT_ICEBERG", statusCode: 400 }),
    );
  });

  it("rejects iceberg datasets with no recorded location", () => {
    expect(() =>
      resolveIcebergTarget({ id: "ds-empty", format: "iceberg", file_path: null }),
    ).toThrowError(expect.objectContaining({ code: "DATASET_NOT_ICEBERG" }));
  });
});

describe("ref name validation", () => {
  it.each(["", "bad name", "-leading-dash", "feat/x", "a".repeat(256)])(
    "rejects %j with REF_NAME_INVALID",
    async (name) => {
      await expectAppError(createBranch(COLON_DATASET, name), "REF_NAME_INVALID", 400);
      expect(mockCreateBranch).not.toHaveBeenCalled();
    },
  );

  it("rejects creating or dropping the protected main branch", async () => {
    await expectAppError(createBranch(COLON_DATASET, "main"), "REF_NAME_INVALID", 400);
    await expectAppError(createTag(COLON_DATASET, "main"), "REF_NAME_INVALID", 400);
    await expectAppError(dropRef(COLON_DATASET, "main"), "REF_NAME_INVALID", 400);
    expect(mockCreateBranch).not.toHaveBeenCalled();
    expect(mockCreateTag).not.toHaveBeenCalled();
    expect(mockDropRef).not.toHaveBeenCalled();
  });

  it("allows main as the moved branch in fastForward (promote path)", async () => {
    mockFastForward.mockResolvedValue({
      branch: "main",
      snapshotId: "99",
      fastForwarded: true,
    });
    const res = await fastForward(COLON_DATASET, "main", "dev");
    expect(res.fastForwarded).toBe(true);
    expect(mockFastForward).toHaveBeenCalledWith({
      warehouse: "tellus-funnel",
      namespace: "_funnel.proj_a",
      table: "orders",
      branchName: "main",
      toRef: "dev",
    });
  });
});

describe("happy paths", () => {
  it("createBranch resolves the colon location and forwards fromSnapshotId", async () => {
    mockCreateBranch.mockResolvedValue({ ref: "dev", type: "branch", snapshotId: "7" });
    const res = await createBranch(COLON_DATASET, "dev", "7");
    expect(res).toEqual({ ref: "dev", type: "branch", snapshotId: "7" });
    expect(mockCreateBranch).toHaveBeenCalledWith({
      warehouse: "tellus-funnel",
      namespace: "_funnel.proj_a",
      table: "orders",
      refName: "dev",
      snapshotId: "7",
    });
  });

  it("createTag resolves the slash location (snapshot pin does not leak into the call)", async () => {
    mockCreateTag.mockResolvedValue({ ref: "v1.0", type: "tag", snapshotId: "4216" });
    const res = await createTag(SLASH_DATASET, "v1.0");
    expect(res.type).toBe("tag");
    expect(mockCreateTag).toHaveBeenCalledWith({
      warehouse: "tellus-pipeline",
      namespace: "_pipeline.proj_x.pipe_y",
      table: "output",
      refName: "v1.0",
      snapshotId: undefined,
    });
  });

  it("listRefs returns the sidecar's ref rows", async () => {
    const refs = [
      {
        name: "main",
        type: "branch" as const,
        snapshot_id: "10",
        max_ref_age_ms: null,
        max_snapshot_age_ms: null,
        min_snapshots_to_keep: null,
      },
      {
        name: "v1",
        type: "tag" as const,
        snapshot_id: "8",
        max_ref_age_ms: null,
        max_snapshot_age_ms: null,
        min_snapshots_to_keep: null,
      },
    ];
    mockListRefs.mockResolvedValue({ refs });
    await expect(listRefs(SLASH_DATASET)).resolves.toEqual(refs);
    expect(mockListRefs).toHaveBeenCalledWith({
      warehouse: "tellus-pipeline",
      namespace: "_pipeline.proj_x.pipe_y",
      table: "output",
    });
  });

  it("dropRef forwards the ref name", async () => {
    mockDropRef.mockResolvedValue({ dropped: "dev", type: "branch" });
    await expect(dropRef(COLON_DATASET, "dev")).resolves.toEqual({
      dropped: "dev",
      type: "branch",
    });
    expect(mockDropRef).toHaveBeenCalledWith({
      warehouse: "tellus-funnel",
      namespace: "_funnel.proj_a",
      table: "orders",
      refName: "dev",
    });
  });
});

describe("sidecar error mapping", () => {
  it("maps 'already exists' to REF_EXISTS 409", async () => {
    mockCreateBranch.mockRejectedValue(new Error("ref already exists: dev"));
    await expectAppError(createBranch(COLON_DATASET, "dev"), "REF_EXISTS", 409);
  });

  it("maps catalog commit-time conflicts to REF_EXISTS too", async () => {
    mockCreateTag.mockRejectedValue(
      new Error("CommitFailedException: branch or tag v1 already exists"),
    );
    await expectAppError(createTag(COLON_DATASET, "v1"), "REF_EXISTS", 409);
  });

  it("maps 'ref not found' to REF_NOT_FOUND 404", async () => {
    mockDropRef.mockRejectedValue(new Error("ref not found: ghost"));
    await expectAppError(dropRef(COLON_DATASET, "ghost"), "REF_NOT_FOUND", 404);
  });

  it("maps non-ancestor fast-forward failures to REF_NOT_FAST_FORWARD 409", async () => {
    mockFastForward.mockRejectedValue(
      new Error("cannot fast-forward: dev head 5 is not an ancestor of main (9)"),
    );
    await expectAppError(
      fastForward(COLON_DATASET, "dev", "main"),
      "REF_NOT_FAST_FORWARD",
      409,
    );
  });

  it("maps empty-table ref creation to DATASET_EMPTY 409", async () => {
    mockCreateBranch.mockRejectedValue(
      new Error("table has no snapshots; cannot create a ref on an empty table"),
    );
    await expectAppError(createBranch(COLON_DATASET, "dev"), "DATASET_EMPTY", 409);
  });

  it("falls back to ICEBERG_SIDECAR_ERROR 500 for unknown failures", async () => {
    mockListRefs.mockRejectedValue(new Error("connection reset by peer"));
    await expectAppError(listRefs(COLON_DATASET), "ICEBERG_SIDECAR_ERROR", 500);
  });

  it("passes pre-typed AppErrors through unchanged", async () => {
    mockListRefs.mockRejectedValue(
      new AppError("sidecar missing", 503, "ICEBERG_SIDECAR_UNREACHABLE"),
    );
    await expectAppError(listRefs(COLON_DATASET), "ICEBERG_SIDECAR_UNREACHABLE", 503);
  });
});
