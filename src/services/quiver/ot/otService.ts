/**
 * B3 — Operational Transform service.
 *
 * `submitInstructions(rid, baseVersion, idempotencyKey, ops, actor)` is the
 * single mutating entry point. Per spec §B3:
 *   - SELECT FOR UPDATE on quiver_analysis to serialize concurrent submitters.
 *   - Read server-tail since baseVersion.
 *   - Transform local ops against the tail.
 *   - Apply transformed ops; write log rows; advance current_version + etag.
 *   - Emit `appliedInstruction` events; emit `serverRebase` events for any
 *     dropped ops (B3 C-05).
 *
 * Tombstones for replay are reconstructed in-memory by walking the tail and
 * the new transformed ops in order.
 *
 * Per D-43: canvases live as a Record<id, Canvas> inside the OT engine for
 * index locality; serialization back to the row preserves insertion order.
 */

import { withTransaction } from "../../../db";
import { computeEtagOf } from "../etag";
import {
  malformedInstruction,
  otBaseVersionTooOld,
  versionMismatch,
  analysisNotFound,
} from "../errors";
import { instructionListSchema, type Instruction } from "./instructions";
import { applyInstruction } from "./apply";
import { transformLocalAgainstRemote } from "./transform";
import { emitCollab } from "./eventBus";
import { emitQuiverAudit } from "../audit";
import {
  otConflictsTotal,
  otDuplicateOpIdTotal,
  otInstructionApplySeconds,
  otSubmitSeconds,
  otTransformSeconds,
} from "../metrics";

export interface SubmitInstructionsActor {
  userSubject: string;
  orgRid: string;
  branch: string;
}

export interface SubmitInstructionsRequest {
  /** Server view of the version the client thinks it's at. */
  baseVersion: number;
  /** Per-(rid, applied_by, op_id) idempotency. */
  clientOpIds: ReadonlyArray<string>;
  instructions: ReadonlyArray<unknown>;
}

export interface InstructionAck {
  /** Server's version after the apply. */
  newVersion: number;
  /** The instructions actually applied (post-transform). */
  transformedInstructions: ReadonlyArray<Instruction>;
  /** Original-index → drop reason for ops that were rebased. */
  rebases: ReadonlyArray<{
    originalIndex: number;
    reason: "lww" | "tombstone" | "noop" | "merge" | "reorder";
    droppedInstructionType: string;
  }>;
  etag: string;
  /** Latest log row seq written by this submit. Useful for tests. */
  latestSeq: number;
}

/** OT_BASE_VERSION_TOO_OLD threshold per D-44 (default 200 ops). */
export const BASE_VERSION_TOO_OLD_THRESHOLD = 200;

interface RawAnalysisDoc {
  rid: string;
  cards: Record<string, any>;
  canvases: any[];
  parameters: Record<string, any>;
  current_version: number;
  etag: string;
}

function canvasArrayToRecord(arr: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of arr ?? []) out[c.id] = c;
  return out;
}

