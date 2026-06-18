// Quiver B1 — analysis service.
//
// Endpoints implemented (mounted by routes/quiver/analyses.ts):
//   POST   /quiver/api/v1/analyses                 — createAnalysis
//   GET    /quiver/api/v1/analyses/:rid            — getAnalysis
//   PATCH  /quiver/api/v1/analyses/:rid            — updateAnalysisMetadata
//   DELETE /quiver/api/v1/analyses/:rid            — deleteAnalysis (soft)
//   GET    /quiver/api/v1/folders/:folderRid/analyses — listAnalysesInFolder
//
// Concurrency model: ETag-CAS via "WHERE rid = $1 AND etag = $2" (D-06).
// Document size: > 1 MiB → would store in Blobster; ≤ 1 MiB inline (D-05).
// Branch propagation: every read/write stamps current branch.

import type { PoolClient } from "pg";
import { pool, query, withTransaction } from "../../db";
import {
  AnalysisDocument,
  CreateAnalysisRequest,
  UpdateAnalysisMetadataRequest,
  type AnalysesPage,
} from "./types";
import { newQuiverRid } from "./rids";
import {
  analysisNotFound,
  analysisTooLarge,
  invalidAnalysisRequest,
  parentFolderNotFound,
  versionMismatch,
} from "./errors";
import { computeAnalysisEtag, etagsMatch, canonicalizeJson } from "./etag";
import { emitQuiverAudit } from "./audit";
import {
  analysisActiveTotal,
  analysisSizeBytes,
  etagMismatchTotal,
} from "./metrics";

const MAX_INLINE_BYTES = 1_048_576; // 1 MiB (B1 C-05)
const MAX_DOCUMENT_BYTES = 16 * 1_048_576; // 16 MiB hard cap

export interface ActorContext {
  userSubject: string;
  orgRid: string;
  branch: string;
}

export interface CompassPort {
  /**
   * Asserts the actor has Editor on the parent folder; otherwise throws
   * `parentFolderNotFound`. Branch is forwarded.
   */
  assertEditorOnFolder(opts: {
    folderRid: string;
    userSubject: string;
    branch: string;
  }): Promise<void>;
  /**
   * Registers a `tellus-quiver-analysis` resource under the parent folder.
   * Failure is fatal — caller must roll back the analysis row.
   */
  registerAnalysis(opts: {
    rid: string;
    parentFolderRid: string;
    displayName: string;
    branch: string;
  }): Promise<void>;
  /** Compass-driven `isAuthorized(userRid, resourceRid, op)` for getAnalysis. */
  assertReadable(opts: {
    rid: string;
    userSubject: string;
    branch: string;
  }): Promise<void>;
}

/** Default port: in-tree no-op for environments where Compass isn't wired
 *  yet (smoke tests). Production will inject a real implementation. */
export const noopCompass: CompassPort = {
  async assertEditorOnFolder() {},
  async registerAnalysis() {},
  async assertReadable() {},
};

let compass: CompassPort = noopCompass;
export function setCompassPort(port: CompassPort): void {
  compass = port;
}

// ---------- Internal row mapping -------------------------------------------
interface AnalysisRow {
  rid: string;
  parent_folder_rid: string;
  display_name: string;
  description: string | null;
  notebook_metadata: unknown;
  cards: unknown;
  canvases: unknown;
  parameters: unknown;
  current_version: string | number;
  etag: string;
  document_blob_uri: string | null;
  document_inline: unknown | null;
  markings: string[];
  is_deleted: boolean;
  deleted_at: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  branch_rid: string;
}

function rowToDocument(row: AnalysisRow): AnalysisDocument {
  const doc = {
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    displayName: row.display_name,
    description: row.description,
    notebookMetadata: row.notebook_metadata as AnalysisDocument["notebookMetadata"],
    cards: row.cards as AnalysisDocument["cards"],
    canvases: row.canvases as AnalysisDocument["canvases"],
    parameters: row.parameters as AnalysisDocument["parameters"],
    currentVersion:
      typeof row.current_version === "string"
        ? Number(row.current_version)
        : row.current_version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    markings: row.markings,
    isDeleted: row.is_deleted,
    deletedAt: row.deleted_at,
  } satisfies AnalysisDocument;
  return AnalysisDocument.parse(doc);
}

