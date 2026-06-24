// ---------------------------------------------------------------------------
// Unit coverage for `parseTrashSnapshot`, `snapshotTotalRows`,
// `RESTORE_SEQUENCE`, and `MAX_TRASH_SUBTREE_SIZE`.
//
// Why this file matters: the parser is the single read-side contract
// between every trash producer (`folderService.deleteFolder`,
// `datasetService.deleteDataset`) and every trash consumer
// (`trashService.restore`, `trashService.permanentlyDelete`). A silent
// schema narrowing in the writer would make every snapshot trashed
// before the change un-restorable. These tests fail loud on that
// regression by pinning every shape we accept and reject today.
//
// Negative tests (do these break if you remove guards?):
//   * remove the `kind`/`v` early-out → "rejects payload missing kind"
//     starts taking the slow Zod path; the "returns null for empty" test
//     still passes but the parser becomes O(schema) on every junk input.
//   * narrow `pipelines: .optional().default([])` → "back-compat" test
//     fails: snapshots written before pipelines were captured stop
//     parsing and every legacy row becomes un-restorable.
//   * widen `dataset.id` away from `.uuid()` → "rejects malformed id"
//     test fails; production restores rows whose id is not a UUID.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  parseTrashSnapshot,
  snapshotTotalRows,
  RESTORE_SEQUENCE,
  MAX_TRASH_SUBTREE_SIZE,
  type FolderSnapshot,
  type DatasetSnapshot,
} from "../../../src/schemas/trashSnapshot";

const VALID_UUID_A = "39a61ca2-37f3-4d0d-b750-f6d3a6d0823c";
const VALID_UUID_B = "4a94852a-def0-422b-8a55-98fcabc86277";

