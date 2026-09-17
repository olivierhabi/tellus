// Quiver B4 — version service (named saves + history).
//
// Endpoints implemented (mounted by routes/quiver/versions.ts):
//   POST  /quiver/api/v1/analyses/:rid/versions                 — saveVersion
//   GET   /quiver/api/v1/analyses/:rid/versions                 — listVersions
//   GET   /quiver/api/v1/analyses/:rid/versions/:version        — getVersion
//   POST  /quiver/api/v1/analyses/:rid/versions/:version:revert — revertToVersion
//
// Concurrency: ETag-CAS via "WHERE rid AND etag = $stale" (D-06).
// Versions are monotonic per (rid, branch_rid).

import { withTransaction, query } from "../../db";
import {
  ActorContext,
  assertAnalysisEditable,
  assertAnalysisReadable,
} from "./analysisService";
import {
  analysisNotFound,
  invalidAnalysisRequest,
  versionMismatch,
  versionNotFound,
} from "./errors";
import { etagsMatch, computeAnalysisEtag } from "./etag";
import { emitQuiverAudit } from "./audit";
import {
  saveVersionSeconds,
  revertSeconds,
  versionSavedTotal,
  revertedTotal,
} from "./metrics";

export interface SaveVersionRequest {
  message?: string | null;
  named?: boolean;
}

export interface VersionInfo {
  rid: string;
  version: number;
  parentVersion: number | null;
  savedBy: string;
  savedAt: string;
  message: string | null;
  isNamedSave: boolean;
  cardsCount: number;
  branch: string;
}

export interface VersionsPage {
  items: VersionInfo[];
  nextPageToken: string | null;
}

interface AnalysisRow {
  rid: string;
  parent_folder_rid: string;
  display_name: string;
  description: string | null;
  document_inline: unknown | null;
  document_blob_uri: string | null;
  current_version: string | number;
  etag: string;
  is_deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  markings: string[];
  branch_rid: string;
  cards: unknown;
  canvases: unknown;
  parameters: unknown;
  notebook_metadata: unknown;
}

interface VersionRow {
  rid: string;
  version: string | number;
  document_inline: unknown | null;
  document_blob_uri: string | null;
  parent_version: string | number | null;
  saved_by: string;
  saved_at: string;
  message: string | null;
  is_named_save: boolean;
  branch_rid: string;
  cards_count: number;
}

function rowToInfo(r: VersionRow): VersionInfo {
  const v = typeof r.version === "string" ? Number(r.version) : r.version;
  return {
    rid: r.rid,
    version: v,
    parentVersion:
      r.parent_version === null
        ? null
        : typeof r.parent_version === "string"
          ? Number(r.parent_version)
          : r.parent_version,
    savedBy: r.saved_by,
    savedAt: r.saved_at,
    message: r.message,
    isNamedSave: r.is_named_save,
    cardsCount: r.cards_count,
    branch: r.branch_rid,
  };
}

