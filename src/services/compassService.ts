/**
 * Compass Service — Files & Projects B1.
 *
 * Spec:      tasks/files-projects/files-projects-tasks.md:47-138
 * Contracts: tasks/files-projects/contracts.md (B1-C-20 .. B1-C-25, B1-C-40, B1-C-41).
 *
 * The Compass service is the canonical read surface over the `resources`
 * table introduced by B1's DDL block in `src/foundryMigrate.ts`. It is a
 * thin wrapper: every public method is a parameterized query against
 * `resources`, returning typed rows.
 *
 * Write paths live in `projectService` / `folderService` /
 * `foundryUploadService`; this file is read-only by design (B1-X-02 — no
 * parallel implementations of write paths).
 *
 * Errors are thrown as `OntologyError` instances so the existing route-
 * level error handler (`src/utils/queryErrors.ts:OntologyError.toResponse`)
 * produces the canonical envelope `{errorCode, errorName, message,
 * statusCode, requestId, parameters, errorInstanceId}`.
 *
 * Histograms emitted (B1-C-40, B1-C-41) use the canonical bucket set
 * mandated by the brief: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
 * 2.5, 5, 10]`.
 */

import { Histogram, register } from "prom-client";

import { pool } from "../db";
import {
  ROOT_SPACE_RID,
  type Rid,
  parseRid,
  unsafeAsRid,
} from "../lib/rid";
import { OntologyError } from "../utils/queryErrors";

// ---------------------------------------------------------------------------
// Public types — `Resource` mirrors the `resources` row shape verbatim so
// downstream services can pass rows around without remapping.
// ---------------------------------------------------------------------------

export interface Resource {
  rid: Rid;
  service: string;
  type: string;
  displayName: string;
  description: string | null;
  documentation: string | null;
  parentFolderRid: Rid | null;
  projectRid: Rid | null;
  spaceRid: Rid;
  trashStatus: "NOT_TRASHED" | "DIRECTLY_TRASHED" | "ANCESTOR_TRASHED";
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  etag: number;
  metadata: Record<string, unknown>;
  legacyUuid: string | null;
}

export interface PageRequest {
  pageSize?: number;
  pageToken?: string | null;
}

export interface Page<T> {
  data: T[];
  nextPageToken: string | null;
}

// ---------------------------------------------------------------------------
// Constants / errors
// ---------------------------------------------------------------------------

/** Maximum batch size per the spec (B1-C-21). */
export const BATCH_GET_MAX = 1000;

/** Default and ceiling for getChildren pageSize (mirrored by B3 once it lands). */
export const PAGE_SIZE_DEFAULT = 100;
export const PAGE_SIZE_MAX = 1000;

function batchTooLarge(actual: number): OntologyError {
  return new OntologyError(
    `Batch of ${actual} rids exceeds the per-call limit of ${BATCH_GET_MAX}.`,
    "BATCH_TOO_LARGE",
    400,
    { limit: BATCH_GET_MAX, actual },
  );
}

function notFound(rid: string): OntologyError {
  return new OntologyError(
    `Resource not found: ${rid}`,
    "RESOURCE_NOT_FOUND",
    404,
    { rid },
  );
}

function invalidRid(input: string, reason: string): OntologyError {
  return new OntologyError(
    `INVALID_RID_FORMAT: ${reason} (input=${JSON.stringify(input)})`,
    "INVALID_RID_FORMAT",
    400,
    { input, reason },
  );
}

// ---------------------------------------------------------------------------
// Metrics — registered lazily / dedup-safely so test isolation does not
// trip prom-client's "metric already registered" guard.
// ---------------------------------------------------------------------------

const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function getOrCreateHistogram(
  name: string,
  help: string,
  labelNames: string[] = [],
): Histogram<string> {
  const existing = register.getSingleMetric(name);
  if (existing && existing instanceof Histogram) return existing as Histogram<string>;
  return new Histogram({ name, help, buckets: HIST_BUCKETS, labelNames });
}

const getResourceLatencySeconds = getOrCreateHistogram(
  "tellus_compass_get_resource_seconds",
  "Latency of compassService.getResource (seconds).",
  ["outcome"],
);

const batchGetSize = getOrCreateHistogram(
  "tellus_compass_batch_get_size",
  "Batch size passed to compassService.getResourcesBatch.",
  [],
);

// ---------------------------------------------------------------------------
// Row → public Resource mapper. The DB returns snake_case columns; we map
// them once here so callers never see the snake-case shape.
// ---------------------------------------------------------------------------

interface ResourceRow {
  rid: string;
  service: string;
  type: string;
  display_name: string;
  description: string | null;
  documentation: string | null;
  parent_folder_rid: string | null;
  project_rid: string | null;
  space_rid: string | null;
  trash_status: "NOT_TRASHED" | "DIRECTLY_TRASHED" | "ANCESTOR_TRASHED";
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  etag: string | number;
  metadata: Record<string, unknown> | null;
  legacy_uuid: string | null;
}