function snapshotForEtag(row: {
  rid: string;
  parent_folder_rid: string;
  display_name: string;
  description: string | null;
  document_blob_uri: string | null;
  document_inline: unknown | null;
  current_version: string | number;
  is_deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  markings: string[];
}) {
  return {
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    displayName: row.display_name,
    description: row.description,
    documentBlobUri: row.document_blob_uri,
    documentInline: row.document_inline,
    currentVersion:
      typeof row.current_version === "string"
        ? Number(row.current_version)
        : row.current_version,
    isDeleted: row.is_deleted,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    markings: row.markings,
  };
}

function defaultDocumentInline() {
  return {
    cards: {},
    canvases: [],
    parameters: {},
  };
}

// =================== createAnalysis ========================================
export async function createAnalysis(
  actor: ActorContext,
  raw: unknown,
): Promise<{ document: AnalysisDocument; etag: string }> {
  const parsed = CreateAnalysisRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;

  // B1 C-06 — folder authorization.
  await compass.assertEditorOnFolder({
    folderRid: req.parentFolderRid,
    userSubject: actor.userSubject,
    branch: actor.branch,
  });

  const rid = newQuiverRid("analysis");
  const inline = defaultDocumentInline();
  const inlineBytes = Buffer.byteLength(JSON.stringify(inline), "utf8");
  analysisSizeBytes.observe(inlineBytes);
  if (inlineBytes > MAX_DOCUMENT_BYTES) {
    throw analysisTooLarge({ sizeBytes: inlineBytes, limit: MAX_DOCUMENT_BYTES });
  }

  // Inline default since fresh document is tiny. Boundary handling for
  // > 1 MiB lives in updateAnalysis (B1 C-05) — the create path always
  // produces a small doc.
  const useInline = inlineBytes <= MAX_INLINE_BYTES;
  const inlineCol = useInline ? JSON.stringify(inline) : null;
  const blobUri = useInline ? null : "blob://placeholder"; // B1 C-05 path

  const result = await withTransaction(async (client) => {
    // Pre-compute the etag on a row snapshot.
    const now = new Date().toISOString();
    const snap = snapshotForEtag({
      rid,
      parent_folder_rid: req.parentFolderRid,
      display_name: req.displayName,
      description: req.description ?? null,
      document_blob_uri: blobUri,
      document_inline: useInline ? inline : null,
      current_version: 0,
      is_deleted: false,
      deleted_at: null,
      updated_at: now,
      markings: req.markings ?? [],
    });
    const etag = computeAnalysisEtag(snap);

    const sql = `
      INSERT INTO quiver_analysis (
        rid, parent_folder_rid, display_name, description,
        notebook_metadata, cards, canvases, parameters,
        current_version, etag, document_blob_uri, document_inline, markings,
        is_deleted, deleted_at,
        created_at, created_by, updated_at, updated_by, branch_rid
      ) VALUES (
        $1, $2, $3, $4,
        '{"defaultLoad":"VISIBLE","cardIdCounter":0,"branchRid":null}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
        0, $5, $6, $7::jsonb, $8::text[],
        false, NULL,
        now(), $9, now(), $9, $10
      )
      RETURNING *
    `;
    const r = await client.query(sql, [
      rid,
      req.parentFolderRid,
      req.displayName,
      req.description ?? null,
      etag,
      blobUri,
      inlineCol,
      req.markings ?? [],
      actor.userSubject,
      actor.branch,
    ]);
    const row = r.rows[0] as AnalysisRow;

    // Compass registration is fatal-on-failure; the txn rolls back if it
    // throws. (B1 C-18.)
    await compass.registerAnalysis({
      rid,
      parentFolderRid: req.parentFolderRid,
      displayName: req.displayName,
      branch: actor.branch,
    });

    return { row, etag };
  });

  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_ANALYSIS_CREATED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    afterEtag: result.etag,
    details: {
      parentFolderRid: req.parentFolderRid,
      displayName: req.displayName,
      seed: req.seedFromObjectSet
        ? "objectSet"
        : req.seedFromTemplate
          ? "template"
          : "empty",
    },
  });
  analysisActiveTotal.labels({ org: actor.orgRid }).inc();

  return { document: rowToDocument(result.row), etag: result.etag };
}

