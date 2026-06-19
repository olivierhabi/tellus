// ---------------------------------------------------------------------------
// trashSnapshot — Zod-validated snapshot payloads stored in
// `resources.metadata.snapshot` for trashed datasets and folders.
//
// Why this lives in its own module:
//   * Trash mirrors are written by `folderService.deleteFolder` and
//     `datasetService.deleteDataset`, then consumed by
//     `trashService.restore` and `trashService.permanentlyDelete`. A
//     drift between writer and reader silently breaks restore for any
//     row trashed before the drift landed. A single source of truth +
//     parser at the read path catches the drift at runtime with a
//     loud, structured error rather than a half-restored row.
//   * Versioned via a discriminated union so the next snapshot shape
//     can be added (`v: 2`) without breaking older rows. Readers must
//     handle both versions until a backfill ages the older shape out.
// ---------------------------------------------------------------------------
import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy: maximum subtree size that can be soft-deleted in a single
// click. Beyond this we refuse with `RESOURCE_TOO_LARGE` and require
// the caller to use the bulk-trash worker (a follow-up; not yet wired).
//
// 10_000 is chosen so that:
//   * Snapshots never exceed ~5MB (median dataset row ~500 bytes).
//   * The single-txn upsert completes in <2s on a healthy primary.
//   * pg's WAL records stay below the 16MB segment boundary.
// Larger trees are extremely rare in practice; if/when they appear,
// the bulk worker model (commit per 1k rows, retryable, observable) is
// the right answer rather than scaling the synchronous path further.
// ---------------------------------------------------------------------------
export const MAX_TRASH_SUBTREE_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Snapshot payload: dataset (used by `deleteDataset`).
// ---------------------------------------------------------------------------
const DatasetSnapshotV1 = z.object({
  v: z.literal(1),
  kind: z.literal("dataset"),
  capturedAt: z.string(),
  dataset: z.object({
    id: z.string().uuid(),
    name: z.string(),
    project_id: z.string().uuid().nullable(),
    folder_id: z.string().uuid().nullable(),
    file_path: z.string().nullable(),
    original_filename: z.string().nullable(),
    mime_type: z.string().nullable(),
    file_size_bytes: z.number().nullable(),
    row_count: z.number().nullable(),
    row_count_exact: z.number().nullable(),
    column_count: z.number().nullable(),
    schema_info: z.unknown().nullable(),
    markings: z.unknown().nullable(),
    status: z.string().nullable(),
    format: z.string().nullable(),
    content_hash: z.string().nullable(),
    last_output_schema_fingerprint: z.string().nullable(),
    created_at: z.union([z.date(), z.string()]).nullable(),
    updated_at: z.union([z.date(), z.string()]).nullable(),
    created_by: z.string().nullable(),
    updated_by: z.string().nullable(),
  }),
  columns: z.array(z.object({
    column_name: z.string(),
    column_type: z.string(),
    ordinal_position: z.number(),
    nullable: z.boolean(),
    sample_values: z.unknown().nullable(),
  })),
  versions: z.array(z.object({
    id: z.string().uuid(),
    version_number: z.number(),
    file_path: z.string(),
    row_count: z.number().nullable(),
    row_count_exact: z.number().nullable(),
    file_size_bytes: z.number().nullable(),
    schema_info: z.unknown().nullable(),
    content_hash: z.string().nullable(),
    created_at: z.union([z.date(), z.string()]),
    created_by: z.string().nullable(),
  })),
});