function mapRow(r: ResourceRow): Resource {
  return {
    rid: unsafeAsRid(r.rid),
    service: r.service,
    type: r.type,
    displayName: r.display_name,
    description: r.description,
    documentation: r.documentation,
    parentFolderRid: r.parent_folder_rid ? unsafeAsRid(r.parent_folder_rid) : null,
    projectRid: r.project_rid ? unsafeAsRid(r.project_rid) : null,
    // The DB CHECK ensures space_rid is non-null on every non-space row.
    // For the root space row, space_rid points at itself.
    spaceRid: unsafeAsRid(r.space_rid ?? ROOT_SPACE_RID),
    trashStatus: r.trash_status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    etag: typeof r.etag === "string" ? parseInt(r.etag, 10) : r.etag,
    metadata: r.metadata ?? {},
    legacyUuid: r.legacy_uuid,
  };
}

// All-columns SELECT, factored to keep the four query sites in sync.
const SELECT_COLS = `
  rid, service, type, display_name, description, documentation,
  parent_folder_rid, project_rid, space_rid, trash_status,
  created_by, created_at, updated_by, updated_at,
  etag, metadata, legacy_uuid
`;

// ---------------------------------------------------------------------------
// Public API — B1-C-20 .. B1-C-25
// ---------------------------------------------------------------------------

/**
 * B1-C-20 — fetch a single resource by RID.
 *
 * Throws:
 *   - `INVALID_RID_FORMAT (400)` if the input fails RID grammar.
 *   - `RESOURCE_NOT_FOUND (404)` if the rid is well-formed but absent.
 */
export async function getResource(rid: string): Promise<Resource> {
  // Validate at the trust boundary — the brief mandates fail-loudly.
  try {
    parseRid(rid);
  } catch (e) {
    throw invalidRid(rid, (e as Error).message);
  }
  const start = Date.now();
  let outcome: "hit" | "miss" | "error" = "hit";
  try {
    const result = await pool.query<ResourceRow>(
      `SELECT ${SELECT_COLS} FROM resources WHERE rid = $1`,
      [rid],
    );
    if (result.rows.length === 0) {
      outcome = "miss";
      throw notFound(rid);
    }
    return mapRow(result.rows[0]);
  } catch (e) {
    if (outcome === "hit") outcome = "error";
    throw e;
  } finally {
    getResourceLatencySeconds.observe({ outcome }, (Date.now() - start) / 1000);
  }
}

/**
 * B1-C-21 — fetch up to {@link BATCH_GET_MAX} resources in one round-trip.
 *
 * Returns `Map<Rid, Resource>` keyed by the *exact* RID string passed in. Missing
 * RIDs are simply absent from the map (callers can detect them via `Map.has`).
 *
 * Throws:
 *   - `BATCH_TOO_LARGE (400)` if `rids.length > BATCH_GET_MAX`.
 *   - `INVALID_RID_FORMAT (400)` if any element is not a syntactically valid RID.
 */
export async function getResourcesBatch(rids: readonly string[]): Promise<Map<Rid, Resource>> {
  if (rids.length > BATCH_GET_MAX) {
    throw batchTooLarge(rids.length);
  }
  // Validate every input before querying. Doing this up front means a
  // single bad RID short-circuits without consuming a DB round-trip.
  for (const r of rids) {
    try {
      parseRid(r);
    } catch (e) {
      throw invalidRid(r, (e as Error).message);
    }
  }
  batchGetSize.observe(rids.length);
  if (rids.length === 0) return new Map();

  const result = await pool.query<ResourceRow>(
    `SELECT ${SELECT_COLS} FROM resources WHERE rid = ANY($1::text[])`,
    [rids as string[]],
  );
  const out = new Map<Rid, Resource>();
  for (const row of result.rows) {
    const mapped = mapRow(row);
    out.set(mapped.rid, mapped);
  }
  return out;
}

/**
 * B1-C-22 — resolve a slash-delimited path to a Resource.
 *
 * The path grammar is `('/Root')?/<segment>(/<segment>)*` where each
 * segment is matched against `resources.display_name` under the parent
 * resolved by the previous segment (root space is the implicit start).
 *
 * Examples:
 *   `/Root/<projectName>` → project (the literal `/Root` prefix is optional)
 *   `/<projectName>/<folderName>/<datasetName>` → dataset
 */
