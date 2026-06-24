// ---------------------------------------------------------------------------
// Autosave snapshot — type definitions for the unified resource history.
//
// `payload` is a discriminated union keyed by resource_kind. Capture writes
// the kind-specific shape; restore reads it. Adding a new resource kind
// means: (1) add a literal here, (2) add a payload variant, (3) add a
// restore handler in the route layer, (4) extend the DDL CHECK in
// 071_autosave_snapshots.sql.
// ---------------------------------------------------------------------------

export type AutosaveSnapshotResourceKind =
  | "dataset"
  | "pipeline"
  | "workshop-module"
  | "code-repository"
  | "folder"
  | "project";

export type AutosaveSnapshotChangeKind =
  | "created"
  | "renamed"
  | "moved"
  | "schema-changed"
  | "content-changed"
  | "published"
  | "archived"
  | "unarchived"
  | "deleted"
  | "restored"
  | "configuration-changed";

// ---------------------------------------------------------------------------
// Payload variants — one per resource_kind.
// ---------------------------------------------------------------------------

export interface DatasetPayload {
  kind: "dataset";
  displayName: string;
  description: string | null;
  folderId: string | null;
  format: string | null;
  rowCount: number | null;
  fileSizeBytes: number | null;
  schemaInfo?: Record<string, unknown>;
  status?: string;
}

export interface PipelinePayload {
  kind: "pipeline";
  displayName: string;
  description: string | null;
  folderId: string | null;
  pipelineType: string;
  computeType: string;
  status: string;
  config: Record<string, unknown>;
}

export interface WorkshopModulePayload {
  kind: "workshop-module";
  displayName: string;
  parentFolderRid: string;
  publishedSemver: string | null;
  currentSemver: string | null;
  publishedAt: string | null;
  /** Optional: a content hash so equivalent re-publishes don't double-snapshot. */
  contentHash?: string;
  /** Optional: copy of definition. Capped by the 1 MB payload limit. */
  definition?: Record<string, unknown>;
}

export interface CodeRepoPayload {
  kind: "code-repository";
  displayName: string;
  parentFolderRid: string;
  defaultBranch: string;
  state: "ACTIVE" | "ARCHIVED" | "DELETED";
}

export interface FolderPayload {
  kind: "folder";
  name: string;
  parentFolderId: string | null;
  projectId: string;
}

export interface ProjectPayload {
  kind: "project";
  name: string;
  description: string | null;
}

export type AutosavePayload =
  | DatasetPayload
  | PipelinePayload
  | WorkshopModulePayload
  | CodeRepoPayload
  | FolderPayload
  | ProjectPayload;

// ---------------------------------------------------------------------------
// Public + DB row shapes.
// ---------------------------------------------------------------------------

export interface AutosaveSnapshot {
  id: string;
  resourceRid: string;
  resourceKind: AutosaveSnapshotResourceKind;
  projectId: string;
  parentFolderRid: string | null;
  snapshotAt: string;            // ISO 8601
  actorId: string | null;
  actorEmail: string | null;
  changeKind: AutosaveSnapshotChangeKind;
  changeSummary: string;
  payload: AutosavePayload;
  parentSnapshotId: string | null;
  retentionUntil: string | null; // ISO 8601 or null = keep forever
}

// Postgres row shape (snake_case, raw types from pg).
export interface AutosaveSnapshotRow {
  id: string;
  resource_rid: string;
  resource_kind: AutosaveSnapshotResourceKind;
  project_id: string;
  parent_folder_rid: string | null;
  snapshot_at: string | Date;
  actor_id: string | null;
  actor_email: string | null;
  change_kind: AutosaveSnapshotChangeKind;
  change_summary: string;
  payload: unknown;
  parent_snapshot_id: string | null;
  retention_until: string | Date | null;
}