function validFolderSnapshot(): FolderSnapshot {
  return {
    v: 1,
    kind: "folder",
    capturedAt: "2026-05-09T00:00:00.000Z",
    rootFolderId: VALID_UUID_A,
    folders: [
      {
        id: VALID_UUID_A,
        name: "root",
        parent_folder_id: null,
        path: "p1.f1",
        depth: 0,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ],
    datasets: [],
    pipelines: [],
    codeRepositories: [],
    workshopModules: [],
  };
}

function validDatasetSnapshot(): DatasetSnapshot {
  return {
    v: 1,
    kind: "dataset",
    capturedAt: "2026-05-09T00:00:00.000Z",
    dataset: {
      id: VALID_UUID_B,
      name: "x.csv",
      project_id: VALID_UUID_A,
      folder_id: null,
      file_path: "projects/p/folders/f/x.csv",
      original_filename: null,
      mime_type: "text/csv",
      file_size_bytes: 100,
      row_count: 10,
      row_count_exact: null,
      column_count: 4,
      schema_info: null,
      markings: [],
      status: "ready",
      format: "csv",
      content_hash: null,
      last_output_schema_fingerprint: null,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      created_by: VALID_UUID_A,
      updated_by: VALID_UUID_A,
    },
    columns: [],
    versions: [],
  };
}

describe("parseTrashSnapshot", () => {
  it("returns null for null/undefined/non-object inputs", () => {
    expect(parseTrashSnapshot(null)).toBeNull();
    expect(parseTrashSnapshot(undefined)).toBeNull();
    expect(parseTrashSnapshot("string")).toBeNull();
    expect(parseTrashSnapshot(42)).toBeNull();
    expect(parseTrashSnapshot([])).toBeNull();
  });

  it("rejects payload missing the discriminator (`kind` / `v`)", () => {
    expect(parseTrashSnapshot({})).toBeNull();
    expect(parseTrashSnapshot({ kind: "folder" })).toBeNull(); // missing v
    expect(parseTrashSnapshot({ v: 1 })).toBeNull(); // missing kind
    expect(parseTrashSnapshot({ kind: "spaceship", v: 1 })).toBeNull();
  });

  it("parses a valid folder snapshot", () => {
    const result = parseTrashSnapshot(validFolderSnapshot());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("folder");
    if (result?.kind === "folder") {
      expect(result.folders).toHaveLength(1);
      expect(result.rootFolderId).toBe(VALID_UUID_A);
    }
  });

  it("parses a valid dataset snapshot (nested under .dataset)", () => {
    const result = parseTrashSnapshot(validDatasetSnapshot());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("dataset");
    if (result?.kind === "dataset") {
      // Regression guard for the previously-shipped bug: dataset fields
      // live under `.dataset.*`, not at the top level.
      expect(result.dataset.id).toBe(VALID_UUID_B);
      expect(result.dataset.file_path).toBe(
        "projects/p/folders/f/x.csv",
      );
    }
  });

  it("preserves back-compat: legacy folder snapshots without pipelines/codeRepositories/workshopModules parse cleanly with empty defaults", () => {
    const legacy = validFolderSnapshot() as Partial<FolderSnapshot>;
    delete legacy.pipelines;
    delete legacy.codeRepositories;
    delete legacy.workshopModules;
    const result = parseTrashSnapshot(legacy);
    expect(result).not.toBeNull();
    if (result?.kind === "folder") {
      expect(result.pipelines).toEqual([]);
      expect(result.codeRepositories).toEqual([]);
      expect(result.workshopModules).toEqual([]);
    }
  });

  it("rejects a snapshot with a malformed UUID in dataset.id", () => {
    const bad = validDatasetSnapshot();
    (bad.dataset as { id: string }).id = "not-a-uuid";
    expect(parseTrashSnapshot(bad)).toBeNull();
  });

  it("rejects unknown discriminator values without throwing", () => {
    expect(parseTrashSnapshot({ kind: "future-kind", v: 1 })).toBeNull();
  });

  it("rejects an unsupported version (`v: 2`)", () => {
    expect(
      parseTrashSnapshot({ ...validFolderSnapshot(), v: 2 }),
    ).toBeNull();
  });
});

describe("snapshotTotalRows", () => {
  it("counts only folders + datasets when other arrays are empty", () => {
    const snap = validFolderSnapshot();
    snap.datasets = [{ id: "x" }, { id: "y" }];
    expect(snapshotTotalRows(snap)).toBe(1 + 2);
  });

  it("includes pipelines, codeRepositories, workshopModules in the total", () => {
    const snap = validFolderSnapshot();
    snap.pipelines = [{ id: "p1" }, { id: "p2" }];
    snap.codeRepositories = [{ rid: "r1" }];
    snap.workshopModules = [{ rid: "w1" }, { rid: "w2" }, { rid: "w3" }];
    // 1 folder + 0 datasets + 2 pipelines + 1 cr + 3 wm = 7
    expect(snapshotTotalRows(snap)).toBe(7);
  });

  it("treats missing optional arrays as zero-length (back-compat)", () => {
    const snap = validFolderSnapshot() as FolderSnapshot;
    // Simulate a legacy snapshot that pre-dates the new arrays.
    (snap as Partial<FolderSnapshot>).pipelines = undefined;
    (snap as Partial<FolderSnapshot>).codeRepositories = undefined;
    (snap as Partial<FolderSnapshot>).workshopModules = undefined;
    expect(snapshotTotalRows(snap)).toBe(1);
  });
});

describe("RESTORE_SEQUENCE", () => {
  it("starts with `folders` so every dependent kind has a live FK target", () => {
    expect(RESTORE_SEQUENCE[0]).toBe("folders");
  });

  it("places `datasets` before `pipelines` (datasets are typically inputs)", () => {
    const idxDatasets = RESTORE_SEQUENCE.indexOf("datasets");
    const idxPipelines = RESTORE_SEQUENCE.indexOf("pipelines");
    expect(idxDatasets).toBeGreaterThanOrEqual(0);
    expect(idxPipelines).toBeGreaterThan(idxDatasets);
  });

  it("contains every kind with no duplicates", () => {
    const set = new Set(RESTORE_SEQUENCE);
    expect(set.size).toBe(RESTORE_SEQUENCE.length);
    // Pin the canonical set so adding a new kind requires a deliberate
    // edit here too.
    expect(set).toEqual(
      new Set([
        "folders",
        "datasets",
        "pipelines",
        "codeRepositories",
        "workshopModules",
      ]),
    );
  });
});

describe("MAX_TRASH_SUBTREE_SIZE", () => {
  it("is a positive integer", () => {
    expect(MAX_TRASH_SUBTREE_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TRASH_SUBTREE_SIZE)).toBe(true);
  });

  it("is large enough for typical projects but bounded", () => {
    expect(MAX_TRASH_SUBTREE_SIZE).toBeGreaterThanOrEqual(1_000);
    expect(MAX_TRASH_SUBTREE_SIZE).toBeLessThanOrEqual(100_000);
  });
});