// ---------------------------------------------------------------------------
// Snapshot payload: folder subtree (used by `deleteFolder`).
// ---------------------------------------------------------------------------
const FolderRowV1 = z.object({
  id: z.string().uuid(),
  name: z.string(),
  parent_folder_id: z.string().uuid().nullable(),
  path: z.string(),
  depth: z.number(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});

// Datasets, pipelines, code-repositories and workshop-modules in a
// folder subtree are stored verbatim from their source-of-truth tables.
// We keep the shape permissive (`record(unknown)`) and validate the
// fields we actually read at restore time. Adding a new resource kind
// later only requires extending the writer and the restore reader —
// the schema stays additive (back-compat: older snapshots that lack
// these keys still parse, the array defaults to []).
const FolderSubtreeDatasetV1 = z.record(z.string(), z.unknown());
const FolderSubtreePipelineV1 = z.record(z.string(), z.unknown());
const FolderSubtreeCodeRepoV1 = z.record(z.string(), z.unknown());
const FolderSubtreeWorkshopModuleV1 = z.record(z.string(), z.unknown());

const FolderSnapshotV1 = z.object({
  v: z.literal(1),
  kind: z.literal("folder"),
  capturedAt: z.string(),
  rootFolderId: z.string().uuid(),
  folders: z.array(FolderRowV1),
  datasets: z.array(FolderSubtreeDatasetV1),
  // Optional for back-compat: rows trashed before pipelines / code repos
  // / workshop-modules were captured don't carry these arrays. A missing
  // key is read as an empty array by the restore path so old snapshots
  // restore the bits they have rather than failing the whole operation.
  pipelines: z.array(FolderSubtreePipelineV1).optional().default([]),
  codeRepositories: z.array(FolderSubtreeCodeRepoV1).optional().default([]),
  workshopModules: z.array(FolderSubtreeWorkshopModuleV1).optional().default([]),
});

// ---------------------------------------------------------------------------
// Restore order is topological: a kind may only be restored after every
// kind it FK-depends on has already been written. The list below is the
// single source of truth that `trashService.restore` walks; adding a
// new kind requires placing it in the right slot.
//
//   folders         → no FK deps (parent_folder_id is self-ref, handled
//                     in-batch via livePid set).
//   datasets        → folders.id (folder_id), folders.project_id.
//   pipelines       → folders.id (folder_id, ON DELETE SET NULL).
//   codeRepositories → folders (parent_folder_rid → ri.compass.main.folder.<uuid>).
//   workshopModules → folders (parent_folder_rid), ontology (ontology_rid).
//
// Note: code_repository_branch_cache rows are NOT captured. The cache
// FKs to code_repository.rid with ON DELETE CASCADE so it is wiped on
// hard-delete. It self-heals on next branch fetch — capturing it would
// double the snapshot size for no behavioural benefit. (See restore
// docs for rationale.)
// ---------------------------------------------------------------------------
export type RestoreKind =
  | "folders"
  | "datasets"
  | "pipelines"
  | "codeRepositories"
  | "workshopModules";
export const RESTORE_SEQUENCE: readonly RestoreKind[] = [
  "folders",
  "datasets",
  "pipelines",
  "codeRepositories",
  "workshopModules",
] as const;

// ---------------------------------------------------------------------------
// Discriminated union — the single shape readers must accept.
// ---------------------------------------------------------------------------
export const TrashSnapshot = z.discriminatedUnion("kind", [
  DatasetSnapshotV1,
  FolderSnapshotV1,
]);

export type TrashSnapshot = z.infer<typeof TrashSnapshot>;
export type DatasetSnapshot = z.infer<typeof DatasetSnapshotV1>;
export type FolderSnapshot = z.infer<typeof FolderSnapshotV1>;

/**
 * Total number of resource rows captured in a folder snapshot, across
 * every kind. Used by the destructive path to enforce
 * `MAX_TRASH_SUBTREE_SIZE` — the per-row mirror count is one axis, the
 * snapshot byte size is the other, both bounded by the same cap.
 */
export function snapshotTotalRows(snap: FolderSnapshot): number {
  return (
    snap.folders.length +
    snap.datasets.length +
    (snap.pipelines?.length ?? 0) +
    (snap.codeRepositories?.length ?? 0) +
    (snap.workshopModules?.length ?? 0)
  );
}

/**
 * Parse a JSONB `metadata.snapshot` payload from the resources table.
 *
 * Returns `null` for absent / empty / unrecognised payloads — callers
 * decide whether to error or degrade. Logs the schema mismatch detail
 * so we can detect silent drift in production.
 */
export function parseTrashSnapshot(input: unknown): TrashSnapshot | null {
  if (input == null || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || typeof candidate.v !== "number") {
    return null;
  }
  const result = TrashSnapshot.safeParse(input);
  if (!result.success) {
    // Loud structured warning so SREs can spot the drift; a thrown
    // error here would block restore for every row trashed before the
    // change, which is worse UX than a best-effort restore.
    // eslint-disable-next-line no-console
    console.warn("[trashSnapshot] Snapshot failed schema validation:", {
      issues: result.error.issues.slice(0, 5),
    });
    return null;
  }
  return result.data;
}