function canvasRecordToArray(rec: Record<string, any>, keyOrder: string[]): any[] {
  // Preserve insertion order by walking keyOrder first; append any new ids
  // in the order they were added (Object.keys preserves insertion order).
  const seen = new Set<string>();
  const out: any[] = [];
  for (const k of keyOrder) {
    if (rec[k] !== undefined) {
      out.push(rec[k]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(rec)) {
    if (!seen.has(k)) out.push(rec[k]);
  }
  return out;
}

export async function submitInstructions(
  actor: SubmitInstructionsActor,
  rid: string,
  body: SubmitInstructionsRequest,
): Promise<InstructionAck> {
  const submitStart = process.hrtime.bigint();
  // 1. Validate the wire shape (B3 C-14).
  const parsed = instructionListSchema.safeParse(body.instructions);
  if (!parsed.success) {
    otSubmitSeconds.observe({ result: "malformed" }, 0);
    throw malformedInstruction({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const local: Instruction[] = parsed.data;

  if (local.length !== body.clientOpIds.length) {
    throw malformedInstruction({
      reason: "clientOpIds.length must equal instructions.length",
    });
  }

  return withTransaction(async (client) => {
    // 2. Lock the analysis row for the duration.
    const sel = await client.query(
      `SELECT rid, cards, canvases, parameters, current_version, etag
         FROM quiver_analysis WHERE rid = $1 AND is_deleted = false FOR UPDATE`,
      [rid],
    );
    if (sel.rowCount === 0) throw analysisNotFound({ rid });
    const row = sel.rows[0] as RawAnalysisDoc;
    const serverVersion = Number(row.current_version);

    if (body.baseVersion > serverVersion) {
      throw versionMismatch({
        currentVersion: serverVersion,
        suppliedBaseVersion: body.baseVersion,
      });
    }

    const lag = serverVersion - body.baseVersion;
    if (lag > BASE_VERSION_TOO_OLD_THRESHOLD) {
      throw otBaseVersionTooOld({
        currentVersion: serverVersion,
        baseVersion: body.baseVersion,
        threshold: BASE_VERSION_TOO_OLD_THRESHOLD,
      });
    }

    // 3. Idempotency check (B3 C-18). If ALL clientOpIds are already in the
    // log for this user, return the same ack we returned last time.
    const existingByOpId = new Map<string, number>();
    if (body.clientOpIds.length > 0) {
      const dup = await client.query<{ client_op_id: string; seq: number }>(
        `SELECT client_op_id, seq FROM quiver_instruction_log
            WHERE rid = $1 AND applied_by = $2
              AND client_op_id = ANY($3::text[])`,
        [rid, actor.userSubject, body.clientOpIds],
      );
      for (const r of dup.rows) existingByOpId.set(r.client_op_id, Number(r.seq));
    }
    if (existingByOpId.size === body.clientOpIds.length && body.clientOpIds.length > 0) {
      otDuplicateOpIdTotal.inc(body.clientOpIds.length);
      otSubmitSeconds.observe({ result: "duplicate" }, hrToSec(submitStart));
      return {
        newVersion: serverVersion,
        transformedInstructions: [],
        rebases: [],
        etag: row.etag,
        latestSeq: Math.max(...Array.from(existingByOpId.values()), 0),
      };
    }

    // 4. Pull the server-tail since baseVersion.
    let remote: Instruction[] = [];
    if (lag > 0) {
      const tail = await client.query<{ instruction: Instruction }>(
        `SELECT instruction FROM quiver_instruction_log
            WHERE rid = $1 AND seq > $2 ORDER BY seq ASC`,
        [rid, body.baseVersion],
      );
      remote = tail.rows.map((r) => r.instruction);
    }

    // 5. Transform local against remote.
    const transformStart = process.hrtime.bigint();
    const t = transformLocalAgainstRemote(local, remote);
    otTransformSeconds.observe(hrToSec(transformStart));
    for (const [resolution, n] of Object.entries(t.counts)) {
      if (n > 0) otConflictsTotal.inc({ resolution }, n);
    }

    // 6. Build tombstone set from remote ops first (they already affected the doc).
    const tombstones = new Set<string>();
    // Pre-seed tombstones from existing instruction log so reapply skips
    // operations that target previously-deleted cards (B3 C-07).
    const allTombs = await client.query<{ card_id: string }>(
      `SELECT (instruction->>'cardId') AS card_id
         FROM quiver_instruction_log
         WHERE rid = $1
           AND instruction->>'kind' = 'deleteCard'`,
      [rid],
    );
    for (const r of allTombs.rows) {
      if (r.card_id) tombstones.add(r.card_id);
    }

    // 7. Apply transformed instructions.
    const cardsRec: Record<string, any> = { ...row.cards };
    const canvasesRec = canvasArrayToRecord(row.canvases);
    const paramsRec: Record<string, any> = { ...row.parameters };
    let doc: any = { cards: cardsRec, canvases: canvasesRec, parameters: paramsRec };

    const accepted: Instruction[] = [];
    type RebaseEntry = {
      originalIndex: number;
      reason: "lww" | "tombstone" | "noop" | "merge" | "reorder";
      droppedInstructionType: string;
    };
    const rebases: RebaseEntry[] = [];
    let nextSeq = serverVersion;
    for (const entry of t.results) {
      const orig = local[entry.originalIndex];
      const opId = body.clientOpIds[entry.originalIndex];
      if (!entry.transformed) {
        // Drop — emit serverRebase to the client.
        const reason = (entry.resolution ?? "noop") as
          | "lww"
          | "tombstone"
          | "merge"
          | "reorder"
          | "noop";
        rebases.push({
          originalIndex: entry.originalIndex,
          reason,
          droppedInstructionType: orig.kind,
        });
        emitCollab({
          kind: "serverRebase",
          rid,
          toUserSubject: actor.userSubject,
          originalIndex: entry.originalIndex,
          reason: reason === "lww" || reason === "tombstone" ? reason : "lww",
          droppedInstructionType: orig.kind,
        });
        continue;
      }
      // Snapshot doc and tombstones before apply to support rollback on 23505.
      const docSnapshot = JSON.stringify(doc);
      const tombstonesSnapshot = new Set(tombstones);
      const applyStart = process.hrtime.bigint();
      const r = applyInstruction(doc, entry.transformed, tombstones);
      otInstructionApplySeconds.observe(
        { type: entry.transformed.kind },
        hrToSec(applyStart),
      );
      if (!r.applied) {
        // Apply failed silently (e.g. card_not_found, noop) — record but skip log.
        rebases.push({
          originalIndex: entry.originalIndex,
          reason: r.dropReason === "tombstoned" ? "tombstone" : "noop",
          droppedInstructionType: orig.kind,
        });
        continue;
      }
      doc = r.doc;
      nextSeq += 1;
      accepted.push(entry.transformed);
      // Write log row.
      try {
        await client.query(
          `INSERT INTO quiver_instruction_log (rid, seq, instruction, applied_by, client_op_id, branch)
              VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
          [rid, nextSeq, JSON.stringify(entry.transformed), actor.userSubject, opId, actor.branch],
        );
      } catch (err: any) {
        if (err?.code === "23505") {
          // Duplicate (rid, applied_by, client_op_id) — should have been caught
          // in step 3, but if not, rollback doc/tombstones and continue.
          otDuplicateOpIdTotal.inc();
          nextSeq -= 1;
          accepted.pop();
          doc = JSON.parse(docSnapshot);
          tombstones.clear();
          tombstonesSnapshot.forEach((id) => tombstones.add(id));
          continue;
        }
        throw err;
      }
      emitCollab({
        kind: "appliedInstruction",
        rid,
        seq: nextSeq,
        appliedBy: actor.userSubject,
        branch: actor.branch,
        instructionType: entry.transformed.kind,
        appliedAtMs: Date.now(),
      });
      // B3 C-19 — one audit row per accepted instruction.
      void emitQuiverAudit({
        actorSubject: actor.userSubject,
        action: "QUIVER_OT_INSTRUCTION_APPLIED",
        rid,
        result: "SUCCESS",
        branch: actor.branch,
        details: {
          seq: nextSeq,
          instructionType: entry.transformed.kind,
          clientOpId: opId,
        },
      });
    }

    // 8. Re-write the analysis row with the new state.
    const newCanvasesArr = canvasRecordToArray(
      doc.canvases,
      Object.keys(canvasesRec),
    );
    const newRowSnapshot = {
      cards: doc.cards,
      canvases: newCanvasesArr,
      parameters: doc.parameters,
      currentVersion: nextSeq,
    };
    const newEtag = computeEtagOf(newRowSnapshot);
    await client.query(
      `UPDATE quiver_analysis
          SET cards = $1::jsonb,
              canvases = $2::jsonb,
              parameters = $3::jsonb,
              current_version = $4,
              etag = $5,
              updated_at = now()
          WHERE rid = $6`,
      [
        JSON.stringify(doc.cards),
        JSON.stringify(newCanvasesArr),
        JSON.stringify(doc.parameters),
        nextSeq,
        newEtag,
        rid,
      ],
    );

    otSubmitSeconds.observe({ result: "ok" }, hrToSec(submitStart));
    return {
      newVersion: nextSeq,
      transformedInstructions: accepted,
      rebases,
      etag: newEtag,
      latestSeq: nextSeq,
    };
  });
}

/** Read an instruction log slice (used for replay tests + WS catch-up). */
export async function readLogSlice(
  rid: string,
  fromSeq: number,
  toSeq: number = Number.MAX_SAFE_INTEGER,
): Promise<Instruction[]> {
  const r = await (await import("../../../db")).query(
    `SELECT instruction FROM quiver_instruction_log
        WHERE rid = $1 AND seq > $2 AND seq <= $3
        ORDER BY seq ASC`,
    [rid, fromSeq, toSeq],
  );
  return r.rows.map((row: { instruction: Instruction }) => row.instruction);
}

function hrToSec(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
