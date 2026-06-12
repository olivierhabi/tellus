// ---------------------------------------------------------------------------
// compassChildrenService — unified Compass Gateway children fan-out.
//
// Architecturally mirrors Foundry's Compass Gateway: a single endpoint
// accepts a parent folder RID and returns a heterogeneous union of
// children, paginated globally by `(updated_at DESC, rid DESC)`. Each
// underlying service (folders, datasets, pipelines, workshops, code
// repositories) is queried in parallel from its native table; rows are
// merged at the application layer, sorted, and sliced to the page size.
//
// Why this approach (vs the B3 single-table query):
//   - The B3 `resources` table is not fully populated — workshops and
//     code repositories live in their own tables and would be missing.
//   - Backfilling+triggering all 5 services into `resources` is a large
//     cross-cutting migration; the Gateway pattern avoids it entirely.
//   - The same 5 source tables remain the source-of-truth for their
//     own services' writes — we don't introduce a dual-write hazard.
//
// Failure semantics: `Promise.allSettled` — one source going down
// (e.g. workshop service migration in progress) degrades the page
// gracefully instead of 500ing. Failed sources surface as
// `partialErrors[]` in the response so the UI can warn the user.
// ---------------------------------------------------------------------------
import { pool } from "../db";
import { formatFileSize } from "./foundryUploadService";
import {
  ResourceChild,
  ChildrenResponse,
  Cursor,
  decodeCursor,
  encodeCursor,
  parseFolderRid,
  folderRid,
} from "../types/compassChildren";

// Tunables. The hard ceiling matches B3's `MAX_PAGE_SIZE`.
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// Service RID prefixes — must remain stable; cursors persist across
// requests and the cursor.rid carries this prefix.
const FOLDER_RID_PREFIX = "ri.compass.main.folder.";
const DATASET_RID_PREFIX = "ri.foundry.main.dataset.";
const PIPELINE_RID_PREFIX = "ri.foundry.main.pipeline.";

// All Compass folder/project RIDs are `ri.compass.main.<type>.<uuid>` — the
// 5th dot-segment is the UUID. Data-connection sources store their parent as
// EITHER `ri.compass.main.project.<uuid>` (root) or `ri.compass.main.folder.<uuid>`
// (subfolder); Quiver analyses store the full folder RID. Matching by the
// trailing UUID via `split_part(rid,'.',5)` is uniform across both forms and
// is version-safe (positive index — no PG14+ negative-index dependency).
const RID_UUID_SEGMENT = 5;

export interface GetChildrenOpts {
  folderRid: string;
  pageSize?: number;
  pageToken?: string;
  kinds?: string;       // CSV, e.g. "folder,dataset"
  search?: string;
  includeArchived?: boolean;
  // For unit-testing: allow overriding which sources to query (default: all 5).
  enabledSources?: Set<SourceName>;
}

export type SourceName =
  | "folders"
  | "datasets"
  | "pipelines"
  | "workshops"
  | "code-repositories"
  | "data-connections"
  | "quiver-analyses";

const ALL_SOURCES: ReadonlySet<SourceName> = new Set([
  "folders", "datasets", "pipelines", "workshops", "code-repositories",
  "data-connections", "quiver-analyses",
]);

const KIND_TO_SOURCE: Record<string, SourceName> = {
  "folder": "folders",
  "dataset": "datasets",
  "pipeline": "pipelines",
  "workshop-module": "workshops",
  "code-repository": "code-repositories",
  "data-connection": "data-connections",
  "quiver-analysis": "quiver-analyses",
};

/**
 * Resolve a Compass folder RID to the legacy (projectId, folderId) tuple.
 *
 * Convention (Foundry-faithful): a project's root folder uses the same
 * UUID as the project itself, so:
 *   - If <uuid> ∈ projects → projectId = <uuid>, folderId = null  (root)
 *   - If <uuid> ∈ folders  → projectId = folders.project_id,
 *                            folderId  = <uuid>                   (subfolder)
 *   - Otherwise            → 404 NOT_FOUND
 */
