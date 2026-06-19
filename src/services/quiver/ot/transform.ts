/**
 * B3 — Operational Transform.
 *
 * Server-side rebase: given a list of `remote` instructions (the server-tail
 * since the client's baseVersion) and a list of `local` instructions (what
 * the client is now submitting), return the transformed list of local
 * instructions to apply, plus the per-local resolution outcome.
 *
 * Invariant (B3 C-04):
 *   apply(remote; transformLocalAgainstRemote(local, remote))
 *     ≡ apply(local; transformRemoteAgainstLocal(remote, local))
 *
 * For our 13-variant set the transformation reduces to a small set of
 * conflict rules, applied sequentially against an accumulator built from
 * the remote sequence:
 *   - tombstoneCards: ids deleted on the server tail
 *   - tombstoneCanvases: ids deleted on the server tail
 *   - lwwCardConfigPaths: card → set of JSON paths last-written by remote
 *   - lwwBindInputs: cardId → slot set last-written by remote
 *   - lwwPlacements: canvasId → cardId set last-written by remote
 *   - occupiedPositions: canvasId → set of "x,y" cells already taken
 *   - lwwParameters: parameterId set last-written by remote
 *   - lwwHidden: cardId set last-written by remote
 *   - addedCards / addedCanvases: id sets that already exist
 *
 * Resolutions per spec §B3:
 *   - `updateCardConfig` LWW field-level — if any remote patch touched a
 *     path the local patch also touches, drop just the conflicting paths
 *     and (if the local list ends up empty) drop the whole instruction.
 *   - `bindInput` to different slots — merge.
 *   - `bindInput` same slot — LWW.
 *   - `deleteCard` tombstones; subsequent ops on that card drop.
 *   - `placeCardOnCanvas` collisions — offset by ±32 px.
 *   - `addCard` / `addCanvas` same id — drop the second (already exists).
 *   - `deleteCanvas` tombstones; subsequent ops on that canvas drop.
 */

import type { Instruction, JsonPatchOp } from "./instructions";

export type ConflictResolution =
  | "lww"
  | "merge"
  | "tombstone"
  | "reorder"
  | "noop";

export interface TransformResultEntry {
  /** The transformed instruction, or null if dropped entirely. */
  transformed: Instruction | null;
  /** Original index of the local op (preserved for caller bookkeeping). */
  originalIndex: number;
  /** Why the transform produced what it produced. */
  resolution: ConflictResolution | null;
}

export interface TransformResult {
  results: TransformResultEntry[];
  /** Counts per resolution; usable for metric increments. */
  counts: Record<ConflictResolution, number>;
}

interface Accumulator {
  tombstoneCards: Set<string>;
  tombstoneCanvases: Set<string>;
  lwwCardConfigPaths: Map<string, Set<string>>;
  lwwBindInputs: Map<string, Set<string>>;
  lwwParameters: Set<string>;
  lwwHidden: Set<string>;
  lwwPlacements: Map<string, Set<string>>;
  occupiedPositions: Map<string, Set<string>>;
  addedCards: Set<string>;
  addedCanvases: Set<string>;
}

function freshAcc(): Accumulator {
  return {
    tombstoneCards: new Set(),
    tombstoneCanvases: new Set(),
    lwwCardConfigPaths: new Map(),
    lwwBindInputs: new Map(),
    lwwParameters: new Set(),
    lwwHidden: new Set(),
    lwwPlacements: new Map(),
    occupiedPositions: new Map(),
    addedCards: new Set(),
    addedCanvases: new Set(),
  };
}

function recordRemote(acc: Accumulator, instr: Instruction): void {
  switch (instr.kind) {
    case "addCard":
      acc.addedCards.add(instr.card.id);
      break;
    case "addCanvas":
      acc.addedCanvases.add(instr.canvas.id);
      break;
    case "deleteCard":
      acc.tombstoneCards.add(instr.cardId);
      break;
    case "deleteCanvas":
      acc.tombstoneCanvases.add(instr.canvasId);
      break;
    case "updateCardConfig": {
      let s = acc.lwwCardConfigPaths.get(instr.cardId);
      if (!s) {
        s = new Set();
        acc.lwwCardConfigPaths.set(instr.cardId, s);
      }
      for (const op of instr.configJsonPatch) s.add(op.path);
      break;
    }
    case "bindInput":
    case "unbindInput": {
      let s = acc.lwwBindInputs.get(instr.cardId);
      if (!s) {
        s = new Set();
        acc.lwwBindInputs.set(instr.cardId, s);
      }
      s.add(instr.slot);
      break;
    }
    case "placeCardOnCanvas": {
      let lww = acc.lwwPlacements.get(instr.canvasId);
      if (!lww) {
        lww = new Set();
        acc.lwwPlacements.set(instr.canvasId, lww);
      }
      lww.add(instr.cardId);
      let occ = acc.occupiedPositions.get(instr.canvasId);
      if (!occ) {
        occ = new Set();
        acc.occupiedPositions.set(instr.canvasId, occ);
      }
      occ.add(`${instr.position.x},${instr.position.y}`);
      break;
    }
    case "updateParameter":
      acc.lwwParameters.add(instr.parameterId);
      break;
    case "setHidden":
      acc.lwwHidden.add(instr.cardId);
      break;
    default:
      break;
  }
}