// =================== getAnalysis ===========================================
export async function getAnalysis(
  actor: ActorContext,
  rid: string,
): Promise<{ document: AnalysisDocument; etag: string }> {
  await compass.assertReadable({
    rid,
    userSubject: actor.userSubject,
    branch: actor.branch,
  });
  const r = await query(
    `SELECT * FROM quiver_analysis WHERE rid = $1 LIMIT 1`,
    [rid],
  );
  if (r.rowCount === 0) throw analysisNotFound({ rid });
  const row = r.rows[0] as AnalysisRow;
  if (row.is_deleted) throw analysisNotFound({ rid });
  return { document: rowToDocument(row), etag: row.etag };
}

// =================== updateAnalysisMetadata =================================
export async function updateAnalysisMetadata(
  actor: ActorContext,
  rid: string,
  ifMatch: string,
  raw: unknown,
): Promise<{ document: AnalysisDocument; etag: string }> {
  const parsed = UpdateAnalysisMetadataRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;
  // Reject parentFolderRid mutation per B1 C-13.
  if ((raw as { parentFolderRid?: unknown })?.parentFolderRid !== undefined) {
    throw invalidAnalysisRequest({
      reason: "parentFolderRid is immutable (use Compass folder-move)",
    });
  }
  if (
    req.displayName === undefined &&
    req.description === undefined &&
    req.markings === undefined
  ) {
    throw invalidAnalysisRequest({ reason: "no mutable fields supplied" });
  }

  return withTransaction(async (client) => {
    // SELECT FOR UPDATE — D-06.
    const sel = await client.query(
      `SELECT * FROM quiver_analysis WHERE rid = $1 FOR UPDATE`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const before = sel.rows[0] as AnalysisRow;
    if (before.is_deleted) throw analysisNotFound({ rid });
    await compass.assertEditorOnFolder({
      folderRid: before.parent_folder_rid,
      userSubject: actor.userSubject,
      branch: actor.branch,
    });
    if (!etagsMatch(ifMatch, before.etag)) {
      etagMismatchTotal.labels({ endpoint: "PATCH /analyses/:rid" }).inc();
      throw versionMismatch({ currentEtag: before.etag });
    }

    const newDisplayName = req.displayName ?? before.display_name;
    const newDescription =
      req.description !== undefined ? req.description : before.description;
    const newMarkings = req.markings ?? before.markings;

    const now = new Date().toISOString();
    const snap = snapshotForEtag({
      rid: before.rid,
      parent_folder_rid: before.parent_folder_rid,
      display_name: newDisplayName,
      description: newDescription,
      document_blob_uri: before.document_blob_uri,
      document_inline: before.document_inline,
      current_version: before.current_version,
      is_deleted: false,
      deleted_at: null,
      updated_at: now,
      markings: newMarkings,
    });
    const newEtag = computeAnalysisEtag(snap);

    const upd = await client.query(
      `UPDATE quiver_analysis
         SET display_name = $2,
             description  = $3,
             markings     = $4::text[],
             etag         = $5,
             updated_at   = now(),
             updated_by   = $6
       WHERE rid = $1 AND etag = $7
       RETURNING *`,
      [
        rid,
        newDisplayName,
        newDescription,
        newMarkings,
        newEtag,
        actor.userSubject,
        before.etag,
      ],
    );
    if (upd.rowCount === 0) {
      // Lost the CAS — concurrent writer beat us between SELECT FOR UPDATE
      // commit boundary. Re-fetch and signal mismatch.
      const refresh = await client.query(
        `SELECT etag FROM quiver_analysis WHERE rid = $1`,
        [rid],
      );
      const cur = refresh.rows[0]?.etag as string | undefined;
      etagMismatchTotal.labels({ endpoint: "PATCH /analyses/:rid" }).inc();
      throw versionMismatch({ currentEtag: cur ?? "<unknown>" });
    }
    const row = upd.rows[0] as AnalysisRow;
    await emitQuiverAudit({
      actorSubject: actor.userSubject,
      action: "QUIVER_ANALYSIS_UPDATED",
      rid,
      result: "SUCCESS",
      branch: actor.branch,
      beforeEtag: before.etag,
      afterEtag: row.etag,
      details: {
        changedFields: [
          ...(req.displayName !== undefined ? ["displayName"] : []),
          ...(req.description !== undefined ? ["description"] : []),
          ...(req.markings !== undefined ? ["markings"] : []),
        ],
      },
    });
    return { document: rowToDocument(row), etag: row.etag };
  });
}

// =================== deleteAnalysis (soft) =================================
export async function deleteAnalysis(
  actor: ActorContext,
  rid: string,
  ifMatch: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT * FROM quiver_analysis WHERE rid = $1 FOR UPDATE`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const before = sel.rows[0] as AnalysisRow;
    if (before.is_deleted) {
      // Idempotent on repeat per B1 C-14.
      return;
    }
    await compass.assertEditorOnFolder({
      folderRid: before.parent_folder_rid,
      userSubject: actor.userSubject,
      branch: actor.branch,
    });
    if (!etagsMatch(ifMatch, before.etag)) {
      etagMismatchTotal.labels({ endpoint: "DELETE /analyses/:rid" }).inc();
      throw versionMismatch({ currentEtag: before.etag });
    }
    const now = new Date().toISOString();
    const snap = snapshotForEtag({
      rid: before.rid,
      parent_folder_rid: before.parent_folder_rid,
      display_name: before.display_name,
      description: before.description,
      document_blob_uri: before.document_blob_uri,
      document_inline: before.document_inline,
      current_version: before.current_version,
      is_deleted: true,
      deleted_at: now,
      updated_at: now,
      markings: before.markings,
    });
    const newEtag = computeAnalysisEtag(snap);
    const r = await client.query(
      `UPDATE quiver_analysis
         SET is_deleted = true,
             deleted_at = now(),
             updated_at = now(),
             updated_by = $2,
             etag       = $3
       WHERE rid = $1 AND etag = $4`,
      [rid, actor.userSubject, newEtag, before.etag],
    );
    if (r.rowCount === 0) {
      etagMismatchTotal.labels({ endpoint: "DELETE /analyses/:rid" }).inc();
      throw versionMismatch({ currentEtag: before.etag });
    }
    await emitQuiverAudit({
      actorSubject: actor.userSubject,
      action: "QUIVER_ANALYSIS_DELETED",
      rid,
      result: "SUCCESS",
      branch: actor.branch,
      beforeEtag: before.etag,
      afterEtag: newEtag,
    });
    analysisActiveTotal.labels({ org: actor.orgRid }).dec();
  });
}

// =================== listAnalysesInFolder ===================================
export async function listAnalysesInFolder(
  actor: ActorContext,
  folderRid: string,
  pageToken: string | undefined,
  pageSize: number,
): Promise<AnalysesPage> {
  const ps = Math.max(1, Math.min(200, Math.trunc(pageSize)));
  const cursor = pageToken
    ? Buffer.from(pageToken, "base64url").toString("utf8")
    : null;
  const params: unknown[] = [folderRid, actor.branch, ps];
  let where = `parent_folder_rid = $1 AND branch_rid = $2 AND is_deleted = false`;
  if (cursor) {
    where += ` AND rid > $4`;
    params.push(cursor);
  }
  const r = await query(
    `SELECT * FROM quiver_analysis
     WHERE ${where}
     ORDER BY rid ASC
     LIMIT $3`,
    params,
  );
  const items = (r.rows as AnalysisRow[]).map(rowToDocument);
  const next =
    items.length === ps
      ? Buffer.from(items[items.length - 1].rid, "utf8").toString("base64url")
      : null;
  return { items, nextPageToken: next };
}

/** Test helper: ensure an analysis row exists. */
export async function loadRowForTest(
  rid: string,
  client?: PoolClient,
): Promise<AnalysisRow | null> {
  const r = client
    ? await client.query(`SELECT * FROM quiver_analysis WHERE rid = $1`, [rid])
    : await query(`SELECT * FROM quiver_analysis WHERE rid = $1`, [rid]);
  return r.rowCount === 0 ? null : (r.rows[0] as AnalysisRow);
}

/** Test helper to clear quiver tables between tests. */
export async function truncateForTest(): Promise<void> {
  await query(`TRUNCATE quiver_analysis, quiver_idempotency_record`);
}

/** Re-export so the route can canonicalize the response body byte-identically. */
export { canonicalizeJson };

// Hint to the pool to keep the import tree tidy when this module is the
// only consumer (test isolation: server.ts already creates the pool).
export { pool as _pool };