/** B4 C-01 — POST /analyses/:rid/versions. */
export async function saveVersion(
  actor: ActorContext,
  rid: string,
  ifMatch: string,
  raw: unknown,
): Promise<VersionInfo> {
  const t0 = process.hrtime.bigint();
  const req = (raw ?? {}) as SaveVersionRequest;
  const named = req.named === true;
  if (named && (!req.message || !req.message.trim())) {
    throw invalidAnalysisRequest({
      reason: "named save requires a non-empty 'message' (B4 C-02)",
    });
  }
  if (req.message && req.message.length > 2000) {
    throw invalidAnalysisRequest({
      reason: "message length must be <= 2000 chars",
    });
  }

  // Folder authorization — editor on the analysis's parent folder (a save
  // snapshots the whole document; viewer+ is not enough).
  await assertAnalysisEditable(actor, rid);

  const result = await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT * FROM quiver_analysis WHERE rid = $1 FOR UPDATE`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const a = sel.rows[0] as AnalysisRow;
    if (a.is_deleted) throw analysisNotFound({ rid });
    if (!etagsMatch(ifMatch, a.etag)) {
      throw versionMismatch({ currentEtag: a.etag });
    }
    // B4 C-01: monotonic per (rid, branch). Read the max under FOR UPDATE
    // implicitly (PK lookup on parent row already serializes saves).
    const maxQ = await client.query(
      `SELECT COALESCE(MAX(version), 0)::bigint AS m FROM quiver_analysis_version
        WHERE rid = $1 AND branch_rid = $2`,
      [rid, actor.branch],
    );
    const prev = Number(maxQ.rows[0].m);
    const nextVersion = prev + 1;

    const docPayload = {
      cards: a.cards,
      canvases: a.canvases,
      parameters: a.parameters,
      notebookMetadata: a.notebook_metadata,
    };
    const cardsCount = Object.keys(
      (a.cards ?? {}) as Record<string, unknown>,
    ).length;

    const ins = await client.query(
      `INSERT INTO quiver_analysis_version (
         rid, version, document_inline, document_blob_uri, parent_version,
         saved_by, saved_at, message, is_named_save, branch_rid, cards_count
       )
       VALUES ($1, $2, $3::jsonb, NULL, $4, $5, now(), $6, $7, $8, $9)
       RETURNING *`,
      [
        rid,
        nextVersion,
        JSON.stringify(docPayload),
        prev > 0 ? prev : null,
        actor.userSubject,
        req.message ?? null,
        named,
        actor.branch,
        cardsCount,
      ],
    );

    // Bump current_version on the parent so subsequent saveVersion reads see
    // the latest. Etag updates only on metadata changes (PATCH path); a save
    // does not invalidate the analysis etag.
    await client.query(
      `UPDATE quiver_analysis SET current_version = $2, updated_at = now() WHERE rid = $1`,
      [rid, nextVersion],
    );
    return ins.rows[0] as VersionRow;
  });

  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_ANALYSIS_VERSION_SAVED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    details: {
      version: Number(result.version),
      named: result.is_named_save,
      message: result.message,
    },
  });
  saveVersionSeconds
    .labels({ named: String(result.is_named_save) })
    .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  versionSavedTotal.labels({ named: String(result.is_named_save) }).inc();
  return rowToInfo(result);
}

/** B4 C-04 — GET /analyses/:rid/versions. Paginated DESC by version. */
export async function listVersions(
  actor: ActorContext,
  rid: string,
  pageToken: string | undefined,
  pageSize: number,
  namedOnly: boolean,
): Promise<VersionsPage> {
  const ps = Math.max(1, Math.min(200, Math.trunc(pageSize)));
  const cursor = pageToken
    ? Number(Buffer.from(pageToken, "base64url").toString("utf8"))
    : null;

  // Folder authorization — viewer+ (version rows carry full documents).
  await assertAnalysisReadable(actor, rid);

  // Existence + branch scope check.
  const head = await query(
    `SELECT rid FROM quiver_analysis WHERE rid = $1 AND is_deleted = false`,
    [rid],
  );
  if (head.rowCount === 0) throw analysisNotFound({ rid });

  const params: unknown[] = [rid, actor.branch, ps];
  let where = `rid = $1 AND branch_rid = $2`;
  if (namedOnly) where += ` AND is_named_save = true`;
  if (cursor !== null && Number.isFinite(cursor)) {
    where += ` AND version < $4`;
    params.push(cursor);
  }
  const r = await query(
    `SELECT * FROM quiver_analysis_version WHERE ${where}
     ORDER BY version DESC LIMIT $3`,
    params,
  );
  const items = (r.rows as VersionRow[]).map(rowToInfo);
  const next =
    items.length === ps
      ? Buffer.from(String(items[items.length - 1].version), "utf8").toString(
          "base64url",
        )
      : null;
  return { items, nextPageToken: next };
}

/** B4 C-05 — GET /analyses/:rid/versions/:version. */
export async function getVersion(
  actor: ActorContext,
  rid: string,
  version: number,
): Promise<{ info: VersionInfo; document: unknown }> {
  // Folder authorization — viewer+ (the version row carries the document).
  await assertAnalysisReadable(actor, rid);
  const r = await query(
    `SELECT * FROM quiver_analysis_version
      WHERE rid = $1 AND version = $2 AND branch_rid = $3 LIMIT 1`,
    [rid, version, actor.branch],
  );
  if (r.rowCount === 0) throw versionNotFound({ rid, version });
  const row = r.rows[0] as VersionRow;
  return { info: rowToInfo(row), document: row.document_inline };
}

/** B4 C-03 — POST /analyses/:rid/versions/:version:revert. */
export async function revertToVersion(
  actor: ActorContext,
  rid: string,
  version: number,
  ifMatch: string,
): Promise<{ rid: string; etag: string; revertedTo: number; newVersion: number }> {
  const t0 = process.hrtime.bigint();
  // Folder authorization — editor on the parent folder (revert mutates).
  await assertAnalysisEditable(actor, rid);
  const r = await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT * FROM quiver_analysis WHERE rid = $1 FOR UPDATE`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const a = sel.rows[0] as AnalysisRow;
    if (a.is_deleted) throw analysisNotFound({ rid });
    if (!etagsMatch(ifMatch, a.etag)) {
      throw versionMismatch({ currentEtag: a.etag });
    }
    const v = await client.query(
      `SELECT * FROM quiver_analysis_version
        WHERE rid = $1 AND version = $2 AND branch_rid = $3 LIMIT 1`,
      [rid, version, actor.branch],
    );
    if (v.rowCount === 0) throw versionNotFound({ rid, version });
    const ver = v.rows[0] as VersionRow;
    const restored =
      (ver.document_inline as {
        cards?: unknown;
        canvases?: unknown;
        parameters?: unknown;
        notebookMetadata?: unknown;
      }) ?? {};

    const newSnap = {
      rid: a.rid,
      parentFolderRid: a.parent_folder_rid,
      displayName: a.display_name,
      description: a.description,
      documentBlobUri: a.document_blob_uri,
      documentInline: restored,
      currentVersion:
        (typeof a.current_version === "string"
          ? Number(a.current_version)
          : a.current_version) + 1,
      isDeleted: false,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      markings: a.markings,
    };
    const newEtag = computeAnalysisEtag(newSnap);
    const newVersion = newSnap.currentVersion;

    // Snapshot first — every revert produces a new immutable version row.
    await client.query(
      `INSERT INTO quiver_analysis_version (
         rid, version, document_inline, parent_version, saved_by, saved_at,
         message, is_named_save, branch_rid, cards_count
       ) VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6, false, $7, $8)`,
      [
        rid,
        newVersion,
        JSON.stringify(restored),
        version,
        actor.userSubject,
        `revert to v${version}`,
        actor.branch,
        Object.keys((restored.cards ?? {}) as Record<string, unknown>).length,
      ],
    );

    const upd = await client.query(
      `UPDATE quiver_analysis
         SET cards = $2::jsonb,
             canvases = $3::jsonb,
             parameters = $4::jsonb,
             notebook_metadata = $5::jsonb,
             current_version = $6,
             etag = $7,
             updated_at = now(),
             updated_by = $8
       WHERE rid = $1 AND etag = $9
       RETURNING *`,
      [
        rid,
        JSON.stringify(restored.cards ?? {}),
        JSON.stringify(restored.canvases ?? []),
        JSON.stringify(restored.parameters ?? {}),
        JSON.stringify(restored.notebookMetadata ?? {}),
        newVersion,
        newEtag,
        actor.userSubject,
        a.etag,
      ],
    );
    if (upd.rowCount === 0) {
      throw versionMismatch({ currentEtag: a.etag });
    }
    return {
      rid: a.rid,
      etag: newEtag,
      revertedTo: version,
      newVersion,
    };
  });

  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_ANALYSIS_REVERTED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    afterEtag: r.etag,
    details: { revertedToVersion: version, newVersion: r.newVersion },
  });
  revertSeconds.observe(Number(process.hrtime.bigint() - t0) / 1e9);
  revertedTotal.inc();
  return r;
}