function transformOne(
  local: Instruction,
  acc: Accumulator,
  index: number,
): TransformResultEntry {
  switch (local.kind) {
    case "addCard": {
      if (acc.addedCards.has(local.card.id) || acc.tombstoneCards.has(local.card.id)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "addCanvas": {
      if (acc.addedCanvases.has(local.canvas.id) || acc.tombstoneCanvases.has(local.canvas.id)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "updateCardConfig": {
      if (acc.tombstoneCards.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      const lww = acc.lwwCardConfigPaths.get(local.cardId);
      if (!lww) return { transformed: local, originalIndex: index, resolution: null };
      const remaining: JsonPatchOp[] = local.configJsonPatch.filter(
        (op) => !lww.has(op.path) && !lww.has(coveringPath(op.path, lww)),
      );
      if (remaining.length === 0) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      if (remaining.length !== local.configJsonPatch.length) {
        return {
          transformed: { ...local, configJsonPatch: remaining },
          originalIndex: index,
          resolution: "lww",
        };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "bindInput":
    case "unbindInput": {
      if (acc.tombstoneCards.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      const lww = acc.lwwBindInputs.get(local.cardId);
      if (!lww) return { transformed: local, originalIndex: index, resolution: null };
      if (lww.has(local.slot)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      return { transformed: local, originalIndex: index, resolution: "merge" };
    }
    case "deleteCard": {
      if (acc.tombstoneCards.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "noop" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "deleteCanvas":
    case "renameCanvas": {
      if (acc.tombstoneCanvases.has(local.canvasId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "placeCardOnCanvas": {
      if (acc.tombstoneCards.has(local.cardId) || acc.tombstoneCanvases.has(local.canvasId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      const lww = acc.lwwPlacements.get(local.canvasId);
      if (lww?.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      const occ = acc.occupiedPositions.get(local.canvasId);
      if (occ) {
        let { x, y } = local.position;
        let key = `${x},${y}`;
        let bumped = false;
        while (occ.has(key)) {
          x += 32;
          y += 32;
          key = `${x},${y}`;
          bumped = true;
        }
        if (bumped) {
          occ.add(key);
          return {
            transformed: { ...local, position: { x, y } },
            originalIndex: index,
            resolution: "reorder",
          };
        }
        occ.add(key);
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "removeCardFromCanvas": {
      if (acc.tombstoneCanvases.has(local.canvasId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "reorderCanvasCards": {
      if (acc.tombstoneCanvases.has(local.canvasId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "updateParameter": {
      if (acc.lwwParameters.has(local.parameterId)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    case "setHidden": {
      if (acc.tombstoneCards.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "tombstone" };
      }
      if (acc.lwwHidden.has(local.cardId)) {
        return { transformed: null, originalIndex: index, resolution: "lww" };
      }
      return { transformed: local, originalIndex: index, resolution: null };
    }
    default: {
      const _exhaustive: never = local;
      void _exhaustive;
      return { transformed: null, originalIndex: index, resolution: "noop" };
    }
  }
}

/** Returns the matching path in the lww set if a covering ancestor exists. */
function coveringPath(path: string, lww: Set<string>): string {
  // If lww contains an ancestor path of `path` (e.g. lww has "/a" and path
  // is "/a/b/c"), the local op should drop. Walk up the path components.
  const segs = path.split("/");
  for (let i = segs.length - 1; i >= 1; i--) {
    const ancestor = segs.slice(0, i).join("/") || "/";
    if (lww.has(ancestor)) return ancestor;
  }
  return ""; // no cover; lww.has("") is false, so non-match
}

/** Public entry: rebase `local` against `remote`. */
export function transformLocalAgainstRemote(
  local: Instruction[],
  remote: Instruction[],
): TransformResult {
  const acc = freshAcc();
  for (const r of remote) recordRemote(acc, r);

  const counts: Record<ConflictResolution, number> = {
    lww: 0,
    merge: 0,
    tombstone: 0,
    reorder: 0,
    noop: 0,
  };
  const results: TransformResultEntry[] = [];
  for (let i = 0; i < local.length; i++) {
    const out = transformOne(local[i], acc, i);
    if (out.resolution) counts[out.resolution] += 1;
    // Treat the transformed local op as part of the accumulator so
    // intra-batch conflicts are resolved consistently.
    if (out.transformed) recordRemote(acc, out.transformed);
    results.push(out);
  }
  return { results, counts };
}
