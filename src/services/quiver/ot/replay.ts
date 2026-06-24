/**
 * B3 — Replay engine.
 *
 * Replay an instruction log (in seq order) onto an empty `AnalysisDocument`
 * and produce the canonical document. Used to verify B3 C-10 (replay from
 * seq=0 produces byte-identical state).
 */

import { applyInstruction, type OtDocument } from "./apply";
import type { Instruction } from "./instructions";

export interface ReplayedDocument {
  document: OtDocument;
  tombstones: Set<string>;
  appliedCount: number;
  droppedCount: number;
}

/**
 * Replay every instruction. The seed document MUST be the same as what
 * the analysis was created with (same RID, same parentFolder, same branch).
 */
export function replay(
  seed: OtDocument,
  instructions: ReadonlyArray<Instruction>,
): ReplayedDocument {
  let doc = seed;
  const tombstones = new Set<string>();
  let appliedCount = 0;
  let droppedCount = 0;
  for (const instr of instructions) {
    const r = applyInstruction(doc, instr, tombstones);
    if (r.applied) {
      doc = r.doc;
      appliedCount += 1;
    } else {
      droppedCount += 1;
    }
  }
  return { document: doc, tombstones, appliedCount, droppedCount };
}