async function resolveFolder(rid: string): Promise<{ projectId: string; folderId: string | null }> {
  const { uuid } = parseFolderRid(rid);
  // Single round-trip — UNION over both tables.
  const { rows } = await pool.query<{ source: string; project_id: string }>(
    `SELECT 'project'::text AS source, id::text AS project_id FROM projects WHERE id = $1
     UNION ALL
     SELECT 'folder'::text AS source, project_id::text AS project_id FROM folders WHERE id = $1
     LIMIT 1`,
    [uuid],
  );
  if (rows.length === 0) {
    throw Object.assign(new Error(`Compass folder not found: ${rid}`), {
      code: "FOLDER_NOT_FOUND",
      status: 404,
    });
  }
  const r = rows[0];
  return { projectId: r.project_id, folderId: r.source === "project" ? null : uuid };
}

interface QueryArgs {
  folderRid: string;
  projectId: string;
  folderId: string | null;
  pageSize: number;
  cursor: Cursor | null;
  search: string | null;
  includeArchived: boolean;
}

// ---- per-source queries ----------------------------------------------------

async function queryFolders(a: QueryArgs): Promise<ResourceChild[]> {
  const params: unknown[] = [a.projectId];
  let where = "f.project_id = $1";
  if (a.folderId === null) where += " AND f.parent_folder_id IS NULL";
  else { params.push(a.folderId); where += ` AND f.parent_folder_id = $${params.length}`; }

  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND f.name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (f.updated_at, '${FOLDER_RID_PREFIX}' || f.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const limitIdx = params.length;
  const sql = `
    SELECT f.id::text AS id, f.name, f.created_at, f.updated_at,
           (SELECT count(*) FROM folders WHERE parent_folder_id = f.id) AS sub_folder_count
    FROM folders f
    WHERE ${where}
    ORDER BY f.updated_at DESC, f.id DESC
    LIMIT $${limitIdx}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "folder",
    rid: FOLDER_RID_PREFIX + r.id,
    displayName: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: r.id,
    subFolderCount: Number(r.sub_folder_count ?? 0),
  }));
}

async function queryDatasets(a: QueryArgs): Promise<ResourceChild[]> {
  const params: unknown[] = [a.projectId];
  let where = "fd.project_id = $1";
  if (a.folderId === null) where += " AND fd.folder_id IS NULL";
  else { params.push(a.folderId); where += ` AND fd.folder_id = $${params.length}`; }
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND fd.name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (fd.updated_at, '${DATASET_RID_PREFIX}' || fd.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT fd.id::text AS id, fd.name, fd.created_at, fd.updated_at, fd.status,
           fd.row_count_exact, fd.row_count, fd.file_size_bytes, fd.format
    FROM foundry_datasets fd
    WHERE ${where}
    ORDER BY fd.updated_at DESC, fd.id DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "dataset",
    rid: DATASET_RID_PREFIX + r.id,
    displayName: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: r.id,
    status: (["pending", "processing", "ready", "error"] as const).includes(r.status)
      ? r.status as "pending" | "processing" | "ready" | "error"
      : "ready",
    rowCount: r.row_count_exact ? Number(r.row_count_exact) : (r.row_count ? Number(r.row_count) : null),
    fileSize: r.file_size_bytes ? Number(r.file_size_bytes) : null,
    // Server-authoritative size string. The formatter accepts the
    // BIGINT-as-string shape that node-postgres returns, so we don't
    // need to coerce here — the canonical implementation in
    // foundryUploadService.formatFileSize handles every realistic
    // input (number | string | bigint | null | undefined).
    fileSizeFormatted: formatFileSize(r.file_size_bytes),
    format: r.format ?? null,
  }));
}

async function queryPipelines(a: QueryArgs): Promise<ResourceChild[]> {
  const params: unknown[] = [a.projectId];
  let where = "p.project_id = $1";
  if (a.folderId === null) where += " AND p.folder_id IS NULL";
  else { params.push(a.folderId); where += ` AND p.folder_id = $${params.length}`; }
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND p.name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (p.updated_at, '${PIPELINE_RID_PREFIX}' || p.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT p.id::text AS id, p.name, p.created_at, p.updated_at,
           p.pipeline_type, p.compute_type, p.status
    FROM pipelines p
    WHERE ${where}
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "pipeline",
    rid: PIPELINE_RID_PREFIX + r.id,
    displayName: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: r.id,
    pipelineType: r.pipeline_type ?? "batch",
    computeType: r.compute_type ?? "duckdb",
    status: r.status ?? "draft",
  }));
}

async function queryWorkshops(a: QueryArgs): Promise<ResourceChild[]> {
  // workshop_module has no `status` column — the lifecycle is encoded by
  // (published_at, deleted_at). We derive the DRAFT/PUBLISHED/ARCHIVED
  // status the FE expects from those nullable timestamps. Default query
  // hides soft-deleted rows (matches the production
  // `idx_workshop_module_folder` partial index `WHERE deleted_at IS NULL`);
  // `includeArchived` opens that filter for admin views.
  const params: unknown[] = [a.folderRid];
  let where = "wm.parent_folder_rid = $1";
  if (!a.includeArchived) where += " AND wm.deleted_at IS NULL";
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND wm.display_name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (wm.updated_at, wm.rid) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT wm.rid, wm.display_name, wm.created_at, wm.updated_at,
           wm.current_semver, wm.published_semver,
           wm.published_at, wm.deleted_at
    FROM workshop_module wm
    WHERE ${where}
    ORDER BY wm.updated_at DESC, wm.rid DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => {
    const status: "DRAFT" | "PUBLISHED" | "ARCHIVED" = r.deleted_at
      ? "ARCHIVED"
      : r.published_at
        ? "PUBLISHED"
        : "DRAFT";
    return {
      kind: "workshop-module",
      rid: r.rid,
      displayName: r.display_name,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      parentFolderRid: a.folderRid,
      legacyId: null,
      status,
      currentSemver: r.current_semver ?? null,
      publishedSemver: r.published_semver ?? null,
    };
  });
}

async function queryCodeRepos(a: QueryArgs): Promise<ResourceChild[]> {
  const params: unknown[] = [a.folderRid];
  let where = "cr.parent_folder_rid = $1";
  if (!a.includeArchived) where += " AND cr.state = 'ACTIVE'";
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND cr.display_name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (cr.updated_at, cr.rid) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT cr.rid, cr.display_name, cr.created_at, cr.updated_at, cr.state, cr.default_branch
    FROM code_repository cr
    WHERE ${where}
    ORDER BY cr.updated_at DESC, cr.rid DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "code-repository",
    rid: r.rid,
    displayName: r.display_name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: null,
    state: (["ACTIVE", "ARCHIVED", "DELETED"] as const).includes(r.state)
      ? r.state as "ACTIVE" | "ARCHIVED" | "DELETED"
      : "ACTIVE",
    defaultBranch: r.default_branch ?? "main",
  }));
}

async function queryDataConnections(a: QueryArgs): Promise<ResourceChild[]> {
  // `connectivity_connections.compass_folder_rid` is the resource's parent —
  // a project RID at root, a folder RID in a subfolder. Match on the trailing
  // UUID so both forms resolve to the folder the caller asked for. Soft-deleted
  // connections (`deleted_at`) are hidden — there is no archived/admin view
  // for connections, so `includeArchived` does not widen this filter.
  const matchUuid = a.folderId ?? a.projectId;
  const params: unknown[] = [matchUuid];
  let where = `split_part(cc.compass_folder_rid, '.', ${RID_UUID_SEGMENT}) = $1 AND cc.deleted_at IS NULL`;
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND cc.name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (cc.updated_at, cc.rid) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT cc.rid, cc.name, cc.connector_type, cc.created_at, cc.updated_at,
           cc.status->>'kind' AS status_kind
    FROM connectivity_connections cc
    WHERE ${where}
    ORDER BY cc.updated_at DESC, cc.rid DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "data-connection",
    rid: r.rid,
    displayName: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: null,
    connectorType: r.connector_type ?? "unknown",
    status: r.status_kind ?? "active",
  }));
}

async function queryQuiverAnalyses(a: QueryArgs): Promise<ResourceChild[]> {
  // `quiver_analysis.parent_folder_rid` is the full Compass folder RID. Match
  // on the trailing UUID (same rule as data-connections) so an analysis
  // created in a real project/folder lands in the tree. Soft-deleted rows
  // (`is_deleted`) are hidden.
  const matchUuid = a.folderId ?? a.projectId;
  const params: unknown[] = [matchUuid];
  let where = `split_part(qa.parent_folder_rid, '.', ${RID_UUID_SEGMENT}) = $1 AND qa.is_deleted = false`;
  if (a.search) {
    params.push(`%${a.search}%`);
    where += ` AND qa.display_name ILIKE $${params.length}`;
  }
  if (a.cursor) {
    params.push(a.cursor.updatedAt, a.cursor.rid);
    where += ` AND (qa.updated_at, qa.rid) < ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(a.pageSize + 1);
  const sql = `
    SELECT qa.rid, qa.display_name, qa.created_at, qa.updated_at
    FROM quiver_analysis qa
    WHERE ${where}
    ORDER BY qa.updated_at DESC, qa.rid DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r): ResourceChild => ({
    kind: "quiver-analysis",
    rid: r.rid,
    displayName: r.display_name,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    parentFolderRid: a.folderRid,
    legacyId: null,
  }));
}

// ---- public API ------------------------------------------------------------

export async function getChildren(opts: GetChildrenOpts): Promise<ChildrenResponse> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const cursor = decodeCursor(opts.pageToken);
  const search = opts.search?.trim() ? opts.search.trim() : null;
  const includeArchived = !!opts.includeArchived;
  const enabled = opts.enabledSources ?? ALL_SOURCES;

  // Optional kind filter narrows which sources we even bother querying.
  const requestedSources = opts.kinds
    ? new Set(opts.kinds.split(",").map((k) => KIND_TO_SOURCE[k.trim()]).filter((s): s is SourceName => !!s))
    : enabled;

  const { projectId, folderId } = await resolveFolder(opts.folderRid);
  const args: QueryArgs = {
    folderRid: opts.folderRid,
    projectId,
    folderId,
    pageSize,
    cursor,
    search,
    includeArchived,
  };

  // Fan out — each source over-fetches by 1 to detect "more".
  const tasks: Array<[SourceName, Promise<ResourceChild[]>]> = [];
  if (requestedSources.has("folders"))           tasks.push(["folders", queryFolders(args)]);
  if (requestedSources.has("datasets"))          tasks.push(["datasets", queryDatasets(args)]);
  if (requestedSources.has("pipelines"))         tasks.push(["pipelines", queryPipelines(args)]);
  if (requestedSources.has("workshops"))         tasks.push(["workshops", queryWorkshops(args)]);
  if (requestedSources.has("code-repositories")) tasks.push(["code-repositories", queryCodeRepos(args)]);
  if (requestedSources.has("data-connections"))  tasks.push(["data-connections", queryDataConnections(args)]);
  if (requestedSources.has("quiver-analyses"))   tasks.push(["quiver-analyses", queryQuiverAnalyses(args)]);

  const settled = await Promise.allSettled(tasks.map(([, p]) => p));
  const partialErrors: Array<{ source: SourceName; message: string }> = [];
  const merged: ResourceChild[] = [];
  settled.forEach((res, i) => {
    const [name] = tasks[i];
    if (res.status === "fulfilled") {
      merged.push(...res.value);
    } else {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      partialErrors.push({ source: name, message: msg });
       
      console.error(`[compassChildrenService] source ${name} failed:`, res.reason);
    }
  });

  // Global merge sort — `(updated_at DESC, rid DESC)`.
  merged.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.rid < b.rid ? 1 : -1;
  });
  const items = merged.slice(0, pageSize);
  const more = merged.length > pageSize;
  const nextPageToken = more && items.length > 0
    ? encodeCursor({ updatedAt: items[items.length - 1].updatedAt, rid: items[items.length - 1].rid })
    : null;

  return { items, nextPageToken, pageSize, partialErrors };
}
