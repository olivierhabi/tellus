// Quiver B4 — working-state service (24h TTL, base36 stateId).
//
// Endpoints implemented (mounted by routes/quiver/workingStates.ts):
//   POST /quiver/api/v1/analyses/:rid/working-states            — createWorkingState
//   PUT  /quiver/api/v1/analyses/:rid/working-states/:stateId   — upsertWorkingState
//   GET  /quiver/api/v1/analyses/:rid/working-states/:stateId   — getWorkingState
//   POST /quiver/api/v1/_admin/purge-working-states             — manual sweeper
//
// Spec: B4 C-07..C-10.

import { randomBytes } from "node:crypto";
import { withTransaction, query } from "../../db";
import {
  ActorContext,
  assertAnalysisEditable,
  assertAnalysisReadable,
} from "./analysisService";
import {
  analysisNotFound,
  invalidAnalysisRequest,
  workingStateNotFound,
} from "./errors";
import { emitQuiverAudit } from "./audit";
import {
  workingStateSizeBytes,
  workingStateTtlPurgesTotal,
} from "./metrics";

const STATE_ID_LENGTH = 10; // B4 C-07 — base36 [a-z0-9]{10}
const STATE_ID_RE = /^[a-z0-9]{10}$/;

export interface CreateWorkingStateRequest {
  fromVersion?: number | null;
}

export interface WorkingStateInfo {
  rid: string;
  stateId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  fromVersion: number | null;
}

interface AnalysisRow {
  rid: string;
  cards: unknown;
  canvases: unknown;
  parameters: unknown;
  notebook_metadata: unknown;
  is_deleted: boolean;
}

interface WorkingStateRow {
  rid: string;
  state_id: string;
  user_subject: string;
  document_inline: unknown | null;
  from_version: string | number | null;
  branch_rid: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

function rowToInfo(r: WorkingStateRow): WorkingStateInfo {
  return {
    rid: r.rid,
    stateId: r.state_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fromVersion:
      r.from_version === null
        ? null
        : typeof r.from_version === "string"
          ? Number(r.from_version)
          : r.from_version,
  };
}

/** B4 C-07 — generate base36 [a-z0-9]{10} state ID. */
export function generateStateId(): string {
  // 10 chars × log2(36) ≈ 51.7 bits; sample 8 random bytes (64 bits) and
  // re-encode. Crypto-strong randomness; collision rate is negligible at
  // any reasonable lifetime, but we still retry on PK conflict on insert.
  const buf = randomBytes(8);
  // Convert to base36 — pad/truncate to STATE_ID_LENGTH chars.
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = n.toString(36);
  if (s.length < STATE_ID_LENGTH) s = s.padStart(STATE_ID_LENGTH, "0");
  if (s.length > STATE_ID_LENGTH) s = s.slice(0, STATE_ID_LENGTH);
  return s;
}

/** B4 C-08 — POST /analyses/:rid/working-states. */
export async function createWorkingState(
  actor: ActorContext,
  rid: string,
  raw: unknown,
): Promise<WorkingStateInfo> {
  const req = (raw ?? {}) as CreateWorkingStateRequest;
  if (
    req.fromVersion !== undefined &&
    req.fromVersion !== null &&
    (!Number.isInteger(req.fromVersion) || req.fromVersion < 1)
  ) {
    throw invalidAnalysisRequest({ reason: "fromVersion must be a positive integer" });
  }

  // Folder authorization — editor on the analysis's parent folder (the
  // working state snapshots the full document).
  await assertAnalysisEditable(actor, rid);

  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT rid, cards, canvases, parameters, notebook_metadata, is_deleted
         FROM quiver_analysis WHERE rid = $1`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const a = sel.rows[0] as AnalysisRow;
    if (a.is_deleted) throw analysisNotFound({ rid });

    let payload: unknown;
    if (req.fromVersion) {
      const v = await client.query(
        `SELECT document_inline FROM quiver_analysis_version
          WHERE rid = $1 AND version = $2 AND branch_rid = $3 LIMIT 1`,
        [rid, req.fromVersion, actor.branch],
      );
      if (v.rowCount === 0) {
        throw invalidAnalysisRequest({
          reason: `version ${req.fromVersion} not found on branch ${actor.branch}`,
        });
      }
      payload = v.rows[0].document_inline;
    } else {
      payload = {
        cards: a.cards,
        canvases: a.canvases,
        parameters: a.parameters,
        notebookMetadata: a.notebook_metadata,
      };
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    workingStateSizeBytes.observe(sizeBytes);

    // Retry on PK collision (B4 C-07).
    for (let attempt = 0; attempt < 5; attempt++) {
      const stateId = generateStateId();
      try {
        const ins = await client.query(
          `INSERT INTO quiver_working_state (
             rid, state_id, user_subject, document_inline, from_version,
             branch_rid, created_at, updated_at, expires_at
           ) VALUES (
             $1, $2, $3, $4::jsonb, $5, $6,
             now(), now(), now() + INTERVAL '24 hours'
           )
           RETURNING *`,
          [
            rid,
            stateId,
            actor.userSubject,
            JSON.stringify(payload),
            req.fromVersion ?? null,
            actor.branch,
          ],
        );
        return rowToInfo(ins.rows[0] as WorkingStateRow);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/duplicate key|unique constraint/i.test(msg)) throw e;
      }
    }
    throw invalidAnalysisRequest({ reason: "could not allocate working-state ID after 5 attempts" });
  });
}

/** PUT /analyses/:rid/working-states/:stateId — upsert document payload. */
export async function upsertWorkingStateDocument(
  actor: ActorContext,
  rid: string,
  stateId: string,
  document: unknown,
): Promise<WorkingStateInfo> {
  if (!STATE_ID_RE.test(stateId)) {
    throw invalidAnalysisRequest({ reason: "stateId must match [a-z0-9]{10}" });
  }
  const sizeBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  workingStateSizeBytes.observe(sizeBytes);

  // Folder authorization — editor on the parent folder.
  await assertAnalysisEditable(actor, rid);

  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT rid, is_deleted FROM quiver_analysis WHERE rid = $1`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    if ((sel.rows[0] as AnalysisRow).is_deleted) throw analysisNotFound({ rid });

    const upsert = await client.query(
      `INSERT INTO quiver_working_state (
         rid, state_id, user_subject, document_inline, branch_rid,
         created_at, updated_at, expires_at
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5,
         now(), now(), now() + INTERVAL '24 hours'
       )
       ON CONFLICT (rid, state_id) DO UPDATE
         SET document_inline = EXCLUDED.document_inline,
             updated_at = now(),
             expires_at = now() + INTERVAL '24 hours'
       RETURNING *`,
      [rid, stateId, actor.userSubject, JSON.stringify(document), actor.branch],
    );
    return rowToInfo(upsert.rows[0] as WorkingStateRow);
  });
}