export async function getResourceByPath(path: string): Promise<Resource> {
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new OntologyError(
      `Path must be a non-empty string starting with '/': ${JSON.stringify(path)}`,
      "VALIDATION_ERROR",
      400,
      { path },
    );
  }
  const rawSegments = path.split("/").filter((s) => s.length > 0);
  if (rawSegments.length === 0) {
    // `/` resolves to the root space itself.
    return getResource(ROOT_SPACE_RID);
  }
  // Strip an optional leading `Root` (the brief says root space is implicit
  // in path resolution — `/Root/X` ≡ `/X`).
  const segments = rawSegments[0] === "Root" ? rawSegments.slice(1) : rawSegments;
  if (segments.length === 0) return getResource(ROOT_SPACE_RID);

  // Walk segment by segment. The first segment must be a project (its
  // `parent_folder_rid IS NULL`). Subsequent segments live under the prior
  // resource's `rid`.
  let currentRid: Rid | null = null;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    let result;
    if (i === 0) {
      // Top-level: project (parent_folder_rid IS NULL) under the root space.
      result = await pool.query<ResourceRow>(
        `SELECT ${SELECT_COLS}
           FROM resources
          WHERE display_name = $1
            AND parent_folder_rid IS NULL
            AND space_rid = $2
          LIMIT 2`,
        [name, ROOT_SPACE_RID],
      );
    } else {
      result = await pool.query<ResourceRow>(
        `SELECT ${SELECT_COLS}
           FROM resources
          WHERE display_name = $1
            AND parent_folder_rid = $2
          LIMIT 2`,
        [name, currentRid],
      );
    }
    if (result.rows.length === 0) {
      throw notFound(path);
    }
    if (result.rows.length > 1) {
      // Should be unreachable once B2 lands the partial unique index on
      // `(coalesce(parent_folder_rid,'∅'), display_name)`. Until then,
      // fail loudly so we surface duplicates rather than silently picking.
      throw new OntologyError(
        `Path ${JSON.stringify(path)} is ambiguous at segment ${JSON.stringify(name)}: multiple matches.`,
        "VALIDATION_ERROR",
        409,
        { path, segment: name },
      );
    }
    currentRid = unsafeAsRid(result.rows[0].rid);
    if (i === segments.length - 1) {
      return mapRow(result.rows[0]);
    }
  }
  // Unreachable — the loop returns on the last segment.
  throw notFound(path);
}

/**
 * B1-C-23 — paginated children of `parentRid`.
 *
 * Page tokens are opaque base64 of the last `(updated_at, rid)` cursor.
 * (B3 will lift this to the public API; here we keep it internal so the
 * tests can exercise it without the route layer.)
 */
export async function getChildren(
  parentRid: string,
  page: PageRequest = {},
): Promise<Page<Resource>> {
  try {
    parseRid(parentRid);
  } catch (e) {
    throw invalidRid(parentRid, (e as Error).message);
  }
  const pageSize = clampPageSize(page.pageSize);
  const cursor = decodePageToken(page.pageToken);

  const params: unknown[] = [parentRid];
  let cursorPredicate = "";
  if (cursor) {
    cursorPredicate = `AND (updated_at, rid) < ($2::timestamptz, $3::text)`;
    params.push(cursor.updatedAt, cursor.rid);
  }
  // pageSize+1 to detect "more" without a second COUNT query.
  params.push(pageSize + 1);
  const limitParamIdx = params.length;
  const result = await pool.query<ResourceRow>(
    `SELECT ${SELECT_COLS}
       FROM resources
      WHERE parent_folder_rid = $1
        ${cursorPredicate}
      ORDER BY updated_at DESC, rid DESC
      LIMIT $${limitParamIdx}`,
    params,
  );
  const rows = result.rows.slice(0, pageSize).map(mapRow);
  const more = result.rows.length > pageSize;
  const nextPageToken = more
    ? encodePageToken({
        updatedAt: result.rows[pageSize - 1].updated_at,
        rid: result.rows[pageSize - 1].rid,
      })
    : null;
  return { data: rows, nextPageToken };
}

// ---------------------------------------------------------------------------
// Page-token helpers (kept private to this module; B3 will hoist to a shared
// `src/lib/pageToken.ts` once a second consumer appears).
// ---------------------------------------------------------------------------

interface Cursor {
  updatedAt: string;
  rid: string;
}

function clampPageSize(input: number | undefined): number {
  if (input === undefined || input === null) return PAGE_SIZE_DEFAULT;
  if (!Number.isFinite(input) || !Number.isInteger(input) || input < 1) {
    throw new OntologyError(
      `pageSize must be a positive integer (got ${JSON.stringify(input)})`,
      "VALIDATION_ERROR",
      400,
      { pageSize: input },
    );
  }
  return Math.min(input, PAGE_SIZE_MAX);
}

function encodePageToken(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodePageToken(token: string | null | undefined): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Cursor;
    if (
      !parsed ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.rid !== "string"
    ) {
      throw new Error("malformed cursor");
    }
    return parsed;
  } catch {
    throw new OntologyError(
      `Invalid pageToken: ${JSON.stringify(token)}`,
      "INVALID_PAGE_TOKEN",
      400,
      { token },
    );
  }
}

// Re-export the mint helper so callers don't reach into `lib/rid` directly
// for write-path mints (keeps a single import surface for service consumers).
export { mintRid } from "../lib/rid";
