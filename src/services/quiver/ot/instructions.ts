/**
 * B3 — `Instruction` discriminated union (12 variants per spec §B3).
 *
 * Validation via zod; the BE accepts only well-formed instructions and
 * returns `Tellus:Quiver:MalformedInstruction` (B3 C-14) on parse failure.
 */

import { z } from "zod";
import {
  CardId,
  CardType,
  CanvasId,
  CanvasPlacement,
} from "../types";

const positionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const sizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

// RFC 6902 JSON Patch operation; reused for updateCardConfig.
const jsonPatchOpSchema = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

// Write schemas MUST equal the read-side AnalysisDocument schemas in
// ../types exactly. A looser write path accepts instructions that poison
// the quiver_analysis cards/canvases/parameters columns — rows that
// AnalysisDocument.parse then rejects, 500ing GET and (before per-row
// hardening) the whole folder listing. types.ts is the single source of
// truth: import its schemas instead of re-declaring loose primitives.
const cardSchema = z.object({
  id: CardId,
  type: CardType,
  inputs: z.record(z.string(), CardId).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  hidden: z.boolean().default(false),
  displayName: z.string().max(200).optional(),
});

// Placements use the STORED/wire array form ({cardId,x,y,w,h} — types.ts
// Canvas, which is what AnalysisDocument.parse expects). The OT apply
// layer normalizes to its internal record form on ingest and otService
// converts back to the array form at the row boundary, so addCanvas
// round-trips byte-identically with the read schema.
const canvasSchema = z.object({
  id: CanvasId,
  name: z.string().min(1).max(200),
  placements: z.array(CanvasPlacement).default([]),
  ordering: z.array(CardId).default([]),
});

export const instructionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("addCard"), card: cardSchema }),
  z.object({
    kind: z.literal("updateCardConfig"),
    cardId: CardId,
    configJsonPatch: z.array(jsonPatchOpSchema),
    baseCardVersion: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("bindInput"),
    cardId: CardId,
    slot: z.string().min(1),
    sourceCardId: CardId,
  }),
  z.object({
    kind: z.literal("unbindInput"),
    cardId: CardId,
    slot: z.string().min(1),
  }),
  z.object({ kind: z.literal("deleteCard"), cardId: CardId }),
  z.object({ kind: z.literal("addCanvas"), canvas: canvasSchema }),
  z.object({ kind: z.literal("deleteCanvas"), canvasId: CanvasId }),
  z.object({
    kind: z.literal("renameCanvas"),
    canvasId: CanvasId,
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("placeCardOnCanvas"),
    cardId: CardId,
    canvasId: CanvasId,
    position: positionSchema,
    size: sizeSchema,
  }),
  z.object({
    kind: z.literal("removeCardFromCanvas"),
    cardId: CardId,
    canvasId: CanvasId,
  }),
  z.object({
    kind: z.literal("reorderCanvasCards"),
    canvasId: CanvasId,
    ordering: z.array(CardId),
  }),
  z.object({
    kind: z.literal("updateParameter"),
    parameterId: CardId,
    valueJson: z.unknown(),
  }),
  z.object({
    kind: z.literal("setHidden"),
    cardId: CardId,
    hidden: z.boolean(),
  }),
]);

export type Instruction = z.infer<typeof instructionSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type JsonPatchOp = z.infer<typeof jsonPatchOpSchema>;

export const instructionListSchema = z.array(instructionSchema);

/**
 * Stable enum-list of every instruction kind. Used by transformer to
 * exhaustively match (compile-time check via `Instruction["kind"]`).
 */
export const INSTRUCTION_KINDS = [
  "addCard",
  "updateCardConfig",
  "bindInput",
  "unbindInput",
  "deleteCard",
  "addCanvas",
  "deleteCanvas",
  "renameCanvas",
  "placeCardOnCanvas",
  "removeCardFromCanvas",
  "reorderCanvasCards",
  "updateParameter",
  "setHidden",
] as const;

export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];