/** B4 C-09 — GET /analyses/:rid/working-states/:stateId. */
export async function getWorkingState(
  actor: ActorContext,
  rid: string,
  stateId: string,
): Promise<{ info: WorkingStateInfo; document: unknown }> {
  if (!STATE_ID_RE.test(stateId)) throw workingStateNotFound({ rid, stateId });
  // Folder authorization — viewer+ (the state row carries the document).
  await assertAnalysisReadable(actor, rid);
  const r = await query(
    `SELECT * FROM quiver_working_state
      WHERE rid = $1 AND state_id = $2 AND branch_rid = $3 AND expires_at > now() LIMIT 1`,
    [rid, stateId, actor.branch],
  );
  if (r.rowCount === 0) throw workingStateNotFound({ rid, stateId });
  const row = r.rows[0] as WorkingStateRow;
  return { info: rowToInfo(row), document: row.document_inline };
}

/** B4 C-10 — purge expired working-state rows. Returns purged count. */
export async function purgeExpiredWorkingStates(): Promise<number> {
  const r = await query(
    `SELECT quiver_purge_expired_working_states() AS n`,
  );
  const n = Number(r.rows[0]?.n ?? 0);
  if (n > 0) {
    workingStateTtlPurgesTotal.inc(n);
    await emitQuiverAudit({
      actorSubject: "system:tellus-quiver-sweeper",
      action: "QUIVER_ANALYSIS_DELETED", // re-using the closest existing action
      rid: "ri.tellus-quiver.main.sweeper.working-state",
      result: "SUCCESS",
      details: { purgedCount: n, kind: "working_state_ttl" },
    });
  }
  return n;
}
