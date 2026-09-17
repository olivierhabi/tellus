/**
 * B3 — Pure `applyInstruction(doc, instr) → newDoc` function.
 *
 * Returns a *new* `AnalysisDocument` with the instruction applied (or
 * silently dropped per tombstone semantics). Tombstones are tracked in a
 * separate set the caller threads through; once a card is tombstoned, all
 * subsequent instructions targeting it are dropped (B3 C-07).
 *
 * Tombstone tracking: caller manages the set so replay() can rebuild it
 * from the log without re-applying delete instructions.
 */

import type { Instruction, JsonPatchOp } from "./instructions";

/**
 * Internal OT document shape — looser than the AnalysisDocument wire type.
 * Both `cards` and `canvases` are records keyed by id (the OT engine
 * normalizes to records for index locality; otService converts canvases
 * back to an array at the row boundary).
 */
export interface OtDocument {
  cards: Record<string, any>;
  canvases: Record<string, any>;
  parameters: Record<string, any>;
}

export interface ApplyResult {
  /** The document after applying. Identical reference if dropped. */
  doc: OtDocument;
  /** True if the instruction was applied (mutating change). */
  applied: boolean;
  /** Reason for drop, if applied=false. */
  dropReason?: "tombstoned" | "noop" | "card_not_found" | "canvas_not_found";
}

// The wire/stored placements shape is the flat array ({cardId,x,y,w,h} —
// types.ts CanvasPlacement, what AnalysisDocument.parse expects); the OT
// engine keeps canvases as records keyed by cardId of
// {position:{x,y}, size:{width,height}} (see otService.placementsRecordToArray
// for the inverse at the row boundary). addCanvas ingests the array form and
// normalizes to the record form here. Legacy logged instructions carry the
// record form — accept both so replay of old logs still works.
function placementsToRecord(p: unknown): Record<string, any> {
  if (Array.isArray(p)) {
    const out: Record<string, any> = {};
    for (const x of p as Array<{ cardId: string; x: number; y: number; w: number; h: number }>) {
      out[x.cardId] = { position: { x: x.x, y: x.y }, size: { width: x.w, height: x.h } };
    }
    return out;
  }
  return p && typeof p === "object" ? (p as Record<string, any>) : {};
}

// Parameter card type → Parameter record type (types.ts Parameter.type).
const PARAMETER_CARD_TYPES: Record<string, "STRING" | "NUMBER" | "DATETIME" | "BOOLEAN"> = {
  PARAMETER_STRING: "STRING",
  PARAMETER_NUMBER: "NUMBER",
  PARAMETER_DATETIME: "DATETIME",
  PARAMETER_BOOLEAN: "BOOLEAN",
};

// The persisted parameters column is Record<CardId, Parameter>
// (AnalysisDocument). updateParameter must store that exact shape or the
// row stops parsing. Type resolution: keep an existing entry's type, else
// derive from the parameter card (PARAMETER_* card type), else infer from
// the JSON value (number→NUMBER, boolean→BOOLEAN, anything else→STRING).
function parameterTypeFor(
  doc: OtDocument,
  parameterId: string,
  valueJson: unknown,
  existing: { type?: string } | undefined,
): "STRING" | "NUMBER" | "DATETIME" | "BOOLEAN" {
  if (existing?.type) return existing.type as "STRING" | "NUMBER" | "DATETIME" | "BOOLEAN";
  const card = (doc.cards ?? {} as Record<string, any>)[parameterId];
  const fromCard = card ? PARAMETER_CARD_TYPES[card.type] : undefined;
  if (fromCard) return fromCard;
  if (typeof valueJson === "number") return "NUMBER";
  if (typeof valueJson === "boolean") return "BOOLEAN";
  return "STRING";
}

