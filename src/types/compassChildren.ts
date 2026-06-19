// ---------------------------------------------------------------------------
// Compass Gateway children — v2 unified resource catalog.
//
// Replaces the 5 fan-out HTTP calls the project workspace used to make
// (folders, datasets, pipelines, workshops, code-repositories) with one
// merge-paginated endpoint that returns a discriminated-union of child
// resources, ordered by `(updated_at DESC, rid DESC)`. The total order
// across heterogeneous sources is guaranteed because resource RIDs use
// non-overlapping service prefixes (`ri.compass.main.folder.*`,
// `ri.foundry.main.dataset.*`, `ri.compass.main.project.*`,
// `ri.workshop.main.module.*`, `ri.stemma.main.repository.*`).
//
// Pagination is cursor-based (`base64(JSON{updatedAt, rid})`), matching
// the B3 contract, so the frontend can lift this into a TanStack
// useInfiniteQuery and the load-more sentinel scrolls through any size
// folder without ever fetching beyond the current page.
// ---------------------------------------------------------------------------
import { z } from "zod";

// kind discriminator — every child carries exactly one of these.
export const ChildKind = z.enum([
  "folder",
  "dataset",
  "pipeline",
  "workshop-module",
  "code-repository",
]);
export type ChildKind = z.infer<typeof ChildKind>;

// Common fields every kind exposes.
const BaseChild = z.object({
  rid: z.string().min(1),
  displayName: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  parentFolderRid: z.string().min(1),
  // The legacy UUID for routes that still reference rows by UUID
  // (e.g. /projects/<id>/folders/<id>). Always present for v1-source kinds;
  // null only when a future v2-only kind never had a UUID at all.
  legacyId: z.string().uuid().nullable(),
});

const FolderChild = BaseChild.extend({
  kind: z.literal("folder"),
  // Number of immediate children (cheap subquery on `folders` only —
  // doesn't recurse into datasets/pipelines/etc.).
  subFolderCount: z.number().int().nonnegative(),
});

const DatasetChild = BaseChild.extend({
  kind: z.literal("dataset"),
  status: z.enum(["pending", "processing", "ready", "error"]),
  rowCount: z.number().int().nonnegative().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  // Backend-authoritative formatted size string (e.g. "88 KB", "1.5 MB", "0 B").
  // The frontend renders this verbatim — single source of truth for human-readable
  // file sizes, so FE never has to coerce BIGINT-as-string from node-postgres.
  fileSizeFormatted: z.string(),
  format: z.string().nullable(),
});

const PipelineChild = BaseChild.extend({
  kind: z.literal("pipeline"),
  pipelineType: z.string(),
  computeType: z.string(),
  status: z.string(),
});

const WorkshopChild = BaseChild.extend({
  kind: z.literal("workshop-module"),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
  currentSemver: z.string().nullable(),
  publishedSemver: z.string().nullable(),
});

const CodeRepoChild = BaseChild.extend({
  kind: z.literal("code-repository"),
  state: z.enum(["ACTIVE", "ARCHIVED", "DELETED"]),
  defaultBranch: z.string(),
});

export const ResourceChild = z.discriminatedUnion("kind", [
  FolderChild, DatasetChild, PipelineChild, WorkshopChild, CodeRepoChild,
]);
export type ResourceChild = z.infer<typeof ResourceChild>;
export type FolderChildItem = z.infer<typeof FolderChild>;
export type DatasetChildItem = z.infer<typeof DatasetChild>;
export type PipelineChildItem = z.infer<typeof PipelineChild>;
export type WorkshopChildItem = z.infer<typeof WorkshopChild>;
export type CodeRepoChildItem = z.infer<typeof CodeRepoChild>;

// Request shape — query params accepted by the unified endpoint.
export const ChildrenQuery = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  pageToken: z.string().optional(),
  // Optional kind filter — accepts CSV ("folder,dataset"). Empty/absent ⇒ all.
  kinds: z.string().optional(),
  // Substring (case-insensitive) on displayName.
  search: z.string().max(200).optional(),
  // For code repos: include archived. Default false (matches Foundry default).
  includeArchived: z.coerce.boolean().default(false),
});
export type ChildrenQuery = z.infer<typeof ChildrenQuery>;

export const ChildrenResponse = z.object({
  items: z.array(ResourceChild),
  nextPageToken: z.string().nullable(),
  pageSize: z.number().int().positive(),
  // Per-source partial errors. If a source failed, its rows are missing
  // but the rest of the page rendered. UI surfaces this as a banner.
  partialErrors: z.array(z.object({
    source: z.enum(["folders", "datasets", "pipelines", "workshops", "code-repositories"]),
    message: z.string(),
  })),
});
export type ChildrenResponse = z.infer<typeof ChildrenResponse>;

// Cursor — opaque base64(JSON) format, identical to B3.
export const Cursor = z.object({
  updatedAt: z.string(),
  rid: z.string(),
});
export type Cursor = z.infer<typeof Cursor>;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(token: string | undefined): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return Cursor.parse(parsed);
  } catch {
    return null;
  }
}

// Parse a Compass folder RID (`ri.compass.main.folder.<uuid>`) → uuid.
const FOLDER_RID_RE = /^ri\.compass\.main\.folder\.([0-9a-fA-F-]{36})$/;
export function parseFolderRid(rid: string): { uuid: string } {
  const m = FOLDER_RID_RE.exec(rid);
  if (!m) {
    throw Object.assign(new Error(`INVALID_FOLDER_RID: ${rid}`), {
      code: "INVALID_FOLDER_RID",
      status: 400,
    });
  }
  return { uuid: m[1].toLowerCase() };
}

export function folderRid(uuid: string): string {
  return `ri.compass.main.folder.${uuid}`;
}