/** Mutates a tombstone set with an instruction's effect, then returns updated doc. */
export function applyInstruction(
  doc: OtDocument,
  instr: Instruction,
  tombstones: Set<string>,
): ApplyResult {
  switch (instr.kind) {
    case "addCard": {
      // Tombstoned IDs are NOT reused (B2 contract); treat as no-op.
      if (tombstones.has(instr.card.id)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      if ((doc.cards as Record<string, unknown>)[instr.card.id]) {
        return { doc, applied: false, dropReason: "noop" };
      }
      return {
        doc: {
          ...doc,
          cards: { ...doc.cards, [instr.card.id]: { ...instr.card } },
        },
        applied: true,
      };
    }
    case "updateCardConfig": {
      if (tombstones.has(instr.cardId)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      const card = (doc.cards as Record<string, any>)[instr.cardId];
      if (!card) return { doc, applied: false, dropReason: "card_not_found" };
      const newConfig = applyJsonPatch(card.config ?? {}, instr.configJsonPatch);
      return {
        doc: {
          ...doc,
          cards: {
            ...doc.cards,
            [instr.cardId]: { ...card, config: newConfig },
          },
        },
        applied: true,
      };
    }
    case "bindInput": {
      if (tombstones.has(instr.cardId) || tombstones.has(instr.sourceCardId)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      const card = (doc.cards as Record<string, any>)[instr.cardId];
      if (!card) return { doc, applied: false, dropReason: "card_not_found" };
      return {
        doc: {
          ...doc,
          cards: {
            ...doc.cards,
            [instr.cardId]: {
              ...card,
              inputs: { ...(card.inputs ?? {}), [instr.slot]: instr.sourceCardId },
            },
          },
        },
        applied: true,
      };
    }
    case "unbindInput": {
      if (tombstones.has(instr.cardId)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      const card = (doc.cards as Record<string, any>)[instr.cardId];
      if (!card) return { doc, applied: false, dropReason: "card_not_found" };
      const inputs = { ...(card.inputs ?? {}) };
      delete inputs[instr.slot];
      return {
        doc: { ...doc, cards: { ...doc.cards, [instr.cardId]: { ...card, inputs } } },
        applied: true,
      };
    }
    case "deleteCard": {
      if (tombstones.has(instr.cardId)) {
        return { doc, applied: false, dropReason: "noop" };
      }
      const card = (doc.cards as Record<string, any>)[instr.cardId];
      if (!card) {
        // Defensive: still tombstone so future updates from concurrent clients drop.
        tombstones.add(instr.cardId);
        return { doc, applied: false, dropReason: "card_not_found" };
      }
      tombstones.add(instr.cardId);
      const cards = { ...doc.cards } as Record<string, any>;
      delete cards[instr.cardId];
      // Drop canvas placements that reference the deleted card.
      const canvases: Record<string, any> = { ...(doc.canvases as Record<string, any>) };
      for (const cid of Object.keys(canvases)) {
        const c = canvases[cid];
        const ordering: string[] = (c.ordering ?? []).filter((id: string) => id !== instr.cardId);
        const placements: Record<string, any> = { ...(c.placements ?? {}) };
        delete placements[instr.cardId];
        canvases[cid] = { ...c, ordering, placements };
      }
      return { doc: { ...doc, cards, canvases }, applied: true };
    }
    case "addCanvas": {
      const existing = (doc.canvases as Record<string, any>)[instr.canvas.id];
      if (existing) return { doc, applied: false, dropReason: "noop" };
      return {
        doc: {
          ...doc,
          canvases: {
            ...doc.canvases,
            [instr.canvas.id]: {
              ...instr.canvas,
              placements: placementsToRecord(instr.canvas.placements),
            },
          },
        },
        applied: true,
      };
    }
    case "deleteCanvas": {
      const c = (doc.canvases as Record<string, any>)[instr.canvasId];
      if (!c) return { doc, applied: false, dropReason: "canvas_not_found" };
      const canvases = { ...(doc.canvases as Record<string, any>) };
      delete canvases[instr.canvasId];
      return { doc: { ...doc, canvases }, applied: true };
    }
    case "renameCanvas": {
      const c = (doc.canvases as Record<string, any>)[instr.canvasId];
      if (!c) return { doc, applied: false, dropReason: "canvas_not_found" };
      return {
        doc: {
          ...doc,
          canvases: {
            ...doc.canvases,
            [instr.canvasId]: { ...c, name: instr.name },
          },
        },
        applied: true,
      };
    }
    case "placeCardOnCanvas": {
      if (tombstones.has(instr.cardId)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      const c = (doc.canvases as Record<string, any>)[instr.canvasId];
      if (!c) return { doc, applied: false, dropReason: "canvas_not_found" };
      const ordering: string[] = (c.ordering ?? []).slice();
      if (!ordering.includes(instr.cardId)) ordering.push(instr.cardId);
      const placements = {
        ...(c.placements ?? {}),
        [instr.cardId]: { position: instr.position, size: instr.size },
      };
      return {
        doc: {
          ...doc,
          canvases: {
            ...doc.canvases,
            [instr.canvasId]: { ...c, ordering, placements },
          },
        },
        applied: true,
      };
    }
    case "removeCardFromCanvas": {
      const c = (doc.canvases as Record<string, any>)[instr.canvasId];
      if (!c) return { doc, applied: false, dropReason: "canvas_not_found" };
      const ordering: string[] = (c.ordering ?? []).filter((id: string) => id !== instr.cardId);
      const placements: Record<string, any> = { ...(c.placements ?? {}) };
      delete placements[instr.cardId];
      return {
        doc: {
          ...doc,
          canvases: {
            ...doc.canvases,
            [instr.canvasId]: { ...c, ordering, placements },
          },
        },
        applied: true,
      };
    }
    case "reorderCanvasCards": {
      const c = (doc.canvases as Record<string, any>)[instr.canvasId];
      if (!c) return { doc, applied: false, dropReason: "canvas_not_found" };
      // Filter to only cards still on this canvas (drop dangling refs).
      const valid = new Set<string>(c.ordering ?? []);
      const ordering = instr.ordering.filter((id) => valid.has(id));
      return {
        doc: {
          ...doc,
          canvases: {
            ...doc.canvases,
            [instr.canvasId]: { ...c, ordering },
          },
        },
        applied: true,
      };
    }
    case "updateParameter": {
      const params = { ...((doc.parameters ?? {}) as Record<string, any>) };
      const existing = params[instr.parameterId];
      // Store the canonical Parameter shape (types.ts) so the parameters
      // column round-trips AnalysisDocument.parse — the old `{value: X}`
      // envelope poisoned the row against the read schema.
      params[instr.parameterId] = {
        cardId: instr.parameterId,
        type: parameterTypeFor(doc, instr.parameterId, instr.valueJson, existing),
        defaultValueJson: instr.valueJson ?? null,
        ...(existing?.externalName !== undefined
          ? { externalName: existing.externalName }
          : {}),
      };
      return { doc: { ...doc, parameters: params }, applied: true };
    }
    case "setHidden": {
      if (tombstones.has(instr.cardId)) {
        return { doc, applied: false, dropReason: "tombstoned" };
      }
      const card = (doc.cards as Record<string, any>)[instr.cardId];
      if (!card) return { doc, applied: false, dropReason: "card_not_found" };
      return {
        doc: {
          ...doc,
          cards: {
            ...doc.cards,
            [instr.cardId]: { ...card, hidden: instr.hidden },
          },
        },
        applied: true,
      };
    }
    default: {
      // Exhaustiveness check at compile time.
      const _exhaustive: never = instr;
      void _exhaustive;
      return { doc, applied: false, dropReason: "noop" };
    }
  }
}

/** Apply an RFC 6902 JSON Patch (subset: add, remove, replace) onto a value. */
export function applyJsonPatch(target: unknown, patch: JsonPatchOp[]): unknown {
  let cur = clone(target);
  for (const op of patch) {
    if (op.op === "add" || op.op === "replace") {
      cur = setAtPath(cur, op.path, clone(op.value));
    } else if (op.op === "remove") {
      cur = removeAtPath(cur, op.path);
    } else if (op.op === "test") {
      const existing = getAtPath(cur, op.path);
      if (!deepEqual(existing, op.value)) {
        // Test failed — RFC 6902 says the whole patch should fail. Keep
        // cur as the pre-failed snapshot per atomicity.
        return target;
      }
    } else if (op.op === "copy" || op.op === "move") {
      const v = getAtPath(cur, op.from ?? "");
      cur = setAtPath(cur, op.path, clone(v));
      if (op.op === "move") cur = removeAtPath(cur, op.from ?? "");
    }
  }
  return cur;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function pathSegs(path: string): string[] {
  if (!path || path === "/") return [];
  return path
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAtPath(target: unknown, path: string): unknown {
  let cur: any = target;
  for (const seg of pathSegs(path)) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setAtPath(target: unknown, path: string, value: unknown): unknown {
  const segs = pathSegs(path);
  if (segs.length === 0) return value;
  const root = (target == null ? {} : { ...(target as Record<string, unknown>) }) as any;
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = cur[seg];
    cur[seg] = next == null ? {} : { ...next };
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return root;
}

function removeAtPath(target: unknown, path: string): unknown {
  const segs = pathSegs(path);
  if (segs.length === 0 || target == null) return target;
  const root = { ...(target as Record<string, unknown>) } as any;
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = cur[seg];
    if (next == null) return root;
    cur[seg] = { ...next };
    cur = cur[seg];
  }
  delete cur[segs[segs.length - 1]];
  return root;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
